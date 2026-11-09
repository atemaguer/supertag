import { expect, it } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { applyManifest } from "../apps/cli/src/operator-resources.ts";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";

const target = { url: "http://127.0.0.1:1", token: "unused" };
const manifest = { apiVersion: "supertag/v1", kind: "Workspace", metadata: { name: "app" } };

it("fails when the Control Plane answers that its one manifest failed to apply", async () => {
  const rpc = fakeOperatorRpc({
    "ResourceService/ApplyManifests": () => ({
      results: [
        {
          kind: "RESOURCE_KIND_WORKSPACE",
          name: "app",
          outcome: "MANIFEST_OUTCOME_FAILED",
          failureMessage: "Workspace app could not be written",
        },
      ],
      complete: false,
    }),
  });
  try {
    await expect(applyManifest(target, { manifest, source: "test" })).rejects.toThrow(
      "Workspace app could not be written",
    );
    await expect(new ControlPlaneClient(target).createTag({ name: "quick" })).rejects.toThrow(
      "Workspace app could not be written",
    );
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("returns once the manifest applied", async () => {
  const rpc = fakeOperatorRpc({
    "ResourceService/ApplyManifests": () => ({
      results: [{ name: "app", outcome: "MANIFEST_OUTCOME_APPLIED" }],
      complete: true,
    }),
  });
  try {
    await applyManifest(target, { manifest, source: "test", applySet: "init" });
    expect(rpc.called("ResourceService/ApplyManifests")[0]?.body).toMatchObject({
      applySet: "init",
      documents: [{ manifest, source: "test" }],
    });
  } finally {
    rpc.fetch.mockRestore();
  }
});
