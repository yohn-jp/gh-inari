# Repository Template Authority

Status: authoring/projection contract under [Semantic Artifact Contracts](./SEMANTIC_ARTIFACT_CONTRACTS.md) and [Product Architecture Canon](./ARCHITECTURE.md).

## 1. Editable source and generated projection

Repository-owned template contracts live under `.github/inari/`. GitHub-native Issue Forms and PR templates are generated projections for migrated repositories; do not maintain them as a second editable authority.

The current semantic-template v1 paths are `.github/inari/issues/<id>.json`, `.github/inari/pull-request.json`, or `.github/inari/pull-requests/<id>.json` for the multi-template form. Current discovery, compilation and synchronization semantics remain defined by the canonical implementation until a versioned migration changes them.

The target compiler consumes portable schema-native contracts: JSON Schema for shape plus Inari bindings, derivations, relations and provenance. Existing v1/native forms remain bounded compatibility inputs, not parallel shape/validation engines.

## 2. Ordinary Issue, Implementation and PR

Ordinary Issues state a problem, request, decision or acceptance outcome. They do not need execution scopes and Session/base details merely to exist. Implementation is the separate bounded task contract. PRs describe delivered work, links, verification and review concerns, not another authorization record.

Native provider relationships are canonical for hierarchy where supported. Source references and execution dependencies retain their contract meaning but do not override actual parent evidence. A historical prose Parent line does not trigger automatic reparenting.

Use the appropriate canonical template/routing role for Implementation, Source integration, Epic, trust and release work. Do not add a closing relation to an unrelated Issue merely to satisfy a form.

## 3. Discovery and input

The current resolver uses explicit selection, configured repository default, a sole candidate, interactive selection where permitted, or a bounded non-interactive failure. Invalid configured selection is not a reason to choose another template silently.

Only declared supplied semantic values are caller input. Fixed/derived outputs and presentation strings are not caller authority. Prefer the bounded semantic/schema view over copying native Markdown or YAML as the input contract.

Current synchronization/import operations remain canonical code paths. They validate supported native syntax, regenerate byte-stable projections and check freshness before governed mutation. This guide adds no command or permission and does not lift any operational agent-use suspension.

## 4. Freshness and compatibility

Compiled contracts bind immutable repository/governance provenance. Generated native projections must correspond to the selected source contract when that version's mutation path depends on them. An out-of-date generated template is not repaired by bypassing validation.

Schema-native migration must preserve supported old serialized meaning through explicit compilation. It must not silently reinterpret a v1 file as a newer schema or edit every consumer repository as incidental cleanup.

Automatic artifact reconciliation repairs only proven semantics-preserving differences with fresh observation. It cannot guess template intent, missing values or a new parent. Source, renderer and provider capability are tested separately and then round-tripped together.
