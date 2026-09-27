import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import { JSON_SCHEMA_DIALECT } from "./ir.js";

const MAX_DIAGNOSTIC_PATH_LENGTH = 256;
const UNSUPPORTED_SCHEMA_EXTENSIONS = new Set(["$async", "discriminator", "nullable"]);
const SINGLE_SCHEMA_KEYWORDS = [
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const SCHEMA_MAP_KEYWORDS = ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

export type JsonSchemaDiagnosticCode = "schema_invalid" | "value_invalid";

/** Inari-owned diagnostic; it never includes candidate values or validator messages. */
export interface JsonSchemaDiagnostic {
  readonly code: JsonSchemaDiagnosticCode;
  /** RFC 6901 pointer into the candidate, when it fits the diagnostic bound. */
  readonly path?: string;
}

export interface JsonSchemaValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly JsonSchemaDiagnostic[];
}

export interface CompiledJsonSchema {
  validate(candidate: unknown): JsonSchemaValidationResult;
}

const schemaInvalidDiagnostic: JsonSchemaDiagnostic = Object.freeze({ code: "schema_invalid" });

/** Compilation failures carry a stable Inari diagnostic without exposing Ajv details. */
export class JsonSchemaCompilationError extends Error {
  readonly diagnostics = Object.freeze([schemaInvalidDiagnostic]);

  constructor() {
    super("JSON Schema compilation failed.");
    this.name = "JsonSchemaCompilationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnsupportedReferenceOrExtension(schema: AnySchema): boolean {
  const pending: unknown[] = [schema];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      if (visited.has(current)) continue;
      visited.add(current);
      for (const child of current) pending.push(child);
      continue;
    }
    if (!isRecord(current)) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const keyword of ["$ref", "$dynamicRef"] as const) {
      const reference = current[keyword];
      if (typeof reference === "string" && !reference.startsWith("#")) {
        return true;
      }
    }
    if (Object.keys(current).some((keyword) => UNSUPPORTED_SCHEMA_EXTENSIONS.has(keyword))) return true;

    for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
      const child = current[keyword];
      if (typeof child === "boolean" || isRecord(child)) pending.push(child);
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const children = current[keyword];
      if (isRecord(children)) {
        for (const child of Object.values(children)) pending.push(child);
      }
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      const children = current[keyword];
      if (Array.isArray(children)) {
        for (const child of children) pending.push(child);
      }
    }
  }

  return false;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function diagnosticPath(error: ErrorObject): string | undefined {
  let path = error.instancePath;
  const params = isRecord(error.params) ? error.params : {};
  const propertyName =
    error.keyword === "required"
      ? params.missingProperty
      : error.keyword === "additionalProperties" || error.keyword === "unevaluatedProperties"
        ? params.additionalProperty
        : error.keyword === "propertyNames"
          ? params.propertyName
          : undefined;

  if (typeof propertyName === "string") path += `/${escapePointerSegment(propertyName)}`;
  return path.length <= MAX_DIAGNOSTIC_PATH_LENGTH ? path : undefined;
}

function invalidValidationResult(): JsonSchemaValidationResult {
  return Object.freeze({
    valid: false,
    diagnostics: Object.freeze([Object.freeze({ code: "value_invalid" as const })]),
  });
}

function compileOptions(): ConstructorParameters<typeof Ajv2020>[0] {
  return {
    allErrors: true,
    coerceTypes: false,
    messages: false,
    ownProperties: true,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
    validateSchema: true,
  };
}

/**
 * Compile one Draft 2020-12 JSON Schema with a fresh, synchronous Ajv runtime.
 * Only references resolved within the admitted schema document are supported.
 */
export function compileJsonSchema(schema: unknown): CompiledJsonSchema {
  try {
    if (typeof schema !== "boolean" && !isSchemaObject(schema)) throw new JsonSchemaCompilationError();
    if (isRecord(schema) && schema.$schema !== undefined && schema.$schema !== JSON_SCHEMA_DIALECT) {
      throw new JsonSchemaCompilationError();
    }

    const candidateSchema = schema as AnySchema;
    if (hasUnsupportedReferenceOrExtension(candidateSchema)) throw new JsonSchemaCompilationError();

    const ajv = new Ajv2020(compileOptions());
    if (ajv.validateSchema(candidateSchema) === false) throw new JsonSchemaCompilationError();
    const validate = ajv.compile(candidateSchema) as ValidateFunction;

    return Object.freeze({
      validate(candidate: unknown): JsonSchemaValidationResult {
        let valid: boolean;
        try {
          valid = validate(candidate);
        } catch {
          return invalidValidationResult();
        }
        if (valid) return Object.freeze({ valid: true, diagnostics: Object.freeze([]) });

        const errors = validate.errors ?? [];
        const diagnostics = errors.map((error) => {
          const path = diagnosticPath(error);
          return Object.freeze({ code: "value_invalid" as const, ...(path === undefined ? {} : { path }) });
        });
        diagnostics.sort((left, right) => {
          const leftPath = left.path ?? "";
          const rightPath = right.path ?? "";
          return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
        });
        if (diagnostics.length === 0) return invalidValidationResult();
        return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics.slice(0, 16)) });
      },
    });
  } catch (error) {
    if (error instanceof JsonSchemaCompilationError) throw error;
    throw new JsonSchemaCompilationError();
  }
}
