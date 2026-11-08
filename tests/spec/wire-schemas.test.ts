import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Schema = Readonly<Record<string, unknown>>;

const specDirectory = resolve(process.cwd(), "spec");
const schemas = new Map<string, Schema>(
  readdirSync(specDirectory)
    .filter((name) => name.endsWith(".schema.json"))
    .map((name) => [name, JSON.parse(readFileSync(join(specDirectory, name), "utf8")) as Schema]),
);

function pointer(root: Schema, fragment: string): Schema {
  if (fragment === "" || fragment === "#") return root;
  const parts = fragment
    .replace(/^#\//u, "")
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      throw new Error(`Unresolved JSON pointer ${fragment}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error(`JSON pointer ${fragment} does not identify a schema`);
  }
  return current as Schema;
}

function dereference(ref: string, fromFile: string): { file: string; schema: Schema } {
  const [path = "", fragment = ""] = ref.split("#", 2);
  const file =
    path === "" ? fromFile : basename(resolve(dirname(join(specDirectory, fromFile)), path));
  const root = schemas.get(file);
  if (root === undefined) throw new Error(`Missing schema ${file} referenced by ${fromFile}`);
  return { file, schema: pointer(root, fragment === "" ? "" : `#${fragment}`) };
}

function validationErrors(schema: Schema, value: unknown, fromFile: string, at = "$"): string[] {
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const target = dereference(ref, fromFile);
    return validationErrors(target.schema, value, target.file, at);
  }

  const allOf = schema.allOf;
  const compositionErrors = Array.isArray(allOf)
    ? allOf.flatMap((candidate) => validationErrors(candidate as Schema, value, fromFile, at))
    : [];

  if (
    typeof schema.not === "object" &&
    schema.not !== null &&
    validationErrors(schema.not as Schema, value, fromFile, at).length === 0
  )
    compositionErrors.push(`${at} matched a schema it must not match`);

  if (typeof schema.if === "object" && schema.if !== null) {
    const conditionMatches =
      validationErrors(schema.if as Schema, value, fromFile, at).length === 0;
    const branch = conditionMatches ? schema.then : schema.else;
    if (typeof branch === "object" && branch !== null) {
      compositionErrors.push(...validationErrors(branch as Schema, value, fromFile, at));
    }
  }

  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives !== undefined) {
    const results = alternatives.map((candidate) =>
      validationErrors(candidate as Schema, value, fromFile, at),
    );
    const matches = results.filter((errors) => errors.length === 0).length;
    const valid = Array.isArray(schema.oneOf) ? matches === 1 : matches > 0;
    if (!valid) return [`${at} matched ${matches} alternatives`];
  }

  if ("const" in schema && !Object.is(value, schema.const))
    return [`${at} must equal ${String(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return [`${at} is not an allowed value`];
  }

  const type = schema.type;
  if (typeof type === "string" && !hasType(value, type)) return [`${at} must be ${type}`];
  if (Array.isArray(type) && !type.some((item) => hasType(value, String(item))))
    return [`${at} must be one of ${type.join(", ")}`];
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
      return [`${at} must match ${schema.pattern}`];
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      return [`${at} is too short`];
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength)
      return [`${at} is too long`];
    if (
      schema.format === "date-time" &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    ) {
      return [`${at} must be an RFC 3339 UTC timestamp`];
    }
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    return [`${at} must be at least ${schema.minimum}`];
  }
  if (typeof value === "number" && typeof schema.maximum === "number" && value > schema.maximum) {
    return [`${at} must be at most ${schema.maximum}`];
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return [`${at} has too few items`];
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return [`${at} has too many items`];
    if (typeof schema.items === "object" && schema.items !== null) {
      return value.flatMap((item, index) =>
        validationErrors(schema.items as Schema, item, fromFile, `${at}[${index}]`),
      );
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const missing = required
      .filter((key) => !(key in object))
      .map((key) => `${at}.${key} is required`);
    const properties =
      typeof schema.properties === "object" && schema.properties !== null
        ? (schema.properties as Record<string, Schema>)
        : {};
    const children = Object.entries(properties).flatMap(([key, child]) =>
      key in object ? validationErrors(child, object[key], fromFile, `${at}.${key}`) : [],
    );
    const additional = schema.additionalProperties;
    const extra =
      additional === undefined || additional === true
        ? []
        : Object.keys(object)
            .filter((key) => !(key in properties))
            .flatMap((key) =>
              additional === false
                ? [`${at}.${key} is not allowed`]
                : validationErrors(additional as Schema, object[key], fromFile, `${at}.${key}`),
            );
    return [...compositionErrors, ...missing, ...children, ...extra];
  }
  return compositionErrors;
}

function hasType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function expectValid(file: string, value: unknown): void {
  const schema = schemas.get(file);
  if (schema === undefined) throw new Error(`Unknown schema ${file}`);
  expect(validationErrors(schema, value, file)).toEqual([]);
}

function expectInvalid(file: string, value: unknown): void {
  const schema = schemas.get(file);
  if (schema === undefined) throw new Error(`Unknown schema ${file}`);
  expect(validationErrors(schema, value, file).length).toBeGreaterThan(0);
}

const at = "2026-08-13T20:00:00.000Z";
const worklet = {
  durableProtocolVersion: 1,
  id: "worklet-1",
  protocolVersion: 1,
  host: {
    id: "worker-host-1",
    workers: [
      {
        profileCapabilities: [
          {
            profile: { id: "engineering", revision: "1" },
            capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
            contextTypes: [{ type: "supertag/skill", versions: [1] }],
          },
        ],
        id: "codex-worker",
        type: "codex",
        capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
        profiles: [{ id: "engineering", revision: "1" }],
        contextTypes: [{ type: "supertag/skill", versions: [1] }],
        maxConcurrency: 2,
      },
    ],
  },
};
const task = {
  execution: {},
  version: 2,
  taskId: "task-1",
  attemptId: "attempt-1",
  tag: { id: "tag-1", name: "Engineering" },
  input: {
    origin: {
      surface: "slack",
      accountId: "account-1",
      scope: "channel:C123",
      sessionKey: "slack:C123:thread-1",
      occurredAt: at,
    },
    messages: [{ id: "message-1", role: "requester", text: "Inspect the repository" }],
  },
  authorization: {
    version: 5,
    capturedAt: at,
    tag: { id: "tag-1", name: "Engineering" },
    origin: {
      tagRouteId: "route-1",
      surfaceAccountId: "account-1",
      provider: "slack",
      scope: "channel:C123",
    },
    requester: { id: "user-1", kind: "user" },
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  },
  contextPlan: { version: 7, capturedAt: at, sets: [] },
  workspacePlan: { version: 1, status: "none" },
  workerProfile: { id: "engineering", revision: "1" },
};
const event = {
  taskId: "task-1",
  attemptId: "attempt-1",
  at,
  type: "execution.started",
  workerId: "codex-worker",
};

describe("language-neutral wire schemas", () => {
  it("contains valid JSON Schema documents with resolvable references", () => {
    expect(schemas.size).toBe(14);
    for (const [file, schema] of schemas) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      visitReferences(schema, file);
    }
  });

  it("validates control-plane resource envelopes", () => {
    expectValid("resource-envelope.schema.json", {
      apiVersion: "supertag/v1",
      kind: "Tag",
      metadata: {
        id: "tag-1",
        name: "engineering",
        resourceVersion: "17",
        createdAt: at,
        updatedAt: at,
      },
      spec: { workerProfile: { id: "engineering", revision: "1" } },
      status: { phase: "active" },
    });
    expectInvalid("resource-envelope.schema.json", {
      apiVersion: "supertag/v2",
      kind: "Tag",
      metadata: {},
      spec: {},
      status: {},
    });
  });

  it("validates supertag.yaml services and rejects unknown fields and earlier formats", () => {
    const file = "supertag-yaml.schema.json";
    expectValid(file, {});
    expectValid(file, null);
    expectValid(file, { services: { "control-plane": { type: "control-plane" } } });
    const host = (models: unknown) => ({
      services: { laptop: { type: "host", harnesses: ["codex"], models: { codex: models } } },
    });
    expectValid(file, host("gpt-6-sol"));
    expectValid(file, host(["gpt-6-sol", "gpt-6-max"]));
    expectInvalid(file, host([]));
    expectInvalid(file, host([""]));
    const mountRoot = (root: unknown) => ({
      services: { laptop: { type: "host", harnesses: ["codex"], "local-mount-root": root } },
    });
    expectValid(file, mountRoot("/srv/supertag-mounts"));
    expectInvalid(file, mountRoot(""));
    expectInvalid(file, mountRoot(["/srv"]));
    const artifactVolume = (volume: unknown) => ({
      services: { laptop: { type: "host", harnesses: ["codex"], "artifact-volume": volume } },
    });
    expectValid(file, artifactVolume("team-artifacts"));
    expectInvalid(file, artifactVolume("Team Artifacts"));
    expectInvalid(file, artifactVolume({ volume: "team-artifacts" }));
    const mcp = (servers: unknown) => ({
      services: { laptop: { type: "host", harnesses: ["codex"], mcp: servers } },
    });
    expectValid(
      file,
      mcp({
        github: { preset: "github" },
        sentry: { url: "https://mcp.sentry.dev/mcp", auth: { bearer: { env: "SENTRY_TOKEN" } } },
        internal: { url: "https://x.dev", auth: { headers: { "X-Api-Key": { secretRef: "k" } } } },
        app: {
          preset: "github",
          auth: { githubApp: { appId: 1, installationId: "2", privateKey: { file: "~/k.pem" } } },
        },
        acme: {
          url: "https://x.dev",
          auth: { clientCredentials: { clientId: "id", assertionKey: { file: "/k" } } },
        },
        vendor: { url: "https://x.dev", auth: { helper: ["/opt/bin/mcp-token"] } },
        notion: { url: "https://x.dev", auth: { oauth: true } },
        refresh: { url: "https://x.dev", auth: { oauth: { refreshToken: { env: "R" } } } },
      }),
    );
    expectInvalid(file, mcp({ db: { command: ["npx", "db-mcp"] } }));
    expectInvalid(file, mcp({ s: { url: "https://x.dev", auth: { bearer: "literal" } } }));
    expectInvalid(file, mcp({ s: { preset: "lark" } }));
    expectInvalid(file, mcp({ s: {} }));
    expectInvalid(
      file,
      mcp({ s: { url: "https://x.dev", auth: { oauth: true, bearer: { env: "A" } } } }),
    );
    expectValid(file, {
      version: 1,
      name: "acme-eng",
      services: {
        "control-plane": {
          type: "control-plane",
          url: "https://supertag.acme.dev",
          ports: ["0.0.0.0:3434"],
          restart: "unless-stopped",
          database: { url: "postgresql://supertag@db/supertag", password: "db-password" },
          credentials: "vault://secret/supertag",
          notify: "slack:C0123456789",
          logging: { level: "info", format: "json", audit: "/var/log/supertag/audit.jsonl" },
          hosts: { grpc: "3435" },
          tls: { cert: "cert.pem", key: "key.pem" },
          provision: [
            "~/acme/org.yaml",
            { apiVersion: "supertag/v1", kind: "Tag", metadata: { name: "lead" }, spec: {} },
          ],
        },
        laptop: {
          type: "host",
          "control-plane": "https://supertag.acme.dev",
          "auth-key": "laptop-key",
          harnesses: ["codex", "opencode"],
          models: { opencode: "anthropic/claude-sonnet-4-5" },
          workspaces: { app: "~/code/app" },
          "volume-credentials": {
            "artifact-keys": { file: "/etc/supertag/artifact-keys.json" },
            share: { path: "/srv/share" },
          },
          labels: ["gpu"],
          depends_on: [],
          restart: "no",
        },
      },
      secrets: { "db-password": { environment: "PGPASSWORD" }, "laptop-key": { file: "~/k" } },
      env_file: [".env"],
    });
    expectInvalid(file, { services: { cp: { type: "gateway" } } });
    expectInvalid(file, { services: { cp: { type: "control-plane", port: 3434 } } });
    expectInvalid(file, { services: { cp: { type: "control-plane", ports: ["3434", "3435"] } } });
    expectInvalid(file, {
      services: { cp: { type: "control-plane", database: { url: "postgresql://u:p@db/s" } } },
    });
    expectInvalid(file, { services: { cp: { type: "control-plane", restart: "always" } } });
    expectInvalid(file, {
      services: { cp: { type: "control-plane", storage: { artifacts: "s3://bucket/prefix" } } },
    });
    // The Control Plane stores no artifacts, so it takes no artifact Volume or its credentials.
    expectInvalid(file, {
      services: { cp: { type: "control-plane", artifacts: { volume: "artifacts" } } },
    });
    expectInvalid(file, {
      services: {
        cp: {
          type: "control-plane",
          "volume-credentials": { keys: { file: "/etc/supertag/artifact-keys.json" } },
        },
      },
    });
    expectInvalid(file, { services: { laptop: { type: "host" } } });
    expectInvalid(file, { services: { laptop: { type: "host", harnesses: ["vim"] } } });
    const unsandboxed = (allowed: unknown) => ({
      services: {
        laptop: {
          type: "host",
          harnesses: ["claude-code", "codex"],
          "allow-unsandboxed-commands": allowed,
        },
      },
    });
    expectValid(file, unsandboxed(["claude-code"]));
    expectInvalid(file, unsandboxed(["codex"]));
    expectInvalid(file, unsandboxed("claude-code"));
    expectInvalid(file, {
      services: { laptop: { type: "host", harnesses: ["codex"], workspaces: { app: "rel" } } },
    });
    expectInvalid(file, { secrets: { key: { environment: "A", file: "b" } } });
    expectInvalid(file, { version: 2 });
    // Earlier formats are not accepted.
    expectInvalid(file, { port: 3434 });
    expectInvalid(file, { controlPlane: { port: 3434 } });
    expectInvalid(file, { tags: { lead: { roles: ["Lead"] } } });
  });

  it("validates Objective manifests and rejects declared status", () => {
    const file = "objective-manifest.schema.json";
    const manifest = {
      apiVersion: "supertag/v1",
      kind: "Objective",
      metadata: { name: "dependency-upkeep" },
      spec: {
        owner: "maintainer",
        outcome: "Keep dependencies current and the build green.",
        ongoing: true,
        workspaces: ["app"],
        budget: { minor: 50000, currency: "USD" },
        deadline: "2027-01-01T00:00:00Z",
        runtimeActions: ["files:write"],
        team: { name: "upkeep", members: ["maintainer", "builder"], maxConcurrency: 2 },
      },
    };
    expectValid(file, manifest);
    expectInvalid(file, { ...manifest, status: { phase: "working" } });
    expectInvalid(file, { ...manifest, spec: { ...manifest.spec, status: "completed" } });
    expectInvalid(file, { ...manifest, spec: { ...manifest.spec, budget: { minor: -1 } } });
    // A Team is named, or declared in place with at least one member.
    expectValid(file, { ...manifest, spec: { ...manifest.spec, team: "upkeep" } });
    expectInvalid(file, {
      ...manifest,
      spec: { ...manifest.spec, team: { name: "upkeep", members: [], maxConcurrency: 2 } },
    });
    expectInvalid(file, {
      ...manifest,
      spec: { ...manifest.spec, team: { name: "upkeep", members: ["a"], maxConcurrency: 0 } },
    });
  });

  it("validates SurfaceAccount manifests and rejects literal secrets", () => {
    const file = "surface-account-manifest.schema.json";
    const slack = {
      apiVersion: "supertag/v1",
      kind: "SurfaceAccount",
      metadata: { name: "acme-slack" },
      spec: {
        provider: "slack",
        displayName: "Acme Slack",
        configuration: { transport: "socket" },
        secrets: { botToken: { secretRef: "slack-bot-token" }, appToken: { env: "SLACK_APP" } },
      },
    };
    expectValid(file, slack);
    expectValid(file, {
      ...slack,
      metadata: { name: "acme-github" },
      spec: {
        provider: "github",
        configuration: { auth: "app", appId: "12", installationId: "34" },
        secrets: { privateKey: { file: "github-app.pem" }, webhookSecret: { env: "GH_HOOK" } },
      },
    });
    expectValid(file, {
      ...slack,
      spec: {
        provider: "teams",
        configuration: { appId: "app", tenantId: "tenant" },
        secrets: { appSecret: { env: "TEAMS_APP_SECRET" } },
      },
    });
    // A literal value, two reference forms, or a missing transport secret are invalid.
    expectInvalid(file, {
      ...slack,
      spec: { ...slack.spec, secrets: { botToken: "xoxb-literal", appToken: { env: "A" } } },
    });
    expectInvalid(file, {
      ...slack,
      spec: {
        ...slack.spec,
        secrets: { botToken: { env: "A", file: "b" }, appToken: { env: "A" } },
      },
    });
    expectInvalid(file, {
      ...slack,
      spec: {
        ...slack.spec,
        configuration: { transport: "http" },
        secrets: { botToken: { env: "A" } },
      },
    });
    expectInvalid(file, {
      ...slack,
      spec: { ...slack.spec, configuration: { botToken: "xoxb-literal" } },
    });
    expectInvalid(file, { ...slack, status: { phase: "connected" } });
  });

  it("validates resource deletion responses", () => {
    expectValid("resource-deletion.schema.json", {
      apiVersion: "supertag/v1",
      kind: "ResourceDeletion",
      metadata: { kind: "Tag", name: "release" },
      dryRun: true,
      action: "retire",
      removed: ["location slack:C01 with Permission Set deploy"],
      notes: [],
    });
    expectInvalid("resource-deletion.schema.json", {
      apiVersion: "supertag/v1",
      kind: "ResourceDeletion",
      metadata: { kind: "Task", name: "task-1" },
      dryRun: false,
      action: "erase",
      removed: [],
      notes: [],
    });
  });

  it("validates Task Attempt specs and rejects incompatible snapshots", () => {
    expectValid("task-attempt-spec.schema.json", task);
    expectValid("task-attempt-spec.schema.json", {
      ...task,
      authorization: {
        ...task.authorization,
        roles: [
          {
            assignmentId: "assignment-1",
            assignmentRevision: 2,
            role: {
              id: "role-1",
              name: "Org Architect",
              purpose: "Apply organization policy.",
              instructions: "Require durable ownership.",
              revision: 3,
              contextSetIds: [],
              permissionSetIds: [],
            },
          },
        ],
      },
    });
    expectValid("task-attempt-spec.schema.json", { ...task, futureOptionalField: { value: true } });
    expectValid("task-attempt-spec.schema.json", {
      ...task,
      execution: { harness: "codex", model: "gpt-6-sol", effort: "high" },
    });
    // A Task with no execution settings carries the low default effort.
    expectValid("task-attempt-spec.schema.json", { ...task, execution: { effort: "low" } });
    expectInvalid("task-attempt-spec.schema.json", {
      ...task,
      execution: { harness: "codex", effort: "maximum" },
    });
    expectInvalid("task-attempt-spec.schema.json", { ...task, execution: { model: "" } });
    expectInvalid("task-attempt-spec.schema.json", { ...task, version: 1 });
    expectInvalid("task-attempt-spec.schema.json", {
      ...task,
      authorization: { ...task.authorization, version: 1 },
    });
    expectInvalid("task-attempt-spec.schema.json", {
      ...task,
      authorization: {
        ...task.authorization,
        roles: [
          {
            assignmentId: "assignment-1",
            assignmentRevision: 0,
            role: {},
          },
        ],
      },
    });
    expectInvalid("task-attempt-spec.schema.json", {
      ...task,
      input: { ...task.input, messages: [] },
    });
  });

  it("validates internal authorization and scoped coordination without inventing a surface", () => {
    const internal = {
      ...task,
      authorization: {
        ...task.authorization,
        version: 4,
        origin: { kind: "internal", objectiveId: "objective-1", requestedByTagId: "lead" },
      },
      coordination: {
        controlPlaneUrl: "https://control-plane.example",
        token: "attempt-token",
        objectiveId: "objective-1",
      },
    };
    expectValid("task-attempt-spec.schema.json", internal);
    expectInvalid("task-attempt-spec.schema.json", {
      ...internal,
      authorization: { ...internal.authorization, origin: task.authorization.origin },
    });
    expectInvalid("task-attempt-spec.schema.json", {
      ...internal,
      coordination: {
        controlPlaneUrl: "https://control-plane.example",
        objectiveId: "objective-1",
      },
    });
  });

  it("accepts Worker-reported findings without an id or status", () => {
    const resultEvent = (findings: unknown) => ({
      taskId: "task-1",
      attemptId: "attempt-1",
      at,
      type: "result",
      result: {
        summary: "Reviewed",
        decisions: [],
        changes: [],
        unresolved: [],
        findings,
        references: [],
        artifacts: [],
      },
    });
    expectValid(
      "task-attempt-event.schema.json",
      resultEvent([
        { severity: "high", summary: "The export skips tenant scoping.", location: "q.ts:42" },
        { severity: "low", summary: "Typo." },
        // Ignored: the Control Plane assigns the id.
        { id: "anything", severity: "medium", summary: "Slow." },
      ]),
    );
    for (const finding of [
      { summary: "No severity." },
      { severity: "critical", summary: "Unknown severity." },
      { severity: "high", summary: "" },
      { severity: "high", summary: "Names another Task.", taskId: "task-2" },
      // Finding closure is gone, so a status is no longer a finding field.
      { severity: "high", summary: "Closed.", status: "closed" },
    ])
      expectInvalid("task-attempt-event.schema.json", resultEvent([finding]));
    expectInvalid("task-attempt-event.schema.json", resultEvent(undefined));
  });

  it("validates discriminated Task Attempt events", () => {
    expectValid("task-attempt-event.schema.json", event);
    expectValid("task-attempt-event.schema.json", { ...event, futureOptionalField: "ignored" });
    expectValid("task-attempt-event.schema.json", {
      taskId: "task-1",
      attemptId: "attempt-1",
      at,
      type: "execution.completed",
    });
    expectValid("task-attempt-event.schema.json", {
      taskId: "task-1",
      attemptId: "attempt-1",
      at,
      type: "progress.updated",
      progress: {
        summary: "Working through the request",
        items: [{ id: "inspect", text: "Inspecting the code", status: "active" }],
      },
    });
    expectInvalid("task-attempt-event.schema.json", {
      taskId: "task-1",
      attemptId: "attempt-1",
      at,
      type: "progress.updated",
      progress: { summary: "", items: [] },
    });
    expectInvalid("task-attempt-event.schema.json", {
      ...event,
      type: "execution.started",
      workerId: undefined,
    });
    const command = {
      taskId: "task-1",
      attemptId: "attempt-1",
      at,
      type: "command.updated",
      command: { id: "cmd-1", command: "pnpm test:verify", status: "running" },
    };
    expectValid("task-attempt-event.schema.json", command);
    expectInvalid("task-attempt-event.schema.json", {
      ...command,
      command: { ...command.command, status: "interrupted" },
    });
    expectInvalid("task-attempt-event.schema.json", {
      ...command,
      command: { ...command.command, command: "x".repeat(201) },
    });
    expectInvalid("task-attempt-event.schema.json", { ...event, type: "future.event" });
  });

  it("validates Worklet descriptors", () => {
    expectValid("worklet-descriptor.schema.json", worklet);
    expectInvalid("worklet-descriptor.schema.json", {
      ...worklet,
      host: {
        ...worklet.host,
        workers: worklet.host.workers.map(({ profileCapabilities: _, ...worker }) => worker),
      },
    });
    const { durableProtocolVersion: _, ...nonDurable } = worklet;
    expectInvalid("worklet-descriptor.schema.json", nonDurable);
    expectInvalid("worklet-descriptor.schema.json", { ...worklet, durableProtocolVersion: 2 });
    expectInvalid("worklet-descriptor.schema.json", { ...worklet, protocolVersion: 2 });
    expectInvalid("worklet-descriptor.schema.json", {
      ...worklet,
      host: { ...worklet.host, workers: [] },
    });
  });

  it("validates messages in both Worklet transport directions", () => {
    expectValid("worklet-transport-message.schema.json", {
      type: "hello",
      protocolVersions: [18],
      credential: "secret",
      worklet,
    });
    for (const protocolVersions of [[17], [17, 18], [18, 18]]) {
      expectInvalid("worklet-transport-message.schema.json", {
        type: "hello",
        protocolVersions,
        credential: "secret",
        worklet,
      });
    }
    expectValid("worklet-transport-message.schema.json", {
      type: "ready",
      protocolVersion: 18,
      heartbeatIntervalMs: 15_000,
      connectionGeneration: 1,
    });
    expectInvalid("worklet-transport-message.schema.json", {
      type: "ready",
      protocolVersion: 18,
      heartbeatIntervalMs: 15_000,
      connectionGeneration: 0,
    });
    expectValid("worklet-transport-message.schema.json", {
      type: "ready",
      protocolVersion: 18,
      heartbeatIntervalMs: 15_000,
    });
    expectInvalid("worklet-transport-message.schema.json", {
      type: "ready",
      protocolVersion: 16,
      heartbeatIntervalMs: 15_000,
    });
    expectInvalid("worklet-transport-message.schema.json", {
      type: "ready",
      protocolVersion: 9,
      heartbeatIntervalMs: 15_000,
    });
    expectInvalid("worklet-transport-message.schema.json", {
      type: "job",
      jobId: "job-1",
      spec: task,
    });
    expectInvalid("worklet-transport-message.schema.json", {
      type: "task_attempt_event",
      jobId: "job-1",
      event,
    });
    expectInvalid("worklet-transport-message.schema.json", {
      type: "cancel",
      jobId: "job-1",
      reason: "shutdown",
    });
    expectInvalid("worklet-transport-message.schema.json", {
      type: "hello",
      protocolVersions: [],
      pairingToken: "secret",
      worklet,
    });
    expectInvalid("worklet-transport-message.schema.json", {
      type: "job",
      jobId: "job-1",
      spec: { ...task, taskId: "" },
    });
  });

  it("keeps checked-in protocol fixtures compatible with their declared version", () => {
    for (const version of ["v18"]) {
      const directory = join(specDirectory, "fixtures", "worklet-transport", version);
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
        expectValid(
          "worklet-transport-message.schema.json",
          JSON.parse(readFileSync(join(directory, file), "utf8")),
        );
      }
    }
  });
});

function visitReferences(value: unknown, file: string): void {
  if (Array.isArray(value)) {
    for (const item of value) visitReferences(item, file);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string") dereference(item, file);
    else visitReferences(item, file);
  }
}

describe("Workstream post schema", () => {
  it("describes one Team post, with the Tags it wakes and its sequence", () => {
    const post = {
      id: "post-1",
      teamId: "launch-team",
      authorTagId: "marketing",
      to: ["sales"],
      body: "Launch messaging is drafted.",
      sequence: 4,
      createdAt: at,
    };
    expectValid("workstream.schema.json", post);
    expectValid("workstream.schema.json", { ...post, to: [], optionalFutureField: true });
    expectInvalid("workstream.schema.json", { ...post, body: "" });
    expectInvalid("workstream.schema.json", { ...post, sequence: 0 });
    const { teamId: _, ...teamless } = post;
    expectInvalid("workstream.schema.json", teamless);
    const schema = schemas.get("workstream.schema.json");
    expect(schema?.["properties"]).not.toHaveProperty("objectiveId");
    expect(schema?.["properties"]).not.toHaveProperty("type");
  });
});

describe("Objective response schema", () => {
  it("requires an outcome, owner, and revisioned status", () => {
    const objective = {
      id: "launch",
      outcome: "Launch product",
      ownerTagId: "leadership",
      status: "working",
      revision: 1,
      completionSummary: null,
      createdAt: at,
      updatedAt: at,
    };
    expectValid("objective.schema.json", objective);
    expectValid("objective.schema.json", {
      ...objective,
      status: "completed",
      completionSummary: "Approved in launch review",
    });
    // Criteria are folded into the outcome, so new Objectives return an empty list.
    expectValid("objective.schema.json", { ...objective });
    expectInvalid("objective.schema.json", { ...objective, outcome: "" });
    expectInvalid("objective.schema.json", { ...objective, status: "invented" });
    expectInvalid("objective.schema.json", { ...objective, revision: 0 });
    expectValid("objective.schema.json", {
      ...objective,
      budgetLimitMinor: 10_000,
      budgetCurrency: "USD",
    });
    expectInvalid("objective.schema.json", { ...objective, budgetCurrency: "USD" });
    expectInvalid("objective.schema.json", {
      ...objective,
      budgetLimitMinor: null,
      budgetCurrency: "USD",
    });
  });

  it("accepts creation warnings, a dry-run marker, and an owner assessment under review", () => {
    const objective = {
      id: "ship-sso-7f3k",
      outcome: "Ship SSO",
      ownerTagId: "planner",
      status: "ready_for_review",
      revision: 2,
      completionSummary: "SSO works for both identity providers.",
      createdAt: at,
      updatedAt: at,
    };
    expectValid("objective.schema.json", objective);
    expectValid("objective.schema.json", {
      ...objective,
      warnings: ["Tag planner has no Worker Host, so its Tasks cannot run."],
      dryRun: true,
    });
    expectInvalid("objective.schema.json", { ...objective, warnings: [""] });
    expectInvalid("objective.schema.json", { ...objective, warnings: "none" });
    expectInvalid("objective.schema.json", { ...objective, dryRun: false });
  });
});

describe("Team response schema", () => {
  it("requires bounded membership and a revision, with no Objective and no lifecycle", () => {
    const team = {
      id: "engineering",
      name: "Engineering",
      memberTagIds: ["lead"],
      maxConcurrency: 4,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    expectValid("team.schema.json", team);
    // Worker Host capacity is the only limit when no concurrency is set.
    expectValid("team.schema.json", { ...team, maxConcurrency: null });
    // A Team may be emptied without being deleted.
    expectValid("team.schema.json", { ...team, memberTagIds: [] });
    expectInvalid("team.schema.json", { ...team, memberTagIds: [""] });
    expectInvalid("team.schema.json", { ...team, maxConcurrency: 0 });
    expectInvalid("team.schema.json", { ...team, revision: 0 });
    const schema = schemas.get("team.schema.json");
    expect(schema?.["properties"]).not.toHaveProperty("objectiveId");
    expect(schema?.["properties"]).not.toHaveProperty("leadTagId");
    expect(schema?.["properties"]).not.toHaveProperty("status");
  });
});

describe("profile-specific Worker capabilities", () => {
  it("validates exact profile support and rejects malformed capability entries", () => {
    const schema = schemas.get("worker-host-descriptor.schema.json");
    if (!schema) throw new Error("Missing Worker Host schema");
    const capability = { id: "tools", version: 1 };
    const profile = { id: "custom", revision: "1" };
    const descriptor = {
      id: "host",
      workers: [
        {
          id: "worker",
          type: "custom",
          profiles: [profile],
          capabilities: [],
          contextTypes: [],
          profileCapabilities: [{ profile, capabilities: [capability], contextTypes: [] }],
        },
      ],
    };
    expect(validationErrors(schema, descriptor, "worker-host-descriptor.schema.json")).toEqual([]);
    const advertising = (support: Record<string, unknown>) => ({
      ...descriptor,
      workers: descriptor.workers.map((worker) => ({
        ...worker,
        profileCapabilities: [
          {
            profile,
            harness: "codex",
            models: ["gpt-6-sol", "gpt-6-mini"],
            efforts: ["low", "medium", "high"],
            capabilities: [capability],
            contextTypes: [],
            ...support,
          },
        ],
      })),
    });
    expect(validationErrors(schema, advertising({}), "worker-host-descriptor.schema.json")).toEqual(
      [],
    );
    for (const invalid of [{ models: [""] }, { efforts: ["max"] }, { models: "gpt-6-sol" }])
      expect(
        validationErrors(schema, advertising(invalid), "worker-host-descriptor.schema.json").length,
      ).toBeGreaterThan(0);
    capability.version = 0;
    expect(
      validationErrors(schema, descriptor, "worker-host-descriptor.schema.json").length,
    ).toBeGreaterThan(0);
  });
});

describe("Worker Host placement labels", () => {
  it("accepts advertised labels and bounds their number and type", () => {
    const host = { ...worklet.host, labels: ["arm64", "harness:codex", "macos", "workspace:app"] };
    expectValid("worker-host-descriptor.schema.json", host);
    expectValid("worklet-descriptor.schema.json", { ...worklet, host });
    expectInvalid("worker-host-descriptor.schema.json", { ...host, labels: "gpu" });
    expectInvalid("worker-host-descriptor.schema.json", { ...host, labels: [7] });
    expectInvalid("worker-host-descriptor.schema.json", {
      ...host,
      labels: Array.from({ length: 65 }, (_, index) => `label-${index}`),
    });
  });
});

it("validates durable native control commands, acknowledgements, and capabilities", () => {
  const command = {
    id: "command",
    taskId: "task",
    attemptId: "attempt",
    type: "input",
    text: "steer",
  };
  const message = {
    type: "durable_request",
    requestId: "request",
    operation: "control",
    attemptId: "attempt",
    command,
  };
  expectValid("worklet-transport-message.schema.json", message);
  expectInvalid("worklet-transport-message.schema.json", {
    ...message,
    command: { ...command, type: "unknown" },
  });
  expectInvalid("worklet-transport-message.schema.json", {
    ...message,
    command: {
      id: command.id,
      taskId: command.taskId,
      attemptId: command.attemptId,
      type: "input",
    },
  });
  expectValid("worklet-transport-message.schema.json", {
    type: "durable_request",
    requestId: "request",
    operation: "control_capabilities",
    taskId: "task",
    attemptId: "attempt",
  });
  expectValid("worklet-transport-message.schema.json", {
    type: "durable_reply",
    requestId: "request",
    result: { id: "command", taskId: "task", attemptId: "attempt", status: "unknown" },
  });
  expectValid("worklet-transport-message.schema.json", {
    type: "durable_reply",
    requestId: "request",
    result: { version: 1, operations: ["input"], inputMode: "steer" },
  });
  expectInvalid("worklet-transport-message.schema.json", {
    type: "durable_reply",
    requestId: "request",
    result: { version: 1, operations: ["input"], inputMode: "invented" },
  });
});
