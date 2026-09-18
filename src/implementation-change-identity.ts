/**
 * Pure binding projection for the Implementation-native execution topology.
 *
 * The existing contract modules remain authoritative for their own values:
 * this module only proves that one current Implementation authorization is
 * bound to one Change, Session task/capability, branch, PR relation, and
 * execution-evidence record. It does not create provider effects, persist
 * lifecycle state, or replace any of those authorities.
 */

import { validateBranchName } from "./branch-naming.js";
import { canonicalJsonString, type CanonicalJsonValue } from "./agent-authority/codec.js";
import { changeIdentityKey, validateChange, type Change, type ChangeIdentity } from "./change.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import {
  validateCapabilityClaim,
  type CapabilityClaim,
  type ChangeCapabilityClaim,
} from "./agent-authority/capability.js";
import type { SessionCertificateTask } from "./agent-authority/session-certificate.js";
import {
  validateImplementationAuthorizationRecord,
  type ImplementationAuthorizationRecord,
} from "./implementation-authorization.js";
import { validateImplementationContract, type ImplementationRepositoryIdentity } from "./implementation-contract.js";
import {
  tryParseImplementationExecutionEvidence,
  type ImplementationExecutionEvidence,
} from "./implementation-execution-evidence.js";
import type { SemanticPullRequestProjectionRepresentation } from "./semantic-pr-projection.js";

export const IMPLEMENTATION_CHANGE_IDENTITY_VERSION = 1 as const;
export type ImplementationChangeIdentityVersion = typeof IMPLEMENTATION_CHANGE_IDENTITY_VERSION;
export const IMPLEMENTATION_CHANGE_IDENTITY_KIND = "implementation-change-identity" as const;

/** A new execution is rooted in the Implementation; this is not a new lifecycle. */
export const IMPLEMENTATION_CHANGE_IDENTITY_MODE = "implementation-native" as const;
export type ImplementationChangeIdentityMode = typeof IMPLEMENTATION_CHANGE_IDENTITY_MODE;

/** Compatibility classification for Changes issued before this topology. */
export const HISTORICAL_ISSUE_ROOT_CHANGE_MODE = "historical-issue-root" as const;
export type ChangeRootCompatibilityMode = ImplementationChangeIdentityMode | typeof HISTORICAL_ISSUE_ROOT_CHANGE_MODE;

export const IMPLEMENTATION_SOURCE_LIFECYCLE_AUTHORITY = "ordinary-issue" as const;
export const IMPLEMENTATION_SOURCE_LIFECYCLE_CLOSURE = "explicit-terminalization-only" as const;

export type ImplementationAuthorizationIdentity = Pick<
  ImplementationAuthorizationRecord,
  "version" | "kind" | "implementation" | "repository" | "base" | "governedBodyDigest"
>;

export interface ImplementationSessionIdentity {
  /** The current Session Certificate task projection. */
  readonly task: SessionCertificateTask;
  /** The one capability that grants implementation of this Implementation. */
  readonly capability: ChangeCapabilityClaim;
  /** Bound from the current authorization; Session admission must retain this binding. */
  readonly authorizationDigest: string;
}

export interface ImplementationPullRequestIdentity {
  readonly number: number;
  /** The canonical semantic relation targets the Implementation, never only its source Issue. */
  readonly implements: IssueReference;
  /** The recognized closing-reference target is the same Implementation. */
  readonly closingReference: IssueReference;
  readonly representation: SemanticPullRequestProjectionRepresentation;
}

export type ImplementationExecutionEvidenceIdentity = Pick<
  ImplementationExecutionEvidence,
  "implementation" | "repository" | "governedBodyDigest" | "base" | "branch" | "headRevision"
>;

/** One bounded binding across existing semantic authorities. */
export interface ImplementationChangeIdentity {
  readonly version: ImplementationChangeIdentityVersion;
  readonly kind: typeof IMPLEMENTATION_CHANGE_IDENTITY_KIND;
  readonly mode: ImplementationChangeIdentityMode;
  readonly repository: ImplementationRepositoryIdentity;
  readonly sourceIssues: readonly IssueReference[];
  readonly implementation: IssueReference;
  readonly authorization: ImplementationAuthorizationIdentity;
  readonly change: {
    readonly identity: ChangeIdentity;
    readonly state: Change["state"];
    readonly identityKey: string;
  };
  readonly session: ImplementationSessionIdentity;
  readonly branch: {
    readonly name: string;
    readonly baseBranch: string;
  };
  readonly pullRequest: ImplementationPullRequestIdentity;
  readonly executionEvidence: ImplementationExecutionEvidenceIdentity;
  readonly sourceLifecycle: {
    readonly authority: typeof IMPLEMENTATION_SOURCE_LIFECYCLE_AUTHORITY;
    readonly closure: typeof IMPLEMENTATION_SOURCE_LIFECYCLE_CLOSURE;
  };
  /** Stable key for one Implementation authorization, independent of locators. */
  readonly identityKey: string;
}

export interface ImplementationSessionIdentityInput {
  readonly task: unknown;
  readonly capabilities: unknown;
  readonly authorizationDigest: unknown;
}

export interface ImplementationPullRequestIdentityInput {
  readonly number: unknown;
  readonly relation: unknown;
  readonly closingReference: unknown;
}

export interface ImplementationChangeIdentityInput {
  readonly contract: unknown;
  readonly implementation: unknown;
  readonly authorization: unknown;
  readonly change: unknown;
  readonly session: unknown;
  readonly branch: unknown;
  readonly baseBranch: unknown;
  readonly pullRequest: unknown;
  readonly executionEvidence: unknown;
}

export type ImplementationChangeIdentityDiagnosticCode =
  | "IMPLEMENTATION_CHANGE_IDENTITY_INPUT_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_UNKNOWN_PROPERTY"
  | "IMPLEMENTATION_CHANGE_IDENTITY_CONTRACT_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_REFERENCE_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_SOURCE_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_SOURCE_SELF"
  | "IMPLEMENTATION_CHANGE_IDENTITY_AUTHORIZATION_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_AUTHORIZATION_MISMATCH"
  | "IMPLEMENTATION_CHANGE_IDENTITY_CHANGE_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_ROOT_MISMATCH"
  | "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_MISMATCH"
  | "IMPLEMENTATION_CHANGE_IDENTITY_CAPABILITY_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_BRANCH_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_BRANCH_MISMATCH"
  | "IMPLEMENTATION_CHANGE_IDENTITY_BASE_MISMATCH"
  | "IMPLEMENTATION_CHANGE_IDENTITY_PR_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_PR_MISMATCH"
  | "IMPLEMENTATION_CHANGE_IDENTITY_RELATION_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_CLOSING_REFERENCE_MISMATCH"
  | "IMPLEMENTATION_CHANGE_IDENTITY_EXECUTION_EVIDENCE_INVALID"
  | "IMPLEMENTATION_CHANGE_IDENTITY_EXECUTION_MISMATCH"
  | "IMPLEMENTATION_CHANGE_IDENTITY_HISTORICAL_CHANGE"
  | "IMPLEMENTATION_CHANGE_IDENTITY_COLLISION";

export interface ImplementationChangeIdentityDiagnostic {
  readonly code: ImplementationChangeIdentityDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ImplementationChangeIdentityResult {
  readonly valid: boolean;
  readonly identity?: ImplementationChangeIdentity;
  readonly diagnostics: readonly ImplementationChangeIdentityDiagnostic[];
}

export interface ChangeRootCompatibilityInput {
  readonly change: unknown;
  readonly implementation?: unknown;
  readonly sourceIssues?: unknown;
}

export interface ChangeRootCompatibilityResult {
  readonly valid: boolean;
  /** `false` means the historical Change is readable but not admissible for a new native execution. */
  readonly implementationNative: boolean;
  readonly mode?: ChangeRootCompatibilityMode;
  readonly change?: Change;
  readonly implementation?: IssueReference;
  readonly diagnostics: readonly ImplementationChangeIdentityDiagnostic[];
}

export interface ImplementationChangeIdentitySetResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ImplementationChangeIdentityDiagnostic[];
}

type RecordValue = Record<string, unknown>;

const INPUT_KEYS = new Set([
  "contract",
  "implementation",
  "authorization",
  "change",
  "session",
  "branch",
  "baseBranch",
  "pullRequest",
  "executionEvidence",
]);
const SESSION_KEYS = new Set(["task", "capabilities", "authorizationDigest"]);
const TASK_KEYS = new Set(["kind", "number"]);
const PR_KEYS = new Set(["number", "relation", "closingReference"]);
const RELATION_KEYS = new Set(["relation", "references", "representation"]);
const RELATION_REPRESENTATIONS = new Set<SemanticPullRequestProjectionRepresentation>([
  "native",
  "recognized-convention",
  "body-fallback",
]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareDiagnostics(
  left: ImplementationChangeIdentityDiagnostic,
  right: ImplementationChangeIdentityDiagnostic,
): number {
  return left.path.localeCompare(right.path, "en-US") || left.code.localeCompare(right.code, "en-US");
}

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeDeep(entry))) as T;
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = freezeDeep(value[key]);
    return Object.freeze(result) as T;
  }
  return value;
}

function diagnostic(
  diagnostics: ImplementationChangeIdentityDiagnostic[],
  code: ImplementationChangeIdentityDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function sortedDiagnostics(
  diagnostics: readonly ImplementationChangeIdentityDiagnostic[],
): readonly ImplementationChangeIdentityDiagnostic[] {
  return Object.freeze([...diagnostics].sort(compareDiagnostics));
}

function unknownProperties(
  input: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ImplementationChangeIdentityDiagnostic[],
): void {
  for (const key of Object.keys(input).sort()) {
    if (!allowed.has(key))
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        "Property is not supported.",
      );
  }
}

function normalizeReference(
  input: unknown,
  path: string,
  diagnostics: ImplementationChangeIdentityDiagnostic[],
  code: ImplementationChangeIdentityDiagnosticCode = "IMPLEMENTATION_CHANGE_IDENTITY_REFERENCE_INVALID",
): IssueReference | undefined {
  const result = normalizeIssueReference(input, path);
  if (!result.valid || result.reference === undefined) {
    if (result.violations.length === 0) diagnostic(diagnostics, code, path, "Issue reference is invalid.");
    else for (const violation of result.violations) diagnostic(diagnostics, code, violation.path, violation.message);
    return undefined;
  }
  return result.reference;
}

function sameRepository(
  left: { readonly repositoryHost: string; readonly repositoryId: string },
  right: IssueReference,
): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function sameReference(left: IssueReference, right: IssueReference): boolean {
  return issueReferenceKey(left) === issueReferenceKey(right);
}

function validBranch(value: unknown): value is string {
  return typeof value === "string" && validateBranchName(value).length === 0;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validateSessionBinding(
  input: unknown,
  implementation: IssueReference | undefined,
  authorizationDigest: string | undefined,
  diagnostics: ImplementationChangeIdentityDiagnostic[],
): ImplementationSessionIdentity | undefined {
  if (!isRecord(input)) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_INVALID",
      "$.session",
      "Session binding must be an object.",
    );
    return undefined;
  }
  unknownProperties(input, SESSION_KEYS, "$.session", diagnostics);
  const taskInput = input.task;
  const capabilitiesInput = input.capabilities;
  if (typeof input.authorizationDigest !== "string" || input.authorizationDigest.length === 0)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_MISMATCH",
      "$.session.authorizationDigest",
      "Session binding must carry the current authorization digest.",
    );
  else if (authorizationDigest !== undefined && input.authorizationDigest !== authorizationDigest)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_MISMATCH",
      "$.session.authorizationDigest",
      "Session binding must match the current authorization digest.",
    );
  let task: SessionCertificateTask | undefined;
  if (!isRecord(taskInput)) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_INVALID",
      "$.session.task",
      "Session task is required.",
    );
  } else {
    unknownProperties(taskInput, TASK_KEYS, "$.session.task", diagnostics);
    if (taskInput.kind !== "issue")
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_INVALID",
        "$.session.task.kind",
        'task.kind must be "issue".',
      );
    if (!positiveNumber(taskInput.number))
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_INVALID",
        "$.session.task.number",
        "task.number must be a positive Issue number.",
      );
    else task = { kind: "issue", number: taskInput.number };
  }

  const capabilities: CapabilityClaim[] = [];
  if (!Array.isArray(capabilitiesInput) || capabilitiesInput.length === 0) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_INVALID",
      "$.session.capabilities",
      "At least one capability is required.",
    );
  } else {
    capabilitiesInput.forEach((entry, index) => {
      const result = validateCapabilityClaim(entry, `$.session.capabilities[${index}]`);
      if (!result.valid || result.value === undefined) {
        diagnostic(
          diagnostics,
          "IMPLEMENTATION_CHANGE_IDENTITY_CAPABILITY_INVALID",
          `$.session.capabilities[${index}]`,
          "Capability claim is invalid.",
        );
      } else capabilities.push(result.value);
    });
  }

  const implementationCapability = capabilities.filter(
    (claim): claim is ChangeCapabilityClaim => claim.kind === "change.implement",
  );
  if (
    implementation === undefined ||
    authorizationDigest === undefined ||
    task === undefined ||
    implementationCapability.length !== 1
  )
    return undefined;
  const capability = implementationCapability[0];
  if (task.number !== implementation.number)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_MISMATCH",
      "$.session.task.number",
      "Session task must target the Implementation Issue.",
    );
  if (capability.issue !== implementation.number)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_MISMATCH",
      "$.session.capabilities",
      "change.implement must target the Implementation Issue.",
    );
  if (diagnostics.some((entry) => entry.path.startsWith("$.session"))) return undefined;
  return { task, capability, authorizationDigest };
}

function validatePullRequestBinding(
  input: unknown,
  implementation: IssueReference | undefined,
  change: Change | undefined,
  diagnostics: ImplementationChangeIdentityDiagnostic[],
): ImplementationPullRequestIdentity | undefined {
  if (!isRecord(input)) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_PR_INVALID",
      "$.pullRequest",
      "Pull-request binding must be an object.",
    );
    return undefined;
  }
  unknownProperties(input, PR_KEYS, "$.pullRequest", diagnostics);
  if (!positiveNumber(input.number))
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_PR_INVALID",
      "$.pullRequest.number",
      "Pull-request number must be positive.",
    );
  if (!isRecord(input.relation)) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_RELATION_INVALID",
      "$.pullRequest.relation",
      "PR implements relation is required.",
    );
  }
  let relationReference: IssueReference | undefined;
  let representation: SemanticPullRequestProjectionRepresentation | undefined;
  if (isRecord(input.relation)) {
    unknownProperties(input.relation, RELATION_KEYS, "$.pullRequest.relation", diagnostics);
    if (input.relation.relation !== "implements")
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_RELATION_INVALID",
        "$.pullRequest.relation.relation",
        'Relation must be "implements".',
      );
    if (!Array.isArray(input.relation.references) || input.relation.references.length !== 1) {
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_RELATION_INVALID",
        "$.pullRequest.relation.references",
        "The canonical PR relation must target exactly one Implementation.",
      );
    } else
      relationReference = normalizeReference(
        input.relation.references[0],
        "$.pullRequest.relation.references[0]",
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_RELATION_INVALID",
      );
    if (!RELATION_REPRESENTATIONS.has(input.relation.representation as SemanticPullRequestProjectionRepresentation))
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_RELATION_INVALID",
        "$.pullRequest.relation.representation",
        "A supported PR relation representation is required.",
      );
    else representation = input.relation.representation as SemanticPullRequestProjectionRepresentation;
  }
  const closingReference = normalizeReference(
    input.closingReference,
    "$.pullRequest.closingReference",
    diagnostics,
    "IMPLEMENTATION_CHANGE_IDENTITY_CLOSING_REFERENCE_MISMATCH",
  );
  if (
    implementation !== undefined &&
    relationReference !== undefined &&
    !sameReference(relationReference, implementation)
  )
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_PR_MISMATCH",
      "$.pullRequest.relation.references",
      "The canonical PR relation must target the Implementation, not a source Issue.",
    );
  if (
    implementation !== undefined &&
    closingReference !== undefined &&
    !sameReference(closingReference, implementation)
  )
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_CLOSING_REFERENCE_MISMATCH",
      "$.pullRequest.closingReference",
      "The canonical closing reference must target the Implementation.",
    );
  if (change !== undefined && positiveNumber(input.number) && change.projection?.pullRequest !== input.number)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_PR_MISMATCH",
      "$.pullRequest.number",
      "Pull-request number must match the Change projection.",
    );
  if (
    !positiveNumber(input.number) ||
    relationReference === undefined ||
    closingReference === undefined ||
    representation === undefined ||
    diagnostics.some((entry) => entry.path.startsWith("$.pullRequest"))
  )
    return undefined;
  return {
    number: input.number,
    implements: relationReference,
    closingReference,
    representation,
  };
}

function identityKey(implementation: IssueReference, authorizationDigest: string): string {
  return canonicalJsonString({
    implementation: issueReferenceKey(implementation),
    authorizationDigest,
  } as unknown as CanonicalJsonValue);
}

/**
 * Project one implementation-native identity from already-authoritative
 * values. Every cross-artifact relationship is checked; no provider is read.
 */
export function tryProjectImplementationChangeIdentity(input: unknown): ImplementationChangeIdentityResult {
  const diagnostics: ImplementationChangeIdentityDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostic(diagnostics, "IMPLEMENTATION_CHANGE_IDENTITY_INPUT_INVALID", "$", "Identity input must be an object.");
    return { valid: false, diagnostics: sortedDiagnostics(diagnostics) };
  }
  unknownProperties(input, INPUT_KEYS, "$", diagnostics);

  const contractResult = validateImplementationContract(input.contract);
  if (!contractResult.valid || contractResult.contract === undefined) {
    for (const violation of contractResult.violations)
      diagnostic(diagnostics, "IMPLEMENTATION_CHANGE_IDENTITY_CONTRACT_INVALID", violation.path, violation.message);
  }
  const contract = contractResult.contract;
  const implementation = normalizeReference(input.implementation, "$.implementation", diagnostics);

  const authorizationResult = validateImplementationAuthorizationRecord(input.authorization);
  if (!authorizationResult.valid || authorizationResult.record === undefined) {
    for (const violation of authorizationResult.violations)
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_AUTHORIZATION_INVALID",
        violation.path,
        violation.message,
      );
  }
  const authorization = authorizationResult.record;

  const changeResult = validateChange(input.change);
  if (!changeResult.valid || changeResult.change === undefined) {
    for (const entry of changeResult.diagnostics)
      diagnostic(diagnostics, "IMPLEMENTATION_CHANGE_IDENTITY_CHANGE_INVALID", entry.path, entry.message);
  }
  const change = changeResult.change;

  if (contract !== undefined && implementation !== undefined) {
    if (!sameRepository(contract.repository, implementation))
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_REFERENCE_INVALID",
        "$.implementation",
        "Implementation and contract repositories differ.",
      );
    if (contract.sources.some((source) => sameReference(source, implementation)))
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_SOURCE_SELF",
        "$.contract.sources",
        "An Implementation cannot use itself as a source Issue.",
      );
  }
  if (
    authorization !== undefined &&
    implementation !== undefined &&
    !sameReference(authorization.implementation, implementation)
  )
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_AUTHORIZATION_MISMATCH",
      "$.authorization.implementation",
      "Authorization must target the current Implementation.",
    );
  if (
    authorization !== undefined &&
    contract !== undefined &&
    !sameRepository(contract.repository, authorization.implementation)
  )
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_AUTHORIZATION_MISMATCH",
      "$.authorization.implementation",
      "Authorization and contract repositories differ.",
    );
  if (
    authorization !== undefined &&
    contract !== undefined &&
    (authorization.repository.repositoryHost !== contract.repository.repositoryHost ||
      authorization.repository.repositoryId !== contract.repository.repositoryId)
  )
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_AUTHORIZATION_MISMATCH",
      "$.authorization.repository",
      "Authorization and contract repositories differ.",
    );
  if (change !== undefined && implementation !== undefined) {
    if (
      change.identity.repositoryHost !== implementation.repositoryHost ||
      change.identity.repositoryId !== implementation.repositoryId ||
      change.identity.rootIssue !== implementation.number
    )
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_ROOT_MISMATCH",
        "$.change.identity.rootIssue",
        "New Implementation-native Change identity must be rooted in the Implementation Issue.",
      );
    if (change.projection?.branch === undefined)
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_BRANCH_MISMATCH",
        "$.change.projection.branch",
        "The canonical Change branch projection is required.",
      );
    if (change.projection?.pullRequest === undefined)
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_PR_MISMATCH",
        "$.change.projection.pullRequest",
        "The canonical Change PR projection is required.",
      );
  }

  const session = validateSessionBinding(input.session, implementation, authorization?.governedBodyDigest, diagnostics);
  if (typeof input.branch !== "string" || !validBranch(input.branch))
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_BRANCH_INVALID",
      "$.branch",
      "Branch must use the canonical branch grammar.",
    );
  if (typeof input.baseBranch !== "string" || !validBranch(input.baseBranch))
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_BRANCH_INVALID",
      "$.baseBranch",
      "Base branch must use the canonical branch grammar.",
    );
  if (contract !== undefined && input.baseBranch !== contract.execution.baseBranch)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_BASE_MISMATCH",
      "$.baseBranch",
      "Base branch must match the Implementation contract.",
    );
  if (authorization !== undefined && input.baseBranch !== authorization.base.branch)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_BASE_MISMATCH",
      "$.baseBranch",
      "Base branch must match authorization evidence.",
    );
  if (change !== undefined && typeof input.branch === "string" && change.projection?.branch !== input.branch)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_BRANCH_MISMATCH",
      "$.branch",
      "Branch must match the Change projection.",
    );
  if (
    contract !== undefined &&
    contract.execution.branch !== undefined &&
    typeof input.branch === "string" &&
    input.branch !== contract.execution.branch
  )
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_BRANCH_MISMATCH",
      "$.branch",
      "Branch must match the Implementation contract.",
    );

  const pullRequest = validatePullRequestBinding(input.pullRequest, implementation, change, diagnostics);
  const evidenceResult = tryParseImplementationExecutionEvidence(input.executionEvidence);
  if (!evidenceResult.valid || evidenceResult.evidence === undefined) {
    for (const violation of evidenceResult.violations)
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_EXECUTION_EVIDENCE_INVALID",
        violation.path,
        violation.message,
      );
  }
  const executionEvidence = evidenceResult.evidence;
  if (
    executionEvidence !== undefined &&
    implementation !== undefined &&
    !sameReference(executionEvidence.implementation, implementation)
  )
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_EXECUTION_MISMATCH",
      "$.executionEvidence.implementation",
      "Execution evidence must target the current Implementation.",
    );
  if (executionEvidence !== undefined && authorization !== undefined) {
    if (executionEvidence.governedBodyDigest !== authorization.governedBodyDigest)
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_EXECUTION_MISMATCH",
        "$.executionEvidence.governedBodyDigest",
        "Execution evidence must match the authorization digest.",
      );
    if (
      executionEvidence.base.branch !== authorization.base.branch ||
      executionEvidence.base.revision !== authorization.base.revision ||
      executionEvidence.base.freshness !== authorization.base.freshness
    )
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_EXECUTION_MISMATCH",
        "$.executionEvidence.base",
        "Execution evidence must match authorization base evidence.",
      );
  }
  if (executionEvidence !== undefined && typeof input.branch === "string" && executionEvidence.branch !== input.branch)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_EXECUTION_MISMATCH",
      "$.executionEvidence.branch",
      "Execution evidence must match the canonical branch.",
    );

  if (
    contract === undefined ||
    implementation === undefined ||
    authorization === undefined ||
    change === undefined ||
    session === undefined ||
    pullRequest === undefined ||
    executionEvidence === undefined ||
    typeof input.branch !== "string" ||
    !validBranch(input.branch) ||
    typeof input.baseBranch !== "string" ||
    !validBranch(input.baseBranch) ||
    diagnostics.length > 0
  )
    return { valid: false, diagnostics: sortedDiagnostics(diagnostics) };

  const bindingKey = identityKey(implementation, authorization.governedBodyDigest);
  const identity: ImplementationChangeIdentity = freezeDeep({
    version: IMPLEMENTATION_CHANGE_IDENTITY_VERSION,
    kind: IMPLEMENTATION_CHANGE_IDENTITY_KIND,
    mode: IMPLEMENTATION_CHANGE_IDENTITY_MODE,
    repository: contract.repository,
    sourceIssues: contract.sources,
    implementation,
    authorization: {
      version: authorization.version,
      kind: authorization.kind,
      implementation: authorization.implementation,
      repository: authorization.repository,
      base: authorization.base,
      governedBodyDigest: authorization.governedBodyDigest,
    },
    change: {
      identity: change.identity,
      state: change.state,
      identityKey: changeIdentityKey(change.identity),
    },
    session,
    branch: { name: input.branch, baseBranch: input.baseBranch },
    pullRequest,
    executionEvidence: {
      implementation: executionEvidence.implementation,
      repository: executionEvidence.repository,
      governedBodyDigest: executionEvidence.governedBodyDigest,
      base: executionEvidence.base,
      branch: executionEvidence.branch,
      headRevision: executionEvidence.headRevision,
    },
    sourceLifecycle: {
      authority: IMPLEMENTATION_SOURCE_LIFECYCLE_AUTHORITY,
      closure: IMPLEMENTATION_SOURCE_LIFECYCLE_CLOSURE,
    },
    identityKey: bindingKey,
  });
  return { valid: true, identity, diagnostics: [] };
}

export function projectImplementationChangeIdentity(input: unknown): ImplementationChangeIdentity {
  const result = tryProjectImplementationChangeIdentity(input);
  if (!result.valid || result.identity === undefined) {
    throw new Error(result.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
  }
  return result.identity;
}

/**
 * Classify an existing Change without reinterpreting it. Historical
 * Issue-rooted Changes remain readable, but cannot satisfy a new
 * Implementation-native binding unless their root is the Implementation.
 */
export function classifyChangeRoot(input: unknown): ChangeRootCompatibilityResult {
  const diagnostics: ImplementationChangeIdentityDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_INPUT_INVALID",
      "$",
      "Compatibility input must be an object.",
    );
    return { valid: false, implementationNative: false, diagnostics: sortedDiagnostics(diagnostics) };
  }
  const changeResult = validateChange(input.change);
  const change = changeResult.change;
  if (!changeResult.valid || change === undefined) {
    for (const entry of changeResult.diagnostics)
      diagnostic(diagnostics, "IMPLEMENTATION_CHANGE_IDENTITY_CHANGE_INVALID", entry.path, entry.message);
    return { valid: false, implementationNative: false, diagnostics: sortedDiagnostics(diagnostics) };
  }
  const implementation =
    input.implementation === undefined
      ? undefined
      : normalizeReference(input.implementation, "$.implementation", diagnostics);
  if (input.implementation !== undefined && implementation === undefined)
    return { valid: false, implementationNative: false, change, diagnostics: sortedDiagnostics(diagnostics) };
  if (implementation === undefined)
    return {
      valid: true,
      implementationNative: false,
      mode: HISTORICAL_ISSUE_ROOT_CHANGE_MODE,
      change,
      diagnostics: sortedDiagnostics(diagnostics),
    };
  if (
    change.identity.repositoryHost === implementation.repositoryHost &&
    change.identity.repositoryId === implementation.repositoryId &&
    change.identity.rootIssue === implementation.number
  )
    return {
      valid: true,
      implementationNative: true,
      mode: IMPLEMENTATION_CHANGE_IDENTITY_MODE,
      change,
      implementation,
      diagnostics: [],
    };

  const sourceIssues = Array.isArray(input.sourceIssues) ? input.sourceIssues : [];
  const sourceReferences = sourceIssues
    .map((entry, index) =>
      normalizeReference(
        entry,
        `$.sourceIssues[${index}]`,
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_SOURCE_INVALID",
      ),
    )
    .filter((entry): entry is IssueReference => entry !== undefined);
  if (
    sourceReferences.some(
      (source) =>
        source.repositoryHost === change.identity.repositoryHost &&
        source.repositoryId === change.identity.repositoryId &&
        source.number === change.identity.rootIssue,
    )
  ) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CHANGE_IDENTITY_HISTORICAL_CHANGE",
      "$.change.identity.rootIssue",
      "Historical Issue-rooted Change remains readable but is not admissible as the Implementation-native execution.",
    );
    return {
      valid: true,
      implementationNative: false,
      mode: HISTORICAL_ISSUE_ROOT_CHANGE_MODE,
      change,
      implementation,
      diagnostics: sortedDiagnostics(diagnostics),
    };
  }
  diagnostic(
    diagnostics,
    "IMPLEMENTATION_CHANGE_IDENTITY_ROOT_MISMATCH",
    "$.change.identity.rootIssue",
    "Change root is neither the Implementation nor a declared historical source Issue.",
  );
  return {
    valid: false,
    implementationNative: false,
    change,
    implementation,
    diagnostics: sortedDiagnostics(diagnostics),
  };
}

/** Detect conflicting projections without becoming a second lifecycle store. */
export function validateImplementationChangeIdentitySet(
  identities: readonly ImplementationChangeIdentity[],
): ImplementationChangeIdentitySetResult {
  const diagnostics: ImplementationChangeIdentityDiagnostic[] = [];
  const byImplementation = new Map<string, ImplementationChangeIdentity>();
  const byChange = new Map<string, ImplementationChangeIdentity>();
  const byBranch = new Map<string, ImplementationChangeIdentity>();
  const byPullRequest = new Map<number, ImplementationChangeIdentity>();
  for (const identity of identities) {
    const implementationKey = issueReferenceKey(identity.implementation);
    const previousImplementation = byImplementation.get(implementationKey);
    if (
      previousImplementation !== undefined &&
      (previousImplementation.identityKey !== identity.identityKey ||
        previousImplementation.branch.name !== identity.branch.name ||
        previousImplementation.pullRequest.number !== identity.pullRequest.number)
    )
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CHANGE_IDENTITY_COLLISION",
        "$.identities",
        "One Implementation cannot have multiple concurrent authorization, branch, or pull-request identities.",
      );
    else byImplementation.set(implementationKey, identity);
    const check = <T>(map: Map<T, ImplementationChangeIdentity>, key: T, label: string): void => {
      const previous = map.get(key);
      if (previous !== undefined && issueReferenceKey(previous.implementation) !== implementationKey)
        diagnostic(
          diagnostics,
          "IMPLEMENTATION_CHANGE_IDENTITY_COLLISION",
          "$.identities",
          `${label} is claimed by multiple Implementations.`,
        );
      else map.set(key, identity);
    };
    check(byChange, identity.change.identityKey, "Change identity");
    check(byBranch, identity.branch.name, "Canonical branch");
    check(byPullRequest, identity.pullRequest.number, "Canonical pull request");
  }
  return { valid: diagnostics.length === 0, diagnostics: sortedDiagnostics(diagnostics) };
}
