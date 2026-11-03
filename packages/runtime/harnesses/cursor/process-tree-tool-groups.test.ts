import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { platformProcessInventory } from "@supertag/worker-sdk/internal/process-inventory";
import { expect, it } from "vitest";
import { CursorProcessTree } from "./src/process-tree.js";

const inventoryAvailable = await platformProcessInventory()
  .snapshot({})
  .then(
    () => true,
    () => false,
  );

// Security review reproductions: tool shells use their own detached group, or enable job
// control within the launcher's session. Gate launch so its parentage is observed first;
// retain the review's final external sleep, including Bash's job-control/exec behavior.
it.skipIf(!inventoryAvailable).each([
  ["detached tool shell", true, ""],
  ["job control in launcher session", false, "set -m;"],
] as const)(
  "kills a reparented system binary from a %s",
  async (_name, detached, setup) => {
    const inventory = platformProcessInventory();
    const tree = await CursorProcessTree.prepare(inventory);
    const directory = await mkdtemp(join(tmpdir(), "cursor-tool-group-"));
    const pidFile = join(directory, "orphan");
    const toolFile = join(directory, "tool");
    const root = spawn(
      process.execPath,
      [
        "-e",
        `
          const { spawn } = require('node:child_process');
          const { writeFileSync } = require('node:fs');
          const { createInterface } = require('node:readline');
          const env = { ...process.env };
          // Linux must exercise group discovery too; macOS hides system-binary environments.
          delete env.SUPERTAG_INTERNAL_PROCESS_MARKER;
          const tool = spawn('/bin/bash', ['-c', process.argv[2], 'sh', process.argv[1]], {
            env, detached: process.argv[3] === '1', stdio: ['pipe', 'pipe', 'inherit'],
          });
          writeFileSync(process.argv[4], String(tool.pid));
          process.stdout.write(tool.pid + '\\n');
          tool.stdout.pipe(process.stdout, { end: false });
          tool.once('exit', () => process.stdout.write('exited\\n'));
          createInterface({ input: process.stdin }).on('line', line => tool.stdin.write(line + '\\n'));
        `,
        pidFile,
        `read -r start; ${setup} (/bin/sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$1"); printf 'ready\\n'; /bin/sleep 3`,
        detached ? "1" : "0",
        toolFile,
      ],
      {
        detached: true,
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, SUPERTAG_INTERNAL_PROCESS_MARKER: tree.marker },
      },
    );
    const rootExited = once(root, "exit");
    const lines = createInterface({ input: root.stdout });
    const identities = new Map<number, string>();
    try {
      if (!root.pid) throw new Error("Missing root PID");
      const [toolLine] = await once(lines, "line", { signal: AbortSignal.timeout(5000) });
      const toolPid = Number(toolLine);
      expect(toolPid).toBeGreaterThan(1);
      const toolStarted = await inventory.started(toolPid);
      if (!toolStarted) throw new Error("Tool shell exited before its first gate");
      identities.set(toolPid, toolStarted);
      tree.start(root.pid, () => root.exitCode === null && root.signalCode === null);
      await tree.scan();
      const ready = once(lines, "line", { signal: AbortSignal.timeout(5000) });
      root.stdin.write("launch\n");
      expect(await ready).toEqual(["ready"]);
      const exited = once(lines, "line", { signal: AbortSignal.timeout(10000) });
      // The review's foreground sleep keeps a group member alive for periodic scans.
      // Scan explicitly too; the detached orphan has already lost its parent.
      await tree.scan();
      expect(await exited).toEqual(["exited"]);
      tree.close();
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(pid).toBeGreaterThan(1);
      const started = await inventory.started(pid);
      if (!started) throw new Error("Orphan exited before cleanup");
      identities.set(pid, started);
      const snapshot = await inventory.snapshot({ marker: tree.marker });
      const entry = snapshot.entries.find((candidate) => candidate.pid === pid);
      expect(entry).toBeDefined();
      expect(entry?.parent).not.toBe(root.pid);
      expect(entry?.parent).not.toBe(toolPid);
      expect(entry?.group).not.toBe(root.pid);
      expect(entry?.session).toBe(detached ? toolPid : root.pid);
      expect(snapshot.marked.has(pid)).toBe(false);
      root.kill("SIGSTOP");
      await tree.terminate(Date.now() + 5000);
      root.kill("SIGKILL");
      await rootExited;
      await tree.confirm(Date.now() + 5000);
      // Confirmation alone is insufficient: the regression was false confirmation of cleanup.
      await expect.poll(() => inventory.started(pid)).toBeUndefined();
    } finally {
      tree.close();
      lines.close();
      root.kill("SIGKILL");
      await rootExited;
      for (const file of [toolFile, pidFile]) {
        const pid = Number(await readFile(file, "utf8").catch(() => "0"));
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        const started = identities.get(pid);
        if (started) await inventory.signal(pid, started, "SIGKILL");
        else {
          // An assertion or inventory failure may have preceded identity capture.
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);

it.skipIf(!inventoryAvailable)(
  "keeps an unrelated process whose argv contains the marker out of cleanup (H1)",
  async () => {
    const inventory = platformProcessInventory();
    const tree = await CursorProcessTree.prepare(inventory);
    const environment = { ...process.env };
    delete environment.SUPERTAG_INTERNAL_PROCESS_MARKER;
    const root = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...environment, SUPERTAG_INTERNAL_PROCESS_MARKER: tree.marker },
    });
    const rootExited = once(root, "exit");
    let unrelated: ReturnType<typeof spawn> | undefined;
    let unrelatedExited: Promise<unknown> | undefined;
    try {
      if (!root.pid) throw new Error("Root did not start");
      tree.start(root.pid, () => root.exitCode === null && root.signalCode === null);
      await tree.scan();
      unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", `SUPERTAG_INTERNAL_PROCESS_MARKER=${tree.marker}`],
        { detached: true, stdio: "ignore", env: environment },
      );
      unrelatedExited = once(unrelated, "exit");
      if (!unrelated.pid) throw new Error("Unrelated process did not start");
      const started = await inventory.started(unrelated.pid);
      expect(started).toBeDefined();
      expect((await inventory.snapshot({ marker: tree.marker })).marked.has(unrelated.pid)).toBe(
        false,
      );
      root.kill("SIGSTOP");
      await tree.terminate(Date.now() + 5000);
      root.kill("SIGKILL");
      await rootExited;
      await tree.confirm(Date.now() + 5000);
      expect(await inventory.started(unrelated.pid)).toBe(started);
      process.kill(unrelated.pid, 0);
    } finally {
      tree.close();
      root.kill("SIGKILL");
      unrelated?.kill("SIGKILL");
      await Promise.all([rootExited, unrelatedExited]);
    }
  },
  20000,
);
