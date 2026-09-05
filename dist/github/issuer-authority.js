/**
 * The Inari GitHub App authority boundary.
 *
 * This module owns the identity, scope, permission, and trusted-execution
 * checks around the issuer capability. It deliberately does not derive
 * branches, validate lifecycle transitions, or implement GitHub Actions.
 *
 * A TrustedInstallationCredentialBroker is the only credential boundary. Its
 * implementation obtains an installation token inside trusted execution and
 * exposes only a repository-scoped mutation channel to this module. Neither
 * the token nor the App private key appears in any public type or result.
 */
import { CHANGE_EFFECT_KINDS, MAX_CHANGE_TRANSITION_EFFECTS, validateChangeEffect, } from "../change.js";
import { INARI_ISSUER_APP_KIND, INARI_ISSUER_APP_SLUG, INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";
export { INARI_ISSUER_APP_KIND, INARI_ISSUER_APP_SLUG, INARI_ISSUER_PRINCIPAL, } from "../issuer-identity.js";
export const ISSUER_AUTHORITY_CONTRACT_VERSION = 1;
export const TRUSTED_EXECUTION_RUNTIME = "github-actions";
export const TRUSTED_EXECUTION_EVENTS = Object.freeze(["workflow_dispatch", "workflow_call"]);
export const ISSUER_PERMISSION_NAMES = Object.freeze(["contents", "pull_requests", "metadata"]);
export const ISSUER_PERMISSION_ACCESS = Object.freeze(["read", "write"]);
/**
 * The App manifest ceiling. No Issues, administration, Actions, contents
 * administration, review, or merge permission is part of the issuer role.
 */
export const INARI_ISSUER_MAXIMUM_PERMISSIONS = Object.freeze({
    contents: "write",
    pull_requests: "write",
});
/** Initial Change effects and their exact GitHub App permission requirement. */
export const INITIAL_CHANGE_EFFECT_PERMISSION_REQUIREMENTS = Object.freeze({
    CREATE_BRANCH: Object.freeze({ contents: "write" }),
    CREATE_PULL_REQUEST: Object.freeze({ pull_requests: "write" }),
    MARK_PULL_REQUEST_READY: Object.freeze({ pull_requests: "write" }),
    CLOSE_PULL_REQUEST: Object.freeze({ pull_requests: "write" }),
    DELETE_BRANCH: Object.freeze({ contents: "write" }),
});
export const INITIAL_CHANGE_EFFECT_KINDS = Object.freeze([
    "CREATE_BRANCH",
    "CREATE_PULL_REQUEST",
    "MARK_PULL_REQUEST_READY",
    "CLOSE_PULL_REQUEST",
    "DELETE_BRANCH",
]);
export const MAX_ISSUER_DIAGNOSTICS = 16;
export const MAX_ISSUER_DIAGNOSTIC_MESSAGE_LENGTH = 240;
export const MAX_ISSUER_DIAGNOSTIC_PATH_LENGTH = 160;
export const MAX_ISSUER_REPOSITORY_NAME_LENGTH = 255;
export const MAX_ISSUER_WORKFLOW_REF_LENGTH = 255;
export const MAX_ISSUER_REQUESTER_LENGTH = 160;
const APP_IDENTITY_KEYS = new Set(["kind", "slug", "appId", "principal"]);
const REPOSITORY_IDENTITY_KEYS = new Set(["repositoryHost", "repositoryId", "nameWithOwner"]);
const INSTALLATION_IDENTITY_KEYS = new Set(["appId", "installationId", "repositoryHost"]);
const INSTALLATION_SCOPE_KEYS = new Set([
    "app",
    "installation",
    "repository",
    "repositorySelection",
    "permissions",
    "expiresAt",
]);
const TRUSTED_EXECUTION_KEYS = new Set([
    "version",
    "runtime",
    "event",
    "repository",
    "workflowRef",
    "workflowSha",
    "workflowTrust",
    "codeExecution",
    "fork",
    "pullRequest",
    "requester",
]);
const MUTATION_REQUEST_KEYS = new Set(["version", "authority", "execution", "target", "effects"]);
const CREDENTIAL_REQUEST_KEYS = new Set(["version", "authority", "app", "execution", "target", "permissions"]);
const MUTATION_CAPABILITY_KEYS = new Set(["scope", "apply"]);
const PERMISSION_NAMES = new Set(ISSUER_PERMISSION_NAMES);
const MAX_ID_LENGTH = 20;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const WORKFLOW_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9_.\-/]+$/u;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const internalBoundaryErrors = new WeakSet();
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function bounded(value, maxLength) {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
}
function createDiagnostic(code, path, message) {
    return {
        version: ISSUER_AUTHORITY_CONTRACT_VERSION,
        code,
        path: bounded(path, MAX_ISSUER_DIAGNOSTIC_PATH_LENGTH),
        message: bounded(message, MAX_ISSUER_DIAGNOSTIC_MESSAGE_LENGTH),
    };
}
function normalizeDiagnostics(diagnostics) {
    const unique = new Map();
    for (const diagnostic of diagnostics) {
        const normalized = createDiagnostic(diagnostic.code, diagnostic.path, diagnostic.message);
        unique.set(`${normalized.code}\u0000${normalized.path}\u0000${normalized.message}`, normalized);
    }
    return Object.freeze([...unique.values()]
        .sort((left, right) => compareText(left.path, right.path) || compareText(left.code, right.code))
        .slice(0, MAX_ISSUER_DIAGNOSTICS));
}
function report(diagnostics) {
    return { valid: false, diagnostics: normalizeDiagnostics(diagnostics) };
}
function valid(value) {
    return { valid: true, value, diagnostics: [] };
}
function addUnknownProperties(input, allowed, path, diagnostics) {
    for (const key of Object.keys(input).sort(compareText)) {
        if (!allowed.has(key)) {
            diagnostics.push(createDiagnostic("ISSUER_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not accepted."));
        }
    }
}
function requireProperty(input, key, path, diagnostics) {
    if (hasOwn(input, key))
        return true;
    diagnostics.push(createDiagnostic("ISSUER_MISSING_PROPERTY", `${path}.${key}`, "Property is required."));
    return false;
}
function validText(value, maxLength) {
    return (typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001F\u007F]/u.test(value));
}
function normalizeRepositoryName(value) {
    if (!REPOSITORY_NAME_PATTERN.test(value) || value.length > MAX_ISSUER_REPOSITORY_NAME_LENGTH)
        return undefined;
    const parts = value.split("/");
    if (parts.some((part) => part === "." || part === ".."))
        return undefined;
    return value;
}
function repositoryIdentityEqual(left, right) {
    return (left.repositoryHost === right.repositoryHost &&
        left.repositoryId === right.repositoryId &&
        left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase());
}
function freezeRepositoryIdentity(value) {
    return Object.freeze({ ...value });
}
function validateRepositoryIdentity(input, path) {
    const diagnostics = [];
    if (!isRecord(input))
        return report([createDiagnostic("ISSUER_INVALID_IDENTITY", path, "Repository identity must be an object.")]);
    addUnknownProperties(input, REPOSITORY_IDENTITY_KEYS, path, diagnostics);
    const host = input.repositoryHost;
    const repositoryId = input.repositoryId;
    const nameWithOwner = input.nameWithOwner;
    if (!requireProperty(input, "repositoryHost", path, diagnostics)) {
        // Continue checking other fields to keep diagnostics deterministic.
    }
    else if (!validText(host, MAX_ISSUER_REPOSITORY_NAME_LENGTH) || /[\s/]/u.test(host)) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_IDENTITY", `${path}.repositoryHost`, "Repository host is invalid."));
    }
    if (!requireProperty(input, "repositoryId", path, diagnostics)) {
        // Continue checking other fields to keep diagnostics deterministic.
    }
    else if (typeof repositoryId !== "string" ||
        repositoryId.length > MAX_ID_LENGTH ||
        !DECIMAL_ID_PATTERN.test(repositoryId)) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_IDENTITY", `${path}.repositoryId`, "Repository ID is invalid."));
    }
    if (!requireProperty(input, "nameWithOwner", path, diagnostics)) {
        // Continue checking other fields to keep diagnostics deterministic.
    }
    else if (typeof nameWithOwner !== "string" || normalizeRepositoryName(nameWithOwner) === undefined) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_IDENTITY", `${path}.nameWithOwner`, "Repository owner/name is invalid."));
    }
    if (diagnostics.length > 0)
        return report(diagnostics);
    return valid(freezeRepositoryIdentity({
        repositoryHost: host.toLowerCase(),
        repositoryId: repositoryId,
        nameWithOwner: nameWithOwner,
    }));
}
export function validateIssuerRepositoryIdentity(input, path = "$.repository") {
    return validateRepositoryIdentity(input, path);
}
export function createInariIssuerAppIdentity(appId) {
    const result = validateInariIssuerAppIdentity({
        kind: INARI_ISSUER_APP_KIND,
        slug: INARI_ISSUER_APP_SLUG,
        appId,
        principal: INARI_ISSUER_PRINCIPAL,
    });
    if (!result.valid || result.value === undefined)
        throw new IssuerAuthorityError(result.diagnostics);
    return result.value;
}
export function validateInariIssuerAppIdentity(input, path = "$.app") {
    const diagnostics = [];
    if (!isRecord(input))
        return report([createDiagnostic("ISSUER_INVALID_IDENTITY", path, "App identity must be an object.")]);
    addUnknownProperties(input, APP_IDENTITY_KEYS, path, diagnostics);
    if (!requireProperty(input, "kind", path, diagnostics)) {
        // Continue checking all identity fields.
    }
    else if (input.kind !== INARI_ISSUER_APP_KIND) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_IDENTITY", `${path}.kind`, "Issuer App kind is invalid."));
    }
    if (!requireProperty(input, "slug", path, diagnostics)) {
        // Continue checking all identity fields.
    }
    else if (input.slug !== INARI_ISSUER_APP_SLUG) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_IDENTITY", `${path}.slug`, "Issuer App slug is invalid."));
    }
    if (!requireProperty(input, "appId", path, diagnostics)) {
        // Continue checking all identity fields.
    }
    else if (typeof input.appId !== "string" ||
        input.appId.length > MAX_ID_LENGTH ||
        !DECIMAL_ID_PATTERN.test(input.appId)) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_IDENTITY", `${path}.appId`, "Issuer App ID is invalid."));
    }
    if (!requireProperty(input, "principal", path, diagnostics)) {
        // Continue checking all identity fields.
    }
    else if (input.principal !== INARI_ISSUER_PRINCIPAL) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_IDENTITY", `${path}.principal`, "Issuer principal is invalid."));
    }
    if (diagnostics.length > 0)
        return report(diagnostics);
    return valid(Object.freeze({
        kind: INARI_ISSUER_APP_KIND,
        slug: INARI_ISSUER_APP_SLUG,
        appId: input.appId,
        principal: INARI_ISSUER_PRINCIPAL,
    }));
}
function validatePermissionSet(input, path, requiredPermissions, diagnostics) {
    if (!isRecord(input)) {
        diagnostics.push(createDiagnostic("ISSUER_PERMISSION_MISMATCH", path, "Permission scope must be an object."));
        return undefined;
    }
    const normalized = {};
    for (const key of Object.keys(input).sort(compareText)) {
        if (!PERMISSION_NAMES.has(key)) {
            diagnostics.push(createDiagnostic("ISSUER_PERMISSION_MISMATCH", `${path}.${key}`, "Permission is not allowed."));
            continue;
        }
        const value = input[key];
        if (value !== "read" && value !== "write") {
            diagnostics.push(createDiagnostic("ISSUER_PERMISSION_MISMATCH", `${path}.${key}`, "Permission access is invalid."));
            continue;
        }
        const permission = key;
        if (permission === "metadata" && value !== "read") {
            diagnostics.push(createDiagnostic("ISSUER_PERMISSION_MISMATCH", `${path}.${key}`, "Metadata permission is read-only."));
            continue;
        }
        normalized[permission] = value;
    }
    if (requiredPermissions !== undefined) {
        const requiredResult = validatePermissionSet(requiredPermissions, "$.requiredPermissions", undefined, diagnostics);
        if (requiredResult !== undefined) {
            for (const [key, requiredAccess] of Object.entries(requiredResult)) {
                const actualAccess = normalized[key];
                if (actualAccess !== requiredAccess) {
                    diagnostics.push(createDiagnostic("ISSUER_PERMISSION_MISMATCH", `${path}.${key}`, "Credential permission scope does not exactly match the requested effect capability."));
                }
            }
            for (const key of Object.keys(normalized)) {
                if (key === "metadata")
                    continue;
                if (!Object.prototype.hasOwnProperty.call(requiredResult, key)) {
                    diagnostics.push(createDiagnostic("ISSUER_PERMISSION_MISMATCH", `${path}.${key}`, "Credential permission exceeds the requested effect capability."));
                }
            }
        }
    }
    else {
        for (const key of Object.keys(normalized)) {
            const maximum = INARI_ISSUER_MAXIMUM_PERMISSIONS[key];
            if (key !== "metadata" && maximum === undefined) {
                diagnostics.push(createDiagnostic("ISSUER_PERMISSION_MISMATCH", `${path}.${key}`, "Permission exceeds the issuer App ceiling."));
            }
        }
    }
    return Object.freeze(normalized);
}
function normalizeRequester(value, path, diagnostics) {
    if (value === undefined)
        return undefined;
    if (!validText(value, MAX_ISSUER_REQUESTER_LENGTH)) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_EXECUTION", path, "Requester identity is invalid."));
        return undefined;
    }
    return value;
}
export function validateTrustedExecutionContext(input, path = "$.execution") {
    const diagnostics = [];
    if (!isRecord(input))
        return report([createDiagnostic("ISSUER_INVALID_EXECUTION", path, "Execution context must be an object.")]);
    addUnknownProperties(input, TRUSTED_EXECUTION_KEYS, path, diagnostics);
    if (!requireProperty(input, "version", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (input.version !== ISSUER_AUTHORITY_CONTRACT_VERSION) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_EXECUTION", `${path}.version`, "Execution contract version is unsupported."));
    }
    if (!requireProperty(input, "runtime", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (input.runtime !== TRUSTED_EXECUTION_RUNTIME) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_EXECUTION", `${path}.runtime`, "Execution runtime is not trusted."));
    }
    if (!requireProperty(input, "event", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (!TRUSTED_EXECUTION_EVENTS.includes(input.event)) {
        diagnostics.push(createDiagnostic(input.event === "pull_request" || input.event === "pull_request_target"
            ? "ISSUER_UNSUPPORTED_EVENT"
            : "ISSUER_UNTRUSTED_EXECUTION", `${path}.event`, "This event cannot obtain issuer credentials."));
    }
    const repositoryResult = requireProperty(input, "repository", path, diagnostics)
        ? validateRepositoryIdentity(input.repository, `${path}.repository`)
        : report([]);
    diagnostics.push(...repositoryResult.diagnostics);
    if (!requireProperty(input, "workflowRef", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (!validText(input.workflowRef, MAX_ISSUER_WORKFLOW_REF_LENGTH) ||
        !WORKFLOW_REF_PATTERN.test(input.workflowRef) ||
        input.workflowRef.includes("..")) {
        diagnostics.push(createDiagnostic("ISSUER_UNTRUSTED_EXECUTION", `${path}.workflowRef`, "Workflow ref is not protected."));
    }
    if (!requireProperty(input, "workflowSha", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (typeof input.workflowSha !== "string" || !SHA_PATTERN.test(input.workflowSha)) {
        diagnostics.push(createDiagnostic("ISSUER_UNTRUSTED_EXECUTION", `${path}.workflowSha`, "Workflow commit identity is invalid."));
    }
    if (!requireProperty(input, "workflowTrust", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (input.workflowTrust !== "protected") {
        diagnostics.push(createDiagnostic("ISSUER_UNTRUSTED_EXECUTION", `${path}.workflowTrust`, "Workflow is not trusted."));
    }
    if (!requireProperty(input, "codeExecution", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (input.codeExecution !== "trusted-only") {
        diagnostics.push(createDiagnostic("ISSUER_UNTRUSTED_EXECUTION", `${path}.codeExecution`, "Untrusted code execution is forbidden."));
    }
    if (!requireProperty(input, "fork", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (input.fork !== false) {
        diagnostics.push(createDiagnostic("ISSUER_UNTRUSTED_EXECUTION", `${path}.fork`, "Fork execution cannot obtain issuer credentials."));
    }
    if (!requireProperty(input, "pullRequest", path, diagnostics)) {
        // Continue checking the trust claims.
    }
    else if (input.pullRequest !== false) {
        diagnostics.push(createDiagnostic("ISSUER_UNTRUSTED_EXECUTION", `${path}.pullRequest`, "Pull-request execution cannot obtain issuer credentials."));
    }
    const requester = normalizeRequester(input.requester, `${path}.requester`, diagnostics);
    if (diagnostics.length > 0 || !repositoryResult.valid || repositoryResult.value === undefined)
        return report(diagnostics);
    return valid(Object.freeze({
        version: ISSUER_AUTHORITY_CONTRACT_VERSION,
        runtime: TRUSTED_EXECUTION_RUNTIME,
        event: input.event,
        repository: repositoryResult.value,
        workflowRef: input.workflowRef,
        workflowSha: input.workflowSha.toLowerCase(),
        workflowTrust: "protected",
        codeExecution: "trusted-only",
        fork: false,
        pullRequest: false,
        ...(requester === undefined ? {} : { requester }),
    }));
}
export const assertTrustedExecution = (input) => {
    const result = validateTrustedExecutionContext(input);
    if (!result.valid || result.value === undefined)
        throw new IssuerAuthorityError(result.diagnostics);
    return result.value;
};
function effectKind(value) {
    return (typeof value === "string" &&
        INITIAL_CHANGE_EFFECT_KINDS.includes(value));
}
function normalizeEffects(input, path, diagnostics) {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CHANGE_TRANSITION_EFFECTS) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_EFFECT", path, `Effects must contain between one and ${MAX_CHANGE_TRANSITION_EFFECTS} initial Change effects.`));
        return undefined;
    }
    const normalized = [];
    input.forEach((candidate, index) => {
        const result = validateChangeEffect(candidate, `${path}[${index}]`);
        if (!result.valid || result.effect === undefined) {
            diagnostics.push(createDiagnostic("ISSUER_INVALID_EFFECT", `${path}[${index}]`, "Effect failed the Core effect contract."));
            return;
        }
        if (!effectKind(result.effect.kind) || !CHANGE_EFFECT_KINDS.includes(result.effect.kind)) {
            diagnostics.push(createDiagnostic("ISSUER_UNSUPPORTED_EFFECT", `${path}[${index}].kind`, "Effect is outside the issuer capability."));
            return;
        }
        normalized.push(result.effect);
    });
    if (diagnostics.length > 0)
        return undefined;
    return Object.freeze(normalized);
}
/** Derive only the permissions declared by an explicit initial effect list. */
export function requiredPermissionsForEffects(input) {
    const diagnostics = [];
    const effects = normalizeEffects(input, "$.effects", diagnostics);
    if (effects === undefined)
        throw new IssuerAuthorityError(diagnostics);
    const required = {};
    for (const effect of effects) {
        const permissions = INITIAL_CHANGE_EFFECT_PERMISSION_REQUIREMENTS[effect.kind];
        for (const [name, access] of Object.entries(permissions)) {
            const key = name;
            const current = required[key];
            if (current === "write" || access === undefined)
                continue;
            required[key] = access;
        }
    }
    return Object.freeze(required);
}
export function validateIssuerMutationRequest(input) {
    const diagnostics = [];
    if (!isRecord(input))
        return report([createDiagnostic("ISSUER_INVALID_ROOT", "$", "Issuer mutation request must be an object.")]);
    addUnknownProperties(input, MUTATION_REQUEST_KEYS, "$", diagnostics);
    if (!requireProperty(input, "version", "$", diagnostics)) {
        // Continue checking the request.
    }
    else if (input.version !== ISSUER_AUTHORITY_CONTRACT_VERSION) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_ROOT", "$.version", "Issuer contract version is unsupported."));
    }
    if (!requireProperty(input, "authority", "$", diagnostics)) {
        // Continue checking the request.
    }
    else if (input.authority !== "issuer") {
        diagnostics.push(createDiagnostic("ISSUER_REVIEW_AUTHORITY", "$.authority", "Only issuer authority may request this mutation capability; reviewer authority is separate."));
    }
    const targetResult = requireProperty(input, "target", "$", diagnostics)
        ? validateRepositoryIdentity(input.target, "$.target")
        : report([]);
    diagnostics.push(...targetResult.diagnostics);
    const executionResult = requireProperty(input, "execution", "$", diagnostics)
        ? validateTrustedExecutionContext(input.execution, "$.execution")
        : report([]);
    diagnostics.push(...executionResult.diagnostics);
    if (targetResult.value !== undefined &&
        executionResult.value !== undefined &&
        !repositoryIdentityEqual(targetResult.value, executionResult.value.repository)) {
        diagnostics.push(createDiagnostic("ISSUER_SCOPE_MISMATCH", "$.execution.repository", "Execution repository does not match mutation target."));
    }
    const effects = normalizeEffects(input.effects, "$.effects", diagnostics);
    if (effects === undefined) {
        if (!hasOwn(input, "effects")) {
            diagnostics.push(createDiagnostic("ISSUER_MISSING_PROPERTY", "$.effects", "Property is required."));
        }
    }
    if (diagnostics.length > 0 ||
        targetResult.value === undefined ||
        executionResult.value === undefined ||
        effects === undefined) {
        return report(diagnostics);
    }
    const permissions = requiredPermissionsForEffects(effects);
    return valid(Object.freeze({
        version: ISSUER_AUTHORITY_CONTRACT_VERSION,
        authority: "issuer",
        execution: executionResult.value,
        target: targetResult.value,
        effects,
        permissions,
    }));
}
function validateInstallationIdentity(input, path, diagnostics) {
    if (!isRecord(input)) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_SCOPE", path, "Installation identity must be an object."));
        return undefined;
    }
    addUnknownProperties(input, INSTALLATION_IDENTITY_KEYS, path, diagnostics);
    const appId = input.appId;
    const installationId = input.installationId;
    const repositoryHost = input.repositoryHost;
    if (!requireProperty(input, "appId", path, diagnostics)) {
        // Continue checking the identity.
    }
    else if (typeof appId !== "string" || !DECIMAL_ID_PATTERN.test(appId)) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_SCOPE", `${path}.appId`, "Installation App ID is invalid."));
    }
    if (!requireProperty(input, "installationId", path, diagnostics)) {
        // Continue checking the identity.
    }
    else if (typeof installationId !== "string" || !DECIMAL_ID_PATTERN.test(installationId)) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_SCOPE", `${path}.installationId`, "Installation ID is invalid."));
    }
    if (!requireProperty(input, "repositoryHost", path, diagnostics)) {
        // Continue checking the identity.
    }
    else if (!validText(repositoryHost, MAX_ISSUER_REPOSITORY_NAME_LENGTH) || /[\s/]/u.test(repositoryHost)) {
        diagnostics.push(createDiagnostic("ISSUER_INVALID_SCOPE", `${path}.repositoryHost`, "Installation host is invalid."));
    }
    if (diagnostics.length > 0)
        return undefined;
    return Object.freeze({
        appId: appId,
        installationId: installationId,
        repositoryHost: repositoryHost.toLowerCase(),
    });
}
export function validateIssuerInstallationScope(input, options = {}) {
    const diagnostics = [];
    if (!isRecord(input))
        return report([createDiagnostic("ISSUER_INVALID_SCOPE", "$.scope", "Installation scope must be an object.")]);
    addUnknownProperties(input, INSTALLATION_SCOPE_KEYS, "$.scope", diagnostics);
    const appResult = requireProperty(input, "app", "$.scope", diagnostics)
        ? validateInariIssuerAppIdentity(input.app, "$.scope.app")
        : report([]);
    diagnostics.push(...appResult.diagnostics);
    const installation = requireProperty(input, "installation", "$.scope", diagnostics)
        ? validateInstallationIdentity(input.installation, "$.scope.installation", diagnostics)
        : undefined;
    const repositoryResult = requireProperty(input, "repository", "$.scope", diagnostics)
        ? validateRepositoryIdentity(input.repository, "$.scope.repository")
        : report([]);
    diagnostics.push(...repositoryResult.diagnostics);
    if (!requireProperty(input, "repositorySelection", "$.scope", diagnostics)) {
        // Continue checking all scope fields.
    }
    else if (input.repositorySelection !== "selected") {
        diagnostics.push(createDiagnostic("ISSUER_SCOPE_MISMATCH", "$.scope.repositorySelection", "Credential must be restricted to the selected repository."));
    }
    if (!requireProperty(input, "permissions", "$.scope", diagnostics)) {
        // Continue checking all scope fields.
    }
    const permissions = hasOwn(input, "permissions")
        ? validatePermissionSet(input.permissions, "$.scope.permissions", options.requiredPermissions, diagnostics)
        : undefined;
    if (!requireProperty(input, "expiresAt", "$.scope", diagnostics)) {
        // Continue checking all scope fields.
    }
    let expiresAt;
    let expiresAtMs;
    if (hasOwn(input, "expiresAt")) {
        if (!validText(input.expiresAt, 64)) {
            diagnostics.push(createDiagnostic("ISSUER_INVALID_SCOPE", "$.scope.expiresAt", "Credential expiry is invalid."));
        }
        else {
            expiresAt = input.expiresAt;
            expiresAtMs = Date.parse(input.expiresAt);
            if (!Number.isFinite(expiresAtMs)) {
                diagnostics.push(createDiagnostic("ISSUER_INVALID_SCOPE", "$.scope.expiresAt", "Credential expiry is invalid."));
            }
            else {
                const nowMs = options.now?.getTime() ?? Date.now();
                if (!Number.isFinite(nowMs) || expiresAtMs <= nowMs) {
                    diagnostics.push(createDiagnostic("ISSUER_CREDENTIAL_EXPIRED", "$.scope.expiresAt", "Short-lived credential is expired."));
                }
            }
        }
    }
    if (options.app !== undefined && appResult.value !== undefined && !sameAppIdentity(options.app, appResult.value)) {
        diagnostics.push(createDiagnostic("ISSUER_SCOPE_MISMATCH", "$.scope.app", "Credential App identity does not match the issuer App."));
    }
    if (installation !== undefined && appResult.value !== undefined && installation.appId !== appResult.value.appId) {
        diagnostics.push(createDiagnostic("ISSUER_SCOPE_MISMATCH", "$.scope.installation.appId", "Installation is bound to a different App identity."));
    }
    if (installation !== undefined &&
        repositoryResult.value !== undefined &&
        installation.repositoryHost !== repositoryResult.value.repositoryHost) {
        diagnostics.push(createDiagnostic("ISSUER_SCOPE_MISMATCH", "$.scope.installation.repositoryHost", "Installation host does not match the repository host."));
    }
    if (options.target !== undefined &&
        repositoryResult.value !== undefined &&
        !repositoryIdentityEqual(options.target, repositoryResult.value)) {
        diagnostics.push(createDiagnostic("ISSUER_SCOPE_MISMATCH", "$.scope.repository", "Credential repository does not match the mutation target."));
    }
    if (diagnostics.length > 0 ||
        appResult.value === undefined ||
        installation === undefined ||
        repositoryResult.value === undefined ||
        permissions === undefined ||
        expiresAt === undefined ||
        expiresAtMs === undefined) {
        return report(diagnostics);
    }
    return valid(Object.freeze({
        app: appResult.value,
        installation,
        repository: repositoryResult.value,
        repositorySelection: "selected",
        permissions,
        expiresAt,
    }));
}
function sameAppIdentity(left, right) {
    return left.appId === right.appId && left.principal === right.principal && left.slug === right.slug;
}
function throwValidation(result) {
    if (!result.valid || result.value === undefined)
        throw new IssuerAuthorityError(result.diagnostics);
    return result.value;
}
function assertCredentialRequest(request) {
    if (!isRecord(request))
        throw new IssuerAuthorityError([
            createDiagnostic("ISSUER_CREDENTIAL_BOUNDARY", "$.credential", "Credential request is invalid."),
        ]);
    const diagnostics = [];
    addUnknownProperties(request, CREDENTIAL_REQUEST_KEYS, "$.credential", diagnostics);
    if (request.version !== ISSUER_AUTHORITY_CONTRACT_VERSION || request.authority !== "issuer") {
        diagnostics.push(createDiagnostic("ISSUER_CREDENTIAL_BOUNDARY", "$.credential", "Credential request authority is invalid."));
    }
    const app = throwValidation(validateInariIssuerAppIdentity(request.app, "$.credential.app"));
    const target = throwValidation(validateRepositoryIdentity(request.target, "$.credential.target"));
    const execution = throwValidation(validateTrustedExecutionContext(request.execution, "$.credential.execution"));
    const permissions = validatePermissionSet(request.permissions, "$.credential.permissions", undefined, diagnostics);
    if (!repositoryIdentityEqual(target, execution.repository)) {
        diagnostics.push(createDiagnostic("ISSUER_SCOPE_MISMATCH", "$.credential.execution.repository", "Credential target is outside execution repository."));
    }
    if (diagnostics.length > 0)
        throw new IssuerAuthorityError(diagnostics);
    return Object.freeze({
        version: ISSUER_AUTHORITY_CONTRACT_VERSION,
        authority: "issuer",
        app,
        target,
        execution,
        permissions: permissions ?? Object.freeze({}),
    });
}
function validateCapabilityShape(input) {
    if (!isRecord(input))
        return false;
    if (Object.keys(input).some((key) => !MUTATION_CAPABILITY_KEYS.has(key)))
        return false;
    return isRecord(input.scope) && typeof input.apply === "function";
}
function capabilityError(message) {
    const error = new IssuerAuthorityError([createDiagnostic("ISSUER_CREDENTIAL_BOUNDARY", "$.credential", message)]);
    internalBoundaryErrors.add(error);
    return error;
}
function internalBoundaryError(code, path, message) {
    const error = new IssuerAuthorityError([createDiagnostic(code, path, message)]);
    internalBoundaryErrors.add(error);
    return error;
}
/**
 * Mutation authority for the Inari App. The class contains no semantic
 * transition or branch policy; it only authenticates a trusted capability and
 * applies the explicitly supplied Core effects through a scoped channel.
 */
export class InariIssuerAppAuthority {
    identity;
    #broker;
    #now;
    constructor(options) {
        if (!isRecord(options) || typeof options.appId !== "string") {
            throw new IssuerAuthorityError([
                createDiagnostic("ISSUER_INVALID_IDENTITY", "$.appId", "Issuer App ID is required."),
            ]);
        }
        if (!isRecord(options.broker) || typeof options.broker.withScopedInstallationCredential !== "function") {
            throw new IssuerAuthorityError([
                createDiagnostic("ISSUER_CREDENTIAL_BOUNDARY", "$.broker", "Trusted credential broker is required."),
            ]);
        }
        this.identity = createInariIssuerAppIdentity(options.appId);
        this.#broker = options.broker;
        this.#now = options.now ?? (() => new Date());
    }
    async applyEffects(input) {
        const request = throwValidation(validateIssuerMutationRequest(input));
        const credentialRequest = assertCredentialRequest({
            version: ISSUER_AUTHORITY_CONTRACT_VERSION,
            authority: "issuer",
            app: this.identity,
            execution: request.execution,
            target: request.target,
            permissions: request.permissions,
        });
        const applied = [];
        let scope;
        try {
            await this.#broker.withScopedInstallationCredential(credentialRequest, async (candidate) => {
                if (!validateCapabilityShape(candidate))
                    throw capabilityError("Scoped capability exposes an invalid surface.");
                const scopeResult = validateIssuerInstallationScope(candidate.scope, {
                    app: this.identity,
                    target: request.target,
                    requiredPermissions: request.permissions,
                    now: this.#now(),
                });
                if (!scopeResult.valid || scopeResult.value === undefined) {
                    throw internalBoundaryError(scopeResult.diagnostics[0]?.code ?? "ISSUER_CREDENTIAL_BOUNDARY", scopeResult.diagnostics[0]?.path ?? "$.credential", scopeResult.diagnostics[0]?.message ?? "Credential scope was rejected.");
                }
                scope = scopeResult.value;
                for (const effect of request.effects) {
                    try {
                        await candidate.apply(effect);
                    }
                    catch {
                        throw internalBoundaryError("ISSUER_MUTATION_FAILED", "$.effects", "Trusted issuer mutation failed closed.");
                    }
                    applied.push({ kind: effect.kind, status: "applied" });
                }
            });
        }
        catch (error) {
            if (error instanceof IssuerAuthorityError && internalBoundaryErrors.has(error))
                throw error;
            // Never forward broker errors: provider implementations may accidentally
            // include a token, private key, or authorization header in their error.
            throw new IssuerAuthorityError([
                createDiagnostic("ISSUER_CREDENTIAL_BOUNDARY", "$.credential", "Trusted credential operation failed closed."),
            ]);
        }
        if (scope === undefined)
            throw capabilityError("Credential broker did not provide a verified scope.");
        return Object.freeze({
            version: ISSUER_AUTHORITY_CONTRACT_VERSION,
            authority: "issuer",
            issuer: this.identity,
            repository: request.target,
            installation: scope.installation,
            permissions: request.permissions,
            effects: Object.freeze(applied),
        });
    }
    /** Alias for trusted executor integrations; it does not add semantic policy. */
    async apply(input) {
        return this.applyEffects(input);
    }
}
export const IssuerAppAuthority = InariIssuerAppAuthority;
export class IssuerAuthorityError extends Error {
    code;
    path;
    diagnostics;
    constructor(diagnostics) {
        const normalized = normalizeDiagnostics(diagnostics);
        const first = normalized[0] ?? createDiagnostic("ISSUER_CREDENTIAL_BOUNDARY", "$", "Issuer authority rejected the request.");
        super(first.message);
        this.name = "IssuerAuthorityError";
        this.code = first.code;
        this.path = first.path;
        this.diagnostics = normalized;
    }
}
export function createIssuerDiagnosticReport(diagnostics) {
    return Object.freeze({
        version: ISSUER_AUTHORITY_CONTRACT_VERSION,
        diagnostics: normalizeDiagnostics(diagnostics),
    });
}
//# sourceMappingURL=issuer-authority.js.map