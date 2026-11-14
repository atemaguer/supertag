# Credential storage

If the [organization](glossary.md#autonomous-organization) and execution terms on this page are new,
start with [core concepts](../concepts/README.md).

This page uses these SuperTag terms, each defined in the glossary: [Tag](glossary.md#tag),
[Task](glossary.md#task), [Task Attempt](glossary.md#task-attempt),
[Permission Set](glossary.md#permission-set), [Control Plane](glossary.md#control-plane),
[Gateway](glossary.md#gateway), [Surface Account](glossary.md#surface-account),
[Worker Host](glossary.md#worker-host), [host service](glossary.md#host-service),
[Auth Key](glossary.md#auth-key), [admin token](glossary.md#admin-token),
[Operator Token](glossary.md#operator-token), [Worklet API](glossary.md#control-plane),
[harness adapter](glossary.md#harness-adapter), and
[Workspace](glossary.md#workspace).

SuperTag keeps credential storage behind replaceable interfaces so a deployment can move from local
files to an external service without changing Tags, Surface Accounts, or the Control Plane
resource API.

## Four logical boundaries

| Boundary | Owner | Examples | Default implementation |
| --- | --- | --- | --- |
| Control Plane credential vault (`GatewayCredentialVault`) | Control Plane composition root | Gateway collaboration surface secrets, service keys, and Worker Host credential digests | `gateway` section of `~/.supertag/credentials.json` |
| Operator credential provider | Operator's CLI | Control Plane admin token or [Operator Token](resource-model.md#operator-tokens) | `operator` section of `~/.supertag/credentials.json` |
| Worker Host enrollment credential | One Worker Host | Its connection to the Control Plane | The host's own state directory, on that host |
| MCP and git credentials | One Worker Host | MCP server and git credentials | The host's environment or `~/.supertag/.env`; see [MCP and git credentials](#mcp-and-git-credentials) |

### Local storage paths and model credentials

The local Control Plane that `supertag init` and `supertag up` run uses the same directory,
`~/.supertag/`, or the one `SUPERTAG_STATE_DIR` names. Nothing is stored in a repository:

| Path in `~/.supertag/` | Holds |
| --- | --- |
| `credentials.json` | The Control Plane vault, and the local operator credential and MCP logins under `operator` |
| Host state directories | The Worker Host credential and execution journal of each host service in `supertag.yaml`, owner-only |
| `supertag.yaml` | The services file. It never holds a secret value: keys that take a secret name an entry in `secrets`, whose value comes from an environment variable or a file. |
| `runtime.sqlite3` | Local SQLite state, owner-only |

For `supertag init`, the bundled Claude Agent SDK checks the selected model using the Worker
Host's credentials. Run `claude` and use `/login`, or set `ANTHROPIC_API_KEY` in the host's
environment. The SDK reads the sign-in store selected by `CLAUDE_SECURESTORAGE_CONFIG_DIR`, then
`CLAUDE_CONFIG_DIR`, then `~/.claude` (macOS Keychain or Linux `.credentials.json`).

The bundled Codex SDK checks `CODEX_API_KEY`, then `$CODEX_HOME/auth.json` (default
`~/.codex/auth.json`), then `OPENAI_API_KEY` if the file cannot be read. Run `codex login` or set
either API key in the host's environment. For a login that Task Attempts can copy, run
`codex -c 'cli_auth_credentials_store="file"' login`; a Keychain-only login is not copied.
The file-backed init check verifies credential structure without testing account access.

### Operator and host credentials

The local operator credential, `control-plane/local-admin`, is the local Control Plane's admin
token. Commands use it when no other Control Plane is selected. A host service never connects with
it. For a host in the same file as the local Control Plane, `supertag up` uses the operator
credential once to enroll the host, then stores the host's own Worker Host credential in
`hosts/SERVICE/credential.json`. A host of a shared Control Plane joins with an Auth Key instead.
Keeping the Worker Host ID with the credential means renaming the computer creates no new Worker
Host. See [supertag.yaml and local state](supertag-yaml.md#credentials).

Without operator credentials, `supertag host revoke ID` revokes a host with its
own stored credential. It looks in `worker-hosts/` and in each `hosts/SERVICE/credential.json`,
then deletes the file it used.

### Vault ownership and isolation

The Control Plane composition root owns the shared vault instance used by its subsystems. Gateway
collaboration surface credentials use the `surface/...` logical namespace, while Control Plane service keys
and Worker Host credential digests use `control-plane/...`; sharing a provider does not merge their
purposes or identifiers. Gateway
collaboration surface credentials are never made available to the CLI after enrollment. Operator credentials
are never resolved through this vault interface. A Worklet presents only its own Worker Host
credential. The Control Plane has no interface for resolving MCP or git credentials; they stay on
the Worker Host.

In a local deployment the default adapters share one physical file for simpler setup and backup, but
their namespaces and runtime interfaces remain independent. That is a development convenience, not
a hard OS isolation boundary: any process with permission to read the file can bypass it. In a
remote deployment, the Control Plane and Worker Host should use distinct workload identities and
provider policies even when both are backed by the same secret-management service.

### Local file format

The local file has this shape:

```json
{
  "version": 2,
  "gateway": {
    "surface/slack/T123": { "botToken": "..." },
    "control-plane/coordination-signing-key": { "key": "..." },
    "control-plane/worker-host/YnVpbGQtZWFzdC0x/credential/1/01...": {
      "algorithm": "sha256",
      "digest": "..."
    }
  },
  "operator": {
    "control-plane/local-admin": { "token": "..." },
    "mcp-oauth/notion": { "...": "..." }
  }
}
```

Writes use an inter-process lock and atomic replacement so separate CLI and Control Plane processes
cannot overwrite the other section.

### Older credential files

Credential files accept only `version: 2`, `gateway`, and `operator` at the top level.
SuperTag rejects files containing a `workers` section, even when empty, or any other top-level field.
Rejected reads and writes leave the file unchanged. Back up and review older files before manually
removing unsupported sections; SuperTag does not migrate or delete their contents.

## Stable identifiers

The relational store records a logical credential ID such as:

```text
surface/slack/T123
```

It does not record a backend-specific address such as `file:...`, a Vault path, or an AWS ARN. The configured vault maps the logical ID to its physical storage location. Moving the values and changing the provider therefore requires no surface-account or control-plane API change.

## Control Plane vault contract

```ts
interface GatewayCredentialVault {
  store(credentialId: string, value: CredentialValue): Promise<void>;
  resolve(credentialId: string): Promise<CredentialValue | undefined>;
  delete(credentialId: string): Promise<void>;
}
```

The interface retains its original `GatewayCredentialVault` name, but the Control Plane composition
root receives and owns the dependency. It supplies the same instance to the Gateway for collaboration surface
credentials and to Control Plane services for keys such as
`control-plane/coordination-signing-key`. Those consumers use disjoint logical namespaces. The file
vault is the local default. A self-hosted distribution can supply HashiCorp Vault, AWS Secrets
Manager, Azure Key Vault, Google Secret Manager, or another implementation without exposing it
through `SurfaceAccount` resources. When deployments share an external service, the
implementation must apply a deployment-specific namespace before mapping logical IDs to physical
keys.

The CLI has a separate `OperatorCredentialProvider` contract and provider registry. A distribution can register a keychain, OIDC, or hosted implementation while connection configuration continues to identify only the provider and logical credential ID.

## Worker Host enrollment credential

A Worker Host enrollment credential is distinct from the harness and MCP credentials its Tasks
use. A host obtains one with a host [Auth Key](resource-model.md#auth-keys); the Control Plane
stores only a SHA-256 digest of each `stak_` secret and of each enrolled `stcr_` credential, and
compares them in constant time. Operator Tokens (`stop_`) are stored the same way.

A Worker Host enrolls from its own side and keeps its credential in its owner-only state
directory, outside any checkout a harness can read:

```bash
supertag host enroll build-east-1 --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --auth-key file:build-east-1.key
```

A host service in `supertag.yaml` does the same on its first `supertag up`. A host that reads its
credential from its own secret manager uses `SUPERTAG_HOST_TOKEN`; an operator writes a new one
with `supertag host rotate-credential build-east-1 --out FILE`, and a stopped host's own
credential is rotated with `--host-state-directory`. Rotation replaces the credential at once;
revocation refuses it at once. Ordinary `WorkerHost` reads expose the revision and **connection generation**,
an increasing number identifying the current connection. They never expose the token, digest,
or logical credential ID. They also expose
`lastAuthenticatedAt`, `failedAuthenticationCount`, and `lastAuthenticationFailureAt` so an
operator can detect rejected claims across Control Plane recovery.

A host credential is never a CLI flag. The built-in supervisor removes the exact credential value
from harness events and errors. Local-process execution under the same operating-system account is
not a filesystem security boundary; production deployments must keep the supervisor credential
outside the Task Attempt sandbox or run the harness under a separately confined identity.

## MCP and git credentials

SuperTag's built-in Workers keep no credential store of their own. MCP tool credentials, including
those for the GitHub, Slack, Linear, Teams, and Lark presets, come from references the Worker Host
resolves when a Task Attempt starts. `supertag mcp login` keeps OAuth tokens in the `operator`
section of `credentials.json`. They never enter the Surface Account vault. Git repository
source and pull-request delivery use a separate host-local `GITHUB_TOKEN`. See
[MCP tools](../surfaces/worker-tools.md).

Who wrote the server's configuration decides which variables it may read:

| Server declared in | References may name | Why |
| --- | --- | --- |
| A host service's `mcp` in `supertag.yaml` | Any variable, file, or secret | The host operator wrote it, so it is trusted. |
| A Workspace repository's `.mcp.json` | Only variables named `SUPERTAG_MCP_*`, such as `${SUPERTAG_MCP_SENTRY_TOKEN}` | A repository must not read the Worker Host's own credentials, such as `GITHUB_TOKEN`, `SUPERTAG_AUTH_KEY`, or a model API key. |

Set `SUPERTAG_MCP_*` values in the host's environment or in `~/.supertag/.env`. A Workspace
reference to any other variable stops the Task when it starts, with a message that names the
variable and this rule. SuperTag never sends the literal `${VAR}` text instead. The rule follows
GitHub Copilot's `COPILOT_MCP_` prefix. A stdio server starts with only a minimal environment plus
its resolved `env`, so it never inherits the Worker's credentials either. See
[Workspaces](../guides/workspaces.md#select-repository-skills-and-mcp-servers).

## Declared Surface Accounts

A SurfaceAccount manifest, applied with `supertag apply -f`, reaches the same vault entry as
`supertag setup surface`. The manifest holds only references, such as `{ env: SLACK_BOT_TOKEN }`;
a literal value fails validation. See
[Declare Surface Accounts](../operations/resources.md#declare-surface-accounts).

| Step | Where it happens | What crosses the boundary |
| --- | --- | --- |
| Resolve references | The `supertag apply` process | Environment variables and files are read in memory; a caller's resolver supplies `secretRef` values. |
| Compare | The Control Plane, in a dry run | The values, over the authenticated API. The Control Plane compares them with the vault entry in constant time and answers only `changed` or `unchanged`. |
| Verify | The `supertag apply` process | The provider's own API, as setup calls it. Skipped when nothing changed. |
| Store | The Control Plane | The verified values, over the same request setup uses, written to `surface/PROVIDER/ACCOUNT`. |

The CLI never writes a value to disk or prints one; errors name the reference instead. The
relational store keeps the references beside the account, for export, and no value, hash, or other
derivative of a secret. Field ownership records references only. Deleting a declared account
removes its vault entry.

## API invariants

- collaboration surface enrollment accepts credential material as write-only input over authenticated HTTPS.
- A SurfaceAccount apply accepts credential material only as write-only input. Its dry run reports
  whether the values match the vault and never echoes them.
- Worker Host enrollment and rotation return a host-bound token once; revocation and ordinary
  reads never return it.
- Surface Account responses expose configuration, verification status, and the secret references
  a manifest declared, never credential values, logical credential IDs, or physical locations.
- Tags, Permission Sets, Tasks, Workers, and harness prompts never contain Gateway collaboration surface credentials.
- A Worker Host resolves MCP and git credential references itself. A Workspace `.mcp.json` can
  reach only `SUPERTAG_MCP_*` variables. The Worker Host contains the process-level secret
  boundary for its Workers.
- A shared backend must enforce distinct workload identities and policies; namespace names alone are not a security boundary.
- Rotation writes the same logical ID and lets the collaboration surface controller reconcile the updated account.

External vault implementations must provide encryption, access policy, availability, auditing,
backup, and recovery appropriate to the deployment. Those provider concerns remain outside the
versioned Control Plane resource contract.

## HashiCorp Vault KV v2

`VaultGatewayCredentialVault` is the first external implementation. It maps each logical ID beneath a deployment-specific KV v2 prefix and supports store, resolve, rotation, and permanent deletion without exposing Vault paths through control-plane resources.

```ts
const credentialVault = new VaultGatewayCredentialVault({
  address: "https://vault.example.com",
  token: process.env.VAULT_TOKEN!,
  mount: "supertag",
  pathPrefix: "production/team-a",
});

await startControlPlaneRuntime({ credentialVault });
```

Use a narrowly scoped token with `create`, `update`, and `read` capabilities on the prefix's KV v2 `data` path and `read` and `delete` on its `metadata` path. Non-loopback addresses require HTTPS. Follow [Vault production hardening](https://developer.hashicorp.com/vault/docs/concepts/production-hardening) for server deployment, authentication, audit devices, recovery, and token policy.
