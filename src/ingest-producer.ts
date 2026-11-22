// Queue-mode RSS producer (INGEST_MODE=queue).
//
// The sync cron keeps fetch + diagnosis + status writes, but hands the raw
// item chunks to the consumer instead of parsing/sanitizing/inserting/FTS.
// Everything that must happen before enqueue (feed-internal dedupe, posts.guid
// existence prefilter, maxNewPosts cap, first-sync snapshot) is pure and shared
// with the fixtures.
//
// First-sync ordering is the correctness contract: the snapshot (plus its
// bounded-retry window start) is persisted in one batch before anything is
// dispatched, bootstrap rounds only dispatch snapshot items under maxNewPosts,
// and posts outside the snapshot are dispatched only after the atomic
// completion batch has moved the notification cursor past every committed post.
// After FIRST_SYNC_RETRY_WINDOW_MS the producer releases the first sync: it
// records the still-missing snapshot GUIDs as notification exclusions, advances
// the cursor, and dispatches posts outside the snapshot so a permanently
// skipped item cannot block notifications forever.
import { nowIso, one } from "./db";
import {
  FIRST_SYNC_INCOMPLETE_KEY,
  buildTimeoutReleaseDetail,
  isValidFirstSyncStart,
  parseFirstSyncStartMs,
  parseTimeoutReleaseGuids
} from "./first-sync";
import { buildIngestMessages, chunkMessagesForSend, INGEST_HARD_BYTES, type IngestItem, type IngestMessageV1 } from "./ingest-message";
import { cheapGuid, fetchRssXml, persistSyncFailure, persistSyncSuccess, queryExistingGuids, splitItemChunks } from "./rss";
import type { RssSyncTiming, SafeRssSyncResult } from "./rss";
import type { Env } from "./types";

const DEFAULT_RSS_URL = "https://rss.nodeseek.com/";
const FIRST_SYNC_GUIDS_KEY = "first_sync_guids";
const FIRST_SYNC_STARTED_AT_KEY = "first_sync_started_at";
const FIRST_SYNC_MAX_GUIDS = 20;
// Bounded bootstrap retry window. Within it a missing snapshot GUID is
// re-enqueued under maxNewPosts; after it re-enqueueing stops and only the
// commit check plus a diagnostic continue.
export const FIRST_SYNC_RETRY_WINDOW_MS = 10 * 60 * 1000;
// Canary item count per message; the consumer contract still accepts 10.
export const INGEST_PRODUCER_ITEMS = 5;

// Build-time canary downgrade: only the three supported sizes are accepted;
// absent or anything else falls back to the default 5.
export function resolveIngestItemsPerMessage(raw?: string): 1 | 3 | 5 {
  if (raw === "1") return 1;
  if (raw === "3") return 3;
  return INGEST_PRODUCER_ITEMS;
}

// A missing/unparseable start is treated as "not expired": an upgraded database
// without the key must finish its current bootstrap instead of stalling at once.
export function isFirstSyncWindowExpired(startedAt: string | null, now: number): boolean {
  const started = parseFirstSyncStartMs(startedAt);
  if (started === null) return false;
  return now - started >= FIRST_SYNC_RETRY_WINDOW_MS;
}
const NOTIFICATION_CURSOR_POST_ID = "notification_cursor_post_id";
const NOTIFICATION_CURSOR_SUBSCRIPTION_ID = "notification_cursor_subscription_id";
const NOTIFICATION_CURSOR_CHANNEL = "notification_cursor_channel";

function uniqueGuids(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const guid = raw.trim();
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      unique.push(guid);
    }
  }
  return unique;
}

// The bootstrap snapshot is the current feed's GUID set, bounded by the cap.
export function selectFirstSyncGuids(feedGuids: string[]): string[] {
  return uniqueGuids(feedGuids).slice(0, FIRST_SYNC_MAX_GUIDS);
}

export interface EnqueuePlanInput {
  chunks: string[];
  guids: string[];
  existingGuids: string[];
  maxNewPosts: number | null;
  retryGuids?: string[];
}

export interface EnqueuePlan {
  items: IngestItem[];
  invalidCount: number;
  duplicateCount: number;
  existingCount: number;
  cappedCount: number;
  retryQueuedGuids: string[];
  retryMissingFromFeed: string[];
}

// With a finite cap, eligible first-sync retry GUIDs are selected first (up to
// the cap) and new GUIDs fill the remaining budget in feed order, so retries
// cannot be starved while the cap still bounds every queued item. Without a
// cap, new GUIDs keep feed order and the deduped retry GUIDs follow.
export function planEnqueueTargets(input: EnqueuePlanInput): EnqueuePlan {
  const existing = new Set(input.existingGuids);
  const seen = new Set<string>();
  const feedByGuid = new Map<string, string>();
  const newCandidates: IngestItem[] = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  let existingCount = 0;

  for (let index = 0; index < input.chunks.length; index += 1) {
    const guid = (input.guids[index] ?? "").trim();
    const chunk = input.chunks[index] ?? "";
    if (!guid || !chunk) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(guid)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(guid);
    feedByGuid.set(guid, chunk);
    if (existing.has(guid)) {
      existingCount += 1;
      continue;
    }
    newCandidates.push({ guid, chunk });
  }

  // Eligible retries: deduped, still resident in the feed, and not committed.
  const retryGuids = uniqueGuids(input.retryGuids ?? []);
  const eligibleRetryItems: IngestItem[] = [];
  const retryMissingFromFeed: string[] = [];
  for (const guid of retryGuids) {
    if (existing.has(guid)) continue;
    const chunk = feedByGuid.get(guid);
    if (chunk === undefined) {
      retryMissingFromFeed.push(guid);
      continue;
    }
    eligibleRetryItems.push({ guid, chunk });
  }

  // Retry GUIDs also appear among the feed's new candidates; drop them there so
  // the selection below places each eligible retry exactly once.
  const retrySet = new Set(eligibleRetryItems.map((item) => item.guid));
  const normalCandidates = newCandidates.filter((item) => !retrySet.has(item.guid));

  const cap = typeof input.maxNewPosts === "number" && Number.isFinite(input.maxNewPosts) && input.maxNewPosts >= 0
    ? Math.floor(input.maxNewPosts)
    : null;
  let items: IngestItem[];
  if (cap === null) {
    items = [...normalCandidates, ...eligibleRetryItems];
  } else {
    const retryItems = eligibleRetryItems.slice(0, cap);
    const newItemBudget = cap - retryItems.length;
    items = [...retryItems, ...normalCandidates.slice(0, newItemBudget)];
  }

  // Every candidate the cap left behind, counting skipped retries as capping.
  const cappedCount = Math.max(0, normalCandidates.length + eligibleRetryItems.length - items.length);
  const queued = new Set(items.map((item) => item.guid));
  const retryQueuedGuids = retryGuids.filter((guid) => queued.has(guid));

  return { items, invalidCount, duplicateCount, existingCount, cappedCount, retryQueuedGuids, retryMissingFromFeed };
}

export interface BootstrapPlanInput {
  snapshotGuids: string[];
  chunks: string[];
  guids: string[];
  existingGuids: string[];
  maxNewPosts?: number | null;
}

export interface BootstrapPlan {
  items: IngestItem[];
  missingGuids: string[];
  missingFromFeed: string[];
  invalidGuids: string[];
  cappedCount: number;
  allPresent: boolean;
  invalidCount: number;
  duplicateCount: number;
}

// Bootstrap rounds dispatch only snapshot GUIDs that are not committed yet and
// still resident in the feed. maxNewPosts also applies here: items deferred by
// the cap are simply retried next round and are never reported as unreachable.
// New posts outside the snapshot are deliberately not selected here: they must
// wait for completion.
export function planBootstrapEnqueue(input: BootstrapPlanInput): BootstrapPlan {
  const existing = new Set(input.existingGuids);
  const snapshot = uniqueGuids(input.snapshotGuids);
  const feedResident = new Set<string>();
  const feedByGuid = new Map<string, string>();
  let invalidCount = 0;
  let duplicateCount = 0;

  for (let index = 0; index < input.chunks.length; index += 1) {
    const guid = (input.guids[index] ?? "").trim();
    const chunk = input.chunks[index] ?? "";
    if (!guid) {
      invalidCount += 1;
      continue;
    }
    feedResident.add(guid);
    if (!chunk) {
      invalidCount += 1;
      continue;
    }
    if (feedByGuid.has(guid)) {
      duplicateCount += 1;
      continue;
    }
    feedByGuid.set(guid, chunk);
  }

  const missingGuids = snapshot.filter((guid) => !existing.has(guid));
  const packable: IngestItem[] = [];
  const invalidGuids: string[] = [];
  const missingFromFeed: string[] = [];
  for (const guid of missingGuids) {
    const chunk = feedByGuid.get(guid);
    if (chunk !== undefined) {
      packable.push({ guid, chunk });
    } else if (feedResident.has(guid)) {
      invalidGuids.push(guid);
    } else {
      missingFromFeed.push(guid);
    }
  }

  const cap = typeof input.maxNewPosts === "number" && Number.isFinite(input.maxNewPosts) && input.maxNewPosts >= 0
    ? Math.floor(input.maxNewPosts)
    : null;
  const items = cap === null ? packable : packable.slice(0, cap);

  return {
    items,
    missingGuids,
    missingFromFeed,
    invalidGuids,
    cappedCount: packable.length - items.length,
    allPresent: snapshot.length > 0 && missingGuids.length === 0,
    invalidCount,
    duplicateCount
  };
}

interface FirstSyncState {
  done: boolean;
  guids: string[];
  startedAt: string | null;
  releasedGuids: string[];
}

function parseGuidList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

async function loadFirstSyncState(env: Env): Promise<FirstSyncState> {
  const row = await one<{ done: string | null; guids: string | null; startedAt: string | null; incomplete: string | null }>(
    env.DB.prepare(`SELECT
      (SELECT value FROM sync_state WHERE key = 'first_sync_done') AS done,
      (SELECT value FROM sync_state WHERE key = '${FIRST_SYNC_GUIDS_KEY}') AS guids,
      (SELECT value FROM sync_state WHERE key = '${FIRST_SYNC_STARTED_AT_KEY}') AS startedAt,
      (SELECT value FROM sync_state WHERE key = '${FIRST_SYNC_INCOMPLETE_KEY}') AS incomplete`)
  );
  const startedAt = row?.startedAt?.trim();
  return {
    done: row?.done === "1",
    guids: parseGuidList(row?.guids ?? null),
    startedAt: startedAt ? startedAt : null,
    releasedGuids: parseTimeoutReleaseGuids(row?.incomplete ?? null)
  };
}

// Released snapshot GUIDs may still be inserted later (an in-flight consumer
// message or a later feed appearance), but they must never be dispatched again
// or consume maxNewPosts slots. Membership trims the GUID; the original chunk
// and GUID values (and their alignment) are preserved.
function filterReleasedChunks(chunks: string[], guids: string[], released: Set<string>): { chunks: string[]; guids: string[] } {
  const keptChunks: string[] = [];
  const keptGuids: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const guid = guids[index] ?? "";
    if (released.has(guid.trim())) continue;
    keptChunks.push(chunks[index] ?? "");
    keptGuids.push(guid);
  }
  return { chunks: keptChunks, guids: keptGuids };
}

function upsertStateStatement(env: Env, key: string, value: string, updatedAt: string): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, value, updatedAt);
}

async function writeState(env: Env, key: string, value: string): Promise<void> {
  await upsertStateStatement(env, key, value, nowIso()).run();
}

// Snapshot and retry-window start land in one batch. A failed write throws
// before any message is dispatched, so the next round re-derives the snapshot.
async function writeFirstSyncSnapshot(env: Env, snapshot: string[], startedAt: string): Promise<void> {
  const updatedAt = nowIso();
  await env.DB.batch([
    upsertStateStatement(env, FIRST_SYNC_GUIDS_KEY, JSON.stringify(snapshot), updatedAt),
    upsertStateStatement(env, FIRST_SYNC_STARTED_AT_KEY, startedAt, updatedAt)
  ]);
}

// One atomic batch: point the notification frontier at the newest committed
// post (the notify cron treats the cursor as "next id to process"), enable
// notifications, and drop the bootstrap bookkeeping. The cursor is derived in
// SQL inside the batch so it cannot be split from completion by a concurrent
// insert. The cursor writes are gated on the not-done state so a duplicate
// completion can neither rewind nor advance an already-moving cursor.
async function completeFirstSync(env: Env): Promise<void> {
  const updatedAt = nowIso();
  const cursorGuard = "WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'first_sync_done' AND value = '1')";
  await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO sync_state (key, value, updated_at) SELECT ?, CAST((SELECT COALESCE(MAX(id), 0) + 1 FROM posts) AS TEXT), ? ${cursorGuard}`).bind(NOTIFICATION_CURSOR_POST_ID, updatedAt),
    env.DB.prepare(`INSERT OR REPLACE INTO sync_state (key, value, updated_at) SELECT ?, ?, ? ${cursorGuard}`).bind(NOTIFICATION_CURSOR_SUBSCRIPTION_ID, "0", updatedAt),
    env.DB.prepare(`INSERT OR REPLACE INTO sync_state (key, value, updated_at) SELECT ?, ?, ? ${cursorGuard}`).bind(NOTIFICATION_CURSOR_CHANNEL, "", updatedAt),
    upsertStateStatement(env, "first_sync_done", "1", updatedAt),
    env.DB.prepare("DELETE FROM sync_state WHERE key IN (?, ?)").bind(FIRST_SYNC_GUIDS_KEY, FIRST_SYNC_STARTED_AT_KEY),
    env.DB.prepare("DELETE FROM sync_state WHERE key = ? AND value NOT LIKE ?").bind(FIRST_SYNC_INCOMPLETE_KEY, '%"reason":"timeout_released"%')
  ]);
}

// Timeout release: identical completion shape, but the notification frontier is
// advanced before any normal message is dispatched and the still-missing
// snapshot GUIDs are written into the exclusion audit instead of being awaited
// forever. Every write but `first_sync_done` is gated on the not-done state, so
// a concurrent normal completion cannot be overwritten with a stale release
// audit and a duplicate release cannot rewind the advanced cursor.
async function releaseFirstSync(env: Env, startedAt: string, missingGuids: string[]): Promise<void> {
  const updatedAt = nowIso();
  const cursorGuard = "WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'first_sync_done' AND value = '1')";
  await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO sync_state (key, value, updated_at) SELECT ?, CAST((SELECT COALESCE(MAX(id), 0) + 1 FROM posts) AS TEXT), ? ${cursorGuard}`).bind(NOTIFICATION_CURSOR_POST_ID, updatedAt),
    env.DB.prepare(`INSERT OR REPLACE INTO sync_state (key, value, updated_at) SELECT ?, ?, ? ${cursorGuard}`).bind(NOTIFICATION_CURSOR_SUBSCRIPTION_ID, "0", updatedAt),
    env.DB.prepare(`INSERT OR REPLACE INTO sync_state (key, value, updated_at) SELECT ?, ?, ? ${cursorGuard}`).bind(NOTIFICATION_CURSOR_CHANNEL, "", updatedAt),
    env.DB.prepare(`INSERT OR REPLACE INTO sync_state (key, value, updated_at) SELECT ?, ?, ? ${cursorGuard}`).bind(FIRST_SYNC_INCOMPLETE_KEY, buildTimeoutReleaseDetail(startedAt, updatedAt, missingGuids), updatedAt),
    upsertStateStatement(env, "first_sync_done", "1", updatedAt),
    env.DB.prepare("DELETE FROM sync_state WHERE key IN (?, ?)").bind(FIRST_SYNC_GUIDS_KEY, FIRST_SYNC_STARTED_AT_KEY)
  ]);
}

async function recordFirstSyncIncomplete(env: Env, missing: number, requeued: number): Promise<void> {
  const detail = JSON.stringify({ missing, requeued, at: nowIso() });
  console.warn("first_sync_incomplete", detail);
  try {
    // A pre-release retry round that is still in flight must not resurrect the
    // legacy diagnostic after the timeout release has already completed.
    await env.DB.prepare(`INSERT OR REPLACE INTO sync_state (key, value, updated_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'first_sync_done' AND value = '1')`)
      .bind(FIRST_SYNC_INCOMPLETE_KEY, detail, nowIso())
      .run();
  } catch (error) {
    console.error("first_sync_incomplete persist failed", error instanceof Error ? error.message : String(error));
  }
}

function emptyTimings(): RssSyncTiming {
  return { fetchRssMs: 0, fetchFirstStrategyMs: 0, fetchRetryStrategyMs: 0, parseItemsMs: 0, parseItemCount: 0, prepareInsertMs: 0, insertBindRunMs: 0, insertNewCount: 0, insertExistingCount: 0, insertLoopMs: 0, insertPostsMs: 0, writeSyncStateMs: 0, totalMs: 0 };
}

async function sendMessages(env: Env, messages: IngestMessageV1[]): Promise<void> {
  for (const group of chunkMessagesForSend(messages)) {
    await env.INGEST_QUEUE.sendBatch(group.map((body) => ({ body })));
  }
}

export async function enqueueRss(env: Env, options?: { maxNewPosts?: number }): Promise<SafeRssSyncResult> {
  const startedAt = Date.now();
  const rssUrl = env.RSS_URL || DEFAULT_RSS_URL;
  const maxNewPosts = options?.maxNewPosts ?? null;
  try {
    if (!env.INGEST_QUEUE) throw new Error("INGEST_QUEUE binding is missing; INGEST_MODE=queue requires a Queue producer");
    const { xml, strategy, timings: fetchTimings } = await fetchRssXml(env, rssUrl);
    const chunks = splitItemChunks(xml);
    const guidStartedAt = Date.now();
    const guids = chunks.map((chunk) => cheapGuid(chunk));
    const guidExtractMs = Date.now() - guidStartedAt;
    const feedGuids = uniqueGuids(guids);
    const firstState = await loadFirstSyncState(env);
    // During bootstrap the probe also covers persisted snapshot GUIDs that have
    // already rolled out of the feed; otherwise completion could never be seen.
    const probeGuids = firstState.done ? feedGuids : uniqueGuids(feedGuids, firstState.guids);
    const existingGuids = Array.from(await queryExistingGuids(env, probeGuids));
    const syncRunId = crypto.randomUUID();
    const maxItems = resolveIngestItemsPerMessage(env.INGEST_ITEMS_PER_MESSAGE);
    const build = (items: IngestItem[], firstSyncCandidate: boolean, cap: number | null) =>
      buildIngestMessages(items, { syncRunId, feedUrl: rssUrl, firstSyncCandidate, maxNewPosts: cap, maxItems });

    let messages: IngestMessageV1[] = [];
    let oversize: IngestItem[] = [];
    let invalidItems: IngestItem[] = [];
    let prefilterInvalid = 0;
    let existingCount = 0;
    let cappedCount = 0;
    let snapshotMissing: string[] = [];
    let snapshotUnreachable: string[] = [];
    let snapshotRequeued = 0;

    let snapshot = firstState.guids;
    let firstSyncStartedAt = firstState.startedAt;
    if (!firstState.done && snapshot.length === 0 && feedGuids.length > 0) {
      snapshot = selectFirstSyncGuids(feedGuids);
      firstSyncStartedAt = nowIso();
      // Snapshot + window start first, dispatch second: a failed write throws
      // below, so the catch path records last_sync_error and no message is sent.
      await writeFirstSyncSnapshot(env, snapshot, firstSyncStartedAt);
    } else if (!firstState.done && snapshot.length > 0 && !isValidFirstSyncStart(firstSyncStartedAt)) {
      // The snapshot predates the window key (or the key is malformed); repair
      // it to now so a bad value is never treated as an already-expired window.
      firstSyncStartedAt = nowIso();
      await writeState(env, FIRST_SYNC_STARTED_AT_KEY, firstSyncStartedAt);
    }
    const firstSyncStart = firstSyncStartedAt ?? nowIso();
    const windowExpired = isFirstSyncWindowExpired(firstSyncStart, Date.now());
    let firstSyncReleased = false;

    if (!firstState.done && snapshot.length === 0) {
      // Empty first feed: nothing to import; notifications start later.
      await completeFirstSync(env);
    } else if (!firstState.done) {
      const plan = planBootstrapEnqueue({ snapshotGuids: snapshot, chunks, guids, existingGuids, maxNewPosts });
      prefilterInvalid = plan.invalidCount;
      if (plan.allPresent) {
        // Completion must land before this round's non-snapshot posts.
        await completeFirstSync(env);
        const filtered = filterReleasedChunks(chunks, guids, new Set(firstState.releasedGuids));
        const normal = planEnqueueTargets({ ...filtered, existingGuids, maxNewPosts });
        const built = build(normal.items, false, maxNewPosts);
        messages = built.messages;
        oversize = built.oversize;
        invalidItems = built.invalid;
        existingCount = normal.existingCount;
        cappedCount = normal.cappedCount;
      } else {
        existingCount = snapshot.length - plan.missingGuids.length;
        snapshotMissing = plan.missingGuids;
        cappedCount = plan.cappedCount;
        if (windowExpired) {
          // Release before dispatch: the notification cursor must move past the
          // newest committed post before any post outside the snapshot is sent.
          const releasedGuids = uniqueGuids(plan.missingGuids);
          await releaseFirstSync(env, firstSyncStart, releasedGuids);
          firstSyncReleased = true;
          console.warn("first_sync_timeout_released", JSON.stringify({ missing: releasedGuids.length }));
          const filtered = filterReleasedChunks(chunks, guids, new Set(releasedGuids));
          const normal = planEnqueueTargets({ ...filtered, existingGuids, maxNewPosts });
          const built = build(normal.items, false, maxNewPosts);
          messages = built.messages;
          oversize = built.oversize;
          invalidItems = built.invalid;
          prefilterInvalid = normal.invalidCount;
          existingCount = normal.existingCount;
          cappedCount = normal.cappedCount;
        } else {
          const built = build(plan.items, true, maxNewPosts);
          messages = built.messages;
          oversize = built.oversize;
          invalidItems = built.invalid;
          const packed = new Set<string>();
          for (const message of messages) for (const item of message.items) packed.add(item.guid);
          const unpacked = plan.items.filter((item) => !packed.has(item.guid)).map((item) => item.guid);
          snapshotRequeued = messages.reduce((total, message) => total + message.items.length, 0);
          snapshotUnreachable = [...plan.missingFromFeed, ...plan.invalidGuids, ...unpacked];
        }
      }
    } else {
      const filtered = filterReleasedChunks(chunks, guids, new Set(firstState.releasedGuids));
      const plan = planEnqueueTargets({ ...filtered, existingGuids, maxNewPosts });
      prefilterInvalid = plan.invalidCount;
      const built = build(plan.items, false, maxNewPosts);
      messages = built.messages;
      oversize = built.oversize;
      invalidItems = built.invalid;
      existingCount = plan.existingCount;
      cappedCount = plan.cappedCount;
    }

    if (prefilterInvalid > 0 || invalidItems.length > 0) {
      console.warn("rss_prefilter_invalid_items", JSON.stringify({ invalid: prefilterInvalid + invalidItems.length }));
    }
    if (cappedCount > 0) {
      console.warn("rss_enqueue_capped", JSON.stringify({ cap: maxNewPosts, capped: cappedCount }));
    }
    if (oversize.length > 0) {
      // A single item above the hard byte limit cannot be transported without
      // truncating the body; recording it is the explicit, non-silent fallback.
      const detail = `rss_ingest_oversize: ${oversize.length} item(s) exceed ${INGEST_HARD_BYTES} bytes`;
      console.error(detail, JSON.stringify({ guids: oversize.map((item) => item.guid.slice(0, 64)) }));
      try {
        await writeState(env, "last_ingest_error", `${nowIso()} ${detail}`.slice(0, 500));
      } catch (error) {
        console.error("ingest oversize diagnostic persist failed", error instanceof Error ? error.message : String(error));
      }
    }

    let enqueuedItems = 0;
    for (const message of messages) enqueuedItems += message.items.length;
    await sendMessages(env, messages);
    if (snapshotMissing.length > 0 && snapshotUnreachable.length > 0) {
      await recordFirstSyncIncomplete(env, snapshotMissing.length, snapshotRequeued);
    }

    const writeStateStartedAt = Date.now();
    await persistSyncSuccess(env, strategy, { markFirstSyncDone: false });
    const writeSyncStateMs = Date.now() - writeStateStartedAt;
    const parseItemsMs = guidExtractMs;
    return {
      inserted: 0,
      firstSync: !firstState.done && !firstSyncReleased,
      insertedPosts: [],
      ok: true,
      strategy,
      timings: {
        ...fetchTimings,
        parseItemsMs,
        parseItemCount: chunks.length,
        prepareInsertMs: 0,
        insertBindRunMs: 0,
        insertNewCount: 0,
        insertExistingCount: existingCount,
        insertLoopMs: 0,
        insertPostsMs: 0,
        writeSyncStateMs,
        totalMs: Date.now() - startedAt,
        guidExtractMs,
        guidExtractCount: chunks.length,
        fullParseMs: 0,
        fullParseCount: 0,
        guidMismatchCount: 0,
        indexFailureCount: 0,
        enqueuedItems,
        enqueuedMessages: messages.length
      },
      cpu: { parseItemsMs, parseItemCount: chunks.length }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("RSS enqueue failed", message);
    try {
      await persistSyncFailure(env, message);
    } catch (stateError) {
      console.error("RSS enqueue state persist failed", stateError instanceof Error ? stateError.message : String(stateError));
    }
    return { inserted: 0, firstSync: false, insertedPosts: [], ok: false, error: message, timings: emptyTimings(), cpu: { parseItemsMs: 0, parseItemCount: 0 } };
  }
}
