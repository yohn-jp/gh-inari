# gh-inari

Read `.github/agent-governance/AGENTS.md` before working in this repository.

Inari is the deterministic repository-governance product for contracts, bounded authorization and verified GitHub operations.

## Canon and architecture ownership

- `docs/ARCHITECTURE.md` is the Product Architecture Canon. Domain documents refine it; `docs/ARCHITECTURE_CONVERGENCE.md` distinguishes target from current implementation.
- The product owner approves architecture changes in the design review. Implementation agents may propose, not approve or silently apply, changes to public semantics, identity, trust/capability, credential/state ownership, recovery, deployment guarantees or compatibility.
- Accepted Issues / Implementation contracts define bounded task scope inside the approved Canon. Conflicts require owner reconciliation; an Issue edit or existing code is not implicit architecture approval.
- Ordinary implementation does not edit normative architecture/approval rules. An explicitly authorized architecture-documentation task may do so. Internal implementation choices remain delegated within scope.
- Code, schemas, validators and tests establish actual revision behavior. Do not call a documented target implemented or preserve unintended behavior merely because it exists.
- CLI, MCP, Hosted and UI do not duplicate product semantics. Generated organization governance is not a local source to edit.

## Validation and lifecycle

Full verification: `pnpm run verify`. Report exact local/CI evidence and unavailable checks separately. Documentation completion is not implementation, certification, merge or release completion. Follow the active organization restriction on Inari command use.
