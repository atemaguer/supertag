import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  workspaceEnvironments,
  workspaceResource,
} from "../apps/cli/src/control-plane-resources.ts";
import {
  createHostEnvironmentProvider,
  type HostEnvironmentModules,
  providerCredentialsFromEnvFile,
} from "../apps/cli/src/host-environment.ts";
import { unsandboxedWithoutOptIn } from "../apps/cli/src/host-service.ts";
import { formatRows } from "../apps/cli/src/ps.ts";
import { describeWorkspace } from "../apps/cli/src/resources.ts";
import {
  loadServicesFile,
  renderServicesFile,
  SupertagYamlError,
  serviceFingerprint,
} from "../apps/cli/src/supertag-yaml.ts";
import { createHarnessWorker } from "../apps/cli/src/worker.ts";
import { ContextResolverRegistry } from "../packages/runtime/sdk/src/index.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "supertag-host-environment-"));
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "state"));
  vi.stubEnv("HOME", join(directory, "home"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function host(environment: string, extra = ""): Promise<string> {
  const root = join(directory, "config");
  await mkdir(root, { recursive: true });
  const path = join(root, "supertag.yaml");
  await writeFile(
    path,
    `services:
  cloud:
    type: host
    control-plane: https://supertag.acme.dev
    harnesses: [codex]
    environment: ${environment}
${extra}`,
  );
  return path;
}

async function problems(path: string): Promise<readonly string[]> {
  try {
    await loadServicesFile({ files: [path] });
  } catch (error) {
    if (error instanceof SupertagYamlError) return error.problems;
    throw error;
  }
  return [];
}

describe("host service environment", () => {
  it("rejects remote unsandboxed opt-in at parse time and omits misleading advice", async () => {
    const path = await host("e2b", "    allow-unsandboxed-commands: [claude-code]\n");
    const text = await (await import("node:fs/promises")).readFile(path, "utf8");
    await writeFile(path, text.replace("harnesses: [codex]", "harnesses: [claude-code]"));
    expect(await problems(path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "claude-code cannot use allow-unsandboxed-commands with e2b environment; remove allow-unsandboxed-commands",
        ),
      ]),
    );
    expect(
      unsandboxedWithoutOptIn({
        environment: { provider: "e2b" },
        harnesses: ["claude-code"],
        allowUnsandboxedCommands: [],
      }),
    ).toEqual([]);
  });

  it("selects a provider and its settings, and prints them back in supertag config", async () => {
    const cases = [
      ["e2b", { provider: "e2b" }, "environment: e2b\n"],
      [
        "{ e2b: { image: acme-node } }",
        { provider: "e2b", image: "acme-node" },
        "image: acme-node",
      ],
      [
        "{ modal: { app: supertag-workers, image: 'node:22-bookworm' } }",
        { provider: "modal", app: "supertag-workers", image: "node:22-bookworm" },
        "app: supertag-workers",
      ],
      [
        "{ modal: { app: supertag-workers } }",
        { provider: "modal", app: "supertag-workers" },
        "modal:",
      ],
    ] as const;
    for (const [value, environment, rendered] of cases) {
      const file = await loadServicesFile({ files: [await host(value)] });
      expect(file.services[0]).toMatchObject({ environment });
      expect(renderServicesFile(file)).toContain(rendered);
    }
  });

  it("is absent by default, and changing it restarts the host", async () => {
    const local = await loadServicesFile({ files: [await host("null")] });
    expect(local.services[0]).not.toHaveProperty("environment");
    expect(renderServicesFile(local)).not.toMatch(/^\s+environment:/mu);
    const e2b = await loadServicesFile({ files: [await host("e2b")] });
    const modal = await loadServicesFile({ files: [await host("{ modal: { app: a } }")] });
    const prints = [local, e2b, modal].map((file) =>
      serviceFingerprint(file, file.services[0] as never),
    );
    expect(new Set(prints).size).toBe(3);
  });

  it("refuses every shape outside the design, naming the key", async () => {
    const expectations: readonly (readonly [string, RegExp])[] = [
      ["modal", /environment: modal needs its app: \{ modal: \{ app: NAME \} \}/u],
      ["local", /environment: local is the default; remove environment/u],
      ["docker", /environment: must be e2b, .* "docker" is not a provider/u],
      ["{ e2b: {}, modal: { app: a } }", /environment: .*name exactly one provider/u],
      ["{ codespaces: {} }", /environment: .*name exactly one provider/u],
      [
        "{ e2b: { template: base } }",
        /environment\.e2b\.template: is not a e2b setting; use image/u,
      ],
      [
        "{ e2b: { image: 'https://user:pass@registry.example/x' } }",
        /environment\.e2b\.image: must be an E2B template/u,
      ],
      [
        "{ modal: { app: a, image: 'user:pass@registry.example/x' } }",
        /environment\.modal\.image: must be a registry image/u,
      ],
      ["{ modal: { image: node } }", /environment\.modal\.app: is required/u],
      ["{ modal: { app: 'two words' } }", /environment\.modal\.app: must be a Modal app name/u],
      [
        "{ modal: { app: a, cpu: 2 } }",
        /environment\.modal\.cpu: is not a modal setting; use app or image/u,
      ],
      [
        "{ modal: { app: a, image: 'node 22' } }",
        /environment\.modal\.image: must be a registry image/u,
      ],
      ["[e2b]", /environment: must be e2b, /u],
    ];
    for (const [value, message] of expectations)
      expect(await problems(await host(value)), value).toEqual([expect.stringMatching(message)]);
  });

  it("refuses checkout paths on a remote host: it serves Workspaces by source only", async () => {
    expect(await problems(await host("e2b", "    workspaces: { app: /tmp/app }\n"))).toEqual([
      expect.stringMatching(
        /services\.cloud\.workspaces: cannot name checkout paths on a host with environment e2b/u,
      ),
    ]);
  });

  it("moves only the provider's own credentials from env_file, never over the environment", () => {
    const envFile = {
      E2B_API_KEY: "e2b-file",
      MODAL_TOKEN_ID: "id-file",
      MODAL_TOKEN_SECRET: "secret-file",
      OPENAI_API_KEY: "unrelated",
    };
    expect(providerCredentialsFromEnvFile({ provider: "e2b" }, envFile, {})).toEqual({
      E2B_API_KEY: "e2b-file",
    });
    expect(
      providerCredentialsFromEnvFile({ provider: "modal", app: "a" }, envFile, {
        MODAL_TOKEN_ID: "id-env",
      }),
    ).toEqual({ MODAL_TOKEN_SECRET: "secret-file" });
  });
});

describe("host environment composition", () => {
  function fakeModules(seen: Record<string, unknown>[]): HostEnvironmentModules {
    const record = (kind: string) =>
      class {
        readonly id = kind.startsWith("e2b") ? "e2b" : "modal";
        readonly capabilities = [{ id: `fake.${kind}`, version: 1 }];
        constructor(options: Record<string, unknown>) {
          seen.push({ kind, ...options });
        }
        async provision() {
          throw new Error("not in this test");
        }
      };
    return {
      e2b: async () =>
        ({
          E2BExecutionEnvironmentProvider: record("e2b-execution"),
          E2BWorkspaceEnvironment: record("e2b-workspace"),
        }) as never,
      modal: async () =>
        ({
          ModalExecutionEnvironmentProvider: record("modal-execution"),
          ModalWorkspaceEnvironment: record("modal-workspace"),
        }) as never,
    };
  }

  it("passes only names and bounds to the providers, never a credential", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b-secret-value");
    vi.stubEnv("MODAL_TOKEN_SECRET", "modal-secret-value");
    const seen: Record<string, unknown>[] = [];
    const options = {
      stagingDirectory: "/private/staging",
      sandboxTimeoutMs: 4_200_000,
      modules: fakeModules(seen),
    };
    const e2b = await createHostEnvironmentProvider(
      { provider: "e2b", image: "acme-node" },
      options,
    );
    const modal = await createHostEnvironmentProvider(
      { provider: "modal", app: "supertag-workers", image: "node:22-bookworm" },
      options,
    );
    expect(e2b.id).toBe("e2b");
    expect(e2b.workspaceEnvironment).toBeDefined();
    expect(modal.id).toBe("modal");
    expect(modal.workspaceEnvironment).toBeDefined();
    expect(seen).toEqual([
      { kind: "e2b-execution", template: "acme-node", sandboxTimeoutMs: 4_200_000 },
      {
        kind: "e2b-workspace",
        template: "acme-node",
        stagingDirectory: "/private/staging",
        sandboxTimeoutMs: 4_200_000,
      },
      {
        kind: "modal-execution",
        appName: "supertag-workers",
        createAppIfMissing: true,
        image: "node:22-bookworm",
        sandboxTimeoutMs: 4_200_000,
      },
      {
        kind: "modal-workspace",
        appName: "supertag-workers",
        createAppIfMissing: true,
        image: "node:22-bookworm",
        stagingDirectory: "/private/staging",
        sandboxTimeoutMs: 4_200_000,
      },
    ]);
    expect(JSON.stringify(seen)).not.toMatch(/secret-value/u);
  });

  it("keeps Claude on the host while its workspace runs in the provider sandbox", async () => {
    for (const environment of [
      { provider: "e2b" as const },
      { provider: "modal" as const, app: "supertag-workers" },
    ]) {
      // The real provider packages: constructing them makes no provider call.
      const executionEnvironment = await createHostEnvironmentProvider(environment, {
        stagingDirectory: join(directory, "staging"),
        sandboxTimeoutMs: 60_000,
      });
      const worker = createHarnessWorker(
        {
          harness: "claude-code",
          workerId: "local-claude-code",
          profileId: "local-claude-code",
          profileRevision: "1",
        },
        {
          mcpServers: {},
          executionEnvironment,
          splitHostEnvironment: true,
          checkouts: [],
          worktreeRoot: join(directory, "workspaces"),
          shared: {
            workspace: directory,
            timeoutMs: 60_000,
            redactValues: [],
            contextResolvers: new ContextResolverRegistry([]),
          },
        },
      );
      const descriptor = await worker.describe();
      const profile = descriptor.profileCapabilities?.[0];
      expect(profile?.capabilities).toContainEqual({
        id: `supertag.execution.remote-sandbox.${environment.provider}`,
        version: 1,
      });
      expect(profile?.capabilities.map((capability) => capability.id)).not.toContain(
        "supertag.execution.local-process",
      );
      // Its Workspace environment is registered and serves Workspace Tasks in the sandbox.
      expect(profile?.workspaceRefusal).toBeUndefined();
    }
  });
});

describe("prepared environment output", () => {
  it("shows a host's environment provider in supertag ps TYPE", () => {
    const row = {
      service: "cloud",
      type: "host" as const,
      state: "stopped" as const,
      configured: true,
    };
    const text = formatRows([
      { ...row, environment: "e2b" },
      { ...row, service: "laptop" },
    ]);
    expect(text).toContain("\ncloud    host (e2b)  stopped  ");
    expect(text).toContain("\nlaptop   host        stopped  ");
  });

  const digest = `sha256:4f1c0e2a${"0".repeat(56)}`;
  const commit = `1a2b3c4${"d".repeat(33)}`;
  const snapshot = (capability: string, extra: Record<string, unknown> = {}) => ({
    workers: [
      {
        profileCapabilities: [{ capabilities: [{ id: capability, version: 1 }], ...extra }],
      },
    ],
  });
  const workerHost = (id: string, workerSnapshot: Record<string, unknown>) =>
    ({
      id,
      enrollmentStatus: "active",
      connectionStatus: "connected",
      workerSnapshot,
    }) as never;
  const workspace = {
    id: "w1",
    name: "app",
    source: "https://github.com/acme/app",
    delivery: "branch",
  } as never;

  it("lists each host's prepared environment from its latest Task Attempt, keeping only digests and names", async () => {
    const provenance = (extra: Record<string, unknown>) => ({
      provider: "supertag-workspace",
      preparedDigest: digest,
      preparedProvider: "e2b",
      trustedCommit: commit,
      ...extra,
    });
    const events = (attemptId: string, createdAt: string, extra: Record<string, unknown> = {}) => [
      {
        attemptId,
        type: "runtime-inputs.resolved",
        createdAt,
        payload: {
          manifest: {
            inputs: [{ kind: "workspace", resource: { provenance: provenance(extra) } }],
          },
        },
      },
    ];
    const store = {
      listTasks: async () => [
        { id: "t1", workspacePlan: { status: "workspace", workspace: "app" } },
        { id: "t2", workspacePlan: { status: "workspace", workspace: "other" } },
      ],
      listTaskAttempts: async (taskId: string) =>
        taskId === "t1"
          ? [
              { id: "a1", attemptNumber: 1, workerSnapshot: { workerHostId: "cloud" } },
              { id: "a2", attemptNumber: 2, workerSnapshot: { workerHostId: "cloud" } },
            ]
          : [{ id: "b1", attemptNumber: 1, workerSnapshot: { workerHostId: "cloud" } }],
      listTaskEvents: async (taskId: string) =>
        taskId === "t1"
          ? [
              ...events("a1", "2026-10-03T08:00:00.000Z", { preparedDigest: "sha256:old" }),
              ...events("a2", "2026-10-03T10:00:00.000Z", { secret: "never-shown" }),
            ]
          : events("b1", "2026-10-03T11:00:00.000Z"),
    };
    const hosts = [
      workerHost("cloud", snapshot("supertag.execution.remote-sandbox.e2b")),
      // The laptop runs locally and declares a checkout of the Workspace.
      workerHost("laptop", {
        ...snapshot("supertag.execution.local-process"),
        workspaces: ["app"],
      }),
      workerHost(
        "modal-box",
        snapshot("supertag.execution.remote-sandbox.modal", {
          workspaceRefusal:
            "provider modal Workspace environments cannot deliver a Task's work to the Worker Host yet",
        }),
      ),
    ];
    const environments = await workspaceEnvironments(store as never, workspace, hosts);
    expect(environments).toEqual([
      {
        workerHostId: "cloud",
        connectionStatus: "connected",
        provider: "e2b",
        prepared: {
          digest,
          provider: "e2b",
          trustedCommit: commit,
          at: "2026-10-03T10:00:00.000Z",
        },
      },
      { workerHostId: "laptop", connectionStatus: "connected", provider: "local" },
      {
        workerHostId: "modal-box",
        connectionStatus: "connected",
        provider: "modal",
        refusal:
          "provider modal Workspace environments cannot deliver a Task's work to the Worker Host yet",
      },
    ]);
    expect(JSON.stringify(environments)).not.toContain("never-shown");

    const text = describeWorkspace(
      workspaceResource(workspace, hosts, environments) as never,
      Date.parse("2026-10-03T12:00:00.000Z"),
    );
    expect(text).toContain(
      [
        "Prepared environments:",
        "  cloud (e2b)        sha256:4f1c0e2a  trusted 1a2b3c4  2h ago",
        "  laptop (local)     per Task",
        "  modal-box (modal)  refuses: provider modal Workspace environments cannot deliver a Task's work to the Worker Host yet",
      ].join("\n"),
    );
  });

  it("says when no host serves the Workspace", () => {
    expect(describeWorkspace(workspaceResource(workspace, [], []) as never, Date.now())).toContain(
      "Prepared environments: none\n",
    );
  });
});
