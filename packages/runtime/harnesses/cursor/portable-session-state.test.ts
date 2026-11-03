import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import { expect, it } from "vitest";
import {
  capturePortableCursorSessionState,
  restorePortableCursorSessionState,
  validatePortableCursorSessionState,
} from "./src/portable-session-state.js";

const names = ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"];
const agentLine = (cwd = "/first/workspace") =>
  `${JSON.stringify({ agentId: "agent-fixture", cwd, status: "idle" })}\n`;
const scratch = () =>
  mkdtemp(join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-state-"));

async function writeStore(directory: string, agents = agentLine()): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const name of names)
    await writeFile(join(directory, name), name === "agents.ndjson" ? agents : '{"safe":true}\n');
}

it("archives only the four JSONL files and restores them under a private directory", async () => {
  const root = await scratch();
  try {
    const source = join(root, "source");
    await writeStore(source);
    const state = await capturePortableCursorSessionState(source, "agent-fixture", [
      "cursor-test-secret",
    ]);
    expect(state.files).toHaveLength(4);
    const destination = join(root, "destination");
    await restorePortableCursorSessionState(state, destination, "/first/workspace");
    expect(
      (await capturePortableCursorSessionState(destination, "agent-fixture", [])).files,
    ).toEqual(state.files);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retargets only the archived agent at the next Attempt's workspace", async () => {
  const root = await scratch();
  try {
    const source = join(root, "source");
    const other = `${JSON.stringify({ agentId: "agent-other", cwd: "/elsewhere" })}\n`;
    await writeStore(source, `${agentLine()}${other}`);
    const state = await capturePortableCursorSessionState(source, "agent-fixture", []);
    const destination = join(root, "destination");
    await restorePortableCursorSessionState(state, destination, "/second/workspace");
    const restored = (await readFile(join(destination, "agents.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(restored).toEqual([
      { agentId: "agent-fixture", cwd: "/second/workspace", status: "idle" },
      { agentId: "agent-other", cwd: "/elsewhere" },
    ]);
    expect(await readFile(join(destination, "runs.ndjson"), "utf8")).toBe('{"safe":true}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects state that does not contain its own agent", async () => {
  const root = await scratch();
  try {
    const source = join(root, "source");
    await writeStore(source, '{"agentId":"agent-other","cwd":"/elsewhere"}\n');
    await expect(capturePortableCursorSessionState(source, "agent-fixture", [])).rejects.toThrow(
      /does not contain its agent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects null records in agents.ndjson", async () => {
  const root = await scratch();
  try {
    await writeStore(root, `${agentLine()}null\n`);
    await expect(capturePortableCursorSessionState(root, "agent-fixture", [])).rejects.toThrow(
      /Invalid Cursor Session agent record/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects oversized, malformed, secret-bearing and symlinked session files", async () => {
  const root = await scratch();
  try {
    const source = join(root, "source");
    await writeStore(source);
    await writeFile(join(source, names[0] as string), "cursor-test-secret\n");
    await expect(
      capturePortableCursorSessionState(source, "agent-fixture", ["cursor-test-secret"]),
    ).rejects.toThrow(/sensitive/);
    await writeFile(join(source, names[0] as string), "not-json\n");
    await expect(capturePortableCursorSessionState(source, "agent-fixture", [])).rejects.toThrow(
      /JSONL/,
    );
    await rm(join(source, names[0] as string));
    await symlink(join(source, names[1] as string), join(source, names[0] as string));
    await expect(capturePortableCursorSessionState(source, "agent-fixture", [])).rejects.toThrow();
    expect(() =>
      validatePortableCursorSessionState({
        version: 1,
        agentId: "agent-fixture",
        files: names.map((name) => ({ name, text: `${"x".repeat(9 * 1024 * 1024)}\n` })),
      }),
    ).toThrow(/size|file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Agent.resume in a new process with a new HOME, as a later Attempt runs it. Without a
 * model, @cursor/sdk 1.0.37 resolves the agent from the store without contacting Cursor,
 * so this needs no key or network. https://cursor.com/docs/sdk/typescript.md#resuming-agents
 */
function resumeInFreshProcess(root: string, store: string, workspace: string): string {
  const home = join(root, `home-${Math.random().toString(36).slice(2)}`);
  const script = `
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
const [store, workspace] = process.argv.slice(1);
try {
  const agent = await Agent.resume("agent-fixture", {
    apiKey: "fixture-not-a-cursor-key",
    local: { cwd: workspace, store: new JsonlLocalAgentStore(store) },
  });
  agent.close();
  process.stdout.write("resumed " + agent.agentId);
} catch (error) {
  process.stdout.write(error.name);
}
process.exit(0);
`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, store, workspace],
    {
      // Resolve @cursor/sdk from this package; the child shares nothing else with the test.
      cwd: dirname(fileURLToPath(import.meta.url)),
      env: { PATH: process.env["PATH"] ?? "", HOME: home },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  return child.stdout;
}

it("lets a fresh process with a fresh HOME resume the agent in a new workspace", async () => {
  const root = await scratch();
  try {
    const first = join(root, "attempt-1");
    const second = join(root, "attempt-2");
    const firstWorkspace = join(first, "workspace");
    const secondWorkspace = join(second, "workspace");
    await mkdir(firstWorkspace, { recursive: true });
    await mkdir(secondWorkspace, { recursive: true });
    const firstStore = join(first, "store");
    const now = Date.now();
    await new JsonlLocalAgentStore(firstStore).agents.create({
      agent: {
        agentId: "agent-fixture",
        cwd: firstWorkspace,
        status: "idle",
        createdAt: now,
        updatedAt: now,
      },
    });
    for (const name of names) await writeFile(join(firstStore, name), "", { flag: "a" });
    const state = await capturePortableCursorSessionState(firstStore, "agent-fixture", []);

    // Control: the unmodified archive is invisible from the new workspace.
    const verbatim = join(second, "verbatim-store");
    await mkdir(verbatim, { recursive: true });
    for (const file of state.files) await writeFile(join(verbatim, file.name), file.text);
    expect(resumeInFreshProcess(root, verbatim, secondWorkspace)).toBe("AgentNotFoundError");

    const restored = join(second, "store");
    await restorePortableCursorSessionState(state, restored, secondWorkspace);
    expect(resumeInFreshProcess(root, restored, secondWorkspace)).toBe("resumed agent-fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
