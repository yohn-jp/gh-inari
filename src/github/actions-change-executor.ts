/**
 * GitHub Actions trusted runtime for Change plans.
 *
 * The workflow supplies only a semantic request. This module resolves bounded
 * GitHub evidence, invokes Core planning, applies explicit effects through the
 * #217 issuer authority, and verifies a fresh #213 projection.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_CHANGE_ARTIFACT_BODY_LENGTH,
  deriveCanonicalBranchIdentity,
  projectChangeFromGitHubEvidence,
  validateGovernedRootIssueEvidence,
  type CanonicalBranchNamingInput,
  type ChangeBranchEvidence,
  type ChangeDiagnostic,
  type ChangeProjectionInput,
  type ChangePullRequestEvidence,
  type ChangeReadyEvidence,
} from "../change.js";
import {
  extractTemplateIdentityMarker,
  preparePullRequestArtifact,
  renderIssueArtifact,
  selectExistingArtifactCandidate,
  validateExistingIssueArtifact,
  type ExistingArtifactCandidate,
} from "../artifact.js";
import { compileLocalGovernedContract } from "../governance.js";
import { discoverTemplatesFromPaths } from "../template-discovery.js";
import { artifactContractProvenanceFromTemplate } from "../contract/ir.js";
import { effectiveFieldConstraints } from "../contract/constraints.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  canonicalGitHubRequester,
  changeRemoteMutationRequest,
  changeRemoteReadRequest,
  normalizeChangeRemoteExecutionEvidence,
  normalizeChangeRemoteExecutionResult,
  normalizeChangeRemoteProjection,
  type ChangeRemoteExecutor,
  type ChangeRemoteExecutionEvidence,
  type ChangeRemoteMutationRequest,
  type ChangeRemoteReadRequest,
} from "../change-executor.js";
import {
  ChangeTrustedExecutorError,
  isChangeTrustedExecutorErrorCode,
  TrustedChangeExecutor,
  type ChangeTrustedExecutorErrorCode,
  type ChangeTrustedEvidenceReader,
} from "../change-trusted-executor.js";
import { normalizeTrustedFailureDiagnostics } from "../change-failure-diagnostics.js";
import {
  GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES,
  type GitHubChangeEffectRepository,
  type GitHubChangeEffectRequest,
} from "./change-effect-adapter.js";
import {
  GitHubAppApiTransport,
  GitHubAppInstallationCredentialBroker,
  resolveGitHubRepository,
  type GitHubAppInstallationCredentialBrokerOptions,
  type GitHubAppRepositoryReadTransport,
  type GitHubAppCredentialFailureStage,
} from "./app-installation-credential-broker.js";
import {
  InariIssuerAppAuthority,
  assertTrustedExecution,
  TRUSTED_EXECUTION_EVENTS,
  type IssuerRepositoryIdentity,
  type TrustedExecutionEvent,
  type TrustedExecutionContext,
  IssuerAuthorityError,
} from "./issuer-authority.js";
import { INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";
import { parsePullRequestPolicyOverlay } from "../pr-policy.js";
import { TEMPLATE_RESOLUTION_CONFIG_PATH } from "../template-resolver.js";
import type { CanonicalContract, ContractProvenance, PullRequestBranchGovernance } from "../contract/ir.js";
import {
  SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION,
  SEMANTIC_PULL_REQUEST_PROJECTION_VERSION,
  validateSemanticPullRequestMutationPlan,
  type SemanticPullRequestMutationPlan,
} from "../semantic-pr-projection.js";

const MAX_BRANCH_MATCHES = 100;
const MAX_CANONICAL_PULL_REQUEST_MATCHES = 100;
const POLICY_PATHS = [".github/inari/pr-policy.yml", ".inari/pr-policy.yml"] as const;
const MAX_TITLE_LENGTH = 255;
const MAX_LOGIN_LENGTH = 160;
const MAX_TIMESTAMP_LENGTH = 64;
const DEFAULT_API_URL = "https://api.github.com";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const ISSUE_TITLE_PATTERN = /^(feat|fix|docs|refactor|test|chore):\s*(.+)$/iu;
const ISSUER_LOGIN_NAMES = new Set(["inari-issuer[bot]", "inari-issuer"]);
const CANONICAL_BRANCH_TYPES = new Set(["feat", "fix", "docs", "refactor", "test", "chore"]);
const GITHUB_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

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

function actionsToAppFailureStage(
  stage: TrustedActionsFailureStage | undefined,
): GitHubAppCredentialFailureStage | undefined {
  switch (stage) {
    case "repository-evidence":
      return "repository-read";
    case "issuer-configuration":
    case "installation-token":
    case "installation-scope":
    case "projection-execution":
      return stage;
    default:
      return "projection-execution";
  }
}

/**
 * Bounded, secret-safe reasons within the `repository-evidence` stage. Fixed at the
 * exact repository read boundary that failed so evidence failures do not collapse
 * into one undifferentiated stage.
 */
export const REPOSITORY_EVIDENCE_FAILURE_REASONS = Object.freeze([
  "repository-configuration",
  "repository-request",
  "repository-status",
  "repository-body",
  "repository-id",
  "repository-fork",
  "pull-request-evidence",
] as const);
export type RepositoryEvidenceFailureReason = (typeof REPOSITORY_EVIDENCE_FAILURE_REASONS)[number];

export function isRepositoryEvidenceFailureReason(value: unknown): value is RepositoryEvidenceFailureReason {
  return REPOSITORY_EVIDENCE_FAILURE_REASONS.includes(value as RepositoryEvidenceFailureReason);
}

export interface TrustedActionsFailureDiagnostic {
  readonly stage: TrustedActionsFailureStage;
  readonly reason?: RepositoryEvidenceFailureReason;
  readonly trustedCode?: ChangeTrustedExecutorErrorCode;
  readonly diagnostics?: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeRemoteExecutionEvidence;
}

export function isTrustedActionsFailureStage(value: unknown): value is TrustedActionsFailureStage {
  return TRUSTED_ACTIONS_FAILURE_STAGES.includes(value as TrustedActionsFailureStage);
}

function failureDiagnostic(
  stage: TrustedActionsFailureStage,
  reason?: RepositoryEvidenceFailureReason,
  fields: Omit<TrustedActionsFailureDiagnostic, "stage" | "reason"> = {},
): TrustedActionsFailureDiagnostic {
  return Object.freeze({
    stage,
    ...(reason === undefined ? {} : { reason }),
    ...(fields.trustedCode === undefined ? {} : { trustedCode: fields.trustedCode }),
    ...(fields.diagnostics === undefined ? {} : { diagnostics: fields.diagnostics }),
    ...(fields.evidence === undefined ? {} : { evidence: fields.evidence }),
  });
}

function trustedFailureFields(
  error: ChangeTrustedExecutorError,
): Omit<TrustedActionsFailureDiagnostic, "stage" | "reason"> {
  const fields: {
    trustedCode?: ChangeTrustedExecutorErrorCode;
    diagnostics?: readonly ChangeDiagnostic[];
    evidence?: ChangeRemoteExecutionEvidence;
  } = {};
  if (isChangeTrustedExecutorErrorCode(error.code)) fields.trustedCode = error.code;
  try {
    const diagnostics = normalizeTrustedFailureDiagnostics(error.diagnostics);
    if (diagnostics !== undefined && diagnostics.length > 0) fields.diagnostics = diagnostics;
  } catch {
    // Invalid internal diagnostics are omitted rather than serialized.
  }
  if (error.evidence !== undefined) {
    try {
      fields.evidence = normalizeChangeRemoteExecutionEvidence(error.evidence.operation, error.evidence);
    } catch {
      // Invalid internal evidence is omitted rather than serialized.
    }
  }
  return fields;
}

export class GitHubActionsChangeExecutorError extends Error {
  readonly code = "CHANGE_ACTIONS_RUNTIME_INVALID" as const;
  readonly details?: TrustedActionsFailureDiagnostic;

  constructor(
    message = "Trusted Change Actions runtime configuration is invalid.",
    stage?: TrustedActionsFailureStage,
    reason?: RepositoryEvidenceFailureReason,
    fields: Omit<TrustedActionsFailureDiagnostic, "stage" | "reason"> = {},
  ) {
    super(message);
    this.name = "GitHubActionsChangeExecutorError";
    this.details = stage === undefined ? undefined : failureDiagnostic(stage, reason, fields);
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

function boundedGitHubTimestamp(value: unknown): string {
  const timestamp = boundedString(value, MAX_TIMESTAMP_LENGTH);
  const match = GITHUB_TIMESTAMP_PATTERN.exec(timestamp);
  if (match === null) throw new GitHubActionsChangeExecutorError();

  const date = new Date(timestamp);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0"));
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hours ||
    date.getUTCMinutes() !== minutes ||
    date.getUTCSeconds() !== seconds ||
    date.getUTCMilliseconds() !== milliseconds
  ) {
    throw new GitHubActionsChangeExecutorError();
  }
  return timestamp;
}

function mergedStateFromGitHubEvidence(value: unknown): boolean {
  if (value === null) return false;
  boundedGitHubTimestamp(value);
  return true;
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

function optionalCommitSha(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  return object.type === "commit" && typeof object.sha === "string" && COMMIT_SHA_PATTERN.test(object.sha)
    ? object.sha.toLowerCase()
    : undefined;
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

function apiPath(repository: GitHubChangeEffectRepository, suffix: string): string {
  const base = `repos/${repository.owner}/${repository.name}`;
  return suffix === "" ? base : `${base}/${suffix}`;
}

export interface GitHubActionsApiTransportOptions {
  readonly apiUrl?: string;
  readonly token: string;
  /** GraphQL repository node ID used by the atomic conditional ref update. */
  readonly repositoryNodeId?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly failureStage?: TrustedActionsFailureStage;
}

/** Compatibility wrapper; the credential-bound implementation lives in the App module. */
export class GitHubActionsApiTransport extends GitHubAppApiTransport {
  constructor(options: GitHubActionsApiTransportOptions) {
    super({
      ...options,
      failureStage: actionsToAppFailureStage(options.failureStage),
      failure: (stage) =>
        new GitHubActionsChangeExecutorError(
          undefined,
          stage === "repository-read" ? "repository-evidence" : (stage as TrustedActionsFailureStage),
        ),
    });
  }
}

export interface GitHubActionsCredentialBrokerOptions extends GitHubAppInstallationCredentialBrokerOptions {}

/** Compatibility wrapper; Actions and direct App runtimes share the broker implementation. */
export class GitHubActionsCredentialBroker extends GitHubAppInstallationCredentialBroker {
  constructor(options: GitHubActionsCredentialBrokerOptions) {
    super({
      ...options,
      failure: (stage) =>
        new GitHubActionsChangeExecutorError(
          undefined,
          stage === "repository-read" ? "repository-evidence" : (stage as TrustedActionsFailureStage),
        ),
      mutationFailure: (effect) =>
        new GitHubActionsChangeExecutorError(GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES[effect.kind]),
    });
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
  /**
   * Pull request currently being evaluated at a repository merge boundary.
   * The target PR is retained even when its head is not a Change-shaped branch
   * so the admission adapter cannot silently classify it as unrelated.
   */
  readonly pullRequestNumber?: number;
  /** Absent when the repository's PR policy declares no branch rule; the canonical branch grammar still applies. */
  readonly branchGovernance?: PullRequestBranchGovernance;
  readonly transport: GitHubAppRepositoryReadTransport;
  /** Trusted checkout containing the repository's default-branch governance. */
  readonly cwd?: string;
  /**
   * Core-produced PR plan supplied by the semantic preparation boundary.
   * Omitted only while the explicit v1 Change payload remains in compatibility mode.
   */
  readonly semanticPullRequestPlan?: unknown;
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
    const repositoryResponse = await this.#options.transport
      .request({
        hostname: this.#options.repository.hostname,
        method: "GET",
        path: apiPath(this.#options.repository, ""),
      })
      .catch(atRepositoryEvidenceReason("repository-request"));
    if (repositoryResponse.status !== 200) {
      throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", "repository-status");
    }
    let repository: Record<string, unknown>;
    try {
      repository = record(repositoryResponse.body);
    } catch (error: unknown) {
      throw atRepositoryEvidenceReason("repository-body")(error);
    }
    if (String(repository.id) !== this.#options.identity.repositoryId) {
      throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", "repository-id");
    }
    let baseBranch: string;
    try {
      baseBranch = boundedString(repository.default_branch, 255);
    } catch (error: unknown) {
      throw atRepositoryEvidenceReason("repository-body")(error);
    }
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
    const pullRequests = await this.readPullRequests(derivedBranch, baseBranch, branches).catch(
      atRepositoryEvidenceReason("pull-request-evidence"),
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
    let semanticPullRequestPlan: SemanticPullRequestMutationPlan | undefined;
    if (this.#options.semanticPullRequestPlan !== undefined) {
      if (request.operation !== "issue") throw new GitHubActionsChangeExecutorError();
      const result = validateSemanticPullRequestMutationPlan(this.#options.semanticPullRequestPlan);
      if (!result.valid || result.plan === undefined) throw new GitHubActionsChangeExecutorError();
      semanticPullRequestPlan = result.plan;
    } else if (
      request.operation === "issue" &&
      this.#options.cwd !== undefined &&
      !pullRequests.some((candidate) => candidate.head === canonicalBranch && candidate.base === baseBranch)
    ) {
      semanticPullRequestPlan = await this.buildGovernedPullRequestPlan(baseBranch, canonicalBranch, request.issue);
    }
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
      ...(semanticPullRequestPlan === undefined ? {} : { semanticPullRequestPlan }),
    };
  }

  /**
   * Render the Draft pull request body through the same governed PR
   * template/policy authority `change ready` later re-reads, so the created
   * body carries a real `inari:template` identity marker instead of the
   * historical `Closes #N` compatibility text. Section content that cannot
   * be known before implementation exists (summary/changes) is filled with
   * neutral placeholder text sufficient to satisfy policy-required,
   * non-empty sections; `change ready` review is expected to replace it with
   * the real content before merge.
   */
  private async buildGovernedPullRequestPlan(
    baseBranch: string,
    branch: string,
    rootIssue: number,
  ): Promise<SemanticPullRequestMutationPlan | undefined> {
    const generation = await this.readGovernanceTree(baseBranch);
    const contract = await this.readGovernedContract("pr", baseBranch, generation, "default");
    if (contract === undefined || contract.provenance === undefined) return undefined;
    const fields: Record<string, unknown> = {};
    for (const section of contract.sections) {
      for (const field of section.fields) {
        const constraints = effectiveFieldConstraints(contract, field);
        if (constraints.linkedIssue) {
          fields[field.id] = `Closes #${rootIssue}`;
        } else if (field.type === "checklist") {
          fields[field.id] = constraints.checklistRequireComplete
            ? field.items.map((item) => item.id)
            : constraints.requiredItems;
        } else if (constraints.required) {
          fields[field.id] = `Implementation in progress for #${rootIssue}.`;
        }
      }
    }
    let prepared: ReturnType<typeof preparePullRequestArtifact>;
    try {
      prepared = preparePullRequestArtifact(contract, {
        fields,
        metadata: { title: `Change #${rootIssue}`, head: branch, base: baseBranch, draft: true },
      });
    } catch {
      return undefined;
    }
    const provenance = artifactContractProvenanceFromTemplate(contract.provenance);
    const desired = {
      version: SEMANTIC_PULL_REQUEST_PROJECTION_VERSION,
      kind: "pull_request" as const,
      title: prepared.artifact.title,
      head: prepared.artifact.head,
      base: prepared.artifact.base,
      body: prepared.artifact.body,
      metadata: { draft: true },
      relations: {
        implements: {
          relation: "implements" as const,
          references: [
            {
              repositoryHost: this.#options.identity.repositoryHost,
              repositoryId: this.#options.identity.repositoryId,
              number: rootIssue,
            },
          ],
          representation: "recognized-convention" as const,
        },
      },
      provenance,
      generation: provenance,
    };
    const plan = {
      version: SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION,
      kind: "pull_request" as const,
      artifact: {
        version: "1" as const,
        effectiveContractVersion: "1" as const,
        artifactContractVersion: "1" as const,
        kind: "pull_request" as const,
        id: contract.templateIdentity.id,
        digest: createHash("sha256").update(desired.body, "utf8").digest("hex"),
      },
      provenance,
      generation: provenance,
      capabilities: ["recognized"],
      desired,
      preconditions: [
        { kind: "GOVERNANCE_GENERATION_MATCH" as const, generation: provenance },
        { kind: "PULL_REQUEST_TARGET_ABSENT" as const, head: desired.head, base: desired.base },
      ],
      effects: [{ kind: "CREATE_PULL_REQUEST" as const, desired }],
    };
    const result = validateSemanticPullRequestMutationPlan(plan);
    return result.valid ? result.plan : undefined;
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
      ...(domain === "pr" && this.#options.branchGovernance !== undefined
        ? { branchGovernance: this.#options.branchGovernance }
        : {}),
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

  private async readBranch(branch: string): Promise<ChangeBranchEvidence | undefined> {
    const response = await this.#options.transport.request({
      hostname: this.#options.repository.hostname,
      method: "GET",
      path: apiPath(this.#options.repository, `git/ref/heads/${encodeURIComponent(branch)}`),
    });
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new GitHubActionsChangeExecutorError();
    const value = record(response.body);
    if (value.ref !== `refs/heads/${branch}`) throw new GitHubActionsChangeExecutorError();
    const sha = optionalCommitSha(value.object);
    return { name: branch, ...(sha === undefined ? {} : { sha }) };
  }

  private async readBranches(derivedBranch: string | undefined): Promise<readonly ChangeBranchEvidence[]> {
    const branches = new Map<string, string | undefined>();
    if (derivedBranch !== undefined) {
      const observed = await this.readBranch(derivedBranch);
      if (observed !== undefined) branches.set(observed.name, observed.sha);
    }
    const response = await this.#options.transport.request({
      hostname: this.#options.repository.hostname,
      method: "GET",
      path: apiPath(this.#options.repository, "git/matching-refs/heads/"),
    });
    if (response.status === 404)
      return [...branches].map(([name, sha]) => ({ name, ...(sha === undefined ? {} : { sha }) }));
    if (response.status !== 200 || !Array.isArray(response.body) || response.body.length >= MAX_BRANCH_MATCHES) {
      throw new GitHubActionsChangeExecutorError();
    }
    for (const candidate of response.body) {
      const value = record(candidate);
      const ref = boundedString(value.ref, 512);
      const prefix = "refs/heads/";
      if (!ref.startsWith(prefix)) throw new GitHubActionsChangeExecutorError();
      const name = ref.slice(prefix.length);
      if (branchBelongsToRootIssue(name, this.#options.identity.rootIssue, this.#options.branchGovernance)) {
        const sha = optionalCommitSha(value.object);
        if (!branches.has(name) || sha !== undefined) branches.set(name, sha);
      }
    }
    const orderedNames = [...branches.keys()].sort();
    const hasHistoricalCandidate = orderedNames.some((name) => name !== derivedBranch);
    return orderedNames.map((name) =>
      hasHistoricalCandidate
        ? {
            name,
            ...(branches.get(name) === undefined ? {} : { sha: branches.get(name) }),
            rootIssue: this.#options.identity.rootIssue,
          }
        : { name, ...(branches.get(name) === undefined ? {} : { sha: branches.get(name) }) },
    );
  }

  private async readPullRequests(
    derivedBranch: string | undefined,
    baseBranch: string,
    branches: readonly ChangeBranchEvidence[],
  ): Promise<readonly ChangePullRequestEvidence[]> {
    const candidateBranches = new Set(branches.map((candidate) => candidate.name));
    if (derivedBranch !== undefined) candidateBranches.add(derivedBranch);
    const orderedBranches = [...candidateBranches].sort();
    const hasHistoricalBranch = branches.some((candidate) => candidate.rootIssue !== undefined);
    const pullRequests: ChangePullRequestEvidence[] = [];

    for (const branch of orderedBranches) {
      const response = await this.#options.transport.request({
        hostname: this.#options.repository.hostname,
        method: "GET",
        path: apiPath(
          this.#options.repository,
          `pulls?state=all&head=${encodeURIComponent(`${this.#options.repository.owner}:${branch}`)}&base=${encodeURIComponent(baseBranch)}&per_page=${MAX_CANONICAL_PULL_REQUEST_MATCHES}`,
        ),
      });
      if (
        response.status !== 200 ||
        !Array.isArray(response.body) ||
        response.body.length >= MAX_CANONICAL_PULL_REQUEST_MATCHES
      ) {
        throw new GitHubActionsChangeExecutorError();
      }
      for (const candidate of response.body) {
        const parsed = this.parsePullRequestEvidence(candidate, branch, false);
        if (parsed !== undefined) pullRequests.push(parsed);
      }
    }

    if (this.#options.pullRequestNumber !== undefined) {
      const response = await this.#options.transport.request({
        hostname: this.#options.repository.hostname,
        method: "GET",
        path: apiPath(this.#options.repository, `pulls/${this.#options.pullRequestNumber}`),
      });
      if (response.status !== 200) throw new GitHubActionsChangeExecutorError();
      const observed = this.parsePullRequestEvidence(response.body, undefined, true);
      if (observed !== undefined && !pullRequests.some((candidate) => candidate.number === observed.number)) {
        pullRequests.push(observed);
      }
    }

    const hasHistoricalCandidate =
      hasHistoricalBranch || pullRequests.some((candidate) => candidate.head !== derivedBranch);
    return pullRequests.map((candidate) =>
      hasHistoricalCandidate || candidate.head !== derivedBranch
        ? { ...candidate, rootIssue: this.#options.identity.rootIssue }
        : candidate,
    );
  }

  private parsePullRequestEvidence(
    candidate: unknown,
    expectedHead: string | undefined,
    observed: boolean,
  ): ChangePullRequestEvidence | undefined {
    const value = record(candidate);
    const head = record(value.head);
    const base = record(value.base);
    const user = record(value.user);
    const state = value.state === "open" || value.state === "closed" ? value.state : undefined;
    if (state === undefined || typeof value.draft !== "boolean") throw new GitHubActionsChangeExecutorError();
    const number = positiveNumber(value.number);
    if (observed && this.#options.pullRequestNumber !== undefined && number !== this.#options.pullRequestNumber) {
      throw new GitHubActionsChangeExecutorError();
    }
    const login = boundedString(user.login, MAX_LOGIN_LENGTH);
    const headName = boundedString(head.ref, 255);
    if (expectedHead !== undefined && headName !== expectedHead) return undefined;
    if (head.repo !== undefined && head.repo !== null) {
      const headRepository = record(head.repo);
      if (headRepository.full_name !== `${this.#options.repository.owner}/${this.#options.repository.name}`) {
        return undefined;
      }
    }
    if (
      !observed &&
      !branchBelongsToRootIssue(headName, this.#options.identity.rootIssue, this.#options.branchGovernance)
    ) {
      return undefined;
    }
    return {
      number,
      head: headName,
      base: boundedString(base.ref, 255),
      state,
      draft: value.draft,
      ...(state === "closed" ? { merged: mergedStateFromGitHubEvidence(value.merged_at) } : { merged: false }),
      provenance: { issuer: issuerPrincipal(login) },
      ...(observed ? { rootIssue: this.#options.identity.rootIssue } : {}),
    };
  }

  private async request(
    request: { readonly method: "GET"; readonly path: string },
    expected: number,
  ): Promise<unknown> {
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
      const filePath = path.join(cwd, policyPath);
      // O_NOFOLLOW pins the candidate to a single filesystem object: the open
      // itself fails on a symlinked final path element, so there is no window
      // between a link check and the read where the path can be swapped.
      let handle;
      try {
        handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (error: unknown) {
        // A fallback is safe only when the candidate path itself is absent.
        if (isFileNotFound(error)) continue;
        throw new GitHubActionsChangeExecutorError();
      }
      try {
        // Repository policy is a regular file authority; the descriptor above
        // already excludes a symlinked final path element.
        const stats = await handle.stat();
        if (!stats.isFile()) throw new GitHubActionsChangeExecutorError();
        const source = await handle.readFile("utf8");
        const overlay = parsePullRequestPolicyOverlay(source);
        // A repository-native policy with no branch rule declares no branch precondition.
        return overlay.branch;
      } finally {
        await handle.close();
      }
    }
    throw new GitHubActionsChangeExecutorError();
  } catch (error: unknown) {
    throw withFailureStage(error, "branch-governance");
  }
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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

/**
 * The workflow SHA is the generation that GitHub attested for this workflow.
 * Refusing to continue when the checkout resolves anything else closes the
 * moving-default-branch race before any privileged executor can be created.
 */
function assertAttestedCheckout(cwd: string, workflowSha: string): void {
  if (!COMMIT_SHA_PATTERN.test(workflowSha)) throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");

  let checkedOutSha: string;
  try {
    checkedOutSha = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
  }

  if (!COMMIT_SHA_PATTERN.test(checkedOutSha) || checkedOutSha.toLowerCase() !== workflowSha.toLowerCase()) {
    throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
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

export function asTrustedActionsFailure(
  error: unknown,
  issuerStage: TrustedActionsFailureStage | undefined,
): GitHubActionsChangeExecutorError {
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) return error;
  const stage = trustedFailureStage(error, issuerStage);
  return new GitHubActionsChangeExecutorError(
    undefined,
    stage,
    undefined,
    error instanceof ChangeTrustedExecutorError ? trustedFailureFields(error) : {},
  );
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
  const resolvedRepository = await resolveGitHubRepository(
    repository,
    readTransport,
    (reason) => new GitHubActionsChangeExecutorError(undefined, "repository-evidence", reason),
  );
  const { target, repositoryNodeId } = resolvedRepository;

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
  assertAttestedCheckout(options.cwd, workflowSha);
  const actor = requiredEnvironment(environment, "GITHUB_ACTOR", "trusted-execution");

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
      fork: resolvedRepository.fork,
      pullRequest: event === "pull_request" || event === "pull_request_target",
      requester: canonicalGitHubRequester(actor),
    });
  } catch (error: unknown) {
    throw withFailureStage(error, "trusted-execution");
  }
  const branchGovernance = await atFailureStage("branch-governance", () => loadBranchGovernance(options.cwd));
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: {
      repositoryHost: repository.hostname,
      repositoryId: target.repositoryId,
      rootIssue: options.request.issue,
    },
    branchGovernance,
    transport: readTransport,
    cwd: options.cwd,
    ...(options.request.operation !== "issue" || options.request.semanticPullRequestPlan === undefined
      ? {}
      : { semanticPullRequestPlan: options.request.semanticPullRequestPlan }),
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
      repositoryNodeId,
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
    const allowedRequestKeys = new Set(["version", "operation", "issue", "requester", "semanticPullRequestPlan"]);
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
    if (requestRecord.semanticPullRequestPlan !== undefined && requestRecord.operation !== "issue") {
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
            requestRecord.semanticPullRequestPlan,
          );
    const executor = await createGitHubActionsChangeExecutor({ cwd, request, environment });
    const result =
      request.operation === "show"
        ? normalizeChangeRemoteProjection(request.operation, await executor.read(request))
        : normalizeChangeRemoteExecutionResult(request.operation, await executor.execute(request));
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
