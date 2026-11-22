// D1 capacity pruning (owner-approved 2026-11-20, see AGENTS.md).
// D1 calls are metered by an explicit QueryBudget: every budgeted call consumes
// one query immediately before it executes, and batch() counts as one query.
import type { DbPruneIndexState, Env } from "./types";
import { budgetRemaining, consumeFinalQuery, consumeQuery, createQueryBudget, markDailyWriteQuotaExhausted } from "./query-budget";
import type { QueryBudget } from "./query-budget";

export const DB_PRUNE_FREE_DEFAULT_LIMIT_MB = 480;
export const DB_PRUNE_PAID_DEFAULT_LIMIT_MB = 9850;
export const DB_PRUNE_PAID_TARGET_MB = 9000;
export const DB_PRUNE_DEFAULT_LIMIT_MB = DB_PRUNE_FREE_DEFAULT_LIMIT_MB;
export const DB_PRUNE_MIN_LIMIT_MB = 100;
export const DB_PRUNE_MAX_LIMIT_MB = 9850;
export const DB_PRUNE_HYSTERESIS_BYTES = 30_000_000;
export const DB_PRUNE_DAILY_CAP = 10_000;
export const DB_PRUNE_BATCH_SIZE = 100;
export const DB_PRUNE_DEGRADED_MAX_IDS = 10;
export const DB_PRUNE_MAX_CHUNKS = 5;
export const DB_PRUNE_MAX_SCAN_PAGES = 5;
export const DB_PRUNE_RUN_MAX_POSTS = 500;
export const DB_PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const D1_FREE_MAX_CAPACITY_MB = 500;
export const D1_PAID_MAX_CAPACITY_MB = 10000;
export const D1_FIVE_POST_MARGIN_MB = 2;

// 0014 index state machine. `sync_state.db_prune_index_state` stores exactly
// "0"/"1"/"2"; a missing row is read as "0" and is never written just to
// normalize. State 1 pauses every scheduled task except state I/O, the
// idempotent 0014 DDL, independent verification, and error logging.
export const DB_PRUNE_INDEX_STATE_KEY = "db_prune_index_state";
export const READ_STATES_INDEX_NAME = "idx_read_states_post_id";
export const READ_STATES_INDEX_DDL = "CREATE INDEX IF NOT EXISTS idx_read_states_post_id ON read_states(post_id);";

// Cross-invocation isolation. Cron invocations can overlap and a scheduled
// invocation may live for the full 15-minute Workers cron wall-clock cap, so
// both the lease and the state-1 holder threshold cover 15 minutes plus a
// margin. A non-empty lease whose timestamp cannot be parsed is NOT expired:
// only a parseable timestamp older than the cutoff may be taken over.
export const DB_PRUNE_LEASE_KEY = "db_prune_lease";
export const DB_PRUNE_LEASE_MAX_AGE_MS = 16 * 60 * 1000;
export const DB_PRUNE_INDEX_HOLDER_MAX_AGE_MS = DB_PRUNE_LEASE_MAX_AGE_MS;

// Free Workers limit is 50 D1 queries per invocation; a db.batch() counts as a
// single query (Cloudflare D1 limits). Every phase reserves headroom for the
// remaining critical work plus the final state write and lease release.
// Background budget <= 14: plan+limit reuse already-read settings, orphan cleanup
// re-probes size + blocked state + two 4-query FTS batches = 10, search backfill
// uses 3, and failure diagnosis uses at most 1.
export const DB_PRUNE_BATCH_QUERY_RESERVE = 12;
export const DB_PRUNE_DEGRADED_QUERY_RESERVE = 24;
export const DB_PRUNE_PRUNE_QUERY_RESERVE = 12;
export const DB_PRUNE_BACKGROUND_QUERY_RESERVE = 14;
export const DB_PRUNE_CLAIM_QUERY_RESERVE = 16;

const STATE_ACTIVE_KEY = "db_prune_active";
const STATE_DAY_KEY = "db_prune_day";
const STATE_DELETED_KEY = "db_prune_deleted_today";
const STATE_LAST_AT_KEY = "db_prune_last_at";
const STATE_LAST_ERROR_KEY = "db_prune_last_error";
const STATE_BLOCKED_KEY = "db_prune_blocked_full";
const STATE_FTS_TRIGRAM_CURSOR = "db_prune_fts_trigram_cursor";
const STATE_FTS_BIGRAM_CURSOR = "db_prune_fts_bigram_cursor";
// Event-driven FTS orphan cleanup: "1" only while a full-database fallback has
// intentionally left FTS rows behind. A cleared marker costs zero FTS scans.
export const STATE_FTS_ORPHANS_PENDING = "db_prune_fts_orphans_pending";
// Candidate scan cursor: JSON array [publishedAt, id, restartAt]. Only the
// lease-holding state-"2" prune writes it; index build/recovery/FTS never do.
export const STATE_CANDIDATE_CURSOR = "db_prune_candidate_cursor";

// Bounded keyset candidate pages over the (published_at, id) index. `fetched_at`
// is deliberately absent from SQL: it is filtered in memory after the bounded
// page so a large block of old-published/recently-fetched rows cannot turn the
// query into an unbounded index scan.
const CANDIDATE_SQL_FIRST = "SELECT published_at, id, fetched_at FROM posts INDEXED BY idx_posts_published_at_id WHERE published_at < ? ORDER BY published_at ASC, id ASC LIMIT ?";
const CANDIDATE_SQL_AFTER = "SELECT published_at, id, fetched_at FROM posts INDEXED BY idx_posts_published_at_id WHERE (published_at, id) > (?, ?) AND published_at < ? ORDER BY published_at ASC, id ASC LIMIT ?";

export interface PruneCandidateCursor {
  publishedAt: string;
  id: number;
  restartAt: string;
}

export interface PruneState {
  active: boolean;
  day: string;
  deletedToday: number;
  deletedTodayRaw: string;
  lastAt: string;
  lastError: string;
  hasCounter: boolean;
  blockedFull: boolean;
  ftsOrphansPending: boolean;
  candidateCursorRaw: string;
  candidateCursor: PruneCandidateCursor | null;
}

export interface PruneRunResult {
  skipped: boolean;
  sizeBytes: number | null;
  limitBytes: number;
  targetBytes: number;
  active: boolean;
  deletedToday: number;
  deletedThisRun: number;
  lastError: string;
  paidPlan: boolean;
  maxCapacityBytes: number;
  fivePostThresholdBytes: number;
  indexState: DbPruneIndexState | null;
  indexVerified: boolean;
  indexDay: boolean;
  dailyCap: number;
  dailyWriteQuotaExhausted: boolean;
}

export function clampDbPruneLimitMb(value: unknown, paid = false): number {
  const fallback = paid ? DB_PRUNE_PAID_DEFAULT_LIMIT_MB : DB_PRUNE_FREE_DEFAULT_LIMIT_MB;
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(DB_PRUNE_MAX_LIMIT_MB, Math.max(DB_PRUNE_MIN_LIMIT_MB, number));
}

/**
 * Legacy upgrade path without a migration: an explicit integer string "450"
 * (the pre-480 free default) is effective 480. An admin re-saving 450 writes
 * "450.0" via encodePruneLimitMb, which is no longer treated as the legacy row.
 */
export function decodeStoredPruneLimitMb(value: unknown, paid = false): number {
  return value === "450" ? 480 : clampDbPruneLimitMb(value, paid);
}

export function encodePruneLimitMb(value: unknown, paid = false): string {
  const mb = clampDbPruneLimitMb(value, paid);
  return mb === 450 ? "450.0" : String(mb);
}

export function pruneThresholds(limitMb: number, paid = false): { limitBytes: number; targetBytes: number } {
  const limitBytes = limitMb * 1_000_000;
  // A paid target above the trigger would loop one batch per minute.
  const targetBytes = paid && limitMb > DB_PRUNE_PAID_TARGET_MB
    ? DB_PRUNE_PAID_TARGET_MB * 1_000_000
    : Math.max(0, limitBytes - DB_PRUNE_HYSTERESIS_BYTES);
  return { limitBytes, targetBytes };
}

export function isPruneWindow(date: Date = new Date()): boolean {
  return date.getUTCHours() === 23 && date.getUTCMinutes() >= 30;
}

export function utcDayString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function decidePruneActivation(input: { sizeBytes: number; limitBytes: number; targetBytes: number; active: boolean }): boolean {
  if (input.sizeBytes >= input.limitBytes) return true;
  if (input.sizeBytes <= input.targetBytes) return false;
  return input.active;
}

/**
 * Feed-cap decision shared with the cron path in index.ts: cap new posts only
 * once the database is strictly above the plan's max capacity minus the 2MB
 * margin. An unknown plan (null) uses the paid 10GB boundary so it never caps
 * a database that might still have room.
 */
export function decideMaxNewPosts(input: { sizeBytes: number | null; paid: boolean | null }): number | undefined {
  const sizeBytes = input.sizeBytes;
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) return undefined;
  const threshold = input.paid === false ? 498_000_000 : 9_998_000_000;
  return sizeBytes > threshold ? 5 : undefined;
}

export interface IndexStateSnapshot {
  value: DbPruneIndexState;
  raw: string;
  updatedAt: string;
  present: boolean;
  invalid: boolean;
}

export interface CronStateSnapshot {
  indexState: IndexStateSnapshot;
  pruneActive: boolean;
  blockedFull: boolean;
  ftsOrphansPending: boolean;
  searchComplete: number;
}

export interface IndexVerification {
  ok: boolean;
  reason: string;
}

export interface IndexBuildOutcome {
  state: DbPruneIndexState;
  error: string;
}

export type ClaimIndexBuildStatus = "claimed" | "not-claimed" | "unknown";

export interface ClaimIndexBuildResult {
  status: ClaimIndexBuildStatus;
  token: string | null;
}

export interface BackgroundPlan {
  runFtsOrphans: boolean;
  runSearchBackfill: boolean;
}

export interface IndexRecoveryResult {
  state: IndexStateSnapshot;
  paused: boolean;
  error: string;
}

export interface PruneGateOptions {
  indexState?: IndexStateSnapshot;
  indexVerified?: boolean;
  paidPlan?: boolean;
  limitMb?: number;
  now?: () => Date;
  budget?: QueryBudget;
}

// budgetRemaining() is already net of DB_PRUNE_FINAL_QUERY_RESERVE; stages
// compare their own slot counts directly and never subtract the reserve again.
export function hasQueryHeadroom(remaining: number, needed: number): boolean {
  return remaining >= needed;
}

function takeQuery(budget: QueryBudget | undefined): void {
  if (budget) consumeQuery(budget);
}

export async function acquirePruneLease(env: Env, now: Date = new Date()): Promise<string | null> {
  const token = `${now.toISOString()}#${crypto.randomUUID()}`;
  const staleCutoff = new Date(now.getTime() - DB_PRUNE_LEASE_MAX_AGE_MS).toISOString();
  try {
    const result = await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE sync_state.value = '' OR (sync_state.updated_at <> '' AND datetime(sync_state.updated_at) IS NOT NULL AND julianday(sync_state.updated_at) <= julianday(?))")
      .bind(DB_PRUNE_LEASE_KEY, token, now.toISOString(), staleCutoff)
      .run();
    return Number(result.meta?.changes ?? 0) === 1 ? token : null;
  } catch (error) {
    const quota = toDailyWriteQuotaExhaustedError(error);
    if (quota) throw quota;
    console.error("acquirePruneLease failed", truncateMessage(error));
    return null;
  }
}

export async function refreshPruneLease(env: Env, token: string, now: Date = new Date()): Promise<boolean> {
  try {
    const result = await env.DB.prepare("UPDATE sync_state SET updated_at = ? WHERE key = ? AND value = ?")
      .bind(now.toISOString(), DB_PRUNE_LEASE_KEY, token)
      .run();
    return Number(result.meta?.changes ?? 0) === 1;
  } catch (error) {
    const quota = toDailyWriteQuotaExhaustedError(error);
    if (quota) throw quota;
    console.error("refreshPruneLease failed", truncateMessage(error));
    return false;
  }
}

export async function releasePruneLease(env: Env, token: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM sync_state WHERE key = ? AND value = ?").bind(DB_PRUNE_LEASE_KEY, token).run();
  } catch (error) {
    console.error("releasePruneLease failed", truncateMessage(error));
  }
}

export class DailyWriteQuotaExhaustedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DailyWriteQuotaExhaustedError";
  }
}

export function toDailyWriteQuotaExhaustedError(error: unknown): DailyWriteQuotaExhaustedError | null {
  if (error instanceof DailyWriteQuotaExhaustedError) return error;
  if (!isDailyWriteQuotaError(error)) return null;
  const message = errorMessageChain(error).filter(Boolean).join(" | ");
  return new DailyWriteQuotaExhaustedError(truncateMessage(message || error), { cause: error });
}

export async function runIsolated(label: string, action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    const quota = toDailyWriteQuotaExhaustedError(error);
    if (quota) throw quota;
    console.error(`${label} failed; continuing`, truncateMessage(error));
    return false;
  }
}

export function planBackgroundTasks(input: { pruneCalled: boolean; pruneActive: boolean; pruneDeletedThisRun: number }): BackgroundPlan {
  return {
    runFtsOrphans: !input.pruneCalled || !input.pruneActive || input.pruneDeletedThisRun === 0,
    runSearchBackfill: !input.pruneActive
  };
}

export function decodeIndexSnapshot(value: string | null, updatedAt: string | null, present: boolean): IndexStateSnapshot {
  if (!present) return { value: "0", raw: "", updatedAt: "", present: false, invalid: false };
  const raw = String(value ?? "");
  if (raw === "0" || raw === "1" || raw === "2") return { value: raw, raw, updatedAt: updatedAt || "", present: true, invalid: false };
  return { value: "0", raw, updatedAt: updatedAt || "", present: true, invalid: true };
}

export async function readIndexState(env: Env, budget?: QueryBudget): Promise<IndexStateSnapshot> {
  takeQuery(budget);
  const row = await env.DB.prepare("SELECT value, updated_at FROM sync_state WHERE key = ?")
    .bind(DB_PRUNE_INDEX_STATE_KEY)
    .first<{ value: string; updated_at: string }>();
  return decodeIndexSnapshot(row?.value ?? null, row?.updated_at ?? null, row !== null);
}

/**
 * Post-lease snapshot: the index-state row (value + updated_at) and the
 * search-backfill marker in one D1 statement. The lease holder re-reads both so
 * no post-lease decision (sync pre-mark or backfill gate) relies on the
 * pre-lease `readCronState` value; still exactly one query.
 */
export async function readIndexStateAfterLease(env: Env, budget?: QueryBudget): Promise<{ indexState: IndexStateSnapshot; searchComplete: number }> {
  takeQuery(budget);
  const row = await env.DB.prepare(`SELECT
      (SELECT value FROM sync_state WHERE key = ?) AS index_value,
      (SELECT updated_at FROM sync_state WHERE key = ?) AS index_updated_at,
      (SELECT complete FROM search_index_state WHERE id = 1) AS search_complete`)
    .bind(DB_PRUNE_INDEX_STATE_KEY, DB_PRUNE_INDEX_STATE_KEY)
    .first<{
      index_value: string | null;
      index_updated_at: string | null;
      search_complete: number | null;
    }>();
  return {
    indexState: decodeIndexSnapshot(row?.index_value ?? null, row?.index_updated_at ?? null, row?.index_value !== null && row?.index_value !== undefined),
    searchComplete: Number(row?.search_complete) === 1 ? 1 : 0
  };
}

/**
 * One-shot invocation snapshot: index state (value + updated_at), prune flags,
 * and the search-backfill marker in a single D1 query. The scalar subselects
 * resolve on the sync_state/search_index_state primary keys, so the combined
 * statement costs one query instead of four separate point reads.
 */
export async function readCronState(env: Env, budget?: QueryBudget): Promise<CronStateSnapshot> {
  takeQuery(budget);
  const row = await env.DB.prepare(`SELECT
      (SELECT value FROM sync_state WHERE key = ?) AS index_value,
      (SELECT updated_at FROM sync_state WHERE key = ?) AS index_updated_at,
      (SELECT value FROM sync_state WHERE key = ?) AS active_value,
      (SELECT value FROM sync_state WHERE key = ?) AS blocked_value,
      (SELECT value FROM sync_state WHERE key = ?) AS orphans_value,
      (SELECT complete FROM search_index_state WHERE id = 1) AS search_complete`)
    .bind(DB_PRUNE_INDEX_STATE_KEY, DB_PRUNE_INDEX_STATE_KEY, STATE_ACTIVE_KEY, STATE_BLOCKED_KEY, STATE_FTS_ORPHANS_PENDING)
    .first<{
      index_value: string | null;
      index_updated_at: string | null;
      active_value: string | null;
      blocked_value: string | null;
      orphans_value: string | null;
      search_complete: number | null;
    }>();
  return {
    indexState: decodeIndexSnapshot(row?.index_value ?? null, row?.index_updated_at ?? null, row?.index_value !== null && row?.index_value !== undefined),
    pruneActive: row?.active_value === "1",
    blockedFull: row?.blocked_value === "1",
    ftsOrphansPending: row?.orphans_value === "1",
    searchComplete: Number(row?.search_complete) === 1 ? 1 : 0
  };
}

export function indexStateChanged(after: IndexStateSnapshot, before: IndexStateSnapshot): boolean {
  return after.invalid !== before.invalid || after.value !== before.value || after.raw !== before.raw || after.updatedAt !== before.updatedAt;
}

export function failedIndexWindow(index: IndexStateSnapshot, now: Date = new Date()): boolean {
  if (index.invalid || index.value !== "0" || !index.updatedAt) return false;
  const updatedAt = new Date(index.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) return false;
  return utcDayString(updatedAt) === utcDayString(now) && isPruneWindow(updatedAt);
}

export function canClaimIndexBuild(index: IndexStateSnapshot, now: Date = new Date()): boolean {
  return !index.invalid && index.value === "0" && isPruneWindow(now) && !failedIndexWindow(index, now);
}

// Diagnostics only: reports whether state "2" was entered on the current UTC
// day. Every day shares the same 10,000-post cap.
export function isIndexDay(index: IndexStateSnapshot, now: Date = new Date()): boolean {
  if (index.value !== "2") return false;
  if (!index.updatedAt) return true;
  const updatedAt = new Date(index.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) return true;
  return utcDayString(updatedAt) === utcDayString(now);
}

export function isExpectedReadStatesIndexSql(sql: string): boolean {
  const normalized = sql.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  if (/^CREATE\s+UNIQUE\s+INDEX/i.test(normalized)) return false;
  if (/\bWHERE\b/i.test(normalized)) return false;
  return /^CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?idx_read_states_post_id`?|"idx_read_states_post_id"|\[idx_read_states_post_id\])\s+ON\s+(?:`?read_states`?|"read_states"|\[read_states\])\s*\(\s*(?:`?post_id`?|"post_id"|\[post_id\])\s*\)\s*;?$/i.test(normalized);
}

async function readIndexInfoRows(env: Env, budget?: QueryBudget): Promise<Array<{ seqno: number; cid: number; name: string }>> {
  try {
    takeQuery(budget);
    const result = await env.DB.prepare(`PRAGMA index_info('${READ_STATES_INDEX_NAME}')`).all<{ seqno: number; cid: number; name: string }>();
    return result.results ?? [];
  } catch (pragmaError) {
    console.error("PRAGMA index_info form failed; trying table-valued pragma", truncateMessage(pragmaError));
    takeQuery(budget);
    const result = await env.DB.prepare(`SELECT seqno, cid, name FROM pragma_index_info('${READ_STATES_INDEX_NAME}')`).all<{ seqno: number; cid: number; name: string }>();
    return result.results ?? [];
  }
}

export async function verifyReadStatesIndex(env: Env, budget?: QueryBudget): Promise<IndexVerification> {
  try {
    takeQuery(budget);
    const row = await env.DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = ?")
      .bind(READ_STATES_INDEX_NAME)
      .first<{ type: string; name: string; tbl_name: string; sql: string | null }>();
    if (!row) return { ok: false, reason: "index missing" };
    if (row.type !== "index" || row.name !== READ_STATES_INDEX_NAME || row.tbl_name !== "read_states") return { ok: false, reason: "index metadata mismatch" };
    if (!isExpectedReadStatesIndexSql(String(row.sql || ""))) return { ok: false, reason: "index definition mismatch" };
    const columns = await readIndexInfoRows(env, budget);
    if (columns.length !== 1 || Number(columns[0].seqno) !== 0 || columns[0].name !== "post_id") return { ok: false, reason: "index columns mismatch" };
    return { ok: true, reason: "" };
  } catch (error) {
    return { ok: false, reason: truncateMessage(error) };
  }
}

export async function claimIndexBuild(env: Env, observedUpdatedAt = "", budget?: QueryBudget): Promise<ClaimIndexBuildResult> {
  const token = nowIso();
  try {
    takeQuery(budget);
    const result = await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at WHERE sync_state.value = '0' AND sync_state.updated_at = ?")
      .bind(DB_PRUNE_INDEX_STATE_KEY, token, observedUpdatedAt)
      .run();
    const changes = result.meta?.changes;
    if (typeof changes !== "number" || !Number.isFinite(changes)) return { status: "unknown", token: null };
    return changes === 1 ? { status: "claimed", token } : { status: "not-claimed", token: null };
  } catch (error) {
    console.error("claimIndexBuild failed; claim outcome is unknown", truncateMessage(error));
    return { status: "unknown", token: null };
  }
}

export function claimAbortsNormalWork(status: ClaimIndexBuildStatus): boolean {
  return status === "unknown";
}

async function transitionClaimedIndexState(env: Env, token: string, target: "0" | "2", budget?: QueryBudget): Promise<boolean> {
  try {
    takeQuery(budget);
    const result = await env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ? AND value = '1' AND updated_at = ?")
      .bind(target, nowIso(), DB_PRUNE_INDEX_STATE_KEY, token)
      .run();
    return Number(result.meta?.changes ?? 0) === 1;
  } catch (error) {
    console.error("read_states index state transition failed", target, truncateMessage(error));
    return false;
  }
}

export async function recordPruneError(env: Env, message: string, budget?: QueryBudget): Promise<void> {
  const value = message.length > 500 ? message.slice(0, 500) : message;
  try {
    takeQuery(budget);
    await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE sync_state.value IS NOT excluded.value")
      .bind(STATE_LAST_ERROR_KEY, value, nowIso())
      .run();
  } catch (error) {
    const quota = toDailyWriteQuotaExhaustedError(error);
    if (quota) throw quota;
    console.error("recordPruneError failed", truncateMessage(error));
  }
}

async function readIndexStateOr(env: Env, fallback: IndexStateSnapshot, budget?: QueryBudget): Promise<IndexStateSnapshot> {
  try {
    return await readIndexState(env, budget);
  } catch (error) {
    console.error("readIndexState after transition failed", truncateMessage(error));
    return fallback;
  }
}

async function settledIndexState(env: Env, budget?: QueryBudget): Promise<DbPruneIndexState> {
  const fallback: IndexStateSnapshot = { value: "1", raw: "1", updatedAt: "", present: true, invalid: false };
  return (await readIndexStateOr(env, fallback, budget)).value;
}

export async function buildAndVerifyReadStatesIndex(env: Env, token: string, budget?: QueryBudget, now: Date = new Date()): Promise<IndexBuildOutcome> {
  if (!isPruneWindow(now)) {
    const message = "index build window closed before DDL";
    console.error(message);
    const reverted = await transitionClaimedIndexState(env, token, "0", budget);
    await recordPruneError(env, message, budget);
    return { state: reverted ? "0" : await settledIndexState(env, budget), error: message };
  }
  try {
    takeQuery(budget);
    await env.DB.prepare(READ_STATES_INDEX_DDL).run();
  } catch (error) {
    const message = truncateMessage(error);
    console.error("read_states index DDL failed", message);
    const reverted = await transitionClaimedIndexState(env, token, "0", budget);
    await recordPruneError(env, message, budget);
    return { state: reverted ? "0" : await settledIndexState(env, budget), error: message };
  }
  const verification = await verifyReadStatesIndex(env, budget);
  if (!verification.ok) {
    const message = `read_states index verification failed: ${verification.reason}`;
    console.error(message);
    const reverted = await transitionClaimedIndexState(env, token, "0", budget);
    await recordPruneError(env, message, budget);
    return { state: reverted ? "0" : await settledIndexState(env, budget), error: message };
  }
  if (!(await transitionClaimedIndexState(env, token, "2", budget))) {
    const state = await settledIndexState(env, budget);
    if (state !== "2") {
      const message = "read_states index verified but state transition to 2 did not apply";
      console.error(message);
      await recordPruneError(env, message, budget);
      return { state, error: message };
    }
  }
  return { state: "2", error: "" };
}

/**
 * Recovers a state-1 row without running the DDL. A concurrent recovery may
 * promote a valid index immediately, but it must not write "0" while the
 * claiming invocation can still be alive. Both transitions are bound to the
 * observed `updated_at`; an unparseable timestamp is never evidence that the
 * holder exited, and zero changed rows always trigger a re-read.
 */
export async function recoverIndexState(env: Env, observed: IndexStateSnapshot, now: Date = new Date(), budget?: QueryBudget): Promise<IndexRecoveryResult> {
  if (observed.invalid || observed.value !== "1") return { state: observed, paused: false, error: "" };
  const verification = await verifyReadStatesIndex(env, budget);
  if (verification.ok) {
    const promoted = await transitionObservedIndexState(env, observed, "2", now, budget);
    if (promoted) return { state: { ...observed, value: "2", raw: "2", updatedAt: now.toISOString() }, paused: false, error: "" };
    const state = await readIndexStateOr(env, observed, budget);
    return { state, paused: state.value === "1", error: state.value === "1" ? "index recovery state write did not apply" : "" };
  }
  const updatedAt = new Date(observed.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) {
    return { state: observed, paused: true, error: "" };
  }
  if (now.getTime() - updatedAt.getTime() < DB_PRUNE_INDEX_HOLDER_MAX_AGE_MS) return { state: observed, paused: true, error: "" };
  const message = `read_states index recovery failed: ${verification.reason}`;
  console.error(message);
  const reverted = await transitionObservedIndexState(env, observed, "0", now, budget);
  await recordPruneError(env, message, budget);
  if (!reverted) {
    const state = await readIndexStateOr(env, observed, budget);
    return { state, paused: state.value === "1", error: state.value === "1" ? message : "" };
  }
  return { state: { ...observed, value: "0", raw: "0", updatedAt: now.toISOString() }, paused: false, error: message };
}

async function transitionObservedIndexState(env: Env, observed: IndexStateSnapshot, target: "0" | "2", now: Date, budget?: QueryBudget): Promise<boolean> {
  try {
    takeQuery(budget);
    const result = await env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ? AND value = '1' AND updated_at = ?")
      .bind(target, now.toISOString(), DB_PRUNE_INDEX_STATE_KEY, observed.updatedAt)
      .run();
    return Number(result.meta?.changes ?? 0) === 1;
  } catch (error) {
    console.error("read_states index recovery transition failed", target, truncateMessage(error));
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncateMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.length > 500 ? message.slice(0, 500) : message;
}

function isDbSizeError(error: unknown): boolean {
  return truncateMessage(error).includes("Exceeded maximum DB size");
}

function errorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let level = 0; current !== undefined && current !== null && level <= 4 && !seen.has(current); level++) {
    seen.add(current);
    messages.push(String(current));
    if (current instanceof Error) messages.push(current.message);
    if (current instanceof Error || typeof current === "object") {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return messages;
}

export function isDailyWriteQuotaError(error: unknown): boolean {
  return errorMessageChain(error).some((raw) => {
    const message = raw.toLowerCase().replace(/\s+/g, " ").replaceAll("’", "'").trim();
    if (message.includes("exceeded d1's free tier daily row write limit")) return true;
    if (message.includes("exceeded maximum allowed rows written")) return true;
    return message.includes("rows written per day") && message.includes("exceeded");
  });
}

function stateUpsert(env: Env, key: string, value: string, updatedAt: string): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, value, updatedAt);
}

async function writeStateUpsert(env: Env, key: string, value: string, updatedAt: string, budget?: QueryBudget): Promise<void> {
  takeQuery(budget);
  await stateUpsert(env, key, value, updatedAt).run();
}

async function initPruneDay(env: Env, today: string, budget?: QueryBudget): Promise<void> {
  const updatedAt = nowIso();
  takeQuery(budget);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").bind(STATE_DAY_KEY, today, updatedAt),
    env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").bind(STATE_DELETED_KEY, "0", updatedAt),
    env.DB.prepare("UPDATE sync_state SET value = '0', updated_at = ? WHERE key = ? AND COALESCE((SELECT value FROM sync_state WHERE key = ?), '') < ?").bind(updatedAt, STATE_DELETED_KEY, STATE_DAY_KEY, today),
    env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ? AND value < ?").bind(today, updatedAt, STATE_DAY_KEY, today)
  ]);
}

async function reserveQuota(env: Env, count: number, cap: number, budget?: QueryBudget): Promise<boolean> {
  takeQuery(budget);
  const result = await env.DB.prepare("UPDATE sync_state SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT), updated_at = ? WHERE key = ? AND CAST(value AS INTEGER) + ? <= ?")
    .bind(count, nowIso(), STATE_DELETED_KEY, count, cap)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

interface DeleteOutcome {
  deleted: number | null;
}

interface WallDeleteOutcome {
  deleted: number | null;
  postsSubmitted: boolean;
  windowClosed: boolean;
  postError: unknown;
}

async function deletePostIds(env: Env, ids: number[], budget?: QueryBudget): Promise<DeleteOutcome> {
  if (ids.length === 0) return { deleted: 0 };
  const placeholders = ids.map(() => "?").join(",");
  takeQuery(budget);
  const batch = await env.DB.batch([
    env.DB.prepare(`DELETE FROM read_states WHERE post_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts_search_trigram WHERE rowid IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts_search_bigrams WHERE rowid IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`).bind(...ids)
  ]);
  const changes = batch[3]?.meta?.changes;
  const valid = typeof changes === "number" && Number.isInteger(changes) && changes >= 0 && changes <= ids.length;
  return {
    deleted: valid ? changes : null
  };
}

async function refundQuota(env: Env, count: number, budget?: QueryBudget): Promise<boolean> {
  if (count <= 0) return true;
  takeQuery(budget);
  const result = await env.DB.prepare("UPDATE sync_state SET value = CAST(MAX(0, CAST(value AS INTEGER) - ?) AS TEXT), updated_at = ? WHERE key = ?")
    .bind(count, nowIso(), STATE_DELETED_KEY)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * Full-DB fallback: single-statement read_states delete, then single-statement
 * posts delete, reusing the quota reservation acquired before the failed
 * 4-statement batch. The UTC window is checked immediately before each
 * independent delete.
 */
async function wallDeleteIds(env: Env, ids: number[], windowOpen: () => boolean, budget?: QueryBudget): Promise<WallDeleteOutcome> {
  if (ids.length === 0) return { deleted: 0, postsSubmitted: false, windowClosed: false, postError: null };
  if (!windowOpen()) return { deleted: 0, postsSubmitted: false, windowClosed: true, postError: null };
  const placeholders = ids.map(() => "?").join(",");
  try {
    takeQuery(budget);
    await env.DB.prepare(`DELETE FROM read_states WHERE post_id IN (${placeholders})`).bind(...ids).run();
  } catch (error) {
    const quota = toDailyWriteQuotaExhaustedError(error);
    if (quota) throw quota;
    console.error("wall read_states delete failed", truncateMessage(error));
  }
  if (!windowOpen()) {
    return { deleted: 0, postsSubmitted: false, windowClosed: true, postError: null };
  }
  try {
    takeQuery(budget);
    const result = await env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`).bind(...ids).run();
    const changes = result.meta?.changes;
    const valid = typeof changes === "number" && Number.isInteger(changes) && changes >= 0 && changes <= ids.length;
    return {
      deleted: valid ? changes : null,
      postsSubmitted: true,
      windowClosed: false,
      postError: null
    };
  } catch (error) {
    return { deleted: null, postsSubmitted: true, windowClosed: false, postError: error };
  }
}

interface DegradedDeleteResult {
  confirmedDeleted: number;
  definiteNotDeleted: number;
  notAttempted: number;
  uncertainReserved: number;
  firstError: string;
}

export async function degradedDeleteIds(env: Env, ids: number[], canContinue: () => boolean, budget?: QueryBudget): Promise<DegradedDeleteResult> {
  const limit = Math.min(DB_PRUNE_DEGRADED_MAX_IDS, ids.length);
  let confirmedDeleted = 0;
  let definiteNotDeleted = 0;
  let notAttempted = 0;
  let uncertainReserved = 0;
  let firstError = "";
  let stopped = false;
  for (let index = 0; index < limit; index++) {
    if (!canContinue()) {
      notAttempted += ids.length - index;
      stopped = true;
      break;
    }
    const id = ids[index];
    try {
      takeQuery(budget);
      await env.DB.prepare("DELETE FROM read_states WHERE post_id = ?").bind(id).run();
    } catch (error) {
      const quota = toDailyWriteQuotaExhaustedError(error);
      if (quota) throw quota;
      console.error("degraded read_states delete failed", truncateMessage(error));
    }
    if (!canContinue()) {
      // The posts delete for this id and every later id was not submitted.
      notAttempted += ids.length - index;
      stopped = true;
      break;
    }
    try {
      takeQuery(budget);
      const result = await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      const changes = result.meta?.changes;
      if (changes === 1) {
        confirmedDeleted += 1;
      } else if (changes === 0) {
        definiteNotDeleted += 1;
      } else {
        if (!firstError) firstError = "posts delete did not return a changes count";
        uncertainReserved += 1;
        notAttempted += ids.length - index - 1;
        stopped = true;
        break;
      }
    } catch (error) {
      const quota = toDailyWriteQuotaExhaustedError(error);
      if (quota) throw quota;
      firstError = truncateMessage(error);
      uncertainReserved += 1;
      notAttempted += ids.length - index - 1;
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    // The 1-row degradation limit stopped before every id; the untouched tail
    // was never submitted and its post quota is provably unused.
    notAttempted += ids.length - limit;
  }
  return { confirmedDeleted, definiteNotDeleted, notAttempted, uncertainReserved, firstError };
}

async function cleanupFtsTable(env: Env, table: "posts_search_trigram" | "posts_search_bigrams", cursorKey: string, budget?: QueryBudget): Promise<"finished" | "more" | "error"> {
  try {
    takeQuery(budget);
    const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = ?").bind(cursorKey).first<{ value: string }>();
    const parsedCursor = Number(row?.value);
    const cursor = Number.isFinite(parsedCursor) && parsedCursor > 0 ? Math.floor(parsedCursor) : 0;
    takeQuery(budget);
    const selected = await env.DB.prepare(`SELECT rowid FROM ${table} WHERE rowid > ? ORDER BY rowid ASC LIMIT 25`)
      .bind(cursor)
      .all<{ rowid: number }>();
    const ids = (selected.results ?? []).map((item: { rowid: number }) => Number(item.rowid)).filter((id: number) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) {
      if (cursor !== 0) await writeStateUpsert(env, cursorKey, "0", nowIso(), budget);
      return "finished";
    }
    const placeholders = ids.map(() => "?").join(",");
    try {
      takeQuery(budget);
      await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (${placeholders}) AND rowid NOT IN (SELECT id FROM posts WHERE id IN (${placeholders}))`)
        .bind(...ids, ...ids)
        .run();
    } catch (error) {
      const quota = toDailyWriteQuotaExhaustedError(error);
      if (quota) throw quota;
      console.error("cleanupFtsTable delete failed", table, truncateMessage(error));
      return "error";
    }
    const nextCursor = ids.length < 25 ? 0 : Math.max(...ids);
    await writeStateUpsert(env, cursorKey, String(nextCursor), nowIso(), budget);
    return ids.length < 25 ? "finished" : "more";
  } catch (error) {
    const quota = toDailyWriteQuotaExhaustedError(error);
    if (quota) throw quota;
    console.error("cleanupFtsTable failed", table, truncateMessage(error));
    return "error";
  }
}

export interface CleanupFtsOrphansOptions {
  paidPlan?: boolean;
  limitMb?: number;
  blockedFull?: boolean;
  orphansPending?: boolean;
  budget?: QueryBudget;
}

export async function cleanupFtsOrphans(env: Env, options: CleanupFtsOrphansOptions = {}): Promise<void> {
  // A caller that already read the marker/flags can skip this entirely without a query.
  if (options.orphansPending === false || options.blockedFull === true) return;
  const budget = options.budget;
  try {
    const paid = options.paidPlan ?? await readD1PaidEnabled(env, budget);
    const limitMb = options.limitMb ?? await readDbPruneLimitMb(env, paid, budget);
    const { limitBytes } = pruneThresholds(limitMb, paid);
    const size = await readDatabaseSizeBytes(env, budget);
    if (size === null || size >= limitBytes) return;
    let blockedFull: boolean | undefined = options.blockedFull;
    let pending: boolean | undefined = options.orphansPending;
    if (blockedFull === undefined || pending === undefined) {
      const state = await readPruneState(env, budget);
      blockedFull ??= state.blockedFull;
      pending ??= state.ftsOrphansPending;
    }
    if (blockedFull) return;
    if (!pending) return;
    const trigram = await cleanupFtsTable(env, "posts_search_trigram", STATE_FTS_TRIGRAM_CURSOR, budget);
    const bigram = await cleanupFtsTable(env, "posts_search_bigrams", STATE_FTS_BIGRAM_CURSOR, budget);
    // Both tables reached their end: clear the marker so cron stops scanning
    // until a full-database fallback leaves new orphans. Partial failure keeps
    // the marker and every cursor as they were.
    if (trigram === "finished" && bigram === "finished") {
      takeQuery(budget);
      await env.DB.batch([stateUpsert(env, STATE_FTS_ORPHANS_PENDING, "0", nowIso())]);
    }
  } catch (error) {
    const quota = toDailyWriteQuotaExhaustedError(error);
    if (quota) throw quota;
    console.error("cleanupFtsOrphans failed", truncateMessage(error));
  }
}

export async function readDatabaseSizeBytes(env: Env, budget?: QueryBudget): Promise<number | null> {
  takeQuery(budget);
  const result = await env.DB.prepare("SELECT 1").run();
  const size = result.meta?.size_after;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

// A missing settings row is the documented default; a D1 query error is not a
// default. Callers decide whether to skip the round, so these helpers must
// reject with the original error instead of silently choosing free-plan limits.
export async function readD1PaidEnabled(env: Env, budget?: QueryBudget): Promise<boolean> {
  takeQuery(budget);
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind("d1_paid_enabled").first<{ value: string }>();
  return row?.value === "1" || row?.value === "true";
}

export async function readDbPruneLimitMb(env: Env, paid: boolean, budget?: QueryBudget): Promise<number> {
  takeQuery(budget);
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind("db_prune_limit_mb").first<{ value: string }>();
  return decodeStoredPruneLimitMb(row?.value, paid);
}

export interface PruneSettings {
  paidPlan: boolean;
  limitMb: number;
}

/**
 * Pure decode of the two prune settings rows. A missing row keeps the existing
 * defaults (free plan, plan-default limit); a missing paid row means free.
 */
export function parsePruneSettingsRows(rows: Array<{ key: string; value: string }>): PruneSettings {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const paidRaw = byKey.get("d1_paid_enabled");
  const paidPlan = paidRaw === "1" || paidRaw === "true";
  return { paidPlan, limitMb: decodeStoredPruneLimitMb(byKey.get("db_prune_limit_mb"), paidPlan) };
}

export async function readPruneSettings(env: Env, budget?: QueryBudget): Promise<PruneSettings> {
  takeQuery(budget);
  const result = await env.DB.prepare("SELECT key, value FROM app_settings WHERE key IN (?, ?)")
    .bind("d1_paid_enabled", "db_prune_limit_mb")
    .all<{ key: string; value: string }>();
  return parsePruneSettingsRows(result.results ?? []);
}

function parseCandidateCursor(raw: string): PruneCandidateCursor | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    console.error("invalid db_prune_candidate_cursor; starting from oldest", truncateMessage(error));
    return null;
  }
  if (Array.isArray(parsed) && parsed.length === 3) {
    const publishedAt = parsed[0];
    const id = parsed[1];
    const restartAt = parsed[2];
    if (typeof publishedAt === "string" && publishedAt.length > 0
      && typeof id === "number" && Number.isSafeInteger(id) && id > 0
      && typeof restartAt === "string" && Number.isFinite(new Date(restartAt).getTime())) {
      return { publishedAt, id, restartAt };
    }
  }
  console.error("invalid db_prune_candidate_cursor; starting from oldest", trimmed.slice(0, 200));
  return null;
}

export async function readPruneState(env: Env, budget?: QueryBudget): Promise<PruneState> {
  takeQuery(budget);
  const result = await env.DB.prepare("SELECT key, value FROM sync_state WHERE key IN (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(STATE_ACTIVE_KEY, STATE_DAY_KEY, STATE_DELETED_KEY, STATE_LAST_AT_KEY, STATE_LAST_ERROR_KEY, STATE_BLOCKED_KEY, STATE_FTS_ORPHANS_PENDING, STATE_CANDIDATE_CURSOR)
    .all<{ key: string; value: string }>();
  const rows = result.results ?? [];
  const readValue = (key: string): string => rows.find((row: { key: string; value: string }) => row.key === key)?.value ?? "";
  const rawDeleted = readValue(STATE_DELETED_KEY);
  const deleted = Number(rawDeleted);
  const candidateCursorRaw = readValue(STATE_CANDIDATE_CURSOR);
  return {
    active: readValue(STATE_ACTIVE_KEY) === "1",
    day: readValue(STATE_DAY_KEY),
    deletedToday: Number.isFinite(deleted) && deleted > 0 ? Math.floor(deleted) : 0,
    deletedTodayRaw: rawDeleted,
    lastAt: readValue(STATE_LAST_AT_KEY),
    lastError: readValue(STATE_LAST_ERROR_KEY),
    hasCounter: rows.some((row: { key: string; value: string }) => row.key === STATE_DELETED_KEY),
    blockedFull: readValue(STATE_BLOCKED_KEY) === "1",
    ftsOrphansPending: readValue(STATE_FTS_ORPHANS_PENDING) === "1",
    candidateCursorRaw,
    candidateCursor: parseCandidateCursor(candidateCursorRaw)
  };
}

/**
 * Sizes the D1 database and deletes the oldest eligible posts until the size
 * falls below the hysteresis target or the daily/run/page limits are reached.
 * Never throws: failures are recorded in sync_state.db_prune_last_error.
 */
export async function pruneOldPostsBySize(env: Env, options: PruneGateOptions = {}): Promise<PruneRunResult> {
  const clock = options.now ?? (() => new Date());
  const budget = options.budget ?? createQueryBudget();
  const headroom = (needed: number): boolean => hasQueryHeadroom(budgetRemaining(budget), needed);
  let sizeBytes: number | null = null;
  let paidPlan = false;
  let maxCapacityBytes = D1_FREE_MAX_CAPACITY_MB * 1_000_000;
  let fivePostThresholdBytes = Math.max(0, maxCapacityBytes - D1_FIVE_POST_MARGIN_MB * 1_000_000);
  let limitMb = DB_PRUNE_FREE_DEFAULT_LIMIT_MB;
  let thresholds = pruneThresholds(limitMb);
  let state: PruneState = { active: false, day: "", deletedToday: 0, deletedTodayRaw: "", lastAt: "", lastError: "", hasCounter: false, blockedFull: false, ftsOrphansPending: false, candidateCursorRaw: "", candidateCursor: null };
  let indexState: IndexStateSnapshot | null = null;
  let indexVerified = false;
  let indexDay = false;
  let dailyCap = DB_PRUNE_DAILY_CAP;
  let active = false;
  let deletedThisRun = 0;
  // Set only by the full-DB fallback paths, which intentionally leave FTS rows
  // behind for the event-driven orphan cleanup.
  let orphansPendingThisRun = false;
  let lastError = "";
  let dailyWriteQuotaExhausted = false;
  const quotaTerminated = (stage: string, error: unknown): boolean => {
    const quota = toDailyWriteQuotaExhaustedError(error);
    if (!quota) return false;
    if (!dailyWriteQuotaExhausted) {
      dailyWriteQuotaExhausted = true;
      markDailyWriteQuotaExhausted(budget);
      lastError = `D1 daily write quota exhausted during ${stage}; prune paused until 00:00 UTC: ${truncateMessage(error)}`;
      console.error("d1_daily_write_quota_exhausted", stage, truncateMessage(error));
    }
    return true;
  };
  const createdState = (skipped = false) => ({
    skipped,
    sizeBytes,
    limitBytes: thresholds.limitBytes,
    targetBytes: thresholds.targetBytes,
    active,
    deletedToday: state.deletedToday,
    deletedThisRun,
    lastError,
    paidPlan,
    maxCapacityBytes,
    fivePostThresholdBytes,
    indexState: indexState?.value ?? null,
    indexVerified,
    indexDay,
    dailyCap,
    dailyWriteQuotaExhausted
  });
  try {
    const currentIndex = options.indexState ?? await readIndexState(env, budget);
    indexState = currentIndex;
    if (currentIndex.invalid) {
      lastError = `invalid ${DB_PRUNE_INDEX_STATE_KEY} value`;
      console.error(lastError, currentIndex.raw);
      return createdState(true);
    }
    if (currentIndex.value !== "2") return createdState(true);

    paidPlan = options.paidPlan ?? await readD1PaidEnabled(env, budget);
    limitMb = options.limitMb ?? await readDbPruneLimitMb(env, paidPlan, budget);
    thresholds = pruneThresholds(limitMb, paidPlan);
    const maxCapacityMb = paidPlan ? D1_PAID_MAX_CAPACITY_MB : D1_FREE_MAX_CAPACITY_MB;
    maxCapacityBytes = maxCapacityMb * 1_000_000;
    fivePostThresholdBytes = Math.max(0, maxCapacityBytes - D1_FIVE_POST_MARGIN_MB * 1_000_000);
    const { limitBytes, targetBytes } = thresholds;
    sizeBytes = await readDatabaseSizeBytes(env, budget);
    if (sizeBytes === null) return createdState(true);

    state = await readPruneState(env, budget);
    active = decidePruneActivation({ sizeBytes, limitBytes, targetBytes, active: state.active });
    let baseError = "";
    if (state.blockedFull) {
      if (sizeBytes >= limitBytes) {
        baseError = state.lastError;
        active = true;
      } else {
        try {
          await writeStateUpsert(env, STATE_BLOCKED_KEY, "0", nowIso(), budget);
        } catch (error) {
          if (quotaTerminated("blocked_flag_clear", error)) return createdState();
          console.error("prune blocked flag clear failed", truncateMessage(error));
        }
      }
    }
    if (!active) {
      if (state.active) await writeStateUpsert(env, STATE_ACTIVE_KEY, "0", nowIso(), budget);
      return createdState();
    }
    active = true;

    if (!isPruneWindow(clock())) return createdState();

    if (!indexVerified) {
      if (options.indexVerified === true) {
        indexVerified = true;
      } else {
        const verification = await verifyReadStatesIndex(env, budget);
        if (!verification.ok) {
          lastError = `read_states index not verified: ${verification.reason}`;
          console.error(lastError);
          await recordPruneError(env, lastError, budget);
          return createdState(true);
        }
        indexVerified = true;
      }
    }
    indexDay = isIndexDay(currentIndex, clock());
    dailyCap = DB_PRUNE_DAILY_CAP;

    if (state.deletedTodayRaw && state.deletedTodayRaw !== String(state.deletedToday)) {
      try {
        await writeStateUpsert(env, STATE_DELETED_KEY, String(state.deletedToday), nowIso(), budget);
      } catch (error) {
        if (quotaTerminated("deleted_counter_normalize", error)) return createdState();
        console.error("prune counter normalize failed", truncateMessage(error));
      }
    }

    const today = utcDayString(clock());
    if (state.day !== today || !state.hasCounter || state.blockedFull) {
      try {
        await initPruneDay(env, today, budget);
      } catch (error) {
        // No delete may run before a persistent quota reservation; an init
        // failure means zero deletes this run, never a bootstrap delete.
        if (quotaTerminated("day_init", error)) return createdState();
        active = sizeBytes > targetBytes;
        lastError = `prune day init failed: ${truncateMessage(error)}`;
        console.error(lastError);
        try {
          await recordPruneError(env, lastError, budget);
        } catch (persistError) {
          if (quotaTerminated("error_key", persistError)) return createdState();
        }
        return createdState();
      }
      state.hasCounter = true;
      if (state.day !== today) {
        state.day = today;
        state.deletedToday = 0;
      }
    }

    if (!headroom(0)) {
      lastError = "query budget exhausted before prune loop";
      console.error(lastError);
      return createdState();
    }

    const markBlocked = async (): Promise<void> => {
      try {
        await writeStateUpsert(env, STATE_BLOCKED_KEY, "1", nowIso(), budget);
      } catch (error) {
        const quota = toDailyWriteQuotaExhaustedError(error);
        if (quota) throw quota;
        console.error("prune blocked flag persist failed", truncateMessage(error));
      }
    };
    const markBlockedOrStop = async (): Promise<boolean> => {
      try {
        await markBlocked();
        return true;
      } catch (error) {
        return !quotaTerminated("blocked_flag_write", error);
      }
    };
    const refundReservedQuota = async (count: number): Promise<boolean> => {
      if (count <= 0) return true;
      try {
        if (await refundQuota(env, count, budget)) {
          state.deletedToday = Math.max(0, state.deletedToday - count);
          return true;
        }
        console.error("prune quota refund not applied", count);
        return false;
      } catch (error) {
        const quota = toDailyWriteQuotaExhaustedError(error);
        if (quota) throw quota;
        console.error("prune quota refund failed", truncateMessage(error));
        return false;
      }
    };
    const refundOrStop = async (count: number): Promise<boolean> => {
      try {
        await refundReservedQuota(count);
        return true;
      } catch (error) {
        return !quotaTerminated("refund", error);
      }
    };
    // Fallback paths leave FTS rows behind, so persist the marker the moment a
    // deleted post is confirmed: refund/blocked/quota early returns skip the
    // final batch, and losing this flag would strand the orphans forever.
    const persistOrphanMarkerNow = async (): Promise<void> => {
      if (orphansPendingThisRun) return;
      orphansPendingThisRun = true;
      try {
        takeQuery(budget);
        await stateUpsert(env, STATE_FTS_ORPHANS_PENDING, "1", nowIso()).run();
      } catch (error) {
        if (!quotaTerminated("fts_orphans_marker", error)) {
          console.error("prune fts orphan marker write failed", truncateMessage(error));
        }
      }
    };

    // One eligibility snapshot per invocation. `restartAt` caps the next scan
    // at the first skipped row's own 24h boundary instead of rescanning the
    // same old-published/recently-fetched prefix every minute.
    const snapshotNow = clock();
    const cutoffMs = snapshotNow.getTime() - DB_PRUNE_MIN_AGE_MS;
    const cutoff = new Date(cutoffMs).toISOString();
    let cursor = state.candidateCursor;
    let restartAt = cursor ? cursor.restartAt : new Date(snapshotNow.getTime() + DB_PRUNE_MIN_AGE_MS).toISOString();
    const persistCursor = async (value: string): Promise<"ok" | "stop"> => {
      try {
        await writeStateUpsert(env, STATE_CANDIDATE_CURSOR, value, nowIso(), budget);
        return "ok";
      } catch (error) {
        if (quotaTerminated("candidate_cursor", error)) return "stop";
        lastError = `candidate cursor write failed: ${truncateMessage(error)}`;
        console.error(lastError);
        return "stop";
      }
    };

    let exhaustedChunks = true;
    let degraded = false;
    let scanPages = 0;
    while (scanPages < DB_PRUNE_MAX_SCAN_PAGES && deletedThisRun < DB_PRUNE_RUN_MAX_POSTS) {
      if (!isPruneWindow(clock()) || !indexVerified) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      if (!headroom(DB_PRUNE_BATCH_QUERY_RESERVE)) {
        lastError = "query headroom insufficient for next prune batch";
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      const remainingDaily = dailyCap - state.deletedToday;
      if (remainingDaily <= 0) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      const pageLimit = Math.min(DB_PRUNE_BATCH_SIZE, remainingDaily, DB_PRUNE_RUN_MAX_POSTS - deletedThisRun);
      if (pageLimit <= 0) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      if (cursor && new Date(cursor.restartAt).getTime() <= clock().getTime()) {
        console.error("db_prune_candidate_cursor expired; restarting from oldest");
        if (!isPruneWindow(clock())) {
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if ((await persistCursor("")) === "stop") {
          if (dailyWriteQuotaExhausted) return createdState();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        cursor = null;
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }

      takeQuery(budget);
      const candidates = cursor
        ? await env.DB.prepare(CANDIDATE_SQL_AFTER).bind(cursor.publishedAt, cursor.id, cutoff, pageLimit).all<{ published_at: string; id: number; fetched_at: string }>()
        : await env.DB.prepare(CANDIDATE_SQL_FIRST).bind(cutoff, pageLimit).all<{ published_at: string; id: number; fetched_at: string }>();
      scanPages += 1;
      const rows = candidates.results ?? [];
      const pageFull = rows.length === pageLimit;
      const ids: number[] = [];
      for (const row of rows) {
        const rowId = Number(row.id);
        if (!Number.isInteger(rowId) || rowId <= 0) continue;
        const fetchedAt = Date.parse(String(row.fetched_at ?? ""));
        if (Number.isFinite(fetchedAt) && fetchedAt < cutoffMs) {
          ids.push(rowId);
        } else if (Number.isFinite(fetchedAt)) {
          const candidateRestartAt = new Date(fetchedAt + DB_PRUNE_MIN_AGE_MS).toISOString();
          if (Date.parse(candidateRestartAt) < Date.parse(restartAt)) restartAt = candidateRestartAt;
        }
      }
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;

      let deleted: number | null = 0;
      let reserved = 0;
      let processed = ids.length === 0;

      if (ids.length > 0) {
        reserved = ids.length;
        try {
          if (!(await reserveQuota(env, reserved, dailyCap, budget))) {
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
        } catch (error) {
          if (quotaTerminated("reservation", error)) return createdState();
          lastError = `prune quota reservation failed: ${truncateMessage(error)}`;
          console.error(lastError);
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        state.deletedToday += reserved;

        if (!isPruneWindow(clock())) {
          if (!(await refundOrStop(reserved))) return createdState();
          if (!lastError) lastError = "prune window closed before delete";
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }

        try {
          const outcome = await deletePostIds(env, ids, budget);
          deleted = outcome.deleted;
          if (deleted === null) {
            lastError = "posts delete did not return a changes count; keeping quota reservation";
            if (!(await markBlockedOrStop())) return createdState();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          if (deleted < reserved) {
            deletedThisRun += deleted;
            if (!(await refundOrStop(reserved - deleted))) return createdState();
            if (deleted === 0 && !(await markBlockedOrStop())) return createdState();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          processed = true;
        } catch (error) {
          if (quotaTerminated("posts_delete", error)) return createdState();
          if (!isDbSizeError(error)) {
            // Ambiguous batch outcome (timeout/transport error): the posts may
            // have been deleted, so the quota reservation stays.
            lastError = truncateMessage(error);
            if (!(await markBlockedOrStop())) return createdState();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          console.error("prune 4-statement batch failed; wall path", truncateMessage(error));
          if (!isPruneWindow(clock()) || !headroom(4)) {
            if (!(await refundOrStop(reserved))) return createdState();
            if (!lastError) lastError = "prune window or query budget closed before full-db fallback";
            if (!(await markBlockedOrStop())) return createdState();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          let wall: WallDeleteOutcome;
          try {
            wall = await wallDeleteIds(env, ids, () => isPruneWindow(clock()), budget);
          } catch (wallError) {
            if (quotaTerminated("wall_read_states_delete", wallError)) return createdState();
            throw wallError;
          }
          if (wall.postError !== null) {
            if (quotaTerminated("wall_posts_delete", wall.postError)) return createdState();
            if (!isDbSizeError(wall.postError)) {
              // The posts delete was submitted but the outcome is unknown.
              lastError = truncateMessage(wall.postError);
              if (!(await markBlockedOrStop())) return createdState();
              active = sizeBytes > targetBytes;
              exhaustedChunks = false;
              break;
            }
          }
          if (!wall.postsSubmitted) {
            // The posts delete was never submitted, so its quota is provably
            // unused; committed read_states deletes are not undone.
            if (!(await refundOrStop(reserved))) return createdState();
            if (!lastError) lastError = "prune window closed before wall posts delete";
            if (!(await markBlockedOrStop())) return createdState();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          if (wall.postError !== null) {
            // The posts delete failed with a capacity error: posts are known not
            // deleted, read_states may be committed. 1-row degradation reuses the
            // same reservation and refunds only provably unused post quota.
            if (!headroom(DB_PRUNE_DEGRADED_QUERY_RESERVE)) {
              if (!(await refundOrStop(reserved))) return createdState();
              lastError = "query headroom insufficient before degraded deletes";
              if (!(await markBlockedOrStop())) return createdState();
              active = sizeBytes > targetBytes;
              exhaustedChunks = false;
              break;
            }
            degraded = true;
            let degradation: DegradedDeleteResult;
            try {
              degradation = await degradedDeleteIds(env, ids, () => isPruneWindow(clock()) && headroom(2), budget);
            } catch (degError) {
              if (quotaTerminated("degraded_delete", degError)) return createdState();
              throw degError;
            }
            deleted = degradation.confirmedDeleted;
            deletedThisRun += deleted;
            if (deleted > 0) await persistOrphanMarkerNow();
            const refundable = degradation.definiteNotDeleted + degradation.notAttempted;
            if (refundable > 0 && !(await refundOrStop(refundable))) return createdState();
            lastError = degradation.firstError || truncateMessage(wall.postError);
            if (!(await markBlockedOrStop())) return createdState();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          deleted = wall.deleted;
          if (deleted === null) {
            lastError = "wall posts delete did not return a changes count; keeping quota reservation";
            if (!(await markBlockedOrStop())) return createdState();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          if (deleted > 0) await persistOrphanMarkerNow();
          if (deleted < reserved) {
            deletedThisRun += deleted;
            if (!(await refundOrStop(reserved - deleted))) return createdState();
            if (deleted === 0 && !(await markBlockedOrStop())) return createdState();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          processed = true;
        }
      }

      if (!processed) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }

      const counted = deleted === null ? 0 : deleted;
      deletedThisRun += counted;
      let targetReached = false;
      if (counted > 0) {
        const probed = await readDatabaseSizeBytes(env, budget);
        if (probed === null) {
          lastError = "size_after unavailable";
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        sizeBytes = probed;
        targetReached = sizeBytes <= targetBytes;
      }

      if (targetReached) {
        if (!isPruneWindow(clock())) {
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if ((await persistCursor("")) === "stop") {
          if (dailyWriteQuotaExhausted) return createdState();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        cursor = null;
        active = false;
        exhaustedChunks = false;
        break;
      }
      if (!pageFull) {
        if (!isPruneWindow(clock())) {
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if ((await persistCursor("")) === "stop") {
          if (dailyWriteQuotaExhausted) return createdState();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        cursor = null;
        active = false;
        exhaustedChunks = false;
        break;
      }
      if (!lastRow) {
        lastError = "candidate page missing cursor row";
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      const nextCursor: PruneCandidateCursor = { publishedAt: String(lastRow.published_at ?? ""), id: Number(lastRow.id), restartAt };
      if (!nextCursor.publishedAt || !Number.isSafeInteger(nextCursor.id) || nextCursor.id <= 0) {
        lastError = "candidate cursor row is invalid";
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      if (!isPruneWindow(clock())) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      if ((await persistCursor(JSON.stringify([nextCursor.publishedAt, nextCursor.id, nextCursor.restartAt]))) === "stop") {
        if (dailyWriteQuotaExhausted) return createdState();
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      cursor = nextCursor;
    }
    if (exhaustedChunks) active = sizeBytes > targetBytes;
    if (deletedThisRun === 0 && !lastError && baseError) lastError = baseError;

    const finishedAt = nowIso();
    const finalStatements: D1PreparedStatement[] = [stateUpsert(env, STATE_ACTIVE_KEY, active ? "1" : "0", finishedAt)];
    if (deletedThisRun > 0) finalStatements.push(stateUpsert(env, STATE_LAST_AT_KEY, finishedAt, finishedAt));
    if (deletedThisRun > 0 || lastError) finalStatements.push(stateUpsert(env, STATE_LAST_ERROR_KEY, lastError, finishedAt));
    try {
      if (budget.dailyWriteQuotaExhausted) throw new DailyWriteQuotaExhaustedError("D1 daily write quota exhausted; final state batch blocked");
      consumeFinalQuery(budget);
      await env.DB.batch(finalStatements);
    } catch (error) {
      if (quotaTerminated("final_state_batch", error)) return createdState();
      console.error("prune final state batch failed", truncateMessage(error));
    }

    // The blocked flag clear stays best-effort and outside the atomic final
    // batch: a clear failure must not roll back active/last_at/last_error.
    if (!degraded && sizeBytes < limitBytes) {
      try {
        if (budget.dailyWriteQuotaExhausted) throw new DailyWriteQuotaExhaustedError("D1 daily write quota exhausted; final blocked-flag clear blocked");
        consumeFinalQuery(budget);
        await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, '0', ?) ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at")
          .bind(STATE_BLOCKED_KEY, finishedAt)
          .run();
      } catch (error) {
        if (quotaTerminated("blocked_flag_clear", error)) return createdState();
        console.error("prune blocked flag clear failed", truncateMessage(error));
      }
    }

    return createdState();
  } catch (error) {
    if (quotaTerminated("prune", error)) return createdState();
    lastError = truncateMessage(error);
    console.error("pruneOldPostsBySize failed", lastError);
    try {
      await writeStateUpsert(env, STATE_LAST_ERROR_KEY, lastError, nowIso(), budget);
    } catch (persistError) {
      if (quotaTerminated("error_key", persistError)) return createdState();
      console.error("pruneOldPostsBySize failed to persist error state", truncateMessage(persistError));
    }
    return createdState();
  }
}
