import { expect, it } from "vitest";
import { describeTask } from "./src/resources.js";

const resource = {
  apiVersion: "v1",
  kind: "Task",
  metadata: { id: "task-1" },
  spec: { sessionId: "session-1" },
  status: {
    phase: "cancelled",
    assignment: { phase: "cancelled", objectiveId: "objective-1", teamId: "team-1" },
    attempt: {
      id: "attempt-1",
      phase: "running",
      workerHostId: "host-1",
      placement: { cleanup: "unknown" },
    },
  },
};

it("explains a cancelled Task's held slot and the recovery path", () => {
  const description = describeTask(resource);
  expect(description).toContain("still holds a Worker Host capacity slot");
  expect(description).toContain("Reconnect the original Worklet");
  expect(description).toContain("supertag recover worklet --confirm-stopped");
});

it("does not claim a slot is held after the Attempt closes", () => {
  const description = describeTask({
    ...resource,
    status: { ...resource.status, attempt: { ...resource.status.attempt, phase: "cancelled" } },
  });
  expect(description).not.toContain("still holds a Worker Host capacity slot");
});

it("shows prepared Workspace provenance and a provider placement refusal", () => {
  const description = describeTask({
    ...resource,
    spec: {
      ...resource.spec,
      workspace: { name: "app", branch: "supertag/o/t", delivery: "branch" },
    },
    status: {
      phase: "pending",
      preparedWorkspace: {
        provider: "e2b",
        digest: `sha256:4f1c0e2a${"0".repeat(56)}`,
        trustedCommit: `1a2b3c4${"d".repeat(33)}`,
      },
      scheduling: {
        status: "incompatible",
        observedAt: "2026-10-03T00:00:00Z",
        unmetRequirements: ["workspace.checkout-or-clone:app"],
        workspaceRefusals: ["Worker Host cloud: modal image does not support mounts"],
      },
    },
  });
  expect(description).toContain(
    "Environment: e2b, prepared sha256:4f1c0e2a, trusted commit 1a2b3c4\n",
  );
  expect(description).toContain("Workspace environment provider");
  expect(
    describeTask({
      ...resource,
      status: {
        phase: "running",
        preparedWorkspace: {
          provider: "local",
          digest: `sha256:9e8d7c6b${"0".repeat(56)}`,
          trustedCommit: `1a2b3c4${"d".repeat(33)}`,
        },
      },
    }),
  ).toContain("Environment: local, prepared per Task (sha256:9e8d7c6b), trusted commit 1a2b3c4\n");
  expect(description).toContain(
    "Workspace provider refusal: Worker Host cloud: modal image does not support mounts",
  );
});
