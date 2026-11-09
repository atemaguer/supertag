import { createHash } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  ControllerPhase,
  ControlPlanePhase,
  type OrganizationService,
} from "@supertag/operator-api";
import type { OperatorQueries } from "./operator-seams.js";

export interface OrganizationServiceDependencies {
  readonly queries: Pick<OperatorQueries, "controlPlaneStatus">;
}

/** `OrganizationService`: the Control Plane's own state. */
export function organizationService(
  dependencies: OrganizationServiceDependencies,
): ServiceImpl<typeof OrganizationService> {
  return {
    async getStatus() {
      const { accepting, startedAt, controllers } = await dependencies.queries.controlPlaneStatus();
      return {
        metadata: {
          id: "control-plane",
          name: "control-plane",
          resourceVersion: createHash("sha256")
            .update(JSON.stringify({ accepting, controllers }))
            .digest("hex"),
          createdAt: timestampFromDate(new Date(startedAt)),
          updatedAt: timestampFromDate(new Date()),
        },
        phase: accepting ? ControlPlanePhase.ACCEPTING : ControlPlanePhase.DRAINING,
        controllers: controllers.map(({ name, phase }) => ({
          name,
          phase: CONTROLLER_PHASES[phase] ?? ControllerPhase.UNSPECIFIED,
        })),
      };
    },
  };
}

const CONTROLLER_PHASES: Readonly<Record<string, ControllerPhase>> = {
  running: ControllerPhase.RUNNING,
  degraded: ControllerPhase.DEGRADED,
  draining: ControllerPhase.DRAINING,
  stopped: ControllerPhase.STOPPED,
  disabled: ControllerPhase.DISABLED,
};
