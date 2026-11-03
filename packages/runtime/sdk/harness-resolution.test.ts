import { afterEach, describe, expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.js";
import {
  collectTaskAttemptEvents,
  createWorker,
  type ExecutionEnvironment,
  type Harness,
  type HarnessCapabilities,
  validateHarnessResolution,
} from "./src/index.js";

afterEach(() => vi.unstubAllEnvs());

const declared: HarnessCapabilities = {
  id: "fixture",
  version: "1",
  inputKinds: ["instruction"],
  streaming: true,
  cancellation: true,
  sessionPersistence: "native",
  runtimePlacements: ["local", "remote"],
  sessions: { resume: true, export: true, scope: "local" },
};
function environment(): ExecutionEnvironment {
  return {
    id: "remote-fixture",
    placement: "remote",
    rootDirectory: "/fixture",
    async prepare() {},
    resolvePath: (path) => `/fixture/${path}`,
    async read() {
      return "";
    },
    async spawn() {
      throw new Error("Must not spawn during negotiation");
    },
    dispose: vi.fn(async () => {}),
  };
}
const narrowed = {
  ...declared,
  sessionPersistence: "none" as const,
  sessions: { resume: false, export: false, scope: "none" as const },
};

describe("resolved Harness support", () => {
  it("validates MCP client locations and prevents connection-path escalation", () => {
    const local = { ...environment(), placement: "local" as const };
    const withMcp: HarnessCapabilities = {
      ...narrowed,
      mcpClients: [
        { client: "harness-runtime", transports: ["mcp-http", "mcp-stdio"] },
        { client: "worker-host", transports: ["mcp-http"] },
      ],
    };

    expect(() =>
      validateHarnessResolution(
        withMcp,
        {
          capabilities: {
            ...withMcp,
            mcpClients: [{ client: "harness-runtime", transports: ["mcp-http"] }],
          },
        },
        local,
        [],
      ),
    ).not.toThrow();
    expect(() =>
      validateHarnessResolution(
        withMcp,
        {
          capabilities: {
            ...withMcp,
            mcpClients: [{ client: "execution-environment", transports: ["mcp-http"] }],
          },
        },
        local,
        [],
      ),
    ).toThrow("cannot add MCP client support");
    expect(() =>
      validateHarnessResolution(
        {
          ...narrowed,
          mcpClients: [
            { client: "worker-host", transports: ["mcp-http"] },
            { client: "worker-host", transports: ["mcp-stdio"] },
          ],
        },
        { capabilities: narrowed },
        local,
        [],
      ),
    ).toThrow("placements must be unique");
  });

  it("validates limit capability shape and prevents live capability escalation", () => {
    const withLimits: HarnessCapabilities = {
      ...narrowed,
      executionLimits: {
        maxNativeAgents: { minimum: 0, maximum: 8 },
        maxReportedTokens: {
          minimum: 1,
          maximum: 1_000_000,
          enforcement: "interrupt-on-report",
        },
        maxReportedCost: {
          minimum: 0,
          maximum: 100_000,
          currencies: ["USD"],
          enforcement: "provider-budget",
        },
      },
    };
    const local = { ...environment(), placement: "local" as const };
    expect(() =>
      validateHarnessResolution(withLimits, { capabilities: withLimits }, local, []),
    ).not.toThrow();
    expect(() =>
      validateHarnessResolution(narrowed, { capabilities: withLimits }, local, []),
    ).toThrow("cannot add maxNativeAgents");
    expect(() =>
      validateHarnessResolution(
        narrowed,
        {
          capabilities: {
            ...narrowed,
            executionLimits: { maxReportedCost: withLimits.executionLimits?.maxReportedCost },
          },
        },
        local,
        [],
      ),
    ).toThrow("cannot add maxReportedCost");
    expect(() =>
      validateHarnessResolution(
        withLimits,
        {
          capabilities: {
            ...withLimits,
            executionLimits: { maxNativeAgents: { minimum: 0, maximum: -1 } },
          },
        },
        local,
        [],
      ),
    ).toThrow("Invalid native agent limit capability");
    for (const maxReportedCost of [
      { minimum: 0, maximum: -1, currencies: ["USD"], enforcement: "provider-budget" },
      { minimum: 0, maximum: 1, currencies: ["usd"], enforcement: "provider-budget" },
      { minimum: 0, maximum: 1, currencies: [], enforcement: "provider-budget" },
      { minimum: 0, maximum: 1, currencies: ["USD"], enforcement: "observed" },
    ])
      expect(() =>
        validateHarnessResolution(
          {
            ...narrowed,
            executionLimits: { maxReportedCost },
          } as unknown as HarnessCapabilities,
          {
            capabilities: {
              ...narrowed,
              executionLimits: { maxReportedCost },
            } as unknown as HarnessCapabilities,
          },
          local,
          [],
        ),
      ).toThrow("Invalid reported cost limit capability");
  });

  it("permits truthful remote narrowing and rejects capability escalation", () => {
    expect(() =>
      validateHarnessResolution(declared, { capabilities: narrowed }, environment(), []),
    ).not.toThrow();
    expect(() =>
      validateHarnessResolution(declared, { capabilities: declared }, environment(), []),
    ).toThrow("Local native session");
    expect(() =>
      validateHarnessResolution(
        declared,
        { capabilities: { ...narrowed, inputKinds: ["tool"] } },
        environment(),
        [],
      ),
    ).toThrow("input kinds");
    expect(() =>
      validateHarnessResolution(
        declared,
        {
          capabilities: {
            ...narrowed,
            requiredRuntimeCapabilities: [{ id: "missing", version: 1 }],
          },
        },
        environment(),
        [],
      ),
    ).toThrow("missing");
  });

  it("checks Harness Runtime and Execution Environment capabilities independently", () => {
    const duplex = { id: "supertag.process-input-streaming", version: 1 } as const;
    const split: HarnessCapabilities = {
      ...narrowed,
      splitExecution: true,
      requiredRuntimeCapabilities: [duplex],
      requiredExecutionCapabilities: [duplex],
    };
    const local = { ...environment(), placement: "local" as const };

    expect(() =>
      validateHarnessResolution(split, { capabilities: split }, local, [duplex], []),
    ).toThrow("Execution environment lacks supertag.process-input-streaming@1");
    expect(() =>
      validateHarnessResolution(split, { capabilities: split }, local, [], [duplex]),
    ).toThrow("Harness runtime lacks supertag.process-input-streaming@1");
    expect(() =>
      validateHarnessResolution(split, { capabilities: split }, local, [duplex], [duplex]),
    ).not.toThrow();
  });

  it.each([true, false])(
    "Worker resolves before start and cleans up rejected support (valid=%s)",
    async (valid) => {
      vi.stubEnv("SUPERTAG_RESOLUTION_TEST_API_KEY", "test-resolution-secret");
      const env = environment();
      const calls: string[] = [];
      env.prepare = async () => {
        calls.push("prepare");
      };
      const start = vi.fn(async () => ({
        async *run() {
          yield { type: "output.message" as const, text: "done" };
        },
        async close() {},
      }));
      const harness: Harness = {
        id: "fixture",
        async describe() {
          return declared;
        },
        async plan() {
          return {
            runtime: {
              files: [],
              mounts: [],
              environmentVariables: {},
              secretBindings: [],
              network: { mode: "none" },
            },
            execution: {
              files: [],
              mounts: [],
              environmentVariables: {},
              secretBindings: [],
              network: { mode: "none" },
            },
          };
        },
        async resolve() {
          calls.push("resolve");
          return {
            capabilities: valid ? narrowed : { ...narrowed, id: "another" },
            runtime: { name: "fixture", version: "test-resolution-secret", source: "configured" },
          };
        },
        start,
      };
      const spec = repositoryAttempt("resolution");
      const worker = createWorker({
        id: "resolution",
        profiles: [
          {
            ref: spec.workerProfile,
            workerType: "fixture",
            harness: { provider: harness.id },
            execution: { provider: "fixture", lifetime: { scope: "attempt" } },
          },
        ],
        harnesses: [harness],
        environments: [
          {
            id: "fixture",
            capabilities: [],
            async provision() {
              return env;
            },
          },
        ],
      });
      const events = await collectTaskAttemptEvents(worker.execute(spec));
      expect(JSON.stringify(events)).not.toContain("test-resolution-secret");
      expect(calls).toEqual(["prepare", "resolve"]);
      expect(env.dispose).toHaveBeenCalledOnce();
      if (valid) {
        expect(start).toHaveBeenCalledOnce();
        expect(events.find((event) => event.type === "runtime-inputs.resolved")).toMatchObject({
          manifest: { harness: { resolution: { capabilities: narrowed } } },
        });
      } else {
        expect(start).not.toHaveBeenCalled();
        expect(events.at(-1)).toMatchObject({ type: "execution.failed" });
      }
    },
  );
});

it("rejects omitted or malformed session declarations", () => {
  const { sessions: _sessions, ...legacy } = declared;
  const local = { ...environment(), placement: "local" as const };
  expect(() =>
    validateHarnessResolution(
      legacy as HarnessCapabilities,
      { capabilities: legacy as HarnessCapabilities },
      local,
      [],
    ),
  ).toThrow("Invalid Harness session capabilities");
  expect(() =>
    validateHarnessResolution(declared, { capabilities: legacy as HarnessCapabilities }, local, []),
  ).toThrow("Invalid Harness session capabilities");
  expect(() =>
    validateHarnessResolution(
      declared,
      { capabilities: { ...declared, sessions: { resume: false, export: false, scope: "none" } } },
      environment(),
      [],
    ),
  ).toThrow("requires a session persistence scope");

  for (const sessions of [
    null,
    {},
    { resume: true, export: true },
    { resume: "yes", export: true, scope: "local" },
    { resume: true, export: true, scope: "arbitrary" },
  ]) {
    expect(() =>
      validateHarnessResolution(
        declared,
        { capabilities: { ...declared, sessions } as HarnessCapabilities },
        local,
        [],
      ),
    ).toThrow("Invalid Harness session capabilities");
  }
});
