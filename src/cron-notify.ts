// Independent notification cron for queue ingest mode. It only runs from the
// notify-triggered scheduled invocation; inline mode keeps dispatching
// notifications inside the sync invocation (src/index.ts).
import { one } from "./db";
import { emitRunLog } from "./observability";
import type { RunContext } from "./observability";
import { D1_QUERY_LIMIT, DB_PRUNE_FINAL_QUERY_RESERVE, createQueryBudget } from "./query-budget";
import { loadNotificationSnapshot, normalizeLegacyCursor, processNotifications } from "./subscriptions";
import type { NotificationSnapshot } from "./subscriptions";
import type { Env } from "./types";

export const NOTIFICATION_LEASE_KEY = "notification_lease";
// Covers the 15-minute cron wall-clock limit plus one minute of margin, so a
// slow-but-alive invocation can never have its lease stolen by the next cron.
export const NOTIFICATION_LEASE_MAX_AGE_MS = 16 * 60 * 1000;

export function notificationSnapshotHasWork(snapshot: NotificationSnapshot): boolean {
  if (!snapshot.cursorPresent) return true;
  if (normalizeLegacyCursor(snapshot).postId !== snapshot.postId) return true;
  return snapshot.postId <= snapshot.maxPostId;
}

interface NotificationGate {
  firstSyncDone: boolean;
  indexState: string | null;
}

export async function acquireNotificationLease(env: Env, now: Date = new Date()): Promise<string | null> {
  const token = `${now.toISOString()}#${crypto.randomUUID()}`;
  const staleCutoff = new Date(now.getTime() - NOTIFICATION_LEASE_MAX_AGE_MS).toISOString();
  const result = await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE sync_state.value = '' OR (sync_state.updated_at <> '' AND datetime(sync_state.updated_at) IS NOT NULL AND julianday(sync_state.updated_at) <= julianday(?))")
    .bind(NOTIFICATION_LEASE_KEY, token, now.toISOString(), staleCutoff)
    .run();
  return Number(result.meta?.changes ?? 0) === 1 ? token : null;
}

export async function releaseNotificationLease(env: Env, token: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM sync_state WHERE key = ? AND value = ?").bind(NOTIFICATION_LEASE_KEY, token).run();
  } catch (error) {
    console.error("releaseNotificationLease failed", error instanceof Error ? error.message : String(error));
  }
}

async function loadNotificationGate(env: Env): Promise<NotificationGate> {
  const row = await one<{ firstDone: string | null; indexValue: string | null }>(
    env.DB.prepare(`SELECT
      (SELECT value FROM sync_state WHERE key = 'first_sync_done') AS firstDone,
      (SELECT value FROM sync_state WHERE key = 'db_prune_index_state') AS indexValue`)
  );
  return { firstSyncDone: row?.firstDone === "1", indexState: row?.indexValue ?? null };
}

export async function runNotificationCron(env: Env, ctx: ExecutionContext, run: RunContext): Promise<void> {
  void ctx;
  const startedAt = Date.now();
  run.role = "notify";
  const finish = (outcome: string, stage: string | null = null): void => {
    run.fields.notifyMs = Date.now() - startedAt;
    emitRunLog(run, outcome, stage);
  };

  let gate: NotificationGate;
  try {
    gate = await loadNotificationGate(env);
  } catch (error) {
    console.error("loadNotificationGate failed", error instanceof Error ? error.message : String(error));
    finish("failed", "notify_gate");
    return;
  }
  let usedQueries = 1;
  if (!gate.firstSyncDone) {
    finish("skipped", "first_sync_pending");
    return;
  }
  if (gate.indexState === "1") {
    finish("skipped", "index_state_1");
    return;
  }

  let snapshot: NotificationSnapshot;
  try {
    snapshot = await loadNotificationSnapshot(env);
  } catch (error) {
    console.error("loadNotificationSnapshot failed", error instanceof Error ? error.message : String(error));
    finish("failed", "notify_snapshot");
    return;
  }
  usedQueries += 1;

  if (!notificationSnapshotHasWork(snapshot)) {
    run.fields.attempts = 0;
    run.fields.matches = 0;
    run.fields.skipped = 0;
    run.fields.cursorPostId = normalizeLegacyCursor(snapshot).postId;
    finish("ok");
    return;
  }

  let leaseToken: string | null;
  try {
    leaseToken = await acquireNotificationLease(env);
  } catch (error) {
    console.error("acquireNotificationLease failed", error instanceof Error ? error.message : String(error));
    finish("failed", "notification_lease_acquire");
    return;
  }
  usedQueries += 1;
  if (!leaseToken) {
    console.warn("notification lease is held by another invocation; skipping notify work");
    finish("skipped", "notification_lease_held");
    return;
  }
  const token = leaseToken;

  try {
    let snapshotAfterLease: NotificationSnapshot;
    try {
      snapshotAfterLease = await loadNotificationSnapshot(env);
    } catch (error) {
      console.error("loadNotificationSnapshot after lease failed", error instanceof Error ? error.message : String(error));
      finish("failed", "notify_snapshot_after_lease");
      return;
    }
    usedQueries += 1;

    if (!notificationSnapshotHasWork(snapshotAfterLease)) {
      run.fields.attempts = 0;
      run.fields.matches = 0;
      run.fields.skipped = 0;
      run.fields.cursorPostId = normalizeLegacyCursor(snapshotAfterLease).postId;
      finish("ok", "notify_no_work_after_lease");
      return;
    }

    const budget = createQueryBudget(D1_QUERY_LIMIT, DB_PRUNE_FINAL_QUERY_RESERVE, usedQueries);
    const result = await processNotifications(env, budget, snapshotAfterLease);
    run.fields.attempts = result.attempts;
    run.fields.matches = result.matches;
    run.fields.skipped = result.skipped;
    run.fields.cursorPostId = result.cursor.postId;
    finish("ok");
  } catch (error) {
    console.error("processNotifications (notify cron) failed", error instanceof Error ? error.message : String(error));
    finish("failed", "notifications");
  } finally {
    await releaseNotificationLease(env, token);
  }
}
