import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";

const execute = promisify(execFile);
const suite = process.env["SUPERTAG_DOCKER_WORKLET_ARTIFACTS"] === "1" ? describe : describe.skip;
const root = resolve(import.meta.dirname, "..");

suite.each(["http", "grpc"])(
  "direct Worklet artifact transfer with %s metadata across isolated Docker hosts",
  (metadataTransport) => {
    let directory = "";
    let network = "";
    let image = "";
    let digest = "";
    let bytes = Buffer.alloc(0);
    let common: NodeJS.ProcessEnv;
    const containers: string[] = [];
    const name = (service: string) => `${network}-${service}`;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "supertag-worklet-artifacts-"));
      network = `supertag-artifacts-${randomUUID().slice(0, 8)}`;
      image = `${network}:test`;
      bytes = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 251));
      digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      for (const service of ["worker-a", "worker-b", "metadata"]) {
        await mkdir(join(directory, service), { recursive: true });
        await chmod(join(directory, service), 0o777);
      }
      await mkdir(join(directory, "seed"));
      await writeFile(join(directory, "seed/evidence.bin"), bytes);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      common = {
        ...process.env,
        ARTIFACT_DIGEST: digest,
        ARTIFACT_SIZE: String(bytes.byteLength),
        ARTIFACT_METADATA_TRANSPORT: metadataTransport,
      };
      await mkdir(join(directory, "certificates"));
      await execute("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(directory, "certificates/server.key"),
        "-out",
        join(directory, "certificates/server.crt"),
        "-subj",
        "/CN=metadata",
        "-addext",
        "subjectAltName=DNS:metadata",
      ]);
      await chmod(join(directory, "certificates/server.key"), 0o644);
      await execute(
        "pnpm",
        [
          "exec",
          "esbuild",
          "tests/fixtures/worklet-artifact-transfer-docker.ts",
          "--bundle",
          "--platform=node",
          "--format=esm",
          "--conditions=development",
          "--external:better-sqlite3",
          "--external:ws",
          '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
          `--outfile=${join(directory, "fixture.mjs")}`,
        ],
        { cwd: root, maxBuffer: 20 * 1024 * 1024 },
      );
      await writeFile(
        join(directory, "Dockerfile"),
        [
          "FROM node:24-bookworm-slim",
          "WORKDIR /app",
          'RUN echo \'{"type":"module"}\' > package.json && npm install --omit=dev better-sqlite3@12.11.1 ws@8.19.0 && groupadd -g 10001 workload && useradd -u 10001 -g workload workload',
          "COPY fixture.mjs /app/fixture.mjs",
          "USER workload",
        ].join("\n"),
      );
      await execute("docker", ["build", "-t", image, directory], { maxBuffer: 20 * 1024 * 1024 });
      await execute("docker", ["network", "create", network]);
      await launch("producer", "worker-a", "Producer Worklet ready", {
        ...common,
        TRANSFER_PUBLIC_KEY: Buffer.from(
          publicKey.export({ type: "spki", format: "pem" }),
        ).toString("base64"),
      });
      await launch("metadata", "metadata", "Metadata service ready", {
        ...common,
        TRANSFER_PRIVATE_KEY: Buffer.from(
          privateKey.export({ type: "pkcs8", format: "pem" }),
        ).toString("base64"),
      });
      await launch("consumer", "worker-b", "Consumer Worklet complete", common, false);
    }, 120_000);

    afterAll(async () => {
      await Promise.all(
        containers.map((container) =>
          execute("docker", ["rm", "-f", container]).catch(() => undefined),
        ),
      );
      if (network) await execute("docker", ["network", "rm", network]).catch(() => undefined);
      if (image) await execute("docker", ["image", "rm", image]).catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 30_000);

    it("resolves metadata then transfers bytes directly after the metadata service exits", async () => {
      onTestFailed(async () => {
        for (const container of containers) {
          const logs = await execute("docker", ["logs", container]).catch(() => ({
            stdout: "",
            stderr: "",
          }));
          process.stderr.write(`${container}: ${logs.stdout}${logs.stderr}\n`);
        }
      });
      const hex = digest.slice("sha256:".length);
      const producer = JSON.parse(
        await readFile(join(directory, "worker-a/producer.json"), "utf8"),
      );
      const consumer = JSON.parse(
        await readFile(join(directory, "worker-b/consumer.json"), "utf8"),
      );
      const metadata = JSON.parse(
        await readFile(join(directory, "metadata/metadata.json"), "utf8"),
      );

      expect(producer).toMatchObject({ sizeBytes: bytes.byteLength });
      expect(producer.ref).toMatchObject({ digest, uri: `supertag-artifact:${digest}` });
      expect(consumer).toEqual({
        digest,
        sizeBytes: bytes.byteLength,
        metadataUnavailableBeforeTransfer: true,
        wrongCredentialRejected: true,
        grantRejections: [403, 403],
      });
      expect(metadata).toMatchObject({ requests: 1, transport: metadataTransport });
      expect(metadata.requestBytes).toBeLessThan(2_048);
      expect(metadata.responseBytes).toBeLessThan(32_768);
      expect(await readFile(join(directory, `worker-a/artifacts/sha256/${hex}`))).toEqual(bytes);
      expect(await readFile(join(directory, `worker-b/artifacts/sha256/${hex}`))).toEqual(bytes);
      expect(await readdir(join(directory, "metadata"))).toEqual(["metadata.json"]);
      const metadataRunning = (
        await execute("docker", ["inspect", "-f", "{{.State.Running}}", name("metadata")])
      ).stdout.trim();
      expect(metadataRunning).toBe("false");
    });

    it("reports an unavailable source and recovers direct transfer after its restart without metadata", async () => {
      await execute("docker", ["stop", "-t", "1", name("worker-a")]);
      await launch(
        "source-probe",
        "unavailable-probe",
        "Source probe complete",
        { ...common, SOURCE_AVAILABLE: "false" },
        false,
        "worker-b",
      );
      expect(
        JSON.parse(await readFile(join(directory, "worker-b/probe-false.json"), "utf8")),
      ).toEqual({ available: false, metadataAvailable: false });
      await rm(join(directory, "seed/evidence.bin"));
      await execute("docker", ["start", name("worker-a")]);
      await eventually(async () => {
        const health = await execute("docker", [
          "exec",
          name("worker-a"),
          "node",
          "-e",
          "fetch('http://127.0.0.1:8788/').then(()=>process.exit(0)).catch(()=>process.exit(1))",
        ]).then(
          () => true,
          () => false,
        );
        return health;
      });
      await launch(
        "source-probe",
        "recovered-probe",
        "Source probe complete",
        { ...common, SOURCE_AVAILABLE: "true" },
        false,
        "worker-b",
      );
      expect(
        JSON.parse(await readFile(join(directory, "worker-b/probe-true.json"), "utf8")),
      ).toEqual({ available: true, metadataAvailable: false });
    }, 30_000);

    async function launch(
      mode: string,
      service: string,
      marker: string,
      environment: NodeJS.ProcessEnv,
      detached = true,
      stateService = service,
    ) {
      containers.push(name(service));
      const args = [
        "run",
        ...(detached ? ["-d"] : []),
        "--name",
        name(service),
        "--hostname",
        service,
        "--network",
        network,
        "--network-alias",
        service,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--mount",
        `type=bind,source=${join(directory, stateService)},target=/state`,
        "--mount",
        `type=bind,source=${join(directory, "certificates")},target=/tls,readonly`,
        ...(mode === "producer"
          ? ["--mount", `type=bind,source=${join(directory, "seed")},target=/seed,readonly`]
          : []),
        "-e",
        `FIXTURE_MODE=${mode}`,
        "-e",
        "ARTIFACT_DIGEST",
        "-e",
        "ARTIFACT_SIZE",
        "-e",
        "ARTIFACT_METADATA_TRANSPORT",
        "-e",
        "SOURCE_AVAILABLE",
        "-e",
        "TRANSFER_PRIVATE_KEY",
        "-e",
        "TRANSFER_PUBLIC_KEY",
        image,
        "node",
        "/app/fixture.mjs",
      ];
      const result = await execute("docker", args, {
        env: environment,
        maxBuffer: 20 * 1024 * 1024,
      });
      if (!detached) {
        expect(result.stdout).toContain(marker);
        return;
      }
      await eventually(async () => {
        const logs = await execute("docker", ["logs", name(service)]);
        const running = (
          await execute("docker", ["inspect", "-f", "{{.State.Running}}", name(service)])
        ).stdout.trim();
        if (running !== "true") {
          const state = await execute("docker", [
            "inspect",
            "-f",
            "exit={{.State.ExitCode}} error={{.State.Error}} oom={{.State.OOMKilled}}",
            name(service),
          ]);
          throw new Error(
            `${service} exited (${state.stdout.trim()}): ${logs.stdout}${logs.stderr}`,
          );
        }
        return logs.stdout.includes(marker);
      });
    }
  },
);

async function eventually(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
