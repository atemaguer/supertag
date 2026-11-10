import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "../apps/cli/src/action-command.js";
import { runAuthKeyCommand } from "../apps/cli/src/auth-keys.js";
import * as controlPlane from "../apps/cli/src/control-plane-client.js";
import { main } from "../apps/cli/src/index.js";
import * as worker from "../apps/cli/src/worker.js";
import {
  managementUrlFromWorkletUrl,
  resolveWorkletCredential,
} from "../apps/cli/src/worker-host-join.js";
import {
  revokeOwnWorkerHostCredential,
  storeWorkerHostCredential,
  workerHostCredentialPath,
  writeWorkerHostCredential,
} from "../apps/cli/src/worker-hosts.js";
import { workerHostNameCandidate, workerHostNameFromHostname } from "../packages/core/src/index.js";
import { FakeRpcError, fakeOperatorRpc } from "./support/fake-operator-rpc.js";

const CONTROL_PLANE = "https://control.example.com";
const AUTH_KEY = `stak_${"a".repeat(64)}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-auth-key-cli-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function joinResponse(workerHostId: string, ephemeral = false): Response {
  return Response.json({
    credential: {
      workerHostId,
      issuedAt: "2026-09-30T00:00:00Z",
      token: `token-for-${workerHostId}`,
    },
    authKey: "laptop",
    tags: ["builder"],
    ephemeral,
  });
}

describe("Auth Key commands", () => {
  it("routes the action-first commands", () => {
    expect(normalizeActionFirstCommand(["create", "auth-key", "ci", "--tag", "builder"])).toEqual([
      "auth-key",
      "create",
      "ci",
      "--tag",
      "builder",
    ]);
    expect(normalizeActionFirstCommand(["revoke", "auth-key", "ci"])).toEqual([
      "auth-key",
      "revoke",
      "ci",
    ]);
    expect(normalizeActionFirstCommand(["list", "auth-key"])).toEqual(["get", "auth-key"]);
    expect(normalizeActionFirstCommand(["get", "auth-key", "ci"])).toEqual([
      "get",
      "auth-key",
      "ci",
    ]);
  });

  it("lists the commands in help", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["--help"])).toBe(0);
    const help = write.mock.calls.map(([value]) => String(value)).join("");
    expect(help).toContain(
      "supertag create auth-key NAME --tag TAG [--tag TAG ...] [--label LABEL ...] [--reusable] [--ephemeral]",
    );
    expect(help).toContain("supertag revoke auth-key NAME");
    expect(help).toContain(
      "list tag|role|permission-set|context-set|volume|workspace|surface|worker-host|worker-profile|auth-key",
    );
    expect(help).toContain("[--auth-key KEY|file:PATH]");
    expect(help).toContain("enroll worker-host ID --out PATH");
    expect(help).not.toContain("configure worker-host");
    write.mockClear();
    expect(await main(["help", "create", "auth-key"])).toBe(0);
    expect(write.mock.calls.map(([value]) => String(value)).join("")).toContain(
      "revoking never removes hosts that already joined",
    );
  });

  it("creates a key through the operator API and prints the secret once", async () => {
    const rpc = fakeOperatorRpc({
      "HostService/CreateAuthKey": () => ({
        authKey: {
          metadata: { id: "k", name: "ci" },
          tags: ["builder", "reviewer"],
          reusable: true,
          ephemeral: true,
          phase: "AUTH_KEY_PHASE_ACTIVE",
          expiresAt: "2026-12-29T00:00:00Z",
        },
        secret: AUTH_KEY,
      }),
    });
    const client = { operator: { url: CONTROL_PLANE, token: "admin" } };
    const output = await runAuthKeyCommand(
      client,
      "create",
      ["ci", "--tag", "builder", "--tag", "reviewer", "--reusable", "--ephemeral"],
      CONTROL_PLANE,
    );
    expect(output.split(AUTH_KEY)).toHaveLength(2);
    expect(output).toContain(
      "Created Auth Key ci (reusable, ephemeral) for Tags builder, reviewer",
    );
    expect(output).toContain("It expires at 2026-12-29T00:00:00.000Z.");
    expect(output).toContain(
      `SUPERTAG_AUTH_KEY='<secret>' supertag connect worklet --transport websocket --worklet-url '${CONTROL_PLANE}' --harness codex`,
    );
    expect(rpc.called("HostService/CreateAuthKey")[0]?.body).toEqual({
      name: "ci",
      tags: ["builder", "reviewer"],
      reusable: true,
      ephemeral: true,
    });
    await expect(runAuthKeyCommand(client, "create", ["ci"], CONTROL_PLANE)).rejects.toThrow(
      "--tag TAG",
    );
    await expect(
      runAuthKeyCommand(client, "create", ["ci", "--tag", "x", "--expires", "1d"], CONTROL_PLANE),
    ).rejects.toThrow("Unknown option '--expires'");
  });

  it("revokes a key by name", async () => {
    const rpc = fakeOperatorRpc({
      "HostService/RevokeAuthKey": () => ({
        metadata: { name: "ci" },
        phase: "AUTH_KEY_PHASE_REVOKED",
        expiresAt: "2026-12-29T00:00:00Z",
      }),
    });
    await expect(
      runAuthKeyCommand(
        { operator: { url: CONTROL_PLANE, token: "admin" } },
        "revoke",
        ["ci"],
        CONTROL_PLANE,
      ),
    ).resolves.toContain("hosts that already joined keep their enrollment");
    expect(rpc.called("HostService/RevokeAuthKey")[0]?.body).toEqual({ name: "ci" });
  });

  it("routes revoke auth-key to the operator Control Plane", async () => {
    vi.spyOn(controlPlane, "resolveControlPlaneTarget").mockResolvedValue({
      url: CONTROL_PLANE,
      token: "operator",
    });
    const rpc = fakeOperatorRpc({
      "HostService/RevokeAuthKey": () => ({
        metadata: { name: "ci" },
        phase: "AUTH_KEY_PHASE_REVOKED",
        expiresAt: "2026-12-29T00:00:00Z",
      }),
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["revoke", "auth-key", "ci"])).toBe(0);
    expect(rpc.called("HostService/RevokeAuthKey")).toHaveLength(1);
  });

  it("passes the Auth Key and management URL to connect worklet", async () => {
    const run = vi.spyOn(worker, "runWorkletCommand").mockResolvedValue();
    vi.spyOn(controlPlane, "resolveControlPlaneUrl").mockResolvedValue("http://127.0.0.1:3434");
    expect(
      await main([
        "connect",
        "worklet",
        "--worklet-url",
        "http://127.0.0.1:3435",
        "--auth-key",
        AUTH_KEY,
      ]),
    ).toBe(0);
    expect(run).toHaveBeenLastCalledWith(
      ["--worklet-url", "http://127.0.0.1:3435", "--auth-key", AUTH_KEY],
      expect.objectContaining({ defaultManagementUrl: "http://127.0.0.1:3434" }),
    );
    // An explicit Worklet URL is not taken as the management API without a selection.
    expect(run.mock.lastCall?.[1]).not.toHaveProperty("managementUrl");

    vi.stubEnv("SUPERTAG_CONTROL_PLANE", CONTROL_PLANE);
    expect(
      await main(["connect", "worklet", "--worklet-url", "https://control.example.com:7443"]),
    ).toBe(0);
    expect(run.mock.lastCall?.[1]).toMatchObject({ managementUrl: "http://127.0.0.1:3434" });
  });
});

describe("Worklet credential resolution", () => {
  it("prefers a stored credential for this Control Plane and ignores the Auth Key", async () => {
    const state = await stateDirectory();
    await storeWorkerHostCredential(
      { workerHostId: "laptop", token: "stored", controlPlane: CONTROL_PLANE },
      state,
    );
    const request = vi.fn();
    await expect(
      resolveWorkletCredential({
        controlPlane: CONTROL_PLANE,
        authKey: AUTH_KEY,
        stateDirectory: state,
        fetch: request,
      }),
    ).resolves.toEqual({ workerHostId: "laptop", token: "stored", source: "stored" });
    expect(request).not.toHaveBeenCalled();
    // A credential for another Control Plane is not reused.
    await expect(
      resolveWorkletCredential({
        controlPlane: "https://other.example.com",
        stateDirectory: state,
      }),
    ).rejects.toThrow("--auth-key or SUPERTAG_AUTH_KEY");
  });

  it("redeems an Auth Key under the hostname and stores the credential for next time", async () => {
    const state = await stateDirectory();
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      joinResponse("build-01-2"),
    );
    const resolved = await resolveWorkletCredential({
      controlPlane: CONTROL_PLANE,
      authKey: AUTH_KEY,
      hostname: "Build-01.local",
      stateDirectory: state,
      fetch: request as unknown as typeof fetch,
    });
    expect(resolved).toMatchObject({
      workerHostId: "build-01-2",
      token: "token-for-build-01-2",
      source: "auth-key",
      notice: "Joined as Worker Host build-01-2 for Tags builder.",
    });
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${CONTROL_PLANE}/supertag.operator.v1.HostService/JoinWorkerHost`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${AUTH_KEY}`);
    const body = new TextDecoder().decode(init?.body as Uint8Array);
    expect(JSON.parse(body)).toEqual({ name: "build-01", idempotencyKey: expect.any(String) });
    const path = workerHostCredentialPath("build-01-2", state);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      workerHostId: "build-01-2",
      token: "token-for-build-01-2",
      controlPlane: CONTROL_PLANE,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // The next connect finds the stored credential without the key.
    await expect(
      resolveWorkletCredential({ controlPlane: CONTROL_PLANE, stateDirectory: state }),
    ).resolves.toMatchObject({ workerHostId: "build-01-2", source: "stored" });
  });

  it("retries a join whose answer was lost with the same idempotency key", async () => {
    const state = await stateDirectory();
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => {
      if (request.mock.calls.length === 1) throw new TypeError("fetch failed");
      return joinResponse("build-01");
    });
    await expect(
      resolveWorkletCredential({
        controlPlane: CONTROL_PLANE,
        authKey: AUTH_KEY,
        requestedWorkerHostId: "build-01",
        stateDirectory: state,
        fetch: request as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ workerHostId: "build-01", source: "auth-key" });
    const keys = request.mock.calls.map(
      ([, init]) => JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
  });

  it("keeps an ephemeral host's credential only in memory", async () => {
    const state = await stateDirectory();
    const resolved = await resolveWorkletCredential({
      controlPlane: CONTROL_PLANE,
      authKey: AUTH_KEY,
      requestedWorkerHostId: "ci",
      stateDirectory: state,
      fetch: (async () => joinResponse("ci", true)) as unknown as typeof fetch,
    });
    expect(resolved.notice).toContain("ephemeral Worker Host ci");
    await expect(stat(workerHostCredentialPath("ci", state))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a rejected Auth Key and rejects malformed keys before calling the API", async () => {
    const state = await stateDirectory();
    const request = vi.fn(async () =>
      Response.json(
        { code: "permission_denied", message: "Auth Key has expired; ask for a new key" },
        { status: 403 },
      ),
    );
    await expect(
      resolveWorkletCredential({
        controlPlane: CONTROL_PLANE,
        authKey: AUTH_KEY,
        stateDirectory: state,
        fetch: request as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Joining with the Auth Key failed: Auth Key has expired");
    await expect(
      resolveWorkletCredential({
        controlPlane: CONTROL_PLANE,
        authKey: AUTH_KEY,
        stateDirectory: state,
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(
      `Could not reach the Control Plane management API at ${CONTROL_PLANE} to join`,
    );
    request.mockClear();
    await expect(
      resolveWorkletCredential({
        controlPlane: CONTROL_PLANE,
        authKey: "tskey-wrong",
        stateDirectory: state,
        fetch: request as unknown as typeof fetch,
      }),
    ).rejects.toThrow("malformed");
    expect(request).not.toHaveBeenCalled();
  });

  it("enrolls the host with operator credentials for the same Control Plane", async () => {
    const state = await stateDirectory();
    const rpc = fakeOperatorRpc({
      "HostService/EnrollWorkerHost": (body) => {
        if (body["id"] === "laptop")
          throw new FakeRpcError("already_exists", "Worker Host is already enrolled", 409);
        return {
          workerHostId: "laptop-2",
          issuedAt: "2026-09-30T00:00:00Z",
          token: "operator-issued",
        };
      },
    });
    const resolved = await resolveWorkletCredential({
      controlPlane: "http://127.0.0.1:3434",
      hostname: "laptop",
      operatorTarget: async () => ({ url: "http://localhost:3434", token: "admin" }),
      stateDirectory: state,
    });
    expect(resolved).toMatchObject({ workerHostId: "laptop-2", source: "operator" });
    expect(resolved.notice).toContain("supertag update tag TAG --add-worker-host laptop-2");
    expect(rpc.called("HostService/EnrollWorkerHost").map((call) => call.body["id"])).toEqual([
      "laptop",
      "laptop-2",
    ]);
    expect(await readFile(workerHostCredentialPath("laptop-2", state), "utf8")).toContain(
      "operator-issued",
    );
    // Operator credentials for a different Control Plane are not used.
    await expect(
      resolveWorkletCredential({
        controlPlane: CONTROL_PLANE,
        operatorTarget: async () => ({ url: "https://other.example.com", token: "admin" }),
        stateDirectory: await stateDirectory(),
      }),
    ).rejects.toThrow("Ask an operator for an Auth Key");
  });

  it("guards stored credentials", async () => {
    const state = await stateDirectory();
    await storeWorkerHostCredential(
      { workerHostId: "a", token: "one", controlPlane: CONTROL_PLANE },
      state,
    );
    await storeWorkerHostCredential(
      { workerHostId: "b", token: "two", controlPlane: CONTROL_PLANE },
      state,
    );
    await expect(
      resolveWorkletCredential({ controlPlane: CONTROL_PLANE, stateDirectory: state }),
    ).rejects.toThrow("Choose one with --worker-host ID");
    await expect(
      resolveWorkletCredential({
        controlPlane: CONTROL_PLANE,
        requestedWorkerHostId: "b",
        stateDirectory: state,
      }),
    ).resolves.toMatchObject({ workerHostId: "b", token: "two" });
    await expect(
      resolveWorkletCredential({
        controlPlane: "https://other.example.com",
        requestedWorkerHostId: "b",
        stateDirectory: state,
      }),
    ).rejects.toThrow("belongs to https://control.example.com");
  });

  it("derives Worker Host names and the management URL", () => {
    expect(workerHostNameFromHostname("Build-01.local")).toBe("build-01");
    expect(workerHostNameFromHostname("  My Laptop!!  ")).toBe("my-laptop");
    expect(workerHostNameFromHostname("___")).toBe("worker-host");
    expect(workerHostNameFromHostname("x".repeat(80))).toHaveLength(63);
    expect(workerHostNameCandidate("laptop", 1)).toBe("laptop");
    expect(workerHostNameCandidate("laptop", 3)).toBe("laptop-3");
    expect(workerHostNameCandidate("x".repeat(63), 12)).toHaveLength(63);
    expect(managementUrlFromWorkletUrl("wss://control.example.com/worklets")).toBe(CONTROL_PLANE);
    expect(managementUrlFromWorkletUrl("http://127.0.0.1:3434")).toBe("http://127.0.0.1:3434");
  });
});

/** `RevokeWorkerHostCredential`'s answer for a host that revoked itself. */
function revokedHost(id: string): Response {
  return Response.json({ metadata: { id, name: id }, revocationReason: "SelfRevoked" });
}

describe("Worker Host self-revocation", () => {
  it("reports a credential the Control Plane no longer accepts and keeps the file", async () => {
    const state = await stateDirectory();
    await storeWorkerHostCredential(
      { workerHostId: "laptop", token: "host-secret", controlPlane: CONTROL_PLANE },
      state,
    );
    const refused = (async () =>
      Response.json(
        { code: "unauthenticated", message: "A valid credential is required" },
        { status: 401 },
      )) as unknown as typeof fetch;
    await expect(revokeOwnWorkerHostCredential(["laptop"], refused, state)).rejects.toThrow(
      "The stored credential for Worker Host laptop is no longer accepted",
    );
    await expect(stat(workerHostCredentialPath("laptop", state))).resolves.toBeDefined();
  });

  it("revokes with the stored credential and removes it", async () => {
    const state = await stateDirectory();
    await storeWorkerHostCredential(
      { workerHostId: "laptop", token: "host-secret", controlPlane: CONTROL_PLANE },
      state,
    );
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      revokedHost("laptop"),
    );
    await expect(
      revokeOwnWorkerHostCredential(["laptop"], request as unknown as typeof fetch, state),
    ).resolves.toContain("Revoked Worker Host laptop with its own credential");
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `${CONTROL_PLANE}/supertag.operator.v1.HostService/RevokeWorkerHostCredential`,
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer host-secret");
    expect(new Headers(init?.headers).get("x-supertag-worker-host-id")).toBe("laptop");
    expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
      id: "laptop",
    });
    await expect(stat(workerHostCredentialPath("laptop", state))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      revokeOwnWorkerHostCredential(["laptop"], request as never, state),
    ).rejects.toThrow("no joined credential for Worker Host laptop");
  });

  it("finds a host service's credential under hosts/SERVICE/", async () => {
    const state = await stateDirectory();
    await writeWorkerHostCredential(join(state, "hosts", "laptop", "credential.json"), {
      version: 1,
      workerHostId: "laptop-2",
      token: "service-secret",
      controlPlane: CONTROL_PLANE,
    });
    await writeWorkerHostCredential(join(state, "hosts", "other", "credential.json"), {
      version: 1,
      workerHostId: "other",
      token: "other-secret",
      controlPlane: CONTROL_PLANE,
    });
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      revokedHost("laptop-2"),
    );
    const message = await revokeOwnWorkerHostCredential(
      ["laptop-2"],
      request as unknown as typeof fetch,
      state,
    );
    expect(message).toContain("Revoked Worker Host laptop-2 with its own credential");
    expect(message).toContain("Host service laptop can no longer connect");
    const [, init] = request.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-secret");
    expect(new Headers(init?.headers).get("x-supertag-worker-host-id")).toBe("laptop-2");
    await expect(stat(join(state, "hosts", "laptop", "credential.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(state, "hosts", "other", "credential.json"))).resolves.toBeDefined();
    await expect(
      revokeOwnWorkerHostCredential(["laptop-2"], request as never, state),
    ).rejects.toThrow("no joined credential for Worker Host laptop-2");
  });

  it("falls back to self-revocation when no operator credentials exist", async () => {
    const state = await stateDirectory();
    vi.stubEnv("SUPERTAG_STATE_DIR", state);
    vi.spyOn(controlPlane, "resolveControlPlaneTarget").mockResolvedValue(undefined);
    await storeWorkerHostCredential({
      workerHostId: "laptop",
      token: "host-secret",
      controlPlane: CONTROL_PLANE,
    });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(revokedHost("laptop"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["revoke", "worker-host-credential", "laptop"])).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("Auth Key input", () => {
  it("reads file:PATH like Tailscale and passes plain keys through", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-auth-key-file-"));
    try {
      const file = join(directory, "key");
      await writeFile(file, "stak_abc\n", { mode: 0o600 });
      await expect(worker.readAuthKey(`file:${file}`)).resolves.toBe("stak_abc");
      await expect(worker.readAuthKey("stak_plain")).resolves.toBe("stak_plain");
      await expect(worker.readAuthKey(undefined)).resolves.toBeUndefined();
      await writeFile(file, "\n");
      await expect(worker.readAuthKey(`file:${file}`)).rejects.toThrow(/empty/);
      await expect(worker.readAuthKey("file:")).rejects.toThrow(/requires a path/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
