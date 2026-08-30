import { ContractViolationError, GhNotInstalledError, GhUnauthenticatedError, GitHubApiError, GitHubApiResponseError, GitHubOutputLimitError, GitHubResourceKindMismatchError, GitHubTimeoutError, GitHubTransportError, InvalidRepositoryOverrideError, RepositoryResolutionError, } from "./errors.js";
import { isTrustedValidatedRenderedArtifact } from "./capability.js";
import { DEFAULT_GH_OUTPUT_LIMITS_BYTES, GhTransportOutputLimitError, GhTransportTimeoutError, ProcessGhTransport, } from "./transport.js";
import { VALIDATED_RENDERED_PHASE, } from "./types.js";
const DEFAULT_HOSTNAME = "github.com";
const UNAUTHENTICATED_MESSAGE_PATTERN = /not logged in|authentication failed|login required|status code 401|\b401\b/iu;
export const DEFAULT_GH_TIMEOUTS_MS = Object.freeze({
    auth: 10_000,
    repositoryResolution: 15_000,
    read: 20_000,
    mutation: 30_000,
});
const OPERATION_CLASSES = Object.freeze({
    "gh.version": "auth",
    "auth.status": "auth",
    "repository.resolve": "repositoryResolution",
    "repository.default_branch": "read",
    "repository.governance.tree": "read",
    "repository.governance.blob": "read",
    "issue.read": "read",
    "pull_request.read": "read",
    "issue.create": "mutation",
    "issue.update": "mutation",
    "pull_request.create": "mutation",
    "pull_request.update": "mutation",
});
function operationClass(operation) {
    const operationClassValue = OPERATION_CLASSES[operation];
    if (operationClassValue === undefined) {
        throw new Error(`No timeout class registered for gh operation "${operation}".`);
    }
    return operationClassValue;
}
/**
 * Rejects invalid overrides outright instead of silently disabling a bound: an
 * explicit `{ auth: undefined }` would otherwise erase the default via spread,
 * and non-finite or non-positive values would produce an unbounded or
 * effectively immediate timer.
 */
function validatedTimeoutOverrides(overrides) {
    if (overrides === undefined)
        return {};
    const validated = {};
    for (const [operationClassKey, value] of Object.entries(overrides)) {
        if (value === undefined)
            continue;
        if (!Number.isFinite(value) || value <= 0) {
            throw new ContractViolationError(`Timeout override for "${operationClassKey}" must be a finite number greater than zero.`, `timeoutsMs.${operationClassKey}`);
        }
        validated[operationClassKey] = value;
    }
    return validated;
}
function validatedOutputLimitOverrides(overrides) {
    if (overrides === undefined)
        return {};
    const validated = {};
    for (const [stream, value] of Object.entries(overrides)) {
        if (value === undefined)
            continue;
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new ContractViolationError(`Output limit for "${stream}" must be a finite non-negative integer.`, `outputLimitsBytes.${stream}`);
        }
        validated[stream] = value;
    }
    return validated;
}
export class GitHubAdapter {
    cwd;
    repository;
    hostname;
    transport;
    executable;
    timeoutsMs;
    outputLimitsBytes;
    availablePromise;
    contextPromise;
    authenticatedHostnames = new Set();
    authenticationPromises = new Map();
    constructor(options = {}) {
        this.cwd = options.cwd;
        this.repository = options.repository;
        this.hostname = options.hostname;
        this.transport = options.transport ?? new ProcessGhTransport();
        this.executable = this.transport instanceof ProcessGhTransport ? this.transport.executable : "gh";
        this.timeoutsMs = Object.freeze({ ...DEFAULT_GH_TIMEOUTS_MS, ...validatedTimeoutOverrides(options.timeoutsMs) });
        this.outputLimitsBytes = Object.freeze({
            ...DEFAULT_GH_OUTPUT_LIMITS_BYTES,
            ...validatedOutputLimitOverrides(options.outputLimitsBytes),
        });
    }
    async checkAuthentication() {
        await this.ensureGhAvailable();
        await this.ensureAuthenticated(this.repositoryHostOverride());
    }
    async resolveRepositoryContext() {
        if (this.contextPromise === undefined) {
            const pending = this.resolveRepositoryContextOnce();
            this.contextPromise = pending;
            pending.catch(() => {
                if (this.contextPromise === pending)
                    this.contextPromise = undefined;
            });
        }
        return this.contextPromise;
    }
    async getRepositoryContext() {
        return this.resolveRepositoryContext();
    }
    /** Read the target repository metadata used to select the trusted governance ref. */
    async getRepositoryDefaultBranch() {
        const context = await this.resolveRepositoryContext();
        const result = await this.runApi(this.apiArguments(context, `repos/${context.nameWithOwner}`, "GET"), "repository.default_branch");
        const record = responseRecord(result, "repository.default_branch");
        const ref = responseString(record.default_branch, "default_branch", "repository.default_branch");
        assertRepositoryRef(ref);
        return ref;
    }
    /** Read the complete Git tree for a trusted repository ref. Truncation is invalid for governance. */
    async getRepositoryTree(ref) {
        assertRepositoryRef(ref);
        const context = await this.resolveRepositoryContext();
        const result = await this.runApi(this.apiArguments(context, `repos/${context.nameWithOwner}/git/trees/${encodeURIComponent(ref)}?recursive=1`, "GET"), "repository.governance.tree");
        return parseRepositoryTree(result, "repository.governance.tree");
    }
    /** Read and decode one blob selected from the trusted repository tree. */
    async getRepositoryBlob(sha) {
        if (sha.trim().length === 0)
            throw new ContractViolationError("Repository blob SHA must not be empty.", "sha");
        const context = await this.resolveRepositoryContext();
        const result = await this.runApi(this.apiArguments(context, `repos/${context.nameWithOwner}/git/blobs/${encodeURIComponent(sha)}`, "GET"), "repository.governance.blob");
        const record = responseRecord(result, "repository.governance.blob");
        const returnedSha = responseString(record.sha, "sha", "repository.governance.blob");
        if (returnedSha !== sha) {
            throw new GitHubApiResponseError("repository.governance.blob", "GitHub returned a repository blob different from the trusted tree entry.", { path: "sha" });
        }
        const encoding = responseString(record.encoding, "encoding", "repository.governance.blob");
        const content = responseString(record.content, "content", "repository.governance.blob");
        if (encoding !== "base64") {
            throw new GitHubApiResponseError("repository.governance.blob", "GitHub returned a repository blob with an unsupported encoding.", { path: "encoding" });
        }
        const normalizedContent = content.replace(/\s/gu, "");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalizedContent)) {
            throw new GitHubApiResponseError("repository.governance.blob", "GitHub returned an invalid base64 repository blob.", { path: "content" });
        }
        const bytes = Buffer.from(normalizedContent, "base64");
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch (error) {
            throw new GitHubApiResponseError("repository.governance.blob", "GitHub returned a repository blob containing invalid UTF-8 byte sequences.", { path: "content" }, error);
        }
    }
    async getIssue(issueNumber) {
        assertIssueNumber(issueNumber, "issue_number");
        const context = await this.resolveRepositoryContext();
        const result = await this.runApi(this.apiArguments(context, `repos/${context.nameWithOwner}/issues/${issueNumber}`, "GET"), "issue.read");
        return parseIssue(result, "issue.read", context.repositoryId);
    }
    async readIssue(issueNumber) {
        return this.getIssue(issueNumber);
    }
    async getPullRequest(pullRequestNumber) {
        assertIssueNumber(pullRequestNumber, "pull_request_number");
        const context = await this.resolveRepositoryContext();
        const result = await this.runApi(this.apiArguments(context, `repos/${context.nameWithOwner}/pulls/${pullRequestNumber}`, "GET"), "pull_request.read");
        return parsePullRequest(result, "pull_request.read");
    }
    async readPullRequest(pullRequestNumber) {
        return this.getPullRequest(pullRequestNumber);
    }
    async createIssue(artifact) {
        assertValidatedRenderedIssueArtifact(artifact);
        const context = await this.resolveRepositoryContext();
        assertArtifactRepository(artifact, context);
        const args = this.apiArguments(context, `repos/${context.nameWithOwner}/issues`, "POST");
        appendRawField(args, "title", artifact.title);
        appendRawField(args, "body", artifact.body);
        appendRawFields(args, "labels[]", artifact.labels);
        appendRawFields(args, "assignees[]", artifact.assignees);
        const result = await this.runApi(args, "issue.create");
        return parseIssue(result, "issue.create", context.repositoryId);
    }
    async updateIssue(issueNumber, artifact) {
        assertIssueNumber(issueNumber, "issue_number");
        assertValidatedRenderedIssueArtifact(artifact);
        const context = await this.resolveRepositoryContext();
        assertArtifactRepository(artifact, context);
        // GitHub's issues API also accepts pull request numbers; read first so a
        // pull request is never silently overwritten with Issue Form content.
        await this.getIssue(issueNumber);
        const args = this.apiArguments(context, `repos/${context.nameWithOwner}/issues/${issueNumber}`, "PATCH");
        appendRawField(args, "title", artifact.title);
        appendRawField(args, "body", artifact.body);
        appendRawFields(args, "labels[]", artifact.labels);
        appendRawFields(args, "assignees[]", artifact.assignees);
        const result = await this.runApi(args, "issue.update");
        return parseIssue(result, "issue.update", context.repositoryId);
    }
    async createPullRequest(artifact) {
        assertValidatedRenderedPullRequestArtifact(artifact);
        const context = await this.resolveRepositoryContext();
        assertArtifactRepository(artifact, context);
        const args = this.apiArguments(context, `repos/${context.nameWithOwner}/pulls`, "POST");
        appendRawField(args, "title", artifact.title);
        appendRawField(args, "body", artifact.body);
        appendRawField(args, "head", artifact.head);
        appendRawField(args, "base", artifact.base);
        appendBooleanField(args, "draft", artifact.draft);
        appendBooleanField(args, "maintainer_can_modify", artifact.maintainerCanModify);
        const result = await this.runApi(args, "pull_request.create");
        return parsePullRequest(result, "pull_request.create");
    }
    async updatePullRequest(pullRequestNumber, artifact) {
        assertIssueNumber(pullRequestNumber, "pull_request_number");
        assertValidatedRenderedPullRequestArtifact(artifact);
        const context = await this.resolveRepositoryContext();
        assertArtifactRepository(artifact, context);
        const args = this.apiArguments(context, `repos/${context.nameWithOwner}/pulls/${pullRequestNumber}`, "PATCH");
        appendRawField(args, "title", artifact.title);
        appendRawField(args, "body", artifact.body);
        appendRawField(args, "base", artifact.base);
        appendBooleanField(args, "maintainer_can_modify", artifact.maintainerCanModify);
        const result = await this.runApi(args, "pull_request.update");
        return parsePullRequest(result, "pull_request.update");
    }
    async resolveRepositoryContextOnce() {
        await this.ensureGhAvailable();
        const override = this.repositoryOverride();
        if (override !== undefined) {
            await this.ensureAuthenticated(override.hostname);
            return override;
        }
        await this.ensureAuthenticated(this.normalizedHostname());
        const result = await this.runCommand(["repo", "view", "--json", "id,nameWithOwner,url"], "repository.resolve");
        if (result.exitCode !== 0) {
            if (UNAUTHENTICATED_MESSAGE_PATTERN.test(result.stderr)) {
                throw new GhUnauthenticatedError(this.normalizedHostname(), summarize(result.stderr));
            }
            throw new RepositoryResolutionError("Unable to resolve the GitHub repository from the current working directory. Check the git remote or provide a repository override.", { operation: "repository.resolve", exitCode: result.exitCode, stderr: summarize(result.stderr) });
        }
        let payload;
        try {
            payload = JSON.parse(result.stdout);
        }
        catch (error) {
            throw new RepositoryResolutionError("gh returned invalid JSON while resolving the current repository.", { operation: "repository.resolve", response: summarize(result.stdout) }, error);
        }
        if (!isRecord(payload) || typeof payload.nameWithOwner !== "string" || !isStableRepositoryId(payload.id)) {
            throw new RepositoryResolutionError("gh returned no valid stable repository identity for the current working directory.", { operation: "repository.resolve", response: summarize(result.stdout) });
        }
        try {
            return repositoryContextFromNameWithOwner(payload.nameWithOwner, typeof payload.url === "string" ? payload.url : undefined, this.normalizedHostname() ?? DEFAULT_HOSTNAME, payload.id);
        }
        catch (error) {
            if (error instanceof RepositoryResolutionError)
                throw error;
            throw new RepositoryResolutionError("gh returned an invalid repository identity.", { operation: "repository.resolve", response: summarize(result.stdout) }, error);
        }
    }
    repositoryOverride() {
        if (this.repository === undefined)
            return undefined;
        return parseRepositoryOverride(this.repository, this.normalizedHostname() ?? DEFAULT_HOSTNAME);
    }
    repositoryHostOverride() {
        const override = this.repositoryOverride();
        if (override !== undefined)
            return override.hostname;
        return this.normalizedHostname();
    }
    normalizedHostname() {
        if (this.hostname === undefined)
            return undefined;
        const value = this.hostname.trim().toLowerCase();
        if (!isValidHostname(value))
            throw new InvalidRepositoryOverrideError(this.hostname);
        return value;
    }
    async ensureGhAvailable() {
        if (this.availablePromise === undefined) {
            const pending = this.ensureGhAvailableOnce();
            this.availablePromise = pending;
            pending.catch(() => {
                if (this.availablePromise === pending)
                    this.availablePromise = undefined;
            });
        }
        return this.availablePromise;
    }
    async ensureGhAvailableOnce() {
        const result = await this.runCommand(["--version"], "gh.version");
        if (result.exitCode !== 0) {
            throw new GhNotInstalledError(this.executable);
        }
    }
    async ensureAuthenticated(hostname) {
        if (this.authenticatedHostnames.has(hostname))
            return;
        let pending = this.authenticationPromises.get(hostname);
        if (pending === undefined) {
            pending = this.ensureAuthenticatedOnce(hostname);
            this.authenticationPromises.set(hostname, pending);
            pending
                .catch(() => undefined)
                .finally(() => {
                this.authenticationPromises.delete(hostname);
            });
        }
        return pending;
    }
    async ensureAuthenticatedOnce(hostname) {
        const args = ["auth", "status"];
        if (hostname !== undefined)
            args.push("--hostname", hostname);
        const result = await this.runCommand(args, "auth.status");
        if (result.exitCode !== 0) {
            throw new GhUnauthenticatedError(hostname, summarize(result.stderr));
        }
        this.authenticatedHostnames.add(hostname);
    }
    async runApi(args, operation) {
        const result = await this.runCommand(args, operation);
        if (result.exitCode !== 0) {
            throw new GitHubApiError(operation, `GitHub API request failed during ${operation}.`, {
                exitCode: result.exitCode,
                stderr: summarize(result.stderr),
            });
        }
        return parseJson(result.stdout, operation);
    }
    async runCommand(args, operation) {
        const timeoutMs = this.timeoutsMs[operationClass(operation)];
        try {
            return await this.transport.run(args, {
                cwd: this.cwd,
                timeoutMs,
                maxStdoutBytes: this.outputLimitsBytes.stdout,
                maxStderrBytes: this.outputLimitsBytes.stderr,
            });
        }
        catch (error) {
            if (error instanceof GhTransportOutputLimitError) {
                throw new GitHubOutputLimitError(operation, error.stream, error.limitBytes, error.outputBytes, error);
            }
            if (error instanceof GhTransportTimeoutError) {
                throw new GitHubTimeoutError(operation, error.timeoutMs, error);
            }
            if (isErrno(error, "ENOENT"))
                throw new GhNotInstalledError(this.executable, error);
            throw new GitHubTransportError(operation, `Unable to execute gh during ${operation}.`, { stderr: error instanceof Error ? summarize(error.message) : undefined }, error);
        }
    }
    apiArguments(context, endpoint, method) {
        return ["api", endpoint, "--hostname", context.hostname, "--method", method];
    }
}
function assertIssueNumber(value, path) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new ContractViolationError("GitHub artifact number must be a positive integer.", path);
    }
}
export function assertValidatedRenderedIssueArtifact(artifact) {
    assertArtifactBase(artifact, "issue");
    if (!isRecord(artifact))
        return;
    assertStringArray(artifact.labels, "labels");
    assertStringArray(artifact.assignees, "assignees");
}
export function assertValidatedRenderedPullRequestArtifact(artifact) {
    assertArtifactBase(artifact, "pull_request");
    if (!isRecord(artifact))
        return;
    assertString(artifact.head, "head");
    assertString(artifact.base, "base");
    assertOptionalBoolean(artifact.draft, "draft");
    assertOptionalBoolean(artifact.maintainerCanModify, "maintainerCanModify");
}
function assertArtifactBase(artifact, kind) {
    if (!isTrustedValidatedRenderedArtifact(artifact)) {
        throw new ContractViolationError("Mutation requires an opaque artifact produced by Inari's trusted preparation boundary.", "artifact");
    }
    if (!isRecord(artifact))
        throw new ContractViolationError("Mutation requires a validated rendered artifact.");
    if (artifact.phase !== VALIDATED_RENDERED_PHASE) {
        throw new ContractViolationError("Mutation requires an artifact produced after contract validation and rendering.", "phase");
    }
    if (artifact.kind !== kind) {
        throw new ContractViolationError(`Expected a validated rendered ${kind} artifact.`, "kind");
    }
    assertString(artifact.title, "title");
    assertString(artifact.body, "body");
    assertProvenance(artifact.provenance);
}
function assertArtifactRepository(artifact, context) {
    const provenance = artifact.provenance;
    if (provenance.repository.host.toLowerCase() !== context.hostname.toLowerCase() ||
        provenance.repository.nameWithOwner !== context.nameWithOwner) {
        throw new ContractViolationError("Mutation artifact provenance does not match the target repository.", "provenance.repository");
    }
}
function assertProvenance(value) {
    if (!isRecord(value)) {
        throw new ContractViolationError("Mutation requires trusted repository/ref provenance.", "provenance");
    }
    if (!isRecord(value.repository) || typeof value.repository.nameWithOwner !== "string") {
        throw new ContractViolationError("Mutation requires trusted repository/ref provenance.", "provenance.repository");
    }
}
function assertString(value, path) {
    if (typeof value !== "string")
        throw new ContractViolationError(`Artifact field ${path} must be a string.`, path);
}
function assertStringArray(value, path) {
    if (value === undefined)
        return;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new ContractViolationError(`Artifact field ${path} must be an array of strings.`, path);
    }
}
function assertOptionalBoolean(value, path) {
    if (value !== undefined && typeof value !== "boolean") {
        throw new ContractViolationError(`Artifact field ${path} must be a boolean.`, path);
    }
}
function appendRawField(args, name, value) {
    if (value !== undefined)
        args.push("--raw-field", `${name}=${value}`);
}
function appendRawFields(args, name, values) {
    if (values === undefined)
        return;
    for (const value of values)
        args.push("--raw-field", `${name}=${value}`);
}
function appendBooleanField(args, name, value) {
    if (value !== undefined)
        args.push("--field", `${name}=${value ? "true" : "false"}`);
}
function parseJson(value, operation) {
    try {
        return JSON.parse(value);
    }
    catch (error) {
        throw new GitHubApiResponseError(operation, `gh returned invalid JSON during ${operation}.`, { response: summarize(value) }, error);
    }
}
function parseIssue(value, operation, repositoryId) {
    const record = responseRecord(value, operation);
    const number = responseNumber(record.number, "number", operation);
    if (record.pull_request !== undefined)
        throw new GitHubResourceKindMismatchError(operation, number);
    const title = responseString(record.title, "title", operation);
    const state = responseState(record.state, operation);
    const url = responseUrl(record, operation);
    const body = record.body === null ? null : responseString(record.body, "body", operation);
    return {
        number,
        title,
        body,
        state,
        url,
        labels: responseNames(record.labels, "labels", operation),
        assignees: responseNames(record.assignees, "assignees", operation),
        ...(repositoryId === undefined ? {} : { repositoryId }),
    };
}
function parsePullRequest(value, operation) {
    const record = responseRecord(value, operation);
    const number = responseNumber(record.number, "number", operation);
    const title = responseString(record.title, "title", operation);
    const state = responseState(record.state, operation);
    const url = responseUrl(record, operation);
    const body = record.body === null ? null : responseString(record.body, "body", operation);
    const draft = responseBoolean(record.draft, "draft", operation);
    const maintainerCanModify = record.maintainer_can_modify === undefined
        ? undefined
        : responseBoolean(record.maintainer_can_modify, "maintainer_can_modify", operation);
    const head = responseRef(record.head, "head", operation);
    const base = responseRef(record.base, "base", operation);
    return {
        number,
        title,
        body,
        state,
        url,
        draft,
        ...(maintainerCanModify === undefined ? {} : { maintainerCanModify }),
        head,
        base,
    };
}
function responseRecord(value, operation) {
    if (!isRecord(value)) {
        throw new GitHubApiResponseError(operation, `GitHub returned an invalid object during ${operation}.`);
    }
    return value;
}
function responseNumber(value, path, operation) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
            path,
        });
    }
    return value;
}
function responseString(value, path, operation) {
    if (typeof value !== "string") {
        throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
            path,
        });
    }
    return value;
}
function responseBoolean(value, path, operation) {
    if (typeof value !== "boolean") {
        throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
            path,
        });
    }
    return value;
}
function responseState(value, operation) {
    if (value !== "open" && value !== "closed") {
        throw new GitHubApiResponseError(operation, `GitHub response state is invalid during ${operation}.`, {
            path: "state",
        });
    }
    return value;
}
function responseUrl(record, operation) {
    return responseString(record.html_url ?? record.url, "url", operation);
}
function responseNames(value, path, operation) {
    if (!Array.isArray(value)) {
        throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
            path,
        });
    }
    return value.map((item, index) => {
        if (!isRecord(item)) {
            throw new GitHubApiResponseError(operation, `GitHub response field ${path}[${index}] is invalid during ${operation}.`, { path: `${path}[${index}]` });
        }
        return responseString(item.name ?? item.login, `${path}[${index}]`, operation);
    });
}
function responseRef(value, path, operation) {
    if (!isRecord(value)) {
        throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
            path,
        });
    }
    return responseString(value.ref, `${path}.ref`, operation);
}
function assertRepositoryRef(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ContractViolationError("Repository governance ref must be a non-empty string.", "ref");
    }
}
function parseRepositoryTree(value, operation) {
    const record = responseRecord(value, operation);
    if (record.truncated !== false) {
        throw new GitHubApiResponseError(operation, "GitHub returned a truncated repository tree; governance authority cannot be established.", { path: "truncated" });
    }
    const sha = responseString(record.sha, "sha", operation);
    if (!Array.isArray(record.tree)) {
        throw new GitHubApiResponseError(operation, "GitHub repository tree response is missing tree entries.", {
            path: "tree",
        });
    }
    const entries = record.tree.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new GitHubApiResponseError(operation, `GitHub repository tree entry ${index} is invalid.`, {
                path: `tree[${index}]`,
            });
        }
        const entryPath = responseString(entry.path, `tree[${index}].path`, operation);
        const entrySha = responseString(entry.sha, `tree[${index}].sha`, operation);
        if (entry.type !== "blob" && entry.type !== "tree") {
            throw new GitHubApiResponseError(operation, `GitHub repository tree entry ${index} has an invalid type.`, {
                path: `tree[${index}].type`,
            });
        }
        return { path: entryPath, type: entry.type, sha: entrySha };
    });
    return { sha, entries };
}
function parseRepositoryOverride(repository, fallbackHostname) {
    const value = repository.trim();
    if (value.length === 0)
        throw new InvalidRepositoryOverrideError(repository);
    if (/^https?:\/\//iu.test(value)) {
        try {
            const url = new URL(value);
            const parts = url.pathname.split("/").filter(Boolean);
            if (parts.length !== 2)
                throw new Error("repository URL path must contain owner and name");
            const name = parts[1].replace(/\.git$/iu, "");
            return repositoryContext(url.hostname, parts[0], name, url.toString());
        }
        catch (error) {
            throw new InvalidRepositoryOverrideError(repository, error);
        }
    }
    const parts = value.split("/");
    try {
        if (parts.length === 2)
            return repositoryContext(fallbackHostname, parts[0], parts[1]);
        if (parts.length === 3)
            return repositoryContext(parts[0], parts[1], parts[2]);
    }
    catch (error) {
        throw new InvalidRepositoryOverrideError(repository, error);
    }
    throw new InvalidRepositoryOverrideError(repository);
}
function repositoryContextFromNameWithOwner(nameWithOwner, url, fallbackHostname, repositoryId) {
    const parts = nameWithOwner.split("/");
    if (parts.length !== 2) {
        throw new RepositoryResolutionError("Repository nameWithOwner must contain exactly owner/name.", {
            path: "nameWithOwner",
        });
    }
    const hostname = url === undefined ? fallbackHostname : repositoryUrlHostname(url, fallbackHostname);
    return repositoryContext(hostname, parts[0], parts[1], url, repositoryId);
}
function repositoryContext(hostname, owner, name, url, repositoryId) {
    const normalizedHostname = hostname.trim().toLowerCase();
    if (!isValidHostname(normalizedHostname) || !isValidRepositorySegment(owner) || !isValidRepositorySegment(name)) {
        throw new RepositoryResolutionError("Repository identity contains an invalid hostname, owner, or name.", {
            path: "repository",
        });
    }
    const nameWithOwner = `${owner}/${name}`;
    return Object.freeze({
        hostname: normalizedHostname,
        host: normalizedHostname,
        owner,
        name,
        nameWithOwner,
        url: url ?? `https://${normalizedHostname}/${nameWithOwner}`,
        ...(repositoryId === undefined ? {} : { repositoryId }),
    });
}
function repositoryUrlHostname(url, fallbackHostname) {
    try {
        return new URL(url).hostname;
    }
    catch {
        return fallbackHostname;
    }
}
function isValidHostname(value) {
    return value.length > 0 && !/[\s/]/u.test(value);
}
function isValidRepositorySegment(value) {
    if (value === "." || value === "..")
        return false;
    return /^[A-Za-z0-9_.-]+$/u.test(value);
}
function isStableRepositoryId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[^\s\/#]+$/u.test(value);
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isErrno(value, code) {
    return isRecord(value) && value.code === code;
}
function summarize(value) {
    if (value === undefined)
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
}
//# sourceMappingURL=adapter.js.map