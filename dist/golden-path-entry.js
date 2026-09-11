/**
 * Golden Path entry composition.
 *
 * This module is intentionally a projection boundary. Repository Canon and
 * Semantic Artifact Core prove that the root Issue is governed; Change Core
 * proves whether a canonical Change is absent or healthy and owns the
 * issuance plan. The module only joins those existing results and identifies
 * the one existing operation a caller may invoke. It does not own a
 * lifecycle, branch naming rule, PR identity, persistence, or a transport.
 */
import { CHANGE_PROJECTION_STATUSES, CHANGE_STATES, isChangeDiagnosticCode, planChangeIssuance, projectChangeFromGitHubEvidence, validateChangeIdentity, validateChangeProjectionResult, validateGovernedRootIssueEvidence, } from "./change.js";
import { CHANGE_REMOTE_EXECUTION_OUTCOMES, normalizeChangeRemoteExecutionResult, changeRemoteMutationRequest, changeRemoteReadRequest, } from "./change-executor.js";
import { artifactContractProvenanceFromTemplate, } from "./contract/ir.js";
import { tryMaterializeSemanticArtifact, } from "./contract/semantic-artifact.js";
import { tryProjectSemanticIssue } from "./semantic-issue-projection.js";
/** Version of the transport-neutral entry projection. */
export const GOLDEN_PATH_ENTRY_CONTRACT_VERSION = 1;
export const GOLDEN_PATH_ENTRY_CONTRACT_ID = `urn:inari:golden-path-entry:${GOLDEN_PATH_ENTRY_CONTRACT_VERSION}`;
/** The fields accepted by the pure entry projection (adapter-only fields are excluded). */
const GOLDEN_PATH_ENTRY_INPUT_KEYS = new Set([
    "projection",
    "repository",
    "governedIssue",
    "semanticIntent",
    "preflight",
    "requireGovernedIssue",
    "executionOutcome",
]);
export class GoldenPathEntryProjectionError extends Error {
    diagnostics;
    constructor(diagnostics) {
        super(diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
        this.name = "GoldenPathEntryProjectionError";
        this.diagnostics = diagnostics;
    }
}
const MAX_DIAGNOSTICS = 32;
const MAX_PATH_LENGTH = 160;
const MAX_MESSAGE_LENGTH = 240;
const MAX_REPOSITORY_HOST_LENGTH = 255;
const MAX_REPOSITORY_ID_LENGTH = 128;
const MAX_GOVERNANCE_ID_LENGTH = 255;
const MAX_OPERATION_RESULT_BYTES = 65_536;
const CHANGE_EXECUTION_OUTCOME_SET = new Set(CHANGE_REMOTE_EXECUTION_OUTCOMES);
const CHANGE_PROJECTION_STATUS_SET = new Set(CHANGE_PROJECTION_STATUSES);
const CHANGE_STATE_SET = new Set(CHANGE_STATES);
const RESULT_KEYS = new Set([
    "version",
    "valid",
    "subject",
    "governance",
    "status",
    "action",
    "change",
    "projection",
    "diagnostics",
]);
const STATUS_KEYS = new Set(["changeState", "projectionStatus", "executionOutcome"]);
const ACTION_KEYS = new Set(["operation", "issue", "mode"]);
const SUBJECT_KEYS = new Set(["repositoryHost", "repositoryId", "rootIssue"]);
const GOVERNANCE_KEYS = new Set(["kind", "id", "version", "generation"]);
const GOLDEN_PATH_ENTRY_DIAGNOSTIC_CODE_SET = new Set([
    "GOLDEN_PATH_INPUT_INVALID",
    "GOLDEN_PATH_REPOSITORY_MISMATCH",
    "GOLDEN_PATH_PREFLIGHT_BLOCKED",
    "GOLDEN_PATH_GOVERNANCE_INVALID",
    "GOLDEN_PATH_GOVERNED_ISSUE_REQUIRED",
    "GOLDEN_PATH_SEMANTIC_INTENT_INVALID",
    "GOLDEN_PATH_CHANGE_INVALID",
    "GOLDEN_PATH_CHANGE_UNAVAILABLE",
    "GOLDEN_PATH_CHANGE_NOT_ADMISSIBLE",
    "GOLDEN_PATH_EXECUTION_INVALID",
]);
function isRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function unknownProperties(value, allowed, path) {
    return Object.keys(value)
        .filter((key) => !allowed.has(key))
        .sort(compareStrings)
        .map((key) => diagnostic("GOLDEN_PATH_INPUT_INVALID", `${path}.${key}`, `Property "${key}" is not supported.`));
}
function compareStrings(left, right) {
    return left.localeCompare(right, "en-US");
}
function stableValue(value, stack = new WeakSet()) {
    if (value === null)
        return "null";
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
    if (typeof value === "undefined")
        return "undefined";
    if (typeof value !== "object")
        return `${typeof value}:${String(value)}`;
    if (stack.has(value))
        throw new TypeError("Cyclic value.");
    stack.add(value);
    const result = Array.isArray(value)
        ? `[${value.map((entry) => stableValue(entry, stack)).join(",")}]`
        : isRecord(value)
            ? `{${Object.keys(value)
                .sort(compareStrings)
                .map((key) => `${JSON.stringify(key)}:${stableValue(value[key], stack)}`)
                .join(",")}}`
            : `${typeof value}:${String(value)}`;
    stack.delete(value);
    return result;
}
function boundedText(value, maximum) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001F\u007F]/u.test(value))
        return undefined;
    return value;
}
function diagnostic(code, path, message) {
    return {
        version: GOLDEN_PATH_ENTRY_CONTRACT_VERSION,
        code,
        path: path.slice(0, MAX_PATH_LENGTH),
        message: message.slice(0, MAX_MESSAGE_LENGTH),
    };
}
function normalizeDiagnostics(diagnostics) {
    const unique = new Map();
    for (const entry of diagnostics.slice(0, MAX_DIAGNOSTICS)) {
        if (!isRecord(entry))
            continue;
        const version = entry.version;
        const code = entry.code;
        const path = boundedText(entry.path, MAX_PATH_LENGTH);
        const message = boundedText(entry.message, MAX_MESSAGE_LENGTH);
        if (version !== GOLDEN_PATH_ENTRY_CONTRACT_VERSION)
            continue;
        if (typeof code !== "string" ||
            (!GOLDEN_PATH_ENTRY_DIAGNOSTIC_CODE_SET.has(code) && !isChangeDiagnosticCode(code)) ||
            path === undefined ||
            message === undefined)
            continue;
        const normalized = {
            version,
            code,
            path,
            message,
        };
        unique.set(`${path}\u0000${code}\u0000${message}`, normalized);
    }
    return Object.freeze([...unique.values()].sort((left, right) => compareStrings(left.path, right.path) ||
        compareStrings(left.code, right.code) ||
        compareStrings(left.message, right.message)));
}
function isBoundedDiagnostic(value) {
    if (!isRecord(value))
        return false;
    const code = value.code;
    return (value.version === GOLDEN_PATH_ENTRY_CONTRACT_VERSION &&
        typeof code === "string" &&
        (GOLDEN_PATH_ENTRY_DIAGNOSTIC_CODE_SET.has(code) || isChangeDiagnosticCode(code)) &&
        boundedText(value.path, MAX_PATH_LENGTH) !== undefined &&
        boundedText(value.message, MAX_MESSAGE_LENGTH) !== undefined);
}
function normalizeSemanticDiagnostics(diagnostics) {
    return normalizeDiagnostics(diagnostics.map((entry) => diagnostic("GOLDEN_PATH_SEMANTIC_INTENT_INVALID", entry.path, entry.message)));
}
function projectionLooksLikeResult(value) {
    return isRecord(value) && hasOwn(value, "status") && hasOwn(value, "candidates") && hasOwn(value, "valid");
}
function projectionIdentity(projection) {
    return projection.change?.identity;
}
function inputIdentity(input) {
    if (!isRecord(input) || projectionLooksLikeResult(input) || !isRecord(input.change))
        return undefined;
    const candidate = hasOwn(input.change, "identity") ? input.change.identity : input.change;
    const validated = validateChangeIdentity(candidate);
    return validated.valid ? validated.identity : undefined;
}
function readProjection(input) {
    if (projectionLooksLikeResult(input)) {
        const validated = validateChangeProjectionResult(input);
        if (!validated.valid || validated.projection === undefined) {
            return {
                diagnostics: normalizeDiagnostics(validated.diagnostics.map((entry) => diagnostic("GOLDEN_PATH_CHANGE_INVALID", entry.path, entry.message))),
            };
        }
        return { projection: validated.projection, diagnostics: [] };
    }
    try {
        const projection = projectChangeFromGitHubEvidence(input);
        return { projection, diagnostics: [] };
    }
    catch (error) {
        return {
            diagnostics: [
                diagnostic("GOLDEN_PATH_CHANGE_INVALID", "$.projection", error instanceof Error ? error.message : "Change projection could not be evaluated."),
            ],
        };
    }
}
function identityDiagnostics(identity, repository) {
    if (identity === undefined || repository === undefined)
        return [];
    const diagnostics = [];
    if (identity.repositoryHost.toLowerCase() !== repository.repositoryHost.toLowerCase() ||
        identity.repositoryId !== repository.repositoryId ||
        identity.rootIssue !== repository.rootIssue) {
        diagnostics.push(diagnostic("GOLDEN_PATH_REPOSITORY_MISMATCH", "$.repository", "Repository and root Issue identity do not match the Change projection."));
    }
    return diagnostics;
}
function validateSubject(identity) {
    if (identity === undefined)
        return [];
    const diagnostics = [];
    if (boundedText(identity.repositoryHost, MAX_REPOSITORY_HOST_LENGTH) === undefined) {
        diagnostics.push(diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.projection.change.repositoryHost", "Repository host is invalid."));
    }
    if (boundedText(identity.repositoryId, MAX_REPOSITORY_ID_LENGTH) === undefined) {
        diagnostics.push(diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.projection.change.repositoryId", "Repository ID is invalid."));
    }
    if (!Number.isSafeInteger(identity.rootIssue) || identity.rootIssue < 1) {
        diagnostics.push(diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.projection.change.rootIssue", "Root Issue must be a positive integer."));
    }
    return diagnostics;
}
function artifactProvenance(value) {
    if (!isRecord(value) || value.authority !== "repository-default-branch")
        return undefined;
    if (!isRecord(value.repository) || !isRecord(value.source))
        return undefined;
    const repository = value.repository;
    const source = value.source;
    if (["host", "owner", "name", "nameWithOwner"].some((key) => typeof repository[key] !== "string" || repository[key].length === 0) ||
        (repository.repositoryId !== undefined &&
            (typeof repository.repositoryId !== "string" || repository.repositoryId.length === 0)) ||
        typeof value.ref !== "string" ||
        value.ref.length === 0 ||
        typeof value.treeSha !== "string" ||
        value.treeSha.length === 0 ||
        ["path", "ref", "sha", "digest"].some((key) => typeof source[key] !== "string" || source[key].length === 0)) {
        return undefined;
    }
    return value;
}
function nativeContractProvenance(value) {
    if (!isRecord(value) || !isRecord(value.template))
        return undefined;
    const native = artifactProvenance({ ...value, source: value.template });
    if (native === undefined)
        return undefined;
    return artifactContractProvenanceFromTemplate(value);
}
/** Keep the immutable Canon generation bound across semantic and native views. */
function generationMismatchDiagnostics(semanticIntent, governedIssue) {
    if (semanticIntent === undefined || governedIssue === undefined)
        return [];
    const effective = isRecord(semanticIntent.effectiveContract) ? semanticIntent.effectiveContract : undefined;
    const contract = isRecord(governedIssue.contract) ? governedIssue.contract : undefined;
    const semanticGeneration = effective?.generation;
    const nativeGeneration = nativeContractProvenance(contract?.provenance);
    if (semanticGeneration === undefined || nativeGeneration === undefined)
        return [];
    try {
        if (stableValue(semanticGeneration) === stableValue(nativeGeneration))
            return [];
    }
    catch {
        // The detailed semantic validators own malformed-generation diagnostics.
    }
    return [
        diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.governedIssue.contract.provenance", "Governed Issue evidence is bound to a different repository Canon generation than semantic intent."),
    ];
}
function governanceProjection(semanticIntent, governedIssue) {
    if (semanticIntent !== undefined && isRecord(semanticIntent)) {
        const contract = semanticIntent.effectiveContract;
        if (!isRecord(contract) ||
            typeof contract.id !== "string" ||
            typeof contract.version !== "string" ||
            !isRecord(contract.generation))
            return undefined;
        return {
            kind: "issue",
            id: contract.id.slice(0, MAX_GOVERNANCE_ID_LENGTH),
            version: contract.version,
            generation: artifactProvenance(contract.generation),
        };
    }
    if (governedIssue !== undefined && isRecord(governedIssue.contract)) {
        const contract = governedIssue.contract;
        const identity = isRecord(contract.templateIdentity) ? contract.templateIdentity : undefined;
        const provenance = isRecord(contract.provenance) ? contract.provenance : undefined;
        const id = typeof identity?.id === "string" ? identity.id : "issue";
        const version = typeof contract.version === "string" || typeof contract.version === "number"
            ? String(contract.version)
            : "unknown";
        const generation = nativeContractProvenance(provenance);
        return {
            kind: "issue",
            id: id.slice(0, MAX_GOVERNANCE_ID_LENGTH),
            version,
            ...(generation === undefined ? {} : { generation }),
        };
    }
    return undefined;
}
function validateSemanticIntent(semanticIntent, identity) {
    if (semanticIntent === undefined)
        return { diagnostics: [] };
    const diagnostics = [];
    if (!isRecord(semanticIntent)) {
        return {
            diagnostics: [
                diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.semanticIntent", "Semantic intent must be an object."),
            ],
        };
    }
    const effective = semanticIntent.effectiveContract;
    if (!isRecord(effective) || effective.kind !== "issue" || !isRecord(effective.generation)) {
        diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.semanticIntent.effectiveContract.kind", "An Issue Effective Contract is required."));
        return { diagnostics: normalizeDiagnostics(diagnostics) };
    }
    const materialized = semanticIntent.artifact === undefined
        ? tryMaterializeSemanticArtifact(effective, semanticIntent.input)
        : { valid: true, artifact: semanticIntent.artifact, violations: [] };
    if (!materialized.valid || materialized.artifact === undefined) {
        return { diagnostics: normalizeSemanticDiagnostics(materialized.violations) };
    }
    const artifact = materialized.artifact;
    if (artifact.kind !== effective.kind ||
        artifact.id !== effective.id ||
        artifact.effectiveContractVersion !== effective.version ||
        artifact.artifactContractVersion !== effective.artifactContractVersion) {
        diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.semanticIntent.artifact", "Semantic intent artifact is not bound to the supplied Effective Contract."));
    }
    try {
        if (stableValue(artifact.generation) !== stableValue(effective.generation)) {
            diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.semanticIntent.artifact.generation", "Semantic intent artifact generation does not match the Effective Contract generation."));
        }
    }
    catch {
        diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.semanticIntent.artifact.generation", "Semantic intent generation evidence is not comparable."));
    }
    if (artifact.kind !== "issue") {
        diagnostics.push(diagnostic("GOLDEN_PATH_SEMANTIC_INTENT_INVALID", "$.semanticIntent.artifact.kind", "Semantic entry intent must materialize an Issue artifact."));
    }
    const semanticProjection = tryProjectSemanticIssue({
        artifact,
        capabilities: effective.capabilities,
    });
    if (!semanticProjection.valid)
        diagnostics.push(...normalizeSemanticDiagnostics(semanticProjection.violations));
    if (!isRecord(artifact.generation) || !isRecord(artifact.generation.repository)) {
        diagnostics.push(diagnostic("GOLDEN_PATH_SEMANTIC_INTENT_INVALID", "$.semanticIntent.artifact.generation", "Semantic intent generation evidence is invalid."));
        return { artifact, diagnostics: normalizeDiagnostics(diagnostics) };
    }
    const artifactRepository = artifact.generation.repository;
    if (identity !== undefined &&
        (artifactRepository.host.toLowerCase() !== identity.repositoryHost.toLowerCase() ||
            artifactRepository.repositoryId !== identity.repositoryId)) {
        diagnostics.push(diagnostic("GOLDEN_PATH_REPOSITORY_MISMATCH", "$.semanticIntent.artifact.generation.repository", "Semantic intent belongs to a different repository than the Change projection."));
    }
    return { artifact, diagnostics: normalizeDiagnostics(diagnostics) };
}
/**
 * Bounded evidence carried on the result; this module does not classify it
 * into a Golden Path phase or availability. Owner: sibling status/recovery
 * projection (#409/#410).
 */
function statusFor(projection, executionOutcome) {
    const state = projection.change?.state;
    return {
        ...(state === undefined ? {} : { changeState: state }),
        ...(CHANGE_PROJECTION_STATUS_SET.has(projection.status) ? { projectionStatus: projection.status } : {}),
        ...(executionOutcome === undefined ? {} : { executionOutcome }),
    };
}
function resultFor(projection, diagnostics, governedIssue, semanticIntent, executionOutcome, valid, subjectOverride) {
    const subject = projectionIdentity(projection) ?? subjectOverride;
    const action = valid &&
        projection.valid &&
        (projection.status === "absent" || projection.status === "healthy") &&
        subject !== undefined
        ? {
            operation: "change.issue",
            issue: subject.rootIssue,
            mode: projection.status === "absent" ? "create" : "return-existing",
        }
        : undefined;
    const normalizedDiagnostics = normalizeDiagnostics(diagnostics);
    const status = statusFor(projection, executionOutcome);
    return {
        version: GOLDEN_PATH_ENTRY_CONTRACT_VERSION,
        valid,
        ...(subject === undefined ? {} : { subject }),
        ...(governanceProjection(semanticIntent, governedIssue) === undefined
            ? {}
            : { governance: governanceProjection(semanticIntent, governedIssue) }),
        status,
        ...(action === undefined ? {} : { action }),
        ...(projection.change === undefined ? {} : { change: projection.change }),
        projection,
        diagnostics: normalizedDiagnostics,
    };
}
function invalidResult(diagnostics, projection) {
    const fallback = projection ?? {
        valid: false,
        status: "unavailable",
        candidates: { branches: [], pullRequests: [] },
        diagnostics: [],
    };
    return resultFor(fallback, diagnostics, undefined, undefined, undefined, false, undefined);
}
/**
 * Project a Golden Path entry without any provider effects. The result is
 * deterministic and bounded; invalid/blocked evidence is represented in the
 * result rather than guessed into an issuance action.
 */
export function tryProjectGoldenPathEntry(input) {
    if (!isRecord(input))
        return invalidResult([diagnostic("GOLDEN_PATH_INPUT_INVALID", "$", "Entry input must be an object.")]);
    const structuralDiagnostics = unknownProperties(input, GOLDEN_PATH_ENTRY_INPUT_KEYS, "$");
    if (structuralDiagnostics.length > 0)
        return invalidResult(structuralDiagnostics);
    const rawProjection = input.projection;
    if (rawProjection === undefined) {
        return invalidResult([
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.projection", "Change projection input is required."),
        ]);
    }
    const read = readProjection(rawProjection);
    if (read.projection === undefined)
        return invalidResult(read.diagnostics);
    const projection = read.projection;
    const identity = projectionIdentity(projection) ?? inputIdentity(rawProjection);
    const diagnostics = [...read.diagnostics, ...validateSubject(identity)];
    const explicitRepository = input.repository;
    if (explicitRepository !== undefined && !isRecord(explicitRepository)) {
        diagnostics.push(diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.repository", "Repository identity must be an object."));
    }
    else if (explicitRepository !== undefined) {
        const repositoryResult = validateChangeIdentity(explicitRepository, "$.repository");
        if (!repositoryResult.valid || repositoryResult.identity === undefined) {
            diagnostics.push(...repositoryResult.diagnostics.map((entry) => diagnostic("GOLDEN_PATH_INPUT_INVALID", entry.path, entry.message)));
        }
        else if (identity !== undefined)
            diagnostics.push(...identityDiagnostics(identity, repositoryResult.identity));
    }
    const preflight = input.preflight;
    let preflightGeneration;
    if (preflight !== undefined) {
        if (!isRecord(preflight) ||
            unknownProperties(preflight, new Set(["status", "diagnostics", "generation"]), "$.preflight").length > 0 ||
            (preflight.status !== "ready" && preflight.status !== "blocked")) {
            diagnostics.push(diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.preflight", "Preflight evidence is invalid."));
        }
        else if (preflight.status === "blocked") {
            diagnostics.push(diagnostic("GOLDEN_PATH_PREFLIGHT_BLOCKED", "$.preflight", "Repository preflight did not establish an actionable entry."));
            if (Array.isArray(preflight.diagnostics))
                diagnostics.push(...preflight.diagnostics);
        }
        else if (preflight.generation === undefined) {
            diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.preflight.generation", "Ready repository preflight must carry immutable governance generation evidence."));
        }
        else {
            preflightGeneration = artifactProvenance(preflight.generation);
            if (preflightGeneration === undefined) {
                diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.preflight.generation", "Repository preflight generation evidence is invalid."));
            }
        }
    }
    const semanticIntent = input.semanticIntent;
    let semantic;
    try {
        semantic = validateSemanticIntent(semanticIntent, identity);
    }
    catch {
        semantic = {
            diagnostics: [
                diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.semanticIntent", "Semantic intent could not be evaluated."),
            ],
        };
    }
    diagnostics.push(...semantic.diagnostics);
    if (preflightGeneration !== undefined && isRecord(semanticIntent) && isRecord(semanticIntent.effectiveContract)) {
        try {
            if (stableValue(preflightGeneration) !== stableValue(semanticIntent.effectiveContract.generation)) {
                diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.preflight.generation", "Preflight generation does not match the semantic Effective Contract generation."));
            }
        }
        catch {
            diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.preflight.generation", "Preflight generation evidence is not comparable with the semantic contract."));
        }
    }
    const projectionInput = projectionLooksLikeResult(rawProjection)
        ? undefined
        : rawProjection;
    const governedIssue = input.governedIssue ?? projectionInput?.governedIssue;
    diagnostics.push(...generationMismatchDiagnostics(semanticIntent, governedIssue));
    if (preflightGeneration !== undefined && governedIssue !== undefined) {
        const issueGeneration = nativeContractProvenance(isRecord(governedIssue.contract) ? governedIssue.contract.provenance : undefined);
        if (issueGeneration !== undefined) {
            try {
                if (stableValue(preflightGeneration) !== stableValue(issueGeneration)) {
                    diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.preflight.generation", "Repository preflight and governed Issue evidence use different Canon generations."));
                }
            }
            catch {
                diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.preflight.generation", "Repository preflight generation evidence is not comparable with governed Issue evidence."));
            }
        }
    }
    const requireGovernedIssue = input.requireGovernedIssue !== false;
    // The bypass is only a projection convenience for an already-authorized
    // remote result. It must never turn a confirmed absence into a new
    // issuance, because this facade cannot establish Issue governance itself.
    if (!requireGovernedIssue && projection.status === "absent") {
        diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNED_ISSUE_REQUIRED", "$.governedIssue", "A governed root Issue proof is required before a new Change issuance."));
    }
    if (requireGovernedIssue) {
        if (governedIssue === undefined) {
            diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNED_ISSUE_REQUIRED", "$.governedIssue", "A governed root Issue proof is required before Change issuance."));
        }
        else {
            try {
                diagnostics.push(...normalizeDiagnostics(validateGovernedRootIssueEvidence(governedIssue, identity, projection.canonicalBaseBranch).map((entry) => entry)));
            }
            catch {
                diagnostics.push(diagnostic("GOLDEN_PATH_GOVERNANCE_INVALID", "$.governedIssue", "Governed root Issue evidence could not be evaluated."));
            }
        }
    }
    if (!projection.valid) {
        diagnostics.push(...projection.diagnostics);
    }
    else if (projection.status !== "absent" && projection.status !== "healthy") {
        diagnostics.push(diagnostic("GOLDEN_PATH_CHANGE_NOT_ADMISSIBLE", "$.projection.status", `Change projection status "${projection.status}" cannot enter issuance.`));
    }
    else if (projection.status === "healthy" && projection.change?.state === "RECOVERY_REQUIRED") {
        // Recovery classification/safe-action selection is owned by the sibling
        // Golden Path recovery projection; this entry only refuses to treat a
        // Change awaiting recovery as admissible for ordinary issuance.
        diagnostics.push(diagnostic("GOLDEN_PATH_CHANGE_NOT_ADMISSIBLE", "$.projection.change.state", "A Change in RECOVERY_REQUIRED state cannot enter ordinary issuance."));
    }
    let issuancePlan;
    if (diagnostics.length === 0 && projection.status === "absent" && projectionInput !== undefined) {
        try {
            issuancePlan = planChangeIssuance({
                ...projectionInput,
                ...(governedIssue === undefined ? {} : { governedIssue }),
            });
        }
        catch (error) {
            const issuanceDiagnostics = isRecord(error) && Array.isArray(error.diagnostics)
                ? error.diagnostics
                : [
                    diagnostic("GOLDEN_PATH_CHANGE_NOT_ADMISSIBLE", "$.projection", error instanceof Error ? error.message : "Change issuance planning failed."),
                ];
            diagnostics.push(...normalizeDiagnostics(issuanceDiagnostics));
        }
    }
    const executionOutcome = input.executionOutcome;
    if (executionOutcome !== undefined && !CHANGE_EXECUTION_OUTCOME_SET.has(executionOutcome)) {
        diagnostics.push(diagnostic("GOLDEN_PATH_EXECUTION_INVALID", "$.executionOutcome", "Execution outcome is invalid."));
    }
    else if (executionOutcome === "failed") {
        diagnostics.push(diagnostic("GOLDEN_PATH_EXECUTION_INVALID", "$.executionOutcome", "The Change executor did not verify the requested operation."));
    }
    else if (executionOutcome === "compensated") {
        diagnostics.push(diagnostic("GOLDEN_PATH_EXECUTION_INVALID", "$.executionOutcome", "The Change executor compensated the issuance; no Change was verified."));
    }
    else if (executionOutcome === "recovery-required") {
        // Recovery projection itself is owned by the sibling Golden Path
        // recovery contract; this entry only refuses to expose a normal action.
        diagnostics.push(diagnostic("GOLDEN_PATH_EXECUTION_INVALID", "$.executionOutcome", "The Change executor reported that recovery is required."));
    }
    const valid = diagnostics.length === 0 &&
        projection.valid &&
        (projection.status === "absent" || projection.status === "healthy") &&
        (executionOutcome === undefined || executionOutcome === "verified" || executionOutcome === "returned-existing");
    const result = resultFor(projection, diagnostics, governedIssue, semanticIntent, executionOutcome, valid, identity);
    // Keep the local variable as an explicit assertion that planning is part of
    // admissibility, without leaking the full plan as a second public authority.
    void issuancePlan;
    return result;
}
/** Throwing Core entry point following the existing projection conventions. */
export function projectGoldenPathEntry(input) {
    const result = tryProjectGoldenPathEntry(input);
    if (!result.valid)
        throw new GoldenPathEntryProjectionError(result.diagnostics);
    return result;
}
export const projectGoldenPathEntryResult = tryProjectGoldenPathEntry;
export const planGoldenPathEntry = projectGoldenPathEntry;
/** Validate a previously projected result at an adapter/package boundary. */
export function validateGoldenPathEntryResult(input) {
    if (!isRecord(input)) {
        const diagnostics = [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$", "Golden Path entry result must be an object.")];
        return { valid: false, diagnostics };
    }
    const structuralDiagnostics = unknownProperties(input, RESULT_KEYS, "$");
    if (structuralDiagnostics.length > 0)
        return { valid: false, diagnostics: structuralDiagnostics };
    if (input.version !== GOLDEN_PATH_ENTRY_CONTRACT_VERSION || typeof input.valid !== "boolean") {
        const diagnostics = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.version", "Golden Path entry result version is invalid."),
        ];
        return { valid: false, diagnostics };
    }
    const status = input.status;
    if (!isRecord(status) || unknownProperties(status, STATUS_KEYS, "$.status").length > 0) {
        const diagnostics = [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.status", "Golden Path entry status is invalid.")];
        return { valid: false, diagnostics };
    }
    if (status.changeState !== undefined && !CHANGE_STATE_SET.has(status.changeState)) {
        const diagnostics = [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.status.changeState", "Change state is invalid.")];
        return { valid: false, diagnostics };
    }
    if (status.projectionStatus !== undefined && !CHANGE_PROJECTION_STATUS_SET.has(status.projectionStatus)) {
        const diagnostics = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.status.projectionStatus", "Projection status is invalid."),
        ];
        return { valid: false, diagnostics };
    }
    if (status.executionOutcome !== undefined && !CHANGE_EXECUTION_OUTCOME_SET.has(status.executionOutcome)) {
        const diagnostics = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.status.executionOutcome", "Execution outcome is invalid."),
        ];
        return { valid: false, diagnostics };
    }
    if (!hasOwn(input, "projection")) {
        const diagnostics = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.projection", "Golden Path entry result projection is required."),
        ];
        return { valid: false, diagnostics };
    }
    const projectionValidation = validateChangeProjectionResult(input.projection);
    if (!projectionValidation.valid || projectionValidation.projection === undefined) {
        const diagnostics = projectionValidation.diagnostics.map((entry) => diagnostic("GOLDEN_PATH_CHANGE_INVALID", entry.path, entry.message));
        return { valid: false, diagnostics };
    }
    if (isRecord(input.action)) {
        const action = input.action;
        const actionDiagnostics = unknownProperties(action, ACTION_KEYS, "$.action");
        if (actionDiagnostics.length > 0 ||
            action.operation !== "change.issue" ||
            !Number.isSafeInteger(action.issue) ||
            typeof action.issue !== "number" ||
            action.issue < 1 ||
            (action.mode !== "create" && action.mode !== "return-existing")) {
            const diagnostics = actionDiagnostics.length > 0
                ? actionDiagnostics
                : [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.action", "Entry action is invalid.")];
            return { valid: false, diagnostics };
        }
    }
    else if (input.action !== undefined) {
        const diagnostics = [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.action", "Entry action must be an object.")];
        return { valid: false, diagnostics };
    }
    if (isRecord(input.subject)) {
        const subjectDiagnostics = unknownProperties(input.subject, SUBJECT_KEYS, "$.subject");
        const subject = input.subject;
        const rootIssue = subject.rootIssue;
        if (subjectDiagnostics.length > 0 ||
            boundedText(subject.repositoryHost, MAX_REPOSITORY_HOST_LENGTH) === undefined ||
            boundedText(subject.repositoryId, MAX_REPOSITORY_ID_LENGTH) === undefined ||
            !Number.isSafeInteger(rootIssue) ||
            typeof rootIssue !== "number" ||
            rootIssue < 1) {
            const diagnostics = subjectDiagnostics.length > 0
                ? subjectDiagnostics
                : [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.subject", "Entry subject is invalid.")];
            return { valid: false, diagnostics };
        }
    }
    else if (input.subject !== undefined) {
        const diagnostics = [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.subject", "Entry subject must be an object.")];
        return { valid: false, diagnostics };
    }
    if (isRecord(input.governance)) {
        const governanceDiagnostics = unknownProperties(input.governance, GOVERNANCE_KEYS, "$.governance");
        if (governanceDiagnostics.length > 0 ||
            input.governance.kind !== "issue" ||
            boundedText(input.governance.id, MAX_GOVERNANCE_ID_LENGTH) === undefined ||
            typeof input.governance.version !== "string" ||
            input.governance.version.length === 0) {
            const diagnostics = governanceDiagnostics.length > 0
                ? governanceDiagnostics
                : [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.governance", "Entry governance projection is invalid.")];
            return { valid: false, diagnostics };
        }
    }
    else if (input.governance !== undefined) {
        const diagnostics = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.governance", "Entry governance projection must be an object."),
        ];
        return { valid: false, diagnostics };
    }
    let diagnostics;
    if (!Array.isArray(input.diagnostics)) {
        diagnostics = [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.diagnostics", "Diagnostics must be an array.")];
    }
    else if (input.diagnostics.length > MAX_DIAGNOSTICS) {
        diagnostics = [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.diagnostics", "Diagnostics exceed the bounded count.")];
    }
    else if (input.diagnostics.some((entry) => !isBoundedDiagnostic(entry))) {
        diagnostics = [diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.diagnostics", "Diagnostics contain an invalid entry.")];
    }
    else {
        diagnostics = normalizeDiagnostics(input.diagnostics);
    }
    if (diagnostics.length === 1 && diagnostics[0]?.code === "GOLDEN_PATH_INPUT_INVALID") {
        return { valid: false, diagnostics };
    }
    if (input.valid && diagnostics.length > 0) {
        const consistency = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.valid", "A valid entry result cannot carry diagnostics."),
        ];
        return { valid: false, diagnostics: consistency };
    }
    if (!input.valid && input.action !== undefined) {
        const consistency = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.action", "An invalid entry result cannot expose an action."),
        ];
        return { valid: false, diagnostics: consistency };
    }
    let serialized;
    try {
        serialized = JSON.stringify(input);
    }
    catch {
        const serialization = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$", "Golden Path entry result must be JSON-serializable."),
        ];
        return { valid: false, diagnostics: serialization };
    }
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_OPERATION_RESULT_BYTES) {
        const oversized = [
            diagnostic("GOLDEN_PATH_INPUT_INVALID", "$", "Golden Path entry result exceeds the bounded size."),
        ];
        return { valid: false, diagnostics: oversized };
    }
    return { valid: true, result: input, diagnostics: [] };
}
export function serializeGoldenPathEntryResult(input) {
    const result = validateGoldenPathEntryResult(input);
    if (!result.valid || result.result === undefined)
        throw new GoldenPathEntryProjectionError(result.diagnostics);
    return JSON.stringify(result.result);
}
export async function executeGoldenPathEntry(input) {
    if (input.issue !== undefined && input.repository !== undefined && input.issue !== input.repository.rootIssue) {
        return invalidResult([
            diagnostic("GOLDEN_PATH_REPOSITORY_MISMATCH", "$.issue", "Requested root Issue does not match the supplied repository identity."),
        ]);
    }
    let projection = input.projection;
    if (projection === undefined) {
        const requestedIssue = input.issue ?? input.repository?.rootIssue;
        if (typeof requestedIssue !== "number" || !Number.isSafeInteger(requestedIssue) || requestedIssue < 1) {
            return invalidResult([
                diagnostic("GOLDEN_PATH_INPUT_INVALID", "$.issue", "A positive root Issue is required when entry projection evidence is not supplied."),
            ]);
        }
        const issue = requestedIssue;
        try {
            projection = await input.executor.read(changeRemoteReadRequest(issue, input.requester));
        }
        catch {
            return invalidResult([
                diagnostic("GOLDEN_PATH_EXECUTION_INVALID", "$.executor.read", "Authoritative Change preflight evidence could not be read."),
            ]);
        }
    }
    if (input.issue !== undefined) {
        const observedIdentity = projectionLooksLikeResult(projection)
            ? projectionIdentity(projection)
            : inputIdentity(projection);
        if (observedIdentity !== undefined && observedIdentity.rootIssue !== input.issue) {
            return invalidResult([
                diagnostic("GOLDEN_PATH_REPOSITORY_MISMATCH", "$.projection.change.rootIssue", "Authoritative Change evidence does not match the requested root Issue."),
            ]);
        }
    }
    const projectionInput = {
        projection,
        ...(input.repository === undefined ? {} : { repository: input.repository }),
        ...(input.governedIssue === undefined ? {} : { governedIssue: input.governedIssue }),
        ...(input.semanticIntent === undefined ? {} : { semanticIntent: input.semanticIntent }),
        ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
        ...(input.requireGovernedIssue === undefined ? {} : { requireGovernedIssue: input.requireGovernedIssue }),
        ...(input.executionOutcome === undefined ? {} : { executionOutcome: input.executionOutcome }),
    };
    const preflight = tryProjectGoldenPathEntry(projectionInput);
    if (!preflight.valid || preflight.action === undefined)
        return preflight;
    // Returning a healthy existing Change is a read-only idempotent outcome; no
    // second remote issuance request is necessary and no effect is possible.
    if (preflight.action.mode === "return-existing")
        return preflight;
    const request = changeRemoteMutationRequest("issue", preflight.action.issue, input.requester);
    try {
        const raw = await input.executor.execute(request);
        const execution = normalizeChangeRemoteExecutionResult("issue", raw);
        return tryProjectGoldenPathEntry({
            ...projectionInput,
            projection: execution.projection,
            requireGovernedIssue: false,
            ...(execution.evidence?.outcome === undefined ? {} : { executionOutcome: execution.evidence.outcome }),
        });
    }
    catch {
        // The remote boundary owns its detailed error contract. The entry facade
        // exposes only a bounded, transport-neutral failure and never leaks it.
        return tryProjectGoldenPathEntry({
            ...projectionInput,
            executionOutcome: "failed",
        });
    }
}
/** Compatibility spelling for consumers that name this boundary by composition. */
export const composeGoldenPathEntry = executeGoldenPathEntry;
//# sourceMappingURL=golden-path-entry.js.map