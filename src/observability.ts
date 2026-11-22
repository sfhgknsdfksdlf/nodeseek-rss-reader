// Low-overhead structured run logging.
//
// Platform logs already carry the authoritative `cpuTimeMs`/`outcome`/`requestId`
// for every invocation. In-workload timers do not advance during pure-CPU work,
// so this module deliberately emits only one small JSON line per invocation:
// success is sampled at 5%, every non-"ok" outcome is kept. No post bodies,
// tokens, emails, chat ids, or GUID lists ever enter these fields.
export type RunRole = "cron" | "consumer" | "notify" | "maintenance";

export type RunFieldValue = number | string | boolean | null;

export interface RunContext {
  runId: string;
  role: RunRole;
  firstInIsolate: boolean;
  // Temporary `MEASURE_CRON=1` mode: forces the success line out and enables
  // the second `run_measure` line. Never set outside the inline cron flag path.
  measureSuccess: boolean;
  fields: Record<string, RunFieldValue>;
}

// Approximates "this isolate is handling its first event", not a precise cold
// start: a Workers isolate may be reused for many invocations.
let firstInIsolate = true;

export function noteFirstInIsolate(): boolean {
  const isFirst = firstInIsolate;
  firstInIsolate = false;
  return isFirst;
}

export function createRunContext(role: RunRole, isFirstInIsolate: boolean, measureSuccess = false): RunContext {
  return { runId: crypto.randomUUID(), role, firstInIsolate: isFirstInIsolate, measureSuccess, fields: {} };
}

export function shouldEmitRunLog(outcome: string, random: number, measureSuccess = false): boolean {
  if (outcome !== "ok") return true;
  return measureSuccess || random < 0.05;
}

// Cron timing snapshots are one D1 write each, so a healthy cron only samples
// 1 in 10 runs; a failed run (RSS sync or notifications) is always recorded.
export function shouldRecordCronTiming(force: boolean, random: number): boolean {
  return force || random < 0.1;
}

export function emitRunLog(ctx: RunContext, outcome: string, failureStage?: string | null): void {
  if (!shouldEmitRunLog(outcome, Math.random(), ctx.measureSuccess)) return;
  const payload: Record<string, RunFieldValue> = {
    event: "run",
    role: ctx.role,
    syncRunId: ctx.runId,
    firstInIsolate: ctx.firstInIsolate,
    outcome
  };
  if (failureStage !== undefined && failureStage !== null) payload.failureStage = failureStage;
  for (const [key, value] of Object.entries(ctx.fields)) {
    if (value !== null) payload[key] = value;
  }
  console.log(JSON.stringify(payload));
}

// Second measurement-only line, emitted after the waitUntil background chain
// and lease release settle so it carries the complete D1 counters. Uses
// `syncRunId` for correlation; ScheduledEvent has no platform requestId.
export function emitRunMeasureLog(ctx: RunContext, fields: Record<string, RunFieldValue>): void {
  if (!ctx.measureSuccess) return;
  const payload: Record<string, RunFieldValue> = {
    event: "run_measure",
    role: ctx.role,
    syncRunId: ctx.runId,
    firstInIsolate: ctx.firstInIsolate
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) payload[key] = value;
  }
  console.log(JSON.stringify(payload));
}
