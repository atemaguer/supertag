import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import { fakeWorkRpc } from "./support/fake-work-rpc.ts";

const serveTask = (view: Record<string, unknown>) => fakeWorkRpc([view]);

afterEach(() => vi.restoreAllMocks());

it("does not present a prior Attempt's wait conditions as a resumed Attempt's current wait", async () => {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
  serveTask({
    apiVersion: "supertag/v1",
    kind: "Task",
    metadata: { id: "resumed" },
    spec: { tagId: "manager", sessionId: "session" },
    status: {
      phase: "running",
      assignment: {
        objectiveId: "objective",
        teamId: "team",
        phase: "running",
        priority: "normal",
        attemptCount: 2,
        wait: { attemptCount: 1, acceptedTaskIds: ["already-accepted"], mailbox: true },
      },
      attempt: { id: "attempt-2", phase: "running" },
    },
  });
  const result = await runResourceCommand(client, "describe", ["task", "resumed"]);
  expect(result).toContain("Latest Attempt: attempt-2 (running)");
  expect(result).not.toContain("Recorded wait conditions");
  expect(result).not.toContain("already-accepted");
});

it("lists each Task Attempt with its provider-reported cost", async () => {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
  serveTask({
    apiVersion: "supertag/v1",
    kind: "Task",
    metadata: { id: "objective:start" },
    spec: { tagId: "owner", sessionId: "assignment:objective:start" },
    status: {
      phase: "running",
      attempt: { id: "attempt-3", phase: "running" },
      attempts: [
        {
          id: "attempt-1",
          number: 1,
          phase: "cancelled",
          startedAt: "2026-10-01T10:00:00.000Z",
          endedAt: "2026-10-01T10:05:00.000Z",
          reportedCost: { amountMinor: 150, currency: "USD" },
        },
        {
          id: "attempt-2",
          number: 2,
          phase: "cancelled",
          startedAt: "2026-10-01T11:00:00.000Z",
          endedAt: "2026-10-01T11:04:00.000Z",
          reportedCost: { amountMinor: 162, currency: "USD", estimated: true },
        },
        {
          id: "attempt-3",
          number: 3,
          phase: "running",
          startedAt: "2026-10-01T12:00:00.000Z",
          endedAt: null,
          reportedCost: null,
        },
      ],
    },
  });
  const result = await runResourceCommand(client, "describe", ["task", "objective:start"]);
  expect(result).toContain("Task Attempts (3, $3.12 reported, 1 without a reported cost):");
  expect(result).toContain("  1. attempt-1 cancelled, started 2026-10-01T10:00:00.000Z, $1.50");
  expect(result).toContain(
    "  2. attempt-2 cancelled, started 2026-10-01T11:00:00.000Z, $1.62 (estimated)",
  );
  expect(result).toContain(
    "  3. attempt-3 running, started 2026-10-01T12:00:00.000Z, cost not reported",
  );
});

it.each(["unknown", "confirmed"])(
  "describes cancelled Task cleanup %s conservatively",
  async (cleanup) => {
    const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
    serveTask({
      kind: "Task",
      metadata: { id: "cancelled" },
      spec: {},
      status: {
        phase: "cancelled",
        attempt: { id: "a", phase: "cancelled", placement: { cleanup } },
      },
    });
    const result = await runResourceCommand(client, "describe", ["task", "cancelled"]);
    expect(result.includes("Cancellation is recorded, but execution cleanup is unconfirmed")).toBe(
      cleanup === "unknown",
    );
  },
);

it("shows the running command as plain, truncated text with its elapsed time", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-03T03:00:00.000Z"), toFake: ["Date"] });
  try {
    const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
    const describeWith = async (attempt: Record<string, unknown>) => {
      serveTask({
        apiVersion: "supertag/v1",
        kind: "Task",
        metadata: { id: "build" },
        spec: { tagId: "builder", sessionId: "session" },
        status: { phase: "running", attempt },
      });
      return runResourceCommand(client, "describe", ["task", "build"]);
    };
    const running = await describeWith({
      id: "attempt-1",
      phase: "running",
      runningCommand: { command: "pnpm test:verify", startedAt: "2026-10-03T02:36:00.000Z" },
    });
    expect(running).toContain("Command: running `pnpm test:verify` for 24m");

    const hostile = await describeWith({
      id: "attempt-1",
      phase: "running",
      runningCommand: {
        command: `\x1b]0;pwned\x07\x1b[31mecho\x1b[0m ${String.fromCodePoint(0x202e)}${"y".repeat(200)}\r\nfake: line`,
        startedAt: "2026-10-03T02:59:58.000Z",
      },
    });
    const line = hostile.split("\n").find((candidate) => candidate.startsWith("Command: "));
    expect(line).toMatch(/^Command: running `echo y+…` for 2s$/u);
    expect(hostile).not.toContain("pwned");
    expect(hostile).not.toContain("fake: line");
    expect(hostile.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);

    const ended = await describeWith({
      id: "attempt-1",
      phase: "completed",
      runningCommand: { command: "pnpm test:verify", startedAt: "2026-10-03T02:36:00.000Z" },
    });
    expect(ended).not.toContain("Command:");
  } finally {
    vi.useRealTimers();
  }
});

it("lists each Attempt's copied mounts and marks a mount whose content changed", async () => {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
  const manifest = (digest: string, objectCount: number, objects: unknown[]) => ({
    volume: "datasets",
    source: "s3://datasets/prefix/",
    path: "/mnt/datasets",
    strategy: "copy",
    access: "read-only",
    objectCount,
    totalBytes: 12 * 1024,
    digest: `sha256:${digest.repeat(64)}`,
    copiedAt: "2026-10-04T00:00:00.000Z",
    objects,
  });
  const many = Array.from({ length: 20 }, (_, index) => ({ key: `part-${index}.csv`, size: 10 }));
  const attempt = (number: number, mountManifests?: unknown[]) => ({
    id: `attempt-${number}`,
    number,
    phase: "failed",
    startedAt: "2026-10-04T00:00:00.000Z",
    endedToWait: null,
    reportedCost: null,
    ...(mountManifests === undefined ? {} : { mountManifests }),
  });
  serveTask({
    apiVersion: "supertag/v1",
    kind: "Task",
    metadata: { id: "train" },
    spec: { tagId: "builder", sessionId: "session" },
    status: {
      phase: "running",
      attempts: [
        attempt(1, [
          manifest("a", 1, [{ key: "a.csv", size: 1024, etag: '"abc"', versionId: "v1" }]),
        ]),
        attempt(2),
        attempt(3, [manifest("a", 1, [{ key: "a.csv", size: 1024, etag: '"abc"' }])]),
        attempt(4, [
          manifest("b", 25, [
            { key: "evil\x1b[31m.csv", size: 2048, sha256: `sha256:${"c".repeat(64)}` },
            ...many,
          ]),
        ]),
      ],
    },
  });
  const result = await runResourceCommand(client, "describe", ["task", "train"]);
  expect(result).toContain(
    "Mounts (Attempt 1):\n  datasets  /mnt/datasets  copy read-only  1 object, 12.0 KiB  sha256:aaaaaaaaaaaa\n" +
      '    a.csv  1.0 KiB  etag "abc"  version v1\n',
  );
  expect(result).not.toContain("Mounts (Attempt 2)");
  expect(result).toContain(
    "Mounts (Attempt 3):\n  datasets  /mnt/datasets  copy read-only  1 object, 12.0 KiB  sha256:aaaaaaaaaaaa\n",
  );
  expect(result).toContain(
    "  datasets  /mnt/datasets  copy read-only  25 objects, 12.0 KiB  sha256:bbbbbbbbbbbb (changed since Attempt 1)",
  );
  expect(result).toContain("    evil .csv  2.0 KiB  sha256:cccccccccccc\n");
  expect(result).toContain("    part-18.csv  10 B\n    … 5 more objects\n");
  expect(result).not.toContain("part-19.csv");
  expect(result.replaceAll("\n", "")).not.toMatch(/[\p{Cc}]/u);
});

it("describes live mounts per Task Attempt without implying pinned content", async () => {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
  serveTask({
    apiVersion: "supertag/v1",
    kind: "Task",
    metadata: { id: "train" },
    spec: { tagId: "builder", sessionId: "session" },
    status: {
      phase: "running",
      attempts: [1, 2].map((number) => ({
        id: `attempt-${number}`,
        number,
        phase: "running",
        liveMounts: [
          {
            volume: "datasets",
            source: number === 1 ? "s3://datasets/prefix/" : "s3://datasets",
            prefix: number === 1 ? "prefix/" : "",
            path: "/mnt/datasets",
            strategy: "mount",
            access: "read-only",
            attachedAt: `2026-10-06T14:00:0${number}.000Z`,
          },
        ],
      })),
    },
  });
  const result = await runResourceCommand(client, "describe", ["task", "train"]);
  expect(result).toContain("Mounts (Attempt 1):");
  expect(result).toContain("Mounts (Attempt 2):");
  expect(result).toContain("datasets  /mnt/datasets  mount read-only  live");
  expect(result).toContain("source s3://datasets/prefix/");
  expect(result).toContain("prefix prefix/");
  expect(result).toContain("prefix (entire source)");
  expect(result).toContain("attached 2026-10-06T14:00:01.000Z");
  expect(result).toContain("attached 2026-10-06T14:00:02.000Z");
  expect(result).not.toMatch(/sha256|objects|changed since/u);
});
