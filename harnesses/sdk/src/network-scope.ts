/**
 * A Task's network scope, as the Control Plane composed it from its Permission Sets' `web:fetch`
 * grants. The semantics match `supertag_protocol::network_scope`: a request is allowed when
 * `anyOrigin` is set or a rule matches its origin, method, and path. A rule origin
 * `https://*.example.com` names every subdomain of `example.com`, at any depth, but not
 * `example.com` itself. A path prefix matches at a `/` boundary.
 */
export interface NetworkRuleLike {
  readonly origins: readonly string[];
  readonly methods: readonly string[];
  readonly credential: string;
  readonly paths: readonly string[];
}

export interface NetworkScopeLike {
  readonly anyOrigin: boolean;
  readonly rules: readonly NetworkRuleLike[];
}

interface TaskLike {
  readonly allowedActions: readonly string[];
  readonly policySnapshot?:
    | {
        readonly runtimeAuthority?: { readonly network?: NetworkScopeLike | undefined } | undefined;
      }
    | undefined;
}

/** The accepted Task's network scope, or `undefined` when it has none or lacks `web:fetch`. */
export function networkScopeOf(task: TaskLike): NetworkScopeLike | undefined {
  if (!task.allowedActions.includes("web:fetch")) return undefined;
  const scope = task.policySnapshot?.runtimeAuthority?.network;
  return scope && scope.rules.length > 0 ? scope : undefined;
}

/** Credential names the scope binds. */
export function networkCredentials(scope: NetworkScopeLike): string[] {
  return [...new Set(scope.rules.map((rule) => rule.credential).filter(Boolean))].sort();
}

/** Host names, without ports, of a scope that limits origins: `api.github.com`, `*.example.com`. */
export function networkHostNames(scope: NetworkScopeLike): string[] {
  const names = new Set<string>();
  for (const rule of scope.rules)
    for (const origin of rule.origins) {
      const rest = origin.replace(/^https:\/\//u, "");
      const colon = rest.lastIndexOf(":");
      names.add(colon === -1 ? rest : rest.slice(0, colon));
    }
  return [...names].sort();
}

/** Whether a request path can be compared with path prefixes. */
export function canonicalRequestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    !path.includes("\\") &&
    !["%2e", "%2f", "%5c", "%00"].some((encoded) => lower.includes(encoded)) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function pathMatches(prefix: string, path: string): boolean {
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}

function originMatches(origin: string, host: string, port: number): boolean {
  const rest = origin.replace(/^https:\/\//u, "");
  const colon = rest.lastIndexOf(":");
  const name = colon === -1 ? rest : rest.slice(0, colon);
  const number = colon === -1 ? 443 : Number(rest.slice(colon + 1));
  if (number !== port) return false;
  const lowered = host.toLowerCase();
  if (name.startsWith("*.")) {
    const parent = name.slice(2);
    return lowered.length > parent.length + 1 && lowered.endsWith(`.${parent}`);
  }
  return name === lowered;
}

/** The scope's rules, matched as the egress proxy matches them. */
export class NetworkRules {
  constructor(private readonly scope: NetworkScopeLike) {}

  /** Whether a request with `method` to `url` is allowed. */
  allows(method: string, url: URL): boolean {
    if (this.scope.anyOrigin) return true;
    if (url.protocol !== "https:") return false;
    const port = url.port === "" ? 443 : Number(url.port);
    const path = url.pathname;
    return this.scope.rules.some(
      (rule) =>
        (rule.origins.length === 0 ||
          rule.origins.some((origin) => originMatches(origin, url.hostname, port))) &&
        (rule.methods.length === 0 || rule.methods.includes(method.toUpperCase())) &&
        (rule.paths.length === 0 ||
          (canonicalRequestPath(path) && rule.paths.some((prefix) => pathMatches(prefix, path)))),
    );
  }
}
