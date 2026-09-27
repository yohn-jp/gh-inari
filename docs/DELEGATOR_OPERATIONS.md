# Delegator Operations Runbook

Status: operator procedure under [Product Architecture Canon](./ARCHITECTURE.md)
and [Caller Authentication](./AGENT_CAPABILITY_AUTHORIZATION.md).

This runbook preserves key generation, trust publication, readiness, rotation,
revocation, backup, and recovery. Runtime Authority is the existing public/wire
name for the Delegator. Terminology changes do not rewrite committed records,
signatures, paths, or diagnostics.

Examples describe existing product operations. Use installed Help for exact
syntax and obey the active organization policy for who may invoke them.
Documentation does not remove the current agent-use suspension.

## 1. Operating model

```text
Authority-owned key generation or exact-identity adoption
  -> canonical public trust record
  -> operator-controlled trust-root worktree
  -> governed trust publication
  -> independent human review and protected-ref merge
  -> protected-ref reread and signer readiness
  -> bounded local delegation or admitted provenance signing
  -> overlap rotation or governed revocation
```

Authority may prepare private custody before repository trust exists. That
preparation does not authorize delegated work before trust/readiness succeed.
Requiring execution readiness to enroll the first key would create a bootstrap
cycle.

The protected canonical ref is the repository trust source. A working branch,
local file, matching secret, or healthy process is not trust.

## 2. Formats and custody

The current signing key is Ed25519 with PKCS#8 PEM private representation.
Private files use the owner storage contract, including restrictive ownership,
`0600` files and private `0700` directories where those modes apply.

The public JWK contains only `kty`, `crv`, and `x`. The public fingerprint is
diagnostic identity data, not a replacement for current trust. Private JWK
`d` must never enter a public record.

The public record remains:

```text
.github/inari/authorities/<authority-id>.json
```

It contains public identity, active/disabled status, validity, maximum Session
TTL, and semantic capability ceiling. Exact versioned schema and canonical
serialization remain in the Delegator implementation.

Authority custody is Authority-ID-scoped in the multi-identity target.
Repository configuration references public ID/fingerprint only. A shared
Authority may be trusted independently by multiple repositories without
copying its key into repository directories.

The compatibility path `~/.config/inari/runtime-authority.pem` may remain a
verified adoption input. It is not a cross-component binding or permission to
bypass the owner store.

A Delegator key is not an App key, user token, Session key, Control mTLS key,
or Relay transport key. Executor receives signed evidence/public identity,
never this private material.

## 3. Existing explicit CLI operations

These are product reference examples, not instructions for an agent to ignore
repository governance:

```sh
inari authority generate --private-key runtime-a.pem --json

inari authority bootstrap \
  --private-key runtime-a.pem \
  --authority-id runtime-a \
  --output runtime-a-authority.json \
  --max-session-ttl-seconds 7200 \
  --capability change.implement \
  --capability change.ready \
  --json

inari authority register --from runtime-a-authority.json --json
inari authority rotate --from rotation.json --json
inari authority revoke runtime-a --json

inari authority readiness \
  --authority-id runtime-a \
  --private-key runtime-a.pem \
  --probe-issue 522 \
  --session-ttl-seconds 7200 \
  --capability change.implement \
  --json
```

Select actual probe Issue, validity, and capabilities for the target. An
example Issue number is not operational authorization.

Bootstrap accepts exactly one admitted private-key or public-key input and
writes a canonical public record outside the trust directory. Register is
the explicit local materialization step. Omitted supported `notAfter` retains
the existing null representation, not an exemption from Session TTL checks.

Generate/bootstrap/register/rotate/revoke do not themselves approve, merge,
or mutate a GitHub PR, configure an Environment, or establish trust. Setup
publication is a separate owner-authorized action.

## 4. First bootstrap

Start from the current protected default branch in an operator-owned isolated
worktree. Keep private material outside repository contents.

1. Generate or adopt the exact Authority key under its owner.
2. Choose identity, validity, maximum TTL, and narrow capability ceiling.
3. Construct and inspect the canonical public record and fingerprint.
4. Materialize only that public record in the trust-root worktree.
5. Publish through the governed trust PR path and retain its public identity.
6. Obtain actual required governance checks and independent human approval.
7. After merge, reread the protected ref and exact active record.
8. Run readiness under the selected Authority owner and intended operation.
9. Only then admit normal delegated work.

Possession of a new key never approves its registration. Setup publication
reports human wait, not connected/ready. Actual Ruleset enforcement is checked
separately; a validator or this runbook does not prove live protection enabled.

## 5. Trust-root transitions

The existing transition validator requires new records active, rejects
deletion/reactivation, permits revocation as active to disabled, and separates
creation/overlap from revocation transitions.

Keep those as distinct governed phases. Reread the exact public record before
mutation. Setup reruns must not change a registered key, ID, validity, or
ceiling under the guise of idempotent adoption. A conflict requires explicit
rotation/repair, not overwrite permission.

## 6. Signer provisioning and local composition

Authority holds the selected ID/private-key pair. Existing variables
`INARI_RUNTIME_AUTHORITY_ID` and `INARI_RUNTIME_AUTHORITY_PRIVATE_KEY` remain
compatibility provisioning inputs where supported. They belong to that owner
process, not an agent child or repository-global Executor setting.

A secret being present does not prove it matches current trust. Readiness
derives and compares public identity without printing the key.

Setup/CLI use AuthoritySigningPort and public observations. Admission retains
the signed local Session binding. Executor uses its own Inari Access
credentials. Neither owner acquires the other's key.

Remote placement does not change custody. Initial remote Control support does
not add a general remotely callable Authority signing service.

## 7. Readiness

Normal delegation/provenance requires the exact active/current protected-ref
record, matching parseable owner key, permitted TTL/capability intent, current
repository policy/binding, and a successful bounded signer probe.

```sh
inari authority readiness --environment \
  --probe-issue 522 \
  --session-ttl-seconds 7200 \
  --capability change.implement \
  --json
```

The existing probe resolves protected-ref evidence, compares derived public
identity, checks validity and operation intent, and returns only public
identity, policy/ref evidence, bounded probe outcome, and diagnostics.

A working-branch record, old policy SHA, healthy process, or prior successful
probe is not indefinitely current authorization. Unavailable trust fails
closed rather than permitting unbounded cached trust.

## 8. Planned overlap rotation

Use distinct candidate B while A remains the working identity:

```text
prepare B
  -> publish and independently approve/merge B
  -> verify A+B current trust
  -> select/provision B at its owner
  -> prove B readiness and normal operation
  -> separately revoke A through governance
  -> reread and confirm A rejected
  -> retire private copies under operator policy
```

The existing rotation envelope names `currentAuthorityId` and prepared
`nextAuthority`; it adds B without rewriting A.

```sh
inari authority readiness --environment --rotation-phase activate \
  --current-authority-id A --probe-issue 522 --json

inari authority readiness --environment --rotation-phase revoke \
  --current-authority-id A --probe-issue 522 --json
```

A blocked rotation order is a hard stop. Never revoke A while the deployed
signer depends on it. Before revocation, failed migration may restore the last
approved A binding; it does not justify changing A's key or widening its ceiling.

## 9. Revocation and compromise

Use the governed revocation procedure and its independent emergency/human
approval boundary. Reread trust and prove subsequent admission rejects the
affected identity. Revocation does not undo completed provider effects.

Local Session closure, App rotation, Relay rotation, and Hosted signer
revocation remain separate. For planned retirement retain disabled public
history. For a lost key create a new identity; public data cannot recover the
private key. For ID/key mismatch stop signing and inspect actual binding.

Restore a deleted deployment copy only from approved backup and repeat
readiness. Restoration alone is not trust. Do not restore a suspected
compromised key into service; revoke and replace it.

## 10. Backup and destruction

Retain an offline encrypted access-controlled backup under operator policy.
A local or Environment deployment copy is not the sole recovery source.
Inari is not a key escrow or general secrets manager.

Restore only into restrictive owner storage, verify identity, and run
readiness. Never put keys in repository history, Issues/PRs, artifacts, logs,
shell history, or an agent's general environment.

After revocation and the approved rollback window, retire private copies
under secure-destruction policy. Keep public trust history. Rotating one
credential domain does not delete another domain's key.

## 11. Multi-repository adoption and disconnect

Registry records refer to public Authority identity. Adoption verifies
repository and key/fingerprint without destructively moving/regenerating keys.
Canonical migrated records win over stale compatibility input.

Disconnecting one repository cannot delete a key still referenced by another
binding or trust relationship. Trust revocation and owner key retirement are
explicitly selected actions with current evidence. Observation/enumeration
never adopts records or creates owner directories.

## 12. Setup frontends and process lifecycle

The existing `inari setup status|next|console` surfaces use one Setup
Application and owner state. Unified multi-repository Console reuses that
application, not a second wizard engine.

Typed action metadata owns secret-free input. Enrollment bytes stream to the
selected owner and never enter generic action JSON. Operator bearer/CSRF
material stays memory-only and origin/context-bound, absent from URLs/assets.

The dynamic loopback host may start before keys/trust are ready. Start, stop,
and cleanup affect only its own Runtime children/listeners. Observe-only CLI
calls do not become supervisors. A Runtime owned elsewhere is not adopted,
stopped, or restarted merely because it is reachable.

Configuration, health, binding, trust, Session readiness, and Relay
reachability remain separate observations. Existing browser certification is
`pnpm run test:setup-browser`; unavailable prerequisites are blocked, not pass.

## 13. Session and Source operation

Local work selects the current authorized Implementation and exact leaf
branch. The Session task remains that Implementation. Source Change operations
select a Source in both signed and current authorized Source sets.

Do not use the task number as a Change root because older guidance equated
them. The task-bound compatibility claim is limited to leaf publication and
branch-side composition.

Remote human-operated clients use Hosted assertions. They do not receive
Delegator keys or manually copied Session credential bundles. Authority is
not Hosted caller identity.

## 14. Troubleshooting

`missing-deployment-binding`: configure the exact Authority owner pair, not
Executor. `unknown-authority`: correct the ID or complete the protected trust
PR. `inactive-authority`: use approved active trust or complete rotation.

`invalid-private-key`: restore valid bounded Ed25519 owner material.
`key-mismatch`: stop and repair the actual ID/key/trust binding.
`ambiguous-authority`: resolve the exact public trust conflict.

`canonical-trust-unavailable`: restore bounded protected-ref reads; never use
an agent working branch instead. `ttl-exceeds-ceiling` and
`capability-exceeds-ceiling`: narrow intent or govern a separate trust change.
`signer-probe-failed`: inspect key identity, validity, and probe safely.

Existing `RUNTIME_AUTHORITY_*` codes retain machine-facing meaning. Errors
never echo private material, tokens, headers, or raw provider responses.

## 15. Compatibility inventory

Retain supported RuntimeAuthority-named types/functions as thin aliases to
Delegator code, existing `runtimeAuthority`, `authorityId`, and `runtime:<id>`
fields, `runtime-authority` record kind, `runtime-authority-rotation` envelope,
and protected trust path.

Existing provisioning variables, key-reader paths, public signatures,
canonical JSON vectors, and `Runtime Authority Governance` check name retain
their versioned behavior until approved migration.

These representation/API adapters do not retain independent Direct App
execution, a Hosted Session engine, or a second trust source.

## 16. Operator evidence

Record public identity/fingerprint, repository, protected-ref SHA, trust PR,
readiness outcome, intended TTL/capability, rotation phase, and bounded failure.
Exclude private bytes, credential-bearing environment, raw signed payloads,
tokens, and provider exceptions.

A unit probe is not live Ruleset proof. A Source-branch test is not a
current-main deployment certification. Publishing this runbook performs none
of those operations.
