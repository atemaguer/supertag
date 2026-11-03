/** Shared deployment contract. This module also runs in Cloudflare Workers: no Node APIs. */
export const DEPLOYMENT_RUNTIME = {
  stateDirectory: "/var/lib/supertag",
  port: 3434,
  grpcPort: 3435,
  startCommand: "node dist/index.js up --foreground control-plane",
  migrationCommand: "node dist/index.js migrate",
  healthPath: "/healthz",
  readinessPath: "/readyz",
} as const;
export const DEPLOYMENT_PLATFORMS = ["railway", "render", "cloudflare", "fly", "modal"] as const;
export type DeploymentPlatform = (typeof DEPLOYMENT_PLATFORMS)[number];
/** Template capabilities, not a claim about every provider networking product. */
export const DEPLOYMENT_RPC_CAPABILITIES = {
  railway: { grpc: false, websocket: true },
  render: { grpc: false, websocket: true },
  cloudflare: { grpc: false, websocket: true },
  fly: { grpc: true, websocket: true },
  modal: { grpc: false, websocket: true },
} as const;
export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

export function deploymentPlatform(value: string | undefined): DeploymentPlatform {
  if (!DEPLOYMENT_PLATFORMS.includes(value as DeploymentPlatform))
    throw new Error(`Deployment platform must be one of: ${DEPLOYMENT_PLATFORMS.join(", ")}`);
  return value as DeploymentPlatform;
}

export const DEPLOYMENT_SECRET_KEYS = new Set([
  "SUPERTAG_DATABASE_URL",
  "SUPERTAG_ADMIN_TOKEN",
  "VAULT_TOKEN",
]);
export const DEPLOYMENT_ENVIRONMENT_KEYS = [
  "SUPERTAG_DEPLOYMENT_PLATFORM",
  "SUPERTAG_STATE_DIR",
  "SUPERTAG_WORKLET_TRANSPORT",
  "SUPERTAG_RPC_TRACE",
  "SUPERTAG_DEPLOYMENT_RPC_TRANSPORT",
  "SUPERTAG_WORKLET_GRPC_PORT",
  "SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE",
  "SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE",
  "SUPERTAG_CREDENTIAL_VAULT",
  "SUPERTAG_DATABASE_URL",
  "SUPERTAG_ADMIN_TOKEN",
  "SUPERTAG_COORDINATION_URL",
  "SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID",
  "SUPERTAG_OPERATOR_CHANNEL",
  "VAULT_ADDR",
  "VAULT_TOKEN",
  "VAULT_NAMESPACE",
  "SUPERTAG_VAULT_MOUNT",
  "SUPERTAG_VAULT_PATH_PREFIX",
] as const;

export function deploymentDefaults(platform: DeploymentPlatform): Record<string, string> {
  return {
    SUPERTAG_DEPLOYMENT_PLATFORM: platform,
    SUPERTAG_STATE_DIR: DEPLOYMENT_RUNTIME.stateDirectory,
    SUPERTAG_WORKLET_TRANSPORT: "remote",
    SUPERTAG_DEPLOYMENT_RPC_TRANSPORT: "websocket",
    SUPERTAG_CREDENTIAL_VAULT: platform === "cloudflare" || platform === "modal" ? "vault" : "file",
  };
}

export function deploymentRequiredKeys(
  _platform: DeploymentPlatform,
  env: DeploymentEnvironment,
): string[] {
  return [
    "SUPERTAG_DATABASE_URL",
    "SUPERTAG_ADMIN_TOKEN",
    "SUPERTAG_COORDINATION_URL",
    ...(env["SUPERTAG_CREDENTIAL_VAULT"] === "vault" ? ["VAULT_ADDR", "VAULT_TOKEN"] : []),
  ];
}

export function resolveDeploymentEnvironment(
  platform: DeploymentPlatform,
  supplied: DeploymentEnvironment,
): Record<string, string> {
  const env = deploymentDefaults(platform);
  for (const key of DEPLOYMENT_ENVIRONMENT_KEYS) {
    if (supplied[key]?.trim()) env[key] = supplied[key].trim();
  }
  const issues: string[] = [];
  if (env["SUPERTAG_RPC_TRACE"] && !["0", "1"].includes(env["SUPERTAG_RPC_TRACE"]))
    issues.push("SUPERTAG_RPC_TRACE must be 0 or 1");
  const rpc = env["SUPERTAG_DEPLOYMENT_RPC_TRANSPORT"];
  if (rpc !== "websocket" && rpc !== "grpc")
    issues.push("SUPERTAG_DEPLOYMENT_RPC_TRANSPORT must be websocket or grpc");
  if (rpc === "grpc") {
    if (!DEPLOYMENT_RPC_CAPABILITIES[platform].grpc)
      issues.push(`${platform} template requires WebSocket; native gRPC ingress is not configured`);
    if (env["SUPERTAG_WORKLET_GRPC_PORT"] !== String(DEPLOYMENT_RUNTIME.grpcPort))
      issues.push(
        `gRPC template requires SUPERTAG_WORKLET_GRPC_PORT=${DEPLOYMENT_RUNTIME.grpcPort}`,
      );
    for (const key of ["SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE", "SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE"])
      if (!env[key]?.startsWith("/")) issues.push(`${key} must name an absolute mounted file`);
  } else if (
    [
      "SUPERTAG_WORKLET_GRPC_PORT",
      "SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE",
      "SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE",
    ].some((key) => env[key])
  ) {
    issues.push("gRPC listener settings require SUPERTAG_DEPLOYMENT_RPC_TRANSPORT=grpc");
  }

  for (const key of deploymentRequiredKeys(platform, env))
    if (!env[key]) issues.push(`Missing ${key}`);
  if (env["SUPERTAG_DEPLOYMENT_PLATFORM"] !== platform)
    issues.push("SUPERTAG_DEPLOYMENT_PLATFORM does not match the selected platform");
  if (env["SUPERTAG_WORKLET_TRANSPORT"] !== "remote")
    issues.push("Hosted deployments require SUPERTAG_WORKLET_TRANSPORT=remote");
  if (!["file", "vault"].includes(env["SUPERTAG_CREDENTIAL_VAULT"] ?? ""))
    issues.push("SUPERTAG_CREDENTIAL_VAULT must be file or vault");
  if (
    (platform === "cloudflare" || platform === "modal") &&
    env["SUPERTAG_CREDENTIAL_VAULT"] !== "vault"
  )
    issues.push(`${platform} hosting requires SUPERTAG_CREDENTIAL_VAULT=vault`);
  if (
    env["SUPERTAG_CREDENTIAL_VAULT"] === "file" &&
    env["SUPERTAG_STATE_DIR"] !== DEPLOYMENT_RUNTIME.stateDirectory
  )
    issues.push(
      `Local credentials require the template's persistent mount at ${DEPLOYMENT_RUNTIME.stateDirectory}`,
    );
  const parseUrl = (key: string): URL | undefined => {
    if (!env[key]) return undefined;
    try {
      return new URL(env[key]);
    } catch {
      issues.push(`${key} must be a valid URL`);
      return undefined;
    }
  };
  const database = parseUrl("SUPERTAG_DATABASE_URL");
  if (database && !["postgres:", "postgresql:"].includes(database.protocol))
    issues.push("Hosted deployments require PostgreSQL");
  for (const key of ["SUPERTAG_COORDINATION_URL", "VAULT_ADDR"]) {
    const url = parseUrl(key);
    if (
      url &&
      (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    )
      issues.push(`${key} must be an HTTPS URL without credentials, query, or fragment`);
    if (key === "SUPERTAG_COORDINATION_URL" && url && url.pathname !== "/")
      issues.push("SUPERTAG_COORDINATION_URL must be an origin without a path");
  }
  if (issues.length) throw new Error(issues.join("\n"));
  return env;
}
