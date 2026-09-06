import { MAX_CHANGE_BRANCH_LENGTH, MAX_CHANGE_COMMIT_SHA_LENGTH, MAX_CHANGE_HOST_LENGTH, validateChangeEffect, } from "../change.js";
export const GITHUB_CHANGE_EFFECT_COMPARE_AND_DELETE_OUTCOMES = Object.freeze([
    "deleted",
    "absent",
    "mismatch",
]);
export const GITHUB_CHANGE_EFFECT_FAILURE_CODES = Object.freeze({
    CREATE_BRANCH: "BRANCH_CREATE_FAILED",
    CREATE_PULL_REQUEST: "PULL_REQUEST_CREATE_FAILED",
    MARK_PULL_REQUEST_READY: "PULL_REQUEST_READY_FAILED",
    CLOSE_PULL_REQUEST: "PULL_REQUEST_CLOSE_FAILED",
    DELETE_BRANCH: "BRANCH_DELETE_FAILED",
});
export const GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES = Object.freeze({
    CREATE_BRANCH: "The branch creation effect failed.",
    CREATE_PULL_REQUEST: "The pull request creation effect failed.",
    MARK_PULL_REQUEST_READY: "The pull request ready effect failed.",
    CLOSE_PULL_REQUEST: "The pull request close effect failed.",
    DELETE_BRANCH: "The branch deletion effect failed.",
});
/** Stable bounded failure evidence for a single explicit effect. */
export function changeEffectFailureEvidence(effect) {
    return {
        effect,
        code: GITHUB_CHANGE_EFFECT_FAILURE_CODES[effect.kind],
        message: GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES[effect.kind],
    };
}
const READY_FOR_REVIEW_MUTATION = "mutation PullRequestReadyForReview($input: MarkPullRequestReadyForReviewInput!) { " +
    "markPullRequestReadyForReview(input: $input) { " +
    "pullRequest { id number state isDraft } } }";
/** Raised before transport execution when the supplied effect is not a Core effect contract value. */
export class GitHubChangeEffectContractError extends Error {
    code = "CHANGE_EFFECT_INVALID";
    diagnostics;
    constructor(diagnostics = []) {
        super("The GitHub Change effect adapter accepts only a valid explicit Core ChangeEffect.");
        this.name = "GitHubChangeEffectContractError";
        this.diagnostics = Object.freeze([...diagnostics]);
    }
}
export class GitHubChangeEffectConfigurationError extends Error {
    code = "GITHUB_CHANGE_EFFECT_CONFIGURATION_INVALID";
    constructor() {
        super("The GitHub Change effect adapter requires a valid repository and transport boundary.");
        this.name = "GitHubChangeEffectConfigurationError";
    }
}
/**
 * Thin projection of one explicit Core effect onto GitHub's API resources.
 * It deliberately executes no plan, retry, idempotency, lifecycle, naming, or
 * compensation logic.
 */
export class GitHubChangeEffectAdapter {
    repository;
    transport;
    constructor(options) {
        assertRepository(options?.repository);
        if (!isRecord(options?.transport) || typeof options.transport.request !== "function") {
            throw new GitHubChangeEffectConfigurationError();
        }
        this.repository = { ...options.repository };
        this.transport = options.transport;
    }
    /** Execute exactly one explicit effect and normalize every execution failure. */
    async execute(effect) {
        const explicitEffect = assertExplicitChangeEffect(effect);
        try {
            return {
                status: "succeeded",
                effect: explicitEffect,
                evidence: await this.executeExplicitEffect(explicitEffect),
            };
        }
        catch {
            return {
                status: "failed",
                effect: explicitEffect,
                failure: createFailureEvidence(explicitEffect),
            };
        }
    }
    async executeExplicitEffect(effect) {
        switch (effect.kind) {
            case "CREATE_BRANCH":
                return this.createBranch(effect);
            case "CREATE_PULL_REQUEST":
                return this.createPullRequest(effect);
            case "MARK_PULL_REQUEST_READY":
                return this.markPullRequestReady(effect);
            case "CLOSE_PULL_REQUEST":
                return this.closePullRequest(effect);
            case "DELETE_BRANCH":
                return this.deleteBranch(effect);
        }
    }
    async createBranch(effect) {
        const baseReference = await this.request({
            method: "GET",
            path: `${this.repositoryPath()}/git/ref/heads/${encodeURIComponent(effect.baseBranch)}`,
        }, 200);
        const baseSha = parseGitReference(baseReference, `refs/heads/${effect.baseBranch}`);
        const createdReference = await this.request({
            method: "POST",
            path: `${this.repositoryPath()}/git/refs`,
            body: { ref: `refs/heads/${effect.branch}`, sha: baseSha },
        }, 201);
        const createdCommitSha = parseGitReference(createdReference, `refs/heads/${effect.branch}`);
        return { kind: effect.kind, branch: effect.branch, baseBranch: effect.baseBranch, createdCommitSha };
    }
    async createPullRequest(effect) {
        const desired = effect.semanticPullRequestPlan?.desired;
        const response = await this.request({
            method: "POST",
            path: `${this.repositoryPath()}/pulls`,
            body: {
                head: desired?.head ?? effect.branch,
                base: desired?.base ?? effect.baseBranch,
                title: desired?.title ?? effect.title,
                body: desired?.body ?? effect.body,
                draft: effect.draft,
                ...(desired?.metadata.maintainerCanModify === undefined
                    ? {}
                    : { maintainer_can_modify: desired.metadata.maintainerCanModify }),
            },
        }, 201);
        const record = responseRecord(response);
        const pullRequest = responseNumber(record.number);
        // GitHub Issue and pull-request numbers share a namespace. Equality here
        // is the observable signature of Issue-to-PR conversion, never a valid
        // Change issuance result.
        if (pullRequest === effect.rootIssue)
            throw new InvalidGitHubResponseError();
        if (record.state !== "open" || record.draft !== true)
            throw new InvalidGitHubResponseError();
        responseBranch(record.head, desired?.head ?? effect.branch);
        responseBranch(record.base, desired?.base ?? effect.baseBranch);
        if (desired !== undefined &&
            desired.metadata.maintainerCanModify !== undefined &&
            record.maintainer_can_modify !== desired.metadata.maintainerCanModify) {
            throw new InvalidGitHubResponseError();
        }
        if (desired !== undefined &&
            ((desired.metadata.labels?.length ?? 0) > 0 || (desired.metadata.assignees?.length ?? 0) > 0)) {
            const metadataResponse = responseRecord(await this.request({
                method: "PATCH",
                path: `${this.repositoryPath()}/issues/${pullRequest}`,
                body: {
                    ...(desired.metadata.labels === undefined ? {} : { labels: desired.metadata.labels }),
                    ...(desired.metadata.assignees === undefined ? {} : { assignees: desired.metadata.assignees }),
                },
            }, 200));
            if (desired.metadata.labels !== undefined)
                responseStringSet(metadataResponse.labels, "name", desired.metadata.labels);
            if (desired.metadata.assignees !== undefined)
                responseStringSet(metadataResponse.assignees, "login", desired.metadata.assignees);
        }
        return {
            kind: effect.kind,
            branch: effect.branch,
            baseBranch: effect.baseBranch,
            rootIssue: effect.rootIssue,
            pullRequest,
        };
    }
    async markPullRequestReady(effect) {
        const current = responseRecord(await this.request({
            method: "GET",
            path: `${this.repositoryPath()}/pulls/${effect.pullRequest}`,
        }, 200));
        if (responseNumber(current.number) !== effect.pullRequest || current.state !== "open" || current.draft !== true) {
            throw new InvalidGitHubResponseError();
        }
        const nodeId = responseBoundedString(current.node_id);
        const response = await this.request({
            method: "POST",
            path: "graphql",
            body: {
                operationName: "PullRequestReadyForReview",
                query: READY_FOR_REVIEW_MUTATION,
                variables: { input: { pullRequestId: nodeId } },
            },
        }, 200);
        const envelope = responseRecord(response);
        if (envelope.errors !== undefined || !isRecord(envelope.data)) {
            throw new InvalidGitHubResponseError();
        }
        const mutation = responseRecord(envelope.data.markPullRequestReadyForReview);
        const record = responseRecord(mutation.pullRequest);
        if (record.id !== nodeId ||
            responseNumber(record.number) !== effect.pullRequest ||
            record.state !== "OPEN" ||
            record.isDraft !== false) {
            throw new InvalidGitHubResponseError();
        }
        return { kind: effect.kind, pullRequest: effect.pullRequest };
    }
    async closePullRequest(effect) {
        const response = await this.request({
            method: "PATCH",
            path: `${this.repositoryPath()}/pulls/${effect.pullRequest}`,
            body: { state: "closed" },
        }, 200);
        const record = responseRecord(response);
        if (responseNumber(record.number) !== effect.pullRequest || record.state !== "closed") {
            throw new InvalidGitHubResponseError();
        }
        return { kind: effect.kind, pullRequest: effect.pullRequest };
    }
    async deleteBranch(effect) {
        const expectedCommitSha = effect.expectedCommitSha;
        if (expectedCommitSha !== undefined)
            return this.deleteBranchIfUnchanged({ ...effect, expectedCommitSha });
        const response = await this.request({
            method: "DELETE",
            path: `${this.repositoryPath()}/git/refs/heads/${encodeURIComponent(effect.branch)}`,
        }, 204);
        if (response !== undefined && response !== null && response !== "")
            throw new InvalidGitHubResponseError();
        return { kind: effect.kind, branch: effect.branch };
    }
    async deleteBranchIfUnchanged(effect) {
        const currentCommitSha = await this.readBranchCommitSha(effect.branch);
        if (currentCommitSha === undefined) {
            return {
                kind: effect.kind,
                branch: effect.branch,
                expectedCommitSha: effect.expectedCommitSha,
                outcome: "absent",
            };
        }
        if (currentCommitSha !== effect.expectedCommitSha)
            throw new InvalidGitHubResponseError();
        if (typeof this.transport.compareAndDeleteBranch !== "function")
            throw new InvalidGitHubResponseError();
        const outcome = await this.transport.compareAndDeleteBranch({
            branch: effect.branch,
            expectedCommitSha: effect.expectedCommitSha,
        });
        if (outcome !== "deleted" && outcome !== "absent")
            throw new InvalidGitHubResponseError();
        return {
            kind: effect.kind,
            branch: effect.branch,
            expectedCommitSha: effect.expectedCommitSha,
            outcome,
        };
    }
    async readBranchCommitSha(branch) {
        let response;
        try {
            response = await this.transport.request({
                hostname: this.repository.hostname,
                method: "GET",
                path: `${this.repositoryPath()}/git/ref/heads/${encodeURIComponent(branch)}`,
            });
        }
        catch {
            throw new InvalidGitHubResponseError();
        }
        if (!isRecord(response) || !isHttpStatus(response.status))
            throw new InvalidGitHubResponseError();
        if (response.status === 404)
            return undefined;
        if (response.status !== 200)
            throw new InvalidGitHubResponseError();
        return parseGitReference(response.body, `refs/heads/${branch}`);
    }
    async request(request, expectedStatus) {
        try {
            const response = await this.transport.request({ ...request, hostname: this.repository.hostname });
            if (!isRecord(response) || !isHttpStatus(response.status) || response.status !== expectedStatus) {
                throw new InvalidGitHubResponseError();
            }
            return response.body;
        }
        catch (error) {
            if (error instanceof InvalidGitHubResponseError)
                throw error;
            throw new InvalidGitHubResponseError();
        }
    }
    repositoryPath() {
        return `repos/${this.repository.owner}/${this.repository.name}`;
    }
}
function assertExplicitChangeEffect(input) {
    try {
        const result = validateChangeEffect(input);
        if (!result.valid || result.effect === undefined)
            throw new GitHubChangeEffectContractError(result.diagnostics);
    }
    catch (error) {
        if (error instanceof GitHubChangeEffectContractError)
            throw error;
        throw new GitHubChangeEffectContractError();
    }
    // Keep the caller's explicit values. Core validation is a gate, not an
    // instruction for this adapter to canonicalize or repair the effect.
    return input;
}
function createFailureEvidence(effect) {
    return changeEffectFailureEvidence(effect);
}
function parseGitReference(value, expectedRef) {
    const record = responseRecord(value);
    if (record.ref !== expectedRef || !isRecord(record.object) || record.object.type !== "commit") {
        throw new InvalidGitHubResponseError();
    }
    return responseCommitSha(record.object.sha);
}
function responseBranch(value, expected) {
    if (!isRecord(value) || value.ref !== expected)
        throw new InvalidGitHubResponseError();
}
function responseRecord(value) {
    if (!isRecord(value))
        throw new InvalidGitHubResponseError();
    return value;
}
function responseNumber(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new InvalidGitHubResponseError();
    }
    return value;
}
function responseBoundedString(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_CHANGE_BRANCH_LENGTH ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        throw new InvalidGitHubResponseError();
    }
    return value;
}
function responseCommitSha(value) {
    if (typeof value !== "string" || value.length !== MAX_CHANGE_COMMIT_SHA_LENGTH || !/^[0-9a-f]{40}$/iu.test(value)) {
        throw new InvalidGitHubResponseError();
    }
    return value.toLowerCase();
}
function responseStringSet(value, property, expected) {
    if (!Array.isArray(value))
        throw new InvalidGitHubResponseError();
    const actual = value.map((entry) => {
        if (!isRecord(entry))
            throw new InvalidGitHubResponseError();
        return responseBoundedString(entry[property]);
    });
    const sort = (items) => [...items].sort((left, right) => left.localeCompare(right, "en-US"));
    if (JSON.stringify(sort(actual)) !== JSON.stringify(sort(expected)))
        throw new InvalidGitHubResponseError();
}
function assertRepository(value) {
    if (!isRecord(value) ||
        !validHostname(value.hostname) ||
        !validRepositorySegment(value.owner) ||
        !validRepositorySegment(value.name)) {
        throw new GitHubChangeEffectConfigurationError();
    }
}
function validHostname(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_CHANGE_HOST_LENGTH &&
        !/[\u0000-\u001F\u007F\s/]/u.test(value));
}
function validRepositorySegment(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_CHANGE_BRANCH_LENGTH &&
        /^[A-Za-z0-9_.-]+$/u.test(value));
}
function isHttpStatus(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
class InvalidGitHubResponseError extends Error {
    constructor() {
        super("GitHub response was invalid.");
        this.name = "InvalidGitHubResponseError";
    }
}
//# sourceMappingURL=change-effect-adapter.js.map