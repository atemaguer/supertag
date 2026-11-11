/**
 * A host service's `environment`: the remote sandbox provider its Workers run Task Attempts in,
 * and that provider's settings. Absent means the local process environment.
 *
 * ```yaml
 * environment: e2b
 * environment: { e2b: { image: my-template } }
 * environment: { modal: { app: supertag-workers, image: node:22-bookworm } }
 * ```
 *
 * Settings name things, never credentials: providers authenticate through their own variables
 * (`E2B_API_KEY`; `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or `~/.modal.toml`), read from the
 * process environment or env_file and kept in the Worker Host process.
 */
import type { ExecutionEnvironmentProvider, WorkspaceEnvironment } from "@supertag/worker-sdk";

export const HOST_ENVIRONMENT_PROVIDERS = ["e2b", "modal"] as const;
export type HostEnvironmentProvider = (typeof HOST_ENVIRONMENT_PROVIDERS)[number];

export type HostEnvironment =
  | {
      readonly provider: "e2b";
      /** The E2B template sandboxes start from, when the repository has no devcontainer. */
      readonly image?: string;
    }
  | {
      readonly provider: "modal";
      /** The Modal app that owns the sandboxes and images. */
      readonly app: string;
      /** A registry image or Modal image ID for repositories without a devcontainer. */
      readonly image?: string;
    };

const SETTINGS: Readonly<Record<HostEnvironmentProvider, readonly string[]>> = {
  e2b: ["image"],
  modal: ["app", "image"],
};

/** An image or template reference: registry characters only, no whitespace. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;
/** The one `@` an image reference may hold: a content digest, such as `@sha256:4f1c…`. */
const IMAGE_DIGEST = /@[a-z0-9]+:[0-9a-f]{32,}$/u;

/**
 * Whether a value names an image without carrying a credential: no scheme, and no `@` except a
 * trailing content digest, so `https://user:pass@registry/x` and `user:pass@registry/x` fail.
 */
function isImageReference(value: string): boolean {
  if (!IMAGE.test(value) || value.includes("://")) return false;
  const at = value.indexOf("@");
  return at === -1 || (value.lastIndexOf("@") === at && IMAGE_DIGEST.test(value.slice(at)));
}
/** A Modal app name: letters, digits, `.`, `_`, and `-`, up to 64 characters. */
const MODAL_APP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const SHAPE =
  "must be e2b, { e2b: { image: TEMPLATE } }, or { modal: { app: NAME, image: IMAGE } }";

/**
 * Reads a host service's `environment`. Reports each problem through `problem` with the key path
 * below `environment`, and returns undefined when the value is absent or invalid.
 */
export function parseHostEnvironment(
  value: unknown,
  problem: (path: readonly string[], message: string) => void,
): HostEnvironment | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const name = value.trim();
    if (name === "e2b") return { provider: "e2b" };
    if (name === "modal") problem([], "modal needs its app: { modal: { app: NAME } }");
    else if (name === "local")
      problem([], "local is the default; remove environment to run Task Attempts on this machine");
    else problem([], `${SHAPE}; ${JSON.stringify(name)} is not a provider`);
    return undefined;
  }
  if (!isRecord(value)) {
    problem([], SHAPE);
    return undefined;
  }
  const keys = Object.keys(value);
  const provider = keys[0];
  if (keys.length !== 1 || !isProvider(provider)) {
    problem([], `${SHAPE}; name exactly one provider`);
    return undefined;
  }
  const settings = value[provider] ?? {};
  if (!isRecord(settings)) {
    problem([provider], `must map settings: ${SETTINGS[provider].join(", ")}`);
    return undefined;
  }
  let valid = true;
  for (const key of Object.keys(settings))
    if (!SETTINGS[provider].includes(key)) {
      problem(
        [provider, key],
        `is not a ${provider} setting; use ${SETTINGS[provider].join(" or ")}`,
      );
      valid = false;
    }
  const image = settings["image"];
  if (image !== undefined && (typeof image !== "string" || !isImageReference(image.trim()))) {
    problem(
      [provider, "image"],
      provider === "e2b"
        ? "must be an E2B template name or ID"
        : "must be a registry image or Modal image ID, without a scheme or credentials",
    );
    valid = false;
  }
  const chosen = typeof image === "string" ? { image: image.trim() } : {};
  if (provider === "e2b") return valid ? { provider, ...chosen } : undefined;
  const app = settings["app"];
  if (typeof app !== "string" || !MODAL_APP.test(app.trim())) {
    problem(
      ["modal", "app"],
      app === undefined
        ? "is required: the Modal app that owns sandboxes and images"
        : "must be a Modal app name: letters, digits, '.', '_', and '-', up to 64 characters",
    );
    return undefined;
  }
  return valid ? { provider, app: app.trim(), ...chosen } : undefined;
}

/** The file form `supertag config` prints: `e2b`, or the provider with its settings. */
export function hostEnvironmentValue(environment: HostEnvironment): unknown {
  const { provider, ...settings } = environment;
  return Object.keys(settings).length === 0 ? provider : { [provider]: { ...settings } };
}

/**
 * The variables each provider's SDK authenticates with. Only these move from env_file into the
 * host process, where Worker redaction already covers them. Host child processes that copy the
 * process environment, git bundling and the Codex model check, strip them with
 * `withoutProviderCredentials`; harness processes get allowlisted variables only.
 */
export const PROVIDER_CREDENTIAL_VARIABLES: Readonly<
  Record<HostEnvironmentProvider, readonly string[]>
> = {
  e2b: ["E2B_API_KEY", "E2B_ACCESS_TOKEN"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
};

/**
 * The provider credentials env_file holds and the process environment lacks. A service unit does
 * not inherit the shell's environment, so `supertag up` reads them from ~/.supertag/.env.
 */
export function providerCredentialsFromEnvFile(
  environment: HostEnvironment,
  envFile: Readonly<Record<string, string>>,
  processEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of PROVIDER_CREDENTIAL_VARIABLES[environment.provider]) {
    const value = envFile[name]?.trim();
    if (value && !processEnvironment[name]?.trim()) found[name] = value;
  }
  return found;
}

/** The provider modules a host environment loads; tests replace them with fakes. */
export interface HostEnvironmentModules {
  e2b(): Promise<typeof import("@supertag/worker-environment-e2b")>;
  modal(): Promise<typeof import("@supertag/worker-environment-modal")>;
}

const nativeModules: HostEnvironmentModules = {
  // Loaded only when configured: the provider SDKs are optional dependencies of supertag-ai.
  e2b: () => import("@supertag/worker-environment-e2b"),
  modal: () => import("@supertag/worker-environment-modal"),
};

export interface HostEnvironmentOptions {
  /** Private host directory for bundles read back from sandboxes. */
  readonly stagingDirectory: string;
  /**
   * How long a Task sandbox may live. Each provider terminates it then, so a lost Worker Host
   * can't leave one running and billing.
   */
  readonly sandboxTimeoutMs: number;
  readonly modules?: HostEnvironmentModules;
}

/**
 * The execution environment provider a host's Workers run Task Attempts in, with its Workspace
 * environment attached for prepared Workspaces. No credential passes through here: each provider
 * SDK reads its own.
 */
export async function createHostEnvironmentProvider(
  environment: HostEnvironment,
  options: HostEnvironmentOptions,
): Promise<ExecutionEnvironmentProvider> {
  const modules = options.modules ?? nativeModules;
  if (environment.provider === "e2b") {
    const { E2BExecutionEnvironmentProvider, E2BWorkspaceEnvironment } = await modules.e2b();
    const template = environment.image === undefined ? {} : { template: environment.image };
    return withWorkspaceEnvironment(
      new E2BExecutionEnvironmentProvider({
        ...template,
        sandboxTimeoutMs: options.sandboxTimeoutMs,
      }),
      new E2BWorkspaceEnvironment({
        ...template,
        stagingDirectory: options.stagingDirectory,
        sandboxTimeoutMs: options.sandboxTimeoutMs,
      }),
    );
  }
  const { ModalExecutionEnvironmentProvider, ModalWorkspaceEnvironment } = await modules.modal();
  const image = environment.image === undefined ? {} : { image: environment.image };
  // The operator names the app in supertag.yaml, so the Worker Host creates it when missing.
  const target = { appName: environment.app, createAppIfMissing: true, ...image };
  return withWorkspaceEnvironment(
    new ModalExecutionEnvironmentProvider({
      ...target,
      sandboxTimeoutMs: options.sandboxTimeoutMs,
    }),
    new ModalWorkspaceEnvironment({
      ...target,
      stagingDirectory: options.stagingDirectory,
      sandboxTimeoutMs: options.sandboxTimeoutMs,
    }),
  );
}

function withWorkspaceEnvironment(
  provider: ExecutionEnvironmentProvider,
  workspaceEnvironment: WorkspaceEnvironment,
): ExecutionEnvironmentProvider {
  return {
    id: provider.id,
    capabilities: provider.capabilities,
    ...(provider.guarantees === undefined ? {} : { guarantees: provider.guarantees }),
    ...(provider.recover === undefined
      ? {}
      : { recover: () => provider.recover?.() ?? Promise.resolve() }),
    workspaceEnvironment,
    provision: (spec, signal) => provider.provision(spec, signal),
  };
}

function isProvider(value: unknown): value is HostEnvironmentProvider {
  return (HOST_ENVIRONMENT_PROVIDERS as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
