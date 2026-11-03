import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostSlot } from "../apps/cli/src/local-state.ts";
import { retireRemovedHost } from "../apps/cli/src/removed-host.ts";
import { useServicesContext } from "./support/services.ts";

const context = useServicesContext();
const UNREACHABLE = "http://127.0.0.1:1";

async function hostState(credential?: string, mode = 0o600): Promise<string> {
  const directory = join(context.state, "hosts", "old");
  await mkdir(directory, { recursive: true });
  if (credential !== undefined) {
    const path = join(directory, "credential.json");
    await writeFile(path, credential);
    await chmod(path, mode);
  }
  return directory;
}

const credential = (controlPlane?: string) =>
  JSON.stringify({
    version: 1,
    workerHostId: "old",
    token: "secret",
    ...(controlPlane === undefined ? {} : { controlPlane }),
  });

async function retire() {
  const output: string[] = [];
  const request = vi.fn<typeof fetch>(async () => new Response("{}"));
  const result = await retireRemovedHost(hostSlot("old"), (text) => output.push(text), request);
  return { result, printed: output.join(""), request };
}

describe("retiring a host service the file no longer names", () => {
  it("removes its state when it has no credential", async () => {
    const directory = await hostState();
    const { result, request } = await retire();
    expect(result).toBe("removed");
    expect(request).not.toHaveBeenCalled();
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps its state and does not revoke without operator access to unbind", async () => {
    const directory = await hostState(credential(UNREACHABLE));
    const { result, printed, request } = await retire();
    expect(result).toBe("kept");
    expect(request).not.toHaveBeenCalled();
    expect(printed).toContain(
      `No operator access to ${UNREACHABLE}, so Worker Host old was not unbound from its Tags or revoked. Kept host service old's state`,
    );
    expect(printed).toContain("Run supertag down old again with operator access");
    await expect(stat(join(directory, "credential.json"))).resolves.toBeDefined();
  });

  it("keeps its state and does not revoke when unbinding fails", async () => {
    vi.stubEnv("SUPERTAG_CONTROL_PLANE", UNREACHABLE);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "operator");
    const directory = await hostState(credential(UNREACHABLE));
    const { result, printed, request } = await retire();
    expect(result).toBe("kept");
    expect(request).not.toHaveBeenCalled();
    expect(printed).toContain("Could not unbind Worker Host old from its Tags");
    expect(printed).toContain(
      `Run supertag down old again once its Control Plane at ${UNREACHABLE} runs.`,
    );
    await expect(stat(join(directory, "credential.json"))).resolves.toBeDefined();
  });

  it("keeps its state when its credential cannot be read", async () => {
    for (const [content, mode] of [
      ["not json", 0o600],
      [credential(UNREACHABLE), 0o644],
    ] as const) {
      const directory = await hostState(content, mode);
      const { result, printed, request } = await retire();
      expect(result).toBe("kept");
      expect(request).not.toHaveBeenCalled();
      expect(printed).toContain("Could not read host service old's Worker Host credential");
      await expect(stat(join(directory, "credential.json"))).resolves.toBeDefined();
    }
  });

  it("keeps its state when its credential does not record its Control Plane", async () => {
    const directory = await hostState(credential());
    const { result, printed, request } = await retire();
    expect(result).toBe("kept");
    expect(request).not.toHaveBeenCalled();
    expect(printed).toContain(
      "Unbind it from its Tags and revoke it with supertag revoke worker-host-credential old",
    );
    await expect(stat(directory)).resolves.toBeDefined();
  });
});
