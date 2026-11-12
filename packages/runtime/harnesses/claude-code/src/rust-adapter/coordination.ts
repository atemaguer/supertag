import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  COORDINATION_SERVER,
  type CoordinationScope,
  type HarnessRun,
  type harnessClient,
  registerCoordinationTools,
  validCoordinationArguments as validArguments,
} from "@supertag/worker-sdk/internal/rust-harness";

export {
  COORDINATION_SERVER,
  WORKSTREAM_POST_ACTION,
} from "@supertag/worker-sdk/internal/rust-harness";

export const COORDINATION_PREFIX = `mcp__${COORDINATION_SERVER}__`;

export function validCoordinationArguments(name: string, input: unknown): boolean {
  return (
    name.startsWith(COORDINATION_PREFIX) &&
    validArguments(name.slice(COORDINATION_PREFIX.length), input)
  );
}

export function coordinationTools(
  bridge: ReturnType<typeof harnessClient>,
  run: Pick<HarnessRun, "task" | "mayAskObjectiveQuestion" | "coordination"> &
    Partial<Pick<HarnessRun, "mayCaptureArtifacts">>,
  scope: CoordinationScope,
) {
  const server = createSdkMcpServer({
    name: COORDINATION_SERVER,
    version: "1",
    timeout: run.mayCaptureArtifacts ? 70_000 : 16_000,
    tools: [],
  });
  const { tools, waitingApprovalIds } = registerCoordinationTools(
    server.instance,
    bridge,
    run,
    scope,
    {
      questionOperationPrefix: "claude",
      meta: { "anthropic/alwaysLoad": true },
    },
  );
  return {
    tools: tools.map((name) => `${COORDINATION_PREFIX}${name}`),
    servers: tools.length ? { [COORDINATION_SERVER]: server } : {},
    waitingApprovalIds,
  };
}
