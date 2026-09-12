# #378 Dogfood — Phase 0 Bootstrap Blocker

Status: **blocked at Phase 0 (mandatory bootstrap preflight)**. No live
mutation sequence (Runtime Authority trust-root installation, Session
issuance, Cloudflare Worker `/v1/execute` calls, `change issue` /
`change publish` / `change ready`) was executed against
`yohn-jp/gh-inari`, per the explicit stop condition in the #378 dogfood
task: *"If that makes #390's real privileged publication path impossible
before Epic merge, stop the live mutation sequence and report a bootstrap
blocker."*

## Evidence

- Current `main` SHA: `c9b41d7733b3fae85a1238d43344f1a9f6ef3f14`
- Current Epic SHA (`epic/463-session-app-execution`): `9f9405daf538deaf8c07c12efc21d2477bc8842a`
- This worktree/branch (`test/378-dogfood-session-capabilities`) was created
  directly from the Epic SHA above; no rebase was required (Epic had not
  advanced past the expected starting HEAD given in the task).

### Missing/unavailable required workflow and trust-root artifacts on `main`

- `.github/workflows/runtime-authority-governance.yml` exists on
  `epic/463-session-app-execution` but **does not exist on `main`**
  (`git show origin/main:.github/workflows/runtime-authority-governance.yml`
  → `fatal: path ... does not exist in 'origin/main'`).
- `.github/inari/authorities/**` — the canonical Runtime Authority
  trust-root directory referenced by
  `src/agent-authority/runtime-authority-trust.ts`
  (`RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY` /
  `RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX`) — **does not exist on either
  `main` or the Epic branch**. No Runtime Authority has ever been
  installed in this repository.
- `runtime-authority-trust.ts` resolves the canonical ref to check via
  `reader.getRepositoryDefaultBranch()` (`repository.default_branch`),
  i.e. the canonical protected ref for trust-root records is confirmed to
  be `main`, not the Epic branch.

### Why a governed Runtime Authority trust-root PR cannot satisfy #390 today

`#390`'s privileged publication path requires a trust-root PR targeting
`main` (the canonical protected ref) to receive both the "Runtime
Authority Governance" workflow check
(`scripts/validate-runtime-authority-governance.mjs`) and independent
human approval.

GitHub Actions resolves a `pull_request`-triggered workflow's *definition*
from the workflow file present on the PR's **base** ref, not the head
branch. Since `main` does not contain
`.github/workflows/runtime-authority-governance.yml`, opening a trust-root
PR against `main` today means:

- the "Runtime Authority Governance" check is never scheduled and never
  runs on that PR, regardless of what the PR's head branch contains, and
- consequently the PR can be approved and merged with **no automated
  governance validation of the trust-root content at all** — the exact
  outcome #390 and this task explicitly forbid ("Do not claim #378
  success with a synthetic trust root", "inject trust through raw GitHub
  API calls" is disallowed, but an *unvalidated merged PR* would produce
  an equivalent ungoverned trust record).

This is not a hypothetical: it is the documented "known condition" the
task itself flags — the workflow "exists on the Epic branch, but is not
currently present on main" — and inspecting both branches confirms it
exactly as described, plus confirms the trust-root directory itself has
never been created on either branch.

Repository rulesets / required-status-check configuration for `main`
could not be independently inspected: this session's GitHub tool surface
(GitHub MCP server) does not expose a rulesets/branch-protection read
endpoint, and raw GitHub API calls are outside this session's permitted
tool surface. This does not change the conclusion above — whether or not
"Runtime Authority Governance" is currently configured as a *required*
check on `main`:

- if it is required, a trust-root PR against `main` would show the check
  as perpetually unscheduled/absent and could never merge through normal
  branch-protection semantics; or
- if it is not required, the PR could merge without the check ever having
  run, i.e. without governance validation.

Either way, #390's real privileged publication path — a Runtime Authority
trust-root PR against the canonical protected ref that actually receives
Runtime Authority Governance validation — is not achievable against the
current `main` before the Epic (which carries the workflow) merges.

## Smallest architectural fix required

Land `#390`'s governance surface — `.github/workflows/runtime-authority-governance.yml`,
`scripts/validate-runtime-authority-governance.mjs`, and the
`src/agent-authority/*` modules it imports — on `main` itself (i.e. the
Epic branch reaching `main`, or a narrowly-scoped standalone PR carrying
only that governance surface to `main` ahead of the full Epic merge).
Once `main` carries the workflow, a genuine trust-root PR against `main`
can receive Runtime Authority Governance validation and independent human
approval as #390 intends, and the #378 dogfood sequence (Phases 1–6) can
run for real.

## What was not done, and why

Per the task's explicit instructions, none of the following were
performed, since they all depend on a viable #390 privileged publication
path that does not currently exist on `main`:

- installing/registering a dogfood Runtime public authority through
  #390's governance path;
- issuing a short-lived Session credential;
- running the isolated-Agent positive path (`change issue` /
  `change publish` / `change show` / `change ready`) against the
  deployed Cloudflare Worker;
- the negative probes in Phase 5;
- the abort/recovery fixture in Phase 6.

No manual trust-root placement, ruleset weakening, raw GitHub API trust
injection, or synthetic trust root was used to work around the blocker,
per the task's explicit prohibitions.

## Validation

`pnpm run verify` was not run as part of this report: no source, script,
or governance file was modified — only this evidence document was added.
