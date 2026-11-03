import {
  type DatabaseProvider,
  estimatedCodexCost,
  parseSpendSince,
  type SpendGroup,
  type SpendGrouping,
  type SpendReport,
} from "@supertag/core";

type Row = Readonly<Record<string, unknown>>;
type Query = (statement: string, parameters?: readonly unknown[]) => Promise<readonly Row[]>;
interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly totalTokens: number;
  readonly reportedCost?: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly estimated?: boolean;
  };
  readonly unpricedModel?: string;
}

const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** Same validity rule as Task execution reports, so spend matches budget accounting. */
function validUsage(raw: unknown): Usage | null {
  const payload = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as Record<string, unknown>)["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const value = usage as Record<string, unknown>;
  if (
    !count(value["inputTokens"]) ||
    !count(value["outputTokens"]) ||
    !count(value["cachedInputTokens"]) ||
    !count(value["totalTokens"]) ||
    typeof value["complete"] !== "boolean"
  )
    return null;
  const cost = value["reportedCost"] as Record<string, unknown> | undefined;
  return {
    inputTokens: value["inputTokens"],
    outputTokens: value["outputTokens"],
    cachedInputTokens: value["cachedInputTokens"],
    totalTokens: value["totalTokens"],
    ...(typeof cost === "object" &&
    cost !== null &&
    count(cost["amountMinor"]) &&
    typeof cost["currency"] === "string" &&
    /^[A-Z]{3}$/u.test(cost["currency"])
      ? {
          reportedCost: {
            amountMinor: cost["amountMinor"],
            currency: cost["currency"],
            estimated: cost["estimated"] === true,
          },
        }
      : typeof value["unpricedModel"] === "string" &&
          /^[\w.:/-]{1,200}$/u.test(value["unpricedModel"])
        ? { unpricedModel: value["unpricedModel"] }
        : {}),
  };
}

const USAGE_TYPES = `('usage.updated', 'execution.usage.updated')`;

/**
 * Read each Attempt once with only its latest provider usage report. The
 * `TaskEvent_attemptId_type_sequence_idx` index makes that lookup a short index seek, so a
 * whole-history report costs one pass over Attempts rather than one pass over every event per
 * Attempt.
 */
export class DrizzleSpendStore {
  constructor(
    private readonly provider: DatabaseProvider,
    private readonly query: Query,
  ) {}

  async readSpend(
    input: {
      readonly by?: SpendGrouping;
      readonly since?: string;
      readonly taskIds?: readonly string[];
      readonly objectiveIds?: readonly string[];
    } = {},
  ): Promise<SpendReport> {
    const by = input.by ?? "objective";
    if (by !== "tag" && by !== "objective" && by !== "day")
      throw new Error("by must be tag, objective, or day");
    const since = input.since === undefined ? null : parseSpendSince(input.since);
    const postgresql = this.provider === "postgresql";
    const parameters: unknown[] = [];
    const conditions: string[] = [];
    const jsonList = (values: readonly string[]) => {
      parameters.push(JSON.stringify(values));
      return postgresql
        ? `SELECT jsonb_array_elements_text($${parameters.length}::jsonb)`
        : "SELECT value FROM json_each(?)";
    };
    if (since !== null) {
      parameters.push(since);
      conditions.push(
        postgresql
          ? `a."startedAt"::timestamptz >= $${parameters.length}::timestamptz`
          : `julianday(a."startedAt") >= julianday(?)`,
      );
    }
    if (input.taskIds !== undefined) conditions.push(`a."taskId" IN (${jsonList(input.taskIds)})`);
    if (input.objectiveIds !== undefined)
      conditions.push(
        `COALESCE(q."objectiveId", t."surfaceObjectiveId") IN (${jsonList(input.objectiveIds)})`,
      );
    const rows = await this.query(
      `SELECT a."id" AS "attemptId", a."startedAt" AS "startedAt", a."workerSnapshot" AS "workerSnapshot", t."tagId" AS "tagId", tag."name" AS "tagName",
      COALESCE(q."objectiveId", t."surfaceObjectiveId") AS "objectiveId", o."budgetLimitMinor" AS "budgetLimitMinor",
      o."budgetCurrency" AS "budgetCurrency", q."activationKind" AS "activationKind",
      (SELECT e."payload" FROM "TaskEvent" e WHERE e."attemptId" = a."id" AND e."type" IN ${USAGE_TYPES}
        ORDER BY e."sequence" DESC LIMIT 1) AS "latestUsage"
      FROM "TaskAttempt" a
      JOIN "Task" t ON t."id" = a."taskId"
      LEFT JOIN "TaskAssignment" q ON q."taskId" = a."taskId"
      LEFT JOIN "Objective" o ON o."id" = COALESCE(q."objectiveId", t."surfaceObjectiveId")
      JOIN "Tag" tag ON tag."id" = t."tagId"
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY a."startedAt", a."id"`,
      parameters,
    );
    const latest = new Map<string, Usage>();
    const malformed: string[] = [];
    for (const row of rows) {
      if (row["latestUsage"] === null || row["latestUsage"] === undefined) continue;
      const usage = validUsage(row["latestUsage"]);
      if (usage !== null) latest.set(String(row["attemptId"]), usage);
      else malformed.push(String(row["attemptId"]));
    }
    // Keep validation shared with execution reports: a malformed later event must not erase the
    // latest valid usage. Only those rare Attempts read their earlier reports.
    if (malformed.length) {
      parameters.length = 0;
      const earlier = await this.query(
        `SELECT e."attemptId" AS "attemptId", e."payload" AS "payload" FROM "TaskEvent" e
        WHERE e."attemptId" IN (${jsonList(malformed)}) AND e."type" IN ${USAGE_TYPES}
        ORDER BY e."attemptId", e."sequence"`,
        parameters,
      );
      for (const row of earlier) {
        const usage = validUsage(row["payload"]);
        if (usage !== null) latest.set(String(row["attemptId"]), usage);
      }
    }
    const emptyUsage = () => ({
      attempts: 0,
      reportedCostByCurrency: {} as Record<string, number>,
      unknownCostAttempts: 0,
      estimatedCostAttempts: 0,
      unpricedModels: {} as Record<string, number>,
      unpricedTokens: 0,
      reportedTokens: null as number | null,
      unknownTokenAttempts: 0,
    });
    type UsageTotals = ReturnType<typeof emptyUsage>;
    const groups = new Map<
      string,
      UsageTotals & {
        key: string;
        name?: string;
        postTriggered: UsageTotals;
        budget?: Exclude<SpendGroup["budget"], undefined>;
      }
    >();
    for (const row of rows) {
      const key =
        by === "day"
          ? new Date(String(row["startedAt"])).toISOString().slice(0, 10)
          : by === "tag"
            ? String(row["tagId"])
            : String(row["objectiveId"] ?? "unassigned");
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          ...(by === "tag" ? { name: String(row["tagName"]) } : {}),
          ...emptyUsage(),
          postTriggered: emptyUsage(),
          ...(by === "objective"
            ? {
                budget:
                  row["budgetLimitMinor"] === null || row["budgetLimitMinor"] === undefined
                    ? null
                    : {
                        limitMinor: Number(row["budgetLimitMinor"]),
                        currency:
                          row["budgetCurrency"] === null ? null : String(row["budgetCurrency"]),
                      },
              }
            : {}),
        };
        groups.set(key, group);
      }
      const targets =
        row["activationKind"] === "team_reply" ? [group, group.postTriggered] : [group];
      for (const group of targets) {
        group.attempts += 1;
        const usage = latest.get(String(row["attemptId"]));
        let cost = usage?.reportedCost;
        let unpricedModel = usage?.unpricedModel;
        if (!cost && usage) {
          const rawSnapshot = row["workerSnapshot"];
          const snapshot = typeof rawSnapshot === "string" ? JSON.parse(rawSnapshot) : rawSnapshot;
          if (snapshot && typeof snapshot === "object") {
            const execution = (snapshot as Record<string, unknown>)["execution"];
            if (execution && typeof execution === "object") {
              const fields = execution as Record<string, unknown>;
              if (fields["harness"] === "codex" && typeof fields["model"] === "string") {
                cost = estimatedCodexCost(fields["model"], usage);
                if (!cost && /^[\w.:/-]{1,200}$/u.test(fields["model"]))
                  unpricedModel = fields["model"];
              }
            }
          }
        }
        if (cost !== undefined) {
          if (cost.estimated) group.estimatedCostAttempts += 1;
          group.reportedCostByCurrency[cost.currency] =
            (group.reportedCostByCurrency[cost.currency] ?? 0) + cost.amountMinor;
        } else {
          group.unknownCostAttempts += 1;
          const model = unpricedModel;
          if (model !== undefined) {
            group.unpricedModels[model] = (group.unpricedModels[model] ?? 0) + 1;
            group.unpricedTokens += usage?.totalTokens ?? 0;
          }
        }
        if (usage !== undefined)
          group.reportedTokens = (group.reportedTokens ?? 0) + usage.totalTokens;
        else group.unknownTokenAttempts += 1;
      }
    }
    const normalize = <T extends UsageTotals>(group: T) => ({
      ...group,
      reportedCostByCurrency:
        Object.keys(group.reportedCostByCurrency).length === 0
          ? null
          : group.reportedCostByCurrency,
    });
    return {
      by,
      since,
      groups: [...groups.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ estimatedCostAttempts, unpricedModels, ...group }) => ({
          ...group,
          postTriggered: normalize(group.postTriggered),
          ...(estimatedCostAttempts === 0 ? {} : { estimatedCostAttempts }),
          ...(Object.keys(unpricedModels).length === 0 ? {} : { unpricedModels }),
          reportedCostByCurrency:
            Object.keys(group.reportedCostByCurrency).length === 0
              ? null
              : group.reportedCostByCurrency,
        })),
    };
  }
}
