import type { TaskEvent } from "@supertag/core";
import { expect, test } from "vitest";
import { workspaceSkillPins } from "./src/workspace-skill-pins.js";

test("first Workspace Skill manifest pins later Task Attempts", () => {
  const event = (sequence: number, digest: string) =>
    ({
      sequence,
      type: "runtime-inputs.resolved",
      payload: {
        manifest: {
          inputs: [
            {
              id: "skill:review",
              kind: "skill",
              resource: {
                digest,
                provenance: { provider: "supertag-workspace", source: ".claude/skills/review" },
              },
            },
          ],
        },
      },
    }) as TaskEvent;
  const first = `sha256:${"a".repeat(64)}`;
  const later = `sha256:${"b".repeat(64)}`;
  expect(workspaceSkillPins([event(2, later), event(1, first)])).toEqual([
    { name: "review", source: ".claude/skills/review", digest: first },
  ]);
});

test("GitHub catalog commit and digest are carried to the next Task Attempt", () => {
  const source = `github:acme/skills/catalog/review@${"a".repeat(40)}`;
  const digest = `sha256:${"b".repeat(64)}`;
  const event = {
    sequence: 1,
    type: "runtime-inputs.resolved",
    payload: {
      manifest: {
        inputs: [
          {
            id: "skill:review",
            kind: "skill",
            resource: {
              digest,
              provenance: { provider: "supertag-workspace", source },
            },
          },
        ],
      },
    },
  } as TaskEvent;
  expect(workspaceSkillPins([event])).toEqual([{ name: "review", source, digest }]);
});
