import { ArtifactInputError, parseArtifactInputDocument, validateRequiredMetadataString, } from "./artifact.js";
import { createArtifactDiagnostic, createArtifactDiagnosticReport, createFieldEvidence } from "./diagnostics.js";
import { effectiveFieldConstraints, REQUIRED_STRING_PATTERN, schemaMinItems, } from "./contract/constraints.js";
import { JSON_SCHEMA_DIALECT, assertCanonicalContract, } from "./contract/ir.js";
import { projectToJsonSchema } from "./contract/schema.js";
import { validateSemanticInput } from "./contract/validation.js";
/** The single declaration for the machine-readable `pr sync --from` envelope. */
export const PR_SYNC_INPUT_CONTRACT = {
    id: "urn:inari:input:pull-request-sync:1",
    version: 1,
    kind: "pull_request_sync",
    properties: {
        fields: {
            valueKind: "semantic-fields",
            type: "object",
            required: true,
            description: "Semantic fields declared by the selected pull-request template.",
        },
        title: {
            valueKind: "non-empty-string",
            type: "string",
            required: true,
            description: "The desired pull-request title.",
        },
        head: {
            valueKind: "non-empty-string",
            type: "string",
            required: true,
            description: "The desired pull-request head branch.",
        },
        base: {
            valueKind: "non-empty-string",
            type: "string",
            required: true,
            description: "The desired pull-request base branch.",
        },
        draft: {
            valueKind: "boolean",
            type: "boolean",
            required: false,
            description: "Whether the pull request should remain a draft.",
        },
        maintainerCanModify: {
            valueKind: "boolean",
            type: "boolean",
            required: false,
            description: "Whether maintainers may modify the pull request.",
        },
    },
};
const requiredPropertyNames = Object.entries(PR_SYNC_INPUT_CONTRACT.properties)
    .filter(([, definition]) => definition.required)
    .map(([name]) => name);
const optionalPropertyNames = Object.entries(PR_SYNC_INPUT_CONTRACT.properties)
    .filter(([, definition]) => !definition.required)
    .map(([name]) => name);
/** Return the bounded top-level shape used by help and machine consumers. */
export function projectPullRequestSyncInput(contractInput) {
    assertCanonicalContract(contractInput);
    if (contractInput.artifactKind !== "pull_request") {
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "A pull request contract is required.");
    }
    const semanticSchema = projectToJsonSchema(contractInput);
    const properties = {};
    for (const [name, definition] of Object.entries(PR_SYNC_INPUT_CONTRACT.properties)) {
        properties[name] =
            definition.valueKind === "semantic-fields"
                ? semanticSchema
                : {
                    type: definition.type,
                    description: definition.description,
                    ...(definition.valueKind === "non-empty-string" ? { minLength: 1, pattern: REQUIRED_STRING_PATTERN } : {}),
                };
    }
    const schema = {
        $schema: JSON_SCHEMA_DIALECT,
        $id: `${PR_SYNC_INPUT_CONTRACT.id}:${encodeURIComponent(contractInput.templateIdentity.id)}`,
        title: "Pull request sync input",
        description: "Complete desired pull-request state accepted by `pr sync --from`.",
        type: "object",
        properties,
        required: requiredPropertyNames,
        additionalProperties: false,
    };
    return {
        contract: PR_SYNC_INPUT_CONTRACT,
        schema,
        minimalExample: minimalPullRequestSyncInput(contractInput),
    };
}
/** A valid top-level example, with semantic values generated from the selected contract. */
export function minimalPullRequestSyncInput(contractInput) {
    assertCanonicalContract(contractInput);
    if (contractInput.artifactKind !== "pull_request") {
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "A pull request contract is required.");
    }
    const fields = {};
    for (const field of contractInput.sections.flatMap((section) => section.fields)) {
        const constraints = effectiveFieldConstraints(contractInput, field);
        if (!constraints.required && !constraints.hasDefault)
            continue;
        if (constraints.hasDefault)
            continue;
        fields[field.id] = minimalFieldValue(field, constraints);
    }
    const validation = validateSemanticInput(contractInput, fields);
    if (!validation.valid) {
        throw new Error(`Could not generate a valid pull-request sync example: ${validation.violations.map((violation) => violation.path).join(", ")}`);
    }
    return {
        fields: validation.values,
        title: "Example pull request",
        head: "feature/example",
        base: "main",
    };
}
/** Parse the canonical JSON envelope before semantic field validation. */
export function parsePullRequestSyncInput(input) {
    if (!isRecord(input)) {
        throw prSyncInputError("$", "Pull-request sync input must be a JSON object.", "invalid", input);
    }
    const unknown = Object.keys(input).find((key) => !Object.prototype.hasOwnProperty.call(PR_SYNC_INPUT_CONTRACT.properties, key));
    if (unknown !== undefined) {
        throw prSyncInputError(`$.${unknown}`, `Unknown pull-request sync input property "${unknown}".`, "invalid", input[unknown]);
    }
    for (const name of requiredPropertyNames) {
        if (!Object.prototype.hasOwnProperty.call(input, name)) {
            throw prSyncInputError(`$.${name}`, `Required pull-request sync input property "${name}" is missing.`, "missing");
        }
    }
    for (const [name, definition] of Object.entries(PR_SYNC_INPUT_CONTRACT.properties)) {
        if (!Object.prototype.hasOwnProperty.call(input, name))
            continue;
        const value = input[name];
        if (definition.valueKind === "semantic-fields" && !isRecord(value)) {
            throw prSyncInputError(`$.${name}`, 'The "fields" property must be an object.', "invalid", value);
        }
        if (definition.valueKind === "non-empty-string" && validateRequiredMetadataString(value, name) !== undefined) {
            throw prSyncInputError(`$.${name}`, `${name} must be a non-empty string.`, "invalid", value);
        }
        if (definition.valueKind === "boolean" && typeof value !== "boolean") {
            throw prSyncInputError(`$.${name}`, `${name} must be a boolean.`, "invalid", value);
        }
    }
    return parseArtifactInputDocument(input);
}
/** Apply the same required top-level contract to direct-field input and CLI overrides. */
export function assertPullRequestSyncInputComplete(input) {
    const candidate = { fields: input.fields, ...input.metadata };
    for (const name of requiredPropertyNames) {
        if (!Object.prototype.hasOwnProperty.call(candidate, name)) {
            throw prSyncInputError(`$.${name}`, `Required pull-request sync input property "${name}" is missing.`, "missing");
        }
    }
    parsePullRequestSyncInput(candidate);
    return input;
}
export function renderPullRequestSyncInputHelp() {
    const required = requiredPropertyNames
        .map((name) => `${name} (${PR_SYNC_INPUT_CONTRACT.properties[name].type})`)
        .join(", ");
    const optional = optionalPropertyNames
        .map((name) => `${name} (${PR_SYNC_INPUT_CONTRACT.properties[name].type})`)
        .join(", ");
    return (`The --from JSON contract is one object with required top-level properties: ${required}. ` +
        `Optional top-level properties: ${optional}. ` +
        "`fields` must be the semantic object projected by `pr schema`, including that template's required fields; " +
        "no other top-level properties are accepted. " +
        "`pr schema --json` exposes this bounded contract and a valid minimal example.");
}
function minimalFieldValue(field, constraints) {
    if (field.type === "enum")
        return field.options[0]?.value ?? "example";
    if (field.type === "array") {
        const minimum = schemaMinItems(constraints) ?? 0;
        return minimalArrayValues(constraints.allowedValues ?? [], minimum, constraints.maxItems);
    }
    if (field.type === "checklist") {
        const values = [...constraints.requiredItems];
        const minimum = schemaMinItems(constraints) ?? 0;
        for (const item of field.items.map((entry) => entry.id)) {
            if (values.length >= minimum)
                break;
            if (!values.includes(item))
                values.push(item);
        }
        return values;
    }
    return minimalStringValue(constraints);
}
function minimalArrayValues(allowedValues, minimum, maxItems) {
    const values = [];
    let index = 0;
    while (values.length < minimum && (maxItems === undefined || values.length < maxItems)) {
        const candidate = allowedValues[index] ?? `example-${index + 1}`;
        if (!values.includes(candidate))
            values.push(candidate);
        index += 1;
    }
    return values;
}
function minimalStringValue(constraints) {
    const minimum = constraints.minLength ?? (constraints.required ? 1 : 0);
    const candidate = constraints.linkedIssue ? "Closes #1" : "example";
    if (candidate.length >= minimum &&
        (constraints.maxLength === undefined || candidate.length <= constraints.maxLength)) {
        return candidate;
    }
    const length = Math.max(minimum, 1);
    return "x".repeat(Math.min(length, constraints.maxLength ?? length));
}
function prSyncInputError(path, message, state, actual) {
    const detailCode = state === "missing" ? "FIELD_REQUIRED" : "FIELD_TYPE_MISMATCH";
    const diagnostic = createArtifactDiagnostic({
        state,
        code: state === "missing" ? "FIELD_MISSING" : "FIELD_INVALID",
        detailCode,
        path,
        message,
        ...(actual === undefined ? {} : { actual: createFieldEvidence(path, actual) }),
        recovery: [{ action: "provide", path, hint: `Provide a valid value for ${path}.` }],
    });
    return new ArtifactInputError("INPUT_DOCUMENT_INVALID", message, path, {
        contract: PR_SYNC_INPUT_CONTRACT.id,
        diagnostics: createArtifactDiagnosticReport([diagnostic]),
    });
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=pr-sync-input.js.map