import { expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";

const canonical = [
  "tag",
  "permission-set",
  "context-set",
  "role",
  "surface-account",
  "worker-host",
  "worker-profile",
  "task",
  "session",
  "volume",
  "workspace",
  "auth-key",
  "operator-token",
  "objective",
];
const aliases = [
  ...canonical.map((kind) => `${kind}s`),
  ...canonical.filter((kind) => kind.includes("-")).map((kind) => kind.replaceAll("-", "")),
  "Tag",
  "PermissionSet",
  "unknown",
  "constructor",
  "__proto__",
];

it.each(canonical)("lists canonical resource %s", async (kind) => {
  const request = vi.fn().mockResolvedValue({ items: [] });
  const client = { request } as unknown as ControlPlaneClient;
  await runResourceCommand(client, "get", [kind]);
  expect(request).toHaveBeenCalledWith(`/api/v1/${kind}s`);
});

it.each(aliases)("rejects noncanonical resource %s before requesting", async (kind) => {
  const request = vi.fn().mockResolvedValue({ items: [] });
  const client = { request } as unknown as ControlPlaneClient;
  await expect(runResourceCommand(client, "get", [kind])).rejects.toThrow(
    `Unknown resource kind: ${kind}. Use one of: ${canonical.join(", ")}`,
  );
  expect(request).not.toHaveBeenCalled();
});
