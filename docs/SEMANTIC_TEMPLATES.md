# Semantic Template Authoring and Native Projection

Status: authoring/compatibility contract under
[Product Architecture Canon](./ARCHITECTURE.md) and
[Semantic Artifact Contracts](./SEMANTIC_ARTIFACT_CONTRACTS.md).

Repository-owned JSON declares semantics. GitHub-native forms and Markdown
are generated projections, not parallel authoring authorities. This document
preserves current discovery/import/synchronization behavior while the
schema-native target converges through explicit compatibility compilation.

## 1. Canonical paths

Current semantic template discovery uses:

```text
.github/inari/issues/<id>.json
.github/inari/pull-request.json
.github/inari/pull-requests/<id>.json
```

Use the single PR file or the plural directory model as applicable. A file
written elsewhere does not become discoverable merely because its JSON is
valid. Current explicit `--to` outside canonical paths warns about discovery;
omitting it selects the canonical default.

Native outputs live under `.github/ISSUE_TEMPLATE/` and the supported PR
native-template locations. Edit semantic source and regenerate outputs.
Do not hand-edit generated native files as competing contracts.

## 2. Existing v1 authoring

The current v1 form contains version, kind, identity/name, supported native
metadata, and ordered semantic sections. Input sections have field identity,
type, label, requiredness, choices, and accepted constraints. Fixed headings
and documentation retain bounded rendering metadata.

This serialized vocabulary remains a compatibility input during migration.
It is not the target second type system alongside JSON Schema.
The compatibility compiler must preserve existing meaning and native output
rather than reinterpret old contracts in place.

## 3. Schema-native target

The target contract uses one Draft 2020-12 root object schema plus top-level
value-authority bindings and bounded presentation metadata. Generic shape,
requiredness, enums, and constraints belong only to that schema.

Bindings do not duplicate validation keywords. Initial authority pointers are
direct root properties, not wildcard/nested executable policy. Inari still
owns bounded derivation, typed relations, domain normalization, and provenance.

Native controls are capability projections. A semantically valid nested value
may be unsupported by a target; return a bounded failure rather than silently
flattening or discarding content.

The current v1/native path remains readable until its explicit migration is
implemented and certified. Documentation alone does not convert repository
contracts or introduce new accepted serialized fields.

## 4. Source, Implementation, and PR authoring

An ordinary Issue defines a problem, request, or decision. It need not contain
path scopes, exact base/branch, targeted tests, or Session authorization.

An Implementation is the separate bounded task contract. Its objective,
non-goals, accepted design, explicit scopes, dependencies, verification, base,
and branch belong there. Its design field cannot independently amend the
Product Architecture Canon.

PRs report delivered work, linked task/integration subject, and validation.
They do not create a second authorization record. An Implementation PR links
the task; Source/Epic integration PRs represent their own composed outcomes.

Use [Implementation Contract](./IMPLEMENTATION_CONTRACT.md) for exact
Source/task/Session/publication binding. The old equality between Implementation
and Source Change must not be copied into templates as a universal relation.

## 5. Parent and dependency representation

Where the provider's supported native parent/sub-issue capability is selected,
that graph state is canonical parentage. Body Source references and execution
dependencies retain distinct contract meaning.

Legacy `Parent:` or `Parent Epic:` prose may describe history but does not
override native evidence or authorize automatic reparenting. Multiple Sources
do not create multiple implicit integration parents.

Relations are normalized by Core rather than reconstructed from branch names,
closing-keyword snippets, or UI text in each consumer.

## 6. Generation and checking

Existing product commands are:

```sh
inari template sync
inari template sync --check
```

Check mode does not write and returns nonzero when the committed native
projection is missing or differs. Unchanged semantic input produces stable
native bytes and the bounded generated notice.

Generation does not publish, authorize a Session, or grant trust. Agent use
still obeys active organization governance; these examples do not lift any
invocation suspension.

## 7. Import

The existing native parser supports explicit import:

```sh
inari template import --from .github/ISSUE_TEMPLATE/legacy.yml
inari template import --from .github/PULL_REQUEST_TEMPLATE.md
```

Unsupported or ambiguous constructs fail closed. After import, semantic
source owns authoring and native projections must be regenerated. Import is
not permission to heuristically recover missing intent or embed a duplicate
full semantic document in hidden comments.

## 8. Template selection

The current `.github/inari/template-resolution.yml` shape is:

```yaml
version: 1
defaults:
  issue: feature
  pr: default
```

The shared resolver uses explicit selector, configured default, sole candidate,
interactive TTY choice, then bounded non-interactive failure in that order.
An invalid configured selector fails closed instead of trying another template.

A client must not hard-code a default or silently pick the first candidate.
Remote/Hosted placement does not change selection meaning.

## 9. Mutation provenance

Current governed creation in a repository using semantic templates requires
its committed native projection to be current. The existing template identity
provenance binds the generated native path; changing authoring JSON alone does
not make old native output current.

Synchronize and publish the generated projection before claiming a mutation
uses the new generation. Schema-native migration must explicitly update this
producer/consumer contract rather than silently changing its path meaning.

Governance freshness and the current Issue/PR observation identity are separate
preconditions. A current template cannot justify overwriting a concurrent
human edit to the artifact.

## 10. Machine input and presentation

Existing compact schema discovery exposes permitted semantic fields without
fixed Markdown/YAML presentation:

```sh
inari issue schema bug --compact --json
inari pr schema --compact --json
```

Structured creation accepts semantic JSON through the supported file/stdin
path. Rendering and round-trip validation happen before provider mutation.
Derived/fixed values are not caller overrides even when their bytes match.

CLI Canon owns common shell/Help/invocation mechanics. Repository-derived
schema is still an Inari domain result, not a duplicated static CLI model.

## 11. Observation and reconciliation

Use the shared mdast syntax boundary for headings, fences, lists/tasks, and
comments. Preserve observed free text from original source slices.
Keep existing canonical renderers until representation parity is explicitly
proved. Parsing migration is not permission for arbitrary format rewriting.

Automatic single-artifact reconciliation performs only proven semantics-
preserving repair. Missing intent or template ambiguity remains blocked.
Unknown post-effect outcome is not a safe blind retry.

## 12. Verification

Prove exact-path discovery, selection precedence, invalid default rejection,
import denial, deterministic generation, check-mode non-mutation, current-native
provenance, compact schema authority, and render/observe round trips.

Schema-native compatibility must preserve old input meaning while eliminating
parallel shape authority in each migrated slice. Nested values, relation
binding, free-text preservation, and stale artifact/generation cases need
explicit proof through the public consumer boundary.
