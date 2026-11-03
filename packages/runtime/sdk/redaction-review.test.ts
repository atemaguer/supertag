import { expect, it } from "vitest";
import { redactDiagnostics, redactEventDiagnostics } from "./src/event-redaction.js";
import { redactText, sensitiveEnvironmentValues, sensitiveFieldValues } from "./src/redaction.js";

it.each([
  "MixedCase",
  "SuperTag",
  "ZqxKmVwLpRtYbNcD",
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
])("F1 keeps alphabetic token %s high-confidence", (secret) => {
  const values = sensitiveEnvironmentValues({ PASSWORD: secret });
  expect(values).toEqual([secret]);
  expect(sensitiveFieldValues({ password: secret })).toEqual([secret]);
  expect(redactText(`https://h/${secret}`, values, true)).toBe("https://h/[REDACTED]");
});

it.each(["", "=secret-value"])("F2 scans 40,000 question marks with suffix %s once", (suffix) => {
  const prefix = "?".repeat(40_000);
  const input = `${prefix}token${suffix}`;
  const started = performance.now();
  const result = redactText(input, []);
  const elapsed = performance.now() - started;
  expect(result).toBe(suffix ? `${prefix}token=[REDACTED]` : input);
  expect(elapsed).toBeLessThan(50);
  expect(sensitiveEnvironmentValues({ SERVICE_URL: input })).toEqual(
    suffix ? ["secret-value"] : [],
  );
});

it.each([
  "signingKey",
  "encryptionKey",
  "hmacKey",
  "masterKey",
  "authKey",
  "unknownKey",
  "signing_key",
])("F3 applies low-confidence redaction to diagnostic %s", (key) => {
  const values = sensitiveEnvironmentValues({ PASSWORD: "Postgres" });
  expect(
    redactDiagnostics({ [key]: "Postgres" }, (text, structural) =>
      redactText(text, values, structural),
    ),
  ).toEqual({ [key]: "[REDACTED]" });
});

it.each([String.raw`\\user:password@server\share`, "%5C%5Cuser:password@server%5Cshare"])(
  "F4 masks and collects a password in backslash authority %s",
  (url) => {
    expect(redactText(url, [])).not.toContain("password");
    const values = sensitiveEnvironmentValues({ SERVICE_URL: url });
    expect(values).toContain("password");
    expect(redactText("failed password", values)).toBe("failed [REDACTED]");
  },
);

it("F5 preserves mount-manifest and spec keys without collecting them as secrets", () => {
  const event = {
    type: "workspace.mounts.copied" as const,
    objects: [{ key: "source/object.txt" }],
  };
  const spec = { mounts: [{ objects: [{ key: "source/object.txt" }] }] };
  const values = sensitiveFieldValues(spec);
  expect(values).toEqual([]);
  expect(
    redactEventDiagnostics(event, (text, structural) => redactText(text, values, structural)),
  ).toEqual(event);
  expect(
    redactDiagnostics(event, (text, structural) => redactText(text, ["object"], structural)),
  ).toEqual({ ...event, objects: [{ key: "source/[REDACTED].txt" }] });
});

it.each([",", ";", "|"])(
  "masks username token punctuation %s before the userinfo boundary",
  (separator) => {
    const token = `ghp_abc${separator}def`;
    const url = `https://${token}@host${separator}email@example.test`;
    expect(redactText(url, [])).toBe(`https://[REDACTED]@host${separator}email@example.test`);
    const values = sensitiveEnvironmentValues({ SERVICE_URL: url });
    expect(values).toEqual([token]);
    expect(redactText(`failed ${token}`, values)).toBe("failed [REDACTED]");
  },
);

it.each([
  "key",
  "sourceItemKey",
  "sessionKey",
  "itemKeys",
  "sortKey",
  "idempotencyKey",
  "cursorKey",
  "resource_key",
])("F3 preserves only identifier key %s against low-confidence hints", (key) => {
  expect(
    redactDiagnostics({ [key]: "Postgres" }, (text, structural) =>
      redactText(text, [{ lowConfidence: "Postgres" }], structural),
    ),
  ).toEqual({ [key]: "Postgres" });
  expect(
    redactDiagnostics({ [key]: "preSecretpost" }, (text, structural) =>
      redactText(text, ["Secret"], structural),
    ),
  ).toEqual({ [key]: "pre[REDACTED]post" });
});
