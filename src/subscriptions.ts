import { all, readJson } from "./db";
import { safeRegex } from "./filters";
import { validatePatternInput } from "./rule-import";
import { sendBrevo, sendTelegram } from "./notifications";
import { runtimeSettings } from "./settings";
import type { Env, RssNewPost, Subscription, User } from "./types";

interface SubscriptionWithUser extends Subscription {
  username: string;
  email: string | null;
  telegram_chat_id: string | null;
  telegram_bind_code: string | null;
  telegram_bind_code_expires_at: string | null;
}

interface SubscriptionProcessTimings {
  loadSubsMs: number;
  loadSentMs: number;
  compileRegexMs: number;
  buildPostTextsMs: number;
  matchMs: number;
  sendMs: number;
  totalMs: number;
}

function pushKey(userId: number, subscriptionId: number, postGuid: string, channel: string): string {
  return `${userId}:${subscriptionId}:${postGuid}:${channel}`;
}

export async function processSubscriptions(env: Env, posts: RssNewPost[]): Promise<SubscriptionProcessTimings> {
  const startedAt = Date.now();
  if (!posts.length) return { loadSubsMs: 0, loadSentMs: 0, compileRegexMs: 0, buildPostTextsMs: 0, matchMs: 0, sendMs: 0, totalMs: 0 };
  const loadSubsStartedAt = Date.now();
  const subs = await all<SubscriptionWithUser>(env.DB.prepare(`
    SELECT s.*, u.username, u.email, u.telegram_chat_id, u.telegram_bind_code, u.telegram_bind_code_expires_at
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    ORDER BY s.id DESC
  `));
  const loadSubsMs = Date.now() - loadSubsStartedAt;
  if (!subs.length) return { loadSubsMs, loadSentMs: 0, compileRegexMs: 0, buildPostTextsMs: 0, matchMs: 0, sendMs: 0, totalMs: Date.now() - startedAt };
  const loadSentStartedAt = Date.now();
  const postGuids = posts.map((post) => post.guid);
  const logRows: { user_id: number; subscription_id: number; post_guid: string; channel: string }[] = [];
  for (let offset = 0; offset < postGuids.length; offset += 100) {
    const guidChunk = postGuids.slice(offset, offset + 100);
    const placeholders = guidChunk.map(() => "?").join(",");
    const rows = await all<{ user_id: number; subscription_id: number; post_guid: string; channel: string }>(
      env.DB.prepare(`SELECT user_id, subscription_id, post_guid, channel FROM push_logs WHERE post_guid IN (${placeholders})`).bind(...guidChunk)
    );
    logRows.push(...rows);
  }
  const sent = new Set(logRows.map((row) => pushKey(row.user_id, row.subscription_id, row.post_guid, row.channel)));
  const loadSentMs = Date.now() - loadSentStartedAt;
  const compileStartedAt = Date.now();
  const compiledSubs = subs.map((sub) => ({ sub, regex: safeRegex(sub.pattern) })).filter((item): item is { sub: SubscriptionWithUser; regex: RegExp } => !!item.regex);
  const compileRegexMs = Date.now() - compileStartedAt;
  if (!compiledSubs.length) return { loadSubsMs, loadSentMs, compileRegexMs, buildPostTextsMs: 0, matchMs: 0, sendMs: 0, totalMs: Date.now() - startedAt };
  const buildPostTextsStartedAt = Date.now();
  const settings = await runtimeSettings(env);
  const postTexts = new Map(posts.map((post) => [post.guid, `${post.title}\n${post.content_text}\n${post.author || ""}\n${post.board_key || ""}`]));
  const buildPostTextsMs = Date.now() - buildPostTextsStartedAt;
  const matchStartedAt = Date.now();
  let sendMs = 0;
  for (const { sub, regex } of compiledSubs) {
    const user: User = { id: sub.user_id, username: sub.username, email: sub.email, telegram_chat_id: sub.telegram_chat_id, telegram_bind_code: sub.telegram_bind_code, telegram_bind_code_expires_at: sub.telegram_bind_code_expires_at };
    for (const post of posts) {
      if (!regex.test(postTexts.get(post.guid) || "")) continue;
      if (sub.send_email && !sent.has(pushKey(user.id, sub.id, post.guid, "email"))) {
        const sendStartedAt = Date.now();
        await sendBrevo(env, user, sub, post, settings);
        sendMs += Date.now() - sendStartedAt;
        sent.add(pushKey(user.id, sub.id, post.guid, "email"));
      }
      if (sub.send_telegram && !sent.has(pushKey(user.id, sub.id, post.guid, "telegram"))) {
        const sendStartedAt = Date.now();
        await sendTelegram(env, user, sub, post, settings);
        sendMs += Date.now() - sendStartedAt;
        sent.add(pushKey(user.id, sub.id, post.guid, "telegram"));
      }
    }
  }
  const matchMs = Date.now() - matchStartedAt;
  return { loadSubsMs, loadSentMs, compileRegexMs, buildPostTextsMs, matchMs, sendMs, totalMs: Date.now() - startedAt };
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
