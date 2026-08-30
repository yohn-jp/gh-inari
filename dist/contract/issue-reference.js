/**
 * Representation-independent Issue identity and dependency semantics.
 *
 * Dependency values intentionally live beside template fields.  They are a
 * generic Issue primitive, rather than a template field or a Portal model,
 * so later consumers can reuse them without learning a repository's Markdown
 * layout.
 *
 * For GitHub, repositoryHost + repositoryId is the identity tuple, where
 * repositoryId is the decimal REST repository database ID returned by
 * `gh api repos/{owner}/{repo}`. Rename/transfer within one host changes the
 * repository locator, but not the identity key; migration across hosts is a
 * different identity. The locator is never used for equality, sorting,
 * duplicate detection, or self checks.
 */
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
export const EMPTY_ISSUE_DEPENDENCIES = Object.freeze({ blockedBy: [], blocks: [] });
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function repositoryKey(reference) {
    return `${reference.repositoryHost}#${reference.repositoryId}#${reference.number}`;
}
function compareReferences(left, right) {
    return (left.repositoryHost.localeCompare(right.repositoryHost, "en-US") ||
        left.repositoryId.localeCompare(right.repositoryId, "en-US") ||
        left.number - right.number);
}
function invalidResult(violations) {
    return { valid: false, dependencies: EMPTY_ISSUE_DEPENDENCIES, violations };
}
function referenceViolation(code, path, message) {
    return { code, path, message };
}
/**
 * Normalize one generic Issue reference.  String shorthand and URLs are
 * deliberately rejected: accepting both would make repository identity
 * parsing ambiguous and would create multiple spellings for one reference.
 */
export function normalizeIssueReference(input, path = "$") {
    if (!isRecord(input)) {
        return {
            valid: false,
            reference: undefined,
            violations: [
                referenceViolation(typeof input === "string" || Array.isArray(input) ? "REFERENCE_AMBIGUOUS" : "REFERENCE_NOT_OBJECT", path, "Issue references must be objects containing repositoryHost, repositoryId, and number."),
            ],
        };
    }
    const violations = [];
    for (const key of Object.keys(input)) {
        if (key !== "repositoryHost" && key !== "repositoryId" && key !== "repository" && key !== "number") {
            violations.push(referenceViolation("REFERENCE_UNKNOWN_PROPERTY", `${path}.${key}`, `Reference property "${key}" is not supported.`));
        }
    }
    const repositoryHost = input.repositoryHost;
    if (typeof repositoryHost !== "string" || repositoryHost.length === 0 || /[\s/]/u.test(repositoryHost)) {
        violations.push(referenceViolation("REFERENCE_REPOSITORY_HOST_INVALID", `${path}.repositoryHost`, "repositoryHost must be a non-empty GitHub host without whitespace or path separators."));
    }
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(repositoryId)) {
        violations.push(referenceViolation("REFERENCE_REPOSITORY_ID_INVALID", `${path}.repositoryId`, "repositoryId must be a positive decimal REST repository database ID for this host, not an owner/name locator or URL."));
    }
    const repository = input.repository;
    if (repository !== undefined && (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository))) {
        violations.push(referenceViolation(repository === "" || typeof repository !== "string" ? "REFERENCE_REPOSITORY_INVALID" : "REFERENCE_AMBIGUOUS", `${path}.repository`, "repository is a display/transport locator and must be an owner/name value without a host, URL, or issue suffix."));
    }
    const number = input.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
        violations.push(referenceViolation("REFERENCE_NUMBER_INVALID", `${path}.number`, "Issue number must be a positive safe integer."));
    }
    if (violations.length > 0)
        return { valid: false, reference: undefined, violations };
    return {
        valid: true,
        reference: {
            repositoryHost: repositoryHost.toLocaleLowerCase("en-US"),
            repositoryId: repositoryId,
            ...(repository === undefined ? {} : { repository: repository.toLocaleLowerCase("en-US") }),
            number: number,
        },
        violations: [],
    };
}
/** Canonical validation and projection for Issue dependency declarations. */
export function validateIssueDependencies(input, subject) {
    if (input === undefined)
        return { valid: true, dependencies: EMPTY_ISSUE_DEPENDENCIES, violations: [] };
    if (!isRecord(input)) {
        return invalidResult([referenceViolation("DEPENDENCIES_NOT_OBJECT", "$", "Issue dependencies must be an object.")]);
    }
    const violations = [];
    const subjectKey = subject === undefined ? undefined : issueReferenceKey(subject);
    for (const key of Object.keys(input)) {
        if (key !== "blockedBy" && key !== "blocks") {
            violations.push(referenceViolation("DEPENDENCIES_UNKNOWN_PROPERTY", `$.${key}`, `Dependency property "${key}" is not supported.`));
        }
    }
    const parseDirection = (direction) => {
        const raw = input[direction];
        if (raw === undefined)
            return [];
        if (!Array.isArray(raw)) {
            violations.push(referenceViolation("DEPENDENCIES_NOT_ARRAY", `$.${direction}`, `${direction} must be an array of Issue references.`));
            return [];
        }
        const parsed = [];
        const seen = new Set();
        raw.forEach((entry, index) => {
            const result = normalizeIssueReference(entry, `$.${direction}[${index}]`);
            violations.push(...result.violations);
            if (!result.valid || result.reference === undefined)
                return;
            const key = repositoryKey(result.reference);
            if (seen.has(key)) {
                violations.push(referenceViolation("REFERENCE_DUPLICATE", `$.${direction}[${index}]`, `Duplicate ${direction} reference "${key}".`));
                return;
            }
            seen.add(key);
            if (subjectKey !== undefined && key === subjectKey) {
                violations.push(referenceViolation("REFERENCE_SELF", `$.${direction}[${index}]`, "An Issue cannot depend on itself."));
            }
            parsed.push(result.reference);
        });
        return parsed;
    };
    const blockedBy = parseDirection("blockedBy");
    const blocks = parseDirection("blocks");
    const blockedKeys = new Set(blockedBy.map(repositoryKey));
    blocks.forEach((reference, index) => {
        if (blockedKeys.has(repositoryKey(reference))) {
            violations.push(referenceViolation("REFERENCE_CONTRADICTORY", `$.blocks[${index}]`, `The same reference cannot appear in both blockedBy and blocks (${repositoryKey(reference)}).`));
        }
    });
    if (violations.length > 0)
        return invalidResult(violations);
    return {
        valid: true,
        dependencies: {
            blockedBy: [...blockedBy].sort(compareReferences),
            blocks: [...blocks].sort(compareReferences),
        },
        violations: [],
    };
}
export const normalizeIssueDependencies = validateIssueDependencies;
export const projectIssueDependencies = validateIssueDependencies;
/** Stable key useful to adapters without exposing parsing rules. */
export function issueReferenceKey(reference) {
    return repositoryKey({
        repositoryHost: reference.repositoryHost.toLocaleLowerCase("en-US"),
        repositoryId: reference.repositoryId,
        number: reference.number,
    });
}
//# sourceMappingURL=issue-reference.js.map