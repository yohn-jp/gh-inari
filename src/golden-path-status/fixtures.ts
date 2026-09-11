import type {
  ChangeEffect,
  ChangeEffectKind,
  ChangeGitHubEvidence,
  ChangeIdentity,
  ChangeProjectionInput,
  ChangePullRequestEvidence,
  ChangeReadyEvidence,
} from "../change.js";
import { renderIssueArtifact, renderPullRequestArtifact } from "../artifact.js";
import { issueContractFixture, pullRequestContractFixture } from "../contract/fixtures.js";
import type { CanonicalContract } from "../contract/ir.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerMutationRequest,
  type IssuerMutationResult,
  type IssuerRepositoryIdentity,
  type TrustedExecutionContext,
} from "../github/issuer-authority.js";
import { TrustedChangeExecutor, type ChangeTrustedEvidenceReader } from "../change-trusted-executor.js";
import type { ChangeRemoteMutationRequest, ChangeRemoteReadRequest } from "../change-executor.js";

/** Stable identities used by production-path certification tests. */
export const GOLDEN_PATH_IDENTITY: ChangeIdentity = Object.freeze({
  repositoryHost: "github.com",
  repositoryId: "411000001",
  rootIssue: 411,
});

export const GOLDEN_PATH_BRANCH = "test/411-golden-path-status-xstate-evidence";
export const GOLDEN_PATH_BASE_BRANCH = "main";
export const GOLDEN_PATH_PULL_REQUEST = 4110;
export const GOLDEN_PATH_CREATED_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

export const GOLDEN_PATH_TARGET: IssuerRepositoryIdentity = Object.freeze({
  repositoryHost: GOLDEN_PATH_IDENTITY.repositoryHost,
  repositoryId: GOLDEN_PATH_IDENTITY.repositoryId,
  nameWithOwner: "acme/inari",
});

export const GOLDEN_PATH_EXECUTION: TrustedExecutionContext = Object.freeze({
  version: 1,
  runtime: "github-actions",
  event: "workflow_dispatch",
  repository: GOLDEN_PATH_TARGET,
  workflowRef: "refs/heads/main",
  workflowSha: "a".repeat(40),
  workflowTrust: "protected",
  codeExecution: "trusted-only",
  fork: false,
  pullRequest: false,
});

const BRANCH_GOVERNANCE = Object.freeze({
  pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$",
});
const NAMING = Object.freeze({ type: "test", slug: "golden-path-status-xstate-evidence" });

function governedContract(contract: CanonicalContract): CanonicalContract {
  return {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: {
        host: GOLDEN_PATH_IDENTITY.repositoryHost,
        owner: "acme",
        name: "inari",
        nameWithOwner: GOLDEN_PATH_TARGET.nameWithOwner,
        repositoryId: GOLDEN_PATH_IDENTITY.repositoryId,
      },
      ref: GOLDEN_PATH_BASE_BRANCH,
      treeSha: "fixture-tree-sha",
      template: {
        path: contract.templateIdentity.path,
        ref: GOLDEN_PATH_BASE_BRANCH,
        sha: "fixture-template-sha",
        digest: "fixture-template-digest",
      },
    },
  };
}

const issueContract = governedContract(issueContractFixture);
const pullRequestContract = governedContract(pullRequestContractFixture);
const readyEvidence: ChangeReadyEvidence = Object.freeze({
  issue: {
    contract: issueContract,
    body: renderIssueArtifact(issueContract, {
      problem: "A Draft Change needs a governed Ready transition.",
      category: "feature",
      affected_areas: ["contracts"],
      acceptance: ["tests"],
    }),
  },
  pullRequest: {
    contract: pullRequestContract,
    body: renderPullRequestArtifact(pullRequestContract, {
      summary: "Complete the governed Ready transition.",
      linked_issue: "Closes #411",
      acceptance: ["tests"],
      scope: "Production machine and projector certification.",
    }),
  },
});

function issueEvidence(): NonNullable<ChangeGitHubEvidence["issue"]> {
  return { status: "available", value: { number: GOLDEN_PATH_IDENTITY.rootIssue, state: "open" } };
}

function branches(
  value: readonly { name: string; sha?: string }[] = [],
): NonNullable<ChangeGitHubEvidence["branches"]> {
  return { status: "available", value };
}

function pullRequests(
  value: readonly ChangePullRequestEvidence[] = [],
): NonNullable<ChangeGitHubEvidence["pullRequests"]> {
  return { status: "available", value };
}

function pullRequest(overrides: Partial<ChangePullRequestEvidence> = {}): ChangePullRequestEvidence {
  return {
    number: GOLDEN_PATH_PULL_REQUEST,
    head: GOLDEN_PATH_BRANCH,
    base: GOLDEN_PATH_BASE_BRANCH,
    state: "open",
    draft: true,
    merged: false,
    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
    ...overrides,
  };
}

function input(evidence: ChangeGitHubEvidence, includeReadyEvidence = false): ChangeProjectionInput {
  return {
    change: GOLDEN_PATH_IDENTITY,
    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
    branchGovernance: BRANCH_GOVERNANCE,
    naming: NAMING,
    baseBranch: GOLDEN_PATH_BASE_BRANCH,
    evidence,
    ...(includeReadyEvidence ? { readyEvidence } : {}),
  };
}

/** Confirmed-absence evidence drives Core's real issuance planner. */
export function absentEvidenceInput(): ChangeProjectionInput {
  return {
    ...input({ issue: issueEvidence(), branches: branches(), pullRequests: pullRequests() }),
    provenance: undefined,
  };
}

/** A canonical open Draft PR and branch, suitable for Ready execution. */
export function draftEvidenceInput(): ChangeProjectionInput {
  return input(
    {
      issue: issueEvidence(),
      branches: branches([{ name: GOLDEN_PATH_BRANCH, sha: GOLDEN_PATH_CREATED_COMMIT_SHA }]),
      pullRequests: pullRequests([pullRequest()]),
    },
    true,
  );
}

/** A canonical open non-Draft PR, suitable for an abort execution. */
export function reviewEvidenceInput(): ChangeProjectionInput {
  return input(
    {
      issue: issueEvidence(),
      branches: branches([{ name: GOLDEN_PATH_BRANCH, sha: GOLDEN_PATH_CREATED_COMMIT_SHA }]),
      pullRequests: pullRequests([pullRequest({ draft: false })]),
    },
    true,
  );
}

/** A canonical closed, unmerged PR with no branch, proving abort idempotency. */
export function abortedEvidenceInput(): ChangeProjectionInput {
  return input({
    issue: issueEvidence(),
    branches: branches(),
    pullRequests: pullRequests([pullRequest({ state: "closed", draft: false, merged: false })]),
  });
}

export interface DeterministicActorOptions {
  /** The effect fails after being recorded; by default it has no remote effect. */
  readonly failEffect?: ChangeEffectKind;
  /** Simulate an effect that applied despite an ambiguous provider failure. */
  readonly applyFailedEffect?: boolean;
  /** Leave a successful effect unapplied to exercise production verification failure. */
  readonly applySuccessfulEffect?: boolean;
  /** Keep the canonical branch after DELETE_BRANCH for verification-failure tests. */
  readonly leaveBranchAfterDelete?: boolean;
}

/**
 * Deterministic read actor. It returns only normalized Core input and is the
 * sole test I/O boundary for repository evidence.
 */
export class DeterministicEvidenceReader implements ChangeTrustedEvidenceReader {
  readCount = 0;
  failNextRead = false;

  constructor(public current: ChangeProjectionInput) {}

  async read(_request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest): Promise<ChangeProjectionInput> {
    this.readCount += 1;
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("deterministic read failure");
    }
    return this.current;
  }
}

/**
 * Deterministic issuer actor. It records production effects and updates only
 * normalized evidence; it does not predict lifecycle states or recovery.
 */
export class DeterministicIssuer {
  readonly effects: ChangeEffect[] = [];
  readonly requests: IssuerMutationRequest[] = [];
  private readonly options: DeterministicActorOptions;

  constructor(
    readonly reader: DeterministicEvidenceReader,
    options: DeterministicActorOptions = {},
  ) {
    this.options = options;
  }

  async applyEffects(request: IssuerMutationRequest): Promise<IssuerMutationResult> {
    const effect = request.effects[0];
    if (effect === undefined) throw new Error("effect request was empty");
    this.requests.push(request);
    this.effects.push(effect);

    const failed = effect.kind === this.options.failEffect;
    const applyEffect = failed ? this.options.applyFailedEffect === true : this.options.applySuccessfulEffect !== false;
    if (applyEffect) this.applyEvidence(effect);
    if (failed) throw new Error("deterministic effect failure");

    return {
      version: 1,
      authority: "issuer",
      issuer: { kind: "github-app", slug: "inari-issuer", appId: "411", principal: INARI_ISSUER_PRINCIPAL },
      repository: GOLDEN_PATH_TARGET,
      installation: { appId: "411", installationId: "411", repositoryHost: GOLDEN_PATH_TARGET.repositoryHost },
      permissions: {},
      effects: [{ kind: effect.kind, status: "applied", evidence: successEvidence(effect) }],
    };
  }

  private applyEvidence(effect: ChangeEffect): void {
    const current = this.reader.current.evidence;
    const currentBranches = current.branches?.status === "available" ? [...current.branches.value] : [];
    const currentPullRequests = current.pullRequests?.status === "available" ? [...current.pullRequests.value] : [];

    switch (effect.kind) {
      case "CREATE_BRANCH":
        this.reader.current = {
          ...this.reader.current,
          evidence: {
            ...current,
            branches: branches([
              ...currentBranches.filter((candidate) => candidate.name !== effect.branch),
              { name: effect.branch, sha: GOLDEN_PATH_CREATED_COMMIT_SHA },
            ]),
          },
        };
        return;
      case "CREATE_PULL_REQUEST":
        this.reader.current = {
          ...this.reader.current,
          readyEvidence,
          evidence: {
            ...current,
            pullRequests: pullRequests([
              ...currentPullRequests.filter((candidate) => candidate.number !== GOLDEN_PATH_PULL_REQUEST),
              pullRequest({
                number: effect.rootIssue * 10,
                head: effect.branch,
                base: effect.baseBranch,
                draft: true,
              }),
            ]),
          },
        };
        return;
      case "MARK_PULL_REQUEST_READY":
        this.reader.current = {
          ...this.reader.current,
          evidence: {
            ...current,
            pullRequests: pullRequests(
              currentPullRequests.map((candidate) =>
                candidate.number === effect.pullRequest ? { ...candidate, draft: false } : candidate,
              ),
            ),
          },
        };
        return;
      case "CLOSE_PULL_REQUEST":
        this.reader.current = {
          ...this.reader.current,
          evidence: {
            ...current,
            pullRequests: pullRequests(
              currentPullRequests.map((candidate) =>
                candidate.number === effect.pullRequest
                  ? { ...candidate, state: "closed", draft: false, merged: false }
                  : candidate,
              ),
            ),
          },
        };
        return;
      case "DELETE_BRANCH":
        if (this.options.leaveBranchAfterDelete) return;
        this.reader.current = {
          ...this.reader.current,
          evidence: {
            ...current,
            branches: branches(currentBranches.filter((candidate) => candidate.name !== effect.branch)),
          },
        };
        return;
    }
  }
}

function successEvidence(effect: ChangeEffect) {
  switch (effect.kind) {
    case "CREATE_BRANCH":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        createdCommitSha: GOLDEN_PATH_CREATED_COMMIT_SHA,
      } as const;
    case "CREATE_PULL_REQUEST":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        rootIssue: effect.rootIssue,
        pullRequest: effect.rootIssue * 10,
      } as const;
    case "MARK_PULL_REQUEST_READY":
    case "CLOSE_PULL_REQUEST":
      return { kind: effect.kind, pullRequest: effect.pullRequest } as const;
    case "DELETE_BRANCH":
      return effect.expectedCommitSha === undefined
        ? ({ kind: effect.kind, branch: effect.branch } as const)
        : {
            kind: effect.kind,
            branch: effect.branch,
            expectedCommitSha: effect.expectedCommitSha,
            outcome: "deleted" as const,
          };
  }
}

export interface GoldenPathActors {
  readonly reader: DeterministicEvidenceReader;
  readonly issuer: DeterministicIssuer;
  readonly executor: TrustedChangeExecutor;
}

export function createGoldenPathActors(
  initial: ChangeProjectionInput,
  options: DeterministicActorOptions = {},
): GoldenPathActors {
  const reader = new DeterministicEvidenceReader(initial);
  const issuer = new DeterministicIssuer(reader, options);
  const executor = new TrustedChangeExecutor({
    reader,
    issuerAuthority: issuer,
    execution: GOLDEN_PATH_EXECUTION,
    target: GOLDEN_PATH_TARGET,
  });
  return { reader, issuer, executor };
}

export function mutationRequest(
  operation: "issue" | "ready" | "abort",
  requester?: string,
): ChangeRemoteMutationRequest {
  return {
    version: 1,
    operation,
    issue: GOLDEN_PATH_IDENTITY.rootIssue,
    ...(requester === undefined ? {} : { requester }),
  };
}
