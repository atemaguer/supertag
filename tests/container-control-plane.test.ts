import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  controlPlaneSlot,
  type ProcessStatus,
  readStatus,
  runningProcess,
} from "../apps/cli/src/local-state.ts";
import { bringUp, type UpOptions } from "../apps/cli/src/up.ts";
import { DEPLOYMENT_RUNTIME } from "../deploy/shared/src/index.ts";
import { inspectDatabaseMigrationReadiness, migrateDatabase } from "../packages/store/src/index.js";
import { getResource, listResources } from "./support/resources.ts";
import {
  CLI,
  fakeServices,
  freePort,
  TIMEOUT,
  useServicesContext,
  writeServices,
} from "./support/services.ts";

// A hosting platform's environment check needs PostgreSQL, an HTTPS coordination origin, and the
// state volume at /var/lib/supertag, none of which a test machine has. A test that sets `relaxed`
// keeps the platform's defaults and skips that check; everything else SUPERTAG_DEPLOYMENT_PLATFORM
// changes in supertag up (the platform's PORT, no migration at startup) still applies.
const platformCheck = vi.hoisted(() => ({ relaxed: false }));
vi.mock("../apps/cli/node_modules/@supertag/deployment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../deploy/shared/src/index.ts")>();
  return {
    ...actual,
    resolveDeploymentEnvironment: (
      platform: Parameters<typeof actual.resolveDeploymentEnvironment>[0],
      supplied: Parameters<typeof actual.resolveDeploymentEnvironment>[1],
    ) => {
      if (!platformCheck.relaxed) return actual.resolveDeploymentEnvironment(platform, supplied);
      const env = actual.deploymentDefaults(platform);
      for (const key of actual.DEPLOYMENT_ENVIRONMENT_KEYS) {
        const value = supplied[key]?.trim();
        if (value) env[key] = value;
      }
      return env;
    },
  };
});
afterEach(() => {
  platformCheck.relaxed = false;
});

// What a container runs: `supertag up --foreground control-plane`, with SUPERTAG_STATE_DIR on the
// state volume and an optional supertag.yaml mounted or baked into it.
const context = useServicesContext();
const ADMIN_TOKEN = "container-admin-token";

/** Stands in for a hosting platform whose release step has migrated the database. */
async function onHostingPlatform(): Promise<number> {
  const port = await freePort();
  platformCheck.relaxed = true;
  vi.stubEnv("SUPERTAG_DEPLOYMENT_PLATFORM", "railway");
  vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
  vi.stubEnv("PORT", String(port));
  vi.stubEnv("SUPERTAG_ADMIN_TOKEN", ADMIN_TOKEN);
  await mkdir(context.state, { recursive: true });
  await migrateDatabase({ url: `file:${join(context.state, "supertag.db")}` });
  return port;
}

const provisioned = (...names: string[]) => `services:
  control-plane:
    type: control-plane
    provision:
${names
  .map(
    (name) => `      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: ${name} }
        spec: {}
`,
  )
  .join("")}`;

async function untilReady(): Promise<ProcessStatus> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = await readStatus(controlPlaneSlot());
    if (status?.state === "ready") return status;
    if (status?.state === "failed") throw new Error(status.error);
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("not ready");
}

/** Runs the container command in this process until ready, hands its status to `check`, then stops it. */
async function containerCommand(
  check: (status: ProcessStatus) => Promise<void>,
  options: Partial<UpOptions> = {},
): Promise<void> {
  const controller = new AbortController();
  const running = bringUp({
    foreground: true,
    names: ["control-plane"],
    signal: controller.signal,
    ...options,
  });
  try {
    await check(
      await Promise.race([
        untilReady(),
        running.then(() => {
          throw new Error("stopped early");
        }),
      ]),
    );
  } finally {
    controller.abort();
    await running;
  }
}

/** A Tag of the Control Plane at `url`, read with the admin token. */
function adminResource(url: string, name: string): Promise<{ readonly metadata: unknown }> {
  return getResource({ operator: { url, token: ADMIN_TOKEN } }, "tags", name);
}

describe("the container command, supertag up --foreground control-plane", () => {
  it(
    "reads a supertag.yaml in the state directory, takes the admin token from the environment, and installs no unit",
    async () => {
      const port = await freePort();
      vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", ADMIN_TOKEN);
      await writeServices(
        context,
        `name: acme
services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:${port}"]
    restart: unless-stopped
    notify: slack:C0123456789
`,
      );
      const services = fakeServices(context, "linux");
      await containerCommand(
        async (status) => {
          expect(status).toMatchObject({
            mode: "foreground",
            instance: "acme",
            url: `http://127.0.0.1:${port}`,
            resolved: { notify: "slack:C0123456789", restart: "unless-stopped" },
          });
          await expect(
            listResources(
              { operator: { url: `http://127.0.0.1:${port}`, token: ADMIN_TOKEN } },
              "tags",
            ),
          ).resolves.toMatchObject({ kind: "ResourceList" });
        },
        { services: services.environment },
      );
      // Foreground never installs or starts a service unit, whatever restart says.
      expect(services.calls).toEqual([]);
      await expect(
        stat(join(context.directory, "home", ".config", "systemd", "user")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // With SUPERTAG_ADMIN_TOKEN set, no local operator credential is generated.
      const vault = await readFile(join(context.state, "credentials.json"), "utf8").catch(() => "");
      expect(vault).not.toContain("local-admin");
      expect(context.printed()).toContain("Stopped.");
    },
    TIMEOUT,
  );

  it(
    "lets environment variables override the file, including the bind address",
    async () => {
      const filePort = await freePort();
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", ADMIN_TOKEN);
      // As the image sets it; SUPERTAG_GATEWAY_PORT=0 stands in for the platform's port.
      vi.stubEnv("SUPERTAG_GATEWAY_HOST", "0.0.0.0");
      vi.stubEnv("SUPERTAG_GATEWAY_PORT", "0");
      vi.stubEnv("SUPERTAG_OPERATOR_CHANNEL", "slack:C0000000002");
      await writeServices(
        context,
        `services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:${filePort}"]
    notify: slack:C0123456789
`,
      );
      await containerCommand(async (status) => {
        expect(status.resolved).toMatchObject({
          ports: { host: "0.0.0.0", port: 0 },
          notify: "slack:C0000000002",
        });
        const port = Number(new URL(status.url ?? "").port);
        expect(port).not.toBe(filePort);
        expect(
          (
            await fetch(`http://127.0.0.1:${port}/healthz`, {
              headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
            })
          ).ok,
        ).toBe(true);
      });
    },
    TIMEOUT,
  );

  it(
    "starts over a pid file that names its own pid, as a restarted container finds",
    async () => {
      await mkdir(join(context.state, "control-plane"), { recursive: true });
      await writeFile(join(context.state, "control-plane", "pid"), `${process.pid}\n`);
      await containerCommand(async (status) => {
        expect(status.pid).toBe(process.pid);
      });
      await expect(stat(join(context.state, "control-plane", "pid"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    TIMEOUT,
  );

  it(
    "never migrates the database on a hosting platform, which migrates in its release step",
    async () => {
      vi.stubEnv("SUPERTAG_DEPLOYMENT_PLATFORM", "railway");
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", ADMIN_TOKEN);
      await expect(bringUp({ foreground: true, names: ["control-plane"] })).rejects.toThrow();
      const readiness = await inspectDatabaseMigrationReadiness({
        url: `file:${join(context.state, "supertag.db")}`,
      });
      expect(readiness.state).not.toBe("current");
    },
    TIMEOUT,
  );

  it(
    "provisions on a hosting platform once the Control Plane is healthy, creating only what is missing",
    async () => {
      const port = await onHostingPlatform();
      await writeServices(context, provisioned("lead"));
      let lead: unknown;
      await containerCommand(async (status) => {
        expect(status).toMatchObject({ mode: "foreground", url: `http://127.0.0.1:${port}` });
        lead = (await adminResource(status.url ?? "", "lead")).metadata;
        expect(context.printed().match(/Tag\/lead created \(provision\)/g)).toHaveLength(1);
      });
      // The platform migrates in its release step, never the Control Plane at startup.
      expect(context.printed()).not.toContain("SuperTag database schema updated.");
      expect(context.printed().indexOf("Tag/lead created (provision)")).toBeLessThan(
        context.printed().indexOf("Press Ctrl-C to stop."),
      );

      // A restarted container provisions again: new entries are created, existing ones kept.
      await writeServices(context, provisioned("lead", "helper"));
      context.output.length = 0;
      await containerCommand(async (status) => {
        await expect(adminResource(status.url ?? "", "helper")).resolves.toBeDefined();
        expect((await adminResource(status.url ?? "", "lead")).metadata).toEqual(lead);
        expect(context.printed().match(/Tag\/helper created \(provision\)/g)).toHaveLength(1);
        expect(context.printed()).not.toContain("Tag/lead created");
      });
    },
    TIMEOUT,
  );

  it(
    "reports a provisioning failure on a hosting platform and stops before it reports ready",
    async () => {
      const port = await onHostingPlatform();
      await writeServices(
        context,
        `services:
  control-plane:
    type: control-plane
    provision: [missing-manifests]
`,
      );
      await expect(bringUp({ foreground: true, names: ["control-plane"] })).rejects.toThrow(
        /missing-manifests/,
      );
      const status = await readStatus(controlPlaneSlot());
      expect(status).toMatchObject({ state: "failed", error: expect.stringMatching(/missing/) });
      expect((await runningProcess(controlPlaneSlot())).pid).toBeUndefined();
      await expect(stat(join(context.state, "control-plane", "pid"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      // The API stopped listening, so the platform's health check fails too.
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
      expect(context.printed()).not.toContain("Press Ctrl-C to stop.");
    },
    TIMEOUT,
  );

  it(
    "stops cleanly on SIGTERM, as platforms stop containers",
    async () => {
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", ADMIN_TOKEN);
      const [program, ...prefix] = CLI;
      if (program === undefined) throw new Error("no CLI");
      const child = spawn(program, [...prefix, "up", "--foreground", "control-plane"], {
        cwd: context.directory,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output: string[] = [];
      child.stdout.on("data", (chunk) => output.push(String(chunk)));
      child.stderr.on("data", (chunk) => output.push(String(chunk)));
      const exited = new Promise<number | null>((done) => child.once("exit", done));
      try {
        const status = await untilReady();
        expect(status.pid).toBe(child.pid);
        child.kill("SIGTERM");
        expect(await exited).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      expect(output.join("")).toContain("Stopped.");
      await expect(stat(join(context.state, "control-plane", "pid"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    TIMEOUT,
  );
});

describe("the container images and templates", () => {
  it("all run the container command", async () => {
    const command = DEPLOYMENT_RUNTIME.startCommand.split(" ");
    expect(command).toEqual(["node", "dist/index.js", "up", "--foreground", "control-plane"]);
    for (const dockerfile of ["deploy/docker/Dockerfile"]) {
      const text = await readFile(dockerfile, "utf8");
      expect(text).toContain(`CMD ${JSON.stringify(command).replaceAll(",", ", ")}`);
      expect(text).toContain(`ENV SUPERTAG_STATE_DIR=${DEPLOYMENT_RUNTIME.stateDirectory}`);
      expect(text).toContain("ENV SUPERTAG_GATEWAY_HOST=0.0.0.0");
    }
    expect(await readFile("deploy/compose.yaml", "utf8")).toContain(
      `command: ${JSON.stringify(command).replaceAll(",", ", ")}`,
    );
  });
});
