/**
 * Trusted Change execution orchestration.
 *
 * This module is the executable boundary between the semantic Core contracts,
 * the #216 effect adapter, and the #217 issuer authority. It owns sequencing
 * only. Naming, lifecycle validity, idempotency, compensation, and projection
 * semantics remain delegated to the existing Core authorities.
 */
import { CHANGE_TRANSITION_CONTRACT_VERSION, ChangeIssuanceRecoveryValidationError, ChangeIssuanceValidationError, createChangeDiagnostic, planChangeIssuance, planChangeIssuanceRecovery, planChangeRecovery, planChangeReadyTransition, planChangeTransition, projectChangeFromGitHubEvidence, validateGovernedRootIssueEvidence, validateChangeReadyTransition, } from "./change.js";
import { isTrustedInariIssuerPrincipal } from "./issuer-identity.js";
import { changeEffectFailureEvidence } from "./github/change-effect-adapter.js";
import { ISSUER_AUTHORITY_CONTRACT_VERSION, INARI_ISSUER_PRINCIPAL, } from "./github/issuer-authority.js";
import { CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION, } from "./change-executor.js";
import { executeReadyWithXState, } from "./change/machine/ready-execution-machine.js";
import { executeAbortWithXState, } from "./change/machine/abort-execution-machine.js";
import { executeIssuanceWithXState, } from "./change/machine/issuance-execution-machine.js";
export const CHANGE_TRUSTED_EXECUTOR_ERROR_CODES = Object.freeze([
    "CHANGE_EXECUTION_READ_FAILED",
    "CHANGE_EXECUTION_PRECONDITION_FAILED",
    "CHANGE_EXECUTION_EFFECT_FAILED",
    "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
    "CHANGE_EXECUTION_RECOVERY_REQUIRED",
]);
export function isChangeTrustedExecutorErrorCode(value) {
    return CHANGE_TRUSTED_EXECUTOR_ERROR_CODES.includes(value);
}
/** Bounded trusted-execution failure; provider/API details are discarded. */
export class ChangeTrustedExecutorError extends Error {
    code;
    diagnostics;
    evidence;
    constructor(code, message, diagnostics = [], evidence) {
        super(message);
        this.name = "ChangeTrustedExecutorError";
        this.code = code;
        this.diagnostics = Object.freeze([...diagnostics]);
        this.evidence = evidence;
    }
}
function diagnostic(code, path, message) {
    return createChangeDiagnostic({ code, path, message });
}
function requestWithProvenance(input, requester, issuer) {
    const provenance = {
        ...(input.provenance ?? {}),
        ...(requester === undefined ? {} : { requester }),
        ...(issuer === undefined ? {} : { issuer }),
    };
    return { ...input, provenance };
}
function issueProjectionInput(input, requester) {
    return requestWithProvenance(input, requester, INARI_ISSUER_PRINCIPAL);
}
function projectionIdentity(input) {
    const candidate = input.change;
    const raw = typeof candidate === "object" && candidate !== null && "identity" in candidate
        ? candidate.identity
        : candidate;
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const value = raw;
    return typeof value.repositoryHost === "string" &&
        typeof value.repositoryId === "string" &&
        Number.isSafeInteger(value.rootIssue)
        ? raw
        : undefined;
}
function effectEvidence(attempts) {
    return attempts.map((attempt) => ({
        kind: attempt.effect.kind,
        status: attempt.status,
        ...(attempt.evidence?.kind === "CREATE_BRANCH" ? { createdCommitSha: attempt.evidence.createdCommitSha } : {}),
    }));
}
function executionEvidence(operation, outcome, requester, effects, compensation = "not-required", failure) {
    return {
        version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
        operation,
        outcome,
        ...(requester === undefined ? {} : { requester }),
        issuer: INARI_ISSUER_PRINCIPAL,
        effects,
        ...(compensation === undefined ? {} : { compensation }),
        ...(failure === undefined
            ? {}
            : {
                failure: {
                    kind: failure.effect.kind,
                    code: failure.code,
                    message: failure.message,
                },
            }),
    };
}
function projectionFor(input) {
    return projectChangeFromGitHubEvidence(input);
}
function readyInput(input, change, requester) {
    const provenance = change === undefined
        ? undefined
        : {
            ...change.provenance,
            ...(requester === undefined ? {} : { requester }),
        };
    const evidence = input.readyEvidence;
    return {
        ...(change === undefined ? {} : { change: { ...change, provenance } }),
        projection: input,
        ...(evidence?.issue === undefined ? {} : { issue: evidence.issue }),
        ...(evidence?.pullRequest === undefined ? {} : { pullRequest: evidence.pullRequest }),
    };
}
function sameIdentity(left, right) {
    return (left !== undefined &&
        right !== undefined &&
        left.identity.repositoryHost === right.identity.repositoryHost &&
        left.identity.repositoryId === right.identity.repositoryId &&
        left.identity.rootIssue === right.identity.rootIssue);
}
function expectedProjection(plan) {
    return {
        state: plan.result.state,
        branch: plan.result.projection?.branch,
        pullRequest: plan.result.projection?.pullRequest,
    };
}
function isAbortCleanupRecoveryProjection(projection) {
    if (!projection.valid && projection.status !== "partial")
        return false;
    if (projection.change?.state !== "RECOVERY_REQUIRED" || projection.canonicalBranch === undefined)
        return false;
    const canonicalBranches = projection.candidates.branches.filter((candidate) => candidate.classification === "canonical" && candidate.candidate.name === projection.canonicalBranch);
    const canonicalPullRequests = projection.candidates.pullRequests.filter((candidate) => candidate.classification === "canonical" &&
        candidate.candidate.state === "closed" &&
        candidate.candidate.merged === false);
    return canonicalBranches.length === 1 && canonicalPullRequests.length === 1;
}
function recoveryProjection(projection, change) {
    const diagnostics = projection.diagnostics.length > 0
        ? projection.diagnostics
        : [
            diagnostic("CHANGE_PROJECTION_PARTIAL", "$.evidence", "A Change effect failed and cleanup requires governed recovery."),
        ];
    return {
        ...projection,
        valid: false,
        status: "partial",
        change,
        diagnostics,
    };
}
function recoveryChangeForProjection(issuance, projection) {
    return {
        version: CHANGE_TRANSITION_CONTRACT_VERSION,
        identity: issuance.transaction.identity,
        state: "RECOVERY_REQUIRED",
        provenance: projection.change?.provenance ?? issuance.result.provenance,
        ...(projection.change?.projection === undefined ? {} : { projection: projection.change.projection }),
    };
}
function verifyProjection(plan, projection) {
    const expected = expectedProjection(plan);
    const actual = projection.change;
    const diagnostics = [];
    if (!projection.valid || projection.status !== "healthy") {
        diagnostics.push(diagnostic("CHANGE_INVALID_PLAN", "$.projection", "Post-effect projection is not a healthy canonical Change."));
    }
    if (!sameIdentity(actual, plan.result)) {
        diagnostics.push(diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.identity", "Projection identity differs from the plan."));
    }
    if (actual?.state !== expected.state) {
        diagnostics.push(diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.state", "Projection state differs from the plan."));
    }
    if (actual?.projection?.branch !== expected.branch) {
        diagnostics.push(diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.projection.branch", "Projection branch differs from the plan."));
    }
    for (const role of ["requester", "issuer", "implementer", "reviewer", "merger"]) {
        if (plan.result.provenance[role] !== undefined && actual?.provenance[role] !== plan.result.provenance[role]) {
            diagnostics.push(diagnostic("CHANGE_INVALID_PROVENANCE", `$.projection.change.provenance.${role}`, `Projection ${role} provenance differs from the transition plan.`));
        }
    }
    if ("operation" in plan && plan.operation === "issue" && actual?.provenance.issuer !== INARI_ISSUER_PRINCIPAL) {
        diagnostics.push(diagnostic("CHANGE_INVALID_PROVENANCE", "$.projection.change.provenance.issuer", "The canonical issuance projection is not attributed to the Inari issuer."));
    }
    if (expected.pullRequest !== undefined && actual?.projection?.pullRequest !== expected.pullRequest) {
        diagnostics.push(diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.projection.pullRequest", "Projection pull request differs from the plan."));
    }
    if (diagnostics.length > 0) {
        throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "Post-effect Change projection verification failed.", diagnostics);
    }
}
function issuerMutation(execution, target, effect) {
    return {
        version: ISSUER_AUTHORITY_CONTRACT_VERSION,
        authority: "issuer",
        execution,
        target,
        effects: [effect],
    };
}
function failureFor(effect) {
    return changeEffectFailureEvidence(effect);
}
const DEFAULT_ABORT_READ_FAILURE = {
    code: "CHANGE_EXECUTION_READ_FAILED",
    message: "Trusted Change evidence read failed closed.",
    diagnostics: [],
};
export class TrustedChangeExecutor {
    #reader;
    #issuerAuthority;
    #execution;
    #target;
    constructor(options) {
        this.#reader = options.reader;
        this.#issuerAuthority = options.issuerAuthority;
        this.#execution = options.execution;
        this.#target = options.target;
    }
    async read(request) {
        const boundRequest = this.bindRequester(request);
        try {
            return projectionFor(await this.readInput(boundRequest));
        }
        catch (error) {
            if (error instanceof ChangeTrustedExecutorError)
                throw error;
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_READ_FAILED", "Trusted Change evidence read failed closed.");
        }
    }
    async execute(request) {
        const boundRequest = this.bindRequester(request);
        if (boundRequest.operation === "issue")
            return this.executeIssue(boundRequest);
        if (boundRequest.operation === "ready")
            return this.executeReady(boundRequest);
        return this.executeAbort(boundRequest);
    }
    /**
     * Bind semantic provenance to the authenticated trusted runtime actor.
     * Caller input may corroborate that identity, but can never replace it.
     */
    bindRequester(request) {
        const trustedRequester = this.#execution.requester;
        if (trustedRequester !== undefined && request.requester !== undefined && request.requester !== trustedRequester) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PRECONDITION_FAILED", "The Change requester does not match the trusted execution actor.", [
                diagnostic("CHANGE_PROVENANCE_CONFLICT", "$.requester", "Caller requester provenance does not match the authenticated trusted actor."),
            ]);
        }
        if (trustedRequester === undefined || request.requester === trustedRequester)
            return request;
        return { ...request, requester: trustedRequester };
    }
    async executeReady(request) {
        const outcome = await executeReadyWithXState({
            request,
            read: (readyRequest) => this.readReadyInput(readyRequest),
            apply: (effect) => this.applyReadyEffect(effect),
            failureForEffect: (effect) => {
                const failure = failureFor(effect);
                return { code: failure.code, message: failure.message };
            },
            semantics: {
                project: projectionFor,
                validationInput: readyInput,
                validate: validateChangeReadyTransition,
                plan: planChangeReadyTransition,
                verify: (readyRequest, input, projection, plan) => {
                    try {
                        this.verifyReadyProjection(readyRequest, input, projection, plan);
                        return { valid: true, diagnostics: [] };
                    }
                    catch (error) {
                        if (error instanceof ChangeTrustedExecutorError) {
                            return { valid: false, diagnostics: error.diagnostics, message: error.message };
                        }
                        return {
                            valid: false,
                            diagnostics: [],
                            message: "Post-effect Ready projection verification failed.",
                        };
                    }
                },
            },
            results: {
                returnedExisting: (projection) => ({
                    projection,
                    evidence: executionEvidence(request.operation, "returned-existing", request.requester, []),
                }),
                verified: (projection, effect) => ({
                    projection,
                    evidence: executionEvidence(request.operation, "verified", request.requester, [
                        { kind: effect.kind, status: "succeeded" },
                    ]),
                }),
                failed: (projection, effect, effectFailure) => ({
                    projection,
                    evidence: executionEvidence(request.operation, "failed", request.requester, [{ kind: effect.kind, status: "failed" }], "not-required", { effect, code: effectFailure.code, message: effectFailure.message }),
                }),
            },
        });
        if (outcome.kind === "result")
            return outcome.result;
        throw new ChangeTrustedExecutorError(outcome.failure.code, outcome.failure.message, outcome.failure.diagnostics);
    }
    async readReadyInput(request) {
        try {
            return { ok: true, input: await this.readRawInput(request) };
        }
        catch (error) {
            if (error instanceof ChangeTrustedExecutorError) {
                return {
                    ok: false,
                    failure: {
                        code: error.code,
                        message: error.message,
                        diagnostics: error.diagnostics,
                    },
                };
            }
            return {
                ok: false,
                failure: {
                    code: "CHANGE_EXECUTION_READ_FAILED",
                    message: "Trusted Change evidence read failed closed.",
                    diagnostics: [],
                },
            };
        }
    }
    async applyReadyEffect(effect) {
        try {
            await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
            return { ok: true };
        }
        catch {
            const failure = failureFor(effect);
            return { ok: false, failure: { code: failure.code, message: failure.message } };
        }
    }
    verifyReadyProjection(request, input, projection, plan) {
        if (projection.change === undefined) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "Post-effect Change projection verification failed.");
        }
        const validation = validateChangeReadyTransition(readyInput(input, projection.change, request.requester));
        if (!validation.valid || projection.change.state !== "REVIEW") {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "Post-effect Ready projection verification failed.", validation.diagnostics);
        }
        verifyProjection(plan, projection);
    }
    async readInput(request) {
        try {
            const input = requestWithProvenance(await this.#reader.read(request), request.requester, undefined);
            const projection = projectionFor(input);
            if (projection.change?.identity.rootIssue !== request.issue) {
                throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_READ_FAILED", "Trusted Change evidence identity does not match the semantic request.");
            }
            return input;
        }
        catch (error) {
            if (error instanceof ChangeTrustedExecutorError)
                throw error;
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_READ_FAILED", "Trusted Change evidence read failed closed.");
        }
    }
    /** Read normalized evidence without projecting it; the Ready actor owns the next projection state. */
    async readRawInput(request) {
        try {
            return requestWithProvenance(await this.#reader.read(request), request.requester, undefined);
        }
        catch (error) {
            if (error instanceof ChangeTrustedExecutorError)
                throw error;
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_READ_FAILED", "Trusted Change evidence read failed closed.");
        }
    }
    async executeAbort(request) {
        const results = {
            returnedExisting: (projection) => ({
                projection,
                evidence: executionEvidence(request.operation, "returned-existing", request.requester, []),
            }),
            verified: (projection, attempts) => ({
                projection,
                evidence: executionEvidence(request.operation, "verified", request.requester, effectEvidence(attempts)),
            }),
            recoveryRequired: (projection, attempts, failure) => ({
                projection,
                evidence: executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), "failed", { effect: failure.effect, code: failure.code, message: failure.message }),
            }),
        };
        const services = {
            request,
            read: (abortRequest) => this.readAbortInput(abortRequest),
            apply: (effect) => this.applyAbortEffect(effect),
            failureForEffect: (effect) => {
                const failure = failureFor(effect);
                return { code: failure.code, message: failure.message };
            },
            recoveryReadFailure: (abortRequest, attempts, failure) => ({
                code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                message: "A failed Change transition could not be bounded for recovery.",
                diagnostics: [],
                evidence: executionEvidence(abortRequest.operation, "recovery-required", abortRequest.requester, effectEvidence(attempts), "failed", { effect: failure.effect, code: failure.code, message: failure.message }),
            }),
            semantics: {
                project: projectionFor,
                classify: (projection) => {
                    const recoveryRetry = isAbortCleanupRecoveryProjection(projection);
                    if ((!projection.valid || projection.change === undefined) && !recoveryRetry) {
                        return {
                            ok: false,
                            failure: {
                                code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
                                message: "A valid canonical Change projection is required before a lifecycle transition.",
                                diagnostics: projection.diagnostics,
                            },
                        };
                    }
                    if (projection.change === undefined) {
                        return {
                            ok: false,
                            failure: {
                                code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
                                message: "A canonical Change snapshot is required before a lifecycle transition.",
                                diagnostics: projection.diagnostics,
                            },
                        };
                    }
                    if (!isTrustedInariIssuerPrincipal(projection.change.provenance.issuer)) {
                        return {
                            ok: false,
                            failure: {
                                code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
                                message: "The canonical Change issuer provenance is not trusted.",
                                diagnostics: [
                                    diagnostic("CHANGE_PROVENANCE_ISSUER_MISMATCH", "$.projection.change.provenance.issuer", "The canonical Change issuer provenance is not trusted."),
                                ],
                            },
                        };
                    }
                    return { ok: true, phase: recoveryRetry ? "recovery" : "normal" };
                },
                plan: (abortRequest, projection) => {
                    if (projection.change === undefined) {
                        return {
                            ok: false,
                            failure: {
                                code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                                message: "A canonical Change snapshot is required before an abort transition.",
                                diagnostics: projection.diagnostics,
                            },
                        };
                    }
                    try {
                        const plan = planChangeTransition({
                            version: CHANGE_TRANSITION_CONTRACT_VERSION,
                            transition: abortRequest.operation,
                            change: {
                                ...projection.change,
                                provenance: {
                                    ...projection.change.provenance,
                                    ...(abortRequest.requester === undefined ? {} : { requester: abortRequest.requester }),
                                },
                            },
                            target: {
                                ...(projection.change.projection?.branch === undefined
                                    ? {}
                                    : { branch: projection.change.projection.branch }),
                                ...(projection.change.projection?.pullRequest === undefined
                                    ? {}
                                    : { pullRequest: projection.change.projection.pullRequest }),
                            },
                        });
                        return { ok: true, plan };
                    }
                    catch (error) {
                        return {
                            ok: false,
                            failure: {
                                code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                                message: "Abort transition planning failed closed.",
                                diagnostics: error instanceof ChangeTrustedExecutorError ? error.diagnostics : [],
                            },
                        };
                    }
                },
                recover: (abortRequest, transition, attempts, failed, failedInput) => {
                    const failureEvidence = {
                        effect: failed.effect,
                        code: failed.code,
                        message: failed.message,
                    };
                    const evidence = executionEvidence(abortRequest.operation, "recovery-required", abortRequest.requester, effectEvidence(attempts), "failed", failureEvidence);
                    try {
                        const recovery = planChangeRecovery({
                            transition,
                            attemptedEffects: attempts,
                            failure: failureEvidence,
                            projection: failedInput,
                        });
                        if (!("transition" in recovery)) {
                            return {
                                ok: false,
                                failure: {
                                    code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                                    message: "A failed Change transition produced an invalid recovery authority result.",
                                    diagnostics: [],
                                    evidence,
                                },
                            };
                        }
                        const projection = projectionFor(failedInput);
                        return {
                            ok: true,
                            result: results.recoveryRequired(recoveryProjection(projection, recovery.result.change), attempts, failed),
                        };
                    }
                    catch (error) {
                        return {
                            ok: false,
                            failure: {
                                code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                                message: "A failed Change transition could not produce a bounded recovery plan.",
                                diagnostics: error instanceof ChangeTrustedExecutorError ? error.diagnostics : [],
                                evidence,
                            },
                        };
                    }
                },
                verify: (abortRequest, _input, projection, plan) => {
                    try {
                        verifyProjection(plan, projection);
                        return { valid: true, diagnostics: [] };
                    }
                    catch (error) {
                        if (error instanceof ChangeTrustedExecutorError) {
                            return { valid: false, diagnostics: error.diagnostics, message: error.message };
                        }
                        return {
                            valid: false,
                            diagnostics: [],
                            message: "Post-effect Abort projection verification failed.",
                        };
                    }
                },
            },
            results,
        };
        const outcome = await executeAbortWithXState(services);
        if (outcome.kind === "result")
            return outcome.result;
        throw new ChangeTrustedExecutorError(outcome.failure.code, outcome.failure.message, outcome.failure.diagnostics, outcome.failure.evidence);
    }
    async readAbortInput(request) {
        try {
            return { ok: true, input: await this.readRawInput(request) };
        }
        catch (error) {
            if (error instanceof ChangeTrustedExecutorError) {
                return {
                    ok: false,
                    failure: {
                        code: error.code,
                        message: error.message,
                        diagnostics: error.diagnostics,
                        evidence: error.evidence,
                    },
                };
            }
            return { ok: false, failure: { ...DEFAULT_ABORT_READ_FAILURE } };
        }
    }
    async applyAbortEffect(effect) {
        try {
            await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
            return { ok: true };
        }
        catch {
            const failure = failureFor(effect);
            return { ok: false, failure: { code: failure.code, message: failure.message } };
        }
    }
    async executeIssue(request) {
        const services = {
            request,
            read: (issuanceRequest) => this.readIssuanceInput(issuanceRequest),
            apply: (effect) => this.applyIssuanceEffect(effect),
            failureForEffect: (effect) => {
                const failure = failureFor(effect);
                return { code: failure.code, message: failure.message };
            },
            semantics: {
                project: projectionFor,
                validateGovernance: (issuanceInput) => this.validateIssuanceGovernance(issuanceInput),
                validateGovernanceDrift: (initial, fresh) => validateIssuanceGovernanceDrift(initial, fresh),
                plan: (issuanceInput, requester) => {
                    try {
                        return { ok: true, plan: planChangeIssuance(issueProjectionInput(issuanceInput, requester)) };
                    }
                    catch (error) {
                        return {
                            ok: false,
                            failure: {
                                code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                                message: "Change issuance planning failed closed.",
                                diagnostics: error instanceof ChangeIssuanceValidationError ? error.diagnostics : [],
                            },
                        };
                    }
                },
                verify: (issuanceRequest, issuanceInput, projection, plan) => {
                    try {
                        verifyProjection(plan, projection);
                        return { valid: true, diagnostics: [] };
                    }
                    catch (error) {
                        if (error instanceof ChangeTrustedExecutorError) {
                            return { valid: false, diagnostics: error.diagnostics, message: error.message };
                        }
                        return {
                            valid: false,
                            diagnostics: [],
                            message: "Post-effect Change issuance projection verification failed.",
                        };
                    }
                },
                classifyEffectFailureProjection: (projection) => projection.status === "absent" && projection.valid && projection.change?.state === "DEFINED"
                    ? "confirmed-absent"
                    : "unresolved",
                planRecovery: (recoveryInput) => {
                    try {
                        const plan = planChangeIssuanceRecovery({
                            issuance: recoveryInput.issuance,
                            attemptedEffects: recoveryInput.attempts,
                            failure: recoveryInput.failure,
                            projection: recoveryInput.projectionInput,
                            ...(recoveryInput.compensation === undefined
                                ? {}
                                : {
                                    compensation: {
                                        status: recoveryInput.compensation.status,
                                        projection: recoveryInput.compensation.projectionInput,
                                        ...(recoveryInput.compensation.failure === undefined
                                            ? {}
                                            : { failure: recoveryInput.compensation.failure }),
                                    },
                                }),
                        });
                        return { ok: true, plan };
                    }
                    catch (error) {
                        return {
                            ok: false,
                            failure: {
                                code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                                message: "A failed Change issuance could not produce a bounded recovery plan.",
                                diagnostics: error instanceof ChangeIssuanceRecoveryValidationError ? error.diagnostics : [],
                            },
                        };
                    }
                },
            },
            results: {
                returnedExisting: (projection) => ({
                    projection,
                    evidence: executionEvidence(request.operation, "returned-existing", request.requester, []),
                }),
                verified: (projection, attempts) => ({
                    projection,
                    evidence: executionEvidence(request.operation, "verified", request.requester, effectEvidence(attempts)),
                }),
                effectFailed: (attempts, failure) => ({
                    code: "CHANGE_EXECUTION_EFFECT_FAILED",
                    message: "A Change effect failed before a compensable partial issuance was established.",
                    diagnostics: [],
                    evidence: executionEvidence(request.operation, "failed", request.requester, effectEvidence(attempts), "not-required", failure),
                }),
                compensated: (projection, attempts, failure) => ({
                    projection,
                    evidence: executionEvidence(request.operation, "compensated", request.requester, effectEvidence(attempts), "succeeded", failure),
                }),
                recoveryRequired: (projection, attempts, failure, compensationStatus) => ({
                    projection,
                    evidence: executionEvidence(request.operation, compensationStatus === "succeeded" ? "compensated" : "recovery-required", request.requester, effectEvidence(attempts), compensationStatus, failure),
                }),
                recoveryUnsafe: (plan, projection, attempts, failure, compensationStatus) => ({
                    projection: recoveryProjection(projection, recoveryChangeForProjection(plan, projection)),
                    evidence: executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), compensationStatus, failure),
                }),
                recoveryReadFailure: (attempts, failure, compensationStatus) => ({
                    code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                    message: compensationStatus === undefined
                        ? "Issuance failed and its partial projection could not be bounded for recovery."
                        : "Issuance compensation completed without bounded post-compensation evidence.",
                    diagnostics: [],
                    evidence: executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), compensationStatus ?? "failed", failure),
                }),
            },
        };
        const outcome = await executeIssuanceWithXState(services);
        if (outcome.kind === "result")
            return outcome.result;
        throw new ChangeTrustedExecutorError(outcome.failure.code, outcome.failure.message, outcome.failure.diagnostics, outcome.failure.evidence);
    }
    validateIssuanceGovernance(input) {
        return this.#reader.requiresGovernedIssueValidation || input.governedIssue !== undefined
            ? validateGovernedRootIssueEvidence(input.governedIssue, projectionIdentity(input), input.baseBranch)
            : [];
    }
    async readIssuanceInput(request) {
        try {
            return { ok: true, input: await this.readRawInput(request) };
        }
        catch (error) {
            if (error instanceof ChangeTrustedExecutorError) {
                return {
                    ok: false,
                    failure: { code: error.code, message: error.message, diagnostics: error.diagnostics },
                };
            }
            return {
                ok: false,
                failure: {
                    code: "CHANGE_EXECUTION_READ_FAILED",
                    message: "Trusted Change evidence read failed closed.",
                    diagnostics: [],
                },
            };
        }
    }
    async applyIssuanceEffect(effect) {
        try {
            const mutation = await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
            const evidence = mutation.effects[0]?.evidence;
            return { ok: true, ...(evidence === undefined ? {} : { evidence }) };
        }
        catch {
            const failure = failureFor(effect);
            return { ok: false, failure: { code: failure.code, message: failure.message } };
        }
    }
}
function validateIssuanceGovernanceDrift(initial, fresh) {
    const diagnostics = [];
    const validatedGeneration = initial.governedIssue?.contract.provenance?.treeSha;
    const freshGeneration = fresh.governedIssue?.contract.provenance?.treeSha;
    if (validatedGeneration !== undefined && freshGeneration !== validatedGeneration) {
        diagnostics.push(diagnostic("CHANGE_PROVENANCE_CONFLICT", "$.governedIssue.contract.provenance.treeSha", "The validated root Issue governance generation changed before issuance."));
    }
    const semanticPullRequestPlan = fresh.semanticPullRequestPlan;
    if (semanticPullRequestPlan !== undefined &&
        (fresh.governedIssue?.contract.provenance?.treeSha === undefined ||
            semanticPullRequestPlan.generation.treeSha !== fresh.governedIssue.contract.provenance.treeSha)) {
        diagnostics.push(diagnostic("CHANGE_PROVENANCE_CONFLICT", "$.semanticPullRequestPlan.generation.treeSha", "The Semantic PR plan generation does not match the trusted repository generation."));
    }
    return diagnostics;
}
export const GitHubActionsChangeExecutor = TrustedChangeExecutor;
//# sourceMappingURL=change-trusted-executor.js.map