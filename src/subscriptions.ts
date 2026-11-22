import { all, nowIso, one, readJson } from "./db";
import { compileChainedRule, matchChainedRule } from "./filters";
import { FIRST_SYNC_INCOMPLETE_KEY, parseTimeoutReleaseGuids } from "./first-sync";
import { recordPushLog, sendBrevo, sendTelegram } from "./notifications";
import { budgetRemaining, consumeQuery } from "./query-budget";
import type { QueryBudget } from "./query-budget";
import { validatePatternInput } from "./rule-import";
import { runtimeSettings } from "./settings";
import type { RuntimeSettings } from "./settings";
import type { Env, RssNewPost, Subscription, User } from "./types";

export const NOTIFICATION_ATTEMPT_LIMIT = 20;
export const NOTIFICATION_MATCH_UNIT_LIMIT = 500;
export const NOTIFICATION_POST_PAGE = 20;
export const NOTIFICATION_SUB_PAGE = 50;

const NOTIFICATION_CURSOR_POST_ID = "notification_cursor_post_id";
const NOTIFICATION_CURSOR_SUBSCRIPTION_ID = "notification_cursor_subscription_id";
const NOTIFICATION_CURSOR_CHANNEL = "notification_cursor_channel";

type NotificationChannel = "email" | "telegram";
const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ["email", "telegram"];

interface NotificationCursor {
  postId: number;
  subscriptionId: number;
  channel: NotificationChannel | "";
}

/**
 * One bounded read of the whole notification frontier. `postId` is the next
 * post id to process (the posts scan stays `id >= postId`). `cursorPresent`
 * is false when any of the three cursor keys is missing or unparseable, in
 * which case the first-sync bootstrap must run.
 */
export interface NotificationSnapshot {
  postId: number;
  subscriptionId: number;
  channel: string;
  firstSubId: number | null;
  maxPostId: number;
  cursorPresent: boolean;
  excludedGuids?: string[];
}

interface NotificationPostRow {
  id: number;
  guid: string;
  title: string;
  link: string;
  content_text: string;
  author: string | null;
  board_key: string | null;
}

interface NotificationSubRow {
  id: number;
  user_id: number;
  pattern: string;
  send_email: number;
  send_telegram: number;
  created_at: string;
  updated_at: string;
  username: string;
  email: string | null;
  telegram_chat_id: string | null;
  telegram_bind_code: string | null;
  telegram_bind_code_expires_at: string | null;
}

const COMPILED_RULE_CACHE_LIMIT = 256;
const compiledRuleCache = new Map<number, { key: string; segments: readonly RegExp[] | null }>();

function compiledSegmentsFor(sub: NotificationSubRow, timings: { compileMs: number }): readonly RegExp[] | null {
  const key = `${sub.id}:${sub.updated_at}:${sub.pattern}`;
  const cached = compiledRuleCache.get(sub.id);
  if (cached && cached.key === key) return cached.segments;
  const compileStartedAt = Date.now();
  const compiled = compileChainedRule(sub.pattern);
  timings.compileMs += Date.now() - compileStartedAt;
  const segments = compiled.ok ? compiled.segments : null;
  if (cached) compiledRuleCache.delete(sub.id);
  compiledRuleCache.set(sub.id, { key, segments });
  while (compiledRuleCache.size > COMPILED_RULE_CACHE_LIMIT) {
    const oldest = compiledRuleCache.keys().next();
    if (oldest.done) break;
    compiledRuleCache.delete(oldest.value);
  }
  return segments;
}

function parseCursorInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function loadNotificationSnapshot(env: Env): Promise<NotificationSnapshot> {
  const row = await one<{
    postId: string | null;
    subscriptionId: string | null;
    channel: string | null;
    firstSubId: number | null;
    maxPostId: number | null;
    firstSyncIncomplete: string | null;
  }>(
    env.DB.prepare(`SELECT
      (SELECT value FROM sync_state WHERE key = ?) AS postId,
      (SELECT value FROM sync_state WHERE key = ?) AS subscriptionId,
      (SELECT value FROM sync_state WHERE key = ?) AS channel,
      (SELECT id FROM subscriptions LIMIT 1) AS firstSubId,
      (SELECT MAX(id) FROM posts) AS maxPostId,
      (SELECT value FROM sync_state WHERE key = ?) AS firstSyncIncomplete`).bind(
      NOTIFICATION_CURSOR_POST_ID,
      NOTIFICATION_CURSOR_SUBSCRIPTION_ID,
      NOTIFICATION_CURSOR_CHANNEL,
      FIRST_SYNC_INCOMPLETE_KEY
    )
  );
  const rawMax = row?.maxPostId ?? null;
  const maxPostId = typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax >= 0 ? rawMax : 0;
  const rawFirst = row?.firstSubId ?? null;
  const firstSubId = typeof rawFirst === "number" && Number.isInteger(rawFirst) && rawFirst >= 0 ? rawFirst : null;
  const rawPostId = row?.postId ?? null;
  const rawSubscriptionId = row?.subscriptionId ?? null;
  const rawChannel = row?.channel ?? null;
  const postId = rawPostId === null ? null : parseCursorInteger(rawPostId);
  const subscriptionId = rawSubscriptionId === null ? null : parseCursorInteger(rawSubscriptionId);
  const channelValid = rawChannel === "" || rawChannel === "email" || rawChannel === "telegram";
  const cursorPresent = postId !== null && subscriptionId !== null && channelValid;
  return {
    postId: postId ?? maxPostId,
    subscriptionId: subscriptionId ?? 0,
    channel: channelValid && rawChannel !== null ? rawChannel : "",
    firstSubId,
    maxPostId,
    cursorPresent,
    excludedGuids: parseTimeoutReleaseGuids(row?.firstSyncIncomplete ?? null)
  };
}

/**
 * The old bootstrap stored MAX(posts.id) although the cursor means "next id to
 * process", so `id >= cursor` reprocessed the newest imported post. Only the
 * no-subscription shape can come from that bootstrap (the first sync has no
 * users/subscriptions yet, and the zero-subscription catch-up wrote MAX); when
 * subscriptions exist a cursor equal to MAX is a real pending post and must not
 * be skipped.
 */
export function normalizeLegacyCursor(snapshot: NotificationSnapshot): NotificationSnapshot {
  if (!snapshot.cursorPresent) return snapshot;
  if (snapshot.firstSubId !== null) return snapshot;
  if (snapshot.postId === snapshot.maxPostId && snapshot.subscriptionId === 0 && snapshot.channel === "") {
    return { ...snapshot, postId: snapshot.maxPostId + 1 };
  }
  return snapshot;
}

function cursorUpserts(env: Env, cursor: NotificationCursor): D1PreparedStatement[] {
  const updatedAt = nowIso();
  return [
    [NOTIFICATION_CURSOR_POST_ID, String(cursor.postId)],
    [NOTIFICATION_CURSOR_SUBSCRIPTION_ID, String(cursor.subscriptionId)],
    [NOTIFICATION_CURSOR_CHANNEL, cursor.channel]
  ].map(([key, value]) =>
    env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, value, updatedAt)
  );
}

async function persistNotificationCursor(env: Env, cursor: NotificationCursor, budget: QueryBudget): Promise<void> {
  consumeQuery(budget);
  await env.DB.batch(cursorUpserts(env, cursor));
}

export async function initializeNotificationCursor(env: Env): Promise<void> {
  const row = await one<{ maxPostId: number | null }>(env.DB.prepare("SELECT MAX(id) AS maxPostId FROM posts"));
  await env.DB.batch(cursorUpserts(env, { postId: (row?.maxPostId ?? 0) + 1, subscriptionId: 0, channel: "" }));
}

function notificationPost(row: NotificationPostRow): RssNewPost {
  return {
    guid: row.guid,
    title: row.title,
    link: row.link,
    content_html: "",
    content_text: row.content_text,
    author: row.author,
    board_key: row.board_key,
    published_at: "",
    fetched_at: ""
  };
}

function notificationSubscription(row: NotificationSubRow): Subscription {
  return {
    id: row.id,
    user_id: row.user_id,
    pattern: row.pattern,
    send_email: row.send_email,
    send_telegram: row.send_telegram
  };
}

function notificationUser(row: NotificationSubRow): User {
  return {
    id: row.user_id,
    username: row.username,
    email: row.email,
    telegram_chat_id: row.telegram_chat_id,
    telegram_bind_code: row.telegram_bind_code,
    telegram_bind_code_expires_at: row.telegram_bind_code_expires_at
  };
}

function pushKey(userId: number, subscriptionId: number, postGuid: string, channel: string): string {
  return `${userId}:${subscriptionId}:${postGuid}:${channel}`;
}

async function loadPushStatuses(env: Env, posts: NotificationPostRow[]): Promise<Map<string, string>> {
  const guids = posts.map((post) => post.guid);
  const placeholders = guids.map(() => "?").join(",");
  const rows = await all<{ user_id: number; subscription_id: number; post_guid: string; channel: string; status: string }>(
    env.DB.prepare(`SELECT user_id, subscription_id, post_guid, channel, status FROM push_logs WHERE post_guid IN (${placeholders})`).bind(...guids)
  );
  return new Map(rows.map((row) => [pushKey(row.user_id, row.subscription_id, row.post_guid, row.channel), row.status]));
}

/**
 * Advance the notification frontier with bounded work: at most
 * NOTIFICATION_ATTEMPT_LIMIT channel attempts and NOTIFICATION_MATCH_UNIT_LIMIT
 * regex evaluations per invocation. The persisted cursor is always the exact
 * next post/subscription/channel triple, so a failure retries that triple on
 * the next invocation instead of dropping the notification.
 */
export async function processNotifications(
  env: Env,
  budget: QueryBudget,
  snapshot?: NotificationSnapshot
): Promise<{
  attempts: number;
  matches: number;
  skipped: number;
  cursorPostId: number;
  compileMs: number;
  matchMs: number;
  cursor: NotificationCursor;
}> {
  const compileTimings = { compileMs: 0 };
  let matchMs = 0;

  let current: NotificationSnapshot;
  if (snapshot) {
    current = snapshot;
  } else {
    consumeQuery(budget);
    current = await loadNotificationSnapshot(env);
  }
  const normalized = normalizeLegacyCursor(current);
  const legacyAdjusted = normalized.postId !== current.postId;
  const maxPostId = normalized.maxPostId;
  const excludedGuids = new Set(normalized.excludedGuids ?? []);

  if (!normalized.cursorPresent) {
    const bootstrapCursor: NotificationCursor = { postId: maxPostId + 1, subscriptionId: 0, channel: "" };
    await persistNotificationCursor(env, bootstrapCursor, budget);
    return { attempts: 0, matches: 0, skipped: 0, cursorPostId: bootstrapCursor.postId, compileMs: compileTimings.compileMs, matchMs, cursor: bootstrapCursor };
  }

  const storedCursor: NotificationCursor = {
    postId: normalized.postId,
    subscriptionId: normalized.subscriptionId,
    channel: normalized.channel === "email" || normalized.channel === "telegram" ? normalized.channel : ""
  };
  const hasSubscriptions = normalized.firstSubId !== null;

  if (!hasSubscriptions) {
    const catchupTarget = maxPostId + 1;
    if (storedCursor.postId < catchupTarget) {
      const advancedCursor: NotificationCursor = { postId: catchupTarget, subscriptionId: 0, channel: "" };
      await persistNotificationCursor(env, advancedCursor, budget);
      return { attempts: 0, matches: 0, skipped: 0, cursorPostId: advancedCursor.postId, compileMs: compileTimings.compileMs, matchMs, cursor: advancedCursor };
    }
    if (legacyAdjusted) {
      await persistNotificationCursor(env, storedCursor, budget);
    }
    return { attempts: 0, matches: 0, skipped: 0, cursorPostId: storedCursor.postId, compileMs: compileTimings.compileMs, matchMs, cursor: storedCursor };
  }

  if (storedCursor.postId > maxPostId) {
    return { attempts: 0, matches: 0, skipped: 0, cursorPostId: storedCursor.postId, compileMs: compileTimings.compileMs, matchMs, cursor: storedCursor };
  }

  consumeQuery(budget);
  const posts = await all<NotificationPostRow>(
    env.DB.prepare(
      `SELECT id, guid, title, link, content_text, author, board_key FROM posts WHERE id >= ? AND id <= ? ORDER BY id ASC LIMIT ${NOTIFICATION_POST_PAGE}`
    ).bind(storedCursor.postId, maxPostId)
  );
  if (!posts.length) {
    return { attempts: 0, matches: 0, skipped: 0, cursorPostId: storedCursor.postId, compileMs: compileTimings.compileMs, matchMs, cursor: storedCursor };
  }

  consumeQuery(budget);
  const pushStatuses = await loadPushStatuses(env, posts);

  const resumePostId = storedCursor.postId;
  const resumeSubscriptionId = storedCursor.subscriptionId;
  const resumeChannel = storedCursor.channel;

  let cursor: NotificationCursor = { ...storedCursor };
  let attempts = 0;
  let matches = 0;
  let skipped = 0;
  let matchUnits = 0;
  let cursorDirty = false;
  let cachedSettings: RuntimeSettings | null = null;
  let subPage: NotificationSubRow[] = [];
  let subPageStart = -1;
  let subPageComplete = false;

  const getSettings = async (): Promise<RuntimeSettings> => {
    if (!cachedSettings) {
      // Charge the settings read before it happens so the ledger stays an
      // upper bound; a failed consume happens before any settings/send work.
      consumeQuery(budget);
      cachedSettings = await runtimeSettings(env);
    }
    return cachedSettings;
  };

  outer: for (const postRow of posts) {
    // The release audit stores trimmed GUIDs, but posts.guid may retain feed
    // whitespace, so compare the trimmed stored value without normalizing it.
    if (excludedGuids.has(postRow.guid.trim())) {
      // Released first-sync GUIDs may be inserted later, but they are historical
      // and must never notify. Skip the whole post (even mid-cursor) with no
      // queries, logs, or sends and advance the frontier past it.
      cursor = { postId: postRow.id + 1, subscriptionId: 0, channel: "" };
      cursorDirty = true;
      subPageStart = -1;
      continue;
    }
    const post = notificationPost(postRow);
    const haystack = `${postRow.title}\n${postRow.content_text}\n${postRow.author || ""}\n${postRow.board_key || ""}`;
    const isResumePost = postRow.id === resumePostId;
    const startSubId = isResumePost ? resumeSubscriptionId : 0;
    const channelStart = isResumePost ? resumeChannel : "";

    if (subPageStart !== startSubId) {
      consumeQuery(budget);
      subPage = await all<NotificationSubRow>(
        env.DB.prepare(`SELECT s.id, s.user_id, s.pattern, s.send_email, s.send_telegram, s.created_at, s.updated_at, u.username, u.email, u.telegram_chat_id, u.telegram_bind_code, u.telegram_bind_code_expires_at
          FROM subscriptions s
          JOIN users u ON u.id = s.user_id
          WHERE s.id >= ?
          ORDER BY s.id ASC
          LIMIT ${NOTIFICATION_SUB_PAGE}`).bind(startSubId)
      );
      subPageStart = startSubId;
      subPageComplete = subPage.length < NOTIFICATION_SUB_PAGE;
    }

    if (!subPage.length) {
      cursor = { postId: postRow.id + 1, subscriptionId: 0, channel: "" };
      cursorDirty = true;
      subPageStart = -1;
      continue;
    }

    for (const subRow of subPage) {
      const isResumePair = isResumePost && subRow.id === resumeSubscriptionId;
      const startsAtChannel = isResumePair && channelStart !== "";
      let channelIndex = isResumePair && channelStart === "telegram" ? 1 : 0;

      if (!startsAtChannel) {
        if (matchUnits >= NOTIFICATION_MATCH_UNIT_LIMIT) {
          cursor = { postId: postRow.id, subscriptionId: subRow.id, channel: "" };
          cursorDirty = true;
          break outer;
        }
        matchUnits += 1;
        const segments = compiledSegmentsFor(subRow, compileTimings);
        if (!segments) continue;
        const matchStartedAt = Date.now();
        const matched = matchChainedRule(segments, haystack);
        matchMs += Date.now() - matchStartedAt;
        if (!matched) continue;
        matches += 1;
      }

      const user = notificationUser(subRow);
      const sub = notificationSubscription(subRow);

      for (; channelIndex < NOTIFICATION_CHANNELS.length; channelIndex += 1) {
        const channel = NOTIFICATION_CHANNELS[channelIndex];
        const nextCursor: NotificationCursor =
          channelIndex + 1 < NOTIFICATION_CHANNELS.length
            ? { postId: postRow.id, subscriptionId: subRow.id, channel: NOTIFICATION_CHANNELS[channelIndex + 1] }
            : { postId: postRow.id, subscriptionId: subRow.id + 1, channel: "" };
        const key = pushKey(subRow.user_id, subRow.id, postRow.guid, channel);
        const priorStatus = pushStatuses.get(key);

        if (priorStatus === "sent" || priorStatus === "skipped") {
          skipped += 1;
          cursor = nextCursor;
          continue;
        }

        const channelEnabled = channel === "email" ? subRow.send_email !== 0 : subRow.send_telegram !== 0;
        if (!channelEnabled) {
          // Disabled channels are not delivery attempts: no push_logs write and no query,
          // keeping writes bounded by NOTIFICATION_ATTEMPT_LIMIT (D1 query budget).
          cursor = nextCursor;
          continue;
        }

        if (attempts >= NOTIFICATION_ATTEMPT_LIMIT) {
          // An unevaluated pair must restart at its first channel so the next
          // invocation re-runs the regex instead of assuming the rule matched.
          cursor = { postId: postRow.id, subscriptionId: subRow.id, channel: channelIndex === 0 ? "" : channel };
          cursorDirty = true;
          break outer;
        }

        if (budgetRemaining(budget) < 2) {
          // Reserve one query for the log write and one for the final cursor
          // persist. Sending without the log slot would replay this delivery.
          cursor = { postId: postRow.id, subscriptionId: subRow.id, channel: channelIndex === 0 ? "" : channel };
          cursorDirty = true;
          break outer;
        }
        attempts += 1;
        consumeQuery(budget);

        const settings = await getSettings();
        const result = channel === "email"
          ? await sendBrevo(env, user, sub, post, settings)
          : await sendTelegram(env, user, sub, post, settings);

        await recordPushLog(env, subRow.user_id, subRow.id, postRow.guid, channel, result.status, result.error);
        pushStatuses.set(key, result.status);

        if (result.status === "failed") {
          cursor = { postId: postRow.id, subscriptionId: subRow.id, channel };
          cursorDirty = true;
          break outer;
        }
        if (result.status === "skipped") skipped += 1;
        cursor = nextCursor;
      }
    }

    if (!subPageComplete) {
      cursor = { postId: postRow.id, subscriptionId: subPage[subPage.length - 1].id + 1, channel: "" };
      cursorDirty = true;
      break;
    }

    cursor = { postId: postRow.id + 1, subscriptionId: 0, channel: "" };
    cursorDirty = true;
    if (subPageStart > 0) subPageStart = -1;
  }

  if (cursorDirty) {
    if (budgetRemaining(budget) < 1) {
      console.warn("notification_cursor_persist_skipped_no_budget");
    } else {
      await persistNotificationCursor(env, cursor, budget);
    }
  }
  return { attempts, matches, skipped, cursorPostId: cursor.postId, compileMs: compileTimings.compileMs, matchMs, cursor };
}

export async function createSubscription(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJson<{ pattern?: string; sendEmail?: boolean; sendTelegram?: boolean }>(request);
  // Same gate as imports and block rules: reject invalid/hazardous regex at
  // creation time instead of letting the cron matcher silently drop it later.
  const result = validatePatternInput(body.pattern ?? "");
  if (!result.ok) return Response.json({ error: `订阅正则无效：${result.reason}` }, { status: 400 });
  await env.DB.prepare("INSERT INTO subscriptions (user_id, pattern, send_email, send_telegram, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))")
    .bind(user.id, result.pattern, body.sendEmail === false ? 0 : 1, body.sendTelegram === false ? 0 : 1)
    .run();
  return Response.json({ ok: true });
}
