import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { assertCanonicalContract, CANONICAL_IR_VERSION, CONTRACT_SCHEMA_VERSION, MULTI_SELECT_OPTION_SEPARATOR, } from "./ir.js";
import { selectIssueTemplate, } from "../template-discovery.js";
// GitHub's native Issue Form schema permits any non-empty identifier made of
// alphanumeric characters, hyphens, and underscores; it does not require a
// letter as the first character.
const identifierPattern = /^[A-Za-z0-9_-]+$/u;
const GITHUB_NO_RESPONSE_LABEL = "_No response_";
export class IssueFormCompilerError extends Error {
    code;
    path;
    context;
    violations;
    constructor(violations, options) {
        const first = violations[0];
        if (first === undefined)
            throw new Error("Issue Form compiler errors require at least one violation.");
        super(violations
            .map((violation) => `${violation.context.templatePath}${violation.path}: ${violation.message}`)
            .join("\n"), options);
        this.name = "IssueFormCompilerError";
        this.code = first.code;
        this.path = first.path;
        this.context = first.context;
        this.violations = violations;
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            path: this.path,
            context: this.context,
            violations: this.violations,
        };
    }
}
class Diagnostics {
    templateId;
    templatePath;
    violations = [];
    constructor(templateId, templatePath) {
        this.templateId = templateId;
        this.templatePath = templatePath;
    }
    add(code, yamlPath, message, position) {
        this.violations.push({
            code,
            path: yamlPath,
            message,
            context: {
                templateId: this.templateId,
                templatePath: this.templatePath,
                yamlPath,
                ...(position === undefined ? {} : { line: position.line, column: position.column }),
            },
        });
    }
    throwIfAny() {
        if (this.violations.length > 0)
            throw new IssueFormCompilerError(this.violations);
    }
}
/** Compile YAML already selected by the repository's template discovery layer. */
export function compileIssueFormYaml(source, template) {
    const diagnostics = new Diagnostics(String(template.id), String(template.path));
    validateTemplateIdentity(template, diagnostics);
    const root = parseYaml(source, diagnostics);
    if (root === undefined)
        diagnostics.throwIfAny();
    if (root === undefined || !isRecord(root)) {
        diagnostics.add("ISSUE_FORM_INVALID_ROOT", "$", "Issue Form YAML must contain a mapping at its root.");
        diagnostics.throwIfAny();
        throw new Error("Unreachable");
    }
    const metadata = parseFormMetadata(root, diagnostics);
    const fields = new Set();
    const sections = new Set();
    const compiledSections = [];
    let inputCount = 0;
    if (metadata !== undefined) {
        metadata.body.forEach((bodyEntry, index) => {
            const section = compileBodyEntry(bodyEntry, index, fields, sections, diagnostics);
            if (section !== undefined) {
                compiledSections.push(section);
                if (section.kind === "input")
                    inputCount += 1;
            }
        });
        if (inputCount === 0) {
            diagnostics.add("ISSUE_FORM_INVALID_VALUE", "$.body", "Issue Form body must contain at least one input field.");
        }
    }
    const formName = metadata?.name ?? template.name;
    const canonicalTemplateId = canonicalTemplateIdentifier(template);
    const templateIdentity = {
        id: canonicalTemplateId,
        name: formName,
        path: template.path,
        source: "issue_form",
    };
    const nativeMetadata = {
        source: "issue_form",
        path: template.path,
        ...(metadata?.title === undefined ? {} : { title: metadata.title }),
        ...(metadata?.description === undefined ? {} : { description: metadata.description }),
        ...(metadata?.labels === undefined ? {} : { labels: metadata.labels }),
    };
    const contract = {
        irVersion: CANONICAL_IR_VERSION,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        artifactKind: "issue",
        templateIdentity,
        nativeMetadata,
        sections: compiledSections,
        supplementalConstraints: { fields: [] },
    };
    diagnostics.throwIfAny();
    try {
        assertCanonicalContract(contract);
    }
    catch (error) {
        if (error instanceof Error && "violations" in error && Array.isArray(error.violations)) {
            for (const violation of error.violations) {
                if (isRecord(violation)) {
                    const code = typeof violation.code === "string" ? violation.code : "IR_INVALID";
                    const message = typeof violation.message === "string" ? violation.message : "Canonical IR is invalid.";
                    const violationPath = typeof violation.path === "string" ? violation.path : "$";
                    diagnostics.add("ISSUE_FORM_IR_INVALID", violationPath, `${code}: ${message}`);
                }
            }
        }
        if (diagnostics.violations.length === 0) {
            diagnostics.add("ISSUE_FORM_IR_INVALID", "$", "Compiled Issue Form did not satisfy the canonical contract.");
        }
        diagnostics.throwIfAny();
    }
    return contract;
}
/** Short alias for callers compiling an in-memory Issue Form source. */
export const compileIssueForm = compileIssueFormYaml;
/** Discover, read, select, and compile one repository-native Issue Form. */
export async function compileIssueFormTemplate(discovery, selector) {
    const template = selectIssueTemplate(discovery, selector);
    const repositoryRoot = path.resolve(discovery.repositoryRoot);
    const absolutePath = path.resolve(repositoryRoot, template.path);
    const relativePath = path.relative(repositoryRoot, absolutePath);
    if (relativePath.length === 0 || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new IssueFormCompilerError([
            {
                code: "ISSUE_FORM_SOURCE_ERROR",
                path: "$",
                message: "Discovered template path must remain inside the repository root.",
                context: { templateId: template.id, templatePath: template.path, yamlPath: "$" },
            },
        ]);
    }
    let source;
    try {
        source = await readFile(absolutePath, "utf8");
    }
    catch (error) {
        throw new IssueFormCompilerError([
            {
                code: "ISSUE_FORM_SOURCE_ERROR",
                path: "$",
                message: `Cannot read discovered Issue Form source: ${absolutePath}.`,
                context: { templateId: template.id, templatePath: template.path, yamlPath: "$" },
            },
        ], { cause: error });
    }
    return compileIssueFormYaml(source, template);
}
function validateTemplateIdentity(template, diagnostics) {
    if (template.type !== undefined && template.type !== "issue-form") {
        diagnostics.add("ISSUE_FORM_UNSUPPORTED_SEMANTICS", "$", `Template type "${template.type}" is not an Issue Form.`);
    }
    if (template.kind !== undefined && template.kind !== "issue") {
        diagnostics.add("ISSUE_FORM_UNSUPPORTED_SEMANTICS", "$", `Template kind "${template.kind}" is not an issue template.`);
    }
    if (template.id.trim().length === 0)
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", "$", "Template identity id must not be empty.");
    if (template.name.trim().length === 0)
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", "$", "Template identity name must not be empty.");
    if (template.path.trim().length === 0)
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", "$", "Template path must not be empty.");
    if (path.isAbsolute(template.path) || template.path.includes("\\") || template.path.split("/").includes("..")) {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", "$", "Template path must be repository-relative.");
    }
}
function parseYaml(source, diagnostics) {
    let document;
    try {
        document = parseDocument(source, {
            merge: false,
            prettyErrors: true,
            strict: true,
            stringKeys: true,
            uniqueKeys: true,
            version: "1.2",
        });
    }
    catch (error) {
        diagnostics.add("ISSUE_FORM_INVALID_YAML", "$", error instanceof Error ? error.message : "YAML parsing failed.");
        return undefined;
    }
    for (const error of document.errors) {
        diagnostics.add(yamlErrorCode(error), "$", error.message, yamlPosition(error));
    }
    if (document.errors.length > 0)
        return undefined;
    try {
        return document.toJS({ maxAliasCount: 0 });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "YAML aliases could not be resolved.";
        diagnostics.add(message.toLocaleLowerCase("en-US").includes("alias")
            ? "ISSUE_FORM_UNSUPPORTED_SEMANTICS"
            : "ISSUE_FORM_INVALID_YAML", "$", message);
        return undefined;
    }
}
function yamlErrorCode(error) {
    return error.code === "DUPLICATE_KEY" ? "ISSUE_FORM_DUPLICATE_KEY" : "ISSUE_FORM_INVALID_YAML";
}
function yamlPosition(error) {
    const position = error.linePos?.[0];
    return position === undefined ? undefined : { line: position.line, column: position.col };
}
function parseFormMetadata(root, diagnostics) {
    checkUnknownKeys(root, ["name", "description", "title", "labels", "body", "assignees", "projects", "type"], "$", diagnostics);
    for (const key of ["assignees", "projects", "type"]) {
        if (hasOwn(root, key)) {
            diagnostics.add("ISSUE_FORM_UNSUPPORTED_SEMANTICS", `$.${key}`, `Top-level Issue Form key "${key}" is not representable by the canonical contract.`);
        }
    }
    const name = requiredNonEmptyString(root, "name", "$", diagnostics);
    const description = requiredNonEmptyString(root, "description", "$", diagnostics);
    const title = optionalString(root, "title", "$", diagnostics);
    const labels = hasOwn(root, "labels") ? parseStringList(root.labels, "$.labels", diagnostics) : undefined;
    const body = requiredArray(root, "body", "$", diagnostics);
    if (name === undefined || description === undefined || body === undefined)
        return undefined;
    return {
        name,
        description,
        ...(title === undefined ? {} : { title }),
        ...(labels === undefined ? {} : { labels }),
        body,
    };
}
function compileBodyEntry(value, index, fieldIds, sectionIds, diagnostics) {
    const pathPrefix = `$.body[${index}]`;
    if (!isRecord(value)) {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", pathPrefix, "Body entries must be objects.");
        return undefined;
    }
    checkUnknownKeys(value, ["type", "id", "attributes", "validations"], pathPrefix, diagnostics);
    const type = requiredNonEmptyString(value, "type", pathPrefix, diagnostics);
    if (type === undefined)
        return undefined;
    if (type === "markdown")
        return compileMarkdown(value, index, pathPrefix, sectionIds, diagnostics);
    if (type === "upload") {
        diagnostics.add("ISSUE_FORM_UNSUPPORTED_TYPE", `${pathPrefix}.type`, "Issue Form upload fields are browser/API-only and cannot be represented by the canonical contract.");
        return undefined;
    }
    if (type !== "input" && type !== "textarea" && type !== "dropdown" && type !== "checkboxes") {
        diagnostics.add("ISSUE_FORM_UNSUPPORTED_TYPE", `${pathPrefix}.type`, `Issue Form element type "${type}" is not supported.`);
        return undefined;
    }
    const id = requiredNonEmptyString(value, "id", pathPrefix, diagnostics);
    if (id === undefined) {
        diagnostics.add("ISSUE_FORM_AMBIGUOUS", `${pathPrefix}.id`, "Non-markdown Issue Form elements require an explicit id; deriving one from presentation text is ambiguous.");
    }
    else {
        validateIdentifier(id, `${pathPrefix}.id`, diagnostics);
        if (fieldIds.has(id))
            diagnostics.add("ISSUE_FORM_DUPLICATE_ID", `${pathPrefix}.id`, `Duplicate field id "${id}".`);
        fieldIds.add(id);
        if (sectionIds.has(id))
            diagnostics.add("ISSUE_FORM_DUPLICATE_ID", `${pathPrefix}.id`, `Duplicate section id "${id}".`);
        sectionIds.add(id);
    }
    const attributes = requiredRecord(value, "attributes", pathPrefix, diagnostics);
    const validations = parseValidations(value.validations, `${pathPrefix}.validations`, diagnostics);
    const fieldId = id ?? `field-${index}`;
    if (attributes === undefined)
        return undefined;
    if (type === "input" || type === "textarea") {
        return compileTextField(type, fieldId, attributes, validations, index, pathPrefix, diagnostics);
    }
    if (type === "dropdown") {
        return compileDropdown(fieldId, attributes, validations, index, pathPrefix, diagnostics);
    }
    return compileCheckboxes(fieldId, attributes, validations, index, pathPrefix, diagnostics);
}
function compileMarkdown(value, index, pathPrefix, sectionIds, diagnostics) {
    if (hasOwn(value, "id"))
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.id`, "Markdown elements must not define an id.");
    if (hasOwn(value, "validations"))
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.validations`, "Markdown elements cannot define validations.");
    const attributes = requiredRecord(value, "attributes", pathPrefix, diagnostics);
    if (attributes === undefined)
        return undefined;
    checkUnknownKeys(attributes, ["value"], `${pathPrefix}.attributes`, diagnostics);
    const content = requiredString(attributes, "value", `${pathPrefix}.attributes`, diagnostics);
    if (content === undefined)
        return undefined;
    // The canonical IR requires section IDs, while native markdown blocks intentionally have none.
    const id = `markdown-${index}`;
    if (sectionIds.has(id))
        diagnostics.add("ISSUE_FORM_DUPLICATE_ID", `${pathPrefix}.type`, `Duplicate generated section id "${id}".`);
    sectionIds.add(id);
    return {
        id,
        kind: "documentation",
        content,
        render: { order: index },
        nativeMetadata: { elementType: "markdown", markdown: content },
        fields: [],
    };
}
function compileTextField(elementType, id, attributes, validation, index, pathPrefix, diagnostics) {
    const allowedKeys = elementType === "textarea"
        ? ["label", "description", "placeholder", "value", "render"]
        : ["label", "description", "placeholder", "value"];
    checkUnknownKeys(attributes, allowedKeys, `${pathPrefix}.attributes`, diagnostics);
    const common = parseFieldCommon(id, attributes, validation, index, pathPrefix, diagnostics);
    const placeholder = optionalString(attributes, "placeholder", `${pathPrefix}.attributes`, diagnostics);
    const defaultValue = optionalString(attributes, "value", `${pathPrefix}.attributes`, diagnostics);
    const nativeMetadata = {
        elementType,
        sourceId: id,
        ...(placeholder === undefined ? {} : { placeholder }),
        ...(defaultValue === undefined ? {} : { defaultValue }),
        ...(elementType !== "textarea" || !hasOwn(attributes, "render")
            ? {}
            : { render: optionalString(attributes, "render", `${pathPrefix}.attributes`, diagnostics) }),
    };
    const field = {
        id: common.id,
        label: common.label,
        ...(common.description === undefined ? {} : { description: common.description }),
        type: "string",
        required: common.required,
        ...(defaultValue === undefined ? {} : { defaultValue }),
        render: { order: 0 },
        nativeMetadata,
    };
    return inputSection(common, elementType, field);
}
function compileDropdown(id, attributes, validation, index, pathPrefix, diagnostics) {
    checkUnknownKeys(attributes, ["label", "description", "options", "multiple", "default"], `${pathPrefix}.attributes`, diagnostics);
    const common = parseFieldCommon(id, attributes, validation, index, pathPrefix, diagnostics);
    const multiple = optionalBoolean(attributes, "multiple", `${pathPrefix}.attributes`, diagnostics) ?? false;
    const optionValues = parseDropdownOptions(attributes.options, `${pathPrefix}.attributes.options`, diagnostics, multiple);
    const defaultIndex = optionalSafeInteger(attributes, "default", `${pathPrefix}.attributes`, diagnostics);
    let defaultOption;
    if (defaultIndex !== undefined) {
        if (optionValues !== undefined && (defaultIndex < 0 || defaultIndex >= optionValues.length)) {
            diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.attributes.default`, "Dropdown default must be a valid option index.");
        }
        else if (optionValues !== undefined) {
            defaultOption = optionValues[defaultIndex];
            if (defaultOption !== undefined && isReservedEmptyOption(defaultOption)) {
                diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.attributes.default`, 'A dropdown with a default cannot contain the native empty option "None" or "n/a".');
            }
        }
    }
    const options = optionValues?.map((option) => ({ value: option, label: option })) ?? [];
    const nativeOptions = options.map((option) => ({ value: option.value }));
    const nativeMetadata = {
        elementType: "dropdown",
        sourceId: id,
        ...(Object.prototype.hasOwnProperty.call(attributes, "multiple") ? { multiple } : {}),
        ...(optionValues === undefined ? {} : { options: nativeOptions }),
        ...(defaultOption === undefined ? {} : { defaultValue: multiple ? [defaultOption] : defaultOption }),
    };
    if (multiple) {
        const field = {
            id: common.id,
            label: common.label,
            ...(common.description === undefined ? {} : { description: common.description }),
            type: "array",
            selection: "multi_select",
            required: common.required,
            items: { type: "string", options },
            ...(defaultOption === undefined ? {} : { defaultValue: [defaultOption] }),
            render: { order: 0 },
            nativeMetadata,
        };
        return inputSection(common, "dropdown", field);
    }
    const field = {
        id: common.id,
        label: common.label,
        ...(common.description === undefined ? {} : { description: common.description }),
        type: "enum",
        required: common.required,
        options,
        ...(defaultOption === undefined ? {} : { defaultValue: defaultOption }),
        render: { order: 0 },
        nativeMetadata,
    };
    return inputSection(common, "dropdown", field);
}
function compileCheckboxes(id, attributes, validation, index, pathPrefix, diagnostics) {
    checkUnknownKeys(attributes, ["label", "description", "options"], `${pathPrefix}.attributes`, diagnostics);
    const common = parseFieldCommon(id, attributes, validation, index, pathPrefix, diagnostics);
    const rawOptions = requiredArray(attributes, "options", `${pathPrefix}.attributes`, diagnostics);
    const itemIds = new Set();
    const items = [];
    const nativeOptions = [];
    if (rawOptions !== undefined) {
        if (rawOptions.length === 0)
            diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.attributes.options`, "Checkbox options must not be empty.");
        rawOptions.forEach((rawOption, optionIndex) => {
            const optionPath = `${pathPrefix}.attributes.options[${optionIndex}]`;
            if (!isRecord(rawOption)) {
                diagnostics.add("ISSUE_FORM_INVALID_VALUE", optionPath, "Checkbox options must be objects.");
                return;
            }
            checkUnknownKeys(rawOption, ["label", "required"], optionPath, diagnostics);
            const label = requiredNonEmptyString(rawOption, "label", optionPath, diagnostics);
            const required = optionalBoolean(rawOption, "required", optionPath, diagnostics) ?? false;
            if (label === undefined)
                return;
            if (new Set(items.map((item) => item.label)).has(label)) {
                diagnostics.add("ISSUE_FORM_AMBIGUOUS", `${optionPath}.label`, `Duplicate checkbox label "${label}".`);
            }
            const itemId = checklistIdentifier(label, optionIndex);
            if (itemIds.has(itemId))
                diagnostics.add("ISSUE_FORM_AMBIGUOUS", `${optionPath}.label`, `Checkbox label maps to duplicate canonical id "${itemId}".`);
            itemIds.add(itemId);
            items.push({ id: itemId, label, required });
            nativeOptions.push({ value: itemId, label, required });
        });
    }
    const requiredByItem = items.some((item) => item.required);
    const field = {
        id: common.id,
        label: common.label,
        ...(common.description === undefined ? {} : { description: common.description }),
        type: "checklist",
        required: validation.required || requiredByItem ? "required" : "optional",
        items,
        render: { order: 0 },
        nativeMetadata: { elementType: "checkboxes", sourceId: id, options: nativeOptions },
    };
    return inputSection(common, "checkboxes", field);
}
function parseFieldCommon(id, attributes, validation, order, pathPrefix, diagnostics) {
    const label = requiredNonEmptyString(attributes, "label", `${pathPrefix}.attributes`, diagnostics) ?? id;
    const description = optionalString(attributes, "description", `${pathPrefix}.attributes`, diagnostics);
    return {
        id,
        label,
        ...(description === undefined ? {} : { description }),
        required: validation.required ? "required" : "optional",
        order,
    };
}
function inputSection(common, elementType, field) {
    return {
        id: common.id,
        title: common.label,
        kind: "input",
        render: { order: common.order },
        nativeMetadata: { elementType, sourceId: common.id },
        fields: [field],
    };
}
function parseValidations(value, pathPrefix, diagnostics) {
    if (value === undefined)
        return { required: false };
    const validations = requiredRecordValue(value, pathPrefix, diagnostics);
    if (validations === undefined)
        return { required: false };
    checkUnknownKeys(validations, ["required"], pathPrefix, diagnostics);
    return { required: optionalBoolean(validations, "required", pathPrefix, diagnostics) ?? false };
}
function parseDropdownOptions(value, pathPrefix, diagnostics, multiple) {
    const options = requiredArrayValue(value, pathPrefix, diagnostics);
    if (options === undefined)
        return undefined;
    if (options.length === 0)
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", pathPrefix, "Dropdown options must not be empty.");
    const values = [];
    const seen = new Set();
    options.forEach((option, index) => {
        if (typeof option !== "string" || option.length === 0) {
            diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}[${index}]`, "Dropdown options must be non-empty strings.");
            return;
        }
        if (option !== option.trim()) {
            diagnostics.add("ISSUE_FORM_UNSUPPORTED_SEMANTICS", `${pathPrefix}[${index}]`, "Dropdown labels must not have leading or trailing whitespace because native artifact parsing trims values.");
        }
        if (/\r|\n/u.test(option)) {
            diagnostics.add("ISSUE_FORM_UNSUPPORTED_SEMANTICS", `${pathPrefix}[${index}]`, "Dropdown labels must not contain line breaks because native artifact parsing is line-based.");
        }
        if (option === GITHUB_NO_RESPONSE_LABEL) {
            diagnostics.add("ISSUE_FORM_UNSUPPORTED_SEMANTICS", `${pathPrefix}[${index}]`, `Dropdown label "${GITHUB_NO_RESPONSE_LABEL}" is reserved for an empty Issue Form response.`);
        }
        if (multiple && option.includes(MULTI_SELECT_OPTION_SEPARATOR)) {
            diagnostics.add("ISSUE_FORM_UNSUPPORTED_SEMANTICS", `${pathPrefix}[${index}]`, "Multi-select dropdown labels must not contain commas because native artifact parsing uses commas as separators.");
        }
        if (seen.has(option))
            diagnostics.add("ISSUE_FORM_DUPLICATE_VALUE", `${pathPrefix}[${index}]`, `Duplicate dropdown option "${option}".`);
        seen.add(option);
        values.push(option);
    });
    return values;
}
function parseStringList(value, pathPrefix, diagnostics) {
    const values = [];
    if (typeof value === "string") {
        if (value.trim().length > 0) {
            for (const entry of value.split(",")) {
                const trimmed = entry.trim();
                if (trimmed.length === 0) {
                    diagnostics.add("ISSUE_FORM_INVALID_VALUE", pathPrefix, "Comma-delimited labels cannot contain empty entries.");
                }
                else {
                    values.push(trimmed);
                }
            }
        }
    }
    else if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            if (typeof entry !== "string" || entry.trim().length === 0) {
                diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}[${index}]`, "Labels must be non-empty strings.");
            }
            else {
                values.push(entry.trim());
            }
        });
    }
    else {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", pathPrefix, "Labels must be an array or comma-delimited string.");
    }
    const seen = new Set();
    values.forEach((value, index) => {
        if (seen.has(value))
            diagnostics.add("ISSUE_FORM_DUPLICATE_VALUE", `${pathPrefix}[${index}]`, `Duplicate label "${value}".`);
        seen.add(value);
    });
    return values;
}
function checkUnknownKeys(record, allowedKeys, pathPrefix, diagnostics) {
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key))
            diagnostics.add("ISSUE_FORM_UNKNOWN_PROPERTY", `${pathPrefix}.${key}`, `Property "${key}" is not supported.`);
    }
}
function requiredNonEmptyString(record, key, pathPrefix, diagnostics) {
    if (!hasOwn(record, key)) {
        diagnostics.add("ISSUE_FORM_MISSING_PROPERTY", `${pathPrefix}.${key}`, `Property "${key}" is required.`);
        return undefined;
    }
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.${key}`, `Property "${key}" must be a non-empty string.`);
        return undefined;
    }
    return value;
}
function requiredString(record, key, pathPrefix, diagnostics) {
    if (!hasOwn(record, key)) {
        diagnostics.add("ISSUE_FORM_MISSING_PROPERTY", `${pathPrefix}.${key}`, `Property "${key}" is required.`);
        return undefined;
    }
    const value = record[key];
    if (typeof value !== "string") {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.${key}`, `Property "${key}" must be a string.`);
        return undefined;
    }
    return value;
}
function optionalString(record, key, pathPrefix, diagnostics) {
    if (!hasOwn(record, key))
        return undefined;
    const value = record[key];
    if (typeof value !== "string") {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.${key}`, `Property "${key}" must be a string when present.`);
        return undefined;
    }
    return value;
}
function optionalBoolean(record, key, pathPrefix, diagnostics) {
    if (!hasOwn(record, key))
        return undefined;
    const value = record[key];
    if (typeof value !== "boolean") {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.${key}`, `Property "${key}" must be a boolean when present.`);
        return undefined;
    }
    return value;
}
function optionalSafeInteger(record, key, pathPrefix, diagnostics) {
    if (!hasOwn(record, key))
        return undefined;
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", `${pathPrefix}.${key}`, `Property "${key}" must be a safe integer when present.`);
        return undefined;
    }
    return value;
}
function requiredArray(record, key, pathPrefix, diagnostics) {
    if (!hasOwn(record, key)) {
        diagnostics.add("ISSUE_FORM_MISSING_PROPERTY", `${pathPrefix}.${key}`, `Property "${key}" is required.`);
        return undefined;
    }
    return requiredArrayValue(record[key], `${pathPrefix}.${key}`, diagnostics);
}
function requiredArrayValue(value, pathPrefix, diagnostics) {
    if (!Array.isArray(value)) {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", pathPrefix, "Value must be an array.");
        return undefined;
    }
    return value;
}
function requiredRecord(record, key, pathPrefix, diagnostics) {
    if (!hasOwn(record, key)) {
        diagnostics.add("ISSUE_FORM_MISSING_PROPERTY", `${pathPrefix}.${key}`, `Property "${key}" is required.`);
        return undefined;
    }
    return requiredRecordValue(record[key], `${pathPrefix}.${key}`, diagnostics);
}
function requiredRecordValue(value, pathPrefix, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", pathPrefix, "Value must be an object.");
        return undefined;
    }
    return value;
}
function validateIdentifier(value, pathPrefix, diagnostics) {
    if (!identifierPattern.test(value)) {
        diagnostics.add("ISSUE_FORM_INVALID_VALUE", pathPrefix, "Identifiers must be non-empty and contain only letters, numbers, hyphens, or underscores.");
    }
}
function canonicalTemplateIdentifier(template) {
    const preferred = identifierPattern.test(template.id) ? template.id : template.name;
    const normalized = preferred
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/gu, "")
        .replace(/[^A-Za-z0-9_-]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    if (normalized.length === 0)
        return "template";
    return normalized;
}
function checklistIdentifier(label, index) {
    // GitHub checkbox options expose labels but no IDs; this ID is only a stable IR key.
    const normalized = label
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/gu, "")
        .replace(/[^A-Za-z0-9_-]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    if (normalized.length === 0)
        return `item-${index + 1}`;
    return /^[A-Za-z]/u.test(normalized) ? normalized : `item-${normalized}`;
}
function isReservedEmptyOption(value) {
    const normalized = value.trim().toLocaleLowerCase("en-US");
    return normalized === "none" || normalized === "n/a";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
//# sourceMappingURL=issue-form.js.map