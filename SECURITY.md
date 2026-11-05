# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.8.x | yes |
| 0.7.x | yes |
| 0.6.x | security fixes only |
| 0.5.x and older | no |

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://github.com/pham-canh/opencode-harness-kit/security/advisories/new)
rather than opening a public issue.

Include the affected version, a reproduction, and the expected behaviour.
You can expect an acknowledgement within 72 hours and a fix or mitigation
plan within 7 days.

## Scope

`opencode-harness-kit` runs agent subprocesses and reads harness config. Reports
that are in scope include path traversal when resolving a capability
profile, command injection through harness config values, and any way a
harness writes outside its configured working directory.

Out of scope: anything requiring you to hand over a credential you were
never given, and issues in the model provider itself.