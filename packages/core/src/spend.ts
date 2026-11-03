export type SpendGrouping = "tag" | "objective" | "day";

export interface SpendUsage {
  readonly attempts: number;
  /** Null means no Attempt reported cost; separate currencies are never combined. */
  readonly reportedCostByCurrency: Readonly<Record<string, number>> | null;
  readonly unknownCostAttempts: number;
  readonly estimatedCostAttempts?: number;
  /** Unknown-cost Attempts that reported tokens for a model the Harness has no price for, by model. */
  readonly unpricedModels?: Readonly<Record<string, number>>;
  /** Tokens on unknown-cost Attempts with a named unpriced model. */
  readonly unpricedTokens?: number;
  readonly reportedTokens: number | null;
  readonly unknownTokenAttempts: number;
}

export interface SpendGroup extends SpendUsage {
  readonly key: string;
  readonly name?: string;
  /** Reply activation usage, already included in this group's totals. */
  readonly postTriggered: SpendUsage;
  readonly budget?: { readonly limitMinor: number; readonly currency: string | null } | null;
}

export interface SpendReport {
  readonly by: SpendGrouping;
  readonly since: string | null;
  readonly groups: readonly SpendGroup[];
}

export interface SpendStore {
  readSpend(input?: {
    readonly by?: SpendGrouping;
    readonly since?: string;
    /** Restrict aggregation to these Objectives, including their surface Tasks; an empty list returns no groups. */
    readonly objectiveIds?: readonly string[];
    /** Restrict aggregation to these Tasks; an empty list returns no groups. */
    readonly taskIds?: readonly string[];
  }): Promise<SpendReport>;
}

export function parseSpendSince(value: string): string {
  const date = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    date === null ||
    new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])))
      .toISOString()
      .slice(0, 10) !== value.slice(0, 10)
  )
    throw new Error("since must be a valid ISO timestamp with a timezone");
  return new Date(value).toISOString();
}
