import { expect, it } from "vitest";
import { describeTask } from "./src/resources.js";

const base = {
  apiVersion: "v1",
  kind: "Task",
  metadata: { id: "task-1" },
  spec: {},
};

for (const status of ["complete", "partial", "refused"] as const) {
  it(`shows ${status} mount writes with uploaded files and failure details`, () => {
    const output = describeTask({
      ...base,
      status: {
        phase: "completed",
        attempts: [
          {
            id: "attempt-1",
            number: 1,
            phase: "completed",
            startedAt: "2026-01-01T00:00:00Z",
            mountOutputManifests: [
              {
                volume: "reports",
                path: "/mnt/reports",
                status,
                skipped: 2,
                objects:
                  status === "refused" ? [] : [{ key: "a.txt", size: 4, sha256: "a".repeat(64) }],
                ...(status === "complete"
                  ? {}
                  : { error: { key: "b.txt", reason: "upload failed" } }),
                notAttempted: status === "complete" ? [] : ["b.txt"],
              },
            ],
          },
        ],
      },
    });
    expect(output).toContain("Writes (Attempt 1):");
    expect(output).toContain(`reports  /mnt/reports  ${status}`);
    expect(output).toContain("2 skipped");
    if (status !== "refused") expect(output).toContain(`sha256 ${"a".repeat(64)}`);
    if (status !== "complete") {
      expect(output).toContain("error b.txt: upload failed");
      expect(output).toContain("notAttempted: b.txt");
    }
  });
}
