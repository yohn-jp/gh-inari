import {
  extractTemplateIdentityMarker,
  loadCanonicalArtifact,
  prepareIssueArtifact,
  preparePullRequestArtifact,
  recoverExistingArtifactValues,
  renderIssueArtifact,
  renderPullRequestArtifact,
  selectExistingArtifactCandidate,
  validateExistingIssueArtifact,
  validateExistingPullRequestArtifact,
  validatePartialArtifactInput,
  type ArtifactInputDocument,
  type ExistingArtifactDiagnostic,
  type ExistingArtifactValidationResult,
  type TemplateIdentityMarker,
} from "./artifact.js";
import { SemanticValidationError, type ArtifactKind, type CanonicalContract } from "./contract/index.js";
import {
  createArtifactDiagnostic,
  createArtifactDiagnosticReport,
  type ArtifactDiagnosticReport,
} from "./diagnostics.js";
import {
  compileRepositoryGovernedContract,
  compileRepositoryGovernedContracts,
  updateGovernedIssue,
  updateGovernedPullRequest,
  type CompiledTemplateOutcome,
  type GovernedArtifactDomain,
  type GovernedMutationResult,
} from "./governance.js";
import { GitHubAdapter, type GitHubIssue, type GitHubPullRequest } from "./github/index.js";
import type { ValidatedRenderedIssueArtifact, ValidatedRenderedPullRequestArtifact } from "./github/types.js";
import type { TemplateSelector } from "./template-discovery.js";
import { createHash } from "node:crypto";

export type RemediationOperation = "check" | "edit" | "normalize" | "sync";

export type RemediationStatus =
  "valid-current" | "non-canonical" | "semantically-invalid" | "unsupported" | "ambiguous";

export type RemediationErrorCode =
  | "SEMANTIC_PATCH_INVALID"
  | "SEMANTIC_PATCH_UNSUPPORTED"
  | "SEMANTIC_VALIDATION_FAILED"
  | "NORMALIZATION_UNSAFE"
  | "SYNC_INPUT_INCOMPLETE"
  | "SYNC_CURRENT_UNSUPPORTED"
  | "PR_HEAD_CHANGE_UNSUPPORTED";

export class RemediationError extends Error {
  readonly code: RemediationErrorCode;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly diagnostics?: ArtifactDiagnosticReport;

  constructor(
    code: RemediationErrorCode,
    message: string,
    path?: string,
    details?: Readonly<Record<string, unknown>>,
    diagnostics?: ArtifactDiagnosticReport,
  ) {
    super(message);
    this.name = "RemediationError";
    this.code = code;
    this.path = path;
    this.details = details;
    this.diagnostics = diagnostics;
  }
}

/** Project recoverable normalize/edit failures through the shared #118 contract. */
export function remediationDiagnosticReport(
  domain: GovernedArtifactDomain,
  operation: "edit" | "normalize",
  read: ExistingArtifactRead,
  input?: ArtifactInputDocument,
  error?: unknown,
): ArtifactDiagnosticReport {
  const requirementReport = remediationRequirementDiagnostics(error);
  if (requirementReport !== undefined) return boundedDiagnosticReport(requirementReport);

  let semanticReport: ArtifactDiagnosticReport | undefined;
  if (read.result.parse.parsed && read.contract !== undefined) {
    const candidate =
      error instanceof RemediationError && error.code === "PR_HEAD_CHANGE_UNSUPPORTED"
        ? currentArtifactInput(domain, read)
        : (input ?? currentArtifactInput(domain, read));
    const loaded = loadCanonicalArtifact(read.contract, candidate);
    semanticReport = boundedDiagnosticReport(loaded.diagnostics);
  }

  if (error instanceof RemediationError && error.code === "SEMANTIC_PATCH_INVALID") {
    return createArtifactDiagnosticReport(
      [
        ...(semanticReport?.diagnostics.slice(0, 31) ?? []),
        createArtifactDiagnostic({
          state: "invalid",
          code: "FIELD_INVALID",
          detailCode: "FIELD_CONSTRAINT_VIOLATION",
          reason: "constraint",
          path: error.path,
          message: error.message,
          recovery: [{ action: "replace", path: error.path, hint: "Remove or replace the undeclared field." }],
        }),
      ],
      semanticReport?.acceptedFields ?? [],
    );
  }

  if (error instanceof RemediationError && error.code === "PR_HEAD_CHANGE_UNSUPPORTED") {
    return createArtifactDiagnosticReport(
      [
        ...(semanticReport?.diagnostics.slice(0, 31) ?? []),
        createArtifactDiagnostic({
          state: "unsupported",
          code: "FIELD_UNSUPPORTED",
          detailCode: "FIELD_UNSUPPORTED",
          reason: "unsupported",
          path: "$.metadata.head",
          message: error.message,
          recovery: [
            {
              action: "replace",
              path: "$.metadata.head",
              hint: "Keep the current pull-request head branch and retry.",
            },
          ],
        }),
      ],
      semanticReport?.acceptedFields ?? [],
    );
  }

  if (
    semanticReport !== undefined &&
    (semanticReport.diagnostics.length > 0 || semanticReport.acceptedFields.length > 0)
  ) {
    return semanticReport;
  }

  const sourceDiagnostics = read.remediationDiagnostics ?? read.result.parse.diagnostics;
  const projected = sourceDiagnostics.slice(0, 32).map((diagnostic) => {
    const ambiguous = diagnostic.code === "EXISTING_AMBIGUOUS_TEMPLATE";
    const selectedTemplate = read.contract?.templateIdentity.path;
    const hasSelectedTemplate = selectedTemplate !== undefined;
    const path = projectExistingDiagnosticPath(diagnostic.path, read.contract);
    const recovery = ambiguous
      ? [
          {
            action: "select-template" as const,
            path: "$.template",
            hint: "Select one authoritative template with --template and retry.",
          },
        ]
      : hasSelectedTemplate
        ? [
            {
              action: "repair" as const,
              path: "$.artifact",
              hint: `Repair the artifact to match selected template "${selectedTemplate}" and retry.`,
            },
          ]
        : [
            {
              action: "select-template" as const,
              path: "$.template",
              hint: "Select an authoritative template with --template and retry.",
            },
          ];
    return createArtifactDiagnostic({
      state: ambiguous ? "conflicting" : "unsupported",
      code: ambiguous ? "FIELD_CONFLICT" : "FIELD_UNSUPPORTED",
      detailCode: ambiguous ? "TEMPLATE_AMBIGUOUS" : "TEMPLATE_UNPARSEABLE",
      reason: ambiguous ? "conflict" : "unsupported",
      path,
      message: existingDiagnosticMessage(diagnostic.code, hasSelectedTemplate),
      recovery,
    });
  });

  if (projected.length > 0) return createArtifactDiagnosticReport(projected);

  const selectedTemplate = read.contract?.templateIdentity.path;
  return createArtifactDiagnosticReport([
    createArtifactDiagnostic({
      state: "unrecoverable",
      code: "ARTIFACT_UNRECOVERABLE",
      path: "$.artifact",
      message:
        operation === "normalize"
          ? "Normalization cannot preserve the existing artifact deterministically."
          : "The existing artifact cannot be safely edited as a semantic document.",
      recovery: [
        {
          action: "repair",
          path: "$.artifact",
          hint:
            selectedTemplate === undefined
              ? "Repair the artifact against an authoritative template and retry."
              : `Repair the artifact against selected template "${selectedTemplate}" and retry.`,
        },
      ],
    }),
  ]);
}

/** Attach the common report while preserving the command's existing outer error. */
export function translateRemediationFailure(
  domain: GovernedArtifactDomain,
  operation: "edit" | "normalize",
  read: ExistingArtifactRead,
  error: unknown,
  input?: ArtifactInputDocument,
): unknown {
  const diagnostics = remediationDiagnosticReport(domain, operation, read, input, error);
  const details = {
    ...remediationFailureDetails(read),
    ...(error instanceof RemediationError && error.details !== undefined ? error.details : {}),
  };
  if (error instanceof RemediationError) {
    return new RemediationError(error.code, error.message, error.path, details, diagnostics);
  }
  if (error instanceof SemanticValidationError) {
    return new SemanticValidationError(error.violations, diagnostics, details);
  }
  return error;
}

/** Bounded context for explicit-template repair without retaining source/body data. */
export function remediationFailureDetails(read: ExistingArtifactRead): Readonly<Record<string, unknown>> {
  const template = read.contract?.templateIdentity;
  const requirements = explicitRepairRequirements(read);
  return {
    ...(template === undefined
      ? {}
      : {
          template: {
            id: boundDiagnosticText(template.id),
            name: boundDiagnosticText(template.name),
            path: boundDiagnosticText(template.path),
            source: template.source,
          },
        }),
    ...(read.result.attemptedTemplates === undefined
      ? {}
      : {
          attemptedTemplates: read.result.attemptedTemplates.slice(0, 32).map(boundDiagnosticText),
        }),
    ...(requirements === undefined ? {} : { requirements }),
  };
}

export interface ExistingArtifactRead {
  readonly remote: GitHubIssue | GitHubPullRequest;
  readonly contract?: CanonicalContract;
  readonly result: ExistingArtifactValidationResult;
  readonly templateSelection?: "explicit" | "inferred";
  /** Candidate-local parser diagnostics retained only for normalize/edit projection. */
  readonly remediationDiagnostics?: readonly ExistingArtifactDiagnostic[];
}

export interface ExistingArtifactAssessment {
  readonly status: RemediationStatus;
  readonly normalizable: boolean;
  readonly canonicalBody?: string;
  readonly diagnostics: readonly ExistingArtifactDiagnostic[];
}

export interface SemanticDiffChange {
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface RenderedDiffSummary {
  readonly changed: boolean;
  readonly before: RenderedValueSummary;
  readonly after: RenderedValueSummary;
}

export interface RenderedValueSummary {
  readonly sha256: string;
  readonly length: number;
  readonly preview: string;
}

export interface SemanticArtifactDiff {
  readonly changed: boolean;
  readonly semantic: readonly SemanticDiffChange[];
  readonly rendered: RenderedDiffSummary;
}

export type PreparedRemediationArtifact = ValidatedRenderedIssueArtifact | ValidatedRenderedPullRequestArtifact;

const MAX_DIFF_CHANGES = 32;
const MAX_DIFF_VALUE = 240;
const MAX_PREVIEW = 160;

const DOMAIN_ARTIFACT_KIND: Readonly<Record<GovernedArtifactDomain, ArtifactKind>> = {
  issue: "issue",
  pr: "pull_request",
};

/** Read and select an existing artifact using the same governed candidate path as `get`. */
export async function readGovernedExistingArtifact(
  adapter: GitHubAdapter,
  domain: GovernedArtifactDomain,
  number: number,
  selector?: string | TemplateSelector,
): Promise<ExistingArtifactRead> {
  let contracts: readonly CanonicalContract[];
  let failedTemplates: readonly { readonly path: string; readonly message: string }[];
  if (selector === undefined) {
    const outcomes = await compileRepositoryGovernedContracts(adapter, domain);
    contracts = outcomes.filter(isCompiledOutcome).map((outcome) => outcome.contract);
    failedTemplates = outcomes.filter(isFailedOutcome).map((outcome) => ({
      path: outcome.path,
      message: outcome.message,
    }));
  } else {
    contracts = [await compileRepositoryGovernedContract(adapter, domain, selector)];
    failedTemplates = [];
  }

  const remote = domain === "issue" ? await adapter.getIssue(number) : await adapter.getPullRequest(number);

  if (selector === undefined) {
    const marker = extractTemplateIdentityMarker(remote.body ?? "");
    if (marker.status !== "absent") {
      return resolveExistingArtifactByMarker(domain, remote, contracts, failedTemplates, marker.status, marker.marker);
    }
  }

  const candidates = contracts.map((contract) => ({
    contract,
    result:
      domain === "issue"
        ? validateExistingIssueArtifact(contract, remote.body)
        : validateExistingPullRequestArtifact(contract, remote.body),
  }));
  const selected = selectExistingArtifactCandidate(candidates);

  if (selector !== undefined && candidates[0] !== undefined && !candidates[0].result.parse.parsed) {
    // Explicit template selection is authoritative for repair. Keep the strict
    // parser untouched, but recover only unambiguous contract-owned values and
    // expose them as a semantic candidate to edit/normalize. Structural parser
    // failures remain available separately for bounded diagnostics.
    const contract = candidates[0].contract;
    const strictResult = candidates[0].result;
    const recovered = recoverExistingArtifactValues(contract, remote.body);
    const input = artifactInputFromRemote(domain, remote, recovered.values);
    const loaded = loadCanonicalArtifact(contract, input);
    const result: ExistingArtifactValidationResult = {
      valid: loaded.valid,
      classification: loaded.valid ? "valid" : "semantic",
      parse: {
        parsed: true,
        values: loaded.valid ? loaded.canonical : recovered.values,
        diagnostics: [],
      },
      violations: loaded.valid ? [] : loaded.violations,
    };
    return {
      remote,
      contract,
      result,
      templateSelection: "explicit",
      remediationDiagnostics: strictResult.parse.diagnostics,
    };
  }

  if (selected.contract !== undefined || failedTemplates.length === 0) {
    const explicitContract = selector !== undefined ? candidates[0]?.contract : undefined;
    const remediationDiagnostics =
      selected.contract === undefined
        ? candidates.flatMap((candidate) => candidate.result.parse.diagnostics).slice(0, 32)
        : undefined;
    return {
      remote,
      contract: selected.contract ?? explicitContract,
      result: selected.result,
      templateSelection: selector === undefined ? "inferred" : "explicit",
      ...(remediationDiagnostics === undefined || remediationDiagnostics.length === 0
        ? {}
        : { remediationDiagnostics }),
    };
  }

  const compileDiagnostics: ExistingArtifactDiagnostic[] = failedTemplates.map((failed) => ({
    code: "EXISTING_TEMPLATE_COMPILE_FAILED",
    path: failed.path,
    message: `[${failed.path}] Template failed to compile: ${failed.message}`,
  }));
  const diagnostics = [...selected.result.parse.diagnostics, ...compileDiagnostics];
  return {
    remote,
    result: {
      valid: false,
      classification: selected.result.classification,
      parse: { parsed: false, values: {}, diagnostics },
      violations: diagnostics,
      attemptedTemplates: selected.result.attemptedTemplates,
    },
  };
}

function resolveExistingArtifactByMarker(
  domain: GovernedArtifactDomain,
  remote: GitHubIssue | GitHubPullRequest,
  contracts: readonly CanonicalContract[],
  failedTemplates: readonly { readonly path: string; readonly message: string }[],
  status: "valid" | "malformed" | "unsupported-version",
  marker: TemplateIdentityMarker | undefined,
): ExistingArtifactRead {
  const invalid = (message: string): ExistingArtifactRead => {
    const diagnostic: ExistingArtifactDiagnostic = {
      code: "EXISTING_TEMPLATE_MARKER_INVALID",
      path: "$.template",
      message,
    };
    return {
      remote,
      result: {
        valid: false,
        classification: "wrong-template",
        parse: { parsed: false, values: {}, diagnostics: [diagnostic] },
        violations: [diagnostic],
      },
    };
  };

  if (status !== "valid" || marker === undefined) {
    return invalid(
      status === "unsupported-version"
        ? `Artifact template identity marker uses an unsupported marker version: ${marker?.version ?? "unknown"}.`
        : "Artifact template identity marker is malformed.",
    );
  }
  if (marker.kind !== DOMAIN_ARTIFACT_KIND[domain]) {
    return invalid(
      `Artifact template identity marker names a "${marker.kind}" template, which cannot resolve a ${DOMAIN_ARTIFACT_KIND[domain]} artifact.`,
    );
  }

  const contract = contracts.find((candidate) => candidate.templateIdentity.path === marker.path);
  if (contract === undefined) {
    const failed = failedTemplates.find((failedTemplate) => failedTemplate.path === marker.path);
    return invalid(
      failed === undefined
        ? `Artifact template identity marker names an unknown or stale template: ${marker.path}.`
        : `[${failed.path}] Artifact template identity marker names a template that failed to compile: ${failed.message}`,
    );
  }
  const result =
    domain === "issue"
      ? validateExistingIssueArtifact(contract, remote.body)
      : validateExistingPullRequestArtifact(contract, remote.body);
  return { remote, contract, result };
}

/** Classify the current artifact and prove whether a canonical body can preserve its semantics. */
export function assessExistingArtifact(
  domain: GovernedArtifactDomain,
  read: ExistingArtifactRead,
): ExistingArtifactAssessment {
  if (read.result.classification === "ambiguous") {
    return { status: "ambiguous", normalizable: false, diagnostics: read.result.parse.diagnostics };
  }
  if (!read.result.parse.parsed || read.contract === undefined) {
    return { status: "unsupported", normalizable: false, diagnostics: read.result.parse.diagnostics };
  }
  if (!read.result.valid) {
    return { status: "semantically-invalid", normalizable: false, diagnostics: read.result.parse.diagnostics };
  }

  const canonicalBody = renderCanonicalBody(domain, read.contract, read.result.parse.values);
  const currentBody = read.remote.body ?? "";
  const normalizable = canonicalBody !== currentBody;
  const diagnostics: readonly ExistingArtifactDiagnostic[] = normalizable
    ? [
        {
          code: "EXISTING_NON_CANONICAL",
          path: "$.body",
          message: "Artifact is semantically valid but differs from the canonical rendered representation.",
        },
      ]
    : [];
  return {
    status: normalizable ? "non-canonical" : "valid-current",
    normalizable,
    canonicalBody,
    diagnostics,
  };
}

/** Render through the existing canonical renderer; this is the only representation authority. */
export function renderCanonicalBody(
  domain: GovernedArtifactDomain,
  contract: CanonicalContract,
  fields: Readonly<Record<string, unknown>>,
): string {
  return domain === "issue" ? renderIssueArtifact(contract, fields) : renderPullRequestArtifact(contract, fields);
}

/** Build the complete semantic input represented by the current remote artifact. */
export function currentArtifactInput(
  domain: GovernedArtifactDomain,
  read: ExistingArtifactRead,
): ArtifactInputDocument {
  const fields =
    read.result.parse.parsed || read.contract === undefined || read.templateSelection !== "explicit"
      ? read.result.parse.values
      : recoverExistingArtifactValues(read.contract, read.remote.body).values;
  return artifactInputFromRemote(domain, read.remote, fields);
}

function artifactInputFromRemote(
  domain: GovernedArtifactDomain,
  remote: GitHubIssue | GitHubPullRequest,
  fields: Readonly<Record<string, unknown>>,
): ArtifactInputDocument {
  if (domain === "issue") {
    const issue = remote as GitHubIssue;
    return {
      fields,
      metadata: { title: issue.title, labels: issue.labels, assignees: issue.assignees },
    };
  }
  const pullRequest = remote as GitHubPullRequest;
  return {
    fields,
    metadata: {
      title: pullRequest.title,
      head: pullRequest.head,
      base: pullRequest.base,
      draft: pullRequest.draft,
    },
  };
}

/** Apply an explicit semantic patch without touching raw Markdown or inferring missing fields. */
export function applySemanticPatch(
  domain: GovernedArtifactDomain,
  read: ExistingArtifactRead,
  patch: ArtifactInputDocument,
): ArtifactInputDocument {
  if (read.contract === undefined || (!read.result.parse.parsed && read.templateSelection !== "explicit")) {
    throw new RemediationError(
      "SEMANTIC_PATCH_UNSUPPORTED",
      "The existing artifact is not safely parseable under one authoritative template.",
      "$.artifact",
    );
  }
  assertKnownFields(read.contract, patch.fields, "SEMANTIC_PATCH_INVALID");
  const current = currentArtifactInput(domain, read);
  const metadata = { ...current.metadata, ...patch.metadata };
  if (domain === "pr" && patch.metadata.head !== undefined) {
    const remote = read.remote as GitHubPullRequest;
    if (patch.metadata.head !== remote.head) {
      throw new RemediationError(
        "PR_HEAD_CHANGE_UNSUPPORTED",
        "Pull request head branches cannot be changed through the GitHub pull-request model.",
        "$.head",
        { current: remote.head, requested: patch.metadata.head },
      );
    }
  }
  const merged = { fields: { ...current.fields, ...patch.fields }, metadata };
  if (read.templateSelection === "explicit" && !read.result.valid) {
    validateReconstructedInput(read.contract, merged, "SEMANTIC_PATCH_INVALID");
  }
  return merged;
}

/** Validate values recovered during an explicit-template repair. */
export function validateReconstructedInput(
  contract: CanonicalContract,
  input: ArtifactInputDocument,
  code: "NORMALIZATION_UNSAFE" | "SEMANTIC_PATCH_INVALID",
): void {
  const loaded = loadCanonicalArtifact(contract, input);
  if (loaded.valid) return;
  const partial = validatePartialArtifactInput(contract, input.fields);
  throw new RemediationError(
    code,
    "The selected template requires semantic values that could not be recovered from the existing artifact.",
    "$.fields",
    {
      requirements: {
        acceptedFields: partial.acceptedFields,
        missingFields: partial.missingFields,
        invalidFields: partial.invalidFields,
        projectedConstraints: partial.projectedConstraints,
        diagnostics: partial.diagnostics,
      },
    },
  );
}

/** Validate and prepare the complete desired state through the existing artifact boundary. */
export function prepareRemediationArtifact(
  domain: GovernedArtifactDomain,
  contract: CanonicalContract,
  input: ArtifactInputDocument,
): PreparedRemediationArtifact {
  if (domain === "issue") return prepareIssueArtifact(contract, input).artifact;
  return preparePullRequestArtifact(contract, input).artifact;
}

/** Ensure a declarative sync only names fields in the authoritative contract. */
export function prepareSyncInput(
  domain: GovernedArtifactDomain,
  read: ExistingArtifactRead,
  desired: ArtifactInputDocument,
): ArtifactInputDocument {
  if (read.contract === undefined) {
    throw new RemediationError(
      "SYNC_CURRENT_UNSUPPORTED",
      "Sync refuses to replace an unsupported or unparseable existing artifact.",
      "$.artifact",
    );
  }
  assertKnownFields(read.contract, desired.fields, "SYNC_INPUT_INCOMPLETE");
  if (domain === "pr" && desired.metadata.head !== undefined) {
    const remote = read.remote as GitHubPullRequest;
    if (desired.metadata.head !== remote.head) {
      throw new RemediationError(
        "PR_HEAD_CHANGE_UNSUPPORTED",
        "Pull request head branches cannot be changed through the GitHub pull-request model.",
        "$.head",
        { current: remote.head, requested: desired.metadata.head },
      );
    }
  }
  return desired;
}

/** Compare the current semantic/rendered artifact with a prepared canonical projection. */
export function diffArtifact(
  domain: GovernedArtifactDomain,
  read: ExistingArtifactRead,
  desired: PreparedRemediationArtifact,
): SemanticArtifactDiff {
  const currentFields = currentArtifactInput(domain, read).fields;
  const desiredFields = desiredFieldsFromArtifact(domain, desired, read.contract);
  const keys = [...new Set([...Object.keys(currentFields), ...Object.keys(desiredFields)])].sort(compareStrings);
  const semantic: SemanticDiffChange[] = [];
  for (const key of keys) {
    if (stableValue(currentFields[key]) !== stableValue(desiredFields[key])) {
      semantic.push({
        path: `$.fields.${key}`,
        ...(Object.prototype.hasOwnProperty.call(currentFields, key)
          ? { before: boundedValue(currentFields[key]) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(desiredFields, key)
          ? { after: boundedValue(desiredFields[key]) }
          : {}),
      });
    }
  }

  const currentMetadata = currentMetadataForDiff(domain, read.remote);
  const desiredMetadata = desiredMetadataForDiff(domain, desired);
  for (const key of Object.keys(desiredMetadata).sort(compareStrings)) {
    if (stableValue(currentMetadata[key]) !== stableValue(desiredMetadata[key])) {
      semantic.push({
        path: `$.metadata.${key}`,
        ...(currentMetadata[key] === undefined ? {} : { before: boundedValue(currentMetadata[key]) }),
        ...(desiredMetadata[key] === undefined ? {} : { after: boundedValue(desiredMetadata[key]) }),
      });
    }
  }

  const currentBody = read.remote.body ?? "";
  const rendered = {
    changed: currentBody !== desired.body,
    before: summarizeRenderedValue(currentBody),
    after: summarizeRenderedValue(desired.body),
  } satisfies RenderedDiffSummary;
  const boundedSemantic = semantic.slice(0, MAX_DIFF_CHANGES);
  return { changed: semantic.length > 0 || rendered.changed, semantic: boundedSemantic, rendered };
}

/** Apply a prepared artifact through the existing freshness and reconciliation boundary. */
export async function updateGovernedExistingArtifact(
  adapter: GitHubAdapter,
  domain: GovernedArtifactDomain,
  number: number,
  artifact: PreparedRemediationArtifact,
): Promise<GovernedMutationResult<GitHubIssue> | GovernedMutationResult<GitHubPullRequest>> {
  if (domain === "issue") return updateGovernedIssue(adapter, number, artifact as ValidatedRenderedIssueArtifact);
  return updateGovernedPullRequest(adapter, number, artifact as ValidatedRenderedPullRequestArtifact);
}

function desiredFieldsFromArtifact(
  domain: GovernedArtifactDomain,
  artifact: PreparedRemediationArtifact,
  contract: CanonicalContract | undefined,
): Readonly<Record<string, unknown>> {
  if (contract === undefined) return {};
  const parsed =
    domain === "issue"
      ? validateExistingIssueArtifact(contract, artifact.body)
      : validateExistingPullRequestArtifact(contract, artifact.body);
  return parsed.parse.values;
}

function currentMetadataForDiff(
  domain: GovernedArtifactDomain,
  remote: GitHubIssue | GitHubPullRequest,
): Readonly<Record<string, unknown>> {
  if (domain === "issue") {
    const issue = remote as GitHubIssue;
    return { title: issue.title, labels: issue.labels, assignees: issue.assignees };
  }
  const pullRequest = remote as GitHubPullRequest;
  return { title: pullRequest.title, head: pullRequest.head, base: pullRequest.base, draft: pullRequest.draft };
}

function desiredMetadataForDiff(
  domain: GovernedArtifactDomain,
  artifact: PreparedRemediationArtifact,
): Readonly<Record<string, unknown>> {
  if (domain === "issue") {
    const issue = artifact as ValidatedRenderedIssueArtifact;
    return {
      title: issue.title,
      ...(issue.labels === undefined ? {} : { labels: issue.labels }),
      ...(issue.assignees === undefined ? {} : { assignees: issue.assignees }),
    };
  }
  const pullRequest = artifact as ValidatedRenderedPullRequestArtifact;
  return {
    title: pullRequest.title,
    head: pullRequest.head,
    base: pullRequest.base,
    ...(pullRequest.draft === undefined ? {} : { draft: pullRequest.draft }),
  };
}

function assertKnownFields(
  contract: CanonicalContract,
  fields: Readonly<Record<string, unknown>>,
  code: "SEMANTIC_PATCH_INVALID" | "SYNC_INPUT_INCOMPLETE",
): void {
  const known = new Set(contract.sections.flatMap((section) => section.fields.map((field) => field.id)));
  const unknown = Object.keys(fields).find((field) => !known.has(field));
  if (unknown !== undefined) {
    throw new RemediationError(code, `Unknown semantic field "${unknown}".`, `$.fields.${unknown}`, { field: unknown });
  }
}

function remediationRequirementDiagnostics(error: unknown): ArtifactDiagnosticReport | undefined {
  if (!(error instanceof RemediationError)) return undefined;
  const requirements = error.details?.requirements;
  if (typeof requirements !== "object" || requirements === null) return undefined;
  const diagnostics = (requirements as { diagnostics?: unknown }).diagnostics;
  if (!isArtifactDiagnosticReport(diagnostics)) return undefined;
  return diagnostics;
}

function explicitRepairRequirements(read: ExistingArtifactRead): Readonly<Record<string, unknown>> | undefined {
  if (read.contract === undefined || read.templateSelection !== "explicit" || read.result.valid) return undefined;
  const domain: GovernedArtifactDomain = read.contract.artifactKind === "issue" ? "issue" : "pr";
  const partial = validatePartialArtifactInput(read.contract, currentArtifactInput(domain, read).fields);
  return {
    acceptedFields: partial.acceptedFields,
    missingFields: partial.missingFields,
    invalidFields: partial.invalidFields,
    projectedConstraints: partial.projectedConstraints,
    diagnostics: partial.diagnostics,
  };
}

function isArtifactDiagnosticReport(value: unknown): value is ArtifactDiagnosticReport {
  return (
    typeof value === "object" &&
    value !== null &&
    "diagnostics" in value &&
    Array.isArray((value as { diagnostics?: unknown }).diagnostics) &&
    "acceptedFields" in value &&
    Array.isArray((value as { acceptedFields?: unknown }).acceptedFields)
  );
}

function boundedDiagnosticReport(report: ArtifactDiagnosticReport): ArtifactDiagnosticReport {
  return createArtifactDiagnosticReport(report.diagnostics.slice(0, 32), report.acceptedFields.slice(0, 128));
}

function existingDiagnosticMessage(code: ExistingArtifactDiagnostic["code"], hasSelectedTemplate: boolean): string {
  if (code === "EXISTING_AMBIGUOUS_TEMPLATE") return "The artifact matches more than one repository template.";
  if (code === "EXISTING_EXTRA_CONTENT")
    return "The artifact contains content outside the selected template structure.";
  if (code === "EXISTING_UNKNOWN_CHECKLIST_ITEM") {
    return "The artifact contains a checklist item that is not declared by the selected template.";
  }
  if (code === "EXISTING_TEMPLATE_COMPILE_FAILED") return "The repository template could not be compiled.";
  if (code === "EXISTING_TEMPLATE_MARKER_INVALID") return "The artifact template identity marker is invalid.";
  if (code === "EXISTING_WRONG_TEMPLATE") {
    return hasSelectedTemplate
      ? "The artifact structure does not match the selected template."
      : "The artifact structure does not match an authoritative template.";
  }
  return hasSelectedTemplate
    ? "The artifact representation does not match the selected template."
    : "The artifact representation could not be parsed against an authoritative template.";
}

function projectExistingDiagnosticPath(path: string, contract: CanonicalContract | undefined): string {
  if (path === "$" || path === "$.body") return "$.artifact";
  if (path === "$.template") return path;
  if (contract !== undefined) {
    const fieldIds = contract.sections.flatMap((section) => section.fields.map((field) => field.id));
    const lastSegment = path.split(".").at(-1);
    const field = fieldIds.find((id) => id === lastSegment);
    if (field !== undefined) return `$.fields.${field}`;
  }
  const fieldLikePath = /^\$\.(?:sections\.)?([A-Za-z][A-Za-z0-9_-]*)$/u.exec(path);
  if (fieldLikePath?.[1] !== undefined) return `$.fields.${fieldLikePath[1]}`;
  return path;
}

function boundDiagnosticText(value: string): string {
  return value.slice(0, 160);
}

function isCompiledOutcome(
  outcome: CompiledTemplateOutcome,
): outcome is Extract<CompiledTemplateOutcome, { readonly status: "compiled" }> {
  return outcome.status === "compiled";
}

function isFailedOutcome(
  outcome: CompiledTemplateOutcome,
): outcome is Extract<CompiledTemplateOutcome, { readonly status: "failed" }> {
  return outcome.status === "failed";
}

function summarizeRenderedValue(value: string): RenderedValueSummary {
  const bytes = new TextEncoder().encode(value);
  const digest = createSha256(bytes);
  return { sha256: digest, length: bytes.byteLength, preview: value.slice(0, MAX_PREVIEW) };
}

function createSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedValue(value: unknown): unknown {
  const serialized = stableValue(value);
  if (serialized.length <= MAX_DIFF_VALUE) return value;
  return { truncated: true, preview: serialized.slice(0, MAX_DIFF_VALUE), length: serialized.length };
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableValue(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareStrings)
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}
