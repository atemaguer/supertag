import { readFile } from "node:fs/promises";

export const objectiveId = "ongoing-support";
export const resource = (kind, name, spec) => ({
  apiVersion: "supertag/v1",
  kind,
  metadata: { name },
  spec,
});
export function apiClient(url, adminToken) {
  const request = async (method, path, input) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  return {
    request,
    coordinate: (name, input = {}) =>
      request("POST", `/api/v1/coordination/${name}`, { objectiveId, ...input }),
  };
}
export async function createOrganization(api) {
  await api.request(
    "POST",
    "/api/v1/permission-sets",
    resource("PermissionSet", "support-work", {
      permissions: ["files:write", "commands:execute"].map((action) => ({
        target: "runtime",
        action,
      })),
    }),
  );
  const actors = {};
  for (const name of ["manager", "analyst"]) {
    const hostId = `support-${name}-host`;
    const enrolled = await api.request("POST", "/api/v1/worker-hosts", {
      apiVersion: "supertag/v1",
      kind: "WorkerHostEnrollment",
      metadata: { id: hostId },
      spec: {},
    });
    const instructions = await readFile(new URL(`./roles/${name}.md`, import.meta.url), "utf8");
    await api.request(
      "POST",
      "/api/v1/roles",
      resource("Role", `Support ${name}`, {
        purpose:
          name === "manager"
            ? "Maintain reviewed responses to support incidents"
            : "Produce bounded, reviewable policy proposals",
        instructions,
        contextSets: [],
        permissionSets: ["support-work"],
      }),
    );
    const tag = await api.request(
      "POST",
      "/api/v1/tags",
      resource("Tag", `Support ${name}`, { roles: [`Support ${name}`], workerHosts: [hostId] }),
    );
    actors[name] = { hostId, credential: enrolled.credential.token, tagId: tag.metadata.id };
  }
  await api.request("POST", "/api/v1/tag-messaging/objectives", {
    id: objectiveId,
    ownerTagId: actors.manager.tagId,
    outcome: [
      `Maintain support responses. Team support-team, observation channel support-observations, analyst Tag ${actors.analyst.tagId}. Follow your Role, process at most two posts per page, and wait when idle.`,
      "Done when:",
      ...[
        "Every valid incident is accounted for once",
        "Only reviewed artifact bytes are applied",
        "Uncertain writes are inspected before any retry",
      ].map((criterion) => `- ${criterion}`),
    ].join("\n"),
    runtimeActions: ["files:write", "commands:execute"],
    budgetLimitMinor: 1000,
  });
  await api.coordinate("create_team", {
    id: "support-team",
    name: "Support",
    leadTagId: actors.manager.tagId,
    memberTagIds: [actors.analyst.tagId],
    maxConcurrency: 2,
  });
  // Observations arrive on this Team's channel. The administrator posts them as the Objective
  // owner, so the manager leads the Team; the analyst keeps read access as a member.
  await api.coordinate("create_team", {
    id: "support-observations",
    name: "Support observations",
    leadTagId: actors.manager.tagId,
    memberTagIds: [actors.analyst.tagId],
  });
  return actors;
}
