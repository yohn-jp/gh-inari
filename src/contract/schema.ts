import {
  assertCanonicalContract,
  type CanonicalContract,
  type CanonicalField,
  type ContractProvenance,
  JSON_SCHEMA_DIALECT,
} from "./ir.js";
import {
  effectiveFieldConstraints,
  schemaMinItems,
  schemaStringPatternProjection,
} from "./constraints.js";
import { effectiveTitleGovernance, projectTitleSchema } from "./title.js";

/** JSON Schema values used by the projected public input contract. */
export type JsonSchemaPrimitive = string | number | boolean | null;

export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: "object" | "string" | "array" | "boolean";
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly JsonSchemaPrimitive[];
  readonly const?: JsonSchemaPrimitive;
  readonly items?: JsonSchema;
  readonly uniqueItems?: boolean;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly default?: JsonSchemaPrimitive | readonly JsonSchemaPrimitive[];
  readonly allOf?: readonly JsonSchema[];
  readonly contains?: JsonSchema;
  readonly minContains?: number;
}

export interface JsonSchemaDocument extends JsonSchema {
  readonly $schema: typeof JSON_SCHEMA_DIALECT;
  readonly $id: string;
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly additionalProperties: false;
}

export interface RenderingProjection {
  readonly artifactKind: CanonicalContract["artifactKind"];
  readonly templateIdentity: CanonicalContract["templateIdentity"];
  readonly nativeMetadata: CanonicalContract["nativeMetadata"];
  readonly titleGovernance: CanonicalContract["titleGovernance"];
  readonly sections: CanonicalContract["sections"];
  readonly provenance?: ContractProvenance;
}

export interface ContractProjection {
  readonly schema: JsonSchemaDocument;
  /** Required metadata accepted by create; deliberately separate from semantic body fields. */
  readonly metadata: JsonSchemaDocument;
  /** Rendering/native information intentionally remains outside JSON Schema. */
  readonly rendering: RenderingProjection;
}

function fieldDescription(field: CanonicalField): Pick<JsonSchema, "title" | "description"> {
  return {
    title: field.label,
    ...(field.description === undefined ? {} : { description: field.description }),
  };
}

function stringConstraints(
  field: CanonicalField,
  contract: CanonicalContract,
): Pick<JsonSchema, "minLength" | "maxLength" | "pattern" | "allOf"> {
  const constraints = effectiveFieldConstraints(contract, field);

  return {
    ...(constraints.minLength === undefined ? {} : { minLength: constraints.minLength }),
    ...(constraints.maxLength === undefined ? {} : { maxLength: constraints.maxLength }),
    ...schemaStringPatternProjection(constraints),
  };
}

function arrayConstraints(
  field: CanonicalField,
  contract: CanonicalContract,
): Pick<JsonSchema, "minItems" | "maxItems"> {
  const constraints = effectiveFieldConstraints(contract, field);
  const minItems = schemaMinItems(constraints);
  return {
    ...(minItems === undefined ? {} : { minItems }),
    ...(constraints.maxItems === undefined ? {} : { maxItems: constraints.maxItems }),
  };
}

function projectField(field: CanonicalField, contract: CanonicalContract): JsonSchema {
  const description = fieldDescription(field);
  const constraints = effectiveFieldConstraints(contract, field);
  if (field.type === "string") {
    return {
      ...description,
      type: "string",
      ...stringConstraints(field, contract),
      ...(constraints.hasDefault ? { default: constraints.defaultValue as string } : {}),
    };
  }
  if (field.type === "enum") {
    return {
      ...description,
      type: "string",
      enum: field.options.map((option) => option.value),
      ...stringConstraints(field, contract),
      ...(constraints.hasDefault ? { default: constraints.defaultValue as string } : {}),
    };
  }
  if (field.type === "array") {
    const itemOptions = field.items.options?.map((option) => option.value);
    return {
      ...description,
      type: "array",
      items: {
        type: "string",
        ...(itemOptions === undefined ? {} : { enum: itemOptions }),
      },
      uniqueItems: constraints.uniqueItems,
      ...arrayConstraints(field, contract),
      ...(constraints.hasDefault ? { default: [...(constraints.defaultValue as readonly string[])] } : {}),
    };
  }
  const itemIds = constraints.allowedValues ?? [];
  const itemSchema: JsonSchema = {
    type: "string",
    enum: itemIds,
  };
  const requiredItemConstraints: readonly JsonSchema[] = constraints.requiredItems.map((itemId) => ({
    contains: { const: itemId },
    minContains: 1,
  }));
  return {
    ...description,
    type: "array",
    items: itemSchema,
    uniqueItems: constraints.uniqueItems,
    ...arrayConstraints(field, contract),
    ...(requiredItemConstraints.length === 0 ? {} : { allOf: requiredItemConstraints }),
    ...(constraints.hasDefault ? { default: [...(constraints.defaultValue as readonly string[])] } : {}),
  };
}

function schemaIdentifier(contract: CanonicalContract): string {
  return [
    "urn:inari:contract",
    encodeURIComponent(contract.artifactKind),
    encodeURIComponent(contract.templateIdentity.id),
    "schema",
    encodeURIComponent(contract.schemaVersion),
  ].join(":");
}

function metadataSchemaIdentifier(contract: CanonicalContract): string {
  return [
    "urn:inari:contract",
    encodeURIComponent(contract.artifactKind),
    encodeURIComponent(contract.templateIdentity.id),
    "metadata-schema",
    encodeURIComponent(contract.schemaVersion),
  ].join(":");
}

export function projectToJsonSchema(input: unknown): JsonSchemaDocument {
  assertCanonicalContract(input);
  return projectValidatedContractToJsonSchema(input);
}

function projectValidatedContractToJsonSchema(contract: CanonicalContract): JsonSchemaDocument {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const section of contract.sections) {
    for (const field of section.fields) {
      properties[field.id] = projectField(field, contract);
      const constraints = effectiveFieldConstraints(contract, field);
      if (constraints.required && !constraints.hasDefault) required.push(field.id);
    }
  }
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: schemaIdentifier(contract),
    title: contract.nativeMetadata.title ?? contract.templateIdentity.name,
    ...(contract.nativeMetadata.description === undefined ? {} : { description: contract.nativeMetadata.description }),
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function projectValidatedArtifactMetadataSchema(contract: CanonicalContract): JsonSchemaDocument {
  const noun = contract.artifactKind === "issue" ? "Issue" : "pull request";
  const titleGovernance = effectiveTitleGovernance(contract);
  const fixedTitle = titleGovernance.prefix ?? titleGovernance.template;
  const titleDescription = fixedTitle !== undefined
    ? `Caller-supplied ${noun} title; provide content beyond the fixed native template prefix.`
    : `Caller-supplied ${noun} title.`;
  const titleSchema = projectTitleSchema(titleGovernance);
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: metadataSchemaIdentifier(contract),
    title: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} metadata input`,
    description: `Required metadata accepted by \`${contract.artifactKind === "issue" ? "issue" : "pr"} create\`.`,
    type: "object",
    properties: {
      title: {
        description: titleDescription,
        ...titleSchema,
      },
    },
    ...(titleGovernance.required ? { required: ["title"] } : {}),
    additionalProperties: false,
  };
}

/** Project the required create metadata separately from semantic body fields. */
export function projectArtifactMetadataSchema(input: unknown): JsonSchemaDocument {
  assertCanonicalContract(input);
  return projectValidatedArtifactMetadataSchema(input);
}

export const toJsonSchema = projectToJsonSchema;

export function projectContract(input: unknown): ContractProjection {
  assertCanonicalContract(input);
  return {
    schema: projectValidatedContractToJsonSchema(input),
    metadata: projectValidatedArtifactMetadataSchema(input),
    rendering: {
      artifactKind: input.artifactKind,
      templateIdentity: input.templateIdentity,
      nativeMetadata: input.nativeMetadata,
      titleGovernance: effectiveTitleGovernance(input),
      sections: input.sections,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    },
  };
}

export function serializeJsonSchema(schema: JsonSchema): string {
  const serialized = JSON.stringify(schema);
  if (serialized === undefined) throw new Error("JSON Schema could not be serialized.");
  return serialized;
}
