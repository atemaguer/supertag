import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSoftwareObjectiveDemo } from "./support/software-objective-demo.js";

it("delivers software through independent artifact review and revision across Workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "software-objective-test-"));
  try {
    const report = await runSoftwareObjectiveDemo({ outputDirectory: directory });
    expect(report.passed).toBe(true);
    expect(report.providerCalls).toBe(0);
    expect(report.catalogArtifacts).toHaveLength(4);
    const byTask = new Map(report.catalogArtifacts.map((artifact) => [artifact.taskId, artifact]));
    const original = byTask.get("implementation");
    const initialReview = byTask.get("review-initial");
    const revision = byTask.get("revision");
    const finalReview = byTask.get("review-final");
    expect(original?.inputs).toEqual([]);
    expect(initialReview?.inputs).toEqual([
      { artifactId: original?.id, paths: ["workspace/schedule.cjs"] },
    ]);
    expect(revision?.inputs).toEqual(
      expect.arrayContaining([
        { artifactId: original?.id, paths: ["workspace/schedule.cjs"] },
        { artifactId: initialReview?.id, paths: ["workspace/review.json"] },
      ]),
    );
    expect(finalReview?.inputs).toEqual([
      { artifactId: revision?.id, paths: ["workspace/schedule.cjs"] },
    ]);
    expect(report.reviews.find((review) => review.taskId === "revision")).toEqual({
      taskId: "revision",
      attemptId: revision?.attemptId,
      artifacts: [{ artifactId: revision?.id, paths: ["workspace/schedule.cjs"] }],
    });
    expect(report.consumed).toHaveLength(4);
    expect(report.attempts).toBeLessThanOrEqual(12);
    expect(report.finalReview.passed).toBe(true);
    expect(report.tasks.find((task) => task.id === "implementation")?.status).toBe("rejected");
    expect(report.tasks.find((task) => task.id === "revision")?.status).toBe("accepted");
    const lifecycle = JSON.parse(
      await readFile(join(directory, "environment-lifecycle.json"), "utf8"),
    );
    expect(lifecycle.environmentOutputsRemoved.every((removed: boolean) => removed)).toBe(true);
    expect(new Set(lifecycle.runs.map((run: { role: string }) => run.role))).toEqual(
      new Set(["lead", "engineer", "reviewer"]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);

it("lets the completing Attempt finish across a heartbeat while coordination stays closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "software-completion-test-"));
  try {
    const report = await runSoftwareObjectiveDemo({
      outputDirectory: directory,
      finalResponseDelayMs: 6500,
    });
    expect(report.passed).toBe(true);
    expect(report.tasks.some((task) => task.status === "failed")).toBe(false);
    const lifecycle = JSON.parse(
      await readFile(join(directory, "environment-lifecycle.json"), "utf8"),
    );
    expect(lifecycle.environmentOutputsRemoved.every((removed: boolean) => removed)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);

it("recovers the same software objective across Control Plane restarts and artifact delivery disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "software-recovery-test-"));
  try {
    const report = await runSoftwareObjectiveDemo({
      outputDirectory: directory,
      recovery: true,
      timeoutMs: 120000,
    });
    expect(report.passed).toBe(true);
    expect(report.disruptions).toEqual([
      "control_plane_restart_coordinator_waiting",
      "control_plane_restart_implementation_running",
      "worklet_disconnect_during_artifact_delivery",
    ]);
    expect(
      report.tasks
        .filter((task) =>
          ["implementation", "review-initial", "revision", "review-final"].includes(task.id),
        )
        .map((task) => task.attemptCount),
    ).toEqual([1, 1, 1, 1]);
    expect(report.tasks.find((task) => task.id === "software-demo:start")?.attemptCount).toBe(5);
    expect(report.tasks.some((task) => task.status === "failed")).toBe(false);
    expect(report.accounting).toEqual({ spentMinor: 40, reservedMinor: 0 });
    expect(report.unknownOutcomes).toEqual([]);
    expect(report.offlineDeliveryEvidence).toHaveLength(1);
    expect(report.offlineDeliveryEvidence[0]).toMatchObject({
      status: "completed",
      eventTypes: expect.arrayContaining(["artifact.created", "result", "execution.completed"]),
    });
    expect(report.executionReceipts).toHaveLength(9);
    expect(report.consumed).toHaveLength(4);
    expect(report.finalReview.passed).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 130000);
