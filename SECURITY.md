# Security Policy

## Supported versions and reporting

This project is pre-1.0 and has no long-term support branch. Security fixes target main and the latest supported 0.x release.

Report suspected vulnerabilities privately through [GitHub Security Advisories](../../security/advisories/new). If that path is unavailable, request a private maintainer channel without publishing exploit details or credentials. Include affected revision, impact and a minimal reproduction where possible.

Acknowledgment within five business days is a best-effort goal, not a service guarantee.

## Trust boundaries

The [Product Architecture Canon](./docs/ARCHITECTURE.md) defines the approved target. [Architecture Convergence](./docs/ARCHITECTURE_CONVERGENCE.md) distinguishes it from code/deployment status; a documentation change is not security certification of an unchanged release.

GitHub owns repository facts and protected trust. Runtime Admission checks caller/task/operation authority. Executor owns Inari Access App keys, installation capabilities and repository bindings. Authority owns delegation signing material. Clients and Hosted do not receive these execution secrets.

Hosted may transiently use a GitHub user access token for authentication and repository eligibility. It does not persist or forward that credential; only a short-lived signed request-bound assertion reaches Runtime. That assertion is not an Inari capability. Visibility-only callers must not inherit App write authority without explicit Runtime authorization.

Runtime trusts the configured assertion issuer for authenticated eligibility facts. Signatures do not protect against a compromised issuer making false claims. Runtime still checks exact repository/App/installation/target, freshness, replay and permitted operation. Local delegated Session controls remain independent.

Relay transport keys, Authority keys, App keys, OAuth client secrets and assertion signing keys have separate owners and purposes. A locator is public routing data, not an access grant. Standard TLS protects hops; the architecture does not claim payload end-to-end encryption or that Hosted cannot observe traffic.

## Safe execution and observation

Normal provider effects follow admission, explicit planning, narrowly scoped execution and authoritative postcondition verification. Unknown outcomes are reconciled before retry. No fallback credential, backend or repository is selected after a denial.

Module import boundaries are not an OS sandbox. Inari is not a remote shell or filesystem server. Worktree/process isolation belongs to its isolation runtime; owner-local secure storage and transport authentication remain necessary.

Control/enrollment, trust changes, human review and merge retain separate explicit authority. A healthy process, OAuth login, valid App installation or green source test does not imply those rights.

## Evidence and deployment

Exclude credentials and raw secret-bearing payloads from repositories, browser storage, logs, tracing, queues and retained test evidence. Review platform request logging and error middleware as part of non-retention. Open-source code alone does not prove a deployment's configuration or guarantee memory zeroization.

Test negative identity/scope cases, private repository access, stale/replay/reconnect behavior, no secret leakage and the real common execution path. Report unexecuted, environment-blocked and live-provider checks distinctly. Retiring Direct App in the target does not claim its current code has already been removed.
