import {
  COORDINATION_SERVER,
  type CoordinationScope,
  type HarnessRun,
  type harnessClient,
  startCoordinationHttp,
} from "@supertag/worker-sdk/internal/rust-harness";

export async function startCoordination(
  bridge: ReturnType<typeof harnessClient>,
  run: HarnessRun,
  scope: CoordinationScope,
) {
  const { server, waitingApprovalIds, close } = await startCoordinationHttp(
    bridge,
    run,
    scope,
    "opencode",
  );
  return {
    tools: server
      ? [
          {
            name: COORDINATION_SERVER,
            url: server.url,
            headers: server.headers,
            operations: server.toolNames,
            audience: "manager" as const,
          },
        ]
      : [],
    waitingApprovalIds,
    close,
  };
}
