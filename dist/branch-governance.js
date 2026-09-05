/**
 * Canonical branch naming and classification owned by Inari Core.
 *
 * Repository policy may constrain ordinary pull-request branches. Release
 * branches have a separate, deterministic semver class. Neither class is an
 * authorization or security boundary.
 */
export const DEFAULT_BRANCH_PATTERN = "^(feat|fix|docs|refactor|test|chore)/\\d+-[a-z0-9-]+$";
export const DEFAULT_RELEASE_BRANCH_PATTERN = "^release/(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$";
export const DEFAULT_BRANCH_EXEMPTIONS = Object.freeze(["main"]);
export const MAX_BRANCH_NAME_LENGTH = 255;
/** The fixed ordinary branch grammar used for Change branch derivation. */
const CANONICAL_CHANGE_BRANCH_PATTERN = /^(feat|fix|docs|refactor|test|chore)\/([1-9][0-9]*)-([a-z0-9-]+)$/u;
export const DEFAULT_BRANCH_GOVERNANCE = Object.freeze({
    pattern: DEFAULT_BRANCH_PATTERN,
    release: Object.freeze({ pattern: DEFAULT_RELEASE_BRANCH_PATTERN }),
    exemptions: DEFAULT_BRANCH_EXEMPTIONS,
});
/** Add effective defaults to a repository-declared branch policy. */
export function effectiveBranchGovernance(input) {
    return {
        pattern: input.pattern,
        release: input.release ?? { pattern: DEFAULT_RELEASE_BRANCH_PATTERN },
        exemptions: [...(input.exemptions ?? [])].sort(compareStrings),
    };
}
/** Parse the ordinary Change branch identity without assigning governance meaning. */
export function parseCanonicalChangeBranchName(branch) {
    const match = CANONICAL_CHANGE_BRANCH_PATTERN.exec(branch);
    if (match === null)
        return undefined;
    const issueNumber = Number(match[2]);
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
        return undefined;
    return { type: match[1], issueNumber, slug: match[3] };
}
/** Derive the canonical ordinary branch projection for a Change. */
export function deriveBranchName(input) {
    if (typeof input.type !== "string" || input.type.length === 0) {
        throw new TypeError("Branch type must be a non-empty string.");
    }
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
        throw new TypeError("Branch issue number must be a positive safe integer.");
    }
    if (typeof input.slug !== "string" || input.slug.length === 0) {
        throw new TypeError("Branch slug must be a non-empty string.");
    }
    const branch = `${input.type}/${input.issueNumber}-${input.slug}`;
    if (branch.length > MAX_BRANCH_NAME_LENGTH || !CANONICAL_CHANGE_BRANCH_PATTERN.test(branch)) {
        throw new TypeError(`branch name "${branch}" does not match <type>/<issue-number>-<slug> ` +
            '(e.g. "feat/42-add-init-command"); type must be one of feat, fix, docs, refactor, test, chore');
    }
    return branch;
}
/**
 * Classify an observed PR head branch against one compiled repository policy.
 * An absent policy intentionally returns a valid unclassified result: the
 * repository has declared no branch-name precondition.
 */
export function classifyBranchName(branch, governance) {
    if (governance === undefined)
        return { valid: true, classification: "unclassified", violations: [] };
    if (branch === undefined || branch === null || branch === "") {
        return {
            valid: false,
            classification: "invalid",
            violations: [
                {
                    code: "BRANCH_NAME_MISSING",
                    path: "$.head",
                    message: "Pull request head branch must be a non-empty string.",
                },
            ],
        };
    }
    if (typeof branch !== "string") {
        return {
            valid: false,
            classification: "invalid",
            violations: [
                {
                    code: "BRANCH_NAME_INVALID",
                    path: "$.head",
                    message: "Pull request head branch must be a string.",
                },
            ],
        };
    }
    if (branch.length > MAX_BRANCH_NAME_LENGTH) {
        return {
            valid: false,
            classification: branch.startsWith("release/") ? "invalid-release" : "invalid",
            violations: [
                {
                    code: "BRANCH_NAME_TOO_LONG",
                    path: "$.head",
                    message: `Pull request head branch exceeds the maximum supported length of ${MAX_BRANCH_NAME_LENGTH} characters.`,
                },
            ],
        };
    }
    const effective = effectiveBranchGovernance(governance);
    const releasePattern = compilePattern(effective.release.pattern);
    if (branch.startsWith("release/")) {
        if (releasePattern === undefined) {
            return invalidPolicyViolation();
        }
        // release/* is a distinct class and cannot be authorized by an ordinary
        // pattern or exemption. This preserves deterministic release routing.
        if (releasePattern.test(branch)) {
            return {
                valid: true,
                classification: "release",
                version: branch.slice("release/".length),
                violations: [],
            };
        }
        return {
            valid: false,
            classification: "invalid-release",
            violations: [
                {
                    code: "BRANCH_RELEASE_INVALID",
                    path: "$.head",
                    message: `Release branch "${branch}" must match release/<semver> (for example release/1.2.3).`,
                },
            ],
        };
    }
    const ordinaryPattern = compilePattern(effective.pattern);
    if (ordinaryPattern === undefined) {
        return invalidPolicyViolation();
    }
    if (effective.exemptions.includes(branch))
        return { valid: true, classification: "exempt", violations: [] };
    if (ordinaryPattern.test(branch))
        return { valid: true, classification: "ordinary", violations: [] };
    return {
        valid: false,
        classification: "invalid",
        violations: [
            {
                code: "BRANCH_PATTERN_MISMATCH",
                path: "$.head",
                message: `Branch name "${branch}" does not satisfy the ordinary branch governance pattern.`,
            },
        ],
    };
}
function invalidPolicyViolation() {
    return {
        valid: false,
        classification: "invalid",
        violations: [
            {
                code: "BRANCH_POLICY_INVALID",
                path: "$.branch",
                message: "Compiled branch governance contains an invalid regular expression.",
            },
        ],
    };
}
/** Compatibility-facing diagnostics for the package's branch helper. */
export function validateBranchName(branch, governance = DEFAULT_BRANCH_GOVERNANCE) {
    return classifyBranchName(branch, governance).violations.map((violation) => violation.message);
}
function compilePattern(pattern) {
    try {
        return new RegExp(pattern, "u");
    }
    catch {
        return undefined;
    }
}
function compareStrings(left, right) {
    return left.localeCompare(right, "en-US");
}
//# sourceMappingURL=branch-governance.js.map