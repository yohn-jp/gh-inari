import { assertCanonicalContract, JSON_SCHEMA_DIALECT, } from "./ir.js";
import { effectiveFieldConstraints, schemaMinItems, schemaStringPatternProjection } from "./constraints.js";
function fieldDescription(field) {
    return {
        title: field.label,
        ...(field.description === undefined ? {} : { description: field.description }),
    };
}
function stringConstraints(field, contract) {
    const constraints = effectiveFieldConstraints(contract, field);
    return {
        ...(constraints.minLength === undefined ? {} : { minLength: constraints.minLength }),
        ...(constraints.maxLength === undefined ? {} : { maxLength: constraints.maxLength }),
        ...schemaStringPatternProjection(constraints),
    };
}
function arrayConstraints(field, contract) {
    const constraints = effectiveFieldConstraints(contract, field);
    const minItems = schemaMinItems(constraints);
    return {
        ...(minItems === undefined ? {} : { minItems }),
        ...(constraints.maxItems === undefined ? {} : { maxItems: constraints.maxItems }),
    };
}
function projectField(field, contract) {
    const description = fieldDescription(field);
    const constraints = effectiveFieldConstraints(contract, field);
    if (field.type === "string") {
        return {
            ...description,
            type: "string",
            ...stringConstraints(field, contract),
            ...(constraints.hasDefault ? { default: constraints.defaultValue } : {}),
        };
    }
    if (field.type === "enum") {
        return {
            ...description,
            type: "string",
            enum: field.options.map((option) => option.value),
            ...stringConstraints(field, contract),
            ...(constraints.hasDefault ? { default: constraints.defaultValue } : {}),
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
            ...(constraints.hasDefault ? { default: [...constraints.defaultValue] } : {}),
        };
    }
    const itemIds = constraints.allowedValues ?? [];
    const itemSchema = {
        type: "string",
        enum: itemIds,
    };
    const requiredItemConstraints = constraints.requiredItems.map((itemId) => ({
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
        ...(constraints.hasDefault ? { default: [...constraints.defaultValue] } : {}),
    };
}
function schemaIdentifier(contract) {
    return [
        "urn:inari:contract",
        encodeURIComponent(contract.artifactKind),
        encodeURIComponent(contract.templateIdentity.id),
        "schema",
        encodeURIComponent(contract.schemaVersion),
    ].join(":");
}
export function projectToJsonSchema(input) {
    assertCanonicalContract(input);
    return projectValidatedContractToJsonSchema(input);
}
function projectValidatedContractToJsonSchema(contract) {
    const properties = {};
    const required = [];
    for (const section of contract.sections) {
        for (const field of section.fields) {
            properties[field.id] = projectField(field, contract);
            const constraints = effectiveFieldConstraints(contract, field);
            if (constraints.required && !constraints.hasDefault)
                required.push(field.id);
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
export function projectContract(input) {
    assertCanonicalContract(input);
    return {
        schema: projectValidatedContractToJsonSchema(input),
        rendering: {
            artifactKind: input.artifactKind,
            templateIdentity: input.templateIdentity,
            nativeMetadata: input.nativeMetadata,
            sections: input.sections,
            ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
        },
    };
}
export function serializeJsonSchema(schema) {
    const serialized = JSON.stringify(schema);
    if (serialized === undefined)
        throw new Error("JSON Schema could not be serialized.");
    return serialized;
}
//# sourceMappingURL=schema.js.map