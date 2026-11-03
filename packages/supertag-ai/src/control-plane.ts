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
export { TagMailboxService } from "../../control-plane/src/mailbox.js";
export { ObjectiveController } from "../../control-plane/src/objective-controller.js";
export type {
  CancelPendingSurfaceTaskInput,
  ClaimDueInboundEventInput,
  GatewayCredentialVault,
  OpenSurfaceTaskAttemptInput,
  SettleSurfaceAttemptInput,
  SettleSurfaceFailureInput,
  Store,
} from "../../core/src/index.js";
