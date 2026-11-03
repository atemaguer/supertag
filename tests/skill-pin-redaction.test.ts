import type { TaskEvent } from "@supertag/core";
import { expect, it } from "vitest";
import { workspaceSkillPins } from "../packages/control-plane/src/workspace-skill-pins.js";
import { redactEventDiagnostics } from "../packages/runtime/sdk/src/event-redaction.js";
import {
  collectTaskAttemptEvents,
  createWorker,
  type TaskAttemptEvent,
} from "../packages/runtime/sdk/src/index.js";
import { redactText } from "../packages/runtime/sdk/src/redaction.js";
import { repositoryAttempt } from "./support/repository-execution.js";

// The control plane reads Skill pins back from the stored runtime-inputs.resolved event and
// sends them as the next Attempt's expected sources. Stored sources must not expose credentials.
it("redacts high-confidence credentials in stored Workspace Skill pins", () => {
  const source = ".claude/skills/release-tools";
  const digest = `sha256:${"a".repeat(64)}`;
  const event = {
    type: "runtime-inputs.resolved",
    taskId: "task-1",
    attemptId: "attempt-1",
    at: "2026-10-06T00:00:00.000Z",
    manifest: {
      workerProfile: { id: "profile", revision: "1" },
      harness: { id: "codex", version: "1" },
      executionEnvironment: { id: "local", provider: "local", placement: "local" },
      inputs: [
        {
          id: "skill:release-tools",
          kind: "skill",
          resource: {
            digest,
            provenance: { provider: "supertag-workspace", source, description: "release-tools" },
          },
        },
      ],
      omitted: [],
    },
  } as unknown as TaskAttemptEvent;
  // A host credential that happens to equal the Skill's directory name.
  const stored = redactEventDiagnostics(event, (text, structural) =>
    redactText(text, ["release-tools", "supertag-workspace", digest], structural),
  );
  expect(stored).toMatchObject({
    manifest: {
      inputs: [{ resource: { provenance: { description: "[REDACTED]" } } }],
    },
  });
  expect(event).toMatchObject({
    manifest: { inputs: [{ resource: { provenance: { description: "release-tools" } } }] },
  });
  const pins = workspaceSkillPins([
    {
      type: "runtime-inputs.resolved",
      sequence: 1,
      payload: {
        manifest: (stored as Extract<TaskAttemptEvent, { type: "runtime-inputs.resolved" }>)
          .manifest,
      },
    } as unknown as TaskEvent,
  ]);
  expect(pins).toBeUndefined();
});

// The Worker stores the same sanitized manifest without rewriting the Skill input.
it("redacts stored Workspace Skill sources while preserving execution inputs", async () => {
  const source = ".claude/skills/release-tools";
  const digest = `sha256:${"b".repeat(64)}`;
  const worker = createWorker({
    id: "worker",
    // A host credential that happens to equal the Skill's directory name.
    redactValues: ["release-tools"],
    profiles: [
      {
        ref: { id: "skills", revision: "1" },
        workerType: "test",
        harness: { provider: "skills" },
        execution: { provider: "test", lifetime: { scope: "attempt" } },
      },
    ],
    harnesses: [
      {
        id: "skills",
        describe: async () => ({
          sessions: { resume: false, export: false, scope: "none" as const },
          id: "skills",
          version: "1",
          inputKinds: ["instruction", "skill", "history"],
          streaming: true,
          cancellation: true,
          sessionPersistence: "none",
        }),
        plan: async () => ({ runtime: emptyPlan(), execution: emptyPlan() }),
        start: async (_plan, _runtime, context) => {
          expect(context.context.skills).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "skill:release-tools",
                source: expect.objectContaining({ uri: `file:///workspace/${source}` }),
              }),
            ]),
          );
          return {
            run: async function* () {
              yield { type: "output.message" as const, text: "finished" };
            },
            close: async () => {},
          };
        },
      },
    ],
    runtimeInputProviders: [
      {
        id: "workspace-skills",
        scope: "custom",
        resolve: async () => [
          {
            id: "skill:release-tools",
            kind: "skill" as const,
            required: true,
            source: {
              uri: `file:///workspace/${source}`,
              digest,
              provenance: { provider: "supertag-workspace", source, description: "release-tools" },
            },
          },
        ],
      },
    ],
    environments: [
      {
        id: "test",
        capabilities: [],
        provision: async () => ({
          id: "test",
          placement: "local",
          rootDirectory: "/test",
          prepare: async () => {},
          read: async () => "",
          resolvePath: (value: string) => value,
          spawn: async () => {
            throw new Error("unused");
          },
          dispose: async () => {},
        }),
      },
    ],
  });
  const events = await collectTaskAttemptEvents(
    worker.execute({
      ...repositoryAttempt("skills"),
      workerProfile: { id: "skills", revision: "1" },
    }),
  );
  const manifest = events.find((event) => event.type === "runtime-inputs.resolved");
  expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("execution.completed");
  // Fields outside the pin are still redacted.
  expect(manifest).toMatchObject({
    manifest: {
      inputs: [
        { id: "supertag-scratch-directory" },
        { resource: { provenance: { description: "[REDACTED]" } } },
      ],
    },
  });
  const pins = workspaceSkillPins([
    {
      type: "runtime-inputs.resolved",
      sequence: 1,
      payload: {
        manifest: (manifest as Extract<TaskAttemptEvent, { type: "runtime-inputs.resolved" }>)
          .manifest,
      },
    } as unknown as TaskEvent,
  ]);
  expect(pins).toEqual([{ name: "[REDACTED]", source: ".claude/skills/[REDACTED]", digest }]);
});

function emptyPlan() {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" as const },
  };
}
