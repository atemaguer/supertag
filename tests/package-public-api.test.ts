import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as core from "../packages/supertag-ai/src/core.js";
import * as modal from "../packages/supertag-ai/src/environments/modal.js";
import * as sdk from "../packages/supertag-ai/src/index.js";
import * as messaging from "../packages/supertag-ai/src/messaging.js";
import * as testing from "../packages/supertag-ai/src/testing.js";
import * as worker from "../packages/supertag-ai/src/worker.js";

describe("supertag-ai public API", () => {
  it("documents only published package entry points in API stability", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../packages/supertag-ai/package.json", import.meta.url), "utf8"),
    );
    const doc = readFileSync(
      new URL("../docs/reference/api-stability.md", import.meta.url),
      "utf8",
    );
    const imports = doc.split("\n").filter((line) => line.startsWith("| `supertag-ai"));
    expect(imports.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const row of imports) {
      const cell = row.split("|")[1] ?? "";
      let parent = "";
      for (const match of cell.matchAll(/`([^`]+)`/g)) {
        const name = match[1] ?? "";
        const path = name.startsWith("/") ? `${parent}${name}` : name;
        parent = path.slice(0, path.lastIndexOf("/"));
        const key = path === "supertag-ai" ? "." : `.${path.slice("supertag-ai".length)}`;
        if (!Object.hasOwn(manifest.exports, key)) missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });

  it("exposes Role contracts through the domain core subpath", () => {
    expect(core).not.toHaveProperty("ORG_ARCHITECT_ROLE_KEY");
    expectTypeOf<core.Role>().toEqualTypeOf<{
      id: string;
      name: string;
      purpose: string;
      instructions: string;
      contextSetIds: readonly string[];
      permissionSetIds: readonly string[];
      status: core.RoleStatus;
      createdAt: string;
      updatedAt: string;
    }>();
    expectTypeOf<core.CreateRoleInput>().toEqualTypeOf<{
      name: string;
      purpose: string;
      instructions?: string;
      contextSetIds?: readonly string[];
      permissionSetIds?: readonly string[];
    }>();
    expectTypeOf<core.UpdateRoleInput>().toEqualTypeOf<{
      purpose?: string;
      instructions?: string;
      contextSetIds?: readonly string[];
      permissionSetIds?: readonly string[];
      status?: core.RoleStatus;
    }>();
  });
  it("exposes Modal through its optional environment subpath", () => {
    expect(modal).toHaveProperty("ModalExecutionEnvironmentProvider");
    expect(modal).toHaveProperty("ModalSandboxBackend");
    expect(modal.MODAL_REMOTE_SANDBOX_CAPABILITY.id).toBe(
      "supertag.execution.remote-sandbox.modal",
    );
    expect(sdk).not.toHaveProperty("ModalExecutionEnvironmentProvider");
  });
  it("exposes Tag messaging on its own experimental subpath", () => {
    expect(messaging).toHaveProperty("TagMailboxClient");
    expect(messaging.TAG_MAILBOX_MAX_OUTSTANDING).toBe(100);
    expect(messaging.OBJECTIVE_STATUSES).toContain("completed");
    expect(messaging.WORKSTREAM_POST_TYPES).toEqual([
      "note",
      "question",
      "blocker",
      "evidence",
      "decision",
    ]);
    expect(messaging.WORKSTREAM_POST_MAX_TO).toBe(20);
    expect(messaging).not.toHaveProperty("WORKSTREAM_STATUSES");
    for (const removed of [
      "createWorkstream",
      "updateWorkstream",
      "updateWorkstreamStatus",
      "workstreamMessages",
    ])
      expect(messaging.TagMailboxClient.prototype).not.toHaveProperty(removed);
    expect(messaging.TagMailboxClient.prototype).toHaveProperty("postWorkstream");
    expect(messaging.TagMailboxClient.prototype).toHaveProperty("history");
    expect(messaging.TagMailboxClient.prototype).toHaveProperty("workstreamPosts");
    expect(messaging.TagMailboxClient.prototype).toHaveProperty("createObjective");
    expect(messaging.TAG_MESSAGE_TYPES).toContain("delegation.requested");
    expect(sdk).not.toHaveProperty("TagMailboxClient");
  });
  it("keeps the default entry point focused on the Beta SDK kernel", () => {
    expect(sdk).toHaveProperty("createWorker");
    expect(sdk).toHaveProperty("LocalExecutionEnvironmentProvider");
    expect(sdk).toHaveProperty("LocalHarnessRuntimeProvider");
    expect(sdk).not.toHaveProperty("LocalProcessEnvironmentProvider");
    expect(sdk).toHaveProperty("LocalWorklet");
    expect(sdk).toHaveProperty("connectWorklet");
    expectTypeOf<sdk.WorkerHostDescriptor>().toMatchTypeOf<{
      id: string;
      workers: readonly sdk.WorkerDescriptor[];
    }>();
    expect(sdk.WORKLET_PROTOCOL_VERSION).toBe(18);
    expect(sdk.SUPPORTED_WORKLET_PROTOCOL_VERSIONS).toEqual([18]);

    expect(sdk).not.toHaveProperty("ContextResolverRegistry");
    expect(sdk).not.toHaveProperty("ToolAdapterRegistry");
    expect(sdk).not.toHaveProperty("FileSessionStateStore");
    expect(sdk).not.toHaveProperty("WorkerRuntime");
  });

  it("exposes advanced worker extension points through the worker subpath", () => {
    expect(worker).toHaveProperty("LocalHarnessExecutionControl");
    expect(worker).toHaveProperty("validateHarnessResolution");
    expect(worker).toHaveProperty("descriptorForProfile");
    expect(worker).toHaveProperty("DurableLocalWorklet");
    expect(worker).toHaveProperty("FileAttemptJournal");
    expect(worker).toHaveProperty("ContextResolverRegistry");
    expect(worker).toHaveProperty("ToolAdapterRegistry");
    expect(worker).toHaveProperty("FileSessionStateStore");
  });

  it.each([
    "descriptorSupportsCoordination",
    "descriptorSupportsExecution",
    "descriptorSupportsSurfaceCoordination",
    "executionPreferenceScore",
    "selectDescriptorExecution",
    "selectWorkletExecution",
    "ProcessOutputBuffer",
    "signArtifactTransferGrant",
    "verifyArtifactTransferGrant",
    "MAX_ARTIFACT_TRANSFER_GRANT_BYTES",
    "MAX_ARTIFACT_TRANSFER_GRANT_TTL_MS",
    "WORKLET_ARTIFACT_TRANSFER_PATH",
  ])("keeps %s internal to workspace packages", (name) => {
    expect(worker).not.toHaveProperty(name);
    expect(sdk).not.toHaveProperty(name);
  });

  it("publishes reusable extension conformance probes separately", () => {
    expect(testing).toHaveProperty("runWorkerConformance");
    expect(testing).toHaveProperty("runHarnessConformance");
    expect(testing).toHaveProperty("assertConformance");
    expect(testing).toHaveProperty("runSurfaceConformance");
    expect(testing).toHaveProperty("runEnvironmentConformance");
    expect(testing).toHaveProperty("runToolAdapterConformance");
    expect(testing).toHaveProperty("runWorkletTransportConformance");
  });

  it("exercises a custom Surface lifecycle through the public conformance kit", async () => {
    const calls: string[] = [];
    const report = await testing.runSurfaceConformance({
      surface: {
        identity: { id: "example", displayName: "Example" },
        start: async () => void calls.push("start"),
        stop: async () => void calls.push("stop"),
      },
    });

    expect(report).toMatchObject({ passed: true, findings: [] });
    expect(calls).toEqual(["start", "stop"]);
  });

  it("checks independent Worklet protocol 18 implementations", () => {
    expect(
      testing.runWorkletTransportConformance({
        workletProtocolVersions: [18],
        controlPlaneProtocolVersions: [18],
        negotiate: () => 18,
      }),
    ).toMatchObject({ passed: true });
    expect(
      testing.runWorkletTransportConformance({
        workletProtocolVersions: [18],
        controlPlaneProtocolVersions: [18],
        negotiate: () => 17,
      }),
    ).toMatchObject({ passed: false });
    expect(
      testing.runWorkletTransportConformance({
        workletProtocolVersions: [17, 18],
        controlPlaneProtocolVersions: [18],
      }),
    ).toMatchObject({ passed: false });
  });
});
