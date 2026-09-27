import {
  assertSemanticInput,
  repairPartialSemanticInput,
  SemanticValidationError,
  validatePartialSemanticInput,
  validateSemanticInput,
  type PartialSemanticValidationResult,
  type PartialSemanticRepairResult,
  type SemanticValidationResult,
  type SemanticViolation,
} from "./contract/validation.js";
import {
  createArtifactDiagnostic,
  createArtifactDiagnosticReport,
  createFieldEvidence,
  MAX_ARTIFACT_DIAGNOSTICS,
  type ArtifactDiagnostic,
  type ArtifactDiagnosticReport,
} from "./diagnostics.js";
import {
  assertCanonicalContract,
  type ArtifactKind,
  type CanonicalContract,
  type CanonicalField,
  type ContractProvenance,
} from "./contract/ir.js";
import {
  EMPTY_ISSUE_DEPENDENCIES,
  validateIssueDependencies,
  type IssueDependencies,
  type IssueReference,
} from "./contract/issue-reference.js";
import { type ValidatedRenderedIssueArtifact, type ValidatedRenderedPullRequestArtifact } from "./github/types.js";
import {
  parseMarkdownStructure,
  type MarkdownHeading,
  type MarkdownSourceRange,
  type MarkdownStructure,
} from "./markdown-ast.js";
import {
  createValidatedRenderedIssueArtifact,
  createValidatedRenderedPullRequestArtifact,
} from "./github/capability.js";
import {
  assertSchemaNativeIssueFormCapability,
  assertSchemaNativePullRequestMarkdownCapability,
  NativeTemplateProjectionError,
  schemaNativeMarkdownFieldHeading,
} from "./contract/native-template-projection.js";
import {
  parseArtifactContract,
  serializeArtifactContract,
  SCHEMA_NATIVE_ARTIFACT_CONTRACT_VERSION,
  type SchemaNativeArtifactContract,
} from "./contract/artifact-contract.js";
import { buildSchemaNativeInputSchema } from "./contract/effective-artifact-contract.js";
import { compileJsonSchema } from "./contract/json-schema-runtime.js";

// v1 artifact APIs remain available during migration. Their explicit
// convergence adapter is re-exported here so callers do not need a second
// legacy-specific package entrypoint.
export {
  artifactContractFromLegacyCanonical,
  compileLegacyEffectiveArtifactContract,
  convergeLegacyArtifactInput,
  mapLegacyArtifactCandidate,
  materializeLegacyArtifact,
  tryMaterializeLegacyArtifact,
  validateLegacyBranchProjection,
} from "./legacy-artifact-convergence.js";
export type {
  LegacyArtifactCompatibilitySource,
  LegacyArtifactConvergenceCode,
  LegacyArtifactConvergenceDiagnostic,
  LegacyArtifactConvergenceOptions,
  LegacyArtifactConvergenceResult,
  LegacyLinkedIssueRepository,
  LegacySemanticArtifactMaterializationResult,
} from "./legacy-artifact-convergence.js";

export interface ArtifactInputMetadata {
  readonly title?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly head?: string;
  readonly base?: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

export interface ArtifactInputDocument {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly metadata: ArtifactInputMetadata;
  /** Generic Issue relationships, independent of template-specific fields. */
  readonly dependencies?: IssueDependencies;
}

/**
 * A representation-independent candidate entering the canonical contract.
 * Adapters may decode JSON, native Markdown, an existing GitHub body, or
 * internal field input, but they never validate or materialize contract
 * semantics themselves.
 */
export type ArtifactCandidateSource = "json" | "markdown" | "existing" | "fields";

export interface ArtifactCandidate {
  readonly fields: unknown;
  readonly metadata: ArtifactInputMetadata;
  readonly source: ArtifactCandidateSource;
  readonly dependencies?: IssueDependencies;
}

export interface ArtifactCandidateAdapterResult {
  readonly parsed: boolean;
  readonly candidate?: ArtifactCandidate;
  readonly diagnostics: readonly ExistingArtifactDiagnostic[];
}

/** Result of the one candidate -> selected contract -> canonical JSON boundary. */
export interface CanonicalArtifactLoadResult {
  readonly valid: boolean;
  readonly complete: boolean;
  /** Canonical contract-shaped semantic JSON. Never contains rejected fields. */
  readonly canonical: Readonly<Record<string, unknown>>;
  /** Explicit alias for callers that name the output canonical JSON. */
  readonly canonicalJson: Readonly<Record<string, unknown>>;
  /** Backward-compatible semantic value name used by renderer callers. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly candidate: ArtifactCandidate;
  readonly acceptedFields: readonly string[];
  readonly missingFields: PartialSemanticValidationResult["missingFields"];
  readonly invalidFields: PartialSemanticValidationResult["invalidFields"];
  readonly diagnostics: ArtifactDiagnosticReport;
  readonly violations: readonly SemanticViolation[];
  readonly dependencies?: IssueDependencies;
}

export interface ArtifactMetadataViolation {
  readonly code: "INPUT_METADATA_INVALID";
  readonly path: string;
  readonly message: string;
}

export type ArtifactInputErrorCode = "INPUT_DOCUMENT_INVALID" | "INPUT_METADATA_INVALID" | "INPUT_DEPENDENCIES_INVALID";

export class ArtifactInputError extends Error {
  readonly code: ArtifactInputErrorCode;
  readonly path: string;
  readonly details?: unknown;

  constructor(code: ArtifactInputErrorCode, message: string, path = "$", details?: unknown) {
    super(message);
    this.name = "ArtifactInputError";
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

export type ArtifactPreparationErrorCode = "ARTIFACT_PROVENANCE_MISSING" | "ARTIFACT_ROUND_TRIP_INVALID";

/** @deprecated Round-trip diagnostics use the shared #118 diagnostic contract. */
export type ArtifactRoundTripDiagnostic = ArtifactDiagnostic;
/** @deprecated Use ArtifactDiagnosticCode/ArtifactDiagnosticDetailCode. */
export type ArtifactRoundTripDiagnosticCode = ArtifactDiagnostic["code"];

/** Stable failures raised before a mutation-capable artifact is created. */
export class ArtifactPreparationError extends Error {
  readonly code: ArtifactPreparationErrorCode;
  readonly diagnostics: readonly ArtifactDiagnostic[];

  constructor(
    code: ArtifactPreparationErrorCode,
    message: string,
    diagnostics: readonly ArtifactRoundTripDiagnostic[] = [],
  ) {
    super(message);
    this.name = "ArtifactPreparationError";
    this.code = code;
    this.diagnostics = createArtifactDiagnosticReport(diagnostics.slice(0, MAX_ARTIFACT_DIAGNOSTICS)).diagnostics;
  }
}

export interface PreparedIssueArtifact {
  readonly input: ArtifactInputDocument;
  readonly validation: SemanticValidationResult;
  readonly artifact: ValidatedRenderedIssueArtifact;
}

export interface PreparedPullRequestArtifact {
  readonly input: ArtifactInputDocument;
  readonly validation: SemanticValidationResult;
  readonly artifact: ValidatedRenderedPullRequestArtifact;
}

export type ExistingArtifactClassification = "valid" | "semantic" | "wrong-template" | "unparseable" | "ambiguous";

export type ExistingArtifactDiagnosticCode =
  | "EXISTING_WRONG_TEMPLATE"
  | "EXISTING_UNPARSEABLE"
  | "EXISTING_EXTRA_CONTENT"
  | "EXISTING_UNKNOWN_CHECKLIST_ITEM"
  | "EXISTING_AMBIGUOUS_TEMPLATE"
  | "EXISTING_NON_CANONICAL"
  | "EXISTING_TEMPLATE_COMPILE_FAILED"
  | "EXISTING_TEMPLATE_MARKER_INVALID";

export interface ExistingArtifactDiagnostic {
  readonly code: ExistingArtifactDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ExistingArtifactParseResult {
  readonly parsed: boolean;
  readonly values: Readonly<Record<string, unknown>>;
  readonly dependencies?: IssueDependencies;
  /** Raw dependency declaration retained for the semantic validation boundary. */
  readonly dependencyInput?: unknown;
  readonly diagnostics: readonly ExistingArtifactDiagnostic[];
}

/**
 * Semantic values recovered from an artifact that did not pass the strict
 * structural parser. Values are extracted only from unambiguous contract
 * sections and are still subject to the canonical semantic loader before use.
 */
export interface RecoverableArtifactValues {
  readonly values: Readonly<Record<string, unknown>>;
  readonly dependencies?: IssueDependencies;
  readonly diagnostics: readonly ExistingArtifactDiagnostic[];
  /** Bounded evidence that every material source range was semantically accounted for. */
  readonly coverage: ArtifactRecoveryCoverage;
}

export interface ArtifactRecoveryCoverage {
  readonly complete: boolean;
  readonly sourceLineCount: number;
  readonly coveredLineCount: number;
  readonly unmatchedLineCount: number;
  /** At most sixteen ranges are included; ranges contain no source text. */
  readonly unmatchedRanges: readonly MarkdownSourceRange[];
  readonly truncated: boolean;
}

export interface ExistingArtifactValidationResult {
  readonly valid: boolean;
  readonly classification: ExistingArtifactClassification;
  readonly parse: ExistingArtifactParseResult;
  readonly violations: readonly ExistingArtifactDiagnostic[] | readonly SemanticViolation[];
  /** Template paths tried against a multi-candidate match that produced no single parse. */
  readonly attemptedTemplates?: readonly string[];
}

export interface ExistingIssueReader {
  getIssue(issueNumber: number): Promise<{
    readonly body: string | null;
    readonly url: string;
    readonly repositoryId?: string;
    readonly repositoryHost?: string;
  }>;
}

export interface ExistingPullRequestReader {
  getPullRequest(pullRequestNumber: number): Promise<{ readonly body: string | null; readonly url: string }>;
}

const GITHUB_NO_RESPONSE = "_No response_";
/** Explicit empty strings need a representation distinct from omitted values. */
const EXPLICIT_EMPTY_STRING_MARKER = "\u200B";

/**
 * Bounded invisible template identity marker embedded in newly rendered
 * artifacts. It is the primary template-selection signal for governed
 * read/repair/validation; legacy artifacts without a marker (or with one
 * that cannot be trusted) fall back to deterministic structural matching.
 * The marker is metadata only: it never substitutes for the authoritative
 * repository governance/provenance that resolves the actual contract.
 */
export const TEMPLATE_IDENTITY_MARKER_VERSION = "1" as const;

const TEMPLATE_IDENTITY_MARKER_PREFIX = "<!-- inari:template ";
const TEMPLATE_IDENTITY_MARKER_SUFFIX = " -->";
const TEMPLATE_IDENTITY_MARKER_LINE_PATTERN = /^<!-- inari:template (\{.*\}) -->$/u;
const TEMPLATE_IDENTITY_MARKER_MAX_LENGTH = 512;
export const ISSUE_DEPENDENCY_MARKER_VERSION = "1" as const;
const ISSUE_DEPENDENCY_MARKER_PREFIX = "<!-- inari:issue-dependencies ";
const ISSUE_DEPENDENCY_MARKER_SUFFIX = " -->";
const ISSUE_DEPENDENCY_MARKER_LINE_PATTERN = /^<!-- inari:issue-dependencies (\{.*\}) -->$/u;
const ISSUE_DEPENDENCY_MARKER_MAX_LENGTH = 8_192;

export interface TemplateIdentityMarker {
  readonly version: string;
  readonly kind: ArtifactKind;
  readonly path: string;
}

export type TemplateIdentityMarkerStatus = "absent" | "valid" | "malformed" | "unsupported-version";

export interface TemplateIdentityMarkerExtraction {
  readonly status: TemplateIdentityMarkerStatus;
  readonly marker?: TemplateIdentityMarker;
  /** Body with a recognized trailing marker line removed; unchanged when none is present. */
  readonly body: string;
}

export type IssueDependencyMarkerStatus = "absent" | "valid" | "malformed" | "unsupported-version";

export interface IssueDependencyMarkerExtraction {
  readonly status: IssueDependencyMarkerStatus;
  readonly dependencies?: IssueDependencies;
  /** Body with a recognized trailing dependency marker removed. */
  readonly body: string;
}

function renderTemplateIdentityMarker(contract: CanonicalContract, expectedKind: ArtifactKind): string {
  if (contract.artifactKind !== expectedKind) {
    throw new ArtifactInputError(
      "INPUT_DOCUMENT_INVALID",
      `A ${expectedKind === "issue" ? "Issue" : "pull request"} contract is required to render its identity marker.`,
    );
  }
  const marker: TemplateIdentityMarker = {
    version: TEMPLATE_IDENTITY_MARKER_VERSION,
    kind: expectedKind,
    path: contract.provenance?.semanticSource?.path ?? contract.templateIdentity.path,
  };
  return `${TEMPLATE_IDENTITY_MARKER_PREFIX}${JSON.stringify(marker)}${TEMPLATE_IDENTITY_MARKER_SUFFIX}`;
}

/** Render the bounded compatibility marker used for Issue dependency projections. */
export function renderIssueDependencyMarker(dependencies: IssueDependencies): string {
  return `${ISSUE_DEPENDENCY_MARKER_PREFIX}${JSON.stringify({
    version: ISSUE_DEPENDENCY_MARKER_VERSION,
    dependencies,
  })}${ISSUE_DEPENDENCY_MARKER_SUFFIX}`;
}

/**
 * Read only the reserved trailing dependency marker emitted by Inari.  No
 * ordinary Markdown is interpreted as a relationship declaration.
 */
export function extractIssueDependencyMarker(body: string): IssueDependencyMarkerExtraction {
  const source = normalizeSource(body);
  const lines = source.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) end -= 1;
  const candidate = end > 0 ? (lines[end - 1] ?? "").trim() : undefined;
  if (candidate === undefined || !candidate.startsWith(ISSUE_DEPENDENCY_MARKER_PREFIX)) {
    return { status: "absent", body: source };
  }
  const remaining = lines.slice(0, end - 1);
  while (remaining.at(-1) !== undefined && (remaining.at(-1) ?? "").trim().length === 0) remaining.pop();
  const strippedBody = remaining.length === 0 ? "" : `${remaining.join("\n")}\n`;
  if (candidate.length > ISSUE_DEPENDENCY_MARKER_MAX_LENGTH || !candidate.endsWith(ISSUE_DEPENDENCY_MARKER_SUFFIX)) {
    return { status: "malformed", body: strippedBody };
  }
  const match = ISSUE_DEPENDENCY_MARKER_LINE_PATTERN.exec(candidate);
  if (match === null) return { status: "malformed", body: strippedBody };
  let payload: unknown;
  try {
    payload = JSON.parse(match[1] as string);
  } catch {
    return { status: "malformed", body: strippedBody };
  }
  if (!isRecord(payload) || payload.version !== ISSUE_DEPENDENCY_MARKER_VERSION) {
    return { status: "unsupported-version", body: strippedBody };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "dependencies")) {
    return { status: "malformed", body: strippedBody };
  }
  return { status: "valid", dependencies: payload.dependencies as IssueDependencies, body: strippedBody };
}

/**
 * Recognize and remove a trailing template identity marker line without
 * applying semantic parsing. Only a line starting with the exact reserved
 * marker prefix is treated as a marker attempt at all; ordinary trailing
 * HTML comments (e.g. PR template scaffolding) are left untouched here and
 * handled by the existing comment-stripping path. Once the reserved prefix
 * is detected, the line is never silently ignored as "absent" again: an
 * oversized, truncated, or otherwise broken marker attempt fails closed as
 * "malformed" instead of falling through to structural matching.
 */
export function extractTemplateIdentityMarker(body: string): TemplateIdentityMarkerExtraction {
  const source = normalizeSource(body);
  const lines = source.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) end -= 1;
  const candidate = end > 0 ? (lines[end - 1] ?? "").trim() : undefined;
  if (candidate === undefined || !candidate.startsWith(TEMPLATE_IDENTITY_MARKER_PREFIX)) {
    return { status: "absent", body: source };
  }

  const remaining = lines.slice(0, end - 1);
  while (remaining.at(-1) !== undefined && (remaining.at(-1) ?? "").trim().length === 0) remaining.pop();
  const strippedBody = remaining.length === 0 ? "" : `${remaining.join("\n")}\n`;

  if (candidate.length > TEMPLATE_IDENTITY_MARKER_MAX_LENGTH || !candidate.endsWith(TEMPLATE_IDENTITY_MARKER_SUFFIX)) {
    return { status: "malformed", body: strippedBody };
  }

  const match = TEMPLATE_IDENTITY_MARKER_LINE_PATTERN.exec(candidate);
  if (match === null) return { status: "malformed", body: strippedBody };

  let payload: unknown;
  try {
    payload = JSON.parse(match[1] as string);
  } catch {
    return { status: "malformed", body: strippedBody };
  }
  if (!isTemplateIdentityMarkerShape(payload)) return { status: "malformed", body: strippedBody };
  if (payload.version !== TEMPLATE_IDENTITY_MARKER_VERSION) {
    return { status: "unsupported-version", marker: payload, body: strippedBody };
  }
  return { status: "valid", marker: payload, body: strippedBody };
}

function isTemplateIdentityMarkerShape(value: unknown): value is TemplateIdentityMarker {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    (value.kind === "issue" || value.kind === "pull_request") &&
    typeof value.path === "string" &&
    value.path.trim().length > 0
  );
}

export interface FetchedExistingArtifact {
  readonly number: number;
  readonly url: string;
  readonly result: ExistingArtifactValidationResult;
}

/** Parse the documented JSON input envelope while keeping field semantics adapter-independent. */
export function parseArtifactInputDocument(input: unknown): ArtifactInputDocument {
  if (!isRecord(input)) throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "Input must be a JSON object.");
  const metadataKeys = ["title", "labels", "assignees", "head", "base", "draft", "maintainerCanModify"];
  if (Object.prototype.hasOwnProperty.call(input, "fields")) {
    if (!isRecord(input.fields))
      throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "fields must be an object.", "$.fields");
    const metadata: Record<string, unknown> = {};
    for (const key of metadataKeys) {
      if (input[key] !== undefined) metadata[key] = input[key];
    }
    const dependencies = parseInputDependencies(input.dependencies);
    const unknown = Object.keys(input).filter(
      (key) => key !== "fields" && key !== "dependencies" && !Object.prototype.hasOwnProperty.call(metadata, key),
    );
    if (unknown.length > 0)
      throw new ArtifactInputError(
        "INPUT_DOCUMENT_INVALID",
        `Unknown input property "${unknown[0]}".`,
        `$.${unknown[0]}`,
      );
    return {
      fields: input.fields,
      metadata: parseMetadata(metadata),
      ...(dependencies === undefined ? {} : { dependencies }),
    };
  }
  const reservedInBare = Object.keys(input).find((key) => metadataKeys.includes(key));
  if (reservedInBare !== undefined) {
    throw new ArtifactInputError(
      "INPUT_DOCUMENT_INVALID",
      `Reserved metadata key "${reservedInBare}" cannot appear without a fields property.`,
      `$.${reservedInBare}`,
    );
  }
  return { fields: input, metadata: {} };
}

function parseInputDependencies(input: unknown): IssueDependencies | undefined {
  if (input === undefined) return undefined;
  const result = validateIssueDependencies(input);
  if (!result.valid) {
    const first = result.violations[0];
    const violations = result.violations.map((violation) => ({
      ...violation,
      path: prefixDependencyPath(violation.path),
    }));
    throw new ArtifactInputError(
      "INPUT_DEPENDENCIES_INVALID",
      first?.message ?? "Issue dependencies are invalid.",
      prefixDependencyPath(first?.path ?? "$.dependencies"),
      violations,
    );
  }
  return result.dependencies;
}

/** Prefix dependency violations when they cross the public input envelope boundary. */
function prefixDependencyPath(path: string): string {
  if (path === "$") return "$.dependencies";
  return path.startsWith("$.") ? `$.dependencies${path.slice(1)}` : "$.dependencies";
}

/** Adapt a parsed JSON envelope without granting it canonical status. */
export function adaptJsonArtifactCandidate(input: unknown): ArtifactCandidate {
  const document = parseArtifactInputDocument(input);
  return { ...document, source: "json" };
}

/** Adapt internal structured fields to the same candidate shape as JSON. */
export function adaptFieldArtifactCandidate(fields: unknown, metadata: ArtifactInputMetadata = {}): ArtifactCandidate {
  if (!isRecord(fields)) {
    throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "Candidate fields must be an object.", "$.fields");
  }
  return { fields, metadata, source: "fields" };
}

/** Alias used by command adapters that call this input the CLI field path. */
export const adaptCliFieldCandidate = adaptFieldArtifactCandidate;

/** Generic adapter spelling for callers that already hold structured fields. */
export const adaptArtifactCandidate = adaptFieldArtifactCandidate;

/** Adapt an existing native artifact body through the repository parser. */
export function adaptMarkdownArtifactCandidate(
  contractInput: unknown,
  body: string | null | undefined,
): ArtifactCandidateAdapterResult {
  assertCanonicalContract(contractInput);
  const contract = contractInput;
  const parse =
    contract.artifactKind === "issue"
      ? parseExistingIssueArtifact(contract, body)
      : parseExistingPullRequestArtifact(contract, body);
  if (!parse.parsed) return { parsed: false, diagnostics: parse.diagnostics };
  return {
    parsed: true,
    candidate: { fields: parse.values, metadata: {}, source: "markdown", dependencies: parse.dependencies },
    diagnostics: parse.diagnostics,
  };
}

/** Existing GitHub bodies use the same native Markdown adapter by design. */
export function adaptExistingArtifactCandidate(
  contractInput: unknown,
  body: string | null | undefined,
): ArtifactCandidateAdapterResult {
  const adapted = adaptMarkdownArtifactCandidate(contractInput, body);
  return adapted.candidate === undefined
    ? adapted
    : { ...adapted, candidate: { ...adapted.candidate, source: "existing" } };
}

/**
 * Reload a candidate against the selected canonical contract.  Complete input
 * takes the normal one-pass validator (and therefore may materialize contract
 * defaults); incomplete/invalid input uses the bounded partial contract and
 * exposes only accepted semantic values.
 */
export function loadCanonicalArtifact(contractInput: unknown, candidateInput: unknown): CanonicalArtifactLoadResult {
  assertCanonicalContract(contractInput);
  const candidate = normalizeArtifactCandidate(candidateInput);
  const dependencyValidation =
    contractInput.artifactKind === "issue"
      ? validateIssueDependencies(candidate.dependencies)
      : candidate.dependencies === undefined
        ? { valid: true, dependencies: EMPTY_ISSUE_DEPENDENCIES, violations: [] }
        : {
            valid: false,
            dependencies: EMPTY_ISSUE_DEPENDENCIES,
            violations: [
              {
                code: "DEPENDENCIES_UNKNOWN_PROPERTY" as const,
                path: "$.dependencies",
                message: "Issue dependencies are supported only for Issue artifacts.",
              },
            ],
          };
  if (!dependencyValidation.valid) {
    throw new ArtifactInputError(
      "INPUT_DEPENDENCIES_INVALID",
      dependencyValidation.violations[0]?.message ?? "Issue dependencies are invalid.",
      dependencyValidation.violations[0]?.path ?? "$.dependencies",
      dependencyValidation.violations,
    );
  }
  const validation = validateSemanticInput(contractInput, candidate.fields);
  if (validation.valid) {
    const acceptedFields = Object.keys(validation.values)
      .sort(compareStrings)
      .map((field) => `$.fields.${field}`);
    const diagnostics = createArtifactDiagnosticReport([], acceptedFields);
    return {
      valid: true,
      complete: true,
      canonical: validation.values,
      canonicalJson: validation.values,
      values: validation.values,
      candidate,
      acceptedFields,
      missingFields: [],
      invalidFields: [],
      diagnostics,
      violations: [],
      dependencies: dependencyValidation.dependencies,
    };
  }

  const partial = validatePartialSemanticInput(contractInput, candidate.fields);
  // Partial classification intentionally asks repair callers for explicit
  // values, including fields whose defaults can complete a full input.  The
  // loader's missingFields output instead describes why the complete
  // validation failed, so default-backed fields must only appear when the
  // full validator actually reports them as required and absent.
  const missingFields = partial.missingFields.filter((issue) =>
    validation.violations.some(
      (violation) => violation.code === "INPUT_REQUIRED" && violation.path === `$.${issue.field}`,
    ),
  );
  const missingFieldPaths = new Set(missingFields.map((issue) => issue.path));
  const diagnostics = createArtifactDiagnosticReport(
    partial.diagnostics.diagnostics.filter(
      (diagnostic) =>
        diagnostic.state !== "missing" || (diagnostic.path !== undefined && missingFieldPaths.has(diagnostic.path)),
    ),
    partial.acceptedFields,
  );
  return {
    valid: false,
    complete: false,
    canonical: partial.values,
    canonicalJson: partial.values,
    values: partial.values,
    candidate,
    acceptedFields: partial.acceptedFields,
    missingFields,
    invalidFields: partial.invalidFields,
    diagnostics,
    violations: validation.violations,
    dependencies: dependencyValidation.dependencies,
  };
}

/** Explicitly named alias for callers that pass a candidate object. */
export const loadCanonicalCandidate = loadCanonicalArtifact;

/** Load a JSON representation through the canonical contract boundary. */
export function loadCanonicalJsonArtifact(contractInput: unknown, input: unknown): CanonicalArtifactLoadResult {
  return loadCanonicalArtifact(contractInput, adaptJsonArtifactCandidate(input));
}

/** Load native Markdown through the same parser and canonical contract. */
export function loadCanonicalMarkdownArtifact(
  contractInput: unknown,
  body: string | null | undefined,
): CanonicalArtifactLoadResult {
  const adapted = adaptMarkdownArtifactCandidate(contractInput, body);
  if (!adapted.parsed || adapted.candidate === undefined) {
    const candidate: ArtifactCandidate = { fields: {}, metadata: {}, source: "markdown" };
    const diagnostics = markdownDiagnostics(adapted.diagnostics);
    return {
      valid: false,
      complete: false,
      canonical: {},
      canonicalJson: {},
      values: {},
      candidate,
      acceptedFields: [],
      missingFields: [],
      invalidFields: [],
      diagnostics,
      violations: [],
    };
  }
  return loadCanonicalArtifact(contractInput, adapted.candidate);
}

/** Existing-body spelling retained so read/repair callers share one boundary. */
export function loadCanonicalExistingArtifact(
  contractInput: unknown,
  body: string | null | undefined,
): CanonicalArtifactLoadResult {
  const adapted = adaptExistingArtifactCandidate(contractInput, body);
  if (!adapted.parsed || adapted.candidate === undefined) {
    const candidate: ArtifactCandidate = { fields: {}, metadata: {}, source: "existing" };
    const diagnostics = markdownDiagnostics(adapted.diagnostics);
    return {
      valid: false,
      complete: false,
      canonical: {},
      canonicalJson: {},
      values: {},
      candidate,
      acceptedFields: [],
      missingFields: [],
      invalidFields: [],
      diagnostics,
      violations: [],
    };
  }
  return loadCanonicalArtifact(contractInput, adapted.candidate);
}

function normalizeArtifactCandidate(input: unknown): ArtifactCandidate {
  if (isArtifactCandidate(input)) return input;
  if (isRecord(input) && input.parsed === true && isArtifactCandidate(input.candidate)) return input.candidate;
  if (isArtifactInputDocument(input)) return { ...input, source: "json" };
  return adaptJsonArtifactCandidate(input);
}

function isArtifactCandidate(input: unknown): input is ArtifactCandidate {
  return (
    isRecord(input) &&
    (input.source === "json" ||
      input.source === "markdown" ||
      input.source === "existing" ||
      input.source === "fields") &&
    Object.prototype.hasOwnProperty.call(input, "fields") &&
    isRecord(input.metadata)
  );
}

function isArtifactInputDocument(input: unknown): input is ArtifactInputDocument {
  return isRecord(input) && Object.prototype.hasOwnProperty.call(input, "fields") && isRecord(input.metadata);
}

function markdownDiagnostics(diagnostics: readonly ExistingArtifactDiagnostic[]): ArtifactDiagnosticReport {
  const projected = diagnostics.slice(0, 32).map((diagnostic) =>
    createArtifactDiagnostic({
      state: "unsupported",
      code: "FIELD_UNSUPPORTED",
      detailCode: diagnostic.code === "EXISTING_AMBIGUOUS_TEMPLATE" ? "TEMPLATE_AMBIGUOUS" : "TEMPLATE_UNPARSEABLE",
      reason: "unsupported",
      path: diagnostic.path,
      message: diagnostic.message,
      recovery: [
        {
          action: diagnostic.code === "EXISTING_AMBIGUOUS_TEMPLATE" ? "select-template" : "retry",
          path: diagnostic.path,
        },
      ],
    }),
  );
  return createArtifactDiagnosticReport(projected, []);
}

/** Classify an artifact input envelope without applying semantic defaults. */
export function validatePartialArtifactInput(contractInput: unknown, input: unknown): PartialSemanticValidationResult {
  assertCanonicalContract(contractInput);
  return validatePartialSemanticInput(contractInput, parseArtifactInputDocument(input).fields);
}

/** Terminology alias for callers that treat validation as classification. */
export const classifyPartialArtifactInput = validatePartialArtifactInput;

/** Merge only a targeted field patch into a prior stateless partial result. */
export function repairPartialArtifactInput(
  contractInput: unknown,
  previous: unknown,
  patch?: unknown,
): PartialSemanticRepairResult {
  assertCanonicalContract(contractInput);
  return repairPartialSemanticInput(contractInput, previous, patch);
}

/** Terminology alias for callers that describe targeted repair as a merge. */
export const mergePartialArtifactInput = repairPartialArtifactInput;

const MAX_SCHEMA_NATIVE_MARKDOWN_BYTES = 256 * 1024;
const MAX_SCHEMA_NATIVE_VALUE_BYTES = 16 * 1024;
const MAX_SCHEMA_NATIVE_RENDERED_NODES = 4096;

type SchemaNativeRecord = Record<string, unknown>;

function isSchemaNativeInput(input: unknown): boolean {
  return isRecord(input) && input.version === SCHEMA_NATIVE_ARTIFACT_CONTRACT_VERSION;
}

function parseSchemaNativeContract(input: unknown): SchemaNativeArtifactContract {
  const source =
    isRecord(input) && Array.isArray(input.derivations)
      ? (JSON.parse(serializeArtifactContract(input as unknown as SchemaNativeArtifactContract)) as unknown)
      : input;
  return parseArtifactContract(source) as SchemaNativeArtifactContract;
}

function schemaNativeProjectionError(path: string, message: string): never {
  throw new NativeTemplateProjectionError([
    { code: "NATIVE_TEMPLATE_PROJECTION_UNSUPPORTED_CAPABILITY", path, message },
  ]);
}

function schemaNativeBinding(contract: SchemaNativeArtifactContract, name: string) {
  return contract.bindings[`/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`];
}

function schemaNativeSuppliedNames(contract: SchemaNativeArtifactContract): readonly string[] {
  return Object.keys(contract.schema.properties as Record<string, unknown>)
    .filter((name) => schemaNativeBinding(contract, name)?.authority.kind === "supplied")
    .sort(compareStrings);
}

function schemaNativeTemplateMarker(contract: SchemaNativeArtifactContract): string {
  if (contract.kind === "branch")
    schemaNativeProjectionError("$.kind", "Branches have no body template identity marker.");
  const directory = contract.kind === "issue" ? "issues" : "pull-requests";
  const marker: TemplateIdentityMarker = {
    version: TEMPLATE_IDENTITY_MARKER_VERSION,
    kind: contract.kind,
    path: `.github/inari/${directory}/${contract.id}.json`,
  };
  return `${TEMPLATE_IDENTITY_MARKER_PREFIX}${JSON.stringify(marker)}${TEMPLATE_IDENTITY_MARKER_SUFFIX}`;
}

function stripSchemaNativeTemplateMarker(
  contract: SchemaNativeArtifactContract,
  body: string,
): {
  readonly source: string;
  readonly exactSource: string;
  readonly hasMarker: boolean;
  readonly diagnostic?: ExistingArtifactDiagnostic;
} {
  const marker = extractTemplateIdentityMarker(body);
  if (marker.status === "malformed" || marker.status === "unsupported-version") {
    return {
      source: marker.body,
      exactSource: marker.body,
      hasMarker: false,
      diagnostic: {
        code: "EXISTING_TEMPLATE_MARKER_INVALID",
        path: "$.template",
        message:
          marker.status === "unsupported-version"
            ? "Template identity marker uses an unsupported version."
            : "Template identity marker is malformed.",
      },
    };
  }
  if (
    marker.status === "valid" &&
    (marker.marker?.kind !== contract.kind ||
      marker.marker.path !==
        `.github/inari/${contract.kind === "issue" ? "issues" : "pull-requests"}/${contract.id}.json`)
  ) {
    return {
      source: marker.body,
      exactSource: marker.body,
      hasMarker: false,
      diagnostic: {
        code: "EXISTING_WRONG_TEMPLATE",
        path: "$.template",
        message: "Template identity marker does not match the schema-native contract.",
      },
    };
  }
  return {
    source: marker.body,
    exactSource: marker.status === "valid" ? schemaNativeBodyBeforeIdentityMarker(body) : marker.body,
    hasMarker: marker.status === "valid",
  };
}

function schemaNativeBodyBeforeIdentityMarker(body: string): string {
  const lines = normalizeSource(body).split("\n");
  while (lines.at(-1)?.trim() === "") lines.pop();
  lines.pop();
  return lines.join("\n");
}

function schemaNativeValues(contract: SchemaNativeArtifactContract, input: unknown): SchemaNativeRecord {
  if (!isRecord(input))
    throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "Schema-native values must be an object.");
  const properties = contract.schema.properties as Record<string, unknown>;
  const supplied = new Set(schemaNativeSuppliedNames(contract));
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(properties, name) || !supplied.has(name)) {
      throw new ArtifactInputError(
        "INPUT_DOCUMENT_INVALID",
        `Caller cannot supply schema-native value "${name}".`,
        `$.${name}`,
      );
    }
  }
  let validation;
  try {
    validation = compileJsonSchema(buildSchemaNativeInputSchema(contract)).validate(input);
  } catch {
    schemaNativeProjectionError("$.schema", "Canonical schema-native caller input could not be compiled.");
  }
  if (!validation.valid) {
    throw new ArtifactInputError(
      "INPUT_DOCUMENT_INVALID",
      "Schema-native caller values do not satisfy the projected authoritative JSON Schema.",
    );
  }
  return input;
}

function schemaNativeObservationDiagnostic(
  contract: SchemaNativeArtifactContract,
  values: SchemaNativeRecord,
): ExistingArtifactDiagnostic | undefined {
  try {
    schemaNativeValues(contract, values);
    return undefined;
  } catch (error: unknown) {
    return {
      code: "EXISTING_UNPARSEABLE",
      path: "$",
      message: error instanceof Error ? error.message : "Observed values do not satisfy the schema-native contract.",
    };
  }
}

function encodeSchemaNativeMarkdownToken(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodeSchemaNativeMarkdownToken(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return encodeSchemaNativeMarkdownToken(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function schemaNativeMarkdownTask(label: string, depth: number): string {
  return `${"  ".repeat(depth)}- [ ] ${label}`;
}

function renderSchemaNativeMarkdownNode(
  schema: Record<string, unknown>,
  value: unknown,
  depth: number,
  budget: { nodes: number },
  path: string,
): readonly string[] {
  budget.nodes += 1;
  if (budget.nodes > MAX_SCHEMA_NATIVE_RENDERED_NODES)
    schemaNativeProjectionError(path, "Structured Markdown value exceeds its bounded node count.");
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Expected an object at ${path}.`);
    const lines = [schemaNativeMarkdownTask("object", depth)];
    const properties = schema.properties as Record<string, unknown>;
    for (const name of Object.keys(properties)
      .filter((key) => Object.hasOwn(value, key))
      .sort(compareStrings)) {
      lines.push(schemaNativeMarkdownTask(`property:${encodeSchemaNativeMarkdownToken(name)}`, depth + 1));
      lines.push(
        ...renderSchemaNativeMarkdownNode(
          properties[name] as Record<string, unknown>,
          value[name],
          depth + 2,
          budget,
          `${path}.${name}`,
        ),
      );
    }
    return lines;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Expected an array at ${path}.`);
    const lines = [schemaNativeMarkdownTask("array", depth)];
    value.forEach((entry, index) => {
      lines.push(schemaNativeMarkdownTask("item", depth + 1));
      lines.push(
        ...renderSchemaNativeMarkdownNode(
          schema.items as Record<string, unknown>,
          entry,
          depth + 2,
          budget,
          `${path}[${index}]`,
        ),
      );
    });
    return lines;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Expected text at ${path}.`);
    if (new TextEncoder().encode(value).length > MAX_SCHEMA_NATIVE_VALUE_BYTES)
      schemaNativeProjectionError(path, "Structured Markdown scalar exceeds its bounded byte length.");
    return [schemaNativeMarkdownTask(`string:${encodeSchemaNativeMarkdownToken(value)}`, depth)];
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Expected a finite number at ${path}.`);
    const token = Object.is(value, -0) ? "-0" : String(value);
    return [schemaNativeMarkdownTask(`${type}:${token}`, depth)];
  }
  if (type === "boolean") {
    if (typeof value !== "boolean")
      throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Expected a boolean at ${path}.`);
    return [schemaNativeMarkdownTask(`boolean:${value ? "true" : "false"}`, depth)];
  }
  if (type === "null") {
    if (value !== null) throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Expected null at ${path}.`);
    return [schemaNativeMarkdownTask("null", depth)];
  }
  return schemaNativeProjectionError(path, "Structured Markdown encountered an unsupported JSON Schema node.");
}

function renderSchemaNativeIssueBody(contract: SchemaNativeArtifactContract, rawValues: unknown): string {
  const formContract = assertSchemaNativeIssueFormCapability(contract);
  const values = schemaNativeValues(formContract, rawValues);
  const properties = formContract.schema.properties as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(formContract.schema.required) ? (formContract.schema.required as string[]) : [],
  );
  const blocks = schemaNativeSuppliedNames(formContract).map((name) => {
    const binding = schemaNativeBinding(formContract, name);
    const propertySchema = properties[name] as Record<string, unknown>;
    const enumValues = Array.isArray(propertySchema.enum) ? (propertySchema.enum as string[]) : undefined;
    const raw = values[name];
    let answer = raw === undefined ? GITHUB_NO_RESPONSE : String(raw);
    if (raw !== undefined && enumValues !== undefined) {
      const labels = binding?.presentation?.options;
      answer = labels?.[raw as string] ?? (raw as string);
    }
    if (raw === undefined && required.has(name))
      throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Required schema-native value "${name}" is missing.`);
    const renderedAnswer = raw === undefined ? answer : encodeSchemaNativeIssueSentinel(answer);
    return [`### ${escapeHeading(name)}`, escapeMarkdownValue(renderedAnswer)].join("\n\n");
  });
  return `${blocks.join("\n\n")}\n${schemaNativeTemplateMarker(formContract)}\n`;
}

function parseSchemaNativeIssueBody(contract: SchemaNativeArtifactContract, body: string): ExistingArtifactParseResult {
  const values: SchemaNativeRecord = {};
  const diagnostics: ExistingArtifactDiagnostic[] = [];
  try {
    assertSchemaNativeIssueFormCapability(contract);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Issue Form capability is unsupported.";
    return { parsed: false, values: {}, diagnostics: [{ code: "EXISTING_UNPARSEABLE", path: "$.schema", message }] };
  }
  const marker = stripSchemaNativeTemplateMarker(contract, body);
  if (marker.diagnostic !== undefined) return { parsed: false, values: {}, diagnostics: [marker.diagnostic] };
  const rawSource = normalizeSource(marker.exactSource);
  const source = stripMarkdownHtmlComments(rawSource, parseMarkdownStructure(rawSource));
  if (source.length > MAX_SCHEMA_NATIVE_MARKDOWN_BYTES) {
    return {
      parsed: false,
      values: {},
      diagnostics: [
        {
          code: "EXISTING_UNPARSEABLE",
          path: "$",
          message: "Schema-native Issue body exceeds its bounded observation size.",
        },
      ],
    };
  }
  const structure = parseMarkdownStructure(source);
  const properties = contract.schema.properties as Record<string, Record<string, unknown>>;
  const names = schemaNativeSuppliedNames(contract);
  const lines = source.split("\n");
  if (
    structure.headings.length !== names.length ||
    structure.headings.some(
      (heading, index) => heading.depth !== 3 || heading.indented || heading.title.trim() !== names[index],
    ) ||
    hasMaterialSourceLines(lines, 1, (structure.headings[0]?.startLine ?? 1) - 1)
  ) {
    return {
      parsed: false,
      values: {},
      diagnostics: [
        { code: "EXISTING_UNPARSEABLE", path: "$", message: "Issue headings do not match the schema-native template." },
      ],
    };
  }
  for (const [index, name] of names.entries()) {
    const heading = structure.headings[index];
    if (heading === undefined) {
      diagnostics.push({
        code: "EXISTING_UNPARSEABLE",
        path: `$.${name}`,
        message: `Expected Issue Form response heading "### ${name}".`,
      });
      break;
    }
    const nextHeading = structure.headings[index + 1];
    const endLine = (nextHeading?.startLine ?? source.split("\n").length + 1) - 1;
    const response = schemaNativeIssueResponse(
      sourceRangeSlice(structure, heading.endLine + 1, endLine),
      index < names.length - 1 || !marker.hasMarker,
    );
    const schema = properties[name] as Record<string, unknown>;
    const binding = schemaNativeBinding(contract, name);
    if (response === undefined || response === GITHUB_NO_RESPONSE) {
      if (Array.isArray(contract.schema.required) && contract.schema.required.includes(name)) {
        diagnostics.push({
          code: "EXISTING_UNPARSEABLE",
          path: `$.${name}`,
          message: "Required Issue Form response is empty.",
        });
        break;
      }
      continue;
    }
    let value = decodeSchemaNativeIssueSentinel(response);
    if (value === undefined) value = unescapeMarkdownValue(response);
    if (Array.isArray(schema.enum)) {
      const enumValues = schema.enum.filter((entry): entry is string => typeof entry === "string");
      const options = binding?.presentation?.options;
      const semantic =
        options === undefined
          ? enumValues.find((entry) => entry === value)
          : enumValues.find((entry) => options[entry] === value);
      if (semantic === undefined) {
        diagnostics.push({
          code: "EXISTING_UNPARSEABLE",
          path: `$.${name}`,
          message: "Issue Form response is not one of the schema's reversible choices.",
        });
        break;
      }
      value = semantic;
    }
    values[name] = value;
  }
  if (diagnostics.length > 0) return { parsed: false, values: {}, diagnostics: diagnostics.slice(0, 16) };
  const schemaDiagnostic = schemaNativeObservationDiagnostic(contract, values);
  if (schemaDiagnostic !== undefined) diagnostics.push(schemaDiagnostic);
  if (diagnostics.length > 0) return { parsed: false, values: {}, diagnostics: diagnostics.slice(0, 16) };
  return { parsed: true, values, diagnostics: [] };
}

function schemaNativeIssueResponse(source: string, trimTrailingSeparator: boolean): string | undefined {
  const lines = normalizeSource(source).split("\n");
  if (lines[0]?.trim() === "") lines.shift();
  if (trimTrailingSeparator && lines.at(-1)?.trim() === "") lines.pop();
  const response = lines.join("\n");
  return response.length === 0 ? undefined : response;
}

function encodeSchemaNativeIssueSentinel(value: string): string {
  const match = /^(\\*)_No response_$/u.exec(value);
  if (match === null) return value;
  return `${"\\".repeat(Math.max(1, (match[1]?.length ?? 0) * 2))}_No response_`;
}

function decodeSchemaNativeIssueSentinel(value: string): string | undefined {
  const match = /^(\\+)_No response_$/u.exec(value);
  const slashCount = match?.[1]?.length;
  if (slashCount === 1) return GITHUB_NO_RESPONSE;
  if (slashCount !== undefined && slashCount % 2 === 0) return `${"\\".repeat(slashCount / 2)}_No response_`;
  return undefined;
}

function renderSchemaNativePullRequestBody(contract: SchemaNativeArtifactContract, rawValues: unknown): string {
  const markdownContract = assertSchemaNativePullRequestMarkdownCapability(contract);
  const values = schemaNativeValues(markdownContract, rawValues);
  const properties = markdownContract.schema.properties as Record<string, Record<string, unknown>>;
  const sections = schemaNativeSuppliedNames(markdownContract).map((name) => {
    const heading = `## ${schemaNativeMarkdownFieldHeading(name)}`;
    if (!Object.hasOwn(values, name)) return heading;
    const lines = renderSchemaNativeMarkdownNode(
      properties[name] as Record<string, unknown>,
      values[name],
      0,
      { nodes: 0 },
      `$.${name}`,
    );
    return `${heading}\n\n${lines.join("\n")}`;
  });
  const body = `${sections.join("\n\n")}\n`;
  if (new TextEncoder().encode(body).length > MAX_SCHEMA_NATIVE_MARKDOWN_BYTES)
    schemaNativeProjectionError("$", "Structured Markdown artifact exceeds its bounded byte length.");
  return `${body}\n${schemaNativeTemplateMarker(markdownContract)}\n`;
}

function parseSchemaNativeMarkdownNode(
  schema: Record<string, unknown>,
  items: readonly import("./markdown-ast.js").MarkdownListItem[],
  cursor: { value: number },
  depth: number,
  budget: { nodes: number },
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_SCHEMA_NATIVE_RENDERED_NODES) throw new TypeError("Structured Markdown node limit exceeded.");
  const item = items[cursor.value];
  if (item === undefined || item.depth !== depth || item.checked !== false || item.blockquoted)
    throw new TypeError("Expected one bounded task-list value node.");
  cursor.value += 1;
  const type = schema.type;
  if (type === "object") {
    if (item.label !== "object") throw new TypeError("Object marker is missing.");
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const value: SchemaNativeRecord = {};
    while (items[cursor.value] !== undefined && (items[cursor.value]?.depth ?? 0) > depth) {
      const property = items[cursor.value];
      if (property?.depth !== depth + 1 || !property.label.startsWith("property:"))
        throw new TypeError("Object property marker is invalid.");
      const name = decodeSchemaNativeMarkdownToken(property.label.slice("property:".length));
      if (name === undefined || !Object.hasOwn(properties, name) || Object.hasOwn(value, name))
        throw new TypeError("Object property marker is undeclared or duplicated.");
      cursor.value += 1;
      value[name] = parseSchemaNativeMarkdownNode(
        properties[name] as Record<string, unknown>,
        items,
        cursor,
        depth + 2,
        budget,
      );
    }
    return value;
  }
  if (type === "array") {
    if (item.label !== "array") throw new TypeError("Array marker is missing.");
    const values: unknown[] = [];
    const itemSchema = schema.items as Record<string, unknown>;
    while (items[cursor.value] !== undefined && (items[cursor.value]?.depth ?? 0) > depth) {
      const wrapper = items[cursor.value];
      if (wrapper?.depth !== depth + 1 || wrapper.label !== "item")
        throw new TypeError("Array item marker is invalid.");
      cursor.value += 1;
      values.push(parseSchemaNativeMarkdownNode(itemSchema, items, cursor, depth + 2, budget));
    }
    return values;
  }
  if (items[cursor.value] !== undefined && (items[cursor.value]?.depth ?? 0) > depth)
    throw new TypeError("Scalar value node cannot contain children.");
  if (type === "string" && item.label.startsWith("string:")) {
    const value = decodeSchemaNativeMarkdownToken(item.label.slice("string:".length));
    if (value === undefined || new TextEncoder().encode(value).length > MAX_SCHEMA_NATIVE_VALUE_BYTES)
      throw new TypeError("String value token is invalid or over the bounded byte length.");
    return value;
  }
  if ((type === "number" || type === "integer") && item.label.startsWith(`${type}:`)) {
    const token = item.label.slice(type.length + 1);
    const value = token === "-0" ? -0 : Number(token);
    if (!Number.isFinite(value) || (String(value) !== token && !(Object.is(value, -0) && token === "-0")))
      throw new TypeError("Number value token is not canonical.");
    if (type === "integer" && !Number.isInteger(value)) throw new TypeError("Integer value token is invalid.");
    return value;
  }
  if (type === "boolean" && (item.label === "boolean:true" || item.label === "boolean:false"))
    return item.label === "boolean:true";
  if (type === "null" && item.label === "null") return null;
  throw new TypeError("Scalar value token does not match its schema type.");
}

function parseSchemaNativePullRequestBody(
  contract: SchemaNativeArtifactContract,
  rawBody: string,
): ExistingArtifactParseResult {
  const values: SchemaNativeRecord = {};
  const diagnostics: ExistingArtifactDiagnostic[] = [];
  try {
    assertSchemaNativePullRequestMarkdownCapability(contract);
  } catch (error: unknown) {
    return {
      parsed: false,
      values: {},
      diagnostics: [
        {
          code: "EXISTING_UNPARSEABLE",
          path: "$.schema",
          message: error instanceof Error ? error.message : "Markdown capability is unsupported.",
        },
      ],
    };
  }
  const marker = stripSchemaNativeTemplateMarker(contract, rawBody);
  if (marker.diagnostic !== undefined) return { parsed: false, values: {}, diagnostics: [marker.diagnostic] };
  const rawSource = normalizeSource(marker.source);
  const source = stripMarkdownHtmlComments(rawSource, parseMarkdownStructure(rawSource));
  if (new TextEncoder().encode(source).length > MAX_SCHEMA_NATIVE_MARKDOWN_BYTES) {
    return {
      parsed: false,
      values: {},
      diagnostics: [
        { code: "EXISTING_UNPARSEABLE", path: "$", message: "Markdown artifact exceeds its bounded size." },
      ],
    };
  }
  const structure = parseMarkdownStructure(source);
  const properties = contract.schema.properties as Record<string, Record<string, unknown>>;
  const names = schemaNativeSuppliedNames(contract);
  const expectedHeadings = names.map((name) => schemaNativeMarkdownFieldHeading(name));
  const lines = source.split("\n");
  if (
    structure.headings.length !== expectedHeadings.length ||
    structure.headings.some(
      (heading, index) => heading.depth !== 2 || heading.indented || heading.title !== expectedHeadings[index],
    ) ||
    hasMaterialSourceLines(lines, 1, (structure.headings[0]?.startLine ?? 1) - 1)
  ) {
    return {
      parsed: false,
      values: {},
      diagnostics: [
        {
          code: "EXISTING_UNPARSEABLE",
          path: "$",
          message: "Markdown headings do not match the schema-native template.",
        },
      ],
    };
  }
  for (let sectionIndex = 0; sectionIndex < names.length; sectionIndex += 1) {
    const name = names[sectionIndex] as string;
    const heading = structure.headings[sectionIndex] as MarkdownHeading;
    const next = structure.headings[sectionIndex + 1];
    const endLine = (next?.startLine ?? lines.length + 1) - 1;
    const sectionItems = structure.listItems.filter(
      (item) => item.startLine > heading.endLine && item.startLine < endLine,
    );
    const itemStartLines = new Set(sectionItems.map((item) => item.startLine));
    for (let line = heading.endLine + 1; line <= endLine; line += 1) {
      if ((lines[line - 1] ?? "").trim().length > 0 && !itemStartLines.has(line)) {
        diagnostics.push({
          code: "EXISTING_UNPARSEABLE",
          path: `$.${name}`,
          message: "Structured Markdown section contains text outside parsed task-list nodes.",
        });
        break;
      }
    }
    if (diagnostics.length > 0) break;
    if (sectionItems.some((item) => item.checked !== false || item.blockquoted)) {
      diagnostics.push({
        code: "EXISTING_UNPARSEABLE",
        path: `$.${name}`,
        message: "Structured Markdown values must use unquoted task-list nodes.",
      });
      break;
    }
    if (sectionItems.length === 0) continue;
    const cursor = { value: 0 };
    try {
      const value = parseSchemaNativeMarkdownNode(
        properties[name] as Record<string, unknown>,
        sectionItems,
        cursor,
        0,
        { nodes: 0 },
      );
      if (cursor.value !== sectionItems.length)
        throw new TypeError("Structured Markdown section has unconsumed list nodes.");
      // Validate once against the canonical effective input schema below so root-local references remain resolvable.
      values[name] = value;
    } catch (error: unknown) {
      diagnostics.push({
        code: "EXISTING_UNPARSEABLE",
        path: `$.${name}`,
        message: error instanceof Error ? error.message : "Structured Markdown value is invalid.",
      });
      break;
    }
  }
  if (diagnostics.length === 0) {
    const schemaDiagnostic = schemaNativeObservationDiagnostic(contract, values);
    if (schemaDiagnostic !== undefined) diagnostics.push(schemaDiagnostic);
  }
  if (diagnostics.length > 0) return { parsed: false, values: {}, diagnostics: diagnostics.slice(0, 16) };
  return { parsed: true, values, diagnostics: [] };
}

export function renderIssueArtifact(contractInput: unknown, input: unknown): string {
  if (isSchemaNativeInput(contractInput))
    return renderSchemaNativeIssueBody(parseSchemaNativeContract(contractInput), input);
  assertCanonicalContract(contractInput);
  if (contractInput.artifactKind !== "issue")
    throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "An Issue contract is required.");
  const loaded = loadCanonicalArtifact(contractInput, input);
  if (!loaded.valid) throw new SemanticValidationError(loaded.violations);
  return renderIssueBody(contractInput, loaded.canonical, loaded.dependencies);
}

export function renderPullRequestArtifact(contractInput: unknown, input: unknown): string {
  if (isSchemaNativeInput(contractInput))
    return renderSchemaNativePullRequestBody(parseSchemaNativeContract(contractInput), input);
  assertCanonicalContract(contractInput);
  if (contractInput.artifactKind !== "pull_request") {
    throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "A pull request contract is required.");
  }
  const loaded = loadCanonicalArtifact(contractInput, input);
  if (!loaded.valid) throw new SemanticValidationError(loaded.violations);
  return renderPullRequestBody(contractInput, loaded.canonical);
}

/** Construct the only values accepted by the GitHub mutation adapter. */
export function prepareIssueArtifact(contractInput: unknown, input: ArtifactInputDocument): PreparedIssueArtifact {
  assertCanonicalContract(contractInput);
  if (contractInput.artifactKind !== "issue")
    throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "An Issue contract is required.");
  requireTrustedProvenance(contractInput);
  const loaded = loadCanonicalArtifact(contractInput, input);
  if (!loaded.valid) throw new SemanticValidationError(loaded.violations);
  const title = requiredCreateTitle(input.metadata.title, contractInput.nativeMetadata.title);
  const labels = mergeIssueLabels(contractInput.nativeMetadata.labels, input.metadata.labels);
  const expectedMetadata: Readonly<Record<string, unknown>> = {
    title,
    ...(labels === undefined ? {} : { labels: [...labels] }),
    ...(input.metadata.assignees === undefined ? {} : { assignees: [...input.metadata.assignees] }),
  };
  const body = renderIssueBody(contractInput, loaded.canonical, loaded.dependencies);
  verifyRenderedRoundTrip(contractInput, loaded.canonical, body, "issue", loaded.dependencies);
  const artifact = createValidatedRenderedIssueArtifact({
    kind: "issue",
    title,
    body,
    provenance: contractInput.provenance,
    ...(labels === undefined ? {} : { labels }),
    ...(input.metadata.assignees === undefined ? {} : { assignees: input.metadata.assignees }),
  });
  verifyIssueMetadataRoundTrip(expectedMetadata, artifact);
  return { input, validation: semanticValidationFromLoad(loaded), artifact };
}

export function preparePullRequestArtifact(
  contractInput: unknown,
  input: ArtifactInputDocument,
): PreparedPullRequestArtifact {
  assertCanonicalContract(contractInput);
  if (contractInput.artifactKind !== "pull_request") {
    throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "A pull request contract is required.");
  }
  requireTrustedProvenance(contractInput);
  const loaded = loadCanonicalArtifact(contractInput, input);
  if (!loaded.valid) throw new SemanticValidationError(loaded.violations);
  const title = requiredCreateTitle(input.metadata.title, contractInput.nativeMetadata.title);
  const head = requiredMetadataString(input.metadata.head, "head");
  const base = requiredMetadataString(input.metadata.base, "base");
  const body = renderPullRequestBody(contractInput, loaded.canonical);
  verifyRenderedRoundTrip(contractInput, loaded.canonical, body, "pull_request");
  const artifact = createValidatedRenderedPullRequestArtifact({
    kind: "pull_request",
    title,
    body,
    provenance: contractInput.provenance,
    head,
    base,
    ...(input.metadata.draft === undefined ? {} : { draft: input.metadata.draft }),
    ...(input.metadata.maintainerCanModify === undefined
      ? {}
      : { maintainerCanModify: input.metadata.maintainerCanModify }),
  });
  verifyPullRequestMetadataRoundTrip(input.metadata, artifact);
  return { input, validation: semanticValidationFromLoad(loaded), artifact };
}

export function parseExistingIssueArtifact(
  contractInput: unknown,
  body: string | null | undefined,
): ExistingArtifactParseResult {
  if (isSchemaNativeInput(contractInput))
    return parseSchemaNativeIssueBody(parseSchemaNativeContract(contractInput), body ?? "");
  assertCanonicalContract(contractInput);
  if (contractInput.artifactKind !== "issue")
    throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "An Issue contract is required.");
  return parseRenderedBody(contractInput, body ?? "", 3, false);
}

export function parseExistingPullRequestArtifact(
  contractInput: unknown,
  body: string | null | undefined,
): ExistingArtifactParseResult {
  if (isSchemaNativeInput(contractInput))
    return parseSchemaNativePullRequestBody(parseSchemaNativeContract(contractInput), body ?? "");
  assertCanonicalContract(contractInput);
  if (contractInput.artifactKind !== "pull_request") {
    throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "A pull request contract is required.");
  }
  return parseRenderedBody(contractInput, body ?? "", undefined, true);
}

/**
 * Recover field values from a malformed or wrong-template body without
 * weakening the strict existing-artifact parser. The section boundaries and
 * field decoding are the same parser primitives used by strict parsing; only
 * the order/complete-structure requirement is relaxed for an explicitly
 * selected repair target.
 */
export function recoverExistingArtifactValues(
  contractInput: unknown,
  body: string | null | undefined,
): RecoverableArtifactValues {
  assertCanonicalContract(contractInput);
  const contract = contractInput;
  const strict =
    contract.artifactKind === "issue"
      ? parseExistingIssueArtifact(contract, body)
      : parseExistingPullRequestArtifact(contract, body);
  const dependencyMarker = contract.artifactKind === "issue" ? extractIssueDependencyMarker(body ?? "") : undefined;
  const markerFreeBody = extractTemplateIdentityMarker(dependencyMarker?.body ?? body ?? "").body;
  const source = normalizeSource(markerFreeBody);
  const structure = parseMarkdownStructure(source);
  if (strict.parsed) {
    return {
      values: strict.values,
      dependencies: strict.dependencies,
      diagnostics: strict.diagnostics,
      coverage: completeRecoveryCoverage(source),
    };
  }

  const stripArtifactComments = contract.artifactKind === "pull_request";
  const sourceLines = source.split("\n");
  const cleanedLines = stripArtifactComments ? stripMarkdownHtmlComments(source, structure).split("\n") : sourceLines;
  const values: Record<string, unknown> = {};
  const expectedTitles = new Map<string, number>();

  for (const section of contract.sections) {
    if (section.kind !== "input") continue;
    const field = section.fields[0];
    const title = section.title ?? field?.label;
    if (field === undefined || title === undefined) continue;
    const expectedTitle = escapeHeading(title);
    expectedTitles.set(expectedTitle, (expectedTitles.get(expectedTitle) ?? 0) + 1);
  }

  for (const section of contract.sections) {
    if (section.kind !== "input") continue;
    const field = section.fields[0];
    const title = section.title ?? field?.label;
    if (field === undefined || title === undefined) continue;
    const expectedTitle = escapeHeading(title);
    if (expectedTitles.get(expectedTitle) !== 1) continue;
    const level = section.render.headingLevel ?? section.nativeMetadata.headingLevel ?? 3;
    const candidates = structure.headings.filter(
      (heading) => heading.depth === level && heading.title.trim() === expectedTitle,
    );
    if (candidates.length !== 1) continue;
    const heading = candidates[0] as MarkdownHeading;
    const contractIndex = contract.sections.indexOf(section);
    const nextHeading = findNextRecognizedHeading(contract, structure.headings, heading.endLine + 1);
    const bodyStartLine = heading.endLine + 1;
    const bodyEndLine = (nextHeading?.startLine ?? sourceLines.length + 1) - 1;
    const documentationSplit =
      contract.artifactKind === "pull_request"
        ? splitTrailingDocumentation(
            cleanedLines,
            bodyStartLine,
            bodyEndLine,
            trailingDocumentation(contract, contractIndex),
          )
        : undefined;
    const fieldEndLine = documentationSplit?.fieldEndLine ?? bodyEndLine;
    const parsed = parseFieldLines(
      field,
      sourceRangeSlice(structure, bodyStartLine, fieldEndLine),
      `$.${field.id}`,
      contract.artifactKind === "issue",
      pullRequestFieldPlaceholder(field, stripArtifactComments),
      stripArtifactComments,
    );
    // parseFieldLines may retain known checklist selections alongside a
    // bounded structural diagnostic. The canonical loader below decides
    // whether such a partial value is semantically usable.
    if (parsed.value !== undefined) values[field.id] = parsed.value;
  }

  const dependencies = dependencyMarker?.dependencies;
  const coverage = recoveryCoverage(contract, source, structure, stripArtifactComments);
  return { values, dependencies, diagnostics: strict.diagnostics, coverage };
}

export function validateExistingIssueArtifact(
  contractInput: unknown,
  body: string | null | undefined,
  subject?: IssueReference,
): ExistingArtifactValidationResult {
  assertCanonicalContract(contractInput);
  const parse = parseExistingIssueArtifact(contractInput, body);
  return validateParsedArtifact(contractInput, parse, subject);
}

export function validateExistingPullRequestArtifact(
  contractInput: unknown,
  body: string | null | undefined,
): ExistingArtifactValidationResult {
  assertCanonicalContract(contractInput);
  const parse = parseExistingPullRequestArtifact(contractInput, body);
  return validateParsedArtifact(contractInput, parse);
}

export interface ExistingArtifactCandidate {
  readonly contract: CanonicalContract;
  readonly result: ExistingArtifactValidationResult;
}

export interface ExistingArtifactSelection {
  readonly contract?: CanonicalContract;
  readonly result: ExistingArtifactValidationResult;
}

export interface ExistingArtifactProjection {
  readonly valid: boolean;
  readonly projection: "canonical" | "unavailable";
  readonly classification: ExistingArtifactClassification;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly dependencies?: IssueDependencies;
  readonly diagnostics: readonly ExistingArtifactDiagnostic[];
  readonly violations?: readonly SemanticViolation[];
  readonly attemptedTemplates?: readonly string[];
}

/** Project only validated semantic values; invalid artifacts never expose parsed fields. */
export function projectExistingArtifact(result: ExistingArtifactValidationResult): ExistingArtifactProjection {
  return {
    valid: result.valid,
    projection: result.valid ? "canonical" : "unavailable",
    classification: result.classification,
    ...(result.valid ? { fields: result.parse.values } : {}),
    ...(result.valid && result.parse.dependencies !== undefined ? { dependencies: result.parse.dependencies } : {}),
    diagnostics: result.parse.diagnostics,
    ...(result.classification === "semantic" ? { violations: result.violations as readonly SemanticViolation[] } : {}),
    ...(result.attemptedTemplates === undefined ? {} : { attemptedTemplates: result.attemptedTemplates }),
  };
}

/** Select a uniquely parsed governed artifact, failing closed on ambiguity. */
export function selectExistingArtifactCandidate(
  candidates: readonly ExistingArtifactCandidate[],
): ExistingArtifactSelection {
  const parsed = candidates.filter((candidate) => candidate.result.parse.parsed);
  if (parsed.length === 1) {
    const selected = parsed[0] as ExistingArtifactCandidate;
    return selected;
  }
  if (parsed.length > 1) {
    const paths = parsed.map((candidate) => candidate.contract.templateIdentity.path).sort(compareStrings);
    const diagnostic: ExistingArtifactDiagnostic = {
      code: "EXISTING_AMBIGUOUS_TEMPLATE",
      path: "$.template",
      message: `Artifact structure matches multiple repository-native templates: ${paths.join(", ")}.`,
    };
    return {
      result: {
        valid: false,
        classification: "ambiguous",
        parse: { parsed: false, values: {}, diagnostics: [diagnostic] },
        violations: [diagnostic],
      },
    };
  }

  const attemptedTemplates = candidates
    .map((candidate) => candidate.contract.templateIdentity.path)
    .sort(compareStrings);
  const classification = candidates.some((candidate) =>
    candidate.result.parse.diagnostics.some((diagnostic) => diagnostic.code === "EXISTING_WRONG_TEMPLATE"),
  )
    ? "wrong-template"
    : "unparseable";
  const diagnostic: ExistingArtifactDiagnostic = {
    code: classification === "wrong-template" ? "EXISTING_WRONG_TEMPLATE" : "EXISTING_UNPARSEABLE",
    path: "$.template",
    message:
      classification === "wrong-template"
        ? `Artifact structure does not match any repository-native template. Tried: ${attemptedTemplates.join(", ")}.`
        : `Artifact could not be parsed against any repository-native template. Tried: ${attemptedTemplates.join(", ")}.`,
  };
  return {
    result: {
      valid: false,
      classification,
      parse: { parsed: false, values: {}, diagnostics: [diagnostic] },
      violations: [diagnostic],
      attemptedTemplates,
    },
  };
}

/** Validate the same required string metadata enforced by mutation preparation. */
export function validateRequiredMetadataString(value: unknown, key: string): ArtifactMetadataViolation | undefined {
  if (typeof value === "string" && value.trim().length > 0) return undefined;
  return {
    code: "INPUT_METADATA_INVALID",
    path: `$.${key}`,
    message: `${key} must be a non-empty string.`,
  };
}

export async function validateExistingIssueFromAdapter(
  reader: ExistingIssueReader,
  contract: unknown,
  issueNumber: number,
): Promise<FetchedExistingArtifact> {
  const issue = await reader.getIssue(issueNumber);
  return {
    number: issueNumber,
    url: issue.url,
    result: validateExistingIssueArtifact(
      contract,
      issue.body,
      issueReferenceFromUrl(issue.url, issueNumber, issue.repositoryId, issue.repositoryHost),
    ),
  };
}

export async function validateExistingPullRequestFromAdapter(
  reader: ExistingPullRequestReader,
  contract: unknown,
  pullRequestNumber: number,
): Promise<FetchedExistingArtifact> {
  const pullRequest = await reader.getPullRequest(pullRequestNumber);
  return {
    number: pullRequestNumber,
    url: pullRequest.url,
    result: validateExistingPullRequestArtifact(contract, pullRequest.body),
  };
}

function validateParsedArtifact(
  contract: CanonicalContract,
  parse: ExistingArtifactParseResult,
  subject?: IssueReference,
): ExistingArtifactValidationResult {
  if (!parse.parsed) {
    const classification = parse.diagnostics.some((diagnostic) => diagnostic.code === "EXISTING_WRONG_TEMPLATE")
      ? "wrong-template"
      : "unparseable";
    return { valid: false, classification, parse, violations: parse.diagnostics };
  }
  const dependencyInput = parse.dependencyInput ?? parse.dependencies;
  const dependencyValidation =
    contract.artifactKind === "issue" ? validateIssueDependencies(dependencyInput, subject) : undefined;
  if (dependencyValidation !== undefined && !dependencyValidation.valid) {
    return {
      valid: false,
      classification: "semantic",
      parse,
      violations: dependencyValidation.violations.map((violation) => ({
        code: "INPUT_DEPENDENCY" as const,
        path: prefixDependencyPath(violation.path),
        message: violation.message,
      })),
    };
  }
  const normalizedParse =
    dependencyValidation === undefined
      ? parse
      : { ...parse, dependencies: dependencyValidation.dependencies, dependencyInput: undefined };
  const semantic = loadCanonicalArtifact(contract, {
    fields: parse.values,
    metadata: {},
    source: "existing",
    dependencies: dependencyValidation?.dependencies ?? parse.dependencies,
  });
  return {
    valid: semantic.valid,
    classification: semantic.valid ? "valid" : "semantic",
    parse: normalizedParse,
    violations: semantic.violations,
  };
}

function requireTrustedProvenance(
  contract: CanonicalContract,
): asserts contract is CanonicalContract & { readonly provenance: ContractProvenance } {
  if (contract.provenance === undefined) {
    throw new ArtifactPreparationError(
      "ARTIFACT_PROVENANCE_MISSING",
      "Mutation preparation requires a contract bound to trusted repository governance.",
      [
        createArtifactDiagnostic({
          state: "unrecoverable",
          code: "ARTIFACT_UNRECOVERABLE",
          reason: "unrecoverable",
          path: "$.provenance",
          message: "The compiled contract has no trusted repository/ref provenance.",
          recovery: [{ action: "retry", path: "$.provenance" }],
        }),
      ],
    );
  }
}

function verifyPullRequestMetadataRoundTrip(
  input: ArtifactInputMetadata,
  artifact: ValidatedRenderedPullRequestArtifact,
): void {
  const expected: Readonly<Record<string, unknown>> = {
    title: input.title,
    head: input.head,
    base: input.base,
    ...(input.draft === undefined ? {} : { draft: input.draft }),
    ...(input.maintainerCanModify === undefined ? {} : { maintainerCanModify: input.maintainerCanModify }),
  };
  const actual: Readonly<Record<string, unknown>> = {
    title: artifact.title,
    head: artifact.head,
    base: artifact.base,
    ...(artifact.draft === undefined ? {} : { draft: artifact.draft }),
    ...(artifact.maintainerCanModify === undefined ? {} : { maintainerCanModify: artifact.maintainerCanModify }),
  };
  const mismatches: ArtifactDiagnostic[] = [];
  for (const key of Object.keys(expected).sort(compareStrings)) {
    const path = `$.metadata.${key}`;
    if (stableValue(expected[key]) === stableValue(actual[key])) continue;
    mismatches.push(
      createArtifactDiagnostic({
        state: "conflicting",
        code: "FIELD_CONFLICT",
        detailCode: "FIELD_VALUE_CONFLICT",
        reason: "conflict",
        path,
        message: "Prepared pull request metadata changed before the mutation boundary.",
        expected: createFieldEvidence(path, expected[key]),
        actual: createFieldEvidence(path, actual[key]),
        recovery: [{ action: "repair", path, hint: "Repair the pull request metadata projection." }],
      }),
    );
  }
  if (mismatches.length > 0) {
    throw new ArtifactPreparationError(
      "ARTIFACT_ROUND_TRIP_INVALID",
      "Prepared pull request metadata did not preserve its validated values.",
      mismatches,
    );
  }
}

/** @internal Validate the canonical Issue metadata handoff before mutation. */
export function verifyIssueMetadataRoundTrip(
  expected: Readonly<Record<string, unknown>>,
  artifact: ValidatedRenderedIssueArtifact,
): void {
  const actual: Readonly<Record<string, unknown>> = {
    title: artifact.title,
    ...(artifact.labels === undefined ? {} : { labels: artifact.labels }),
    ...(artifact.assignees === undefined ? {} : { assignees: artifact.assignees }),
  };
  const mismatches: ArtifactDiagnostic[] = [];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(compareStrings);
  for (const key of keys) {
    const expectedPresent = Object.prototype.hasOwnProperty.call(expected, key);
    const actualPresent = Object.prototype.hasOwnProperty.call(actual, key);
    const path = `$.metadata.${key}`;
    if (expectedPresent && actualPresent && stableValue(expected[key]) === stableValue(actual[key])) continue;
    mismatches.push(
      createArtifactDiagnostic({
        state: "conflicting",
        code: "FIELD_CONFLICT",
        detailCode: "FIELD_VALUE_CONFLICT",
        reason: "conflict",
        path,
        message: "Prepared issue metadata changed before the mutation boundary.",
        expected: createFieldEvidence(path, expectedPresent ? expected[key] : undefined),
        actual: createFieldEvidence(path, actualPresent ? actual[key] : undefined),
        recovery: [{ action: "repair", path, hint: "Repair the issue metadata projection." }],
      }),
    );
  }
  if (mismatches.length > 0) {
    throw new ArtifactPreparationError(
      "ARTIFACT_ROUND_TRIP_INVALID",
      "Prepared issue metadata did not preserve its validated values.",
      mismatches,
    );
  }
}

function verifyRenderedRoundTrip(
  contract: CanonicalContract,
  expectedValues: Readonly<Record<string, unknown>>,
  body: string,
  kind: "issue" | "pull_request",
  expectedDependencies: IssueDependencies | undefined = undefined,
): void {
  const parsed =
    kind === "issue" ? parseExistingIssueArtifact(contract, body) : parseExistingPullRequestArtifact(contract, body);
  if (!parsed.parsed) {
    throw new ArtifactPreparationError(
      "ARTIFACT_ROUND_TRIP_INVALID",
      `Rendered ${kind} artifact did not reparse under the compiled contract.`,
      roundTripParseDiagnostics(contract, expectedValues, parsed.diagnostics),
    );
  }

  const reconstructed = validateSemanticInput(contract, parsed.values);
  if (!reconstructed.valid) {
    throw new ArtifactPreparationError(
      "ARTIFACT_ROUND_TRIP_INVALID",
      `Rendered ${kind} artifact failed semantic validation after reparsing.`,
      roundTripSemanticDiagnostics(contract, expectedValues, parsed.values, reconstructed.violations),
    );
  }

  const mismatches: ArtifactDiagnostic[] = [...compareMaterializedValues(expectedValues, reconstructed.values)];
  if (kind === "issue") {
    const actualDependencies = parsed.dependencies ?? EMPTY_ISSUE_DEPENDENCIES;
    const expected = expectedDependencies ?? EMPTY_ISSUE_DEPENDENCIES;
    if (stableValue(expected) !== stableValue(actualDependencies)) {
      mismatches.push(
        createArtifactDiagnostic({
          state: "conflicting",
          code: "FIELD_CONFLICT",
          detailCode: "FIELD_VALUE_CONFLICT",
          reason: "conflict",
          path: "$.dependencies",
          message: "Rendered artifact changed its Issue dependency semantics.",
          expected: createFieldEvidence("$.dependencies", expected),
          actual: createFieldEvidence("$.dependencies", actualDependencies),
          recovery: [{ action: "repair", path: "$.dependencies" }],
        }),
      );
    }
  }
  if (mismatches.length > 0) {
    throw new ArtifactPreparationError(
      "ARTIFACT_ROUND_TRIP_INVALID",
      `Rendered ${kind} artifact did not preserve its validated semantic values.`,
      mismatches,
    );
  }
}

function roundTripParseDiagnostics(
  contract: CanonicalContract,
  expectedValues: Readonly<Record<string, unknown>>,
  diagnostics: readonly ExistingArtifactDiagnostic[],
): readonly ArtifactDiagnostic[] {
  const projected = diagnostics.slice(0, MAX_ARTIFACT_DIAGNOSTICS).map((diagnostic) => {
    const fieldId = semanticFieldId(contract, diagnostic.path);
    const path = fieldId === undefined ? semanticDiagnosticPath(contract, diagnostic.path) : fieldPath(fieldId);
    return createArtifactDiagnostic({
      state: "unsupported",
      code: "FIELD_UNSUPPORTED",
      detailCode: "TEMPLATE_UNPARSEABLE",
      reason: "unsupported",
      ...(path === undefined ? {} : { path }),
      message: roundTripParseMessage(diagnostic.code),
      ...(fieldId === undefined
        ? {}
        : {
            expected: createFieldEvidence(fieldPath(fieldId), expectedValues[fieldId]),
            actual: createFieldEvidence(fieldPath(fieldId), undefined),
          }),
      recovery: path === undefined ? [{ action: "retry" as const }] : [{ action: "repair" as const, path }],
    });
  });
  return projected.length > 0
    ? projected
    : [
        createArtifactDiagnostic({
          state: "unrecoverable",
          code: "ARTIFACT_UNRECOVERABLE",
          reason: "unrecoverable",
          message: "Rendered artifact could not be reparsed under the compiled contract.",
          recovery: [{ action: "retry" }],
        }),
      ];
}

function roundTripSemanticDiagnostics(
  contract: CanonicalContract,
  expectedValues: Readonly<Record<string, unknown>>,
  actualValues: Readonly<Record<string, unknown>>,
  violations: readonly SemanticViolation[],
): readonly ArtifactDiagnostic[] {
  const projected = violations.slice(0, MAX_ARTIFACT_DIAGNOSTICS).map((violation) => {
    const fieldId = semanticFieldId(contract, violation.path);
    const path = fieldId === undefined ? semanticDiagnosticPath(contract, violation.path) : fieldPath(fieldId);
    const evidencePath = fieldId === undefined ? path : fieldPath(fieldId);
    return createArtifactDiagnostic({
      state: "invalid",
      code: "FIELD_INVALID",
      detailCode: violation.code === "INPUT_TYPE" ? "FIELD_TYPE_MISMATCH" : "FIELD_CONSTRAINT_VIOLATION",
      reason: violation.code === "INPUT_TYPE" ? "type" : "constraint",
      ...(path === undefined ? {} : { path }),
      message:
        violation.code === "INPUT_TYPE"
          ? "Reparsed semantic value has an unsupported type."
          : "Reparsed semantic value violates a compiled constraint.",
      ...(evidencePath === undefined
        ? {}
        : {
            expected: createFieldEvidence(evidencePath, fieldId === undefined ? undefined : expectedValues[fieldId]),
            actual: createFieldEvidence(evidencePath, fieldId === undefined ? undefined : actualValues[fieldId]),
          }),
      recovery: path === undefined ? [{ action: "repair" as const }] : [{ action: "repair" as const, path }],
    });
  });
  return projected.length > 0
    ? projected
    : [
        createArtifactDiagnostic({
          state: "unrecoverable",
          code: "ARTIFACT_UNRECOVERABLE",
          reason: "unrecoverable",
          message: "Reparsed artifact failed semantic validation under the compiled contract.",
          recovery: [{ action: "retry" }],
        }),
      ];
}

function compareMaterializedValues(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): readonly ArtifactDiagnostic[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(compareStrings);
  const diagnostics: ArtifactDiagnostic[] = [];
  for (const key of keys) {
    const expectedPresent = Object.prototype.hasOwnProperty.call(expected, key);
    const actualPresent = Object.prototype.hasOwnProperty.call(actual, key);
    const path = fieldPath(key);
    if (!expectedPresent || !actualPresent) {
      diagnostics.push(
        createArtifactDiagnostic({
          state: "conflicting",
          code: "FIELD_CONFLICT",
          detailCode: "FIELD_VALUE_CONFLICT",
          reason: "conflict",
          path,
          message: "Rendered artifact changed whether this semantic field was materialized.",
          expected: createFieldEvidence(path, expectedPresent ? expected[key] : undefined),
          actual: createFieldEvidence(path, actualPresent ? actual[key] : undefined),
          recovery: [{ action: "repair", path, hint: "Repair the renderer/parser mapping for this field." }],
        }),
      );
      continue;
    }
    if (stableValue(expected[key]) !== stableValue(actual[key])) {
      diagnostics.push(
        createArtifactDiagnostic({
          state: "conflicting",
          code: "FIELD_CONFLICT",
          detailCode: "FIELD_VALUE_CONFLICT",
          reason: "conflict",
          path,
          message: "Rendered artifact changed this materialized semantic value.",
          expected: createFieldEvidence(path, expected[key]),
          actual: createFieldEvidence(path, actual[key]),
          recovery: [{ action: "repair", path, hint: "Repair the renderer/parser mapping for this field." }],
        }),
      );
    }
  }
  return diagnostics;
}

function fieldPath(fieldId: string): string {
  return `$.fields.${fieldId}`;
}

function semanticFieldId(contract: CanonicalContract, path: string): string | undefined {
  const fields = contract.sections.flatMap((section) => section.fields);
  for (const field of fields) {
    if (path === `$.${field.id}` || path.startsWith(`$.${field.id}[`)) return field.id;
  }
  const sectionId = /^\$\.sections\.([^.[\]]+)/u.exec(path)?.[1];
  return sectionId === undefined
    ? undefined
    : contract.sections.find((section) => section.id === sectionId)?.fields[0]?.id;
}

function semanticDiagnosticPath(contract: CanonicalContract, path: string): string | undefined {
  const sectionId = /^\$\.sections\.([^.[\]]+)/u.exec(path)?.[1];
  if (sectionId !== undefined && contract.sections.some((section) => section.id === sectionId)) {
    return `$.sections.${sectionId}`;
  }
  return path === "$" ? undefined : path.startsWith("$.artifact") ? undefined : path;
}

function roundTripParseMessage(code: ExistingArtifactDiagnosticCode): string {
  switch (code) {
    case "EXISTING_UNKNOWN_CHECKLIST_ITEM":
      return "Rendered artifact contains an undeclared checklist item.";
    case "EXISTING_EXTRA_CONTENT":
      return "Rendered artifact contains content outside the compiled template structure.";
    case "EXISTING_WRONG_TEMPLATE":
      return "Rendered artifact does not match the compiled template structure.";
    default:
      return "Rendered artifact does not match the compiled field representation.";
  }
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

function issueReferenceFromUrl(
  url: string,
  number: number,
  repositoryId?: string,
  repositoryHost?: string,
): IssueReference | undefined {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/[1-9][0-9]*$/u.exec(url);
  if (match === null || repositoryId === undefined) return undefined;
  return {
    repositoryHost: (repositoryHost ?? match[1]).toLocaleLowerCase("en-US"),
    repositoryId,
    repository: `${match[2]}/${match[3]}`.toLocaleLowerCase("en-US"),
    number,
  };
}

function renderIssueBody(
  contract: CanonicalContract,
  values: Readonly<Record<string, unknown>>,
  dependencies: IssueDependencies | undefined = undefined,
): string {
  const blocks: string[] = [];
  for (let sectionIndex = 0; sectionIndex < contract.sections.length; sectionIndex += 1) {
    const section = contract.sections[sectionIndex] as CanonicalContract["sections"][number];
    if (section.kind === "documentation") {
      // GitHub renders Issue Form markdown in the form only; it is not part of
      // the submitted Issue body. The content remains in the contract for
      // schema/explain and native-source traceability.
      continue;
    }
    const title = section.title ?? section.fields[0]?.label;
    if (title === undefined) continue;
    const body = section.fields
      .map((field) => renderFieldValue(field, values[field.id], "issue"))
      .filter(Boolean)
      .join("\n\n");
    blocks.push([`### ${escapeHeading(title)}`, body].filter((part) => part.length > 0).join("\n\n"));
  }
  const marker = renderTemplateIdentityMarker(contract, "issue");
  const dependencyMarker =
    dependencies !== undefined && (dependencies.blockedBy.length > 0 || dependencies.blocks.length > 0)
      ? `\n${renderIssueDependencyMarker(dependencies)}`
      : "";
  return `${blocks.join("\n\n")}\n\n${marker}${dependencyMarker}\n`;
}

function renderPullRequestBody(contract: CanonicalContract, values: Readonly<Record<string, unknown>>): string {
  const blocks: string[] = [];
  for (let sectionIndex = 0; sectionIndex < contract.sections.length; sectionIndex += 1) {
    const section = contract.sections[sectionIndex] as CanonicalContract["sections"][number];
    if (section.kind === "documentation") {
      const content = trimBlankLines(section.content ?? "");
      if (content !== undefined)
        blocks.push(section.title === undefined ? content : renderDocumentation(section, content));
      continue;
    }
    const title = section.title ?? section.fields[0]?.label;
    const level = section.render.headingLevel ?? section.nativeMetadata.headingLevel;
    if (title === undefined || level === undefined)
      throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `PR section "${section.id}" has no heading identity.`);
    const rendered = section.fields
      .map((field) => renderFieldValue(field, values[field.id], "pull_request"))
      .filter(Boolean);
    blocks.push([`${"#".repeat(level)} ${escapeHeading(title)}`, ...rendered].join("\n\n"));
  }
  return `${blocks.join("\n\n")}\n\n${renderTemplateIdentityMarker(contract, "pull_request")}\n`;
}

function renderDocumentation(section: CanonicalContract["sections"][number], content: string): string {
  const level = section.render.headingLevel ?? section.nativeMetadata.headingLevel;
  if (section.title === undefined || level === undefined) return content;
  return [`${"#".repeat(level)} ${escapeHeading(section.title)}`, content].join("\n\n");
}

function renderFieldValue(field: CanonicalField, value: unknown, kind: "issue" | "pull_request"): string {
  if (field.type === "string" || field.type === "enum") {
    if (typeof value === "string" && value.length === 0) {
      return field.nativeMetadata.render === undefined
        ? EXPLICIT_EMPTY_STRING_MARKER
        : renderCodeBlock(EXPLICIT_EMPTY_STRING_MARKER, field.nativeMetadata.render);
    }
    if (typeof value === "string" && (kind !== "issue" || value.trim().length > 0)) {
      const renderedValue = kind === "issue" ? issueNativeValue(field, value) : value;
      return field.nativeMetadata.render === undefined
        ? escapeMarkdownValue(renderedValue)
        : renderCodeBlock(renderedValue, field.nativeMetadata.render);
    }
    if (kind === "pull_request") return field.nativeMetadata.placeholder ?? "";
    return field.nativeMetadata.render === undefined
      ? GITHUB_NO_RESPONSE
      : renderCodeBlock("", field.nativeMetadata.render);
  }
  if (field.type === "array") {
    if (!Array.isArray(value)) return kind === "issue" ? GITHUB_NO_RESPONSE : "";
    if (value.length === 0) return kind === "issue" ? GITHUB_NO_RESPONSE : "";
    const renderedValues =
      kind === "issue"
        ? value.map((entry) => (typeof entry === "string" ? issueNativeValue(field, entry) : String(entry)))
        : value.map((entry) => String(entry));
    if (field.nativeMetadata.multiple === true)
      return renderedValues.map((entry) => escapeMarkdownValue(entry)).join(", ");
    return renderedValues.map((entry) => `- ${escapeMarkdownValue(entry)}`).join("\n");
  }
  const selected = new Set(
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
  );
  const placeholder = kind === "pull_request" ? field.nativeMetadata.placeholder : undefined;
  const lines = field.items.map(
    (item) => `- [${selected.has(item.id) ? "x" : " "}] ${escapeChecklistLabel(item.label)}`,
  );
  return [placeholder === undefined ? "" : placeholder, lines.join("\n")].filter(Boolean).join("\n\n");
}

/** Map canonical Issue semantic values to the labels shown by GitHub Issue Forms. */
function issueNativeValue(field: CanonicalField, value: string): string {
  if (field.type === "enum") return field.options.find((option) => option.value === value)?.label ?? value;
  if (field.type === "array") return field.items.options?.find((option) => option.value === value)?.label ?? value;
  return value;
}

/** Map GitHub Issue Form labels back to canonical semantic values. */
function issueSemanticValue(field: CanonicalField, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (field.type === "enum") return field.options.find((option) => option.label === value)?.value ?? value;
  if (field.type === "array") return field.items.options?.find((option) => option.label === value)?.value ?? value;
  return value;
}

const MAX_RECOVERY_COVERAGE_RANGES = 16;

interface DocumentationRun {
  readonly count: number;
  readonly source?: string;
}

interface DocumentationSplit {
  readonly fieldEndLine: number;
  readonly documentationStartLine: number;
}

function completeRecoveryCoverage(source: string): ArtifactRecoveryCoverage {
  const sourceLineCount = normalizeSource(source).split("\n").length;
  return {
    complete: true,
    sourceLineCount,
    coveredLineCount: sourceLineCount,
    unmatchedLineCount: 0,
    unmatchedRanges: [],
    truncated: false,
  };
}

function recoveryCoverage(
  contract: CanonicalContract,
  source: string,
  structure: MarkdownStructure,
  stripArtifactComments: boolean,
): ArtifactRecoveryCoverage {
  const lines = normalizeSource(source).split("\n");
  const cleanedLines = (stripArtifactComments ? stripMarkdownHtmlComments(source, structure) : source).split("\n");
  const covered = lines.map(() => false);
  let decodingComplete = true;
  const mark = (startLine: number, endLine: number): void => {
    for (let line = Math.max(1, startLine); line <= Math.min(lines.length, endLine); line += 1)
      covered[line - 1] = true;
  };

  if (stripArtifactComments) {
    for (const block of structure.opaqueBlocks) {
      if (block.kind === "html" && isCompleteHtmlComment(structure.sourceSlice(block)))
        mark(block.startLine, block.endLine);
    }
  }

  const titleCounts = new Map<string, number>();
  for (const section of contract.sections) {
    if (section.kind !== "input") continue;
    const title = section.title ?? section.fields[0]?.label;
    if (title !== undefined) titleCounts.set(escapeHeading(title), (titleCounts.get(escapeHeading(title)) ?? 0) + 1);
  }

  for (let contractIndex = 0; contractIndex < contract.sections.length; contractIndex += 1) {
    const section = contract.sections[contractIndex] as CanonicalContract["sections"][number];
    if (section.kind !== "input") continue;
    const field = section.fields[0];
    const title = section.title ?? field?.label;
    if (field === undefined || title === undefined) {
      decodingComplete = false;
      continue;
    }
    const expectedTitle = escapeHeading(title);
    const level = section.render.headingLevel ?? section.nativeMetadata.headingLevel ?? 3;
    const candidates = structure.headings.filter(
      (heading) => heading.depth === level && heading.title.trim() === expectedTitle,
    );
    if (titleCounts.get(expectedTitle) !== 1 || candidates.length !== 1) {
      decodingComplete = false;
      continue;
    }
    const heading = candidates[0] as MarkdownHeading;
    const nextHeading = findNextRecognizedHeading(contract, structure.headings, heading.endLine + 1);
    const bodyStartLine = heading.endLine + 1;
    const bodyEndLine = (nextHeading?.startLine ?? lines.length + 1) - 1;
    const docs = contract.artifactKind === "pull_request" ? trailingDocumentation(contract, contractIndex) : undefined;
    const documentationSplit = splitTrailingDocumentation(cleanedLines, bodyStartLine, bodyEndLine, docs);
    if (docs !== undefined && documentationSplit === undefined) {
      decodingComplete = false;
      mark(heading.startLine, heading.endLine);
      continue;
    }
    const fieldEndLine = documentationSplit?.fieldEndLine ?? bodyEndLine;
    const parsed = parseFieldLines(
      field,
      sourceRangeSlice(structure, bodyStartLine, fieldEndLine),
      `$.${field.id}`,
      contract.artifactKind === "issue",
      pullRequestFieldPlaceholder(field, stripArtifactComments),
      stripArtifactComments,
    );
    if (parsed.diagnostics.length > 0) {
      decodingComplete = false;
      mark(heading.startLine, heading.endLine);
      continue;
    }
    mark(heading.startLine, fieldEndLine);
    if (documentationSplit !== undefined) mark(documentationSplit.documentationStartLine, bodyEndLine);
  }

  if (contract.artifactKind === "pull_request") {
    for (let contractIndex = 0; contractIndex < contract.sections.length; contractIndex += 1) {
      const section = contract.sections[contractIndex] as CanonicalContract["sections"][number];
      if (section.kind !== "documentation") continue;
      const previous = contract.sections[contractIndex - 1];
      if (previous?.kind === "input") continue;
      const run = documentationRun(contract, contractIndex);
      contractIndex += run.count - 1;
      if (run.source === undefined) continue;
      const nextInput = findNextInputHeading(contract, structure.headings, contractIndex, 1, undefined);
      const endLine = (nextInput?.startLine ?? lines.length + 1) - 1;
      const actual = cleanedMarkdownText(sourceRangeSlice(structure, 1, endLine), true);
      if (actual === run.source) mark(1, endLine);
      else decodingComplete = false;
    }
  }

  const unmatchedLines: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!covered[index] && (lines[index] ?? "").trim().length > 0) unmatchedLines.push(index + 1);
  }
  const ranges: MarkdownSourceRange[] = [];
  let truncated = false;
  for (const line of unmatchedLines) {
    const previous = ranges.at(-1);
    if (previous !== undefined && previous.endLine === line - 1) {
      ranges[ranges.length - 1] = { startLine: previous.startLine, endLine: line };
    } else if (ranges.length < MAX_RECOVERY_COVERAGE_RANGES) {
      ranges.push({ startLine: line, endLine: line });
    } else {
      truncated = true;
    }
  }
  return {
    complete: decodingComplete && unmatchedLines.length === 0,
    sourceLineCount: lines.length,
    coveredLineCount: lines.length - unmatchedLines.length,
    unmatchedLineCount: unmatchedLines.length,
    unmatchedRanges: ranges,
    truncated,
  };
}

function documentationRun(contract: CanonicalContract, startIndex: number): DocumentationRun {
  const blocks: string[] = [];
  let count = 0;
  for (let index = startIndex; index < contract.sections.length; index += 1) {
    const section = contract.sections[index] as CanonicalContract["sections"][number];
    if (section.kind !== "documentation") break;
    count += 1;
    const content = cleanedMarkdownText(section.content ?? "", true);
    if (content !== undefined) blocks.push(content);
  }
  const source = trimBlankLines(blocks.join("\n\n"));
  return { count, ...(source === undefined ? {} : { source }) };
}

function trailingDocumentation(contract: CanonicalContract, sectionIndex: number): string | undefined {
  return documentationRun(contract, sectionIndex + 1).source;
}

function findNextInputHeading(
  contract: CanonicalContract,
  headings: readonly MarkdownHeading[],
  sectionIndex: number,
  fromLine: number,
  issueHeadingLevel: number | undefined,
): MarkdownHeading | undefined {
  for (let index = sectionIndex + 1; index < contract.sections.length; index += 1) {
    const section = contract.sections[index] as CanonicalContract["sections"][number];
    if (section.kind !== "input") continue;
    const field = section.fields[0];
    const title = section.title ?? field?.label;
    if (title === undefined) continue;
    const level = issueHeadingLevel ?? section.render.headingLevel ?? section.nativeMetadata.headingLevel ?? 3;
    const match = headings.find(
      (heading) =>
        heading.startLine >= fromLine && heading.depth === level && heading.title.trim() === escapeHeading(title),
    );
    if (match !== undefined) return match;
  }
  return undefined;
}

function findNextRecognizedHeading(
  contract: CanonicalContract,
  headings: readonly MarkdownHeading[],
  fromLine: number,
): MarkdownHeading | undefined {
  const expected = new Map<string, number>();
  for (const section of contract.sections) {
    if (section.kind !== "input") continue;
    const field = section.fields[0];
    const title = section.title ?? field?.label;
    if (title === undefined) continue;
    const escaped = escapeHeading(title);
    expected.set(escaped, (expected.get(escaped) ?? 0) + 1);
  }
  return headings.find((heading) => {
    if (heading.startLine < fromLine || expected.get(heading.title.trim()) !== 1) return false;
    const section = contract.sections.find((candidate) => {
      if (candidate.kind !== "input") return false;
      const field = candidate.fields[0];
      const title = candidate.title ?? field?.label;
      const level = candidate.render.headingLevel ?? candidate.nativeMetadata.headingLevel ?? 3;
      return title !== undefined && escapeHeading(title) === heading.title.trim() && level === heading.depth;
    });
    return section !== undefined;
  });
}

function splitTrailingDocumentation(
  cleanedLines: readonly string[],
  startLine: number,
  endLine: number,
  expected: string | undefined,
): DocumentationSplit | undefined {
  if (expected === undefined || endLine < startLine) return undefined;
  const expectedLines = trimLineRange(expected.split("\n"));
  const candidate = Array.from({ length: Math.max(0, endLine - startLine + 1) }, (_, index) => ({
    lineNumber: startLine + index,
    text: cleanedLines[startLine + index - 1] ?? "",
  }));
  while (candidate[0] !== undefined && candidate[0].text.trim().length === 0) candidate.shift();
  while (candidate.at(-1) !== undefined && candidate.at(-1)?.text.trim().length === 0) candidate.pop();
  if (candidate.length < expectedLines.length) return undefined;
  const suffixStart = candidate.length - expectedLines.length;
  if (!expectedLines.every((line, index) => candidate[suffixStart + index]?.text === line)) return undefined;
  const firstDocumentationLine = candidate[suffixStart]?.lineNumber;
  if (firstDocumentationLine === undefined) return undefined;
  return { fieldEndLine: firstDocumentationLine - 1, documentationStartLine: firstDocumentationLine };
}

function sourceRangeSlice(structure: MarkdownStructure, startLine: number, endLine: number): string {
  return endLine < startLine ? "" : structure.sourceSlice({ startLine: Math.max(1, startLine), endLine });
}

function cleanedMarkdownText(source: string, stripComments: boolean): string | undefined {
  const normalized = normalizeSource(source);
  const structure = parseMarkdownStructure(normalized);
  const semanticSource = stripComments ? stripMarkdownHtmlComments(normalized, structure) : normalized;
  return trimBlankLines(semanticSource);
}

function hasMaterialSourceLines(lines: readonly string[], startLine: number, endLine: number): boolean {
  for (let line = Math.max(1, startLine); line <= Math.min(lines.length, endLine); line += 1) {
    if ((lines[line - 1] ?? "").trim().length > 0) return true;
  }
  return false;
}

function isCompleteHtmlComment(source: string): boolean {
  return /^\s*<!--[\s\S]*?-->\s*$/u.test(source);
}

function stripMarkdownHtmlComments(source: string, structure: MarkdownStructure): string {
  let result = normalizeSource(source);
  const lines = result.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const htmlBlocks = structure.opaqueBlocks
    .filter((block) => block.kind === "html")
    .slice()
    .sort((left, right) => right.startLine - left.startLine);
  for (const block of htmlBlocks) {
    const start = offsets[block.startLine - 1];
    const lastLine = lines[block.endLine - 1];
    if (start === undefined || lastLine === undefined) continue;
    const end = (offsets[block.endLine - 1] ?? start) + lastLine.length;
    const raw = result.slice(start, end);
    const cleaned = raw.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ""));
    result = `${result.slice(0, start)}${cleaned}${result.slice(end)}`;
  }
  return result;
}

function stripInlineMarkdownComments(value: string): string {
  const normalized = normalizeSource(value);
  return stripMarkdownHtmlComments(normalized, parseMarkdownStructure(normalized));
}

function placeholderLineNumbers(lines: readonly string[], placeholder: string | undefined): ReadonlySet<number> {
  const result = new Set<number>();
  if (placeholder === undefined) return result;
  const expected = nonEmptyLines(placeholder);
  if (expected.length === 0) return result;
  let cursor = 0;
  for (const expectedLine of expected) {
    while (cursor < lines.length && (lines[cursor] ?? "").trim().length === 0) cursor += 1;
    if (lines[cursor] !== expectedLine) return new Set<number>();
    result.add(cursor);
    cursor += 1;
  }
  return result;
}

function parseRenderedBody(
  contract: CanonicalContract,
  body: string,
  issueHeadingLevel: number | undefined,
  stripArtifactComments: boolean,
): ExistingArtifactParseResult {
  const dependencyMarker =
    contract.artifactKind === "issue" ? extractIssueDependencyMarker(body) : { status: "absent" as const, body };
  const markerFreeBody = extractTemplateIdentityMarker(dependencyMarker.body).body;
  const source = normalizeSource(markerFreeBody);
  const structure = parseMarkdownStructure(source);
  const lines = source.split("\n");
  const semanticSource = stripArtifactComments ? stripMarkdownHtmlComments(source, structure) : source;
  const semanticLines = semanticSource.split("\n");
  const values: Record<string, unknown> = {};
  const diagnostics: ExistingArtifactDiagnostic[] = [];
  const dependencies =
    contract.artifactKind === "issue" ? (dependencyMarker.dependencies ?? EMPTY_ISSUE_DEPENDENCIES) : undefined;
  if (dependencyMarker.status === "malformed" || dependencyMarker.status === "unsupported-version") {
    diagnostics.push({
      code: "EXISTING_UNPARSEABLE",
      path: "$.dependencies",
      message:
        dependencyMarker.status === "unsupported-version"
          ? "Issue dependency marker uses an unsupported version."
          : "Issue dependency marker is malformed or semantically invalid.",
    });
  }
  let cursor = 0;

  for (let sectionIndex = 0; sectionIndex < contract.sections.length; sectionIndex += 1) {
    const section = contract.sections[sectionIndex] as CanonicalContract["sections"][number];
    if (section.kind === "documentation") {
      if (issueHeadingLevel !== undefined) continue;
      const run = documentationRun(contract, sectionIndex);
      const runEndIndex = sectionIndex + run.count - 1;
      if (run.source === undefined) {
        sectionIndex = runEndIndex;
        continue;
      }
      const nextInput = findNextInputHeading(contract, structure.headings, runEndIndex, cursor + 1, issueHeadingLevel);
      const documentationEnd = (nextInput?.startLine ?? lines.length + 1) - 1;
      const actual = cleanedMarkdownText(sourceRangeSlice(structure, cursor + 1, documentationEnd), true);
      if (run.source !== actual) {
        diagnostics.push({
          code: "EXISTING_UNPARSEABLE",
          path: `$.sections.${section.id}`,
          message: "Documentation structure does not match the native template.",
        });
        return { parsed: false, values: {}, diagnostics };
      }
      cursor = (nextInput?.startLine ?? lines.length + 1) - 1;
      sectionIndex = runEndIndex;
      continue;
    }
    const expectedTitle = section.title ?? section.fields[0]?.label;
    const field = section.fields[0];
    if (expectedTitle === undefined || field === undefined) continue;
    const level = issueHeadingLevel ?? section.render.headingLevel ?? section.nativeMetadata.headingLevel;
    const expectedHeadingTitle = escapeHeading(expectedTitle);
    const headingIndex = structure.headings.findIndex((candidate) => candidate.startLine > cursor);
    const heading = headingIndex < 0 ? undefined : structure.headings[headingIndex];
    const materialBeforeHeading =
      heading === undefined || hasMaterialSourceLines(semanticLines, cursor + 1, heading.startLine - 1);
    if (
      heading === undefined ||
      heading.title.trim() !== expectedHeadingTitle ||
      heading.depth !== (level ?? 3) ||
      materialBeforeHeading
    ) {
      const hasHeading = structure.headings.length > 0;
      diagnostics.push({
        code:
          materialBeforeHeading && heading !== undefined
            ? "EXISTING_EXTRA_CONTENT"
            : hasHeading
              ? "EXISTING_WRONG_TEMPLATE"
              : "EXISTING_UNPARSEABLE",
        path: `$.sections.${section.id}`,
        message: `Expected native section heading "${"#".repeat(level ?? 3)} ${expectedHeadingTitle}".`,
      });
      return { parsed: false, values: {}, diagnostics };
    }
    const bodyStartLine = heading.endLine + 1;
    const nextInput = findNextInputHeading(
      contract,
      structure.headings,
      sectionIndex,
      heading.endLine + 1,
      issueHeadingLevel,
    );
    const bodyEndLine = (nextInput?.startLine ?? lines.length + 1) - 1;
    const documentationSplit =
      issueHeadingLevel === undefined
        ? splitTrailingDocumentation(
            semanticLines,
            bodyStartLine,
            bodyEndLine,
            trailingDocumentation(contract, sectionIndex),
          )
        : undefined;
    const fieldEndLine = documentationSplit?.fieldEndLine ?? bodyEndLine;
    const fieldSource = sourceRangeSlice(structure, bodyStartLine, fieldEndLine);
    const parsed = parseFieldLines(
      field,
      fieldSource,
      `$.${field.id}`,
      issueHeadingLevel !== undefined,
      pullRequestFieldPlaceholder(field, stripArtifactComments),
      stripArtifactComments,
    );
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value !== undefined) values[field.id] = parsed.value;
    if (parsed.diagnostics.length > 0) return { parsed: false, values: {}, diagnostics };
    cursor =
      documentationSplit?.documentationStartLine !== undefined
        ? documentationSplit.documentationStartLine - 1
        : (nextInput?.startLine ?? lines.length + 1) - 1;
  }
  if (hasMaterialSourceLines(semanticLines, cursor + 1, lines.length)) {
    diagnostics.push({
      code: "EXISTING_EXTRA_CONTENT",
      path: "$",
      message: "Artifact contains content outside the compiled template structure.",
    });
  }
  if (diagnostics.length > 0) return { parsed: false, values: {}, diagnostics };
  return {
    parsed: true,
    values,
    dependencies,
    ...(dependencyMarker.status === "valid" ? { dependencyInput: dependencyMarker.dependencies } : {}),
    diagnostics: [],
  };
}

function parseFieldLines(
  field: CanonicalField,
  source: string,
  path: string,
  issueBody: boolean,
  pullRequestPlaceholder: string | undefined,
  stripArtifactComments: boolean,
): { value: unknown; diagnostics: readonly ExistingArtifactDiagnostic[] } {
  const diagnostics: ExistingArtifactDiagnostic[] = [];
  const normalizedSource = normalizeSource(source);
  const structure = parseMarkdownStructure(normalizedSource);
  const semanticSource = stripArtifactComments
    ? stripMarkdownHtmlComments(normalizedSource, structure)
    : normalizedSource;
  const semanticLines = semanticSource.split("\n");
  const canonicalLines = canonicalizeFieldLines(field, trimLineRange(semanticLines));
  if (canonicalLines.length === 1 && canonicalLines[0]?.trim() === GITHUB_NO_RESPONSE) {
    // GitHub uses the same marker for an empty optional selection. Preserve
    // the materialized empty array so prepared artifacts remain reversible.
    return { value: field.type === "array" ? [] : undefined, diagnostics };
  }
  if (field.type === "string" || field.type === "enum") {
    const parsedValue =
      field.nativeMetadata.render === undefined
        ? trimBlankLines(unescapeMarkdownValue(canonicalLines.join("\n")))
        : parseRenderedCodeBlock(normalizedSource, structure, field.nativeMetadata.render, path, diagnostics);
    if (parsedValue === EXPLICIT_EMPTY_STRING_MARKER) return { value: "", diagnostics };
    if (
      pullRequestPlaceholder !== undefined &&
      parsedValue !== undefined &&
      parsedValue === trimBlankLines(pullRequestPlaceholder)
    )
      return { value: undefined, diagnostics };
    return { value: issueBody ? issueSemanticValue(field, parsedValue) : parsedValue, diagnostics };
  }
  if (field.type === "array") {
    if (field.nativeMetadata.multiple === true) {
      const value = trimBlankLines(unescapeMarkdownValue(canonicalLines.join("\n")));
      if (value === undefined) return { value: undefined, diagnostics };
      const values = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (values.length === 0) return { value: undefined, diagnostics };
      return { value: issueBody ? values.map((value) => issueSemanticValue(field, value)) : values, diagnostics };
    }
    const sourceLines = semanticLines;
    const listItems = structure.listItems.filter((item) => item.depth === 0 && !item.blockquoted);
    const values: string[] = [];
    const itemLines = new Set<number>();
    const placeholderLines = placeholderLineNumbers(semanticLines, pullRequestPlaceholder);
    for (const item of listItems) {
      if (item.checked !== undefined || item.startLine !== item.endLine) {
        diagnostics.push({
          code: "EXISTING_UNPARSEABLE",
          path,
          message: "Array values must be a canonical Markdown list.",
        });
        continue;
      }
      const line = sourceLines[item.startLine - 1] ?? "";
      const match = /^ {0,3}[-+*][ \t]+(.+?)\s*$/u.exec(line);
      if (match === null) {
        diagnostics.push({
          code: "EXISTING_UNPARSEABLE",
          path,
          message: "Array values must be a canonical Markdown list.",
        });
        continue;
      }
      itemLines.add(item.startLine);
      values.push(unescapeMarkdownValue(match[1] as string));
    }
    const materialLines = semanticLines.filter((line, index) => line.trim().length > 0 && !placeholderLines.has(index));
    const hasUnrecognizedContent = semanticLines.some((line, index) => {
      if (line.trim().length === 0 || placeholderLines.has(index)) return false;
      return !itemLines.has(index + 1);
    });
    if (hasUnrecognizedContent || values.length !== materialLines.length || diagnostics.length > 0) {
      if (diagnostics.length === 0) {
        diagnostics.push({
          code: "EXISTING_UNPARSEABLE",
          path,
          message: "Array values must be a canonical Markdown list.",
        });
      }
      return { value: undefined, diagnostics };
    }
    return { value: issueBody ? values.map((value) => issueSemanticValue(field, value)) : values, diagnostics };
  }
  const values: string[] = [];
  const placeholderLines = placeholderLineNumbers(semanticLines, pullRequestPlaceholder);
  const taskItems = structure.listItems.filter((item) => item.depth === 0 && !item.blockquoted);
  const itemLines = new Set<number>();
  for (const item of taskItems) {
    if (item.checked === undefined || item.startLine !== item.endLine) {
      diagnostics.push({
        code: "EXISTING_UNPARSEABLE",
        path,
        message: "Checklist values must use canonical task-list syntax.",
      });
      continue;
    }
    itemLines.add(item.startLine);
    const label = unescapeMarkdownValue(stripInlineMarkdownComments(item.label).trim());
    if (label.length === 0) {
      diagnostics.push({
        code: "EXISTING_UNPARSEABLE",
        path,
        message: "Checklist values must use canonical task-list syntax.",
      });
      continue;
    }
    const selected = field.items.find((candidate) => candidate.label === label);
    if (selected === undefined) {
      diagnostics.push({
        code: "EXISTING_UNKNOWN_CHECKLIST_ITEM",
        path,
        message: `Unknown checklist item "${label}".`,
      });
    } else if (item.checked === true) {
      values.push(selected.id);
    }
  }
  const unrecognizedContent = semanticLines.some((line, index) => {
    if (line.trim().length === 0 || placeholderLines.has(index)) return false;
    return !itemLines.has(index + 1);
  });
  if (unrecognizedContent) {
    diagnostics.push({
      code: "EXISTING_UNPARSEABLE",
      path,
      message: "Checklist values must use canonical task-list syntax.",
    });
  }
  return { value: values, diagnostics };
}

/**
 * Preserve line structure for scalar values; blank lines are presentation
 * noise only for structured collection fields.
 */
function canonicalizeFieldLines(field: CanonicalField, lines: readonly string[]): readonly string[] {
  return field.type === "array" || field.type === "checklist" ? lines.filter((line) => line.trim().length > 0) : lines;
}

function pullRequestFieldPlaceholder(field: CanonicalField, stripArtifactComments: boolean): string | undefined {
  if (!stripArtifactComments || field.nativeMetadata.placeholder === undefined) return undefined;
  const placeholder = normalizeSource(field.nativeMetadata.placeholder);
  return stripMarkdownHtmlComments(placeholder, parseMarkdownStructure(placeholder));
}

function parseRenderedCodeBlock(
  source: string,
  structure: MarkdownStructure,
  language: string,
  path: string,
  diagnostics: ExistingArtifactDiagnostic[],
): string | undefined {
  const codeBlocks = structure.opaqueBlocks.filter((block) => block.kind === "fenced-code");
  const semanticSource = stripMarkdownHtmlComments(source, structure);
  const semanticLines = semanticSource.split("\n");
  const block = codeBlocks[0];
  const hasContentOutsideCode = semanticLines.some((line, index) => {
    const lineNumber = index + 1;
    return (
      line.trim().length > 0 && (block === undefined || lineNumber < block.startLine || lineNumber > block.endLine)
    );
  });
  if (block === undefined || codeBlocks.length !== 1 || hasContentOutsideCode) {
    diagnostics.push({
      code: "EXISTING_UNPARSEABLE",
      path,
      message: `Rendered textarea values must use a fenced ${language} code block.`,
    });
    return undefined;
  }
  const lines = structure.sourceSlice(block).split("\n");
  const opening = /^(`{3,})(.*)$/u.exec(lines[0] ?? "");
  if (opening === null || opening[2] !== language || lines.length < 2) {
    diagnostics.push({
      code: "EXISTING_UNPARSEABLE",
      path,
      message: `Rendered textarea values must use a fenced ${language} code block.`,
    });
    return undefined;
  }
  const fence = opening[1];
  if (lines.at(-1) !== fence) {
    diagnostics.push({
      code: "EXISTING_UNPARSEABLE",
      path,
      message: "Rendered textarea code blocks must have a matching closing fence.",
    });
    return undefined;
  }
  const value = lines.slice(1, -1).join("\n");
  return value.length === 0 ? undefined : value;
}

function renderCodeBlock(value: string, language: string): string {
  const normalized = normalizeSource(value);
  const longestFence = Math.max(0, ...Array.from(normalized.matchAll(/`+/gu), (match) => match[0]?.length ?? 0));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${normalized}\n${fence}`;
}

function mergeIssueLabels(
  nativeLabels: readonly string[] | undefined,
  callerLabels: readonly string[] | undefined,
): readonly string[] | undefined {
  if (nativeLabels === undefined && callerLabels === undefined) return undefined;
  const labels: string[] = [];
  for (const label of [...(nativeLabels ?? []), ...(callerLabels ?? [])]) {
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function parseMetadata(input: Record<string, unknown>): ArtifactInputMetadata {
  const metadata: MutableArtifactInputMetadata = {};
  if (input.title !== undefined) metadata.title = requiredMetadataString(input.title, "title");
  for (const key of ["labels", "assignees"] as const) {
    if (input[key] !== undefined) metadata[key] = stringArray(input[key], key);
  }
  for (const key of ["head", "base"] as const) {
    if (input[key] !== undefined) metadata[key] = requiredMetadataString(input[key], key);
  }
  for (const key of ["draft", "maintainerCanModify"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean")
        throw new ArtifactInputError("INPUT_METADATA_INVALID", `${key} must be a boolean.`, `$.${key}`);
      metadata[key] = input[key];
    }
  }
  return metadata;
}

type MutableArtifactInputMetadata = {
  -readonly [Key in keyof ArtifactInputMetadata]?: ArtifactInputMetadata[Key];
};

function requiredMetadataString(value: unknown, key: string): string {
  const violation = validateRequiredMetadataString(value, key);
  if (violation !== undefined) {
    throwMetadataInputError(
      value,
      key,
      violation.message,
      value === undefined ? "missing" : "invalid",
      value === undefined ? `Provide a value for ${key}.` : `Provide a non-empty string for ${key}.`,
    );
  }
  return value as string;
}

function requiredCreateTitle(value: unknown, nativeTitle: string | undefined): string {
  const title = requiredMetadataString(value, "title");
  const nativePrefix = nativeTitle?.trim();
  if (nativePrefix !== undefined && nativePrefix.length > 0 && title.trim() === nativePrefix) {
    throwMetadataInputError(
      title,
      "title",
      "title must contain content beyond the fixed native template prefix.",
      "invalid",
      "Provide a title containing caller content beyond the fixed native template prefix.",
    );
  }
  return title;
}

function throwMetadataInputError(
  value: unknown,
  key: string,
  message: string,
  state: "missing" | "invalid",
  hint: string,
): never {
  const path = `$.${key}`;
  const diagnostic = createArtifactDiagnostic({
    state,
    code: state === "missing" ? "FIELD_MISSING" : "FIELD_INVALID",
    detailCode: state === "missing" ? "FIELD_REQUIRED" : "FIELD_CONSTRAINT_VIOLATION",
    reason: state === "missing" ? "required" : "constraint",
    path,
    message,
    ...(state === "missing" || value === undefined ? {} : { actual: createFieldEvidence(path, value) }),
    recovery: [{ action: "provide", path, hint }],
  });
  throw new ArtifactInputError("INPUT_METADATA_INVALID", message, path, {
    diagnostics: createArtifactDiagnosticReport([diagnostic]),
  });
}

function stringArray(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new ArtifactInputError("INPUT_METADATA_INVALID", `${key} must be an array of non-empty strings.`, `$.${key}`);
  }
  return [...(value as string[])];
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

/**
 * Escape only Markdown constructs that can change the compiled canonical
 * structure when a field value is spliced verbatim into a rendered body:
 *
 * - a heading line could be interpreted as a contract section heading;
 * - a fence marker could turn following Markdown into opaque code;
 * - a line matching the reserved `<!-- inari:... -->` marker prefix could be
 *   read back as the trailing template-identity/dependency marker.
 *
 * Task-list (`- [ ]`) and blockquote (`>`) prefixes are not used by any
 * section/field boundary detection in this file, so they are left as
 * intentional Markdown rather than escaped merely because they resemble a
 * construct (see #275). Checklist item labels get their own additional
 * escape in `escapeChecklistLabel` because those *are* line-delimited by a
 * task-list prefix during parsing.
 */
export function escapeMarkdownValue(value: string): string {
  return normalizeSource(value)
    .split("\n")
    .map((line) => {
      if (/^ {0,3}(?:#{1,6})(?:[ \t]+|$)/u.test(line)) return line.replace(/^( {0,3})(#)/u, "$1\\$2");
      if (/^ {0,3}(?:```|~~~)/u.test(line)) return line.replace(/^([ \t]{0,3})([`~])/u, "$1\\$2");
      if (/^ {0,3}<!--/u.test(line)) return line.replace(/^( {0,3})(<!--)/u, "$1\\$2");
      return line;
    })
    .join("\n");
}

/**
 * Checklist item labels are rendered one-per-line under a shared `- [ ] `/
 * `- [x] ` prefix, and parsing re-splits that same block back into items by
 * matching the task-list prefix on each line. An embedded, unescaped
 * task-list-look-alike line inside a label would therefore be read back as a
 * separate checklist entry, so (unlike free-form string/array fields) the
 * task-list prefix is structural here and must stay escaped.
 */
function escapeChecklistLabel(value: string): string {
  return escapeMarkdownValue(value)
    .split("\n")
    .map((line) =>
      /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\]/u.test(line)
        ? line.replace(/^( {0,3})([-+*]|\d+[.)])/u, "$1\\$2")
        : line,
    )
    .join("\n");
}

function unescapeMarkdownValue(value: string): string {
  return normalizeSource(value)
    .split("\n")
    .map((line) => line.replace(/^( {0,3})\\(#{1,6}|[-+*]|\d+[.)]|[`~]|>|<!--)/u, "$1$2"))
    .join("\n");
}

export function removeHtmlComments(value: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("<!--", cursor);
    if (start < 0) {
      result += value.slice(cursor);
      break;
    }
    result += value.slice(cursor, start);
    const end = value.indexOf("-->", start + 4);
    if (end < 0) break;
    cursor = end + 3;
  }
  return result;
}

function normalizeSource(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function trimBlankLines(value: string): string | undefined {
  const lines = value.split("\n");
  while (lines[0] !== undefined && lines[0].trim().length === 0) lines.shift();
  while (lines.at(-1) !== undefined && lines.at(-1)?.trim().length === 0) lines.pop();
  return lines.length === 0 ? undefined : lines.join("\n");
}

function trimLineRange(lines: readonly string[]): readonly string[] {
  const copy = [...lines];
  while (copy[0] !== undefined && copy[0].trim().length === 0) copy.shift();
  while (copy.at(-1) !== undefined && copy.at(-1)?.trim().length === 0) copy.pop();
  return copy;
}

function nonEmptyLines(value: string): readonly string[] {
  return normalizeSource(value)
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function semanticValidationFromLoad(loaded: CanonicalArtifactLoadResult): SemanticValidationResult {
  return { valid: loaded.valid, violations: loaded.violations, values: loaded.canonical };
}
