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
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";

const client = { operator: { url: "https://control.example.com", token: "admin" } };

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
    ["enroll" as const, ["HostService/EnrollWorkerHost"]],
    [
      "rotate-credential" as const,
      ["HostService/GetWorkerHost", "HostService/RotateWorkerHostCredential"],
    ],
  ])("%s writes the credential once without printing the secret", async (command, methods) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-worker-host-credential-"));
    const stateDirectory = join(directory, ".supertag");
    vi.stubEnv("SUPERTAG_STATE_DIR", stateDirectory);
    const credential = () => ({
      workerHostId: "host-a",
      issuedAt: "2026-09-14T00:00:00Z",
      token: "one-time-secret",
    });
    const rpc = fakeOperatorRpc({
      "HostService/EnrollWorkerHost": credential,
      "HostService/GetWorkerHost": () => ({ metadata: { id: "host-a" }, credentialRevision: "3" }),
      "HostService/RotateWorkerHostCredential": credential,
    });

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
      expect(rpc.calls.map((call) => call.method)).toEqual(methods);
      if (command === "rotate-credential")
        expect(rpc.called("HostService/RotateWorkerHostCredential")[0]?.body).toEqual({
          id: "host-a",
          expectedCredentialRevision: "3",
        });
      await expect(stat(join(stateDirectory, "worker-hosts"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revokes a host credential without returning a secret", async () => {
    const rpc = fakeOperatorRpc({
      "HostService/RevokeWorkerHostCredential": () => ({ metadata: { id: "host-a" } }),
    });

    await expect(runWorkerHostOperation(client, "revoke", ["host-a"])).resolves.toBe(
      "Revoked Worker Host host-a.\n",
    );
    expect(rpc.calls).toEqual([
      { method: "HostService/RevokeWorkerHostCredential", body: { id: "host-a" } },
    ]);
  });

  it("requires an output path and never accepts a token through enrollment options", async () => {
    const rpc = fakeOperatorRpc({});
    await expect(runWorkerHostOperation(client, "enroll", ["host-a"])).rejects.toThrow(
      "--out PATH",
    );
    await expect(
      runWorkerHostOperation(client, "enroll", [
        "host-a",
        "--out",
        "/tmp/credential.json",
        "--token",
        "forbidden",
      ]),
    ).rejects.toThrow("Unknown option '--token'");
    expect(rpc.calls).toEqual([]);
  });

  it("keeps every host credential inside the SuperTag state directory", () => {
    expect(workerHostCredentialPath("../../outside", "/srv/supertag")).toBe(
      "/srv/supertag/worker-hosts/..%2F..%2Foutside.credential.json",
    );
  });
});
