import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildDockerWorkerImage,
  cleanupDockerWorkerHosts,
  removeDockerWorkerImage,
  startDockerWorker,
  stopDockerWorker,
} from "../examples/shared-organization/docker-workers.mjs";

type WorkerRecord = {
  kind?: string;
  containerName: string;
  containerId?: string;
  removed?: boolean;
  ownerLabel?: string;
  workerHostId?: string;
  runningObserved?: boolean;
};
type DockerInfo = {
  Id: string;
  Config: { Labels: Record<string, string> };
  State?: { Status: string; Running: boolean; ExitCode: number };
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "supertag-docker-workers-"));
  directories.push(stateDirectory);
  const state = {
    stateDirectory,
    containerName: "supertag-shared-org-fixture",
    workerOwner: "owned-example",
    workerImageName: "supertag-org-workers:fixture",
    workerImageId: "sha256:owned",
    workerNetwork: "bridge",
    workers: {} as Record<string, WorkerRecord>,
  };
  for (const name of ["claude", "codex"])
    await writeFile(
      join(stateDirectory, `${name}.json`),
      JSON.stringify({
        hostId: `host-${name}`,
        credential: `${name}-host-secret`,
        executionToken: "execution-secret",
        mcpToken: "mcp-secret",
      }),
    );
  const infos = new Map<string, DockerInfo>();
  const saved: (typeof state)[] = [];
  const run = vi.fn(async (_command: string, args: string[], _options?: unknown) => {
    if (args[0] === "inspect") {
      const info = infos.get(args[1]);
      if (info) return { stdout: JSON.stringify([info]), stderr: "" };
      throw Object.assign(new Error("missing"), { stderr: "No such object" });
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      const info = {
        Id: `id-${name}`,
        Config: { Labels: { "supertag.example.owner": state.workerOwner } },
        State: { Status: "created", Running: false, ExitCode: 0 },
      };
      infos.set(name, info);
      infos.set(info.Id, info);
      return { stdout: info.Id, stderr: "" };
    }
    if (args[0] === "start") {
      infos.get(args[1]).State.Running = true;
      infos.get(args[1]).State.Status = "running";
    }
    if (args[0] === "stop") {
      const info = infos.get(args.at(-1));
      info.State.Running = false;
      info.State.Status = "exited";
    }
    if (args[0] === "logs")
      return { stdout: "execution-secret mcp-secret claude-host-secret", stderr: "" };
    if (args[0] === "rm") {
      const info = infos.get(args[1]);
      for (const [key, value] of infos) if (value === info) infos.delete(key);
    }
    return { stdout: "", stderr: "" };
  });
  const stageAuth = vi.fn(
    async ({ name, homeDirectory }: { name: string; homeDirectory: string }) => {
      await mkdir(homeDirectory, { recursive: true });
      return { provider: name, source: "file" };
    },
  );
  const save = vi.fn(async (value: typeof state) => {
    saved.push(structuredClone(value));
  });
  return { state, infos, run, stageAuth, save, saved };
}
it("gives each Worker only its own config, native home, and state without credential flags", async () => {
  const f = await fixture();
  for (const name of ["claude", "codex"])
    await startDockerWorker(f.state, name, f.save, {
      run: f.run,
      stageAuth: f.stageAuth,
      environment: { PATH: "/bin", OPENAI_API_KEY: "unrelated-api-key" },
    });
  const creates = f.run.mock.calls.filter(([, args]) => args[0] === "create");
  expect(creates).toHaveLength(2);
  for (const name of ["claude", "codex"]) {
    const args = creates.find(([, args]) => args.at(-1) === name)?.[1] ?? [];
    const other = name === "claude" ? "codex" : "claude";
    const mounts = args.filter((_, index) => args[index - 1] === "--mount");
    expect(mounts).toHaveLength(3);
    expect(mounts.join(" ")).toContain(`${name}.json`);
    expect(mounts.join(" ")).toContain(`/worker-hosts/${name}/home`);
    expect(mounts.join(" ")).not.toContain(`${other}.json`);
    expect(mounts.join(" ")).not.toContain(`/worker-hosts/${other}/`);
    expect(mounts.join(" ")).not.toContain("docker.sock");
    expect(JSON.stringify(args)).not.toMatch(
      /host-secret|execution-secret|mcp-secret|unrelated-api-key/,
    );
    expect(args).toContain("--read-only");
    expect(f.state.workers[name]).toMatchObject({
      ownerLabel: f.state.workerOwner,
      workerHostId: `host-${name}`,
      runningObserved: true,
    });
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
  }
  expect(f.saved[0].workers.claude).toMatchObject({
    kind: "docker",
    containerName: "supertag-shared-org-fixture-claude-worker",
  });
  expect(f.saved[0].workers.claude.containerId).toBeUndefined();
});
it("reuses a known running Worker without starting it twice", async () => {
  const f = await fixture();
  await startDockerWorker(f.state, "claude", f.save, { run: f.run, stageAuth: f.stageAuth });
  await startDockerWorker(f.state, "claude", f.save, { run: f.run, stageAuth: f.stageAuth });
  expect(f.run.mock.calls.filter(([, args]) => args[0] === "create")).toHaveLength(1);
  expect(f.run.mock.calls.filter(([, args]) => args[0] === "start")).toHaveLength(1);
  expect(f.stageAuth).toHaveBeenCalledTimes(1);
});
it("refuses to stop a same-name container belonging to someone else", async () => {
  const f = await fixture();
  const record = { kind: "docker", containerName: "foreign-container" };
  f.infos.set(record.containerName, {
    Id: "foreign",
    Config: { Labels: { "supertag.example.owner": "other-example" } },
  });
  await expect(stopDockerWorker(f.state, record, { run: f.run })).rejects.toThrow(
    "ownership differs",
  );
  expect(f.run.mock.calls.some(([, args]) => ["stop", "rm"].includes(args[0]))).toBe(false);
});
it("retains an owned create intent if Docker admission fails", async () => {
  const f = await fixture();
  const run = async (command: string, args: string[], options: unknown) => {
    if (args[0] === "create") throw new Error("Docker unavailable");
    return f.run(command, args, options);
  };
  await expect(
    startDockerWorker(f.state, "codex", f.save, { run, stageAuth: f.stageAuth }),
  ).rejects.toThrow("Docker unavailable");
  expect(f.saved[0].workers.codex.containerName).toBe("supertag-shared-org-fixture-codex-worker");
});
it("confirms shutdown, preserves redacted logs, and removes only the owned container", async () => {
  const f = await fixture();
  await startDockerWorker(f.state, "claude", f.save, { run: f.run, stageAuth: f.stageAuth });
  const record = f.state.workers.claude;
  expect(await stopDockerWorker(f.state, record, { run: f.run })).toEqual({ stopped: true });
  expect(record.removed).toBe(true);
  expect(await readFile(join(f.state.stateDirectory, "claude.log"), "utf8")).toBe(
    "[REDACTED] [REDACTED] [REDACTED]",
  );
  expect(await stopDockerWorker(f.state, record, { run: f.run })).toEqual({ stopped: true });
});
it("reports possible uncertainty after Docker forcibly kills the Worker", async () => {
  const f = await fixture();
  await startDockerWorker(f.state, "codex", f.save, { run: f.run, stageAuth: f.stageAuth });
  const record = f.state.workers.codex;
  f.infos.get(record.containerId).State.ExitCode = 137;
  expect(await stopDockerWorker(f.state, record, { run: f.run })).toMatchObject({
    stopped: true,
    forced: true,
    outcome: expect.stringContaining("uncertainty"),
  });
});
it("keeps the Worker image until ownership is verified", async () => {
  const f = await fixture();
  f.infos.set(f.state.workerImageName, {
    Id: "sha256:foreign",
    Config: { Labels: { "supertag.example.owner": "foreign" } },
  });
  await expect(removeDockerWorkerImage(f.state, { run: f.run })).rejects.toThrow(
    "ownership differs",
  );
  expect(f.run.mock.calls.some(([, args]) => args[0] === "image")).toBe(false);
});
it("records the built image identity without adding sign-in material to the build", async () => {
  const f = await fixture();
  f.infos.set(f.state.workerImageName, {
    Id: f.state.workerImageId,
    Config: { Labels: { "supertag.example.owner": f.state.workerOwner } },
  });
  await buildDockerWorkerImage(f.state, f.state.stateDirectory, f.save, { run: f.run });
  expect(f.saved.at(-1).workerImageId).toBe("sha256:owned");
  expect(JSON.stringify(f.run.mock.calls)).not.toMatch(/host-secret|execution-secret|mcp-secret/);
});

it("attempts independent execution cleanup after Docker refuses Worker shutdown", async () => {
  const f = await fixture();
  await startDockerWorker(f.state, "claude", f.save, { run: f.run, stageAuth: f.stageAuth });
  const run = async (command: string, args: string[], options: unknown) => {
    if (args[0] === "stop") throw new Error("Docker unavailable");
    return f.run(command, args, options);
  };
  const stopControlPlane = vi.fn(async () => ({ stopped: true }));
  const stopExecution = vi.fn(async () => {});
  await expect(
    cleanupDockerWorkerHosts(f.state, { run, stopControlPlane, stopExecution, save: f.save }),
  ).rejects.toThrow("cleanup could not be fully confirmed");
  expect(stopControlPlane).toHaveBeenCalledOnce();
  expect(stopExecution).toHaveBeenCalledOnce();
  expect(f.saved.at(-1)).not.toHaveProperty("stopped");
  expect(f.saved.at(-1)).toMatchObject({
    shutdown: [expect.objectContaining({ stopped: false }), { stopped: true }],
  });
  expect(f.saved.at(-1)?.workers.claude.containerId).toBeTruthy();
});

it("recovers an owned created container without duplicating creation or dropping its host identity", async () => {
  const f = await fixture();
  const record = { kind: "docker", containerName: "supertag-shared-org-fixture-codex-worker" };
  f.state.workers.codex = record;
  const info = {
    Id: "id-created",
    Config: { Labels: { "supertag.example.owner": f.state.workerOwner } },
    State: { Status: "created", Running: false, ExitCode: 0 },
  };
  f.infos.set(record.containerName, info);
  f.infos.set(info.Id, info);
  await startDockerWorker(f.state, "codex", f.save, { run: f.run, stageAuth: f.stageAuth });
  expect(f.state.workers.codex).toMatchObject({
    containerId: "id-created",
    workerHostId: "host-codex",
    runningObserved: true,
  });
  expect(f.stageAuth).not.toHaveBeenCalled();
  expect(f.run.mock.calls.some(([, args]) => args[0] === "create")).toBe(false);
});

it("mounts only the public coordination CA and enables verified Node TLS for the Worker", async () => {
  const f = await fixture();
  const state = {
    ...f.state,
    coordinationTls: {
      caFile: join(f.state.stateDirectory, "ca.pem"),
      keyFile: join(f.state.stateDirectory, "server-key.pem"),
    },
  };
  await startDockerWorker(state, "codex", f.save, { run: f.run, stageAuth: f.stageAuth });
  const args = f.run.mock.calls.find(([, args]) => args[0] === "create")[1];
  expect(args).toContain(
    `type=bind,src=${state.coordinationTls.caFile},dst=/run/supertag/coordination-ca.pem,readonly`,
  );
  expect(args).toContain("NODE_EXTRA_CA_CERTS=/run/supertag/coordination-ca.pem");
  expect(args.join(" ")).not.toContain(state.coordinationTls.keyFile);
  expect(args.join(" ")).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
});
