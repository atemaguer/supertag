import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "supertag-mixed-grpc-live-"));
const suffix = randomUUID().slice(0, 8);
const image = `supertag-mixed-grpc-live:${suffix}`;
const container = `supertag-mixed-grpc-live-${suffix}`;
const environmentId = `mixed-grpc-live-${suffix}`;
const adminToken = randomUUID();
const environment = {
  ...process.env,
  SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
  SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID: environmentId,
};
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, env: environment, stdio: "inherit", ...options });
try {
  const manifest = JSON.parse(
    await readFile(join(root, "packages/runtime/harnesses/codex/package.json"), "utf8"),
  );
  const version = manifest.dependencies["@openai/codex-sdk"];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error("Codex SDK version must be pinned");
  await mkdir(join(directory, "certificates"));
  run(
    "openssl",
    [
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
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "pipe" },
  );
  run("pnpm", [
    "exec",
    "esbuild",
    "tests/fixtures/mixed-harness-grpc-live-service.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--conditions=development",
    `--outfile=${join(directory, "service.mjs")}`,
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  ]);
  await writeFile(
    join(directory, "Dockerfile"),
    [
      "FROM node:24-bookworm-slim",
      `RUN npm install --global @openai/codex@${version} && groupadd -g 10001 workload && useradd -u 10001 -g workload workload`,
      "WORKDIR /app",
      "COPY service.mjs /app/service.mjs",
      'CMD ["node", "/app/service.mjs"]',
    ].join("\n"),
  );
  run("docker", ["build", "-t", image, directory]);
  run("docker", [
    "run",
    "-d",
    "--name",
    container,
    "-p",
    "127.0.0.1::8788",
    "-e",
    "SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN",
    "-e",
    "SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID",
    "-v",
    `${join(directory, "certificates")}:/certificates:ro`,
    image,
  ]);
  const deadline = Date.now() + 30_000;
  while (true) {
    const logs = run("docker", ["logs", container], { encoding: "utf8", stdio: "pipe" });
    if (logs.includes("mixed Harness gRPC execution ready")) break;
    if (Date.now() > deadline) throw new Error("Live execution service did not become ready");
    await delay(100);
  }
  const port = run("docker", ["port", container, "8788/tcp"], { encoding: "utf8", stdio: "pipe" })
    .trim()
    .match(/:(\d+)$/u)?.[1];
  if (!port) throw new Error("Missing live execution service port");
  run("pnpm", ["exec", "vitest", "run", "tests/mixed-harness-shared-docker-live.test.ts"], {
    timeout: 800_000,
    env: {
      ...process.env,
      SUPERTAG_MIXED_HARNESS_SHARED_URL: `https://127.0.0.1:${port}`,
      SUPERTAG_MIXED_HARNESS_SHARED_TRANSPORT: "grpc",
      SUPERTAG_MIXED_HARNESS_TLS_CA_PATH: join(directory, "certificates/server.crt"),
      SUPERTAG_MIXED_HARNESS_ENVIRONMENT_ID: environmentId,
      SUPERTAG_MIXED_HARNESS_ADMIN_TOKEN: adminToken,
    },
  });
} finally {
  try {
    run("docker", ["rm", "-f", container], { stdio: "pipe" });
  } catch {
    /* cleanup after startup failure */
  }
  try {
    run("docker", ["image", "rm", "-f", image], { stdio: "pipe" });
  } catch {
    /* image may not have built */
  }
  await rm(directory, { recursive: true, force: true });
}
