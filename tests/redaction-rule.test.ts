import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { workspaceSkillPins } from "../packages/control-plane/src/workspace-skill-pins.js";
import { emptyTagContextPlan, type TaskEvent } from "../packages/core/src/index.js";
import {
  redactEventDiagnostics,
  redactResultDiagnostics,
} from "../packages/runtime/sdk/src/event-redaction.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import {
  redactText,
  sensitiveEnvironmentValues,
  sensitiveFieldValues,
} from "../packages/runtime/sdk/src/redaction.js";

type Row = {
  name: string;
  env: Record<string, string>;
  type: string;
  field: string;
  value: unknown;
  expected: unknown;
  resolved?: Record<string, unknown>;
  journal?: boolean;
  receipt?: boolean;
  explicit?: string[];
  milliseconds?: number;
  skillPins?: boolean;
};
const token = "ghp_HostSecretValue1234567890";
const uri = `supertag-artifact:sha256:${"a".repeat(64)}`;
const host = { GITHUB_TOKEN: token };
const ordinary = {
  POSTGRES_PASSWORD: "supertag",
  MYSQL_ROOT_PASSWORD: "root",
  REDIS_PASSWORD: "write",
};
const rows: Row[] = [];
const fields: Record<string, string[]> = {
  "tool.call.started": ["call.resources.0.uri", "call.arguments.command"],
  "tool.call.completed": ["outcome.references.0", "call.resources.0.uri"],
  "tool.call.failed": ["error.stderr", "error.stack", "error.name"],
  "execution.failed": ["error.stderr", "error.stack", "error.name"],
  "artifact.created": ["artifact.uri", "artifact.path", "artifact.provenance.source"],
  "usage.updated": ["usage.unpricedModel"],
  result: [
    "result.references.0.reference",
    "result.changes.0.reference",
    "result.findings.0.location",
    "result.artifacts.0.paths.0",
  ],
};
for (const [type, paths] of Object.entries(fields)) {
  for (const field of paths) {
    for (const [label, value, expected] of [
      ["host", `/repo/${token}`, "/repo/[REDACTED]"],
      [
        "URL",
        "https://user:pw@host/path?access_token=query-secret",
        "https://[REDACTED]@host/path?access_token=[REDACTED]",
      ],
    ])
      rows.push({ name: `F1 ${label} ${type} ${field}`, env: host, type, field, value, expected });
  }
}
for (const prefix of ["call.arguments", "request.data", "artifact.provenance", "extension"]) {
  const type =
    prefix === "call.arguments"
      ? "tool.call.started"
      : prefix === "request.data"
        ? "approval.requested"
        : prefix === "artifact.provenance"
          ? "artifact.created"
          : "future.event";
  for (const key of [
    "accessToken",
    "apiKey",
    "clientSecret",
    "privateKey",
    "refreshToken",
    "authorization",
    "password",
    "token",
    "secret",
    "access_token",
    "api_key",
    "client_secret",
    "private_key",
    "refresh_token",
    "AUTHORIZATION",
  ]) {
    rows.push({
      name: `F2 ${prefix}.${key}`,
      env: {},
      type,
      field: `${prefix}.nested.${key}`,
      value: { arbitrary: [42, "unregistered"] },
      expected: "[REDACTED]",
    });
  }
  for (const field of ["command", "url", "headers.Authorization", "files.0.content"])
    rows.push({
      name: `F2 ${prefix}.${field}`,
      env: host,
      type,
      field: `${prefix}.${field}`,
      value: token,
      expected: "[REDACTED]",
    });
}
// Object-field vocabulary and UPPER_SNAKE environment segments share the stored-data rule.
const credentialNames = [
  "token",
  "secret",
  "password",
  "passphrase",
  "pwd",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "set-cookie",
  "jwt",
  "signature",
  "apikey",
  "api_key",
  "api-key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "secretkey",
  "clientsecret",
  "client_secret",
  "sshkey",
  "apiKey",
  "accessKey",
  "privateKey",
  "secretKey",
  "clientSecret",
  "sshKey",
];
const identifierNames = [
  "sourceItemKey",
  "sessionKey",
  "itemKey",
  "sortKey",
  "idempotencyKey",
  "cursorKey",
  "source_item_key",
  "session_key",
  "item_key",
  "sort_key",
  "idempotency_key",
  "cursor_key",
  "key",
  "authKey",
  "signingKey",
  "requestSig",
  "PROVIDER_KEY",
  "SERVICE_AUTH",
  "DB_PASS",
  "PASSWD",
  "GITHUB_PAT",
  "PROVIDER_SK",
];
for (const [names, sensitive] of [
  [credentialNames, true],
  [identifierNames, false],
] as const) {
  for (const base of names) {
    for (const key of new Set([base, base.toLowerCase(), base.toUpperCase()])) {
      rows.push({
        name: `credential vocabulary object ${key}`,
        env: {},
        type: "tool.call.started",
        field: `call.arguments.${key}`,
        value: "skill:code-review",
        expected:
          sensitive ||
          (key === key.toUpperCase() && /(?:^|_)(?:KEY|AUTH|PASS|PASSWD|PAT|SK)(?:_|$)/u.test(key))
            ? "[REDACTED]"
            : "skill:code-review",
        journal: true,
      });
      const querySensitive = sensitive || key.toLowerCase() === "key";
      rows.push({
        name: `credential vocabulary query ${key}`,
        env: {},
        type: "tool.call.started",
        field: "call.arguments.url",
        value: `https://host/?${key}=skill:code-review`,
        expected: `https://host/?${key}=${querySensitive ? "[REDACTED]" : "skill:code-review"}`,
      });
    }
  }
}
const environmentCredentialNames = [
  "SK",
  "PROVIDER_SK",
  "KEY",
  "TOKEN",
  "SECRET",
  "PASS",
  "PASSWD",
  "PASSWORD",
  "PAT",
  "CREDENTIAL",
  "CREDENTIALS",
  "AUTH",
  "COOKIE",
  "DB_PASS",
  "GITHUB_PAT",
  "PROVIDER_KEY",
  "HOST_PRIVATE_KEY",
  "AWS_ACCESS_KEY_ID",
  "X_AUTH",
  "SESSION_COOKIE",
  "PRIVATE_KEY",
  "ACCESS_KEY",
  "API_KEY",
  "DB_PWD",
  "_DB_PASS",
  "DB__PASS",
  "DB_PASS_",
  "_GITHUB_PAT",
  "__KEY",
  "X__AUTH",
  "_PWD",
  ...[
    "KEY",
    "TOKEN",
    "SECRET",
    "PASS",
    "PASSWD",
    "PASSWORD",
    "PWD",
    "PAT",
    "CREDENTIAL",
    "CREDENTIALS",
    "AUTH",
    "COOKIE",
  ].flatMap((segment) => [`PREFIX_${segment}`, `${segment}_VALUE`, `PREFIX_${segment}_VALUE`]),
];
const readableNames = [
  "PWD",
  "OLDPWD",
  "KEYBOARD_LAYOUT",
  "__KEYBOARD_",
  "_PATH_",
  "SKU",
  "TASK",
  "skuKey",
  "provider_sk",
  "providerSk",
  "MONKEY",
  "COMPASS",
  "PATTERN",
  "AUTHORS",
  "PATH",
  "PASSWORD_STORE_DIR",
  "APP_ID",
  "sourceItemKey",
  "sessionKey",
  "itemKey",
  "sortKey",
  "idempotencyKey",
  "cursorKey",
  "source_item_key",
  "session_key",
  "item_key",
  "sort_key",
  "idempotency_key",
  "cursor_key",
  "provider_key",
  "db_pass",
];
for (const [names, sensitive] of [
  [environmentCredentialNames, true],
  [readableNames, false],
] as const) {
  for (const key of new Set(names)) {
    const value = "/test/credential-value";
    for (const source of ["object", "host", "resolved"] as const) {
      rows.push({
        name: `environment segments ${source} ${key}`,
        env: source === "host" ? { [key]: value } : {},
        resolved: source === "resolved" ? { runtimeEnvironment: { [key]: value } } : undefined,
        type: "tool.call.started",
        field: source === "object" ? `call.arguments.${key}` : "call.arguments.command",
        value,
        expected:
          sensitive || (source === "object" && /^(?:OLD)?PWD$/u.test(key)) ? "[REDACTED]" : value,
        journal: true,
      });
    }
  }
}
for (const [field, value] of [
  ["call.effect", "write"],
  ["call.id", "supertag"],
  ["call.arguments.path", "/root/repo/supertag/write"],
  ["call.resources.0.uri", "https://supertag.test/root/write"],
  ["outcome.references.0", "https://supertag.test/root/write"],
  ["outcome.references.0", uri],
])
  rows.push({
    name: `M3 ordinary ${field} ${value}`,
    env: ordinary,
    type: "tool.call.completed",
    field: field ?? "",
    value,
    expected: value,
  });
for (const [name, value, expected] of [
  ["PWD", "/Users/op/work/repo", "wrote /Users/op/work/repo/src/a.ts"],
  ["OLDPWD", "/Users/op", "wrote /Users/op/work/repo/src/a.ts"],
  ["DB_PWD", "/Users/op/work/repo", "wrote [REDACTED]/src/a.ts"],
] as const)
  rows.push({
    name: `shell working directory ${name}`,
    env: { [name]: value },
    type: "output.delta",
    field: "text",
    value: "wrote /Users/op/work/repo/src/a.ts",
    expected,
  });
rows.push(
  {
    name: "M3 free-text error",
    env: ordinary,
    type: "execution.failed",
    field: "error.message",
    value: "supertag root write",
    expected: "[REDACTED] [REDACTED] [REDACTED]",
  },
  {
    name: "M3 URI embedded in free text",
    env: ordinary,
    type: "output.delta",
    field: "text",
    value: "write https://supertag.test/root/write",
    expected: "[REDACTED] https://supertag.test/root/write",
  },
  {
    name: "G1 journal usage.apiToken",
    env: {},
    type: "usage.updated",
    field: "usage.apiToken",
    value: "unregistered",
    expected: "[REDACTED]",
    journal: true,
  },
  {
    name: "artifact digest",
    env: { HOST_SECRET: "a".repeat(64) },
    resolved: { runtimeEnvironment: { PASSWORD: "a".repeat(64) } },
    type: "artifact.created",
    field: "artifact.uri",
    value: uri,
    expected: uri,
  },
  {
    name: "F8 resolved short password",
    env: ordinary,
    resolved: { runtimeEnvironment: { PASSWORD: "root" } },
    type: "execution.failed",
    field: "error.message",
    value: "--password root",
    expected: "--password [REDACTED]",
  },
  {
    name: "resolved short password in path",
    env: {},
    resolved: { runtimeHeaders: { authorization: "root" } },
    type: "artifact.created",
    field: "artifact.path",
    value: "/root/repo",
    expected: "/[REDACTED]/repo",
  },
  {
    name: "enum with high-confidence match",
    env: {},
    resolved: { runtimeEnvironment: { PASSWORD: "write" } },
    type: "tool.call.started",
    field: "call.effect",
    value: "write",
    expected: "write",
  },
  {
    name: "ordinary uppercase word in URI",
    env: { HOST_TOKEN: "ORDINARYWORD" },
    type: "artifact.created",
    field: "artifact.uri",
    value: "https://host/ORDINARYWORD",
    expected: "https://host/ORDINARYWORD",
  },
  {
    name: "mixed-case host token in URI",
    env: { HOST_TOKEN: "MixedCase" },
    type: "artifact.created",
    field: "artifact.uri",
    value: "https://host/MixedCase",
    expected: "https://host/[REDACTED]",
  },
  {
    name: "URL userinfo JSON boundary",
    env: {},
    type: "output.delta",
    field: "text",
    value: '"https://u:pw@host/path","email":"a@b.c"}',
    expected: '"https://[REDACTED]@host/path","email":"a@b.c"}',
  },
  {
    name: "URL port path",
    env: {},
    type: "artifact.created",
    field: "artifact.uri",
    value: "https://registry.npmjs.org:443/@scope/pkg",
    expected: "https://[REDACTED]@scope/pkg",
  },
  {
    name: "URL adjacent scheme-relative passwords",
    env: { MIRRORS_URL: "https://u:first-password@a/x;//u:second-password@h" },
    type: "output.delta",
    field: "text",
    value: "first-password second-password",
    expected: "[REDACTED] [REDACTED]",
  },
  {
    name: "F5 linear labels",
    env: ordinary,
    type: "execution.failed",
    field: "error.message",
    value: `${"pass-".repeat(13108)} password=root`,
    expected: `${"pass-".repeat(13108)} password=[REDACTED]`,
    milliseconds: 500,
  },
);

for (const field of [
  "call.arguments.filePath",
  "call.arguments.file_path",
  "artifact.provenance.sourcePath",
]) {
  rows.push({
    name: `M3 structural suffix ${field}`,
    env: ordinary,
    type: "future.event",
    field,
    value: "/root/supertag/write",
    expected: "/root/supertag/write",
  });
}
rows.push({
  name: "M3 non-hierarchical URI in free text",
  env: ordinary,
  type: "output.delta",
  field: "text",
  value: "write mailto:root@supertag.test urn:example:root",
  expected: "[REDACTED] mailto:root@supertag.test urn:example:root",
});
for (const credential of ["x", "12", "abc", "root"]) {
  rows.push({
    name: `resolved credential at any length: ${credential}`,
    env: {},
    resolved: { runtimeEnvironment: { PASSWORD: credential } },
    type: "artifact.created",
    field: "artifact.path",
    value: `/pre${credential}post/report`,
    expected: "/pre[REDACTED]post/report",
  });
}
rows.push(
  {
    name: "explicit short credential",
    env: ordinary,
    explicit: ["root"],
    type: "output.delta",
    field: "text",
    value: "--password root",
    expected: "--password [REDACTED]",
  },
  {
    name: "receipt uses the resolved credential rule",
    env: ordinary,
    resolved: { runtimeEnvironment: { PASSWORD: "root" } },
    type: "execution.failed",
    field: "error.message",
    value: "--password root",
    expected: "--password [REDACTED]",
    journal: true,
    receipt: true,
  },
  {
    name: "low-confidence URI with masked query",
    env: ordinary,
    type: "output.delta",
    field: "text",
    value: "https://root/path?token=pw&safe=root",
    expected: "https://root/path?token=[REDACTED]&safe=root",
  },
  {
    name: "URI userinfo followed by email JSON",
    env: {},
    type: "output.delta",
    field: "text",
    value: '"https://u:pw@host","email":"a@b.c"',
    expected: '"https://[REDACTED]@host","email":"a@b.c"',
  },
  {
    name: "adjacent scheme-relative password has no combined remainder",
    env: {},
    type: "output.delta",
    field: "text",
    value: "https://u:pw1abcd@a/x;//u:pw2abcd@h",
    expected: "https://[REDACTED]@a/x;//[REDACTED]@h",
  },
);

// Enum-position review regressions. Result rows also exercise direct Task result storage.
for (const [type, field, value, expected] of [
  ["tool.call.started", "call.arguments.type", "https://u:pw@h", "https://[REDACTED]@h"],
  [
    "tool.call.started",
    "call.arguments.opts.method",
    "https://h/?token=pw",
    "https://h/?token=[REDACTED]",
  ],
  ["tool.call.started", "call.arguments.headers.type", token, "[REDACTED]"],
  ["execution.failed", "error.kind", token, "[REDACTED]"],
  ["execution.failed", "error.operation", token, "[REDACTED]"],
  ["future.event", "data.status", token, "[REDACTED]"],
  ["result", "result.findings.0.severity", token, "[REDACTED]"],
  ["result", "result.extra.type", token, "[REDACTED]"],
  ["tool.call.started", "call.effect", token, "[REDACTED]"],
  ["tool.call.started", "call.provider", token, "[REDACTED]"],
  ["tool.call.started", "call.operation", token, "[REDACTED]"],
  ["tool.call.started", "call.binding.kind", token, "[REDACTED]"],
  ["execution.limits.applied", "applied.maxNativeAgents.method", token, "[REDACTED]"],
  ["future.event", "call.effect", "write", "[REDACTED]"],
  ["future.event", "type", token, "[REDACTED]"],
  ["tool.call.completed", "call.kind", "root", "[REDACTED]"],
  ["tool.call.completed", "call.status", "supertag", "[REDACTED]"],
] as const)
  rows.push({
    name: `enum F1 ${field} ${type}`,
    env: ordinary,
    explicit: ["write"],
    resolved: { runtimeHeaders: { authorization: token } },
    type,
    field,
    value,
    expected,
  });
for (const [type, field, value] of [
  ["tool.call.started", "call.effect", "write"],
  ["tool.call.started", "call.binding.kind", "mcp-http"],
  ["agent.updated", "agent.status", "running"],
  ["command.updated", "command.status", "completed"],
  ["progress.updated", "progress.items.0.status", "active"],
  ["result", "result.findings.0.severity", "high"],
  ["result", "result.findings.0.status", "open"],
  ["result", "result.decisions.0.status", "accepted"],
  ["result", "result.references.0.relationship", "changed"],
  ["execution.limits.applied", "applied.maxReportedTokens.method", "interrupt-on-report"],
] as const)
  rows.push({
    name: `enum valid ${field}`,
    env: {},
    explicit: [value],
    type,
    field,
    value,
    expected: value,
  });
for (const password of ["2024/Secret", "443/abcdEFGH", "2024?Secret", "1234#frag"]) {
  rows.push({
    name: `enum F2 URL ${password}`,
    env: {},
    type: "artifact.created",
    field: "artifact.uri",
    value: `https://user:${password}@h`,
    expected: "https://[REDACTED]@h",
  });
  rows.push({
    name: `enum F2 collected ${password}`,
    env: { DATABASE_URL: `https://user:${password}@h` },
    type: "output.delta",
    field: "text",
    value: `echo ${password}`,
    expected: "echo [REDACTED]",
  });
}
for (const secret of ["1", "a", "root", "abcdefg"]) {
  for (const [field, value] of [
    ["artifact.id", `artifact-${secret}`],
    ["artifact.digest", `sha256:${secret.repeat(64).slice(0, 64)}`],
    ["artifact.path", `/pre${secret}post/${secret}/report`],
    ["artifact.uri", `file:///repo/f${secret}.txt`],
    ["artifact.name", `skill:rele${secret}se-tools`],
  ] as const)
    rows.push({
      name: `enum F3 short structural ${field} ${secret}`,
      env: {},
      explicit: [secret],
      type: "artifact.created",
      field,
      value,
      expected: value.replaceAll(secret, "[REDACTED]"),
    });
  for (const [field, value, expected] of [
    ["artifact.path", secret, "[REDACTED]"],
    [
      "artifact.uri",
      `https://u:${secret}@h/?token=${secret}`,
      "https://[REDACTED]@h/?token=[REDACTED]",
    ],
    ["artifact.description", `pre${secret}post`, "pre[REDACTED]post"],
    ["artifact.headers.custom", secret, "[REDACTED]"],
  ] as const)
    rows.push({
      name: `enum F3 whole component ${field} ${secret}`,
      env: {},
      explicit: [secret],
      type: "artifact.created",
      field,
      value,
      expected,
    });
}
for (const value of ["true", "false", "yes", "no", "TRUE", "1234567", "1", "x", ".", "abc"])
  rows.push({
    name: `enum F4 ignored host ${value}`,
    env: { HOST_TOKEN: value },
    type: "output.delta",
    field: "text",
    value: `value ${value}`,
    expected: `value ${value}`,
  });
rows.push({
  name: "enum F7 free-text path example",
  env: ordinary,
  type: "output.delta",
  field: "text",
  value: "/workspace/supertag",
  expected: "/workspace/[REDACTED]",
});

const pin = {
  id: "skill:release-tools",
  kind: "skill",
  resource: {
    digest: `sha256:${"a1".repeat(32)}`,
    provenance: { provider: "supertag-workspace", source: ".claude/skills/root/release-tools" },
  },
};
rows.push({
  name: "short resolved secrets redact Skill pins as well as other stored content",
  env: { SERVICE_URL: "https://h/?token=1" },
  resolved: { runtimeEnvironment: { PASSWORD: "a", TOKEN: "root" } },
  type: "runtime-inputs.resolved",
  field: "manifest.inputs",
  value: [pin],
  expected: [
    {
      ...pin,
      id: "skill:rele[REDACTED]se-tools",
      resource: {
        digest: `sh[REDACTED]256:${"[REDACTED]".repeat(64)}`,
        provenance: {
          provider: "supert[REDACTED]g-worksp[REDACTED]ce",
          source: ".cl[REDACTED]ude/skills/[REDACTED]/rele[REDACTED]se-tools",
        },
      },
    },
  ],
  skillPins: true,
});
for (const [type, field, value, expected] of [
  ["tool.call.started", "call.effect", ["write"], ["[REDACTED]"]],
  ["tool.call.started", "call", [{ effect: "write" }], [{ effect: "[REDACTED]" }]],
  ["result", "result.findings", { severity: "high" }, { severity: "[REDACTED]" }],
] as const)
  rows.push({
    name: `enum F1 malformed shape ${field}`,
    env: {},
    explicit: ["write", "high"],
    type,
    field,
    value,
    expected,
  });

function setField(path: string[], value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  return /^\d+$/u.test(key) ? [setField(rest, value)] : { [key]: setField(rest, value) };
}
const journalBase = {
  "tool.call.started": {
    call: {
      id: "call-1",
      capabilityId: "github",
      provider: "github",
      binding: { kind: "mcp-http", name: "github" },
      operation: "create_issue",
      effect: "write",
      actions: [],
      resources: [],
    },
  },
  "usage.updated": {
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      totalTokens: 2,
      complete: true,
    },
  },
};
function merge(base: unknown, value: unknown): unknown {
  if (!base || typeof base !== "object" || Array.isArray(base)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, item] of Object.entries(value)) merged[key] = merge(merged[key], item);
  return merged;
}
function getField(value: unknown, path: string): unknown {
  return path.split(".").reduce((item, key) => (item as Record<string, unknown>)[key], value);
}

it.each(rows)("$name", async (row) => {
  const event = {
    type: row.type,
    ...(setField(row.field.split("."), row.value) as object),
  } as TaskAttemptEvent;
  const original = structuredClone(event);
  const secrets = [
    ...sensitiveEnvironmentValues(row.env),
    ...sensitiveFieldValues(row.resolved),
    ...(row.explicit ?? []),
  ];
  const started = performance.now();
  const stored = redactEventDiagnostics(event, (text, structural) =>
    redactText(text, secrets, structural),
  );
  const elapsed = performance.now() - started;
  if (row.skillPins) {
    expect(
      workspaceSkillPins([
        { type: "runtime-inputs.resolved", sequence: 1, payload: stored } as unknown as TaskEvent,
      ]),
    ).toBeUndefined();
  }
  expect(getField(stored, row.field)).toEqual(row.expected);
  expect(event).toEqual(original);
  if (row.type === "result") {
    const result = (event as Extract<TaskAttemptEvent, { type: "result" }>).result;
    expect(
      getField(
        redactResultDiagnostics(result, (text, structural) =>
          redactText(text, secrets, structural),
        ),
        row.field.slice("result.".length),
      ),
    ).toEqual(row.expected);
  }
  if (row.milliseconds) expect(elapsed).toBeLessThan(row.milliseconds);
  if (!row.journal) return;
  const directory = await mkdtemp(join(tmpdir(), "redaction-rule-"));
  const spec = {
    ...row.resolved,
    version: 1,
    taskId: "task",
    attemptId: "attempt",
    tag: { id: "tag", name: "Tag" },
    input: { messages: [] },
    authorization: {},
    contextPlan: emptyTagContextPlan("now"),
    execution: {},
    workerProfile: { id: "test", revision: "1" },
  } as TaskAttemptSpec;
  const worker: Worker = {
    async describe() {
      return {
        profileCapabilities: [{ profile: spec.workerProfile, capabilities: [], contextTypes: [] }],
        id: "worker",
        type: "test",
        capabilities: [],
        contextTypes: [],
        profiles: [spec.workerProfile],
      };
    },
    async *execute() {
      if (row.receipt) throw new Error(String(row.value));
      // The journal accepts only complete events, so the row's field joins a valid one.
      yield {
        ...(merge(journalBase[row.type as keyof typeof journalBase] ?? {}, event) as object),
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: "now",
      } as TaskAttemptEvent;
      yield {
        type: "execution.completed",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: "now",
      };
    },
  };
  for (const [name, value] of Object.entries(row.env)) vi.stubEnv(name, value);
  const durable = new DurableLocalWorklet(
    new LocalWorklet("local", "host", [worker]),
    new FileAttemptJournal(directory),
  );
  try {
    await durable.accept(spec);
    const events = [];
    for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
    if (row.receipt) {
      expect((await durable.inspect(spec.attemptId))?.uncertainty?.message).toBe(row.expected);
    } else expect(getField(events[0], row.field)).toEqual(row.expected);
  } finally {
    await durable.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
