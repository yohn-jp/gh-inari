import {
  assertCanonicalContract,
  type CanonicalContract,
  type CanonicalField,
  type FieldConstraints,
  JSON_SCHEMA_DIALECT,
  LINKED_ISSUE_PATTERN,
} from "./ir.js";

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
  readonly sections: CanonicalContract["sections"];
}

export interface ContractProjection {
  readonly schema: JsonSchemaDocument;
  /** Rendering/native information intentionally remains outside JSON Schema. */
  readonly rendering: RenderingProjection;
}

function supplementalForField(contract: CanonicalContract, fieldId: string) {
  return contract.supplementalConstraints.fields.find((constraint) => constraint.fieldId === fieldId);
}

function effectiveConstraint(
  field: CanonicalField,
  contract: CanonicalContract,
  key: keyof FieldConstraints,
): number | string | boolean | undefined {
  const nativeValue = field.constraints?.[key];
  if (nativeValue !== undefined) return nativeValue;
  const supplemental = supplementalForField(contract, field.id);
  if (supplemental === undefined || key === "uniqueItems") return undefined;
  const supplementalKey = key as Exclude<keyof FieldConstraints, "uniqueItems">;
  return supplemental[supplementalKey];
}

function fieldIsRequired(field: CanonicalField, contract: CanonicalContract): boolean {
  return field.required === "required" || supplementalForField(contract, field.id)?.required === true;
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
): Pick<JsonSchema, "minLength" | "maxLength" | "pattern"> {
  const minLength = effectiveConstraint(field, contract, "minLength");
  const maxLength = effectiveConstraint(field, contract, "maxLength");
  const pattern = effectiveConstraint(field, contract, "pattern");
  const supplemental = supplementalForField(contract, field.id);
  const linkedIssue = supplemental?.linkedIssue === true;

  return {
    ...(typeof minLength === "number" ? { minLength } : {}),
    ...(typeof maxLength === "number" ? { maxLength } : {}),
    ...(typeof pattern === "string" ? { pattern } : linkedIssue ? { pattern: LINKED_ISSUE_PATTERN } : {}),
  };
}

function arrayConstraints(
  field: CanonicalField,
  contract: CanonicalContract,
): Pick<JsonSchema, "minItems" | "maxItems"> {
  const minItems = effectiveConstraint(field, contract, "minItems");
  const maxItems = effectiveConstraint(field, contract, "maxItems");
  const supplemental = supplementalForField(contract, field.id);
  const checklistMinimum = field.type === "checklist" ? (supplemental?.checklistMinCompleted ?? 0) : 0;
  const checklistComplete = field.type === "checklist" && supplemental?.checklistRequireComplete === true;
  const completeMinimum = checklistComplete && field.type === "checklist" ? field.items.length : 0;
  const effectiveMinItems = Math.max(typeof minItems === "number" ? minItems : 0, checklistMinimum, completeMinimum);
  return {
    ...(effectiveMinItems > 0 ? { minItems: effectiveMinItems } : {}),
    ...(typeof maxItems === "number" ? { maxItems } : {}),
  };
}

function projectField(field: CanonicalField, contract: CanonicalContract): JsonSchema {
  const description = fieldDescription(field);
  if (field.type === "string") {
    return {
      ...description,
      type: "string",
      ...stringConstraints(field, contract),
      ...(field.defaultValue === undefined ? {} : { default: field.defaultValue }),
    };
  }
  if (field.type === "enum") {
    return {
      ...description,
      type: "string",
      enum: field.options.map((option) => option.value),
      ...stringConstraints(field, contract),
      ...(field.defaultValue === undefined ? {} : { default: field.defaultValue }),
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
      uniqueItems: true,
      ...arrayConstraints(field, contract),
      ...(field.defaultValue === undefined ? {} : { default: [...field.defaultValue] }),
    };
  }
  const itemIds = field.items.map((item) => item.id);
  const requiredItems = field.items.filter((item) => item.required).map((item) => item.id);
  const itemSchema: JsonSchema = {
    type: "string",
    enum: itemIds,
  };
  const requiredItemConstraints: readonly JsonSchema[] = requiredItems.map((itemId) => ({
    contains: { const: itemId },
    minContains: 1,
  }));
  return {
    ...description,
    type: "array",
    items: itemSchema,
    uniqueItems: true,
    ...arrayConstraints(field, contract),
    ...(requiredItemConstraints.length === 0 ? {} : { allOf: requiredItemConstraints }),
    ...(field.defaultValue === undefined ? {} : { default: [...field.defaultValue] }),
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

export function projectToJsonSchema(input: unknown): JsonSchemaDocument {
  assertCanonicalContract(input);
  const contract = input;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const section of contract.sections) {
    for (const field of section.fields) {
      properties[field.id] = projectField(field, contract);
      if (fieldIsRequired(field, contract)) required.push(field.id);
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

export const toJsonSchema = projectToJsonSchema;

export function projectContract(input: unknown): ContractProjection {
  assertCanonicalContract(input);
  return {
    schema: projectToJsonSchema(input),
    rendering: {
      artifactKind: input.artifactKind,
      templateIdentity: input.templateIdentity,
      nativeMetadata: input.nativeMetadata,
      sections: input.sections,
    },
  };
}

export function serializeJsonSchema(schema: JsonSchema): string {
  const serialized = JSON.stringify(schema);
  if (serialized === undefined) throw new Error("JSON Schema could not be serialized.");
  return serialized;
}
