import { readFile } from "node:fs/promises";

export const objectiveId = "ongoing-support";
export const teamId = "support-team";
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
  /** Calls an operator RPC over the Connect protocol with a JSON body. */
  const rpc = (service, method, input) =>
    request("POST", `/supertag.operator.v1.${service}/${method}`, input);
  return {
    request,
    rpc,
    /** Delivers an operator message to the Objective's conversation. */
    message: (text, idempotencyKey) =>
      rpc("ObjectiveService", "MessageObjective", { id: objectiveId, text, idempotencyKey }),
    overview: (pageSize = 100) =>
      rpc("ObjectiveService", "DescribeObjective", { id: objectiveId, pageSize }),
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
  // One flat Team: the manager owns the Objective and may give work Sessions to the analyst.
  await api.request("POST", "/api/v1/tag-messaging/teams", {
    id: teamId,
    name: "Support",
    memberTagIds: [actors.manager.tagId, actors.analyst.tagId],
    maxConcurrency: 2,
  });
  for (const [senderTagId, recipientTagId] of [
    [actors.manager.tagId, actors.analyst.tagId],
    [actors.analyst.tagId, actors.manager.tagId],
  ])
    await api.request("PUT", "/api/v1/tag-messaging/grants", { senderTagId, recipientTagId });
  // Creating the Objective starts its conversation; it is ongoing, so it rests between messages.
  await api.rpc("ObjectiveService", "CreateObjective", {
    id: objectiveId,
    owner: "Support manager",
    team: teamId,
    ongoing: true,
    outcome: [
      `Maintain support responses. Incident reports arrive as operator messages in this conversation. Team ${teamId}; give proposal work to analyst Tag ${actors.analyst.tagId}. Follow your Role.`,
      "Done when:",
      ...[
        "Every valid incident is accounted for once",
        "Only reviewed artifact bytes are applied",
        "Uncertain writes are inspected before any retry",
      ].map((criterion) => `- ${criterion}`),
    ].join("\n"),
    runtimeActions: ["files:write", "commands:execute"],
    budget: { limitMinor: 1000 },
  });
  return actors;
}
