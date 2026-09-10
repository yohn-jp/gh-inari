# Change provenance enforcement suspended (Golden Path bootstrap)

This file's presence is the suspension switch for
`.github/workflows/change-provenance.yml`: as long as it exists, the
"Validate Change merge admission" step in that workflow is skipped, so the
`Change provenance` required check completes as a passing, non-blocking job
instead of failing/blocking merges.

## Why

The Inari Golden Path is currently being bootstrapped manually. Golden Path
bootstrap Epic/leaf branches and Draft PRs implement the canonical Change
issuance path itself, so they cannot by construction satisfy the
merge-admission validator, which already requires PRs to have been issued
as healthy canonical Changes. Typical diagnostics on bootstrap PRs include
`CHANGE_MERGE_ADMISSION_PULL_REQUEST_IDENTITY_MISMATCH`,
`CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH`, `CHANGE_PROVENANCE_INVALID_ISSUER`,
`CHANGE_PROVENANCE_INVALID_INPUT`, and `CHANGE_PROJECTION_WRONG_BASE`.

This is a temporary bootstrap exception only. It does not delete or weaken
the Change provenance/semantic validator
(`scripts/validate-change-merge-admission.mjs`, `src/change.ts`) or its
tests, which are unchanged and still exercised in isolation. Only the
workflow-level enforcement boundary is gated.

## Restoration condition

Delete this file — re-enabling enforcement immediately — once Inari can
execute the canonical path end-to-end and that path has been dogfooded
against `gh-inari`:

```
governed Issue
  -> Change issuance
  -> canonical branch + Draft PR
  -> implementation
  -> Change ready
  -> review admission
```

Do not introduce a second provenance mechanism during this suspension.

Tracking: #437
