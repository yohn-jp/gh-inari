/**
 * GitHub Actions trusted runtime for Change plans.
 *
 * The workflow supplies only a semantic request. This module resolves bounded
 * GitHub evidence, invokes Core planning, applies explicit effects through the
 * #217 issuer authority, and verifies a fresh #213 projection.
 */
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deriveCanonicalBranchIdentity, } from "../change.js";
import { CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION, changeRemoteMutationRequest, } from "../change-executor.js";
import { TrustedChangeExecutor } from "../change-trusted-executor.js";
import { GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES, GitHubChangeEffectAdapter, } from "./change-effect-adapter.js";
import { InariIssuerAppAuthority, assertTrustedExecution, } from "./issuer-authority.js";
import { INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";
import { parsePullRequestPolicyOverlay } from "../pr-policy.js";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PULL_REQUESTS = 100;
const MAX_TITLE_LENGTH = 255;
const MAX_LOGIN_LENGTH = 160;
const DEFAULT_API_URL = "https://api.github.com";
const ISSUE_TITLE_PATTERN = /^(feat|fix|docs|refactor|test|chore):\s*(.+)$/iu;
const ISSUER_LOGIN_NAMES = new Set(["inari-issuer[bot]", "inari-issuer"]);
export class GitHubActionsChangeExecutorError extends Error {
    code = "CHANGE_ACTIONS_RUNTIME_INVALID";
    constructor(message = "Trusted Change Actions runtime configuration is invalid.") {
        super(message);
        this.name = "GitHubActionsChangeExecutorError";
    }
}
function record(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new GitHubActionsChangeExecutorError();
    }
    return value;
}
function boundedString(value, maxLength) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        throw new GitHubActionsChangeExecutorError();
    }
    return value;
}
function boundedSecret(value, maxLength) {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000\u007F]/u.test(value)) {
        throw new GitHubActionsChangeExecutorError();
    }
    return value;
}
function positiveNumber(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new GitHubActionsChangeExecutorError();
    }
    return value;
}
function parseRepository(value, hostname = "github.com") {
    const parts = value.split("/");
    if (parts.length !== 2)
        throw new GitHubActionsChangeExecutorError();
    return {
        hostname: boundedString(hostname, 255),
        owner: boundedString(parts[0], 255),
        name: boundedString(parts[1], 255),
    };
}
function repositoryName(repository) {
    return `${repository.owner}/${repository.name}`;
}
function apiPath(repository, suffix) {
    return `repos/${repository.owner}/${repository.name}/${suffix}`;
}
async function boundedBody(response) {
    if (response.status === 204)
        return undefined;
    if (response.body === null)
        return undefined;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            size += next.value.byteLength;
            if (size > MAX_RESPONSE_BYTES)
                throw new GitHubActionsChangeExecutorError();
            chunks.push(next.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    if (chunks.length === 0)
        return undefined;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.trim().length === 0)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        throw new GitHubActionsChangeExecutorError();
    }
}
/** A bounded credential-bound transport. The bearer never appears in results. */
export class GitHubActionsApiTransport {
    #apiUrl;
    #token;
    #fetch;
    constructor(options) {
        this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/u, "");
        this.#token = boundedString(options.token, 4096);
        this.#fetch = options.fetch ?? globalThis.fetch;
    }
    async request(request) {
        try {
            const response = await this.#fetch(`${this.#apiUrl}/${request.path}`, {
                method: request.method,
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${this.#token}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                    ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            });
            return { status: response.status, body: await boundedBody(response) };
        }
        catch {
            throw new GitHubActionsChangeExecutorError();
        }
    }
}
function base64Url(value) {
    return Buffer.from(value, "utf8").toString("base64url");
}
function createAppJwt(appId, privateKeyPem, now = Date.now()) {
    const issuedAt = Math.floor(now / 1000) - 60;
    const payload = { iat: issuedAt, exp: issuedAt + 540, iss: appId };
    const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const encodedPayload = base64Url(JSON.stringify(payload));
    const signer = createSign("RSA-SHA256");
    signer.update(`${encodedHeader}.${encodedPayload}`);
    return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKeyPem, "base64url")}`;
}
/** #217 broker implementation used only inside the protected Actions job. */
export class GitHubActionsCredentialBroker {
    #options;
    #fetch;
    constructor(options) {
        this.#options = options;
        this.#fetch = options.fetch ?? globalThis.fetch;
        boundedString(options.appId, 20);
        boundedString(options.installationId, 20);
        boundedSecret(options.privateKeyPem, 16_384);
    }
    async withScopedInstallationCredential(request, operation) {
        const credential = await this.issueInstallationToken(request);
        const transport = new GitHubActionsApiTransport({
            apiUrl: this.#options.apiUrl,
            token: credential.token,
            fetch: this.#fetch,
        });
        const adapter = new GitHubChangeEffectAdapter({ repository: this.#options.repository, transport });
        const capability = {
            scope: credential.scope,
            apply: async (effect) => {
                const result = await adapter.execute(effect);
                if (result.status === "failed") {
                    // #217 deliberately sanitizes this provider failure at its boundary.
                    throw new GitHubActionsChangeExecutorError(GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES[effect.kind]);
                }
            },
        };
        await operation(capability);
    }
    async issueInstallationToken(request) {
        if (request.target.repositoryHost !== this.#options.target.repositoryHost ||
            request.target.repositoryId !== this.#options.target.repositoryId ||
            request.target.nameWithOwner !== this.#options.target.nameWithOwner ||
            repositoryName(this.#options.repository) !== this.#options.target.nameWithOwner) {
            throw new GitHubActionsChangeExecutorError();
        }
        const apiUrl = (this.#options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/u, "");
        const response = await this.#fetch(`${apiUrl}/app/installations/${this.#options.installationId}/access_tokens`, {
            method: "POST",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${createAppJwt(this.#options.appId, this.#options.privateKeyPem)}`,
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({
                repositories: [this.#options.repository.name],
                permissions: request.permissions,
            }),
        });
        if (response.status !== 201)
            throw new GitHubActionsChangeExecutorError();
        const body = record(await boundedBody(response));
        const token = boundedString(body.token, 4096);
        const expiresAt = boundedString(body.expires_at, 64);
        const permissions = record(body.permissions);
        const repositories = Array.isArray(body.repositories) ? body.repositories : [];
        const selected = repositories.some((candidate) => {
            if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
                return false;
            const value = candidate;
            return String(value.id) === request.target.repositoryId && value.full_name === request.target.nameWithOwner;
        });
        if (!selected)
            throw new GitHubActionsChangeExecutorError();
        const scope = {
            app: request.app,
            installation: {
                appId: request.app.appId,
                installationId: this.#options.installationId,
                repositoryHost: request.target.repositoryHost,
            },
            repository: request.target,
            repositorySelection: "selected",
            permissions: permissions,
            expiresAt,
        };
        return { token, scope };
    }
}
function issuerPrincipal(login) {
    return ISSUER_LOGIN_NAMES.has(login) ? INARI_ISSUER_PRINCIPAL : login;
}
function deriveNaming(title) {
    const match = ISSUE_TITLE_PATTERN.exec(title);
    if (match === null)
        throw new GitHubActionsChangeExecutorError();
    const type = match[1].toLowerCase();
    const slug = match[2]
        .normalize("NFKD")
        .replace(/[\u0300-\u036F]/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    if (slug.length === 0)
        throw new GitHubActionsChangeExecutorError();
    return { type, slug };
}
export const deriveChangeNamingFromIssueTitle = deriveNaming;
/** Converts only bounded GitHub fields into the #213 Core evidence contract. */
export class GitHubActionsEvidenceReader {
    #options;
    constructor(options) {
        this.#options = options;
    }
    async read(request) {
        if (request.issue !== this.#options.identity.rootIssue) {
            throw new GitHubActionsChangeExecutorError();
        }
        const repositoryResponse = await this.request({ method: "GET", path: apiPath(this.#options.repository, "") }, 200);
        const repository = record(repositoryResponse);
        if (String(repository.id) !== this.#options.identity.repositoryId)
            throw new GitHubActionsChangeExecutorError();
        const baseBranch = boundedString(repository.default_branch, 255);
        const issueResponse = await this.request({ method: "GET", path: apiPath(this.#options.repository, `issues/${request.issue}`) }, 200);
        const issue = record(issueResponse);
        const issueNumber = positiveNumber(issue.number);
        const title = boundedString(issue.title, MAX_TITLE_LENGTH);
        const state = issue.state === "open" || issue.state === "closed" ? issue.state : undefined;
        if (issueNumber !== request.issue || state === undefined)
            throw new GitHubActionsChangeExecutorError();
        const naming = deriveNaming(title);
        const derivation = deriveCanonicalBranchIdentity({
            change: this.#options.identity,
            branchGovernance: this.#options.branchGovernance,
            naming,
        });
        if (!derivation.valid || derivation.branch === undefined)
            throw new GitHubActionsChangeExecutorError();
        const branch = await this.readBranch(derivation.branch);
        const pullRequests = await this.readPullRequests(derivation.branch);
        return {
            change: this.#options.identity,
            branchGovernance: this.#options.branchGovernance,
            naming,
            baseBranch,
            evidence: {
                issue: { status: "available", value: { number: issueNumber, state } },
                branches: { status: "available", value: branch ? [{ name: derivation.branch }] : [] },
                pullRequests: { status: "available", value: pullRequests },
            },
        };
    }
    async readBranch(branch) {
        const response = await this.#options.transport.request({
            hostname: this.#options.repository.hostname,
            method: "GET",
            path: apiPath(this.#options.repository, `git/ref/heads/${encodeURIComponent(branch)}`),
        });
        if (response.status === 404)
            return false;
        if (response.status !== 200)
            throw new GitHubActionsChangeExecutorError();
        const value = record(response.body);
        if (value.ref !== `refs/heads/${branch}`)
            throw new GitHubActionsChangeExecutorError();
        return true;
    }
    async readPullRequests(branch) {
        const response = await this.#options.transport.request({
            hostname: this.#options.repository.hostname,
            method: "GET",
            path: apiPath(this.#options.repository, `pulls?state=all&head=${encodeURIComponent(`${this.#options.repository.owner}:${branch}`)}&per_page=${MAX_PULL_REQUESTS}`),
        });
        if (response.status !== 200 || !Array.isArray(response.body) || response.body.length >= MAX_PULL_REQUESTS) {
            throw new GitHubActionsChangeExecutorError();
        }
        return response.body.map((candidate) => {
            const value = record(candidate);
            const head = record(value.head);
            const base = record(value.base);
            const user = record(value.user);
            const state = value.state === "open" || value.state === "closed" ? value.state : undefined;
            if (state === undefined || typeof value.draft !== "boolean")
                throw new GitHubActionsChangeExecutorError();
            const login = boundedString(user.login, MAX_LOGIN_LENGTH);
            return {
                number: positiveNumber(value.number),
                head: boundedString(head.ref, 255),
                base: boundedString(base.ref, 255),
                state,
                draft: value.draft,
                ...(state === "closed" ? { merged: value.merged_at !== null } : { merged: false }),
                provenance: { issuer: issuerPrincipal(login) },
            };
        });
    }
    async request(request, expected) {
        const response = await this.#options.transport.request({
            ...request,
            hostname: this.#options.repository.hostname,
        });
        if (response.status !== expected)
            throw new GitHubActionsChangeExecutorError();
        return response.body;
    }
}
async function loadBranchGovernance(cwd) {
    try {
        const source = await readFile(path.join(cwd, ".github", "inari", "pr-policy.yml"), "utf8");
        const overlay = parsePullRequestPolicyOverlay(source);
        if (overlay.branch === undefined)
            throw new GitHubActionsChangeExecutorError();
        return overlay.branch;
    }
    catch {
        throw new GitHubActionsChangeExecutorError();
    }
}
function requiredEnvironment(environment, key) {
    const value = environment[key];
    if (value === undefined)
        throw new GitHubActionsChangeExecutorError();
    return boundedString(value, 16_384);
}
/** Build the trusted executor from GitHub Actions runtime claims and secrets. */
export async function createGitHubActionsChangeExecutor(options) {
    const environment = options.environment ?? process.env;
    const repositoryNameWithOwner = requiredEnvironment(environment, "GITHUB_REPOSITORY");
    let hostname = "github.com";
    if (environment.GITHUB_SERVER_URL !== undefined) {
        try {
            hostname = new URL(environment.GITHUB_SERVER_URL).hostname;
        }
        catch {
            throw new GitHubActionsChangeExecutorError();
        }
    }
    const repository = parseRepository(repositoryNameWithOwner, hostname);
    const readTransport = new GitHubActionsApiTransport({
        apiUrl: environment.GITHUB_API_URL ?? DEFAULT_API_URL,
        token: requiredEnvironment(environment, "GITHUB_TOKEN"),
        fetch: options.fetch,
    });
    const repositoryResponse = await readTransport.request({
        hostname: repository.hostname,
        method: "GET",
        path: apiPath(repository, ""),
    });
    if (repositoryResponse.status !== 200)
        throw new GitHubActionsChangeExecutorError();
    const repositoryBody = record(repositoryResponse.body);
    const repositoryId = String(repositoryBody.id);
    if (!/^[1-9][0-9]{0,19}$/u.test(repositoryId))
        throw new GitHubActionsChangeExecutorError();
    const target = {
        repositoryHost: repository.hostname,
        repositoryId,
        nameWithOwner: repositoryNameWithOwner,
    };
    const workflowRef = requiredEnvironment(environment, "GITHUB_WORKFLOW_REF").split("@").at(-1);
    const workflowSha = requiredEnvironment(environment, "GITHUB_WORKFLOW_SHA");
    const execution = assertTrustedExecution({
        version: 1,
        runtime: "github-actions",
        event: requiredEnvironment(environment, "GITHUB_EVENT_NAME"),
        repository: target,
        workflowRef,
        workflowSha,
        workflowTrust: "protected",
        codeExecution: "trusted-only",
        fork: false,
        pullRequest: false,
        ...(environment.GITHUB_ACTOR === undefined ? {} : { requester: environment.GITHUB_ACTOR }),
    });
    const branchGovernance = await loadBranchGovernance(options.cwd);
    const reader = new GitHubActionsEvidenceReader({
        repository,
        identity: { repositoryHost: repository.hostname, repositoryId, rootIssue: options.request.issue },
        branchGovernance,
        transport: readTransport,
    });
    const broker = new GitHubActionsCredentialBroker({
        appId: requiredEnvironment(environment, "INARI_ISSUER_APP_ID"),
        installationId: requiredEnvironment(environment, "INARI_ISSUER_INSTALLATION_ID"),
        privateKeyPem: boundedSecret(environment.INARI_ISSUER_APP_PRIVATE_KEY, 16_384),
        repository,
        target,
        apiUrl: environment.GITHUB_API_URL ?? DEFAULT_API_URL,
        fetch: options.fetch,
    });
    const authority = new InariIssuerAppAuthority({
        appId: requiredEnvironment(environment, "INARI_ISSUER_APP_ID"),
        broker,
    });
    return new TrustedChangeExecutor({ reader, issuerAuthority: authority, execution, target });
}
function sanitizedFailure(error) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
        const value = error;
        return {
            code: value.code,
            message: typeof value.message === "string" ? value.message : "Trusted Change execution failed.",
            ...(Array.isArray(value.diagnostics) ? { diagnostics: value.diagnostics } : {}),
            ...(typeof value.evidence === "object" && value.evidence !== null ? { evidence: value.evidence } : {}),
        };
    }
    return { code: "CHANGE_ACTIONS_RUNTIME_INVALID", message: "Trusted Change execution failed closed." };
}
/** Workflow entrypoint. It emits one bounded JSON result and never logs secrets. */
export async function runGitHubActionsChangeExecutor(environment = process.env, cwd = process.cwd()) {
    try {
        const serialized = requiredEnvironment(environment, "INARI_CHANGE_REQUEST");
        const requestValue = JSON.parse(serialized);
        if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
            throw new GitHubActionsChangeExecutorError();
        }
        const requestRecord = requestValue;
        if (requestRecord.version !== CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION ||
            typeof requestRecord.operation !== "string" ||
            typeof requestRecord.issue !== "number") {
            throw new GitHubActionsChangeExecutorError();
        }
        const request = changeRemoteMutationRequest(requestRecord.operation, requestRecord.issue, typeof requestRecord.requester === "string" ? requestRecord.requester : undefined);
        const executor = await createGitHubActionsChangeExecutor({ cwd, request, environment });
        const result = await executor.execute(request);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    }
    catch (error) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: sanitizedFailure(error) })}\n`);
        return 1;
    }
}
const invokedPath = process.argv[1];
if (invokedPath !== undefined && invokedPath.endsWith("actions-change-executor.js")) {
    runGitHubActionsChangeExecutor().then((exitCode) => {
        process.exitCode = exitCode;
    });
}
//# sourceMappingURL=actions-change-executor.js.map