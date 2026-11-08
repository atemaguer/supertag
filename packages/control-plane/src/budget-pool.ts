import {
  type Objective,
  POOL_FLOOR_RATIO,
  type SpendReport,
  type TaskExecutionRequirements,
} from "@supertag/core";

/**
 * A budget pool: reported token and cost limits that a root Session's Tasks draw on together. An
 * Objective's pool is its budget, shared by every turn of its Sessions. A conversation turn's pool
 * is its own reported limits, shared with every work Session Task it starts or continues,
 * including the Tasks that continue those work Sessions after an approval decision.
 */
export interface BudgetPool {
  readonly maxReportedTokens?: number;
  readonly maxReportedCost?: { readonly currency: string; readonly amountMinor: number };
}

/** What the Tasks drawing on a pool reported spending, the cost in the pool's currency. */
export interface PoolSpend {
  readonly tokens: number;
  readonly costMinor: number;
}

/** An Objective's pool: its budget, when the budget has a currency. */
export function objectivePool(
  objective: Pick<Objective, "budgetLimitMinor" | "budgetCurrency">,
): BudgetPool {
  const limit = objective.budgetLimitMinor;
  const currency = objective.budgetCurrency;
  return limit === null || limit === undefined || !currency
    ? {}
    : { maxReportedCost: { currency, amountMinor: limit } };
}

/** A conversation turn's pool: the turn's own reported token and cost limits. */
export function turnPool(execution: TaskExecutionRequirements): BudgetPool {
  const limits = execution.limits;
  return {
    ...(limits?.maxReportedTokens === undefined
      ? {}
      : { maxReportedTokens: limits.maxReportedTokens }),
    ...(limits?.maxReportedCost === undefined ? {} : { maxReportedCost: limits.maxReportedCost }),
  };
}

/** Whether a pool limits anything. */
export function limitsSpend(pool: BudgetPool): boolean {
  return pool.maxReportedTokens !== undefined || pool.maxReportedCost !== undefined;
}

/** A pool's spend from a spend report over the Tasks drawing on it. */
export function poolSpend(pool: BudgetPool, report: SpendReport): PoolSpend {
  const currency = pool.maxReportedCost?.currency;
  let tokens = 0;
  let costMinor = 0;
  for (const group of report.groups) {
    tokens += group.reportedTokens ?? 0;
    if (currency !== undefined) costMinor += group.reportedCostByCurrency?.[currency] ?? 0;
  }
  return { tokens, costMinor };
}

/**
 * `base`, drawing on a pool: a new Task may spend at most what the pool has left, its limit less
 * what the Tasks drawing on it reported. Allowances of Tasks still running are not held back, so
 * Tasks running at once may together overspend by what they spend in flight. A Task that asked
 * for less keeps its own smaller limit. Undefined when what is left, in tokens or in cost, is below
 * `POOL_FLOOR_RATIO` of the pool's limit: a Task that small would stop on its first model call, so
 * none is admitted. A pool that limits nothing passes `base` on unchanged.
 */
export function poolExecution(
  pool: BudgetPool,
  spent: PoolSpend,
  base: TaskExecutionRequirements,
): TaskExecutionRequirements | undefined {
  const floor = (limit: number) => Math.max(1, Math.ceil(limit * POOL_FLOOR_RATIO));
  if (
    (pool.maxReportedTokens !== undefined &&
      pool.maxReportedTokens - spent.tokens < floor(pool.maxReportedTokens)) ||
    (pool.maxReportedCost !== undefined &&
      pool.maxReportedCost.amountMinor - spent.costMinor < floor(pool.maxReportedCost.amountMinor))
  )
    return undefined;
  return poolRemainderExecution(pool, spent, base);
}

/**
 * `base`, capped at what the pool has left, with no floor: for a Task the pool owes, such as the
 * turn that reports a finished work Session, which runs however little is left. A spent pool
 * leaves it the smallest limit a Task can carry (one token, no cost), so it stops on its first
 * model call.
 */
export function poolRemainderExecution(
  pool: BudgetPool,
  spent: PoolSpend,
  base: TaskExecutionRequirements,
): TaskExecutionRequirements {
  if (!limitsSpend(pool)) return base;
  const own = base.limits;
  let maxReportedTokens = own?.maxReportedTokens;
  if (pool.maxReportedTokens !== undefined) {
    const remaining = Math.max(1, pool.maxReportedTokens - spent.tokens);
    maxReportedTokens = Math.min(maxReportedTokens ?? remaining, remaining);
  }
  let maxReportedCost = own?.maxReportedCost;
  if (pool.maxReportedCost !== undefined) {
    const { currency, amountMinor } = pool.maxReportedCost;
    const remaining = Math.max(0, amountMinor - spent.costMinor);
    maxReportedCost = {
      currency,
      amountMinor:
        maxReportedCost?.currency === currency
          ? Math.min(maxReportedCost.amountMinor, remaining)
          : remaining,
    };
  }
  return {
    ...base,
    limits: {
      ...own,
      ...(maxReportedTokens === undefined ? {} : { maxReportedTokens }),
      ...(maxReportedCost === undefined ? {} : { maxReportedCost }),
    },
  };
}
