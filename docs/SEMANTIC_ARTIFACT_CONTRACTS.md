# Semantic Artifact Contracts and Projection Architecture

Status: proposed architecture for Epic #278 and Issue #279. This document becomes the normative implementation boundary for #278 when merged.

This document refines the artifact-semantics layer of [`CHANGE_CONTROL_PLANE.md`](./CHANGE_CONTROL_PLANE.md) and composes with [`NATIVE_MCP_ISSUER_GATEWAY.md`](./NATIVE_MCP_ISSUER_GATEWAY.md). It does not replace the Change lifecycle, authorization model, issuer identity, or hosted MCP trust model defined there.

The current v1 semantic-template behavior described in [`SEMANTIC_TEMPLATES.md`](./SEMANTIC_TEMPLATES.md) remains the executable compatibility authority until the migration in this document is implemented.

## 1. Purpose

Inari currently has repository-owned semantic JSON under `.github/inari/`, a compiler-generated `CanonicalContract`, semantic artifact loaders/validators, deterministic branch derivation for governed Changes, and a trusted execution path. Those pieces already establish the important principle that GitHub presentation and transport must not become independent policy authorities.

The remaining architectural problem is that the pieces do not yet share one general artifact model:

- semantic-template JSON is still compiled through a generated GitHub-native Issue Form or pull-request template before the canonical IR is produced;
- `CanonicalContract` is explicitly the compiled result of native template structure and therefore centers `nativeMetadata`, sections, and supplemental constraints;
- Issue dependencies already exist outside template fields as a representation-independent sidecar;
- PR-to-Issue linkage is still fundamentally enforced as a body-field closing-keyword constraint;
- title is still caller metadata with optional native-template prefix semantics;
- canonical branch naming is owned outside the repository semantic artifact JSON and is composed separately by Change;
- CLI, MCP, and the trusted executor need a common answer to “what may the caller supply, what does the repository determine, and what will Inari derive?”

The target architecture makes repository-owned semantic contracts the declaration of **meaning and authority**, then deterministically derives accepted input, semantic state, GitHub projection, validation, and execution planning from that declaration.

## 2. Architectural statement

The product pipeline is:

```text
Repository Contract
        |
        | compile
        v
Effective Contract
        |
        | accept only declared caller input
        v
Semantic Artifact
        |
        | project for a target capability set
        v
Desired Projection / Projection Plan
        |
        | reconcile against observed state
        v
Mutation Plan
        |
        | trusted execution
        v
Observed GitHub State + Execution Evidence
```

The layers are intentionally distinct.

- **Repository Contract** is repository-owned Canon: the versioned declaration of semantic values, relationships, authority, cardinality, constraints, and projection rules.
- **Effective Contract** is the compiler-owned, normalized contract for one artifact kind/template and repository generation. It includes the exact caller input schema and all derived/fixed outputs.
- **Semantic Artifact** is one fully validated/materialized instance after supplied input, derived values, fixed values, defaults, and relations have converged.
- **Desired Projection** is the deterministic GitHub-facing representation of that semantic artifact for a declared target capability set.
- **Mutation Plan** is a versioned set of preconditions and effects produced by reconciling desired projection with observed state.
- **Observed Projection** is structured evidence reconstructed from GitHub state. It is evidence, not semantic authority.
- **Executor** is the logical trusted component that admits and applies a mutation plan and verifies the resulting projection.

Names, titles, Markdown bodies, labels, ref names, hidden markers, closing-keyword strings, and native GitHub relation objects are representations of semantic facts. They are not independent semantic authorities.

## 3. Authority hierarchy

For artifact semantics, authority is ordered as follows:

1. Inari Core defines the versioned Contract format, compiler semantics, validation semantics, derivation operations, projection semantics, diagnostics, and plan contracts.
2. The target repository owns the concrete Repository Contract values under `.github/inari/`.
3. Effective Contract and Semantic Artifact are compiler/validator products of Core + repository Canon.
4. CLI and MCP expose discovery, schema, validation, preview, and plan capabilities over Core. They do not own repository-specific rules.
5. Executor implementations re-resolve authoritative repository state and invoke the same Core authority for admission.
6. GitHub-native templates, bodies, metadata, relations, branches, workflow YAML, and API response shapes are projections or observed evidence.

No adapter may turn a repository-specific convention into a second hard-coded semantic rule.

## 4. Core Contract Format

### 4.1 The three independent dimensions

Every declared semantic value has three orthogonal dimensions:

```text
semantic type     what the value means and how it is validated
value authority   who determines the value
cardinality       how many values may/must exist
```

These dimensions must not be collapsed into one `required` flag, one native UI field type, or one metadata special case.

A normalized value declaration is conceptually:

```ts
interface ValueDeclaration {
  readonly type: SemanticType;
  readonly authority: ValueAuthority;
  readonly cardinality: Cardinality;
  readonly constraints?: SemanticConstraints;
}
```

Repository authoring syntax may be more compact, but compilation must converge to this model.

### 4.2 Value authority

Core v2 defines three initial authority modes.

#### `supplied`

The caller is allowed to provide the semantic value. Cardinality determines whether it is required.

```json
{
  "type": "string",
  "authority": { "kind": "supplied" },
  "cardinality": { "min": 1, "max": 1 }
}
```

A required supplied value appears in the Effective Contract input schema and must be present before the Semantic Artifact can materialize.

#### `derived`

Core deterministically computes the value from other declared semantic values.

```json
{
  "type": "branch_name",
  "authority": {
    "kind": "derived",
    "derive": {
      "op": "format",
      "template": "{type}/{issue.number}-{slug}"
    }
  },
  "cardinality": { "min": 1, "max": 1 }
}
```

A derived value is **not caller input**. Supplying it through CLI, MCP, JSON, or another candidate adapter is an authority violation, even when the supplied bytes equal the derived result. Generation and validation therefore have one authority rather than “caller chooses, validator checks”.

#### `fixed`

The Repository Contract determines a literal value.

```json
{
  "type": "branch_name",
  "authority": {
    "kind": "fixed",
    "value": "main"
  },
  "cardinality": { "min": 1, "max": 1 }
}
```

A fixed value is also excluded from caller input and cannot be overridden.

### 4.3 Unsupported values

Core does not need a fourth `unsupported` authority mode. If an artifact contract does not declare a value or relation, that capability is absent for that contract. Caller attempts to provide an undeclared value fail as unknown/unsupported input.

This is important for repository variance: a repository that does not use PR-to-Issue linkage does not need to declare an optional fake relation merely to disable it.

### 4.4 Cardinality

Canonical cardinality is represented as bounded count semantics:

```ts
interface Cardinality {
  readonly min: number;
  readonly max: number | "many";
}
```

Typical projections are:

```text
required scalar   { min: 1, max: 1 }
optional scalar   { min: 0, max: 1 }
optional list     { min: 0, max: "many" }
non-empty list    { min: 1, max: "many" }
```

Requiredness is derived from `min`; Core must not maintain a contradictory parallel `required` boolean in the normalized IR.

### 4.5 Semantic types

Core owns a closed, versioned semantic type registry. The initial v2 architecture must support the existing template value semantics plus domain types needed to remove representation-specific special cases.

At minimum the registry must be capable of representing:

- strings and bounded text;
- enum values;
- booleans and bounded integers where product contracts require them;
- checklist/list semantics already supported by v1;
- `issue_reference` using repository-stable Issue identity;
- `repository_reference` where a repository itself is a semantic endpoint;
- `branch_name`;
- `slug` or an equivalent explicitly validated branch-naming input;
- typed relation endpoints.

The exact serialized type registry belongs to the Contract Format implementation leaf, but it must remain closed/versioned. Repository contracts do not embed arbitrary executable validators or arbitrary JSON Schema programs.

## 5. Bounded derivation model

Derived values must be deterministic, inspectable, cycle-free, and safe to reproduce in CLI, MCP, Executor admission, and tests.

The initial derivation algebra is deliberately small:

```text
copy(value-path)
format(template, referenced value paths)
```

A repository may also use explicitly versioned Core-owned named derivations in the future, for example a deterministic slugification operation, but repository-defined scripts/functions are not permitted.

`format` rules:

- placeholders reference only declared values or declared scalar members such as `{issue.number}`;
- placeholder names are resolved by the compiler, not dynamically at runtime;
- unknown references fail contract compilation;
- derived-to-derived references are allowed only when the dependency graph is acyclic;
- derived values are evaluated in topological order;
- no conditionals, loops, code execution, environment reads, network reads, date/time reads, or natural-language inference exist in the format language;
- the final value is revalidated against its declared semantic type and constraints;
- a derivation that cannot produce exactly the declared cardinality fails closed.

This means a repository that wants `{type}/{issue.number}-{slug}` must supply or otherwise deterministically derive `type`, `issue`, and `slug`; Core does not invent missing semantic text.

## 6. Repository variance is a first-class requirement

Core must support different repository contracts without changing Core code.

### 6.1 Deterministic branch repository

A repository such as the current `yohn-jp` set may declare:

```json
{
  "values": {
    "type": {
      "type": "enum",
      "authority": { "kind": "supplied" },
      "cardinality": { "min": 1, "max": 1 },
      "constraints": { "values": ["feat", "fix", "docs", "refactor", "test", "chore"] }
    },
    "issue": {
      "type": "issue_reference",
      "authority": { "kind": "supplied" },
      "cardinality": { "min": 1, "max": 1 }
    },
    "slug": {
      "type": "slug",
      "authority": { "kind": "supplied" },
      "cardinality": { "min": 1, "max": 1 }
    },
    "branch": {
      "type": "branch_name",
      "authority": {
        "kind": "derived",
        "derive": {
          "op": "format",
          "template": "{type}/{issue.number}-{slug}"
        }
      },
      "cardinality": { "min": 1, "max": 1 }
    }
  }
}
```

Effective input contains `type`, `issue`, and `slug`. It does **not** contain `branch`.

### 6.2 Caller-named branch repository

Another repository may instead declare:

```json
{
  "values": {
    "branch": {
      "type": "branch_name",
      "authority": { "kind": "supplied" },
      "cardinality": { "min": 1, "max": 1 }
    }
  }
}
```

Effective input contains `branch`. No Issue relationship is implied by Core.

### 6.3 Required PR-Issue relation

A repository may require a PR to implement exactly one Issue:

```json
{
  "relations": {
    "implements": {
      "target": "issue_reference",
      "authority": {
        "kind": "derived",
        "derive": { "op": "copy", "from": "issue" }
      },
      "cardinality": { "min": 1, "max": 1 }
    }
  }
}
```

The caller supplies `issue`; `implements` is materialized by Core and cannot be independently overridden.

Another repository may make `implements` optional and supplied, or omit it entirely. Core never asserts that all pull requests require Issue linkage.

## 7. Relation model

Relations are semantic graph edges, not body strings.

Core must define a typed relation vocabulary with direction and cardinality. The initial Issue/PR architecture needs at least enough vocabulary to express:

- Issue parenthood;
- Issue dependencies;
- PR implementation/closing intent toward an Issue;
- Change/root-Issue composition where the Change model needs to reference artifact semantics.

The stable `IssueReference` identity introduced by the current dependency model is retained as the initial Issue endpoint identity:

```text
repositoryHost + repositoryId + Issue number
```

The current owner/name locator remains display/transport metadata rather than equality identity.

Canonical contracts store one direction for each fact. Inverse views are derived rather than stored as competing authorities. For example:

```text
parent        -> children view is derived
dependsOn     -> blocks view is derived
implements    -> implementedBy view is derived where useful
```

The exact user-facing relation names are frozen by the implementation contract/IR leaf, but the architecture forbids requiring both directions as independent repository input.

## 8. Effective Contract

The Effective Contract is the compiler-owned answer to “what does this repository expect for this artifact?”

It contains at least:

- contract/version/template identity;
- repository and immutable governance generation provenance;
- normalized value/relation declarations;
- the exact caller input schema;
- derived/fixed output declarations;
- projection rules;
- target capability assumptions when projection behavior depends on them;
- stable diagnostics/schema version.

Compilation rules for caller input are mechanical:

```text
authority = supplied, min >= 1   -> required input
authority = supplied, min = 0    -> optional input
authority = derived              -> excluded from input; reject override
authority = fixed                -> excluded from input; reject override
undeclared value/relation        -> reject as unknown/unsupported
```

The Effective Contract is the primary machine-facing discovery surface for CLI, MCP, agents, tests, and execution admission. Agents should not need to reverse-engineer authoring JSON or GitHub-native templates to learn required inputs.

## 9. Semantic Artifact materialization

Core materializes a Semantic Artifact by:

1. validating caller input against the Effective Contract input schema;
2. normalizing accepted supplied values;
3. materializing fixed values;
4. evaluating derived values in deterministic dependency order;
5. validating every materialized value against semantic type/cardinality/constraints;
6. materializing and validating typed relations;
7. producing one immutable canonical semantic instance plus provenance.

A Semantic Artifact contains no rejected candidate values and no unresolved required values.

This extends the architectural role already played by the current `ArtifactCandidate -> loadCanonicalArtifact(...)` boundary. The current canonical loader should evolve rather than be duplicated by a second artifact ingestion pipeline.

## 10. Projection semantics

Projection answers how a Semantic Artifact should be represented on a target GitHub capability set.

For each semantic fact, Core chooses the strongest supported representation deterministically:

1. a supported GitHub-native semantic property/relation;
2. a GitHub-recognized machine convention when no stronger supported native representation is available;
3. title/body/hidden presentation encoding only as a documented compatibility/fallback representation.

Examples:

- `summary` may contribute to a derived Issue/PR title;
- an `implements` relation may project to GitHub-recognized closing-reference text when that is the supported mechanism required to produce closing behavior;
- parenthood/dependency relations should use a native relation adapter when the target capability adapter declares support, otherwise a documented compatibility representation may be used;
- semantic content not otherwise represented may render into canonical body sections;
- branch identity projects to a Git ref name.

Projection capability detection is explicit input to the projector. GitHub.com/GHES differences must not silently change canonical semantics.

When the same semantic fact is intentionally projected to more than one GitHub surface for behavior and usability, the projections remain one semantic authority. Conflicting observed representations are drift.

## 11. Desired Projection and Mutation Plan

A Desired Projection is pure desired state for GitHub-facing artifacts and relations. It is deterministic for:

```text
Effective Contract + Semantic Artifact + target capability set
```

A Mutation Plan is produced by reconciling Desired Projection with a bounded Observed Projection. It is versioned and transport-independent and contains at minimum:

- contract/repository generation identity;
- semantic artifact identity/digest sufficient to bind the plan to intent;
- observed-state generation/evidence identity where applicable;
- explicit preconditions;
- ordered effects;
- expected postconditions;
- bounded diagnostics/recovery classification.

A plan never embeds GitHub App private keys, installation tokens, workflow filenames, HTTP endpoints, or provider response dumps.

CLI/MCP may produce a preview plan when they have enough observed evidence. A preview is useful for UX and agent reasoning but is not itself mutation authorization.

## 12. Executor boundary

`Executor` is a logical architecture role, not a synonym for GitHub Actions Runner.

An Executor admits a plan by performing the following sequence:

```text
receive versioned plan/request
        |
        v
resolve authoritative repository + Canon generation
        |
        v
recompile Effective Contract with Core
        |
        v
revalidate/materialize semantic intent with the same Core authority
        |
        v
re-read authoritative bounded GitHub state
        |
        v
validate plan generation + preconditions
        |
        v
apply explicit effects
        |
        v
re-read state and verify postconditions
        |
        v
return bounded execution evidence
```

If repository governance or relevant GitHub state changed after preflight, the Executor must not blindly apply the stale plan. It either rejects with a stale-generation/precondition diagnostic or produces a newly validated plan through the same Core path where the operation contract explicitly permits re-planning.

The initial hosted deployment remains GitHub Actions because it provides repository-local execution context, observable runs, OIDC identity, and an established trusted execution seam. That is a deployment choice. Core and the plan contract must also remain usable by a future equivalent trusted executor without semantic changes.

## 13. CLI and MCP responsibilities

CLI and MCP are peer interfaces over Core.

They may:

- resolve a target repository;
- fetch authoritative repository Canon for read/preflight purposes;
- compile an Effective Contract;
- return the effective caller input schema;
- validate semantic input;
- materialize a Semantic Artifact;
- render/preview desired GitHub projection;
- obtain bounded observed state when permitted;
- create a preview plan;
- submit semantic intent/plan to the trusted mutation path.

They must not:

- maintain independent repository-specific regexes/rules;
- make derived/fixed values caller-overridable;
- treat successful preflight as mutation authorization;
- keep a stale repository Canon copy as an execution authority;
- move policy semantics into MCP tool descriptions or CLI option code.

### 13.1 Repository contract discovery capability

The MCP surface must expose a route semantically equivalent to:

```text
resolve repository contract
    -> contract identity
    -> immutable governance generation/provenance
    -> Effective Contract
    -> caller input schema
    -> supported/derived/fixed capability summary
```

The exact MCP tool name belongs to the native MCP tool catalog, but the capability is architectural, not optional.

An agent must be able to ask “what input is accepted for creating or changing this artifact in this repository?” before it constructs the mutation request.

The same capability should be available to CLI schema/discovery commands through the same Core compiler.

### 13.2 Preflight versus admission

```text
CLI/MCP preflight
  purpose: UX, discovery, early rejection, plan preview
  authority: current repository evidence + Core
  security effect: none

Executor admission
  purpose: authorize one external state transition against authoritative current state
  authority: re-resolved repository evidence + same Core + execution identity
  security effect: mutation may proceed only after success
```

This distinction prevents MCP from becoming a shadow policy/security engine while still making it genuinely useful to agents.

## 14. Provenance and TOCTOU

Every Effective Contract and plan must bind to immutable governance generation evidence.

The current `ContractProvenance` model already carries repository identity, trusted ref, root tree SHA, source SHA/digest, and policy provenance. The target architecture should reuse/generalize that concept rather than invent a second generation identity.

At minimum, discovery/preflight returns enough information to identify:

```text
repository identity
trusted ref
immutable repository/governance generation
contract identity/version
contract/source digest(s)
```

Mutation admission compares the request/plan generation to newly resolved authoritative generation. A ref name such as `main` alone is not sufficient because it is mutable.

If the generation changed, identical semantic input may be revalidated only by the Executor/Core path under an explicitly defined retry/replan contract. A plan produced under generation A is never silently treated as valid under generation B.

## 15. Relationship to Change

This architecture does not remove `Change`.

`Change` continues to own:

- work lifecycle (`DEFINED`, `DRAFT`, `REVIEW`, and terminal/recovery states);
- root-Issue Change identity;
- requester/issuer/implementer/reviewer/merger provenance;
- transition authorization and sequencing;
- issuance idempotency, compensation, and recovery;
- publication/review lifecycle policy.

Artifact Contracts own what Issue/PR/branch projections mean and how repository policy determines their semantic values.

The intended convergence is:

```text
Change transition
      |
      | asks Artifact Core for canonical artifact/branch semantics
      v
Semantic Artifact + Desired Projection
      |
      | Change adds lifecycle transition semantics/preconditions
      v
Mutation Plan / Change effects
      |
      v
Trusted Executor
```

The existing Change planner/effect model is therefore a foundation for the generalized plan/executor boundary, not a competing system.

The current Change invariant that its canonical branch is Issue-derived is a **Change/repository-policy choice for the current deployment**, not a universal Core Artifact Contract invariant. The generic Contract Format must still permit a repository/artifact model whose branch name is supplied.

## 16. Current-code mapping

### `src/semantic-template.ts`

**Current:** repository JSON authoring model plus native projection compiler path.

**Target:** compatibility parser/authoring adapter for v1, then Repository Contract v2 ingestion/projection support. The long-term compiler must not require a native template round-trip to define semantic IR.

### `src/contract/ir.ts`

**Current:** compiler-generated IR of native Issue/PR template structure, native metadata, sections, supplemental constraints, provenance, and optional branch governance.

**Target:** either a versioned v2 IR or a clearly separated Artifact Contract IR. The implementation architecture must make the new semantic value/authority/cardinality/relation model primary and retain native render metadata only in a projection-specific layer.

### `src/artifact.ts`

**Current:** candidate adapters, canonical loader, render/parse, prepare/create validation, existing-artifact projection, metadata handling, and dependency sidecar integration.

**Target:** retain the candidate -> canonical boundary and reconciliation machinery, but materialize a full Semantic Artifact. Metadata/dependency special cases converge into declared semantic values/relations or projection metadata where appropriate.

### `src/contract/issue-reference.ts`

**Current:** stable representation-independent Issue identity and `blockedBy` / `blocks` normalization.

**Target:** retain `IssueReference` identity. Generalize dependency-specific relation handling into the common typed relation model, with inverse views derived rather than independently authored.

### `branch-naming-authority.mjs`

**Current:** shared executable grammar and deterministic `type/issue-slug` derivation for current repositories.

**Target:** reuse its validation/derivation behavior as an implementation of repository-declared branch projection while moving the declaration of whether/how branch is derived into repository Canon. No second branch grammar is introduced.

### `src/change.ts`

**Current:** transport-independent Change contract, canonical branch derivation composition, transition planning, effects, projection/admission validation, issuance and recovery semantics.

**Target:** retain lifecycle and transition authority. Consume Artifact Contract derivation/projection instead of independently owning artifact title/body/branch policy where those semantics have moved to the Artifact Contract.

### `src/github/*`

**Current:** repository resolution/provenance reads, GitHub artifact adapters, trusted Change sequencing, issuer authorization, and effect application.

**Target:** split cleanly into observed-projection/capability adapters and Executor/effect adapters. Provider code reports capability/evidence and applies already admitted effects; it does not define semantic policy.

### `docs/SEMANTIC_TEMPLATES.md`

**Current:** authoritative description of v1 semantic template JSON and generated native templates.

**Target:** remains migration documentation until v2 ships, then becomes compatibility/authoring migration guidance or is replaced by Artifact Contract authoring documentation.

### `docs/CHANGE_CONTROL_PLANE.md`

**Current:** authoritative Change lifecycle and execution-control architecture.

**Target:** remains authoritative for Change. This document refines the artifact semantics that Change composes.

### `docs/NATIVE_MCP_ISSUER_GATEWAY.md`

**Current:** authoritative hosted MCP ingress, repository-local runner, OIDC/issuer boundary, and transport migration architecture.

**Target:** remains authoritative for hosted trust/deployment. Its MCP tools consume Effective Contracts and plans from this architecture rather than acquiring semantic policy ownership.

## 17. Compatibility and migration

Migration is additive and staged; no flag day is required.

### Phase 0 — architecture authority

Merge this document and decompose #278. Do not implement #161/#272/#273 as independent new semantic authorities before the decomposition is fixed.

### Phase 1 — Contract IR and compiler

Introduce the v2 Artifact Contract/Effective Contract model and deterministic authority/cardinality/derivation validation without changing external GitHub mutation behavior.

Current v1 semantic templates remain accepted through a compatibility compiler that maps only semantics it can represent without guessing.

### Phase 2 — input schema and semantic materialization

Make schema/validate/render paths consume Effective Contract and Semantic Artifact. Preserve current CLI behavior where compatible; expose authority violations explicitly when callers attempt to supply newly derived/fixed values.

### Phase 3 — Issue relations

Move dependency/parent semantics into the common relation layer. Preserve the existing dependency marker only as an observation/backward-compatibility projection where required. Add native relation adapters only behind explicit capability detection.

### Phase 4 — PR identity/linkage projection

Move title derivation and PR-to-Issue semantic linkage into Artifact Contract projection. Closing-keyword body text becomes a projection of the relation, not the relation authority.

### Phase 5 — branch projection and Change convergence

Move the repository declaration of branch authority/derivation into the Artifact Contract. Reuse current branch grammar and Change identity semantics for repositories that declare the current deterministic form. Change consumes the resulting branch projection.

### Phase 6 — CLI/MCP discovery and plan handoff

Expose Effective Contract discovery/schema and plan preview through CLI/MCP using one Core implementation. Do not put repository policy in protocol handlers.

### Phase 7 — Executor admission convergence

Make trusted execution re-resolve the same Contract generation and admit/revalidate the common plan model before applying GitHub effects. Preserve Actions as the primary deployment while keeping the Core/plan boundary transport-independent.

### Phase 8 — repository/organization consumer migration

Migrate organization CI/governance consumers to the new Core result and delete duplicated title/branch/relation validation only after equivalent Inari authority exists.

## 18. Issue disposition after this document

After merge, #278 should be decomposed into bounded implementation leaves. At minimum the work graph should cover:

1. Artifact Contract/Effective Contract IR and compiler;
2. authority/cardinality/derivation validation and effective input schema;
3. typed relation model and Issue projection/observation;
4. PR title/linkage projection/observation;
5. branch authority/derivation migration and Change consumption;
6. desired projection + plan contract convergence;
7. CLI/MCP repository-contract discovery and preflight;
8. Executor admission/revalidation convergence;
9. organization CI/governance consumer migration.

Existing issues are then dispositioned against those leaves:

- #157 is completed foundation and its semantic behavior must be preserved;
- #161 is absorbed into the typed relation / Issue observation work rather than becoming a separate lifecycle semantic authority;
- #272 is absorbed into PR identity/title projection work;
- #273 is absorbed into branch authority/derivation work;
- #275 remains an independent projection-renderer correctness bug and may proceed separately.

## 19. Normative invariants

The following are non-negotiable for implementations derived from #278:

- Repository-owned Canon contains repository-specific semantic choices.
- Core owns the Contract language and interpretation, not concrete repository policy values.
- Core does not universally require an Issue in branch identity or an Issue relation on pull requests.
- Supplied, derived, and fixed authority are exclusive for one value in one Effective Contract.
- Derived/fixed values are rejected as caller overrides.
- Cardinality is independent of authority and represented without contradictory requiredness flags in normalized IR.
- Derivation is bounded, deterministic, cycle-free, non-executable, and revalidated against output type.
- Relations are semantic edges with stable endpoint identity; inverse views are derived.
- Effective Contract is the machine discovery authority for caller input.
- CLI/MCP and Executor use the same Core compiler/validator semantics.
- CLI/MCP preflight never substitutes for Executor mutation admission.
- Mutation admission re-resolves immutable governance generation and current state.
- Desired/observed GitHub representations are projections/evidence, not semantic authorities.
- Plan/evidence contracts are transport-independent and credential-free.
- GitHub Actions is an Executor deployment, not a Core primitive.
- Change lifecycle and artifact semantics remain distinct and composable.
- Migration preserves current valid behavior until the replacement authority exists and is proven.

## 20. Non-goals

This architecture does not define:

- arbitrary repository scripting or executable policy;
- natural-language derivation, summarization, or LLM inference;
- a universal branch grammar for every Inari repository;
- a universal requirement that every PR close/implement an Issue;
- a graph database or separate persistent artifact state store;
- a new Change lifecycle or authorization model;
- a new GitHub App reviewer/merge authority;
- MCP-specific semantic policy;
- a requirement that all mutations execute specifically on GitHub Actions forever;
- a flag-day rewrite of v1 templates or historical GitHub artifacts.

## 21. Decision summary

The architectural center is **Core + repository Canon + versioned plan**, not CLI, MCP, workflow YAML, GitHub-native templates, or Runner.

```text
Repository chooses semantics
        |
Core compiles what may be supplied and what must be derived/fixed
        |
CLI/MCP let humans and agents discover and validate that contract
        |
Core materializes semantic intent and a deterministic projection/plan
        |
Trusted Executor re-resolves the same authority and current state
        |
GitHub effects are applied and verified
```

This division gives MCP real value without turning it into a policy authority, preserves GitHub Actions as a useful trusted execution boundary without making Runner the product architecture, and allows different repositories to choose different Issue/PR/branch semantics while sharing one deterministic Inari Core.
