export function exampleMcpInputs({ actor, taskId, attemptId, token }) {
  return ["stdio", "http"].map((transport) => ({
    id: `example-${transport}`,
    kind: "tool",
    required: true,
    audience: "manager",
    capability: {
      id: `example-${transport}`,
      provider: "example-notes",
      operations: [
        {
          name: "exchange",
          effect: "write",
          actions: ["notes:write"],
          resourceArgumentPolicies: [
            { match: "scope", prefix: "collection:", components: [{ arguments: ["collection"] }] },
          ],
        },
      ],
      authorization: {
        provider: "example-notes",
        resources: [{ surfaceAccountId: "example", scope: "collection:docs" }],
      },
    },
    binding:
      transport === "stdio"
        ? {
            kind: "mcp-stdio",
            name: "example_stdio",
            command: "node",
            args: ["/app/mcp-fixture.cjs"],
            runtimeEnvironment: {
              MCP_FIXTURE_TOKEN: token,
              MCP_ACTOR: actor,
              MCP_TASK: taskId,
              MCP_ATTEMPT: attemptId,
            },
          }
        : {
            kind: "mcp-http",
            name: "example_http",
            url: "http://127.0.0.1:8799/mcp",
            runtimeHeaders: {
              Authorization: `Bearer ${token}`,
              "X-Example-Actor": actor,
              "X-Example-Task": taskId,
              "X-Example-Attempt": attemptId,
            },
          },
  }));
}
