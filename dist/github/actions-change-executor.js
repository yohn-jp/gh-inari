/**
 * GitHub Actions trusted runtime for Change plans.
 *
 * The workflow supplies only a semantic request. This module resolves bounded
 * GitHub evidence, invokes Core planning, applies explicit effects through the
 * #217 issuer authority, and verifies a fresh #213 projection.
 */
import { createHash, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MAX_CHANGE_ARTIFACT_BODY_LENGTH, deriveCanonicalBranchIdentity, projectChangeFromGitHubEvidence, validateGovernedRootIssueEvidence, } from "../change.js";
import { extractTemplateIdentityMarker, renderIssueArtifact, selectExistingArtifactCandidate, validateExistingIssueArtifact, } from "../artifact.js";
import { compileLocalBranchGovernance, compileLocalGovernedContract } from "../governance.js";
import { classifyBranchName, effectiveBranchGovernance, parseCanonicalChangeBranchName } from "../branch-governance.js";
import { discoverTemplatesFromPaths } from "../template-discovery.js";
import { CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION, changeRemoteMutationRequest, changeRemoteReadRequest, } from "../change-executor.js";
import { ChangeTrustedExecutorError, TrustedChangeExecutor, } from "../change-trusted-executor.js";
import { GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES, GitHubChangeEffectAdapter, } from "./change-effect-adapter.js";
import { InariIssuerAppAuthority, assertTrustedExecution, TRUSTED_EXECUTION_EVENTS, IssuerAuthorityError, } from "./issuer-authority.js";
import { INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";
import { TEMPLATE_RESOLUTION_CONFIG_PATH } from "../template-resolver.js";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PULL_REQUESTS = 100;
const POLICY_PATHS = [".github/inari/pr-policy.yml", ".inari/pr-policy.yml"];
const MAX_TITLE_LENGTH = 255;
const MAX_LOGIN_LENGTH = 160;
const DEFAULT_API_URL = "https://api.github.com";
const ISSUE_TITLE_PATTERN = /^(feat|fix|docs|refactor|test|chore):\s*(.+)$/iu;
const ISSUER_LOGIN_NAMES = new Set(["inari-issuer[bot]", "inari-issuer"]);
/** Stable, non-secret boundaries exposed for trusted Actions runtime failures. */
export const TRUSTED_ACTIONS_FAILURE_STAGES = Object.freeze([
    "repository-evidence",
    "trusted-execution",
    "branch-governance",
    "issuer-configuration",
    "installation-token",
    "installation-scope",
    "projection-execution",
]);
/**
 * Bounded, secret-safe reasons within the `repository-evidence` stage. Fixed at the
 * exact repository-bootstrap boundary that failed so #239-class dogfood failures no
 * longer collapse into one undifferentiated stage (issue #244).
 */
export const REPOSITORY_EVIDENCE_FAILURE_REASONS = Object.freeze([
    "repository-configuration",
    "repository-request",
    "repository-status",
    "repository-body",
    "repository-id",
    "repository-fork",
]);
export function isRepositoryEvidenceFailureReason(value) {
    return REPOSITORY_EVIDENCE_FAILURE_REASONS.includes(value);
}
export function isTrustedActionsFailureStage(value) {
    return TRUSTED_ACTIONS_FAILURE_STAGES.includes(value);
}
function failureDiagnostic(stage, reason) {
    return Object.freeze(reason === undefined ? { stage } : { stage, reason });
}
export class GitHubActionsChangeExecutorError extends Error {
    code = "CHANGE_ACTIONS_RUNTIME_INVALID";
    details;
    constructor(message = "Trusted Change Actions runtime configuration is invalid.", stage, reason) {
        super(message);
        this.name = "GitHubActionsChangeExecutorError";
        this.details = stage === undefined ? undefined : failureDiagnostic(stage, reason);
    }
}
function withFailureStage(error, stage) {
    if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined)
        return error;
    return new GitHubActionsChangeExecutorError(undefined, stage);
}
function atRepositoryEvidenceReason(reason) {
    return (error) => {
        const hasOwnReason = error instanceof GitHubActionsChangeExecutorError &&
            error.details !== undefined &&
            (error.details.stage !== "repository-evidence" || error.details.reason !== undefined);
        throw hasOwnReason ? error : new GitHubActionsChangeExecutorError(undefined, "repository-evidence", reason);
    };
}
async function atFailureStage(stage, operation) {
    try {
        return await operation();
    }
    catch (error) {
        throw withFailureStage(error, stage);
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
function boundedArtifactBody(value) {
    if (value === null)
        return null;
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_CHANGE_ARTIFACT_BODY_LENGTH ||
        /[\u0000-\u0009\u000B-\u000C\u000E-\u001F\u007F]/u.test(value)) {
        throw new GitHubActionsChangeExecutorError();
    }
    return value;
}
function gitBlobSha(source) {
    const bytes = Buffer.byteLength(source, "utf8");
    return createHash("sha1").update(`blob ${bytes}\0`, "utf8").update(source, "utf8").digest("hex");
}
function semanticSourcePath(domain, id) {
    if (domain === "issue")
        return `.github/inari/issues/${id}.json`;
    return id === "pull-request" ? ".github/inari/pull-request.json" : `.github/inari/pull-requests/${id}.json`;
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
    try {
        const parts = value.split("/");
        if (parts.length !== 2)
            throw new GitHubActionsChangeExecutorError();
        return {
            hostname: boundedString(hostname, 255),
            owner: boundedString(parts[0], 255),
            name: boundedString(parts[1], 255),
        };
    }
    catch (error) {
        throw atRepositoryEvidenceReason("repository-configuration")(error);
    }
}
function repositoryName(repository) {
    return `${repository.owner}/${repository.name}`;
}
function apiPath(repository, suffix) {
    const base = `repos/${repository.owner}/${repository.name}`;
    return suffix === "" ? base : `${base}/${suffix}`;
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
    #failureStage;
    constructor(options) {
        // Bound the input length before the trailing-slash regex runs, so it cannot be handed an
        // unbounded string (CodeQL polynomial-regex guard).
        this.#apiUrl = boundedString(options.apiUrl ?? DEFAULT_API_URL, 2048).replace(/\/+$/u, "");
        this.#token = boundedString(options.token, 4096);
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#failureStage = options.failureStage ?? "repository-evidence";
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
            throw new GitHubActionsChangeExecutorError(undefined, this.#failureStage);
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
        try {
            this.#options = options;
            this.#fetch = options.fetch ?? globalThis.fetch;
            boundedString(options.appId, 20);
            boundedString(options.installationId, 20);
            boundedSecret(options.privateKeyPem, 16_384);
        }
        catch (error) {
            throw withFailureStage(error, "issuer-configuration");
        }
    }
    async withScopedInstallationCredential(request, operation) {
        const credential = await this.issueInstallationToken(request);
        const transport = new GitHubActionsApiTransport({
            apiUrl: this.#options.apiUrl,
            token: credential.token,
            fetch: this.#fetch,
            failureStage: "projection-execution",
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
        try {
            await operation(capability);
        }
        catch (error) {
            throw withFailureStage(error, "projection-execution");
        }
    }
    async issueInstallationToken(request) {
        if (request.target.repositoryHost !== this.#options.target.repositoryHost ||
            request.target.repositoryId !== this.#options.target.repositoryId ||
            request.target.nameWithOwner !== this.#options.target.nameWithOwner ||
            repositoryName(this.#options.repository) !== this.#options.target.nameWithOwner) {
            throw new GitHubActionsChangeExecutorError(undefined, "installation-scope");
        }
        const apiUrl = boundedString(this.#options.apiUrl ?? DEFAULT_API_URL, 2048).replace(/\/+$/u, "");
        let response;
        try {
            response = await this.#fetch(`${apiUrl}/app/installations/${this.#options.installationId}/access_tokens`, {
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
        }
        catch (error) {
            throw withFailureStage(error, "installation-token");
        }
        if (response.status !== 201)
            throw new GitHubActionsChangeExecutorError(undefined, "installation-token");
        let body;
        try {
            body = record(await boundedBody(response));
        }
        catch (error) {
            throw withFailureStage(error, "installation-token");
        }
        let token;
        let expiresAt;
        let permissions;
        try {
            token = boundedString(body.token, 4096);
            expiresAt = boundedString(body.expires_at, 64);
            permissions = record(body.permissions);
        }
        catch (error) {
            throw withFailureStage(error, "installation-token");
        }
        const repositories = Array.isArray(body.repositories) ? body.repositories : [];
        const selected = repositories.some((candidate) => {
            if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
                return false;
            const value = candidate;
            return String(value.id) === request.target.repositoryId && value.full_name === request.target.nameWithOwner;
        });
        if (!selected)
            throw new GitHubActionsChangeExecutorError(undefined, "installation-scope");
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
    // Bound the input length before the regex runs (CodeQL polynomial-regex guard); callers
    // within this module already pass a title bounded to MAX_TITLE_LENGTH.
    if (title.length > MAX_TITLE_LENGTH)
        throw new GitHubActionsChangeExecutorError();
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
/** Recognize only repository-governed branch names carrying this root Issue. */
function branchBelongsToRootIssue(branch, rootIssue, branchGovernance) {
    const parsed = parseCanonicalChangeBranchName(branch);
    if (parsed === undefined || parsed.issueNumber !== rootIssue)
        return false;
    const classification = classifyBranchName(branch, branchGovernance);
    return (classification.valid &&
        (classification.classification === "ordinary" || classification.classification === "unclassified"));
}
function namingFromBranch(branch, rootIssue) {
    const parsed = parseCanonicalChangeBranchName(branch);
    if (parsed === undefined || parsed.issueNumber !== rootIssue)
        return undefined;
    return { type: parsed.type, slug: parsed.slug };
}
export const deriveChangeNamingFromIssueTitle = deriveNaming;
/** Converts only bounded GitHub fields into the #213 Core evidence contract. */
export class GitHubActionsEvidenceReader {
    requiresGovernedIssueValidation;
    #options;
    constructor(options) {
        this.#options = options;
        this.requiresGovernedIssueValidation = options.cwd !== undefined;
    }
    async read(request) {
        try {
            return await this.readInternal(request);
        }
        catch (error) {
            throw withFailureStage(error, "repository-evidence");
        }
    }
    async readInternal(request) {
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
        // GitHub's Issues endpoint also returns pull-request resources. Presence of
        // the marker is authoritative, and a Change must retain two distinct artifacts.
        if (Object.prototype.hasOwnProperty.call(issue, "pull_request")) {
            throw new GitHubActionsChangeExecutorError();
        }
        const issueNumber = positiveNumber(issue.number);
        const title = boundedString(issue.title, MAX_TITLE_LENGTH);
        const state = issue.state === "open" || issue.state === "closed" ? issue.state : undefined;
        if (issueNumber !== request.issue || state === undefined)
            throw new GitHubActionsChangeExecutorError();
        const issueBody = boundedArtifactBody(issue.body);
        let naming;
        try {
            naming = deriveNaming(title);
        }
        catch {
            // A title can be edited into a non-governed descriptive value after
            // issuance. Existing GitHub evidence remains authoritative in that
            // case; absence still fails closed below.
        }
        const derivation = naming === undefined
            ? undefined
            : deriveCanonicalBranchIdentity({
                change: this.#options.identity,
                branchGovernance: this.#options.branchGovernance,
                naming,
            });
        const derivedBranch = derivation?.valid === true ? derivation.branch : undefined;
        const branches = await this.readBranches(derivedBranch);
        const pullRequests = await this.readPullRequests(derivedBranch, branches.some((candidate) => candidate.rootIssue !== undefined));
        const anchoredBranches = new Set([
            ...branches.filter((candidate) => candidate.rootIssue === request.issue).map((candidate) => candidate.name),
            ...pullRequests.filter((candidate) => candidate.rootIssue === request.issue).map((candidate) => candidate.head),
        ]);
        if (anchoredBranches.size > 1)
            throw new GitHubActionsChangeExecutorError();
        const canonicalBranch = anchoredBranches.size === 1 ? [...anchoredBranches][0] : derivedBranch;
        if (naming === undefined && canonicalBranch !== undefined) {
            naming = namingFromBranch(canonicalBranch, request.issue);
        }
        if (naming === undefined || canonicalBranch === undefined) {
            throw new GitHubActionsChangeExecutorError();
        }
        const governedIssue = request.operation === "issue" && this.#options.cwd !== undefined
            ? await this.readGovernedIssue(issueBody, baseBranch)
            : undefined;
        const readyEvidence = request.operation === "ready"
            ? await this.readReadyEvidence(baseBranch, issueBody, pullRequests, canonicalBranch)
            : undefined;
        return {
            change: this.#options.identity,
            ...(this.#options.branchGovernance === undefined ? {} : { branchGovernance: this.#options.branchGovernance }),
            naming,
            baseBranch,
            evidence: {
                issue: { status: "available", value: { number: issueNumber, state } },
                branches: branches.length === 0 ? { status: "absent" } : { status: "available", value: branches },
                pullRequests: pullRequests.length === 0 ? { status: "absent" } : { status: "available", value: pullRequests },
            },
            ...(governedIssue === undefined ? {} : { governedIssue }),
            ...(readyEvidence === undefined ? {} : { readyEvidence }),
        };
    }
    async readReadyEvidence(baseBranch, issueBody, pullRequests, branch) {
        if (this.#options.cwd === undefined || issueBody === undefined || issueBody === null)
            return undefined;
        const canonical = pullRequests.filter((candidate) => candidate.head === branch && candidate.base === baseBranch);
        if (canonical.length !== 1)
            return undefined;
        const pullRequest = canonical[0];
        if (pullRequest === undefined)
            return undefined;
        const pullRequestBody = await this.readPullRequestBody(pullRequest.number);
        if (pullRequestBody === undefined || pullRequestBody === null)
            return undefined;
        const generation = await this.readGovernanceTree(baseBranch);
        const issueMarker = extractTemplateIdentityMarker(issueBody);
        const issueContract = issueMarker.status === "valid" && issueMarker.marker !== undefined
            ? await this.readGovernedContract("issue", baseBranch, generation, issueMarker.marker.path)
            : undefined;
        const pullRequestMarker = extractTemplateIdentityMarker(pullRequestBody);
        const pullRequestContract = pullRequestMarker.status === "valid" && pullRequestMarker.marker !== undefined
            ? await this.readGovernedContract("pr", baseBranch, generation, pullRequestMarker.marker.path)
            : undefined;
        if (issueContract === undefined || pullRequestContract === undefined)
            return undefined;
        return {
            issue: { contract: issueContract, body: issueBody },
            pullRequest: { contract: pullRequestContract, body: pullRequestBody },
        };
    }
    /**
     * Resolve the root Issue against every authoritative Issue template when no
     * marker is present, or against the marker's exact identity when present.
     * Selection and validation remain delegated to the shared artifact parser.
     */
    async readGovernedIssue(body, ref) {
        if (body === undefined || body === null)
            throw new GitHubActionsChangeExecutorError();
        const generation = await this.readGovernanceTree(ref);
        const marker = extractTemplateIdentityMarker(body);
        if (marker.status !== "absent") {
            if (marker.status !== "valid" || marker.marker === undefined || marker.marker.kind !== "issue") {
                throw new GitHubActionsChangeExecutorError();
            }
            const contract = await this.readGovernedContract("issue", ref, generation, marker.marker.path);
            if (contract === undefined)
                throw new GitHubActionsChangeExecutorError();
            this.assertGovernedIssue(contract, body);
            return { contract, body };
        }
        const selectors = await this.issueTemplateSelectors(generation);
        const candidates = [];
        for (const selector of selectors) {
            const contract = await this.readGovernedContract("issue", ref, generation, selector);
            if (contract === undefined)
                continue;
            candidates.push({ contract, result: validateExistingIssueArtifact(contract, body) });
        }
        const selected = selectExistingArtifactCandidate(candidates);
        if (selected.contract === undefined || !selected.result.valid) {
            throw new GitHubActionsChangeExecutorError();
        }
        this.assertCanonicalIssueBody(selected.contract, body, selected.result);
        return { contract: selected.contract, body };
    }
    async issueTemplateSelectors(generation) {
        const cwd = this.#options.cwd;
        if (cwd === undefined)
            throw new GitHubActionsChangeExecutorError();
        const remotePaths = generation.entries
            .filter((entry) => entry.type === "blob")
            .map((entry) => entry.path)
            .filter((entryPath) => entryPath.startsWith(".github/ISSUE_TEMPLATE/"));
        const native = discoverTemplatesFromPaths(remotePaths).issueTemplates.map((template) => template.path);
        if (native.length > 0)
            return [...new Set(native)].sort();
        // Semantic-only repositories may not have generated native files.  Their
        // source identities are still compiled by the same local compiler seam.
        const semanticPaths = generation.entries
            .filter((entry) => entry.type === "blob")
            .map((entry) => entry.path)
            .filter((entryPath) => /^\.github\/inari\/issues\/[^/]+\.json$/u.test(entryPath));
        if (semanticPaths.length === 0)
            throw new GitHubActionsChangeExecutorError();
        return [...new Set(semanticPaths)].sort();
    }
    assertGovernedIssue(contract, body) {
        const diagnostics = validateGovernedRootIssueEvidence({ contract, body });
        if (diagnostics.length > 0)
            throw new GitHubActionsChangeExecutorError();
    }
    assertCanonicalIssueBody(contract, body, result) {
        try {
            const canonical = renderIssueArtifact(contract, {
                fields: result.parse.values,
                ...(result.parse.dependencies === undefined ? {} : { dependencies: result.parse.dependencies }),
            });
            if (canonical !== body)
                throw new GitHubActionsChangeExecutorError();
        }
        catch {
            throw new GitHubActionsChangeExecutorError();
        }
    }
    async readPullRequestBody(number) {
        const response = await this.request({ method: "GET", path: apiPath(this.#options.repository, `pulls/${number}`) }, 200);
        const value = record(response);
        if (positiveNumber(value.number) !== number)
            throw new GitHubActionsChangeExecutorError();
        return boundedArtifactBody(value.body);
    }
    async readGovernanceTree(ref) {
        const response = await this.request({
            method: "GET",
            path: apiPath(this.#options.repository, `git/trees/${encodeURIComponent(ref)}?recursive=1`),
        }, 200);
        const value = record(response);
        const sha = boundedString(value.sha, 255);
        if (value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > 2048) {
            throw new GitHubActionsChangeExecutorError();
        }
        const entries = value.tree.map((entry) => {
            const candidate = record(entry);
            const type = candidate.type === "blob" || candidate.type === "tree" ? candidate.type : undefined;
            if (type === undefined)
                throw new GitHubActionsChangeExecutorError();
            return { path: boundedString(candidate.path, 512), type, sha: boundedString(candidate.sha, 255) };
        });
        return { sha, entries };
    }
    async readGovernedContract(domain, ref, generation, selector) {
        const cwd = this.#options.cwd;
        if (cwd === undefined)
            return undefined;
        let contract;
        try {
            contract = await compileLocalGovernedContract(domain, cwd, selector);
        }
        catch {
            return undefined;
        }
        const templatePath = contract.templateIdentity.path;
        const templateEntry = generation.entries.find((entry) => entry.type === "blob" && entry.path === templatePath);
        if (templateEntry === undefined)
            return undefined;
        const templateSource = await this.readMatchingGovernanceFile(cwd, templateEntry.path, templateEntry.sha);
        if (templateSource === undefined)
            return undefined;
        // The local compiler is used only as the existing Core compiler seam. Its
        // semantic source and generated native projection must both be the exact
        // files observed in the trusted GitHub generation.
        const semanticPath = semanticSourcePath(domain, contract.templateIdentity.id);
        const semanticEntry = generation.entries.find((entry) => entry.path === semanticPath);
        const semanticSource = semanticEntry === undefined || semanticEntry.type !== "blob"
            ? undefined
            : await this.readMatchingGovernanceFile(cwd, semanticEntry.path, semanticEntry.sha);
        if (semanticEntry !== undefined
            ? semanticSource === undefined
            : (await this.readLocalGovernanceFile(cwd, semanticPath)) !== undefined) {
            return undefined;
        }
        const policyEntry = domain === "pr"
            ? generation.entries.find((entry) => POLICY_PATHS.includes(entry.path))
            : undefined;
        if (policyEntry !== undefined && policyEntry.type !== "blob")
            return undefined;
        const policySource = policyEntry === undefined
            ? undefined
            : await this.readMatchingGovernanceFile(cwd, policyEntry.path, policyEntry.sha);
        if (policyEntry !== undefined && policySource === undefined)
            return undefined;
        if (domain === "pr" && policyEntry === undefined) {
            for (const policyPath of POLICY_PATHS) {
                if ((await this.readLocalGovernanceFile(cwd, policyPath)) !== undefined)
                    return undefined;
            }
        }
        const resolutionEntry = generation.entries.find((entry) => entry.path === TEMPLATE_RESOLUTION_CONFIG_PATH);
        if (resolutionEntry !== undefined && resolutionEntry.type !== "blob")
            return undefined;
        const resolutionSource = resolutionEntry === undefined
            ? undefined
            : await this.readMatchingGovernanceFile(cwd, resolutionEntry.path, resolutionEntry.sha);
        if (resolutionEntry !== undefined && resolutionSource === undefined)
            return undefined;
        const provenance = {
            authority: "repository-default-branch",
            repository: {
                host: this.#options.identity.repositoryHost,
                owner: this.#options.repository.owner,
                name: this.#options.repository.name,
                nameWithOwner: `${this.#options.repository.owner}/${this.#options.repository.name}`,
                repositoryId: this.#options.identity.repositoryId,
            },
            ref,
            treeSha: generation.sha,
            template: {
                path: templatePath,
                ref,
                sha: templateEntry.sha,
                digest: createHash("sha256").update(templateSource, "utf8").digest("hex"),
            },
            ...(policyEntry === undefined
                ? {}
                : {
                    policy: {
                        path: policyEntry.path,
                        ref,
                        sha: policyEntry.sha,
                        digest: createHash("sha256")
                            .update(policySource ?? "", "utf8")
                            .digest("hex"),
                    },
                }),
            ...(resolutionEntry === undefined
                ? {}
                : {
                    templateResolution: {
                        path: resolutionEntry.path,
                        ref,
                        sha: resolutionEntry.sha,
                        digest: createHash("sha256")
                            .update(resolutionSource ?? "", "utf8")
                            .digest("hex"),
                    },
                }),
            ...(domain === "pr" && this.#options.branchGovernance !== undefined
                ? { branchGovernance: effectiveBranchGovernance(this.#options.branchGovernance) }
                : {}),
        };
        return { ...contract, provenance };
    }
    async readLocalGovernanceFile(cwd, filePath) {
        try {
            return await readFile(path.join(cwd, filePath), "utf8");
        }
        catch {
            return undefined;
        }
    }
    async readMatchingGovernanceFile(cwd, filePath, expectedSha) {
        const source = await this.readLocalGovernanceFile(cwd, filePath);
        return source !== undefined && gitBlobSha(source) === expectedSha ? source : undefined;
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
    async readBranches(derivedBranch) {
        const names = new Set();
        if (derivedBranch !== undefined && (await this.readBranch(derivedBranch)))
            names.add(derivedBranch);
        const response = await this.#options.transport.request({
            hostname: this.#options.repository.hostname,
            method: "GET",
            path: apiPath(this.#options.repository, "git/matching-refs/heads/"),
        });
        if (response.status === 404)
            return [...names].map((name) => ({ name }));
        if (response.status !== 200 || !Array.isArray(response.body) || response.body.length >= MAX_PULL_REQUESTS) {
            throw new GitHubActionsChangeExecutorError();
        }
        for (const candidate of response.body) {
            const value = record(candidate);
            const ref = boundedString(value.ref, 512);
            const prefix = "refs/heads/";
            if (!ref.startsWith(prefix))
                throw new GitHubActionsChangeExecutorError();
            const name = ref.slice(prefix.length);
            if (branchBelongsToRootIssue(name, this.#options.identity.rootIssue, this.#options.branchGovernance)) {
                names.add(name);
            }
        }
        const orderedNames = [...names].sort();
        const hasHistoricalCandidate = orderedNames.some((name) => name !== derivedBranch);
        return orderedNames.map((name) => hasHistoricalCandidate ? { name, rootIssue: this.#options.identity.rootIssue } : { name });
    }
    async readPullRequests(derivedBranch, hasHistoricalBranch) {
        const response = await this.#options.transport.request({
            hostname: this.#options.repository.hostname,
            method: "GET",
            path: apiPath(this.#options.repository, `pulls?state=all&per_page=${MAX_PULL_REQUESTS}`),
        });
        if (response.status !== 200 || !Array.isArray(response.body) || response.body.length >= MAX_PULL_REQUESTS) {
            throw new GitHubActionsChangeExecutorError();
        }
        const pullRequests = response.body.flatMap((candidate) => {
            const value = record(candidate);
            const head = record(value.head);
            const base = record(value.base);
            const user = record(value.user);
            const state = value.state === "open" || value.state === "closed" ? value.state : undefined;
            if (state === undefined || typeof value.draft !== "boolean")
                throw new GitHubActionsChangeExecutorError();
            const login = boundedString(user.login, MAX_LOGIN_LENGTH);
            const headName = boundedString(head.ref, 255);
            if (head.repo !== undefined && head.repo !== null) {
                const headRepository = record(head.repo);
                if (headRepository.full_name !== `${this.#options.repository.owner}/${this.#options.repository.name}`) {
                    return [];
                }
            }
            if (!branchBelongsToRootIssue(headName, this.#options.identity.rootIssue, this.#options.branchGovernance)) {
                return [];
            }
            return [
                {
                    number: positiveNumber(value.number),
                    head: headName,
                    base: boundedString(base.ref, 255),
                    state,
                    draft: value.draft,
                    ...(state === "closed" ? { merged: value.merged_at !== null } : { merged: false }),
                    provenance: { issuer: issuerPrincipal(login) },
                },
            ];
        });
        const hasHistoricalCandidate = hasHistoricalBranch || pullRequests.some((candidate) => candidate.head !== derivedBranch);
        return pullRequests.map((candidate) => hasHistoricalCandidate || candidate.head !== derivedBranch
            ? { ...candidate, rootIssue: this.#options.identity.rootIssue }
            : candidate);
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
export async function loadBranchGovernance(cwd) {
    try {
        return await compileLocalBranchGovernance(cwd);
    }
    catch (error) {
        throw withFailureStage(error, "branch-governance");
    }
}
function requiredEnvironment(environment, key, stage = "trusted-execution") {
    const value = environment[key];
    if (value === undefined)
        throw new GitHubActionsChangeExecutorError(undefined, stage);
    try {
        return boundedString(value, 16_384);
    }
    catch (error) {
        throw withFailureStage(error, stage);
    }
}
function issuerFailureStage(error) {
    if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined)
        return error.details.stage;
    if (error instanceof IssuerAuthorityError) {
        if (["ISSUER_INVALID_EXECUTION", "ISSUER_UNTRUSTED_EXECUTION", "ISSUER_UNSUPPORTED_EVENT"].includes(error.code)) {
            return "trusted-execution";
        }
        if ([
            "ISSUER_INVALID_SCOPE",
            "ISSUER_PERMISSION_MISMATCH",
            "ISSUER_SCOPE_MISMATCH",
            "ISSUER_CREDENTIAL_EXPIRED",
        ].includes(error.code)) {
            return "installation-scope";
        }
        if (["ISSUER_INVALID_EFFECT", "ISSUER_UNSUPPORTED_EFFECT", "ISSUER_MUTATION_FAILED"].includes(error.code)) {
            return "projection-execution";
        }
    }
    return "installation-token";
}
function trustedFailureStage(error, issuerStage) {
    if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined)
        return error.details.stage;
    if (error instanceof ChangeTrustedExecutorError) {
        if (error.code === "CHANGE_EXECUTION_READ_FAILED")
            return "repository-evidence";
        return issuerStage ?? "projection-execution";
    }
    if (error instanceof IssuerAuthorityError)
        return issuerFailureStage(error);
    return issuerStage ?? "projection-execution";
}
function asTrustedActionsFailure(error, issuerStage) {
    if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined)
        return error;
    return new GitHubActionsChangeExecutorError(undefined, trustedFailureStage(error, issuerStage));
}
/** Build the trusted executor from GitHub Actions runtime claims and secrets. */
export async function createGitHubActionsChangeExecutor(options) {
    const environment = options.environment ?? process.env;
    let repositoryNameWithOwner;
    let hostname = "github.com";
    let readTransport;
    try {
        repositoryNameWithOwner = requiredEnvironment(environment, "GITHUB_REPOSITORY", "repository-evidence");
        if (environment.GITHUB_SERVER_URL !== undefined) {
            hostname = new URL(environment.GITHUB_SERVER_URL).hostname;
        }
        readTransport = new GitHubActionsApiTransport({
            apiUrl: environment.GITHUB_API_URL ?? DEFAULT_API_URL,
            token: requiredEnvironment(environment, "GITHUB_TOKEN", "repository-evidence"),
            fetch: options.fetch,
            failureStage: "repository-evidence",
        });
    }
    catch (error) {
        throw atRepositoryEvidenceReason("repository-configuration")(error);
    }
    const repository = parseRepository(repositoryNameWithOwner, hostname);
    const repositoryResponse = await readTransport
        .request({
        hostname: repository.hostname,
        method: "GET",
        path: apiPath(repository, ""),
    })
        .catch(atRepositoryEvidenceReason("repository-request"));
    if (repositoryResponse.status !== 200) {
        throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", "repository-status");
    }
    let repositoryBody;
    try {
        repositoryBody = record(repositoryResponse.body);
    }
    catch (error) {
        throw atRepositoryEvidenceReason("repository-body")(error);
    }
    const repositoryId = String(repositoryBody.id);
    if (!/^[1-9][0-9]{0,19}$/u.test(repositoryId)) {
        throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", "repository-id");
    }
    if (typeof repositoryBody.fork !== "boolean") {
        throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", "repository-fork");
    }
    const target = {
        repositoryHost: repository.hostname,
        repositoryId,
        nameWithOwner: repositoryNameWithOwner,
    };
    const event = requiredEnvironment(environment, "GITHUB_EVENT_NAME", "trusted-execution");
    if (!TRUSTED_EXECUTION_EVENTS.includes(event)) {
        throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    // GITHUB_REF constrains the target ref only. Under workflow_call this reflects the
    // *caller's* context, so it cannot alone prove the trusted-executor source — see below.
    if (requiredEnvironment(environment, "GITHUB_REF", "trusted-execution") !== "refs/heads/main") {
        throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    // GITHUB_WORKFLOW_REF names the workflow FILE actually executing (owner/repo/path@ref).
    // Unlike GITHUB_REF it cannot be substituted by a workflow_call caller, so an exact match
    // against this repository's protected executor workflow is the real trust proof: only this
    // check licenses workflowTrust: "protected" / codeExecution: "trusted-only" below.
    const expectedWorkflowRef = `${repositoryNameWithOwner}/.github/workflows/inari-change-executor.yml@refs/heads/main`;
    if (requiredEnvironment(environment, "GITHUB_WORKFLOW_REF", "trusted-execution") !== expectedWorkflowRef) {
        throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    const workflowRef = "refs/heads/main";
    const workflowSha = requiredEnvironment(environment, "GITHUB_WORKFLOW_SHA", "trusted-execution");
    let execution;
    try {
        execution = assertTrustedExecution({
            version: 1,
            runtime: "github-actions",
            event,
            repository: target,
            workflowRef,
            workflowSha,
            workflowTrust: "protected",
            codeExecution: "trusted-only",
            // repositoryBody.fork is an auxiliary scope check on the target repository identity;
            // the primary proof against untrusted/forked execution is the workflow-ref match above.
            fork: repositoryBody.fork,
            pullRequest: event === "pull_request" || event === "pull_request_target",
            ...(environment.GITHUB_ACTOR === undefined ? {} : { requester: environment.GITHUB_ACTOR }),
        });
    }
    catch (error) {
        throw withFailureStage(error, "trusted-execution");
    }
    const branchGovernance = await atFailureStage("branch-governance", () => loadBranchGovernance(options.cwd));
    const reader = new GitHubActionsEvidenceReader({
        repository,
        identity: { repositoryHost: repository.hostname, repositoryId, rootIssue: options.request.issue },
        branchGovernance,
        transport: readTransport,
        cwd: options.cwd,
    });
    if (options.request.operation === "show") {
        return {
            execute: async () => {
                throw new GitHubActionsChangeExecutorError("Read-only Change execution cannot apply effects.", "projection-execution");
            },
            read: async (request) => {
                try {
                    return projectChangeFromGitHubEvidence(await reader.read(request));
                }
                catch (error) {
                    throw withFailureStage(error, "projection-execution");
                }
            },
        };
    }
    let broker;
    let authority;
    try {
        const appId = requiredEnvironment(environment, "INARI_ISSUER_APP_ID", "issuer-configuration");
        const installationId = requiredEnvironment(environment, "INARI_ISSUER_INSTALLATION_ID", "issuer-configuration");
        broker = new GitHubActionsCredentialBroker({
            appId,
            installationId,
            privateKeyPem: boundedSecret(environment.INARI_ISSUER_APP_PRIVATE_KEY, 16_384),
            repository,
            target,
            apiUrl: environment.GITHUB_API_URL ?? DEFAULT_API_URL,
            fetch: options.fetch,
        });
        authority = new InariIssuerAppAuthority({ appId, broker });
    }
    catch (error) {
        throw withFailureStage(error, "issuer-configuration");
    }
    let issuerStage;
    const stagedAuthority = {
        applyEffects: async (input) => {
            try {
                return await authority.applyEffects(input);
            }
            catch (error) {
                issuerStage = issuerFailureStage(error);
                throw error;
            }
        },
    };
    const trustedExecutor = new TrustedChangeExecutor({
        reader,
        issuerAuthority: stagedAuthority,
        execution,
        target,
    });
    return {
        execute: async (request) => {
            issuerStage = undefined;
            try {
                return await trustedExecutor.execute(request);
            }
            catch (error) {
                throw asTrustedActionsFailure(error, issuerStage);
            }
        },
        read: async (request) => {
            try {
                return await trustedExecutor.read(request);
            }
            catch (error) {
                throw asTrustedActionsFailure(error, undefined);
            }
        },
    };
}
function sanitizedFailure(error) {
    if (error instanceof GitHubActionsChangeExecutorError) {
        return {
            code: error.code,
            message: "Trusted Change execution failed closed.",
            ...(error.details === undefined ? {} : { details: error.details }),
        };
    }
    return { code: "CHANGE_ACTIONS_RUNTIME_INVALID", message: "Trusted Change execution failed closed." };
}
/** Workflow entrypoint. It emits one bounded JSON result and never logs secrets. */
export async function runGitHubActionsChangeExecutor(environment = process.env, cwd = process.cwd()) {
    try {
        const serialized = requiredEnvironment(environment, "INARI_CHANGE_REQUEST", "trusted-execution");
        let requestValue;
        try {
            requestValue = JSON.parse(serialized);
        }
        catch {
            throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
        }
        if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
            throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
        }
        const requestRecord = requestValue;
        const allowedRequestKeys = new Set(["version", "operation", "issue", "requester"]);
        if (Object.keys(requestRecord).some((key) => !allowedRequestKeys.has(key))) {
            throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
        }
        if (requestRecord.requester !== undefined && typeof requestRecord.requester !== "string") {
            throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
        }
        if (requestRecord.version !== CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION ||
            typeof requestRecord.operation !== "string" ||
            typeof requestRecord.issue !== "number") {
            throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
        }
        if (requestRecord.operation !== "show" && !["issue", "ready", "abort"].includes(requestRecord.operation)) {
            throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
        }
        const requester = typeof requestRecord.requester === "string" ? requestRecord.requester : undefined;
        const request = requestRecord.operation === "show"
            ? changeRemoteReadRequest(requestRecord.issue, requester)
            : changeRemoteMutationRequest(requestRecord.operation, requestRecord.issue, requester);
        const executor = await createGitHubActionsChangeExecutor({ cwd, request, environment });
        const result = request.operation === "show" ? await executor.read(request) : await executor.execute(request);
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