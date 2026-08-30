import { type CanonicalContract, type ContractProvenance, JSON_SCHEMA_DIALECT } from "./ir.js";
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
    readonly provenance?: ContractProvenance;
}
export interface ContractProjection {
    readonly schema: JsonSchemaDocument;
    /** Required metadata accepted by create; deliberately separate from semantic body fields. */
    readonly metadata: JsonSchemaDocument;
    /** Rendering/native information intentionally remains outside JSON Schema. */
    readonly rendering: RenderingProjection;
}
export declare function projectToJsonSchema(input: unknown): JsonSchemaDocument;
/** Project the required create metadata separately from semantic body fields. */
export declare function projectArtifactMetadataSchema(input: unknown): JsonSchemaDocument;
export declare const toJsonSchema: typeof projectToJsonSchema;
export declare function projectContract(input: unknown): ContractProjection;
export declare function serializeJsonSchema(schema: JsonSchema): string;
