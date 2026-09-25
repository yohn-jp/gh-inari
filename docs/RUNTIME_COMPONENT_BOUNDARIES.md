# Runtime Component Boundaries

Source: #1098. Implementation: #1105. Epic: #1097. Baseline: `569c2399fe63bb78adf92a766375da8fd9485ca8`.

Inari ships as one product and one distribution. This document freezes the public Runtime ports, the ownership of every Runtime component, and the import direction the migration leaves (#1106, #1107, #1108, #1109, #1110, #1111) build against. Module isolation is not OS sandboxing. It keeps private secret-holding code out of the components that must not load it.

The executable authority is:

- `src/runtime-contracts/`: the public ports, DTOs, validators and ownership catalog.
- `scripts/check-runtime-boundaries.mjs`: the dependency guard. It runs in `pnpm run verify` as `boundaries:check`.
- `test/runtime-boundaries.test.mjs`: the guard proofs and the frozen migration-ledger baseline.

## Components and ownership

`RUNTIME_COMPONENT_CATALOG` in `src/runtime-contracts/components.ts` is the canonical catalog. The guard's `RUNTIME_ROLE_OWNERSHIP` must match it exactly, and `src/runtime-contracts/components.test.ts` checks that it does.

| Component           | Owner leaf | Owned modules                                                                                                                  | Public entries                                      | Implements                                                               | Consumes                                                                                                                                                        |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-contracts` | #1105      | `src/runtime-contracts/`                                                                                                       | `src/runtime-contracts/index.ts`                    | —                                                                        | —                                                                                                                                                               |
| `setup-application` | #1110      | `src/application/setup/`                                                                                                       | `src/application/setup/index.ts`                    | —                                                                        | `SetupObservationPort`, `SetupActionPort`, `SetupJournalPort`, `SecretEnrollmentPort`                                                                           |
| `cli`               | #1108      | `src/cli/`, `src/local-control/admission-client.ts`, `src/local-control/session-launcher.ts`, `src/local-application-state.ts` | `src/cli/runtime/session-launcher.ts`               | —                                                                        | `AdmissionSessionPort`, `AuthoritySigningPort`, `RuntimeRoleStatusPort`                                                                                         |
| `console`           | #1109      | `src/local-control/console-server.ts`                                                                                          | `src/local-control/console-server.ts`               | —                                                                        | `RuntimeRoleStatusPort`                                                                                                                                         |
| `admission`         | #1107      | `src/admission/`, `src/local-control/admission-server.ts`, `src/local-control/session-store.ts`                                | `src/admission/setup.ts`, `src/admission/server.ts` | `AdmissionSessionPort`, `RuntimeRoleStatusPort`                          | `ExecutorExecutionPort`                                                                                                                                         |
| `executor`          | #1106      | `src/executor/`, `src/local-control/executor-server.ts`                                                                        | `src/executor/setup.ts`, `src/executor/server.ts`   | `ExecutorExecutionPort`, `RuntimeRoleStatusPort`, `SecretEnrollmentPort` | —                                                                                                                                                               |
| `authority`         | #1108      | `src/authority/`                                                                                                               | `src/authority/index.ts`                            | `AuthoritySigningPort`                                                   | —                                                                                                                                                               |
| `composition`       | #1109      | `src/composition/`, `src/local-control/supervisor.ts`                                                                          | `src/composition/index.ts`                          | —                                                                        | `AdmissionSessionPort`, `ExecutorExecutionPort`, `RuntimeRoleStatusPort`, `SecretEnrollmentPort`, `SetupActionPort`, `SetupJournalPort`, `SetupObservationPort` |

Responsibilities follow Epic #1097:

- The CLI and Web console run operations and display results. They do not reimplement workflow or branch policy.
- The setup application holds secret-free state, the allowed actions, prerequisites, freshness and the next action.
- Admission authorizes Sessions, Delegators and capabilities. It holds no GitHub credential.
- The Executor holds the Issuer installation credential and performs authorized provider effects.
- The Authority owner holds the initiating Runtime's private signing key.
- Composition selects roles, runs the process lifecycle and connects public ports. It never becomes a private-key parser or a provider authority.

## Frozen public ports

Every port reuses an existing canonical type. None of them adds provider, permission, Session or trust semantics.

| Port                    | Module                                | Reused canonical types                                                         | Existing implementation                  |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| `ExecutorExecutionPort` | `src/runtime-contracts/ports.ts`      | `AuthorizedExecution`, `AuthorizedExecutionResult`, `RepositoryIdentity`       | `LocalExecutorClient`                    |
| `AdmissionSessionPort`  | `src/runtime-contracts/ports.ts`      | `LocalSessionBinding`, `ExecutionIntent`, the existing Admission wire identity | `createLocalAdmissionClient`             |
| `AuthoritySigningPort`  | `src/runtime-contracts/ports.ts`      | `SignedChangeProvenanceRecord`                                                 | the existing Delegator provenance signer |
| `RuntimeRoleStatusPort` | `src/runtime-contracts/ports.ts`      | `RepositoryIdentity`, the setup dimension observations                         | #1106 / #1107                            |
| `SetupObservationPort`  | `src/runtime-contracts/ports.ts`      | `SetupObservation`                                                             | #1110 / #1120                            |
| `SetupActionPort`       | `src/runtime-contracts/ports.ts`      | `SetupActionRequest`, `SetupActionResult`                                      | #1110 / #1120                            |
| `SetupJournalPort`      | `src/runtime-contracts/ports.ts`      | `SetupJournalEntry`                                                            | #1110 / #1120                            |
| `SecretEnrollmentPort`  | `src/runtime-contracts/enrollment.ts` | `SecretEnrollmentRequest`, `SecretEnrollmentReceipt`                           | #1114                                    |

`components.test.ts` proves at compile time that `LocalExecutorClient` satisfies `ExecutorExecutionPort` and `LocalAdmissionClient` satisfies `AdmissionSessionPort` without change.

### Setup observations, actions and results (`setup.ts`)

A `SetupObservation` is bound to a `SetupGeneration`: the repository identity plus the owner configuration generation. It carries five separate dimensions:

| Member             | Dimension           | Statuses                                                 |
| ------------------ | ------------------- | -------------------------------------------------------- |
| `configuration`    | `configuration`     | `unknown`, `unconfigured`, `partial`, `configured`       |
| `health`           | `health`            | `unknown`, `not-running`, `unhealthy`, `healthy`         |
| `providerBinding`  | `provider-binding`  | `unknown`, `unbound`, `mismatched`, `bound`              |
| `repositoryTrust`  | `repository-trust`  | `unknown`, `untrusted`, `pending-human-trust`, `trusted` |
| `sessionReadiness` | `session-readiness` | `unknown`, `not-ready`, `ready`                          |

Apart from `unknown`, no status appears in two dimensions. A status from one dimension is invalid in another. There is no aggregate "ready" member. Any known status must carry owner evidence: the owner, the observation time and the generation.

A `SetupAction` declares its owner, prerequisites (a dimension plus the accepted statuses), required inputs (`text`, `choice`, `confirmation` or `enrollment`), confirmation, freshness (a generation plus `notAfter`) and an optional `StructuredCommand` (`executable` plus `argv`, never a shell string). An `enrollment` input names a `SecretEnrollmentKind`. Its value never appears in a `SetupActionRequest`.

`SetupActionResult.outcome` is one of `succeeded`, `failed`, `cancelled`, `stale`, `action-required` or `unknown`. `stale` covers a wrong repository or an outdated generation. `unknown` reports an effect whose outcome was not observed, so the caller reconciles it instead of replaying it blindly.

### Secret-free setup JSON (`secret-material.ts`)

Every setup validator first calls `assertSecretFreeSetupJson`. It rejects:

- PEM blocks;
- GitHub provider tokens and bearer credentials;
- private JWK members;
- members whose names denote secrets, such as `privateKey`, `pem`, `token`, `accessToken`, `refreshToken`, `clientSecret`, `secret` and `password`;
- non-JSON values;
- oversized or deeply nested data.

Diagnostics name the JSON path only and never echo the rejected value. The shared contracts never acquire, parse or store a secret.

### Streaming enrollment (`enrollment.ts`)

PEM files, provider tokens and private signing material cross only through `SecretEnrollmentPort.enroll(request, stream, signal)`:

- The request is secret-free and byte-bounded. `MAX_SECRET_ENROLLMENT_BYTES` is 64 KiB, the existing Issuer key bound.
- Only the owning component consumes the stream. The Issuer private key goes to the `executor`.
- The port returns a public `SecretEnrollmentReceipt`: the outcome plus a `sha256:` public fingerprint.
- The port must be usable before normal Executor or Admission readiness. An implementation must not require health, provider binding or trust before accepting an enrollment.

## Dependency guard

`scripts/check-runtime-boundaries.mjs` resolves every module specifier with the TypeScript resolver (`ts.resolveModuleName`) using the repository `tsconfig.json`. For each role-owned module it walks the full value-import closure, which covers:

- static imports and side-effect imports;
- `export … from` re-exports, which is how barrels such as `src/github/index.ts` load their targets;
- `import x = require()`;
- literal dynamic `import()`.

It reports every forbidden private module the role can load, with a witness path.

Private module groups:

| Group                 | Modules                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer-custody`      | `src/executor/`, `src/local-control/executor-server.ts`, `src/relay/local-runtime-config.ts`, `src/github/app-installation-credential-broker.ts`    |
| `app-user-credential` | `src/github/app-user-credential.ts`, `app-user-credential-store.ts`, `app-user-credential-broker.ts`, `gh-auth-credential.ts`, `user-credential.ts` |
| `authority-signing`   | `src/authority/`, `src/agent-authority/delegator-operations.ts`                                                                                     |
| `admission-private`   | `src/admission/`, `src/local-control/admission-server.ts`, `src/local-control/session-store.ts`                                                     |

Denied groups by role (a role is never denied its own group):

| Role          | Denied                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| `cli`         | `issuer-custody`, `admission-private`                                            |
| `console`     | `issuer-custody`, `admission-private`, `authority-signing`                       |
| `admission`   | `issuer-custody`, `app-user-credential`, `authority-signing`                     |
| `executor`    | `app-user-credential`, `authority-signing`, `admission-private`                  |
| `authority`   | `issuer-custody`, `app-user-credential`, `admission-private`                     |
| `composition` | none; it wires roles and must keep private roles out of the ordinary CLI (#1109) |

The neutral roles are stricter:

- `runtime-contracts` may value-import only itself.
- `setup-application` may value-import only itself and `runtime-contracts`.

Type-only imports are erased at runtime, but they are still restricted. A neutral role may type-import only the approved neutral types (`APPROVED_NEUTRAL_TYPES`): `AuthorizedExecution`, `AuthorizedExecutionOperation`, `AuthorizedExecutionResult`, `RepositoryIdentity`, `Delegator`, `SignedChangeProvenanceRecord`, `LocalSessionBinding` and `ExecutionIntent`. Any other role may type-import from a denied group only those approved symbols.

Some imports inside a role's closure cannot be proven safe. A non-literal dynamic `import()`/`require()` or an unresolvable relative specifier always fails, and no ledger entry can excuse it.

## Historical migration ledger

`HISTORICAL_MIGRATION_EDGES` is empty after #1109. The frozen baseline remains in `test/runtime-boundaries.test.mjs` to prevent reintroducing exceptions. The ledger rules remain:

- An entry must contain exactly `from`, `to` and `owner`.
- Both `from` and `to` must be exact `.ts` module paths. No wildcards, no directories.
- The owner must be one of #1106, #1107, #1108 or #1109.
- The entry must be in the frozen baseline in `test/runtime-boundaries.test.mjs`. A new or grown entry fails verification.
- A removed import is reported as retired until its ledger entry is removed. No entries remain.

All 17 baseline exceptions (#1106: 5, #1108: 7, #1109: 5) are retired. The local role commands load only the selected private implementation through `src/composition/local-runtime-roles.ts`; ordinary CLI clients and the browser console use public ports and status projections.

The baseline has no Admission (#1107) violation. #1107 must keep it that way.

During extraction, a frozen cross-role edge is treated as the historical boundary itself: traversal does not continue through that target under the caller's role, because the target module is checked independently under its owning Runtime role. When code moves from a frozen source into modules of that same owner role, only the exact forbidden targets already recorded for the frozen source may follow that owner-internal path. The ledger itself is unchanged; a new caller, target, owner, wildcard, unresolved import or dynamic import still fails.

## Import direction for producers

- Producers implement the ports in `src/runtime-contracts/` and expose them only through the public entries listed above.
- Consumers import `src/runtime-contracts/index.ts`, never a sibling leaf's implementation or worktree.
- Old `src/local-control/*` paths may remain as bounded compatibility facades until #1109 wires the composition. They are not approved access to private implementation.
- Adding a module under an owned prefix places it under the guard automatically.
