// D1 capacity pruning (owner-approved 2026-11-20, see AGENTS.md).
// Self-contained on purpose: only a type-only import, so the pure helpers can be
// imported by `node --experimental-strip-types` without dependency resolution.
import type { Env } from "./types";

export const DB_PRUNE_FREE_DEFAULT_LIMIT_MB = 480;
export const DB_PRUNE_PAID_DEFAULT_LIMIT_MB = 9850;
export const DB_PRUNE_DEFAULT_LIMIT_MB = DB_PRUNE_FREE_DEFAULT_LIMIT_MB;
export const DB_PRUNE_MIN_LIMIT_MB = 100;
export const DB_PRUNE_MAX_LIMIT_MB = 9850;
export const DB_PRUNE_HYSTERESIS_BYTES = 30_000_000;
export const DB_PRUNE_DAILY_CAP = 20_000;
export const DB_PRUNE_BATCH_SIZE = 100;
export const DB_PRUNE_DEGRADED_MAX_IDS = 10;
export const DB_PRUNE_MAX_CHUNKS = 5;
export const DB_PRUNE_RUN_MAX_POSTS = 500;
export const DB_PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const D1_FREE_MAX_CAPACITY_MB = 500;
export const D1_PAID_MAX_CAPACITY_MB = 10000;
export const D1_FIVE_POST_MARGIN_MB = 2;

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

export function pruneThresholds(limitMb: number): { limitBytes: number; targetBytes: number } {
  const limitBytes = limitMb * 1_000_000;
  // Keep the 30MB hysteresis below the limit; the floor only guards against a
  // negative target for limits below the hysteresis size.
  const targetBytes = Math.max(0, limitBytes - DB_PRUNE_HYSTERESIS_BYTES);
  return { limitBytes, targetBytes };
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

async function reserveQuota(env: Env, count: number): Promise<boolean> {
  const result = await env.DB.prepare("UPDATE sync_state SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT), updated_at = ? WHERE key = ? AND CAST(value AS INTEGER) + ? <= ?")
    .bind(count, nowIso(), STATE_DELETED_KEY, count, DB_PRUNE_DAILY_CAP)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

async function deletePostIds(env: Env, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const batch = await env.DB.batch([
    env.DB.prepare(`DELETE FROM read_states WHERE post_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts_search_trigram WHERE rowid IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts_search_bigrams WHERE rowid IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`).bind(...ids)
  ]);
  return Number(batch[3]?.meta?.changes ?? 0);
}

async function refundQuota(env: Env, count: number): Promise<boolean> {
  if (count <= 0) return true;
  const result = await env.DB.prepare("UPDATE sync_state SET value = CAST(MAX(0, CAST(value AS INTEGER) - ?) AS TEXT), updated_at = ? WHERE key = ?")
    .bind(count, nowIso(), STATE_DELETED_KEY)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

async function bootstrapDeleteIds(env: Env, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  try {
    await env.DB.prepare(`DELETE FROM read_states WHERE post_id IN (${placeholders})`).bind(...ids).run();
  } catch (error) {
    console.error("bootstrap read_states delete failed", truncateMessage(error));
  }
  const result = await env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`).bind(...ids).run();
  return Number(result.meta?.changes ?? 0);
}

interface DegradedDeleteResult {
  confirmedDeleted: number;
  definiteNotDeleted: number;
  uncertainReserved: number;
  firstError: string;
}

async function degradedDeleteIds(env: Env, ids: number[]): Promise<DegradedDeleteResult> {
  const limit = Math.min(DB_PRUNE_DEGRADED_MAX_IDS, ids.length);
  let confirmedDeleted = 0;
  let definiteNotDeleted = 0;
  let firstError = "";
  for (let index = 0; index < limit; index++) {
    const id = ids[index];
    try {
      await env.DB.prepare("DELETE FROM read_states WHERE post_id = ?").bind(id).run();
    } catch (error) {
      console.error("degraded read_states delete failed", truncateMessage(error));
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
        break;
      }
    } catch (error) {
      firstError = truncateMessage(error);
      break;
    }
  }
  return { confirmedDeleted, definiteNotDeleted, uncertainReserved: ids.length - confirmedDeleted - definiteNotDeleted, firstError };
}

async function persistBootstrapAccounting(env: Env, settled: number, lastError: string, day?: string): Promise<void> {
  const updatedAt = nowIso();
  const statements = [
    stateUpsert(env, STATE_DELETED_KEY, String(settled), updatedAt),
    stateUpsert(env, STATE_BLOCKED_KEY, "1", updatedAt),
    stateUpsert(env, STATE_ACTIVE_KEY, "1", updatedAt),
    stateUpsert(env, STATE_LAST_ERROR_KEY, lastError, updatedAt)
  ];
  if (day !== undefined) statements.push(stateUpsert(env, STATE_DAY_KEY, day, updatedAt));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error("bootstrap accounting persist failed", truncateMessage(error));
  }
}

async function deleteOldestChunkBootstrap(env: Env, cutoff: string, limit: number): Promise<number> {
  const candidates = await env.DB.prepare("SELECT id FROM posts WHERE published_at < ? AND fetched_at < ? ORDER BY published_at ASC, id ASC LIMIT ?")
    .bind(cutoff, cutoff, limit)
    .all<{ id: number }>();
  const ids = (candidates.results ?? []).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
  return bootstrapDeleteIds(env, ids);
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
    const { limitBytes } = pruneThresholds(limitMb);
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
export async function pruneOldPostsBySize(env: Env): Promise<PruneRunResult> {
  let sizeBytes: number | null = null;
  let paidPlan = false;
  let maxCapacityBytes = D1_FREE_MAX_CAPACITY_MB * 1_000_000;
  let fivePostThresholdBytes = Math.max(0, maxCapacityBytes - D1_FIVE_POST_MARGIN_MB * 1_000_000);
  let limitMb = DB_PRUNE_FREE_DEFAULT_LIMIT_MB;
  let thresholds = pruneThresholds(limitMb);
  let state: PruneState = { active: false, day: "", deletedToday: 0, deletedTodayRaw: "", lastAt: "", lastError: "", hasCounter: false, blockedFull: false };
  let active = false;
  let deletedThisRun = 0;
  let lastError = "";
  try {
    const createdState = () => ({
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
      fivePostThresholdBytes
    });

    paidPlan = await readD1PaidEnabled(env);
    limitMb = await readDbPruneLimitMb(env, paidPlan);
    thresholds = pruneThresholds(limitMb);
    const maxCapacityMb = paidPlan ? D1_PAID_MAX_CAPACITY_MB : D1_FREE_MAX_CAPACITY_MB;
    maxCapacityBytes = maxCapacityMb * 1_000_000;
    fivePostThresholdBytes = Math.max(0, maxCapacityBytes - D1_FIVE_POST_MARGIN_MB * 1_000_000);
    const { limitBytes, targetBytes } = thresholds;
    sizeBytes = await readDatabaseSizeBytes(env);
    if (sizeBytes === null) {
      return { skipped: true, sizeBytes: null, limitBytes, targetBytes, active: false, deletedToday: 0, deletedThisRun: 0, lastError: "", paidPlan, maxCapacityBytes, fivePostThresholdBytes };
    }

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

    if (state.deletedTodayRaw && state.deletedTodayRaw !== String(state.deletedToday)) {
      try {
        await stateUpsert(env, STATE_DELETED_KEY, String(state.deletedToday), nowIso()).run();
      } catch (error) {
        console.error("prune counter normalize failed", truncateMessage(error));
      }
    }

    const cutoff = new Date(Date.now() - DB_PRUNE_MIN_AGE_MS).toISOString();
    const today = utcDayString();
    const previousDay = state.day;
    let emergencyDeleted = 0;
    if (state.day !== today || !state.hasCounter || state.blockedFull) {
      let secondInitFailed = false;
      try {
        await initPruneDay(env, today);
      } catch (error) {
        if (!isDbSizeError(error)) throw error;
        console.error("prune day init failed; bootstrap delete", truncateMessage(error));
        // A same-day retry must not bootstrap past the remaining daily cap.
        const remainingDaily = previousDay === today ? Math.max(0, DB_PRUNE_DAILY_CAP - state.deletedToday) : DB_PRUNE_BATCH_SIZE;
        const bootstrapLimit = Math.min(DB_PRUNE_BATCH_SIZE, remainingDaily);
        emergencyDeleted = bootstrapLimit > 0 ? await deleteOldestChunkBootstrap(env, cutoff, bootstrapLimit) : 0;
        deletedThisRun += emergencyDeleted;
        try {
          await initPruneDay(env, today);
        } catch (retryError) {
          secondInitFailed = true;
          console.error("prune day init retry failed", truncateMessage(retryError));
        }
      }
      state.hasCounter = true;
      if (previousDay < today) {
        state.day = today;
        state.deletedToday = 0;
      }
      const settled = previousDay === today ? state.deletedToday + emergencyDeleted : emergencyDeleted;
      if (secondInitFailed) {
        active = true;
        lastError = "prune day init failed after bootstrap deletion";
        state.deletedToday = settled;
        await persistBootstrapAccounting(env, settled, lastError, today);
        return createdState();
      }
      if (emergencyDeleted > 0) {
        let quotaReserved = false;
        try {
          quotaReserved = await reserveQuota(env, emergencyDeleted);
        } catch (error) {
          console.error("bootstrap quota reservation failed", truncateMessage(error));
          state.deletedToday = settled;
          active = true;
          lastError = truncateMessage(error);
          await persistBootstrapAccounting(env, settled, lastError);
          return createdState();
        }
        if (!quotaReserved) {
          state.deletedToday = settled;
          active = true;
          lastError = "bootstrap deletion occurred but quota settlement failed";
          await persistBootstrapAccounting(env, settled, lastError);
          return createdState();
        }
        state.deletedToday = settled;
      }
    }

    let exhaustedChunks = true;
    let degraded = false;
    for (let chunk = 0; chunk < DB_PRUNE_MAX_CHUNKS && deletedThisRun < DB_PRUNE_RUN_MAX_POSTS; chunk++) {
      const remainingDaily = DB_PRUNE_DAILY_CAP - state.deletedToday;
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

      let deleted = 0;
      let reserved = 0;
      try {
        if (!(await reserveQuota(env, ids.length))) {
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          break;
        }
        reserved = ids.length;
        state.deletedToday += reserved;
        deleted = await deletePostIds(env, ids);
        if (deleted < reserved) {
          const refund = reserved - deleted;
          try {
            if (await refundQuota(env, refund)) state.deletedToday = Math.max(0, state.deletedToday - refund);
          } catch (error) {
            lastError = truncateMessage(error);
          }
        }
      } catch (error) {
        if (!isDbSizeError(error)) throw error;
        console.error("prune 4-statement batch failed; wall path", truncateMessage(error));
        if (reserved <= 0) {
          active = sizeBytes > targetBytes;
          exhaustedChunks = false;
          lastError = "prune reservation failed at size wall";
          try {
            await stateUpsert(env, STATE_BLOCKED_KEY, "1", nowIso()).run();
          } catch (blockedError) {
            console.error("prune blocked flag persist failed", truncateMessage(blockedError));
          }
          break;
        }
        let wallError: unknown = null;
        try {
          deleted = await bootstrapDeleteIds(env, ids);
        } catch (thrown) {
          wallError = thrown;
          if (!isDbSizeError(thrown)) {
            try {
              if (await refundQuota(env, reserved)) state.deletedToday = Math.max(0, state.deletedToday - reserved);
            } catch (refundError) {
              console.error("prune wall refund failed", truncateMessage(refundError));
            }
            throw thrown;
          }
        }
        if (wallError !== null) {
          // 1-row degradation: the 100-row wall delete itself failed, so retry
          // at most 10 IDs individually and keep every unconfirmed reservation.
          degraded = true;
          const degradation = await degradedDeleteIds(env, ids);
          deleted = degradation.confirmedDeleted;
          const refundable = reserved - degradation.confirmedDeleted - degradation.uncertainReserved;
          let refundFailed = false;
          if (refundable > 0) {
            try {
              if (await refundQuota(env, refundable)) {
                state.deletedToday = Math.max(0, state.deletedToday - refundable);
              } else {
                refundFailed = true;
                console.error("prune degraded quota refund not applied", refundable);
              }
            } catch (refundError) {
              refundFailed = true;
              console.error("prune degraded quota refund failed", truncateMessage(refundError));
            }
          }
          lastError = refundFailed ? truncateMessage(wallError) : degradation.firstError || truncateMessage(wallError);
          try {
            await stateUpsert(env, STATE_BLOCKED_KEY, "1", nowIso()).run();
          } catch (blockedError) {
            console.error("prune blocked flag persist failed", truncateMessage(blockedError));
          }
        } else if (deleted < reserved) {
          const refund = reserved - deleted;
          try {
            if (await refundQuota(env, refund)) state.deletedToday = Math.max(0, state.deletedToday - refund);
          } catch (refundError) {
            lastError = truncateMessage(refundError);
          }
        }
        if (!degraded && deleted === 0) {
          try {
            await stateUpsert(env, STATE_BLOCKED_KEY, "1", nowIso()).run();
          } catch (blockedError) {
            console.error("prune blocked flag persist failed", truncateMessage(blockedError));
          }
        }
      }
      deletedThisRun += deleted;

      if (degraded) {
        active = sizeBytes > targetBytes;
        exhaustedChunks = false;
        break;
      }

      if (deleted === 0) {
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
    await env.DB.batch(finalStatements);

    // The blocked flag clear stays best-effort and outside the atomic final
    // batch: a clear failure must not roll back active/last_at/last_error.
    if (!degraded && sizeBytes < limitBytes) {
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
    return { skipped: false, sizeBytes, limitBytes: thresholds.limitBytes, targetBytes: thresholds.targetBytes, active, deletedToday: state.deletedToday, deletedThisRun, lastError, paidPlan, maxCapacityBytes, fivePostThresholdBytes };
  }
}
