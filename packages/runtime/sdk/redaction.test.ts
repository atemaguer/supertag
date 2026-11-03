import { expect, it } from "vitest";
import {
  isSensitiveName,
  redactText,
  sensitiveEnvironmentValues,
  sensitiveFieldValues,
} from "./src/redaction.js";

it("tolerates cyclic invalid specs", () => {
  const spec: Record<string, unknown> = {
    nested: { PROVIDER_API_KEY: "private-value" },
  };
  spec["cycle"] = spec;
  expect(sensitiveFieldValues(spec)).toEqual(["private-value"]);
});

it("ignores tiny, boolean and short numeric host hints", () => {
  expect(
    sensitiveEnvironmentValues({
      TOKEN_ENABLED: "false",
      TOKEN_DEBUG: "true",
      TOKEN_COUNT: "123456",
      TOKEN_RATIO: "1.234",
      TOKEN_FLAG: "1",
      BRANCH_KEY: "abc",
      REAL_TOKEN: "long-secret",
    }),
  ).toEqual(["long-secret", { lowConfidence: "1.234" }]);
});

it.each(["/", "//", "?", "#", ","])("F2 redacts unescaped %s in URL passwords", (separator) => {
  expect(redactText(`https://user:pa${separator}ss@example.test/path`, [])).toBe(
    "https://[REDACTED]@example.test/path",
  );
});

it("keeps ordinary escaped text unchanged and handles malformed encoding without throwing", () => {
  for (const text of [
    String.raw`C:\Temp\Users\File`,
    String.raw`literal \u0041`,
    "https://example.test/%ff",
  ]) {
    expect(redactText(text, [])).toBe(text);
  }
  expect(redactText("bad \ud800 secret", ["\ud800 secret"])).toBe("bad [REDACTED]");
  expect(redactText("https%3A%2F%2F%ffuser:password%40example.test", [])).not.toContain("password");
});

it.each([
  String.raw`https:\/\/user:password@example.test/path`,
  String.raw`https:\u002f\u002fuser:password\u0040example.test/path`,
  encodeURIComponent("https://user:password@example.test/path"),
  "https://user:password%40example.test/path",
])("F2 redacts encoded URL credentials: %s", (url) => {
  const safe = redactText(url, []);
  expect(safe).not.toContain("user");
  expect(safe).not.toContain("password");
  expect(safe).toContain("[REDACTED]");
});

it.each([
  "access_token",
  "X-Amz-Signature",
  "secretAccessKey",
  "provider_token",
  "provider_secret",
])("F2 redacts %s query credentials", (key) => {
  for (const url of [
    `https://example.test/path?${key}=query-secret&safe=yes`,
    encodeURIComponent(`https://example.test/path?${key}=query-secret&safe=yes`),
  ]) {
    expect(redactText(url, [])).not.toContain("query-secret");
    expect(redactText(url, [])).toContain("[REDACTED]");
  }
});

it.each(["percent", "json", "base64", "basic"])(
  "F3 redacts %s copies of host secrets",
  (encoding) => {
    const secret = 'host/pass?word#"value\\end';
    const encoded =
      encoding === "percent"
        ? encodeURIComponent(secret)
        : encoding === "json"
          ? JSON.stringify(secret).slice(1, -1)
          : encoding === "base64"
            ? Buffer.from(secret).toString("base64")
            : `Basic ${Buffer.from(`username:${secret}`).toString("base64")}`;
    const safe = redactText(
      `failed: ${encoded}`,
      sensitiveEnvironmentValues({ HOST_PASSWORD: secret }),
    );
    expect(safe).not.toContain(encoded);
    expect(safe).not.toContain(secret);
    expect(safe).toContain("[REDACTED]");
  },
);

it.each([
  "PROVIDER_API_KEY",
  "SERVICE_AUTHORIZATION",
  "DB_PASSWORD",
  "PASSPHRASE",
  "GITHUB_TOKEN",
  "PROVIDER_SECRET",
])("F4 recognizes %s", (name) => {
  expect(sensitiveEnvironmentValues({ [name]: "private-value" })).toEqual(["private-value"]);
});

it("F4 collects credentials from URL environment values without hiding ordinary endpoints", () => {
  const secrets = sensitiveEnvironmentValues({
    DATABASE_URL: "postgresql://db-user:db-password@example.test/db",
    SERVICE_URL: "https://example.test/?access_token=url-token-value",
    PUBLIC_URL: "https://example.test/public",
  });
  expect(redactText("db-password url-token-value https://example.test/public", secrets)).toBe(
    "[REDACTED] [REDACTED] https://example.test/public",
  );
});

it.each([
  ["//user:pass@example.test/a", "//[REDACTED]@example.test/a"],
  ["https://user:pass@example.test/a", "https://[REDACTED]@example.test/a"],
  ["postgresql://user:p%40ss@[::1]:5432/db", "postgresql://[REDACTED]@[::1]:5432/db"],
  ["HTTPS://token@example.test", "HTTPS://[REDACTED]@example.test"],
  ["ssh://user:p@ss@example.test/repo", "ssh://[REDACTED]@example.test/repo"],
  [
    "https://example.test/path?email=user@example.test",
    "https://example.test/path?email=user@example.test",
  ],
  ["user@example.test and /local/path", "user@example.test and /local/path"],
])("redacts URL userinfo in %s", (input, expected) => {
  expect(redactText(`Failed: ${input}`, [])).toBe(`Failed: ${expected}`);
});

it("redacts overlapping host secrets longest first without treating ordinary environment values as secrets", () => {
  const secrets = sensitiveEnvironmentValues({
    PROVIDER_API_KEY: "shared-prefix",
    HOST_CREDENTIAL: "shared-prefix-private-suffix",
    EMPTY_TOKEN: "",
    PATH: "/usr/bin",
    HOME: "/home/user",
  });
  expect(
    redactText("shared-prefix-private-suffix shared-prefix /usr/bin /home/user", secrets),
  ).toBe("[REDACTED] [REDACTED] /usr/bin /home/user");
});

it("precision F1 scans 256 KiB of repeated URL starts within a bounded time", () => {
  const input = "//a:b".repeat(Math.ceil((256 * 1024) / 5));
  const started = performance.now();
  expect(redactText(input, [])).toBe(input);
  expect(performance.now() - started).toBeLessThan(1000);
});

it("checks a long uppercase name that is not an environment name within a bounded time", () => {
  const name = `${"A".repeat(100_000)}a`;
  const started = performance.now();
  expect(isSensitiveName(name)).toBe(false);
  expect(performance.now() - started).toBeLessThan(100);
});

it("precision F2 distinguishes URL passwords from ordinary host words", () => {
  const secrets = sensitiveEnvironmentValues({
    DATABASE_URL: "postgres://admin:long-password@example.test/db",
    SERVICE_URL: "https://operator@example.test",
    BRANCH_KEY: "main",
  });
  expect(secrets).toEqual(["long-password", { lowConfidence: "main" }]);
  expect(redactText("admin operator main long-password", secrets)).toBe(
    "admin operator [REDACTED] [REDACTED]",
  );
});

it("precision F3 preserves manifest keys in events", () => {
  const event = {
    type: "workspace.mounts.copied",
    objects: [{ key: "source/object.txt" }],
    pat: "pattern-name",
    sk: "sort-key-value",
  };
  const secrets = sensitiveFieldValues({ ...event, API_KEY: "long-secret", BRANCH_KEY: "main" });
  expect(secrets).toEqual(["long-secret"]);
  expect(redactText(JSON.stringify(event), secrets)).toBe(JSON.stringify(event));
});

it("precision F4 keeps endpoint paths and stops userinfo at whitespace", () => {
  const diagnostic = "http://localhost:8080/api failed for admin@example.com";
  expect(redactText(diagnostic, [])).toBe(diagnostic);
  expect(redactText("https://user:password@host/path admin@example.com", [])).toBe(
    "https://[REDACTED]@host/path admin@example.com",
  );
});

it("redacts short, numeric, and boolean credentials the host resolved for a server", () => {
  const secrets = sensitiveFieldValues({
    runtimeEnvironment: {
      DB_PASSWORD: "hunter2",
      PIN_TOKEN: "12345678",
      GITHUB_APP_ID: "4242",
      FLAG_SECRET: "true",
    },
  });
  expect([...secrets].sort()).toEqual(["12345678", "hunter2", "true"]);
  expect(redactText("login hunter2 pin 12345678 app 4242", secrets)).toBe(
    "login [REDACTED] pin [REDACTED] app 4242",
  );
  // Explicit password and token names also identify short host credentials.
  expect(
    sensitiveEnvironmentValues({
      DB_PASSWORD: "hunter2",
      PIN_TOKEN: "12345678",
    }),
  ).toEqual(["12345678", { lowConfidence: "hunter2" }]);
});

it("redacts tiny, numeric, and boolean resolved secrets and encoded copies everywhere", () => {
  const secrets = sensitiveFieldValues({
    GITHUB_APP_ID: "1",
    BRANCH_KEY: "main",
    runtimeEnvironment: { DB_PASSWORD: "hunter2", PIN_TOKEN: "12345678", FLAG_SECRET: "true" },
    runtimeHeaders: { authorization: "abc" },
  });
  expect(
    redactText(
      "exit code 1 main hunter2 hunter2x xhunter2 true untrue 123456789 abc abcd",
      secrets,
    ),
  ).toBe(
    "exit code 1 main [REDACTED] [REDACTED]x x[REDACTED] [REDACTED] un[REDACTED] [REDACTED]9 [REDACTED] [REDACTED]d",
  );
  expect(redactText("aHVudGVyMg== YWJj MTIzNDU2Nzg=", secrets)).toBe(
    "[REDACTED] [REDACTED] [REDACTED]",
  );
});

it("redacts diagnostic encodings of short resolved passwords", () => {
  const secrets = sensitiveFieldValues({ runtimeEnvironment: { DB_PASSWORD: "hunter2" } });
  const diagnostic = String.raw`h\u0075nter2 h%75nter2`;
  expect(redactText(diagnostic, secrets)).toBe("[REDACTED] [REDACTED]");
});

it.each([
  ['"http://a/x","https://u:pw@h/"', '"http://a/x","https://[REDACTED]@h/"'],
  ["http://m/x,https://u:pw@h", "http://m/x,https://[REDACTED]@h"],
])("redacts adjacent diagnostic URLs: %s", (input, expected) => {
  expect(redactText(input, [])).toBe(expected);
});

it.each(["key", "signature", "KEY", "SIGNATURE"])("redacts the %s query parameter", (name) => {
  expect(redactText(`https://host/?${name}=private-value&safe=yes`, [])).toBe(
    `https://host/?${name}=[REDACTED]&safe=yes`,
  );
  expect(
    sensitiveEnvironmentValues({ SERVICE_URL: `https://host/?${name}=private-value` }),
  ).toContain("private-value");
});

it.each(["DB_PASSWORD", "ACCESS_TOKEN", "CLIENT_SECRET", "API_KEY"])(
  "collects short host credentials named %s",
  (name) => {
    const secrets = sensitiveEnvironmentValues({ [name]: "hunter2" });
    expect(secrets).toEqual([{ lowConfidence: "hunter2" }]);
    expect(redactText("failed hunter2 xhunter2x", secrets)).toBe("failed [REDACTED] xhunter2x");
  },
);

it.each([
  ["https://registry.npmjs.org:443/@scope/pkg", "https://[REDACTED]@scope/pkg"],
  ["http://localhost:8080/path/@user", "http://[REDACTED]@user"],
  ["https://host:443/?email=user@example.test", "https://[REDACTED]@example.test"],
  ["https://host:443/#@name", "https://[REDACTED]@name"],
])("redacts ambiguous port paths containing an at sign: %s", (url, expected) => {
  expect(redactText(url, [])).toBe(expected);
});

it.each(["p%40ssword", "pa%2Fssword", "p%2540ssword"])(
  "collects decoded URL passwords: %s",
  (password) => {
    const secrets = sensitiveEnvironmentValues({
      DATABASE_URL: `postgres://user:${password}@host/db`,
    });
    const decoded = decodeURIComponent(decodeURIComponent(password));
    expect(secrets).toContain(decoded);
    expect(secrets).not.toContain("p");
    expect(secrets).not.toContain("[REDACTED]");
    expect(redactText(`login ${decoded}`, secrets)).toBe("login [REDACTED]");
  },
);

it.each(["PASSWORD_STORE_DIR", "SECRET_STORE", "TOKEN_FILE", "PASSWORD_PATH"])(
  "preserves credential storage settings named %s",
  (name) => {
    for (const value of ["/home/user/.password-store", "local", "development"]) {
      expect(sensitiveEnvironmentValues({ [name]: value })).toEqual([]);
      expect(sensitiveFieldValues({ runtimeEnvironment: { [name]: value } })).toEqual([]);
    }
  },
);

it("preserves resolved application IDs and ordinary standalone numbers", () => {
  const secrets = sensitiveFieldValues({
    runtimeEnvironment: { APP_ID: "1", GITHUB_APP_ID: "4242" },
  });
  expect(secrets).toEqual([]);
  expect(redactText("exit code 1 app 4242", secrets)).toBe("exit code 1 app 4242");
});

it.each([
  "pa'ssw0rd",
  'pa"ssw0rd',
  "pa<ssw0rd",
  "pa>ssw0rd",
  "pa@ssw0rd",
  "prefix,//suffix",
  "pa@ss,//suffix",
  "prefix,https://suffix",
])("regression collects and redacts the complete URL password %s", (password) => {
  const url = `postgres://u:${password}@h/db`;
  const secrets = sensitiveEnvironmentValues({ DATABASE_URL: url });
  expect(secrets).toContain(password);
  expect(redactText(url, [])).toBe("postgres://[REDACTED]@h/db");
  expect(redactText(`failed ${password}`, secrets)).toBe("failed [REDACTED]");
  expect(redactText(JSON.stringify(url), [])).toBe('"postgres://[REDACTED]@h/db"');
});

it("redacts separate credentials in adjacent absolute URLs", () => {
  const input = "https://u:first-password@h;https://u:second-password@h";
  expect(redactText(input, [])).toBe("https://[REDACTED]@h;https://[REDACTED]@h");
  expect(sensitiveEnvironmentValues({ SERVICE_URL: input })).toEqual([
    "second-password",
    "first-password",
  ]);
});

it.each([
  "registry.npmjs.org/@scope%2fpkg",
  "github.com/o/r.git?ref=a@b",
  "host?email=a@b",
  "host#user@host",
  'host/x","email":"a@b.c"}',
  "host:443/path@name",
])("redacts username tokens before later at signs: %s", (suffix) => {
  expect(redactText(`https://TOKEN@${suffix}`, [])).toBe(`https://[REDACTED]@${suffix}`);
});

it("keeps the last username at sign inside the authority", () => {
  expect(redactText("https://TOKEN@part@host/path@name", [])).toBe(
    "https://[REDACTED]@host/path@name",
  );
});

it.each([";", ",", "|"])(
  "collects each password in adjacent scheme-relative URLs joined by %s",
  (separator) => {
    const input = `https://u:pw1abcd@a/x${separator}//u:pw2abcd@h`;
    const secrets = sensitiveEnvironmentValues({ MIRRORS_URL: input });
    expect(secrets).toContain("pw1abcd");
    expect(secrets).toContain("pw2abcd");
    expect(redactText("pw1abcd pw2abcd", secrets)).toBe("[REDACTED] [REDACTED]");
    expect(redactText(input, [])).not.toContain("pw2abcd");
  },
);

it("redacts a scheme-relative URL following an ordinary endpoint", () => {
  expect(redactText("https://h/path,//u:password@h", [])).toBe("https://h/path,//[REDACTED]@h");
});

it.each(["PAT", "hunter22", "p%40ssword", "123/abc", "prefix,https://suffix"])(
  "redacts URL passwords after an empty username: %s",
  (password) => {
    const url = `https://:${password}@dev.azure.com/o/r`;
    expect(redactText(url, [])).toBe("https://[REDACTED]@dev.azure.com/o/r");
    if (password.length >= 4) {
      const secrets = sensitiveEnvironmentValues({ REPOSITORY_URL: url });
      expect(secrets).toContain(decodeURIComponent(password));
      expect(redactText(`failed ${decodeURIComponent(password)}`, secrets)).toBe(
        "failed [REDACTED]",
      );
    }
  },
);

it.each(["http://proxy/", "http://proxy/?u=", "{http://a/}{", "http://a/}"])(
  "redacts nested credential URLs after %s",
  (prefix) => {
    for (const userinfo of ["u:hunter22", ":hunter22", "ghp_x"]) {
      const input = `${prefix}https://${userinfo}@h/r`;
      expect(redactText(input, [])).toBe(`${prefix}https://[REDACTED]@h/r`);
      if (userinfo.includes(":")) {
        const secrets = sensitiveEnvironmentValues({ PROXY_URL: input });
        expect(secrets).toContain("hunter22");
        expect(redactText("failed hunter22", secrets)).toBe("failed [REDACTED]");
      }
    }
  },
);

it.each(["/", "=", "{", "}"])(
  "preserves and collects a diagnostic password containing a nested URL after %s",
  (separator) => {
    const password = `prefix${separator}https://u:hunter22`;
    const input = `https://:${password}@h/r`;
    expect(redactText(input, [])).toBe("https://[REDACTED]@h/r");
    const secrets = sensitiveEnvironmentValues({ PROXY_URL: input });
    expect(secrets).toContain(password);
    expect(secrets).toContain("hunter22");
  },
);

it("collects credentials from a URL adjacent to an ambiguous endpoint port", () => {
  const input = "https://host:443/path;https://u:private-value@h";
  const secrets = sensitiveEnvironmentValues({ SERVICE_URL: input });
  expect(redactText(input, [])).not.toContain("private-value");
  expect(secrets).toContain("private-value");
  expect(redactText("failed private-value", secrets)).toBe("failed [REDACTED]");
});

it.each(["password", "pa@ssword"])(
  "collects the password separately when a URL path also contains @: %s",
  (password) => {
    const secrets = sensitiveEnvironmentValues({
      DATABASE_URL: `postgres://u:${password}@host/path@name`,
    });
    expect(secrets).toContain(password);
    expect(redactText(`failed ${password}`, secrets)).toBe("failed [REDACTED]");
  },
);

it.each(["https://host/path;", "https://host:443/path;"])(
  "scans large adjacent URL lists in bounded time: %s",
  (endpoint) => {
    const input = endpoint.repeat(Math.ceil((256 * 1024) / endpoint.length));
    const started = performance.now();
    expect(redactText(input, [])).toBe(input);
    expect(performance.now() - started).toBeLessThan(1000);
  },
);

it.each(["/", "?", "#", "\\"])(
  "regression redacts digit-prefixed passwords containing %s",
  (separator) => {
    const password = `123${separator}abc`;
    const url = `https://user:${password}@host/path`;
    expect(sensitiveEnvironmentValues({ DATABASE_URL: url })).toContain(password);
    expect(redactText(url, [])).toBe("https://[REDACTED]@host/path");
  },
);

it.each([",", ";", "|", ")(", "`,`", '","', "','", "><"])(
  "regression redacts adjacent URLs joined by %s",
  (separator) => {
    const input = `http://a/x${separator}https://u:password@h/db`;
    expect(redactText(input, [])).toBe(`http://a/x${separator}https://[REDACTED]@h/db`);
    expect(sensitiveEnvironmentValues({ SERVICE_URL: input })).toContain("password");
  },
);

it.each(["PROVIDER_API_KEY", "PRIVATE_KEY"])(
  "regression redacts hexadecimal secrets named %s and their encoded copies",
  (name) => {
    const secret = `0x${"abcdef01".repeat(8)}`;
    const secrets = sensitiveEnvironmentValues({ [name]: secret });
    expect(secrets).toContain(secret);
    expect(
      redactText(`prefix${secret}suffix ${Buffer.from(secret).toString("base64")}`, secrets),
    ).toBe("prefix[REDACTED]suffix [REDACTED]");
  },
);

it("regression treats long decimal credentials as secrets", () => {
  const secret = "12345678901234567890123456789012";
  const secrets = sensitiveEnvironmentValues({ PROVIDER_API_KEY: secret });
  expect(secrets).toContain(secret);
  expect(redactText(`x${secret}x ${Buffer.from(secret).toString("base64")}`, secrets)).toBe(
    "x[REDACTED]x [REDACTED]",
  );
});

it.each(["NPM_AUTH_TOKENFILE", "CLIENT_SECRET_PROFILE", "secretStore", "authTokenPath"])(
  "regression recognizes credential names without a storage separator: %s",
  (name) => {
    expect(isSensitiveName(name)).toBe(true);
    expect(sensitiveEnvironmentValues({ [name]: "private-value" })).toEqual(["private-value"]);
    expect(sensitiveFieldValues({ runtimeEnvironment: { [name]: "private-value" } })).toEqual([
      "private-value",
    ]);
  },
);

it.each(["true", "false", "1", "x", "ab", "abc"])(
  "ignores flag or tiny host credentials: %s",
  (value) => {
    const secrets = sensitiveEnvironmentValues({
      USE_AUTH: value,
      NPM_TOKEN: value,
      DB_PASS: value,
    });
    expect(secrets).toEqual([]);
    expect(redactText(`setting ${value} within${value}word`, secrets)).toBe(
      `setting ${value} within${value}word`,
    );
    expect(sensitiveEnvironmentValues({ SERVICE_URL: `https://h/?token=${value}` })).toEqual([
      value,
    ]);
    expect(redactText(`https://h/?token=${value}`, [])).toBe("https://h/?token=[REDACTED]");
  },
);

it.each(["pwd", "jwt", "accessKey", "apiKey"])(
  "regression recognizes query credential %s",
  (name) => {
    const url = `https://host/?${name}=private-value&safe=yes`;
    expect(redactText(url, [])).toBe(`https://host/?${name}=[REDACTED]&safe=yes`);
    expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toContain("private-value");
    expect(redactText(encodeURIComponent(url), [])).not.toContain("private-value");
  },
);

it.each([
  "https://host:443",
  "http://localhost:8080/path",
  "https://host:443/?safe=yes",
  "https://host:443/#name",
])("preserves unambiguous endpoint ports: %s", (url) => {
  expect(redactText(url, [])).toBe(url);
  expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toEqual([]);
});

it("redacts 64 KiB of adversarial short-password labels in under a second", () => {
  const prefix = "pass-".repeat(Math.ceil((64 * 1024) / 5));
  const secrets = sensitiveEnvironmentValues({ MYSQL_ROOT_PASSWORD: "root" });
  const started = performance.now();
  expect(redactText(`${prefix} password=root`, secrets)).toBe(`${prefix} password=[REDACTED]`);
  expect(redactText(`${prefix}=root`, secrets)).toBe(`${prefix}=[REDACTED]`);
  expect(performance.now() - started).toBeLessThan(1000);
});

it("redacts short-password labels even after another assignment", () => {
  const secrets = sensitiveEnvironmentValues({ MYSQL_ROOT_PASSWORD: "root" });
  expect(redactText("message=password=root other=token: ROOT", secrets)).toBe(
    "message=password=[REDACTED] other=token: [REDACTED]",
  );
});
