import { expect, it } from "vitest";
import { redactDiagnostics, redactEventDiagnostics } from "./src/event-redaction.js";
import {
  isSensitiveName,
  redactText,
  sensitiveEnvironmentValues,
  sensitiveFieldValues,
} from "./src/redaction.js";

it.each(["abc1", "x", "root"])("N3 masks short resolved %s inside structural fields", (secret) => {
  const values = sensitiveFieldValues({ runtimeEnvironment: { PASSWORD: secret } });
  const input = { id: `pre${secret}post`, uri: `https://h/${secret}`, paths: [`/${secret}/a`] };
  expect(
    redactDiagnostics(input, (text, structural) => redactText(text, values, structural)),
  ).toEqual({ id: "pre[REDACTED]post", uri: "https://h/[REDACTED]", paths: ["/[REDACTED]/a"] });
  expect(input.uri).toBe(`https://h/${secret}`);
});

it.each(["accesskey", "sshkey", "passphrase", "cookie", "set-cookie", "jwt", "pwd", "signature"])(
  "N4 recognizes the credential name %s in every casing",
  (name) => {
    for (const key of [name, name.toUpperCase(), name[0]?.toUpperCase() + name.slice(1)]) {
      expect(isSensitiveName(key)).toBe(true);
      expect(redactDiagnostics({ [key]: { nested: ["value"] } }, (text) => text)).toEqual({
        [key]: "[REDACTED]",
      });
    }
  },
);

it("N5 retains routing identities while protecting same-named diagnostic content", () => {
  const event = {
    type: "execution.started" as const,
    taskId: "task",
    attemptId: "attempt",
    workerId: "worker",
    at: "now",
  };
  expect(redactEventDiagnostics(event, () => "[REDACTED]")).toEqual(event);
  const withdrawn = { type: "input.withdrawn" as const, commandId: "command" };
  expect(redactEventDiagnostics(withdrawn, () => "[REDACTED]")).toEqual(withdrawn);
  expect(
    redactDiagnostics(
      { taskId: "secret", attemptId: "secret", workerId: "secret", commandId: "secret" },
      () => "[REDACTED]",
    ),
  ).toEqual({
    taskId: "[REDACTED]",
    attemptId: "[REDACTED]",
    workerId: "[REDACTED]",
    commandId: "[REDACTED]",
  });
});

it.each(["postgres", "POSTGRES", "Postgres"])(
  "N6 treats the alphabetic host value %s as low confidence",
  (word) => {
    const values = sensitiveEnvironmentValues({ PASSWORD: word });
    expect(values).toEqual([{ lowConfidence: word }]);
    expect(redactText(`failed ${word} https://h/${word}`, values)).toBe(
      `failed [REDACTED] https://h/${word}`,
    );
    expect(redactText(`/repo/${word}`, values, true)).toBe(`/repo/${word}`);
  },
);

it.each(["sessionKey", "itemKey", "sourceItemKey", "sort_key"])(
  "preserves structural identifier %s",
  (key) => {
    expect(
      redactDiagnostics({ [key]: "Postgres" }, (text, structural) =>
        redactText(text, [{ lowConfidence: "Postgres" }], structural),
      ),
    ).toEqual({ [key]: "Postgres" });
    expect(sensitiveEnvironmentValues({ [key]: "ordinary-value" })).toEqual([]);
  },
);

it.each([String.raw`\\server@host\share`, String.raw`\\server\share`])(
  "preserves a UNC path without an explicit URL scheme: %s",
  (path) => {
    expect(redactText(path, [])).toBe(path);
  },
);

it.each(["//u:password@h/a", "https://h/a;//u:password@h/a"])(
  "masks scheme-relative userinfo: %s",
  (url) => {
    expect(redactText(url, [])).not.toContain("password");
    expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toContain("password");
  },
);

it.each(["token:name", "token+name", "user/password", "token(1)", "令牌[token]"])(
  "masks query credentials with name characters in %s",
  (name) => {
    const url = `https://h/?${name}=query-secret&safe=yes`;
    expect(redactText(url, [])).toBe(`https://h/?${name}=[REDACTED]&safe=yes`);
    expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toContain("query-secret");
  },
);

it.each(["glpat-Ab123456789", "npm_Ab123456789", "xoxb-Ab123456789", "sk-Ab123456789"])(
  "collects recognizable non-GitHub username token %s",
  (token) => {
    const values = sensitiveEnvironmentValues({ SERVICE_URL: `https://${token}@h/a` });
    expect(values).toContain(token);
    expect(redactText(`failed ${token}`, values)).toBe("failed [REDACTED]");
  },
);

it.each([",", ";", "|"])(
  "stops username-only userinfo before a following email separated by %s",
  (separator) => {
    const url = `https://glpat-Ab123456789@host${separator}email@example.test`;
    expect(redactText(url, [])).toBe(`https://[REDACTED]@host${separator}email@example.test`);
    expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toEqual(["glpat-Ab123456789"]);
  },
);

it.each([",", ";", "|"])(
  "favors hiding the complete ambiguous raw password containing %s",
  (separator) => {
    const password = `pa@ss${separator}word`;
    const url = `https://u:${password}@host`;
    expect(redactText(url, [])).toBe("https://[REDACTED]@host");
    expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toContain(password);
  },
);

it("continues scanning explicit URLs after a UNC path", () => {
  const prefix = String.raw`\\server@host\share;`;
  expect(redactText(`${prefix}https://u:password@h`, [])).toBe(`${prefix}https://[REDACTED]@h`);
});

it("masks unknown selected artifact paths without requiring catalog entries", () => {
  const value = { artifacts: [{ artifactId: "unknown", paths: ["long-secret/report.txt"] }] };
  expect(
    redactDiagnostics(value, (text, structural) => redactText(text, ["long-secret"], structural)),
  ).toEqual({ artifacts: [{ artifactId: "unknown", paths: ["[REDACTED]/report.txt"] }] });
});
