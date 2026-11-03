import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureLocalAdminToken,
  resolveControlPlaneTarget,
} from "../apps/cli/src/control-plane-client.ts";
import { main } from "../apps/cli/src/index.ts";
import {
  controlPlaneSlot,
  hostSlot,
  localControlPlaneUrl,
  readStatus,
  runningProcess,
  writeStatus,
} from "../apps/cli/src/local-state.ts";
import { formatRows, listServices } from "../apps/cli/src/ps.ts";
import { DEFAULT_INSTANCE_NAME } from "../apps/cli/src/supertag-yaml.ts";
import { bringDown, bringUp, showLogs, type UpOptions, type UpResult } from "../apps/cli/src/up.ts";
import { serviceManager, unitName } from "../apps/cli/src/up-service.ts";
import { SUPERTAG_VERSION } from "../apps/cli/src/version.ts";
import { machineWorkerConcurrency } from "../apps/cli/src/worker-concurrency.ts";
import {
  api,
  CLI,
  fakeHarness,
  fakeServices,
  freePort,
  repository,
  sharedControlPlane,
  TIMEOUT,
  useServicesContext,
  writeServices,
} from "./support/services.ts";

const context = useServicesContext();
const printed = () => context.printed();

async function untilReady(slot = controlPlaneSlot()) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = await readStatus(slot);
    if (status?.state === "ready") return status;
    if (status?.state === "failed") throw new Error(status.error);
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("not ready");
}

/** Runs one service in this process until ready, hands its status to `check`, then stops it. */
async function foreground(
  check: (status: Awaited<ReturnType<typeof untilReady>>) => Promise<void>,
  options: Partial<UpOptions> = {},
): Promise<UpResult> {
  const controller = new AbortController();
  const running = bringUp({ foreground: true, signal: controller.signal, ...options });
  try {
    const status = await Promise.race([
      untilReady(),
      running.then(() => {
        throw new Error("stopped early");
      }),
    ]);
    await check(status);
  } catch (error) {
    controller.abort();
    await running.catch(() => undefined);
    throw error;
  }
  controller.abort();
  return running;
}

describe("supertag up with a control-plane service", () => {
  it(
    "provisions missing resources before a single foreground Control Plane is ready and leaves existing resources alone",
    async () => {
      const manifest = (name: string) => `      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: ${name} }
        spec: {}
`;
      const configuration = (entries: string) => `services:
  control-plane:
    type: control-plane
    provision:
${entries}`;
      await writeServices(context, configuration(manifest("lead")));
      await foreground(async () => {
        expect((await api("/api/v1/tags/lead")).metadata).toMatchObject({ name: "lead" });
        expect(printed()).toContain("Tag/lead created (provision)");
      });
      await writeServices(context, configuration(manifest("lead") + manifest("helper")));
      context.output.length = 0;
      await foreground(async () => {
        expect((await api("/api/v1/tags/helper")).metadata).toMatchObject({ name: "helper" });
        expect(printed()).toContain("Tag/helper created (provision)");
        expect(printed()).not.toContain("Tag/lead created (provision)");
      });
    },
    TIMEOUT,
  );

  it(
    "provisions once in a foreground control-plane child before its host starts",
    async () => {
      await fakeHarness(context, "codex");
      const shop = await repository(context, "shop");
      await writeServices(
        context,
        `services:
  control-plane:
    type: control-plane
    provision:
      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: lead }
        spec: {}
  laptop:
    type: host
    harnesses: [codex]
    workspaces: { shop: ${shop} }
`,
      );
      const controller = new AbortController();
      const running = bringUp({ foreground: true, cliCommand: CLI, signal: controller.signal });
      try {
        for (let attempt = 0; attempt < 600; attempt += 1) {
          if ((await readStatus(hostSlot("laptop")))?.state === "ready") break;
          await new Promise((done) => setTimeout(done, 100));
        }
        expect((await readStatus(hostSlot("laptop")))?.state).toBe("ready");
        expect((await api("/api/v1/tags/lead")).metadata).toMatchObject({ name: "lead" });
        expect((await api("/api/v1/workspaces/shop")).metadata).toMatchObject({ name: "shop" });
        expect(printed().match(/Tag\/lead created \(provision\)/g)).toHaveLength(1);
        expect(printed().match(/Workspace\/shop created for host service laptop/g)).toHaveLength(1);
        expect(printed()).toContain("control-plane | Tag/lead created (provision)");
      } finally {
        controller.abort();
        await running;
      }
    },
    TIMEOUT,
  );

  it(
    "provisions an unchanged background Control Plane used by a foreground host",
    async () => {
      await fakeHarness(context, "codex");
      const shop = await repository(context, "shop");
      const tag = (name: string) => `      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: ${name} }
        spec: {}
`;
      const configuration = (entries: string) => `services:
  control-plane:
    type: control-plane
    provision:
${entries}  laptop:
    type: host
    harnesses: [codex]
    workspaces: { shop: ${shop} }
`;
      await writeServices(context, configuration(tag("lead")));
      await bringUp({ names: ["control-plane"], cliCommand: CLI });
      const background = await readStatus(controlPlaneSlot());
      const lead = (await api("/api/v1/tags/lead")).metadata;
      expect(printed().match(/Workspace\/shop created for host service laptop/g)).toHaveLength(1);
      // The provision list is not one of the Control Plane's settings, so adding to it leaves the
      // background Control Plane unchanged, and only the new entry is missing.
      await writeServices(context, configuration(tag("lead") + tag("helper")));
      context.output.length = 0;
      const controller = new AbortController();
      const running = bringUp({
        foreground: true,
        names: ["laptop"],
        cliCommand: CLI,
        signal: controller.signal,
      });
      try {
        for (let attempt = 0; attempt < 600; attempt += 1) {
          if ((await readStatus(hostSlot("laptop")))?.state === "ready") break;
          await new Promise((done) => setTimeout(done, 100));
        }
        expect((await readStatus(hostSlot("laptop")))?.state).toBe("ready");
        expect(printed()).toContain(
          "The local Control Plane already runs in the background; leaving it.",
        );
        expect((await readStatus(controlPlaneSlot()))?.pid).toBe(background?.pid);
        expect((await api("/api/v1/tags/helper")).metadata).toMatchObject({ name: "helper" });
        expect(printed().match(/Tag\/helper created \(provision\)/g)).toHaveLength(1);
        // What exists is left alone and never created again.
        expect((await api("/api/v1/tags/lead")).metadata).toEqual(lead);
        expect(printed()).not.toContain("Tag/lead created");
        expect(printed()).not.toContain("Workspace/shop created");
      } finally {
        controller.abort();
        await running;
      }
    },
    TIMEOUT,
  );

  it(
    "stops a foreground Control Plane when provisioning fails",
    async () => {
      await writeServices(
        context,
        `services:
  control-plane:
    type: control-plane
    provision: [missing-manifests]
`,
      );
      await expect(bringUp({ foreground: true })).rejects.toThrow(/missing-manifests/);
      expect((await readStatus(controlPlaneSlot()))?.state).toBe("failed");
      expect((await runningProcess(controlPlaneSlot())).pid).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "runs it in the foreground from supertag.yaml with no provision list",
    async () => {
      const port = await freePort();
      const grpc = await freePort();
      vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
      await writeServices(
        context,
        `services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:${port}"]
    database: { url: file:data/cp.db }
    hosts: { grpc: "${grpc}" }
    notify: slack:C0123456789
`,
      );
      const root = await repository(context, "shop");
      const result = await foreground(
        async (status) => {
          expect(status).toMatchObject({
            mode: "foreground",
            kind: "control-plane",
            service: "control-plane",
            instance: "supertag",
            url: `http://127.0.0.1:${port}`,
            workletUrl: `http://127.0.0.1:${grpc}`,
          });
          await expect(stat(join(context.state, "data", "cp.db"))).resolves.toBeDefined();
          await expect(stat(join(context.state, "control-plane", "pid"))).resolves.toBeDefined();
          await expect(resolveControlPlaneTarget()).resolves.toEqual({
            url: `http://127.0.0.1:${port}`,
            token: await ensureLocalAdminToken(),
          });
          expect((await api("/api/v1/tags")).items).toEqual([]);
          expect((await api("/api/v1/worker-hosts")).items).toEqual([]);
          await expect(bringUp({ foreground: true })).rejects.toThrow(
            /already running in the foreground[\s\S]*supertag down control-plane/,
          );
        },
        { cwd: root },
      );
      expect(result.services).toEqual([
        expect.objectContaining({ service: "control-plane", action: "stopped" }),
      ]);
      expect(printed()).toContain("Press Ctrl-C to stop.");
      expect(printed()).toContain("Stopped.");
      await expect(stat(join(context.state, "control-plane", "pid"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(root)).toEqual([".git"]);
    },
    TIMEOUT,
  );

  it(
    "uses the defaults without a file, -f for others, and notes files it does not read",
    async () => {
      const root = await repository(context, "app");
      await writeFile(join(root, "supertag.yaml"), "services: {}\n");
      await foreground(
        async (status) => {
          expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
          expect(status.url).not.toBe("http://127.0.0.1:0");
          await expect(stat(join(context.state, "supertag.db"))).resolves.toBeDefined();
        },
        { cwd: root },
      );
      expect(printed()).toContain("supertag.yaml is not read: supertag up reads");
      // -f names a file or a directory that holds one; later files merge over earlier ones.
      const elsewhere = join(context.directory, "elsewhere");
      await mkdir(elsewhere);
      const port = await freePort();
      vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
      await writeFile(
        join(elsewhere, "supertag.yaml"),
        "services:\n  control-plane: { type: control-plane, ports: ['1'] }\n",
      );
      await writeFile(
        join(elsewhere, "port.yaml"),
        `services:\n  control-plane: { ports: ["${port}"] }\n`,
      );
      context.output.length = 0;
      await foreground(
        async (status) => {
          expect(status.url).toBe(`http://127.0.0.1:${port}`);
        },
        { cwd: context.directory, files: ["elsewhere", "elsewhere/port.yaml"] },
      );
      await expect(bringUp({ files: ["missing.yaml"] })).rejects.toThrow(
        "missing.yaml does not exist",
      );
    },
    TIMEOUT,
  );

  it(
    "runs in the background, leaves it alone when unchanged, restarts on change, and stops with down",
    async () => {
      const port = await freePort();
      vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
      const services = (extra = "") =>
        `services:\n  control-plane:\n    type: control-plane\n    ports: ["${port}"]\n${extra}`;
      await writeServices(context, services());
      const first = await bringUp({ cliCommand: CLI });
      expect(first.services).toEqual([
        expect.objectContaining({
          action: "started",
          status: expect.objectContaining({
            mode: "background",
            state: "ready",
            url: `http://127.0.0.1:${port}`,
          }),
        }),
      ]);
      const pid = first.services[0]?.status?.pid;
      expect(printed()).toContain("Starting the local Control Plane in the background (logs in ");
      expect(printed()).toContain(`Control Plane ready at http://127.0.0.1:${port}.`);
      expect(printed()).toMatch(
        /The local Control Plane is running in the background \(process \d+\)\. Follow its logs with supertag logs -f control-plane; stop it with supertag down control-plane\./,
      );
      await expect(localControlPlaneUrl()).resolves.toBe(`http://127.0.0.1:${port}`);

      context.output.length = 0;
      await expect(bringUp({ cliCommand: CLI })).resolves.toMatchObject({
        services: [{ action: "unchanged", status: { pid } }],
      });
      expect(printed()).toContain("already runs with these settings, so it was left alone");

      context.output.length = 0;
      await writeServices(context, services("    url: https://supertag.example.com\n"));
      await bringUp({ cliCommand: CLI, dryRun: true });
      expect(printed()).toContain(
        "restart control-plane: url changed; hosts reconnect on their own",
      );
      expect((await runningProcess(controlPlaneSlot())).pid).toBe(pid);
      const restarted = await bringUp({ cliCommand: CLI });
      expect(restarted.services[0]).toMatchObject({ action: "restarted" });
      expect(restarted.services[0]?.status?.pid).not.toBe(pid);
      expect(printed()).toContain("The local Control Plane: url changed, so SuperTag restarts it.");
      expect(printed()).toContain("Running Task Attempts may see a brief disconnect");

      const rows = await listServices();
      expect(rows).toEqual([
        expect.objectContaining({
          service: "control-plane",
          type: "control-plane",
          state: "running",
          address: `http://127.0.0.1:${port}`,
          mode: "background",
        }),
      ]);
      expect(formatRows(rows)).toMatch(
        /^SERVICE\s+TYPE\s+STATE\s+ADDRESS\s+PROCESS\ncontrol-plane\s+control-plane\s+running\s+http:\/\/127\.0\.0\.1:\d+\s+\d+ in the background\n {2}build [0-9a-f]+\n$/u,
      );

      // One service: its log lines carry no service prefix, only the time each was written.
      const lines: string[] = [];
      await showLogs({ write: (chunk) => lines.push(chunk) });
      expect(lines.join("")).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z SuperTag database schema updated\./mu,
      );
      const controller = new AbortController();
      const followed: string[] = [];
      const following = showLogs({
        follow: true,
        signal: controller.signal,
        write: (chunk) => followed.push(chunk),
      });
      try {
        // Wait for the initial drain before testing a later append.
        await expect.poll(() => followed.join(""), { timeout: 5_000 }).toContain(lines.join(""));
        await writeFile(
          join(context.state, "control-plane", "logs", "control-plane.log"),
          "appended line\n",
          { flag: "a" },
        );
        await expect.poll(() => followed.join(""), { timeout: 5_000 }).toContain("appended line");
      } finally {
        controller.abort();
        await following;
      }

      context.output.length = 0;
      await expect(bringDown()).resolves.toBe("stopped");
      expect(printed()).toMatch(/Stopped the local Control Plane \(process \d+\)\./);
      context.output.length = 0;
      await expect(bringDown()).resolves.toBe("not-running");
      expect(printed()).toContain("SuperTag is not running on this machine.");
      expect((await listServices())[0]).toMatchObject({ state: "stopped" });
      const log = await readFile(
        join(context.state, "control-plane", "logs", "control-plane.log"),
        "utf8",
      );
      expect(log).toContain("Stopped.");
      expect(log).not.toContain(await ensureLocalAdminToken());
    },
    TIMEOUT,
  );

  it(
    "cleans up a stale pid file and prints the log tail when the child exits during startup",
    async () => {
      await mkdir(join(context.state, "control-plane"), { recursive: true });
      await writeFile(join(context.state, "control-plane", "pid"), "999999\n");
      const failed = join(context.directory, "failed.mjs");
      await writeFile(failed, "console.error('startup failed'); process.exitCode = 1;\n");
      await expect(bringUp({ cliCommand: [process.execPath, failed] })).rejects.toThrow(
        /stopped before it was ready[\s\S]*startup failed/,
      );
      expect(printed()).toContain("Removed a stale pid file of the local Control Plane");
    },
    TIMEOUT,
  );

  it(
    "stops a background child that never reports ready",
    async () => {
      const slow = join(context.directory, "slow.mjs");
      await writeFile(slow, "setTimeout(() => {}, 60000);\n");
      // The deadline may expire before the child runs any JavaScript on a loaded host.
      // Log-tail coverage above waits for an exit after output, independently of this deadline.
      await expect(
        bringUp({ cliCommand: [process.execPath, slow], readyTimeoutMs: 1_500 }),
      ).rejects.toThrow(/was not ready within 2 seconds and was stopped/);
    },
    TIMEOUT,
  );
});

describe("host services", () => {
  it(
    "join the local Control Plane, restart only when changed, and stop before it",
    async () => {
      const shop = await repository(context, "shop");
      const docs = await repository(context, "docs");
      const services = (workspaces: string) => `services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex]
    workspaces: { ${workspaces} }
`;
      await writeServices(context, services(`shop: ${shop}`));
      // up SERVICE brings up what it depends on first.
      const first = await bringUp({ cliCommand: CLI, names: ["laptop"] });
      expect(first.services.map((service) => [service.service, service.action])).toEqual([
        ["control-plane", "started"],
        ["laptop", "started"],
      ]);
      const host = first.services[1]?.status;
      expect(host).toMatchObject({
        kind: "host",
        mode: "background",
        state: "ready",
        connected: true,
        workers: ["local-codex"],
        attempts: [],
        attemptTimeLimitMs: 3_600_000,
      });
      const workerHostId = host?.workerHostId ?? "";
      expect(workerHostId).toBe("laptop");
      expect(printed()).toContain("Host service laptop: Enrolled as Worker Host laptop");
      expect(printed()).toMatch(/Worker Host laptop connected; Workers registered: local-codex\./);
      const credential = JSON.parse(
        await readFile(join(context.state, "hosts", "laptop", "credential.json"), "utf8"),
      ) as { workerHostId: string; token: string; controlPlane: string };
      expect(credential).toMatchObject({ workerHostId: "laptop" });
      expect(credential.token).not.toBe(await ensureLocalAdminToken());
      expect((await api("/api/v1/worker-hosts/laptop")).status).toMatchObject({
        connectionStatus: "connected",
        workspaces: ["shop"],
      });

      // ps reports both, with the host's Worker Host, connection, Tags, and Task Attempts.
      await api("/api/v1/tags", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "Tag",
          metadata: { name: "lead" },
          spec: {},
        }),
      });
      await api("/api/v1/tags/lead/worker-hosts/laptop", { method: "PUT" });
      const rows = await listServices();
      expect(rows[1]).toMatchObject({
        service: "laptop",
        type: "host",
        state: "running",
        workerHostId: "laptop",
        connected: true,
        tags: ["lead"],
        attempts: 0,
      });
      expect(formatRows(rows)).toContain(
        `  Worker Host laptop; connected; Tags lead; Task Attempts running: 0; concurrency ${machineWorkerConcurrency()} per harness (from this machine); build `,
      );
      context.output.length = 0;
      expect(await main(["ps", "--output", "json"])).toBe(0);
      expect(JSON.parse(printed())).toHaveLength(2);

      // Unchanged services are left alone.
      context.output.length = 0;
      const again = await bringUp({ cliCommand: CLI });
      expect(again.services.map((service) => service.action)).toEqual(["unchanged", "unchanged"]);

      // A previous release left the same settings on disk. It still needs a drain and restart.
      if (host === undefined) throw new Error("host did not report status");
      const old = { ...host, version: "0.1.0", buildIdentity: "0000000000000000" };
      await writeStatus(hostSlot("laptop"), old);
      const outdated = await listServices();
      expect(outdated[1]).toMatchObject({ version: "0.1.0", olderVersion: true });
      expect(formatRows(outdated)).toContain(`SuperTag 0.1.0 (older than CLI ${SUPERTAG_VERSION})`);
      // A build from before versions were recorded leaves no version at all.
      const { version: _version, ...unversioned } = host;
      await writeStatus(hostSlot("laptop"), unversioned);
      const unknown = await listServices();
      expect(unknown[1]).toMatchObject({ olderVersion: true });
      expect(formatRows(unknown)).toContain(
        `SuperTag version unknown (older than CLI ${SUPERTAG_VERSION})`,
      );
      await writeStatus(hostSlot("laptop"), old);
      context.output.length = 0;
      await bringUp({ cliCommand: CLI, dryRun: true });
      expect(printed()).toContain(
        "drain and restart laptop: SuperTag build changed; no Task Attempts running, so no wait",
      );
      context.output.length = 0;
      const upgraded = await bringUp({ cliCommand: CLI });
      expect(upgraded.services.map((service) => service.action)).toEqual([
        "unchanged",
        "restarted",
      ]);
      expect(upgraded.services[1]?.status).toMatchObject({ version: SUPERTAG_VERSION });
      expect(printed()).toContain(
        "Host service laptop: SuperTag build changed, so SuperTag restarts it.",
      );
      expect((await listServices())[1]?.olderVersion).toBeUndefined();

      // A changed host restarts; its Control Plane is left alone.
      await writeServices(context, services(`shop: ${shop}, docs: ${docs}`));
      context.output.length = 0;
      await bringUp({ cliCommand: CLI, dryRun: true });
      expect(printed()).toContain("leave control-plane: running with the same settings");
      expect(printed()).toContain(
        "drain and restart laptop: workspaces changed; no Task Attempts running, so no wait",
      );
      context.output.length = 0;
      const changed = await bringUp({ cliCommand: CLI });
      expect(changed.services.map((service) => service.action)).toEqual(["unchanged", "restarted"]);
      expect(changed.services[1]?.status?.workerHostId).toBe("laptop");
      expect(printed()).toContain(
        "Host service laptop: workspaces changed, so SuperTag restarts it.",
      );
      expect((await api("/api/v1/worker-hosts/laptop")).status).toMatchObject({
        workspaces: expect.arrayContaining(["docs", "shop"]),
      });

      // Logs of several services carry a prefix.
      const lines: string[] = [];
      await showLogs({ write: (chunk) => lines.push(chunk) });
      expect(lines.join("")).toMatch(
        /^control-plane \| \S+Z SuperTag Control Plane listening at/mu,
      );
      expect(lines.join("")).toMatch(
        /^laptop \| \S+Z Serving codex with Workspaces docs, shop as Worker Host laptop\./mu,
      );

      // The host's Workspaces exist on its Control Plane, created with defaults by up.
      expect((await api("/api/v1/workspaces/shop")).spec).toMatchObject({
        ref: "main",
        delivery: "branch",
      });
      expect(printed()).toContain("Workspace/docs created for host service laptop");

      // down SERVICE drains the host with its own credential before stopping it; up resumes it.
      context.output.length = 0;
      await expect(bringDown({ names: ["laptop"] })).resolves.toBe("stopped");
      expect((await api("/api/v1/worker-hosts/laptop")).spec).toMatchObject({ draining: true });
      await expect(stat(join(context.state, "hosts", "laptop", "drained"))).resolves.toBeDefined();
      context.output.length = 0;
      await bringUp({ cliCommand: CLI });
      expect(printed()).toContain("Resumed Worker Host laptop: it takes new Task Attempts again.");
      expect((await api("/api/v1/worker-hosts/laptop")).spec).toMatchObject({ draining: false });
      await expect(stat(join(context.state, "hosts", "laptop", "drained"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      // down stops the host first.
      context.output.length = 0;
      await expect(bringDown()).resolves.toBe("stopped");
      expect(printed()).toMatch(
        /Stopped host service laptop \(process \d+\)\.\nStopped the local Control Plane \(process \d+\)\./,
      );
      expect(await readdir(shop)).toEqual([".git"]);
    },
    TIMEOUT,
  );

  it(
    "apply a changed concurrency without a restart, and restart only for other changes",
    async () => {
      const shop = await repository(context, "shop");
      const services = (concurrency: number, workspaces = `shop: ${shop}`) => `services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex]
    workspaces: { ${workspaces} }
    concurrency: ${concurrency}
`;
      const capacity = async () =>
        ((await api("/api/v1/worker-hosts/laptop")) as { status: { capacity: number } }).status
          .capacity;
      await writeServices(context, services(2));
      const first = await bringUp({ cliCommand: CLI });
      const pid = first.services[1]?.status?.pid;
      expect(pid).toBeDefined();
      await vi.waitFor(async () => expect(await capacity()).toBe(2));

      // A higher limit: dry-run says so, and up applies it to the running host.
      await writeServices(context, services(5));
      context.output.length = 0;
      await bringUp({ cliCommand: CLI, dryRun: true });
      expect(printed()).toContain(
        "raise concurrency of laptop from 2 to 5 without a restart; new Task Attempts can start at once",
      );
      expect(printed()).not.toContain("drain and restart laptop");
      context.output.length = 0;
      const raised = await bringUp({ cliCommand: CLI });
      expect(raised.services.map((service) => service.action)).toEqual(["unchanged", "updated"]);
      expect(raised.services[1]?.status).toMatchObject({
        pid,
        resolved: { concurrency: 5 },
        concurrency: { value: 5, source: "file" },
      });
      expect(printed()).toContain(
        "Host service laptop: concurrency changed from 2 to 5, so SuperTag applies it without a restart.",
      );
      expect(printed()).not.toContain("restarts it");
      await vi.waitFor(async () => expect(await capacity()).toBe(5), { timeout: 10_000 });
      expect(formatRows(await listServices())).toContain(
        "concurrency 5 per harness (from supertag.yaml)",
      );
      context.output.length = 0;
      const again = await bringUp({ cliCommand: CLI });
      expect(again.services.map((service) => service.action)).toEqual(["unchanged", "unchanged"]);

      // Two up commands at once: the host applies both requests, and neither command times out.
      const six = join(context.state, "six.yaml");
      const seven = join(context.state, "seven.yaml");
      await writeFile(six, services(6));
      await writeFile(seven, services(7));
      const both = await Promise.all([
        bringUp({ cliCommand: CLI, files: [six] }),
        bringUp({ cliCommand: CLI, files: [seven] }),
      ]);
      expect(both.map((result) => result.services[1])).toMatchObject([
        { action: "updated", status: { pid } },
        { action: "updated", status: { pid } },
      ]);
      const applied = (await readStatus(hostSlot("laptop")))?.concurrency?.value;
      expect([6, 7]).toContain(applied);
      await vi.waitFor(async () => expect(await capacity()).toBe(applied), { timeout: 10_000 });
      expect(await readdir(join(context.state, "hosts", "laptop", "concurrency"))).toEqual([]);

      // A lower limit with work running: only new Task Attempts wait, until running ones fit.
      await writeServices(context, services(1));
      const status = await readStatus(hostSlot("laptop"));
      if (status === undefined) throw new Error("host did not report status");
      const attempt = (id: string) => ({
        attemptId: id,
        taskId: `task-${id}`,
        startedAt: new Date().toISOString(),
      });
      await writeStatus(hostSlot("laptop"), {
        ...status,
        attempts: [attempt("a"), attempt("b"), attempt("c")],
      });
      context.output.length = 0;
      await bringUp({ cliCommand: CLI, dryRun: true });
      expect(printed()).toContain(
        `lower concurrency of laptop from ${applied} to 1 without a restart; running Task Attempts finish, and a harness starts new ones only once fewer than 1 run on it (3 running now)`,
      );
      await writeStatus(hostSlot("laptop"), status);
      context.output.length = 0;
      const lowered = await bringUp({ cliCommand: CLI });
      expect(lowered.services[1]).toMatchObject({ action: "updated", status: { pid } });
      await vi.waitFor(async () => expect(await capacity()).toBe(1), { timeout: 10_000 });

      // Another setting changed with it: the host drains and restarts as before.
      const docs = await repository(context, "docs");
      await writeServices(context, services(3, `shop: ${shop}, docs: ${docs}`));
      context.output.length = 0;
      await bringUp({ cliCommand: CLI, dryRun: true });
      expect(printed()).toContain(
        "drain and restart laptop: workspaces, concurrency changed; no Task Attempts running, so no wait",
      );
      const restarted = await bringUp({ cliCommand: CLI });
      expect(restarted.services[1]?.action).toBe("restarted");
      expect(restarted.services[1]?.status?.pid).not.toBe(pid);
      await expect(bringDown()).resolves.toBe("stopped");
    },
    TIMEOUT,
  );

  it(
    "join a shared Control Plane with an auth-key secret, then use the stored credential",
    async () => {
      const root = await repository(context, "app");
      const remote = await sharedControlPlane(context);
      const keyFile = join(context.directory, "laptop.key");
      await writeFile(keyFile, `${await remote.authKey("laptop-key")}\n`);
      await writeServices(
        context,
        `services:
  laptop:
    type: host
    control-plane: ${remote.url}
    auth-key: laptop-key
    harnesses: [codex]
    workspaces: { app: ${root} }
  spare:
    type: host
    control-plane: ${remote.url}
    harnesses: [codex]
secrets:
  laptop-key: { file: ${keyFile} }
`,
      );
      // Without an auth-key and without a stored credential, a host cannot join.
      await expect(bringUp({ cliCommand: CLI, names: ["spare"] })).rejects.toThrow(
        /Host service spare has no Worker Host credential for http:\/\/127\.0\.0\.1:\d+\. Ask an operator for an Auth Key/,
      );
      context.output.length = 0;
      const result = await bringUp({ cliCommand: CLI, names: ["laptop"] });
      const status = result.services[0]?.status;
      expect(status).toMatchObject({
        mode: "background",
        state: "ready",
        workers: ["local-codex"],
      });
      expect(printed()).toMatch(
        /Host service laptop: Joined as Worker Host laptop for Tags lead\./,
      );
      expect(printed()).toContain(
        `Worker Host laptop connected to ${remote.url}; Workers registered: local-codex.`,
      );
      expect((await remote.shared("/api/v1/worker-hosts/laptop")).status).toMatchObject({
        connectionStatus: "connected",
        authKey: "laptop-key",
        workspaces: ["app"],
      });
      // No local Control Plane started; nothing was written in the repository.
      await expect(runningProcess(controlPlaneSlot())).resolves.toEqual({});
      expect(await readdir(root)).toEqual([".git"]);
      await bringDown({ write: () => {} });

      // A new Auth Key is not spent: the stored credential is used.
      await writeFile(keyFile, `${await remote.authKey("unused")}\n`);
      context.output.length = 0;
      const again = await bringUp({ cliCommand: CLI, names: ["laptop"] });
      expect(again.services[0]?.status?.workerHostId).toBe("laptop");
      expect(printed()).not.toContain("Joined as");
      expect((await remote.shared("/api/v1/auth-keys/unused")).status).toMatchObject({
        redemptionCount: 0,
      });
      await bringDown({ write: () => {} });
    },
    TIMEOUT,
  );

  it(
    "remove a host service the file no longer names with down SERVICE: stop, revoke, unbind",
    async () => {
      const shop = await repository(context, "shop");
      const both = `services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex]
    workspaces: { shop: ${shop} }
`;
      await writeServices(context, both);
      await bringUp({ cliCommand: CLI });
      await api("/api/v1/tags", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "Tag",
          metadata: { name: "lead" },
          spec: {},
        }),
      });
      await api("/api/v1/tags/lead/worker-hosts/laptop", { method: "PUT" });

      // The file drops the host: up and ps say how to remove it, and leave it running.
      await writeServices(context, "services:\n  control-plane: { type: control-plane }\n");
      context.output.length = 0;
      await bringUp({ cliCommand: CLI, dryRun: true });
      expect(printed()).toContain(
        "  Host service laptop is no longer in supertag.yaml but still runs. Remove it with supertag down laptop:",
      );
      context.output.length = 0;
      await bringUp({ cliCommand: CLI });
      expect(printed()).toContain(
        "Host service laptop is no longer in supertag.yaml but still runs. Remove it with supertag down laptop: that stops it, removes its service unit, and revokes its Worker Host and unbinds it from Tags.\n",
      );
      expect(formatRows(await listServices())).toContain(
        "not in supertag.yaml; remove it with supertag down laptop",
      );
      await expect(runningProcess(hostSlot("laptop"))).resolves.toHaveProperty("pid");

      // down laptop stops it, unbinds and revokes its Worker Host, and removes its state.
      context.output.length = 0;
      await expect(bringDown({ names: ["laptop"] })).resolves.toBe("stopped");
      expect(printed()).toMatch(
        /Stopped host service laptop \(process \d+\)\.\nUnbound Worker Host laptop from Tag lead\.\nRevoked Worker Host laptop\.\nRemoved host service laptop from this machine/u,
      );
      expect((await api("/api/v1/tags/lead")).spec.workerHosts).toEqual([]);
      expect((await api("/api/v1/worker-hosts/laptop")).status).toMatchObject({
        phase: "revoked",
      });
      await expect(stat(join(context.state, "hosts", "laptop"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await listServices()).map((row) => row.service)).toEqual(["control-plane"]);
      context.output.length = 0;
      await bringUp({ cliCommand: CLI });
      expect(printed()).not.toContain("no longer in supertag.yaml");
      await bringDown({ write: () => {} });
    },
    TIMEOUT,
  );
});

describe("service units", () => {
  it(
    "install LaunchAgents for restart: unless-stopped, keep secrets out, and stop or remove them",
    async () => {
      const root = await repository(context, "service");
      const port = await freePort();
      vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
      vi.stubEnv("PGPASSWORD", "hunter2-in-the-shell");
      const services = (restart: string) => `name: acme
services:
  control-plane:
    type: control-plane
    ports: ["${port}"]
    restart: ${restart}
    database: { password: db-password }
  laptop:
    type: host
    harnesses: [codex]
    restart: unless-stopped
    workspaces: { service: ${root} }
secrets:
  db-password: { environment: PGPASSWORD }
`;
      await writeServices(context, services("unless-stopped"));
      const units = fakeServices(context, "darwin");
      // A unit does not inherit this shell's environment, so a secret read from it is missing.
      await expect(bringUp({ services: units.environment, cliCommand: CLI })).rejects.toThrow(
        /failed to start: Secret db-password reads PGPASSWORD, which is not set in the environment or an env_file/,
      );
      expect(printed()).toContain(
        "Warning: the service unit for control-plane does not inherit this shell's environment, so it cannot see PGPASSWORD.",
      );
      // env_file (.env beside supertag.yaml) is where a unit finds it.
      await writeFile(join(context.state, ".env"), "PGPASSWORD=from-the-env-file\n");
      context.output.length = 0;
      const result = await bringUp({ services: units.environment, cliCommand: CLI });
      expect(printed()).not.toContain("Warning:");
      expect(result.services.map((service) => [service.service, service.status?.mode])).toEqual([
        ["control-plane", "service"],
        ["laptop", "service"],
      ]);
      const agents = join(context.directory, "home", "Library", "LaunchAgents");
      const plist = await readFile(join(agents, "ai.supertag.acme.control-plane.plist"), "utf8");
      expect(plist).toContain("<string>ai.supertag.acme.control-plane</string>");
      expect(plist).toContain(
        "<string>up</string>\n    <string>--foreground</string>\n    <string>control-plane</string>",
      );
      expect(plist).toContain(
        `<string>${join(context.state, "control-plane", "logs", "control-plane.log")}</string>`,
      );
      expect(plist).toContain("<key>SUPERTAG_UP_MODE</key>\n    <string>service</string>");
      const hostPlist = await readFile(join(agents, "ai.supertag.acme.laptop.plist"), "utf8");
      expect(hostPlist).toContain("<string>laptop</string>");
      for (const text of [plist, hostPlist]) {
        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("from-the-env-file");
        expect(text).not.toContain("PGPASSWORD");
      }
      expect(printed()).toMatch(/Host service laptop is running as a service unit/);
      expect(printed()).toMatch(/Worker Host laptop connected; Workers registered: local-codex\./);
      expect(await listServices({ services: units.environment })).toEqual([
        expect.objectContaining({
          service: "control-plane",
          mode: "service",
          unit: join(agents, "ai.supertag.acme.control-plane.plist"),
        }),
        expect.objectContaining({ service: "laptop", mode: "service" }),
      ]);

      // up works with the running units instead of starting second processes.
      context.output.length = 0;
      const again = await bringUp({ services: units.environment, cliCommand: CLI });
      expect(again.services.map((service) => service.action)).toEqual(["unchanged", "unchanged"]);

      // down stops both until the next login; up starts them again through the units.
      context.output.length = 0;
      await expect(bringDown({ services: units.environment })).resolves.toBe("stopped");
      expect(units.calls).toContain("launchctl bootout gui/501/ai.supertag.acme.laptop");
      expect(units.calls).toContain("launchctl bootout gui/501/ai.supertag.acme.control-plane");
      expect(printed()).toContain("supertag down --remove-services removes it");

      // restart: no removes the Control Plane's unit and runs it in the background.
      await writeServices(context, services("no"));
      context.output.length = 0;
      const switched = await bringUp({ services: units.environment, cliCommand: CLI });
      expect(switched.services[0]?.status?.mode).toBe("background");
      expect(printed()).toContain("Removed the service unit for the local Control Plane");
      await expect(
        stat(join(agents, "ai.supertag.acme.control-plane.plist")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });

      context.output.length = 0;
      await bringDown({ removeServices: true, services: units.environment });
      await expect(stat(join(agents, "ai.supertag.acme.laptop.plist"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(printed()).toContain("Removed the service unit for host service laptop");
      await expect(runningProcess(hostSlot("laptop"))).resolves.toEqual({});
    },
    TIMEOUT,
  );

  it(
    "resolve without the shell's environment: shell-only values warn and never restart, non-secret overrides are carried",
    async () => {
      const port = await freePort();
      vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
      // Shell-only: an interpolated variable and a database URL with a password.
      vi.stubEnv("LOG_FORMAT", "json");
      vi.stubEnv("SUPERTAG_DATABASE_URL", "postgresql://app:hunter2@127.0.0.1:1/supertag");
      // Non-secret: written into the unit.
      vi.stubEnv("SUPERTAG_COORDINATION_URL", `http://localhost:${port}`);
      await writeServices(
        context,
        `services:
  control-plane:
    type: control-plane
    ports: ["${port}"]
    restart: unless-stopped
    logging: { format: "\${LOG_FORMAT:-text}" }
`,
      );
      const units = fakeServices(context, "darwin");
      const warning = `Warning: the service unit for control-plane does not inherit this shell's environment, so it cannot see LOG_FORMAT, SUPERTAG_DATABASE_URL. Put them in ${join(context.state, ".env")} (env_file) or a secret file, or unset them in this shell. supertag up does not restart the service for them.`;
      const first = await bringUp({ services: units.environment, cliCommand: CLI });
      expect(first.services[0]?.action).toBe("started");
      expect(printed()).toContain(warning);
      expect(printed()).toContain(
        "The service unit for control-plane keeps SUPERTAG_COORDINATION_URL from this shell",
      );
      const plist = await readFile(
        join(
          context.directory,
          "home",
          "Library",
          "LaunchAgents",
          "ai.supertag.control-plane.plist",
        ),
        "utf8",
      );
      expect(plist).toContain(
        `<key>SUPERTAG_COORDINATION_URL</key>\n    <string>http://localhost:${port}</string>`,
      );
      expect(plist).not.toContain("hunter2");
      expect(plist).not.toContain("SUPERTAG_DATABASE_URL");
      expect(plist).not.toContain("LOG_FORMAT");
      // The unit resolved the file as it sees it: no shell-only values, the carried override.
      const status = await readStatus(controlPlaneSlot());
      expect(status?.resolved).toMatchObject({
        url: `http://localhost:${port}`,
        logging: { format: "text" },
        database: { url: `file:${join(context.state, "supertag.db")}` },
      });

      // The same shell again: nothing restarts, and the warning says why.
      for (const run of [1, 2]) {
        context.output.length = 0;
        const again = await bringUp({ services: units.environment, cliCommand: CLI });
        expect(again.services.map((service) => [run, service.action])).toEqual([
          [run, "unchanged"],
        ]);
        expect(again.services[0]?.status?.pid).toBe(status?.pid);
        expect(printed()).toContain(warning);
        expect(printed()).toContain("already runs with these settings, so it was left alone");
      }
      context.output.length = 0;
      await bringUp({ services: units.environment, cliCommand: CLI, dryRun: true });
      expect(printed()).toContain("leave control-plane: running with the same settings");

      // env_file is what a unit reads: the value there changes the unit's settings.
      await writeFile(join(context.state, ".env"), "LOG_FORMAT=json\n");
      context.output.length = 0;
      const changed = await bringUp({ services: units.environment, cliCommand: CLI });
      expect(changed.services[0]?.action).toBe("restarted");
      expect(printed()).toContain("logging changed, so SuperTag restarts it");
      expect(printed()).toContain("so it cannot see SUPERTAG_DATABASE_URL. Put them in");
      expect((await readStatus(controlPlaneSlot()))?.resolved).toMatchObject({
        logging: { format: "json" },
      });
      await bringDown({ removeServices: true, services: units.environment, write: () => {} });
    },
    TIMEOUT,
  );

  it(
    "write systemd user units with a lingering hint, and are not supported on Windows",
    async () => {
      const port = await freePort();
      vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
      await writeServices(
        context,
        `services:\n  control-plane: { type: control-plane, ports: ["${port}"], restart: unless-stopped }\n`,
      );
      const units = fakeServices(context, "linux");
      await bringUp({ services: units.environment, cliCommand: CLI });
      const unit = await readFile(
        join(
          context.directory,
          "home",
          ".config",
          "systemd",
          "user",
          "supertag-control-plane.service",
        ),
        "utf8",
      );
      expect(unit).toContain(`ExecStart=${CLI.join(" ")} up --foreground control-plane`);
      expect(unit).toContain(
        `StandardOutput=append:${join(context.state, "control-plane", "logs", "control-plane.log")}`,
      );
      expect(unit).toContain("Restart=on-failure");
      expect(units.calls).toEqual(
        expect.arrayContaining([
          "systemctl --user daemon-reload",
          "systemctl --user enable supertag-control-plane.service",
          "systemctl --user restart supertag-control-plane.service",
        ]),
      );
      expect(printed()).toContain("loginctl enable-linger $USER");
      await bringDown({ removeServices: true, services: units.environment });
      expect(units.calls).toContain(
        "systemctl --user disable --now supertag-control-plane.service",
      );
      await expect(
        bringUp({ services: { ...units.environment, platform: "win32" } }),
      ).rejects.toThrow("not supported on win32 yet");
    },
    TIMEOUT,
  );
});

describe("unit names", () => {
  it("label a service with the file's name only when it is not the default", () => {
    expect(unitName("supertag", "control-plane")).toEqual({
      label: "ai.supertag.control-plane",
      unit: "supertag-control-plane.service",
    });
    expect(unitName("acme", "laptop")).toEqual({
      label: "ai.supertag.acme.laptop",
      unit: "supertag-acme-laptop.service",
    });
  });

  it("down SERVICE removes the unit and state of a host service the file no longer names", async () => {
    await mkdir(join(context.state, "hosts", "old"), { recursive: true });
    const units = fakeServices(context, "darwin");
    const manager = serviceManager(units.environment);
    const unit = unitName(DEFAULT_INSTANCE_NAME, "old");
    await manager.install({
      name: unit,
      description: "host old",
      workingDirectory: context.state,
      command: ["/bin/sleep", "up", "--foreground", "old"],
      logFile: join(context.directory, "old.log"),
      environment: {},
    });
    await expect(bringDown({ names: ["old"], services: units.environment })).resolves.toBe(
      "not-running",
    );
    expect(await manager.installed(unit)).toBe(false);
    expect(printed()).toContain(
      `Removed the service unit for host service old (${manager.path(unit)}).`,
    );
    expect(printed()).toContain("Removed host service old from this machine");
    expect(printed()).not.toContain("is not running");
    await expect(stat(join(context.state, "hosts", "old"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("CLI routing", () => {
  it("lists the service commands in help and rejects unknown flags", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(printed()).toContain("supertag init [--yes]\n");
    expect(printed()).toContain(
      "supertag up [SERVICE...] [-f PATH...] [--foreground|--dry-run] [--force]\n",
    );
    expect(printed()).toContain(
      "supertag down [SERVICE...] [-f PATH...] [--remove-services] [--force]\n",
    );
    expect(printed()).toContain("supertag logs [-f] [SERVICE...]\n");
    expect(printed()).toContain("supertag ps [-f PATH...] [--output text|json]\n");
    expect(printed()).toContain("supertag config [-f PATH...] [--services]\n");
    expect(printed()).not.toContain("--background");
    context.output.length = 0;
    expect(await main(["up", "--help"])).toBe(0);
    expect(printed()).toContain("Brings up the services supertag.yaml defines");
    context.output.length = 0;
    expect(await main(["help", "ps"])).toBe(0);
    expect(printed()).toContain("Usage: supertag ps");
    context.output.length = 0;
    expect(await main(["connect", "worklet", "--help"])).toBe(0);
    expect(printed()).toContain("never supertag.yaml");
    await expect(main(["up", "--prune"])).rejects.toThrow(/Unknown option/);
    await expect(main(["up", "--foreground", "--dry-run"])).rejects.toThrow("cannot be combined");
    await expect(main(["up", "nope"])).rejects.toThrow(/nope is not a service in the defaults/);
    await expect(main(["logs", "--prune"])).rejects.toThrow(/Unknown option/);
  });

  it("prints a message when there are no logs yet", async () => {
    const lines: string[] = [];
    await showLogs({ write: (line) => lines.push(line) });
    expect(lines.join("")).toContain("No logs yet in");
  });
});
