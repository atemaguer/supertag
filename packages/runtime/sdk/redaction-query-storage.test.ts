// Cases from the fu4-redaction-fixes security review (findings F2 and F6), kept on the
// integrated redaction policy.
import { expect, it } from "vitest";
import { redactText, sensitiveEnvironmentValues, sensitiveFieldValues } from "./src/redaction.js";

it("does not let credential storage names exempt resolved or token-shaped values", () => {
  expect(
    sensitiveFieldValues({ runtimeEnvironment: { GH_TOKEN_PATH: "ghp_0123456789abcdefghij" } }),
  ).not.toEqual([]);
  expect(sensitiveEnvironmentValues({ VAULT_SECRET_STORE: "s.AbCdEf1234567890xyz" })).not.toEqual(
    [],
  );
});

it.each(["_STORE", "_DIR", "_PATH", "_FILE"])(
  "exempts only location and word values of credential storage names ending in %s",
  (suffix) => {
    const name = `VAULT_SECRET${suffix}`;
    expect(sensitiveEnvironmentValues({ [name]: "token-shaped-secret" })).toEqual([
      "token-shaped-secret",
    ]);
    expect(sensitiveEnvironmentValues({ [name]: "/home/user/secrets" })).toEqual([]);
    expect(sensitiveEnvironmentValues({ [name]: "~/.secrets" })).toEqual([]);
    expect(sensitiveEnvironmentValues({ [name]: "filesystem" })).toEqual([]);
    expect(
      sensitiveFieldValues({ runtimeEnvironment: { [name]: "s.AbCdEf1234567890xyz" } }),
    ).toEqual(["s.AbCdEf1234567890xyz"]);
  },
);

it("keeps a password store directory readable", () => {
  expect(sensitiveEnvironmentValues({ PASSWORD_STORE_DIR: "/Users/me/.password-store" })).toEqual(
    [],
  );
});

it.each(["accessKey", "apiKey", "pwd", "jwt", "user[password]", "user[apiKey]"])(
  "redacts and collects the %s query credential, also when encoded",
  (name) => {
    const url = `https://h/?${name}=long-query-secret&safe=yes`;
    for (const text of [url, encodeURIComponent(url)]) {
      expect(redactText(text, [])).not.toContain("long-query-secret");
      expect(sensitiveEnvironmentValues({ SERVICE_URL: text })).toContain("long-query-secret");
    }
    expect(redactText(url, [])).toContain("safe=yes");
  },
);

it("keeps ordinary camelCase and bracketed query names readable", () => {
  for (const name of ["monkey", "sortKey2", "filter[name]", "page"]) {
    const url = `https://h/?${name}=visible-value`;
    expect(redactText(url, [])).toBe(url);
  }
});

it.each(["?", "=", "%3A", "(", "'", '"', ";", ",", "|", "!", "☃"])(
  "redacts nested userinfo after arbitrary separator %s",
  (separator) => {
    for (const userinfo of ["ghp_nestedcredential", "user:nestedpassword"]) {
      const url = `http://proxy/redirect${separator}https://${userinfo}@github.com/x`;
      for (const text of [url, encodeURIComponent(url)]) {
        expect(redactText(text, [])).not.toContain(userinfo);
        if (userinfo.includes(":")) {
          expect(sensitiveEnvironmentValues({ SERVICE_URL: text })).toContain("nestedpassword");
        }
      }
    }
  },
);

it.each(["password[]", "token[]", "api_key[0]", "user[password][]", "user[token][0][]"])(
  "redacts and collects array query credential %s",
  (name) => {
    const url = `https://h/?${name}=array-secret-value`;
    for (const text of [url, encodeURIComponent(url)]) {
      expect(redactText(text, [])).not.toContain("array-secret-value");
      expect(sensitiveEnvironmentValues({ SERVICE_URL: text })).toContain("array-secret-value");
    }
  },
);

it.each([
  "sortKey",
  "cacheKey",
  "objectKey",
  "primaryKey",
  "partitionKey",
  "idempotencyKey",
  "publicKey",
  "filter[name][]",
])("preserves ordinary query values under %s", (name) => {
  const url = `https://h/?${name}=ordinary-value`;
  expect(redactText(url, [])).toBe(url);
  expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toEqual([]);
});

it.each(["apiKey", "accessKey", "secretKey", "privateKey", "signature", "requestSignature"])(
  "keeps credential query name %s sensitive",
  (name) => {
    expect(redactText(`https://h/?${name}=credential-value`, [])).not.toContain("credential-value");
  },
);

it.each(["FILE", "STORE", "DIR", "PATH"])(
  "collects long alphabetic tokens in TOKEN_%s",
  (suffix) => {
    const name = `SERVICE_TOKEN_${suffix}`;
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    expect(sensitiveEnvironmentValues({ [name]: secret })).toContain(secret);
    expect(sensitiveFieldValues({ runtimeEnvironment: { [name]: secret } })).toContain(secret);
    for (const value of ["filesystem", "keychain", "/home/user/token", "./token", "~/.token"]) {
      expect(sensitiveEnvironmentValues({ [name]: value })).toEqual([]);
    }
  },
);

it("scans long scheme-like values without retrying every character", () => {
  const url = `https://host/${"a1".repeat(128 * 1024)}`;
  const started = performance.now();
  expect(redactText(url, [])).toBe(url);
  expect(performance.now() - started).toBeLessThan(1000);
});

it.each([
  "clientKey",
  "masterKey",
  "encryptionKey",
  "accountKey",
  "storageKey",
  "hmacKey",
  "consumerKey",
  "writeKey",
  "serverKey",
  "adminKey",
  "serviceKey",
  "sharedKey",
  "sasKey",
  "subscriptionKey",
  "licenseKey",
  "encKey",
  "cryptoKey",
  "AppKey",
  "SessionKey",
  "SigningKey",
])("preserves non-credential Key suffix %s in query and environment values", (name) => {
  const secret = "credential-value";
  expect(redactText(`https://h/?${name}=${secret}`, [])).toContain(secret);
  expect(sensitiveEnvironmentValues({ [name]: secret })).toEqual([]);
});

it.each([
  "sortKey",
  "CacheKey",
  "objectKey",
  "primaryKey",
  "partitionKey",
  "idempotencyKey",
  "publicKey",
  "foreignKey",
  "rowKey",
  "mapKey",
])("preserves ordinary Key suffix %s in query and environment values", (name) => {
  const url = `https://h/?${name}=ordinary-value`;
  expect(redactText(url, [])).toBe(url);
  expect(sensitiveEnvironmentValues({ [name]: "ordinary-value" })).toEqual([]);
});

it.each(["?", "&", "#"])("redacts bare nested userinfo after %s", (separator) => {
  for (const userinfo of ["user:nestedpassword", "ghp_nestedcredential"]) {
    const url = `http://proxy/r${separator}//${userinfo}@github.com`;
    expect(redactText(url, [])).not.toContain(userinfo);
    expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toContain(
      userinfo.includes(":") ? "nestedpassword" : userinfo,
    );
  }
});

it.each([
  String.raw`https:\\u:backslashpassword@host`,
  String.raw`https:/\u:backslashpassword@host`,
])("redacts and collects backslash authority %s", (url) => {
  expect(redactText(url, [])).not.toContain("backslashpassword");
  expect(sensitiveEnvironmentValues({ SERVICE_URL: url })).toContain("backslashpassword");
});

it.each([
  "user[password]x",
  "password[new]",
  "secret[value]",
  "api_key[primary]",
  "token[value]",
  "password[ 0 ]",
])("redacts any credential segment in %s", (name) => {
  const url = `https://h/?${name}=segment-secret`;
  for (const text of [url, encodeURIComponent(url)]) {
    expect(redactText(text, [])).not.toContain("segment-secret");
    expect(sensitiveEnvironmentValues({ SERVICE_URL: text })).toContain("segment-secret");
  }
});

it.each(["TOKEN_FILE", "TOKEN_STORE", "TOKEN_DIR", "TOKEN_PATH"])(
  "collects short mixed-case alphabetic secrets in %s",
  (name) => {
    const secret = "ZqxKmVwLpRtYbNcD";
    expect(sensitiveEnvironmentValues({ [name]: secret })).toContain(secret);
    expect(sensitiveFieldValues({ [name]: secret })).toContain(secret);
    expect(sensitiveEnvironmentValues({ [name]: "filesystem" })).toEqual([]);
  },
);
