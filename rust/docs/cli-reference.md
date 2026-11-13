# Rust CLI reference

Generated from `supertag --help` and the help of every visible command, and checked by
`rust/crates/cli/tests/cli_help.rs`. Do not edit by hand: change the command's help, then
rerun that test with `SUPERTAG_UPDATE_CLI_REFERENCE=1`.

This page describes the Rust CLI. The pages under `docs/` still describe the TypeScript CLI
until the docs switch.

## `supertag`

```text
Usage: supertag [OPTIONS] [COMMAND]

Commands:
  health                Check a public or private gRPC service using the configured TLS trust
  setup                 Prepare a deployment of the Control Plane and Gateway, or connect a collaboration surface account
  check                 Validate a deployment's configuration without connecting
  verify                Check a running deployment through its public Gateway
  diff                  Preview an organization manifest through the Gateway
  apply                 Apply an organization manifest through the Gateway
  github-publication    Stop further provider writes of a GitHub publication
  workspace             Select GitHub Workspace sources pinned to one repository and commit
  reply                 Resolve uncertain connector replies from provider evidence
  role                  Define reusable Roles: purpose, instructions, Permission Sets, and Context Sets
  role-assignment       Assign Roles to Tags and deactivate assignments
  permission-set        Define reusable Permission Sets and apply them at surface locations
  context-set           Define reusable Context Sets and apply them at surface locations
  surface-account       Record verified connector accounts for surface policy
  surface-location      Bind a connector account's locations to a Tag and its policy
  gateway-credential    Store or delete Gateway collaboration credentials in the configured credential vault
  host                  Enroll, drain, resume, and revoke Worker Hosts, and rotate their credentials
  placement             Choose which labelled Worker Hosts run a Tag, and explain waiting Tasks
  question              Answer questions Objective Tasks ask the operator
  approval              Approve or deny actions waiting on an operator
  mcp                   List this host's catalog MCP servers and log in to OAuth servers
  mailbox-grant         Manage permission to send direct messages between Tags
  operator-token        Issue, rotate, and revoke named Operator Tokens. Admin operator token only
  audit                 List recorded operator changes, newest first, with actor, action, target, and outcome
  team                  Manage Teams and read their Workstream posts
  init                  Set up SuperTag on this machine for the git repository in the current directory
  sign-in               Check that a harness's Worker Host credentials work, and say how to sign in when not
  up                    Start local services or configured Worker Hosts in the background and return when ready
  down                  Stop this machine's SuperTag services, draining local Worker Hosts first
  logs                  Print this machine's service logs
  ps                    List this machine's SuperTag services
  status                Show Worker Hosts, Tags, unfinished Objectives, and the operator inbox
  version               Print this CLI's version and the version of the running local services
  config                Print the resolved supertag.yaml that supertag up runs
  control-plane         Run the private service that stores work and schedules execution
  gateway               Run the public gRPC service for operators and Worker Hosts
  tui                   Open the terminal UI for a saved or explicitly configured Gateway
  worker-host           Connect a Worker Host and run accepted Tasks through an adapter
  auth-key              Create and revoke Auth Keys that enroll Worker Hosts
  connect               Check an operator token against a Gateway, then save the Gateway under a name for `--gateway NAME` and the terminal UI. The token is read from SUPERTAG_OPERATOR_TOKEN, or from standard input when that is not set
  tag                   Set up and retire Tags
  task                  Submit, cancel, and steer Tasks, and read their events, usage, and published results
  artifact-publication  Publish completed artifact files for named destination Objectives, and withdraw them
  artifact-consumption  Approve and withdraw a destination Objective's use of a publication
  volume                Register Volumes and copy immutable artifact files into explicitly mapped storage
  workspace-volume      Register a file Volume for read-only Workspace data
  artifact              Download files captured by a Task
  fetch                 Import a Task's or Session's delivered commits as its Session branch in a repository
  input                 Resolve a message whose delivery to a running Task is uncertain
  test                  Check operator settings by sending a sample
  spend                 Report recorded spend by Objective, Tag, or day
  metrics               Read an operational snapshot: resource and Task counts, usage, Worker Host capacity, and Mailbox and reply backlogs
  get                   Read one resource by kind and ID, or list a kind, as JSON
  describe              Describe one resource in readable text
  delete                Delete one resource by kind and ID
  watch                 Stream change notices, reconnecting from the last resume token
  objective             Manage an Objective and inspect its owner's work
  help                  Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>  Gateway URL or the name of a Gateway saved in the terminal UI or desktop app, for the operator command that follows
  -h, --help                Print help
  -V, --version             Print version
```

## `supertag health`

```text
Check a public or private gRPC service using the configured TLS trust

Usage: supertag health [OPTIONS] --endpoint <ENDPOINT>

Options:
      --endpoint <ENDPOINT>
          Public Gateway or private Control Plane endpoint
      --service <SERVICE>
          Fully qualified gRPC service name; an empty string checks overall server status [default: supertag.runtime.v2.Operator]
      --timeout-seconds <TIMEOUT_SECONDS>
          Bound the entire connection and health request [default: 5]
  -h, --help
          Print help
```

## `supertag setup`

```text
Prepare a deployment of the Control Plane and Gateway, or connect a collaboration surface account

Usage: supertag setup <COMMAND>

Commands:
  deployment  Write private per-role environment files for a hosted deployment
  surface     Connect a Slack, GitHub, Lark, Linear, or Microsoft Teams account
  help        Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

## `supertag setup deployment`

```text
Write private per-role environment files for a hosted deployment

Usage: supertag setup deployment [OPTIONS] <PLATFORM>

Arguments:
  <PLATFORM>
          Possible values:
          - compose: Docker Compose on your own server: deploy/compose.native.yaml
          - fly:     Two Fly.io apps: deploy/native/fly
          - railway: Two Railway services: deploy/native/railway

Options:
      --output <OUTPUT>
          New private directory for the environment files
          
          [default: supertag-deployment]

      --non-interactive
          Fail instead of prompting when a required value is missing

  -h, --help
          Print help (see a summary with '-h')

Setup reads SUPERTAG_DATABASE_URL, SUPERTAG_GATEWAY_TOKEN, SUPERTAG_OPERATOR_TOKEN, SUPERTAG_OPERATOR_PRINCIPAL, SUPERTAG_CREDENTIAL_VAULT, and VAULT_* from the environment and prompts for missing required values (secrets are masked). Tokens that are not supplied are generated. Secrets are never accepted as flags or printed. Compose generates its own PostgreSQL password when SUPERTAG_DATABASE_URL is not set. Setup never replaces an existing directory. Upload the files through your provider's secret controls; do not shell-source them.
```

## `supertag setup surface`

```text
Connect a Slack, GitHub, Lark, Linear, or Microsoft Teams account

Usage: supertag setup surface <COMMAND>

Commands:
  slack   Enroll a Slack app for HTTP events: its bot token and signing secret
  github  Enroll a GitHub fine-grained token (default) or, with --auth app, a GitHub App
  linear  Enroll a Linear workspace API key and webhook signing secret
  lark    Enroll a Lark or Feishu app for long-connection events and thread replies
  teams   Enroll the Microsoft Entra application and tenant of a Teams bot
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

## `supertag setup surface slack`

```text
Enroll a Slack app for HTTP events: its bot token and signing secret

Usage: supertag setup surface slack [OPTIONS]

Options:
      --name <NAME>
          The Surface Account name, used in supertag.yaml and the credential vault. Defaults to the provider name
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
      --listen <LISTEN>
          Loopback address of this account's webhook listener on the local Gateway
      --transport <TRANSPORT>
          Event transport. The Gateway receives Slack events over HTTP [default: http]
  -h, --help
          Print help

Guide: docs/surfaces/slack.md (app manifest: docs/surfaces/slack-app-manifest.yaml)

Optional environment variables:
  SLACK_BOT_TOKEN
  SLACK_SIGNING_SECRET
```

## `supertag setup surface github`

```text
Enroll a GitHub fine-grained token (default) or, with --auth app, a GitHub App

Usage: supertag setup surface github [OPTIONS]

Options:
      --name <NAME>
          The Surface Account name, used in supertag.yaml and the credential vault. Defaults to the provider name
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
      --listen <LISTEN>
          Loopback address of this account's webhook listener on the local Gateway
      --auth <AUTH>
          How SuperTag authenticates to GitHub: a personal access token or a GitHub App [default: token] [possible values: token, app]
      --webhook
          With token authentication, also enroll a repository webhook secret
  -h, --help
          Print help

With token authentication, --webhook also enrolls a repository webhook secret.
Guide: docs/surfaces/github.md

Optional environment variables:
  SUPERTAG_GITHUB_TOKEN
  GITHUB_APP_ID
  GITHUB_INSTALLATION_ID
  GITHUB_PRIVATE_KEY_PATH
  GITHUB_WEBHOOK_SECRET
```

## `supertag setup surface linear`

```text
Enroll a Linear workspace API key and webhook signing secret

Usage: supertag setup surface linear [OPTIONS]

Options:
      --name <NAME>
          The Surface Account name, used in supertag.yaml and the credential vault. Defaults to the provider name
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
      --listen <LISTEN>
          Loopback address of this account's webhook listener on the local Gateway
  -h, --help
          Print help

Team locations and webhooks are configured separately.
Guide: docs/surfaces/linear.md

Optional environment variables:
  LINEAR_API_KEY
  LINEAR_WEBHOOK_SECRET
```

## `supertag setup surface lark`

```text
Enroll a Lark or Feishu app for long-connection events and thread replies

Usage: supertag setup surface lark [OPTIONS]

Options:
      --name <NAME>
          The Surface Account name, used in supertag.yaml and the credential vault. Defaults to the provider name
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
      --domain <DOMAIN>
          The app's platform: Lark, or Feishu in mainland China [default: lark] [possible values: lark, feishu]
  -h, --help
          Print help

Create and publish the app separately. Guide: docs/surfaces/lark.md

Optional environment variables:
  LARK_APP_ID
  LARK_APP_SECRET
  LARK_TENANT_KEY
```

## `supertag setup surface teams`

```text
Enroll the Microsoft Entra application and tenant of a Teams bot

Usage: supertag setup surface teams [OPTIONS]

Options:
      --name <NAME>
          The Surface Account name, used in supertag.yaml and the credential vault. Defaults to the provider name
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
      --listen <LISTEN>
          Loopback address of this account's webhook listener on the local Gateway
  -h, --help
          Print help

Create and install the Teams app separately. Guide: docs/surfaces/teams.md

Optional environment variables:
  TEAMS_APP_ID
  TEAMS_APP_SECRET
  TEAMS_TENANT_ID
  TEAMS_TENANT_NAME
```

## `supertag check`

```text
Validate a deployment's configuration without connecting

Usage: supertag check <COMMAND>

Commands:
  deployment  Validate a deployment's environment files without connecting
  help        Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

## `supertag check deployment`

```text
Validate a deployment's environment files without connecting

Usage: supertag check deployment [OPTIONS] <PLATFORM>

Arguments:
  <PLATFORM>
          Possible values:
          - compose: Docker Compose on your own server: deploy/compose.native.yaml
          - fly:     Two Fly.io apps: deploy/native/fly
          - railway: Two Railway services: deploy/native/railway

Options:
      --directory <DIRECTORY>
          Directory written by `supertag setup deployment`
          
          [default: supertag-deployment]

  -h, --help
          Print help (see a summary with '-h')
```

## `supertag verify`

```text
Check a running deployment through its public Gateway

Usage: supertag verify <COMMAND>

Commands:
  deployment  Check a deployed Gateway: health, authentication, the Control Plane hop, and readiness
  help        Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

## `supertag verify deployment`

```text
Check a deployed Gateway: health, authentication, the Control Plane hop, and readiness

Usage: supertag verify deployment [OPTIONS] <URL>

Arguments:
  <URL>  The Gateway's public HTTPS origin, such as https://supertag.example.com

Options:
      --env-file <ENV_FILE>  Private env file that holds SUPERTAG_OPERATOR_TOKEN
      --require-ready        Fail unless at least one Worker Host is ready
  -h, --help                 Print help

The operator token comes from SUPERTAG_OPERATOR_TOKEN or --env-file (the operator.env setup wrote). Use SUPERTAG_SERVER_CA_FILE when the Gateway's certificate comes from a private CA, and SUPERTAG_CLIENT_CERT_FILE and SUPERTAG_CLIENT_KEY_FILE when the Gateway requires client certificates. Verification registers no Worker Host and runs no Task.
```

## `supertag diff`

```text
Preview an organization manifest through the Gateway

Usage: supertag diff [OPTIONS] --file <FILES>

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -f, --file <FILES>
          YAML documents, a JSON array, a directory of manifests, or - for stdin
      --set <MANAGER>
          Apply as this apply set: it owns the Tag relationships it declares and the resources it creates
      --prune
          Remove the apply set's resources that the input no longer declares
  -h, --help
          Print help
```

## `supertag apply`

```text
Apply an organization manifest through the Gateway

Usage: supertag apply [OPTIONS] --file <FILES>

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -f, --file <FILES>
          YAML documents, a JSON array, a directory of manifests, or - for stdin
      --set <MANAGER>
          Apply as this apply set: it owns the Tag relationships it declares and the resources it creates
      --prune
          Remove the apply set's resources that the input no longer declares
  -h, --help
          Print help
```

## `supertag github-publication`

```text
Stop further provider writes of a GitHub publication

Usage: supertag github-publication [OPTIONS] <COMMAND>

Commands:
  cancel  Stop further provider writes. This does not delete a branch or close a PR
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag github-publication cancel`

```text
Stop further provider writes. This does not delete a branch or close a PR

Usage: supertag github-publication cancel [OPTIONS] --reason <REASON> <PUBLICATION_ID>

Arguments:
  <PUBLICATION_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --reason <REASON>
          Why provider writes stop; recorded with the cancellation
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag workspace`

```text
Select GitHub Workspace sources pinned to one repository and commit

Usage: supertag workspace [OPTIONS] <COMMAND>

Commands:
  put   Select a GitHub source. Moving revisions are pinned once per Session. Credentials stay on the Gateway
  help  Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag workspace put`

```text
Select a GitHub source. Moving revisions are pinned once per Session. Credentials stay on the Gateway

Usage: supertag workspace put [OPTIONS] --account <ACCOUNT> --repository-id <REPOSITORY_ID> --repository <REPOSITORY> <WORKSPACE_ID>

Arguments:
  <WORKSPACE_ID>  

Options:
      --account <ACCOUNT>
          Configured GitHub account that reads the repository
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --repository-id <REPOSITORY_ID>
          Numeric GitHub repository ID, which survives renames
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --repository <REPOSITORY>
          Repository as OWNER/NAME; must match the repository ID
      --commit <COMMIT>
          Pin this full commit SHA
      --ref <REFERENCE>
          Select a branch or tag. Omit commit and ref to use the default branch
      --pull-request-base <PULL_REQUEST_BASE>
          Publish verified results as a draft pull request into this branch
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag reply`

```text
Resolve uncertain connector replies from provider evidence

Usage: supertag reply [OPTIONS] <COMMAND>

Commands:
  resolve  Record verified delivery or failure for an uncertain reply. This never resends it
  help     Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag reply resolve`

```text
Record verified delivery or failure for an uncertain reply. This never resends it

Usage: supertag reply resolve [OPTIONS] --decision <DECISION> --evidence <EVIDENCE> <REPLY_ID>

Arguments:
  <REPLY_ID>  

Options:
      --decision <DECISION>
          What the provider shows happened to the reply [possible values: delivered, failed]
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --evidence <EVIDENCE>
          What you checked at the provider that shows the outcome
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --provider-receipt <PROVIDER_RECEIPT>
          Required for a delivered decision; identifies the observed provider response
      --operation-id <OPERATION_ID>
          Reuse this ID when retrying after a lost response
  -h, --help
          Print help
```

## `supertag role`

```text
Define reusable Roles: purpose, instructions, Permission Sets, and Context Sets

Usage: supertag role [OPTIONS] <COMMAND>

Commands:
  put   Create or replace a Role from a JSON specification. Retire one by putting it with status retired
  help  Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag role put`

```text
Create or replace a Role from a JSON specification. Retire one by putting it with status retired

Usage: supertag role put [OPTIONS] <FILE>

Arguments:
  <FILE>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag role-assignment`

```text
Assign Roles to Tags and deactivate assignments

Usage: supertag role-assignment [OPTIONS] <COMMAND>

Commands:
  create      Assign an active Role to a Tag
  deactivate  Deactivate a Role assignment
  help        Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag role-assignment create`

```text
Assign an active Role to a Tag

Usage: supertag role-assignment create [OPTIONS] <ROLE> <TAG_ID>

Arguments:
  <ROLE>    
  <TAG_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag role-assignment deactivate`

```text
Deactivate a Role assignment

Usage: supertag role-assignment deactivate [OPTIONS] --expected-revision <EXPECTED_REVISION> <ASSIGNMENT_ID>

Arguments:
  <ASSIGNMENT_ID>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag permission-set`

```text
Define reusable Permission Sets and apply them at surface locations

Usage: supertag permission-set [OPTIONS] <COMMAND>

Commands:
  put         Create or replace the set from a JSON specification
  activate    Apply the set to a Tag's work at a surface location
  deactivate  Stop applying the set at a surface location
  help        Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag permission-set put`

```text
Create or replace the set from a JSON specification

Usage: supertag permission-set put [OPTIONS] <FILE>

Arguments:
  <FILE>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag permission-set activate`

```text
Apply the set to a Tag's work at a surface location

Usage: supertag permission-set activate [OPTIONS] --tag <TAG> --provider <PROVIDER> <SET>

Arguments:
  <SET>  The set's ID or name

Options:
      --tag <TAG>
          The Tag whose surface location the set applies to
      --provider <PROVIDER>
          The surface the location belongs to [possible values: slack, github, linear, lark, teams]
      --account <ACCOUNT>
          Surface Account name from `supertag setup surface`. Needed when several accounts of the provider exist
      --channel-id <CHANNEL_ID>
          Slack or Teams channel ID
      --team-id <TEAM_ID>
          Linear team ID or Microsoft Teams team ID
      --chat-id <CHAT_ID>
          Lark chat ID
      --repo <REPOSITORY>
          GitHub repository as OWNER/NAME
      --repo-id <REPOSITORY_ID>
          GitHub numeric repository ID
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
  -h, --help
          Print help
```

## `supertag permission-set deactivate`

```text
Stop applying the set at a surface location

Usage: supertag permission-set deactivate [OPTIONS] --tag <TAG> --provider <PROVIDER> <SET>

Arguments:
  <SET>  The set's ID or name

Options:
      --tag <TAG>
          The Tag whose surface location the set applies to
      --provider <PROVIDER>
          The surface the location belongs to [possible values: slack, github, linear, lark, teams]
      --account <ACCOUNT>
          Surface Account name from `supertag setup surface`. Needed when several accounts of the provider exist
      --channel-id <CHANNEL_ID>
          Slack or Teams channel ID
      --team-id <TEAM_ID>
          Linear team ID or Microsoft Teams team ID
      --chat-id <CHAT_ID>
          Lark chat ID
      --repo <REPOSITORY>
          GitHub repository as OWNER/NAME
      --repo-id <REPOSITORY_ID>
          GitHub numeric repository ID
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
  -h, --help
          Print help
```

## `supertag context-set`

```text
Define reusable Context Sets and apply them at surface locations

Usage: supertag context-set [OPTIONS] <COMMAND>

Commands:
  put         Create or replace the set from a JSON specification
  activate    Apply the set to a Tag's work at a surface location
  deactivate  Stop applying the set at a surface location
  help        Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag context-set put`

```text
Create or replace the set from a JSON specification

Usage: supertag context-set put [OPTIONS] <FILE>

Arguments:
  <FILE>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag context-set activate`

```text
Apply the set to a Tag's work at a surface location

Usage: supertag context-set activate [OPTIONS] --tag <TAG> --provider <PROVIDER> <SET>

Arguments:
  <SET>  The set's ID or name

Options:
      --tag <TAG>
          The Tag whose surface location the set applies to
      --provider <PROVIDER>
          The surface the location belongs to [possible values: slack, github, linear, lark, teams]
      --account <ACCOUNT>
          Surface Account name from `supertag setup surface`. Needed when several accounts of the provider exist
      --channel-id <CHANNEL_ID>
          Slack or Teams channel ID
      --team-id <TEAM_ID>
          Linear team ID or Microsoft Teams team ID
      --chat-id <CHAT_ID>
          Lark chat ID
      --repo <REPOSITORY>
          GitHub repository as OWNER/NAME
      --repo-id <REPOSITORY_ID>
          GitHub numeric repository ID
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
  -h, --help
          Print help
```

## `supertag context-set deactivate`

```text
Stop applying the set at a surface location

Usage: supertag context-set deactivate [OPTIONS] --tag <TAG> --provider <PROVIDER> <SET>

Arguments:
  <SET>  The set's ID or name

Options:
      --tag <TAG>
          The Tag whose surface location the set applies to
      --provider <PROVIDER>
          The surface the location belongs to [possible values: slack, github, linear, lark, teams]
      --account <ACCOUNT>
          Surface Account name from `supertag setup surface`. Needed when several accounts of the provider exist
      --channel-id <CHANNEL_ID>
          Slack or Teams channel ID
      --team-id <TEAM_ID>
          Linear team ID or Microsoft Teams team ID
      --chat-id <CHAT_ID>
          Lark chat ID
      --repo <REPOSITORY>
          GitHub repository as OWNER/NAME
      --repo-id <REPOSITORY_ID>
          GitHub numeric repository ID
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
  -h, --help
          Print help
```

## `supertag surface-account`

```text
Record verified connector accounts for surface policy

Usage: supertag surface-account [OPTIONS] <COMMAND>

Commands:
  put   Create or update a verified connector account from a JSON specification
  help  Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag surface-account put`

```text
Create or update a verified connector account from a JSON specification

Usage: supertag surface-account put [OPTIONS] <FILE>

Arguments:
  <FILE>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag surface-location`

```text
Bind a connector account's locations to a Tag and its policy

Usage: supertag surface-location [OPTIONS] <COMMAND>

Commands:
  put   Create or update a location's Tag and policy from a JSON specification
  help  Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help

A location applies to its exact configured Gateway connector account alias. Other aliases use their own policy. Configure a separate alias for each location. The Gateway owns provider credentials.
```

## `supertag surface-location put`

```text
Create or update a location's Tag and policy from a JSON specification

Usage: supertag surface-location put [OPTIONS] <FILE>

Arguments:
  <FILE>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag gateway-credential`

```text
Store or delete Gateway collaboration credentials in the configured credential vault

Usage: supertag gateway-credential <COMMAND>

Commands:
  store   Store or replace a credential from a JSON object of strings on standard input, such as `{"botToken":"...","signingSecret":"..."}` for `surface/slack/<account>`
  delete  Delete a credential. Deleting a missing credential succeeds
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

## `supertag gateway-credential store`

```text
Store or replace a credential from a JSON object of strings on standard input, such as `{"botToken":"...","signingSecret":"..."}` for `surface/slack/<account>`

Usage: supertag gateway-credential store <CREDENTIAL_ID>

Arguments:
  <CREDENTIAL_ID>  

Options:
  -h, --help  Print help
```

## `supertag gateway-credential delete`

```text
Delete a credential. Deleting a missing credential succeeds

Usage: supertag gateway-credential delete <CREDENTIAL_ID>

Arguments:
  <CREDENTIAL_ID>  

Options:
  -h, --help  Print help
```

## `supertag host`

```text
Enroll, drain, resume, and revoke Worker Hosts, and rotate their credentials

Usage: supertag host [OPTIONS] <COMMAND>

Commands:
  drain              Stop assigning new Tasks while the Worker Host finishes current work
  resume             Allow the Worker Host to claim new Tasks again
  enroll             Enroll this installation with a one-time Auth Key. Its own --gateway and --state-directory name the Gateway to enroll with and the new Worker Host's state
  revoke             Revoke a Worker Host and its execution authority
  rotate-credential  Replace an enrolled Worker Host's credential. The previous one stops working at once
  help               Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag host drain`

```text
Stop assigning new Tasks while the Worker Host finishes current work

Usage: supertag host drain [OPTIONS] <HOST_ID>

Arguments:
  <HOST_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag host resume`

```text
Allow the Worker Host to claim new Tasks again

Usage: supertag host resume [OPTIONS] <HOST_ID>

Arguments:
  <HOST_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag host enroll`

```text
Enroll this installation with a one-time Auth Key. Its own --gateway and --state-directory name the Gateway to enroll with and the new Worker Host's state

Usage: supertag host enroll [OPTIONS] --gateway <GATEWAY> --state-directory <STATE_DIRECTORY> <HOST_ID>

Arguments:
  <HOST_ID>  

Options:
      --gateway <GATEWAY>
          Gateway URL to enroll with
      --state-directory <STATE_DIRECTORY>
          Private directory for this Worker Host's enrollment and execution journal
      --auth-key <AUTH_KEY>
          Auth Key or file:PATH. Also reads SUPERTAG_AUTH_KEY
  -h, --help
          Print help
```

## `supertag host revoke`

```text
Revoke a Worker Host and its execution authority

Usage: supertag host revoke [OPTIONS] <HOST_ID>

Arguments:
  <HOST_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag host rotate-credential`

```text
Replace an enrolled Worker Host's credential. The previous one stops working at once

Usage: supertag host rotate-credential [OPTIONS] <HOST_ID>

Arguments:
  <HOST_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --out <OUT>
          Write the new credential to this new owner-only file, for a host that reads SUPERTAG_HOST_TOKEN from its own secret manager
      --host-state-directory <HOST_STATE_DIRECTORY>
          Install the new credential in the state directory of this machine's stopped, enrolled Worker Host. It uses the credential when it next starts
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag placement`

```text
Choose which labelled Worker Hosts run a Tag, and explain waiting Tasks

Usage: supertag placement [OPTIONS] <COMMAND>

Commands:
  runs-on  Replace the labels a bound Worker Host must carry to run a Tag's Tasks
  explain  Explain which bound Worker Hosts can take a Task, and why others cannot
  help     Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag placement runs-on`

```text
Replace the labels a bound Worker Host must carry to run a Tag's Tasks

Usage: supertag placement runs-on [OPTIONS] <TAG_ID> [LABELS]...

Arguments:
  <TAG_ID>     
  [LABELS]...  Required labels. Omit every label to allow any bound host

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag placement explain`

```text
Explain which bound Worker Hosts can take a Task, and why others cannot

Usage: supertag placement explain [OPTIONS] <TASK_ID>

Arguments:
  <TASK_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag question`

```text
Answer questions Objective Tasks ask the operator

Usage: supertag question [OPTIONS] <COMMAND>

Commands:
  answer  Answer an Objective question in the owner's Session
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag question answer`

```text
Answer an Objective question in the owner's Session

Usage: supertag question answer [OPTIONS] <TASK_ID> <TEXT>

Arguments:
  <TASK_ID>  The Task that asked
  <TEXT>     

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Supply the same ID to retry an answer after a lost response
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag approval`

```text
Approve or deny actions waiting on an operator

Usage: supertag approval [OPTIONS] <COMMAND>

Commands:
  approve  Approve the exact requested action once or for its Objective
  deny     Deny a pending approval request
  help     Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag approval approve`

```text
Approve the exact requested action once or for its Objective

Usage: supertag approval approve [OPTIONS] <APPROVAL_ID>

Arguments:
  <APPROVAL_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --objective-scope
          Allow this Tag's Workstream posts to the same Team for this Objective
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --valid-until-ms <VALID_UNTIL_MS>
          End of the approval, in milliseconds since the Unix epoch. Omit for no end
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag approval deny`

```text
Deny a pending approval request

Usage: supertag approval deny [OPTIONS] --reason <REASON> <APPROVAL_ID>

Arguments:
  <APPROVAL_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --reason <REASON>
          Why the request is denied; the Tag sees this reason
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag mcp`

```text
List this host's catalog MCP servers and log in to OAuth servers

Usage: supertag mcp <COMMAND>

Commands:
  list   Show each catalog server, its auth form, and whether its credentials are ready. Never prints a credential
  login  Log in to an "oauth": true server in the browser (OAuth with PKCE). SuperTag stores the tokens in this host's MCP login store and the Worker Host refreshes them
  help   Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

## `supertag mcp list`

```text
Show each catalog server, its auth form, and whether its credentials are ready. Never prints a credential

Usage: supertag mcp list --mcp-catalog <MCP_CATALOG>

Options:
      --mcp-catalog <MCP_CATALOG>  The Worker Host's owner-only MCP catalog
  -h, --help                       Print help
```

## `supertag mcp login`

```text
Log in to an "oauth": true server in the browser (OAuth with PKCE). SuperTag stores the tokens in this host's MCP login store and the Worker Host refreshes them

Usage: supertag mcp login [OPTIONS] --mcp-catalog <MCP_CATALOG> <NAME>

Arguments:
  <NAME>  

Options:
      --mcp-catalog <MCP_CATALOG>
          The Worker Host's owner-only MCP catalog
      --no-browser
          Print the authorization URL without opening the system browser
      --timeout-seconds <TIMEOUT_SECONDS>
          Seconds to wait for the browser to come back [default: 300]
  -h, --help
          Print help
```

## `supertag mailbox-grant`

```text
Manage permission to send direct messages between Tags

Usage: supertag mailbox-grant [OPTIONS] <COMMAND>

Commands:
  allow   Allow one Tag to send direct messages to another Tag
  revoke  Remove a directional grant; shared Team membership still permits messages
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag mailbox-grant allow`

```text
Allow one Tag to send direct messages to another Tag

Usage: supertag mailbox-grant allow [OPTIONS] <SENDER_TAG_ID> <RECIPIENT_TAG_ID>

Arguments:
  <SENDER_TAG_ID>     
  <RECIPIENT_TAG_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag mailbox-grant revoke`

```text
Remove a directional grant; shared Team membership still permits messages

Usage: supertag mailbox-grant revoke [OPTIONS] <SENDER_TAG_ID> <RECIPIENT_TAG_ID>

Arguments:
  <SENDER_TAG_ID>     
  <RECIPIENT_TAG_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag operator-token`

```text
Issue, rotate, and revoke named Operator Tokens. Admin operator token only

Usage: supertag operator-token [OPTIONS] <COMMAND>

Commands:
  create  Issue a named Operator Token and print its secret once
  rotate  Replace the secret, print the new one once, and refuse the old one from now on
  revoke  Refuse the token from now on, including in calls and streams already open
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag operator-token create`

```text
Issue a named Operator Token and print its secret once.

Calls made with it act as the operator token:NAME. It expires 90 days after it is created or rotated. Names are never reused. Only the admin operator token manages Operator Tokens.

Usage: supertag operator-token create [OPTIONS] <NAME>

Arguments:
  <NAME>
          

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN

      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway

  -h, --help
          Print help (see a summary with '-h')
```

## `supertag operator-token rotate`

```text
Replace the secret, print the new one once, and refuse the old one from now on

Usage: supertag operator-token rotate [OPTIONS] <NAME>

Arguments:
  <NAME>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag operator-token revoke`

```text
Refuse the token from now on, including in calls and streams already open

Usage: supertag operator-token revoke [OPTIONS] <NAME>

Arguments:
  <NAME>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag audit`

```text
List recorded operator changes, newest first, with actor, action, target, and outcome

Usage: supertag audit [OPTIONS]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --since <SINCE>
          Only changes at or after this time, such as 2026-10-01T09:00:00Z or 2026-10-01
      --actor <ACTOR>
          Only changes by this operator, such as token:laptop-2
      --limit <LIMIT>
          At most N entries, 1 through 500 [default: 50]
      --cursor <CURSOR>
          Continue from the cursor a previous JSON page returned [default: ""]
      --output <OUTPUT>
          Print readable text, or JSON for scripts [default: text] [possible values: text, json]
  -h, --help
          Print help
```

## `supertag team`

```text
Manage Teams and read their Workstream posts

Usage: supertag team [OPTIONS] <COMMAND>

Commands:
  create  Create a Team from existing Tags
  update  Replace the selected fields of a Team
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag team create`

```text
Create a Team from existing Tags

Usage: supertag team create [OPTIONS] --member <MEMBER> <TEAM_ID>

Arguments:
  <TEAM_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --name <NAME>
          Display name. Defaults to the Team ID
      --member <MEMBER>
          Member Tag ID. Repeat for each member
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --max-concurrency <MAX_CONCURRENCY>
          Most Tasks the Team runs at once. Omit for no Team limit
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag team update`

```text
Replace the selected fields of a Team

Usage: supertag team update [OPTIONS] <TEAM>

Arguments:
  <TEAM>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --name <NAME>
          New display name
      --member <MEMBER>
          Replace the members with these Tag IDs. Repeat for each member
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --max-concurrency <MAX_CONCURRENCY>
          Most Tasks the Team runs at once
      --clear-concurrency
          Remove the Team concurrency limit
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag init`

```text
Set up SuperTag on this machine for the git repository in the current directory

Usage: supertag init [OPTIONS]

Options:
  -y, --yes
          Accept every default without asking
      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)
  -h, --help
          Print help
```

## `supertag sign-in`

```text
Check that a harness's Worker Host credentials work, and say how to sign in when not

Usage: supertag sign-in [OPTIONS] <HARNESS>

Arguments:
  <HARNESS>  The harness to check: claude-code, codex, cursor or opencode [possible values: claude-code, codex, cursor, opencode]

Options:
      --model <MODEL>
          Model to check with. OpenCode requires one, as provider/model
      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)
  -f, --file <FILE>
          Service configuration whose env_file supplies credentials; otherwise STATE_DIRECTORY/supertag.yaml when present
  -h, --help
          Print help
```

## `supertag up`

```text
Start local services or configured Worker Hosts in the background and return when ready.

With --foreground, supervise them in this terminal until interrupted. A service with restart: unless-stopped makes up install a per-user service unit (launchd on macOS, systemd on Linux) that runs the supervisor and starts it again after a failure or login.

Usage: supertag up [OPTIONS]

Options:
  -f, --file <FILE>
          Service configuration, otherwise STATE_DIRECTORY/supertag.yaml when present

      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)

      --foreground
          Run in this terminal with each service's logs here until interrupted

      --force
          When restarting changed services, do not wait for running Task Attempts

      --adapter <ADAPTER>
          Executable that implements the SuperTag harness protocol

      --adapter-arg <ADAPTER_ARG>
          Argument passed to the --adapter executable. Repeat for more arguments

      --harness <HARNESS>
          Built-in harness to use for Tasks on this host
          
          [possible values: codex, claude-code, openai-agents, opencode, cursor]

      --harness-runtime <HARNESS_RUNTIME>
          Node or Python interpreter used by a language adapter

      --harness-entrypoint <HARNESS_ENTRYPOINT>
          Override the JavaScript or Python application entrypoint

      --harness-model <HARNESS_MODEL>
          Default model ID for the built-in harness

      --harness-models <HARNESS_MODELS>
          Additional model IDs this Worker Host can run

      --cursor-node <CURSOR_NODE>
          Node interpreter for the Cursor SDK adapter application

      --cursor-adapter <CURSOR_ADAPTER>
          Override the compiled Cursor SDK adapter entrypoint

      --opencode-node <OPENCODE_NODE>
          Node interpreter for the OpenCode adapter application

      --opencode-adapter <OPENCODE_ADAPTER>
          Override the compiled OpenCode adapter entrypoint

      --opencode-path <OPENCODE_PATH>
          Absolute OpenCode executable path. Otherwise resolve opencode on PATH

      --opencode-auth-file <OPENCODE_AUTH_FILE>
          Owner-only API credential file. Also accepts SUPERTAG_OPENCODE_AUTH_FILE

      --allow-unsandboxed-commands
          Allow OpenCode or Cursor commands without an operating-system sandbox

      --claude-path <CLAUDE_PATH>
          Claude executable used by the Agent SDK

      --codex-path <CODEX_PATH>
          Codex executable. Otherwise resolve codex on PATH

      --codex-model <CODEX_MODEL>
          Default Codex model ID

      --codex-workspace <CODEX_WORKSPACE>
          Existing directory for read-only Tasks. Otherwise each Task gets its own directory

      --workspace-id <WORKSPACE_ID>
          Repository identity that this host can prepare for accepted Tasks. Repeat it, each followed by its --workspace-source, to map several Workspaces

      --workspace-source <WORKSPACE_SOURCE>
          Trusted local Git source for the preceding --workspace-id; Tasks run in separate pinned checkouts. Several Workspace IDs may name the same source

      --workspace-from-gateway
          Retrieve each Workspace's accepted GitHub source from the Gateway

      --skill-catalog <SKILL_CATALOG>
          Private host allowlist of Skill packages

      --gateway-listen <GATEWAY_LISTEN>
          Address the local Gateway listens on. Port 0 picks a free port
          
          [default: 127.0.0.1:0]

  -h, --help
          Print help (see a summary with '-h')
```

## `supertag down`

```text
Stop this machine's SuperTag services, draining local Worker Hosts first

Usage: supertag down [OPTIONS]

Options:
      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)
  -f, --file <FILE>
          supertag.yaml, or a directory that holds one, naming the service unit to remove
      --remove-services
          Also uninstall the per-user service unit
      --force
          Do not wait for running Task Attempts
  -h, --help
          Print help
```

## `supertag logs`

```text
Print this machine's service logs

Usage: supertag logs [OPTIONS] [SERVICES]...

Arguments:
  [SERVICES]...  Services to show: supervisor, control-plane, gateway, or a host (default: all)

Options:
      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)
  -f, --follow
          Keep printing new lines until interrupted
      --file <FILE>
          supertag.yaml, or a directory that holds one
  -h, --help
          Print help
```

## `supertag ps`

```text
List this machine's SuperTag services

Usage: supertag ps [OPTIONS]

Options:
      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)
  -f, --file <FILE>
          supertag.yaml, or a directory that holds one
      --output <OUTPUT>
          Print readable text, or JSON for scripts [default: text] [possible values: text, json]
  -h, --help
          Print help
```

## `supertag status`

```text
Show Worker Hosts, Tags, unfinished Objectives, and the operator inbox

Usage: supertag status [OPTIONS]

Options:
      --gateway <GATEWAY>
          Remote Gateway; reads SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)
      --output <OUTPUT>
          Print readable text, or JSON for scripts [default: text] [possible values: text, json]
  -h, --help
          Print help
```

## `supertag version`

```text
Print this CLI's version and the version of the running local services

Usage: supertag version [OPTIONS]

Options:
      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)
      --output <OUTPUT>
          Print readable text, or JSON for scripts [default: text] [possible values: text, json]
  -h, --help
          Print help
```

## `supertag config`

```text
Print the resolved supertag.yaml that supertag up runs

Usage: supertag config [OPTIONS]

Options:
  -f, --file <FILE>
          Service configuration, otherwise STATE_DIRECTORY/supertag.yaml when present
      --state-directory <STATE_DIRECTORY>
          Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR)
      --services
          List the service names only
  -h, --help
          Print help
```

## `supertag control-plane`

```text
Run the private service that stores work and schedules execution

Usage: supertag control-plane [OPTIONS]

Options:
      --listen <LISTEN>
          Address this service listens on. Port 0 picks a free port [default: 127.0.0.1:0]
      --websocket-listen <WEBSOCKET_LISTEN>
          Also accept gRPC carried in a WebSocket on this address, for hosts that only forward HTTP/1.1. This service's TLS runs inside the tunnel. Its bound address is reported after the gRPC address
  -h, --help
          Print help
```

## `supertag gateway`

```text
Run the public gRPC service for operators and Worker Hosts

Usage: supertag gateway [OPTIONS] --control-plane <CONTROL_PLANE>

Options:
      --listen <LISTEN>
          Address this service listens on. Port 0 picks a free port
          
          [default: 127.0.0.1:0]

      --websocket-listen <WEBSOCKET_LISTEN>
          Also accept gRPC carried in a WebSocket on this address, for hosts that only forward HTTP/1.1. This service's TLS runs inside the tunnel. Its bound address is reported after the gRPC address

      --control-plane <CONTROL_PLANE>
          Private Control Plane URL that this Gateway forwards to

      --checkpoint-directory <CHECKPOINT_DIRECTORY>
          Private directory for Session checkpoint archives that Worker Hosts transfer through this Gateway

      --artifact-volume <ARTIFACT_VOLUMES>
          Explicit storage-host consent: VOLUME_ID=/absolute/private/directory

      --artifact-s3-volumes <ARTIFACT_S3_VOLUMES>
          Path to a JSON array of mappings with volumeId, source (s3://bucket/prefix), endpoint (HTTPS origin), region, and credentialEnvPrefix. The Gateway reads <prefix>_ACCESS_KEY_ID, <prefix>_SECRET_ACCESS_KEY, and optionally <prefix>_SESSION_TOKEN. For Cloudflare R2, use region auto.

      --slack-listen <SLACK_LISTEN>
          Address for Slack webhooks. Requires the Slack state directory

      --slack-state-directory <SLACK_STATE_DIRECTORY>
          Private directory for Slack connector state and reply receipts

      --github-listen <GITHUB_LISTEN>
          Address for GitHub webhooks. Requires the GitHub state directory

      --github-state-directory <GITHUB_STATE_DIRECTORY>
          Private directory for GitHub connector state and reply receipts

      --github-workspace-directory <GITHUB_WORKSPACE_DIRECTORY>
          Private scratch for GitHub source bundles, using the configured GitHub account. The GitHub Surface connector reads the same `SUPERTAG_GITHUB_*` variables, so one Gateway serves either a GitHub Workspace or a GitHub location, not both

      --linear-listen <LINEAR_LISTEN>
          Address for Linear webhooks. Requires the Linear state directory

      --linear-state-directory <LINEAR_STATE_DIRECTORY>
          Private directory for Linear connector state and reply receipts

      --lark-state-directory <LARK_STATE_DIRECTORY>
          Enable the outbound Lark or Feishu connection and store reply receipts here

      --microsoft-teams-listen <MICROSOFT_TEAMS_LISTEN>
          Address for Microsoft Teams webhooks. Requires the Microsoft Teams state directory

      --microsoft-teams-state-directory <MICROSOFT_TEAMS_STATE_DIRECTORY>
          Private directory for Microsoft Teams connector state and reply receipts

      --notify <NOTIFY>
          Tell the operator about Inbox items here: desktop, webhook:HTTPS_URL[#SECRET_NAME], slack:CHANNEL_OR_USER_ID, or slack:WORKSPACE_ID/CHANNEL_OR_USER_ID. Repeatable. A webhook's SECRET_NAME is read from SUPERTAG_NOTIFY_SECRET_<NAME> (uppercase, - as _) and sent as a bearer token. Slack destinations post with this Gateway's Slack connector.

  -h, --help
          Print help (see a summary with '-h')
```

## `supertag tui`

```text
Open the terminal UI for a saved or explicitly configured Gateway

Usage: supertag tui [OPTIONS]

Options:
      --gateway <GATEWAY>
          Gateway URL or the name of a saved Gateway
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --binary <BINARY>
          Terminal UI executable. Also reads SUPERTAG_TUI_BINARY
      --workspace <WORKSPACE>
          Workspace ID the terminal UI starts in
  -h, --help
          Print help
```

## `supertag worker-host`

```text
Connect a Worker Host and run accepted Tasks through an adapter

Usage: supertag worker-host [OPTIONS] --gateway <GATEWAY> --state-directory <STATE_DIRECTORY>

Options:
      --gateway <GATEWAY>
          Gateway URL this Worker Host connects to

      --state-directory <STATE_DIRECTORY>
          Private directory for this Worker Host's enrollment and execution journal

      --label <LABELS>
          Placement label for this host, such as gpu. Repeat for more labels

      --adapter <ADAPTER>
          Executable that implements the SuperTag harness protocol

      --adapter-arg <ADAPTER_ARG>
          Argument passed to the --adapter executable. Repeat for more arguments

      --harness <HARNESS>
          Built-in harness to use for Tasks on this host
          
          [possible values: codex, claude-code, openai-agents, opencode, cursor]

      --harness-runtime <HARNESS_RUNTIME>
          Node or Python interpreter used by a language adapter

      --harness-entrypoint <HARNESS_ENTRYPOINT>
          Override the JavaScript or Python application entrypoint

      --harness-model <HARNESS_MODEL>
          Default model ID for the built-in harness

      --harness-models <HARNESS_MODELS>
          Additional model IDs this Worker Host can run

      --cursor-node <CURSOR_NODE>
          Node interpreter for the Cursor SDK adapter application

      --cursor-adapter <CURSOR_ADAPTER>
          Override the compiled Cursor SDK adapter entrypoint

      --opencode-node <OPENCODE_NODE>
          Node interpreter for the OpenCode adapter application

      --opencode-adapter <OPENCODE_ADAPTER>
          Override the compiled OpenCode adapter entrypoint

      --opencode-path <OPENCODE_PATH>
          Absolute OpenCode executable path. Otherwise resolve opencode on PATH

      --opencode-auth-file <OPENCODE_AUTH_FILE>
          Owner-only API credential file. Also accepts SUPERTAG_OPENCODE_AUTH_FILE

      --allow-unsandboxed-commands
          Allow OpenCode or Cursor commands without an operating-system sandbox

      --claude-path <CLAUDE_PATH>
          Claude executable used by the Agent SDK

      --codex-path <CODEX_PATH>
          Codex executable. Otherwise resolve codex on PATH

      --codex-model <CODEX_MODEL>
          Default Codex model ID

      --codex-workspace <CODEX_WORKSPACE>
          Existing directory for read-only Tasks. Otherwise each Task gets its own directory

      --workspace-id <WORKSPACE_ID>
          Repository identity that this host can prepare for accepted Tasks. Repeat it, each followed by its --workspace-source, to map several Workspaces

      --workspace-source <WORKSPACE_SOURCE>
          Trusted local Git source for the preceding --workspace-id; Tasks run in separate pinned checkouts. Several Workspace IDs may name the same source

      --workspace-from-gateway
          Retrieve each Workspace's accepted GitHub source from the Gateway

      --workspace-mount-mappings <WORKSPACE_MOUNT_MAPPINGS>
          Owner-controlled JSON mappings for read-only Workspace Volume copies

      --artifact-transfer-listen <ARTIFACT_TRANSFER_LISTEN>
          Listen for authorized artifact reads from other Worker Hosts

      --artifact-source-directory <ARTIFACT_SOURCE_DIRECTORY>
          Dedicated owner-only absolute directory for immutable artifact copies

      --artifact-transfer-tls-cert <ARTIFACT_TRANSFER_TLS_CERT>
          TLS certificate for the artifact transfer listener

      --artifact-transfer-tls-key <ARTIFACT_TRANSFER_TLS_KEY>
          TLS private key for the artifact transfer listener

      --artifact-peer <HOST_ID=ORIGIN>
          Pin a producing Worker Host to an HTTPS origin or literal loopback HTTP

      --artifact-peer-ca-file <ARTIFACT_PEER_CA_FILE>
          CA certificate for the configured artifact peer endpoints

      --e2b-workspace-provider <E2B_WORKSPACE_PROVIDER>
          Executable for a private E2B workspace provider used by Cursor

      --e2b-workspace-provider-arg <E2B_WORKSPACE_PROVIDER_ARG>
          Argument to the E2B provider, such as the compiled helper entrypoint

      --modal-workspace-provider <MODAL_WORKSPACE_PROVIDER>
          Executable for a private Modal Workspace provider used by Cursor

      --modal-workspace-provider-arg <MODAL_WORKSPACE_PROVIDER_ARG>
          Argument to the Modal provider, such as the compiled helper entrypoint

      --mcp-catalog <MCP_CATALOG>
          Owner-only JSON catalog of HTTP and stdio MCP tools for Claude Code Tasks.
          
          Use {"version":1,"servers":[{"name":"catalog","url":"https://example.com/mcp","headerEnv":{"Authorization":"CATALOG_AUTH"}}]}. Set CATALOG_AUTH to the full header value in the Worker Host environment. An HTTP server with "oauth":true instead uses the login `supertag mcp login NAME --mcp-catalog PATH` stores on this host.
          
          A stdio server has a command instead of a url, such as {"name":"db","command":["npx","-y","@acme/db-mcp"],"env":{"DB_TOKEN":"ACME_DB_TOKEN"}}. The Worker Host launches it for each Task Attempt with only its env, each value read from the named Worker Host variable, plus HOME, PATH, and a few locale variables, and stops its process group when the Attempt ends.
          
          The optional resources.tools object maps each tool name to a list of rules, for example [{"prefix":"repository:","separator":"/","components":[{"arguments":["owner"]},{"arguments":["repo"]}]}].
          
          A preset names an official HTTP server instead of a url, with its URL and resource mapping: {"name":"github","preset":"github","headerEnv":{"Authorization":"GITHUB_MCP_AUTH"}}. Presets are github, slack, linear, and teams; teams also needs "tenantId", the Microsoft Entra tenant ID or domain.
          
          Catalog entries expose tools only when the Task's accepted Permission Sets grant them. Calls requiring approval appear in the operator Inbox. Endpoints must use HTTPS or literal loopback HTTP.

      --shared-execution-endpoint <SHARED_EXECUTION_ENDPOINT>
          gRPC origin of a standalone shared execution provider for Cursor

      --shared-execution-environment <SHARED_EXECUTION_ENVIRONMENT>
          Environment ID expected from the provider. Set SUPERTAG_EXECUTION_ADMIN_TOKEN separately

      --shared-execution-ca-file <SHARED_EXECUTION_CA_FILE>
          CA certificate for the shared execution provider endpoint

      --shared-execution-commands
          Enable lease-bound commands on an operator-trusted Linux shared execution provider. Commands start in the fixed root with an empty credential environment and run with the provider's configured workload UID and GID. That identity's OS filesystem and network permissions also apply.

      --skill-catalog <SKILL_CATALOG>
          Private host allowlist of Skill packages

      --attempt-timeout-seconds <ATTEMPT_TIMEOUT_SECONDS>
          Seconds a Task Attempt may run before this host stops it
          
          [default: 120]

      --once
          Exit after running one Task Attempt

      --wait-for-recovery
          Stay connected while an interrupted Attempt waits for an operator decision, instead of exiting

  -h, --help
          Print help (see a summary with '-h')
```

## `supertag auth-key`

```text
Create and revoke Auth Keys that enroll Worker Hosts

Usage: supertag auth-key [OPTIONS] <COMMAND>

Commands:
  create  Create a named, scoped Auth Key: one-time for a named Worker Host, or reusable
  revoke  Stop an Auth Key from enrolling more Worker Hosts. Hosts that joined stay enrolled
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag auth-key create`

```text
Create a named, scoped Auth Key: one-time for a named Worker Host, or reusable

Usage: supertag auth-key create [OPTIONS] <NAME>

Arguments:
  <NAME>  The key's name: 1-63 lowercase letters, digits, hyphens or underscores. Never reused

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --host <HOST_ID>
          Worker Host ID a one-time key enrolls. Omit with --reusable
      --reusable
          Enroll any number of Worker Hosts, each choosing its own ID
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --ephemeral
          Remove hosts that join with this key once they go offline
      --label <LABELS>
          Label granted to every host that joins. Repeat for more labels
      --expires-in-seconds <EXPIRES_IN_SECONDS>
          Shorter lifetime. Defaults to the maximum: one hour, or 90 days with --reusable
      --tag <TAG>
          Tag whose Tasks hosts enrolled with this key may run. Repeat for more Tags
      --all-tags
          Let hosts enrolled with this key run Tasks for every Tag
  -h, --help
          Print help
```

## `supertag auth-key revoke`

```text
Stop an Auth Key from enrolling more Worker Hosts. Hosts that joined stay enrolled

Usage: supertag auth-key revoke [OPTIONS] <NAME>

Arguments:
  <NAME>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag connect`

```text
Check an operator token against a Gateway, then save the Gateway under a name for `--gateway NAME` and the terminal UI. The token is read from SUPERTAG_OPERATOR_TOKEN, or from standard input when that is not set

Usage: supertag connect [OPTIONS] --name <NAME> <URL>

Arguments:
  <URL>  The Gateway origin, such as https://supertag.example.com

Options:
      --name <NAME>
          The name to save it under
      --replace
          Replace a Gateway already saved under this name for the same origin
      --server-ca-file <SERVER_CA_FILE>
          PEM file of the certificate authority that signed the Gateway's TLS certificate
      --client-cert-file <CLIENT_CERT_FILE>
          PEM client certificate for a Gateway that requires mutual TLS
      --client-key-file <CLIENT_KEY_FILE>
          PEM private key of the client certificate
  -h, --help
          Print help
```

## `supertag tag`

```text
Set up and retire Tags

Usage: supertag tag [OPTIONS] <COMMAND>

Commands:
  put     Set the instructions and allowed actions for a Tag
  retire  Retire a Tag by ID while preserving its work history
  update  Change where a Tag works: add or remove its location on a connected surface. Its own --gateway, --state-directory, and --file name the local configuration it edits
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag tag put`

```text
Set the instructions and allowed actions for a Tag

Usage: supertag tag put [OPTIONS] --instructions <INSTRUCTIONS> <TAG_ID>

Arguments:
  <TAG_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --name <DISPLAY_NAME>
          Display name. Defaults to the Tag ID for a new Tag
      --instructions <INSTRUCTIONS>
          Standing instructions the Tag follows in every Task
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --allow <ALLOW>
          Action the Tag may take, such as files:read. Repeat for each action
      --require-workstream-approval
          Require approval before this Tag posts to a Team Workstream
      --workstream-approver <WORKSTREAM_APPROVER>
          Bare operator ID eligible to approve. Omit to allow any eligible operator
      --require-mailbox-approval
          Require approval before this Tag sends a direct message
      --mailbox-approver <MAILBOX_APPROVER>
          Bare operator ID eligible to approve a direct message
      --workspace-id <WORKSPACE_ID>
          Logical local or configured GitHub repository binding
      --workspace-base <WORKSPACE_BASE>
          Full local Git base commit. Omit for a configured GitHub source
      --workspace-mounts <WORKSPACE_MOUNTS>
          JSON array of {volumeId,destination,maxBytes} for local read-only copy mounts
      --workspace-mcp <WORKSPACE_MCP>
          A server the Workspace's `.mcp.json` declares that this Tag's Tasks may use, read from the Task's base commit. May be repeated
      --harness <HARNESS>
          Required harness for Tasks accepted from this Tag [possible values: codex, claude-code, openai-agents, opencode, cursor]
      --model <MODELS>
          Allowed model IDs, with the default first. May be repeated
      --effort <EFFORTS>
          Allowed reasoning efforts, with the default first. May be repeated
      --shared-execution-environment <SHARED_EXECUTION_ENVIRONMENT>
          Require this fixed execution environment for new Cursor Sessions
  -h, --help
          Print help
```

## `supertag tag retire`

```text
Retire a Tag by ID while preserving its work history

Usage: supertag tag retire [OPTIONS] <TAG_ID>

Arguments:
  <TAG_ID>  

Options:
      --dry-run
          Show blockers and what retirement would detach
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag tag update`

```text
Change where a Tag works: add or remove its location on a connected surface. Its own --gateway, --state-directory, and --file name the local configuration it edits

Usage: supertag tag update [OPTIONS] <TAG>

Arguments:
  <TAG>  

Options:
      --add-location <PROVIDER>
          Admit work for the Tag at a location of a connected surface account [possible values: slack, github, linear, lark, teams]
      --remove-location <PROVIDER>
          Stop admitting work for the Tag at the location [possible values: slack, github, linear, lark, teams]
      --account <ACCOUNT>
          Surface Account name from `supertag setup surface`. Needed when several accounts of the provider exist
      --channel-id <CHANNEL_ID>
          Slack or Teams channel ID
      --team-id <TEAM_ID>
          Linear team ID or Microsoft Teams team ID
      --chat-id <CHAT_ID>
          Lark chat ID
      --repo <REPOSITORY>
          GitHub repository as OWNER/NAME
      --repo-id <REPOSITORY_ID>
          GitHub numeric repository ID
      --allowed-user <ALLOWED_USERS>
          Provider user ID allowed to ask the Tag for work there (numeric on GitHub). Repeat for more users
      --gateway <URL|NAME>
          Gateway URL or saved Gateway name. Defaults to this machine's running local services
      --state-directory <STATE_DIRECTORY>
          State directory with supertag.yaml and the file credential vault. Defaults to SUPERTAG_STATE_DIR, then ~/.supertag
  -f, --file <FILE>
          Services file to record the surface in. Defaults to STATE_DIRECTORY/supertag.yaml
  -h, --help
          Print help

The local Gateway serves one location per Surface Account and one per provider; remove a location before adding another.
```

## `supertag task`

```text
Submit, cancel, and steer Tasks, and read their events, usage, and published results

Usage: supertag task [OPTIONS] <COMMAND>

Commands:
  submit           Accept one turn of work in a Tag's Session
  cancel           Cancel a Task
  events           Read a page of recorded Task events
  usage            Read native token usage recorded for a Task Attempt
  input            Send a message to a running Task, with a queued fallback if it cannot take it
  resolve-attempt  Record an audited decision for a stopped, uncertain Task Attempt
  download         Download the patch or Git bundle published by a successful workspace Task
  help             Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag task submit`

```text
Accept one turn of work in a Tag's Session

Usage: supertag task submit [OPTIONS] --tag <TAG> --session <SESSION> <PROMPT>

Arguments:
  <PROMPT>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --tag <TAG>
          Tag that does the work
      --session <SESSION>
          Session that the turn belongs to; a new name starts a new Session
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --max-reported-tokens <MAX_REPORTED_TOKENS>
          Stop the turn when its reported token count reaches this limit
      --max-reported-cost-minor <MAX_REPORTED_COST_MINOR>
          Apply a provider-reported spending limit in minor currency units
      --reported-cost-currency <REPORTED_COST_CURRENCY>
          Three-letter currency for the reported cost limit
      --max-native-agents <MAX_NATIVE_AGENTS>
          Limit native agents and Work Sessions started by this turn
      --outputs <OUTPUTS>
          Read declared output requirements from a JSON file
      --artifact-input <ARTIFACT_ID:PATH>
          Include one submitted artifact file from the same Objective. Repeat for more files
      --artifact-publication <ARTIFACT_PUBLICATION>
          Bind selected artifact inputs to this explicit publication approval
  -h, --help
          Print help
```

## `supertag task cancel`

```text
Cancel a Task

Usage: supertag task cancel [OPTIONS] <TASK_ID>

Arguments:
  <TASK_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag task events`

```text
Read a page of recorded Task events

Usage: supertag task events [OPTIONS] <TASK_ID>

Arguments:
  <TASK_ID>  

Options:
      --after <AFTER>
          Only entries after this sequence number [default: 0]
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag task usage`

```text
Read native token usage recorded for a Task Attempt

Usage: supertag task usage [OPTIONS] <TASK_ID> <ATTEMPT_ID>

Arguments:
  <TASK_ID>     
  <ATTEMPT_ID>  

Options:
      --after <AFTER>
          Only entries after this sequence number [default: 0]
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag task input`

```text
Send a message to a running Task, with a queued fallback if it cannot take it

Usage: supertag task input [OPTIONS] <TASK_ID> <TEXT>

Arguments:
  <TASK_ID>  
  <TEXT>     

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag task resolve-attempt`

```text
Record an audited decision for a stopped, uncertain Task Attempt

Usage: supertag task resolve-attempt [OPTIONS] --decision <DECISION> --evidence <EVIDENCE> <TASK_ID> <ATTEMPT_ID>

Arguments:
  <TASK_ID>     
  <ATTEMPT_ID>  

Options:
      --decision <DECISION>
          Mark the Attempt failed, or run the Task again [possible values: failed, retry]
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --evidence <EVIDENCE>
          What you checked that shows the Attempt stopped and what it did
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --confirmed-stopped
          Confirm that no process of this Attempt is still running
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag task download`

```text
Download the patch or Git bundle published by a successful workspace Task

Usage: supertag task download [OPTIONS] --kind <KIND> --output <OUTPUT> <TASK_ID>

Arguments:
  <TASK_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --kind <KIND>
          Which published result to download [possible values: patch, bundle]
      --output <OUTPUT>
          Local file to create with the download. It must not already exist
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact-publication`

```text
Publish completed artifact files for named destination Objectives, and withdraw them

Usage: supertag artifact-publication [OPTIONS] <COMMAND>

Commands:
  publish   Approve selected completed output for named destination Objectives
  withdraw  Withdraw a publication at its exact revision, so later Tasks cannot use it
  audit     List the recorded events for one publication
  help      Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact-publication publish`

```text
Approve selected completed output for named destination Objectives

Usage: supertag artifact-publication publish [OPTIONS] --path <PATH> --audience <AUDIENCE> <PUBLICATION_ID> <ARTIFACT_ID>

Arguments:
  <PUBLICATION_ID>  
  <ARTIFACT_ID>     

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --path <PATH>
          File in the artifact to publish. Repeat for each file
      --audience <AUDIENCE>
          Destination Objective ID that may use the files. Repeat for each Objective
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --supersedes <SUPERSEDES>
          Earlier publication that this one replaces
  -h, --help
          Print help
```

## `supertag artifact-publication withdraw`

```text
Withdraw a publication at its exact revision, so later Tasks cannot use it

Usage: supertag artifact-publication withdraw [OPTIONS] --expected-revision <EXPECTED_REVISION> <PUBLICATION_ID>

Arguments:
  <PUBLICATION_ID>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact-publication audit`

```text
List the recorded events for one publication

Usage: supertag artifact-publication audit [OPTIONS] <PUBLICATION_ID>

Arguments:
  <PUBLICATION_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact-consumption`

```text
Approve and withdraw a destination Objective's use of a publication

Usage: supertag artifact-consumption [OPTIONS] <COMMAND>

Commands:
  approve   Approve consumption by a destination already in the publication audience
  withdraw  Withdraw a consumption approval at its exact revision
  audit     List the recorded events for one consumption approval
  help      Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact-consumption approve`

```text
Approve consumption by a destination already in the publication audience

Usage: supertag artifact-consumption approve [OPTIONS] <CONSUMPTION_ID> <PUBLICATION_ID> <OBJECTIVE_ID>

Arguments:
  <CONSUMPTION_ID>  
  <PUBLICATION_ID>  
  <OBJECTIVE_ID>    

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact-consumption withdraw`

```text
Withdraw a consumption approval at its exact revision

Usage: supertag artifact-consumption withdraw [OPTIONS] --expected-revision <EXPECTED_REVISION> <CONSUMPTION_ID>

Arguments:
  <CONSUMPTION_ID>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact-consumption audit`

```text
List the recorded events for one consumption approval

Usage: supertag artifact-consumption audit [OPTIONS] <CONSUMPTION_ID>

Arguments:
  <CONSUMPTION_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag volume`

```text
Register Volumes and copy immutable artifact files into explicitly mapped storage

Usage: supertag volume [OPTIONS] <COMMAND>

Commands:
  put       Register a file or S3-compatible Volume. Existing metadata requires its exact revision
  copy      Copy one exact artifact file. The Gateway must separately consent to this Volume's storage
  download  Download and re-verify one recorded copy, including after the Gateway cache is lost
  help      Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag volume put`

```text
Register a file or S3-compatible Volume. Existing metadata requires its exact revision

Usage: supertag volume put [OPTIONS] --source <SOURCE> --operation-id <OPERATION_ID> <VOLUME_ID>

Arguments:
  <VOLUME_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --source <SOURCE>
          Canonical file:///absolute/path or s3://bucket/prefix. The Gateway supplies storage endpoints and credentials
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --expected-revision <EXPECTED_REVISION>
          The revision you last read, or 0 to create. The change is refused when it no longer matches [default: 0]
  -h, --help
          Print help
```

## `supertag volume copy`

```text
Copy one exact artifact file. The Gateway must separately consent to this Volume's storage

Usage: supertag volume copy [OPTIONS] --path <PATH> --expected-revision <EXPECTED_REVISION> --operation-id <OPERATION_ID> <VOLUME_ID> <ARTIFACT_ID>

Arguments:
  <VOLUME_ID>    
  <ARTIFACT_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --path <PATH>
          File in the artifact to copy
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice
  -h, --help
          Print help
```

## `supertag volume download`

```text
Download and re-verify one recorded copy, including after the Gateway cache is lost

Usage: supertag volume download [OPTIONS] --output <OUTPUT> <COPY_ID>

Arguments:
  <COPY_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --output <OUTPUT>
          Local file to create with the verified copy. It must not already exist
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag workspace-volume`

```text
Register a file Volume for read-only Workspace data

Usage: supertag workspace-volume [OPTIONS] <COMMAND>

Commands:
  put   Register a canonical file Volume for Workspace data
  help  Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag workspace-volume put`

```text
Register a canonical file Volume for Workspace data

Usage: supertag workspace-volume put [OPTIONS] --source <SOURCE> <VOLUME_ID>

Arguments:
  <VOLUME_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --source <SOURCE>
          Canonical file:///absolute/path of the data directory
      --expected-revision <EXPECTED_REVISION>
          The revision you last read, or 0 to create. The change is refused when it no longer matches [default: 0]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact`

```text
Download files captured by a Task

Usage: supertag artifact [OPTIONS] <COMMAND>

Commands:
  download  Download one immutable file and verify its digest before publishing it locally
  help      Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag artifact download`

```text
Download one immutable file and verify its digest before publishing it locally

Usage: supertag artifact download [OPTIONS] --path <PATH> --output <OUTPUT> <ARTIFACT_ID>

Arguments:
  <ARTIFACT_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --path <PATH>
          File in the artifact to download
      --output <OUTPUT>
          Local file to create with the verified download. It must not already exist
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag fetch`

```text
Import a Task's or Session's delivered commits as its Session branch in a repository

Usage: supertag fetch [OPTIONS] <ID>

Arguments:
  <ID>  A Task ID, or a Session ID to import that Session's latest delivery

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --tag <TAG>
          The Tag whose Session to import, when more than one Tag has a Session with this ID
      --repository <REPOSITORY>
          The Git repository that receives the Session branch [default: .]
  -h, --help
          Print help
```

## `supertag input`

```text
Resolve a message whose delivery to a running Task is uncertain

Usage: supertag input [OPTIONS] <COMMAND>

Commands:
  resolve  Record a decision and evidence for a message whose delivery is uncertain
  help     Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag input resolve`

```text
Record a decision and evidence for a message whose delivery is uncertain

Usage: supertag input resolve [OPTIONS] --evidence <EVIDENCE> <INPUT_ID> <DECISION>

Arguments:
  <INPUT_ID>  
  <DECISION>  [possible values: fail, retry]

Options:
      --evidence <EVIDENCE>
          What you checked that shows whether the message arrived
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag test`

```text
Check operator settings by sending a sample

Usage: supertag test <COMMAND>

Commands:
  notification  Send a sample notification through every configured destination
  help          Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

## `supertag test notification`

```text
Send a sample notification through every configured destination

Usage: supertag test notification [OPTIONS]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --objective <OBJECTIVE>
          Link the sample to this Objective [default: ""]
  -h, --help
          Print help
```

## `supertag spend`

```text
Report recorded spend by Objective, Tag, or day

Usage: supertag spend [OPTIONS]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --by <BY>
          Group Attempts by Objective (default), Tag, or UTC day claimed [default: objective] [possible values: objective, tag, day]
      --since <SINCE>
          Only Attempts claimed at or after this RFC 3339 time
      --output <OUTPUT>
          Print readable text, or JSON for scripts [default: text] [possible values: text, json]
  -h, --help
          Print help
```

## `supertag metrics`

```text
Read an operational snapshot: resource and Task counts, usage, Worker Host capacity, and Mailbox and reply backlogs

Usage: supertag metrics [OPTIONS]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --output <OUTPUT>
          Print readable text, or JSON for scripts [default: text] [possible values: text, json]
  -h, --help
          Print help
```

## `supertag get`

```text
Read one resource by kind and ID, or list a kind, as JSON

Usage: supertag get [OPTIONS] <COMMAND>

Commands:
  tag                   Read a Tag by its permanent ID, including after retirement, or list active Tags [alias: tags]
  task                  Read a Task [alias: tasks]
  objective             Read one Objective, or list Objectives [alias: objectives]
  team                  Read one Team by ID or name, or list Teams, optionally for one member Tag [alias: teams]
  host                  Read one Worker Host, or list Worker Hosts and their readiness [alias: hosts]
  session               Read one Work Session, its latest Task, and its report, or list the Work Sessions started from a parent Session [alias: sessions]
  role                  Read a Role by ID or name, or list Roles [alias: roles]
  permission-set        Read a Permission Set by ID or name, or list Permission Sets [alias: permission-sets]
  context-set           Read a Context Set by ID or name, or list Context Sets [alias: context-sets]
  volume                Read one Volume, or list registered Volumes [alias: volumes]
  volume-copy           Read one recorded artifact copy, or list them newest first, optionally for one Volume [alias: volume-copies]
  workspace-volume      Read one Workspace data Volume [alias: workspace-volumes]
  workspace             Read one GitHub Workspace source, or list them [alias: workspaces]
  auth-key              Read one Auth Key without its secret, or list Auth Keys, revoked, expired and used ones included [alias: auth-keys]
  operator-token        Read one Operator Token without its secret, or list them. Admin operator token only [alias: operator-tokens]
  artifact              Read an artifact's provenance and exact file manifest, or list the artifacts a Task captured [alias: artifacts]
  artifact-publication  Read one artifact publication, or list those approved from an Objective [alias: artifact-publications]
  artifact-consumption  Read one consumption approval, or list those for a destination Objective [alias: artifact-consumptions]
  github-publication    Read one GitHub publication, or list verified Workspace results and their publication status [alias: github-publications]
  reply                 Read a connector reply, its delivery status, and its audit history, or list replies [alias: replies]
  input                 Read the delivery status and fallback Task of a message sent to a running Task [alias: inputs]
  surface-account       Read one verified connector account, or list them [alias: surface-accounts]
  surface-location      Read one surface location's Tag and policy, or list locations [alias: surface-locations]
  role-assignment       List Role assignments [alias: role-assignments]
  mailbox-grant         List the incoming and outgoing direct message grants of a Tag [alias: mailbox-grants]
  message               List the messages sent to or from a Tag [alias: messages]
  workstream-post       List a Team's newest Workstream posts, or those after a sequence [alias: workstream-posts]
  approval              Read the action, resource, and exact arguments an approval requests, or list approval history [alias: approvals]
  question              Read the full question an Objective Task asked [alias: questions]
  inbox-item            List the questions and work waiting for an operator [alias: inbox-items]
  help                  Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get tag`

```text
Read a Tag by its permanent ID, including after retirement, or list active Tags

Usage: supertag get tag [OPTIONS] [ID]

Arguments:
  [ID]  Tag ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --include-retired
          Also list retired Tags
      --limit <LIMIT>
          Most entries to return on one page [default: 100]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get task`

```text
Read a Task

Usage: supertag get task [OPTIONS] <ID>

Arguments:
  <ID>  Task ID

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get objective`

```text
Read one Objective, or list Objectives

Usage: supertag get objective [OPTIONS] [ID]

Arguments:
  [ID]  Objective ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 20]
      --after-id <AFTER_ID>
          Continue after the last ID the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get team`

```text
Read one Team by ID or name, or list Teams, optionally for one member Tag

Usage: supertag get team [OPTIONS] [ID]

Arguments:
  [ID]  Team ID or name. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --member <MEMBER>
          Only Teams this Tag belongs to [default: ""]
      --limit <LIMIT>
          Most entries to return on one page [default: 32]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get host`

```text
Read one Worker Host, or list Worker Hosts and their readiness

Usage: supertag get host [OPTIONS] [ID]

Arguments:
  [ID]  Worker Host ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 32]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get session`

```text
Read one Work Session, its latest Task, and its report, or list the Work Sessions started from a parent Session

Usage: supertag get session [OPTIONS] [ID]

Arguments:
  [ID]  Work Session ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --report-task <REPORT_TASK>
          Show the child Task associated with this report
      --parent-tag <PARENT_TAG>
          Tag that started the Work Sessions
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --parent-session <PARENT_SESSION>
          Session that started the Work Sessions
      --starter-task <STARTER_TASK>
          Only Work Sessions started by this Task
      --limit <LIMIT>
          Most entries to return on one page [default: 32]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get role`

```text
Read a Role by ID or name, or list Roles

Usage: supertag get role [OPTIONS] [ID]

Arguments:
  [ID]  Role ID or name. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 20]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get permission-set`

```text
Read a Permission Set by ID or name, or list Permission Sets

Usage: supertag get permission-set [OPTIONS] [ID]

Arguments:
  [ID]  Permission Set ID or name. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 20]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get context-set`

```text
Read a Context Set by ID or name, or list Context Sets

Usage: supertag get context-set [OPTIONS] [ID]

Arguments:
  [ID]  Context Set ID or name. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 20]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get volume`

```text
Read one Volume, or list registered Volumes

Usage: supertag get volume [OPTIONS] [ID]

Arguments:
  [ID]  Volume ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 30]
      --after-id <AFTER_ID>
          Continue after the last ID the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get volume-copy`

```text
Read one recorded artifact copy, or list them newest first, optionally for one Volume

Usage: supertag get volume-copy [OPTIONS] [ID]

Arguments:
  [ID]  Copy ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --volume-id <VOLUME_ID>
          Only copies made into this Volume [default: ""]
      --limit <LIMIT>
          Most entries to return on one page [default: 30]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --before-order <BEFORE_ORDER>
          Continue from the next_before_order the previous page returned [default: 0]
  -h, --help
          Print help
```

## `supertag get workspace-volume`

```text
Read one Workspace data Volume

Usage: supertag get workspace-volume [OPTIONS] <ID>

Arguments:
  <ID>  Workspace Volume ID

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get workspace`

```text
Read one GitHub Workspace source, or list them

Usage: supertag get workspace [OPTIONS] [ID]

Arguments:
  [ID]  Workspace ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 50]
      --after-id <AFTER_ID>
          Continue after the last ID the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get auth-key`

```text
Read one Auth Key without its secret, or list Auth Keys, revoked, expired and used ones included

Usage: supertag get auth-key [OPTIONS] [ID]

Arguments:
  [ID]  Auth Key name. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 100]
      --cursor <CURSOR>
          The next_cursor of the previous page [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get operator-token`

```text
Read one Operator Token without its secret, or list them. Admin operator token only

Usage: supertag get operator-token [OPTIONS] [ID]

Arguments:
  [ID]  Operator Token name. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 50]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get artifact`

```text
Read an artifact's provenance and exact file manifest, or list the artifacts a Task captured

Usage: supertag get artifact [OPTIONS] [ID]

Arguments:
  [ID]  Artifact ID. Omit to list with --task

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --task <TASK>
          Task whose artifacts to list
      --limit <LIMIT>
          Most entries to return on one page [default: 50]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --before-order <BEFORE_ORDER>
          Continue from the next_before_order the previous page returned [default: 0]
  -h, --help
          Print help
```

## `supertag get artifact-publication`

```text
Read one artifact publication, or list those approved from an Objective

Usage: supertag get artifact-publication [OPTIONS] [ID]

Arguments:
  [ID]  Publication ID. Omit to list with --objective

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --objective <OBJECTIVE>
          Objective whose approvals to list
      --limit <LIMIT>
          Most entries to return on one page [default: 30]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --before-order <BEFORE_ORDER>
          Continue from the next_before_order the previous page returned [default: 0]
  -h, --help
          Print help
```

## `supertag get artifact-consumption`

```text
Read one consumption approval, or list those for a destination Objective

Usage: supertag get artifact-consumption [OPTIONS] [ID]

Arguments:
  [ID]  Consumption ID. Omit to list with --objective

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --objective <OBJECTIVE>
          Objective whose approvals to list
      --limit <LIMIT>
          Most entries to return on one page [default: 30]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --before-order <BEFORE_ORDER>
          Continue from the next_before_order the previous page returned [default: 0]
  -h, --help
          Print help
```

## `supertag get github-publication`

```text
Read one GitHub publication, or list verified Workspace results and their publication status

Usage: supertag get github-publication [OPTIONS] [ID]

Arguments:
  [ID]  Publication ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --task-id <TASK_ID>
          Only results of this Task [default: ""]
      --limit <LIMIT>
          Most entries to return on one page [default: 50]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --before-order <BEFORE_ORDER>
          Continue from the next_before_order the previous page returned [default: 0]
  -h, --help
          Print help
```

## `supertag get reply`

```text
Read a connector reply, its delivery status, and its audit history, or list replies

Usage: supertag get reply [OPTIONS] [ID]

Arguments:
  [ID]  Reply ID. Omit to list

Options:
      --account <ACCOUNT>
          Only replies sent through this connector account [default: ""]
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state <STATE>
          Only replies in this delivery state [possible values: pending, claimed, delivered, failed, uncertain]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --limit <LIMIT>
          Most entries to return on one page [default: 50]
      --before-order <BEFORE_ORDER>
          Continue with next_before_order from the previous page [default: 0]
  -h, --help
          Print help
```

## `supertag get input`

```text
Read the delivery status and fallback Task of a message sent to a running Task

Usage: supertag get input [OPTIONS] <ID>

Arguments:
  <ID>  Input ID, as `task input` printed it

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get surface-account`

```text
Read one verified connector account, or list them

Usage: supertag get surface-account [OPTIONS] [ID]

Arguments:
  [ID]  Surface Account ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 20]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get surface-location`

```text
Read one surface location's Tag and policy, or list locations

Usage: supertag get surface-location [OPTIONS] [ID]

Arguments:
  [ID]  Surface Location ID. Omit to list

Options:
      --account <ACCOUNT>
          Only locations of this account [default: ""]
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 20]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get role-assignment`

```text
List Role assignments

Usage: supertag get role-assignment [OPTIONS]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --role <ROLE>
          Only assignments of this Role [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --tag <TAG>
          Only assignments to this Tag [default: ""]
      --active
          Only assignments in effect now
      --limit <LIMIT>
          Most entries to return on one page [default: 20]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get mailbox-grant`

```text
List the incoming and outgoing direct message grants of a Tag

Usage: supertag get mailbox-grant [OPTIONS] --tag <TAG>

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --tag <TAG>
          The Tag whose incoming and outgoing grants to list
      --limit <LIMIT>
          Most entries to return on one page [default: 32]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get message`

```text
List the messages sent to or from a Tag

Usage: supertag get message [OPTIONS] --mailbox <MAILBOX>

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --mailbox <MAILBOX>
          The Tag whose sent and received messages to list
      --limit <LIMIT>
          Most entries to return on one page [default: 32]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get workstream-post`

```text
List a Team's newest Workstream posts, or those after a sequence

Usage: supertag get workstream-post [OPTIONS] --team <TEAM>

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --team <TEAM>
          The Team whose Workstream to read, by ID or name
      --after-sequence <AFTER_SEQUENCE>
          Continue after this post sequence instead of reading the newest posts
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --limit <LIMIT>
          Most entries to return on one page [default: 16]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get approval`

```text
Read the action, resource, and exact arguments an approval requests, or list approval history

Usage: supertag get approval [OPTIONS] [ID]

Arguments:
  [ID]  Approval ID. Omit to list

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --objective <OBJECTIVE>
          Only approvals for this Objective [default: ""]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --task <TASK>
          Only approvals requested by this Task [default: ""]
      --pending
          Only requests that still wait for a decision
      --limit <LIMIT>
          Most entries to return on one page [default: 20]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag get question`

```text
Read the full question an Objective Task asked

Usage: supertag get question [OPTIONS] <ID>

Arguments:
  <ID>  The ID of the Task that asked

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag get inbox-item`

```text
List the questions and work waiting for an operator

Usage: supertag get inbox-item [OPTIONS]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --objective <OBJECTIVE>
          Only items for this Objective [default: ""]
      --kind <KIND>
          Only items of this kind [possible values: question, budget, limit, task-attention, approval, mcp-login]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --limit <LIMIT>
          Most entries to return on one page [default: 50]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag describe`

```text
Describe one resource in readable text

Usage: supertag describe [OPTIONS] <KIND> <ID>

Arguments:
  <KIND>  The kind of resource. Only kinds read by ID can be described [possible values: tag, task, objective, team, host, session, role, permission-set, context-set, volume, volume-copy, workspace-volume, workspace, auth-key, operator-token, artifact, artifact-publication, artifact-consumption, github-publication, reply, input, surface-account, surface-location, approval, question]
  <ID>    The resource's ID or name

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --output <OUTPUT>
          Print readable text, or JSON for scripts [default: text] [possible values: text, json]
  -h, --help
          Print help
```

## `supertag delete`

```text
Delete one resource by kind and ID

Usage: supertag delete [OPTIONS] <COMMAND>

Commands:
  team              Delete a Team and its Workstream after its Objectives close [alias: teams]
  permission-set    Delete an unused Permission Set [alias: permission-sets]
  context-set       Delete an unused Context Set [alias: context-sets]
  volume            Remove a Volume's metadata when no reserved or verified copies depend on it [alias: volumes]
  workspace         Delete a GitHub Workspace source at its exact revision [alias: workspaces]
  surface-location  Remove a location's policy and stop new work on its connector alias [alias: surface-locations]
  help              Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag delete team`

```text
Delete a Team and its Workstream after its Objectives close

Usage: supertag delete team [OPTIONS] <ID>

Arguments:
  <ID>  Team ID or name

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag delete permission-set`

```text
Delete an unused Permission Set

Usage: supertag delete permission-set [OPTIONS] --expected-revision <EXPECTED_REVISION> <ID>

Arguments:
  <ID>  Permission Set ID or name

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag delete context-set`

```text
Delete an unused Context Set

Usage: supertag delete context-set [OPTIONS] --expected-revision <EXPECTED_REVISION> <ID>

Arguments:
  <ID>  Context Set ID or name

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag delete volume`

```text
Remove a Volume's metadata when no reserved or verified copies depend on it

Usage: supertag delete volume [OPTIONS] --operation-id <OPERATION_ID> --expected-revision <EXPECTED_REVISION> <ID>

Arguments:
  <ID>  Volume ID

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag delete workspace`

```text
Delete a GitHub Workspace source at its exact revision

Usage: supertag delete workspace [OPTIONS] --expected-revision <EXPECTED_REVISION> <ID>

Arguments:
  <ID>  Workspace ID

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag delete surface-location`

```text
Remove a location's policy and stop new work on its connector alias

Usage: supertag delete surface-location [OPTIONS] --expected-revision <EXPECTED_REVISION> <ID>

Arguments:
  <ID>  Surface Location ID

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag watch`

```text
Stream change notices, reconnecting from the last resume token

Usage: supertag watch [OPTIONS] [KIND]...

Arguments:
  [KIND]...  Only these kinds of change; omit for every kind. `watch objective ID` follows one Objective's progress as a timeline until it closes [possible values: tag, task, conversation-message, objective, team, workstream-post]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --settle-seconds <SETTLE_SECONDS>
          With `watch objective ID`: seconds to wait after the Objective closes for its running Sessions to record their turns [default: 10]
      --resume-token <RESUME_TOKEN>
          Continue after the last notice a previous watch printed
      --limit <LIMIT>
          Stop after this many change notices
      --reconnect-seconds <RECONNECT_SECONDS>
          Seconds to keep reconnecting with the last resume token after the connection drops. Zero exits on the first disconnect [default: 60]
      --output <OUTPUT>
          Print readable text, or JSON for scripts [default: text] [possible values: text, json]
  -h, --help
          Print help
```

## `supertag objective`

```text
Manage an Objective and inspect its owner's work

Usage: supertag objective [OPTIONS] <COMMAND>

Commands:
  create               Record an Objective and queue the owner's first Task
  commit-reviews       List commit review requests and recorded verdicts for an Objective
  set-limits           Change the deadline or monetary limit
  set-runtime-actions  Replace the runtime-action ceiling for future Objective turns
  pause                Pause the Objective. Resuming it later queues an owner turn that reports what happened
  resume               Resume a paused Objective
  cancel               Cancel the Objective and its open Tasks
  review               Approve the owner's assessment of an Objective ready for review, or request changes with feedback the owner works from
  complete             Complete an open Objective, ongoing or not, with an assessment of its outcome and the results that support it. Its open Tasks are cancelled
  help                 Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag objective create`

```text
Record an Objective and queue the owner's first Task

Usage: supertag objective create [OPTIONS] --owner <OWNER> <OBJECTIVE_ID> <OUTCOME>

Arguments:
  <OBJECTIVE_ID>  
  <OUTCOME>       

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --owner <OWNER>
          Tag that owns the Objective until it is met
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --team <TEAM>
          Optional Team ID or name
      --ongoing
          An ongoing responsibility with no finish, instead of an outcome that completes
      --deadline <DEADLINE>
          RFC 3339 time with a time zone by which the outcome is due
      --budget-minor <BUDGET_MINOR>
          Spending limit in minor currency units, such as cents. Requires --currency
      --currency <CURRENCY>
          Three-letter currency of the spending limit
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --runtime-action <RUNTIME_ACTIONS>
          Narrow runtime actions to this list; repeat for each allowed action
      --no-runtime-actions
          Create the Objective with no runtime actions
  -h, --help
          Print help
```

## `supertag objective commit-reviews`

```text
List commit review requests and recorded verdicts for an Objective

Usage: supertag objective commit-reviews [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --limit <LIMIT>
          Most entries to return on one page [default: 50]
      --before-order <BEFORE_ORDER>
          Continue from the next_before_order the previous page returned [default: 0]
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag objective set-limits`

```text
Change the deadline or monetary limit

Usage: supertag objective set-limits [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --deadline <DEADLINE>
          New RFC 3339 deadline with a time zone
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --clear-deadline
          Remove the deadline
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --budget-minor <BUDGET_MINOR>
          New spending limit in minor currency units, such as cents
      --currency <CURRENCY>
          Three-letter currency of the spending limit
      --clear-budget
          Remove the spending limit
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag objective set-runtime-actions`

```text
Replace the runtime-action ceiling for future Objective turns

Usage: supertag objective set-runtime-actions [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --runtime-action <RUNTIME_ACTIONS>
          Runtime action future turns may use. Repeat for each action
      --no-runtime-actions
          Allow no runtime actions in future turns
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag objective pause`

```text
Pause the Objective. Resuming it later queues an owner turn that reports what happened

Usage: supertag objective pause [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --reason <REASON>
          Why, recorded in the Objective history [default: ""]
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag objective resume`

```text
Resume a paused Objective

Usage: supertag objective resume [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --reason <REASON>
          Why, recorded in the Objective history [default: ""]
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag objective cancel`

```text
Cancel the Objective and its open Tasks

Usage: supertag objective cancel [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --reason <REASON>
          Why, recorded in the Objective history [default: ""]
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag objective review`

```text
Approve the owner's assessment of an Objective ready for review, or request changes with feedback the owner works from

Usage: supertag objective review [OPTIONS] <OBJECTIVE_ID> <DECISION>

Arguments:
  <OBJECTIVE_ID>  
  <DECISION>      [possible values: approve, request-changes]

Options:
      --feedback <FEEDBACK>
          What to change; required to request changes, refused on approval [default: ""]
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag objective complete`

```text
Complete an open Objective, ongoing or not, with an assessment of its outcome and the results that support it. Its open Tasks are cancelled

Usage: supertag objective complete [OPTIONS] --summary-file <SUMMARY_FILE> <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --summary-file <SUMMARY_FILE>
          File holding the assessment; `-` reads standard input
      --expected-revision <EXPECTED_REVISION>
          Refuse when the Objective changed since this revision
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```
