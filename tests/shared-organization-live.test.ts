import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  observedDockerWorkerHarnesses,
  observedMcpHarnesses,
  takeUnseenTaskEvents,
} from "../scripts/shared-organization-evidence.mjs";

const execute = promisify(execFile);
const enabled = process.env["SUPERTAG_SHARED_ORGANIZATION_LIVE"] === "1";
const example = process.env["SUPERTAG_LIVE_EXAMPLE_DIRECTORY"];
const stateDirectory = process.env["SUPERTAG_EXAMPLE_STATE"];
const maxAttempts = Number(process.env["SUPERTAG_LIVE_MAX_ATTEMPTS"] ?? 12);
const maxSeconds = Number(process.env["SUPERTAG_LIVE_MAX_SECONDS"] ?? 600);
const attemptSeconds = Number(process.env["SUPERTAG_EXAMPLE_ATTEMPT_MS"] ?? 300000) / 1000;
const restartControlPlane = process.env["SUPERTAG_LIVE_RESTART_CONTROL_PLANE"] === "1";
const provider = process.env["SUPERTAG_EXAMPLE_PROVIDER"] ?? "docker";
const requestedWorkerHosts = process.env["SUPERTAG_EXAMPLE_WORKER_HOSTS"] ?? "process";
const setupSeconds = provider === "modal" ? 420 : 180;
const cleanupSeconds = requestedWorkerHosts === "docker" ? 180 : provider === "modal" ? 120 : 60;
type Row = Record<string, unknown>;
function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(row) : [];
}
function select(value: Row, keys: string[]): Row {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
}
function normalizeStatus(raw: Row): Row {
  const resources = rows(raw["tasks"]);
  const attempts: Row[] = [];
  for (const group of rows(raw["attempts"])) {
    const taskId = String(group["taskId"]);
    const resource = resources.find((item) => row(item["metadata"])["id"] === taskId) ?? {};
    const latest = row(row(resource["status"])["attempt"]);
    const events = rows(group["events"]);
    const ids = new Set(
      events.map((event) => event["attemptId"]).filter((id) => typeof id === "string"),
    );
    if (typeof latest["id"] === "string") ids.add(latest["id"]);
    for (const id of ids) {
      const ownEvents = events.filter((event) => event["attemptId"] === id);
      const terminal = ownEvents.findLast((event) =>
        ["execution.completed", "execution.failed"].includes(String(event["type"])),
      );
      attempts.push({
        id,
        taskId,
        attemptNumber: latest["id"] === id ? latest["number"] : undefined,
        executionStarted: ownEvents.some((event) => event["type"] === "execution.started"),
        executionCompleted: ownEvents.some((event) => event["type"] === "execution.completed"),
        completedObjective: ownEvents.some(
          (event) =>
            event["type"] === "objective.completed" &&
            row(event["payload"])["objectiveId"] === row(raw["objective"])["id"],
        ),
        workerProfile:
          latest["id"] === id
            ? (latest["workerProfile"] ?? row(row(resource["spec"])["execution"])["profile"])
            : undefined,
        workerHostId: latest["id"] === id ? latest["workerHostId"] : undefined,
        cleanup: latest["id"] === id ? row(latest["placement"])["cleanup"] : undefined,
        status:
          latest["id"] === id
            ? latest["phase"]
            : terminal
              ? String(terminal["type"]).replace("execution.", "")
              : "unknown",
        startedAt: ownEvents[0]?.["createdAt"],
        endedAt: terminal?.["createdAt"],
      });
    }
  }
  return {
    ...raw,
    resources,
    eventGroups: rows(raw["attempts"]),
    tasks: rows(raw["assignments"] ?? row(raw["objective"])["tasks"]),
    attempts,
  };
}
function completionSettled(status: Row): boolean {
  if (row(status["objective"])["status"] !== "completed") return false;
  const marked = rows(status["attempts"]).filter(
    (attempt) => attempt["completedObjective"] === true,
  );
  if (marked.length !== 1) return false;
  const completion = marked[0];
  if (completion?.["executionCompleted"] !== true || completion["status"] !== "completed")
    return false;
  return rows(status["resources"]).every((resource) => {
    const phase = row(row(resource["status"])["attempt"])["phase"];
    return phase === undefined || ["completed", "failed", "cancelled"].includes(String(phase));
  });
}

function cleanupDiagnostic(progress: Row): Row | undefined {
  if (
    progress["summary"] !== "Execution cleanup could not be confirmed; execution remains uncertain."
  )
    return;
  const items = rows(progress["items"])
    .filter((item) => /^cleanup-\d+$/u.test(String(item["id"])) && item["status"] === "blocked")
    .slice(0, 8)
    .map((item) => ({
      id: item["id"],
      status: "blocked",
      text: String(item["text"] ?? "").slice(0, 160),
    }));
  return items.length > 0 ? { items } : undefined;
}

function recordedProfileIds(status: Row): Set<string> {
  return new Set(
    rows(status["attempts"])
      .map((attempt) => row(attempt["workerProfile"])["id"])
      .filter((id): id is string => typeof id === "string"),
  );
}

function startedAttemptCount(status: Row): number {
  return new Set(
    rows(status["attempts"])
      .filter((attempt) => attempt["executionStarted"] === true)
      .map((attempt) => attempt["id"]),
  ).size;
}

it("keeps historical Attempt provenance separate from a newer Worker Profile", () => {
  const status = normalizeStatus({
    tasks: [
      {
        metadata: { id: "task" },
        spec: { execution: { profile: { id: "new-profile", revision: "2" } } },
        status: {
          attempt: {
            id: "new",
            phase: "running",
            workerProfile: { id: "new-profile", revision: "2" },
          },
        },
      },
    ],
    assignments: [{ taskId: "task", status: "running" }],
    attempts: [
      {
        taskId: "task",
        events: [
          { attemptId: "old", type: "execution.started", createdAt: "2026-09-15T00:00:00Z" },
          { attemptId: "old", type: "execution.failed", createdAt: "2026-09-15T00:01:00Z" },
          { attemptId: "new", type: "execution.started", createdAt: "2026-09-15T00:02:00Z" },
        ],
      },
    ],
  });
  const attempts = rows(status["attempts"]);
  expect(recordedProfileIds(status)).toEqual(new Set(["new-profile"]));
  expect(attempts.find((attempt) => attempt["id"] === "old")).toMatchObject({
    status: "failed",
    endedAt: "2026-09-15T00:01:00Z",
    workerProfile: undefined,
  });
  expect(attempts.find((attempt) => attempt["id"] === "new")).toMatchObject({
    status: "running",
    workerProfile: { id: "new-profile", revision: "2" },
  });
});

it("counts Worker execution starts separately from capacity admission refusals", () => {
  const status = normalizeStatus({
    tasks: [
      {
        metadata: { id: "busy" },
        status: { attempt: { id: "refusal-nine", number: 9, phase: "failed" } },
      },
    ],
    assignments: [{ taskId: "busy", attemptCount: 9 }],
    attempts: [
      {
        taskId: "busy",
        events: [
          { attemptId: "executed", type: "execution.started" },
          { attemptId: "executed", type: "execution.completed" },
        ],
      },
    ],
  });
  expect(rows(status["attempts"])).toHaveLength(2);
  expect(startedAttemptCount(status)).toBe(1);
  expect(
    rows(status["attempts"]).find((attempt) => attempt["id"] === "refusal-nine"),
  ).toMatchObject({ executionStarted: false });
});

it("retains only the bounded runtime cleanup diagnostic, not native progress text", () => {
  expect(
    cleanupDiagnostic({
      summary: "Native agent working",
      items: [{ id: "native", status: "active", text: "private content" }],
    }),
  ).toBeUndefined();
  const diagnostic = cleanupDiagnostic({
    summary: "Execution cleanup could not be confirmed; execution remains uncertain.",
    items: [
      { id: "native", status: "active", text: "private content" },
      {
        id: "cleanup-1",
        status: "blocked",
        text: "ExecutionCleanupError: Harness execution cleanup failed",
        stack: "excluded",
      },
    ],
  });
  expect(diagnostic).toEqual({
    items: [
      {
        id: "cleanup-1",
        status: "blocked",
        text: "ExecutionCleanupError: Harness execution cleanup failed",
      },
    ],
  });
});

it("waits for the exact Objective completion Attempt to settle", () => {
  const raw: Row = {
    objective: { id: "objective", status: "completed" },
    tasks: [
      { metadata: { id: "owner" }, status: { attempt: { id: "current", phase: "running" } } },
    ],
    attempts: [
      {
        taskId: "owner",
        events: [
          { attemptId: "old", type: "execution.completed" },
          {
            attemptId: "current",
            type: "objective.completed",
            payload: { objectiveId: "objective" },
          },
        ],
      },
    ],
  };
  expect(completionSettled(normalizeStatus(raw))).toBe(false);
  const events = rows(rows(raw["attempts"])[0]?.["events"]);
  events.push({ attemptId: "current", type: "execution.completed" });
  raw["attempts"] = [{ taskId: "owner", events }];
  expect(completionSettled(normalizeStatus(raw))).toBe(false);
  raw["tasks"] = [
    { metadata: { id: "owner" }, status: { attempt: { id: "current", phase: "completed" } } },
  ];
  expect(completionSettled(normalizeStatus(raw))).toBe(true);
  raw["tasks"] = [
    ...rows(raw["tasks"]),
    { metadata: { id: "other" }, status: { attempt: { id: "uncertain", phase: "unknown" } } },
  ];
  expect(completionSettled(normalizeStatus(raw))).toBe(false);
});

function nativeEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    delete env[key];
  return env;
}

it.skipIf(!enabled)(
  "lets native Claude and Codex managers complete and review a shared software Objective",
  async () => {
    if (!example || !stateDirectory)
      throw new Error("Use scripts/test-shared-organization-live.mjs --live");
    if (!["docker", "modal"].includes(provider)) throw new Error("Unsupported execution provider");
    if (!["process", "docker"].includes(requestedWorkerHosts))
      throw new Error("Unsupported Worker Host mode");
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 20 ||
      !Number.isInteger(maxSeconds) ||
      maxSeconds < 1 ||
      maxSeconds > 900 ||
      !Number.isInteger(attemptSeconds) ||
      attemptSeconds < 1 ||
      attemptSeconds > 600
    )
      throw new Error("Live organization bounds are invalid");
    const startedAt = new Date().toISOString();
    let status: Row = {};
    let outcome = "setup";
    let verification: unknown = null;
    let failure: string | null = null;
    let runError: unknown;
    let cleanupError: unknown;
    const recovery: Row = {
      requested: restartControlPlane,
      injected: false,
      reason: restartControlPlane ? "No eligible native execution observed yet" : "Baseline run",
    };
    const usage = new Map<string, Row>();
    const limits = new Map<string, Row>();
    const calls: Row[] = [];
    const placements = new Map<string, Row>();
    const completedAttempts = new Set<string>();
    const waitingInterruptions = new Set<string>();
    const denials: Row[] = [];
    const executionFailures: Row[] = [];
    const cleanupDiagnostics = new Map<string, Row>();
    const seenEvents = new Set<string>();
    let cleanup: Row = {};
    let execution: Row = { provider };
    let mcpProbe: Row = {};
    let workerHosts: Row = { mode: "local" };
    async function command(name: string, timeout = 30_000) {
      return execute(process.execPath, [join(example as string, "organization.mjs"), name], {
        cwd: example,
        env: nativeEnvironment(),
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    async function saveReport() {
      try {
        const saved = row(
          JSON.parse(await readFile(join(stateDirectory as string, "state.json"), "utf8")),
        );
        execution = {
          ...execution,
          ...select(saved, [
            "provider",
            "modalSandboxId",
            "modalImageId",
            "modalTerminated",
            "mcpEvidenceUnavailable",
            "containerName",
          ]),
          stateAvailable: true,
        };
        workerHosts = {
          mode: saved["workerHosts"] ?? "local",
          owner: saved["workerOwner"],
          workers: Object.entries(row(saved["workers"])).map(([manager, record]) => ({
            manager,
            ...select(row(record), [
              "kind",
              "containerName",
              "containerId",
              "ownerLabel",
              "workerHostId",
              "removed",
              "runningObserved",
            ]),
          })),
        };
        mcpProbe = select(row(saved["mcpProbe"]), [
          "passed",
          "interruptedWriteObserved",
          "deniedCallObserved",
          "committedWrites",
          "forbiddenCalls",
        ]);
      } catch {
        execution = { ...execution, stateAvailable: false };
      }
      const tasks = rows(status["tasks"]);
      const report = {
        version: 1,
        startedAt,
        observedAt: new Date().toISOString(),
        outcome,
        failure,
        transport: { worklet: "websocket", execution: "http" },
        execution,
        workerHosts,
        mcpProbe,
        liveHarnesses: ["claude-code", "codex"],
        credentials: "existing local CLI authentication",
        bounds: {
          maxAttempts,
          attemptAccounting: "worker-execution-started",
          maxSeconds,
          attemptSeconds,
          concurrency: 2,
        },
        objective: select(row(status["objective"]), [
          "id",
          "status",
          "ownerTagId",
          "budgetLimitMinor",
          "chargedMinor",
        ]),
        tasks: tasks.map((task) =>
          select(task, [
            "taskId",
            "teamId",
            "requestedByTagId",
            "assignedTagId",
            "parentTaskId",
            "sourceMessageId",
            "status",
            "attemptCount",
            "chargedMinor",
          ]),
        ),
        attemptHistoryCoverage: {
          assignmentAttempts: tasks.reduce(
            (count, task) => count + Number(task["attemptCount"] ?? 0),
            0,
          ),
          identifiedAttempts: rows(status["attempts"]).length,
          workerStartedAttempts: startedAttemptCount(status),
        },
        admissionRejections: rows(status["resources"]).flatMap((resource) => {
          const latest = row(resource["status"]);
          const rejection = row(latest["outcome"])["admissionRejected"];
          if (rejection === undefined) return [];
          return [
            {
              taskId: row(resource["metadata"])["id"],
              attemptNumber: row(latest["attempt"])["number"],
              category: /No eligible Worker capacity/iu.test(String(rejection))
                ? "worker-capacity-unavailable"
                : "admission-rejected",
            },
          ];
        }),
        attempts: rows(status["attempts"]).map((attempt) =>
          select(attempt, [
            "id",
            "taskId",
            "attemptNumber",
            "executionStarted",
            "executionCompleted",
            "completedObjective",
            "status",
            "cleanup",
            "workerProfile",
            "workerHostId",
            "startedAt",
            "endedAt",
          ]),
        ),
        messages: rows(status["messages"]).map((message) =>
          select(message, [
            "id",
            "senderTagId",
            "recipientTagId",
            "recipientTeamId",
            "type",
            "status",
            "inReplyTo",
            "attemptCount",
          ]),
        ),
        placements: [...placements.values()].map((placement) => ({
          ...placement,
          completed: completedAttempts.has(String(placement["attemptId"])),
        })),
        usage: [...usage.values()],
        usageCoverage: {
          observedAttempts: rows(status["attempts"]).length,
          reportedAttempts: usage.size,
          missingAttemptIds: rows(status["attempts"])
            .filter((attempt) => !usage.has(String(attempt["id"])))
            .map((attempt) => attempt["id"]),
        },
        limits: [...limits.values()],
        toolCalls: calls,
        permissionDenials: denials,
        executionFailures: executionFailures.map((failure) =>
          failure["category"] === "native-execution-interrupted" &&
          waitingInterruptions.has(String(failure["attemptId"]))
            ? { ...failure, category: "coordination-wait-interruption" }
            : failure,
        ),
        cleanupDiagnostics: [...cleanupDiagnostics.values()],
        cleanup,
        verification,
        recovery,
        uncertainty: tasks
          .filter((task) =>
            ["queued", "running", "waiting", "failed"].includes(String(task["status"])),
          )
          .map((task) => select(task, ["taskId", "status", "attemptCount"])),
        limitations: [
          "Reported usage is not an invoice; missing reports remain unavailable.",
          "Permission denial evidence is reported only when observed.",
          "Native SDK tool activity may not emit Task tool-call events; an empty list is not proof of no calls.",
          `${workerHosts["mode"] === "docker" ? "Two Docker Worker Host containers" : "Two local Harness processes"} share one ${provider === "modal" ? "Modal sandbox over HTTPS" : "Docker execution environment"}; this is not a multi-region or separate-physical-machine test.`,
          "MCP interruption and denial probes are deterministic SDK calls; native manager MCP evidence is reported separately by the verifier.",
        ],
      };
      const destination = join(stateDirectory as string, "live-report.json");
      await writeFile(`${destination}.tmp`, JSON.stringify(report, null, 2), { mode: 0o600 });
      await rename(`${destination}.tmp`, destination);
    }
    async function collectEvidence() {
      for (const { taskId, event } of takeUnseenTaskEvents(status["eventGroups"], seenEvents)) {
        const task = { taskId };
        const attemptId = String(event["attemptId"] ?? "unknown");
        const payload = row(event["payload"]);
        if (event["type"] === "progress.updated") {
          const diagnostic = cleanupDiagnostic(row(payload["progress"]));
          if (diagnostic !== undefined)
            cleanupDiagnostics.set(attemptId, {
              attemptId,
              at: event["createdAt"],
              ...diagnostic,
            });
        }
        if (event["type"] === "execution.completed") completedAttempts.add(attemptId);
        if (event["type"] === "execution.failed") {
          const message = String(row(payload["error"])["message"] ?? payload["error"] ?? "");
          const category = /timed? out|timeout/iu.test(message)
            ? "native-execution-timeout"
            : /cannot yet enforce per-access network policy/iu.test(message)
              ? "unsupported-network-policy"
              : /aborted|cancelled|canceled/iu.test(message)
                ? waitingInterruptions.has(attemptId)
                  ? "coordination-wait-interruption"
                  : "native-execution-interrupted"
                : /auth|credential|login/iu.test(message)
                  ? "authentication-error"
                  : "execution-failed";
          executionFailures.push({ attemptId, taskId: task["taskId"], category });
        }
        if (event["type"] === "runtime-inputs.resolved") {
          const manifest = row(payload["manifest"]);
          const environment = row(manifest["executionEnvironment"]);
          placements.set(attemptId, {
            attemptId,
            harnessId: row(manifest["harness"])["id"],
            executionEnvironment: {
              ...select(environment, ["id", "provider", "placement"]),
              provenance: select(row(environment["provenance"]), [
                "environmentId",
                "incarnationId",
                "accessId",
                "transport",
              ]),
            },
            mcpClients: rows(row(row(manifest["harness"])["provenance"])["mcpClients"]).map(
              (client) => select(client, ["client", "server", "transport"]),
            ),
          });
        }
        if (event["type"] === "usage.updated")
          usage.set(attemptId, {
            attemptId,
            ...select(row(payload["usage"]), [
              "inputTokens",
              "outputTokens",
              "cachedInputTokens",
              "totalTokens",
              "complete",
              "reportedCost",
            ]),
          });
        if (event["type"] === "execution.limits.applied")
          limits.set(attemptId, {
            attemptId,
            requested: payload["requested"],
            applied: payload["applied"],
          });
        if (event["type"] === "tool.call.started")
          calls.push({
            attemptId,
            ...select(row(payload["call"]), ["id", "provider", "operation", "effect"]),
          });
        if (event["type"] === "tool.call.failed") {
          const message = String(row(payload["error"])["message"] ?? "");
          if (/denied|not authorized|not permitted|forbidden/iu.test(message))
            denials.push({
              attemptId,
              operation: row(payload["call"])["operation"],
              observed: true,
            });
        }
      }
    }
    try {
      await command("bootstrap", setupSeconds * 1000);
      await saveReport();
      await command("start", 60_000);
      const deadline = Date.now() + maxSeconds * 1000;
      outcome = "running";
      while (true) {
        status = normalizeStatus(row(JSON.parse((await command("status")).stdout)));
        for (const resource of rows(status["resources"])) {
          const taskId = row(resource["metadata"])["id"];
          const assignment = rows(status["tasks"]).find((task) => task["taskId"] === taskId);
          const attempt = row(row(resource["status"])["attempt"]);
          if (
            assignment?.["status"] === "waiting" &&
            ["failed", "cancelled"].includes(String(attempt["phase"]))
          )
            waitingInterruptions.add(String(attempt["id"]));
        }
        await collectEvidence();
        await saveReport();
        if (
          restartControlPlane &&
          recovery["injected"] === false &&
          rows(status["tasks"]).length > 1 &&
          rows(status["attempts"]).some((attempt) => attempt["status"] === "running")
        ) {
          recovery["injected"] = true;
          recovery["interruptedAt"] = new Date().toISOString();
          recovery["activeAttemptIds"] = rows(status["attempts"])
            .filter((attempt) => attempt["status"] === "running")
            .map((attempt) => attempt["id"]);
          recovery["reason"] = "Control Plane interrupted during native delegated work";
          await saveReport();
          await command("restart-control-plane", 60_000);
          recovery["restartedAt"] = new Date().toISOString();
        }
        if (completionSettled(status)) {
          outcome = "completed";
          break;
        }
        if (startedAttemptCount(status) >= maxAttempts) {
          outcome = "attempt-limit";
          break;
        }
        const assignments = rows(status["tasks"]);
        if (
          assignments.length > 0 &&
          assignments.every((task) =>
            ["failed", "cancelled", "rejected"].includes(String(task["status"])),
          )
        ) {
          outcome = "stalled-terminal-tasks";
          break;
        }
        if (Date.now() >= deadline) {
          outcome = "deadline";
          break;
        }
        if (["failed", "cancelled"].includes(String(row(status["objective"])["status"]))) {
          outcome = "objective-stopped";
          break;
        }
        await delay(1000);
      }
      await collectEvidence();
      if (recovery["injected"] === true) {
        const activeIds = Array.isArray(recovery["activeAttemptIds"])
          ? recovery["activeAttemptIds"]
          : [];
        recovery["observedAttempts"] = activeIds.map((id) => {
          const attempt = rows(status["attempts"]).find((candidate) => candidate["id"] === id);
          return attempt
            ? select(attempt, ["id", "taskId", "status", "endedAt"])
            : { id, status: "unknown" };
        });
      }
      try {
        verification = JSON.parse(
          (
            await execute(process.execPath, [join(example, "verify.mjs")], {
              cwd: example,
              env: nativeEnvironment(),
              timeout: 30_000,
              maxBuffer: 1024 * 1024,
            })
          ).stdout,
        );
      } catch (error) {
        try {
          verification = JSON.parse(String(row(error)["stdout"]));
        } catch {
          verification = { passed: false, reason: "Independent artifact verifier did not pass" };
        }
      }
      await saveReport();
      expect(
        outcome,
        `Live run stopped at ${outcome}; evidence: ${join(stateDirectory, "live-report.json")}`,
      ).toBe("completed");
      expect(rows(status["tasks"]).length).toBeGreaterThan(1);
      expect(rows(status["tasks"]).some((task) => task["status"] === "accepted")).toBe(true);
      expect(recordedProfileIds(status).size).toBe(2);
      expect(
        rows(status["messages"]).some(
          (message) => message["senderTagId"] !== message["recipientTagId"],
        ),
      ).toBe(true);
      expect(
        new Set(
          [...placements.values()]
            .filter((placement) => completedAttempts.has(String(placement["attemptId"])))
            .map((placement) => placement["harnessId"]),
        ),
      ).toEqual(new Set(["claude-code", "codex"]));
      const ownerTagId = row(status["objective"])["ownerTagId"];
      expect(
        rows(status["tasks"]).some(
          (task) =>
            task["assignedTagId"] !== ownerTagId &&
            rows(status["attempts"]).some(
              (attempt) =>
                attempt["taskId"] === task["taskId"] &&
                completedAttempts.has(String(attempt["id"])),
            ),
        ),
      ).toBe(true);
      expect(row(verification)["passed"]).toBe(true);
      expect(mcpProbe["passed"]).toBe(true);
      expect(mcpProbe["interruptedWriteObserved"]).toBe(true);
      expect(mcpProbe["deniedCallObserved"]).toBe(true);
      expect(mcpProbe["committedWrites"]).toBe(1);
      expect(mcpProbe["forbiddenCalls"]).toBe(0);
      expect(row(row(verification)["mcp"])["passed"]).toBe(true);
      expect(
        observedMcpHarnesses({
          verification,
          attempts: rows(status["attempts"]),
          placements: [...placements.values()].map((placement) => ({
            ...placement,
            completed: completedAttempts.has(String(placement["attemptId"])),
          })),
        }),
      ).toEqual(new Set(["claude-code", "codex"]));
      expect(workerHosts["mode"]).toBe(requestedWorkerHosts);
      if (requestedWorkerHosts === "docker")
        expect(
          observedDockerWorkerHarnesses({
            workerHosts,
            verification,
            attempts: rows(status["attempts"]),
            placements: [...placements.values()].map((placement) => ({
              ...placement,
              completed: completedAttempts.has(String(placement["attemptId"])),
            })),
          }),
        ).toEqual(new Set(["claude-code", "codex"]));
      const completedPlacements = [...placements.values()].filter((placement) =>
        completedAttempts.has(String(placement["attemptId"])),
      );
      const incarnations = completedPlacements.map(
        (placement) => row(row(placement["executionEnvironment"])["provenance"])["incarnationId"],
      );
      expect(incarnations.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(incarnations).size).toBe(1);
      if (restartControlPlane) expect(recovery["injected"]).toBe(true);
    } catch (error) {
      failure = error instanceof Error ? error.name : "LiveExperimentError";
      if (outcome === "setup") outcome = "setup-failed";
      else if (outcome === "running") outcome = "interrupted";
      else if (outcome === "completed") outcome = "acceptance-failed";
      runError = error;
    } finally {
      try {
        cleanup = row(JSON.parse((await command("cleanup", cleanupSeconds * 1000)).stdout));
        if (cleanup["stopped"] !== true) cleanupError = new Error("Cleanup was not confirmed");
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError !== undefined) {
        cleanup = {
          stopped: false,
          error: cleanupError instanceof Error ? cleanupError.name : "CleanupError",
        };
        if (outcome === "completed") outcome = "cleanup-failed";
        failure ??= "Cleanup could not be confirmed";
      }
      await saveReport();
    }
    if (runError !== undefined) throw runError;
    if (cleanupError !== undefined) throw cleanupError;
  },
  (maxSeconds + setupSeconds + cleanupSeconds + 60) * 1000,
);
