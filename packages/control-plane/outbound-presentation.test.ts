import { expect, it } from "vitest";
import { objectiveReportKey, outboundPresentationPolicy } from "./src/outbound-presentation.js";

it("writes canonical delivery names and keeps reports independent of acknowledgements", () => {
  const report = objectiveReportKey("objective", "report");
  expect(report).toMatch(/^objective-report:[a-f0-9]{64}$/u);
  for (const deliveryKey of [report, "session-input-unresolved"]) {
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
