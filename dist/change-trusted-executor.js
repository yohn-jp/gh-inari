/**
 * Trusted Change execution orchestration.
 *
 * This module is the executable boundary between the semantic Core contracts,
 * the #216 effect adapter, and the #217 issuer authority. It owns sequencing
 * only. Naming, lifecycle validity, idempotency, compensation, and projection
 * semantics remain delegated to the existing Core authorities.
 */
import { CHANGE_TRANSITION_CONTRACT_VERSION, createChangeDiagnostic, planChangeIssuance, planChangeIssuanceRecovery, planChangeRecovery, planChangeReadyTransition, planChangeTransition, projectChangeFromGitHubEvidence, validateGovernedRootIssueEvidence, validateChangeReadyTransition, } from "./change.js";
import { isTrustedInariIssuerPrincipal } from "./issuer-identity.js";
import { changeEffectFailureEvidence } from "./github/change-effect-adapter.js";
import { ISSUER_AUTHORITY_CONTRACT_VERSION, INARI_ISSUER_PRINCIPAL, } from "./github/issuer-authority.js";
import { CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION, } from "./change-executor.js";
import { executeReadyWithXState, } from "./change/machine/ready-execution-machine.js";
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
        const input = await this.readInput(boundRequest);
        const current = projectionFor(input);
        const recoveryRetry = boundRequest.operation === "abort" && isAbortCleanupRecoveryProjection(current);
        if ((!current.valid || current.change === undefined) && !recoveryRetry) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "A valid canonical Change projection is required before a lifecycle transition.", current.diagnostics);
        }
        if (current.change === undefined) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "A canonical Change snapshot is required before a lifecycle transition.", current.diagnostics);
        }
        if (boundRequest.operation === "abort" && !isTrustedInariIssuerPrincipal(current.change.provenance.issuer)) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "The canonical Change issuer provenance is not trusted.", [
                diagnostic("CHANGE_PROVENANCE_ISSUER_MISMATCH", "$.projection.change.provenance.issuer", "The canonical Change issuer provenance is not trusted."),
            ]);
        }
        const plan = planChangeTransition({
            version: CHANGE_TRANSITION_CONTRACT_VERSION,
            transition: boundRequest.operation,
            change: {
                ...current.change,
                provenance: {
                    ...current.change.provenance,
                    ...(boundRequest.requester === undefined ? {} : { requester: boundRequest.requester }),
                },
            },
            target: {
                ...(current.change.projection?.branch === undefined ? {} : { branch: current.change.projection.branch }),
                ...(current.change.projection?.pullRequest === undefined
                    ? {}
                    : { pullRequest: current.change.projection.pullRequest }),
            },
        });
        return this.executeTransition(boundRequest, plan, input);
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
    async executeIssue(request) {
        const input = await this.readInput(request);
        const rootIssueDiagnostics = this.#reader.requiresGovernedIssueValidation || input.governedIssue !== undefined
            ? validateGovernedRootIssueEvidence(input.governedIssue, projectionIdentity(input), input.baseBranch)
            : [];
        if (rootIssueDiagnostics.length > 0) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PRECONDITION_FAILED", "Governed root Issue validation failed before Change issuance planning.", rootIssueDiagnostics);
        }
        // Re-read the complete trusted evidence immediately before planning. The
        // contract provenance carries the governance generation; a changed
        // template/native source therefore cannot authorize the first effect.
        const freshInput = await this.readInput(request);
        const freshRootIssueDiagnostics = this.#reader.requiresGovernedIssueValidation || freshInput.governedIssue !== undefined
            ? validateGovernedRootIssueEvidence(freshInput.governedIssue, projectionIdentity(freshInput), freshInput.baseBranch)
            : [];
        if (freshRootIssueDiagnostics.length > 0) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PRECONDITION_FAILED", "Governed root Issue validation changed before Change issuance planning.", freshRootIssueDiagnostics);
        }
        const validatedGeneration = input.governedIssue?.contract.provenance?.treeSha;
        const freshGeneration = freshInput.governedIssue?.contract.provenance?.treeSha;
        if (validatedGeneration !== undefined && freshGeneration !== validatedGeneration) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PRECONDITION_FAILED", "Repository governance changed before Change issuance planning.", [
                diagnostic("CHANGE_PROVENANCE_CONFLICT", "$.governedIssue.contract.provenance.treeSha", "The validated root Issue governance generation changed before issuance."),
            ]);
        }
        const semanticPullRequestPlan = freshInput.semanticPullRequestPlan;
        if (semanticPullRequestPlan !== undefined &&
            (freshInput.governedIssue?.contract.provenance?.treeSha === undefined ||
                semanticPullRequestPlan.generation.treeSha !== freshInput.governedIssue.contract.provenance.treeSha)) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_PRECONDITION_FAILED", "Semantic PR plan generation changed before Change issuance planning.", [
                diagnostic("CHANGE_PROVENANCE_CONFLICT", "$.semanticPullRequestPlan.generation.treeSha", "The Semantic PR plan generation does not match the trusted repository generation."),
            ]);
        }
        const plannedInput = freshInput;
        const plan = planChangeIssuance(issueProjectionInput(plannedInput, request.requester));
        if (plan.mode === "return-existing") {
            const after = projectionFor(await this.readInput(request));
            verifyProjection(plan, after);
            return {
                projection: after,
                evidence: executionEvidence(request.operation, "returned-existing", request.requester, []),
            };
        }
        const attempts = [];
        for (const effect of plan.effects) {
            try {
                const mutation = await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
                const evidence = mutation.effects[0]?.evidence;
                attempts.push({ effect, status: "succeeded", ...(evidence === undefined ? {} : { evidence }) });
            }
            catch {
                attempts.push({ effect, status: "failed" });
                return this.recoverIssuance(request, plan, attempts, failureFor(effect));
            }
        }
        const after = projectionFor(await this.readInput(request));
        verifyProjection(plan, after);
        return {
            projection: after,
            evidence: executionEvidence(request.operation, "verified", request.requester, effectEvidence(attempts)),
        };
    }
    async recoverIssuance(request, issuance, attempts, failure) {
        if (attempts.length !== 2 || attempts[0]?.status !== "succeeded") {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_EFFECT_FAILED", "A Change effect failed before a compensable partial issuance was established.", [], executionEvidence(request.operation, "failed", request.requester, effectEvidence(attempts), "not-required", failure));
        }
        let failedProjectionInput;
        try {
            failedProjectionInput = await this.readInput(request);
        }
        catch {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_RECOVERY_REQUIRED", "Issuance failed and its partial projection could not be bounded for recovery.", [], executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), "failed", failure));
        }
        let recovery;
        try {
            recovery = planChangeIssuanceRecovery({
                issuance,
                attemptedEffects: attempts,
                failure,
                projection: failedProjectionInput,
            });
        }
        catch {
            const projection = projectionFor(failedProjectionInput);
            return {
                projection: recoveryProjection(projection, recoveryChangeForProjection(issuance, projection)),
                evidence: executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), "failed", failure),
            };
        }
        const compensationEffect = recovery.compensation.plan.effects[0];
        if (compensationEffect === undefined) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_RECOVERY_REQUIRED", "Issuance recovery did not produce an explicit compensation effect.", [], executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), "failed", failure));
        }
        let compensationFailure;
        let compensationStatus = "succeeded";
        try {
            await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, compensationEffect));
        }
        catch {
            compensationStatus = "failed";
            compensationFailure = failureFor(compensationEffect);
        }
        let compensatedProjectionInput;
        try {
            compensatedProjectionInput = await this.readInput(request);
        }
        catch {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_RECOVERY_REQUIRED", "Issuance compensation completed without bounded post-compensation evidence.", [], executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), compensationStatus, failure));
        }
        const projection = projectionFor(compensatedProjectionInput);
        try {
            recovery = planChangeIssuanceRecovery({
                issuance,
                attemptedEffects: attempts,
                failure,
                projection: failedProjectionInput,
                compensation: {
                    status: compensationStatus,
                    projection: compensatedProjectionInput,
                    ...(compensationFailure === undefined ? {} : { failure: compensationFailure }),
                },
            });
        }
        catch {
            return {
                projection: recoveryProjection(projection, recoveryChangeForProjection(issuance, projection)),
                evidence: executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), compensationStatus, failure),
            };
        }
        const evidence = executionEvidence(request.operation, compensationStatus === "succeeded" ? "compensated" : "recovery-required", request.requester, effectEvidence(attempts), compensationStatus, failure);
        return { projection, evidence };
    }
    async executeTransition(request, plan, input) {
        void input;
        const attempts = [];
        if (plan.effects.length === 0) {
            const after = projectionFor(await this.readInput(request));
            verifyProjection(plan, after);
            return {
                projection: after,
                evidence: executionEvidence(request.operation, "returned-existing", request.requester, []),
            };
        }
        for (const effect of plan.effects) {
            try {
                await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
                attempts.push({ effect, status: "succeeded" });
            }
            catch {
                attempts.push({ effect, status: "failed" });
                const failure = failureFor(effect);
                if (request.operation === "abort") {
                    return this.recoverTransition(request, plan, attempts, failure);
                }
                return {
                    projection: projectionFor(await this.readInput(request)),
                    evidence: executionEvidence(request.operation, "failed", request.requester, effectEvidence(attempts), "not-required", failure),
                };
            }
        }
        const after = projectionFor(await this.readInput(request));
        verifyProjection(plan, after);
        return {
            projection: after,
            evidence: executionEvidence(request.operation, "verified", request.requester, effectEvidence(attempts)),
        };
    }
    async recoverTransition(request, transition, attempts, failure) {
        let afterInput;
        try {
            afterInput = await this.readInput(request);
        }
        catch {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_RECOVERY_REQUIRED", "A failed Change transition could not be bounded for recovery.", [], executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), "failed", failure));
        }
        let recovery;
        try {
            recovery = planChangeRecovery({
                transition,
                attemptedEffects: attempts,
                failure,
                projection: afterInput,
            });
        }
        catch (error) {
            const diagnostics = error instanceof ChangeTrustedExecutorError ? error.diagnostics : [];
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_RECOVERY_REQUIRED", "A failed Change transition could not produce a bounded recovery plan.", diagnostics, executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), "failed", failure));
        }
        if (!("transition" in recovery)) {
            throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_RECOVERY_REQUIRED", "A failed Change transition produced an invalid recovery authority result.", [], executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), "failed", failure));
        }
        const after = projectionFor(afterInput);
        return {
            projection: recoveryProjection(after, recovery.result.change),
            evidence: executionEvidence(request.operation, "recovery-required", request.requester, effectEvidence(attempts), "failed", failure),
        };
    }
}
export const GitHubActionsChangeExecutor = TrustedChangeExecutor;
//# sourceMappingURL=change-trusted-executor.js.map