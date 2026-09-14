/**
 * Core-facing Change State Projector.
 *
 * This role consumes bounded provider evidence from the deployment-neutral
 * Evidence Reader and applies the existing Change/Core contracts: canonical
 * branch identity, governed artifact resolution, desired-state preparation,
 * and Change projection input. It performs no provider I/O directly.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  deriveCanonicalBranchIdentity,
  type CanonicalBranchNamingInput,
  type ChangeBranchEvidence,
  type ChangeProjectionInput,
  type ChangePullRequestEvidence,
  type ChangeReadyEvidence,
} from "../change.js";
import {
  branchBelongsToRootIssue,
  deriveBranchNamingFromIssueTitle,
  MAX_BRANCH_TITLE_LENGTH,
  recognizeBranchNamingForIssue,
  type BranchNaming,
} from "../branch-naming.js";
import {
  extractTemplateIdentityMarker,
  preparePullRequestArtifact,
  renderIssueArtifact,
  selectExistingArtifactCandidate,
  validateExistingIssueArtifact,
  type ExistingArtifactCandidate,
} from "../artifact.js";
import {
  compileLocalGovernedContract,
  compileRepositoryGovernedContract,
  resolveGovernedIssueEvidence,
  type RepositoryGovernanceSourceReader,
} from "../governance.js";
import { discoverTemplatesFromPaths } from "../template-discovery.js";
import { artifactContractProvenanceFromTemplate } from "../contract/ir.js";
import { effectiveFieldConstraints } from "../contract/constraints.js";
import { type ChangeMutationRequest, type ChangeReadRequest } from "../change-execution-port.js";
import {
  SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION,
  SEMANTIC_PULL_REQUEST_PROJECTION_VERSION,
  validateSemanticPullRequestMutationPlan,
  type SemanticPullRequestMutationPlan,
} from "../semantic-pr-projection.js";
import type { ChangeTrustedEvidenceReader } from "../change-trusted-executor.js";
import type { GitHubChangeEffectRepository } from "./change-effect-adapter.js";
import {
  GitHubRepositoryEvidenceReader,
  type GitHubRepositoryBranchEvidence,
  type GitHubRepositoryEvidenceReaderOptions,
  type GitHubRepositoryGovernanceTree,
  type GitHubRepositoryPullRequestEvidence,
} from "./repository-evidence-reader.js";
import type { IssuerRepositoryIdentity } from "./issuer-authority.js";
import type { ContractProvenance, CanonicalContract, PullRequestBranchGovernance } from "../contract/ir.js";
import { TEMPLATE_RESOLUTION_CONFIG_PATH } from "../template-resolver.js";

const POLICY_PATHS = [".github/inari/pr-policy.yml", ".inari/pr-policy.yml"] as const;
export interface GitHubChangeStateProjectorOptions {
  readonly repository: GitHubChangeEffectRepository;
  readonly identity: { readonly repositoryHost: string; readonly repositoryId: string; readonly rootIssue: number };
  readonly pullRequestNumber?: number;
  readonly branchGovernance?: PullRequestBranchGovernance;
  readonly transport: GitHubRepositoryEvidenceReaderOptions["transport"];
  readonly cwd?: string;
  readonly remoteGovernance?: RepositoryGovernanceSourceReader;
  readonly semanticPullRequestPlan?: unknown;
  /** Optional deployment-specific translation of bounded reader failures. */
  readonly onReadFailure?: (error: unknown) => never;
  readonly evidenceReader?: GitHubRepositoryEvidenceReader;
}

interface GovernanceTree {
  readonly sha: string;
  readonly entries: GitHubRepositoryGovernanceTree["entries"];
}

function deriveNaming(title: string): BranchNaming {
  if (title.length > MAX_BRANCH_TITLE_LENGTH) throw new Error("Issue title exceeds the branch naming bound.");
  return deriveBranchNamingFromIssueTitle(title);
}

/** Core naming compatibility entrypoint retained while callers migrate. */
export const deriveChangeNamingFromIssueTitle = deriveNaming;

function withoutObserved(candidate: GitHubRepositoryPullRequestEvidence): ChangePullRequestEvidence {
  const { observed: _observed, ...evidence } = candidate;
  return evidence;
}

function gitBlobSha(source: string): string {
  const bytes = Buffer.byteLength(source, "utf8");
  return createHash("sha1").update(`blob ${bytes}\0`, "utf8").update(source, "utf8").digest("hex");
}

function semanticSourcePath(domain: "issue" | "pr", id: string): string {
  if (domain === "issue") return `.github/inari/issues/${id}.json`;
  return id === "pull-request" ? ".github/inari/pull-request.json" : `.github/inari/pull-requests/${id}.json`;
}

export class GitHubChangeStateProjector implements ChangeTrustedEvidenceReader {
  readonly requiresGovernedIssueValidation: boolean;
  readonly #options: GitHubChangeStateProjectorOptions;
  readonly #reader: GitHubRepositoryEvidenceReader;

  constructor(options: GitHubChangeStateProjectorOptions) {
    this.#options = options;
    this.#reader =
      options.evidenceReader ??
      new GitHubRepositoryEvidenceReader({
        repository: options.repository,
        repositoryId: options.identity.repositoryId,
        transport: options.transport,
        ...(options.pullRequestNumber === undefined ? {} : { pullRequestNumber: options.pullRequestNumber }),
      });
    this.requiresGovernedIssueValidation = options.cwd !== undefined || options.remoteGovernance !== undefined;
  }

  async read(request: ChangeMutationRequest | ChangeReadRequest): Promise<ChangeProjectionInput> {
    try {
      return await this.readInternal(request);
    } catch (error: unknown) {
      if (this.#options.onReadFailure !== undefined) throw this.#options.onReadFailure(error);
      throw error;
    }
  }

  private async readInternal(request: ChangeMutationRequest | ChangeReadRequest): Promise<ChangeProjectionInput> {
    if (request.issue !== this.#options.identity.rootIssue)
      throw new Error("Change request Issue does not match reader scope.");

    const repository = await this.#reader.readRepository();
    const issue = await this.#reader.readIssue(request.issue);
    let naming: CanonicalBranchNamingInput | undefined;
    try {
      naming = deriveNaming(issue.title);
    } catch {
      // A title can be edited after issuance. Existing branch evidence remains
      // authoritative, while a completely unanchored title still fails closed.
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
    const pullRequests = await this.readPullRequests(derivedBranch, repository.defaultBranch, branches);
    const anchoredBranches = new Set<string>([
      ...branches.filter((candidate) => candidate.rootIssue === request.issue).map((candidate) => candidate.name),
      ...pullRequests.filter((candidate) => candidate.rootIssue === request.issue).map((candidate) => candidate.head),
    ]);
    if (anchoredBranches.size > 1) throw new Error("Multiple canonical Change branches were observed.");
    const canonicalBranch = anchoredBranches.size === 1 ? [...anchoredBranches][0] : derivedBranch;
    if (naming === undefined && canonicalBranch !== undefined)
      naming = recognizeBranchNamingForIssue(canonicalBranch, request.issue);
    if (naming === undefined || canonicalBranch === undefined)
      throw new Error("Canonical Change branch is unavailable.");

    const governedIssue =
      request.operation === "issue" && (this.#options.cwd !== undefined || this.#options.remoteGovernance !== undefined)
        ? await this.readGovernedIssue(issue.body, repository.defaultBranch)
        : undefined;
    const readyEvidence =
      request.operation === "ready"
        ? await this.readReadyEvidence(repository.defaultBranch, issue.body, pullRequests, canonicalBranch)
        : undefined;
    let semanticPullRequestPlan: SemanticPullRequestMutationPlan | undefined;
    if (this.#options.semanticPullRequestPlan !== undefined) {
      if (request.operation !== "issue") throw new Error("A Semantic PR plan is valid only for Change issuance.");
      const result = validateSemanticPullRequestMutationPlan(this.#options.semanticPullRequestPlan);
      if (!result.valid || result.plan === undefined) throw new Error("The Semantic PR plan is invalid.");
      semanticPullRequestPlan = result.plan;
    } else if (
      request.operation === "issue" &&
      (this.#options.cwd !== undefined || this.#options.remoteGovernance !== undefined) &&
      !pullRequests.some(
        (candidate) => candidate.head === canonicalBranch && candidate.base === repository.defaultBranch,
      )
    ) {
      semanticPullRequestPlan = await this.buildGovernedPullRequestPlan(
        repository.defaultBranch,
        canonicalBranch,
        request.issue,
      );
    }

    return {
      change: this.#options.identity,
      branchGovernance: this.#options.branchGovernance,
      naming,
      baseBranch: repository.defaultBranch,
      evidence: {
        issue: { status: "available", value: { number: issue.number, state: issue.state } },
        branches: branches.length === 0 ? { status: "absent" } : { status: "available", value: branches },
        pullRequests: pullRequests.length === 0 ? { status: "absent" } : { status: "available", value: pullRequests },
      },
      ...(governedIssue === undefined ? {} : { governedIssue }),
      ...(readyEvidence === undefined ? {} : { readyEvidence }),
      ...(semanticPullRequestPlan === undefined ? {} : { semanticPullRequestPlan }),
    };
  }

  private async readBranches(derivedBranch: string | undefined): Promise<readonly ChangeBranchEvidence[]> {
    const branches = new Map<string, string | undefined>();
    if (derivedBranch !== undefined) {
      const observed = await this.#reader.readBranch(derivedBranch);
      if (observed !== undefined) branches.set(observed.name, observed.sha);
    }
    for (const candidate of await this.#reader.readBranches()) {
      if (branchBelongsToRootIssue(candidate.name, this.#options.identity.rootIssue, this.#options.branchGovernance)) {
        if (!branches.has(candidate.name) || candidate.sha !== undefined) branches.set(candidate.name, candidate.sha);
      }
    }
    const orderedNames = [...branches.keys()].sort();
    const hasHistoricalCandidate = orderedNames.some((name) => name !== derivedBranch);
    return orderedNames.map((name) => {
      const base = { name, ...(branches.get(name) === undefined ? {} : { sha: branches.get(name) }) };
      return hasHistoricalCandidate ? { ...base, rootIssue: this.#options.identity.rootIssue } : base;
    });
  }

  private async readPullRequests(
    derivedBranch: string | undefined,
    baseBranch: string,
    branches: readonly ChangeBranchEvidence[],
  ): Promise<readonly ChangePullRequestEvidence[]> {
    const candidateBranches = new Set(branches.map((candidate) => candidate.name));
    if (derivedBranch !== undefined) candidateBranches.add(derivedBranch);
    const providerEvidence = await this.#reader.readPullRequests(
      [...candidateBranches],
      baseBranch,
      this.#options.pullRequestNumber,
    );
    const hasHistoricalBranch = branches.some((candidate) => candidate.rootIssue !== undefined);
    const hasHistoricalCandidate =
      hasHistoricalBranch || providerEvidence.some((candidate) => candidate.head !== derivedBranch);
    return providerEvidence.map((candidate) => {
      const normalized = withoutObserved(candidate);
      return candidate.observed === true || hasHistoricalCandidate || candidate.head !== derivedBranch
        ? { ...normalized, rootIssue: this.#options.identity.rootIssue }
        : normalized;
    });
  }

  private async buildGovernedPullRequestPlan(
    baseBranch: string,
    branch: string,
    rootIssue: number,
  ): Promise<SemanticPullRequestMutationPlan | undefined> {
    const generation = await this.readGovernanceTree(baseBranch);
    const contract = await this.resolveGovernedContract("pr", baseBranch, generation, "default");
    if (contract === undefined || contract.provenance === undefined) return undefined;
    const fields: Record<string, unknown> = {};
    for (const section of contract.sections) {
      for (const field of section.fields) {
        const constraints = effectiveFieldConstraints(contract, field);
        if (constraints.linkedIssue) fields[field.id] = `Closes #${rootIssue}`;
        else if (field.type === "checklist") {
          fields[field.id] = constraints.checklistRequireComplete
            ? field.items.map((item) => item.id)
            : constraints.requiredItems;
        } else if (constraints.required) fields[field.id] = `Implementation in progress for #${rootIssue}.`;
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
    if (
      (this.#options.cwd === undefined && this.#options.remoteGovernance === undefined) ||
      issueBody === undefined ||
      issueBody === null
    )
      return undefined;
    const canonical = pullRequests.filter((candidate) => candidate.head === branch && candidate.base === baseBranch);
    if (canonical.length !== 1) return undefined;
    const pullRequest = canonical[0];
    if (pullRequest === undefined) return undefined;
    const pullRequestBody = await this.#reader.readPullRequestBody(pullRequest.number);
    if (pullRequestBody === undefined || pullRequestBody === null) return undefined;
    const generation = await this.readGovernanceTree(baseBranch);
    const issueMarker = extractTemplateIdentityMarker(issueBody);
    const issueContract =
      issueMarker.status === "valid" && issueMarker.marker !== undefined
        ? await this.resolveGovernedContract("issue", baseBranch, generation, issueMarker.marker.path)
        : undefined;
    const pullRequestMarker = extractTemplateIdentityMarker(pullRequestBody);
    const pullRequestContract =
      pullRequestMarker.status === "valid" && pullRequestMarker.marker !== undefined
        ? await this.resolveGovernedContract("pr", baseBranch, generation, pullRequestMarker.marker.path)
        : undefined;
    if (issueContract === undefined || pullRequestContract === undefined) return undefined;
    return {
      issue: { contract: issueContract, body: issueBody },
      pullRequest: { contract: pullRequestContract, body: pullRequestBody },
    };
  }

  private async readGovernedIssue(
    body: string | null | undefined,
    ref: string,
  ): Promise<{ readonly contract: CanonicalContract; readonly body: string }> {
    if (body === undefined || body === null) throw new Error("Root Issue body is unavailable.");
    if (this.#options.cwd === undefined) {
      if (this.#options.remoteGovernance === undefined) throw new Error("Repository governance reader is unavailable.");
      const evidence = await resolveGovernedIssueEvidence(this.#options.remoteGovernance, body, ref);
      return { contract: evidence.contract, body };
    }
    const generation = await this.readGovernanceTree(ref);
    const marker = extractTemplateIdentityMarker(body);
    if (marker.status !== "absent") {
      if (marker.status !== "valid" || marker.marker === undefined || marker.marker.kind !== "issue") {
        throw new Error("Root Issue template identity is invalid.");
      }
      const contract = await this.readGovernedContract("issue", ref, generation, marker.marker.path);
      if (contract === undefined) throw new Error("Root Issue contract is unavailable.");
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
    if (selected.contract === undefined || !selected.result.valid) throw new Error("Root Issue artifact is invalid.");
    return { contract: selected.contract, body };
  }

  private async issueTemplateSelectors(generation: GovernanceTree): Promise<readonly string[]> {
    const remotePaths = generation.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entryPath) => entryPath.startsWith(".github/ISSUE_TEMPLATE/"));
    const native = discoverTemplatesFromPaths(remotePaths).issueTemplates.map((template) => template.path);
    if (native.length > 0) return [...new Set(native)].sort();
    const semanticPaths = generation.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entryPath) => /^\.github\/inari\/issues\/[^/]+\.json$/u.test(entryPath));
    if (semanticPaths.length === 0) throw new Error("Issue template contracts are unavailable.");
    return [...new Set(semanticPaths)].sort();
  }

  private async readGovernanceTree(ref: string): Promise<GovernanceTree> {
    return this.#reader.readGovernanceTree(ref);
  }

  private async resolveGovernedContract(
    domain: "issue" | "pr",
    ref: string,
    generation: GovernanceTree,
    selector: string,
  ): Promise<CanonicalContract | undefined> {
    if (this.#options.cwd !== undefined) return this.readGovernedContract(domain, ref, generation, selector);
    if (this.#options.remoteGovernance === undefined) return undefined;
    try {
      return await compileRepositoryGovernedContract(this.#options.remoteGovernance, domain, selector);
    } catch {
      return undefined;
    }
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
    )
      return undefined;
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
        digest: gitBlobSha(templateSource),
      },
      ...(policyEntry === undefined
        ? {}
        : { policy: { path: policyEntry.path, ref, sha: policyEntry.sha, digest: gitBlobSha(policySource ?? "") } }),
      ...(resolutionEntry === undefined
        ? {}
        : {
            templateResolution: {
              path: resolutionEntry.path,
              ref,
              sha: resolutionEntry.sha,
              digest: gitBlobSha(resolutionSource ?? ""),
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
}

export function createGitHubChangeStateProjector(
  options: GitHubChangeStateProjectorOptions,
): GitHubChangeStateProjector {
  return new GitHubChangeStateProjector(options);
}
