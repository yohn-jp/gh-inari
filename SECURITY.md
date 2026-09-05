# Security Policy

## Supported Versions

This project is pre-1.0 (`0.x`). There is no long-term support branch yet —
security fixes land on `main` and the latest `0.x` release only.

| Version    | Supported |
| ---------- | --------- |
| latest 0.x | ✅        |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](../../security/advisories/new) on this
repository rather than opening a public issue. If that path is unavailable to
you, open an issue with minimal detail and ask a maintainer to follow up
through a private channel.

Include, where possible:

- A description of the issue and its impact
- Steps or a minimal reproduction
- Affected version/commit

We aim to acknowledge reports within 5 business days. This is a small,
independently maintained project without a dedicated security team, so
response times are best-effort.

## Trust boundaries

Inari does not execute user-supplied shell commands and does not store
GitHub credentials. It reads the selected repository's `.github` templates
and the explicit `--from`/`--policy` files, then delegates authentication
and GitHub API calls to the user's existing `gh` installation. Create
commands invoke the remote mutation only after compilation, semantic
validation, and canonical rendering have succeeded. Review input paths
before running Inari with untrusted arguments, and use the
least-privileged `gh` authentication available for the target repository.

The governed Change architecture adds a separate Inari GitHub App issuer
boundary. The App private key and short-lived installation tokens are confined
to trusted execution and are never caller- or agent-facing; repository and
installation scope mismatches fail closed. See
[the issuer authority contract](docs/INARI_ISSUER_APP.md).
