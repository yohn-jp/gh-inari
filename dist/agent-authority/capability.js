/**
 * The semantic capability vocabulary usable inside a Runtime Authority
 * `capabilityCeiling` and a Session Certificate `capabilities` claim list.
 *
 * Per `docs/AGENT_CAPABILITY_AUTHORIZATION.md` section 11.2, agent-facing
 * capabilities are bounded repository/Change semantics, never raw GitHub
 * provider permissions (`contents: write`, `pull_requests: write`, ...).
 * This module is the single allow-list: a capability kind not listed here
 * cannot be expressed by either record, which is also how trust-root and
 * other non-delegable operations (section 11.6) stay structurally
 * unreachable from ordinary delegated authority -- there is no capability
 * kind for them to begin with.
 *
 * Branch and pull-request-head identity reuses the repository's one branch
 * grammar (`branch-naming-authority.mjs`) instead of a second parallel
 * pattern.
 */
import { validateBranchName } from "../../branch-naming-authority.mjs";
export const CAPABILITY_KINDS = Object.freeze([
    "change.implement",
    "change.ready",
    "change.abort",
    "branch.create",
    "branch.advance",
    "pullRequest.create",
]);
const CHANGE_CAPABILITY_KINDS = new Set([
    "change.implement",
    "change.ready",
    "change.abort",
]);
export const MAX_ISSUE_NUMBER = 999_999_999;
export const MAX_PATH_POLICY_LENGTH = 160;
/** Architecture doc 11.2/11.4 examples bound branch/PR creation to exactly one. */
export const CAPABILITY_CREATE_MAX = 1;
function diagnostic(code, path, message) {
    return { code, path, message };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isCapabilityKind(value) {
    return typeof value === "string" && CAPABILITY_KINDS.includes(value);
}
function isSafeIssueNumber(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER;
}
/**
 * `main` validates as a branch name under the shared grammar because it is
 * a legitimate PR base reference, but it is never a branch an agent
 * capability can be delegated to create or write to -- that would collapse
 * into default-branch/trust-root authority, which section 11.6 places
 * outside ordinary delegated capability.
 */
function validAgentBranchName(value) {
    return typeof value === "string" && value !== "main" && value.length > 0 && validateBranchName(value).length === 0;
}
function validBaseBranchName(value) {
    return typeof value === "string" && value.length > 0 && validateBranchName(value).length === 0;
}
function addUnknownProperties(input, allowed, path, diagnostics) {
    for (const key of Object.keys(input).sort()) {
        if (!allowed.has(key))
            diagnostics.push(diagnostic("CAPABILITY_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not accepted."));
    }
}
function requireProperty(input, key, path, diagnostics) {
    if (key in input)
        return true;
    diagnostics.push(diagnostic("CAPABILITY_MISSING_PROPERTY", `${path}.${key}`, "Property is required."));
    return false;
}
/** Validate one capability claim (a Session Certificate `capabilities[i]` entry). */
export function validateCapabilityClaim(input, path = "$") {
    const diagnostics = [];
    if (!isRecord(input)) {
        return {
            valid: false,
            diagnostics: [diagnostic("CAPABILITY_INVALID_ROOT", path, "Capability claim must be an object.")],
        };
    }
    if (!requireProperty(input, "kind", path, diagnostics) || !isCapabilityKind(input.kind)) {
        if (diagnostics.length === 0) {
            diagnostics.push(diagnostic("CAPABILITY_UNSUPPORTED_KIND", `${path}.kind`, "Capability kind is not a recognized semantic capability."));
        }
        return { valid: false, diagnostics };
    }
    const kind = input.kind;
    if (CHANGE_CAPABILITY_KINDS.has(kind)) {
        addUnknownProperties(input, new Set(["kind", "issue"]), path, diagnostics);
        if (requireProperty(input, "issue", path, diagnostics) && !isSafeIssueNumber(input.issue)) {
            diagnostics.push(diagnostic("CAPABILITY_INVALID_CLAIM", `${path}.issue`, "issue must be a positive integer Issue number."));
        }
        if (diagnostics.length > 0)
            return { valid: false, diagnostics };
        return {
            valid: true,
            value: Object.freeze({ kind, issue: input.issue }),
            diagnostics: [],
        };
    }
    if (kind === "branch.create") {
        addUnknownProperties(input, new Set(["kind", "branch", "max"]), path, diagnostics);
        if (requireProperty(input, "branch", path, diagnostics) && !validAgentBranchName(input.branch)) {
            diagnostics.push(diagnostic("CAPABILITY_INVALID_CLAIM", `${path}.branch`, "branch must be a canonical repository branch name."));
        }
        if (requireProperty(input, "max", path, diagnostics) && input.max !== CAPABILITY_CREATE_MAX) {
            diagnostics.push(diagnostic("CAPABILITY_INVALID_CLAIM", `${path}.max`, `max must be exactly ${CAPABILITY_CREATE_MAX}.`));
        }
        if (diagnostics.length > 0)
            return { valid: false, diagnostics };
        return {
            valid: true,
            value: Object.freeze({
                kind,
                branch: input.branch,
                max: CAPABILITY_CREATE_MAX,
            }),
            diagnostics: [],
        };
    }
    if (kind === "branch.advance") {
        addUnknownProperties(input, new Set(["kind", "branch", "pathPolicy"]), path, diagnostics);
        if (requireProperty(input, "branch", path, diagnostics) && !validAgentBranchName(input.branch)) {
            diagnostics.push(diagnostic("CAPABILITY_INVALID_CLAIM", `${path}.branch`, "branch must be a canonical repository branch name."));
        }
        let pathPolicy;
        if ("pathPolicy" in input) {
            if (typeof input.pathPolicy !== "string" ||
                input.pathPolicy.length === 0 ||
                input.pathPolicy.length > MAX_PATH_POLICY_LENGTH) {
                diagnostics.push(diagnostic("CAPABILITY_INVALID_CLAIM", `${path}.pathPolicy`, `pathPolicy must be 1-${MAX_PATH_POLICY_LENGTH} characters.`));
            }
            else {
                pathPolicy = input.pathPolicy;
            }
        }
        if (diagnostics.length > 0)
            return { valid: false, diagnostics };
        return {
            valid: true,
            value: Object.freeze({
                kind,
                branch: input.branch,
                ...(pathPolicy === undefined ? {} : { pathPolicy }),
            }),
            diagnostics: [],
        };
    }
    // kind === "pullRequest.create"
    addUnknownProperties(input, new Set(["kind", "head", "base", "max"]), path, diagnostics);
    if (requireProperty(input, "head", path, diagnostics) && !validAgentBranchName(input.head)) {
        diagnostics.push(diagnostic("CAPABILITY_INVALID_CLAIM", `${path}.head`, "head must be a canonical repository branch name."));
    }
    if (requireProperty(input, "base", path, diagnostics) && !validBaseBranchName(input.base)) {
        diagnostics.push(diagnostic("CAPABILITY_INVALID_CLAIM", `${path}.base`, "base must be a canonical repository branch name."));
    }
    if (requireProperty(input, "max", path, diagnostics) && input.max !== CAPABILITY_CREATE_MAX) {
        diagnostics.push(diagnostic("CAPABILITY_INVALID_CLAIM", `${path}.max`, `max must be exactly ${CAPABILITY_CREATE_MAX}.`));
    }
    if (diagnostics.length > 0)
        return { valid: false, diagnostics };
    return {
        valid: true,
        value: Object.freeze({
            kind,
            head: input.head,
            base: input.base,
            max: CAPABILITY_CREATE_MAX,
        }),
        diagnostics: [],
    };
}
/** `EffectiveAuthority` intersection (architecture doc 7.3/11.1): a claim's kind must be within the delegating Runtime's ceiling. */
export function capabilityClaimWithinCeiling(claim, ceiling) {
    return ceiling.includes(claim.kind);
}
/** The Issue number a change.* claim is scoped to, for task-binding consistency checks. */
export function capabilityClaimIssueNumber(claim) {
    return CHANGE_CAPABILITY_KINDS.has(claim.kind) ? claim.issue : undefined;
}
//# sourceMappingURL=capability.js.map