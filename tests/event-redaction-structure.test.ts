import { expect, it } from "vitest";
import { buildTaskResult } from "../packages/control-plane/src/task-results.js";
import type { DurableInboundEvent } from "../packages/core/src/index.js";
import { redactEventDiagnostics } from "../packages/runtime/sdk/src/event-redaction.js";
import { defaultTaskResult, type TaskAttemptEvent } from "../packages/runtime/sdk/src/index.js";
import { redactText, sensitiveEnvironmentValues } from "../packages/runtime/sdk/src/redaction.js";

const secrets = sensitiveEnvironmentValues({
  POSTGRES_PASSWORD: "supertag",
  MYSQL_ROOT_PASSWORD: "root",
  REDIS_PASSWORD: "write",
  SERVICE_API_KEY: "long-secret-value",
  DB_PASSWORD: "hunter2",
  HOST_PASSWORD: "ZqvXab",
});
function redact(text: string, structural = false): string {
  return redactText(text, secrets, structural);
}

it("M3 keeps structural tool fields and collects their references and changes", () => {
  const uri = `supertag-artifact:sha256:${"a".repeat(64)}`;
  const reference = "https://example.test/root/write";
  const event = {
    type: "tool.call.completed" as const,
    taskId: "supertag",
    attemptId: "root",
    at: "now",
    call: {
      id: "root",
      capabilityId: "supertag",
      provider: "github",
      binding: { kind: "mcp-http" as const, name: "root" },
      operation: "create_issue",
      effect: "write" as const,
      actions: ["issues:write"],
      resources: [{ surfaceAccountId: "root", scope: "root", uri, reference }],
      arguments: { path: "/root/repo", uri, issueId: "root", body: "long-secret-value hunter2" },
    },
    outcome: { references: [uri, reference] },
  };
  const stored = redactEventDiagnostics(event, redact);
  expect(stored).toEqual({
    ...event,
    call: {
      ...event.call,
      capabilityId: "supertag",
      arguments: { ...event.call.arguments, body: "[REDACTED] [REDACTED]" },
    },
  });
  const work = {
    surfaceAccountId: "account",
    event: {
      provider: "slack",
      scope: "channel:general",
      source: { channelId: "general" },
    },
  } as DurableInboundEvent;
  const result = buildTaskResult(work, "done", [
    stored,
    {
      type: "result",
      result: defaultTaskResult("done"),
      taskId: "supertag",
      attemptId: "root",
      at: "now",
    },
  ]);
  expect(result.changes).toContainEqual({
    summary: "Completed github action create_issue",
    reference,
  });
  expect(result.references).toContainEqual(
    expect.objectContaining({ reference, resourceId: "root", relationship: "changed" }),
  );
  expect(event.call.arguments.body).toBe("long-secret-value hunter2");
});

it("preserves result identities, enums, references, and finding locations", () => {
  const result = {
    ...defaultTaskResult("long-secret-value hunter2"),
    decisions: [{ text: "long-secret-value", status: "accepted" as const }],
    changes: [{ summary: "hunter2", reference: "/root/repo" }],
    findings: [
      {
        id: "root",
        severity: "low" as const,
        status: "open" as const,
        summary: "long-secret-value",
        location: "/root/repo",
        reason: "hunter2",
      },
    ],
    fixedFindings: [{ taskId: "supertag", findingId: "root" }],
    references: [
      {
        provider: "github" as const,
        resourceType: "file" as const,
        reference: "/root/repo",
        relationship: "changed" as const,
      },
    ],
  };
  const stored = redactEventDiagnostics({ type: "result", result }, redact).result;
  expect(stored).toEqual({
    ...result,
    summary: "[REDACTED] [REDACTED]",
    fixedFindings: [{ taskId: "supertag", findingId: "root" }],
    decisions: [{ text: "[REDACTED]", status: "accepted" }],
    changes: [{ summary: "[REDACTED]", reference: "/root/repo" }],
    findings: [{ ...result.findings[0], summary: "[REDACTED]", reason: "[REDACTED]" }],
  });
});

it("preserves metadata identities while redacting explicit diagnostic fields", () => {
  const events: TaskAttemptEvent[] = [
    {
      type: "artifact.created",
      artifact: {
        id: "root",
        uri: "/root/repo",
        path: "/root/repo",
        digest: "supertag",
        name: "long-secret-value",
        provenance: { source: "/root/repo", description: "hunter2" },
      },
      taskId: "root",
      attemptId: "write",
      at: "now",
    },
    {
      type: "execution.failed",
      error: { name: "root", message: "hunter2" },
      taskId: "root",
      attemptId: "write",
      at: "now",
    },
  ];
  for (const event of events) {
    const stored = redactEventDiagnostics(event, redact);
    expect(JSON.stringify(stored)).not.toContain("hunter2");
    expect(stored.taskId).toBe("root");
    if (stored.type === "artifact.created") {
      expect(stored.artifact.uri).toBe("/root/repo");
      expect(stored.artifact.digest).toBe("supertag");
      expect(stored.artifact.provenance?.["source"]).toBe("/root/repo");
    }
    if (stored.type === "execution.failed") expect(stored.error.name).toBe("root");
  }
});

it("keeps short guessed values and ordinary words readable, but hides labelled passwords", () => {
  expect(
    sensitiveEnvironmentValues({
      TOKEN_LABEL: "root",
      SERVICE_AUTHORIZATION: "write",
      SERVICE_API_KEY: "abcdefg",
      SERVICE_CREDENTIAL: "abcdefg",
    }),
  ).toEqual([{ lowConfidence: "abcdefg" }, { lowConfidence: "write" }, { lowConfidence: "root" }]);
  expect(redactText("write to /root/repo with supertag; rooted writer", secrets)).toBe(
    "[REDACTED] to /[REDACTED]/repo with [REDACTED]; rooted writer",
  );
  expect(
    redactText(
      "password=root token=write password: supertag hunter2 long-secret-value ZqvXab",
      secrets,
    ),
  ).toBe(
    "password=[REDACTED] token=[REDACTED] password: [REDACTED] [REDACTED] [REDACTED] [REDACTED]",
  );
});

it("exempts structural short words while redacting unknown fields recursively", () => {
  const redactAnyText = (text: string, structural = false) => (structural ? text : "[REDACTED]");
  expect(
    redactEventDiagnostics(
      {
        type: "progress.updated",
        progress: {
          summary: "progress",
          items: [{ id: "active", status: "active", text: "working" }],
        },
      },
      redactAnyText,
    ),
  ).toEqual({
    type: "progress.updated",
    progress: {
      summary: "[REDACTED]",
      items: [{ id: "active", status: "active", text: "[REDACTED]" }],
    },
  });
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    totalTokens: 2,
    complete: true,
    reportedCost: { amountMinor: 0, currency: "USD", estimated: false },
    unpricedModel: "root",
  };
  expect(redactEventDiagnostics({ type: "usage.updated", usage }, redactAnyText).usage).toEqual({
    ...usage,
    unpricedModel: "[REDACTED]",
  });
  const data = {
    message: "failed",
    stdoutExcerpt: "output",
    stderrExcerpt: "error",
    secretId: "root",
    key: "root",
    resource_key: "root",
    status: "write",
    uri: "/root/repo",
    nested: { id: "root" },
  };
  expect(
    redactEventDiagnostics(
      { type: "approval.requested", request: { id: "root", description: "approve", data } },
      redactAnyText,
    ),
  ).toEqual({
    type: "approval.requested",
    request: {
      id: "root",
      description: "[REDACTED]",
      data: {
        ...data,
        status: "[REDACTED]",
        message: "[REDACTED]",
        stdoutExcerpt: "[REDACTED]",
        stderrExcerpt: "[REDACTED]",
        secretId: "[REDACTED]",
        key: "root",
        resource_key: "root",
        uri: "/root/repo",
      },
    },
  });
});

it("redacts usage by schema and recursively protects unknown fields", () => {
  const usage = {
    inputTokens: "secret-count",
    outputTokens: 0,
    cachedInputTokens: Number.MAX_SAFE_INTEGER,
    totalTokens: 40,
    complete: false,
    reportedCost: {
      amountMinor: 20,
      currency: "USD",
      estimated: true,
      apiToken: "secret-value",
      nested: [{ inputTokens: 123, note: "hunter2" }],
    },
    unpricedModel: "hunter2",
    apiToken: "secret-value",
    nested: { inputTokens: 123, password: { value: "secret-value" }, note: "hunter2" },
  };
  const event = { type: "usage.updated", usage } as unknown as TaskAttemptEvent;
  const original = structuredClone(event);
  expect(redactEventDiagnostics(event, redact)).toEqual({
    type: "usage.updated",
    usage: {
      ...usage,
      inputTokens: "[REDACTED]",
      reportedCost: {
        ...usage.reportedCost,
        apiToken: "[REDACTED]",
        nested: [{ inputTokens: "[REDACTED]", note: "[REDACTED]" }],
      },
      unpricedModel: "[REDACTED]",
      apiToken: "[REDACTED]",
      nested: { inputTokens: "[REDACTED]", password: "[REDACTED]", note: "[REDACTED]" },
    },
  });
  expect(event).toEqual(original);
});

it.each(["secret", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, {}, []])(
  "redacts malformed usage fields (%j)",
  (invalid) => {
    const event = {
      type: "usage.updated",
      usage: {
        inputTokens: invalid,
        outputTokens: invalid,
        cachedInputTokens: invalid,
        totalTokens: invalid,
        complete: invalid,
        reportedCost: { amountMinor: invalid, currency: invalid, estimated: invalid },
        unpricedModel: invalid,
      },
    } as unknown as TaskAttemptEvent;
    expect(redactEventDiagnostics(event, redact)).toEqual({
      type: "usage.updated",
      usage: {
        inputTokens: "[REDACTED]",
        outputTokens: "[REDACTED]",
        cachedInputTokens: "[REDACTED]",
        totalTokens: "[REDACTED]",
        complete: "[REDACTED]",
        reportedCost: {
          amountMinor: "[REDACTED]",
          currency: "[REDACTED]",
          estimated: "[REDACTED]",
        },
        unpricedModel: typeof invalid === "string" ? invalid : "[REDACTED]",
      },
    });
  },
);

const hostToken = "ghp_HostSecretValue1234567890";
const credentialUrl = `https://user:password@host/path?token=query-secret&key=key-secret`;
const leakedReference = `https://host/${hostToken}`;
const secretCall = {
  id: "call",
  capabilityId: "github",
  provider: "github",
  binding: { kind: "mcp-http", name: "github" },
  operation: "write",
  effect: "write",
  actions: [],
  resources: [{ uri: leakedReference }],
  arguments: {
    command: hostToken,
    url: credentialUrl,
    query: hostToken,
    headers: { Authorization: "unregistered" },
    files: [{ content: hostToken }],
    accessToken: "unregistered",
    apiKey: "unregistered",
    clientSecret: "unregistered",
    privateKey: "unregistered",
    refreshToken: "unregistered",
  },
};
const secretResource = {
  id: "resource",
  uri: leakedReference,
  path: hostToken,
  provenance: { nested: { command: hostToken, accessToken: "unregistered" } },
};
it.each([
  { type: "tool.call.started", call: secretCall },
  {
    type: "tool.call.completed",
    call: secretCall,
    outcome: { references: [leakedReference, credentialUrl] },
  },
  {
    type: "tool.call.failed",
    call: secretCall,
    error: { message: "failed", name: hostToken, stderr: hostToken, stack: hostToken },
  },
  { type: "artifact.created", artifact: secretResource },
  { type: "session.updated", sessionState: { ...secretResource, format: "session" } },
  {
    type: "usage.updated",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      complete: true,
      unpricedModel: hostToken,
    },
  },
  {
    type: "result",
    result: {
      ...defaultTaskResult("done"),
      changes: [{ summary: "done", reference: leakedReference }],
      references: [{ reference: credentialUrl }],
      findings: [
        { id: "F1", severity: "low", status: "open", summary: "found", location: leakedReference },
      ],
    },
  },
  {
    type: "approval.requested",
    request: { id: "approval", description: "approve", data: secretCall.arguments },
  },
  {
    type: "execution.failed",
    error: { message: "failed", name: hostToken, stderr: hostToken, stack: hostToken },
  },
  { type: "future.event", extension: secretCall.arguments },
])("redacts long host secrets and nested credentials in $type", (event) => {
  const original = structuredClone(event);
  const stored = redactEventDiagnostics(event as unknown as TaskAttemptEvent, (text) =>
    redactText(text, sensitiveEnvironmentValues({ GITHUB_TOKEN: hostToken })),
  );
  const serialized = JSON.stringify(stored);
  for (const secret of [hostToken, "unregistered", "user:password", "query-secret", "key-secret"])
    expect(serialized).not.toContain(secret);
  expect(event).toEqual(original);
});

it("protects token limits by exact schema without exempting extension fields", () => {
  const event = {
    type: "execution.limits.applied",
    requested: { maxReportedTokens: 1000 },
    applied: {
      maxReportedTokens: { limit: 1000, method: "interrupt-on-report", apiToken: "private-value" },
    },
    extension: { maxReportedTokens: "private-value" },
  } as unknown as TaskAttemptEvent;
  expect(redactEventDiagnostics(event, redact)).toEqual({
    ...event,
    applied: {
      maxReportedTokens: { limit: 1000, method: "interrupt-on-report", apiToken: "[REDACTED]" },
    },
    extension: { maxReportedTokens: "[REDACTED]" },
  });
});

it.each(["abcdefgh", hostToken])(
  "redacts eight-character and longer secrets in structural fields: %s",
  (secret) => {
    const event = {
      type: "progress.updated",
      progress: { summary: "working", items: [{ id: secret, status: "active", text: "working" }] },
    };
    const stored = redactEventDiagnostics(
      event as unknown as TaskAttemptEvent,
      (text, structural) => redactText(text, [secret], structural),
    );
    expect(JSON.stringify(stored)).not.toContain(secret);
  },
);

it("redacts all URL and path slots while preserving artifact references and short path words", () => {
  const uri = `supertag-artifact:sha256:${"b".repeat(64)}`;
  for (const value of [leakedReference, credentialUrl, "/root/repo", uri]) {
    const event = {
      type: "result",
      result: {
        ...defaultTaskResult("done"),
        changes: [{ summary: "done", reference: value }],
        findings: [
          { id: "F1", severity: "low", status: "open", summary: "found", location: value },
        ],
        references: [{ reference: value }],
        extension: { uri: value, path: value },
      },
    } as unknown as TaskAttemptEvent;
    const stored = redactEventDiagnostics(event, (text, structural) =>
      redactText(text, [...secrets, hostToken], structural),
    );
    const expected =
      value === leakedReference
        ? "https://host/[REDACTED]"
        : value === credentialUrl
          ? "https://[REDACTED]@host/path?token=[REDACTED]&key=[REDACTED]"
          : value;
    expect(stored).toMatchObject({
      result: {
        changes: [{ reference: expected }],
        findings: [{ location: expected }],
        references: [{ reference: expected }],
        extension: { uri: expected, path: expected },
      },
    });
  }
});

it("redacts high-confidence secrets in artifact selection paths and extensions", () => {
  const event = {
    type: "result",
    result: {
      ...defaultTaskResult("done"),
      artifacts: [
        {
          artifactId: "artifact-1",
          paths: [`${hostToken}/report.txt`],
          extension: { accessToken: "unregistered", text: hostToken },
        },
      ],
    },
  } as unknown as TaskAttemptEvent;
  expect(
    redactEventDiagnostics(event, (text, structural) => redactText(text, [hostToken], structural)),
  ).toMatchObject({
    result: {
      artifacts: [
        {
          artifactId: "artifact-1",
          paths: ["[REDACTED]/report.txt"],
          extension: { accessToken: "[REDACTED]", text: "[REDACTED]" },
        },
      ],
    },
  });
});
