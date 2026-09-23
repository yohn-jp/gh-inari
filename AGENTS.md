# gh-inari

Read `.github/agent-governance/AGENTS.md` before working in this repository.

Inari is the deterministic GitHub governance CLI for repository-governed Issues, pull requests, templates, and related lifecycle contracts.

## Canon

- Accepted Issues / Implementation contracts define task scope.
- `docs/GOLDEN_PATH_ARCHITECTURE.md` is the normative composition architecture where applicable.
- Repository source, schemas, validators, and tests are the executable authority for exact behavior.
- Do not duplicate product semantics across CLI, MCP, Worker, HTTP, or other projections.

## Validation

Full verification: `pnpm run verify`.
