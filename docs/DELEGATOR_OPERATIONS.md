# Authority and Delegator Operations

Status: operator guide subordinate to [Authorization](./AGENT_CAPABILITY_AUTHORIZATION.md) and [Product Architecture Canon](./ARCHITECTURE.md). Runtime Authority is the existing compatibility name for the delegation-signing owner, not the Relay identity or provider App.

## 1. Ownership and trust

Authority owns the private delegation key. Only its public record and fingerprint are published or referenced by repository setup. Repository trust is established by the protected canonical ref, not by a local file, a healthy process or possession of a key.

The current public record path is `.github/inari/authorities/<authority-id>.json`. Existing record schemas and validators define status, validity, maximum Session lifetime and capability ceiling. Use their canonical construction/validation; do not hand-invent a wider record to make setup succeed.

The key is not an Inari Access private key, OAuth credential or Relay transport key. Admission/Executor receive validated public evidence and signed records, not private delegation material.

## 2. Bootstrap and adoption

Resolve the intended repository and existing local/canonical Authority identities. Adopt an exact matching identity/key/record when available; otherwise create a new one under explicit operator-selected capability and validity intent.

Materialize only the public record in an operator-controlled worktree, publish the governed trust PR, wait for independent human review/merge, then reread the protected record and prove readiness. Preparing or publishing a record is not trust. Key enrollment/preparation may occur before trust; it does not authorize execution before trust is established.

Never regenerate IDs, keys, validity or ceilings merely because setup was rerun. Conflicting public and private evidence fails closed. An existing restricted ceiling is not automatically widened to all product operations.

Repository contexts refer to Authority identity/fingerprint, not private-key paths. Authority-ID-scoped custody may support more than one repository without copying its key; each repository establishes trust independently.

## 3. Current operational surface

The existing authority command family includes generation, bootstrap, registration, readiness, rotation and revocation. Exact flags and supported input formats belong to the installed command contract. This guide introduces no new commands and does not lift the repository's agent-use suspension.

Use the owner-supported enrollment/materialization path instead of manually editing internal JSON. Keep private material out of argv, repositories, browser persistence, generic Setup actions, diagnostics and certification evidence. Owner-only filesystem protections remain required by the implemented storage contract.

## 4. Rotation and revocation

Rotation creates and verifies a candidate identity, establishes its protected trust under the existing overlap rules, switches intended consumers and only then retires the old authorization. App rotation and Relay transport-key rotation do not happen implicitly with it.

The existing trust validator rejects unsupported mutations such as deleting or reactivating records. Follow explicit creation/overlap and revocation phases rather than overwriting the old record. Preserve human review and exact-generation evidence.

Before removing local key material, inspect all remaining repository bindings and trust dependencies. A disconnected repository is not proof that a shared Authority is unused. Never delete operator state as incidental cleanup.

## 5. Readiness and recovery

Readiness verifies current repository identity, protected trust, public/private identity match, validity and applicable Session/capability intent. Runtime health and a file's existence are insufficient.

A failed trust read is unknown, not absence. A published-but-unmerged PR waits for a human. A merged record with stale local observation triggers reread, not another identity. Preserve uncertain publication evidence and reconcile before retry.

Remote human-operated assertions do not require the cloud client to hold this key or request a new Session Certificate. They also cannot invoke signing or trust changes merely by proving repository eligibility.

## 6. Proof and historical names

Prove clean bootstrap, exact-identity adoption, mismatch denial, restricted ceilings, expiry, overlap/revocation, shared-identity retention and secret exclusion. Live trust-rule enforcement is separate from source validation and requires exact repository settings evidence.

`RUNTIME_AUTHORITY_OPERATIONS.md`, older environment names and historical paths are compatibility references only. Current custody and supported migration are established by the release's owner contracts, never inferred from an old runbook example.
