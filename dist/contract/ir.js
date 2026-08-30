/**
 * Versioned, compiler-generated contract representation.
 *
 * This module deliberately describes the result of compiling a repository's
 * native template. It is not a second template language for repository
 * authors to maintain.
 */
export const CANONICAL_IR_VERSION = "1.0.0";
export const CONTRACT_SCHEMA_VERSION = "1.0.0";
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
/** Separator used by native multi-select Issue Form artifacts. */
export const MULTI_SELECT_OPTION_SEPARATOR = ",";
/**
 * GitHub's syntactic closing-reference language for pull request bodies.
 * Contextual effects, such as closing only when targeting the default branch,
 * remain GitHub behavior and are deliberately outside this contract rule.
 */
export const LINKED_ISSUE_PATTERN = "(?:^|[^A-Za-z0-9_])(?:[Cc][Ll][Oo][Ss][Ee](?:[Ss]|[Dd])?|[Ff][Ii][Xx](?:[Ee][Ss]|[Ee][Dd])?|[Rr][Ee][Ss][Oo][Ll][Vv][Ee](?:[Ss]|[Dd])?)(?:[ \\t]+|[ \\t]*:[ \\t]*)(?:#[1-9][0-9]*|[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*#[1-9][0-9]*)(?![A-Za-z0-9_])";
export class CanonicalIrValidationError extends Error {
    violations;
    constructor(violations) {
        super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
        this.name = "CanonicalIrValidationError";
        this.violations = violations;
    }
}
const requiredStates = ["required", "optional", "unknown"];
const fieldTypes = ["string", "enum", "array", "checklist"];
const templateSources = ["issue_form", "pull_request_template"];
const sectionKinds = ["input", "documentation"];
const arraySelections = ["list", "multi_select"];
const nativeSectionElements = [
    "input",
    "textarea",
    "dropdown",
    "checkboxes",
    "markdown",
    "heading",
];
const identifierPattern = /^[A-Za-z0-9_-]+$/u;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
function addViolation(violations, code, path, message) {
    violations.push({ code, path, message });
}
function checkUnknownKeys(record, allowedKeys, path, violations) {
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            addViolation(violations, "IR_UNKNOWN_PROPERTY", `${path}.${key}`, `Property "${key}" is not supported.`);
        }
    }
}
function requiredString(record, key, path, violations) {
    if (!hasOwn(record, key)) {
        addViolation(violations, "IR_MISSING_PROPERTY", `${path}.${key}`, `Property "${key}" is required.`);
        return undefined;
    }
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        addViolation(violations, "IR_INVALID_VALUE", `${path}.${key}`, `Property "${key}" must be a non-empty string.`);
        return undefined;
    }
    return value;
}
function optionalString(record, key, path, violations) {
    if (!hasOwn(record, key))
        return undefined;
    const value = record[key];
    if (typeof value !== "string") {
        addViolation(violations, "IR_INVALID_VALUE", `${path}.${key}`, `Property "${key}" must be a string when present.`);
        return undefined;
    }
    return value;
}
function optionalBoolean(record, key, path, violations) {
    if (!hasOwn(record, key))
        return undefined;
    const value = record[key];
    if (typeof value !== "boolean") {
        addViolation(violations, "IR_INVALID_VALUE", `${path}.${key}`, `Property "${key}" must be a boolean when present.`);
        return undefined;
    }
    return value;
}
function optionalStringArray(record, key, path, violations) {
    if (!hasOwn(record, key))
        return undefined;
    const value = record[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        addViolation(violations, "IR_INVALID_VALUE", `${path}.${key}`, `Property "${key}" must be an array of strings.`);
        return undefined;
    }
    return value;
}
function requiredArray(record, key, path, violations) {
    if (!hasOwn(record, key)) {
        addViolation(violations, "IR_MISSING_PROPERTY", `${path}.${key}`, `Property "${key}" is required.`);
        return undefined;
    }
    const value = record[key];
    if (!Array.isArray(value)) {
        addViolation(violations, "IR_INVALID_VALUE", `${path}.${key}`, `Property "${key}" must be an array.`);
        return undefined;
    }
    return value;
}
function requiredRecord(record, key, path, violations) {
    if (!hasOwn(record, key)) {
        addViolation(violations, "IR_MISSING_PROPERTY", `${path}.${key}`, `Property "${key}" is required.`);
        return undefined;
    }
    const value = record[key];
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_VALUE", `${path}.${key}`, `Property "${key}" must be an object.`);
        return undefined;
    }
    return value;
}
function validateProvenance(value, path, artifactKind, templatePath, violations) {
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_PROVENANCE", path, "Contract provenance must be an object.");
        return;
    }
    checkUnknownKeys(value, ["authority", "repository", "ref", "treeSha", "template", "policy", "branchGovernance"], path, violations);
    const authority = requiredString(value, "authority", path, violations);
    const ref = requiredString(value, "ref", path, violations);
    requiredString(value, "treeSha", path, violations);
    const repository = requiredRecord(value, "repository", path, violations);
    const template = requiredRecord(value, "template", path, violations);
    if (authority !== undefined && authority !== "repository-default-branch") {
        addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.authority`, 'Provenance authority must be "repository-default-branch".');
    }
    if (repository !== undefined) {
        checkUnknownKeys(repository, ["host", "owner", "name", "nameWithOwner", "repositoryId"], `${path}.repository`, violations);
        const host = requiredString(repository, "host", `${path}.repository`, violations);
        const owner = requiredString(repository, "owner", `${path}.repository`, violations);
        const name = requiredString(repository, "name", `${path}.repository`, violations);
        const nameWithOwner = requiredString(repository, "nameWithOwner", `${path}.repository`, violations);
        const repositoryId = optionalString(repository, "repositoryId", `${path}.repository`, violations);
        if (host !== undefined && /[\s/]/u.test(host)) {
            addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.repository.host`, "Repository host is invalid.");
        }
        if (owner !== undefined && name !== undefined && nameWithOwner !== `${owner}/${name}`) {
            addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.repository.nameWithOwner`, "Repository nameWithOwner must match owner and name.");
        }
        if (repositoryId !== undefined && !/^[1-9][0-9]{0,19}$/u.test(repositoryId)) {
            addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.repository.repositoryId`, "Repository repositoryId must be a positive decimal REST database identity.");
        }
    }
    const templateSource = validateProvenanceSource(template, `${path}.template`, ref, violations);
    if (templateSource !== undefined && templatePath !== undefined && templateSource.path !== templatePath) {
        addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.template.path`, "Template provenance path must match templateIdentity.path.");
    }
    if (hasOwn(value, "policy")) {
        if (artifactKind !== "pull_request") {
            addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.policy`, "Only pull request contracts may contain policy provenance.");
        }
        validateProvenanceSource(value.policy, `${path}.policy`, ref, violations);
    }
    if (hasOwn(value, "branchGovernance")) {
        if (artifactKind !== "pull_request") {
            addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.branchGovernance`, "Only pull request contracts may contain branch governance provenance.");
        }
        validateBranchGovernance(value.branchGovernance, `${path}.branchGovernance`, violations);
    }
}
function validateBranchGovernance(value, path, violations) {
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_PROVENANCE", path, "Branch governance must be an object.");
        return;
    }
    checkUnknownKeys(value, ["pattern"], path, violations);
    const pattern = requiredString(value, "pattern", path, violations);
    if (pattern !== undefined) {
        try {
            new RegExp(pattern, "u");
        }
        catch {
            addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.pattern`, "Pattern must be a valid regular expression.");
        }
    }
}
function validateProvenanceSource(value, path, contractRef, violations) {
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_PROVENANCE", path, "Provenance source must be an object.");
        return undefined;
    }
    checkUnknownKeys(value, ["path", "ref", "sha", "digest"], path, violations);
    const sourcePath = requiredString(value, "path", path, violations);
    const ref = requiredString(value, "ref", path, violations);
    requiredString(value, "sha", path, violations);
    requiredString(value, "digest", path, violations);
    if (sourcePath !== undefined &&
        (sourcePath.startsWith("/") || sourcePath.includes("\\") || sourcePath.split("/").includes(".."))) {
        addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.path`, "Provenance source path is not repository-relative.");
    }
    if (contractRef !== undefined && ref !== undefined && ref !== contractRef) {
        addViolation(violations, "IR_INVALID_PROVENANCE", `${path}.ref`, "Source ref must match contract provenance ref.");
    }
    return value;
}
function validateIdentifier(value, path, violations) {
    if (value !== undefined && !identifierPattern.test(value)) {
        addViolation(violations, "IR_INVALID_IDENTIFIER", path, "Identifiers must be non-empty and contain only letters, numbers, hyphens, or underscores.");
    }
}
function validateEnumValue(value, path, violations) {
    if (typeof value !== "string" || value.length === 0) {
        addViolation(violations, "IR_INVALID_OPTIONS", path, "Option values must be non-empty strings.");
        return undefined;
    }
    return value;
}
function validateOptionalDefault(record, path, violations) {
    return hasOwn(record, "defaultValue") ? record.defaultValue : undefined;
}
function validateRenderMetadata(value, path, expectedOrder, violations, allowHeadingLevel) {
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_ORDER", path, "Render metadata must be an object.");
        return;
    }
    checkUnknownKeys(value, allowHeadingLevel ? ["order", "headingLevel"] : ["order"], path, violations);
    if (!hasOwn(value, "order") || !Number.isSafeInteger(value.order) || value.order !== expectedOrder) {
        addViolation(violations, "IR_INVALID_ORDER", `${path}.order`, `Render order must be the zero-based position ${expectedOrder}.`);
    }
    if (allowHeadingLevel && hasOwn(value, "headingLevel")) {
        if (typeof value.headingLevel !== "number" ||
            !Number.isSafeInteger(value.headingLevel) ||
            value.headingLevel < 1 ||
            value.headingLevel > 6) {
            addViolation(violations, "IR_INVALID_VALUE", `${path}.headingLevel`, "Heading level must be an integer from 1 to 6.");
        }
    }
}
function validateNativeOption(value, path, violations) {
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_NATIVE_METADATA", path, "Native options must be objects.");
        return undefined;
    }
    checkUnknownKeys(value, ["value", "label", "description", "required"], path, violations);
    const optionValue = requiredString(value, "value", path, violations);
    const label = optionalString(value, "label", path, violations);
    const description = optionalString(value, "description", path, violations);
    const required = optionalBoolean(value, "required", path, violations);
    return optionValue === undefined
        ? undefined
        : {
            value: optionValue,
            ...(label === undefined ? {} : { label }),
            ...(description === undefined ? {} : { description }),
            ...(required === undefined ? {} : { required }),
        };
}
function validateNativeOptions(value, path, violations) {
    if (!Array.isArray(value)) {
        addViolation(violations, "IR_INVALID_NATIVE_METADATA", path, "Native options must be an array.");
        return undefined;
    }
    const options = [];
    const values = new Set();
    value.forEach((entry, index) => {
        const option = validateNativeOption(entry, `${path}[${index}]`, violations);
        if (option !== undefined) {
            if (values.has(option.value)) {
                addViolation(violations, "IR_DUPLICATE_ID", `${path}[${index}].value`, `Duplicate native option "${option.value}".`);
            }
            values.add(option.value);
            options.push(option);
        }
    });
    return options;
}
function validateNativeSectionMetadata(value, path, source, kind, violations) {
    if (value === undefined) {
        addViolation(violations, "IR_MISSING_PROPERTY", path, 'Property "nativeMetadata" is required.');
        return;
    }
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_VALUE", path, 'Property "nativeMetadata" must be an object.');
        return;
    }
    const metadata = value;
    checkUnknownKeys(metadata, ["elementType", "sourceId", "headingLevel", "markdown"], path, violations);
    const elementType = requiredString(metadata, "elementType", path, violations);
    const sourceId = optionalString(metadata, "sourceId", path, violations);
    const markdown = optionalString(metadata, "markdown", path, violations);
    if (sourceId !== undefined)
        validateIdentifier(sourceId, `${path}.sourceId`, violations);
    if (elementType !== undefined && !nativeSectionElements.includes(elementType)) {
        addViolation(violations, "IR_INVALID_NATIVE_METADATA", `${path}.elementType`, `Native section type "${elementType}" is not supported.`);
    }
    if (source === "issue_form") {
        if (kind === "documentation" && elementType !== "markdown") {
            addViolation(violations, "IR_INCONSISTENT_SOURCE", path, "Issue Form documentation sections must use native markdown metadata.");
        }
        if (kind === "input" && elementType === "markdown") {
            addViolation(violations, "IR_INCONSISTENT_SOURCE", path, "Issue Form input sections cannot use native markdown metadata.");
        }
    }
    else {
        if (kind === "documentation" && elementType !== "markdown") {
            addViolation(violations, "IR_INCONSISTENT_SOURCE", path, "PR documentation sections must use native markdown metadata.");
        }
        if (kind === "input" && elementType !== "heading") {
            addViolation(violations, "IR_INCONSISTENT_SOURCE", path, "PR input sections must use native heading metadata.");
        }
    }
    if (kind === "documentation" && (markdown === undefined || markdown.length === 0)) {
        addViolation(violations, "IR_INVALID_NATIVE_METADATA", `${path}.markdown`, "Documentation metadata must preserve its markdown content.");
    }
    if (kind === "input" && markdown !== undefined) {
        addViolation(violations, "IR_INVALID_NATIVE_METADATA", `${path}.markdown`, "Input sections cannot contain native markdown content.");
    }
    if (hasOwn(metadata, "headingLevel")) {
        if (typeof metadata.headingLevel !== "number" ||
            !Number.isSafeInteger(metadata.headingLevel) ||
            metadata.headingLevel < 1 ||
            metadata.headingLevel > 6) {
            addViolation(violations, "IR_INVALID_NATIVE_METADATA", `${path}.headingLevel`, "Heading level must be an integer from 1 to 6.");
        }
        if (elementType !== "heading") {
            addViolation(violations, "IR_INCONSISTENT_SOURCE", `${path}.headingLevel`, "Heading level is only valid for native headings.");
        }
    }
}
function validateNativeFieldMetadata(value, path, source, fieldType, violations) {
    if (value === undefined) {
        addViolation(violations, "IR_MISSING_PROPERTY", path, 'Property "nativeMetadata" is required.');
        return undefined;
    }
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_VALUE", path, 'Property "nativeMetadata" must be an object.');
        return undefined;
    }
    const metadata = value;
    checkUnknownKeys(metadata, ["elementType", "sourceId", "placeholder", "defaultValue", "render", "multiple", "options"], path, violations);
    const elementType = requiredString(metadata, "elementType", path, violations);
    const sourceId = optionalString(metadata, "sourceId", path, violations);
    const placeholder = optionalString(metadata, "placeholder", path, violations);
    const defaultValue = hasOwn(metadata, "defaultValue") ? metadata.defaultValue : undefined;
    const render = optionalString(metadata, "render", path, violations);
    if (render !== undefined && (source !== "issue_form" || elementType !== "textarea")) {
        addViolation(violations, "IR_INCONSISTENT_FIELD", `${path}.render`, "The render property is only valid for Issue Form textarea fields.");
    }
    const multiple = optionalBoolean(metadata, "multiple", path, violations);
    const options = hasOwn(metadata, "options")
        ? validateNativeOptions(metadata.options, `${path}.options`, violations)
        : undefined;
    if (sourceId !== undefined)
        validateIdentifier(sourceId, `${path}.sourceId`, violations);
    if (source === "issue_form" && elementType === "pr_section") {
        addViolation(violations, "IR_INCONSISTENT_SOURCE", path, "Issue Form fields cannot use PR section metadata.");
    }
    if (source === "pull_request_template" && elementType !== "pr_section") {
        addViolation(violations, "IR_INCONSISTENT_SOURCE", path, "PR fields must use native PR section metadata.");
    }
    if (multiple !== undefined && elementType !== "dropdown") {
        addViolation(violations, "IR_INCONSISTENT_FIELD", `${path}.multiple`, "The multiple flag is only valid for native dropdowns.");
    }
    const expectedElements = {
        string: source === "issue_form" ? ["input", "textarea"] : ["pr_section"],
        enum: source === "issue_form" ? ["dropdown"] : ["pr_section"],
        array: source === "issue_form" ? ["dropdown"] : ["pr_section"],
        checklist: source === "issue_form" ? ["checkboxes"] : ["pr_section"],
    };
    if (elementType !== undefined && !expectedElements[fieldType].includes(elementType)) {
        addViolation(violations, "IR_INCONSISTENT_FIELD", `${path}.elementType`, `Native element type "${elementType}" cannot represent a ${fieldType} field.`);
    }
    if (defaultValue !== undefined && typeof defaultValue !== "string" && !Array.isArray(defaultValue)) {
        addViolation(violations, "IR_INVALID_NATIVE_METADATA", `${path}.defaultValue`, "Native default must be a string or string array.");
    }
    if (Array.isArray(defaultValue) && defaultValue.some((entry) => typeof entry !== "string")) {
        addViolation(violations, "IR_INVALID_NATIVE_METADATA", `${path}.defaultValue`, "Native default arrays must contain strings.");
    }
    return elementType === undefined
        ? undefined
        : {
            elementType: elementType,
            ...(sourceId === undefined ? {} : { sourceId }),
            ...(placeholder === undefined ? {} : { placeholder }),
            ...(defaultValue === undefined ? {} : { defaultValue: defaultValue }),
            ...(render === undefined ? {} : { render }),
            ...(multiple === undefined ? {} : { multiple }),
            ...(options === undefined ? {} : { options }),
        };
}
function validateOptionList(value, path, violations) {
    if (!Array.isArray(value) || value.length === 0) {
        addViolation(violations, "IR_INVALID_OPTIONS", path, "Options must be a non-empty array.");
        return undefined;
    }
    const options = [];
    const values = new Set();
    value.forEach((entry, index) => {
        if (!isRecord(entry)) {
            addViolation(violations, "IR_INVALID_OPTIONS", `${path}[${index}]`, "Options must be objects.");
            return;
        }
        checkUnknownKeys(entry, ["value", "label", "description"], `${path}[${index}]`, violations);
        const optionValue = requiredString(entry, "value", `${path}[${index}]`, violations);
        const label = requiredString(entry, "label", `${path}[${index}]`, violations);
        const description = optionalString(entry, "description", `${path}[${index}]`, violations);
        if (optionValue !== undefined) {
            if (values.has(optionValue)) {
                addViolation(violations, "IR_DUPLICATE_ID", `${path}[${index}].value`, `Duplicate option value "${optionValue}".`);
            }
            values.add(optionValue);
        }
        if (optionValue !== undefined && label !== undefined) {
            options.push({
                value: optionValue,
                label,
                ...(description === undefined ? {} : { description }),
            });
        }
    });
    return options;
}
function validateMultiSelectOptionLabels(options, path, violations) {
    options?.forEach((option, index) => {
        if (option.label.includes(MULTI_SELECT_OPTION_SEPARATOR)) {
            addViolation(violations, "IR_INVALID_OPTIONS", `${path}[${index}].label`, "Multi-select option labels must not contain commas because native artifact parsing uses commas as separators.");
        }
    });
}
function validateChecklistItems(value, path, violations) {
    if (!Array.isArray(value) || value.length === 0) {
        addViolation(violations, "IR_INVALID_OPTIONS", path, "Checklist items must be a non-empty array.");
        return undefined;
    }
    const items = [];
    const ids = new Set();
    value.forEach((entry, index) => {
        const itemPath = `${path}[${index}]`;
        if (!isRecord(entry)) {
            addViolation(violations, "IR_INVALID_OPTIONS", itemPath, "Checklist items must be objects.");
            return;
        }
        checkUnknownKeys(entry, ["id", "label", "required", "description"], itemPath, violations);
        const id = requiredString(entry, "id", itemPath, violations);
        const label = requiredString(entry, "label", itemPath, violations);
        const required = hasOwn(entry, "required") ? entry.required : undefined;
        const description = optionalString(entry, "description", itemPath, violations);
        if (id !== undefined) {
            validateIdentifier(id, `${itemPath}.id`, violations);
            if (ids.has(id))
                addViolation(violations, "IR_DUPLICATE_ID", `${itemPath}.id`, `Duplicate checklist item "${id}".`);
            ids.add(id);
        }
        if (typeof required !== "boolean") {
            addViolation(violations, "IR_INVALID_VALUE", `${itemPath}.required`, "Checklist item required must be a boolean.");
        }
        if (id !== undefined && label !== undefined && typeof required === "boolean") {
            items.push({ id, label, required, ...(description === undefined ? {} : { description }) });
        }
    });
    return items;
}
function validateConstraints(value, path, fieldType, violations) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_CONSTRAINT", path, "Constraints must be an object.");
        return undefined;
    }
    checkUnknownKeys(value, ["minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems"], path, violations);
    const minLength = optionalNonNegativeInteger(value, "minLength", path, violations);
    const maxLength = optionalNonNegativeInteger(value, "maxLength", path, violations);
    const pattern = optionalString(value, "pattern", path, violations);
    const minItems = optionalNonNegativeInteger(value, "minItems", path, violations);
    const maxItems = optionalNonNegativeInteger(value, "maxItems", path, violations);
    const uniqueItems = optionalBoolean(value, "uniqueItems", path, violations);
    if (pattern !== undefined) {
        try {
            new RegExp(pattern, "u");
        }
        catch {
            addViolation(violations, "IR_INVALID_CONSTRAINT", `${path}.pattern`, "Pattern must be a valid regular expression.");
        }
    }
    const isStringLike = fieldType === "string" || fieldType === "enum";
    const isArrayLike = fieldType === "array" || fieldType === "checklist";
    if (!isStringLike && (minLength !== undefined || maxLength !== undefined || pattern !== undefined)) {
        addViolation(violations, "IR_INVALID_CONSTRAINT", path, "String constraints are not supported for array-like fields.");
    }
    if (!isArrayLike && (minItems !== undefined || maxItems !== undefined || uniqueItems !== undefined)) {
        addViolation(violations, "IR_INVALID_CONSTRAINT", path, "Array constraints are not supported for string-like fields.");
    }
    if (fieldType === "checklist" && uniqueItems === false) {
        addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", `${path}.uniqueItems`, "Checklist values must be unique.");
    }
    if (fieldType === "array" && uniqueItems === false) {
        addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", `${path}.uniqueItems`, "Array selection values must be unique.");
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", path, "minLength cannot be greater than maxLength.");
    }
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
        addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", path, "minItems cannot be greater than maxItems.");
    }
    return {
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(pattern === undefined ? {} : { pattern }),
        ...(minItems === undefined ? {} : { minItems }),
        ...(maxItems === undefined ? {} : { maxItems }),
        ...(uniqueItems === undefined ? {} : { uniqueItems }),
    };
}
function optionalNonNegativeInteger(record, key, path, violations) {
    if (!hasOwn(record, key))
        return undefined;
    const value = record[key];
    if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
        addViolation(violations, "IR_INVALID_CONSTRAINT", `${path}.${key}`, `${key} must be a non-negative safe integer.`);
        return undefined;
    }
    return value;
}
function validateDefaultString(value, path, constraints, violations) {
    if (typeof value !== "string") {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "String defaults must be strings.");
        return;
    }
    if (constraints?.minLength !== undefined && Array.from(value).length < constraints.minLength) {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "Default does not satisfy minLength.");
    }
    if (constraints?.maxLength !== undefined && Array.from(value).length > constraints.maxLength) {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "Default does not satisfy maxLength.");
    }
    if (constraints?.pattern !== undefined) {
        try {
            if (!new RegExp(constraints.pattern, "u").test(value)) {
                addViolation(violations, "IR_INVALID_DEFAULT", path, "Default does not satisfy pattern.");
            }
        }
        catch {
            // The invalid pattern is reported by validateConstraints; do not make
            // validation itself throw while reporting the complete violation set.
        }
    }
}
function validateDefaultArray(value, path, allowedValues, requiredValues, constraints, violations) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "Array defaults must be arrays of strings.");
        return;
    }
    const values = value;
    if (new Set(values).size !== values.length) {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "Array defaults must not contain duplicates.");
    }
    if (allowedValues !== undefined && values.some((entry) => !allowedValues.includes(entry))) {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "Array defaults must use declared option values.");
    }
    if (requiredValues.some((entry) => !values.includes(entry))) {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "Checklist defaults must include every required item.");
    }
    if (constraints?.minItems !== undefined && values.length < constraints.minItems) {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "Default does not satisfy minItems.");
    }
    if (constraints?.maxItems !== undefined && values.length > constraints.maxItems) {
        addViolation(violations, "IR_INVALID_DEFAULT", path, "Default does not satisfy maxItems.");
    }
}
function sameStringArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function compareNativeOptions(semanticValues, nativeOptions, path, violations) {
    if (nativeOptions === undefined)
        return;
    const nativeValues = nativeOptions.map((option) => option.value);
    if (!sameStringArray(semanticValues, nativeValues)) {
        addViolation(violations, "IR_INCONSISTENT_FIELD", path, "Native option values must match semantic option values in source order.");
    }
}
function compareChecklistRequirements(items, nativeOptions, path, violations) {
    if (nativeOptions === undefined)
        return;
    items.forEach((item, index) => {
        const nativeRequired = nativeOptions[index]?.required;
        if (nativeRequired !== undefined && nativeRequired !== item.required) {
            addViolation(violations, "IR_INCONSISTENT_FIELD", `${path}[${index}].required`, "Native and semantic checklist required flags must match.");
        }
    });
}
function compareDefaults(fieldDefault, nativeDefault, path, violations) {
    if (nativeDefault === undefined || fieldDefault === undefined)
        return;
    if (typeof fieldDefault === "string" && typeof nativeDefault === "string" && fieldDefault === nativeDefault)
        return;
    if (Array.isArray(fieldDefault) && Array.isArray(nativeDefault) && sameStringArray(fieldDefault, nativeDefault))
        return;
    addViolation(violations, "IR_INCONSISTENT_FIELD", path, "Native and semantic default values must match.");
}
function validateField(value, path, index, source, fieldIds, violations) {
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_FIELD", path, "Fields must be objects.");
        return undefined;
    }
    const typeValue = requiredString(value, "type", path, violations);
    if (typeValue === undefined || !fieldTypes.includes(typeValue)) {
        if (typeValue !== undefined) {
            addViolation(violations, "IR_UNSUPPORTED_FIELD_TYPE", `${path}.type`, `Field type "${typeValue}" is not supported.`);
        }
        return undefined;
    }
    const fieldType = typeValue;
    const allowedKeys = [
        "id",
        "label",
        "description",
        "type",
        "required",
        "defaultValue",
        "render",
        "nativeMetadata",
        "constraints",
    ];
    if (fieldType === "enum")
        allowedKeys.push("options");
    if (fieldType === "array")
        allowedKeys.push("selection", "items");
    if (fieldType === "checklist")
        allowedKeys.push("items");
    checkUnknownKeys(value, allowedKeys, path, violations);
    const id = requiredString(value, "id", path, violations);
    const label = requiredString(value, "label", path, violations);
    const description = optionalString(value, "description", path, violations);
    const required = requiredString(value, "required", path, violations);
    const render = value.render;
    validateRenderMetadata(render, `${path}.render`, index, violations, false);
    const nativeMetadata = validateNativeFieldMetadata(value.nativeMetadata, `${path}.nativeMetadata`, source, fieldType, violations);
    const constraints = validateConstraints(value.constraints, `${path}.constraints`, fieldType, violations);
    if (id !== undefined) {
        validateIdentifier(id, `${path}.id`, violations);
        if (fieldIds.has(id))
            addViolation(violations, "IR_DUPLICATE_ID", `${path}.id`, `Duplicate field id "${id}".`);
        fieldIds.add(id);
    }
    if (required === undefined || !requiredStates.includes(required)) {
        if (required !== undefined)
            addViolation(violations, "IR_INVALID_VALUE", `${path}.required`, `Required state "${required}" is not supported.`);
    }
    const requiredState = required;
    const defaultValue = validateOptionalDefault(value, path, violations);
    let allowedValues;
    let requiredValues = [];
    if (fieldType === "string") {
        if (defaultValue !== undefined)
            validateDefaultString(defaultValue, `${path}.defaultValue`, constraints, violations);
    }
    else if (fieldType === "enum") {
        const options = validateOptionList(value.options, `${path}.options`, violations);
        allowedValues = options?.map((option) => option.value);
        if (defaultValue !== undefined) {
            if (typeof defaultValue !== "string" || allowedValues === undefined || !allowedValues.includes(defaultValue)) {
                addViolation(violations, "IR_INVALID_DEFAULT", `${path}.defaultValue`, "Enum defaults must match a declared option value.");
            }
            if (typeof defaultValue === "string")
                validateDefaultString(defaultValue, `${path}.defaultValue`, constraints, violations);
        }
        compareNativeOptions(allowedValues ?? [], nativeMetadata?.options, `${path}.nativeMetadata.options`, violations);
        if (nativeMetadata?.multiple === true) {
            addViolation(violations, "IR_INCONSISTENT_FIELD", `${path}.nativeMetadata.multiple`, "Single-select enum fields cannot be native multi-selects.");
        }
    }
    else if (fieldType === "array") {
        const selection = requiredString(value, "selection", path, violations);
        if (selection === undefined || !arraySelections.includes(selection)) {
            if (selection !== undefined)
                addViolation(violations, "IR_INVALID_VALUE", `${path}.selection`, `Array selection "${selection}" is not supported.`);
        }
        const items = requiredRecord(value, "items", path, violations);
        if (items !== undefined) {
            checkUnknownKeys(items, ["type", "options"], `${path}.items`, violations);
            const itemType = requiredString(items, "type", `${path}.items`, violations);
            if (itemType !== undefined && itemType !== "string") {
                addViolation(violations, "IR_UNSUPPORTED_FIELD_TYPE", `${path}.items.type`, "Only string array items are supported.");
            }
            if (hasOwn(items, "options")) {
                const options = validateOptionList(items.options, `${path}.items.options`, violations);
                allowedValues = options?.map((option) => option.value);
                if (selection === "multi_select")
                    validateMultiSelectOptionLabels(options, `${path}.items.options`, violations);
            }
        }
        if (selection === "multi_select" &&
            source === "issue_form" &&
            (allowedValues === undefined || allowedValues.length === 0)) {
            addViolation(violations, "IR_INVALID_OPTIONS", `${path}.items.options`, "Issue Form multi-select fields require options.");
        }
        if (defaultValue !== undefined)
            validateDefaultArray(defaultValue, `${path}.defaultValue`, allowedValues, [], constraints, violations);
        compareNativeOptions(allowedValues ?? [], nativeMetadata?.options, `${path}.nativeMetadata.options`, violations);
        if (source === "issue_form" && selection === "multi_select" && nativeMetadata?.multiple !== true) {
            addViolation(violations, "IR_INCONSISTENT_FIELD", `${path}.nativeMetadata.multiple`, "Multi-select fields must preserve native multiple=true.");
        }
        if (source === "issue_form" && selection === "list" && nativeMetadata?.multiple === true) {
            addViolation(violations, "IR_INCONSISTENT_FIELD", `${path}.nativeMetadata.multiple`, "List fields cannot preserve native multiple=true.");
        }
    }
    else {
        const items = validateChecklistItems(value.items, `${path}.items`, violations);
        requiredValues = items?.filter((item) => item.required).map((item) => item.id) ?? [];
        allowedValues = items?.map((item) => item.id);
        if (requiredValues.length > 0 && requiredState !== "required") {
            addViolation(violations, "IR_CHECKLIST_REQUIRED_MISMATCH", `${path}.required`, "A checklist with required items must have required field semantics.");
        }
        if (defaultValue !== undefined) {
            validateDefaultArray(defaultValue, `${path}.defaultValue`, allowedValues, requiredValues, constraints, violations);
        }
        compareNativeOptions(allowedValues ?? [], nativeMetadata?.options, `${path}.nativeMetadata.options`, violations);
        compareChecklistRequirements(items ?? [], nativeMetadata?.options, `${path}.nativeMetadata.options`, violations);
    }
    if (nativeMetadata !== undefined)
        compareDefaults(defaultValue, nativeMetadata.defaultValue, `${path}.nativeMetadata.defaultValue`, violations);
    return id === undefined || required === undefined || !requiredStates.includes(required)
        ? undefined
        : {
            type: fieldType,
            required: requiredState,
            ...(constraints === undefined ? {} : { constraints }),
            ...(fieldType === "checklist" && allowedValues !== undefined
                ? { checklistItemCount: allowedValues.length }
                : {}),
        };
}
function validateSection(value, path, index, source, fieldIds, sectionIds, summaries, violations) {
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_SECTION", path, "Sections must be objects.");
        return;
    }
    checkUnknownKeys(value, ["id", "title", "description", "kind", "content", "render", "nativeMetadata", "fields"], path, violations);
    const id = requiredString(value, "id", path, violations);
    const title = optionalString(value, "title", path, violations);
    optionalString(value, "description", path, violations);
    const kind = requiredString(value, "kind", path, violations);
    if (kind !== undefined && !sectionKinds.includes(kind)) {
        addViolation(violations, "IR_INVALID_SECTION", `${path}.kind`, `Section kind "${kind}" is not supported.`);
    }
    const sectionKind = kind;
    validateRenderMetadata(value.render, `${path}.render`, index, violations, true);
    validateNativeSectionMetadata(value.nativeMetadata, `${path}.nativeMetadata`, source, sectionKind, violations);
    const fields = requiredArray(value, "fields", path, violations);
    if (id !== undefined) {
        validateIdentifier(id, `${path}.id`, violations);
        if (sectionIds.has(id))
            addViolation(violations, "IR_DUPLICATE_ID", `${path}.id`, `Duplicate section id "${id}".`);
        sectionIds.add(id);
    }
    const content = hasOwn(value, "content") ? value.content : undefined;
    if (content !== undefined && typeof content !== "string") {
        addViolation(violations, "IR_INVALID_SECTION", `${path}.content`, "Section content must be a string when present.");
    }
    if (fields !== undefined && sectionKind === "documentation" && fields.length > 0) {
        addViolation(violations, "IR_INVALID_SECTION", `${path}.fields`, "Documentation sections cannot contain semantic fields.");
    }
    if (sectionKind === "documentation" && (typeof content !== "string" || content.length === 0)) {
        addViolation(violations, "IR_INVALID_SECTION", `${path}.content`, "Documentation sections must preserve non-empty content.");
    }
    if (fields !== undefined && sectionKind === "input" && fields.length === 0) {
        addViolation(violations, "IR_INVALID_SECTION", `${path}.fields`, "Input sections must contain at least one field.");
    }
    if (fields !== undefined) {
        fields.forEach((field, fieldIndex) => {
            const summary = validateField(field, `${path}.fields[${fieldIndex}]`, fieldIndex, source, fieldIds, violations);
            if (summary !== undefined && isRecord(field)) {
                const fieldId = typeof field.id === "string" ? field.id : undefined;
                if (fieldId !== undefined)
                    summaries.set(fieldId, summary);
            }
        });
    }
    if (title === undefined && sectionKind === "input" && source === "pull_request_template") {
        addViolation(violations, "IR_INVALID_SECTION", `${path}.title`, "PR input sections must preserve their heading title.");
    }
}
function validateSupplementalConstraints(value, path, summaries, violations) {
    if (value === undefined) {
        addViolation(violations, "IR_MISSING_PROPERTY", path, 'Property "supplementalConstraints" is required.');
        return;
    }
    if (!isRecord(value)) {
        addViolation(violations, "IR_INVALID_VALUE", path, 'Property "supplementalConstraints" must be an object.');
        return;
    }
    const record = value;
    checkUnknownKeys(record, ["fields"], path, violations);
    const fields = requiredArray(record, "fields", path, violations);
    if (fields === undefined)
        return;
    const references = new Set();
    fields.forEach((entry, index) => {
        const entryPath = `${path}.fields[${index}]`;
        if (!isRecord(entry)) {
            addViolation(violations, "IR_INVALID_CONSTRAINT", entryPath, "Supplemental field constraints must be objects.");
            return;
        }
        checkUnknownKeys(entry, [
            "fieldId",
            "required",
            "minLength",
            "maxLength",
            "pattern",
            "minItems",
            "maxItems",
            "linkedIssue",
            "checklistMinCompleted",
            "checklistRequireComplete",
        ], entryPath, violations);
        const fieldId = requiredString(entry, "fieldId", entryPath, violations);
        if (fieldId === undefined)
            return;
        if (references.has(fieldId)) {
            addViolation(violations, "IR_DUPLICATE_ID", `${entryPath}.fieldId`, `Duplicate supplemental constraint for "${fieldId}".`);
        }
        references.add(fieldId);
        const summary = summaries.get(fieldId);
        if (summary === undefined) {
            addViolation(violations, "IR_UNKNOWN_FIELD_REFERENCE", `${entryPath}.fieldId`, `Field "${fieldId}" does not exist.`);
            return;
        }
        const required = optionalBoolean(entry, "required", entryPath, violations);
        const minLength = optionalNonNegativeInteger(entry, "minLength", entryPath, violations);
        const maxLength = optionalNonNegativeInteger(entry, "maxLength", entryPath, violations);
        const pattern = optionalString(entry, "pattern", entryPath, violations);
        const minItems = optionalNonNegativeInteger(entry, "minItems", entryPath, violations);
        const maxItems = optionalNonNegativeInteger(entry, "maxItems", entryPath, violations);
        const linkedIssue = optionalBoolean(entry, "linkedIssue", entryPath, violations);
        const checklistMinCompleted = optionalNonNegativeInteger(entry, "checklistMinCompleted", entryPath, violations);
        const checklistRequireComplete = optionalBoolean(entry, "checklistRequireComplete", entryPath, violations);
        if (pattern !== undefined) {
            try {
                new RegExp(pattern, "u");
            }
            catch {
                addViolation(violations, "IR_INVALID_CONSTRAINT", `${entryPath}.pattern`, "Pattern must be a valid regular expression.");
            }
        }
        const isStringLike = summary.type === "string" || summary.type === "enum";
        const isArrayLike = summary.type === "array" || summary.type === "checklist";
        if (!isStringLike && (minLength !== undefined || maxLength !== undefined || pattern !== undefined)) {
            addViolation(violations, "IR_INVALID_CONSTRAINT", entryPath, "String constraints are not supported for array-like fields.");
        }
        if (!isArrayLike && (minItems !== undefined || maxItems !== undefined)) {
            addViolation(violations, "IR_INVALID_CONSTRAINT", entryPath, "Array constraints are not supported for string-like fields.");
        }
        if (linkedIssue !== undefined && !isStringLike) {
            addViolation(violations, "IR_INVALID_CONSTRAINT", `${entryPath}.linkedIssue`, "linkedIssue is supported only for string-like fields.");
        }
        if ((checklistMinCompleted !== undefined || checklistRequireComplete !== undefined) &&
            summary.type !== "checklist") {
            addViolation(violations, "IR_INVALID_CONSTRAINT", entryPath, "Checklist completion constraints are supported only for checklist fields.");
        }
        if (checklistMinCompleted !== undefined && maxItems !== undefined && checklistMinCompleted > maxItems) {
            addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", entryPath, "checklistMinCompleted cannot be greater than maxItems.");
        }
        if (checklistMinCompleted !== undefined &&
            summary.checklistItemCount !== undefined &&
            checklistMinCompleted > summary.checklistItemCount) {
            addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", `${entryPath}.checklistMinCompleted`, "checklistMinCompleted cannot exceed the checklist item count.");
        }
        if (checklistRequireComplete === true &&
            summary.checklistItemCount !== undefined &&
            maxItems !== undefined &&
            maxItems < summary.checklistItemCount) {
            addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", `${entryPath}.checklistRequireComplete`, "checklistRequireComplete requires maxItems to allow all checklist items.");
        }
        if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
            addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", entryPath, "minLength cannot be greater than maxLength.");
        }
        if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
            addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", entryPath, "minItems cannot be greater than maxItems.");
        }
        if (required === false && summary.required === "required") {
            addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", `${entryPath}.required`, "Supplemental required=false contradicts required field semantics.");
        }
        const nativeConstraints = summary.constraints;
        if (nativeConstraints !== undefined) {
            const conflictingKeys = [
                "minLength",
                "maxLength",
                "pattern",
                "minItems",
                "maxItems",
            ];
            for (const key of conflictingKeys) {
                const supplementalValue = entry[key];
                const nativeValue = nativeConstraints[key];
                if (supplementalValue !== undefined && nativeValue !== undefined && supplementalValue !== nativeValue) {
                    addViolation(violations, "IR_INCONSISTENT_CONSTRAINT", `${entryPath}.${key}`, `Supplemental ${key} contradicts the field constraint.`);
                }
            }
        }
    });
}
export function validateCanonicalContract(input) {
    const violations = [];
    if (!isRecord(input)) {
        return {
            valid: false,
            violations: [{ code: "IR_NOT_OBJECT", path: "$", message: "Canonical IR must be a JSON object." }],
        };
    }
    checkUnknownKeys(input, [
        "irVersion",
        "schemaVersion",
        "artifactKind",
        "templateIdentity",
        "nativeMetadata",
        "sections",
        "supplementalConstraints",
        "provenance",
    ], "$", violations);
    const irVersion = requiredString(input, "irVersion", "$", violations);
    const schemaVersion = requiredString(input, "schemaVersion", "$", violations);
    if (irVersion !== undefined && irVersion !== CANONICAL_IR_VERSION) {
        addViolation(violations, "IR_UNSUPPORTED_VERSION", "$.irVersion", `Only IR version ${CANONICAL_IR_VERSION} is supported.`);
    }
    if (schemaVersion !== undefined && schemaVersion !== CONTRACT_SCHEMA_VERSION) {
        addViolation(violations, "IR_UNSUPPORTED_VERSION", "$.schemaVersion", `Only schema version ${CONTRACT_SCHEMA_VERSION} is supported.`);
    }
    const artifactKind = requiredString(input, "artifactKind", "$", violations);
    if (artifactKind !== undefined && artifactKind !== "issue" && artifactKind !== "pull_request") {
        addViolation(violations, "IR_UNSUPPORTED_ARTIFACT_KIND", "$.artifactKind", `Artifact kind "${artifactKind}" is not supported.`);
    }
    const template = requiredRecord(input, "templateIdentity", "$", violations);
    let templateSource;
    let templatePath;
    if (template !== undefined) {
        checkUnknownKeys(template, ["id", "name", "path", "source"], "$.templateIdentity", violations);
        const id = requiredString(template, "id", "$.templateIdentity", violations);
        const name = requiredString(template, "name", "$.templateIdentity", violations);
        templatePath = requiredString(template, "path", "$.templateIdentity", violations);
        const source = requiredString(template, "source", "$.templateIdentity", violations);
        validateIdentifier(id, "$.templateIdentity.id", violations);
        if (name !== undefined && name.trim().length === 0) {
            addViolation(violations, "IR_INVALID_VALUE", "$.templateIdentity.name", "Template name cannot be empty.");
        }
        if (templatePath !== undefined &&
            (templatePath.startsWith("/") || templatePath.includes("\\") || templatePath.split("/").includes(".."))) {
            addViolation(violations, "IR_INVALID_VALUE", "$.templateIdentity.path", "Template path must be a safe repository-relative path.");
        }
        if (source !== undefined && !templateSources.includes(source)) {
            addViolation(violations, "IR_UNSUPPORTED_SOURCE_FORMAT", "$.templateIdentity.source", `Template source "${source}" is not supported.`);
        }
        else {
            templateSource = source;
        }
    }
    const native = requiredRecord(input, "nativeMetadata", "$", violations);
    if (native !== undefined) {
        checkUnknownKeys(native, ["source", "path", "title", "description", "labels"], "$.nativeMetadata", violations);
        const source = requiredString(native, "source", "$.nativeMetadata", violations);
        const path = requiredString(native, "path", "$.nativeMetadata", violations);
        optionalString(native, "title", "$.nativeMetadata", violations);
        optionalString(native, "description", "$.nativeMetadata", violations);
        const labels = optionalStringArray(native, "labels", "$.nativeMetadata", violations);
        if (source !== undefined && !templateSources.includes(source)) {
            addViolation(violations, "IR_UNSUPPORTED_SOURCE_FORMAT", "$.nativeMetadata.source", `Template source "${source}" is not supported.`);
        }
        if (source !== undefined && templateSource !== undefined && source !== templateSource) {
            addViolation(violations, "IR_INCONSISTENT_SOURCE", "$.nativeMetadata.source", "Native source must match templateIdentity.source.");
        }
        if (path !== undefined && templatePath !== undefined && path !== templatePath) {
            addViolation(violations, "IR_INCONSISTENT_SOURCE", "$.nativeMetadata.path", "Native path must match templateIdentity.path.");
        }
        if (labels !== undefined && new Set(labels).size !== labels.length) {
            addViolation(violations, "IR_DUPLICATE_ID", "$.nativeMetadata.labels", "Native labels must not contain duplicates.");
        }
    }
    if (artifactKind === "issue" && templateSource !== undefined && templateSource !== "issue_form") {
        addViolation(violations, "IR_INCONSISTENT_SOURCE", "$.templateIdentity.source", "Issue contracts must use Issue Form sources.");
    }
    if (artifactKind === "pull_request" && templateSource !== undefined && templateSource !== "pull_request_template") {
        addViolation(violations, "IR_INCONSISTENT_SOURCE", "$.templateIdentity.source", "Pull request contracts must use pull request template sources.");
    }
    if (hasOwn(input, "provenance")) {
        validateProvenance(input.provenance, "$.provenance", artifactKind, templatePath, violations);
    }
    const sections = requiredArray(input, "sections", "$", violations);
    const fieldIds = new Set();
    const sectionIds = new Set();
    const summaries = new Map();
    if (sections !== undefined) {
        if (sections.length === 0)
            addViolation(violations, "IR_INVALID_SECTION", "$.sections", "A contract must contain at least one section.");
        if (templateSource === undefined) {
            addViolation(violations, "IR_INVALID_SECTION", "$.sections", "Sections cannot be validated without a supported template source.");
        }
        else {
            sections.forEach((section, index) => {
                validateSection(section, `$.sections[${index}]`, index, templateSource, fieldIds, sectionIds, summaries, violations);
            });
        }
    }
    validateSupplementalConstraints(input.supplementalConstraints, "$.supplementalConstraints", summaries, violations);
    return { valid: violations.length === 0, violations };
}
export function isCanonicalContract(input) {
    return validateCanonicalContract(input).valid;
}
export function assertCanonicalContract(input) {
    const result = validateCanonicalContract(input);
    if (!result.valid)
        throw new CanonicalIrValidationError(result.violations);
}
function canonicalizeNativeOptions(options) {
    return options?.map((option) => ({
        value: option.value,
        ...(option.label === undefined ? {} : { label: option.label }),
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(option.required === undefined ? {} : { required: option.required }),
    }));
}
function canonicalizeNativeFieldMetadata(metadata) {
    return {
        elementType: metadata.elementType,
        ...(metadata.sourceId === undefined ? {} : { sourceId: metadata.sourceId }),
        ...(metadata.placeholder === undefined ? {} : { placeholder: metadata.placeholder }),
        ...(metadata.defaultValue === undefined
            ? {}
            : { defaultValue: Array.isArray(metadata.defaultValue) ? [...metadata.defaultValue] : metadata.defaultValue }),
        ...(metadata.render === undefined ? {} : { render: metadata.render }),
        ...(metadata.multiple === undefined ? {} : { multiple: metadata.multiple }),
        ...(metadata.options === undefined ? {} : { options: canonicalizeNativeOptions(metadata.options) }),
    };
}
function canonicalizeFieldConstraints(constraints) {
    return {
        ...(constraints.minLength === undefined ? {} : { minLength: constraints.minLength }),
        ...(constraints.maxLength === undefined ? {} : { maxLength: constraints.maxLength }),
        ...(constraints.pattern === undefined ? {} : { pattern: constraints.pattern }),
        ...(constraints.minItems === undefined ? {} : { minItems: constraints.minItems }),
        ...(constraints.maxItems === undefined ? {} : { maxItems: constraints.maxItems }),
        ...(constraints.uniqueItems === undefined ? {} : { uniqueItems: constraints.uniqueItems }),
    };
}
function canonicalizeField(field) {
    const base = {
        id: field.id,
        label: field.label,
        ...(field.description === undefined ? {} : { description: field.description }),
        type: field.type,
        required: field.required,
        render: { order: field.render.order },
        nativeMetadata: canonicalizeNativeFieldMetadata(field.nativeMetadata),
        ...(field.constraints === undefined ? {} : { constraints: canonicalizeFieldConstraints(field.constraints) }),
    };
    if (field.type === "string") {
        if (field.defaultValue !== undefined)
            base.defaultValue = field.defaultValue;
    }
    else if (field.type === "enum") {
        base.options = field.options.map((option) => ({
            value: option.value,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
        }));
        if (field.defaultValue !== undefined)
            base.defaultValue = field.defaultValue;
    }
    else if (field.type === "array") {
        base.selection = field.selection;
        base.items = {
            type: field.items.type,
            ...(field.items.options === undefined
                ? {}
                : {
                    options: field.items.options.map((option) => ({
                        value: option.value,
                        label: option.label,
                        ...(option.description === undefined ? {} : { description: option.description }),
                    })),
                }),
        };
        if (field.defaultValue !== undefined)
            base.defaultValue = [...field.defaultValue];
    }
    else {
        base.items = field.items.map((item) => ({
            id: item.id,
            label: item.label,
            required: item.required,
            ...(item.description === undefined ? {} : { description: item.description }),
        }));
        if (field.defaultValue !== undefined)
            base.defaultValue = [...field.defaultValue];
    }
    return base;
}
function canonicalizeSection(section) {
    return {
        id: section.id,
        ...(section.title === undefined ? {} : { title: section.title }),
        ...(section.description === undefined ? {} : { description: section.description }),
        kind: section.kind,
        ...(section.content === undefined ? {} : { content: section.content }),
        render: {
            order: section.render.order,
            ...(section.render.headingLevel === undefined ? {} : { headingLevel: section.render.headingLevel }),
        },
        nativeMetadata: {
            elementType: section.nativeMetadata.elementType,
            ...(section.nativeMetadata.sourceId === undefined ? {} : { sourceId: section.nativeMetadata.sourceId }),
            ...(section.nativeMetadata.headingLevel === undefined
                ? {}
                : { headingLevel: section.nativeMetadata.headingLevel }),
            ...(section.nativeMetadata.markdown === undefined ? {} : { markdown: section.nativeMetadata.markdown }),
        },
        fields: section.fields.map(canonicalizeField),
    };
}
function canonicalizeProvenance(provenance) {
    const source = (value) => ({
        path: value.path,
        ref: value.ref,
        sha: value.sha,
        digest: value.digest,
    });
    return {
        authority: provenance.authority,
        repository: {
            host: provenance.repository.host,
            owner: provenance.repository.owner,
            name: provenance.repository.name,
            nameWithOwner: provenance.repository.nameWithOwner,
            ...(provenance.repository.repositoryId === undefined ? {} : { repositoryId: provenance.repository.repositoryId }),
        },
        ref: provenance.ref,
        treeSha: provenance.treeSha,
        template: source(provenance.template),
        ...(provenance.policy === undefined ? {} : { policy: source(provenance.policy) }),
    };
}
function canonicalizeContract(contract) {
    return {
        irVersion: contract.irVersion,
        schemaVersion: contract.schemaVersion,
        artifactKind: contract.artifactKind,
        templateIdentity: {
            id: contract.templateIdentity.id,
            name: contract.templateIdentity.name,
            path: contract.templateIdentity.path,
            source: contract.templateIdentity.source,
        },
        nativeMetadata: {
            source: contract.nativeMetadata.source,
            path: contract.nativeMetadata.path,
            ...(contract.nativeMetadata.title === undefined ? {} : { title: contract.nativeMetadata.title }),
            ...(contract.nativeMetadata.description === undefined
                ? {}
                : { description: contract.nativeMetadata.description }),
            ...(contract.nativeMetadata.labels === undefined ? {} : { labels: [...contract.nativeMetadata.labels] }),
        },
        sections: contract.sections.map(canonicalizeSection),
        supplementalConstraints: {
            fields: contract.supplementalConstraints.fields.map((constraint) => ({
                fieldId: constraint.fieldId,
                ...(constraint.required === undefined ? {} : { required: constraint.required }),
                ...(constraint.minLength === undefined ? {} : { minLength: constraint.minLength }),
                ...(constraint.maxLength === undefined ? {} : { maxLength: constraint.maxLength }),
                ...(constraint.pattern === undefined ? {} : { pattern: constraint.pattern }),
                ...(constraint.minItems === undefined ? {} : { minItems: constraint.minItems }),
                ...(constraint.maxItems === undefined ? {} : { maxItems: constraint.maxItems }),
                ...(constraint.linkedIssue === undefined ? {} : { linkedIssue: constraint.linkedIssue }),
                ...(constraint.checklistMinCompleted === undefined
                    ? {}
                    : { checklistMinCompleted: constraint.checklistMinCompleted }),
                ...(constraint.checklistRequireComplete === undefined
                    ? {}
                    : { checklistRequireComplete: constraint.checklistRequireComplete }),
            })),
        },
        ...(contract.provenance === undefined ? {} : { provenance: canonicalizeProvenance(contract.provenance) }),
    };
}
export function serializeCanonicalContract(input) {
    assertCanonicalContract(input);
    const serialized = JSON.stringify(canonicalizeContract(input));
    if (serialized === undefined)
        throw new Error("Canonical IR could not be serialized.");
    return serialized;
}
export function deserializeCanonicalContract(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Invalid JSON.";
        throw new CanonicalIrValidationError([{ code: "IR_INVALID_JSON", path: "$", message }]);
    }
    assertCanonicalContract(parsed);
    return parsed;
}
//# sourceMappingURL=ir.js.map