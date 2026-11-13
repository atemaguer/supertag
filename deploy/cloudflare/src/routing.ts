/**
 * What the Worker in front of the SuperTag container forwards, and how it starts the
 * container. Kept apart from `index.ts` so it can be tested without the Workers runtime.
 *
 * The container accepts gRPC carried in a WebSocket on {@link TUNNEL_PORT}, with SuperTag's own
 * TLS running inside the tunnel, so this Worker sees only ciphertext and makes no
 * authentication decision. It forwards WebSocket upgrades unchanged, including any `Origin`
 * header, which the container refuses, and the plain health check. Nothing else reaches the
 * container.
 */

/** The tunnel listener inside the container. */
export const TUNNEL_PORT = 8080;
/** The plain HTTP health route the tunnel listener answers. */
export const HEALTH_PATH = "/healthz";

const ENTRYPOINT = "/usr/local/bin/supertag-hosted-entrypoint";

/** The Control Plane alone: native gRPC on loopback, the tunnel on {@link TUNNEL_PORT}. */
export const CONTROL_PLANE_COMMAND = [
  ENTRYPOINT,
  "control-plane",
  "--listen",
  "127.0.0.1:3434",
  "--websocket-listen",
  "0.0.0.0:8080",
  "--transfer-directory",
  "/var/lib/supertag/transfers",
];
/**
 * The Control Plane and a Gateway in this one container (Cloudflare gives containers no network
 * between them). The Gateway dials the Control Plane on loopback.
 */
export const PAIR_COMMAND = [ENTRYPOINT, "pair", "0.0.0.0:8080"];

/**
 * Worker secrets and variables passed into the container: the settings from
 * `supertag setup deployment cloudflare` and the TLS PEM values the image entrypoint writes to
 * files. Anything else stays in the Worker.
 */
export const CONTAINER_KEYS = [
  "SUPERTAG_DATABASE_URL",
  "SUPERTAG_GATEWAY_TOKEN",
  "SUPERTAG_OPERATOR_TOKEN",
  "SUPERTAG_OPERATOR_PRINCIPAL",
  "SUPERTAG_STATE_DIR",
  "SUPERTAG_GITHUB_ACCOUNT_ID",
  "SUPERTAG_GITHUB_REPOSITORY_ID",
  "SUPERTAG_GITHUB_REPOSITORY",
  "SUPERTAG_GITHUB_TOKEN",
  "SUPERTAG_GITHUB_APP_ID",
  "SUPERTAG_GITHUB_INSTALLATION_ID",
  "SUPERTAG_GITHUB_PRIVATE_KEY_FILE",
  "SUPERTAG_CREDENTIAL_VAULT",
  "VAULT_ADDR",
  "VAULT_TOKEN",
  "VAULT_NAMESPACE",
  "SUPERTAG_VAULT_MOUNT",
  "SUPERTAG_VAULT_PATH_PREFIX",
  "SUPERTAG_TLS_CERT_PEM",
  "SUPERTAG_TLS_KEY_PEM",
  "SUPERTAG_TLS_CLIENT_CA_PEM",
  "SUPERTAG_SERVER_CA_PEM",
  "SUPERTAG_CLIENT_CERT_PEM",
  "SUPERTAG_CLIENT_KEY_PEM",
] as const;

/** The container's environment: only {@link CONTAINER_KEYS} that are set to a string. */
export function containerEnvironment(env: Record<string, unknown>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of CONTAINER_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value !== "") environment[key] = value;
  }
  return environment;
}

/** The container command: with `SUPERTAG_GATEWAY` set to `on`, the Control Plane and a Gateway. */
export function containerCommand(env: Record<string, unknown>): string[] {
  const gateway = env["SUPERTAG_GATEWAY"];
  if (gateway === "on") return [...PAIR_COMMAND];
  if (gateway === undefined || gateway === "off") return [...CONTROL_PLANE_COMMAND];
  throw new Error("SUPERTAG_GATEWAY must be on or off");
}

/**
 * The request to forward to the container, or the response to answer with instead. A request
 * header naming a container port is removed, so a client can reach only the tunnel listener.
 */
export function forwardable(request: Request): Request | Response {
  const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  const health = request.method === "GET" && new URL(request.url).pathname === HEALTH_PATH;
  if (!upgrade && !health)
    return new Response("This endpoint carries SuperTag's WebSocket tunnel only.\n", {
      status: 426,
      headers: { Upgrade: "websocket", "Content-Type": "text/plain" },
    });
  const headers = new Headers(request.headers);
  headers.delete("cf-container-target-port");
  return new Request(request, { headers });
}
