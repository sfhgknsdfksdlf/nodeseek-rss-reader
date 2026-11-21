// D1 capacity pruning (owner-approved 2026-11-20, see AGENTS.md).
// Self-contained on purpose: only a type-only import, so the pure helpers can be
// imported by `node --experimental-strip-types` without dependency resolution.
import type { DbPruneIndexState, Env } from "./types";

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
export const D1_QUERY_LIMIT = 50;
export const DB_PRUNE_FINAL_QUERY_RESERVE = 4;
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

export interface PruneState {
  active: boolean;
  day: string;
  deletedToday: number;
  deletedTodayRaw: string;
  lastAt: string;
  lastError: string;
  hasCounter: boolean;
  blockedFull: boolean;
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
 * once the database is above the plan's max capacity minus the 2MB margin.
 */
export function decideMaxNewPosts(input: { sizeBytes: number | null; fivePostThresholdBytes: number }): number | undefined {
  if (input.sizeBytes === null) return undefined;
  return input.sizeBytes > input.fivePostThresholdBytes ? 5 : undefined;
}

export interface IndexStateSnapshot {
  value: DbPruneIndexState;
  raw: string;
  updatedAt: string;
  present: boolean;
  invalid: boolean;
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

export interface QueryMeter {
  readonly env: Env;
  used(): number;
  remaining(): number;
  readonly limit: number;
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
  queryRemaining?: () => number;
}

export function hasQueryHeadroom(remaining: number, needed: number): boolean {
  return remaining >= needed + DB_PRUNE_FINAL_QUERY_RESERVE;
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

export function createQueryMeter(env: Env, limit = D1_QUERY_LIMIT, reserve = DB_PRUNE_FINAL_QUERY_RESERVE): QueryMeter {
  let used = 0;
  const consume = () => {
    if (used + 1 > limit - reserve) throw new Error("D1 query budget exhausted; final release reserved");
    used += 1;
  };
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrapPrepared = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop === "bind") {
          return (...args: unknown[]) => wrapPrepared((value as (...bindArgs: unknown[]) => D1PreparedStatement).apply(target, args));
        }
        if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
          return (...args: unknown[]) => {
            consume();
            return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...callArgs: unknown[]) => unknown).bind(target);
      }
    }) as D1PreparedStatement;
    originals.set(wrapped, statement);
    return wrapped;
  };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "prepare") {
        return (...args: unknown[]) => wrapPrepared((value as (sql: string) => D1PreparedStatement).apply(target, args));
      }
      if (prop === "batch") {
        return (...args: unknown[]) => {
          consume();
          const statements = args[0];
          const unwrapped = Array.isArray(statements) ? (statements as D1PreparedStatement[]).map((statement) => originals.get(statement) ?? statement) : statements;
          return (value as (list: D1PreparedStatement[]) => unknown).apply(target, [unwrapped]);
        };
      }
      if (prop === "exec" || prop === "dump") {
        return (...args: unknown[]) => {
          consume();
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...callArgs: unknown[]) => unknown).bind(target);
    }
  }) as D1Database;
  return { env: { ...env, DB: db }, used: () => used, remaining: () => Math.max(0, limit - used), limit };
}

export async function runIsolated(label: string, action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
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

export async function readIndexState(env: Env): Promise<IndexStateSnapshot> {
  const row = await env.DB.prepare("SELECT value, updated_at FROM sync_state WHERE key = ?")
    .bind(DB_PRUNE_INDEX_STATE_KEY)
    .first<{ value: string; updated_at: string }>();
  if (!row) return { value: "0", raw: "", updatedAt: "", present: false, invalid: false };
  const raw = String(row.value ?? "");
  if (raw === "0" || raw === "1" || raw === "2") return { value: raw, raw, updatedAt: row.updated_at || "", present: true, invalid: false };
  return { value: "0", raw, updatedAt: row.updated_at || "", present: true, invalid: true };
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

async function readIndexInfoRows(env: Env): Promise<Array<{ seqno: number; cid: number; name: string }>> {
  try {
    const result = await env.DB.prepare(`PRAGMA index_info('${READ_STATES_INDEX_NAME}')`).all<{ seqno: number; cid: number; name: string }>();
    return result.results ?? [];
  } catch (pragmaError) {
    console.error("PRAGMA index_info form failed; trying table-valued pragma", truncateMessage(pragmaError));
    const result = await env.DB.prepare(`SELECT seqno, cid, name FROM pragma_index_info('${READ_STATES_INDEX_NAME}')`).all<{ seqno: number; cid: number; name: string }>();
    return result.results ?? [];
  }
}

export async function verifyReadStatesIndex(env: Env): Promise<IndexVerification> {
  try {
    const row = await env.DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = ?")
      .bind(READ_STATES_INDEX_NAME)
      .first<{ type: string; name: string; tbl_name: string; sql: string | null }>();
    if (!row) return { ok: false, reason: "index missing" };
    if (row.type !== "index" || row.name !== READ_STATES_INDEX_NAME || row.tbl_name !== "read_states") return { ok: false, reason: "index metadata mismatch" };
    if (!isExpectedReadStatesIndexSql(String(row.sql || ""))) return { ok: false, reason: "index definition mismatch" };
    const columns = await readIndexInfoRows(env);
    if (columns.length !== 1 || Number(columns[0].seqno) !== 0 || columns[0].name !== "post_id") return { ok: false, reason: "index columns mismatch" };
    return { ok: true, reason: "" };
  } catch (error) {
    return { ok: false, reason: truncateMessage(error) };
  }
}

export async function claimIndexBuild(env: Env, observedUpdatedAt = ""): Promise<ClaimIndexBuildResult> {
  const token = nowIso();
  try {
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

async function transitionClaimedIndexState(env: Env, token: string, target: "0" | "2"): Promise<boolean> {
  try {
    const result = await env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ? AND value = '1' AND updated_at = ?")
      .bind(target, nowIso(), DB_PRUNE_INDEX_STATE_KEY, token)
      .run();
    return Number(result.meta?.changes ?? 0) === 1;
  } catch (error) {
    console.error("read_states index state transition failed", target, truncateMessage(error));
    return false;
  }
}

export async function recordPruneError(env: Env, message: string): Promise<void> {
  const value = message.length > 500 ? message.slice(0, 500) : message;
  try {
    await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE sync_state.value IS NOT excluded.value")
      .bind(STATE_LAST_ERROR_KEY, value, nowIso())
      .run();
  } catch (error) {
    console.error("recordPruneError failed", truncateMessage(error));
  }
}

async function readIndexStateOr(env: Env, fallback: IndexStateSnapshot): Promise<IndexStateSnapshot> {
  try {
    return await readIndexState(env);
  } catch (error) {
    console.error("readIndexState after transition failed", truncateMessage(error));
    return fallback;
  }
}

async function settledIndexState(env: Env): Promise<DbPruneIndexState> {
  const fallback: IndexStateSnapshot = { value: "1", raw: "1", updatedAt: "", present: true, invalid: false };
  return (await readIndexStateOr(env, fallback)).value;
}

export async function buildAndVerifyReadStatesIndex(env: Env, token: string, now: Date = new Date()): Promise<IndexBuildOutcome> {
  if (!isPruneWindow(now)) {
    const message = "index build window closed before DDL";
    console.error(message);
    const reverted = await transitionClaimedIndexState(env, token, "0");
    await recordPruneError(env, message);
    return { state: reverted ? "0" : await settledIndexState(env), error: message };
  }
  try {
    await env.DB.prepare(READ_STATES_INDEX_DDL).run();
  } catch (error) {
    const message = truncateMessage(error);
    console.error("read_states index DDL failed", message);
    const reverted = await transitionClaimedIndexState(env, token, "0");
    await recordPruneError(env, message);
    return { state: reverted ? "0" : await settledIndexState(env), error: message };
  }
  const verification = await verifyReadStatesIndex(env);
  if (!verification.ok) {
    const message = `read_states index verification failed: ${verification.reason}`;
    console.error(message);
    const reverted = await transitionClaimedIndexState(env, token, "0");
    await recordPruneError(env, message);
    return { state: reverted ? "0" : await settledIndexState(env), error: message };
  }
  if (!(await transitionClaimedIndexState(env, token, "2"))) {
    const state = await settledIndexState(env);
    if (state !== "2") {
      const message = "read_states index verified but state transition to 2 did not apply";
      console.error(message);
      await recordPruneError(env, message);
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
export async function recoverIndexState(env: Env, observed: IndexStateSnapshot, now: Date = new Date()): Promise<IndexRecoveryResult> {
  if (observed.invalid || observed.value !== "1") return { state: observed, paused: false, error: "" };
  const verification = await verifyReadStatesIndex(env);
  if (verification.ok) {
    const promoted = await transitionObservedIndexState(env, observed, "2", now);
    if (promoted) return { state: { ...observed, value: "2", raw: "2", updatedAt: now.toISOString() }, paused: false, error: "" };
    const state = await readIndexStateOr(env, observed);
    return { state, paused: state.value === "1", error: state.value === "1" ? "index recovery state write did not apply" : "" };
  }
  const updatedAt = new Date(observed.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) {
    return { state: observed, paused: true, error: "" };
  }
  if (now.getTime() - updatedAt.getTime() < DB_PRUNE_INDEX_HOLDER_MAX_AGE_MS) return { state: observed, paused: true, error: "" };
  const message = `read_states index recovery failed: ${verification.reason}`;
  console.error(message);
  const reverted = await transitionObservedIndexState(env, observed, "0", now);
  await recordPruneError(env, message);
  if (!reverted) {
    const state = await readIndexStateOr(env, observed);
    return { state, paused: state.value === "1", error: state.value === "1" ? message : "" };
  }
  return { state: { ...observed, value: "0", raw: "0", updatedAt: now.toISOString() }, paused: false, error: message };
}

async function transitionObservedIndexState(env: Env, observed: IndexStateSnapshot, target: "0" | "2", now: Date): Promise<boolean> {
  try {
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

function isDailyWriteQuotaError(error: unknown): boolean {
  const message = truncateMessage(error).toLowerCase();
  return message.includes("exceeded maximum allowed rows written") || message.includes("rows written per day");
}

function stateUpsert(env: Env, key: string, value: string, updatedAt: string): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, value, updatedAt);
}

async function initPruneDay(env: Env, today: string): Promise<void> {
  const updatedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").bind(STATE_DAY_KEY, today, updatedAt),
    env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").bind(STATE_DELETED_KEY, "0", updatedAt),
    env.DB.prepare("UPDATE sync_state SET value = '0', updated_at = ? WHERE key = ? AND COALESCE((SELECT value FROM sync_state WHERE key = ?), '') < ?").bind(updatedAt, STATE_DELETED_KEY, STATE_DAY_KEY, today),
    env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ? AND value < ?").bind(today, updatedAt, STATE_DAY_KEY, today)
  ]);
}

async function reserveQuota(env: Env, count: number, cap: number): Promise<boolean> {
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

async function deletePostIds(env: Env, ids: number[]): Promise<DeleteOutcome> {
  if (ids.length === 0) return { deleted: 0 };
  const placeholders = ids.map(() => "?").join(",");
  const batch = await env.DB.batch([
    env.DB.prepare(`DELETE FROM read_states WHERE post_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts_search_trigram WHERE rowid IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts_search_bigrams WHERE rowid IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`).bind(...ids)
  ]);
  const changes = batch[3]?.meta?.changes;
  return {
    deleted: typeof changes === "number" && Number.isFinite(changes) ? changes : null
  };
}

async function refundQuota(env: Env, count: number): Promise<boolean> {
  if (count <= 0) return true;
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
async function wallDeleteIds(env: Env, ids: number[], windowOpen: () => boolean): Promise<WallDeleteOutcome> {
  if (ids.length === 0) return { deleted: 0, postsSubmitted: false, windowClosed: false, postError: null };
  if (!windowOpen()) return { deleted: 0, postsSubmitted: false, windowClosed: true, postError: null };
  const placeholders = ids.map(() => "?").join(",");
  try {
    await env.DB.prepare(`DELETE FROM read_states WHERE post_id IN (${placeholders})`).bind(...ids).run();
  } catch (error) {
    console.error("wall read_states delete failed", truncateMessage(error));
  }
  if (!windowOpen()) {
    return { deleted: 0, postsSubmitted: false, windowClosed: true, postError: null };
  }
  try {
    const result = await env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`).bind(...ids).run();
    const changes = result.meta?.changes;
    return {
      deleted: typeof changes === "number" && Number.isFinite(changes) ? changes : null,
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

export async function degradedDeleteIds(env: Env, ids: number[], canContinue: () => boolean): Promise<DegradedDeleteResult> {
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
      await env.DB.prepare("DELETE FROM read_states WHERE post_id = ?").bind(id).run();
    } catch (error) {
      console.error("degraded read_states delete failed", truncateMessage(error));
    }
    if (!canContinue()) {
      // The posts delete for this id and every later id was not submitted.
      notAttempted += ids.length - index;
      stopped = true;
      break;
    }
    try {
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

async function cleanupFtsTable(env: Env, table: "posts_search_trigram" | "posts_search_bigrams", cursorKey: string): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = ?").bind(cursorKey).first<{ value: string }>();
    const parsedCursor = Number(row?.value);
    const cursor = Number.isFinite(parsedCursor) && parsedCursor > 0 ? Math.floor(parsedCursor) : 0;
    const selected = await env.DB.prepare(`SELECT rowid FROM ${table} WHERE rowid > ? ORDER BY rowid ASC LIMIT 25`)
      .bind(cursor)
      .all<{ rowid: number }>();
    const ids = (selected.results ?? []).map((item) => Number(item.rowid)).filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) {
      if (cursor !== 0) await stateUpsert(env, cursorKey, "0", nowIso()).run();
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    try {
      await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (${placeholders}) AND rowid NOT IN (SELECT id FROM posts WHERE id IN (${placeholders}))`)
        .bind(...ids, ...ids)
        .run();
    } catch (error) {
      console.error("cleanupFtsTable delete failed", table, truncateMessage(error));
    }
    const nextCursor = ids.length < 25 ? 0 : Math.max(...ids);
    await stateUpsert(env, cursorKey, String(nextCursor), nowIso()).run();
  } catch (error) {
    console.error("cleanupFtsTable failed", table, truncateMessage(error));
  }
}

export async function cleanupFtsOrphans(env: Env): Promise<void> {
  try {
    const paid = await readD1PaidEnabled(env);
    const limitMb = await readDbPruneLimitMb(env, paid);
    const { limitBytes } = pruneThresholds(limitMb, paid);
    const size = await readDatabaseSizeBytes(env);
    if (size === null || size >= limitBytes) return;
    const state = await readPruneState(env);
    if (state.blockedFull) return;
    await cleanupFtsTable(env, "posts_search_trigram", STATE_FTS_TRIGRAM_CURSOR);
    await cleanupFtsTable(env, "posts_search_bigrams", STATE_FTS_BIGRAM_CURSOR);
  } catch (error) {
    console.error("cleanupFtsOrphans failed", truncateMessage(error));
  }
}

export async function readDatabaseSizeBytes(env: Env): Promise<number | null> {
  const result = await env.DB.prepare("SELECT 1").run();
  const size = result.meta?.size_after;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

export async function readD1PaidEnabled(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind("d1_paid_enabled").first<{ value: string }>();
    return row?.value === "1" || row?.value === "true";
  } catch (error) {
    console.error("readD1PaidEnabled failed", truncateMessage(error));
    return false;
  }
}

export async function readDbPruneLimitMb(env: Env, paid?: boolean): Promise<number> {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind("db_prune_limit_mb").first<{ value: string }>();
    const effectivePaid = paid ?? (await readD1PaidEnabled(env));
    return decodeStoredPruneLimitMb(row?.value, effectivePaid);
  } catch (error) {
    console.error("readDbPruneLimitMb failed", truncateMessage(error));
    return clampDbPruneLimitMb(undefined, paid ?? false);
  }
}

export async function readPruneState(env: Env): Promise<PruneState> {
  const result = await env.DB.prepare("SELECT key, value FROM sync_state WHERE key IN (?, ?, ?, ?, ?, ?)")
    .bind(STATE_ACTIVE_KEY, STATE_DAY_KEY, STATE_DELETED_KEY, STATE_LAST_AT_KEY, STATE_LAST_ERROR_KEY, STATE_BLOCKED_KEY)
    .all<{ key: string; value: string }>();
  const rows = result.results ?? [];
  const readValue = (key: string): string => rows.find((row) => row.key === key)?.value ?? "";
  const rawDeleted = readValue(STATE_DELETED_KEY);
  const deleted = Number(rawDeleted);
  return {
    active: readValue(STATE_ACTIVE_KEY) === "1",
    day: readValue(STATE_DAY_KEY),
    deletedToday: Number.isFinite(deleted) && deleted > 0 ? Math.floor(deleted) : 0,
    deletedTodayRaw: rawDeleted,
    lastAt: readValue(STATE_LAST_AT_KEY),
    lastError: readValue(STATE_LAST_ERROR_KEY),
    hasCounter: rows.some((row) => row.key === STATE_DELETED_KEY),
    blockedFull: readValue(STATE_BLOCKED_KEY) === "1"
  };
}

/**
 * Sizes the D1 database and deletes the oldest eligible posts until the size
 * falls below the hysteresis target or the daily/run limits are reached.
 * Never throws: failures are recorded in sync_state.db_prune_last_error.
 */
export async function pruneOldPostsBySize(env: Env, options: PruneGateOptions = {}): Promise<PruneRunResult> {
  const clock = options.now ?? (() => new Date());
  const queryRemaining = options.queryRemaining ?? (() => Number.POSITIVE_INFINITY);
  const headroom = (needed: number): boolean => hasQueryHeadroom(queryRemaining(), needed);
  let sizeBytes: number | null = null;
  let paidPlan = false;
  let maxCapacityBytes = D1_FREE_MAX_CAPACITY_MB * 1_000_000;
  let fivePostThresholdBytes = Math.max(0, maxCapacityBytes - D1_FIVE_POST_MARGIN_MB * 1_000_000);
  let limitMb = DB_PRUNE_FREE_DEFAULT_LIMIT_MB;
  let thresholds = pruneThresholds(limitMb);
  let state: PruneState = { active: false, day: "", deletedToday: 0, deletedTodayRaw: "", lastAt: "", lastError: "", hasCounter: false, blockedFull: false };
  let indexState: IndexStateSnapshot | null = null;
  let indexVerified = false;
  let indexDay = false;
  let dailyCap = DB_PRUNE_DAILY_CAP;
  let active = false;
  let deletedThisRun = 0;
  let lastError = "";
  try {
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
      dailyCap
    });

    const currentIndex = options.indexState ?? await readIndexState(env);
    indexState = currentIndex;
    if (currentIndex.invalid) {
      lastError = `invalid ${DB_PRUNE_INDEX_STATE_KEY} value`;
      console.error(lastError, currentIndex.raw);
      return createdState(true);
    }
    if (currentIndex.value !== "2") return createdState(true);

    paidPlan = options.paidPlan ?? await readD1PaidEnabled(env);
    limitMb = options.limitMb ?? await readDbPruneLimitMb(env, paidPlan);
    thresholds = pruneThresholds(limitMb, paidPlan);
    const maxCapacityMb = paidPlan ? D1_PAID_MAX_CAPACITY_MB : D1_FREE_MAX_CAPACITY_MB;
    maxCapacityBytes = maxCapacityMb * 1_000_000;
    fivePostThresholdBytes = Math.max(0, maxCapacityBytes - D1_FIVE_POST_MARGIN_MB * 1_000_000);
    const { limitBytes, targetBytes } = thresholds;
    sizeBytes = await readDatabaseSizeBytes(env);
    if (sizeBytes === null) return createdState(true);

    state = await readPruneState(env);
    active = decidePruneActivation({ sizeBytes, limitBytes, targetBytes, active: state.active });
    let baseError = "";
    if (state.blockedFull) {
      if (sizeBytes >= limitBytes) {
        baseError = state.lastError;
        active = true;
      } else {
        try {
          await stateUpsert(env, STATE_BLOCKED_KEY, "0", nowIso()).run();
        } catch (error) {
          console.error("prune blocked flag clear failed", truncateMessage(error));
        }
      }
    }
    if (!active) {
      if (state.active) await stateUpsert(env, STATE_ACTIVE_KEY, "0", nowIso()).run();
      return createdState();
    }
    active = true;

    if (!isPruneWindow(clock())) return createdState();

    if (!indexVerified) {
      if (options.indexVerified === true) {
        indexVerified = true;
      } else {
        const verification = await verifyReadStatesIndex(env);
        if (!verification.ok) {
          lastError = `read_states index not verified: ${verification.reason}`;
          console.error(lastError);
          await recordPruneError(env, lastError);
          return createdState(true);
        }
        indexVerified = true;
      }
    }
    indexDay = isIndexDay(currentIndex, clock());
    dailyCap = DB_PRUNE_DAILY_CAP;

    if (state.deletedTodayRaw && state.deletedTodayRaw !== String(state.deletedToday)) {
      try {
        await stateUpsert(env, STATE_DELETED_KEY, String(state.deletedToday), nowIso()).run();
      } catch (error) {
        console.error("prune counter normalize failed", truncateMessage(error));
      }
    }

    const today = utcDayString(clock());
    const cutoff = new Date(clock().getTime() - DB_PRUNE_MIN_AGE_MS).toISOString();
    if (state.day !== today || !state.hasCounter || state.blockedFull) {
      try {
        await initPruneDay(env, today);
      } catch (error) {
        // No delete may run before a persistent quota reservation; an init
        // failure means zero deletes this run, never a bootstrap delete.
        active = sizeBytes > targetBytes;
        lastError = `prune day init failed: ${truncateMessage(error)}`;
        console.error(lastError);
        await recordPruneError(env, lastError);
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
        await stateUpsert(env, STATE_BLOCKED_KEY, "1", nowIso()).run();
      } catch (blockedError) {
        console.error("prune blocked flag persist failed", truncateMessage(blockedError));
      }
    };
    const refundReservedQuota = async (count: number): Promise<boolean> => {
      if (count <= 0) return true;
      try {
        if (await refundQuota(env, count)) {
          state.deletedToday = Math.max(0, state.deletedToday - count);
          return true;
        }
        console.error("prune quota refund not applied", count);
        return false;
      } catch (refundError) {
        console.error("prune quota refund failed", truncateMessage(refundError));
        return false;
      }
    };

    let exhaustedChunks = true;
    let degraded = false;
    for (let chunk = 0; chunk < DB_PRUNE_MAX_CHUNKS && deletedThisRun < DB_PRUNE_RUN_MAX_POSTS; chunk++) {
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
      const wanted = Math.min(DB_PRUNE_BATCH_SIZE, DB_PRUNE_RUN_MAX_POSTS - deletedThisRun, remainingDaily);
      if (wanted <= 0) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }

      const candidates = await env.DB.prepare("SELECT id FROM posts WHERE published_at < ? AND fetched_at < ? ORDER BY published_at ASC, id ASC LIMIT ?")
        .bind(cutoff, cutoff, wanted)
        .all<{ id: number }>();
      const ids = (candidates.results ?? []).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
      if (ids.length === 0) {
        active = false;
        exhaustedChunks = false;
        break;
      }

      let deleted: number | null = 0;
      let reserved = 0;
      try {
        if (!(await reserveQuota(env, ids.length, dailyCap))) {
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        reserved = ids.length;
        state.deletedToday += reserved;

        if (!isPruneWindow(clock())) {
          await refundReservedQuota(reserved);
          if (!lastError) lastError = "prune window closed before delete";
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }

        const outcome = await deletePostIds(env, ids);
        deleted = outcome.deleted;
        if (deleted === null) {
          lastError = "posts delete did not return a changes count; keeping quota reservation";
          await markBlocked();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if (deleted < reserved) {
          await refundReservedQuota(reserved - deleted);
        }
        if (deleted === 0) await markBlocked();
      } catch (error) {
        if (isDailyWriteQuotaError(error)) {
          // No application-level total cap: the platform refused the write.
          // Keep the quota reservation, end the round, and wait for the next
          // 00:00 UTC reset plus the following 23:30-00:00 window.
          lastError = `D1 daily write quota exhausted; prune paused until 00:00 UTC: ${truncateMessage(error)}`;
          console.error(lastError);
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if (!isDbSizeError(error)) {
          // Ambiguous batch outcome (timeout/transport error): the posts may
          // have been deleted, so the quota reservation stays.
          lastError = truncateMessage(error);
          await markBlocked();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        console.error("prune 4-statement batch failed; wall path", truncateMessage(error));
        if (reserved <= 0) {
          lastError = "prune reservation failed at size wall";
          await markBlocked();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if (!isPruneWindow(clock()) || !headroom(4)) {
          await refundReservedQuota(reserved);
          if (!lastError) lastError = "prune window or query budget closed before full-db fallback";
          await markBlocked();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        const wall = await wallDeleteIds(env, ids, () => isPruneWindow(clock()));
        if (wall.postError !== null && isDailyWriteQuotaError(wall.postError)) {
          lastError = `D1 daily write quota exhausted; prune paused until 00:00 UTC: ${truncateMessage(wall.postError)}`;
          console.error(lastError);
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if (wall.postError !== null && !isDbSizeError(wall.postError)) {
          // The posts delete was submitted but the outcome is unknown.
          lastError = truncateMessage(wall.postError);
          await markBlocked();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if (!wall.postsSubmitted) {
          // The posts delete was never submitted, so its quota is provably
          // unused; committed read_states deletes are not undone.
          await refundReservedQuota(reserved);
          if (!lastError) lastError = "prune window closed before wall posts delete";
          await markBlocked();
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        if (wall.postError !== null) {
          // The posts delete failed with a capacity error: posts are known not
          // deleted, read_states may be committed. 1-row degradation reuses the
          // same reservation and refunds only provably unused post quota.
          if (!headroom(DB_PRUNE_DEGRADED_QUERY_RESERVE)) {
            await refundReservedQuota(reserved);
            lastError = "query headroom insufficient before degraded deletes";
            await markBlocked();
            active = sizeBytes > targetBytes;
            exhaustedChunks = false;
            break;
          }
          degraded = true;
          const degradation = await degradedDeleteIds(env, ids, () => isPruneWindow(clock()) && headroom(2));
          deleted = degradation.confirmedDeleted;
          const refundable = degradation.definiteNotDeleted + degradation.notAttempted;
          if (refundable > 0) await refundReservedQuota(refundable);
          lastError = degradation.firstError || truncateMessage(wall.postError);
          await markBlocked();
        } else {
          deleted = wall.deleted;
          if (deleted === null) {
            lastError = "wall posts delete did not return a changes count; keeping quota reservation";
            await markBlocked();
          } else {
            if (deleted < reserved) await refundReservedQuota(reserved - deleted);
            if (deleted === 0) await markBlocked();
          }
        }
      }
      const counted = deleted === null ? 0 : deleted;
      deletedThisRun += counted;

      if (degraded) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      if (counted === 0) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }

      const probed = await readDatabaseSizeBytes(env);
      if (probed === null) {
        lastError = "size_after unavailable";
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }
      sizeBytes = probed;
      if (sizeBytes <= targetBytes) {
        active = false;
        exhaustedChunks = false;
        break;
      }
    }
    if (exhaustedChunks) active = sizeBytes > targetBytes;
    if (deletedThisRun === 0 && !lastError && baseError) lastError = baseError;

    const finishedAt = nowIso();
    const finalStatements: D1PreparedStatement[] = [stateUpsert(env, STATE_ACTIVE_KEY, active ? "1" : "0", finishedAt)];
    if (deletedThisRun > 0) finalStatements.push(stateUpsert(env, STATE_LAST_AT_KEY, finishedAt, finishedAt));
    if (deletedThisRun > 0 || lastError) finalStatements.push(stateUpsert(env, STATE_LAST_ERROR_KEY, lastError, finishedAt));
    if (queryRemaining() >= 2) {
      try {
        await env.DB.batch(finalStatements);
      } catch (error) {
        console.error("prune final state batch failed", truncateMessage(error));
      }
    } else {
      console.error("query budget exhausted before final prune state write");
    }

    // The blocked flag clear stays best-effort and outside the atomic final
    // batch: a clear failure must not roll back active/last_at/last_error.
    if (!degraded && sizeBytes < limitBytes && queryRemaining() >= 1) {
      try {
        await stateUpsert(env, STATE_BLOCKED_KEY, "0", finishedAt).run();
      } catch (clearError) {
        console.error("prune blocked flag clear failed", truncateMessage(clearError));
      }
    }

    return createdState();
  } catch (error) {
    lastError = truncateMessage(error);
    console.error("pruneOldPostsBySize failed", lastError);
    try {
      await stateUpsert(env, STATE_LAST_ERROR_KEY, lastError, nowIso()).run();
    } catch (persistError) {
      console.error("pruneOldPostsBySize failed to persist error state", truncateMessage(persistError));
    }
    return {
      skipped: false,
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
      dailyCap
    };
  }
}
