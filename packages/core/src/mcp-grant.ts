import { mcpServerLabel } from "./worker-host-label.js";

/**
 * Permission Set grants for MCP server tools: `{ target: mcp, action: "server/tool" }`.
 *
 * The server part names one MCP server exactly, as a host service or Workspace declares it.
 * The tool part is an exact tool name or a glob in which `*` matches any run of characters.
 * Matching is exact and case-sensitive: `sentry/Get_Issue` never matches `sentry/get_issue`.
 * An optional `resource`, such as `repository:acme/api`, limits the grant to calls whose
 * arguments name that resource through the server's resource mapping.
 */

/** Server names: lowercase letters, digits, hyphens, and underscores, so `mcp:NAME` is a label. */
export const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,58}$/u;

/** Tool names SuperTag exposes: the MCP specification's characters, 1-128 of them. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;

const TOOL_PATTERN = /^[A-Za-z0-9_.*-]{1,128}$/u;

/** `kind:value`, printable ASCII without spaces or `*`, such as `repository:acme/api`. */
const RESOURCE = /^[a-z][a-z0-9-]{0,39}:[\x21-\x29\x2b-\x7e]{1,400}$/u;

/** Server names SuperTag reserves for its own tools. */
export function isReservedMcpServerName(name: string): boolean {
  return name.startsWith("supertag");
}

/** One `target: mcp` grant frozen into a Task's authorization snapshot. */
export interface TagMcpGrant {
  /** `server/tool`, where the tool part may contain `*`. */
  readonly action: string;
  /** A resource the call's arguments must name, when the server has a resource mapping. */
  readonly resource?: string;
}

export interface McpGrantAction {
  readonly server: string;
  /** Exact tool name or glob. */
  readonly tool: string;
}

/** Parse and validate `server/tool`. Throws an Error naming what is wrong. */
export function parseMcpGrantAction(action: string): McpGrantAction {
  const slash = action.indexOf("/");
  if (slash < 0 || action.indexOf("/", slash + 1) >= 0)
    throw new Error(
      `MCP permission action ${JSON.stringify(action)} must be server/tool, such as sentry/get_issue or notion/*`,
    );
  const server = action.slice(0, slash);
  const tool = action.slice(slash + 1);
  if (!MCP_SERVER_NAME.test(server))
    throw new Error(
      `MCP permission action ${JSON.stringify(action)} must start with an exact server name: lowercase letters, digits, hyphens, or underscores`,
    );
  if (isReservedMcpServerName(server))
    throw new Error(`MCP server names starting with supertag are reserved`);
  if (!TOOL_PATTERN.test(tool))
    throw new Error(
      `MCP permission action ${JSON.stringify(action)} must name a tool with letters, digits, _, -, ., or * as a wildcard`,
    );
  return { server, tool };
}

/** Validate an MCP grant resource such as `repository:acme/api`. Throws when invalid. */
export function parseMcpGrantResource(resource: string): string {
  if (!RESOURCE.test(resource))
    throw new Error(
      `MCP permission resource ${JSON.stringify(resource)} must be kind:value without spaces or *, such as repository:acme/api`,
    );
  return resource;
}

/** Whether a tool glob matches a tool name. `*` matches any run of characters, even none. */
export function mcpToolPatternMatches(pattern: string, tool: string): boolean {
  if (!TOOL_PATTERN.test(pattern) || !MCP_TOOL_NAME.test(tool)) return false;
  // Iterative wildcard matching; no regular expression is built from the pattern.
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < tool.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === tool[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** Whether `server/tool` grant action covers one concrete tool of one server. */
export function mcpGrantActionMatches(action: string, server: string, tool: string): boolean {
  let parsed: McpGrantAction;
  try {
    parsed = parseMcpGrantAction(action);
  } catch {
    return false;
  }
  return parsed.server === server && mcpToolPatternMatches(parsed.tool, tool);
}

/** The grants that cover one concrete tool. */
export function mcpGrantsFor(
  grants: readonly TagMcpGrant[] | undefined,
  server: string,
  tool: string,
): readonly TagMcpGrant[] {
  return (grants ?? []).filter((grant) => mcpGrantActionMatches(grant.action, server, tool));
}

/** The MCP servers a Task's grants need, sorted. */
export function mcpServersOfGrants(grants: readonly TagMcpGrant[] | undefined): string[] {
  const servers = new Set<string>();
  for (const grant of grants ?? []) {
    const slash = grant.action.indexOf("/");
    if (slash > 0) servers.add(grant.action.slice(0, slash));
  }
  return [...servers].sort();
}

/** The `mcp:NAME` labels a host must carry to run a Task with these grants. */
export function mcpPlacementLabels(grants: readonly TagMcpGrant[] | undefined): string[] {
  return mcpServersOfGrants(grants).map(mcpServerLabel);
}

/** Sorted, de-duplicated grants from stored permissions. */
export function mcpGrantsFromPermissions(
  permissions: readonly {
    readonly target: string;
    readonly action: string;
    readonly resource?: string;
  }[],
): TagMcpGrant[] {
  const grants = new Map<string, TagMcpGrant>();
  for (const permission of permissions) {
    if (permission.target !== "mcp") continue;
    const grant: TagMcpGrant = {
      action: permission.action,
      ...(permission.resource === undefined ? {} : { resource: permission.resource }),
    };
    grants.set(JSON.stringify([grant.action, grant.resource ?? null]), grant);
  }
  // Code-unit order, so the frozen snapshot does not depend on the host's locale.
  const order = (grant: TagMcpGrant) => `${grant.action}\u0000${grant.resource ?? ""}`;
  return [...grants.values()].sort((left, right) =>
    order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0,
  );
}
