import { harnessClient, readBootstrap } from "../../runtime/sdk/src/rust-harness/client.js";

export { Code, ConnectError } from "@connectrpc/connect";
export { receipt } from "../../runtime/sdk/src/rust-harness/client.js";
export {
  ExecutionLimitEnforcement,
  LiveInputReceipt,
  ObjectiveSignal,
  TaskState,
} from "../../runtime/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb.js";

/** Read one execution bootstrap from the Worker Host and connect to its private service. */
export async function openHarness(input: AsyncIterable<Uint8Array>): Promise<HarnessConnection> {
  const bootstrap = await readBootstrap(input);
  const { options: _options, ...connection } = harnessClient(bootstrap.endpoint, bootstrap.token);
  return connection;
}

export type HarnessConnection = Omit<ReturnType<typeof harnessClient>, "options">;
