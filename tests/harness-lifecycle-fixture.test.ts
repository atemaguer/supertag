import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { validateTaskAttemptEvents } from "../packages/runtime/sdk/src/conformance.js";
import type { TaskAttemptEvent } from "../packages/runtime/sdk/src/index.js";
import { repositoryAttempt } from "./support/repository-execution.js";

it("validates the shared language-neutral Harness lifecycle examples", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../spec/fixtures/harness-lifecycle.json", import.meta.url), "utf8"),
  ) as {
    attempt: { taskId: string; attemptId: string };
    cases: Array<{ name: string; valid: boolean; events: TaskAttemptEvent[] }>;
  };
  for (const example of fixture.cases)
    expect(
      validateTaskAttemptEvents(example.events, {
        ...repositoryAttempt("fixture"),
        ...fixture.attempt,
      }).passed,
      example.name,
    ).toBe(example.valid);
});
