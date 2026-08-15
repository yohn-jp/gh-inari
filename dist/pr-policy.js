import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { assertCanonicalContract, } from "./contract/ir.js";
export const PULL_REQUEST_POLICY_VERSION = 1;
export class PullRequestPolicyError extends Error {
    code;
    path;
    constructor(code, message, path = "$") {
        super(message);
        this.name = "PullRequestPolicyError";
        this.code = code;
        this.path = path;
    }
    toJSON() {
        return { code: this.code, path: this.path, message: this.message };
    }
}
/** Compile a small, data-only PR overlay into the shared canonical contract. */
export function compilePullRequestPolicyOverlay(contractInput, source, options = {}) {
    assertCanonicalContract(contractInput);
    const contract = contractInput;
    if (contract.artifactKind !== "pull_request") {
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "PR policy overlays apply only to pull request contracts.");
    }
    const overlay = typeof source === "string" ? parsePullRequestPolicyOverlay(source) : source;
    assertOverlayVersion(overlay);
    const selected = selectPolicyEntry(overlay, contract, options);
    const mergedFields = [...contract.supplementalConstraints.fields];
    selected.sections.forEach((rule, ruleIndex) => {
        const field = resolveField(contract, rule.fieldId);
        const rulePath = `${selected.sectionsPath}[${ruleIndex}]`;
        const constraint = ruleToConstraint(rule, field, rulePath);
        const existingIndex = mergedFields.findIndex((entry) => entry.fieldId === field.id);
        if (existingIndex < 0)
            mergedFields.push(constraint);
        else
            mergedFields[existingIndex] = mergeConstraints(mergedFields[existingIndex], constraint, rulePath);
    });
    const merged = {
        ...contract,
        supplementalConstraints: {
            fields: mergedFields,
        },
    };
    try {
        assertCanonicalContract(merged);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Compiled PR policy is not a valid canonical contract.";
        throw new PullRequestPolicyError("PR_POLICY_CONFLICT", message, selected.sectionsPath);
    }
    return merged;
}
function mergeConstraints(previous, next, path) {
    const keys = [
        "required",
        "minLength",
        "maxLength",
        "pattern",
        "minItems",
        "maxItems",
        "linkedIssue",
        "checklistMinCompleted",
        "checklistRequireComplete",
    ];
    for (const key of keys) {
        if (previous[key] !== undefined && next[key] !== undefined && previous[key] !== next[key]) {
            throw new PullRequestPolicyError("PR_POLICY_CONFLICT", `Overlay constraint for field "${previous.fieldId}" conflicts with an existing supplemental constraint.`, `${path}.${String(key)}`);
        }
    }
    return { ...previous, ...next };
}
export function parsePullRequestPolicyOverlay(source) {
    let value;
    try {
        value = parseYaml(source);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Invalid YAML.";
        throw new PullRequestPolicyError("PR_POLICY_INVALID_YAML", message);
    }
    if (!isRecord(value))
        throw new PullRequestPolicyError("PR_POLICY_INVALID_ROOT", "PR policy must be a mapping.");
    assertKeys(value, ["version", "template", "templates", "sections", "fields"], "$");
    if (value.template !== undefined && value.templates !== undefined) {
        throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "Cannot specify both 'template' and 'templates'.", "$.template");
    }
    if (value.templates !== undefined && (value.sections !== undefined || value.fields !== undefined)) {
        throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "Cannot specify root sections together with template entries.", "$.templates");
    }
    if (value.sections !== undefined && value.fields !== undefined) {
        throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "Cannot specify both 'sections' and 'fields'.", "$.sections");
    }
    const version = value.version;
    if (version !== PULL_REQUEST_POLICY_VERSION) {
        throw new PullRequestPolicyError("PR_POLICY_UNSUPPORTED_VERSION", `Only PR policy version ${PULL_REQUEST_POLICY_VERSION} is supported.`, "$.version");
    }
    if (value.templates !== undefined) {
        if (!Array.isArray(value.templates) || value.templates.length === 0) {
            throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "templates must be a non-empty array.", "$.templates");
        }
        const templates = value.templates.map((entry, index) => parseTemplateEntry(entry, `$.templates[${index}]`));
        if (templates.length > 1 && templates.some((entry) => entry.template === undefined)) {
            const index = templates.findIndex((entry) => entry.template === undefined);
            throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "Every entry in a multi-template PR policy must identify a native template.", `$.templates[${index}].template`);
        }
        return { version: PULL_REQUEST_POLICY_VERSION, templates };
    }
    return {
        version: PULL_REQUEST_POLICY_VERSION,
        ...(value.template === undefined ? {} : { template: parseSelector(value.template, "$.template") }),
        sections: parseRules(value.sections ?? value.fields, "$.sections"),
    };
}
function parseTemplateEntry(value, path) {
    if (!isRecord(value)) {
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "Template entries must be objects.", path);
    }
    assertKeys(value, ["template", "sections", "fields"], path);
    if (value.sections !== undefined && value.fields !== undefined) {
        throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "Cannot specify both 'sections' and 'fields'.", `${path}.sections`);
    }
    return {
        ...(value.template === undefined ? {} : { template: parseSelector(value.template, `${path}.template`) }),
        sections: parseRules(value.sections ?? value.fields, `${path}.sections`),
    };
}
export async function compilePullRequestPolicyFile(contract, filePath, options = {}) {
    let source;
    try {
        source = await readFile(filePath, "utf8");
    }
    catch (cause) {
        const error = new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", `Cannot read PR policy file "${filePath}".`);
        if (cause instanceof Error)
            error.cause = cause;
        throw error;
    }
    return compilePullRequestPolicyOverlay(contract, source, options);
}
function parseRules(value, path) {
    if (!Array.isArray(value))
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "sections must be an array.", path);
    return value.map((entry, index) => parseRule(entry, `${path}[${index}]`));
}
function parseRule(value, path) {
    if (!isRecord(value))
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "Section rules must be objects.", path);
    assertKeys(value, [
        "id",
        "fieldId",
        "section",
        "sectionId",
        "required",
        "minLength",
        "maxLength",
        "pattern",
        "minItems",
        "maxItems",
        "linkedIssue",
        "checklistMinCompleted",
        "checklistRequireComplete",
        "checklist",
    ], path);
    const references = ["id", "fieldId", "section", "sectionId"].filter((key) => value[key] !== undefined);
    if (references.length !== 1 || typeof value[references[0]] !== "string") {
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "Each rule must contain exactly one string field identity using id, fieldId, section, or sectionId.", path);
    }
    const fieldId = value[references[0]];
    const required = optionalBoolean(value, "required", path);
    const minLength = optionalInteger(value, "minLength", path);
    const maxLength = optionalInteger(value, "maxLength", path);
    const directPattern = optionalString(value, "pattern", path);
    const minItems = optionalInteger(value, "minItems", path);
    const maxItems = optionalInteger(value, "maxItems", path);
    const linkedIssue = optionalBoolean(value, "linkedIssue", path);
    let checklistMinCompleted = optionalInteger(value, "checklistMinCompleted", path);
    let checklistRequireComplete = optionalBoolean(value, "checklistRequireComplete", path);
    if (value.checklist !== undefined) {
        if (!isRecord(value.checklist))
            throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "checklist must be an object.", `${path}.checklist`);
        assertKeys(value.checklist, ["minCompleted", "requireComplete"], `${path}.checklist`);
        if (checklistMinCompleted !== undefined || checklistRequireComplete !== undefined) {
            throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "Use either checklist shorthand or checklist object, not both.", path);
        }
        checklistMinCompleted = optionalInteger(value.checklist, "minCompleted", `${path}.checklist`);
        checklistRequireComplete = optionalBoolean(value.checklist, "requireComplete", `${path}.checklist`);
    }
    if (linkedIssue === true && directPattern !== undefined) {
        throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "linkedIssue cannot be combined with pattern.", path);
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "minLength cannot exceed maxLength.", path);
    }
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "minItems cannot exceed maxItems.", path);
    }
    return {
        fieldId,
        ...(required === undefined ? {} : { required }),
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(directPattern === undefined ? {} : { pattern: directPattern }),
        ...(minItems === undefined ? {} : { minItems }),
        ...(maxItems === undefined ? {} : { maxItems }),
        ...(linkedIssue === undefined ? {} : { linkedIssue }),
        ...(checklistMinCompleted === undefined ? {} : { checklistMinCompleted }),
        ...(checklistRequireComplete === undefined ? {} : { checklistRequireComplete }),
    };
}
const QUANTIFIER_PATTERN = /^(?:[*+?]|\{\d*,?\d*\})/u;
/**
 * Rejects the structural shapes that cause catastrophic backtracking in a
 * backtracking regex engine: a quantified group nested inside another
 * quantified group, and a quantified group whose top-level alternatives can
 * match overlapping text (e.g. "(a|a)+" or "(a|ab)+"). Overlap is judged by
 * literal prefix comparison, which only inspects alternatives with no
 * metacharacters; alternatives containing metacharacters are treated as
 * potentially safe rather than guessed at. This is a conservative syntactic
 * check, not a full NFA ambiguity analysis: it may reject some safe nested
 * patterns but never a pattern the compiler previously accepted, and it does
 * not claim to catch every possible ambiguous alternation.
 */
function hasCatastrophicBacktrackingRisk(pattern) {
    const stack = [];
    let inCharClass = false;
    const pushGroup = (startIndex) => {
        stack.push({ hasQuantifiedChild: false, alternatives: [], currentAlternativeStart: startIndex });
    };
    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];
        if (inCharClass) {
            if (char === "\\") {
                index += 1;
            }
            else if (char === "]") {
                inCharClass = false;
                markIfQuantifiedAtom(stack, pattern, index + 1);
            }
            continue;
        }
        if (char === "\\") {
            index += 1;
            markIfQuantifiedAtom(stack, pattern, index + 1);
            continue;
        }
        if (char === "[") {
            inCharClass = true;
            continue;
        }
        if (char === "(") {
            pushGroup(index + 1);
            continue;
        }
        if (char === "|") {
            const current = stack.at(-1);
            if (current !== undefined) {
                current.alternatives.push(pattern.slice(current.currentAlternativeStart, index));
                current.currentAlternativeStart = index + 1;
            }
            continue;
        }
        if (char === ")") {
            const closed = stack.pop();
            if (closed === undefined)
                continue;
            closed.alternatives.push(pattern.slice(closed.currentAlternativeStart, index));
            const rest = pattern.slice(index + 1);
            const quantifierMatch = QUANTIFIER_PATTERN.exec(rest);
            const isQuantified = quantifierMatch !== null;
            if (isQuantified) {
                if (closed.hasQuantifiedChild)
                    return true;
                if (closed.alternatives.length > 1 && alternativesOverlap(closed.alternatives))
                    return true;
            }
            const parent = stack.at(-1);
            if (parent !== undefined && isQuantified)
                parent.hasQuantifiedChild = true;
            continue;
        }
        if (QUANTIFIER_PATTERN.test(char))
            continue;
        // An ordinary literal atom: a quantifier immediately following it (e.g. "a+")
        // still contributes unbounded repetition inside whatever group contains it.
        markIfQuantifiedAtom(stack, pattern, index + 1);
    }
    return false;
}
function markIfQuantifiedAtom(stack, pattern, fromIndex) {
    const current = stack.at(-1);
    if (current === undefined)
        return;
    if (QUANTIFIER_PATTERN.test(pattern.slice(fromIndex)))
        current.hasQuantifiedChild = true;
}
const LITERAL_ALTERNATIVE_PATTERN = /^[^\\^$.*+?()[\]{}|]*$/u;
/** True if any two alternatives are literal text where one is a prefix of (or equal to) the other. */
function alternativesOverlap(alternatives) {
    const literals = alternatives.filter((alternative) => LITERAL_ALTERNATIVE_PATTERN.test(alternative));
    for (let i = 0; i < literals.length; i += 1) {
        for (let j = i + 1; j < literals.length; j += 1) {
            const [shorter, longer] = literals[i].length <= literals[j].length ? [literals[i], literals[j]] : [literals[j], literals[i]];
            if (shorter.length > 0 && longer.startsWith(shorter))
                return true;
        }
    }
    return false;
}
function ruleToConstraint(rule, field, path) {
    if (rule.linkedIssue === true && field.type !== "string" && field.type !== "enum") {
        throw new PullRequestPolicyError("PR_POLICY_UNSUPPORTED_CONSTRAINT", "linkedIssue requires a string-like section.", path);
    }
    if ((rule.checklistMinCompleted !== undefined || rule.checklistRequireComplete !== undefined) &&
        field.type !== "checklist") {
        throw new PullRequestPolicyError("PR_POLICY_UNSUPPORTED_CONSTRAINT", "Checklist constraints require a checklist section.", path);
    }
    if (rule.pattern !== undefined) {
        try {
            new RegExp(rule.pattern, "u");
        }
        catch {
            throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "pattern must be a valid regular expression.", path);
        }
        if (rule.pattern.includes("\\1") || /\\[1-9]/u.test(rule.pattern)) {
            throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "pattern must not use backreferences.", path);
        }
        if (hasCatastrophicBacktrackingRisk(rule.pattern)) {
            throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "pattern must not nest quantified groups or repeat overlapping alternatives, which can cause unbounded regex evaluation.", path);
        }
    }
    if (rule.linkedIssue === true && rule.required === false) {
        throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "linkedIssue cannot be combined with required=false.", path);
    }
    return {
        fieldId: field.id,
        ...(rule.required === undefined && rule.linkedIssue !== true ? {} : { required: rule.required ?? true }),
        ...(rule.minLength === undefined ? {} : { minLength: rule.minLength }),
        ...(rule.maxLength === undefined ? {} : { maxLength: rule.maxLength }),
        ...(rule.pattern === undefined ? {} : { pattern: rule.pattern }),
        ...(rule.minItems === undefined ? {} : { minItems: rule.minItems }),
        ...(rule.maxItems === undefined ? {} : { maxItems: rule.maxItems }),
        ...(rule.linkedIssue === undefined ? {} : { linkedIssue: rule.linkedIssue }),
        ...(rule.checklistMinCompleted === undefined ? {} : { checklistMinCompleted: rule.checklistMinCompleted }),
        ...(rule.checklistRequireComplete === undefined ? {} : { checklistRequireComplete: rule.checklistRequireComplete }),
    };
}
function resolveField(contract, reference) {
    const matches = contract.sections
        .flatMap((section) => [...section.fields])
        .filter((field) => field.id === reference || field.nativeMetadata.sourceId === reference);
    if (matches.length === 0) {
        throw new PullRequestPolicyError("PR_POLICY_UNKNOWN_REFERENCE", `No native PR section matches "${reference}".`, reference);
    }
    if (matches.length > 1) {
        throw new PullRequestPolicyError("PR_POLICY_AMBIGUOUS_REFERENCE", `Multiple native PR sections match "${reference}".`, reference);
    }
    return matches[0];
}
function assertOverlayVersion(overlay) {
    if (overlay.version !== PULL_REQUEST_POLICY_VERSION) {
        throw new PullRequestPolicyError("PR_POLICY_UNSUPPORTED_VERSION", "Unsupported PR policy version.", "$.version");
    }
}
function selectPolicyEntry(overlay, contract, options) {
    validatePolicyTemplateBindings(overlay, contract, options.templateIdentities);
    if (overlay.templates !== undefined) {
        if (overlay.templates.length === 0) {
            throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "templates must be a non-empty array.", "$.templates");
        }
        const matches = overlay.templates
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => entry.template === undefined ||
            policySelectorMatchesContract(entry.template, contract, options.templateIdentities));
        if (matches.length === 0) {
            throw new PullRequestPolicyError("PR_POLICY_TEMPLATE_MISMATCH", "No PR policy entry targets the selected native template.", "$.templates");
        }
        if (matches.length > 1) {
            throw new PullRequestPolicyError("PR_POLICY_AMBIGUOUS_REFERENCE", "Multiple PR policy entries target the selected native template.", "$.templates");
        }
        const match = matches[0];
        return {
            template: match.entry.template,
            sections: match.entry.sections,
            sectionsPath: `$.templates[${match.index}].sections`,
        };
    }
    assertTemplateMatch(overlay.template, contract, options.templateIdentities);
    return {
        template: overlay.template,
        sections: overlay.sections ?? [],
        sectionsPath: "$.sections",
    };
}
function validatePolicyTemplateBindings(overlay, contract, templateIdentities) {
    if (templateIdentities === undefined)
        return;
    if (!templateIdentities.some((identity) => identityMatchesContract(identity, contract))) {
        throw new PullRequestPolicyError("PR_POLICY_TEMPLATE_MISMATCH", "PR policy contract is not bound to an available native template.", "$.template");
    }
    const entries = overlay.templates === undefined
        ? overlay.template === undefined
            ? []
            : [{ template: overlay.template, path: "$.template" }]
        : overlay.templates.map((entry, index) => ({
            template: entry.template,
            path: `$.templates[${index}].template`,
        }));
    entries.forEach(({ template, path }) => {
        if (template === undefined)
            return;
        const matches = templateIdentities.filter((identity) => templateSelectorMatchesIdentity(template, identity));
        if (matches.length === 0) {
            throw new PullRequestPolicyError("PR_POLICY_TEMPLATE_MISMATCH", "PR policy does not target an available native template.", path);
        }
        if (matches.length > 1) {
            throw new PullRequestPolicyError("PR_POLICY_AMBIGUOUS_REFERENCE", "PR policy template selector matches multiple native templates.", path);
        }
    });
}
function identityMatchesContract(identity, contract) {
    // A semantic source may provide the display name while the generated native
    // identity derives its name from the committed path. The repository path is
    // the stable authority boundary; it must remain an exact match.
    return identity.path === contract.templateIdentity.path;
}
function assertTemplateMatch(selector, contract, templateIdentities, path = "$.template") {
    if (selector === undefined)
        return;
    if (!policySelectorMatchesContract(selector, contract, templateIdentities)) {
        throw new PullRequestPolicyError("PR_POLICY_TEMPLATE_MISMATCH", "PR policy does not target the selected native template.", path);
    }
}
function policySelectorMatchesContract(selector, contract, templateIdentities) {
    if (templateSelectorMatches(selector, contract))
        return true;
    return (templateIdentities?.some((identity) => identityMatchesContract(identity, contract) && templateSelectorMatchesIdentity(selector, identity)) ?? false);
}
function templateSelectorMatches(selector, contract) {
    return typeof selector === "string"
        ? selector === contract.templateIdentity.id ||
            selector === contract.templateIdentity.path ||
            selector.toLocaleLowerCase("en-US") === contract.templateIdentity.name.toLocaleLowerCase("en-US")
        : (selector.id === undefined || selector.id === contract.templateIdentity.id) &&
            (selector.path === undefined || selector.path === contract.templateIdentity.path) &&
            (selector.name === undefined ||
                selector.name.toLocaleLowerCase("en-US") === contract.templateIdentity.name.toLocaleLowerCase("en-US"));
}
function templateSelectorMatchesIdentity(selector, identity) {
    return typeof selector === "string"
        ? selector === identity.id ||
            selector === identity.path ||
            selector.toLocaleLowerCase("en-US") === identity.name.toLocaleLowerCase("en-US")
        : (selector.id === undefined || selector.id === identity.id) &&
            (selector.path === undefined || selector.path === identity.path) &&
            (selector.name === undefined ||
                selector.name.toLocaleLowerCase("en-US") === identity.name.toLocaleLowerCase("en-US"));
}
function parseSelector(value, path) {
    if (typeof value === "string" && value.trim().length > 0)
        return value;
    if (!isRecord(value))
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "template must be a non-empty string or selector object.", path);
    assertKeys(value, ["id", "path", "name"], path);
    const selector = {
        ...(typeof value.id === "string" ? { id: value.id } : {}),
        ...(typeof value.path === "string" ? { path: value.path } : {}),
        ...(typeof value.name === "string" ? { name: value.name } : {}),
    };
    if (Object.keys(selector).length === 0)
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "template selector must not be empty.", path);
    return selector;
}
function assertKeys(record, allowed, path) {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
    if (unknown.length > 0) {
        throw new PullRequestPolicyError("PR_POLICY_UNKNOWN_PROPERTY", `Unknown property "${unknown[0]}".`, `${path}.${unknown[0]}`);
    }
}
function optionalString(record, key, path) {
    if (record[key] === undefined)
        return undefined;
    if (typeof record[key] !== "string")
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", `${key} must be a string.`, `${path}.${key}`);
    return record[key];
}
function optionalBoolean(record, key, path) {
    if (record[key] === undefined)
        return undefined;
    if (typeof record[key] !== "boolean")
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", `${key} must be a boolean.`, `${path}.${key}`);
    return record[key];
}
function optionalInteger(record, key, path) {
    if (record[key] === undefined)
        return undefined;
    if (!Number.isSafeInteger(record[key]) || typeof record[key] !== "number" || record[key] < 0) {
        throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", `${key} must be a non-negative integer.`, `${path}.${key}`);
    }
    return record[key];
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=pr-policy.js.map