// Temporary cron D1 instrumentation (`MEASURE_CRON=1`).
//
// Only wrappers created here are counted. `src/db.ts` and the real binding are
// never modified; the scheduled handler swaps its LOCAL `env.DB` for this
// wrapper while the flag is on, so queue/notify/maintenance paths stay raw.
//
// Call granularity is method-level: `prepare`/`bind` never count, each
// `first`/`all`/`run`/`raw`/`exec` counts exactly once, and `batch` counts once
// for the whole statement array (never per statement). `batch` forwards the
// ORIGINAL prepared statements through a WeakMap, so instrumentation cannot
// double-count or alter the batch itself. No SQL text or bound value is ever
// logged or returned from a snapshot; the phase classifier is a local heuristic
// over SQL text only.
export type D1TopPhase =
  | "gate"
  | "state"
  | "settings"
  | "size"
  | "lease"
  | "sync"
  | "notifications"
  | "cleanup"
  | "timing"
  | "prune"
  | "background";

export type D1SqlPhase = "first" | "fts" | "posts" | "guid" | "fallback";

export type D1Phase = D1TopPhase | D1SqlPhase | "unphased";

export interface D1Metrics {
  calls: number;
  batchCalls: number;
  durationMs: number;
  rowsRead: number;
  rowsWritten: number;
  sizeAfter: number | null;
  phaseCounts: Partial<Record<D1Phase, number>>;
  activePhase: D1TopPhase | null;
}

export interface D1MetricsSnapshot {
  calls: number;
  batchCalls: number;
  durationMs: number;
  rowsRead: number;
  rowsWritten: number;
  sizeAfter: number | null;
  phaseCounts: Partial<Record<D1Phase, number>>;
}

export function createD1Metrics(): D1Metrics {
  return {
    calls: 0,
    batchCalls: 0,
    durationMs: 0,
    rowsRead: 0,
    rowsWritten: 0,
    sizeAfter: null,
    phaseCounts: {},
    activePhase: null
  };
}

export function snapshotD1Metrics(metrics: D1Metrics): D1MetricsSnapshot {
  return {
    calls: metrics.calls,
    batchCalls: metrics.batchCalls,
    durationMs: metrics.durationMs,
    rowsRead: metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    sizeAfter: metrics.sizeAfter,
    phaseCounts: { ...metrics.phaseCounts }
  };
}

// Marks the currently running top-level stage. When `metrics` is null (flag
// off) the callback is invoked directly and no wrapper bookkeeping happens.
export function withPhase<T>(metrics: D1Metrics | null, phase: D1TopPhase, fn: () => Promise<T>): Promise<T> {
  if (!metrics) return fn();
  const previous = metrics.activePhase;
  metrics.activePhase = phase;
  let pending: Promise<T>;
  try {
    pending = fn();
  } catch (error) {
    metrics.activePhase = previous;
    throw error;
  }
  return pending.finally(() => {
    metrics.activePhase = previous;
  });
}

// Heuristic used only inside the `sync` stage to split its D1 calls. Anything
// unrecognized stays in `fallback`; sync-state writes land there on purpose.
export function classifySqlPhase(sql: string): D1SqlPhase {
  const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return "fallback";
  if (normalized.includes("first_sync")) return "first";
  if (normalized.includes("posts_search_")) return "fts";
  if (normalized.includes("insert or ignore into posts")) return "posts";
  if (normalized.includes("from posts where guid in")) return "guid";
  return "fallback";
}

// A batch is attributed by its FIRST statement, because the merged FTS batch
// starts with a `posts_search_` delete and the insert batch starts with
// `INSERT OR IGNORE INTO posts`. The whole batch still counts as one call.
export function classifyBatchPhase(statements: readonly string[]): D1SqlPhase {
  return statements.length > 0 ? classifySqlPhase(statements[0] ?? "") : "fallback";
}

const originalStatements = new WeakMap<object, D1PreparedStatement>();
const statementSql = new WeakMap<object, string>();

function bump(metrics: D1Metrics, phase: D1Phase): void {
  metrics.phaseCounts[phase] = (metrics.phaseCounts[phase] ?? 0) + 1;
}

function recordCall(metrics: D1Metrics, sqlPhase: D1SqlPhase, isBatch = false): void {
  metrics.calls += 1;
  if (isBatch) metrics.batchCalls += 1;
  const phase = metrics.activePhase;
  bump(metrics, phase ?? "unphased");
  if (phase === "sync") bump(metrics, sqlPhase);
}

function accumulateMeta(metrics: D1Metrics, result: D1Result<unknown> | undefined): void {
  const meta = result?.meta;
  if (!meta) return;
  if (typeof meta.duration === "number" && Number.isFinite(meta.duration)) metrics.durationMs += meta.duration;
  if (typeof meta.rows_read === "number" && Number.isFinite(meta.rows_read)) metrics.rowsRead += meta.rows_read;
  if (typeof meta.rows_written === "number" && Number.isFinite(meta.rows_written)) metrics.rowsWritten += meta.rows_written;
  if (typeof meta.size_after === "number" && Number.isFinite(meta.size_after)) metrics.sizeAfter = meta.size_after;
}

class MeasuredStatement implements D1PreparedStatement {
  constructor(
    private readonly real: D1PreparedStatement,
    private readonly sql: string,
    private readonly metrics: D1Metrics
  ) {
    originalStatements.set(this, real);
    statementSql.set(this, sql);
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new MeasuredStatement(this.real.bind(...values), this.sql, this.metrics);
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(colName?: string): Promise<T | null> {
    recordCall(this.metrics, classifySqlPhase(this.sql));
    if (typeof colName === "string") return this.real.first<T>(colName);
    return this.real.first<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    recordCall(this.metrics, classifySqlPhase(this.sql));
    const result = await this.real.run<T>();
    accumulateMeta(this.metrics, result);
    return result;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    recordCall(this.metrics, classifySqlPhase(this.sql));
    const result = await this.real.all<T>();
    accumulateMeta(this.metrics, result);
    return result;
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    recordCall(this.metrics, classifySqlPhase(this.sql));
    if (options?.columnNames) return this.real.raw<T>({ columnNames: true });
    return this.real.raw<T>();
  }
}

class MeasuredDb implements D1Database {
  constructor(
    private readonly real: D1Database,
    private readonly metrics: D1Metrics
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new MeasuredStatement(this.real.prepare(query), query, this.metrics);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const originals = statements.map((statement) => originalStatements.get(statement) ?? statement);
    const sqlTexts = statements.map((statement) => statementSql.get(statement) ?? "");
    recordCall(this.metrics, classifyBatchPhase(sqlTexts), true);
    const results = await this.real.batch<T>(originals);
    for (const result of results) accumulateMeta(this.metrics, result);
    return results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    recordCall(this.metrics, classifySqlPhase(query));
    const result = await this.real.exec(query);
    if (typeof result.duration === "number" && Number.isFinite(result.duration)) this.metrics.durationMs += result.duration;
    return result;
  }

  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    // Sessions are not used by cron paths; delegate without instrumenting so
    // the wrapper never changes session semantics.
    return this.real.withSession(constraintOrBookmark);
  }

  dump(): Promise<ArrayBuffer> {
    return this.real.dump();
  }
}

export function createMeasuredDb(db: D1Database, metrics: D1Metrics): D1Database {
  return new MeasuredDb(db, metrics);
}
