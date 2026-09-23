/**
 * Repository-backed composition for the Implementation Frontier Core.
 *
 * This module is an I/O adapter only.  Issue relationships, Semantic Issue
 * lifecycle, Implementation contracts, authorization, conformance, and Change
 * projection remain owned by their existing authorities.  The Core projector
 * is called once with the bounded evidence assembled here and its result is
 * returned without reinterpretation.
 */

import { changeReadRequest, normalizeChangeProjection, type ChangeExecutionPort } from "./change-execution-port.js";
import { issueReferenceKey, type IssueReference } from "./contract/issue-reference.js";
import {
  IMPLEMENTATION_FRONTIER_LIMITS,
  tryProjectImplementationFrontier,
  type ImplementationFrontierCandidateInput,
  type ImplementationFrontierInput,
  type ImplementationFrontierResult,
} from "./implementation-frontier.js";
import {
  parseImplementationIssueBody,
  validateImplementationContract,
  type ImplementationContract,
  type ImplementationRepositoryIdentity,
} from "./implementation-contract.js";
import {
  tryVerifyImplementationAuthorization,
  validateImplementationAuthorizationRecord,
} from "./implementation-authorization.js";
import { tryVerifyImplementationConformance } from "./implementation-conformance.js";
import { tryObserveSemanticIssue, type ObservedIssueProjection } from "./semantic-issue-observation.js";
import {
  tryProjectSemanticIssueLifecycle,
  type SemanticIssueLifecycleIssueProjection,
  type SemanticIssueLifecycleProjection,
} from "./semantic-issue-lifecycle.js";
import {
  createGitHubChangeReadAdapter,
  GitHubAdapter,
  GitHubIssueRelationObservationAdapter,
  type IssueBlockedByObservation,
} from "./github/index.js";
import type {
  GitHubBranch,
  GitHubIssue,
  GitHubOperationalPullRequestEvidence,
  RepositoryContext,
} from "./github/types.js";

/** The bounded repository read seam used by the composition layer. */
export interface ImplementationFrontierRepository {
  getRepositoryContext(): Promise<RepositoryContext>;
  getIssue(issueNumber: number): Promise<GitHubIssue>;
  observeBlockedBy(issueNumber: number): Promise<IssueBlockedByObservation>;
  findBranch(branch: string): Promise<GitHubBranch | undefined>;
  observePullRequest(pullRequestNumber: number): Promise<GitHubOperationalPullRequestEvidence>;
  readChange(issueNumber: number): Promise<unknown>;
  /**
   * Read raw current Implementation authority inputs from the existing
   * repository-backed authorization/conformance readers. The values are
   * re-bound to the freshly observed Issue/base/PR below and re-verified by
   * the existing Core authorities; projected status flags are not accepted.
   */
  readImplementationEvidence?(issueNumber: number): Promise<unknown>;
}

interface RepositoryIdentity extends ImplementationRepositoryIdentity {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly repository: string;
}

interface ClosureEntry {
  readonly reference: IssueReference;
  readonly issue?: GitHubIssue;
  readonly observed?: ObservedIssueProjection;
  readonly relation: IssueBlockedByObservation | undefined;
}

interface CandidateState {
  readonly entry: ClosureEntry;
  readonly body: string;
  readonly contract?: ImplementationContract;
  readonly implementationCandidate: boolean;
  readonly repositoryEvidence?: RecordValue;
  readonly change?: unknown;
  readonly base?: unknown;
  readonly authorizationRecord?: unknown;
  readonly authorizationInput?: Record<string, unknown>;
  readonly authorizationResult?: ReturnType<typeof tryVerifyImplementationAuthorization>;
  readonly conformanceResult?: ReturnType<typeof tryVerifyImplementationConformance>;
  readonly pullRequestNumber?: number;
  readonly pullRequest?: GitHubOperationalPullRequestEvidence;
  readonly conformanceInput?: Record<string, unknown>;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function positiveIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function repositoryIdentity(context: RepositoryContext): RepositoryIdentity {
  if (context.repositoryId === undefined) throw new Error("Repository identity is unavailable.");
  return {
    repositoryHost: context.hostname.toLocaleLowerCase("en-US"),
    repositoryId: context.repositoryId,
    repository: context.nameWithOwner.toLocaleLowerCase("en-US"),
  };
}

function reference(identity: RepositoryIdentity, number: number): IssueReference {
  return { ...identity, number };
}

function sameRepositoryIdentity(left: IssueReference, right: RepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function repositoryForReference(value: IssueReference): ImplementationRepositoryIdentity {
  return {
    repositoryHost: value.repositoryHost,
    repositoryId: value.repositoryId,
    ...(value.repository === undefined ? {} : { repository: value.repository }),
  };
}

function bodyOf(issue: GitHubIssue | undefined): string {
  return issue?.body ?? "";
}

function labelMarksImplementation(issue: GitHubIssue | undefined): boolean {
  return issue?.labels.some((label) => label.toLocaleLowerCase("en-US") === "implementation") ?? false;
}

function bodyLooksLikeImplementation(body: string): boolean {
  return /(?:^|\n)###\s+(?:Repository identity|Objective|Execution dependencies)\s*$/u.test(body);
}

function authorizationRecord(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (hasOwn(value, "authorization")) return value.authorization;
  if (hasOwn(value, "record")) return value.record;
  if (value.kind === "implementation-authorization") return value;
  return undefined;
}

function rawImplementationEvidence(candidate: RecordValue | undefined): RecordValue | undefined {
  if (candidate === undefined || !isRecord(candidate.implementation)) return undefined;
  return candidate.implementation;
}

function rawAuthorizationEvidence(candidate: RecordValue | undefined): unknown {
  const implementation = rawImplementationEvidence(candidate);
  return implementation === undefined || !hasOwn(implementation, "authorization")
    ? undefined
    : implementation.authorization;
}

function rawConformanceEvidence(candidate: RecordValue | undefined): RecordValue | undefined {
  const implementation = rawImplementationEvidence(candidate);
  return implementation !== undefined && isRecord(implementation.conformance) ? implementation.conformance : undefined;
}

function rawExecutionEvidence(candidate: RecordValue | undefined): unknown {
  const implementation = rawImplementationEvidence(candidate);
  if (implementation !== undefined && hasOwn(implementation, "executionEvidence"))
    return implementation.executionEvidence;
  const conformance = rawConformanceEvidence(candidate);
  return conformance !== undefined && hasOwn(conformance, "executionEvidence")
    ? conformance.executionEvidence
    : undefined;
}

function suppliedImplementation(value: unknown, fallback: IssueReference): unknown {
  return isRecord(value) && hasOwn(value, "implementation") ? value.implementation : fallback;
}

function suppliedIssueReference(value: RecordValue | undefined, fallback: IssueReference): unknown {
  if (value === undefined || !hasOwn(value, "issue")) return fallback;
  return isRecord(value.issue) && hasOwn(value.issue, "reference") ? value.issue.reference : value.issue;
}

function lifecycleIssueMap(
  projection: SemanticIssueLifecycleProjection | undefined,
): ReadonlyMap<string, SemanticIssueLifecycleIssueProjection> {
  return new Map((projection?.issues ?? []).map((issue) => [issueReferenceKey(issue.reference), issue]));
}

function readinessEvidence(
  state: CandidateState,
  candidates: ReadonlyMap<string, CandidateState>,
  lifecycle: SemanticIssueLifecycleProjection | undefined,
): readonly RecordValue[] {
  const contract = state.contract;
  if (contract === undefined || contract.execution.dependencies.length === 0) return [];
  const lifecycleByKey = lifecycleIssueMap(lifecycle);
  return contract.execution.dependencies.map((dependency) => {
    const dependencyState = candidates.get(issueReferenceKey(dependency));
    const dependencyLifecycle = lifecycleByKey.get(issueReferenceKey(dependency));
    let status: "satisfied" | "active" | "missing" | "stale" | "unavailable" = "missing";
    let freshness: "current" | "stale" = "current";
    if (lifecycle?.scope === "unavailable") {
      status = "unavailable";
      freshness = "stale";
    } else if (dependencyState === undefined || dependencyLifecycle === undefined) {
      status = "missing";
    } else if (
      dependencyLifecycle.completion.status === "complete" ||
      changeState(dependencyState.change) === "MERGED"
    ) {
      status = "satisfied";
    } else if (dependencyLifecycle.observedState === "open") {
      status = "active";
    } else {
      status = "stale";
      freshness = "stale";
    }
    return {
      reference: dependency,
      authority: "semantic-issue-lifecycle",
      status,
      freshness,
      dependencies: dependencyState?.contract?.execution.dependencies ?? [],
      ...(dependencyLifecycle?.supersededBy === undefined ? {} : { supersededBy: dependencyLifecycle.supersededBy }),
    };
  });
}

async function currentBase(
  repository: ImplementationFrontierRepository,
  contract: ImplementationContract | undefined,
  authorization: unknown,
): Promise<unknown> {
  const validated = validateImplementationAuthorizationRecord(authorization);
  const branch = validated.record?.base.branch ?? contract?.execution.baseBranch;
  if (branch === undefined) return undefined;
  try {
    const observed = await repository.findBranch(branch);
    if (observed === undefined || observed.sha.length === 0) return undefined;
    return { branch: observed.name, revision: observed.sha, freshness: observed.sha };
  } catch {
    return undefined;
  }
}

function pullRequestNumber(change: unknown): number | undefined {
  if (!isRecord(change) || !isRecord(change.change) || !isRecord(change.change.projection)) return undefined;
  return positiveIssueNumber(change.change.projection.pullRequest) ? change.change.projection.pullRequest : undefined;
}

function changeState(change: unknown): string | undefined {
  if (!isRecord(change) || !isRecord(change.change)) return undefined;
  return typeof change.change.state === "string" ? change.change.state : undefined;
}

async function observeClosure(
  repository: ImplementationFrontierRepository,
  identity: RepositoryIdentity,
  startingIssue: number,
): Promise<{ readonly entries: readonly ClosureEntry[]; readonly scope: "complete" | "unavailable" }> {
  const queue: IssueReference[] = [reference(identity, startingIssue)];
  const seen = new Set<string>();
  const entries: ClosureEntry[] = [];
  let scope: "complete" | "unavailable" = "complete";
  while (queue.length > 0) {
    const current = queue.shift() as IssueReference;
    const key = issueReferenceKey(current);
    if (seen.has(key)) continue;
    seen.add(key);
    if (entries.length >= IMPLEMENTATION_FRONTIER_LIMITS.candidates) {
      scope = "unavailable";
      break;
    }
    let issue: GitHubIssue | undefined;
    try {
      issue = await repository.getIssue(current.number);
      if (issue.number !== current.number) {
        scope = "unavailable";
        issue = undefined;
      }
    } catch {
      scope = "unavailable";
    }
    let relation: IssueBlockedByObservation | undefined;
    try {
      relation = await repository.observeBlockedBy(current.number);
    } catch {
      scope = "unavailable";
    }
    if (relation === undefined || (relation.kind !== "empty" && relation.kind !== "present")) scope = "unavailable";
    const normalizedIssue =
      issue === undefined
        ? undefined
        : {
            ...issue,
            body: issue.body ?? "",
          };
    let observed: ObservedIssueProjection | undefined;
    if (normalizedIssue !== undefined) {
      const semantic = tryObserveSemanticIssue({
        issue: normalizedIssue,
        repository: identity,
        ...(relation === undefined || (relation.kind !== "empty" && relation.kind !== "present")
          ? {}
          : { relations: { dependsOn: { native: relation.references } } }),
      });
      if (semantic.valid) observed = semantic.projection;
      else scope = "unavailable";
    }
    entries.push({
      reference: current,
      ...(issue === undefined ? {} : { issue }),
      ...(observed === undefined ? {} : { observed }),
      relation,
    });
    if (relation?.kind === "present") {
      for (const related of relation.references) {
        if (!sameRepositoryIdentity(related, identity)) {
          scope = "unavailable";
          continue;
        }
        if (!seen.has(issueReferenceKey(related))) queue.push(related);
      }
    }
    if (entries.length + queue.length > IMPLEMENTATION_FRONTIER_LIMITS.candidates) scope = "unavailable";
  }
  return { entries, scope };
}

async function composeCandidate(
  repository: ImplementationFrontierRepository,
  state: Omit<
    CandidateState,
    | "base"
    | "authorizationRecord"
    | "authorizationInput"
    | "authorizationResult"
    | "conformanceResult"
    | "pullRequestNumber"
    | "pullRequest"
    | "conformanceInput"
  >,
  candidates: ReadonlyMap<string, CandidateState>,
  lifecycle: SemanticIssueLifecycleProjection | undefined,
): Promise<CandidateState> {
  const rawAuthorization = rawAuthorizationEvidence(state.repositoryEvidence);
  const rawConformance = rawConformanceEvidence(state.repositoryEvidence);
  const record = authorizationRecord(rawAuthorization) ?? authorizationRecord(rawConformance?.authorization);
  const base = record === undefined ? undefined : await currentBase(repository, state.contract, record);
  const authorizationInput =
    rawAuthorization === undefined && record === undefined
      ? undefined
      : record === undefined
        ? { authorization: rawAuthorization }
        : {
            authorization: record,
            implementation: suppliedImplementation(rawAuthorization ?? rawConformance, state.entry.reference),
            issue: { reference: state.entry.reference, body: state.body },
            repository: repositoryForReference(state.entry.reference),
            ...(base === undefined ? {} : { base }),
            ...(state.contract === undefined || state.contract.execution.dependencies.length === 0
              ? {}
              : { readiness: { evidence: readinessEvidence(state, candidates, lifecycle) } }),
            ...(rawAuthorization !== undefined && isRecord(rawAuthorization) && hasOwn(rawAuthorization, "supersession")
              ? { supersession: rawAuthorization.supersession }
              : {}),
            ...(rawAuthorization !== undefined && isRecord(rawAuthorization) && hasOwn(rawAuthorization, "completed")
              ? { completed: rawAuthorization.completed }
              : {}),
          };
  const authorizationResult =
    authorizationInput === undefined ? undefined : tryVerifyImplementationAuthorization(authorizationInput);
  const number = pullRequestNumber(state.change);
  let pullRequest: GitHubOperationalPullRequestEvidence | undefined;
  const wantsConformance = rawConformance !== undefined || rawExecutionEvidence(state.repositoryEvidence) !== undefined;
  if (record !== undefined && number !== undefined && wantsConformance) {
    try {
      pullRequest = await repository.observePullRequest(number);
    } catch {
      pullRequest = undefined;
    }
  }
  const conformanceInput =
    record === undefined && rawConformance === undefined
      ? undefined
      : {
          authorization: record,
          issue: { reference: suppliedIssueReference(rawConformance, state.entry.reference), body: state.body },
          repository: repositoryForReference(state.entry.reference),
          base: base ?? {},
          pullRequestNumber:
            rawConformance !== undefined && hasOwn(rawConformance, "pullRequestNumber")
              ? rawConformance.pullRequestNumber
              : (number ?? 0),
          pullRequest,
          ...(rawConformance?.supersession === undefined ? {} : { supersession: rawConformance.supersession }),
          ...(rawConformance?.completed === undefined ? {} : { completed: rawConformance.completed }),
          ...(rawExecutionEvidence(state.repositoryEvidence) === undefined
            ? {}
            : { executionEvidence: rawExecutionEvidence(state.repositoryEvidence) }),
        };
  const conformanceResult =
    conformanceInput === undefined ? undefined : tryVerifyImplementationConformance(conformanceInput);
  return {
    ...state,
    ...(base === undefined ? {} : { base }),
    ...(record === undefined ? {} : { authorizationRecord: record }),
    ...(authorizationInput === undefined ? {} : { authorizationInput }),
    ...(authorizationResult === undefined ? {} : { authorizationResult }),
    ...(conformanceResult === undefined ? {} : { conformanceResult }),
    ...(number === undefined ? {} : { pullRequestNumber: number }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
    ...(conformanceInput === undefined ? {} : { conformanceInput }),
  };
}

/** Current, provider-backed inputs for per-execution Implementation admission. */
export interface CurrentImplementationAdmissionEvidence {
  readonly implementation: IssueReference;
  readonly issue: Readonly<{ reference: IssueReference; body: string }>;
  readonly repository: ImplementationRepositoryIdentity;
  readonly base: unknown;
  readonly readiness: Readonly<{ evidence: readonly RecordValue[] }>;
  readonly change: unknown;
  readonly pullRequest?: GitHubOperationalPullRequestEvidence;
}

/**
 * Read the same canonical Issue, dependency lifecycle, Change, PR, and base
 * evidence used by the Implementation Frontier before deriving an execution
 * authorization. Incomplete closure or stale/unavailable reads fail closed.
 */
export async function readCurrentImplementationAdmissionEvidence(
  repository: ImplementationFrontierRepository,
  implementationIssue: number,
): Promise<CurrentImplementationAdmissionEvidence> {
  if (!positiveIssueNumber(implementationIssue)) throw new Error("A positive Implementation Issue number is required.");
  const identity = repositoryIdentity(await repository.getRepositoryContext());
  const closure = await observeClosure(repository, identity, implementationIssue);
  if (closure.scope !== "complete") throw new Error("Current Implementation dependency evidence is unavailable.");
  const lifecycleInput = {
    scope: closure.scope,
    issues: closure.entries.map((entry) => ({
      reference: entry.reference,
      ...(entry.observed === undefined ? {} : { observed: entry.observed }),
    })),
  };
  const lifecycleResult = tryProjectSemanticIssueLifecycle(lifecycleInput);
  if (!lifecycleResult.valid || lifecycleResult.projection === undefined)
    throw new Error("Current Implementation lifecycle evidence is unavailable.");

  const states: CandidateState[] = [];
  for (const entry of closure.entries) {
    if (entry.issue === undefined || entry.observed === undefined)
      throw new Error("Current Implementation Issue evidence is unavailable.");
    const body = bodyOf(entry.issue);
    const parsed = parseImplementationIssueBody(body);
    const contractResult = parsed.contract === undefined ? undefined : validateImplementationContract(parsed.contract);
    let change: unknown;
    try {
      change = await repository.readChange(entry.reference.number);
    } catch {
      throw new Error("Current Implementation Change evidence is unavailable.");
    }
    states.push({
      entry,
      body,
      ...(contractResult?.valid === true && contractResult.contract !== undefined
        ? { contract: contractResult.contract }
        : {}),
      implementationCandidate:
        parsed.valid || labelMarksImplementation(entry.issue) || bodyLooksLikeImplementation(body),
      change,
    });
  }
  const candidates = new Map(states.map((state) => [issueReferenceKey(state.entry.reference), state]));
  const selected = candidates.get(issueReferenceKey(reference(identity, implementationIssue)));
  if (selected === undefined || selected.entry.issue === undefined || selected.contract === undefined)
    throw new Error("Current Implementation contract is unavailable.");
  const base = await currentBase(repository, selected.contract, undefined);
  if (base === undefined) throw new Error("Current Implementation base evidence is unavailable.");
  const change = selected.change;
  const number = pullRequestNumber(change);
  let pullRequest: GitHubOperationalPullRequestEvidence | undefined;
  if (number !== undefined) {
    try {
      pullRequest = await repository.observePullRequest(number);
    } catch {
      throw new Error("Current Implementation pull request evidence is unavailable.");
    }
  }
  return Object.freeze({
    implementation: selected.entry.reference,
    issue: Object.freeze({ reference: selected.entry.reference, body: selected.body }),
    repository: repositoryForReference(selected.entry.reference),
    base,
    readiness: Object.freeze({
      evidence: Object.freeze(readinessEvidence(selected, candidates, lifecycleResult.projection)),
    }),
    change,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  });
}

function implementationEvidence(state: CandidateState): RecordValue | undefined {
  const raw = rawImplementationEvidence(state.repositoryEvidence);
  const candidate = state.implementationCandidate || raw !== undefined;
  if (!candidate) return undefined;
  const result: RecordValue = {};
  if (state.contract !== undefined) result.contract = state.contract;
  else if (state.implementationCandidate) result.contract = {};
  if (state.authorizationInput !== undefined) result.authorization = state.authorizationInput;
  if (state.conformanceInput !== undefined) result.conformance = state.conformanceInput;
  if (raw !== undefined && hasOwn(raw, "executionEvidence")) result.executionEvidence = raw.executionEvidence;
  return result;
}

function candidateInput(state: CandidateState): ImplementationFrontierCandidateInput {
  const implementation = implementationEvidence(state);
  return {
    reference: state.entry.reference,
    ...(implementation === undefined ? {} : { implementation }),
    ...(state.change === undefined ? {} : { change: state.change }),
    ...(state.entry.issue?.state === undefined ? {} : { state: state.entry.issue.state }),
  };
}

/** Compose repository evidence and return the existing Core result unchanged. */
export async function composeImplementationFrontier(
  repository: ImplementationFrontierRepository,
  startingIssue: number,
): Promise<ImplementationFrontierResult> {
  if (!positiveIssueNumber(startingIssue)) throw new Error("A positive starting Issue number is required.");
  const identity = repositoryIdentity(await repository.getRepositoryContext());
  const closure = await observeClosure(repository, identity, startingIssue);
  const lifecycleInput = {
    scope: closure.scope,
    issues: closure.entries.map((entry) => ({
      reference: entry.reference,
      ...(entry.observed === undefined ? {} : { observed: entry.observed }),
    })),
  };
  const lifecycleResult = tryProjectSemanticIssueLifecycle(lifecycleInput);
  const lifecycle = lifecycleResult.projection;
  const initialStates: CandidateState[] = [];
  for (const entry of closure.entries) {
    const body = bodyOf(entry.issue);
    const parsed = parseImplementationIssueBody(body);
    const implementationCandidate =
      parsed.valid || labelMarksImplementation(entry.issue) || bodyLooksLikeImplementation(body);
    const contractResult = parsed.contract === undefined ? undefined : validateImplementationContract(parsed.contract);
    let repositoryEvidence: RecordValue | undefined;
    if (repository.readImplementationEvidence !== undefined) {
      try {
        const evidence = await repository.readImplementationEvidence(entry.reference.number);
        if (evidence !== undefined) {
          repositoryEvidence =
            isRecord(evidence) && hasOwn(evidence, "implementation") ? evidence : { implementation: evidence };
        }
      } catch {
        // An authority reader that is present but unavailable is evidence
        // failure, not permission to fall back to caller-supplied JSON.
        repositoryEvidence = { implementation: { authorization: {} } };
      }
    }
    initialStates.push({
      entry,
      body,
      ...(contractResult?.valid === true && contractResult.contract !== undefined
        ? { contract: contractResult.contract }
        : {}),
      implementationCandidate,
      ...(repositoryEvidence === undefined ? {} : { repositoryEvidence }),
      ...(await (async () => {
        try {
          return { change: await repository.readChange(entry.reference.number) };
        } catch {
          return { change: { status: "unavailable" } };
        }
      })()),
    });
  }
  const byKey = new Map(initialStates.map((state) => [issueReferenceKey(state.entry.reference), state]));
  const composedStates: CandidateState[] = [];
  for (const state of initialStates) composedStates.push(await composeCandidate(repository, state, byKey, lifecycle));
  const input: ImplementationFrontierInput = {
    version: 1,
    kind: "implementation-frontier-input",
    scope: closure.scope,
    ...(lifecycle === undefined ? { issues: lifecycleInput.issues } : { lifecycle }),
    candidates: composedStates.map(candidateInput),
  };
  return tryProjectImplementationFrontier(input);
}

/** Build the composition seam from the existing GitHub and Change authorities. */
export function createGitHubImplementationFrontierRepository(options: {
  readonly adapter: GitHubAdapter;
  readonly cwd: string;
  readonly changeReader?: Pick<ChangeExecutionPort, "read">;
  readonly implementationEvidenceReader?: (issueNumber: number) => Promise<unknown>;
}): ImplementationFrontierRepository {
  const changeReader =
    options.changeReader ?? createGitHubChangeReadAdapter({ cwd: options.cwd, api: options.adapter });
  let relationAdapterPromise: Promise<GitHubIssueRelationObservationAdapter> | undefined;
  const relationAdapter = async (): Promise<GitHubIssueRelationObservationAdapter> => {
    if (relationAdapterPromise === undefined) {
      relationAdapterPromise = options.adapter
        .getRepositoryContext()
        .then(
          (context) =>
            new GitHubIssueRelationObservationAdapter(options.adapter, context, { parent: false, blockedBy: true }),
        );
    }
    return relationAdapterPromise;
  };
  return {
    getRepositoryContext: () => options.adapter.getRepositoryContext(),
    getIssue: (issueNumber) => options.adapter.getIssue(issueNumber),
    observeBlockedBy: async (issueNumber) => (await relationAdapter()).observeBlockedBy(issueNumber),
    findBranch: (branch) => options.adapter.findBranch(branch),
    observePullRequest: (pullRequestNumber) => options.adapter.observePullRequest(pullRequestNumber),
    readChange: async (issueNumber) =>
      normalizeChangeProjection("show", await changeReader.read(changeReadRequest(issueNumber))),
    ...(options.implementationEvidenceReader === undefined
      ? {}
      : { readImplementationEvidence: options.implementationEvidenceReader }),
  };
}
