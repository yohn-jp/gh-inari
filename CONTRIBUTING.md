# Contributing

This project is pre-1.0. Compatibility changes require an explicit governed decision; a version number alone is not permission to break a supported contract.

## Authority before implementation

Read [AGENTS.md](./AGENTS.md), the organization governance it references and the [Product Architecture Canon](./docs/ARCHITECTURE.md). Work from a current accepted task and its actual integration route, scope and verification obligations.

Ordinary Issues describe intent and acceptance. Implementations describe bounded execution. Architecture changes are approved by the product owner in the design review, not inferred by the implementing worker. A worker may propose a correction but cannot modify its own authority to justify it.

Internal functions, modules, algorithms and test organization remain implementation choices inside approved boundaries. Public semantics, identity, trust, capability, secret/state ownership, recovery and compatibility changes do not.

## Development environment

Requires Node.js 24 or newer and the package-manager version pinned in [package.json](./package.json).

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

Run focused checks while editing and the task's required final verification against the stable head. Distinguish source, built, installed, process/browser and live-provider proof as described in [Verification Architecture](./docs/VERIFICATION_ARCHITECTURE.md).

## Branches and changes

Use the governed isolated branch/worktree and current base. Implementation, Source integration, Epic integration and main are different roles. Never implement directly on an integration branch/main or consume an unmerged sibling as an implicit dependency.

Follow the task/repository branch contract and canonical parent/routing evidence. Do not guess parentage from a name, add an unrelated closing reference or reinterpret a Source set as an ordered target selector.

Reuse canonical helpers and owner ports. Do not add speculative abstractions, duplicate parsers, credential fallbacks or unrelated refactors. Generated organization files are changed at their canonical source, not forked in this repository.

## Code and generated output

TypeScript is strict ESM/NodeNext; relative source imports use the emitted `.js` extension. Prefer full words and comments explaining intent. Use existing test primitives and keep evidence tied to the behavior being proved.

`dist/**` is generated and not committed. Package build and conformance validate produced artifacts; a source-only test is not package proof. Do not edit generated native templates independently of their repository semantic source.

## Pull requests

Use the canonical PR template and describe actual changes, task authority, validation and review focus. Conventional Commit prefixes describe the change. Do not fabricate an Issue, acceptance result or test pass to fill a field. Preserve the explicitly requested lifecycle and any audit-only restriction.

A PR may be published for review with unavailable verification clearly stated; that does not make it merge-ready. Required CI/governance and the applicable human review remain gates. Creating/fixing a PR is not permission to merge, close Issues, change Rulesets or release.

## Security

Report security issues through [SECURITY.md](./SECURITY.md). Never place operator credentials, private keys, tokens or raw secret-bearing evidence in an Issue, PR, log or test artifact.
