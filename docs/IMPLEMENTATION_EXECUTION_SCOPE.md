# Implementation Execution Scope

Status: normative projection contract under
[Product Architecture Canon](./ARCHITECTURE.md) and
[Implementation Contract](./IMPLEMENTATION_CONTRACT.md).

`implementation-execution-scope` is the versioned transport-neutral projection
of one currently authorized Implementation. It is not a second authorization
model, a Hosted capability, or a replacement for physical filesystem isolation.

The existing producer is `src/implementation-scope-projection.ts`. Consumers
use its exported schema, parser, validator, evaluator, and serializer rather
than reconstructing scope from Issue prose or a consumer-specific type.

## 1. Artifact identity

The current v1 constants remain:

```text
kind: implementation-execution-scope
version: 1
schema ID: urn:inari:implementation-scope-projection:1.0.0
```

Their executable owners are `IMPLEMENTATION_SCOPE_PROJECTION_KIND`,
`IMPLEMENTATION_SCOPE_PROJECTION_VERSION`, and
`IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA_ID`.
The exported schema and `projectImplementationScopeSchema()` describe the
exact wire shape; this renewal does not silently version it.

Supported readers include `parseImplementationScopeProjection`,
`deserializeImplementationScopeProjection`,
`validateImplementationScopeProjection`, and
`isImplementationScopeProjection`. Canonical output uses
`serializeImplementationScopeProjection`.

Unsupported kind/version, unknown properties, invalid values, and
noncanonical serialized JSON fail closed. The existing accepted trailing
line feed remains a bounded serialization compatibility rule.

## 2. Root fields

Every v1 artifact carries:

- `version` and `kind` as exact discriminators;
- `authorization` identifying the producing authorization;
- `repository` copied from that current authorization;
- `base` with accepted branch/revision/freshness evidence;
- optional `branch` when an execution branch is already decided;
- `scope` containing all five independent path lists.

An absent branch means no branch was decided. It is not permission to select
any branch or infer one from a Source name.

## 3. Authorization binding

The authorization portion identifies its version/kind, Implementation contract
version, repository-bound Implementation Issue reference, and lower-case
SHA-256 governed-body digest.

The repository includes host, immutable ID, and optional owner/name locator.
Base includes branch, revision, and freshness. Consumers cannot substitute
a different repository, body, or base because the path lists look identical.

This is the Implementation task's scope. Source Change identity remains
separate; membership in multiple Sources does not multiply or union path
permission beyond this authorized projection.

## 4. Independent operations

`readOnly` allows the declared reads and no mutation.
`write` allows the declared modifications and is never inferred from read
access. `create` allows creation and is not inferred from write.
`delete` allows deletion and is not inferred from write.
`deny` applies before the relevant operation allowlist and narrows every one.

Every list is present. An absent source mutation allowance is represented by
an empty list, not by a permissive default. Empty lists remain empty.

Use `isImplementationScopeProjectionPathAllowed` and
`isImplementationScopeProjectionPathDenied` for canonical path evaluation.
A consumer must not implement another glob language, case-normalization rule,
or DENY precedence.

A rename or replacement is evaluated using the actual required operations.
It cannot hide creation/deletion under a generic write label.
Protected repository trust/policy paths retain their additional immutable
security boundary even when a broad task path pattern matches them.

## 5. Lifecycle preconditions

`projectImplementationScope` and `tryProjectImplementationScope` accept the
existing lifecycle verification input. They derive output from current valid
authorization and canonical contract. They do not accept caller override paths
or merge an externally supplied scope.

Missing, stale, invalidated, superseded, completed, aborted, or modified
post-authorization evidence cannot produce a current active execution grant.
A previously serialized valid projection is not indefinitely current merely
because its bytes still pass structural validation.

Fresh authorization/lifecycle verification and structural parsing are
different proofs. A consumer needing current execution authority must satisfy
both.

## 6. Serialization and transport

Canonical JSON serialization fixes normalized keys and paths through the
existing producer. Compare and transport that output rather than defining a
new wire encoding.

CLI, MCP, Relay, or another transport does not add path authority, create a
Session, or transform this artifact into a provider token. It carries only
the bounded projection and required provenance.

## 7. Consumer boundary

The artifact contains no Nawabari/Wabachi-specific runtime type, shared SDK,
filesystem handle, credential, or execution engine. External consumers depend
on the public schema/parser/projection contract.

A physical runtime owns secure filesystem interpretation, process isolation,
and enforcement on its host. Inari owns the admitted semantic scope. Neither
may silently widen the other boundary.

Lexical Path Canon can identify an address but cannot replace ownership,
mode, symlink/no-follow, or descriptor safety checks at the storage owner.

## 8. Verification and migration

Preserve exact v1 serialization fixtures, unsupported/unknown-field denials,
empty-list behavior, independent WRITE/CREATE/DELETE, DENY precedence,
repository/body/base mismatch, and lifecycle invalidation tests.

When Source/task identity or upstream authorization changes, reprove the
producer-consumer join without inventing a new parallel scope language.
A schema-native artifact migration elsewhere does not automatically change
this execution-scope wire version.

This documentation declares the contract and its continued role. It neither
changes the executable projector nor claims downstream enforcement was run.
