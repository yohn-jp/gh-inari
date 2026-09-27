# gh-inari

Read `.github/agent-governance/AGENTS.md` and the applicable organization Skill
before work. Their current Inari invocation restrictions remain in force.

Inari is a deterministic repository-governance product with one user-owned
Admission/Executor execution architecture.

## Authority

- `docs/ARCHITECTURE.md` is the Product Architecture Canon. Its domain guides
  own detailed contracts; `docs/ARCHITECTURE_CONVERGENCE.md` distinguishes target
  decisions from implemented and certified behavior.
- Architecture changes require explicit product-owner/design-review approval.
  Accepted Issues define bounded delivery against that architecture, not an
  independent right to change identity, custody, policy, or public semantics.
- Code, schemas, validators, tests, and current provider state are executable
  evidence. Do not claim target prose is implemented behavior.
- Source Change, Implementation task, Session, leaf publication, and integration
  remain distinct. Do not duplicate Core semantics across CLI/MCP/HTTP/UI.
- Admission holds no provider credentials. Executor owns Inari Access binding
  and effects; Authority owns delegation; Hosted authenticates and relays.

## Validation

Full verification: `pnpm run verify`.
Preserve proof boundaries and report local, CI, packed, and live results
separately. Do not change tests or guards merely to accommodate obsolete
architecture or make an unverified path appear complete.
