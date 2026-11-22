// Independent search-backfill cron for queue ingest mode. It runs only from the
// maintenance-triggered scheduled invocation; inline mode keeps its backfill in
// the sync invocation's background chain (src/index.ts).
import { one } from "./db";
import { emitRunLog } from "./observability";
import type { RunContext } from "./observability";
import { backfillSearchIndexes } from "./search";
import type { Env } from "./types";

// Owner-approved 5-post batch for the maintenance cron. Multi-batch runs are
// deliberately not implemented until separately approved.
export const MAINTENANCE_BACKFILL_BATCH = 5;

export interface MaintenanceGate {
  indexState: string | null;
  searchComplete: number | null;
}

export type MaintenanceDecision =
  | { action: "skip"; reason: "index_state_1" | "complete" }
  | { action: "backfill" };

export function decideMaintenance(gate: MaintenanceGate): MaintenanceDecision {
  if (gate.indexState === "1") return { action: "skip", reason: "index_state_1" };
  if (gate.searchComplete === 1) return { action: "skip", reason: "complete" };
  return { action: "backfill" };
}

async function loadMaintenanceGate(env: Env): Promise<MaintenanceGate> {
  const row = await one<{ indexValue: string | null; searchComplete: number | null }>(
    env.DB.prepare(`SELECT
      (SELECT value FROM sync_state WHERE key = 'db_prune_index_state') AS indexValue,
      (SELECT complete FROM search_index_state WHERE id = 1) AS searchComplete`)
  );
  return { indexState: row?.indexValue ?? null, searchComplete: row?.searchComplete ?? null };
}

export async function runMaintenanceCron(env: Env, ctx: ExecutionContext, run: RunContext): Promise<void> {
  void ctx;
  const startedAt = Date.now();
  run.role = "maintenance";
  const finish = (outcome: string, stage: string | null = null): void => {
    run.fields.maintenanceMs = Date.now() - startedAt;
    emitRunLog(run, outcome, stage);
  };

  let gate: MaintenanceGate;
  try {
    gate = await loadMaintenanceGate(env);
  } catch (error) {
    console.error("loadMaintenanceGate failed", error instanceof Error ? error.message : String(error));
    finish("failed", "maintenance_gate");
    return;
  }

  run.fields.indexState = gate.indexState ?? "missing";
  run.fields.searchComplete = gate.searchComplete === 1 ? 1 : 0;

  const decision = decideMaintenance(gate);
  if (decision.action === "skip") {
    run.fields.skippedReason = decision.reason;
    finish(decision.reason === "index_state_1" ? "skipped" : "ok");
    return;
  }

  try {
    const result = await backfillSearchIndexes(env, MAINTENANCE_BACKFILL_BATCH);
    run.fields.backfilled = result.indexed;
    run.fields.searchComplete = result.complete ? 1 : 0;
    finish("ok");
  } catch (error) {
    console.error("backfillSearchIndexes (maintenance cron) failed", error instanceof Error ? error.message : String(error));
    finish("failed", "search_backfill");
  }
}
