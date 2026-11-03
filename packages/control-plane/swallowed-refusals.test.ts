import { TagMessagingError } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { ObjectiveController } from "./src/objective-controller.js";

type Subject = { taskId: string } | { objectiveId: string };
interface SwallowedInternals {
  reportSwallowed(error: unknown, subject: Subject): void;
  clearSwallowed(subject: Subject): void;
  swallowedRefusals: Map<string, Set<string>>;
}

function setup() {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const controller = new ObjectiveController(
    {} as never,
    undefined,
    (error) => errors.push(error),
    undefined,
    { warn: (message) => warnings.push(message) },
  );
  return { warnings, errors, internals: controller as unknown as SwallowedInternals };
}

describe("background-loop refusals", () => {
  it("logs each refusal at warn level once per subject and reason", () => {
    const { warnings, errors, internals } = setup();
    const refused = new TagMessagingError(409, "Resume refused");
    internals.reportSwallowed(refused, { taskId: "o:owner" });
    internals.reportSwallowed(new TagMessagingError(409, "Resume refused"), { taskId: "o:owner" });
    internals.reportSwallowed(refused, { taskId: "o:other" });
    internals.reportSwallowed(new TagMessagingError(403, "Paused"), { taskId: "o:owner" });
    internals.reportSwallowed(refused, { objectiveId: "o" });
    expect(warnings).toEqual([
      "Background work for Task o:owner was refused (409): Resume refused",
      "Background work for Task o:other was refused (409): Resume refused",
      "Background work for Task o:owner was refused (403): Paused",
      "Background work for Objective o was refused (409): Resume refused",
    ]);
    const unexpected = new Error("boom");
    internals.reportSwallowed(unexpected, { taskId: "o:owner" });
    expect(errors).toEqual([unexpected]);
  });

  it("drops a subject's entries once its work succeeds, so a later refusal logs again", () => {
    const { warnings, internals } = setup();
    const refused = new TagMessagingError(409, "Resume refused");
    internals.reportSwallowed(refused, { taskId: "o:owner" });
    internals.clearSwallowed({ taskId: "o:owner" });
    expect(internals.swallowedRefusals.size).toBe(0);
    internals.reportSwallowed(refused, { taskId: "o:owner" });
    expect(warnings).toHaveLength(2);
  });

  it("bounds the remembered subjects and reasons", () => {
    const { internals } = setup();
    for (let index = 0; index < 2000; index += 1) {
      internals.reportSwallowed(new TagMessagingError(409, "Refused"), { taskId: `o:${index}` });
    }
    expect(internals.swallowedRefusals.size).toBe(1024);
    expect(internals.swallowedRefusals.has("Task o:0")).toBe(false);
    expect(internals.swallowedRefusals.has("Task o:1999")).toBe(true);
    for (let index = 0; index < 50; index += 1) {
      internals.reportSwallowed(new TagMessagingError(409, `Reason ${index}`), { taskId: "o:x" });
    }
    expect(internals.swallowedRefusals.get("Task o:x")?.size).toBe(8);
  });
});
