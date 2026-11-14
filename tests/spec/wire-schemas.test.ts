import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Schema = Readonly<Record<string, unknown>>;

const specDirectory = resolve(process.cwd(), "spec");
/** Every schema under `spec/`, by its file name. */
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
    path === ""
      ? fromFile
      : relative(specDirectory, resolve(dirname(join(specDirectory, fromFile)), path));
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

describe("language-neutral wire schemas", () => {
  it("contains valid JSON Schema documents with resolvable references", () => {
    expect(schemas.size).toBe(6);
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
