# Implementation contract

`Implementation` is Inari's execution contract for exactly one implementation
session. It is distinct from an ordinary Issue: an Issue records a problem or
request, while an Implementation records the bounded work that may be
performed after the contract is reviewed and, in a later lifecycle, explicitly
authorized.

The Core contract is versioned (`version: 1`, schema `1.0.0`) and is exposed
from the `implementation-contract` package entry point. A GitHub Issue Form is
the v1 persistence and UI adapter at
`.github/ISSUE_TEMPLATE/implementation.yml`; the canonical identity is the
normalized Implementation body, not the Issue title, labels, assignees,
Projects metadata, or comments.

The contract contains:

- repository identity and one or more source Issue references;
- objective, explicit non-goals, architecture decision, affected components,
  invariants, and compatibility constraints;
- independent `READONLY`, `WRITE`, `CREATE`, `DELETE`, and `DENY` path scopes;
- prohibited operations, immutable areas, and prerequisites;
- acceptance criteria, targeted tests, required checks, and observable
  postconditions;
- base branch plus optional base revision/freshness and branch/dependency
  inputs.

`WRITE` is an explicit allowlist and defaults to empty. `CREATE` and `DELETE`
are never inferred from `WRITE`, and `DENY` always narrows a matching
allowlist. Creating or editing an Implementation does not grant authority or
start a session.

The future lifecycle surface uses the `impl` namespace (`inari impl ...`).
This contract leaf provides the Core parser, validator, canonical serializer,
Issue-form adapter, and schema; lifecycle and CLI operations are separate
implementation leaves.
