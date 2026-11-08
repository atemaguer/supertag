/** Experimental embedding API for the persistent Control Plane service boundary. */

export type {
  ControlPlaneControllerStatus,
  ControlPlaneDependencies,
  ControlPlaneDispatchOptions,
  InboundEventHandler,
  InboundIngestResult,
  InboundRoute,
  ObjectiveOverview,
  ObjectiveOverviewInput,
  OutboundReplyHandler,
} from "../../control-plane/src/index.js";
export { ControlPlane } from "../../control-plane/src/index.js";
export type {
  CancelPendingSurfaceTaskInput,
  ClaimDueInboundEventInput,
  GatewayCredentialVault,
  OpenSurfaceTaskAttemptInput,
  SettleSurfaceAttemptInput,
  SettleSurfaceFailureInput,
  Store,
} from "../../core/src/index.js";
