/**
 * Core compiler for the caller-facing portion of a Canon v2 Artifact
 * Contract.
 *
 * This module consumes the normalized Artifact Contract IR.  It does not
 * parse repository input, derive semantic values, materialize an artifact, or
 * know anything about a transport/projection target.  Derivation references
 * and format parts are already parsed by artifact-contract.ts and are copied
 * into the effective metadata for the later materialization phase.
 */

import {
  type ArtifactContract,
  type ArtifactContractDerivation,
  type ArtifactContractKind,
  type Cardinality,
  type DerivationReference,
  type FieldContentConstraints,
  type FieldDeclaration,
  type PropertyConstraints,
  type PropertyValueDeclaration,
  type ValueShape,
} from "./artifact-contract.js";
import { JSON_SCHEMA_DIALECT, type ArtifactContractProvenance } from "./ir.js";
import type { JsonSchema, JsonSchemaDocument } from "./schema.js";

export const EFFECTIVE_ARTIFACT_CONTRACT_VERSION = "1" as const;
export type EffectiveArtifactContractVersion = typeof EFFECTIVE_ARTIFACT_CONTRACT_VERSION;

export interface EffectiveArtifactContractOptions {
  /** Representation-independent Canon provenance; `treeSha` and `source` fingerprints bind generation. */
  readonly provenance: ArtifactContractProvenance;
  /** Opaque target capability identifiers are carried, never interpreted, by this compiler. */
  readonly capabilities?: readonly string[];
}

export class EffectiveArtifactContractCompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectiveArtifactContractCompilationError";
  }
}

export interface EffectiveArtifactContract {
  readonly version: EffectiveArtifactContractVersion;
  readonly artifactContractVersion: ArtifactContract["version"];
  readonly kind: ArtifactContractKind;
  readonly id: string;
  /** Immutable normalized source IR retained for downstream Core phases. */
  readonly contract: ArtifactContract;
  /** Normalized authority declarations for every supported property/field. */
  readonly properties: Readonly<Record<string, PropertyValueDeclaration>>;
  readonly fields?: readonly FieldDeclaration[];
  /** Exact closed-world caller input schema. */
  readonly inputSchema: JsonSchemaDocument;
  /** Parsed derivation plans and deterministic dependency/evaluation metadata. */
  readonly derivations: readonly ArtifactContractDerivation[];
  readonly dependencyGraph: Readonly<Record<string, readonly DerivationReference[]>>;
  readonly evaluationOrder: readonly string[];
  /** The same immutable Core provenance is exposed as the generation binding. */
  readonly provenance: ArtifactContractProvenance;
  readonly generation: ArtifactContractProvenance;
  readonly capabilities: readonly string[];
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

/** Clone and freeze JSON-shaped Core data without mutating the caller's IR. */
function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) clone[key] = cloneImmutable(value[key]);
    return Object.freeze(clone) as T;
  }
  return value;
}

function scalarSchema(shape: ValueShape, constraints?: PropertyConstraints): JsonSchema {
  if (shape === "boolean") return { type: "boolean" };
  if (shape === "issue_reference") return issueReferenceSchema();

  return {
    type: "string",
    ...(shape === "classification" || shape === "label"
      ? { ...(constraints?.values === undefined ? {} : { enum: constraints.values }) }
      : {}),
    ...(shape === "text" && constraints?.minLength !== undefined ? { minLength: constraints.minLength } : {}),
    ...(shape === "text" && constraints?.maxLength !== undefined ? { maxLength: constraints.maxLength } : {}),
    ...(shape === "text" && constraints?.pattern !== undefined ? { pattern: constraints.pattern } : {}),
  };
}

function issueReferenceSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      repositoryHost: { type: "string", minLength: 1, pattern: "^[^\\s/]+$" },
      repositoryId: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
      repository: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$",
      },
      number: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
    required: ["repositoryHost", "repositoryId", "number"],
    additionalProperties: false,
  };
}

function listSchema(
  item: JsonSchema,
  cardinality: Cardinality,
  minItems: number | undefined,
  maxItems: number | undefined,
): JsonSchema {
  const minimum = Math.max(cardinality.min, minItems ?? 0);
  return {
    type: "array",
    items: item,
    uniqueItems: true,
    ...(minimum === 0 ? {} : { minItems: minimum }),
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

function propertySchema(declaration: PropertyValueDeclaration): JsonSchema {
  const constraints = declaration.presence === "unused" ? undefined : declaration.constraints;
  const item = scalarSchema(declaration.shape, constraints);
  if (declaration.cardinality.max !== "many") return item;
  return listSchema(item, declaration.cardinality, constraints?.minItems, constraints?.maxItems);
}

function fieldTextSchema(constraints: FieldContentConstraints | undefined): JsonSchema {
  return {
    type: "string",
    ...(constraints?.minLength === undefined ? {} : { minLength: constraints.minLength }),
    ...(constraints?.maxLength === undefined ? {} : { maxLength: constraints.maxLength }),
    ...(constraints?.pattern === undefined ? {} : { pattern: constraints.pattern }),
  };
}

function fieldSchema(field: FieldDeclaration): JsonSchema {
  if (field.presence === "unused") return {};
  const constraints = field.constraints;
  if (field.primitive === "text") return fieldTextSchema(constraints);
  if (field.primitive === "choice") {
    return listSchema(
      {
        type: "string",
        ...(constraints?.values === undefined ? {} : { enum: constraints.values }),
      },
      field.cardinality,
      constraints?.minItems,
      constraints?.maxItems,
    );
  }
  if (field.primitive === "checklist") {
    const items = constraints?.items ?? [];
    const requiredItems = items.filter((item) => item.required).map((item) => item.id);
    const schema = listSchema(
      { type: "string", enum: items.map((item) => item.id) },
      field.cardinality,
      undefined,
      undefined,
    );
    return {
      ...schema,
      ...(requiredItems.length === 0
        ? {}
        : {
            allOf: requiredItems.map((id) => ({
              contains: { const: id },
              minContains: 1,
            })),
          }),
    };
  }
  // Canon v2 deliberately leaves attachment payload structure to the target
  // attachment capability; cardinality remains Core-owned here.
  return listSchema({}, field.cardinality, constraints?.minItems, constraints?.maxItems);
}

function callerInput(declaration: PropertyValueDeclaration | FieldDeclaration): boolean {
  return declaration.presence !== "unused" && declaration.authority.kind === "supplied";
}

function declarationName(field: FieldDeclaration): string {
  return field.id;
}

function buildInputSchema(contract: ArtifactContract): JsonSchemaDocument {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const name of Object.keys(contract.properties).sort(compareStrings)) {
    const declaration = contract.properties[name];
    if (declaration === undefined || !callerInput(declaration)) continue;
    properties[name] = propertySchema(declaration);
    if (declaration.presence === "required") required.push(name);
  }
  for (const field of contract.fields ?? []) {
    if (!callerInput(field)) continue;
    const name = declarationName(field);
    properties[name] = fieldSchema(field);
    if (field.presence === "required") required.push(name);
  }
  required.sort(compareStrings);
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: [
      "urn:inari:effective-artifact-contract",
      encodeURIComponent(contract.version),
      encodeURIComponent(contract.kind),
      encodeURIComponent(contract.id),
    ].join(":"),
    title: `${contract.kind} ${contract.id} caller input`,
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function topologicalOrder(derivations: readonly ArtifactContractDerivation[]): readonly string[] {
  const nodes = [...derivations].sort((left, right) => compareStrings(left.target, right.target));
  const byName = new Map(nodes.map((node) => [node.target, node]));
  if (byName.size !== nodes.length) throw new EffectiveArtifactContractCompilationError("Duplicate derivation target.");

  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const node of nodes) {
    const nodeDependencies = new Set<string>();
    for (const dependency of node.dependencies) {
      if (!byName.has(dependency.name)) continue;
      nodeDependencies.add(dependency.name);
      const consumers = dependents.get(dependency.name) ?? new Set<string>();
      consumers.add(node.target);
      dependents.set(dependency.name, consumers);
    }
    dependencies.set(node.target, nodeDependencies);
  }

  const ready = nodes.filter((node) => (dependencies.get(node.target)?.size ?? 0) === 0).map((node) => node.target);
  ready.sort(compareStrings);
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as string;
    order.push(current);
    for (const dependent of [...(dependents.get(current) ?? [])].sort(compareStrings)) {
      const remaining = dependencies.get(dependent);
      remaining?.delete(current);
      if (remaining?.size === 0) {
        ready.push(dependent);
        ready.sort(compareStrings);
      }
    }
  }
  if (order.length !== nodes.length)
    throw new EffectiveArtifactContractCompilationError("Derivation dependency cycle.");
  return order;
}

function buildDependencyGraph(
  derivations: readonly ArtifactContractDerivation[],
): Readonly<Record<string, readonly DerivationReference[]>> {
  const graph: Record<string, readonly DerivationReference[]> = {};
  for (const derivation of [...derivations].sort((left, right) => compareStrings(left.target, right.target))) {
    graph[derivation.target] = derivation.dependencies;
  }
  return graph;
}

function normalizeCapabilities(capabilities: readonly string[] | undefined): readonly string[] {
  const values = capabilities ?? [];
  if (values.some((capability) => typeof capability !== "string" || capability.length === 0)) {
    throw new EffectiveArtifactContractCompilationError("Capability identifiers must be non-empty strings.");
  }
  return [...new Set(values)].sort(compareStrings);
}

/** Compile a normalized Artifact Contract into the immutable Core discovery contract. */
export function compileEffectiveArtifactContract(
  contractInput: ArtifactContract,
  options: EffectiveArtifactContractOptions,
): EffectiveArtifactContract {
  if (!isRecord(contractInput) || !isRecord(options) || !isRecord(options.provenance)) {
    throw new EffectiveArtifactContractCompilationError("An Artifact Contract and immutable provenance are required.");
  }
  if (!Array.isArray(contractInput.derivations)) {
    throw new EffectiveArtifactContractCompilationError("Artifact Contract derivation metadata is missing.");
  }

  const contract = cloneImmutable(contractInput);
  const provenance = cloneImmutable(options.provenance);
  const derivations = cloneImmutable(
    [...contract.derivations].sort((left, right) => compareStrings(left.target, right.target)),
  );
  const capabilities = cloneImmutable(normalizeCapabilities(options.capabilities));
  const inputSchema = cloneImmutable(buildInputSchema(contract));
  const dependencyGraph = cloneImmutable(buildDependencyGraph(derivations));
  const evaluationOrder = cloneImmutable(topologicalOrder(derivations));

  return Object.freeze({
    version: EFFECTIVE_ARTIFACT_CONTRACT_VERSION,
    artifactContractVersion: contract.version,
    kind: contract.kind,
    id: contract.id,
    contract,
    properties: contract.properties,
    ...(contract.fields === undefined ? {} : { fields: contract.fields }),
    inputSchema,
    derivations,
    dependencyGraph,
    evaluationOrder,
    provenance,
    generation: provenance,
    capabilities,
  });
}
