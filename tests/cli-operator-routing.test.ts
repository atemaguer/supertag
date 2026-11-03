import { afterEach, expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "../apps/cli/src/action-command.js";
import * as controlPlane from "../apps/cli/src/control-plane-client.js";
import { main } from "../apps/cli/src/index.js";

afterEach(() => vi.restoreAllMocks());
it.each([
  ["assign", "task", "--help"],
  ["list", "artifact", "--help"],
  ["get", "artifact", "--help"],
  ["download", "artifact", "--help"],
  ["connect", "worklet", "--help"],
  ["worklet", "connect", "--help"],
])("shows %s %s help without reading credentials", async (...args) => {
  const target = vi
    .spyOn(controlPlane, "resolveControlPlaneTarget")
    .mockImplementation(async () => {
      throw Error("must not resolve credentials");
    });
  const url = vi.spyOn(controlPlane, "resolveControlPlaneUrl").mockImplementation(async () => {
    throw Error("must not resolve URL");
  });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await main(args)).toBe(0);
  expect(write.mock.calls.map(([v]) => String(v)).join("")).toMatch(/Usage|supertag/);
  expect(target).not.toHaveBeenCalled();
  expect(url).not.toHaveBeenCalled();
});
it("passes Worklet flags through unchanged", () => {
  expect(
    normalizeActionFirstCommand([
      "connect",
      "worklet",
      "--worklet-url=https://localhost:4443",
      "--worker-host",
      "host-a",
    ]),
  ).toEqual([
    "worklet",
    "connect",
    "--worklet-url=https://localhost:4443",
    "--worker-host",
    "host-a",
  ]);
});
it("routes artifact reads to JSON API without rendering instructions or prompts", async () => {
  vi.spyOn(controlPlane, "resolveControlPlaneTarget").mockResolvedValue({
    url: "http://127.0.0.1:1",
    token: "unused",
  });
  const resource = {
    apiVersion: "supertag/v1",
    kind: "Artifact",
    metadata: { id: "artifact/one" },
    spec: { entries: [] },
  };
  const request = vi
    .spyOn(controlPlane.ControlPlaneClient.prototype, "request")
    .mockResolvedValue(resource);
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await main(["get", "artifact", "artifact/one"])).toBe(0);
  expect(request).toHaveBeenCalledWith("/api/v1/artifacts/artifact%2Fone");
  expect(JSON.parse(write.mock.calls.map(([v]) => String(v)).join(""))).toEqual(resource);
});
it("preserves explicit JSON for general resource inspection", async () => {
  vi.spyOn(controlPlane, "resolveControlPlaneTarget").mockResolvedValue({
    url: "http://127.0.0.1:1",
    token: "unused",
  });
  const resource = {
    apiVersion: "supertag/v1",
    kind: "WorkerHost",
    metadata: { id: "host-a" },
    status: { phase: "ready" },
  };
  vi.spyOn(controlPlane.ControlPlaneClient.prototype, "request").mockResolvedValue(resource);
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await main(["describe", "worker-host", "host-a", "--output", "json"])).toBe(0);
  expect(JSON.parse(write.mock.calls.map(([v]) => String(v)).join(""))).toEqual(resource);
});

it("routes apply and diff -f and leaves a resource name unrewritten", () => {
  for (const action of ["apply", "diff"]) {
    expect(normalizeActionFirstCommand([action, "-f", "org.yaml"])).toEqual([
      action,
      "-f",
      "org.yaml",
    ]);
    expect(normalizeActionFirstCommand([action, "configuration", "-f", "org.yaml"])).toEqual([
      action,
      "configuration",
      "-f",
      "org.yaml",
    ]);
  }
});
