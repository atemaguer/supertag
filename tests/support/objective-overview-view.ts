import { create } from "@bufbuild/protobuf";
import { overviewMessage, overviewView } from "../../apps/cli/src/objective-protos.ts";
import type { ObjectiveOverview } from "../../packages/control-plane/src/index.ts";
import { ObjectiveOverviewSchema } from "../../packages/operator-api/src/index.ts";

/** The Control Plane's overview as `DescribeObjective` serves it and the CLI reads it back. */
export function describedOverview(view: ObjectiveOverview) {
  return create(
    ObjectiveOverviewSchema,
    overviewMessage(view, view.tagNames[view.objective.ownerTagId], ""),
  );
}

/** The Control Plane's overview as `supertag describe objective` shows it. */
export function overviewViewOf(view: ObjectiveOverview) {
  return overviewView(describedOverview(view));
}
