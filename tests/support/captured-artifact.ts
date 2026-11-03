import { createHash, randomUUID } from "node:crypto";
import type { CapturedArtifact, TaskAttempt } from "../../packages/core/src/index.js";
import type { DrizzleStore } from "../../packages/store/src/index.js";

/** Creates a real catalog manifest against an active producer Attempt for persistence tests. */
export async function captureTestArtifact(
  store: DrizzleStore,
  taskId: string,
  options: { attempt?: TaskAttempt; path?: string; content?: string; mediaType?: string } = {},
): Promise<CapturedArtifact> {
  const task = await store.findTaskById(taskId);
  if (!task) throw new Error(`Missing producer Task ${taskId}`);
  const attempt =
    options.attempt ??
    (await store.createTaskAttempt({
      taskId,
      attemptNumber: 1,
      workerProfile: { id: "test", revision: "1" },
      workerSnapshot: {},
      startedAt: new Date().toISOString(),
    }));
  const bytes = Buffer.from(options.content ?? "reviewable output");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await store.recordArtifactUpload({
    taskId,
    attemptId: attempt.id,
    digest,
    sizeBytes: bytes.length,
  });
  const assignment = await store.getTaskAssignment(taskId);
  return store.commitCapturedArtifact({
    operationId: randomUUID(),
    taskId,
    attemptId: attempt.id,
    tagId: task.tagId,
    sessionId: task.sessionId,
    ...(assignment ? { objectiveId: assignment.objectiveId } : {}),
    title: "Test output",
    kind: "output",
    entries: [
      {
        path: options.path ?? "output.json",
        uri: `supertag-artifact:${digest}`,
        digest,
        sizeBytes: bytes.length,
        mediaType: options.mediaType ?? "application/json",
      },
    ],
  });
}
