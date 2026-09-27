# Semantic Artifact Contracts and Projection

Status: normative target under [Product Architecture Canon](./ARCHITECTURE.md). The schema-native decision supersedes the older duplicated field-primitive/presence model, not Inari's value-authority, relation or derivation semantics.

## 1. Pipeline

```text
Repository Contract + immutable provenance
  -> Effective Contract + exact caller input schema
  -> materialized Semantic Artifact
  -> target-capability Desired Projection
  -> reconcile current observed state
  -> preconditioned Mutation Plan
  -> admitted execution and authoritative verification
```

Repository Canon declares meaning and authority. The compiler produces normalized contracts and plans. GitHub templates, Markdown, labels, titles, refs and native relationships are representations/evidence, not independent rule owners. Hosted does not run another materializer or maintain another artifact source of truth.

## 2. Schema-native Canon

One contract-level JSON Schema Draft 2020-12 root object owns generic data shape, properties, requiredness, nested structure, enum, cardinality and constraints. No second Inari field vocabulary reproduces those rules.

Adjacent bindings contain Inari value authority and bounded presentation intent. Initial bindings address direct root properties using RFC 6901 pointers. Nested authority paths, wildcards and a new path-expression language are not part of this target. Bindings do not duplicate schema validation keywords.

Schema compilation/validation is hermetic and non-mutating. Reject arbitrary external/network/filesystem reference resolution, executable repository validators and validator-specific custom Canon keywords. A schema `default` is annotation, not permission to inject values.

The validator library is replaceable implementation machinery, not repository Canon. Preserve stable bounded Inari diagnostics rather than exposing internal validator objects as a public contract.

## 3. Value authority and materialization

`supplied` values are permitted caller input. `fixed`, `derived` and explicitly supported platform-owned values are determined by their declared owners, not silently overrideable by a caller. Derivation operations and relation kinds remain the existing bounded Core vocabulary; schema-native shape does not authorize arbitrary computation or new semantics.

The Effective caller schema selects the permitted supplied properties while preserving their exact schemas and requiredness. Materialization validates the full result, including supplied, fixed and derived values, against the same authoritative schema and domain checks.

An absent property/capability is not a fake optional field. Unsupported or unknown input fails rather than becoming ignored authority. Domain identities such as IssueReference retain Core semantic normalization even when their JSON shape is described by schema.

## 4. Representation boundary

Use the shared mdast/CommonMark/GFM syntax boundary for Markdown structure and source positions. Inari interprets semantic fields and its reserved bounded/versioned markers. No HTML conversion pipeline or second embedded semantic JSON document is introduced.

Observed free text is recovered from original source slices; generic AST stringification must not rewrite user formatting or paragraph content. Structural lists, headings, tasks, fences and comments use parsed structure rather than parallel regex lexers.

Keep canonical rendering behavior until a separately approved representation change proves byte/semantic parity. Parser migration does not silently authorize renderer migration.

## 5. Capability projection

Presentation is separate from data shape. A checklist is an array-shaped semantic value with presentation metadata, not an additional Core type. Nested objects and arrays do not require a new primitive vocabulary.

A target projection must round-trip the supported semantic content or return bounded unsupported-capability diagnostics. A semantically valid schema is not automatically renderable as a native GitHub control. Do not flatten, truncate or discard values to make a projection appear supported.

CLI, MCP and UI consume the same compiled semantics. Repository-specific titles, body rules, branch formats and relations must not be reimplemented in adapters or shared workflow shell scripts.

## 6. Observation and reconciliation

Operational observation describes normalized evidence. Semantic projection interprets it with current Canon. Reconciliation compares desired and observed semantics and creates explicit effects/preconditions; it does not apply provider mutation itself.

Automatic single-artifact reconcile permits only no-op, canonical normalization and deterministic recovery for which complete semantics are proven. Missing intent, ambiguous template selection and complete-state replacement remain explicit user decisions. No LLM or heuristic invents absent values.

Check governance-generation freshness and mutation-relevant artifact observation independently, including an immediate pre-effect reread. Concurrent edits must not be overwritten. After a possible effect, failed verification is unknown/recovery-required, not a safe blind-retry result.

## 7. Compatibility and proof

Old semantic-template/native-template/primitive formats may enter through explicit deterministic compatibility compilers. They converge to one canonical model, validator, planner and effect path. They do not preserve parallel semantic engines.

Prove free-text preservation, nested object/array round-trip, value-authority denial, schema hermeticity, projection capability rejection, stale-write denial and idempotent reconcile. Preserve meaningful existing regressions without making old accidental parser behavior the new architecture.

The observed baseline contains partial mdast support and older shape/materialization machinery. This target is not a claim that the complete schema-native/reconcile migration has shipped. See [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md).
