// Explicit D1 query budget accounting.
// No imports, no side effects, no global mutable state.

export const D1_QUERY_LIMIT = 50;
export const DB_PRUNE_FINAL_QUERY_RESERVE = 4;

export interface QueryBudget {
  limit: number;
  reserve: number;
  used: number;
  finalUsed: number;
  dailyWriteQuotaExhausted: boolean;
}

export function createQueryBudget(
  limit: number = D1_QUERY_LIMIT,
  reserve: number = DB_PRUNE_FINAL_QUERY_RESERVE,
  prefixUsed: number = 0,
): QueryBudget {
  return {
    limit,
    reserve,
    used: prefixUsed,
    finalUsed: 0,
    dailyWriteQuotaExhausted: false,
  };
}

export function budgetRemaining(b: QueryBudget): number {
  return Math.max(0, b.limit - b.reserve - b.used);
}

export function consumeQuery(b: QueryBudget): void {
  if (b.used + 1 > b.limit - b.reserve) {
    throw new Error("D1 query budget exhausted; final reserve kept");
  }
  b.used += 1;
}

export function consumeFinalQuery(b: QueryBudget): void {
  if (b.finalUsed + 1 > b.reserve) {
    throw new Error("D1 final query reserve exhausted");
  }
  b.finalUsed += 1;
}

export function markDailyWriteQuotaExhausted(b: QueryBudget): void {
  b.dailyWriteQuotaExhausted = true;
}
