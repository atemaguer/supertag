import { createHash } from "node:crypto";
import { TagMessagingError } from "./mailbox.js";
import {
  MCP_TOOL_NAME,
  mcpGrantActionMatches,
  parseMcpGrantAction,
  parseMcpGrantResource,
} from "./mcp-grant.js";

/**
 * One granted action that a Permission Set marks `approval: required`, frozen into a Task's
 * authorization snapshot. `permissionSets` names every requiring set; `approvers` is the union
 * of their approvers.
 */
export type TagApprovalRequirement =
  | {
      readonly target: "surface";
      readonly surfaceAccountId: string;
      readonly scope: string;
      readonly action: string;
      readonly permissionSets: readonly string[];
      readonly approvers: readonly string[];
    }
  | {
      readonly target: "runtime";
      readonly action: string;
      readonly permissionSets: readonly string[];
      readonly approvers: readonly string[];
    }
  | {
      readonly target: "mcp";
      /** The grant's `server/tool`, where the tool part may contain `*`. */
      readonly action: string;
      /** Omitted when the requirement covers every resource. */
      readonly resource?: string;
      readonly permissionSets: readonly string[];
      readonly approvers: readonly string[];
    };

/** The action an approval request covers. `toolName` is descriptive and never part of matching. */
export interface ApprovalActionDescriptor {
  readonly target: "surface" | "runtime" | "mcp";
  /** For `mcp`, the concrete `server/tool` called, never a glob. */
  readonly action: string;
  readonly surfaceAccountId?: string;
  readonly scope?: string;
  /** For `mcp`, the resource the call's arguments name, when the server maps one. */
  readonly resource?: string;
  /** Surface provider, such as `github`, for display. */
  readonly provider?: string;
  readonly toolName?: string;
}

export type ApprovalRequestKind = "surface-action" | "task" | "plan";
export type ApprovalRequestStatus = "pending" | "approved" | "denied" | "expired";
/** Chosen by the decider: this exact request once, or every matching action in the Objective. */
export type ApprovalScope = "once" | "objective";

export interface ApprovalRequest {
  readonly id: string;
  readonly objectiveId: string | null;
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly requestingTagId: string;
  readonly kind: ApprovalRequestKind;
  readonly actions: readonly ApprovalActionDescriptor[];
  /** `sha256:` digest of the canonical JSON tool arguments for surface actions. */
  readonly argumentsDigest: string | null;
  /** Short, sanitized description of what would happen. */
  readonly summary: string;
  /** Permission Set names whose `approval: required` produced this request. */
  readonly ruleSources: readonly string[];
  readonly approvers: readonly string[];
  readonly status: ApprovalRequestStatus;
  readonly scope: ApprovalScope | null;
  readonly validUntil: string | null;
  readonly decidedBy: string | null;
  readonly decidedByKind: "operator" | "tag" | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
  readonly consumedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateApprovalRequestInput {
  readonly objectiveId: string | null;
  readonly taskId: string;
  readonly attemptId?: string | null;
  readonly requestingTagId: string;
  readonly kind: ApprovalRequestKind;
  readonly actions: readonly ApprovalActionDescriptor[];
  readonly argumentsDigest?: string | null;
  readonly summary: string;
  readonly ruleSources: readonly string[];
  readonly approvers: readonly string[];
  /**
   * For an action request: the Tasks whose requests the action matches, in place of `taskId`
   * alone. A work Session passes all of its Tasks, so a once-scope approval its Task waited on
   * covers the retried action in the Session's next Task. A new request still records `taskId`.
   */
  readonly coveringTaskIds?: readonly string[];
}

export type ActionApprovalResult =
  | {
      readonly status: "granted";
      readonly via: "objective" | "once";
      readonly request: ApprovalRequest;
    }
  | { readonly status: "pending"; readonly request: ApprovalRequest; readonly created: boolean }
  | { readonly status: "denied"; readonly request: ApprovalRequest };

export interface ApprovalRequestListFilter {
  readonly objectiveId?: string;
  readonly taskId?: string;
  readonly kind?: ApprovalRequestKind;
  readonly status?: ApprovalRequestStatus;
  /** Only requests decided at or after this instant. */
  readonly decidedAfter?: string;
  readonly limit?: number;
}

/** A Mailbox message delivered to the requesting Tag in the decision transaction. */
export interface ApprovalDecisionMessage {
  readonly senderTagId: string;
  readonly operatorId?: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface DecideApprovalRequestInput {
  readonly id: string;
  readonly decision: "approve" | "deny";
  readonly scope?: ApprovalScope;
  readonly validUntil?: string;
  readonly reason?: string;
  readonly decidedBy: string;
  readonly decidedByKind: "operator" | "tag";
  readonly message?: ApprovalDecisionMessage;
}

export interface ApprovalRequestStore {
  /**
   * Resolve one surface action use atomically: reuse an unexpired Objective-scope approval,
   * consume a matching once-scope approval, report a denial, or create or reuse a pending request.
   */
  requestActionApproval(
    input: CreateApprovalRequestInput & { readonly now?: string },
  ): Promise<ActionApprovalResult>;
  /** Unexpired approved Objective-scope request covering this action, if any. */
  findObjectiveApprovalGrant(
    objectiveId: string,
    action: ApprovalActionDescriptor,
    now?: string,
  ): Promise<ApprovalRequest | undefined>;
  /** Idempotent for `task` requests: one request per Task. */
  createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest>;
  getApprovalRequest(id: string): Promise<ApprovalRequest | undefined>;
  listApprovalRequests(filter?: ApprovalRequestListFilter): Promise<readonly ApprovalRequest[]>;
  /** Decide a pending request and deliver the optional Mailbox message in one transaction. */
  decideApprovalRequest(input: DecideApprovalRequestInput): Promise<ApprovalRequest>;
  expireApprovalRequest(id: string): Promise<ApprovalRequest | undefined>;
}

export const APPROVAL_SUMMARY_MAX_LENGTH = 500;
export const APPROVAL_REASON_MAX_LENGTH = 2000;
export const APPROVERS_MAX = 50;

/**
 * Validate `approvers` entries. Each is `operator:<operatorId>` or `tag:<Tag name or id>`;
 * duplicates are removed and order is preserved.
 */
export function normalizeApprovers(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("approvers must be a string array");
  if (value.length > APPROVERS_MAX)
    throw new Error(`approvers accepts at most ${APPROVERS_MAX} entries`);
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("approvers must be a string array");
    const parsed = parseApprover(entry);
    const normalized = `${parsed.kind}:${parsed.id}`;
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

export function parseApprover(value: string): {
  readonly kind: "operator" | "tag";
  readonly id: string;
} {
  const match = /^(operator|tag):(.+)$/u.exec(value.trim());
  const id = match?.[2]?.trim();
  if (!match || !id || id.length > 200 || /[\p{Cc}]/u.test(id))
    throw new Error(
      `Invalid approver ${JSON.stringify(value)}; use operator:<operatorId> or tag:<Tag name or id>`,
    );
  return { kind: match[1] as "operator" | "tag", id };
}

/** Whether a Tag is named by an approvers list, by id or name. */
export function approversIncludeTag(
  approvers: readonly string[],
  tag: { readonly id: string; readonly name: string },
): boolean {
  return approvers.includes(`tag:${tag.id}`) || approvers.includes(`tag:${tag.name}`);
}

/**
 * Operators decide unless the list names specific operators, in which case only those may.
 * Listing only Tags adds AI actor approvers without removing operator authority.
 */
export function approversAdmitOperator(approvers: readonly string[], operatorId: string): boolean {
  const operators = approvers.filter((entry) => entry.startsWith("operator:"));
  return operators.length === 0 || operators.includes(`operator:${operatorId}`);
}

export function approvalActionsMatch(
  left: ApprovalActionDescriptor,
  right: ApprovalActionDescriptor,
): boolean {
  if (left.target !== right.target || left.action !== right.action) return false;
  if (left.target === "runtime") return true;
  if (left.target === "mcp") return (left.resource ?? null) === (right.resource ?? null);
  return left.surfaceAccountId === right.surfaceAccountId && left.scope === right.scope;
}

/**
 * Whether an `mcp` approval requirement covers one call. A requirement limited to a resource
 * also covers a call whose resource is unknown, so an unmapped call fails closed.
 */
export function mcpApprovalRequirementCovers(
  requirement: Extract<TagApprovalRequirement, { target: "mcp" }>,
  action: Pick<ApprovalActionDescriptor, "action" | "resource">,
): boolean {
  const slash = action.action.indexOf("/");
  if (slash < 0) return false;
  return (
    mcpGrantActionMatches(
      requirement.action,
      action.action.slice(0, slash),
      action.action.slice(slash + 1),
    ) &&
    (requirement.resource === undefined ||
      action.resource === undefined ||
      requirement.resource === action.resource)
  );
}

export function approvalRequirementFor(
  requirements: readonly TagApprovalRequirement[] | undefined,
  action: ApprovalActionDescriptor,
): TagApprovalRequirement | undefined {
  if (action.target === "mcp")
    return requirements?.find(
      (requirement) =>
        requirement.target === "mcp" && mcpApprovalRequirementCovers(requirement, action),
    );
  return requirements?.find((requirement) =>
    requirement.target === "mcp"
      ? false
      : approvalActionsMatch(
          requirement.target === "runtime"
            ? { target: "runtime", action: requirement.action }
            : {
                target: "surface",
                action: requirement.action,
                surfaceAccountId: requirement.surfaceAccountId,
                scope: requirement.scope,
              },
          action,
        ),
  );
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** `sha256:` digest of canonical JSON, used to bind a once-scope approval to exact arguments. */
export function approvalArgumentsDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Remove control characters and bound length for text shown to deciders. */
export function sanitizeApprovalText(value: string, maximum = APPROVAL_SUMMARY_MAX_LENGTH): string {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 1)}…` : clean;
}

/** Parse coordination/API input for one expected action. */
export function parseApprovalActionDescriptor(value: unknown): ApprovalActionDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TagMessagingError(400, "Each action must be an object");
  const record = value as Record<string, unknown>;
  const allowed = [
    "target",
    "action",
    "surfaceAccountId",
    "scope",
    "resource",
    "provider",
    "toolName",
  ];
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TagMessagingError(400, `Unknown action field: ${unknown[0]}`);
  const text = (key: string, required: boolean): string | undefined => {
    const entry = record[key];
    if (entry === undefined && !required) return undefined;
    if (typeof entry !== "string" || !entry.trim() || entry.length > 500)
      throw new TagMessagingError(400, `Action ${key} must be bounded text`);
    return entry.trim();
  };
  const target = text("target", true);
  if (target !== "surface" && target !== "runtime" && target !== "mcp")
    throw new TagMessagingError(400, "Action target must be surface, runtime, or mcp");
  const action = text("action", true) as string;
  const provider = text("provider", false);
  const toolName = text("toolName", false);
  if (target === "mcp") {
    if (record["surfaceAccountId"] !== undefined || record["scope"] !== undefined)
      throw new TagMessagingError(400, "MCP actions do not take surfaceAccountId or scope");
    // An action names the concrete tool called; globs belong only in grants.
    let tool: string;
    try {
      tool = parseMcpGrantAction(action).tool;
    } catch (error) {
      throw new TagMessagingError(400, error instanceof Error ? error.message : String(error));
    }
    if (!MCP_TOOL_NAME.test(tool))
      throw new TagMessagingError(400, "An MCP action names one tool, without wildcards");
    const resource = text("resource", false);
    if (resource !== undefined)
      try {
        parseMcpGrantResource(resource);
      } catch (error) {
        throw new TagMessagingError(400, error instanceof Error ? error.message : String(error));
      }
    return {
      target,
      action,
      ...(resource === undefined ? {} : { resource }),
      ...(toolName ? { toolName } : {}),
    };
  }
  if (record["resource"] !== undefined)
    throw new TagMessagingError(400, "Only MCP actions take a resource");
  if (target === "runtime") {
    if (record["surfaceAccountId"] !== undefined || record["scope"] !== undefined)
      throw new TagMessagingError(400, "Runtime actions do not take surfaceAccountId or scope");
    return { target, action, ...(toolName ? { toolName } : {}) };
  }
  return {
    target,
    action,
    surfaceAccountId: text("surfaceAccountId", true) as string,
    scope: text("scope", true) as string,
    ...(provider ? { provider } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

/**
 * Collect `approval: required` permissions into snapshot requirements. Any requiring set wins
 * over sets that grant the same action without approval; approvers are unioned.
 */
export function approvalRequirementsFromPermissions(
  sets: readonly {
    readonly id: string;
    readonly name: string;
    readonly approvers?: readonly string[];
  }[],
  permissions: readonly {
    readonly permissionSetId: string;
    readonly target: "surface" | "runtime" | "mcp";
    readonly action: string;
    readonly approval?: "required";
    readonly surfaceAccountId?: string;
    readonly scope?: string;
    readonly resource?: string;
  }[],
): TagApprovalRequirement[] {
  const byId = new Map(sets.map((set) => [set.id, set]));
  const collected = new Map<
    string,
    { requirement: TagApprovalRequirement; sets: Set<string>; approvers: Set<string> }
  >();
  for (const permission of permissions) {
    if (permission.approval !== "required") continue;
    const set = byId.get(permission.permissionSetId);
    if (!set) continue;
    const surface = permission.target === "surface";
    const key =
      permission.target === "mcp"
        ? JSON.stringify(["mcp", permission.action, permission.resource ?? null])
        : surface
          ? JSON.stringify([
              "surface",
              permission.surfaceAccountId,
              permission.scope,
              permission.action,
            ])
          : JSON.stringify(["runtime", permission.action]);
    const entry = collected.get(key) ?? {
      requirement:
        permission.target === "mcp"
          ? {
              target: "mcp" as const,
              action: permission.action,
              ...(permission.resource === undefined ? {} : { resource: permission.resource }),
              permissionSets: [],
              approvers: [],
            }
          : surface
            ? {
                target: "surface" as const,
                surfaceAccountId: String(permission.surfaceAccountId),
                scope: String(permission.scope),
                action: permission.action,
                permissionSets: [],
                approvers: [],
              }
            : {
                target: "runtime" as const,
                action: permission.action,
                permissionSets: [],
                approvers: [],
              },
      sets: new Set<string>(),
      approvers: new Set<string>(),
    };
    entry.sets.add(set.name);
    for (const approver of set.approvers ?? []) entry.approvers.add(approver);
    collected.set(key, entry);
  }
  return [...collected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => ({
      ...entry.requirement,
      permissionSets: [...entry.sets].sort(),
      approvers: [...entry.approvers].sort(),
    }));
}

/**
 * Combine a Task's own approval requirements with the runtime requirements of the authority it
 * inherits runtime actions from, such as its delegating Task. An inherited action keeps the
 * approval its source required: Permission Sets and approvers are unioned per action. Surface and
 * MCP requirements are not inherited; they belong to the assignee's own grants.
 */
export function mergeApprovalRequirements(
  own: readonly TagApprovalRequirement[] | undefined,
  inherited: readonly TagApprovalRequirement[] | undefined,
): readonly TagApprovalRequirement[] | undefined {
  const runtime = (inherited ?? []).filter((requirement) => requirement.target === "runtime");
  if (runtime.length === 0) return own;
  const key = (requirement: TagApprovalRequirement) =>
    requirement.target === "surface"
      ? JSON.stringify([
          "surface",
          requirement.surfaceAccountId,
          requirement.scope,
          requirement.action,
        ])
      : requirement.target === "mcp"
        ? JSON.stringify(["mcp", requirement.action, requirement.resource ?? null])
        : JSON.stringify(["runtime", requirement.action]);
  const merged = new Map<string, TagApprovalRequirement>();
  for (const requirement of [...(own ?? []), ...runtime]) {
    const existing = merged.get(key(requirement));
    merged.set(
      key(requirement),
      existing
        ? {
            ...existing,
            permissionSets: [
              ...new Set([...existing.permissionSets, ...requirement.permissionSets]),
            ].sort(),
            approvers: [...new Set([...existing.approvers, ...requirement.approvers])].sort(),
          }
        : requirement,
    );
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, requirement]) => requirement);
}

/** Keep runtime requirements only for runtime actions the Task was finally granted. */
export function restrictApprovalRequirements(
  approvals: readonly TagApprovalRequirement[] | undefined,
  runtimeActions: readonly string[],
): { readonly approvals?: readonly TagApprovalRequirement[] } {
  const kept = (approvals ?? []).filter(
    (requirement) =>
      requirement.target !== "runtime" || runtimeActions.includes(requirement.action),
  );
  return kept.length ? { approvals: kept } : {};
}

export function describeApprovalAction(action: ApprovalActionDescriptor): string {
  if (action.target === "runtime") return `runtime ${action.action}`;
  if (action.target === "mcp")
    return `MCP ${action.action}${action.resource === undefined ? "" : ` on ${action.resource}`}`;
  return `${action.provider ?? "surface"} ${action.action} on ${action.scope} (account ${action.surfaceAccountId})`;
}
