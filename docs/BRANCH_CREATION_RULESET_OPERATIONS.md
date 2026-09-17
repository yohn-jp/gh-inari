# Branch-creation Ruleset operations runbook

This is the operator runbook for #223 issuer-controlled canonical Change
branch-creation enforcement. It is subordinate to
[`CHANGE_CONTROL_PLANE.md`](./CHANGE_CONTROL_PLANE.md) §10 (branch authority
model) and does not redefine Change lifecycle, issuer identity, or authority
boundaries. `src/branch-creation-ruleset.ts` is the single Core definition of
the desired-state Ruleset payload and the staged transition rule; this
document describes the operator procedure around that definition, not a
parallel policy.

## What this enforces

A GitHub repository Ruleset with exactly one rule, `Restrict creations`,
scoped to the governed Change branch namespace:

```text
refs/heads/feat/**
refs/heads/fix/**
refs/heads/docs/**
refs/heads/refactor/**
refs/heads/test/**
refs/heads/chore/**
```

(`refs/heads/main` is explicitly excluded; the default branch remains under
the repository's existing separate Ruleset.)

The Ruleset's only bypass actor is the `inari-issuer` GitHub App with
`bypass_mode: always`. No other actor bypasses branch creation in this
namespace.

Because the Ruleset contains exactly one `creation` rule and no other rule
type:

- **Arbitrary caller creation in the governed namespace is denied.** Only the
  issuer App (or a repository owner acting outside the Ruleset, e.g. through
  admin override) can create a new ref matching the namespace.
- **Canonical branch creation by the issuer succeeds** through the existing
  governed `change issue` path, which already uses the issuer App to create
  the canonical branch.
- **Ordinary authorized pushes to an already-issued branch are unaffected.**
  `Restrict creations` only gates the creation of a new ref; it does not
  gate updates to a ref that already exists, so the existing edit/commit/push
  loop on a working branch (§10.2 of `CHANGE_CONTROL_PLANE.md`) is unchanged.
- **The issuer receives no reviewer, approval, merge, or administration
  authority from this configuration.** The bypass actor is scoped to this one
  Ruleset and this one rule; it is not a bypass entry on any other Ruleset
  (required reviews, required checks, or the existing default-branch
  protection).

## Generating the exact payload

```sh
node --import tsx scripts/print-branch-creation-ruleset.mjs \
  --issuer-app-id <inari-issuer numeric App ID> \
  --enforcement disabled
```

`--issuer-app-id` is deployment configuration (the `inari-issuer` App's
numeric App ID), not committed to the repository; obtain it from the App's
existing installation record. `--enforcement` selects the staged value
(`disabled` | `evaluate` | `active`; defaults to `disabled`). The script only
prints the payload — it never calls the GitHub API.

## Staged rollout

Rollout is strictly sequential; `src/branch-creation-ruleset.ts`
(`planRulesetRolloutStage`, `isRulesetRolloutAdvanceValid`) enforces that a
plan cannot skip a stage:

```text
(not defined) -> disabled -> evaluate -> active
```

| Stage      | Effect                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled` | The Ruleset exists (reviewable in the GitHub UI) but blocks nothing.                                                                         |
| `evaluate` | GitHub reports what would be blocked without blocking it. Use this to confirm the issuer path is the only creator observed in the namespace. |
| `active`   | Arbitrary-caller creation in the namespace is denied.                                                                                        |

For each stage, an authorized repository administrator:

1. Generates the payload for that stage with the script above.
2. Creates the Ruleset (first time) or updates it (subsequent stages) through
   the GitHub REST Rulesets API (`POST`/`PUT
/repos/{owner}/{repo}/rulesets`) or the equivalent repository settings UI,
   using the generated payload as the exact request body.
3. Confirms the live Ruleset matches the generated payload by fetching it and
   calling `validateChangeBranchCreationRuleset(fetched, issuerAppId)` from
   `src/branch-creation-ruleset.ts` — the same `--issuer-app-id` used to
   generate the payload. `expectedIssuerAppId` is mandatory: a fetched
   Ruleset that happens to bypass some other Integration, but is otherwise
   shaped correctly, must never be read as issuer-only.

This is a repository-administration action. It is intentionally **not**
routed through the Inari issuer App, an Agent Session, or any other
delegated capability: `AGENT_CAPABILITY_AUTHORIZATION.md` §11.6 lists
"Ruleset modification" as non-delegable by ordinary implementation Runtime
Authorities.

**Do not advance to `evaluate` or `active` before #449/#588 exact-source
self-dogfood certification succeeds against current `main`.** Only
`disabled` (define the Ruleset without observing or blocking anything) may
proceed ahead of that certification. `evaluate` already starts recording
what the live Ruleset would block, and `active` blocks a live `change issue`
branch creation if the issuer identity, namespace, or bypass configuration
is wrong; that certification evidence is what establishes the issuer path is
safe to observe against, let alone enforce.

## Rollback / recovery

Rollback is a single immediate step back to `disabled` from any current
stage (`planRulesetRollback`, `isRulesetRollbackValid`), regardless of which
rollout stage is currently live:

```text
active -> disabled
evaluate -> disabled
```

Rollback **updates** the existing Ruleset's `enforcement` field to
`disabled`; it does not delete the Ruleset. Preserving the definition means a
repaired issuance path can resume staged rollout (`disabled -> evaluate ->
active`) without redefining conditions or the bypass actor from scratch.

Trigger rollback immediately if, at `evaluate` or `active`:

- the issuer App fails to create a canonical branch through the governed
  `change issue` path (i.e., the bypass actor or namespace is misconfigured);
- an authorized ordinary push to an already-issued branch is unexpectedly
  blocked (this would indicate the live Ruleset drifted from the `creation`-
  only definition validated by `validateChangeBranchCreationRuleset`);
- `evaluate` reports a legitimate non-issuer creator in the governed
  namespace that has not yet been migrated to the issuer path.

To roll back:

1. Generate the `disabled` payload with the script above, using the same
   `--issuer-app-id`.
2. `PUT` it to the existing Ruleset's update endpoint (or toggle enforcement
   to "Disabled" in the UI).
3. Confirm the live payload is `disabled` and still passes
   `validateChangeBranchCreationRuleset(fetched, issuerAppId)`.

Recovery afterward re-enters the staged rollout above from `disabled`; it is
not a new definition.

## Current status

As of this Ruleset's introduction, the live repository enforcement stage is
**not defined / `disabled`**. Live rollout to `evaluate` or `active` is
gated on #449/#588 exact-source self-dogfood certification, per the
constraint on #223. This document and `src/branch-creation-ruleset.ts` define
and test the enforcement; they do not themselves enable it.
