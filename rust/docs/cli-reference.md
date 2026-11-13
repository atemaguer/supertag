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
  diff                  Preview an organization manifest through the Gateway
  apply                 Apply an organization manifest through the Gateway
  github-publication    Read GitHub publications of verified Workspace results and stop further provider writes
  github-workspace      Manage GitHub Workspace sources pinned to one repository and commit
  replies               Inspect connector deliveries and resolve uncertain replies from provider evidence
  policy                Manage reusable Permission Sets, Context Sets, and Roles
  surface-policy        Bind verified connector accounts and locations to Tag policy
  gateway-credential    Store or delete Gateway collaboration credentials in the configured credential vault
  host                  Read Worker Host readiness and manage draining
  placement             Choose which labelled Worker Hosts run a Tag, and explain waiting Tasks
  inbox                 Read and answer work waiting on an operator
  mcp                   List this host's catalog MCP servers and log in to OAuth servers
  mailbox               Read the messages sent to or from a Tag
  mailbox-grants        Manage permission to send direct messages between Tags
  work-sessions         Read the Work Sessions started by a Tag
  operator-token        Issue, list, rotate, and revoke named Operator Tokens. Admin operator token only
  audit                 List recorded operator changes, newest first, with actor, action, target, and outcome
  team                  Manage Teams and read their Workstream posts
  init                  Set up SuperTag on this machine for the git repository in the current directory
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
  create-auth-key       Create a scoped Auth Key: one-time for a named Worker Host, or reusable
  revoke-auth-key       Stop an Auth Key from enrolling more Worker Hosts. Hosts that joined stay enrolled
  enroll-host           Enroll this installation with a one-time Auth Key
  revoke-host           Revoke a Worker Host and its execution authority
  put-tag               Set the instructions and allowed actions for a Tag
  get-tag               Inspect a Tag by its permanent ID, including after retirement
  list-tags             List active Tags and optionally include retired identities
  retire-tag            Retire a Tag by ID while preserving its work history
  submit                Accept one turn of work in a Tag's Session
  get-task              Read a Task
  artifact-publication  Approve and withdraw explicit cross-Objective artifact reuse
  volume                Register Volumes and copy immutable artifact files into explicitly mapped storage
  workspace-volume      Register or inspect a file Volume for read-only Workspace data
  artifact              Inspect or download files captured by a Task
  workspace-artifact    Download the patch or Git bundle published by a successful workspace Task
  task-events           Read a page of recorded Task events
  task-usage            Read native token usage recorded for a Task Attempt
  cancel                Cancel a Task
  resolve-attempt       Record an audited decision for a stopped, uncertain Task Attempt
  input                 Direct input into an active Task and inspect its delivery
  spend                 Report recorded spend by Objective, Tag, or day
  describe              Describe one resource in readable text
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
Read GitHub publications of verified Workspace results and stop further provider writes

Usage: supertag github-publication [OPTIONS] <COMMAND>

Commands:
  list    List verified Workspace results and their separate GitHub publication status
  get     Read one GitHub publication
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

## `supertag github-publication list`

```text
List verified Workspace results and their separate GitHub publication status

Usage: supertag github-publication list [OPTIONS]

Options:
      --task-id <TASK_ID>            Only results of this Task [default: ""]
      --limit <LIMIT>                Most entries to return on one page [default: 50]
      --before-order <BEFORE_ORDER>  Continue from the next_before_order the previous page returned [default: 0]
  -h, --help                         Print help
```

## `supertag github-publication get`

```text
Read one GitHub publication

Usage: supertag github-publication get <PUBLICATION_ID>

Arguments:
  <PUBLICATION_ID>  

Options:
  -h, --help  Print help
```

## `supertag github-publication cancel`

```text
Stop further provider writes. This does not delete a branch or close a PR

Usage: supertag github-publication cancel [OPTIONS] --reason <REASON> <PUBLICATION_ID>

Arguments:
  <PUBLICATION_ID>  

Options:
      --reason <REASON>              Why provider writes stop; recorded with the cancellation
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag github-workspace`

```text
Manage GitHub Workspace sources pinned to one repository and commit

Usage: supertag github-workspace [OPTIONS] <COMMAND>

Commands:
  put     Select a GitHub source. Moving revisions are pinned once per Session. Credentials stay on the Gateway
  get     Read one GitHub Workspace source
  list    List GitHub Workspace sources
  delete  Delete a GitHub Workspace source at its exact revision
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag github-workspace put`

```text
Select a GitHub source. Moving revisions are pinned once per Session. Credentials stay on the Gateway

Usage: supertag github-workspace put [OPTIONS] --account <ACCOUNT> --repository-id <REPOSITORY_ID> --repository <REPOSITORY> <WORKSPACE_ID>

Arguments:
  <WORKSPACE_ID>  

Options:
      --account <ACCOUNT>
          Configured GitHub account that reads the repository
      --repository-id <REPOSITORY_ID>
          Numeric GitHub repository ID, which survives renames
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

## `supertag github-workspace get`

```text
Read one GitHub Workspace source

Usage: supertag github-workspace get <WORKSPACE_ID>

Arguments:
  <WORKSPACE_ID>  

Options:
  -h, --help  Print help
```

## `supertag github-workspace list`

```text
List GitHub Workspace sources

Usage: supertag github-workspace list [OPTIONS]

Options:
      --limit <LIMIT>        Most entries to return on one page [default: 50]
      --after-id <AFTER_ID>  Continue after the last ID the previous page returned [default: ""]
  -h, --help                 Print help
```

## `supertag github-workspace delete`

```text
Delete a GitHub Workspace source at its exact revision

Usage: supertag github-workspace delete [OPTIONS] --expected-revision <EXPECTED_REVISION> <WORKSPACE_ID>

Arguments:
  <WORKSPACE_ID>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag replies`

```text
Inspect connector deliveries and resolve uncertain replies from provider evidence

Usage: supertag replies [OPTIONS] <COMMAND>

Commands:
  list     List connector replies and their recorded delivery status
  get      Read a reply, its delivery status, and its audit history
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

## `supertag replies list`

```text
List connector replies and their recorded delivery status

Usage: supertag replies list [OPTIONS]

Options:
      --account <ACCOUNT>            Only replies sent through this connector account [default: ""]
      --state <STATE>                Only replies in this delivery state [possible values: pending, claimed, delivered, failed, uncertain]
      --limit <LIMIT>                Most entries to return on one page [default: 50]
      --before-order <BEFORE_ORDER>  Continue with next_before_order from the previous page [default: 0]
  -h, --help                         Print help
```

## `supertag replies get`

```text
Read a reply, its delivery status, and its audit history

Usage: supertag replies get <REPLY_ID>

Arguments:
  <REPLY_ID>  

Options:
  -h, --help  Print help
```

## `supertag replies resolve`

```text
Record verified delivery or failure for an uncertain reply. This never resends it

Usage: supertag replies resolve [OPTIONS] --decision <DECISION> --evidence <EVIDENCE> <REPLY_ID>

Arguments:
  <REPLY_ID>  

Options:
      --decision <DECISION>
          What the provider shows happened to the reply [possible values: delivered, failed]
      --evidence <EVIDENCE>
          What you checked at the provider that shows the outcome
      --provider-receipt <PROVIDER_RECEIPT>
          Required for a delivered decision; identifies the observed provider response
      --operation-id <OPERATION_ID>
          Reuse this ID when retrying after a lost response
  -h, --help
          Print help
```

## `supertag policy`

```text
Manage reusable Permission Sets, Context Sets, and Roles

Usage: supertag policy [OPTIONS] <COMMAND>

Commands:
  put          Create or replace a catalog resource from a JSON specification
  show         Read a catalog resource by ID or name
  list         List catalog resources
  delete-set   Delete an unused Permission Set or Context Set
  assign       Assign an active Role to a Tag
  assignments  List Role assignments
  deactivate   Deactivate a Role assignment
  help         Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag policy put`

```text
Create or replace a catalog resource from a JSON specification

Usage: supertag policy put [OPTIONS] <KIND> <FILE>

Arguments:
  <KIND>  [possible values: permission-set, context-set, role]
  <FILE>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag policy show`

```text
Read a catalog resource by ID or name

Usage: supertag policy show <KIND> <REFERENCE>

Arguments:
  <KIND>       [possible values: permission-set, context-set, role]
  <REFERENCE>  

Options:
  -h, --help  Print help
```

## `supertag policy list`

```text
List catalog resources

Usage: supertag policy list [OPTIONS] <KIND>

Arguments:
  <KIND>  [possible values: permission-set, context-set, role]

Options:
      --limit <LIMIT>    Most entries to return on one page [default: 20]
      --cursor <CURSOR>  Continue from the cursor the previous page returned [default: ""]
  -h, --help             Print help
```

## `supertag policy delete-set`

```text
Delete an unused Permission Set or Context Set

Usage: supertag policy delete-set [OPTIONS] --expected-revision <EXPECTED_REVISION> <KIND> <REFERENCE>

Arguments:
  <KIND>       [possible values: permission-set, context-set, role]
  <REFERENCE>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag policy assign`

```text
Assign an active Role to a Tag

Usage: supertag policy assign [OPTIONS] <ROLE> <TAG_ID>

Arguments:
  <ROLE>    
  <TAG_ID>  

Options:
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag policy assignments`

```text
List Role assignments

Usage: supertag policy assignments [OPTIONS]

Options:
      --role <ROLE>      Only assignments of this Role [default: ""]
      --tag <TAG>        Only assignments to this Tag [default: ""]
      --active           Only assignments in effect now
      --limit <LIMIT>    Most entries to return on one page [default: 20]
      --cursor <CURSOR>  Continue from the cursor the previous page returned [default: ""]
  -h, --help             Print help
```

## `supertag policy deactivate`

```text
Deactivate a Role assignment

Usage: supertag policy deactivate [OPTIONS] --expected-revision <EXPECTED_REVISION> <ASSIGNMENT_ID>

Arguments:
  <ASSIGNMENT_ID>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag surface-policy`

```text
Bind verified connector accounts and locations to Tag policy

Usage: supertag surface-policy [OPTIONS] <COMMAND>

Commands:
  put              Create or update an account or location from a JSON specification
  show             Read an account or location by ID
  list             List accounts or locations
  delete-location  Remove a location's policy and stop new work on its connector alias
  help             Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help

A location applies to its exact configured Gateway connector account alias. Other aliases use their own policy. Configure a separate alias for each location. The Gateway owns provider credentials.
```

## `supertag surface-policy put`

```text
Create or update an account or location from a JSON specification

Usage: supertag surface-policy put [OPTIONS] <RESOURCE> <FILE>

Arguments:
  <RESOURCE>  [possible values: account, location]
  <FILE>      

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. If given, the change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag surface-policy show`

```text
Read an account or location by ID

Usage: supertag surface-policy show <RESOURCE> <ID>

Arguments:
  <RESOURCE>  [possible values: account, location]
  <ID>        

Options:
  -h, --help  Print help
```

## `supertag surface-policy list`

```text
List accounts or locations

Usage: supertag surface-policy list [OPTIONS] <RESOURCE>

Arguments:
  <RESOURCE>  [possible values: account, location]

Options:
      --account <ACCOUNT>  Restrict locations to one account
      --limit <LIMIT>      Most entries to return on one page [default: 20]
      --cursor <CURSOR>    Continue from the cursor the previous page returned [default: ""]
  -h, --help               Print help
```

## `supertag surface-policy delete-location`

```text
Remove a location's policy and stop new work on its connector alias

Usage: supertag surface-policy delete-location [OPTIONS] --expected-revision <EXPECTED_REVISION> <ID>

Arguments:
  <ID>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
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
Read Worker Host readiness and manage draining

Usage: supertag host [OPTIONS] <COMMAND>

Commands:
  list    List Worker Hosts and their readiness
  get     Read one Worker Host
  drain   Stop assigning new Tasks while the Worker Host finishes current work
  resume  Allow the Worker Host to claim new Tasks again
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag host list`

```text
List Worker Hosts and their readiness

Usage: supertag host list [OPTIONS]

Options:
      --limit <LIMIT>    Most entries to return on one page [default: 32]
      --cursor <CURSOR>  Continue from the cursor the previous page returned [default: ""]
  -h, --help             Print help
```

## `supertag host get`

```text
Read one Worker Host

Usage: supertag host get <HOST_ID>

Arguments:
  <HOST_ID>  

Options:
  -h, --help  Print help
```

## `supertag host drain`

```text
Stop assigning new Tasks while the Worker Host finishes current work

Usage: supertag host drain <HOST_ID>

Arguments:
  <HOST_ID>  

Options:
  -h, --help  Print help
```

## `supertag host resume`

```text
Allow the Worker Host to claim new Tasks again

Usage: supertag host resume <HOST_ID>

Arguments:
  <HOST_ID>  

Options:
  -h, --help  Print help
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

Usage: supertag placement runs-on <TAG_ID> [LABELS]...

Arguments:
  <TAG_ID>     
  [LABELS]...  Required labels. Omit every label to allow any bound host

Options:
  -h, --help  Print help
```

## `supertag placement explain`

```text
Explain which bound Worker Hosts can take a Task, and why others cannot

Usage: supertag placement explain <TASK_ID>

Arguments:
  <TASK_ID>  

Options:
  -h, --help  Print help
```

## `supertag inbox`

```text
Read and answer work waiting on an operator

Usage: supertag inbox [OPTIONS] <COMMAND>

Commands:
  list       List questions and work waiting for an operator
  question   Read the full question from an Objective Task
  answer     Answer an Objective question in the owner's Session
  approval   Inspect the action, resource, and exact arguments requested
  approvals  List approval history
  approve    Approve the exact requested action once or for its Objective
  deny       Deny a pending approval request
  help       Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag inbox list`

```text
List questions and work waiting for an operator

Usage: supertag inbox list [OPTIONS]

Options:
      --objective <OBJECTIVE>  Only items for this Objective [default: ""]
      --kind <KIND>            Only items of this kind [possible values: question, budget, limit, task-attention, approval, mcp-login]
      --limit <LIMIT>          Most entries to return on one page [default: 50]
      --cursor <CURSOR>        Continue from the cursor the previous page returned [default: ""]
  -h, --help                   Print help
```

## `supertag inbox question`

```text
Read the full question from an Objective Task

Usage: supertag inbox question <TASK_ID>

Arguments:
  <TASK_ID>  

Options:
  -h, --help  Print help
```

## `supertag inbox answer`

```text
Answer an Objective question in the owner's Session

Usage: supertag inbox answer [OPTIONS] <TASK_ID> <TEXT>

Arguments:
  <TASK_ID>  
  <TEXT>     

Options:
      --operation-id <OPERATION_ID>  Supply the same ID to retry an answer after a lost response
  -h, --help                         Print help
```

## `supertag inbox approval`

```text
Inspect the action, resource, and exact arguments requested

Usage: supertag inbox approval <APPROVAL_ID>

Arguments:
  <APPROVAL_ID>  

Options:
  -h, --help  Print help
```

## `supertag inbox approvals`

```text
List approval history

Usage: supertag inbox approvals [OPTIONS]

Options:
      --objective <OBJECTIVE>  Only items for this Objective [default: ""]
      --task <TASK>            Only approvals requested by this Task [default: ""]
      --pending                Only requests that still wait for a decision
      --limit <LIMIT>          Most entries to return on one page [default: 20]
      --cursor <CURSOR>        Continue from the cursor the previous page returned [default: ""]
  -h, --help                   Print help
```

## `supertag inbox approve`

```text
Approve the exact requested action once or for its Objective

Usage: supertag inbox approve [OPTIONS] <APPROVAL_ID>

Arguments:
  <APPROVAL_ID>  

Options:
      --objective-scope
          Allow this Tag's Workstream posts to the same Team for this Objective
      --valid-until-ms <VALID_UNTIL_MS>
          End of the approval, in milliseconds since the Unix epoch. Omit for no end
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag inbox deny`

```text
Deny a pending approval request

Usage: supertag inbox deny [OPTIONS] --reason <REASON> <APPROVAL_ID>

Arguments:
  <APPROVAL_ID>  

Options:
      --reason <REASON>              Why the request is denied; the Tag sees this reason
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
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

## `supertag mailbox`

```text
Read the messages sent to or from a Tag

Usage: supertag mailbox [OPTIONS] <TAG_ID>

Arguments:
  <TAG_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --limit <LIMIT>
          Most entries to return on one page [default: 32]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag mailbox-grants`

```text
Manage permission to send direct messages between Tags

Usage: supertag mailbox-grants [OPTIONS] <COMMAND>

Commands:
  allow   Allow one Tag to send direct messages to another Tag
  revoke  Remove a directional grant; shared Team membership still permits messages
  list    List the incoming and outgoing direct message grants for a Tag
  help    Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag mailbox-grants allow`

```text
Allow one Tag to send direct messages to another Tag

Usage: supertag mailbox-grants allow [OPTIONS] <SENDER_TAG_ID> <RECIPIENT_TAG_ID>

Arguments:
  <SENDER_TAG_ID>     
  <RECIPIENT_TAG_ID>  

Options:
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag mailbox-grants revoke`

```text
Remove a directional grant; shared Team membership still permits messages

Usage: supertag mailbox-grants revoke [OPTIONS] <SENDER_TAG_ID> <RECIPIENT_TAG_ID>

Arguments:
  <SENDER_TAG_ID>     
  <RECIPIENT_TAG_ID>  

Options:
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag mailbox-grants list`

```text
List the incoming and outgoing direct message grants for a Tag

Usage: supertag mailbox-grants list [OPTIONS] <TAG_ID>

Arguments:
  <TAG_ID>  

Options:
      --limit <LIMIT>    Most entries to return on one page [default: 32]
      --cursor <CURSOR>  Continue from the cursor the previous page returned [default: ""]
  -h, --help             Print help
```

## `supertag work-sessions`

```text
Read the Work Sessions started by a Tag

Usage: supertag work-sessions [OPTIONS] <COMMAND>

Commands:
  get   Show one Work Session, its latest Task, and its report
  list  List the Work Sessions started from a parent Session
  help  Print this message or the help of the given subcommand(s)

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag work-sessions get`

```text
Show one Work Session, its latest Task, and its report

Usage: supertag work-sessions get [OPTIONS] <WORK_SESSION_ID>

Arguments:
  <WORK_SESSION_ID>  

Options:
      --report-task <REPORT_TASK>  Show the child Task associated with this report
  -h, --help                       Print help
```

## `supertag work-sessions list`

```text
List the Work Sessions started from a parent Session

Usage: supertag work-sessions list [OPTIONS] --parent-tag <PARENT_TAG> --parent-session <PARENT_SESSION>

Options:
      --parent-tag <PARENT_TAG>
          Tag that started the Work Sessions
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

## `supertag operator-token`

```text
Issue, list, rotate, and revoke named Operator Tokens. Admin operator token only

Usage: supertag operator-token [OPTIONS] <COMMAND>

Commands:
  create  Issue a named Operator Token and print its secret once
  list    List Operator Tokens without their secrets
  get     Read one Operator Token without its secret
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

Usage: supertag operator-token create <NAME>

Arguments:
  <NAME>
          

Options:
  -h, --help
          Print help (see a summary with '-h')
```

## `supertag operator-token list`

```text
List Operator Tokens without their secrets

Usage: supertag operator-token list [OPTIONS]

Options:
      --limit <LIMIT>    Most entries to return on one page [default: 50]
      --cursor <CURSOR>  Continue from the cursor the previous page returned [default: ""]
  -h, --help             Print help
```

## `supertag operator-token get`

```text
Read one Operator Token without its secret

Usage: supertag operator-token get <NAME>

Arguments:
  <NAME>  

Options:
  -h, --help  Print help
```

## `supertag operator-token rotate`

```text
Replace the secret, print the new one once, and refuse the old one from now on

Usage: supertag operator-token rotate <NAME>

Arguments:
  <NAME>  

Options:
  -h, --help  Print help
```

## `supertag operator-token revoke`

```text
Refuse the token from now on, including in calls and streams already open

Usage: supertag operator-token revoke <NAME>

Arguments:
  <NAME>  

Options:
  -h, --help  Print help
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
  get     Read one Team by ID or name
  list    List Teams, optionally for one member Tag
  update  Replace the selected fields of a Team
  delete  Delete a Team and its Workstream after its Objectives close
  posts   Read the newest Workstream posts or continue from a sequence
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
      --name <NAME>
          Display name. Defaults to the Team ID
      --member <MEMBER>
          Member Tag ID. Repeat for each member
      --max-concurrency <MAX_CONCURRENCY>
          Most Tasks the Team runs at once. Omit for no Team limit
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag team get`

```text
Read one Team by ID or name

Usage: supertag team get <TEAM>

Arguments:
  <TEAM>  

Options:
  -h, --help  Print help
```

## `supertag team list`

```text
List Teams, optionally for one member Tag

Usage: supertag team list [OPTIONS]

Options:
      --member <MEMBER>  Only Teams this Tag belongs to [default: ""]
      --limit <LIMIT>    Most entries to return on one page [default: 32]
      --cursor <CURSOR>  Continue from the cursor the previous page returned [default: ""]
  -h, --help             Print help
```

## `supertag team update`

```text
Replace the selected fields of a Team

Usage: supertag team update [OPTIONS] <TEAM>

Arguments:
  <TEAM>  

Options:
      --name <NAME>
          New display name
      --member <MEMBER>
          Replace the members with these Tag IDs. Repeat for each member
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

## `supertag team delete`

```text
Delete a Team and its Workstream after its Objectives close

Usage: supertag team delete [OPTIONS] <TEAM>

Arguments:
  <TEAM>  

Options:
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag team posts`

```text
Read the newest Workstream posts or continue from a sequence

Usage: supertag team posts [OPTIONS] <TEAM>

Arguments:
  <TEAM>  

Options:
      --after-sequence <AFTER_SEQUENCE>
          Continue after this post sequence instead of reading the newest posts
      --limit <LIMIT>
          Most entries to return on one page [default: 16]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
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
          Repository identity that this host can prepare for accepted Tasks

      --workspace-source <WORKSPACE_SOURCE>
          Trusted local Git source; Tasks run in separate pinned checkouts

      --workspace-from-gateway
          Retrieve this Workspace's accepted GitHub source from the Gateway

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
      --listen <LISTEN>  Address this service listens on. Port 0 picks a free port [default: 127.0.0.1:0]
  -h, --help             Print help
```

## `supertag gateway`

```text
Run the public gRPC service for operators and Worker Hosts

Usage: supertag gateway [OPTIONS] --control-plane <CONTROL_PLANE>

Options:
      --listen <LISTEN>
          Address this service listens on. Port 0 picks a free port
          
          [default: 127.0.0.1:0]

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
          Private scratch for GitHub source bundles, using the configured GitHub account

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
          Repository identity that this host can prepare for accepted Tasks

      --workspace-source <WORKSPACE_SOURCE>
          Trusted local Git source; Tasks run in separate pinned checkouts

      --workspace-from-gateway
          Retrieve this Workspace's accepted GitHub source from the Gateway

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

## `supertag create-auth-key`

```text
Create a scoped Auth Key: one-time for a named Worker Host, or reusable

Usage: supertag create-auth-key [OPTIONS] [HOST_ID]

Arguments:
  [HOST_ID]  Worker Host ID for a one-time key. Omit with --reusable

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --reusable
          Enroll any number of Worker Hosts, each choosing its own ID
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

## `supertag revoke-auth-key`

```text
Stop an Auth Key from enrolling more Worker Hosts. Hosts that joined stay enrolled

Usage: supertag revoke-auth-key [OPTIONS] <KEY_ID>

Arguments:
  <KEY_ID>  The key_id that create-auth-key printed

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag enroll-host`

```text
Enroll this installation with a one-time Auth Key

Usage: supertag enroll-host [OPTIONS] --gateway <GATEWAY> --state-directory <STATE_DIRECTORY> <HOST_ID>

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

## `supertag revoke-host`

```text
Revoke a Worker Host and its execution authority

Usage: supertag revoke-host [OPTIONS] <HOST_ID>

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

## `supertag put-tag`

```text
Set the instructions and allowed actions for a Tag

Usage: supertag put-tag [OPTIONS] --instructions <INSTRUCTIONS> <TAG_ID>

Arguments:
  <TAG_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --name <DISPLAY_NAME>
          Display name. Defaults to the Tag ID for a new Tag
      --instructions <INSTRUCTIONS>
          Standing instructions the Tag follows in every Task
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

## `supertag get-tag`

```text
Inspect a Tag by its permanent ID, including after retirement

Usage: supertag get-tag [OPTIONS] <TAG_ID>

Arguments:
  <TAG_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
  -h, --help
          Print help
```

## `supertag list-tags`

```text
List active Tags and optionally include retired identities

Usage: supertag list-tags [OPTIONS]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --include-retired
          Also list retired Tags
      --limit <LIMIT>
          Most entries to return on one page [default: 100]
      --cursor <CURSOR>
          Continue from the cursor the previous page returned [default: ""]
  -h, --help
          Print help
```

## `supertag retire-tag`

```text
Retire a Tag by ID while preserving its work history

Usage: supertag retire-tag [OPTIONS] <TAG_ID>

Arguments:
  <TAG_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --dry-run
          Show blockers and what retirement would detach
  -h, --help
          Print help
```

## `supertag submit`

```text
Accept one turn of work in a Tag's Session

Usage: supertag submit [OPTIONS] --tag <TAG> --session <SESSION> <PROMPT>

Arguments:
  <PROMPT>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --tag <TAG>
          Tag that does the work
      --session <SESSION>
          Session that the turn belongs to; a new name starts a new Session
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

## `supertag get-task`

```text
Read a Task

Usage: supertag get-task [OPTIONS] <TASK_ID>

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

## `supertag artifact-publication`

```text
Approve and withdraw explicit cross-Objective artifact reuse

Usage: supertag artifact-publication [OPTIONS] <COMMAND>

Commands:
  publish               Approve selected completed output for named destination Objectives
  consume               Approve consumption by a destination already in the publication audience
  get                   Read one artifact publication
  consumption           Read one consumption approval
  list                  List the artifact publications approved from an Objective
  consumptions          List the consumption approvals for a destination Objective
  withdraw              Withdraw a publication at its exact revision, so later Tasks cannot use it
  withdraw-consumption  Withdraw a consumption approval at its exact revision
  audit                 List the recorded events for one publication or consumption approval
  help                  Print this message or the help of the given subcommand(s)

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
      --path <PATH>              File in the artifact to publish. Repeat for each file
      --audience <AUDIENCE>      Destination Objective ID that may use the files. Repeat for each Objective
      --supersedes <SUPERSEDES>  Earlier publication that this one replaces
  -h, --help                     Print help
```

## `supertag artifact-publication consume`

```text
Approve consumption by a destination already in the publication audience

Usage: supertag artifact-publication consume <CONSUMPTION_ID> <PUBLICATION_ID> <OBJECTIVE_ID>

Arguments:
  <CONSUMPTION_ID>  
  <PUBLICATION_ID>  
  <OBJECTIVE_ID>    

Options:
  -h, --help  Print help
```

## `supertag artifact-publication get`

```text
Read one artifact publication

Usage: supertag artifact-publication get <PUBLICATION_ID>

Arguments:
  <PUBLICATION_ID>  

Options:
  -h, --help  Print help
```

## `supertag artifact-publication consumption`

```text
Read one consumption approval

Usage: supertag artifact-publication consumption <CONSUMPTION_ID>

Arguments:
  <CONSUMPTION_ID>  

Options:
  -h, --help  Print help
```

## `supertag artifact-publication list`

```text
List the artifact publications approved from an Objective

Usage: supertag artifact-publication list [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --limit <LIMIT>                Most entries to return on one page [default: 30]
      --before-order <BEFORE_ORDER>  Continue from the next_before_order the previous page returned [default: 0]
  -h, --help                         Print help
```

## `supertag artifact-publication consumptions`

```text
List the consumption approvals for a destination Objective

Usage: supertag artifact-publication consumptions [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --limit <LIMIT>                Most entries to return on one page [default: 30]
      --before-order <BEFORE_ORDER>  Continue from the next_before_order the previous page returned [default: 0]
  -h, --help                         Print help
```

## `supertag artifact-publication withdraw`

```text
Withdraw a publication at its exact revision, so later Tasks cannot use it

Usage: supertag artifact-publication withdraw --expected-revision <EXPECTED_REVISION> <PUBLICATION_ID>

Arguments:
  <PUBLICATION_ID>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
  -h, --help
          Print help
```

## `supertag artifact-publication withdraw-consumption`

```text
Withdraw a consumption approval at its exact revision

Usage: supertag artifact-publication withdraw-consumption --expected-revision <EXPECTED_REVISION> <CONSUMPTION_ID>

Arguments:
  <CONSUMPTION_ID>  

Options:
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
  -h, --help
          Print help
```

## `supertag artifact-publication audit`

```text
List the recorded events for one publication or consumption approval

Usage: supertag artifact-publication audit <APPROVAL_TYPE> <APPROVAL_ID>

Arguments:
  <APPROVAL_TYPE>  
  <APPROVAL_ID>    

Options:
  -h, --help  Print help
```

## `supertag volume`

```text
Register Volumes and copy immutable artifact files into explicitly mapped storage

Usage: supertag volume [OPTIONS] <COMMAND>

Commands:
  put       Register a file or S3-compatible Volume. Existing metadata requires its exact revision
  get       Read one Volume
  list      List registered Volumes
  delete    Remove metadata only when no reserved or verified copies depend on it
  copy      Copy one exact artifact file. The Gateway must separately consent to this Volume's storage
  download  Download and re-verify one recorded copy, including after the Gateway cache is lost
  copy-get  Read one recorded artifact copy
  copies    List recorded artifact copies, newest first, optionally for one Volume
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
      --source <SOURCE>
          Canonical file:///absolute/path or s3://bucket/prefix. The Gateway supplies storage endpoints and credentials
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice
      --expected-revision <EXPECTED_REVISION>
          The revision you last read, or 0 to create. The change is refused when it no longer matches [default: 0]
  -h, --help
          Print help
```

## `supertag volume get`

```text
Read one Volume

Usage: supertag volume get <VOLUME_ID>

Arguments:
  <VOLUME_ID>  

Options:
  -h, --help  Print help
```

## `supertag volume list`

```text
List registered Volumes

Usage: supertag volume list [OPTIONS]

Options:
      --limit <LIMIT>        Most entries to return on one page [default: 30]
      --after-id <AFTER_ID>  Continue after the last ID the previous page returned [default: ""]
  -h, --help                 Print help
```

## `supertag volume delete`

```text
Remove metadata only when no reserved or verified copies depend on it

Usage: supertag volume delete --operation-id <OPERATION_ID> --expected-revision <EXPECTED_REVISION> <VOLUME_ID>

Arguments:
  <VOLUME_ID>  

Options:
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
  -h, --help
          Print help
```

## `supertag volume copy`

```text
Copy one exact artifact file. The Gateway must separately consent to this Volume's storage

Usage: supertag volume copy --path <PATH> --expected-revision <EXPECTED_REVISION> --operation-id <OPERATION_ID> <VOLUME_ID> <ARTIFACT_ID>

Arguments:
  <VOLUME_ID>    
  <ARTIFACT_ID>  

Options:
      --path <PATH>
          File in the artifact to copy
      --expected-revision <EXPECTED_REVISION>
          The revision you last read. The change is refused when the resource has changed since
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice
  -h, --help
          Print help
```

## `supertag volume download`

```text
Download and re-verify one recorded copy, including after the Gateway cache is lost

Usage: supertag volume download --output <OUTPUT> <COPY_ID>

Arguments:
  <COPY_ID>  

Options:
      --output <OUTPUT>  Local file to create with the verified copy. It must not already exist
  -h, --help             Print help
```

## `supertag volume copy-get`

```text
Read one recorded artifact copy

Usage: supertag volume copy-get <COPY_ID>

Arguments:
  <COPY_ID>  

Options:
  -h, --help  Print help
```

## `supertag volume copies`

```text
List recorded artifact copies, newest first, optionally for one Volume

Usage: supertag volume copies [OPTIONS]

Options:
      --volume-id <VOLUME_ID>        Only copies made into this Volume [default: ""]
      --limit <LIMIT>                Most entries to return on one page [default: 30]
      --before-order <BEFORE_ORDER>  Continue from the next_before_order the previous page returned [default: 0]
  -h, --help                         Print help
```

## `supertag workspace-volume`

```text
Register or inspect a file Volume for read-only Workspace data

Usage: supertag workspace-volume [OPTIONS] <COMMAND>

Commands:
  put   Register a canonical file Volume for Workspace data
  get   Read one Workspace data Volume
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
      --source <SOURCE>
          Canonical file:///absolute/path of the data directory
      --expected-revision <EXPECTED_REVISION>
          The revision you last read, or 0 to create. The change is refused when it no longer matches [default: 0]
  -h, --help
          Print help
```

## `supertag workspace-volume get`

```text
Read one Workspace data Volume

Usage: supertag workspace-volume get <VOLUME_ID>

Arguments:
  <VOLUME_ID>  

Options:
  -h, --help  Print help
```

## `supertag artifact`

```text
Inspect or download files captured by a Task

Usage: supertag artifact [OPTIONS] <COMMAND>

Commands:
  list      List artifacts captured by a Task
  get       Read an artifact's provenance and exact file manifest
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

## `supertag artifact list`

```text
List artifacts captured by a Task

Usage: supertag artifact list [OPTIONS] --task <TASK>

Options:
      --task <TASK>                  Task whose artifacts to list
      --limit <LIMIT>                Most entries to return on one page [default: 50]
      --before-order <BEFORE_ORDER>  Continue from the next_before_order the previous page returned [default: 0]
  -h, --help                         Print help
```

## `supertag artifact get`

```text
Read an artifact's provenance and exact file manifest

Usage: supertag artifact get <ARTIFACT_ID>

Arguments:
  <ARTIFACT_ID>  

Options:
  -h, --help  Print help
```

## `supertag artifact download`

```text
Download one immutable file and verify its digest before publishing it locally

Usage: supertag artifact download --path <PATH> --output <OUTPUT> <ARTIFACT_ID>

Arguments:
  <ARTIFACT_ID>  

Options:
      --path <PATH>      File in the artifact to download
      --output <OUTPUT>  Local file to create with the verified download. It must not already exist
  -h, --help             Print help
```

## `supertag workspace-artifact`

```text
Download the patch or Git bundle published by a successful workspace Task

Usage: supertag workspace-artifact [OPTIONS] --kind <KIND> --output <OUTPUT> <TASK_ID>

Arguments:
  <TASK_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --kind <KIND>
          Which published result to download [possible values: patch, bundle]
      --output <OUTPUT>
          Local file to create with the download. It must not already exist
  -h, --help
          Print help
```

## `supertag task-events`

```text
Read a page of recorded Task events

Usage: supertag task-events [OPTIONS] <TASK_ID>

Arguments:
  <TASK_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --after <AFTER>
          Only entries after this sequence number [default: 0]
  -h, --help
          Print help
```

## `supertag task-usage`

```text
Read native token usage recorded for a Task Attempt

Usage: supertag task-usage [OPTIONS] <TASK_ID> <ATTEMPT_ID>

Arguments:
  <TASK_ID>     
  <ATTEMPT_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --after <AFTER>
          Only entries after this sequence number [default: 0]
  -h, --help
          Print help
```

## `supertag cancel`

```text
Cancel a Task

Usage: supertag cancel [OPTIONS] <TASK_ID>

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

## `supertag resolve-attempt`

```text
Record an audited decision for a stopped, uncertain Task Attempt

Usage: supertag resolve-attempt [OPTIONS] --decision <DECISION> --evidence <EVIDENCE> <TASK_ID> <ATTEMPT_ID>

Arguments:
  <TASK_ID>     
  <ATTEMPT_ID>  

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --decision <DECISION>
          Mark the Attempt failed, or run the Task again [possible values: failed, retry]
      --evidence <EVIDENCE>
          What you checked that shows the Attempt stopped and what it did
      --confirmed-stopped
          Confirm that no process of this Attempt is still running
      --operation-id <OPERATION_ID>
          Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help
          Print help
```

## `supertag input`

```text
Direct input into an active Task and inspect its delivery

Usage: supertag input [OPTIONS] <COMMAND>

Commands:
  queue    Send a message to a running Task, with a queued fallback if it cannot take it
  get      Read the delivery status and fallback Task of a message
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

## `supertag input queue`

```text
Send a message to a running Task, with a queued fallback if it cannot take it

Usage: supertag input queue [OPTIONS] <TASK_ID> <TEXT>

Arguments:
  <TASK_ID>  
  <TEXT>     

Options:
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag input get`

```text
Read the delivery status and fallback Task of a message

Usage: supertag input get <INPUT_ID>

Arguments:
  <INPUT_ID>  

Options:
  -h, --help  Print help
```

## `supertag input resolve`

```text
Record a decision and evidence for a message whose delivery is uncertain

Usage: supertag input resolve [OPTIONS] --evidence <EVIDENCE> <INPUT_ID> <DECISION>

Arguments:
  <INPUT_ID>  
  <DECISION>  [possible values: fail, retry]

Options:
      --evidence <EVIDENCE>          What you checked that shows whether the message arrived
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
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

## `supertag describe`

```text
Describe one resource in readable text

Usage: supertag describe [OPTIONS] <KIND> <ID>

Arguments:
  <KIND>  [possible values: tag, task, objective, team, worker-host, session, role, permission-set, context-set, volume, workspace-volume, workspace]
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

## `supertag watch`

```text
Stream change notices, reconnecting from the last resume token

Usage: supertag watch [OPTIONS]

Options:
      --gateway <URL|NAME>
          Gateway URL or the name of a Gateway saved in the terminal UI or desktop app. A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN
      --state-directory <STATE_DIRECTORY>
          Use the local services in this state directory instead of a Gateway
      --kind <KINDS>
          Only these kinds of change. Repeat for more; omit for every kind [possible values: tag, task, conversation-message, objective, team, workstream-post]
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
  get                  Read one Objective
  list                 List Objectives
  list-commit-reviews  List commit review requests and recorded verdicts for an Objective
  set-limits           Change the deadline or monetary limit
  set-runtime-actions  Replace the runtime-action ceiling for future Objective turns
  pause                Pause the Objective. Resuming it later queues an owner turn that reports what happened
  resume               Resume a paused Objective
  cancel               Cancel the Objective and its open Tasks
  review               Approve the Objective's result, or reject it with feedback for the owner
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
      --owner <OWNER>
          Tag that owns the Objective until it is met
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

## `supertag objective get`

```text
Read one Objective

Usage: supertag objective get <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
  -h, --help  Print help
```

## `supertag objective list`

```text
List Objectives

Usage: supertag objective list [OPTIONS]

Options:
      --limit <LIMIT>        Most entries to return on one page [default: 20]
      --after-id <AFTER_ID>  Continue after the last ID the previous page returned [default: ""]
  -h, --help                 Print help
```

## `supertag objective list-commit-reviews`

```text
List commit review requests and recorded verdicts for an Objective

Usage: supertag objective list-commit-reviews [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --limit <LIMIT>                Most entries to return on one page [default: 50]
      --before-order <BEFORE_ORDER>  Continue from the next_before_order the previous page returned [default: 0]
  -h, --help                         Print help
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
      --clear-deadline
          Remove the deadline
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
      --runtime-action <RUNTIME_ACTIONS>
          Runtime action future turns may use. Repeat for each action
      --no-runtime-actions
          Allow no runtime actions in future turns
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
      --reason <REASON>              Why, recorded in the Objective history [default: ""]
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag objective resume`

```text
Resume a paused Objective

Usage: supertag objective resume [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --reason <REASON>              Why, recorded in the Objective history [default: ""]
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag objective cancel`

```text
Cancel the Objective and its open Tasks

Usage: supertag objective cancel [OPTIONS] <OBJECTIVE_ID>

Arguments:
  <OBJECTIVE_ID>  

Options:
      --reason <REASON>              Why, recorded in the Objective history [default: ""]
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```

## `supertag objective review`

```text
Approve the Objective's result, or reject it with feedback for the owner

Usage: supertag objective review [OPTIONS] <OBJECTIVE_ID> <DECISION>

Arguments:
  <OBJECTIVE_ID>  
  <DECISION>      [possible values: approve, request-changes]

Options:
      --feedback <FEEDBACK>          What the owner should change. Use it when you reject the result [default: ""]
      --operation-id <OPERATION_ID>  Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key
  -h, --help                         Print help
```
