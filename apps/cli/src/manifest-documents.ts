import { parseSurfaceAccountManifest } from "./surface-account-manifest.js";

/**
 * Manifest documents as an input declares them: their shape, kind and name, the order they apply
 * in, and that the input defines each resource once. The CLI checks these before it reads any
 * secret; the Control Plane checks them again before it plans or applies anything.
 */

/** The most one manifest input, sent to the Control Plane as one request, may be. */
export const MANIFEST_INPUT_MAX_BYTES = 16_000_000;

/** A parsed manifest: `apiVersion`, `kind`, `metadata` and `spec`. */
export interface ManifestResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly spec?: unknown;
}

/** The paths of the kinds a manifest declares, in the order they apply. */
export type ManifestDocumentPath =
  | "surface-accounts"
  | "volumes"
  | "workspaces"
  | "context-sets"
  | "permission-sets"
  | "roles"
  | "tags"
  | "objectives";

/** One manifest of an input, with where it came from. */
export interface ManifestDocument {
  /** Names the document in messages, such as `tags.yaml document 2`. */
  readonly source: string;
  readonly resource: ManifestResource;
  readonly name: string;
  readonly path: ManifestDocumentPath;
  /** Its position among the input's valid documents. */
  readonly index: number;
  /** Its position among all the input's entries. */
  readonly entry: number;
}

/**
 * Referenced resources may follow their referrers in an input; they apply first. Surface
 * Accounts come first because Tag locations and Permission Sets name them.
 */
export const APPLY_ORDER: Readonly<Record<ManifestDocumentPath, number>> = {
  "surface-accounts": 0,
  volumes: 1,
  workspaces: 2,
  "context-sets": 3,
  "permission-sets": 4,
  roles: 5,
  tags: 6,
  objectives: 7,
};

/** Every resource kind a manifest may name, and the path of those that can be applied. */
const MANIFEST_KINDS: Readonly<Record<string, ManifestDocumentPath | "observed">> = {
  Tag: "tags",
  PermissionSet: "permission-sets",
  ContextSet: "context-sets",
  Role: "roles",
  SurfaceAccount: "surface-accounts",
  WorkerHost: "observed",
  WorkerProfile: "observed",
  Task: "observed",
  Session: "observed",
  Volume: "volumes",
  Workspace: "workspaces",
  AuthKey: "observed",
  OperatorToken: "observed",
  Objective: "objectives",
};

/** The documents of an input that are valid, and one line per problem with the others. */
export interface ManifestDocuments {
  readonly documents: readonly ManifestDocument[];
  readonly errors: readonly string[];
  /** The entry each error is about, by the error's index; undefined for a parse error. */
  readonly errorEntries: readonly (number | undefined)[];
}

/**
 * Checks each entry's shape and kind, and that the input defines each resource once. `errors`
 * starts with problems found earlier, such as YAML parse errors, which name no entry.
 */
export function manifestDocuments(
  entries: readonly { readonly source: string; readonly value: unknown }[],
  errors: readonly string[] = [],
): ManifestDocuments {
  const documents: ManifestDocument[] = [];
  const entryOf = new Map<ManifestDocument, number>();
  const problems = [...errors];
  const problemEntries: (number | undefined)[] = errors.map(() => undefined);
  entries.forEach(({ source, value }, entry) => {
    try {
      const resource = parseManifest(value);
      const path = MANIFEST_KINDS[resource.kind];
      if (path === undefined) throw new Error(`Unknown manifest kind: ${resource.kind}`);
      if (path === "observed") throw new Error(`${resource.kind} is observed state`);
      // Literal secrets and malformed references fail here, before any secret is read.
      if (path === "surface-accounts") parseSurfaceAccountManifest(resource);
      const document = {
        source,
        resource,
        name: requiredName(resource),
        path,
        index: documents.length,
        entry,
      };
      documents.push(document);
      entryOf.set(document, entry);
    } catch (error) {
      problems.push(`${source}: ${messageOf(error)}`);
      problemEntries.push(entry);
    }
  });
  const seen = new Map<string, ManifestDocument>();
  for (const document of documents) {
    const key = `${document.path}/${document.name}`;
    const prior = seen.get(key);
    if (prior) {
      problems.push(
        `${document.source}: ${label(document)} is also defined in ${prior.source}; define each resource once`,
      );
      problemEntries.push(entryOf.get(document));
    } else seen.set(key, document);
  }
  return { documents, errors: problems, errorEntries: problemEntries };
}

/** Referenced kinds first; within a kind, input order. */
export function orderForApply<Document extends Pick<ManifestDocument, "path" | "index">>(
  documents: readonly Document[],
): readonly Document[] {
  return documents.toSorted(
    (left, right) => APPLY_ORDER[left.path] - APPLY_ORDER[right.path] || left.index - right.index,
  );
}

/** `KIND/NAME`, as apply output names a document. */
export function label(document: Pick<ManifestDocument, "resource" | "name">): string {
  return `${document.resource.kind}/${document.name}`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseManifest(value: unknown): ManifestResource {
  if (
    !isRecord(value) ||
    typeof value["kind"] !== "string" ||
    typeof value["apiVersion"] !== "string" ||
    !isRecord(value["metadata"])
  ) {
    throw new Error("Manifest requires apiVersion, kind, and metadata");
  }
  requiredName(value as unknown as ManifestResource);
  return value as unknown as ManifestResource;
}

function requiredName(resource: ManifestResource): string {
  const name = resource.metadata["name"];
  if (typeof name !== "string" || name.trim() === "")
    throw new Error(`${resource.kind} metadata.name is required`);
  return name.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
