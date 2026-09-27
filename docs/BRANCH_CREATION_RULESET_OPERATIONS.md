# Branch-Creation Ruleset Operations

Status: operator runbook under
[Change Control Plane](./CHANGE_CONTROL_PLANE.md) section 10 and
[Product Architecture Canon](./ARCHITECTURE.md).

`src/branch-creation-ruleset.ts` is the single Core definition of the desired
Ruleset payload and staged transition rule. This runbook preserves the exact
scope, bypass, rollout, verification, and rollback procedure. It neither
creates live protection nor proves current provider configuration.

## 1. Existing enforcement contract

The existing repository-specific definition contains exactly one rule:
Restrict creations. It covers:

```text
refs/heads/feat/**
refs/heads/fix/**
refs/heads/docs/**
refs/heads/refactor/**
refs/heads/test/**
refs/heads/chore/**
```

The current definition explicitly excludes `refs/heads/main`; separate
default-branch protection remains in force. This is gh-inari's existing
Ruleset contract, not a universal naming rule for every consumer repository.

Its sole bypass Integration is the exact configured Inari Access App ID with
`bypass_mode: always`. Historical Issuer names remain accepted parameter
spelling, not an instruction to select an App by display name.

Because this Ruleset has only creation, it does not itself gate updates to
already existing branches. It grants no bypass of review, checks, merge,
trust-root governance, or another Ruleset.

Repository administrators can change enforcement outside Inari; this boundary
does not claim to constrain the repository owner against their own admin
rights.

## 2. Generate the canonical payload

```sh
node --import tsx scripts/print-branch-creation-ruleset.mjs \
  --issuer-app-id <numeric-Inari-Access-App-ID> \
  --enforcement disabled
```

This existing script prints the payload and does not invoke the GitHub API.
Obtain the exact App ID from the current verified binding. The accepted stage
values are disabled, evaluate, and active; default is disabled.

The configured App and actual repository branch policy must be consistent.
Dedicated/shared App or Source-integration changes do not silently expand the
namespace or bypass actors. Any necessary change to the canonical payload is
separately approved implementation, not a hand-edited live workaround.

## 3. Preflight

An authorized administrator first reads the current live Ruleset inventory and
records IDs, payloads, and rollback state. Historical Issue comments or this
runbook's introduction date are not current settings evidence.

Verify the current packaged governed branch-creation path under the exact
selected App and repository. Earlier #449/#588 certification is historical
lineage, not a perpetual proof for the latest candidate.

Before evaluate/active, require current exact-source self-dogfood evidence and
successful authorized advancement of an already-issued branch. A missing
capability or environment is blocked, not permission to enable optimistically.

## 4. Staged rollout

The canonical stage planner enforces:

```text
not defined -> disabled -> evaluate -> active
```

Disabled makes the definition inspectable without enforcement. Evaluate
observes would-be restrictions where the provider supports it. Active enforces
the accepted restriction. Verify actual provider support and results; do not
silently skip a stage or treat rejected configuration as installed.

At every stage:

1. Generate the exact canonical payload for the intended stage.
2. Apply it with separately authorized repository administration.
3. Fetch the live result.
4. Validate it with validateChangeBranchCreationRuleset and the expected
   numeric App ID.
5. Exercise/record the allowed and denied cases appropriate to that stage.

Expected App identity is mandatory. A correctly shaped Ruleset that bypasses
another Integration is not issuer-only enforcement.

Administrative mutation is not delegated to an ordinary Session, Hosted
caller, or Inari Access effect profile. Their repository visibility or broad
contents permission is not administration authority.

## 5. Acceptance evidence

Prove that the current Inari Access path can create its canonical branch,
arbitrary callers are restricted as intended, and authorized updates to an
already-issued branch are not accidentally captured.

Confirm default-branch and review/check protections remain independent and
unchanged. Record live Ruleset ID, exact payload, App ID, candidate revision,
provider results, and rollback configuration without credentials.

Source/Epic namespaces outside the current payload are not covered by
implication. Report an actual unsupported enforcement gap rather than
claiming this six-prefix definition proves all possible integration branches.

## 6. Rollback

The canonical rollback moves any installed stage immediately to disabled:

```text
active -> disabled
evaluate -> disabled
```

Update the existing Ruleset rather than delete it. Preserve its definition and
App identity so repaired rollout resumes from disabled.

Rollback is required if canonical creation fails, legitimate existing-branch
updates are unexpectedly blocked, or evaluation exposes legitimate creators
not migrated to the accepted path.

Generate the disabled payload with the same App ID, apply it to the existing
Ruleset, reread, and validate the disabled result. Do not add extra bypass
actors or weaken unrelated protections to make the test pass.

## 7. Recovery and current-status reporting

Repair the actual product/configuration cause under separate authority,
re-certify the exact candidate, and resume the normal staged rollout.
A provider failure is not a reason to suppress the validator.

This document intentionally makes no assertion about today's live enforcement
stage. Product definition, tests, historical rollout, and live settings are
separate evidence. The corresponding operational Issues remain open until
their actual current acceptance is demonstrated.
