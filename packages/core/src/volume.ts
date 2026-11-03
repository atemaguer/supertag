import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TagMessagingError } from "./mailbox.js";

/**
 * A Volume is a named storage location that Workspaces can attach data from: a bucket and
 * prefix in an S3-compatible object store, or a directory on the Worker Host. The Control Plane
 * stores only where the data is and the name of the credential that reaches it; each Worker Host
 * that serves the Volume maps that name to a secret of its own.
 */
export interface VolumeSpec {
  /** S3/R2, mount-only GCS or Modal Volume, or a file directory on the Worker Host. */
  readonly source: string;
  /**
   * The name of the credential that reaches the source, never its value. Worker Hosts map it
   * to a secret or provider-held reference. A modal-volume:// mapping consents to the exact
   * Modal Volume name; a file:// mapping consents to exposing its directory. All schemes
   * require the credential name at apply and resolution.
   */
  readonly credential?: string;
}

export interface Volume extends VolumeSpec {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApplyVolumeInput extends VolumeSpec {
  readonly name: string;
}

/**
 * A Volume as the Control Plane's catalog held it when it dispatched a Task Attempt: where the
 * data is and the credential's name, never its value. The Worker Host maps the name itself.
 * A file Volume without a credential is a protected location, not a mount permission. Dispatch
 * includes every file artifact Volume this way so the host can reject aliases on its filesystem.
 */
export interface TaskWorkspaceVolume extends VolumeSpec {
  readonly name: string;
}

/** File locations dispatched without mount consent, including every host's artifact Volumes. */
export function protectedVolumePaths(volumes: readonly TaskWorkspaceVolume[] = []): string[] {
  return volumes.flatMap((volume) => {
    if (volume.credential !== undefined) return [];
    const location = parseVolumeSource(volume.source);
    return location.scheme === "file" ? [location.path] : [];
  });
}

export interface VolumeStore {
  /** Creates or replaces the named Volume; an absent credential is cleared. */
  applyVolume(
    input: ApplyVolumeInput,
  ): Promise<{ readonly volume: Volume; readonly created: boolean }>;
  /** The Volume with this name, which is how Workspace mounts refer to it. */
  findVolumeByName(name: string): Promise<Volume | undefined>;
  /** Every Volume, ordered by name. */
  listVolumes(): Promise<readonly Volume[]>;
  /** Recorded artifact copies from hosts still enrolled, including disconnected hosts. */
  countVolumeArtifactCopies(volumeId: string): Promise<number>;
  /** Deletes the named Volume. Returns false when no such Volume exists. */
  deleteVolume(name: string): Promise<boolean>;
}

/** Explains the retention guard and how an operator can retire its holders. */
export function volumeArtifactCopyRefusal(total: number): string | undefined {
  return total > 0
    ? `${total} artifact copies are recorded on it. Keep this Volume and its source available for existing artifacts; create a new Volume for future artifacts. To retire these copies, revoke their Worker Host credentials with supertag revoke worker-host-credential HOST before deleting or changing this Volume`
    : undefined;
}

/** Where a Volume's data lives, parsed from its `source`. */
export type VolumeLocation =
  | {
      /** `s3` for Amazon S3 and other S3-compatible stores; `r2` for Cloudflare R2. */
      readonly scheme: "s3" | "r2";
      readonly bucket: string;
      /** Key prefix without a leading slash; empty for the whole bucket. */
      readonly prefix: string;
      /** Default: us-east-1 for S3, auto for R2. */
      readonly region?: string;
      /** HTTPS endpoint; required for R2. */
      readonly endpoint?: string;
      readonly forcePathStyle?: boolean;
    }
  | { readonly scheme: "gs"; readonly bucket: string; readonly prefix: string }
  | {
      readonly scheme: "modal-volume";
      readonly name: string;
      readonly prefix: string;
    }
  | {
      readonly scheme: "file";
      /** Absolute, normalized directory path on the Worker Host. */
      readonly path: string;
    };

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
/** S3 and R2 bucket names: 3-63 lowercase letters, digits, dots, and hyphens. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const MAX_SOURCE_LENGTH = 1024;
/** Printable characters allowed in an object key prefix or a file path. */
const PATH_CHARACTERS = /^[A-Za-z0-9._~!$&'()*+,;=:@%/ -]*$/u;

/** Volume names appear in Workspace mounts and host config, so they stay small and plain. */
export function parseVolumeName(value: unknown, field = "Volume name"): string {
  if (typeof value !== "string" || !NAME.test(value))
    throw new TagMessagingError(
      400,
      `${field} must be 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit`,
    );
  return value;
}

/** Validates a Volume's `source` and `credential`. */
export function parseVolumeSpec(value: unknown): VolumeSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TagMessagingError(400, "Volume spec must be an object");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !["source", "credential"].includes(key));
  if (unknown.length > 0)
    throw new TagMessagingError(400, `Volume spec contains unknown fields: ${unknown.join(", ")}`);
  const source = record["source"];
  if (typeof source !== "string")
    throw new TagMessagingError(400, "Volume spec.source is required");
  const location = parseVolumeSource(source);
  const credential = record["credential"] ?? undefined;
  if (credential === undefined)
    throw new TagMessagingError(
      400,
      location.scheme === "file"
        ? "Volume spec.credential is required for a file:// source: name the credential each Worker Host maps to opt in to exposing the directory"
        : `Volume spec.credential is required for a ${location.scheme}:// source: name the credential each Worker Host maps to a secret or provider-held reference`,
    );
  return { source, credential: parseVolumeCredentialName(credential) };
}

/**
 * Parses a Volume source. Object-store sources name a bucket and an optional key prefix; file
 * sources name an absolute directory on the Worker Host. Object-store queries carry only
 * region, endpoint, and forcePathStyle. Credentials and fragments are refused.
 */
export function parseVolumeSource(value: unknown, field = "Volume spec.source"): VolumeLocation {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE_LENGTH)
    throw new TagMessagingError(
      400,
      `${field} must be a URL of at most ${MAX_SOURCE_LENGTH} characters`,
    );
  let decodedSource: string;
  try {
    decodedSource = decodeURIComponent(value);
  } catch {
    throw new TagMessagingError(400, `${field} must use valid percent encoding`);
  }
  if (containsSecretValue(decodedSource))
    throw new TagMessagingError(
      400,
      `${field} looks like a secret value; keep secrets in the host credential mapping`,
    );
  const match = /^([a-z0-9-]+):\/\/([\s\S]*)$/u.exec(value);
  const scheme = match?.[1];
  const raw = match?.[2] ?? "";
  const question = raw.indexOf("?");
  const rest = question === -1 ? raw : raw.slice(0, question);
  if (
    scheme !== "s3" &&
    scheme !== "r2" &&
    scheme !== "file" &&
    scheme !== "gs" &&
    scheme !== "modal-volume"
  )
    throw new TagMessagingError(
      400,
      `${field} must start with s3://, r2://, gs://, modal-volume://, or file://`,
    );
  if (
    raw.includes("#") ||
    hasWhitespaceOrControl(raw.slice(question === -1 ? raw.length : question)) ||
    !PATH_CHARACTERS.test(rest)
  )
    throw new TagMessagingError(
      400,
      `${field} must not contain a fragment, control characters, or invalid path characters`,
    );
  if (scheme === "file") {
    if (question !== -1)
      throw new TagMessagingError(400, `${field} file:// sources must not contain a query string`);
    if (!rest.startsWith("/"))
      throw new TagMessagingError(
        400,
        `${field} must be file:///ABSOLUTE/PATH, a directory on the Worker Host`,
      );
    return { scheme, path: normalizedPath(rest, field) };
  }
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  if (
    !(scheme === "modal-volume" ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u : BUCKET).test(bucket) ||
    bucket.includes("..")
  )
    throw new TagMessagingError(
      400,
      scheme === "modal-volume"
        ? `${field} must name a Modal Volume with 1-64 letters, digits, underscores, dots, or hyphens, starting with a letter or digit, without ..`
        : `${field} must be ${scheme}://BUCKET/PREFIX with a bucket of 3-63 lowercase letters, digits, dots, or hyphens, and no credentials`,
    );
  const prefix = slash === -1 ? "" : rest.slice(slash + 1);
  if (prefix.startsWith("/") || prefix.split("/").some((part) => part === "." || part === ".."))
    throw new TagMessagingError(
      400,
      `${field} prefix must not start with a slash or contain . or .. segments`,
    );
  if (scheme === "gs" || scheme === "modal-volume") {
    const decoded = decodeURIComponent(prefix);
    if (
      decoded.startsWith("/") ||
      decoded.split("/").some((part) => part === "." || part === "..") ||
      /[\p{Cc}\p{Cf}\\]/u.test(decoded)
    )
      throw new TagMessagingError(400, `${field} has an invalid native mount prefix`);
    if (scheme === "gs") {
      if (question !== -1)
        throw new TagMessagingError(400, `${field} gs:// sources take no query parameters`);
      return { scheme, bucket, prefix };
    }
    if (question !== -1)
      throw new TagMessagingError(400, `${field} modal-volume:// sources take no query parameters`);
    return { scheme, name: bucket, prefix };
  }
  const settings = parseObjectStoreSettings(question === -1 ? "" : raw.slice(question + 1), field);
  if (scheme === "r2" && settings.endpoint === undefined)
    throw new TagMessagingError(
      400,
      `${field} r2:// sources need an account endpoint query parameter`,
    );
  return { scheme, bucket, prefix, ...settings };
}

function hasWhitespaceOrControl(value: string): boolean {
  return /[\s\p{Cc}\p{Cf}]/u.test(value);
}

function parseObjectStoreSettings(
  query: string,
  field: string,
): {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
} {
  const refuse = (reason: string) => new TagMessagingError(400, `${field} ${reason}`);
  try {
    if (hasWhitespaceOrControl(decodeURIComponent(query)))
      throw refuse("query string must not contain whitespace, control, or format characters");
  } catch {
    throw refuse("query string must use valid percent encoding");
  }
  const parameters = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const key of parameters.keys()) {
    if (!["region", "endpoint", "forcePathStyle"].includes(key))
      throw refuse("query string takes only region, endpoint, and forcePathStyle");
    if (seen.has(key)) throw refuse(`query parameter ${key} must occur only once`);
    seen.add(key);
  }
  const region = parameters.get("region");
  if (region !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(region))
    throw refuse(
      "region must contain lowercase letters, digits, and single hyphens between groups",
    );
  const endpoint = parameters.get("endpoint");
  if (endpoint !== null) {
    let url: URL;
    let decodedEndpoint: string;
    try {
      url = new URL(endpoint);
      decodedEndpoint = decodeURIComponent(endpoint);
    } catch {
      throw refuse("endpoint must be an https URL");
    }
    if (
      !/^https:\/\//u.test(endpoint) ||
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      endpoint.includes("?") ||
      endpoint.includes("#") ||
      hasWhitespaceOrControl(decodedEndpoint) ||
      endpoint.includes("\\") ||
      /%(?![a-f0-9]{2})/iu.test(endpoint)
    )
      throw refuse(
        "endpoint must be an https URL without credentials, a query, a fragment, or control characters (including on loopback)",
      );
    if (containsSecretValue(decodedEndpoint))
      throw refuse(
        "endpoint looks like a secret value; keep secrets in the host credential mapping",
      );
    if (isUnsafeEndpointAddress(url.hostname))
      throw refuse("endpoint must not use a link-local or metadata address");
  }
  const pathStyle = parameters.get("forcePathStyle");
  if (pathStyle !== null && pathStyle !== "true" && pathStyle !== "false")
    throw refuse("forcePathStyle must be true or false");
  return {
    ...(region === null ? {} : { region }),
    ...(endpoint === null ? {} : { endpoint }),
    ...(pathStyle === null ? {} : { forcePathStyle: pathStyle === "true" }),
  };
}

/** Inspect the canonical literal host from URL, without making a DNS safety promise. */
function isUnsafeEndpointAddress(host: string): boolean {
  const unsafeIpv4 = (high: number, low: number) =>
    high === 0xa9fe ||
    (high === 0x6464 && low === 0x64c8) ||
    (high === 0xc000 && low === 0x00c0) ||
    (high === 0xa83f && low === 0x8110);
  if (!host.startsWith("[")) {
    const bytes = host.split(".").map(Number);
    return (
      bytes.length === 4 &&
      unsafeIpv4((bytes[0] ?? 0) * 256 + (bytes[1] ?? 0), (bytes[2] ?? 0) * 256 + (bytes[3] ?? 0))
    );
  }
  // WHATWG URL has already validated IPv6 and converted dotted tails to hexadecimal.
  const [left = "", right] = host.slice(1, -1).split("::");
  const words = (part: string) =>
    part ? part.split(":").map((word) => Number.parseInt(word, 16)) : [];
  const head = words(left);
  const tail = words(right ?? "");
  const address =
    right === undefined
      ? head
      : [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  if (
    ((address[0] ?? 0) & 0xffc0) === 0xfe80 ||
    ["[fd00:ec2::254]", "[fd00:ec2::23]", "[fd20:ce::254]"].includes(host)
  )
    return true;
  // RFC 8215 local-use NAT64 embeds IPv4 at deployment-specific offsets. Refuse the
  // whole reserved /48 rather than guessing which RFC 6052 prefix length a host uses.
  if (address[0] === 0x64 && address[1] === 0xff9b && address[2] === 1) return true;
  const prefix = address.slice(0, 6).join(":");
  const embedsIpv4 = [
    "0:0:0:0:0:0", // IPv4-compatible ::/96
    "0:0:0:0:0:65535", // IPv4-mapped ::ffff:0:0/96
    "0:0:0:0:65535:0", // IPv4-translated ::ffff:0:0:0/96
    "100:65435:0:0:0:0", // RFC 6052 well-known NAT64 64:ff9b::/96
  ].includes(prefix);
  return embedsIpv4 && unsafeIpv4(address[6] ?? 0, address[7] ?? 0);
}

function normalizedPath(path: string, field: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === ".."))
    throw new TagMessagingError(400, `${field} path must not contain . or .. segments`);
  return `/${parts.join("/")}`;
}

/**
 * Validates a credential name. A Volume names its credential; the value stays on each Worker
 * Host. Anything shaped like a secret value, such as an access key ID or a long random token, is
 * refused so it is never stored in the Control Plane.
 */
export function parseVolumeCredentialName(
  value: unknown,
  field = "Volume spec.credential",
): string {
  if (typeof value !== "string" || !NAME.test(value))
    throw new TagMessagingError(
      400,
      `${field} must be a credential name of 1-63 lowercase letters, digits, hyphens, or underscores, never a secret value`,
    );
  if (looksLikeSecretValue(value))
    throw new TagMessagingError(
      400,
      `${field} looks like a secret value; name the credential instead, and map that name to the secret on each Worker Host`,
    );
  return value;
}

/** Prefixes of common access keys and tokens, lowercased. */
const SECRET_PREFIXES = [
  "akia",
  "asia",
  "sk-",
  "sk_",
  "ghp_",
  "gho_",
  "ghs_",
  "github_pat_",
  "xox",
  "glpat-",
];

/** A path fragment that reads as a word, such as `Singapore`, `training-data`, or `Run1`. */
function wordLike(fragment: string): boolean {
  const pieces = fragment.split(/[-_]/u).filter(Boolean);
  return pieces.length > 0 && pieces.every((piece) => /^[A-Z]?[a-z]{1,12}[0-9]{0,2}$/u.test(piece));
}

/** Keep word boundaries when a prefixed path contains several ordinary words. */
function payloadWord(fragment: string): boolean {
  if (!wordLike(fragment)) return false;
  return fragment
    .split(/[-_]/u)
    .filter(Boolean)
    .every((piece) => {
      const letters = piece.replace(/[0-9]/gu, "");
      const vowels = letters.match(/[aeiouy]/giu)?.length ?? 0;
      // Short splits and consonant-heavy lowercase token fragments are not
      // ordinary words, even though wordLike accepts their character casing.
      return (
        letters.length >= 3 &&
        vowels * 4 >= letters.length &&
        !/[b-df-hj-np-tv-xz]{4}/iu.test(letters)
      );
    });
}

const PROVIDER_SECRET_PREFIX =
  /^sk(?:-(?:ant-api03|svcacct|or-v1|proj|ant|live)-?|_(?:live|test)_?)/u;

/** Strip the complete provider prefix before judging the payload, including lowercase keys. */
function secretPayload(value: string): string | undefined {
  const prefix =
    PROVIDER_SECRET_PREFIX.exec(value)?.[0] ??
    SECRET_PREFIXES.find((candidate) => value.startsWith(candidate));
  return prefix === undefined ? undefined : value.slice(prefix.length);
}

function containsSecretValue(value: string): boolean {
  for (const run of value.split(/[^a-z0-9_/~+.,-]+/iu)) {
    const parts = run.split(/[/~+.,]/u);
    if (parts.some((part) => looksLikeSecretValue(part.toLowerCase()))) return true;
    for (let start = 0; start < parts.length; start++) {
      let joined = "";
      let tokenFragments = true;
      let wordFragments = true;
      for (const [index, part] of parts.slice(start).entries()) {
        joined += part;
        // Unprefixed fragments must each resemble random text. Ordinary words and
        // numeric date segments must not turn into a key merely by concatenation.
        tokenFragments &&=
          (index === 0 || !wordLike(part)) &&
          [/\p{Ll}/u, /\p{Lu}/u, /[0-9]/u].filter((pattern) => pattern.test(part)).length >= 2;
        if (index === 0) {
          const firstPayload = secretPayload(part.toLowerCase());
          wordFragments =
            firstPayload !== undefined &&
            (firstPayload === "" || payloadWord(part.slice(part.length - firstPayload.length)));
          continue;
        }
        if (part !== "") {
          // Ordinary word paths may end in date or version segments. Only exempt
          // the suffix; earlier short or random fragments must still fail.
          const dateOrVersionSuffix = parts
            .slice(start + index)
            .every((segment) => segment === "" || /^(?:[0-9]{1,4}|v[0-9]{1,3})$/u.test(segment));
          wordFragments &&= payloadWord(part) || dateOrVersionSuffix;
        }
        const lower = joined.toLowerCase();
        const payload = secretPayload(lower);
        // Do not count provider names or dates as key material. A key payload can
        // consist entirely of lowercase letters or be split into single letters.
        if (
          payload !== undefined &&
          !wordFragments &&
          lower.length >= 16 &&
          /[a-z]/u.test(payload) &&
          (!wordLike(payload) ||
            (PROVIDER_SECRET_PREFIX.test(lower) && /^[a-z0-9]{12,}$/u.test(payload))) &&
          // Asia is also a place name. Preserve a place followed by date segments,
          // without exempting arbitrary digit-heavy AWS key payloads.
          !(
            parts[start]?.toLowerCase() === "asia" &&
            /^[A-Z]?[a-z]{2,12}[/][12][0-9]{3}(?:[/][0-9]{1,2})*[/]?$/u.test(
              parts.slice(start + 1, start + index + 1).join("/"),
            )
          )
        )
          return true;
        if (tokenFragments && looksLikeSecretValue(lower)) return true;
      }
    }
  }
  return false;
}

function looksLikeSecretValue(value: string): boolean {
  if (value.length >= 16 && SECRET_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;
  // A long run of letters mixed with digits reads as a random key, not a word.
  return value
    .split(/[-_]/u)
    .some((part) => part.length >= 20 && /[a-z]/u.test(part) && /[0-9]/u.test(part));
}

/** A possible S3 request base, with the bucket folded into the host or path. */
interface ObjectStoreRequestBase {
  readonly origin: string;
  readonly segments: readonly string[];
}

/**
 * Locations used to compare stored data, independent of URL spelling. S3-compatible providers
 * can use path-style or virtual-hosted addressing, so both possible request bases are protected.
 * File paths use existing real ancestors and conservative case folding.
 */
export type NormalizedVolumeLocation =
  | { readonly kind: "object-store"; readonly requestBases: readonly ObjectStoreRequestBase[] }
  | { readonly kind: "file"; readonly segments: readonly string[] };

/** Normalizes a parsed Volume location for comparison; see {@link NormalizedVolumeLocation}. */
export function normalizeVolumeLocation(location: VolumeLocation): NormalizedVolumeLocation {
  const segments = (value: string) => {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // parseVolumeSource refuses invalid percent-encoding; keep the text as written.
    }
    return decoded.split("/").filter((part) => part !== "");
  };
  if (location.scheme === "file")
    return { kind: "file", segments: segments(existingRealPath(location.path).toLowerCase()) };
  const prefix = segments(location.prefix);
  if (location.scheme === "gs")
    return {
      kind: "object-store",
      requestBases: [{ origin: "gcs", segments: [location.bucket, ...prefix] }],
    };
  if (location.scheme === "modal-volume")
    // Environments are host configuration, so catalog comparisons protect aliases across hosts.
    return {
      kind: "object-store",
      requestBases: [{ origin: "modal-volume", segments: [location.name, ...prefix] }],
    };
  if (location.endpoint === undefined)
    return {
      kind: "object-store",
      requestBases: [{ origin: "aws", segments: [location.bucket, ...prefix] }],
    };
  const endpoint = new URL(location.endpoint);
  const host = endpoint.hostname.toLowerCase().replace(/\.$/u, "");
  const port = endpoint.port || (endpoint.protocol === "http:" ? "80" : "443");
  const path = segments(endpoint.pathname);
  // Protect either addressing mode regardless of forcePathStyle. Providers and S3-compatible
  // servers can interpret a bucket already in the endpoint differently. A setting must never
  // remove the protection for an otherwise reachable artifact location.
  return {
    kind: "object-store",
    requestBases: [
      objectStoreRequestBase(host, port, [...path, location.bucket, ...prefix]),
      objectStoreRequestBase(`${location.bucket}.${host}`, port, [...path, ...prefix]),
    ],
  };
}

/** Resolve existing ancestors too, so an as-yet unwritten artifact directory stays protected. */
function existingRealPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(realpathSync.native(current), ...missing.toReversed());
    } catch {
      const parent = dirname(current);
      // A remote host's path need not exist on the Control Plane. The host checks it again.
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function objectStoreRequestBase(
  host: string,
  port: string,
  segments: readonly string[],
): ObjectStoreRequestBase {
  if (/(?:^|\.)amazonaws\.com(?:\.cn)?$/u.test(host)) {
    // Fold an AWS virtual-hosted bucket into the path before ignoring region and endpoint
    // spelling. Unknown AWS endpoint forms cannot prove separation from an artifact bucket.
    const service =
      /^(?:(.+)\.)?s3(?:(?:[.-]|\.dualstack\.)[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+|-accelerate(?:\.dualstack)?|-external-1)?\.amazonaws\.com(?:\.cn)?$/u.exec(
        host,
      );
    return {
      origin: "aws",
      segments: service === null ? [] : service[1] ? [service[1], ...segments] : segments,
    };
  }
  if (host === "storage.cloud.google.com") return { origin: "gcs", segments };
  if (/(?:^|\.)googleapis\.com$/u.test(host) || host.endsWith(".storage.cloud.google.com")) {
    // GCS buckets are global across the XML API, regional, and virtual-hosted endpoints.
    // Unknown Google hosts cannot prove separation from a protected GCS bucket.
    const service =
      /^(?:(.+)\.)?(?:(?:commondatastorage|storage(?:\.[a-z]+(?:-[a-z0-9]+)+[0-9]\.rep)?)\.googleapis\.com|storage\.cloud\.google\.com)$/u.exec(
        host,
      );
    return {
      origin: "gcs",
      segments: service === null ? [] : service[1] ? [service[1], ...segments] : segments,
    };
  }
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "[::]" ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(host) ||
    host === "[::1]" ||
    /^\[::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|127(?:\.[0-9]{1,3}){3})\]$/u.test(host);
  return { origin: `${loopback ? "loopback" : host}:${port}`, segments };
}

/** Whether one segment list equals the other or lies beneath it. */
export function segmentsNested(first: readonly string[], second: readonly string[]): boolean {
  const [shorter, longer] = first.length <= second.length ? [first, second] : [second, first];
  return shorter.every((segment, index) => longer[index] === segment);
}

/**
 * Whether two Volume locations could reach the same data: one is the other or contains it.
 * Used to keep Workspaces from mounting a Volume that holds artifacts, where an overlap that
 * cannot be ruled out counts as an overlap.
 */
export function volumeLocationsOverlap(first: VolumeLocation, second: VolumeLocation): boolean {
  const a = normalizeVolumeLocation(first);
  const b = normalizeVolumeLocation(second);
  if (a.kind === "file" || b.kind === "file")
    return a.kind === "file" && b.kind === "file" && segmentsNested(a.segments, b.segments);
  return a.requestBases.some((left) =>
    b.requestBases.some(
      (right) => left.origin === right.origin && segmentsNested(left.segments, right.segments),
    ),
  );
}

/** The immutable Volume key for one producing Task Attempt and file digest. */
export function artifactVolumeKey(attemptId: string, digest: string): string {
  if (typeof attemptId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,511}$/u.test(attemptId))
    throw new TagMessagingError(400, "Invalid artifact Task Attempt id");
  const hex = /^sha256:([a-f0-9]{64})$/u.exec(digest)?.[1];
  if (hex === undefined) throw new TagMessagingError(400, "Artifact digest must be sha256:HEX");
  return `attempts/${attemptId}/sha256/${hex}`;
}

/** Validate a catalog key and return its producing Task Attempt's directory. */
export function artifactVolumeKeyDirectory(key: string, digest: string): string {
  const match = /^attempts\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,511})\/sha256\/([a-f0-9]{64})$/u.exec(
    key,
  );
  if (match === null || `sha256:${match[2]}` !== digest)
    throw new TagMessagingError(400, "Artifact Volume copy key does not name this file's content");
  return `attempts/${match[1]}`;
}

/** Provider-held references only; never secret values or sandbox environment variables. */
export type ModalVolumeCredential =
  | { readonly "modal-secret": string }
  | { readonly "modal-oidc-role": string }
  | { readonly "modal-volume": string };

/** Validate and project a host reference, without retaining unknown properties. */
export function parseModalVolumeCredential(value: unknown): ModalVolumeCredential {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    throw new Error(
      "Native mounts require one provider-held Modal Secret name, OIDC role, or modal-volume consent",
    );
  const record = value as Record<string, unknown>;
  const volume = record["modal-volume"];
  if (
    typeof volume === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(volume) &&
    !volume.includes("..")
  )
    return { "modal-volume": volume };
  const secret = record["modal-secret"];
  if (
    typeof secret === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(secret) &&
    !looksLikeSecretValue(secret.toLowerCase())
  )
    return { "modal-secret": secret };
  const role = record["modal-oidc-role"];
  if (
    typeof role === "string" &&
    /^arn:aws(?:-us-gov|-cn)?:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]+$/u.test(role)
  )
    return { "modal-oidc-role": role };
  throw new Error(
    "Native mounts require a provider-held Modal Secret name, IAM role ARN, or modal-volume consent",
  );
}
