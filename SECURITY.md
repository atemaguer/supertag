# Security Policy

SuperTag handles collaboration events, credentials, permissions, and tool
actions. Please report possible vulnerabilities privately.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/atemaguer/supertag/security/advisories/new)
when it is available. Include:

- the affected version or commit;
- the deployment shape and collaboration surface or runtime involved;
- steps to reproduce the issue;
- the possible impact;
- any temporary mitigation you found.

Do not open a public issue, publish working exploit details, or test against
systems or tenant data you do not own. If private vulnerability reporting is
not available, open a public issue asking a maintainer to provide a private
reporting path, without including security details.

The project does not currently promise a fixed response or repair time. A
maintainer will acknowledge and assess reports as project capacity allows,
coordinate disclosure with the reporter when possible, and credit reporters
who want to be named.

## Supported versions

SuperTag is in active pre-1.0 development and has no published release of the
current Rust services yet. Security fixes are made on the current `main` branch.
Older commits may require upgrading rather than receiving a backport.

## Scope

Examples of useful reports include:

- a permission or context boundary bypass;
- credentials exposed in logs, events, stored Task results, or process arguments;
- forged collaboration surface events or Worker identities;
- unauthorized tool execution or cross-tenant access;
- unsafe handling of untrusted harness output;
- a dependency vulnerability with a demonstrated path through SuperTag.

General hardening ideas and dependency warnings without a reachable SuperTag
impact can be filed as ordinary issues.
