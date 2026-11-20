/**
 * `@supertag/client/node`: Gateway connections in a Node.js (or Bun) process: `GatewayState`
 * with its sessions, Watch and follows, the conversation cache on disk, the saved Gateways store,
 * and the local Gateway through `supertag __local-gateway`. Credentials stay in this process.
 */
export * from "./cache";
export * from "./cli-store";
export { operationId, sessionBranch } from "./coordination";
export * from "./endpoint";
export * from "./errors";
export * from "./harness-memory";
export * from "./local";
export * from "./local-services";
export * from "./profiles";
export * from "./review";
export {
  Code,
  ConnectError,
  createGatewayClient,
  type GatewayClient,
  PROTOCOL_VERSIONS,
  ProtocolMismatchError,
} from "./sdk";
export * from "./session";
export * from "./state";
export * as taskFiles from "./task-files";
