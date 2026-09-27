<p align="center">
  <img src="./docs/assets/readme/inari-hero.webp" alt="Inari — GitHub Governance CLI. Standardize your workflow. Keep your project healthy." width="100%">
</p>

# Inari

**Deterministic GitHub Governance**

Inari (`inari`, published as `gh-inari`) turns repository-owned contracts and current GitHub evidence into bounded, verifiable operations. Its lifecycle summary is **Issue → Change → PR → Merge**; Source intent, Implementation tasks, Sessions and integration artifacts retain distinct identities.

Inari is not a general `gh` wrapper or a remote shell. Canonical semantics, explicit authorization and authoritative postcondition checks constrain supported operations.

## Architecture and implementation status

The [Product Architecture Canon](./docs/ARCHITECTURE.md) is the approved target and entry point for domain contracts. The [convergence plan](./docs/ARCHITECTURE_CONVERGENCE.md) distinguishes that target from implemented, integrated, verified and deployed behavior. Publishing the documentation does not complete the migration.

The target has one user-owned Admission/Executor execution path. Inari Access supplies Executor-owned GitHub installation credentials. Hosted authenticates users with transient OAuth credentials, sends only signed repository-eligibility assertions and relays by a stable Runtime locator. It does not execute repository semantics or retain user credentials. The independent Direct App deployment is retired in the target.

## Quick start

Requires Node.js 24 or newer. The repository pins its development package manager in `package.json`.

```bash
npm install --global gh-inari
inari --version
inari template list
inari issue schema feature --json
```

Use the installed release's help for commands that actually exist. Proposed Relay URLs, assertion profiles and new onboarding behavior are not promised CLI commands until their producer and certification are released.

## Governed workflow

A repository owns the contracts. Inari resolves them, validates permitted semantic input, materializes canonical artifacts, admits bounded operations and verifies resulting provider state.

The [Golden Path](./docs/GOLDEN_PATH_ARCHITECTURE.md) describes local and remote composition. [Implementation Contract](./docs/IMPLEMENTATION_CONTRACT.md) separates task authorization from Source Change lifecycle and integration routing. [Semantic Templates](./docs/SEMANTIC_TEMPLATES.md) defines editable repository sources and generated GitHub projections.

Canonical means one owner for each semantic fact. Deterministic means explicit resolution, validation, projection and recovery. Machine-verifiable means versioned contracts, bounded diagnostics and evidence tied to the exact revision and execution boundary.

## Clients and ownership

CLI, MCP, Local Console and an optional remote UI expose the same Runtime contracts. They do not duplicate policy. Hosted is authentication and transport, not a second Inari server or an arbitrary GitHub proxy.

Inari Access has distinct user-authorization and installation-execution profiles. User identity is not the provider execution identity. Repository visibility does not grant mutation authority. App keys remain with Executor; delegation keys remain with Authority; Relay transport keys remain with their Runtime owner.

Worktree/process isolation belongs to Nawabari, agent orchestration to Mottainai and shared CLI mechanics to CLI Canon. Inari consumes explicit contracts rather than copying those responsibilities.

## Development

Read [AGENTS.md](./AGENTS.md), [Contributing](./CONTRIBUTING.md) and the [verification architecture](./docs/VERIFICATION_ARCHITECTURE.md).

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

The product owner approves architecture changes. Implementation agents work within approved contracts and cannot authorize themselves to change trust, identity, custody or lifecycle semantics. Repository operational restrictions still apply even when a product command exists.

## Security and license

See [Security Policy](./SECURITY.md) for reporting and trust boundaries. MIT — see [LICENSE](./LICENSE).
