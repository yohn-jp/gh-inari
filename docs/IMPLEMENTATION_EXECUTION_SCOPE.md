# Implementation execution scope

`implementation-execution-scope` is Inari's versioned, transport-neutral
execution authority for one currently authorized Implementation. It is a
projection of the existing `implementation-authorization` and
`implementation` contracts. It is not a second authorization or scope model.

The producer is
`src/implementation-scope-projection.ts`. The module is the authority for the
v1 schema, validation, parsing, path evaluation, and canonical serialization.
Consumers must use those exported surfaces rather than reconstructing scope
from an Issue body, lifecycle prose, or a consumer-specific type.

## Artifact identity

The JSON artifact has these stable identity values:

| Field            | v1 value                                          | Authority                                   |
| ---------------- | ------------------------------------------------- | ------------------------------------------- |
| `kind`           | `implementation-execution-scope`                  | `IMPLEMENTATION_SCOPE_PROJECTION_KIND`      |
| `version`        | `1`                                               | `IMPLEMENTATION_SCOPE_PROJECTION_VERSION`   |
| schema `$id`     | `urn:inari:implementation-scope-projection:1.0.0` | `IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA_ID` |
| schema `$schema` | the exported JSON Schema dialect                  | `IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA`    |

The public schema is available as
`IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA` and as an isolated copy from
`projectImplementationScopeSchema()`. The parser and validators are
`parseImplementationScopeProjection`, `deserializeImplementationScopeProjection`,
`validateImplementationScopeProjection`, and
`isImplementationScopeProjection`. Canonical output is produced by
`serializeImplementationScopeProjection`.

Unsupported versions, kinds, unknown properties, invalid values, and
noncanonical serialized JSON are rejected. A consumer must fail closed when
parsing or validation fails. A single trailing line feed remains accepted by
the deserializer for compatibility with the existing parser behavior.

## v1 fields

The artifact has the following fields. No other root or nested properties are
part of v1.

| Path            | Meaning and authority                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`       | Projection wire version. It must be `1`; it is not inferred from the schema or consumer.                                                                         |
| `kind`          | Stable artifact discriminator. It must be `implementation-execution-scope`.                                                                                      |
| `authorization` | Identity of the authorization that produced the projection.                                                                                                      |
| `repository`    | Repository binding copied from the current authorization.                                                                                                        |
| `base`          | Base branch, revision, and freshness evidence copied from the current authorization.                                                                             |
| `branch`        | Optional implementation execution branch copied from the authorized contract when already decided. Its absence means no branch was decided; it grants no branch. |
| `scope`         | The five independent path lists authorized by the Implementation contract.                                                                                       |

`authorization` contains:

| Path                               | Meaning                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `authorization.version`            | Authorization record version; v1 is required.                           |
| `authorization.kind`               | `implementation-authorization`.                                         |
| `authorization.contractVersion`    | Implementation contract version; v1 is required.                        |
| `authorization.implementation`     | Repository-bound Issue reference for the governed Implementation.       |
| `authorization.governedBodyDigest` | Lowercase SHA-256 digest of the canonical governed Implementation body. |

`repository` contains `repositoryHost`, `repositoryId`, and the optional
`repository` owner/name locator. `base` contains `branch`, `revision`, and
`freshness`. These bindings identify the repository and base against which the
authorization was verified; they do not permit a consumer to substitute a
different repository or base.

`scope` contains these independent lists of canonical repository-relative
paths or globs:

| Field      | Authority                                                                           |
| ---------- | ----------------------------------------------------------------------------------- |
| `readOnly` | Paths readable by the governed execution. Read access grants no mutation.           |
| `write`    | Paths explicitly writable. It is never inferred from `readOnly`.                    |
| `create`   | Paths explicitly allowed for creation. It is never inferred from `write`.           |
| `delete`   | Paths explicitly allowed for deletion. It is never inferred from `write`.           |
| `deny`     | Paths denied for every operation. DENY is evaluated before the operation allowlist. |

Every list is present in v1. An omitted mutation in the source contract is
represented as an empty list. Empty lists remain empty; consumers must not
infer authority from another operation. Path evaluation is available through
`isImplementationScopeProjectionPathAllowed` and
`isImplementationScopeProjectionPathDenied`.

## Authority and lifecycle rules

`projectImplementationScope` and `tryProjectImplementationScope` accept the
existing lifecycle verification input and derive all output from its current
valid authorization and canonical contract. They do not accept a caller scope
or merge caller-supplied paths.

Projection is refused when authorization is missing, invalidated, stale,
superseded, completed, aborted, modified after authorization, or otherwise not
the current active authorized Implementation. A projection therefore cannot
widen the governed Implementation. The projection does not change Inari's
authorization semantics; it exposes their already-authorized result.

Serialization is deterministic: normalized object keys and scope paths are
serialized through the existing canonical JSON serializer. Consumers should
compare or transport the output of
`serializeImplementationScopeProjection`; they must not define another wire
format. `deserializeImplementationScopeProjection` accepts only that
canonical representation (with the compatibility trailing line feed noted
above).

This contract deliberately defines no Wabachi/Nawabari adapter, shared SDK,
or consumer-specific runtime type. External consumers depend on the public
projection artifact and its schema/parser surfaces only.
