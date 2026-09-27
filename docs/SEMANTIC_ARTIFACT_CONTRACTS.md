# Semantic Artifact Contracts and Projection Architecture

Status: normative target under [Product Architecture Canon](./ARCHITECTURE.md).

This document retains the detailed value-authority, derivation, relation,
provenance, projection, and reconciliation contracts. JSON Schema Draft
2020-12 replaces the earlier parallel field-primitive, presence, and generic
constraint languages. It does not replace Inari domain semantics.

Existing serialized contracts remain revision-specific compatibility inputs.
This documentation change neither migrates repository templates nor certifies
the schema-native implementation.

## 1. Purpose

Repository contracts declare meaning and who may determine each value.
Core compiles accepted input, materializes semantic state, and derives
supported projections and mutation plans. GitHub presentation and transport
must not become independent policy owners.

The target avoids a pipeline in which semantic authoring must first become a
native Issue Form and then be parsed back into semantics. Native forms and
Markdown are projections/adapters, not the source language of the Core.

## 2. Product pipeline

```text
Repository Artifact Contract + immutable provenance
  -> Effective Contract + exact caller input schema
  -> supplied input validation and semantic materialization
  -> immutable Semantic Artifact
  -> target-capability Desired Projection
  -> reconcile bounded Observed Projection
  -> Mutation Plan with preconditions and postconditions
  -> admitted Executor effect
  -> authoritative reread and verified evidence
```

Repository Contract is authored Canon. Effective Contract is the compiler's
normalized interpretation for one repository generation. Semantic Artifact is
a fully validated instance, not a bag of unresolved candidate values.

Desired Projection is pure target-facing state. Observed Projection is
normalized provider evidence. Mutation Plan is their explicit bounded
reconciliation; it contains no provider credential or implicit execution.

## 3. Semantic authority hierarchy

Inari Core owns the versioned contract language, interpretation, normalization,
bounded derivation and relations, diagnostics, and plan semantics.
The repository owns concrete policy choices under its Canon.

CLI, MCP, and UI consume compiled contracts and schemas. Executor re-resolves
current Canon and evidence before mutation. GitHub-native templates, bodies,
labels, refs, and relation objects are representations or observed facts.

An adapter may not turn a repository convention into a hard-coded universal
Inari rule. A Hosted transport may not keep its own materializer or repository
semantic database.

## 4. Schema-native contract

### 4.1 One data-shape language

One contract-level Draft 2020-12 root object schema owns generic value shape:
properties, requiredness, types, enum sets, bounds, nested objects, arrays,
item shape, uniqueness, and other supported schema constraints.

Bindings must not duplicate `type`, `required`, enum, cardinality, min/max,
pattern, defaults, or item shape. The earlier `primitive + presence +
constraints` model is a versioned compatibility input, not a second target
schema language.

### 4.2 Portable Canon

Repository Canon remains JSON-serializable and runtime-neutral. TypeScript
builders, Zod/TypeBox objects, generated validator code, and validator-specific
keywords are not repository authority.

The initial runtime implementation can use the accepted Ajv Draft 2020-12
boundary in strict compilation mode. The library is replaceable internal
machinery; its errors and options do not become public repository semantics.

### 4.3 Hermetic and non-mutating validation

Meta-validate/compile a repository schema before use. Reject arbitrary network
or filesystem `$ref` resolution and executable repository validators.
Local references are allowed only within the immutable admitted contract and
the supported resolver's complete bounded semantics.

Validation must not coerce types, inject defaults, remove properties, or
otherwise mutate candidate input. JSON Schema `default` is an annotation.
Explicit Inari fixed/derived/default materialization, where supported by the
versioned contract, remains a separate semantic step.

Schema compilation and validation failures become stable bounded Inari
diagnostics, not raw library objects or unbounded candidate echoes.

### 4.4 Top-level bindings

Bindings address direct root properties using RFC 6901 JSON Pointers, such as
`/summary` or `/verification`. Nested authority declarations, wildcard paths,
and a new path-expression DSL are not part of the initial schema-native
contract.

A binding contains value-authority metadata and bounded, target-neutral
presentation intent. It does not redefine schema requiredness or validation.

A required property is declared by root `required`; an optional property is
present in `properties` but not root `required`; an undeclared property is not
a fake optional/unused field.

### 4.5 Shape illustration

The following illustrates the separation, not a complete serialized Contract
with identity, provenance, and all required metadata:

```json
{
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "summary": { "type": "string", "minLength": 1 },
      "verification": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "command": { "type": "string" },
            "outcome": { "type": "string", "enum": ["passed", "failed", "blocked"] }
          },
          "required": ["command", "outcome"],
          "additionalProperties": false
        }
      }
    },
    "required": ["summary"],
    "additionalProperties": false
  },
  "bindings": {
    "/summary": { "authority": { "kind": "supplied" } },
    "/verification": { "authority": { "kind": "supplied" } }
  }
}
```

Nested values do not require new Inari field primitives. Nested value shape
does not authorize nested binding authority or arbitrary new relation kinds.

## 5. Value authority

### 5.1 Supplied

A supplied value is permitted caller input. Its requiredness and shape come
from the authoritative schema. The Effective caller schema includes only the
properties the caller is allowed to supply.

### 5.2 Derived

Core computes a derived value through the declared bounded derivation.
Caller input must not override it, even when the proposed value equals the
expected result. Equality of bytes is not authority to choose the value.

### 5.3 Fixed

The repository contract determines the fixed value. It is excluded from
caller input and validated as part of the fully materialized artifact.

### 5.4 Platform-owned and absent values

Only explicitly supported versioned platform-owned values are supplied by
their trusted owner. This category is not a license for adapters to invent
missing values.

Undeclared properties and unsupported capabilities are rejected rather than
silently ignored. A repository that does not use a relation need not author a
fake optional relation to disable it.

### 5.5 Shape and domain identity

JSON Schema validates instance shape. Inari still owns semantic identity and
normalization for domain values such as IssueReference, repository identity,
branch identity, and typed relation endpoints.

Do not replace immutable repository/Issue equality with string-schema
validation or presentation text comparison.

## 6. Bounded derivation

The existing bounded derivation algebra, including admitted `copy` and
`format` operations, remains Core-owned and versioned. This renewal does not
add repository scripting or a new expression language.

The compiler resolves declared references and rejects unknown paths. Derived
dependencies must be acyclic and evaluated in deterministic topological order.
A format placeholder references an admitted scalar value or declared scalar
member; it does not perform arbitrary object traversal at runtime.

No loops, conditionals, environment reads, filesystem/network I/O, current-time
reads, or natural-language inference are introduced into derivation.
Outputs are revalidated against the authoritative schema and domain rules.

A branch format such as `{type}/{issue.number}-{slug}` requires those inputs
to exist by declared authority. Core cannot invent a slug from missing intent
or silently copy a title that the contract did not authorize as input.

Any new named derivation is a versioned Core capability and requires explicit
approval; it is not arbitrary code supplied by a repository.

## 7. Repository variance

A repository may declare a deterministic branch derived from Issue/type/slug.
Another supported artifact contract may allow a caller-supplied branch. The
schema and bindings express the difference; a provider adapter must not impose
one repository's naming policy on every repository.

Likewise, a PR contract may require, allow, or omit an Issue relationship.
Inari's governed Implementation workflow has its own relation requirements,
but the generic artifact language does not universally require every PR to
close an Issue.

A derived `implements` relation is not independently caller-overridable.
A supplied relation accepts only its declared endpoints and cardinality.
Omission does not cause Core to infer a relationship from branch spelling.

## 8. Relations

Relations are semantic graph edges with typed direction, endpoints, and the
existing bounded cardinality/authority semantics. They are not Markdown body
strings or arbitrary repository-defined executable behavior.

Stable IssueReference equality remains:

```text
repositoryHost + repositoryId + Issue number
```

Current owner/name is locator/display metadata. Relation observations must
preserve unavailable/incomplete/conflicting evidence rather than turn it into
an empty complete graph.

Store one canonical direction for each relation and derive inverse views:
parent/children, dependsOn/blocks, and implements/implementedBy where the
existing contract supports them. Do not require both directions as
independent author input.

Native provider relationships are canonical where the capability contract
selects them. Legacy prose or markers remain explicit representation adapters;
they cannot silently reparent an Issue when native evidence disagrees.

Source membership, native immediate parentage, and execution dependencies are
different relationships. Multiple Source references do not imply multiple
integration parents or a serial dependency chain.

## 9. Effective Contract

An Effective Contract contains the contract/template identity and version,
immutable repository/governance provenance, normalized authority and
relation/derivation plan, exact caller input schema, supported projection
assumptions, and stable diagnostics.

Caller-schema derivation filters the root schema to admitted supplied
properties, preserves their schemas and requiredness, and excludes values
owned by fixed/derived/platform bindings.

Schema constructs whose projection cannot be proven equivalent must produce
a bounded unsupported-contract result. Do not drop cross-property constraints
or unresolved references merely to obtain a convenient caller schema.

Discovery returns enough information for a caller to know what it may supply
without reverse-engineering native templates. The compiler result is the
machine-facing input authority; a manually maintained CLI field list is not.

## 10. Materialization

Materialization performs:

1. validate the candidate against the Effective caller schema;
2. normalize admitted supplied domain values;
3. materialize declared fixed/platform values through their proper owners;
4. evaluate bounded derived values in dependency order;
5. validate the complete value document against the same authoritative schema;
6. validate domain identity, authority, and existing relation semantics;
7. produce one immutable semantic artifact and its provenance.

The result contains no rejected candidate properties, unresolved required
values, or silently widened authority. Use the existing candidate-to-canonical
boundary rather than building a second loader for each interface.

## 11. Markdown representation boundary

One shared mdast/CommonMark/GFM adapter owns Markdown syntax structure and
source positions. Inari owns field identity, template identity, semantic
decoding, its reserved marker protocol, and domain diagnostics.

Free-text observation uses original source slices between proven structural
boundaries. Generic AST stringification must not rewrite paragraph breaks,
literal Markdown, or user formatting while reading the artifact.

Structured headings, lists, task items, fences, and HTML-comment nodes use
parsed syntax. Do not retain independent regex/fence lexers in artifact,
native PR-template, and Implementation parsers after migration.

Reserved `inari:template` and dependency markers remain bounded, versioned
Inari metadata. Identifying an HTML node does not authorize arbitrary HTML or
embedding the full semantic document as a second hidden source of truth.

Canonical renderers remain in place until a separately approved
representation change proves byte and semantic parity. Parser migration does
not automatically authorize renderer migration.

## 12. Capability-driven projection

Projection receives the Effective Contract, Semantic Artifact, and explicit
target capability set. It deterministically selects the strongest supported
representation while preserving semantic meaning.

A native relation/property is preferred where supported. A recognized machine
convention or documented compatibility representation may be selected only
when the capability contract permits it. No deployment-specific silent
fallback changes meaning.

The same semantic fact may intentionally appear on multiple provider surfaces
for behavior and usability. Those are projections of one fact; disagreement
is drift, not independent authority.

Checklist/dropdown/multiline/layout choices are presentation metadata, not
JSON data types. A nested object can be semantically valid but unsupported by
a native control. Such a target returns an unsupported-capability diagnostic
rather than flattening, truncating, or discarding content without proof.

Round-trip proof includes value content, authority, relation meaning, and
relevant native behavior. A renderer that merely produces valid Markdown has
not proved semantic preservation.

## 13. Desired state and mutation plans

A Desired Projection is pure. Reconciliation compares it with bounded current
observed state to produce a versioned plan containing:

- repository/contract/governance identity;
- the semantic artifact or intent digest;
- relevant observed-state identity;
- explicit preconditions;
- ordered bounded effects;
- expected postconditions;
- classified diagnostics and recovery conditions.

A plan contains no App key, provider token, arbitrary authenticated client,
workflow implementation detail, or raw provider response.

Preview is useful for humans and agents but is not execution authorization.
Executor must re-resolve authority and current state before using a plan.

## 14. Observation, freshness, and TOCTOU

ContractProvenance binds repository identity, trusted ref, immutable tree or
source identity, source digest, and policy generation. A mutable branch name
alone is not an immutable generation.

Artifact-observation freshness is independent from governance freshness.
A human may edit an Issue/PR while its template is unchanged. A plan based on
old body/title/metadata must not overwrite that edit because the schema still
matches.

Before an unattended effect, reread the mutation-relevant artifact state and
compare the admitted identity. Changed state fails stale or is replanned only
under the operation's explicit contract. A post-effect read failure remains
possible mutation, not permission for blind replay.

Observation must not create owner directories, migrate records, or perform
reconciliation effects merely because it is called from a status page.

## 15. Single-artifact reconciliation

The automatic reconciler permits only:

- a verified no-op;
- canonical normalization with proven semantic preservation;
- deterministic legacy recovery where complete current semantics are proven.

Missing intent, ambiguous template selection, manual edit, and complete-state
replacement remain explicit decisions. No LLM or heuristic invents values.
The reconciler never silently invokes intent-requiring edit/sync operations.

The public Issue/PR projections share this Core operation. Existing advanced
check/normalize/sync capabilities are not separate automatic policy engines.
Repeated reconciliation of a converged artifact is a no-op.

Results distinguish unchanged, reconciled, blocked, safe pre-effect retry,
and post-effect uncertainty according to the accepted public contract.
A transport retry flag must not erase the possibility that an effect occurred.

## 16. Execution boundary

```text
bounded request/plan
  -> current repository and Canon resolution
  -> same Effective Contract compilation/materialization
  -> current provider evidence
  -> caller/operation and plan-precondition admission
  -> explicit bounded provider effects
  -> authoritative reread
  -> semantic postcondition verification
```

Normal mutations use the user-owned Admission/Executor path. Hosted relays
assertion and request, not a separately materialized semantic plan from its
own repository cache. A retained local pure API may compile supplied data
without gaining provider authority.

If generation changed, Executor rejects stale evidence or explicitly
revalidates under the supported replan contract. It never treats a plan from
generation A as authorized under generation B by default.

## 17. CLI, MCP, and UI

Interfaces may expose contract discovery, input schema, validation,
materialization, rendering, observation, preview, and admitted execution.
They do not maintain repository-specific regexes, derived/fixed overrides,
parallel native parsers, or stale policy copies as authority.

Hosted MCP transports calls to the user's Runtime. It does not interpret
repository artifacts or maintain a work projection backend. An optional remote
UI uses the same authenticated Runtime APIs as local presentation.

Common CLI command/help/Skill mechanics move to CLI Canon. Repository-derived
input schemas remain domain results consumed by handlers, not duplicated
static CLI definitions.

## 18. Relationship to Change

Change owns Source lifecycle and publication/recovery composition. Artifact
Core owns the meaning of Issue/PR/branch values and relations. Change asks the
artifact domain for desired projections, then adds lifecycle preconditions and
sequences the resulting effects.

Implementation task and Source Change identity remain distinct throughout
materialization, PR relationships, branch projection, and evidence. A generic
artifact contract's optional relation does not override the stricter governed
task contract applicable to a specific operation.

Neither domain creates a second persistent artifact/Change database.

## 19. Current implementation seams

`src/semantic-template.ts` is the v1 authoring/compatibility boundary.
`src/contract/ir.ts` and current artifact-contract/effective-contract modules
provide existing representation and authority foundations.
`src/artifact.ts` owns candidate loading and existing-artifact composition.

`src/contract/issue-reference.ts` retains stable Issue identity.
Branch policy and `src/branch-naming.ts` retain canonical naming mechanics;
repository values are not duplicated in provider code.
`src/change.ts` consumes artifact projection within lifecycle planning.

Provider modules observe capabilities/evidence and apply admitted effects.
They do not define repository values, parsing semantics, or a parallel
Effective Contract.

These are observation/migration entry points, not claims that the entire
schema-native target already exists. Code and tests on the candidate revision
must establish each completed seam.

## 20. Compatibility and migration

Preserve v1 semantic-template/native-template behavior through a deterministic
compiler while introducing the schema runtime, schema-native Contract,
Effective caller schema, and full materialization.

Then migrate capability projection/observation and the remaining artifact and
Implementation syntax readers onto the shared mdast boundary. Preserve
free-text content and renderer behavior independently.

Add fresh artifact identity and single-artifact reconciliation, and converge
CLI/MCP discovery to the same compiler results. Native template generation
remains a projection, not a required semantic round-trip.

Each migrated slice removes its duplicate authority. A compatibility adapter
has an exact accepted input version, canonical output, supported consumer,
proof, and retirement condition. It does not sustain an obsolete engine.

## 21. Verification

Required contract proof covers malformed schemas, forbidden external refs,
non-mutating validation, supplied/fixed/derived override rejection, required
property filtering, nested object/array values, bounded derivation cycles,
unknown references, relation identity, and target capability rejection.

Representation proof covers headings inside fences, list/task syntax,
comments, preserved free-text slices, legacy marker validation, and existing
canonical renderer round trips.

Reconciliation proof covers no-op, semantics-preserving repair, incomplete or
ambiguous input, concurrent artifact edits, changed governance, effect failure,
post-effect unknown outcome, and safe retry classification.

Composed proof must traverse actual public source/built/installed boundaries
and provider-shaped adapters. A schema unit test does not prove GitHub
projection, and a Markdown snapshot does not prove authorization.

## 22. Non-goals and review gate

Do not introduce arbitrary executable repository policy, a second hidden
semantic document, universal branch grammar, mandatory Issue linkage for all
PRs, generic graph database, Hosted materializer, new lifecycle engine, or
speculative provider plugin system.

Reviewers must be able to trace each fact to one schema/domain owner, each
projection to its capability contract, each plan to current provenance, and
each successful effect to reread verification. Ambiguity requires a bounded
contract correction, not an adapter-local policy decision.
