import { unsandboxedCommandHoldsOf, unsandboxedCommandsReason } from "./command-sandbox.js";
import { mcpServerOfLabel } from "./worker-host-label.js";

/**
 * One line saying why a Task waits for placement, from the payload of its latest
 * `task.scheduling-incompatible` event, such as "no bound Worker Host provides MCP server notes".
 * Undefined when the payload names no requirement.
 */
export function placementHoldReason(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const logins = Array.isArray(payload?.["mcpLogins"])
    ? payload["mcpLogins"].filter((server): server is string => typeof server === "string")
    : [];
  if (logins.length > 0)
    return `MCP server ${logins.join(", ")} needs a login on its Worker Host (supertag mcp login ${logins[0]})`;
  const held = unsandboxedCommandHoldsOf(payload);
  if (held.length > 0) return held.map(unsandboxedCommandsReason).join(" ").replace(/\.$/u, "");
  const refusals = Array.isArray(payload?.["workspaceRefusals"])
    ? payload["workspaceRefusals"].filter((reason): reason is string => typeof reason === "string")
    : [];
  if (refusals.length > 0) return refusals.join("; ");
  const requirements = Array.isArray(payload?.["unmetRequirements"])
    ? payload["unmetRequirements"].filter((item): item is string => typeof item === "string")
    : [];
  const reasons = requirements.map(requirementReason);
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

function requirementReason(requirement: string): string {
  if (requirement === "tag.workerHostBindings") return "the Tag has no Worker Host binding";
  if (requirement.startsWith("labels:")) {
    const labels = requirement.slice("labels:".length).split(",");
    const servers = labels.flatMap((label) => mcpServerOfLabel(label) ?? []);
    const others = labels.filter((label) => mcpServerOfLabel(label) === undefined);
    return [
      ...(servers.length === 0
        ? []
        : [
            `no bound Worker Host provides MCP server${servers.length === 1 ? "" : "s"} ${servers.join(", ")}`,
          ]),
      ...(others.length === 0 ? [] : [`no bound Worker Host has labels ${others.join(", ")}`]),
    ].join("; ");
  }
  if (requirement.startsWith("workspace.checkout-or-clone:"))
    return `no bound Worker Host can check out or clone Workspace ${requirement.slice("workspace.checkout-or-clone:".length)}`;
  return `no bound Worker Host meets ${requirement}`;
}
