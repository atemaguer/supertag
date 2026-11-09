import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPERTAG_BUILD_IDENTITY } from "../apps/cli/src/build-identity.ts";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import {
  assessVersionSkew,
  compareVersions,
  parseVersion,
  resetVersionSkewWarning,
  SUPERTAG_VERSION,
  versionMismatchHint,
  versionSkewWarning,
  versionWarningSuppressed,
} from "../apps/cli/src/version.ts";
import { migrateSqlite } from "./support/database.ts";

const ADMIN = "version-skew-admin";
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-version-skew-"));
  // Keep saved connections and project files on this machine out of the tests.
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "state"));
  vi.stubEnv("INIT_CWD", directory);
  vi.stubEnv("SUPERTAG_CONTROL_PLANE", "");
  vi.stubEnv("SUPERTAG_NO_VERSION_WARNING", "");
  vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", ADMIN);
  resetVersionSkewWarning();
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function captureStderr(): () => string {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return () => write.mock.calls.map(([value]) => String(value)).join("");
}

function captureStdout(): () => string {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => write.mock.calls.map(([value]) => String(value)).join("");
}

/** Versions at each distance from this CLI, derived so the tests follow release bumps. */
function skewedVersions() {
  const cli = parseVersion(SUPERTAG_VERSION);
  if (cli === undefined) throw new Error(`Unparseable CLI version ${SUPERTAG_VERSION}`);
  const base = `${cli.major}.${cli.minor}.${cli.patch}`;
  return {
    same: SUPERTAG_VERSION,
    prerelease: `${base}-skewtest.1`,
    minor: `${cli.major}.${cli.minor + 2}.0`,
    major: `${cli.major + 1}.0.0`,
  };
}

interface FakeControlPlane {
  readonly url: string;
  readonly requests: IncomingHttpHeaders[];
}

/** A Control Plane stand-in that reports any version, or none, and answers with a fixed reply. */
async function fakeControlPlane(
  version: string | undefined,
  reply: { readonly status: number; readonly body: unknown } = {
    status: 200,
    body: { apiVersion: "supertag/v1", kind: "List", items: [] },
  },
): Promise<FakeControlPlane> {
  const requests: IncomingHttpHeaders[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.headers);
    if (version !== undefined) response.setHeader("SuperTag-Version", version);
    const body = request.url === "/healthz" ? { ok: true } : reply.body;
    response.writeHead(request.url === "/healthz" ? 200 : reply.status, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function realControlPlane(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-version-skew-server-"));
  const databasePath = join(directory, "server.db");
  await migrateSqlite(databasePath);
  const runtime = await startControlPlaneRuntime({
    host: "127.0.0.1",
    port: 0,
    databaseUrl: `file:${databasePath}`,
    adminToken: ADMIN,
    coordinationOperatorCredentials: [],
    stateDirectory: join(directory, "server"),
    reply: async () => {},
  });
  cleanups.push(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return runtime.url;
}

describe("the version skew policy", () => {
  it.each([
    ["0.2.0-alpha.1", "0.2.0-alpha.1", "none", "supported"],
    ["0.2.0", "0.2.1", "patch", "supported"],
    ["0.2.0-alpha.1", "0.2.0-alpha.2", "prerelease", "supported-with-warning"],
    ["0.2.0", "0.2.0-alpha.2", "prerelease", "supported-with-warning"],
    ["0.2.0-alpha.1", "0.2.1", "prerelease", "supported-with-warning"],
    ["0.3.0", "0.2.0-alpha.1", "minor", "unsupported"],
    ["1.3.0", "1.2.4", "minor", "supported-with-warning"],
    ["1.2.0", "1.3.0", "minor", "supported-with-warning"],
    ["1.4.0", "1.2.0", "minor", "unsupported"],
    ["2.0.0", "1.9.0", "major", "unsupported"],
    ["0.2.0", "not-a-version", "unknown", "unknown"],
  ])("classifies CLI %s with Control Plane %s as %s", (cli, controlPlane, skew, support) => {
    expect(assessVersionSkew(cli, controlPlane)).toEqual({ skew, support });
  });

  it("cannot judge a Control Plane that does not report its version", () => {
    expect(assessVersionSkew("0.2.0", undefined)).toEqual({ skew: "unknown", support: "unknown" });
    expect(versionSkewWarning("0.2.0", undefined)).toBeUndefined();
  });

  it("orders versions by semantic version precedence", () => {
    expect(compareVersions("0.2.0-alpha.1", "0.2.0-alpha.2")).toBe(-1);
    expect(compareVersions("0.2.0-alpha.10", "0.2.0-alpha.2")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0-alpha.2")).toBe(1);
    expect(compareVersions("0.3.0", "0.2.9")).toBe(1);
    expect(compareVersions("1.0.0+build.1", "1.0.0")).toBe(0);
  });

  it("warns only outside the same version, and advises upgrading the older side", () => {
    expect(versionSkewWarning("0.2.0-alpha.1", "0.2.0-alpha.1")).toBeUndefined();
    expect(versionSkewWarning("0.2.0", "0.2.1")).toBeUndefined();
    expect(versionSkewWarning("0.2.0-alpha.2", "0.2.0-alpha.1")).toBe(
      "Warning: this CLI is 0.2.0-alpha.2 but the Control Plane is 0.2.0-alpha.1. Some commands may fail; upgrade the Control Plane or use a matching CLI.\n",
    );
    expect(versionSkewWarning("0.3.0", "0.2.0-alpha.1")).toBe(
      "Warning: this CLI is 0.3.0 but the Control Plane is 0.2.0-alpha.1, and SuperTag does not support this pair. Commands may fail; upgrade the Control Plane or use a matching CLI.\n",
    );
    expect(versionSkewWarning("0.2.0", "1.0.0")).toContain(
      "upgrade the CLI or use one that matches the Control Plane",
    );
  });

  it("hints at a mismatch only when the versions differ", () => {
    expect(versionMismatchHint("0.3.0", "0.3.0")).toBeUndefined();
    expect(versionMismatchHint("0.3.0", "0.2.0-alpha.1")).toBe(
      "Hint: this CLI is 0.3.0 but the Control Plane is 0.2.0-alpha.1, which may not support this request. Upgrade the Control Plane or use a matching CLI.",
    );
    expect(versionMismatchHint("0.3.0", undefined)).toContain("does not report its version");
  });

  it("is silenced by SUPERTAG_NO_VERSION_WARNING", () => {
    expect(versionWarningSuppressed({})).toBe(false);
    expect(versionWarningSuppressed({ SUPERTAG_NO_VERSION_WARNING: "0" })).toBe(false);
    expect(versionWarningSuppressed({ SUPERTAG_NO_VERSION_WARNING: "1" })).toBe(true);
    expect(versionWarningSuppressed({ SUPERTAG_NO_VERSION_WARNING: "true" })).toBe(true);
  });
});

describe("the Control Plane version header", () => {
  it("is on every response, including refusals, and /healthz reports only the version", async () => {
    const url = await realControlPlane();
    const health = await fetch(`${url}/healthz`);
    expect(health.headers.get("SuperTag-Version")).toBe(SUPERTAG_VERSION);
    await expect(health.json()).resolves.toEqual({
      ok: true,
      version: SUPERTAG_VERSION,
      buildIdentity: SUPERTAG_BUILD_IDENTITY,
    });
    for (const [path, init, status] of [
      ["/readyz", {}, 200],
      [
        "/supertag.operator.v1.OrganizationService/GetStatus",
        {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
          body: "{}",
        },
        200,
      ],
      [
        "/supertag.operator.v1.OrganizationService/GetStatus",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        401,
      ],
      ["/api/v1/no-such-route", { headers: { authorization: `Bearer ${ADMIN}` } }, 404],
      ["/no-such-page", {}, 404],
    ] as const) {
      const response = await fetch(`${url}${path}`, init);
      expect({ path, status: response.status }).toEqual({ path, status });
      expect(response.headers.get("SuperTag-Version")).toBe(SUPERTAG_VERSION);
    }
  });

  it("names the unknown fields it rejects", async () => {
    const url = await realControlPlane();
    const response = await fetch(`${url}/api/v1/tag-messaging/teams`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "launch", memberTagIds: [], rocket: 1 }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("SuperTag-Version")).toBe(SUPERTAG_VERSION);
    expect(await response.json()).toMatchObject({ message: "Unknown field: rocket" });
  });
});

describe("the CLI against a Control Plane", () => {
  it("sends its version on every request", async () => {
    const server = await fakeControlPlane(SUPERTAG_VERSION);
    const client = new ControlPlaneClient({ url: server.url, token: ADMIN });
    await client.listTags();
    await client.request("/api/v1/worker-hosts");
    expect(server.requests.map((headers) => headers["supertag-client-version"])).toEqual([
      SUPERTAG_VERSION,
      SUPERTAG_VERSION,
    ]);
  });

  it.each([
    ["same", false],
    ["prerelease", true],
    ["minor", true],
    ["major", true],
  ] as const)("warns for a %s version difference: %s", async (distance, warns) => {
    const version = skewedVersions()[distance];
    const server = await fakeControlPlane(version);
    const stderr = captureStderr();
    await new ControlPlaneClient({ url: server.url, token: ADMIN }).listTags();
    if (warns)
      expect(stderr()).toContain(
        `Warning: this CLI is ${SUPERTAG_VERSION} but the Control Plane is ${version}`,
      );
    else expect(stderr()).toBe("");
  });

  it("warns at most once per command", async () => {
    const server = await fakeControlPlane(skewedVersions().major);
    const stderr = captureStderr();
    const client = new ControlPlaneClient({ url: server.url, token: ADMIN });
    await client.listTags();
    await client.listTags();
    expect(stderr().match(/Warning:/gu)).toHaveLength(1);

    captureStdout();
    expect(await main(["--control-plane", server.url, "list", "tag"])).toBe(0);
    expect(await main(["--control-plane", server.url, "list", "tag"])).toBe(0);
    // Each command starts fresh, so two more commands print two more warnings.
    expect(stderr().match(/Warning:/gu)).toHaveLength(3);
  });

  it("stays quiet with SUPERTAG_NO_VERSION_WARNING=1", async () => {
    vi.stubEnv("SUPERTAG_NO_VERSION_WARNING", "1");
    const server = await fakeControlPlane(skewedVersions().major);
    const stderr = captureStderr();
    captureStdout();
    expect(await main(["--control-plane", server.url, "list", "tag"])).toBe(0);
    expect(stderr()).toBe("");
  });

  it("names both versions when a different Control Plane rejects a request", async () => {
    vi.stubEnv("SUPERTAG_NO_VERSION_WARNING", "1");
    const older = "0.1.0";
    const rejected = { status: 400, body: { error: "bad", message: "Unknown field: start" } };
    const skewed = await fakeControlPlane(older, rejected);
    const error = await new ControlPlaneClient({ url: skewed.url, token: ADMIN })
      .listTags()
      .catch((caught: unknown) => caught as Error);
    expect(error.message).toBe(
      `Unknown field: start\nHint: this CLI is ${SUPERTAG_VERSION} but the Control Plane is ${older}, which may not support this request. ${
        compareVersions(SUPERTAG_VERSION, older) === -1
          ? "Upgrade the CLI or use one that matches the Control Plane"
          : "Upgrade the Control Plane or use a matching CLI"
      }.`,
    );

    const unversioned = await fakeControlPlane(undefined, {
      status: 404,
      body: { message: "Admin route not found" },
    });
    await expect(
      new ControlPlaneClient({ url: unversioned.url, token: ADMIN }).listTags(),
    ).rejects.toThrow("the Control Plane does not report its version");

    const matching = await fakeControlPlane(SUPERTAG_VERSION, rejected);
    await expect(
      new ControlPlaneClient({ url: matching.url, token: ADMIN }).listTags(),
    ).rejects.toThrow(/^Unknown field: start$/u);

    const missing = await fakeControlPlane(older, {
      status: 404,
      body: { message: "Task does not exist" },
    });
    await expect(
      new ControlPlaneClient({ url: missing.url, token: ADMIN }).listTags(),
    ).rejects.toThrow(/^Task does not exist$/u);
  });
});

describe("supertag version", () => {
  it("keeps --version to the CLI version alone", async () => {
    const stdout = captureStdout();
    expect(await main(["--version"])).toBe(0);
    expect(stdout()).toBe(`${SUPERTAG_VERSION}\n`);
  });

  it("prints both versions and whether the pair is supported", async () => {
    const url = await realControlPlane();
    const stdout = captureStdout();
    expect(await main(["--control-plane", url, "version"])).toBe(0);
    expect(stdout()).toBe(
      `CLI version: ${SUPERTAG_VERSION}\nCLI build: ${SUPERTAG_BUILD_IDENTITY}\nControl Plane: ${url}\nControl Plane version: ${SUPERTAG_VERSION}\nControl Plane build: ${SUPERTAG_BUILD_IDENTITY}\nCompatibility: supported (same version)\n`,
    );
  });

  it("prints JSON, including an unsupported pair", async () => {
    const version = skewedVersions().major;
    const server = await fakeControlPlane(version);
    const stdout = captureStdout();
    const stderr = captureStderr();
    expect(await main(["--control-plane", server.url, "version", "--output", "json"])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      cli: { version: SUPERTAG_VERSION, buildIdentity: SUPERTAG_BUILD_IDENTITY },
      controlPlane: {
        url: server.url,
        reachable: true,
        version,
        skew: "major",
        support: "unsupported",
      },
    });
    // The version needs no credential, and the command reports skew instead of warning.
    expect(server.requests[0]?.authorization).toBeUndefined();
    expect(stderr()).toBe("");
  });

  it("reports a Control Plane that predates version reporting", async () => {
    const server = await fakeControlPlane(undefined);
    const stdout = captureStdout();
    expect(await main(["--control-plane", server.url, "version"])).toBe(0);
    expect(stdout()).toContain("Control Plane version: unknown (it predates version reporting)");
    expect(stdout()).toContain("Compatibility: unknown");
  });

  it("still prints the CLI version without a reachable Control Plane", async () => {
    const server = await fakeControlPlane(SUPERTAG_VERSION);
    const url = server.url;
    await cleanups.pop()?.();
    const stdout = captureStdout();
    expect(await main(["--control-plane", url, "version"])).toBe(0);
    expect(stdout()).toMatch(
      new RegExp(
        `^CLI version: ${SUPERTAG_VERSION.replaceAll(".", "\\.")}\\nCLI build: ${SUPERTAG_BUILD_IDENTITY}\\nControl Plane: ${url} \\(not reachable`,
        "u",
      ),
    );
    vi.restoreAllMocks();
    const json = captureStdout();
    expect(await main(["--control-plane", url, "version", "-o", "json"])).toBe(0);
    expect(JSON.parse(json())).toMatchObject({
      cli: { version: SUPERTAG_VERSION, buildIdentity: SUPERTAG_BUILD_IDENTITY },
      controlPlane: { url, reachable: false },
    });
  });
});
