import {
  isAuthKeySecret,
  workerHostNameCandidate,
  workerHostNameFromHostname,
} from "@supertag/core";
import { stateDirectory as defaultStateDirectory } from "@supertag/store";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import {
  CONTROL_PLANE_API_VERSION,
  type WorkerHostCredentialIssuance,
} from "./control-plane-resources.js";
import { machineName as machineHostname } from "./machine-name.js";
import {
  findStoredWorkerHostCredentials,
  readStoredWorkerHostCredential,
  storeWorkerHostCredential,
} from "./worker-hosts.js";

/** How `connect worklet` obtained the Worker Host credential it uses. */
export type WorkletCredentialSource = "stored" | "auth-key" | "operator";

export interface WorkletCredential {
  readonly workerHostId: string;
  readonly token: string;
  readonly source: WorkletCredentialSource;
  /** One line for the person running the command, such as the host that joined. */
  readonly notice?: string;
  /** The Tags an Auth Key bound the host to, when it joined just now. */
  readonly tags?: readonly string[];
  /** The host joined with an ephemeral Auth Key: its storage is lost when it stops. */
  readonly ephemeral?: boolean;
}

export interface WorkletCredentialOptions {
  /** HTTP URL of the Control Plane's management API; stored credentials are keyed by it. */
  readonly controlPlane: string;
  readonly requestedWorkerHostId?: string;
  readonly authKey?: string;
  /** Operator credentials on this machine, used to enroll the host directly. */
  readonly operatorTarget?: () => Promise<ControlPlaneTarget | undefined>;
  readonly hostname?: string;
  readonly stateDirectory?: string;
  /**
   * Store an ephemeral host's credential too. `supertag up` joins in one process and runs the
   * Worklet in another, so the credential must outlive the joining process.
   */
  readonly storeEphemeral?: boolean;
  readonly fetch?: typeof fetch;
}

/** Most `NAME-N` IDs tried when an operator enrolls this machine under its hostname. */
const MAX_OPERATOR_NAME_ATTEMPTS = 20;

/**
 * Resolves the credential `connect worklet` uses, in order:
 * 1. a stored credential for this Control Plane (any Auth Key is then ignored);
 * 2. an Auth Key, redeemed to join as a new Worker Host;
 * 3. operator credentials for this Control Plane, used to enroll the host directly;
 * 4. otherwise, an error that asks for an Auth Key.
 */
export async function resolveWorkletCredential(
  options: WorkletCredentialOptions,
): Promise<WorkletCredential> {
  const state = options.stateDirectory ?? defaultStateDirectory();
  const requested = options.requestedWorkerHostId?.trim() || undefined;
  const stored = await storedCredential(options.controlPlane, requested, state);
  if (stored !== undefined)
    return {
      workerHostId: stored.workerHostId,
      token: stored.token,
      source: "stored",
      ...(stored.ephemeral === true ? { ephemeral: true } : {}),
    };

  const name = requested ?? workerHostNameFromHostname(options.hostname ?? machineHostname());
  const authKey = options.authKey?.trim();
  if (authKey) return joinWithAuthKey(options, authKey, name, state);

  const target = await options.operatorTarget?.().catch(() => undefined);
  if (target !== undefined && sameControlPlane(target.url, options.controlPlane))
    return enrollAsOperator(options, target, name, requested !== undefined, state);

  throw new Error(
    `No Worker Host credential for ${options.controlPlane} is stored on this machine. Ask an operator for an Auth Key (supertag create auth-key NAME --tag TAG), then pass it with --auth-key or SUPERTAG_AUTH_KEY.`,
  );
}

async function storedCredential(
  controlPlane: string,
  requested: string | undefined,
  state: string,
) {
  if (requested !== undefined) {
    const credential = await readStoredWorkerHostCredential(requested, state);
    if (credential === undefined) return undefined;
    if (credential.workerHostId !== requested)
      throw new Error("--worker-host does not match the enrolled Worker Host credential");
    if (credential.controlPlane !== undefined && credential.controlPlane !== controlPlane)
      throw new Error(
        `The stored credential for Worker Host ${requested} belongs to ${credential.controlPlane}`,
      );
    return credential;
  }
  const found = await findStoredWorkerHostCredentials(controlPlane, state);
  if (found.length > 1)
    throw new Error(
      `Several Worker Hosts on this machine joined ${controlPlane}: ${found.map((item) => item.workerHostId).join(", ")}. Choose one with --worker-host ID.`,
    );
  return found[0];
}

interface JoinResponse extends WorkerHostCredentialIssuance {
  readonly status?: {
    readonly authKey?: string;
    readonly tags?: readonly string[];
    readonly ephemeral?: boolean;
  };
}

/** A Worker Host credential an Auth Key was redeemed for. */
export interface RedeemedAuthKey {
  readonly workerHostId: string;
  readonly token: string;
  readonly tags: readonly string[];
  readonly ephemeral: boolean;
  /** One line naming the host that joined, such as for display. */
  readonly notice: string;
}

/** Redeems an Auth Key at a Control Plane to join as a new Worker Host named near `name`. */
export async function redeemAuthKey(options: {
  readonly controlPlane: string;
  readonly authKey: string;
  readonly name: string;
  readonly fetch?: typeof fetch;
}): Promise<RedeemedAuthKey> {
  const { authKey, name } = options;
  if (!isAuthKeySecret(authKey))
    throw new Error("The Auth Key is malformed; it starts with stak_ followed by 64 hex digits");
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(new URL("/api/v1/worker-host-joins", `${options.controlPlane}/`), {
      method: "POST",
      headers: { authorization: `Bearer ${authKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        apiVersion: CONTROL_PLANE_API_VERSION,
        kind: "WorkerHostJoin",
        metadata: { name },
        spec: {},
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the Control Plane management API at ${options.controlPlane} to join. Set SUPERTAG_CONTROL_PLANE to its management URL.`,
      { cause: error },
    );
  }
  const body = (await response.json().catch(() => undefined)) as
    | (JoinResponse & { readonly message?: unknown })
    | undefined;
  if (!response.ok) {
    const message =
      typeof body?.message === "string"
        ? body.message
        : `Control Plane returned HTTP ${response.status}`;
    throw new Error(`Joining with the Auth Key failed: ${message}`);
  }
  const workerHostId = body?.metadata?.workerHostId;
  const token = body?.credential?.token;
  if (
    body?.apiVersion !== CONTROL_PLANE_API_VERSION ||
    body.kind !== "WorkerHostCredential" ||
    typeof workerHostId !== "string" ||
    typeof token !== "string" ||
    !token
  )
    throw new Error("Control Plane returned an invalid Worker Host credential");
  const ephemeral = body.status?.ephemeral === true;
  const tags = body.status?.tags?.length ? ` for Tags ${body.status.tags.join(", ")}` : "";
  return {
    workerHostId,
    token,
    tags: body.status?.tags ?? [],
    ephemeral,
    notice: `Joined as ${ephemeral ? "ephemeral " : ""}Worker Host ${workerHostId}${tags}.`,
  };
}

async function joinWithAuthKey(
  options: WorkletCredentialOptions,
  authKey: string,
  name: string,
  state: string,
): Promise<WorkletCredential> {
  const joined = await redeemAuthKey({
    controlPlane: options.controlPlane,
    authKey,
    name,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // An ephemeral host lives only as long as this process; it rejoins as a new host next time.
  if (!joined.ephemeral || options.storeEphemeral === true)
    await storeWorkerHostCredential(
      {
        workerHostId: joined.workerHostId,
        token: joined.token,
        controlPlane: options.controlPlane,
        ...(joined.ephemeral ? { ephemeral: true } : {}),
      },
      state,
    );
  return {
    workerHostId: joined.workerHostId,
    token: joined.token,
    source: "auth-key",
    tags: joined.tags,
    notice: joined.notice,
    ...(joined.ephemeral ? { ephemeral: true } : {}),
  };
}

async function enrollAsOperator(
  options: WorkletCredentialOptions,
  target: ControlPlaneTarget,
  name: string,
  exact: boolean,
  state: string,
): Promise<WorkletCredential> {
  const client = new ControlPlaneClient(target);
  for (let attempt = 1; attempt <= (exact ? 1 : MAX_OPERATOR_NAME_ATTEMPTS); attempt += 1) {
    const workerHostId = workerHostNameCandidate(name, attempt);
    let issuance: WorkerHostCredentialIssuance;
    try {
      issuance = await client.request<WorkerHostCredentialIssuance>("/api/v1/worker-hosts", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: CONTROL_PLANE_API_VERSION,
          kind: "WorkerHostEnrollment",
          metadata: { id: workerHostId },
          spec: {},
        }),
      });
    } catch (error) {
      if (error instanceof Error && /already enrolled/u.test(error.message)) {
        if (exact)
          throw new Error(
            `Worker Host ${workerHostId} is already enrolled, but its credential is not stored on this machine. Choose another --worker-host.`,
          );
        continue;
      }
      throw error;
    }
    if (
      issuance?.kind !== "WorkerHostCredential" ||
      issuance.metadata.workerHostId !== workerHostId ||
      !issuance.credential.token
    )
      throw new Error("Control Plane returned an invalid Worker Host credential");
    await storeWorkerHostCredential(
      { workerHostId, token: issuance.credential.token, controlPlane: options.controlPlane },
      state,
    );
    return {
      workerHostId,
      token: issuance.credential.token,
      source: "operator",
      notice: `Enrolled Worker Host ${workerHostId} with your operator credentials. Bind it to a Tag: supertag update tag TAG --add-worker-host ${workerHostId}`,
    };
  }
  throw new Error(`No free Worker Host ID near ${name}; choose one with --worker-host`);
}

/** Whether two management URLs name the same Control Plane; loopback names are equivalent. */
export function sameControlPlane(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const loopback = (host: string) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
    return (
      a.protocol === b.protocol &&
      a.port === b.port &&
      (a.hostname === b.hostname || (loopback(a.hostname) && loopback(b.hostname)))
    );
  } catch {
    return false;
  }
}

/**
 * The management URL derived from a Worklet URL: WebSocket schemes become HTTP(S) and the path is
 * dropped. A separate gRPC listener needs the management URL named explicitly.
 */
export function managementUrlFromWorkletUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("The Worklet URL must use http:, https:, ws:, or wss:");
  return url.origin;
}
