import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkerHostCredential, workletApiUrl } from "../apps/cli/src/worker.ts";

describe("Worker Host credential files", () => {
  it("requires encrypted transport outside the local machine", () => {
    expect(workletApiUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/worklets");
    expect(workletApiUrl("ws://localhost:8787/worklets")).toBe("ws://localhost:8787/worklets");
    expect(workletApiUrl("http://[::1]:8787")).toBe("ws://[::1]:8787/worklets");
    expect(workletApiUrl("https://control.example.com")).toBe("wss://control.example.com/worklets");
    expect(workletApiUrl("wss://control.example.com/worklets")).toBe(
      "wss://control.example.com/worklets",
    );
    expect(() => workletApiUrl("http://control.example.com")).toThrow(/HTTPS or WSS/);
    expect(() => workletApiUrl("ws://control.example.com/worklets")).toThrow(/HTTPS or WSS/);
    expect(() => workletApiUrl("https://operator:secret@control.example.com")).toThrow(
      /must not contain credentials/,
    );
    expect(() => workletApiUrl("https://control.example.com?credential=secret")).toThrow(
      /query parameters/,
    );
  });

  it("uses an explicit secure gRPC origin without rewriting it to WebSocket", () => {
    expect(workletApiUrl("https://control.example.com:7443", "grpc")).toBe(
      "https://control.example.com:7443/",
    );
    expect(workletApiUrl("http://127.0.0.1:7443", "grpc")).toBe("http://127.0.0.1:7443/");
    for (const url of [
      "http://control.example.com:7443",
      "wss://control.example.com",
      "https://user:secret@control.example.com",
      "https://control.example.com/worklets",
      "https://control.example.com?token=secret",
    ]) {
      expect(() => workletApiUrl(url, "grpc")).toThrow();
    }
  });

  it("reads a private enrolled credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-worker-host-credential-"));
    const path = join(directory, "worker-host.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ version: 1, workerHostId: "host-a", token: "host-token" }),
        { mode: 0o600 },
      );
      await expect(readWorkerHostCredential(path)).resolves.toEqual({
        workerHostId: "host-a",
        token: "host-token",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects permissive files, symlinks, and unknown fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-worker-host-credential-"));
    const path = join(directory, "worker-host.json");
    const link = join(directory, "worker-host-link.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          workerHostId: "host-a",
          token: "host-token",
          unexpected: true,
        }),
        { mode: 0o600 },
      );
      await expect(readWorkerHostCredential(path)).rejects.toThrow("unsupported format");
      await writeFile(
        path,
        JSON.stringify({ version: 1, workerHostId: "host-a", token: "host-token" }),
      );
      if (process.platform !== "win32") {
        await chmod(path, 0o644);
        await expect(readWorkerHostCredential(path)).rejects.toThrow("private regular file");
        await chmod(path, 0o600);
      }
      await symlink(path, link);
      await expect(readWorkerHostCredential(link)).rejects.toThrow("private regular file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
