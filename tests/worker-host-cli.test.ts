import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../apps/cli/src/index.ts";
import {
  isWorkerHostCommand,
  runWorkerHostOperation,
  workerHostCredentialPath,
} from "../apps/cli/src/worker-hosts.ts";

describe("Worker Host operator commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the complete command inventory in help", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["help", "enroll", "worker-host"])).resolves.toBe(0);

    expect(output.join("\n")).toContain("enroll worker-host ID --out PATH");
    expect(output.join("\n")).not.toContain("configure worker-host");
    expect(output.join("\n")).toContain("rotate worker-host-credential ID --out PATH");
    expect(output.join("\n")).toContain("revoke worker-host-credential ID");
    expect(isWorkerHostCommand("enroll")).toBe(true);
    expect(isWorkerHostCommand("configure")).toBe(false);
    expect(isWorkerHostCommand("rotate-credential")).toBe(true);
    expect(isWorkerHostCommand("revoke")).toBe(true);
  });

  it.each([
    ["enroll" as const, "/api/v1/worker-hosts"],
    ["rotate-credential" as const, "/api/v1/worker-hosts/host-a/credential"],
  ])("%s writes the credential once without printing the secret", async (command, path) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-worker-host-credential-"));
    const stateDirectory = join(directory, ".supertag");
    vi.stubEnv("SUPERTAG_STATE_DIR", stateDirectory);
    const requests: { readonly path: string; readonly init?: RequestInit }[] = [];
    const client = {
      async request<T>(requestPath: string, init?: RequestInit): Promise<T> {
        requests.push({ path: requestPath, init });
        return {
          apiVersion: "supertag/v1",
          kind: "WorkerHostCredential",
          metadata: { workerHostId: "host-a", issuedAt: "2026-09-14T00:00:00.000Z" },
          credential: { token: "one-time-secret" },
        } as T;
      },
    };

    try {
      const credentialPath = join(directory, "issued", "host-a.json");
      const output = await runWorkerHostOperation(client, command, [
        "host-a",
        "--out",
        credentialPath,
      ]);

      expect(output).not.toContain("one-time-secret");
      expect(output).toContain(`Credential written to ${credentialPath} with mode 0600`);
      expect(output).not.toContain("configure worker-host");
      expect(JSON.parse(await readFile(credentialPath, "utf8"))).toEqual({
        version: 1,
        workerHostId: "host-a",
        token: "one-time-secret",
      });
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ path });
      expect(requests[0]?.init?.method).toBe("POST");
      await expect(stat(join(stateDirectory, "worker-hosts"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revokes a host credential without returning a secret", async () => {
    const requests: { readonly path: string; readonly init?: RequestInit }[] = [];
    const client = {
      async request<T>(path: string, init?: RequestInit): Promise<T> {
        requests.push({ path, init });
        return undefined as T;
      },
    };

    await expect(runWorkerHostOperation(client, "revoke", ["host-a"])).resolves.toBe(
      "Revoked Worker Host host-a.\n",
    );
    expect(requests).toEqual([
      {
        path: "/api/v1/worker-hosts/host-a/credential",
        init: { method: "DELETE" },
      },
    ]);
  });

  it("requires an output path and never accepts a token through enrollment options", async () => {
    const request = vi.fn();
    await expect(runWorkerHostOperation({ request }, "enroll", ["host-a"])).rejects.toThrow(
      "--out PATH",
    );
    await expect(
      runWorkerHostOperation({ request }, "enroll", [
        "host-a",
        "--out",
        "/tmp/credential.json",
        "--token",
        "forbidden",
      ]),
    ).rejects.toThrow("Unknown option '--token'");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps every host credential inside the SuperTag state directory", () => {
    expect(workerHostCredentialPath("../../outside", "/srv/supertag")).toBe(
      "/srv/supertag/worker-hosts/..%2F..%2Foutside.credential.json",
    );
  });
});
