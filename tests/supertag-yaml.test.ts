import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../apps/cli/src/index.ts";
import {
  availableHostVolumeCredentials,
  defaultDatabaseUrl,
  defaultSupertagYamlPath,
  hostVolumeCredentialLabels,
  interpolateString,
  isSecretSetting,
  isSupertagYamlInput,
  loadServicesFile,
  readSecret,
  readVolumeCredential,
  renderServicesFile,
  type ServicesFile,
  SupertagYamlError,
  serviceFingerprint,
  serviceNameFromHostname,
  startOrder,
  unitSettings,
} from "../apps/cli/src/supertag-yaml.ts";
import { machineWorkerConcurrency } from "../apps/cli/src/worker-concurrency.ts";

let directory: string;
let output: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "supertag-yaml-"));
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "state"));
  vi.stubEnv("HOME", join(directory, "home"));
  for (const name of [
    "SUPERTAG_GATEWAY_HOST",
    "SUPERTAG_GATEWAY_PORT",
    "SUPERTAG_DEPLOYMENT_PLATFORM",
    "PORT",
    "SUPERTAG_DATABASE_URL",
    "SUPERTAG_COORDINATION_URL",
    "SUPERTAG_OPERATOR_CHANNEL",
    "SUPERTAG_CREDENTIAL_VAULT",
    "SUPERTAG_RPC_TRACE",
    "SUPERTAG_WORKLET_GRPC_PORT",
    "SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE",
    "SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE",
    "SUPERTAG_WORKLET_TLS_CA_FILE",
    "SUPERTAG_COORDINATION_OPERATORS_FILE",
    "PGPASSWORD",
  ])
    vi.stubEnv(name, undefined);
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function file(text: string, name = "supertag.yaml", folder = "config"): Promise<string> {
  const root = join(directory, folder);
  await mkdir(root, { recursive: true });
  const path = join(root, name);
  await writeFile(path, text);
  return path;
}

async function problems(...files: string[]): Promise<readonly string[]> {
  try {
    await loadServicesFile({ files });
  } catch (error) {
    if (error instanceof SupertagYamlError) return error.problems;
    throw error;
  }
  return [];
}

const SOLO = `services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [claude-code]
    workspaces: { app: ~/code/app }
`;

const SHARED = `name: acme-eng
services:
  control-plane:
    type: control-plane
    url: https://supertag.acme.dev
    ports: ["0.0.0.0:3434"]
    restart: unless-stopped
    database: { url: "postgresql://supertag@db/supertag", password: db-password }
    credentials: vault://secret/supertag
    notify: slack:C0123456789
    logging: { format: json, audit: /var/log/supertag/audit.jsonl }
secrets:
  db-password: { environment: PGPASSWORD }
`;

it("keeps host Volume credential mappings as references", async () => {
  const path = await file(`services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex]
    volume-credentials:
      datasets: { environment: DATASET_TOKEN }
      archive: { file: ./archive.key }
`);
  const loaded = await loadServicesFile({ files: [path] });
  const host = loaded.services.find((service) => service.type === "host");
  if (!host) throw new Error("missing host service");
  expect(host?.volumeCredentials).toEqual({
    datasets: { environment: "DATASET_TOKEN" },
    archive: { file: join(directory, "config", "archive.key") },
  });
  expect(renderServicesFile(loaded)).toContain("volume-credentials:");
  const marker = "host-only-volume-secret";
  expect(await readVolumeCredential(loaded, host, "datasets", { DATASET_TOKEN: marker })).toBe(
    marker,
  );
  await writeFile(join(directory, "config", "archive.key"), `${marker}\n`);
  expect(await readVolumeCredential(loaded, host, "archive")).toBe(marker);
  expect(JSON.stringify(host)).not.toContain(marker);
  expect(renderServicesFile(loaded)).not.toContain(marker);
  expect(hostVolumeCredentialLabels(host)).toHaveLength(2);
  expect(JSON.stringify(hostVolumeCredentialLabels(host))).not.toContain(marker);
  expect(JSON.stringify(hostVolumeCredentialLabels(host))).not.toContain("DATASET_TOKEN");
  expect(JSON.stringify(hostVolumeCredentialLabels(host))).not.toContain("archive.key");
  expect(await availableHostVolumeCredentials(loaded, host, { DATASET_TOKEN: marker })).toEqual([
    "datasets",
    "archive",
  ]);
  await rm(join(directory, "config", "archive.key"));
  expect(await availableHostVolumeCredentials(loaded, host, { DATASET_TOKEN: "" })).toEqual([]);
  expect(
    await problems(
      await file(
        `services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex]
    volume-credentials: { datasets: plain-secret-value }
`,
        "bad-volume.yaml",
      ),
    ),
  ).toEqual([
    expect.stringContaining(
      "services.laptop.volume-credentials.datasets: must be { environment: VAR } or { file: PATH }",
    ),
  ]);
  expect(
    await problems(
      await file(
        `services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex]
    volume-credentials: { datasets: { environment: SUPERTAG_MCP_TOKEN } }
`,
        "bad-mcp-volume.yaml",
      ),
    ),
  ).toEqual([expect.stringContaining("must not use SUPERTAG_MCP_*")]);
});

it("accepts a host directory path only in a Volume credential mapping", async () => {
  const path = await file(
    `services:\n  control-plane: { type: control-plane }\n  laptop:\n    type: host\n    harnesses: [codex]\n    volume-credentials:\n      datasets: { path: ./datasets }\n`,
    "file-volume.yaml",
  );
  const loaded = await loadServicesFile({ files: [path] });
  const host = loaded.services.find((service) => service.type === "host");
  if (!host) throw new Error("missing host service");
  const directory = join(dirname(path), "datasets");
  expect(host.volumeCredentials.datasets).toEqual({ path: directory });
  expect(await availableHostVolumeCredentials(loaded, host)).toEqual([]);
  await mkdir(directory);
  expect(await availableHostVolumeCredentials(loaded, host)).toEqual(["datasets"]);
  expect(await readVolumeCredential(loaded, host, "datasets")).toEqual({
    path: directory,
  });
});

it("keeps volume-credentials on host services only: the Control Plane maps none", async () => {
  const mapping = `    volume-credentials:
      share: { path: ./share }
`;
  const refused = await problems(
    await file(
      `services:\n  control-plane:\n    type: control-plane\n${mapping}  laptop:\n    type: host\n    harnesses: [codex]\n${mapping}`,
      "cp-credentials.yaml",
    ),
  );
  expect(refused).toEqual([
    expect.stringMatching(
      /services\.control-plane\.volume-credentials: unknown field; expected one of/,
    ),
  ]);
  expect(refused[0]).not.toMatch(/expected one of .*(artifacts|volume-credentials)/u);
});

it("resolves a host service Skill catalog path from its settings file", async () => {
  const path = await file(`services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex]
    skills: ./skills
`);
  const loaded = await loadServicesFile({ files: [path] });
  const host = loaded.services.find((service) => service.type === "host");
  expect(host?.skills).toBe(join(directory, "config", "skills"));
  expect(renderServicesFile(loaded)).toContain(`skills: ${join(directory, "config", "skills")}`);
});

describe("supertag.yaml services", () => {
  it("uses one control-plane service with defaults when there is no file", async () => {
    const resolved = await loadServicesFile();
    expect(resolved.files).toEqual([]);
    expect(resolved.name).toBe("supertag");
    expect(resolved.services).toEqual([
      {
        type: "control-plane",
        name: "control-plane",
        ports: { host: "127.0.0.1", port: 3434 },
        url: "http://127.0.0.1:3434",
        database: { url: defaultDatabaseUrl() },
        credentials: "file",
        logging: { level: "info", format: "text", audit: "stderr" },
        tls: {},
        hosts: {},
        operators: {},
        restart: "no",
        dependsOn: [],
        provision: [],
      },
    ]);
    expect(defaultSupertagYamlPath()).toBe(join(directory, "state", "supertag.yaml"));
    expect(defaultDatabaseUrl()).toBe(`file:${join(directory, "state", "supertag.db")}`);
    // An empty file means the defaults too.
    expect((await loadServicesFile({ files: [await file("")] })).services).toHaveLength(1);
  });

  it("reads the solo, teammate, and shared-server examples", async () => {
    const solo = await loadServicesFile({ files: [await file(SOLO)] });
    expect(solo.services.map((service) => service.name)).toEqual(["control-plane", "laptop"]);
    expect(solo.services[1]).toEqual({
      type: "host",
      name: "laptop",
      controlPlane: { service: "control-plane" },
      harnesses: ["claude-code"],
      allowUnsandboxedCommands: [],
      models: {},
      workspaces: { app: join(directory, "home", "code", "app") },
      volumeCredentials: {},
      labels: [],
      mcp: {},
      concurrency: machineWorkerConcurrency(),
      concurrencySource: "machine",
      restart: "no",
      dependsOn: ["control-plane"],
    });

    const teammate = await loadServicesFile({
      files: [
        await file(`services:
  laptop:
    type: host
    control-plane: https://supertag.acme.dev/
    auth-key: laptop-key
    harnesses: [codex]
secrets:
  laptop-key: { file: ~/laptop.key }
`),
      ],
    });
    expect(teammate.services).toEqual([
      expect.objectContaining({
        name: "laptop",
        controlPlane: { url: "https://supertag.acme.dev" },
        authKey: "laptop-key",
        dependsOn: [],
      }),
    ]);
    expect(teammate.secrets).toEqual({
      "laptop-key": { file: join(directory, "home", "laptop.key") },
    });

    const shared = await loadServicesFile({ files: [await file(SHARED)] });
    expect(shared.name).toBe("acme-eng");
    expect(shared.services[0]).toMatchObject({
      ports: { host: "0.0.0.0", port: 3434 },
      url: "https://supertag.acme.dev",
      restart: "unless-stopped",
      database: { url: "postgresql://supertag@db/supertag", password: "db-password" },
      credentials: "vault://secret/supertag",
      notify: "slack:C0123456789",
      logging: { level: "info", format: "json", audit: "/var/log/supertag/audit.jsonl" },
    });
  });

  it("reads host models as one model or a list whose first is the default", async () => {
    const loaded = await loadServicesFile({
      files: [
        await file(`services:
  laptop:
    type: host
    control-plane: https://supertag.acme.dev/
    harnesses: [claude-code, codex, opencode]
    models:
      claude-code: [claude-opus-5-5, claude-sonnet-5-5]
      codex: gpt-6-sol
      opencode: anthropic/claude-sonnet-5-5
`),
      ],
    });
    expect(loaded.services[0]).toMatchObject({
      models: {
        "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5"],
        codex: ["gpt-6-sol"],
        opencode: ["anthropic/claude-sonnet-5-5"],
      },
    });
    // Rendering keeps one model as a string and several as a list.
    const rendered = renderServicesFile(loaded);
    expect(rendered).toContain("codex: gpt-6-sol");
    expect(rendered).toMatch(/claude-code:.*claude-opus-5-5.*claude-sonnet-5-5/su);
    expect(
      await problems(
        await file(`services:
  laptop:
    type: host
    control-plane: https://supertag.acme.dev/
    harnesses: [codex]
    models:
      codex: [gpt-6-sol, gpt-6-sol]
`),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /services\.laptop\.models\.codex: must map one of .* to a model name or a list of distinct model names/,
        ),
      ]),
    );
  });

  it("reads a host's per-Worker concurrency and refuses values outside 1 through 16", async () => {
    const host = (concurrency: string) =>
      file(`services:
  laptop:
    type: host
    control-plane: https://supertag.acme.dev/
    harnesses: [claude-code, codex]
    concurrency: ${concurrency}
`);
    const loaded = await loadServicesFile({ files: [await host("4")] });
    expect(loaded.services[0]).toMatchObject({ concurrency: 4, concurrencySource: "file" });
    expect(renderServicesFile(loaded)).toContain("concurrency: 4\n");
    for (const value of ["0", "17", "1.5", "two"])
      expect(await problems(await host(value))).toEqual([
        expect.stringMatching(
          /services\.laptop\.concurrency: must be a whole number from 1 through 16/,
        ),
      ]);
  });

  it("accepts Cursor as a host harness with models", async () => {
    const path = await file(
      `services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [cursor]
    models: { cursor: [composer-2.5] }
`,
      "cursor.yaml",
    );
    const services = await loadServicesFile({ files: [path] });
    expect(services.services.find((service) => service.type === "host")).toMatchObject({
      harnesses: ["cursor"],
      models: { cursor: ["composer-2.5"] },
    });
  });

  it("reads allow-unsandboxed-commands and checks it against the service's harnesses", async () => {
    const host = (harnesses: string, allowed: string) =>
      file(`services:
  laptop:
    type: host
    control-plane: https://supertag.acme.dev/
    harnesses: ${harnesses}
    models: { opencode: openai/gpt-6 }
    allow-unsandboxed-commands: ${allowed}
`);
    const loaded = await loadServicesFile({
      files: [
        await host("[claude-code, codex, cursor, opencode]", "[opencode, cursor, claude-code]"),
      ],
    });
    expect(loaded.services[0]).toMatchObject({
      allowUnsandboxedCommands: ["claude-code", "cursor", "opencode"],
    });
    expect(renderServicesFile(loaded)).toContain(
      "allow-unsandboxed-commands: [claude-code, cursor, opencode]\n",
    );
    // The setting decides what runs, so changing it restarts the host.
    const without = await loadServicesFile({
      files: [await host("[claude-code, codex, cursor, opencode]", "[]")],
    });
    expect(without.services[0]).toMatchObject({ allowUnsandboxedCommands: [] });
    expect(renderServicesFile(without)).not.toContain("allow-unsandboxed-commands");
    expect(serviceFingerprint(without, without.services[0] as never)).not.toBe(
      serviceFingerprint(loaded, loaded.services[0] as never),
    );

    expect(await problems(await host("[claude-code, codex]", "[codex]"))).toEqual([
      expect.stringMatching(
        /services\.laptop\.allow-unsandboxed-commands: lists codex, which runs commands in its own OS sandbox and needs no opt-in/,
      ),
    ]);
    expect(await problems(await host("[codex]", "[claude-code]"))).toEqual([
      expect.stringMatching(
        /services\.laptop\.allow-unsandboxed-commands: lists claude-code, which is not in this service's harnesses/,
      ),
    ]);
    expect(await problems(await host("[claude-code]", "[cursor]"))).toEqual([
      expect.stringMatching(/lists cursor, which is not in this service's harnesses/),
    ]);
    expect(await problems(await host("[claude-code]", "[vim]"))).toEqual([
      expect.stringMatching(
        /services\.laptop\.allow-unsandboxed-commands: lists vim; list only claude-code or cursor or opencode/,
      ),
    ]);
    expect(await problems(await host("[claude-code]", "claude-code"))).toEqual([
      expect.stringMatching(
        /services\.laptop\.allow-unsandboxed-commands: must list harnesses, such as \[claude-code, cursor, opencode\]/,
      ),
    ]);
  });

  it("derives a host's default concurrency from the machine, clamped 2 through 8", async () => {
    const gb = 1024 ** 3;
    expect(machineWorkerConcurrency({ cpus: 14, memoryBytes: 36 * gb })).toBe(6);
    expect(machineWorkerConcurrency({ cpus: 64, memoryBytes: 36 * gb })).toBe(6);
    expect(machineWorkerConcurrency({ cpus: 14, memoryBytes: 128 * gb })).toBe(7);
    expect(machineWorkerConcurrency({ cpus: 4, memoryBytes: 8 * gb })).toBe(2);
    expect(machineWorkerConcurrency({ cpus: 1, memoryBytes: 1 * gb })).toBe(2);
    expect(machineWorkerConcurrency({ cpus: 128, memoryBytes: 512 * gb })).toBe(8);
    const loaded = await loadServicesFile({
      files: [
        await file(`services:
  laptop:
    type: host
    control-plane: https://supertag.acme.dev/
    harnesses: [claude-code]
`),
      ],
    });
    expect(loaded.services[0]).toMatchObject({
      concurrency: machineWorkerConcurrency(),
      concurrencySource: "machine",
    });
    expect(renderServicesFile(loaded)).toContain(
      `concurrency: ${machineWorkerConcurrency()} # from this machine's CPU cores and memory`,
    );
  });

  it("refuses Control Plane artifact storage settings: the Control Plane stores no artifacts", async () => {
    for (const setting of [
      "artifacts: { volume: artifacts }",
      'storage: { artifacts: "s3://acme-supertag/artifacts" }',
      "volume-credentials: { artifact-keys: { file: /etc/supertag/artifact-keys.json } }",
    ]) {
      const key = setting.slice(0, setting.indexOf(":"));
      const refused = await problems(
        await file(`services:\n  cp:\n    type: control-plane\n    ${setting}\n`, `${key}.yaml`),
      );
      expect(refused).toEqual([
        expect.stringMatching(new RegExp(`services\\.cp\\.${key}: unknown field; expected one of`)),
      ]);
      expect(refused[0]).not.toMatch(/expected one of .*(artifacts|volume-credentials)/u);
    }
    const local = await loadServicesFile({
      files: [await file("services:\n  cp: { type: control-plane }\n", "local.yaml")],
    });
    expect(local.services[0]).not.toHaveProperty("artifacts");
    expect(local.services[0]).not.toHaveProperty("volumeCredentials");
    expect(renderServicesFile(local)).not.toMatch(/artifacts|volume-credentials/u);
  });

  it("reports every problem at once with file:line:column and the key path", async () => {
    const path = await file(`services:
  cp:
    type: control-plane
    port: 3434
    ports: ["99999"]
    database: { url: "postgresql://supertag:secret@db/supertag", password: missing }
    restart: always
  other: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex, opencode]
    workspaces: { app: relative/path }
    depends_on: [nowhere]
  broken: { harnesses: [codex] }
unknown: 1
`);
    const found = await problems(path);
    const expected = [
      /supertag\.yaml:15:1: unknown: unknown field; expected one of version, name, services/,
      /supertag\.yaml:8:3: services\.other: only one control-plane service is allowed; cp is already one/,
      /supertag\.yaml:4:5: services\.cp\.port: unknown field; expected one of type, ports/,
      /supertag\.yaml:5:13: services\.cp\.ports\.0: must be "PORT" or "IP:PORT"/,
      /supertag\.yaml:6:17: services\.cp\.database\.url: must not contain a password; name a secret in database\.password instead/,
      /supertag\.yaml:6:66: services\.cp\.database\.password: must name an entry in secrets/,
      /supertag\.yaml:7:5: services\.cp\.restart: must be no or unless-stopped/,
      /supertag\.yaml:9:3: services\.laptop\.models: needs opencode: PROVIDER\/MODEL/,
      /supertag\.yaml:12:19: services\.laptop\.workspaces\.app: must be an absolute or ~ path/,
      /supertag\.yaml:13:18: services\.laptop\.depends_on\.0: nowhere is not another service/,
      /supertag\.yaml:14:3: services\.broken\.type: is required: control-plane or host/,
    ];
    for (const pattern of expected)
      expect(found).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
    await expect(loadServicesFile({ files: [path] })).rejects.toThrow(
      /^Invalid supertag\.yaml:\n {2}/,
    );
    // YAML syntax errors have a position too.
    expect(await problems(await file("services: [1\n"))).toEqual([
      expect.stringMatching(/supertag\.yaml:\d+:\d+: /),
    ]);
    expect(await problems(await file("- control-plane\n"))).toEqual([
      expect.stringMatching(/is a map with services/),
    ]);
    // A host with no control-plane service in the file must name a URL; cycles are refused.
    expect(
      await problems(
        await file(`services:
  a: { type: host, harnesses: [codex], control-plane: "https://x.example", depends_on: [b] }
  b: { type: host, harnesses: [codex], control-plane: "https://x.example", depends_on: [a] }
  c: { type: host, harnesses: [codex] }
`),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /services\.c\.control-plane: is required: this file has no control-plane service/,
        ),
        expect.stringMatching(/depends_on: forms a cycle: a -> b -> a/),
      ]),
    );
    // auth-key is only for a URL Control Plane.
    expect(
      await problems(
        await file(`services:
  control-plane: { type: control-plane }
  laptop: { type: host, harnesses: [codex], auth-key: key }
secrets:
  key: { file: k }
`),
      ),
    ).toEqual([
      expect.stringMatching(/services\.laptop\.auth-key: is only for a URL control-plane/),
    ]);
  });

  it("merges -f files in order: maps by key, lists replace, null removes", async () => {
    const base = await file(
      `services:
  control-plane:
    type: control-plane
    ports: ["3434"]
    notify: slack:C0123456789
  laptop:
    type: host
    harnesses: [codex, claude-code]
    labels: [gpu]
    workspaces: { app: /code/app }
`,
      "supertag.yaml",
      "base",
    );
    const override = await file(
      `services:
  control-plane:
    ports: ["4000"]
    notify: null
  laptop:
    harnesses: [codex]
    workspaces: { docs: /code/docs }
`,
      "staging.yaml",
      "staging",
    );
    const resolved = await loadServicesFile({
      files: [base, join(directory, "staging", "staging.yaml")],
    });
    expect(resolved.files).toEqual([base, override]);
    expect(resolved.services[0]).toMatchObject({ ports: { port: 4000 } });
    expect(resolved.services[0]).not.toHaveProperty("notify");
    expect(resolved.services[1]).toMatchObject({
      harnesses: ["codex"],
      labels: ["gpu"],
      workspaces: { app: "/code/app", docs: "/code/docs" },
    });
    // A directory names the supertag.yaml inside it; problems point at the file that set the value.
    expect((await loadServicesFile({ files: [join(directory, "base")] })).files).toEqual([base]);
    const bad = await file("services:\n  laptop:\n    harnesses: [vim]\n", "bad.yaml", "staging");
    expect(await problems(base, bad)).toEqual([
      expect.stringMatching(
        /staging[/\\]bad\.yaml:3:5: services\.laptop\.harnesses: must list one or more of/,
      ),
    ]);
    await expect(loadServicesFile({ files: ["missing.yaml"] })).rejects.toThrow(
      "missing.yaml does not exist",
    );
  });

  it("accepts desktop, webhook and Slack destinations with a named webhook secret", async () => {
    const path = await file(`secrets:
  hook: { environment: TEST_HOOK_TOKEN }
services:
  control-plane:
    type: control-plane
    notify: [desktop, "webhook:https://hooks.example/x?team=one#hook", slack:U0123]
`);
    const resolved = await loadServicesFile({ files: [path] });
    expect(resolved.services[0]?.notify).toEqual([
      "desktop",
      "webhook:https://hooks.example/x?team=one#hook",
      "slack:U0123",
    ]);
    const bad = await file(
      `services:
  control-plane: { type: control-plane, notify: "webhook:https://hooks.example/x#missing" }
`,
      "bad-notify.yaml",
    );
    expect(await problems(bad)).toEqual([
      expect.stringMatching(/services\.control-plane\.notify/u),
    ]);
  });

  it("interpolates variables, defaults, required variables, and $$", async () => {
    vi.stubEnv("DB_HOST", "db.internal");
    vi.stubEnv("EMPTY", "");
    const path = await file(`services:
  control-plane:
    type: control-plane
    url: https://\${PUBLIC_HOST:-supertag.example.com}
    database: { url: "postgresql://supertag@\${DB_HOST}/supertag" }
    notify: \${CHANNEL:-slack:C0123456789}
x-note: \${NEVER_INTERPOLATED}
`);
    const resolved = await loadServicesFile({ files: [path] });
    expect(resolved.services[0]).toMatchObject({
      url: "https://supertag.example.com",
      database: { url: "postgresql://supertag@db.internal/supertag" },
      notify: "slack:C0123456789",
    });
    expect(resolved.provenance.get("services.control-plane.database.url")).toBe(
      "environment: DB_HOST",
    );
    expect(
      await problems(
        await file(`services:
  control-plane:
    type: control-plane
    url: \${MISSING_URL}
    database: { url: "\${DATABASE:?set DATABASE to the shared PostgreSQL URL}" }
    notify: \${EMPTY:?}
`),
      ),
    ).toEqual([
      expect.stringMatching(
        /:4:5: \$\{MISSING_URL\} is not set\. Set it in the environment or an env_file, or give a default/,
      ),
      expect.stringMatching(
        /:5:17: \$\{DATABASE\} is required: set DATABASE to the shared PostgreSQL URL/,
      ),
      expect.stringMatching(/:6:5: \$\{EMPTY\} is required: set EMPTY/),
    ]);
    const lookup = (name: string) => ({ A: "1" })[name] ?? "";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation syntax under test
    expect(interpolateString("cost $$5 and ${A} and $A", (name) => lookup(name))).toBe(
      "cost $5 and 1 and 1",
    );
  });

  it("loads .env beside the file by default, an explicit env_file otherwise, and the environment wins", async () => {
    await file(
      "PORT_FROM_FILE=4100\nCHANNEL='slack:C0000000001'\n# a comment\nexport TOKEN_FILE=/k\n",
      ".env",
    );
    const path = await file(`services:
  control-plane:
    type: control-plane
    ports: ["\${PORT_FROM_FILE}"]
    notify: \${CHANNEL}
`);
    let resolved = await loadServicesFile({ files: [path] });
    expect(resolved.services[0]).toMatchObject({
      ports: { port: 4100 },
      notify: "slack:C0000000001",
    });
    expect(resolved.provenance.get("services.control-plane.ports.0")).toBe(
      "env_file: PORT_FROM_FILE",
    );
    vi.stubEnv("PORT_FROM_FILE", "4200");
    resolved = await loadServicesFile({ files: [path] });
    expect(resolved.services[0]).toMatchObject({ ports: { port: 4200 } });
    vi.stubEnv("PORT_FROM_FILE", undefined);

    await file("PORT_FROM_FILE=4300\n", "staging.env");
    const explicit = await file(
      `env_file: staging.env
services:
  control-plane: { type: control-plane, ports: ["\${PORT_FROM_FILE}"] }
`,
      "explicit.yaml",
    );
    expect((await loadServicesFile({ files: [explicit] })).services[0]).toMatchObject({
      ports: { port: 4300 },
    });
    expect(await problems(await file("env_file: nope.env\n", "missing-env.yaml"))).toEqual([
      expect.stringMatching(/:1:1: env_file: cannot read .*nope\.env/),
    ]);
  });

  it("lets SUPERTAG_* environment variables override the file and marks them in config", async () => {
    const path = await file(SHARED);
    vi.stubEnv("SUPERTAG_DATABASE_URL", "postgresql://override@db/supertag");
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", "5000");
    vi.stubEnv("SUPERTAG_OPERATOR_CHANNEL", "slack:C0000000002");
    vi.stubEnv("SUPERTAG_RPC_TRACE", "1");
    const resolved = await loadServicesFile({ files: [path] });
    expect(resolved.services[0]).toMatchObject({
      ports: { host: "0.0.0.0", port: 5000 },
      database: { url: "postgresql://override@db/supertag", password: "db-password" },
      notify: "slack:C0000000002",
      logging: { level: "trace" },
    });
    const rendered = renderServicesFile(resolved);
    expect(rendered).toContain(
      "url: postgresql://override@db/supertag # from SUPERTAG_DATABASE_URL",
    );
    expect(rendered).toContain("ports: [0.0.0.0:5000] # from SUPERTAG_GATEWAY_PORT");
    expect(rendered).toContain("notify: slack:C0000000002 # from SUPERTAG_OPERATOR_CHANNEL");
    expect(rendered).toContain("level: trace # from SUPERTAG_RPC_TRACE");
    expect(rendered).toContain('password: "<secret: db-password>"');
  });

  it("binds where SUPERTAG_GATEWAY_HOST says, and on a hosting platform's PORT", async () => {
    const path = await file(
      'services:\n  control-plane:\n    type: control-plane\n    ports: ["127.0.0.1:4100"]\n',
    );
    const resolve = async (environment: Record<string, string>) =>
      (await loadServicesFile({ files: [path], environment })).services[0];
    expect(await resolve({})).toMatchObject({ ports: { host: "127.0.0.1", port: 4100 } });
    // PORT alone may be any program's; it sets the port only on a hosting platform.
    expect(await resolve({ PORT: "8080" })).toMatchObject({ ports: { port: 4100 } });
    expect(
      await resolve({
        SUPERTAG_GATEWAY_HOST: "0.0.0.0",
        SUPERTAG_DEPLOYMENT_PLATFORM: "railway",
        PORT: "8080",
      }),
    ).toMatchObject({ ports: { host: "0.0.0.0", port: 8080 }, url: "http://127.0.0.1:8080" });
    expect(
      await resolve({
        SUPERTAG_DEPLOYMENT_PLATFORM: "railway",
        PORT: "8080",
        SUPERTAG_GATEWAY_PORT: "9000",
      }),
    ).toMatchObject({ ports: { host: "127.0.0.1", port: 9000 } });
    expect(await resolve({ SUPERTAG_GATEWAY_HOST: "[::]" })).toMatchObject({
      ports: { host: "::", port: 4100 },
    });
    vi.stubEnv("SUPERTAG_GATEWAY_HOST", "0.0.0.0");
    vi.stubEnv("SUPERTAG_DEPLOYMENT_PLATFORM", "render");
    vi.stubEnv("PORT", "10000");
    expect(renderServicesFile(await loadServicesFile({ files: [path] }))).toContain(
      "ports: [0.0.0.0:10000] # from SUPERTAG_GATEWAY_HOST, PORT",
    );
    // A unit carries the bind address, never the platform's PORT.
    expect(
      unitSettings({
        SUPERTAG_GATEWAY_HOST: "0.0.0.0",
        SUPERTAG_DEPLOYMENT_PLATFORM: "render",
        PORT: "10000",
      }),
    ).toEqual({ SUPERTAG_GATEWAY_HOST: "0.0.0.0" });
    await expect(
      loadServicesFile({ files: [path], environment: { SUPERTAG_GATEWAY_HOST: "not a host" } }),
    ).rejects.toThrow("SUPERTAG_GATEWAY_HOST must be an IP address or host name");
    await expect(
      loadServicesFile({
        files: [path],
        environment: { SUPERTAG_DEPLOYMENT_PLATFORM: "fly", PORT: "http" },
      }),
    ).rejects.toThrow("PORT must be an integer from 0 through 65535");
  });

  it("reads SUPERTAG_* overrides from env_file after the environment", async () => {
    await file("SUPERTAG_GATEWAY_PORT=5100\nSUPERTAG_OPERATOR_CHANNEL=slack:C0000000003\n", ".env");
    const path = await file("services:\n  control-plane: { type: control-plane }\n");
    vi.stubEnv("SUPERTAG_OPERATOR_CHANNEL", "slack:C0000000004");
    const resolved = await loadServicesFile({ files: [path] });
    expect(resolved.services[0]).toMatchObject({
      ports: { port: 5100 },
      notify: "slack:C0000000004",
    });
    const rendered = renderServicesFile(resolved);
    expect(rendered).toContain("# from env_file: SUPERTAG_GATEWAY_PORT");
    expect(rendered).toContain("# from SUPERTAG_OPERATOR_CHANNEL");
  });

  it("carries only non-secret SUPERTAG_* overrides into a service unit", () => {
    expect(isSecretSetting("SUPERTAG_DATABASE_URL", "postgresql://app:pw@db/supertag")).toBe(true);
    expect(isSecretSetting("SUPERTAG_DATABASE_URL", "postgresql://db/supertag?password=pw")).toBe(
      true,
    );
    expect(isSecretSetting("SUPERTAG_DATABASE_URL", "not a url")).toBe(true);
    expect(isSecretSetting("SUPERTAG_DATABASE_URL", "postgresql://app@db/supertag")).toBe(false);
    expect(isSecretSetting("SUPERTAG_DATABASE_URL", "file:/tmp/supertag.db")).toBe(false);
    expect(
      unitSettings({
        SUPERTAG_GATEWAY_PORT: " 4000 ",
        SUPERTAG_DATABASE_URL: "postgresql://app:pw@db/supertag",
        SUPERTAG_WORKLET_TRANSPORT: "embedded",
        SUPERTAG_ADMIN_TOKEN: "admin-secret",
        SUPERTAG_AUTH_KEY: "stak_secret",
        SUPERTAG_OPERATOR_CHANNEL: "",
        PGPASSWORD: "pw",
      }),
    ).toEqual({ SUPERTAG_GATEWAY_PORT: "4000", SUPERTAG_WORKLET_TRANSPORT: "embedded" });
  });

  it("keeps secret values out of config output and reads them only on request", async () => {
    vi.stubEnv("PGPASSWORD", "hunter2-from-env");
    await writeFile(join(directory, "laptop.key"), "stak_secret_value\n");
    const path = await file(`${SHARED.trimEnd()}
  laptop-key: { file: ../laptop.key }
`);
    const resolved = await loadServicesFile({ files: [path] });
    await main(["config", "-f", path]);
    const printed = output.join("");
    expect(printed).toContain("<secret: db-password>");
    expect(printed).not.toContain("hunter2-from-env");
    expect(printed).not.toContain("stak_secret_value");
    await expect(readSecret(resolved, "db-password")).resolves.toBe("hunter2-from-env");
    await expect(readSecret(resolved, "laptop-key")).resolves.toBe("stak_secret_value");
    vi.stubEnv("PGPASSWORD", undefined);
    await expect(readSecret(resolved, "db-password")).rejects.toThrow(
      "Secret db-password reads PGPASSWORD, which is not set in the environment or an env_file",
    );
    // A changed secret value is not part of the fingerprint.
    const fingerprint = serviceFingerprint(
      resolved,
      resolved.services[0] as ServicesFile["services"][number],
    );
    vi.stubEnv("PGPASSWORD", "another");
    expect(
      serviceFingerprint(await loadServicesFile({ files: [path] }), resolved.services[0] as never),
    ).toBe(fingerprint);
  });

  it("orders services by depends_on and fingerprints a host with its Control Plane's address", async () => {
    const path = await file(`${SOLO}  builder:
    type: host
    harnesses: [codex]
    depends_on: [laptop]
`);
    const resolved = await loadServicesFile({ files: [path] });
    expect(startOrder(resolved, ["builder"]).map((service) => service.name)).toEqual([
      "control-plane",
      "laptop",
      "builder",
    ]);
    expect(() => startOrder(resolved, ["nope"])).toThrow(
      /nope is not a service in .*Services: control-plane, laptop, builder/,
    );
    const laptop = resolved.services[1] as never;
    const before = serviceFingerprint(resolved, laptop);
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", "4555");
    const moved = await loadServicesFile({ files: [path] });
    expect(serviceFingerprint(moved, moved.services[1] as never)).not.toBe(before);
  });

  it("names a host service after the machine", () => {
    expect(serviceNameFromHostname("Dana-MacBook-Pro.local")).toBe("dana-macbook-pro");
    expect(serviceNameFromHostname("build_01.corp.example")).toBe("build_01-corp-example");
    expect(serviceNameFromHostname("--")).toBe("host");
    expect(serviceNameFromHostname("control-plane")).toBe("control-plane-host");
  });

  it("tells supertag.yaml apart from resource manifests", () => {
    expect(isSupertagYamlInput({}, "/x/supertag.yaml")).toBe(true);
    expect(isSupertagYamlInput({ services: {} })).toBe(true);
    expect(isSupertagYamlInput({ version: 1, name: "acme" })).toBe(true);
    expect(isSupertagYamlInput({ port: 3434 })).toBe(false);
    expect(isSupertagYamlInput({ apiVersion: "supertag/v1", kind: "Tag", metadata: {} })).toBe(
      false,
    );
    expect(isSupertagYamlInput({ services: {}, other: 2 })).toBe(false);
  });
});

describe("supertag config", () => {
  it("prints the resolved file, lists services, and fails on an invalid file", async () => {
    const path = await file(SOLO);
    expect(await main(["config", "-f", path])).toBe(0);
    const printed = output.join("");
    expect(printed).toContain(`# Resolved from ${path}`);
    expect(printed).toContain(
      "name: supertag\nversion: 1\nservices:\n  control-plane:\n    type: control-plane\n    ports: [127.0.0.1:3434]",
    );
    expect(printed).toContain("  laptop:\n    type: host\n    control-plane: control-plane\n");
    output.length = 0;
    expect(await main(["config", "--services", "-f", path])).toBe(0);
    expect(output.join("")).toBe("control-plane\nlaptop\n");
    output.length = 0;
    expect(await main(["config"])).toBe(0);
    expect(output.join("")).toContain("# No supertag.yaml found; these are the defaults");
    await expect(
      main(["config", "-f", await file("services: { x: { type: nope } }\n", "bad.yaml")]),
    ).rejects.toThrow(/bad\.yaml:1:\d+: services\.x\.type: must be control-plane or host/);
    output.length = 0;
    expect(await main(["help", "config"])).toBe(0);
    expect(output.join("")).toContain("supertag config [-f PATH...] [--services]");
    await expect(main(["config", "--migrate"])).rejects.toThrow(/Unknown option/);
  });
});

it("refuses remote OpenCode before up dry-run advertises the host", async () => {
  for (const environment of ["e2b", "{ modal: { app: test } }"]) {
    const path = await file(
      `services:\n  control-plane: { type: control-plane }\n  laptop:\n    type: host\n    harnesses: [opencode]\n    models: { opencode: openai/model }\n    environment: ${environment}\n`,
      `opencode-${environment === "e2b" ? "e2b" : "modal"}.yaml`,
    );
    await expect(main(["up", "--dry-run", "-f", path])).rejects.toThrow(
      /opencode cannot run with (e2b|modal) environment: OpenCode would need provider keys inside the sandbox/,
    );
  }
});

it("keeps local OpenCode available to host services", async () => {
  const path = await file(
    "services:\n  control-plane: { type: control-plane }\n  laptop:\n    type: host\n    harnesses: [opencode]\n    models: { opencode: openai/model }\n",
    "local-opencode.yaml",
  );
  await expect(main(["up", "--dry-run", "-f", path])).resolves.toBe(0);
  expect(output.join("")).toContain("start laptop: not running");
});

describe("apply and diff", () => {
  beforeEach(() => {
    // Rejection happens before any request, so the Control Plane need not exist.
    vi.stubEnv("SUPERTAG_CONTROL_PLANE", "http://127.0.0.1:9");
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", "unused");
  });

  it("reject supertag.yaml and point to manifests and provision", async () => {
    for (const [name, text] of [
      ["supertag.yaml", SOLO],
      ["project.yaml", "services:\n  control-plane: { type: control-plane }\n"],
    ] as const) {
      const path = await file(text, name);
      for (const command of ["apply", "diff"])
        await expect(main([command, "-f", path])).rejects.toThrow(
          /is a supertag\.yaml, which lists the services supertag up runs[\s\S]*supertag apply -f tag\.yaml[\s\S]*provision/,
        );
    }
  });

  it("require an explicit --set to prune", async () => {
    const path = await file(
      "apiVersion: supertag/v1\nkind: Tag\nmetadata:\n  name: lead\nspec: {}\n",
      "tag.yaml",
    );
    await expect(main(["apply", "-f", path, "--prune"])).rejects.toThrow(
      /--prune requires --set NAME/,
    );
  });
});

describe("config output", () => {
  it("masks database passwords", async () => {
    const { redactDatabaseUrl } = await import("../apps/cli/src/supertag-yaml.js");
    expect(redactDatabaseUrl("postgresql://u:hunter2@db/supertag")).toBe(
      "postgresql://u:****@db/supertag",
    );
    expect(redactDatabaseUrl("postgresql://u@db/supertag?password=hunter2")).toBe(
      "postgresql://u@db/supertag?password=****",
    );
    expect(redactDatabaseUrl("postgresql://u@db/supertag")).toBe("postgresql://u@db/supertag");
    expect(redactDatabaseUrl("file:/tmp/supertag.db")).toBe("file:/tmp/supertag.db");
    expect(redactDatabaseUrl("not a url hunter2")).not.toContain("hunter2");
  });
});
