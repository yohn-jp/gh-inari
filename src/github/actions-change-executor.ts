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
import {
  MAX_CHANGE_ARTIFACT_BODY_LENGTH,
  deriveCanonicalBranchIdentity,
  projectChangeFromGitHubEvidence,
  validateGovernedRootIssueEvidence,
  type CanonicalBranchNamingInput,
  type ChangeProjectionInput,
  type ChangePullRequestEvidence,
  type ChangeReadyEvidence,
} from "../change.js";
import {
  extractTemplateIdentityMarker,
  renderIssueArtifact,
  selectExistingArtifactCandidate,
  validateExistingIssueArtifact,
  type ExistingArtifactCandidate,
} from "../artifact.js";
import { compileLocalGovernedContract } from "../governance.js";
import { discoverTemplatesFromPaths } from "../template-discovery.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  changeRemoteMutationRequest,
  changeRemoteReadRequest,
  type ChangeRemoteExecutor,
  type ChangeRemoteMutationRequest,
  type ChangeRemoteReadRequest,
} from "../change-executor.js";
import {
  ChangeTrustedExecutorError,
  TrustedChangeExecutor,
  type ChangeTrustedEvidenceReader,
} from "../change-trusted-executor.js";
import {
  GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES,
  GitHubChangeEffectAdapter,
  type GitHubChangeEffectRepository,
  type GitHubChangeEffectRequest,
  type GitHubChangeEffectResponse,
  type GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import {
  InariIssuerAppAuthority,
  assertTrustedExecution,
  TRUSTED_EXECUTION_EVENTS,
  type IssuerInstallationScope,
  type IssuerCredentialRequest,
  type IssuerScopedMutationCapability,
  type TrustedInstallationCredentialBroker,
  type IssuerRepositoryIdentity,
  type TrustedExecutionEvent,
  type TrustedExecutionContext,
  IssuerAuthorityError,
} from "./issuer-authority.js";
import { INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";
import { parsePullRequestPolicyOverlay } from "../pr-policy.js";
import { TEMPLATE_RESOLUTION_CONFIG_PATH } from "../template-resolver.js";
import type { CanonicalContract, ContractProvenance, PullRequestBranchGovernance } from "../contract/ir.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PULL_REQUESTS = 100;
const POLICY_PATHS = [".github/inari/pr-policy.yml", ".inari/pr-policy.yml"] as const;
const MAX_TITLE_LENGTH = 255;
const MAX_LOGIN_LENGTH = 160;
const DEFAULT_API_URL = "https://api.github.com";
const ISSUE_TITLE_PATTERN = /^(feat|fix|docs|refactor|test|chore):\s*(.+)$/iu;
const ISSUER_LOGIN_NAMES = new Set(["inari-issuer[bot]", "inari-issuer"]);
const CANONICAL_BRANCH_TYPES = new Set(["feat", "fix", "docs", "refactor", "test", "chore"]);

/** Stable, non-secret boundaries exposed for trusted Actions runtime failures. */
export const TRUSTED_ACTIONS_FAILURE_STAGES = Object.freeze([
  "repository-evidence",
  "trusted-execution",
  "branch-governance",
  "issuer-configuration",
  "installation-token",
  "installation-scope",
  "projection-execution",
] as const);
export type TrustedActionsFailureStage = (typeof TRUSTED_ACTIONS_FAILURE_STAGES)[number];

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
] as const);
export type RepositoryEvidenceFailureReason = (typeof REPOSITORY_EVIDENCE_FAILURE_REASONS)[number];

export function isRepositoryEvidenceFailureReason(value: unknown): value is RepositoryEvidenceFailureReason {
  return REPOSITORY_EVIDENCE_FAILURE_REASONS.includes(value as RepositoryEvidenceFailureReason);
}

export interface TrustedActionsFailureDiagnostic {
  readonly stage: TrustedActionsFailureStage;
  readonly reason?: RepositoryEvidenceFailureReason;
}

export function isTrustedActionsFailureStage(value: unknown): value is TrustedActionsFailureStage {
  return TRUSTED_ACTIONS_FAILURE_STAGES.includes(value as TrustedActionsFailureStage);
}

function failureDiagnostic(
  stage: TrustedActionsFailureStage,
  reason?: RepositoryEvidenceFailureReason,
): TrustedActionsFailureDiagnostic {
  return Object.freeze(reason === undefined ? { stage } : { stage, reason });
}

export class GitHubActionsChangeExecutorError extends Error {
  readonly code = "CHANGE_ACTIONS_RUNTIME_INVALID" as const;
  readonly details?: TrustedActionsFailureDiagnostic;

  constructor(
    message = "Trusted Change Actions runtime configuration is invalid.",
    stage?: TrustedActionsFailureStage,
    reason?: RepositoryEvidenceFailureReason,
  ) {
    super(message);
    this.name = "GitHubActionsChangeExecutorError";
    this.details = stage === undefined ? undefined : failureDiagnostic(stage, reason);
  }
}

function withFailureStage(error: unknown, stage: TrustedActionsFailureStage): GitHubActionsChangeExecutorError {
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) return error;
  return new GitHubActionsChangeExecutorError(undefined, stage);
}

function atRepositoryEvidenceReason(reason: RepositoryEvidenceFailureReason): (error: unknown) => never {
  return (error: unknown) => {
    const hasOwnReason =
      error instanceof GitHubActionsChangeExecutorError &&
      error.details !== undefined &&
      (error.details.stage !== "repository-evidence" || error.details.reason !== undefined);
    throw hasOwnReason ? error : new GitHubActionsChangeExecutorError(undefined, "repository-evidence", reason);
  };
}

async function atFailureStage<T>(stage: TrustedActionsFailureStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw withFailureStage(error, stage);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubActionsChangeExecutorError();
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new GitHubActionsChangeExecutorError();
  }
  return value;
}

function boundedArtifactBody(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CHANGE_ARTIFACT_BODY_LENGTH ||
    /[\u0000-\u0009\u000B-\u000C\u000E-\u001F\u007F]/u.test(value)
  ) {
    throw new GitHubActionsChangeExecutorError();
  }
  return value;
}

function gitBlobSha(source: string): string {
  const bytes = Buffer.byteLength(source, "utf8");
  return createHash("sha1").update(`blob ${bytes}\0`, "utf8").update(source, "utf8").digest("hex");
}

function semanticSourcePath(domain: "issue" | "pr", id: string): string {
  if (domain === "issue") return `.github/inari/issues/${id}.json`;
  return id === "pull-request" ? ".github/inari/pull-request.json" : `.github/inari/pull-requests/${id}.json`;
}

function boundedSecret(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000\u007F]/u.test(value)) {
    throw new GitHubActionsChangeExecutorError();
  }
  return value;
}

function positiveNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GitHubActionsChangeExecutorError();
  }
  return value;
}

function parseRepository(value: string, hostname = "github.com"): GitHubChangeEffectRepository {
  try {
    const parts = value.split("/");
    if (parts.length !== 2) throw new GitHubActionsChangeExecutorError();
    return {
      hostname: boundedString(hostname, 255),
      owner: boundedString(parts[0], 255),
      name: boundedString(parts[1], 255),
    };
  } catch (error: unknown) {
    throw atRepositoryEvidenceReason("repository-configuration")(error);
  }
}

function repositoryName(repository: GitHubChangeEffectRepository): string {
  return `${repository.owner}/${repository.name}`;
}

function apiPath(repository: GitHubChangeEffectRepository, suffix: string): string {
  const base = `repos/${repository.owner}/${repository.name}`;
  return suffix === "" ? base : `${base}/${suffix}`;
}

async function boundedBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new GitHubActionsChangeExecutorError();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) return undefined;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubActionsChangeExecutorError();
  }
}

export interface GitHubActionsApiTransportOptions {
  readonly apiUrl?: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly failureStage?: TrustedActionsFailureStage;
}

/** A bounded credential-bound transport. The bearer never appears in results. */
export class GitHubActionsApiTransport implements GitHubChangeEffectTransport {
  readonly #apiUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #failureStage: TrustedActionsFailureStage;

  constructor(options: GitHubActionsApiTransportOptions) {
    // Bound the input length before the trailing-slash regex runs, so it cannot be handed an
    // unbounded string (CodeQL polynomial-regex guard).
    this.#apiUrl = boundedString(options.apiUrl ?? DEFAULT_API_URL, 2048).replace(/\/+$/u, "");
    this.#token = boundedString(options.token, 4096);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#failureStage = options.failureStage ?? "repository-evidence";
  }

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
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
    } catch {
      throw new GitHubActionsChangeExecutorError(undefined, this.#failureStage);
    }
  }
}

interface InstallationTokenResponse {
  readonly token: string;
  readonly scope: IssuerInstallationScope;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const payload = { iat: issuedAt, exp: issuedAt + 540, iss: appId };
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKeyPem, "base64url")}`;
}

export interface GitHubActionsCredentialBrokerOptions {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyPem: string;
  readonly repository: GitHubChangeEffectRepository;
  readonly target: IssuerRepositoryIdentity;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** #217 broker implementation used only inside the protected Actions job. */
export class GitHubActionsCredentialBroker implements TrustedInstallationCredentialBroker {
  readonly #options: GitHubActionsCredentialBrokerOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GitHubActionsCredentialBrokerOptions) {
    try {
      this.#options = options;
      this.#fetch = options.fetch ?? globalThis.fetch;
      boundedString(options.appId, 20);
      boundedString(options.installationId, 20);
      boundedSecret(options.privateKeyPem, 16_384);
    } catch (error: unknown) {
      throw withFailureStage(error, "issuer-configuration");
    }
  }

  async withScopedInstallationCredential(
    request: IssuerCredentialRequest,
    operation: (capability: IssuerScopedMutationCapability) => Promise<void>,
  ): Promise<void> {
    const credential = await this.issueInstallationToken(request);
    const transport = new GitHubActionsApiTransport({
      apiUrl: this.#options.apiUrl,
      token: credential.token,
      fetch: this.#fetch,
      failureStage: "projection-execution",
    });
    const adapter = new GitHubChangeEffectAdapter({ repository: this.#options.repository, transport });
    const capability: IssuerScopedMutationCapability = {
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
    } catch (error: unknown) {
      throw withFailureStage(error, "projection-execution");
    }
  }

  private async issueInstallationToken(request: IssuerCredentialRequest): Promise<InstallationTokenResponse> {
    if (
      request.target.repositoryHost !== this.#options.target.repositoryHost ||
      request.target.repositoryId !== this.#options.target.repositoryId ||
      request.target.nameWithOwner !== this.#options.target.nameWithOwner ||
      repositoryName(this.#options.repository) !== this.#options.target.nameWithOwner
    ) {
      throw new GitHubActionsChangeExecutorError(undefined, "installation-scope");
    }
    const apiUrl = boundedString(this.#options.apiUrl ?? DEFAULT_API_URL, 2048).replace(/\/+$/u, "");
    let response: Response;
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
    } catch (error: unknown) {
      throw withFailureStage(error, "installation-token");
    }
    if (response.status !== 201) throw new GitHubActionsChangeExecutorError(undefined, "installation-token");
    let body: Record<string, unknown>;
    try {
      body = record(await boundedBody(response));
    } catch (error: unknown) {
      throw withFailureStage(error, "installation-token");
    }
    let token: string;
    let expiresAt: string;
    let permissions: Record<string, unknown>;
    try {
      token = boundedString(body.token, 4096);
      expiresAt = boundedString(body.expires_at, 64);
      permissions = record(body.permissions);
    } catch (error: unknown) {
      throw withFailureStage(error, "installation-token");
    }
    const repositories = Array.isArray(body.repositories) ? body.repositories : [];
    const selected = repositories.some((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
      const value = candidate as Record<string, unknown>;
      return String(value.id) === request.target.repositoryId && value.full_name === request.target.nameWithOwner;
    });
    if (!selected) throw new GitHubActionsChangeExecutorError(undefined, "installation-scope");
    const scope: IssuerInstallationScope = {
      app: request.app,
      installation: {
        appId: request.app.appId,
        installationId: this.#options.installationId,
        repositoryHost: request.target.repositoryHost,
      },
      repository: request.target,
      repositorySelection: "selected",
      permissions: permissions as IssuerInstallationScope["permissions"],
      expiresAt,
    };
    return { token, scope };
  }
}

function issuerPrincipal(login: string): string {
  return ISSUER_LOGIN_NAMES.has(login) ? INARI_ISSUER_PRINCIPAL : login;
}

function deriveNaming(title: string): CanonicalBranchNamingInput {
  // Bound the input length before the regex runs (CodeQL polynomial-regex guard); callers
  // within this module already pass a title bounded to MAX_TITLE_LENGTH.
  if (title.length > MAX_TITLE_LENGTH) throw new GitHubActionsChangeExecutorError();
  const match = ISSUE_TITLE_PATTERN.exec(title);
  if (match === null) throw new GitHubActionsChangeExecutorError();
  const type = match[1].toLowerCase();
  const slug = match[2]
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (slug.length === 0) throw new GitHubActionsChangeExecutorError();
  return { type, slug };
}

/** Recognize only repository-governed branch names carrying this root Issue. */
function branchBelongsToRootIssue(
  branch: string,
  rootIssue: number,
  branchGovernance: PullRequestBranchGovernance | undefined,
): boolean {
  const match = /^(feat|fix|docs|refactor|test|chore)\/(\d+)-([a-z0-9-]+)$/u.exec(branch);
  if (match === null || Number(match[2]) !== rootIssue || !CANONICAL_BRANCH_TYPES.has(match[1])) return false;
  if (branchGovernance === undefined) return true;
  try {
    return new RegExp(branchGovernance.pattern, "u").test(branch);
  } catch {
    return false;
  }
}

function namingFromBranch(branch: string, rootIssue: number): CanonicalBranchNamingInput | undefined {
  const match = /^(feat|fix|docs|refactor|test|chore)\/([0-9]+)-([a-z0-9-]+)$/u.exec(branch);
  if (match === null || Number(match[2]) !== rootIssue) return undefined;
  return { type: match[1] ?? "", slug: match[3] ?? "" };
}

export const deriveChangeNamingFromIssueTitle = deriveNaming;

export interface GitHubActionsEvidenceReaderOptions {
  readonly repository: GitHubChangeEffectRepository;
  readonly identity: { readonly repositoryHost: string; readonly repositoryId: string; readonly rootIssue: number };
  /** Absent when the repository's PR policy declares no branch rule; the canonical branch grammar still applies. */
  readonly branchGovernance?: PullRequestBranchGovernance;
  readonly transport: GitHubChangeEffectTransport;
  /** Trusted checkout containing the repository's default-branch governance. */
  readonly cwd?: string;
}

interface GovernanceTree {
  readonly sha: string;
  readonly entries: readonly { readonly path: string; readonly type: "blob" | "tree"; readonly sha: string }[];
}

/** Converts only bounded GitHub fields into the #213 Core evidence contract. */
export class GitHubActionsEvidenceReader implements ChangeTrustedEvidenceReader {
  readonly requiresGovernedIssueValidation: boolean;
  readonly #options: GitHubActionsEvidenceReaderOptions;

  constructor(options: GitHubActionsEvidenceReaderOptions) {
    this.#options = options;
    this.requiresGovernedIssueValidation = options.cwd !== undefined;
  }

  async read(request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest): Promise<ChangeProjectionInput> {
    try {
      return await this.readInternal(request);
    } catch (error: unknown) {
      throw withFailureStage(error, "repository-evidence");
    }
  }

  private async readInternal(
    request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest,
  ): Promise<ChangeProjectionInput> {
    if (request.issue !== this.#options.identity.rootIssue) {
      throw new GitHubActionsChangeExecutorError();
    }
    const repositoryResponse = await this.request({ method: "GET", path: apiPath(this.#options.repository, "") }, 200);
    const repository = record(repositoryResponse);
    if (String(repository.id) !== this.#options.identity.repositoryId) throw new GitHubActionsChangeExecutorError();
    const baseBranch = boundedString(repository.default_branch, 255);
    const issueResponse = await this.request(
      { method: "GET", path: apiPath(this.#options.repository, `issues/${request.issue}`) },
      200,
    );
    const issue = record(issueResponse);
    // GitHub's Issues endpoint also returns pull-request resources. Presence of
    // the marker is authoritative, and a Change must retain two distinct artifacts.
    if (Object.prototype.hasOwnProperty.call(issue, "pull_request")) {
      throw new GitHubActionsChangeExecutorError();
    }
    const issueNumber = positiveNumber(issue.number);
    const title = boundedString(issue.title, MAX_TITLE_LENGTH);
    const state = issue.state === "open" || issue.state === "closed" ? issue.state : undefined;
    if (issueNumber !== request.issue || state === undefined) throw new GitHubActionsChangeExecutorError();
    const issueBody = boundedArtifactBody(issue.body);
    let naming: CanonicalBranchNamingInput | undefined;
    try {
      naming = deriveNaming(title);
    } catch {
      // A title can be edited into a non-governed descriptive value after
      // issuance. Existing GitHub evidence remains authoritative in that
      // case; absence still fails closed below.
    }
    const derivation =
      naming === undefined
        ? undefined
        : deriveCanonicalBranchIdentity({
            change: this.#options.identity,
            branchGovernance: this.#options.branchGovernance,
            naming,
          });
    const derivedBranch = derivation?.valid === true ? derivation.branch : undefined;
    const branches = await this.readBranches(derivedBranch);
    const pullRequests = await this.readPullRequests(
      derivedBranch,
      branches.some((candidate) => candidate.rootIssue !== undefined),
    );
    const anchoredBranches = new Set<string>([
      ...branches.filter((candidate) => candidate.rootIssue === request.issue).map((candidate) => candidate.name),
      ...pullRequests.filter((candidate) => candidate.rootIssue === request.issue).map((candidate) => candidate.head),
    ]);
    if (anchoredBranches.size > 1) throw new GitHubActionsChangeExecutorError();
    const canonicalBranch = anchoredBranches.size === 1 ? [...anchoredBranches][0] : derivedBranch;
    if (naming === undefined && canonicalBranch !== undefined) {
      naming = namingFromBranch(canonicalBranch, request.issue);
    }
    if (naming === undefined || canonicalBranch === undefined) {
      throw new GitHubActionsChangeExecutorError();
    }
    const governedIssue =
      request.operation === "issue" && this.#options.cwd !== undefined
        ? await this.readGovernedIssue(issueBody, baseBranch)
        : undefined;
    const readyEvidence =
      request.operation === "ready"
        ? await this.readReadyEvidence(baseBranch, issueBody, pullRequests, canonicalBranch)
        : undefined;
    return {
      change: this.#options.identity,
      branchGovernance: this.#options.branchGovernance,
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

  private async readReadyEvidence(
    baseBranch: string,
    issueBody: string | null | undefined,
    pullRequests: readonly ChangePullRequestEvidence[],
    branch: string,
  ): Promise<ChangeReadyEvidence | undefined> {
    if (this.#options.cwd === undefined || issueBody === undefined || issueBody === null) return undefined;
    const canonical = pullRequests.filter((candidate) => candidate.head === branch && candidate.base === baseBranch);
    if (canonical.length !== 1) return undefined;
    const pullRequest = canonical[0];
    if (pullRequest === undefined) return undefined;
    const pullRequestBody = await this.readPullRequestBody(pullRequest.number);
    if (pullRequestBody === undefined || pullRequestBody === null) return undefined;
    const generation = await this.readGovernanceTree(baseBranch);
    const issueMarker = extractTemplateIdentityMarker(issueBody);
    const issueContract =
      issueMarker.status === "valid" && issueMarker.marker !== undefined
        ? await this.readGovernedContract("issue", baseBranch, generation, issueMarker.marker.path)
        : undefined;
    const pullRequestMarker = extractTemplateIdentityMarker(pullRequestBody);
    const pullRequestContract =
      pullRequestMarker.status === "valid" && pullRequestMarker.marker !== undefined
        ? await this.readGovernedContract("pr", baseBranch, generation, pullRequestMarker.marker.path)
        : undefined;
    if (issueContract === undefined || pullRequestContract === undefined) return undefined;
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
  private async readGovernedIssue(
    body: string | null | undefined,
    ref: string,
  ): Promise<{ readonly contract: CanonicalContract; readonly body: string }> {
    if (body === undefined || body === null) throw new GitHubActionsChangeExecutorError();
    const generation = await this.readGovernanceTree(ref);
    const marker = extractTemplateIdentityMarker(body);
    if (marker.status !== "absent") {
      if (marker.status !== "valid" || marker.marker === undefined || marker.marker.kind !== "issue") {
        throw new GitHubActionsChangeExecutorError();
      }
      const contract = await this.readGovernedContract("issue", ref, generation, marker.marker.path);
      if (contract === undefined) throw new GitHubActionsChangeExecutorError();
      this.assertGovernedIssue(contract, body);
      return { contract, body };
    }

    const selectors = await this.issueTemplateSelectors(generation);
    const candidates: ExistingArtifactCandidate[] = [];
    for (const selector of selectors) {
      const contract = await this.readGovernedContract("issue", ref, generation, selector);
      if (contract === undefined) continue;
      candidates.push({ contract, result: validateExistingIssueArtifact(contract, body) });
    }
    const selected = selectExistingArtifactCandidate(candidates);
    if (selected.contract === undefined || !selected.result.valid) {
      throw new GitHubActionsChangeExecutorError();
    }
    this.assertCanonicalIssueBody(selected.contract, body, selected.result);
    return { contract: selected.contract, body };
  }

  private async issueTemplateSelectors(generation: GovernanceTree): Promise<readonly string[]> {
    const cwd = this.#options.cwd;
    if (cwd === undefined) throw new GitHubActionsChangeExecutorError();
    const remotePaths = generation.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entryPath) => entryPath.startsWith(".github/ISSUE_TEMPLATE/"));
    const native = discoverTemplatesFromPaths(remotePaths).issueTemplates.map((template) => template.path);
    if (native.length > 0) return [...new Set(native)].sort();

    // Semantic-only repositories may not have generated native files.  Their
    // source identities are still compiled by the same local compiler seam.
    const semanticPaths = generation.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entryPath) => /^\.github\/inari\/issues\/[^/]+\.json$/u.test(entryPath));
    if (semanticPaths.length === 0) throw new GitHubActionsChangeExecutorError();
    return [...new Set(semanticPaths)].sort();
  }

  private assertGovernedIssue(contract: CanonicalContract, body: string): void {
    const diagnostics = validateGovernedRootIssueEvidence({ contract, body });
    if (diagnostics.length > 0) throw new GitHubActionsChangeExecutorError();
  }

  private assertCanonicalIssueBody(
    contract: CanonicalContract,
    body: string,
    result: ReturnType<typeof validateExistingIssueArtifact>,
  ): void {
    try {
      const canonical = renderIssueArtifact(contract, {
        fields: result.parse.values,
        ...(result.parse.dependencies === undefined ? {} : { dependencies: result.parse.dependencies }),
      });
      if (canonical !== body) throw new GitHubActionsChangeExecutorError();
    } catch {
      throw new GitHubActionsChangeExecutorError();
    }
  }

  private async readPullRequestBody(number: number): Promise<string | null | undefined> {
    const response = await this.request(
      { method: "GET", path: apiPath(this.#options.repository, `pulls/${number}`) },
      200,
    );
    const value = record(response);
    if (positiveNumber(value.number) !== number) throw new GitHubActionsChangeExecutorError();
    return boundedArtifactBody(value.body);
  }

  private async readGovernanceTree(ref: string): Promise<GovernanceTree> {
    const response = await this.request(
      {
        method: "GET",
        path: apiPath(this.#options.repository, `git/trees/${encodeURIComponent(ref)}?recursive=1`),
      },
      200,
    );
    const value = record(response);
    const sha = boundedString(value.sha, 255);
    if (value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > 2048) {
      throw new GitHubActionsChangeExecutorError();
    }
    const entries = value.tree.map((entry): GovernanceTree["entries"][number] => {
      const candidate = record(entry);
      const type = candidate.type === "blob" || candidate.type === "tree" ? candidate.type : undefined;
      if (type === undefined) throw new GitHubActionsChangeExecutorError();
      return { path: boundedString(candidate.path, 512), type, sha: boundedString(candidate.sha, 255) };
    });
    return { sha, entries };
  }

  private async readGovernedContract(
    domain: "issue" | "pr",
    ref: string,
    generation: GovernanceTree,
    selector: string,
  ): Promise<CanonicalContract | undefined> {
    const cwd = this.#options.cwd;
    if (cwd === undefined) return undefined;
    let contract: CanonicalContract;
    try {
      contract = await compileLocalGovernedContract(domain, cwd, selector);
    } catch {
      return undefined;
    }
    const templatePath = contract.templateIdentity.path;
    const templateEntry = generation.entries.find((entry) => entry.type === "blob" && entry.path === templatePath);
    if (templateEntry === undefined) return undefined;
    const templateSource = await this.readMatchingGovernanceFile(cwd, templateEntry.path, templateEntry.sha);
    if (templateSource === undefined) return undefined;

    // The local compiler is used only as the existing Core compiler seam. Its
    // semantic source and generated native projection must both be the exact
    // files observed in the trusted GitHub generation.
    const semanticPath = semanticSourcePath(domain, contract.templateIdentity.id);
    const semanticEntry = generation.entries.find((entry) => entry.path === semanticPath);
    const semanticSource =
      semanticEntry === undefined || semanticEntry.type !== "blob"
        ? undefined
        : await this.readMatchingGovernanceFile(cwd, semanticEntry.path, semanticEntry.sha);
    if (
      semanticEntry !== undefined
        ? semanticSource === undefined
        : (await this.readLocalGovernanceFile(cwd, semanticPath)) !== undefined
    ) {
      return undefined;
    }
    const policyEntry =
      domain === "pr"
        ? generation.entries.find((entry) => POLICY_PATHS.includes(entry.path as (typeof POLICY_PATHS)[number]))
        : undefined;
    if (policyEntry !== undefined && policyEntry.type !== "blob") return undefined;
    const policySource =
      policyEntry === undefined
        ? undefined
        : await this.readMatchingGovernanceFile(cwd, policyEntry.path, policyEntry.sha);
    if (policyEntry !== undefined && policySource === undefined) return undefined;
    if (domain === "pr" && policyEntry === undefined) {
      for (const policyPath of POLICY_PATHS) {
        if ((await this.readLocalGovernanceFile(cwd, policyPath)) !== undefined) return undefined;
      }
    }
    const resolutionEntry = generation.entries.find((entry) => entry.path === TEMPLATE_RESOLUTION_CONFIG_PATH);
    if (resolutionEntry !== undefined && resolutionEntry.type !== "blob") return undefined;
    const resolutionSource =
      resolutionEntry === undefined
        ? undefined
        : await this.readMatchingGovernanceFile(cwd, resolutionEntry.path, resolutionEntry.sha);
    if (resolutionEntry !== undefined && resolutionSource === undefined) return undefined;
    const provenance: ContractProvenance = {
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
      ...(domain === "pr" ? { branchGovernance: this.#options.branchGovernance } : {}),
    };
    return { ...contract, provenance };
  }

  private async readLocalGovernanceFile(cwd: string, filePath: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(cwd, filePath), "utf8");
    } catch {
      return undefined;
    }
  }

  private async readMatchingGovernanceFile(
    cwd: string,
    filePath: string,
    expectedSha: string,
  ): Promise<string | undefined> {
    const source = await this.readLocalGovernanceFile(cwd, filePath);
    return source !== undefined && gitBlobSha(source) === expectedSha ? source : undefined;
  }

  private async readBranch(branch: string): Promise<boolean> {
    const response = await this.#options.transport.request({
      hostname: this.#options.repository.hostname,
      method: "GET",
      path: apiPath(this.#options.repository, `git/ref/heads/${encodeURIComponent(branch)}`),
    });
    if (response.status === 404) return false;
    if (response.status !== 200) throw new GitHubActionsChangeExecutorError();
    const value = record(response.body);
    if (value.ref !== `refs/heads/${branch}`) throw new GitHubActionsChangeExecutorError();
    return true;
  }

  private async readBranches(
    derivedBranch: string | undefined,
  ): Promise<readonly { name: string; rootIssue?: number }[]> {
    const names = new Set<string>();
    if (derivedBranch !== undefined && (await this.readBranch(derivedBranch))) names.add(derivedBranch);
    const response = await this.#options.transport.request({
      hostname: this.#options.repository.hostname,
      method: "GET",
      path: apiPath(this.#options.repository, "git/matching-refs/heads/"),
    });
    if (response.status === 404) return [...names].map((name) => ({ name }));
    if (response.status !== 200 || !Array.isArray(response.body) || response.body.length >= MAX_PULL_REQUESTS) {
      throw new GitHubActionsChangeExecutorError();
    }
    for (const candidate of response.body) {
      const value = record(candidate);
      const ref = boundedString(value.ref, 512);
      const prefix = "refs/heads/";
      if (!ref.startsWith(prefix)) throw new GitHubActionsChangeExecutorError();
      const name = ref.slice(prefix.length);
      if (branchBelongsToRootIssue(name, this.#options.identity.rootIssue, this.#options.branchGovernance)) {
        names.add(name);
      }
    }
    const orderedNames = [...names].sort();
    const hasHistoricalCandidate = orderedNames.some((name) => name !== derivedBranch);
    return orderedNames.map((name) =>
      hasHistoricalCandidate ? { name, rootIssue: this.#options.identity.rootIssue } : { name },
    );
  }

  private async readPullRequests(
    derivedBranch: string | undefined,
    hasHistoricalBranch: boolean,
  ): Promise<readonly ChangePullRequestEvidence[]> {
    const response = await this.#options.transport.request({
      hostname: this.#options.repository.hostname,
      method: "GET",
      path: apiPath(this.#options.repository, `pulls?state=all&per_page=${MAX_PULL_REQUESTS}`),
    });
    if (response.status !== 200 || !Array.isArray(response.body) || response.body.length >= MAX_PULL_REQUESTS) {
      throw new GitHubActionsChangeExecutorError();
    }
    const pullRequests = response.body.flatMap((candidate): ChangePullRequestEvidence[] => {
      const value = record(candidate);
      const head = record(value.head);
      const base = record(value.base);
      const user = record(value.user);
      const state = value.state === "open" || value.state === "closed" ? value.state : undefined;
      if (state === undefined || typeof value.draft !== "boolean") throw new GitHubActionsChangeExecutorError();
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
    const hasHistoricalCandidate =
      hasHistoricalBranch || pullRequests.some((candidate) => candidate.head !== derivedBranch);
    return pullRequests.map((candidate) =>
      hasHistoricalCandidate || candidate.head !== derivedBranch
        ? { ...candidate, rootIssue: this.#options.identity.rootIssue }
        : candidate,
    );
  }

  private async request(request: Omit<GitHubChangeEffectRequest, "hostname">, expected: number): Promise<unknown> {
    const response = await this.#options.transport.request({
      ...request,
      hostname: this.#options.repository.hostname,
    });
    if (response.status !== expected) throw new GitHubActionsChangeExecutorError();
    return response.body;
  }
}

export async function loadBranchGovernance(cwd: string): Promise<PullRequestBranchGovernance | undefined> {
  try {
    for (const policyPath of POLICY_PATHS) {
      let source: string;
      try {
        source = await readFile(path.join(cwd, policyPath), "utf8");
      } catch {
        // Continue only when this repository-native policy path is absent.
        continue;
      }
      const overlay = parsePullRequestPolicyOverlay(source);
      // A repository-native policy with no branch rule declares no branch precondition.
      return overlay.branch;
    }
    throw new GitHubActionsChangeExecutorError();
  } catch (error: unknown) {
    throw withFailureStage(error, "branch-governance");
  }
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  key: string,
  stage: TrustedActionsFailureStage = "trusted-execution",
): string {
  const value = environment[key];
  if (value === undefined) throw new GitHubActionsChangeExecutorError(undefined, stage);
  try {
    return boundedString(value, 16_384);
  } catch (error: unknown) {
    throw withFailureStage(error, stage);
  }
}

function issuerFailureStage(error: unknown): TrustedActionsFailureStage {
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) return error.details.stage;
  if (error instanceof IssuerAuthorityError) {
    if (["ISSUER_INVALID_EXECUTION", "ISSUER_UNTRUSTED_EXECUTION", "ISSUER_UNSUPPORTED_EVENT"].includes(error.code)) {
      return "trusted-execution";
    }
    if (
      [
        "ISSUER_INVALID_SCOPE",
        "ISSUER_PERMISSION_MISMATCH",
        "ISSUER_SCOPE_MISMATCH",
        "ISSUER_CREDENTIAL_EXPIRED",
      ].includes(error.code)
    ) {
      return "installation-scope";
    }
    if (["ISSUER_INVALID_EFFECT", "ISSUER_UNSUPPORTED_EFFECT", "ISSUER_MUTATION_FAILED"].includes(error.code)) {
      return "projection-execution";
    }
  }
  return "installation-token";
}

function trustedFailureStage(
  error: unknown,
  issuerStage: TrustedActionsFailureStage | undefined,
): TrustedActionsFailureStage {
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) return error.details.stage;
  if (error instanceof ChangeTrustedExecutorError) {
    if (error.code === "CHANGE_EXECUTION_READ_FAILED") return "repository-evidence";
    return issuerStage ?? "projection-execution";
  }
  if (error instanceof IssuerAuthorityError) return issuerFailureStage(error);
  return issuerStage ?? "projection-execution";
}

function asTrustedActionsFailure(
  error: unknown,
  issuerStage: TrustedActionsFailureStage | undefined,
): GitHubActionsChangeExecutorError {
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) return error;
  return new GitHubActionsChangeExecutorError(undefined, trustedFailureStage(error, issuerStage));
}

export interface GitHubActionsRuntimeOptions {
  readonly cwd: string;
  readonly request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}

/** Build the trusted executor from GitHub Actions runtime claims and secrets. */
export async function createGitHubActionsChangeExecutor(
  options: GitHubActionsRuntimeOptions,
): Promise<ChangeRemoteExecutor> {
  const environment = options.environment ?? process.env;
  let repositoryNameWithOwner: string;
  let hostname = "github.com";
  let readTransport: GitHubActionsApiTransport;
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
  } catch (error: unknown) {
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
  let repositoryBody: Record<string, unknown>;
  try {
    repositoryBody = record(repositoryResponse.body);
  } catch (error: unknown) {
    throw atRepositoryEvidenceReason("repository-body")(error);
  }
  const repositoryId = String(repositoryBody.id);
  if (!/^[1-9][0-9]{0,19}$/u.test(repositoryId)) {
    throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", "repository-id");
  }
  if (typeof repositoryBody.fork !== "boolean") {
    throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", "repository-fork");
  }
  const target: IssuerRepositoryIdentity = {
    repositoryHost: repository.hostname,
    repositoryId,
    nameWithOwner: repositoryNameWithOwner,
  };

  const event = requiredEnvironment(environment, "GITHUB_EVENT_NAME", "trusted-execution");
  if (!TRUSTED_EXECUTION_EVENTS.includes(event as TrustedExecutionEvent)) {
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

  let execution: TrustedExecutionContext;
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
  } catch (error: unknown) {
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
        throw new GitHubActionsChangeExecutorError(
          "Read-only Change execution cannot apply effects.",
          "projection-execution",
        );
      },
      read: async (request) => {
        try {
          return projectChangeFromGitHubEvidence(await reader.read(request));
        } catch (error: unknown) {
          throw withFailureStage(error, "projection-execution");
        }
      },
    };
  }
  let broker: GitHubActionsCredentialBroker;
  let authority: InariIssuerAppAuthority;
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
  } catch (error: unknown) {
    throw withFailureStage(error, "issuer-configuration");
  }
  let issuerStage: TrustedActionsFailureStage | undefined;
  const stagedAuthority: Pick<InariIssuerAppAuthority, "applyEffects"> = {
    applyEffects: async (input) => {
      try {
        return await authority.applyEffects(input);
      } catch (error: unknown) {
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
      } catch (error: unknown) {
        throw asTrustedActionsFailure(error, issuerStage);
      }
    },
    read: async (request) => {
      try {
        return await trustedExecutor.read(request);
      } catch (error: unknown) {
        throw asTrustedActionsFailure(error, undefined);
      }
    },
  };
}

function sanitizedFailure(error: unknown): Record<string, unknown> {
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
export async function runGitHubActionsChangeExecutor(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<number> {
  try {
    const serialized = requiredEnvironment(environment, "INARI_CHANGE_REQUEST", "trusted-execution");
    let requestValue: unknown;
    try {
      requestValue = JSON.parse(serialized) as unknown;
    } catch {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    const requestRecord = requestValue as Record<string, unknown>;
    const allowedRequestKeys = new Set(["version", "operation", "issue", "requester"]);
    if (Object.keys(requestRecord).some((key) => !allowedRequestKeys.has(key))) {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (requestRecord.requester !== undefined && typeof requestRecord.requester !== "string") {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (
      requestRecord.version !== CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION ||
      typeof requestRecord.operation !== "string" ||
      typeof requestRecord.issue !== "number"
    ) {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (requestRecord.operation !== "show" && !["issue", "ready", "abort"].includes(requestRecord.operation)) {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    const requester = typeof requestRecord.requester === "string" ? requestRecord.requester : undefined;
    const request =
      requestRecord.operation === "show"
        ? changeRemoteReadRequest(requestRecord.issue, requester)
        : changeRemoteMutationRequest(
            requestRecord.operation as "issue" | "ready" | "abort",
            requestRecord.issue,
            requester,
          );
    const executor = await createGitHubActionsChangeExecutor({ cwd, request, environment });
    const result = request.operation === "show" ? await executor.read(request) : await executor.execute(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error: unknown) {
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
