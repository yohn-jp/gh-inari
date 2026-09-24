# Delegator operations runbook

This is the operator runbook for the Delegator lifecycle. It is
subordinate to and must be read with the normative
[Agent Capability Authorization architecture](./AGENT_CAPABILITY_AUTHORIZATION.md),
especially sections 5–7, 12, and 18–19. It does not define another key,
trust, Session, or capability schema.

The public CLI and repository artifacts still contain compatibility names from
the Runtime Authority contract. Those stable names are called out explicitly
in the compatibility inventory at the end of this runbook.

## Operating model

The supported lifecycle is:

```text
local key generation
  -> canonical public record construction
  -> local materialization for a governed trust-root change
  -> Delegator Governance PR and protected-ref merge
  -> per-runtime (authority id, private key) provisioning
  -> canonical protected-ref readiness probe
  -> initiating Runtime signing and bounded Change request
  -> overlap rotation or governed revocation
```

```text
protected main: .github/inari/authorities/*.json (public trust)
                         |
                         v
Runtime A: (authority id A, private key A)
Runtime B: (authority id B, private key B)
                         |
                         v
       initiating Runtime signed bounded provenance record
                         |
                         v
trusted executor: read signature.kid and resolve matching public record
```

The repository's protected default branch is the trust root. A working branch,
local checkout, or deployment secret is not authority by itself.

## Formats and ownership

- Delegator keys are Ed25519. The private key is PKCS#8 PEM and is a long-lived
  Runtime/signer secret. The compatibility default local path is
  `~/.config/inari/runtime-authority.pem`; generated files use owner-only
  permissions (`0600`) in private directories (`0700`).
- The public key is a JWK containing only `{ "kty": "OKP", "crv":
"Ed25519", "x": "..." }`. `x` is unpadded base64url Ed25519 public-key
  material. It is safe to publish in the trust record.
- The canonical public record is
  `.github/inari/authorities/<authority-id>.json`. It includes the key,
  active/disabled status, validity window, `maxSessionTtlSeconds`, and the
  semantic `capabilityCeiling`.
- The authority ID (`kid`) is a stable lowercase identifier. The public
  identity fingerprint printed by Inari is `sha256:` over the canonical public
  JWK; it is diagnostic identity data, not a replacement for repository trust.

The Delegator private key belongs only to the Runtime/signer trust domain. It is
never an App credential, GitHub credential, Session credential, or Agent
credential. The signer may hold it transiently to produce a signature. The
executor receives only the signed record and resolves the public key from the
canonical protected ref.

For fresh Change issuance, the initiating Runtime creates this record with its
own `(authority id, private key)` pair and includes the resulting
`signedProvenanceRecord` in the bounded Change request. The executor never
creates a replacement record or derives an authority ID from deployment
configuration.

## CLI surface

These are the current command-contract commands. Add `--json` for bounded
machine-readable output.

```sh
# Generate a local keypair. This never writes repository trust.
inari authority generate --private-key runtime-a.pem --json

# Construct the canonical public record from that key; no JWK hand-editing.
inari authority bootstrap \
  --private-key runtime-a.pem \
  --authority-id runtime-a-2026-09 \
  --output runtime-a-authority.json \
  --not-before 2026-09-13T00:00:00Z \
  --max-session-ttl-seconds 7200 \
  --capability change.implement \
  --capability change.ready \
  --json

# Materialize the public record in the local trust-root worktree.
inari authority register --from runtime-a-authority.json --json

# Add a distinct active record during overlap rotation.
inari authority rotate --from rotation.json --json

# Disable an exact existing record; this is idempotent and does not delete it.
inari authority revoke runtime-a-2026-09 --json

# Verify a local signer key against canonical protected-ref trust.
inari authority readiness \
  --authority-id runtime-a-2026-09 \
  --private-key runtime-a.pem \
  --probe-issue 522 \
  --session-ttl-seconds 7200 \
  --capability change.implement \
  --json
```

`authority bootstrap` writes one canonical Delegator public record to `--output` and
reports that repository trust and deployment binding were unchanged. It
accepts exactly one of `--private-key` or `--public-key`; the latter reads an
explicit public JWK. `--not-after` is optional and omitted means `null`. The
bootstrap output must remain outside `.github/inari/authorities`; use
`authority register` for the explicit local trust-root materialization step.

`authority generate`, `bootstrap`, `register`, `rotate`, and `revoke` do not
open, merge, or mutate a GitHub PR and do not write a GitHub Environment.

## First bootstrap from zero trusted authorities

Use an operator-controlled worktree based on the current protected default
branch. The first public key has no authority until its record is merged.

1. Generate the private key locally with `authority generate`. Keep the file
   under Runtime-owner control and make an encrypted offline backup before
   continuing.
2. Run `authority bootstrap` with an operator-selected ID, validity window,
   TTL ceiling, and explicit semantic capability ceiling. Inspect the resulting
   public record and its `sha256:` fingerprint.
3. In the dedicated trust-root worktree, run `authority register --from` on
   the prepared record. Review the exact diff. Only the public record may be
   committed; the private PEM must remain outside repository contents.
4. Push the trust-root branch and open the repository's governed PR. Use
   `inari pr schema` / `inari pr create` for the repository-native PR contract
   where those commands are used. The existing `Runtime Authority Governance`
   check name and
   an independent human approval are required by the repository Ruleset.
5. Do not configure the signer secret before the trust-root PR is merged. After
   merge, confirm the record exists on the protected default branch, is active,
   and is within its validity window.
6. Provision the initiating Runtime with this authority's exact `(authority
id, private key)` pair and run readiness from that Runtime's secure
   environment. Readiness must be `state: "ready"` before fresh Change
   issuance or dogfood. Do not configure the pair as repository-wide Change
   executor settings.

Possession of the generated key never approves its own registration. A local
record on a feature branch is a review input, not canonical trust.

## Trust-root PR sequence

Trust-root changes are versioned Git state:

```text
prepare public record -> register in operator worktree -> inspect diff
-> Delegator Governance check (the existing `Runtime Authority Governance` check)
-> independent approval
-> merge to protected default branch -> verify canonical ref and policy SHA
```

The governance validator requires new records to be active, rejects deletion,
rejects reactivation, permits revocation only as `active -> disabled`, and
rejects mixing creation and revocation in one trust-root transition. Keep
creation/overlap and revocation as separate PR phases.

## Per-runtime signer provisioning (#518)

Each independently operated Runtime is provisioned with its own pair, owned by
that Runtime deployment operator. If the readiness command reads environment
variables, the names below are scoped to that Runtime process or deployment;
they are not repository-global Change executor configuration:

| Name                                  | Kind                  | Value and ownership                                                    |
| ------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `INARI_RUNTIME_AUTHORITY_ID`          | Runtime configuration | Exact canonical authority ID selected by this initiating Runtime.      |
| `INARI_RUNTIME_AUTHORITY_PRIVATE_KEY` | Runtime secret        | The matching PKCS#8 Ed25519 PEM; held only by this initiating Runtime. |

The trusted executor receives only the resulting signed provenance record. It
does not receive either private key or a repository-global authority ID. The
direct App path, Actions path, MCP path, Agent Session, and effect adapter
remain private-key-free.

GitHub does not reveal a secret after registration. Therefore, do not use
“secret exists” as readiness evidence. Run the readiness command inside the
approved signer environment with its exact variables:

```sh
inari authority readiness --environment \
  --probe-issue 522 \
  --session-ttl-seconds 7200 \
  --capability change.implement \
  --json
```

`--environment` reads the initiating Runtime's
`INARI_RUNTIME_AUTHORITY_ID` and `INARI_RUNTIME_AUTHORITY_PRIVATE_KEY` without
printing either value. The command resolves the repository's protected
default branch, confirms the record is active/current, derives the public key
from the private key, compares the public identity exactly, checks optional
TTL/capability intent, and runs a bounded `change.issue` sign-and-verify probe.
It returns only public identity, protected-ref provenance, the probe result,
and stable failure diagnostics.

## Readiness and release prerequisites

Fresh `change issue` / self-dogfood / release certification requires all of:

- an active, currently valid Runtime record on the canonical protected ref;
- the initiating Runtime's configured authority ID;
- that Runtime's parseable PKCS#8 Ed25519 private key whose derived public JWK
  exactly matches the canonical record;
- a TTL and semantic capability ceiling that admit the intended operation; and
- a successful bounded signer probe.

Canonical trust is re-resolved for the signing/execution request. A local
feature-branch record, an old policy SHA, or a matching secret with an unknown
public key is not sufficient.

## Planned overlap rotation

Use two distinct authority IDs and keep the old and new records trusted during
the migration:

```text
A = current active authority
B = newly generated authority

1. generate B private key
2. bootstrap B's public record and register/PR it as a new active record
3. merge the B trust PR; confirm A+B are both canonical and active
4. provision the matching B key and ID to Runtime B
5. run readiness from Runtime B and observe a bounded successful signing probe
   for B
6. create a separate revoke PR for A and merge it
7. run readiness again and verify A is inactive under current trust
8. securely retire A's private-key copies under operator policy
```

`authority rotate --from rotation.json` is the existing overlap materializer;
its envelope names `currentAuthorityId` and contains the already prepared
`nextAuthority` public record. It adds B without rewriting A. Do not activate B
before B is trusted, and do not revoke A until the deployed signer has moved to
B and readiness has succeeded.

Before step 4 (activating B) and before step 6 (revoking A), run readiness with
`--rotation-phase` from the deployment that will perform that step:

```sh
# before binding/activating B (step 4)
inari authority readiness --environment --rotation-phase activate \
  --current-authority-id A --probe-issue 522 --json

# before revoking A (step 6), run from Runtime B
inari authority readiness --environment --rotation-phase revoke \
  --current-authority-id A --probe-issue 522 --json
```

This checks B's readiness against canonical trust and, for `revoke`, confirms
the deployment's configured signer has already moved to B before A may be
revoked. A `blocked` rotation order is a hard stop: do not revoke A while the
signer is still bound to A.

If migration fails before A is revoked, leave A active, restore the last known
working A deployment binding, and investigate. Do not replace A's local file
and call that rotation: a new key is a new cryptographic identity.

## Emergency revocation and compromise response

For suspected compromise, revoke the affected ID immediately through the
governed trust-root path with `authority revoke <authority-id>`. Merge the
revocation under the required review/emergency procedure, then confirm that
current-trust verification rejects the old authority. Removing or disabling
the record invalidates outstanding Runtime certificates on subsequent current
trust checks; there is no central revocation database.

- **Planned retirement:** follow overlap rotation, then revoke and retire the
  old key. Never delete the old public record; disabled history is governance
  evidence.
- **Lost or unrecoverable key:** the public record is not recoverable into a
  private key. Generate a new key and ID, add it through overlap governance if
  possible, bind it, verify it, then revoke the unusable old ID.
- **Deleted Environment secret:** restore the Environment copy from the
  operator's encrypted backup, then rerun readiness. Secret restoration alone
  does not establish trust.
- **Authority disabled while deployed:** stop fresh signing, restore a valid
  approved binding only if the authority is intentionally still trusted, or
  generate/bind a replacement and perform overlap recovery. Do not bypass the
  canonical ref.
- **Unknown or mismatched ID/key:** stop the signer. Check the ID, key file,
  canonical protected-ref record, and policy SHA; do not generate a second
  unreviewed trust artifact as a workaround.

## Backup, recovery, and retirement policy

For a long-lived Runtime key, retain an offline, encrypted, access-controlled
backup under the operator's key-management policy. The GitHub Environment is a
deployment copy, not the sole source of truth. Inari does not provide a general
secrets manager or key escrow service.

Backups must preserve the PKCS#8 PEM bytes and restrictive ownership. Restore
to a private directory and a `0600` file, then run readiness before use. Never
put a backup in a repository, Issue, PR, artifact, log, shell history, or
ordinary environment shared with an Agent. If compromise is suspected, do not
restore the compromised key; revoke its authority and replace it.

After revocation has merged and no rollback is approved, remove retired private
copies according to the operator's secure-destruction policy. Keep the disabled
public record and its governance history. A replacement key must always use a
new public identity and a separately governed record.

## Troubleshooting

| Readiness state / code                                           | Meaning                                                            | Recovery                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `missing-deployment-binding` / `...MISSING_DEPLOYMENT_BINDING`   | The initiating Runtime's ID or private key is absent.              | Configure that Runtime's exact pair; do not put the key in the executor.                    |
| `unknown-authority` / `...UNKNOWN_AUTHORITY`                     | ID is not on the protected canonical ref.                          | Merge the public trust PR, or correct the deployment ID.                                    |
| `inactive-authority` / `...INACTIVE_AUTHORITY`                   | Record is disabled or outside its validity window.                 | Use an active approved authority or complete rotation; do not edit the deployment alone.    |
| `invalid-private-key` / `...PRIVATE_KEY_INVALID`                 | PEM is missing, malformed, too large, or not Ed25519 PKCS#8.       | Restore/generate a valid private key in secure storage.                                     |
| `key-mismatch` / `...KEY_MISMATCH`                               | Derived public key does not equal canonical trust.                 | Stop; correct the ID/key binding or govern a new authority.                                 |
| `ambiguous-authority` / `...AMBIGUOUS_AUTHORITY`                 | Canonical trust has duplicate/ambiguous identity.                  | Repair the exact trust-root governance violation; fail closed until then.                   |
| `canonical-trust-unavailable` / `...CANONICAL_TRUST_UNAVAILABLE` | Protected-ref identity, tree, or blob could not be read/validated. | Restore bounded repository read access and retry against the protected ref.                 |
| `ttl-exceeds-ceiling` / `...TTL_EXCEEDS_CEILING`                 | Intended Session TTL is beyond the record ceiling.                 | Request a shorter TTL or govern a new explicit ceiling.                                     |
| `capability-exceeds-ceiling` / `...CAPABILITY_EXCEEDS_CEILING`   | Intended semantic capability is not delegated.                     | Narrow the operation or govern a record with the required ceiling.                          |
| `signer-probe-failed` / `...SIGNER_PROBE_FAILED`                 | Bounded sign/verify probe failed.                                  | Stop signing; inspect the key, validity time, and canonical record without logging secrets. |

Diagnostics are deliberately bounded and never include PEM, JWK private `d`,
tokens, headers, or raw provider errors.

## Never do this

- Never commit, paste, print, or upload a Runtime private key.
- Never put the Runtime private key in App/executor, direct-App, MCP, Agent
  Session, effect-adapter, repository-level, or general-purpose executor
  configuration. Keep it only in the initiating Runtime that signs the
  request.
- Never let possession of a Runtime private key self-authorize trust
  registration, rotation, review, or merge.
- Never rotate by merely replacing a local file or GitHub secret. Add and merge
  the new public trust first, migrate and verify the signer, then revoke the
  old public trust.
- Never treat a working-branch authority file, local checkout, or unmerged PR
  as authorization truth.
- Never weaken `authority register`, `authority rotate`, `authority revoke`,
  Delegator Governance, protected-ref resolution, or fail-closed
  diagnostics to recover from a provisioning error.
- Never add a central Runtime registry, revocation database, HSM/KMS product,
  or general secrets manager to this workflow.

## Local execution plane

Use one isolated `INARI_CONFIG_HOME` for the local CLI, Admission, Executor,
and Runtime Authority. `inari init` reports the ordered setup state and the
next supported command. Repository Runtime onboarding through
`inari setup --endpoint <endpoint-url>` performs GitHub App Device Flow and
stores the App-user credential at `$INARI_CONFIG_HOME/app-user-credential.json`
by default. That App-user credential authorizes only this bootstrap publication;
`inari setup` also writes the repository Runtime profile that binds the
repository to its Inari Issuer App installation. Configuring the local Executor
remains a separate step.

The local Executor performs post-bootstrap provider reads and governed effects
with Inari Issuer App installation credentials, never the App-user credential.
Set `INARI_GITHUB_APP_ID` (or `GITHUB_APP_ID`) to the numeric App ID reported
by `inari setup` and `INARI_GITHUB_APP_PRIVATE_KEY_FILE` to the Issuer App
private key (`.pem`) path, then run `inari executor setup`. `inari executor
setup` and `inari init` check only that this Executor-owned reference is set;
they never open or parse the key. Only the running Executor reads and validates
the key, at start and at each authorized execution, and it mints repository-scoped installation tokens for the
installation recorded in the Runtime profile, and fails closed on a missing or
unreadable, or invalid key, a mismatched App, installation, or repository, or insufficient
installation permissions. The key is never written to Executor configuration,
Runtime profiles, Admission, Session, or `inari init` output; the Supervisor
withholds it from Admission and the Agent child. Run `inari authority setup`
to create local key custody, followed by `inari authority bootstrap` to create
the public Runtime Authority record. Pass that public file to
`inari admission setup --from <public-record-file>`; this pins public trust and
binds the CLI Admission route. The private Authority key stays in its local
custody directory, App-user credentials stay in their credential file, and the
Issuer App private key stays in Executor-owned custody.

Run `inari runtime supervise` to start and supervise the local Executor and
Admission processes together and verify their discovered loopback readiness.
Admission checks the configured Executor identity before becoming ready. The
CLI and Agent child use the configured Admission route and do not need
provider credentials.

Before Session start, check out the canonical Issue-bound Change branch
(`<feat|fix|docs|refactor|test|chore>/<issue-number>-<slug>`) for the Issue
you are implementing; `inari init` reports whether one is currently selected.
From that governed repository checkout, launch the Agent with
`inari session start --issue <n> -- <command...>`. The child inherits
`INARI_SESSION_ID`; `inari change show <n>` and admitted Change mutations use
that Session. Run `inari session close` with the same selector when finished.
The local process route is certified without live provider services by
`test/local-execution-plane-certification.test.mjs` in `pnpm run verify`.

## Runtime Authority compatibility inventory

The following names are stable compatibility surfaces. They remain readable,
verifiable, and byte-compatible while the canonical architecture and library
terminology use Delegator. Compatibility exports are aliases or thin
re-exports of the Delegator implementation; they do not define a second trust
model.

| Compatibility surface        | Stable value/name                                                                                                                      | Canonical Delegator surface                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Library modules              | `src/agent-authority/runtime-authority*.ts`, `runtime-key.ts`                                                                          | `delegator*.ts` and `delegator-key.ts`                              |
| Types and functions          | `RuntimeAuthority*`, `validateRuntimeAuthority`, `assertRuntimeAuthority`, `canonicalRuntimeAuthorityJson`, `isRuntimeAuthorityActive` | `Delegator*` and corresponding Delegator functions                  |
| Trust and key APIs           | `loadRuntimeAuthorityTrust`, `resolveRuntimeAuthority`, `generateRuntimeKeyPair`, and related exports                                  | Delegator-named equivalents                                         |
| Public fields and identity   | `runtimeAuthority`, `authorityId`, `runtime:<id>`                                                                                      | Unchanged wire/property values; Delegator is the semantic role name |
| Persisted trust records      | kind `runtime-authority`; path `.github/inari/authorities/<authority-id>.json`                                                         | Unchanged for existing records and verification                     |
| Rotation and local key paths | kind `runtime-authority-rotation`; `~/.config/inari/runtime-authority.pem`                                                             | Unchanged compatibility paths and envelopes                         |
| Provisioning variables       | `INARI_RUNTIME_AUTHORITY_ID`, `INARI_RUNTIME_AUTHORITY_PRIVATE_KEY`                                                                    | Unchanged deployment contract                                       |
| Diagnostics and governance   | `RUNTIME_AUTHORITY_*`; check name `Runtime Authority Governance`                                                                       | Canonical code paths retain these machine-facing identifiers        |
| CLI command group            | `inari authority ...`                                                                                                                  | Unchanged command contract; it operates on Delegators               |

Committed trust records are not rewritten solely for this terminology
migration. Existing signatures, canonical JSON, golden vectors, persisted
paths, and verification inputs remain valid.
