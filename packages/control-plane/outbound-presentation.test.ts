import { expect, it } from "vitest";
import {
  objectiveReportKey,
  outboundPresentationPolicy,
  taskApprovalKey,
} from "./src/outbound-presentation.js";

it("writes canonical delivery names and keeps reports independent of acknowledgements", () => {
  const report = objectiveReportKey("objective", "report");
  const approval = taskApprovalKey("task");
  expect(report).toMatch(/^objective-report:[a-f0-9]{64}$/u);
  expect(approval).toMatch(/^task-approval:[a-f0-9]{64}$/u);
  for (const deliveryKey of [report, approval, "session-input-unresolved"]) {
    expect(outboundPresentationPolicy({ deliveryKey, presentation: "status" })).toEqual({
      useAcknowledgement: false,
      waitForAcknowledgement: false,
    });
  }
  expect(outboundPresentationPolicy({ deliveryKey: "status", presentation: "status" })).toEqual({
    useAcknowledgement: true,
    waitForAcknowledgement: true,
  });
});
