<p align="center">
  <img src="./docs/assets/readme/inari-hero.webp" alt="Inari — GitHub Governance CLI. Standardize your workflow. Keep your project healthy." width="100%">
</p>

# Inari

**Deterministic GitHub Governance**

Inari (`inari`, published as `gh-inari`) turns repository-governed GitHub work
into typed, deterministic contracts. It resolves repository policy, validates
semantic intent, renders canonical artifacts, admits bounded operations, and
verifies their actual outcomes.

The short lifecycle is **Issue → Change → PR → Merge**. A Source outcome,
Implementation task, Session, leaf PR, and integration PR remain distinct
identities within that workflow.

Inari is not a general `gh` wrapper, arbitrary remote shell, credential
sharing service, or agent scheduler. Unsupported or ambiguous authority fails
closed rather than falling back to a broader credential.

## Quick start

Requires Node.js 24 or newer.

```sh
npm install --global gh-inari

inari --version --json
inari template list
inari issue schema feature --json
```

An ephemeral invocation is also available:

```sh
npx --yes gh-inari --version --json
```

`inari` is the canonical executable; `gh-inari` is its npm binary alias.
Use installed Help for the exact versioned command contract and explicit
repository selection. Common shell behavior is being converged to CLI Canon;
that migration does not change repository authorization.

## Architecture status

The [Product Architecture Canon](./docs/ARCHITECTURE.md) records the approved
2026-09-27 target. The [convergence ledger](./docs/ARCHITECTURE_CONVERGENCE.md)
distinguishes current implementation, accepted changes, remaining integration,
and required certification.

Documentation of a target is not a claim that every advertised interface or
live deployment already implements it. In particular, the new Hosted
assertion/Relay profile and retirement of independent Direct App execution
require their governed implementation and public-path proof.

## Design principles

**Canonical:** each semantic fact has one owner; native GitHub artifacts and
client interfaces are projections, not competing policy.

**Deterministic:** the same admitted contract/input/evidence yields the same
projection and plan. Unavailable evidence is not treated as absence.

**Machine-verifiable:** typed schemas, bounded diagnostics, current identity,
and execution evidence support both humans and agents without exposing
provider credentials.

## Templates and semantic artifacts

Repositories define authoring contracts under `.github/inari/` or use the
supported native-template compatibility path. Semantic source owns meaning;
GitHub Issue Forms and PR Markdown are generated projections.

```sh
inari issue schema feature --json
inari issue validate --template feature --from issue.json
inari issue render --template feature --from issue.json
inari issue create --template feature --from issue.json
```

`--from -` selects stdin where supported. Pure schema/validation/rendering is
not implicit provider mutation. Creation follows semantic validation,
canonical rendering, freshness, and the admitted provider boundary.

See [Semantic Templates](./docs/SEMANTIC_TEMPLATES.md) for exact discovery
paths, native synchronization, import, and current compatibility. The
schema-native target makes JSON Schema the generic data-shape authority while
Inari retains value authority, relations, derivation, and provenance.

Existing artifact observation and reconciliation preserve human intent and
free text. Automatic convergence may only perform proven semantics-preserving
repair; missing intent or ambiguous template selection remains explicit.

## Source and Implementation

A Source Issue defines the desired outcome and acceptance. An Implementation
is the separate bounded task contract with scope, constraints, base/branch,
dependencies, tests, and postconditions.

Session task and leaf publication bind the Implementation. Source Change
operations select a canonical Source in both the signed and current
Implementation Source sets. Multiple Sources do not imply a primary Source
or multiple implicit PR bases.

WRITE never implies CREATE or DELETE. DENY and protected paths remain
additional restrictions. Completion of one task/PR is not completion of its
Source or Epic.

See [Implementation Contract](./docs/IMPLEMENTATION_CONTRACT.md) and
[Golden Path Composition](./docs/GOLDEN_PATH_ARCHITECTURE.md).

## Runtime and operator experience

Admission authenticates and authorizes. Executor owns Inari Access App custody,
repository/installation binding, provider reads, and admitted effects.
Authority owns delegation-signing keys. Setup and Console consume public owner
ports and retain secret-free repository references.

The current local Setup entrypoints include:

```sh
inari setup status
inari setup next
inari setup console
```

These expose canonical state and next action. Configuration, health, provider
binding, repository trust, and Session readiness are not one ready flag.
A trust PR must receive independent human approval/merge and protected-ref
reread before trust is established.

The target unified machine Console serves multiple isolated repository
contexts. Connect, Disconnect, and rotation are recoverable owner operations,
not implicit directory deletion or silent key regeneration.

Detailed key/bootstrap/recovery procedures are in
[Delegator Operations](./docs/DELEGATOR_OPERATIONS.md). Explicit non-loopback
transport is described in [Remote Runtime Transport](./docs/LOCAL_RUNTIME_NON_LOOPBACK.md).

## Remote access target

Hosted authenticates through Inari Access user OAuth, verifies caller and
repository eligibility, and relays a short-lived signed request-bound
assertion. It does not persist or forward the user's GitHub token.

A stable public Relay locator is derived from a separate user-owned transport
key and bound to an authenticated live connection. The locator grants no
repository permission. Private repositories do not require public discovery.

All repository semantics and subject/operation admission terminate on the
user-owned Runtime. Normal provider effects use Executor-owned installation
credentials. Hosted has no repository work database or alternate executor.

See [Hosted Relay](./docs/HOSTED_RELAY_DEPLOYMENT.md) and
[Repository Access Assertion](./docs/REPOSITORY_ACCESS_ASSERTION.md) for the
approved boundaries and remaining implementation/certification gates.

## Agents, MCP, and packaged Skill

The published package contains the Codex Plugin manifest and bundled Inari
Skill; activation is explicit. An npm installation does not silently activate
an agent plugin.

The Skill is a thin router to canonical playbooks, Help, and repository
execution governance. It does not override a repository's active restrictions
or maintain a second command/permission catalog.

MCP exposes the same typed operation contracts. Hosted MCP relays rather than
running a second semantic backend. Protocol access grants no shell, raw GitHub
proxy, review, merge, or operator-enrollment authority.

## Security boundaries

Caller identity is not provider execution identity. App credentials remain
inside Executor, delegation keys at Authority, and Relay transport keys at
the user-owned client. Admission receives validated evidence, not provider
credentials.

A successful provider response is not enough: execution rereads authoritative
state and verifies the planned postcondition. Timeouts after possible effects
retain uncertainty and require safe reconciliation, not blind replay.

See [Security Policy](./SECURITY.md),
[Caller Authentication](./docs/AGENT_CAPABILITY_AUTHORIZATION.md), and
[Inari Access](./docs/INARI_ISSUER_APP.md).

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm run verify
```

`pnpm run verify` remains the authoritative local entrypoint. Source, built,
installed-package, process, browser, and live-provider evidence are different
proof classes. The target removes duplicate execution at the same boundary
and separates routine verification from release-preparation certification.

Read [Verification Architecture](./docs/VERIFICATION_ARCHITECTURE.md) and
[Contributing](./CONTRIBUTING.md). A pending, environment-blocked, or unexecuted
check is never reported as passed.

## License

MIT — see [LICENSE](./LICENSE).

## Project policies

- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Contributing](./CONTRIBUTING.md)
- [MIT License](./LICENSE)
- [Security Policy](./SECURITY.md)
