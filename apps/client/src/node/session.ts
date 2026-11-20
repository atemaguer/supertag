/**
 * One connection to a Gateway, holding its credential. The credential lives only here and in
 * the SDK client's request headers: never in what the window receives, settings, or logs.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Tag } from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type { GatewayRelease, Tag as WindowTag } from "../model/gateway";
import { tag } from "./convert";
import type { Target } from "./endpoint";
import { checkBearer, INCOMPATIBLE, rpc, rpcError, statusOf, UNREACHABLE } from "./errors";
import {
  Code,
  createGatewayClient,
  type GatewayClient,
  PrincipalRole,
  ProtocolMismatchError,
} from "./sdk";

/** Every unary call's deadline. */
export const TIMEOUT_MS = 15_000;
export const CALL = { timeoutMs: TIMEOUT_MS } as const;
/** The most pages one list reads. */
export const MAX_PAGES = 100;
/** Every Auth Key secret starts with this; every enrolled credential with `stcr_`. */
const AUTH_KEY_PREFIX = "stak_";
const CREDENTIAL_PREFIX = "stcr_";

/** True when the text is `prefix` and 64 lowercase hex digits. */
export function isSecret(prefix: string, value: string): boolean {
  return value.startsWith(prefix) && /^[0-9a-f]{64}$/u.test(value.slice(prefix.length));
}

export const isAuthKey = (value: string) => isSecret(AUTH_KEY_PREFIX, value);

/** A new secret: `prefix` and 64 lowercase hex digits. */
export function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

/** A Gateway's TLS beyond the system roots: a private certificate authority and a client identity. */
export interface Tls {
  readonly ca?: string | Buffer;
  readonly identity?: { readonly cert: string | Buffer; readonly key: string | Buffer };
}

/** What every session of this app connects with besides the URL and the credential. */
export interface SessionOptions {
  /** The release the app names while negotiating. */
  readonly buildVersion: string;
  /** A private certificate authority, for tests of `https://` and `wss://` Gateways. */
  readonly ca?: string | Buffer;
}

/** Why connecting failed, as the window shows it. */
export function connectError(error: unknown): string {
  if (error instanceof ProtocolMismatchError) {
    // Names both releases, where the Gateway runs, and which to upgrade.
    if (error.peerVersions !== undefined) {
      return error.rawMessage.replace(/^This client /u, "This app ");
    }
    return INCOMPATIBLE;
  }
  if (statusOf(error).code === Code.FailedPrecondition) return INCOMPATIBLE;
  return UNREACHABLE;
}

/** What a session knows of a Gateway it has not negotiated with yet. */
const UNNEGOTIATED: GatewayRelease = { build: "unknown", protocol: 0 };

export class Session {
  constructor(
    readonly client: GatewayClient,
    /** The Gateway's release, as it named itself while negotiating. */
    readonly release: GatewayRelease = UNNEGOTIATED,
  ) {}

  /** Connects and negotiates the protocol, which the Gateway requires before any call. */
  static async connect(
    target: Target,
    token: string,
    options: SessionOptions,
    tls: Tls = {},
  ): Promise<Session> {
    checkBearer(token);
    let client: GatewayClient;
    const ca = tls.ca ?? options.ca;
    try {
      client = createGatewayClient({
        url: target.url,
        token,
        buildVersion: options.buildVersion,
        ...(ca === undefined ? {} : { ca }),
        ...(tls.identity === undefined ? {} : { identity: tls.identity }),
      });
    } catch {
      throw UNREACHABLE;
    }
    let release: GatewayRelease;
    try {
      const agreed = await client.negotiation();
      release = { build: agreed.gatewayBuild, protocol: agreed.protocolVersion };
    } catch (error) {
      client.close();
      throw connectError(error);
    }
    return new Session(client, release);
  }

  close() {
    this.client.close();
  }

  /** Whom the Gateway resolves this session's credential to, such as `operator:local`. */
  async principal(): Promise<string> {
    const answer = await rpc(() => this.client.enrollments.whoAmI({}, CALL));
    return answer.principal;
  }

  /**
   * Joins this device as `client:NAME` with a client Auth Key, this session's bearer, and
   * returns its new enrolled credential. The key is presented once and never kept.
   */
  async enroll(name: string): Promise<string> {
    const credential = newSecret(CREDENTIAL_PREFIX);
    await rpc(
      () =>
        this.client.enrollments.enroll(
          {
            role: PrincipalRole.CLIENT,
            name,
            operationId: randomBytes(32).toString("hex"),
            tokenDigest: createHash("sha256").update(credential).digest(),
          },
          CALL,
        ),
      (error) => {
        const { code } = statusOf(error);
        return code === Code.PermissionDenied ||
          code === Code.FailedPrecondition ||
          code === Code.Unauthenticated
          ? "The Gateway refused this Auth Key. Ask an operator for a new client Auth Key."
          : rpcError(error);
      },
    );
    return credential;
  }

  /** Every Tag the caller sees, page by page, as protobuf messages. */
  async rawTags(failWhenTooLarge: boolean): Promise<Tag[]> {
    const tags: Tag[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await rpc(() =>
        this.client.operator.listTags({ limit: 100, cursor, includeRetired: false }, CALL),
      );
      tags.push(...listed.tags);
      if (listed.nextCursor === "") return tags;
      if (listed.nextCursor === cursor) break;
      cursor = listed.nextCursor;
    }
    if (failWhenTooLarge) {
      throw "The Tag list is too large to load. Use the CLI to narrow the view.";
    }
    return tags;
  }

  async tags(): Promise<WindowTag[]> {
    return (await this.rawTags(true)).map(tag);
  }
}
