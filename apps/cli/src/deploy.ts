import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { input, password } from "@inquirer/prompts";
import {
  DEPLOYMENT_ENVIRONMENT_KEYS,
  DEPLOYMENT_PLATFORMS,
  DEPLOYMENT_RUNTIME,
  DEPLOYMENT_SECRET_KEYS,
  deploymentDefaults,
  deploymentPlatform,
  deploymentRequiredKeys,
  resolveDeploymentEnvironment,
} from "@supertag/deployment";
import { CoordinationService } from "@supertag/worker-transport";
import { organizationClient } from "./operator-client.js";

export function deploymentHelp(): string {
  return `Usage:
  supertag setup deployment --platform ${DEPLOYMENT_PLATFORMS.join("|")} [--transport websocket|grpc] [--output .env.deployment] [--non-interactive]
  supertag check deployment --platform ${DEPLOYMENT_PLATFORMS.join("|")} [--env-file PATH]
  supertag verify deployment URL [--env-file PATH] [--require-ready] [--grpc-url URL]

Setup reads provider environment variables and prompts for missing values (secrets are masked).
It writes a private environment file without replacing an existing file. Non-interactive setup
requires all required values in the environment. Secrets are never accepted as flags or printed.
Check validates configuration without connecting. Verify checks HTTPS health and API authentication.
With --grpc-url, verify also checks TLS/HTTP2 RPC routing and rejection of an invalid execution credential.
Use SUPERTAG_WORKLET_TLS_CA_FILE for a private CA; this probe does not register a Worker Host.
Upload the environment through your hosting provider's secret/variable controls; do not shell-source it.
`;
}

export function serializeDeploymentEnvironment(environment: Record<string, string>): string {
  return `${Object.entries(environment)
    .map(([key, value]) => {
      if (/[\r\n\0]/u.test(value) || (value.includes("'") && value.includes('"')))
        throw new Error(`${key} cannot be represented in the deployment environment file`);
      const quote = value.includes("'") ? '"' : "'";
      return `${key}=${quote}${value}${quote}`;
    })
    .join("\n")}\n`;
}

export async function verifyDeployment(
  address: string,
  token: string,
  requireReady = false,
  request: typeof fetch = fetch,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("Deployment URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Deployment URL must be an HTTPS origin without credentials, query, or fragment",
    );
  if (!token.trim()) throw new Error("SUPERTAG_ADMIN_TOKEN is required");
  const get = (path: string) =>
    request(new URL(path, url), { redirect: "error", signal: AbortSignal.timeout(15_000) });
  const health = await get(DEPLOYMENT_RUNTIME.healthPath);
  if (!health.ok || ((await health.json()) as { ok?: unknown }).ok !== true)
    throw new Error("Control Plane liveness check failed");
  const rpc = (authenticated: boolean) =>
    organizationClient({
      url: url.origin,
      ...(authenticated ? { token } : {}),
      fetch: request,
    }).getStatus({}, { timeoutMs: 15_000 });
  const anonymous = await rpc(false).then(
    () => undefined,
    (error: unknown) => ConnectError.from(error),
  );
  if (anonymous?.code !== Code.Unauthenticated)
    throw new Error("Control Plane management API did not reject an anonymous request");
  try {
    await rpc(true);
  } catch (error) {
    throw new Error(
      `Control Plane management authentication failed (${Code[ConnectError.from(error).code]})`,
    );
  }
  const readiness = await get(DEPLOYMENT_RUNTIME.readinessPath);
  await readiness.body?.cancel();
  if (!readiness.ok && (requireReady || readiness.status !== 503))
    throw new Error(`Control Plane readiness check failed (HTTP ${readiness.status})`);
  return `Liveness and management authentication passed. Readiness: ${readiness.ok ? "ready" : "not ready; connect a compatible Worklet and inspect status"}.\n`;
}

/** A read-only negative authentication probe: never sends the administrative credential. */
export async function verifyDeploymentGrpc(address: string, tlsCa?: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("gRPC deployment URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "gRPC deployment URL must be an HTTPS origin without credentials, query, or fragment",
    );
  return probeInvalidExecutionCredential(url.origin, tlsCa);
}

/**
 * Calls `CoordinationService.ListTools` at `origin` with an invalid credential and requires a gRPC
 * `Unauthenticated` refusal. It checks no URL policy of its own.
 */
export async function probeInvalidExecutionCredential(
  origin: string,
  tlsCa?: string,
): Promise<string> {
  const client = createClient(
    CoordinationService,
    createGrpcTransport({
      baseUrl: origin,
      readMaxBytes: 8192,
      writeMaxBytes: 8192,
      idleConnectionTimeoutMs: 1000,
      ...(tlsCa ? { nodeOptions: { ca: tlsCa } } : {}),
    }),
  );
  try {
    await client.listTools(
      {},
      {
        headers: { authorization: "Bearer supertag-deployment-verification-invalid-credential" },
        timeoutMs: 30_000,
      },
    );
  } catch (error) {
    if (
      error instanceof ConnectError &&
      error.code === Code.Unauthenticated &&
      error.isWireError &&
      error.metadata.get("grpc-status") === "16"
    )
      return "gRPC TLS/HTTP2 routing and invalid execution credential rejection passed. Authenticated Worklet registration and sustained connectivity are not checked.\n";
    throw new Error(
      "gRPC verification failed: check the RPC listener, HTTP/2 routing, TLS certificate and coordination service.",
    );
  }
  throw new Error(
    "gRPC verification failed: the coordination service accepted an invalid execution credential.",
  );
}

export async function runDeploymentCommand(args: readonly string[]): Promise<string> {
  if (!args.length || args.includes("--help") || args.includes("-h")) return deploymentHelp();
  const [command, ...rest] = args;
  if (!["setup", "check", "verify"].includes(command ?? "")) throw new Error(deploymentHelp());
  const { values: parsedValues, positionals } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: command === "verify",
    options:
      command === "verify"
        ? {
            "env-file": { type: "string" },
            "require-ready": { type: "boolean", default: false },
            "grpc-url": { type: "string" },
          }
        : {
            platform: { type: "string" },
            transport: { type: "string" },
            "env-file": { type: "string" },
            ...(command === "setup"
              ? {
                  output: { type: "string", default: ".env.deployment" },
                  "non-interactive": { type: "boolean", default: false },
                }
              : {}),
          },
  });
  const values = parsedValues as Record<string, string | boolean | undefined>;
  const file = values["env-file"];
  const environment: Record<string, string | undefined> = { ...process.env };
  if (typeof file === "string") {
    const parsed = parseEnv(await readFile(file, "utf8"));
    for (const key of Object.keys(parsed))
      if (!(DEPLOYMENT_ENVIRONMENT_KEYS as readonly string[]).includes(key))
        throw new Error(`Unknown deployment environment key: ${key}`);
    Object.assign(environment, parsed);
  }
  if (command === "verify") {
    if (positionals.length !== 1) throw new Error("deploy verify requires one HTTPS URL");
    const result = await verifyDeployment(
      positionals[0] as string,
      environment["SUPERTAG_ADMIN_TOKEN"] ?? "",
      values["require-ready"] === true,
    );
    const grpcUrl = values["grpc-url"];
    if (typeof grpcUrl !== "string") return result;
    const caFile = process.env["SUPERTAG_WORKLET_TLS_CA_FILE"];
    return (
      result +
      (await verifyDeploymentGrpc(grpcUrl, caFile ? await readFile(caFile, "utf8") : undefined))
    );
  }
  const platform = deploymentPlatform(
    typeof values["platform"] === "string" ? values["platform"] : undefined,
  );
  const configured = { ...deploymentDefaults(platform) };
  for (const key of DEPLOYMENT_ENVIRONMENT_KEYS)
    if (environment[key]?.trim()) configured[key] = environment[key];
  if (typeof values["transport"] === "string") {
    configured["SUPERTAG_DEPLOYMENT_RPC_TRANSPORT"] = values["transport"];
    if (values["transport"] === "grpc") {
      configured["SUPERTAG_WORKLET_GRPC_PORT"] ??= String(DEPLOYMENT_RUNTIME.grpcPort);
      configured["SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE"] ??=
        `${DEPLOYMENT_RUNTIME.stateDirectory}/tls/fullchain.pem`;
      configured["SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE"] ??=
        `${DEPLOYMENT_RUNTIME.stateDirectory}/tls/privkey.pem`;
    }
  }
  if (command === "setup" && values["non-interactive"] !== true) {
    for (const key of deploymentRequiredKeys(platform, configured)) {
      if (configured[key]?.trim()) continue;
      if (key === "SUPERTAG_ADMIN_TOKEN") {
        configured[key] = randomBytes(32).toString("hex");
        continue;
      }
      configured[key] = await (DEPLOYMENT_SECRET_KEYS.has(key)
        ? password({ message: key, mask: "*" })
        : input({ message: key }));
    }
  }
  const validated = resolveDeploymentEnvironment(platform, configured);
  const transportHint =
    validated["SUPERTAG_DEPLOYMENT_RPC_TRANSPORT"] === "grpc"
      ? "Use deploy/fly/fly.grpc.toml and install the configured certificate/key on the persistent volume before starting.\n"
      : "Worker Hosts must connect with --transport websocket for this deployment profile.\n";
  if (command === "check")
    return `${platform} deployment configuration is valid. Connectivity and volume durability are not checked.\n${transportHint}`;
  const output = resolve(
    typeof values["output"] === "string" ? values["output"] : ".env.deployment",
  );
  await writeFile(output, serializeDeploymentEnvironment(validated), { mode: 0o600, flag: "wx" });
  return `Saved ${platform} deployment configuration to ${output} (contains secrets; keep private).\nUpload through provider variables/secrets, then follow docs/guides/deploy-${platform}.md.\n${transportHint}`;
}
