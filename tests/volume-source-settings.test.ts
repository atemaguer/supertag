import { describe, expect, it } from "vitest";
import { parseVolumeCredentialSecret } from "../apps/cli/src/host-volumes.js";
import { describeVolume } from "../apps/cli/src/resources.js";
import { parseVolumeSource } from "../packages/core/src/index.js";

describe("Volume source connection settings", () => {
  it.each(["s3", "r2"])("parses %s settings independently of the prefix", (scheme) => {
    expect(
      parseVolumeSource(
        `${scheme}://bucket/data/?region=eu-west-2&endpoint=https%3A%2F%2Fstore.example%3A9000%2Fs3&forcePathStyle=true`,
      ),
    ).toEqual({
      scheme,
      bucket: "bucket",
      prefix: "data/",
      region: "eu-west-2",
      endpoint: "https://store.example:9000/s3",
      forcePathStyle: true,
    });
    expect(parseVolumeSource("s3://bucket?forcePathStyle=false")).toEqual({
      scheme: "s3",
      bucket: "bucket",
      prefix: "",
      forcePathStyle: false,
    });
  });

  it.each([
    "region=",
    "region=us east 1",
    "region=us-east-1&region=eu-west-1",
    "forcePathStyle=",
    "forcePathStyle=TRUE",
    "forcePathStyle=1",
    "forcePathStyle=true&forcePathStyle=false",
    "unknown=canary-secret",
    "accessKeyId=canary-secret",
    "endpoint=",
    "endpoint=not-a-url",
    "endpoint=ftp%3A%2F%2Fstore.example",
    "endpoint=https%3A%2F%2Fuser%3Acanary-secret%40store.example",
    "endpoint=https%3A%2F%2Fstore.example%3Ftoken%3Dcanary-secret",
    "endpoint=https%3A%2F%2Fstore.example%23canary-secret",
    "endpoint=https%3A%2F%2Fstore.example%0A",
    "endpoint=https%3A%2F%2Fstore.example&endpoint=https%3A%2F%2Fother.example",
    "endpoint=%ZZ",
    "endpoint=https%3A%2F%2Fstore.example%2F%250A",
    "endpoint=https%3A%2F%2Fstore.example%2F%FF",
    "region=us-east-1%0A",
  ])("refuses invalid settings without echoing values: %s", (query) => {
    expect(() => parseVolumeSource(`s3://bucket/prefix?${query}`)).toThrow();
    try {
      parseVolumeSource(`s3://bucket/prefix?${query}`);
    } catch (error) {
      expect(String(error)).not.toContain("canary-secret");
    }
  });

  it.each([
    "http://store.example",
    "http://127.attacker.example",
    "http://localhost.attacker.example",
    "http://10.0.0.1",
    "https://169.254.169.254",
    "https://0xa9fea9fe",
    "https://2852039166",
    "https://[fe80::1]",
    "https://[febf::1]",
    "https://[::ffff:169.254.169.254]",
    "https://[::ffff:0:169.254.169.254]",
    "https://[::169.254.169.254]",
    "https://[64:ff9b::169.254.169.254]",
    "https://[64:ff9b::a9fe:1]",
    "https://[64:ff9b:1:a9fe:a9:fe00::]",
    "https://[fd00:ec2::254]",
    "https://[fd20:ce::254]",
    "https://[fd00:ec2::23]",
    "https://192.0.0.192",
    "https://168.63.129.16",
    "https://[::ffff:192.0.0.192]",
    "https://[64:ff9b::168.63.129.16]",
    "https://100.100.100.200",
    "https://[::ffff:100.100.100.200]",
    "https://[64:ff9b::100.100.100.200]",
    "http://localhost",
    "http://localhost.:9000",
    "http://127.0.0.1:9000",
    "http://127.1:9000",
    "http://[::1]:9000",
    "http://[::ffff:127.0.0.1]:9000",
  ])("F1 refuses unsafe endpoint %s", (endpoint) => {
    expect(() => parseVolumeSource(`s3://bucket?endpoint=${encodeURIComponent(endpoint)}`)).toThrow(
      /endpoint/u,
    );
  });

  it.each([
    "https://localhost:9000",
    "https://127.0.0.1:9000",
    "https://127.1:9000",
    "https://[::1]:9000",
    "https://[::ffff:192.0.2.1]:9000",
    "https://[64:ff9b::192.0.2.1]:9000",
    "https://store.example",
  ])("allows endpoint %s", (endpoint) => {
    expect(parseVolumeSource(`s3://bucket?endpoint=${encodeURIComponent(endpoint)}`)).toMatchObject(
      { endpoint },
    );
  });

  it.each(["\u0080", "\u009b", "\u202e", "\u200b", "\u2066", "\ufeff"])(
    "F2 refuses invisible character %j",
    (character) => {
      for (const tail of [
        character,
        encodeURIComponent(character),
        encodeURIComponent(encodeURIComponent(character)),
      ]) {
        expect(() =>
          parseVolumeSource(`s3://bucket?endpoint=https://store.example/${tail}`),
        ).toThrow();
      }
    },
  );

  it.each([
    "s3://bucket/AKIAIOSFODNN7EXAMPLE",
    "s3://bucket/%41KIAIOSFODNN7EXAMPLE",
    "s3://bucket?endpoint=https://store.example/ghp_abcdefghijklmnopqrst",
    "file:///srv/abc123def456ghi789jkl012",
    "s3://bucket?endpoint=https%3A%2F%2Fstore.example%2F%2541KIAIOSFODNN7EXAMPLE",
    "s3://bucket/AKIA/IOSFODNN7EXAMPLE",
    "s3://bucket/AKIA//IOSFODNN7EXAMPLE",
    "s3://bucket/AKIA/-/IOSFODNN7EXAMPLE",
    "s3://bucket/AKIAIOSF//ODNN7EXAMPLE",
    "s3://bucket/AKIA%2F%2FIOSFODNN7EXAMPLE",
    "s3://bucket/AKIAIOSF/ODNN7EXAMPLE",
    "s3://bucket/AK/IA/IOSFODNN7EXAMPLE",
    "s3://bucket/AKIA%2FIOSFODNN7EXAMPLE",
    "s3://bucket/abc123def456/ghi789jkl012",
    "file:///srv/wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "s3://bucket?endpoint=https://store.example/ghp_/abcdefghijklmnopqrst",
    "s3://bucket?endpoint=https%3A%2F%2Fstore.example%2F%2541KIA%252FIOSFODNN7EXAMPLE",
  ])("F3 refuses secret look-alikes in source %s", (source) => {
    expect(() => parseVolumeSource(source)).toThrow(/secret value/u);
  });

  it.each(["sk-proj", "sk-proj-", "sk-ant", "sk-ant-", "sk-live", "sk-live-"])(
    "refuses split secrets after the word-like key prefix %s",
    (prefix) => {
      for (const source of [
        `s3://bucket/${prefix}/4eC39HqL/yjWDarjt/`,
        `file:///srv/${prefix}/4eC39HqL/yjWDarjt/`,
        `s3://bucket/${prefix}-4eC39HqL/yjWDarjt/`,
        `s3://bucket?endpoint=https://store.example/${prefix}%2F4eC39HqL%2FyjWDarjt/`,
      ]) {
        expect(() => parseVolumeSource(source)).toThrow(/secret value/u);
      }
    },
  );

  it.each([
    "sk-QwEr12/models/training",
    "sk-proj-A1b2/models/checkpoints",
    "sk-proj/Abcdefgh/yjWDarjt9",
    "sk-proj/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p",
    "sk-ant-api03-/abcdefgh/ijklmnop",
    "sk_live_/abcdefgh/ijklmnop",
    "sk_test_/abcdefgh/ijklmnop",
    "sk-svcacct-/abcdefgh/ijklmnop",
    "sk-or-v1-/abcdefgh/ijklmnop",
    "sk-/ant-/api03-/abcdefgh/ijklmnop",
    "sk_/live_/abcdefgh/ijklmnop",
    "sk-proj/abcdefgh/ijklmnop",
    "sk-proj/ab/ec/id/of/ug/ya/be/ci",
    "sk-proj/abcdef/ghijkl9",
    "AKIA/123456789012aBcd",
    "abc123def456/ghi789jkl012",
    "Abcdefgh1/4eC39HqL/yjWDarjt9",
  ])("refuses split key payload %s across supported separators", (key) => {
    for (const separator of ["/", ".", "~", "+", ","]) {
      const split = key.replaceAll("/", separator);
      for (const source of [
        `s3://bucket/${split}`,
        `file:///srv/${split}`,
        `s3://bucket?endpoint=${encodeURIComponent(`https://store.example/${split}`)}`,
        `s3://bucket/${encodeURIComponent(split)}`,
      ]) {
        expect(() => parseVolumeSource(source), source).toThrow(/secret value/u);
      }
    }
  });

  it.each([
    "s3://bucket/datasets/v3/training/checkpoints",
    "file:///srv/datasets/2026/October",
    "s3://bucket?endpoint=https://store.example/storage/v2/objects",
    "s3://logs/Asia/Singapore/2024/",
    "s3://asia-backups/prod/",
    "s3://bucket/asia/training-data/",
    "s3://bucket/sk-learn/models/training/",
    "s3://bucket/sk-proj/models/checkpoints/",
    "s3://bucket/sk-proj/models/checkpoints/2024",
    "s3://bucket/asia/training/checkpoints/v1",
    "s3://bucket/asia/training/checkpoints/",
    "s3://bucket/sk-learn/datasets/validation/",
    "s3://bucket/sk-proj/experiments/results/",
    "s3://bucket/asia/production/backups/",
    "file:///srv/sk-proj/models/checkpoints/",
    "s3://bucket?endpoint=https://store.example/asia/training/checkpoints/",
    "s3://bucket/sk-learn/models/v1/",
    "s3://bucket/sk-proj/models/v1/",
    "s3://bucket/sk-proj/2024/10/06/12/",
    "s3://bucket/asia/2024/10/06/12/30/",
    "s3://bucket/asia/2024.10.06.12.30/",
    "s3://bucket/sk_test_/2024/10/06/12/30/",
    "s3://bucket/models/checkpoints/training/validation/",
    "s3://bucket/releases/v1.2.3/build/2024/10/06/",
    "s3://bucket/sk-ant-/training-data/",
    "s3://bucket/sk-live-backups/prod/",
    "s3://bucket/Run1/Exp2/Model3/Seed4/Trial5/",
  ])("allows ordinary nested paths: %s", (source) => {
    expect(() => parseVolumeSource(source)).not.toThrow();
  });

  it.each([
    "s3://bucket/datasets/v3/training/checkpoints",
    "file:///srv/datasets/2026/October",
    "s3://bucket?endpoint=https://store.example/storage/v2/objects",
    "s3://logs/Asia/Singapore/2024/",
    "s3://asia-backups/prod/",
    "s3://bucket/asia/training-data/",
    "s3://bucket/sk-learn/models/v1/",
    "s3://bucket/Run1/Exp2/Model3/Seed4/Trial5/",
  ])("allows ordinary nested paths: %s", (source) => {
    expect(() => parseVolumeSource(source)).not.toThrow();
  });

  it.each([
    "r2://bucket",
    "s3://bucket?endpoint=https://user:canary-secret@store.example",
    "invalid\u202e",
  ])("F4 describes an invalid stored source safely: %s", (source) => {
    const output = describeVolume({
      apiVersion: "supertag/v1",
      kind: "Volume",
      metadata: { name: "data" },
      spec: { source, credential: "data-key" },
    });
    expect(output).toContain("Source: invalid");
    expect(output).toContain("Credential: data-key");
    expect(output).not.toContain("canary-secret");
    expect(output).not.toContain("\u202e");
  });

  it("refuses settings on file sources and R2 without an endpoint", () => {
    expect(() => parseVolumeSource("file:///srv/data?region=us-east-1")).toThrow();
    expect(() => parseVolumeSource("r2://bucket/data")).toThrow(/endpoint/u);
  });

  it.each(["region", "endpoint", "forcePathStyle", "other"])(
    "refuses %s in credential secrets",
    (key) => {
      expect(() =>
        parseVolumeCredentialSecret(
          "data",
          JSON.stringify({ accessKeyId: "key", secretAccessKey: "secret", [key]: "canary-secret" }),
        ),
      ).toThrow(/unknown field/u);
    },
  );

  it("describes the connection settings without resolving or printing secrets", () => {
    const output = describeVolume({
      apiVersion: "supertag/v1",
      kind: "Volume",
      metadata: { name: "data" },
      spec: {
        source:
          "s3://bucket/data?region=eu-west-2&endpoint=https%3A%2F%2Fstore.example&forcePathStyle=true",
        credential: "data-key",
      },
    });
    expect(output).toContain("Region: eu-west-2");
    expect(output).toContain("Endpoint: https://store.example");
    expect(output).toContain("Force path style: true");
    expect(output).toContain("Credential: data-key (a name;");
    expect(output).not.toMatch(/accessKeyId|secretAccessKey|sessionToken/u);
  });
});
