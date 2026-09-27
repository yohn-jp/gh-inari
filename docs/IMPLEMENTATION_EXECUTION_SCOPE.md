# Implementation Execution Scope

Status: normative existing projection under [Implementation Contract](./IMPLEMENTATION_CONTRACT.md). This documentation revision does not change its v1 serialized schema.

## 1. Producer and identity

`src/implementation-scope-projection.ts` owns the versioned projection, parsing, validation, path evaluation and canonical serialization. Consumers use those public surfaces instead of reparsing Issue bodies or creating another scope model.

The current discriminator is `kind: implementation-execution-scope`, version `1`, with schema identity `urn:inari:implementation-scope-projection:1.0.0`. Public schema/parse/validate/serialize functions remain the executable authority for exact field names and encoding.

The projection contains authorization identity, immutable repository, base evidence, an optional already-decided branch and independent scope lists. Authorization includes the Implementation reference, contract/authorization version and governed-body digest. An absent branch grants no branch.

## 2. Operation-specific authority

The lists `readOnly`, `write`, `create`, `delete` and `deny` are separate. DENY is evaluated before the applicable allowlist. WRITE never implies CREATE or DELETE; READONLY never implies mutation. Empty lists stay empty.

Paths are canonical repository-relative paths/globs under the existing evaluator. Consumers must not widen them through local normalization, fallback patterns or a different glob implementation. Scope is projected from a verified current authorization, not supplied/merged by the caller.

## 3. Lifecycle and freshness

Missing, stale, superseded, completed, aborted, invalidated or modified-after-authorization tasks cannot produce fresh execution scope. Repository, digest, base and branch bindings travel with the projection and cannot be substituted independently.

Source membership and Change-root selection remain separate from file-operation scope. A valid Source reference does not grant file access. A valid scope does not authorize another Source, branch or repository.

Canonical serialization rejects unknown properties, unsupported versions and noncanonical representations according to the existing parser; its accepted trailing-line-feed compatibility is unchanged. Do not invent a consumer-specific wire format.

## 4. Product boundary

Inari owns the declared task authorization and its projection. Nawabari owns worktree/filesystem/process enforcement in its runtime. A projection is not proof that an OS sandbox enforced it. Wabachi/Mottainai/Suzukuri integrations consume published contracts rather than importing private Inari modules or copying its parser.

## 5. Verification

Prove exact identity/base/digest binding, all five operation classes, DENY precedence, absent/empty scope, stale lifecycle rejection and canonical round-trip. Consumer enforcement and installed-package conformance are distinct proofs and remain separately reported.
