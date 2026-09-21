/**
 * Canonical Core projection for Epic/source-Issue/Implementation routing.
 *
 * The projection is deliberately transport independent. Issue references and
 * parent relationships are the authority; branch names are checked as
 * consistency evidence after the route has been selected.
 */

import { DEFAULT_BRANCH_NAME, recognizeBranchName, validateBranchName } from "./branch-naming.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";

export const INTEGRATION_ROUTING_VERSION = 1 as const;
export type IntegrationRoutingVersion = typeof INTEGRATION_ROUTING_VERSION;
export const INTEGRATION_ROUTING_PROJECTION_VERSION = INTEGRATION_ROUTING_VERSION;
export type IntegrationRoutingProjectionVersion = IntegrationRoutingVersion;
export const INTEGRATION_ROUTING_KIND = "integration-routing" as const;

export type IntegrationRoutingMode = "standalone" | "legacy" | "issue-integration";
export type IntegrationRoutingRole = "implementation" | "issue-integration" | "epic-integration";

export interface IntegrationRoutingBranches {
  readonly default: string;
  readonly implementation?: string;
  readonly issue?: string;
  readonly epic?: string;
}

export interface IntegrationRoutingRelationships {
  readonly implementationParent?: IssueReference;
  readonly sourceIssueParent?: IssueReference;
}

export interface IntegrationRoutingPullRequest {
  readonly role: IntegrationRoutingRole;
  readonly head?: string;
  readonly base: string;
}

export interface IntegrationRoutingProjection {
  readonly version: IntegrationRoutingVersion;
  readonly kind: typeof INTEGRATION_ROUTING_KIND;
  readonly mode: IntegrationRoutingMode;
  readonly role: IntegrationRoutingRole;
  readonly implementation?: IssueReference;
  readonly sourceIssue?: IssueReference;
  readonly epic?: IssueReference;
  readonly relationships: IntegrationRoutingRelationships;
  readonly branches: IntegrationRoutingBranches;
  readonly expectedHead?: string;
  readonly expectedBase: string;
  readonly head?: string;
  readonly base: string;
  readonly pullRequest: IntegrationRoutingPullRequest;
}

export type IntegrationRoutingDiagnosticCode =
  | "INTEGRATION_ROUTING_INPUT_INVALID"
  | "INTEGRATION_ROUTING_UNKNOWN_PROPERTY"
  | "INTEGRATION_ROUTING_VERSION_UNSUPPORTED"
  | "INTEGRATION_ROUTING_KIND_INVALID"
  | "INTEGRATION_ROUTING_MODE_INVALID"
  | "INTEGRATION_ROUTING_ROLE_INVALID"
  | "INTEGRATION_ROUTING_REFERENCE_INVALID"
  | "INTEGRATION_ROUTING_REFERENCE_MISMATCH"
  | "INTEGRATION_ROUTING_REPOSITORY_MISMATCH"
  | "INTEGRATION_ROUTING_RELATIONSHIP_REQUIRED"
  | "INTEGRATION_ROUTING_RELATIONSHIP_MISMATCH"
  | "INTEGRATION_ROUTING_BRANCH_INVALID"
  | "INTEGRATION_ROUTING_BRANCH_MISMATCH"
  | "INTEGRATION_ROUTING_BASE_MISMATCH"
  | "INTEGRATION_ROUTING_HEAD_MISMATCH"
  | "INTEGRATION_ROUTING_LAYER_SKIP"
  | "INTEGRATION_ROUTING_METADATA_REQUIRED"
  | "INTEGRATION_ROUTING_ROUTE_INVALID";

export interface IntegrationRoutingDiagnostic {
  readonly code: IntegrationRoutingDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface IntegrationRoutingResult {
  readonly valid: boolean;
  readonly projection?: IntegrationRoutingProjection;
  readonly diagnostics: readonly IntegrationRoutingDiagnostic[];
}

export type IntegrationRoutingProjectionResult = IntegrationRoutingResult;

export class IntegrationRoutingError extends Error {
  readonly diagnostics: readonly IntegrationRoutingDiagnostic[];

  constructor(diagnostics: readonly IntegrationRoutingDiagnostic[]) {
    super(diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
    this.name = "IntegrationRoutingError";
    this.diagnostics = diagnostics;
  }
}

type RecordValue = Record<string, unknown>;

const INPUT_KEYS = new Set([
  "version",
  "kind",
  "mode",
  "topology",
  "role",
  "prRole",
  "implementation",
  "sourceIssue",
  "source",
  "epic",
  "parentEpic",
  "relationships",
  "graph",
  "implementationParent",
  "sourceIssueParent",
  "branches",
  "metadata",
  "defaultBranch",
  "implementationBranch",
  "issueBranch",
  "epicBranch",
  "head",
  "base",
  "expectedHead",
  "expectedBase",
]);
const RELATIONSHIP_KEYS = new Set(["implementationParent", "sourceIssueParent"]);
const GRAPH_KEYS = new Set(["scope", "nodes"]);
const GRAPH_NODE_KEYS = new Set(["reference", "parent", "dependsOn"]);
const BRANCH_KEYS = new Set(["default", "implementation", "issue", "epic"]);
const METADATA_KEYS = new Set([
  "defaultBranch",
  "implementationBranch",
  "issueBranch",
  "epicBranch",
  "issueIntegration",
  "mode",
]);

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  diagnostics: IntegrationRoutingDiagnostic[],
  code: IntegrationRoutingDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function sortDiagnostics(
  diagnostics: readonly IntegrationRoutingDiagnostic[],
): readonly IntegrationRoutingDiagnostic[] {
  return Object.freeze(
    [...diagnostics].sort(
      (left, right) => left.path.localeCompare(right.path, "en-US") || left.code.localeCompare(right.code, "en-US"),
    ),
  );
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: IntegrationRoutingDiagnostic[],
): void {
  for (const key of Object.keys(value).sort())
    if (!allowed.has(key))
      diagnostic(diagnostics, "INTEGRATION_ROUTING_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not supported.");
}

function sameReference(left: IssueReference | undefined, right: IssueReference | undefined): boolean {
  return left !== undefined && right !== undefined && issueReferenceKey(left) === issueReferenceKey(right);
}

function parseReference(
  value: unknown,
  path: string,
  diagnostics: IntegrationRoutingDiagnostic[],
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    if (result.violations.length === 0)
      diagnostic(diagnostics, "INTEGRATION_ROUTING_REFERENCE_INVALID", path, "Issue reference is invalid.");
    else
      for (const violation of result.violations)
        diagnostic(diagnostics, "INTEGRATION_ROUTING_REFERENCE_INVALID", violation.path, violation.message);
    return undefined;
  }
  return result.reference;
}

function parseBranch(value: unknown, path: string, diagnostics: IntegrationRoutingDiagnostic[]): string | undefined {
  if (typeof value !== "string" || validateBranchName(value).length > 0) {
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_BRANCH_INVALID",
      path,
      "Branch does not use canonical branch grammar.",
    );
    return undefined;
  }
  return value;
}

function branchMatchesReference(
  branch: string | undefined,
  expectedType: "ordinary" | "issue" | "epic",
  reference: IssueReference | undefined,
): boolean {
  if (branch === undefined || reference === undefined) return false;
  const parts = recognizeBranchName(branch);
  if (parts === undefined || parts.issueNumber !== reference.number) return false;
  if (expectedType === "ordinary") return parts.type !== "issue" && parts.type !== "epic";
  return parts.type === expectedType;
}

function selectValue(
  root: RecordValue,
  metadata: RecordValue | undefined,
  branches: RecordValue | undefined,
  explicitKey: string,
  branchKey: string,
): unknown {
  if (root[explicitKey] !== undefined) return root[explicitKey];
  if (metadata?.[explicitKey] !== undefined) return metadata[explicitKey];
  return branches?.[branchKey];
}

function normalizeMode(value: unknown): IntegrationRoutingMode | undefined {
  if (value === undefined) return undefined;
  if (value === "standalone" || value === "legacy") return value;
  if (value === "issue" || value === "issue-integration" || value === "opted-in") return "issue-integration";
  return undefined;
}

function normalizeRole(value: unknown): IntegrationRoutingRole | undefined {
  if (value === "implementation" || value === "issue-integration" || value === "epic-integration") return value;
  if (value === "issue") return "issue-integration";
  if (value === "epic") return "epic-integration";
  return undefined;
}

function invalidResult(diagnostics: IntegrationRoutingDiagnostic[]): IntegrationRoutingResult {
  return { valid: false, diagnostics: sortDiagnostics(diagnostics) };
}

/**
 * Project one explicitly related route. `head` and `base` are optional when a
 * caller wants the expected route rather than validation of an observed PR.
 */
export function tryProjectIntegrationRouting(input: unknown): IntegrationRoutingResult {
  const diagnostics: IntegrationRoutingDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostic(diagnostics, "INTEGRATION_ROUTING_INPUT_INVALID", "$", "Routing input must be an object.");
    return invalidResult(diagnostics);
  }
  unknownProperties(input, INPUT_KEYS, "$", diagnostics);

  if (
    input.version !== undefined &&
    input.version !== INTEGRATION_ROUTING_VERSION &&
    input.version !== String(INTEGRATION_ROUTING_VERSION)
  )
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_VERSION_UNSUPPORTED",
      "$.version",
      `Only integration routing version ${INTEGRATION_ROUTING_VERSION} is supported.`,
    );
  if (input.kind !== undefined && input.kind !== INTEGRATION_ROUTING_KIND)
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_KIND_INVALID",
      "$.kind",
      `kind must be "${INTEGRATION_ROUTING_KIND}".`,
    );

  const metadata = input.metadata === undefined ? undefined : isRecord(input.metadata) ? input.metadata : undefined;
  if (input.metadata !== undefined && metadata === undefined)
    diagnostic(diagnostics, "INTEGRATION_ROUTING_INPUT_INVALID", "$.metadata", "metadata must be an object.");
  if (metadata !== undefined) unknownProperties(metadata, METADATA_KEYS, "$.metadata", diagnostics);
  if (metadata?.issueIntegration !== undefined && typeof metadata.issueIntegration !== "boolean")
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_INPUT_INVALID",
      "$.metadata.issueIntegration",
      "issueIntegration must be a boolean.",
    );
  const branches = input.branches === undefined ? undefined : isRecord(input.branches) ? input.branches : undefined;
  if (input.branches !== undefined && branches === undefined)
    diagnostic(diagnostics, "INTEGRATION_ROUTING_INPUT_INVALID", "$.branches", "branches must be an object.");
  if (branches !== undefined) unknownProperties(branches, BRANCH_KEYS, "$.branches", diagnostics);

  const implementation =
    input.implementation === undefined
      ? undefined
      : parseReference(input.implementation, "$.implementation", diagnostics);
  const sourceValue = input.sourceIssue ?? input.source;
  const sourceIssue = sourceValue === undefined ? undefined : parseReference(sourceValue, "$.sourceIssue", diagnostics);
  const epicValue = input.epic ?? input.parentEpic;
  const epic = epicValue === undefined ? undefined : parseReference(epicValue, "$.epic", diagnostics);

  const graphValue = input.graph;
  const graph = graphValue === undefined ? undefined : isRecord(graphValue) ? graphValue : undefined;
  if (graphValue !== undefined && graph === undefined)
    diagnostic(diagnostics, "INTEGRATION_ROUTING_INPUT_INVALID", "$.graph", "graph must be an object.");
  const graphParents = new Map<string, IssueReference | undefined>();
  if (graph !== undefined) {
    unknownProperties(graph, GRAPH_KEYS, "$.graph", diagnostics);
    if (graph.scope !== "complete")
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_METADATA_REQUIRED",
        "$.graph.scope",
        "A complete relationship graph is required.",
      );
    if (!Array.isArray(graph.nodes)) {
      diagnostic(diagnostics, "INTEGRATION_ROUTING_INPUT_INVALID", "$.graph.nodes", "graph.nodes must be an array.");
    } else {
      graph.nodes.forEach((node, index) => {
        if (!isRecord(node)) {
          diagnostic(
            diagnostics,
            "INTEGRATION_ROUTING_INPUT_INVALID",
            `$.graph.nodes[${index}]`,
            "Graph nodes must be objects.",
          );
          return;
        }
        unknownProperties(node, GRAPH_NODE_KEYS, `$.graph.nodes[${index}]`, diagnostics);
        const reference = parseReference(node.reference, `$.graph.nodes[${index}].reference`, diagnostics);
        if (reference === undefined) return;
        const parent =
          node.parent === undefined
            ? undefined
            : parseReference(node.parent, `$.graph.nodes[${index}].parent`, diagnostics);
        graphParents.set(issueReferenceKey(reference), parent);
      });
    }
  }

  const relationshipValue = input.relationships;
  const relationships =
    relationshipValue === undefined ? undefined : isRecord(relationshipValue) ? relationshipValue : undefined;
  if (relationshipValue !== undefined && relationships === undefined)
    diagnostic(diagnostics, "INTEGRATION_ROUTING_INPUT_INVALID", "$.relationships", "relationships must be an object.");
  if (relationships !== undefined) unknownProperties(relationships, RELATIONSHIP_KEYS, "$.relationships", diagnostics);
  const graphImplementationParent =
    implementation === undefined ? undefined : graphParents.get(issueReferenceKey(implementation));
  const graphSourceIssueParent =
    sourceIssue === undefined ? undefined : graphParents.get(issueReferenceKey(sourceIssue));
  const implementationParentValue =
    relationships?.implementationParent ?? input.implementationParent ?? graphImplementationParent;
  const sourceIssueParentValue = relationships?.sourceIssueParent ?? input.sourceIssueParent ?? graphSourceIssueParent;
  const implementationParent =
    implementationParentValue === undefined
      ? undefined
      : parseReference(implementationParentValue, "$.relationships.implementationParent", diagnostics);
  const sourceIssueParent =
    sourceIssueParentValue === undefined
      ? undefined
      : parseReference(sourceIssueParentValue, "$.relationships.sourceIssueParent", diagnostics);

  const defaultBranch = parseBranch(
    selectValue(input, metadata, branches, "defaultBranch", "default") ?? DEFAULT_BRANCH_NAME,
    "$.defaultBranch",
    diagnostics,
  );
  const implementationBranchValue = selectValue(input, metadata, branches, "implementationBranch", "implementation");
  const issueBranchValue = selectValue(input, metadata, branches, "issueBranch", "issue");
  const epicBranchValue = selectValue(input, metadata, branches, "epicBranch", "epic");
  const implementationBranch =
    implementationBranchValue === undefined
      ? undefined
      : parseBranch(implementationBranchValue, "$.implementationBranch", diagnostics);
  const issueBranch =
    issueBranchValue === undefined ? undefined : parseBranch(issueBranchValue, "$.issueBranch", diagnostics);
  const epicBranch =
    epicBranchValue === undefined ? undefined : parseBranch(epicBranchValue, "$.epicBranch", diagnostics);
  const head = input.head === undefined ? undefined : parseBranch(input.head, "$.head", diagnostics);
  const base = input.base === undefined ? undefined : parseBranch(input.base, "$.base", diagnostics);
  const declaredExpectedHead =
    input.expectedHead === undefined ? undefined : parseBranch(input.expectedHead, "$.expectedHead", diagnostics);
  const declaredExpectedBase =
    input.expectedBase === undefined ? undefined : parseBranch(input.expectedBase, "$.expectedBase", diagnostics);

  const requestedMode = normalizeMode(
    input.mode ??
      input.topology ??
      metadata?.mode ??
      (metadata?.issueIntegration === true ? "issue-integration" : undefined),
  );
  if ((input.mode !== undefined || input.topology !== undefined) && requestedMode === undefined)
    diagnostic(diagnostics, "INTEGRATION_ROUTING_MODE_INVALID", "$.mode", "Unsupported integration routing mode.");
  const mode: IntegrationRoutingMode =
    requestedMode ??
    (epic !== undefined && sourceIssue !== undefined
      ? "issue-integration"
      : epic !== undefined
        ? "legacy"
        : "standalone");
  const requestedRole = normalizeRole(input.role ?? input.prRole);
  if ((input.role !== undefined || input.prRole !== undefined) && requestedRole === undefined)
    diagnostic(diagnostics, "INTEGRATION_ROUTING_ROLE_INVALID", "$.role", "Unsupported pull-request routing role.");

  if (implementation !== undefined && sourceIssue !== undefined && sameReference(implementation, sourceIssue))
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_REFERENCE_MISMATCH",
      "$.sourceIssue",
      "Implementation cannot be its source Issue.",
    );
  if (sourceIssue !== undefined && epic !== undefined && sameReference(sourceIssue, epic))
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_REFERENCE_MISMATCH",
      "$.epic",
      "Source Issue cannot be its parent Epic.",
    );
  const references = [implementation, sourceIssue, epic].filter(
    (entry): entry is IssueReference => entry !== undefined,
  );
  if (references.length > 1) {
    const first = references[0];
    if (
      references.some(
        (entry) => entry.repositoryHost !== first.repositoryHost || entry.repositoryId !== first.repositoryId,
      )
    )
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_REPOSITORY_MISMATCH",
        "$.implementation",
        "Route references must share one repository identity.",
      );
  }

  const routeRelationships: IntegrationRoutingRelationships = {
    ...(implementationParent === undefined ? {} : { implementationParent }),
    ...(sourceIssueParent === undefined ? {} : { sourceIssueParent }),
  };
  if (mode === "standalone") {
    if (epic !== undefined || issueBranch !== undefined || sourceIssueParent !== undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_ROUTE_INVALID",
        "$.mode",
        "Standalone routing cannot carry an Issue-integration parent route.",
      );
    if (
      implementationParent !== undefined &&
      sourceIssue !== undefined &&
      !sameReference(implementationParent, sourceIssue)
    )
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_RELATIONSHIP_MISMATCH",
        "$.relationships.implementationParent",
        "Implementation parent must match source Issue.",
      );
  } else if (mode === "legacy") {
    if (epic === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_REFERENCE_INVALID",
        "$.epic",
        "Legacy routing requires a parent Epic reference.",
      );
    if (epicBranch === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_METADATA_REQUIRED",
        "$.epicBranch",
        "Legacy routing requires the canonical Epic branch metadata.",
      );
    if (implementation === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_REFERENCE_INVALID",
        "$.implementation",
        "Legacy routing requires an Implementation reference.",
      );
    if (implementationParent === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_RELATIONSHIP_REQUIRED",
        "$.relationships.implementationParent",
        "Legacy routing requires the Implementation parent relationship.",
      );
    else if (epic !== undefined && !sameReference(implementationParent, epic))
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_RELATIONSHIP_MISMATCH",
        "$.relationships.implementationParent",
        "Legacy Implementation parent must be the Epic.",
      );
    if (
      sourceIssue !== undefined &&
      implementationParent !== undefined &&
      sameReference(implementationParent, sourceIssue)
    )
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_LAYER_SKIP",
        "$.relationships.implementationParent",
        "Legacy routing cannot skip the declared Epic parent.",
      );
  } else {
    if (implementation === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_REFERENCE_INVALID",
        "$.implementation",
        "Issue integration routing requires an Implementation reference.",
      );
    if (sourceIssue === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_REFERENCE_INVALID",
        "$.sourceIssue",
        "Issue integration routing requires a source Issue reference.",
      );
    if (epic === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_REFERENCE_INVALID",
        "$.epic",
        "Issue integration routing requires a parent Epic reference.",
      );
    if (issueBranch === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_METADATA_REQUIRED",
        "$.issueBranch",
        "Issue integration routing requires the canonical Issue branch metadata.",
      );
    if (epicBranch === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_METADATA_REQUIRED",
        "$.epicBranch",
        "Issue integration routing requires the canonical Epic branch metadata.",
      );
    if (implementationParent === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_RELATIONSHIP_REQUIRED",
        "$.relationships.implementationParent",
        "Issue integration routing requires the Implementation parent relationship.",
      );
    else if (sourceIssue !== undefined && !sameReference(implementationParent, sourceIssue))
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_RELATIONSHIP_MISMATCH",
        "$.relationships.implementationParent",
        "Implementation parent must be the source Issue.",
      );
    if (sourceIssueParent === undefined)
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_RELATIONSHIP_REQUIRED",
        "$.relationships.sourceIssueParent",
        "Issue integration routing requires the source Issue parent relationship.",
      );
    else if (epic !== undefined && !sameReference(sourceIssueParent, epic))
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_RELATIONSHIP_MISMATCH",
        "$.relationships.sourceIssueParent",
        "Source Issue parent must be the Epic.",
      );
  }

  if (
    sourceIssue !== undefined &&
    issueBranch !== undefined &&
    !branchMatchesReference(issueBranch, "issue", sourceIssue)
  )
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_BRANCH_MISMATCH",
      "$.issueBranch",
      "Issue branch identity does not match the source Issue reference.",
    );
  if (epic !== undefined && epicBranch !== undefined && !branchMatchesReference(epicBranch, "epic", epic))
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_BRANCH_MISMATCH",
      "$.epicBranch",
      "Epic branch identity does not match the parent Epic reference.",
    );
  if (
    implementation !== undefined &&
    implementationBranch !== undefined &&
    !branchMatchesReference(implementationBranch, "ordinary", implementation)
  )
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_BRANCH_MISMATCH",
      "$.implementationBranch",
      "Implementation branch identity does not match the Implementation reference.",
    );

  if (diagnostics.length > 0 || defaultBranch === undefined) return invalidResult(diagnostics);

  let role: IntegrationRoutingRole;
  if (requestedRole !== undefined) role = requestedRole;
  else if (mode !== "issue-integration") role = "implementation";
  else {
    const candidateHead = head ?? implementationBranch;
    const headParts = candidateHead === undefined ? undefined : recognizeBranchName(candidateHead);
    role =
      headParts?.type === "issue"
        ? "issue-integration"
        : headParts?.type === "epic"
          ? "epic-integration"
          : "implementation";
  }

  if (mode !== "issue-integration" && role !== "implementation")
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_ROLE_INVALID",
      "$.role",
      "Standalone and legacy routes only produce Implementation PRs.",
    );
  if (mode === "issue-integration" && role === "implementation" && implementation === undefined)
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_REFERENCE_INVALID",
      "$.implementation",
      "Implementation PRs require an Implementation reference.",
    );

  let expectedHead: string | undefined;
  let expectedBase: string | undefined;
  if (role === "implementation") {
    expectedHead = implementationBranch ?? head;
    expectedBase = mode === "issue-integration" ? issueBranch : mode === "legacy" ? epicBranch : defaultBranch;
    if (
      implementation !== undefined &&
      expectedHead !== undefined &&
      !branchMatchesReference(expectedHead, "ordinary", implementation)
    )
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_HEAD_MISMATCH",
        "$.implementationBranch",
        "Implementation PR head must be an ordinary branch for the Implementation.",
      );
    if (
      mode === "issue-integration" &&
      (expectedBase === undefined || !branchMatchesReference(expectedBase, "issue", sourceIssue))
    )
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_BASE_MISMATCH",
        "$.issueBranch",
        "Implementation PR base must be the source Issue integration branch.",
      );
  } else if (role === "issue-integration") {
    if (mode !== "issue-integration")
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_ROUTE_INVALID",
        "$.role",
        "Issue integration PRs require opted-in routing.",
      );
    expectedHead = issueBranch;
    expectedBase = epicBranch;
    if (expectedHead === undefined || !branchMatchesReference(expectedHead, "issue", sourceIssue))
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_HEAD_MISMATCH",
        "$.issueBranch",
        "Issue integration PR head must match the source Issue.",
      );
    if (expectedBase === undefined || !branchMatchesReference(expectedBase, "epic", epic))
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_BASE_MISMATCH",
        "$.epicBranch",
        "Issue integration PR base must match the parent Epic.",
      );
  } else {
    if (mode !== "issue-integration")
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_ROUTE_INVALID",
        "$.role",
        "Epic integration PRs require opted-in routing.",
      );
    expectedHead = epicBranch;
    expectedBase = defaultBranch;
    if (expectedHead === undefined || !branchMatchesReference(expectedHead, "epic", epic))
      diagnostic(
        diagnostics,
        "INTEGRATION_ROUTING_HEAD_MISMATCH",
        "$.epicBranch",
        "Epic integration PR head must match the parent Epic.",
      );
  }

  if (expectedBase === undefined) {
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_BASE_MISMATCH",
      "$.base",
      "Expected PR base could not be derived from the explicit route.",
    );
  } else if (base !== undefined && base !== expectedBase) {
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_BASE_MISMATCH",
      "$.base",
      "Observed PR base does not match the canonical route.",
    );
  }
  if (declaredExpectedHead !== undefined && declaredExpectedHead !== expectedHead)
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_HEAD_MISMATCH",
      "$.expectedHead",
      "Declared expected PR head does not match the canonical route.",
    );
  if (declaredExpectedBase !== undefined && declaredExpectedBase !== expectedBase)
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_BASE_MISMATCH",
      "$.expectedBase",
      "Declared expected PR base does not match the canonical route.",
    );
  if (head !== undefined && expectedHead !== undefined && head !== expectedHead)
    diagnostic(
      diagnostics,
      "INTEGRATION_ROUTING_HEAD_MISMATCH",
      "$.head",
      "Observed PR head does not match the canonical route.",
    );

  if (diagnostics.length > 0 || expectedBase === undefined) return invalidResult(diagnostics);
  const projection: IntegrationRoutingProjection = freezeDeep({
    version: INTEGRATION_ROUTING_VERSION,
    kind: INTEGRATION_ROUTING_KIND,
    mode,
    role,
    ...(implementation === undefined ? {} : { implementation }),
    ...(sourceIssue === undefined ? {} : { sourceIssue }),
    ...(epic === undefined ? {} : { epic }),
    relationships: routeRelationships,
    branches: {
      default: defaultBranch,
      ...(implementationBranch === undefined ? {} : { implementation: implementationBranch }),
      ...(issueBranch === undefined ? {} : { issue: issueBranch }),
      ...(epicBranch === undefined ? {} : { epic: epicBranch }),
    },
    ...(expectedHead === undefined ? {} : { expectedHead }),
    expectedBase,
    ...(head === undefined ? {} : { head }),
    base: base ?? expectedBase,
    pullRequest: { role, ...(head === undefined ? {} : { head }), base: base ?? expectedBase },
  });
  return { valid: true, projection, diagnostics: [] };
}

export function projectIntegrationRouting(input: unknown): IntegrationRoutingProjection {
  const result = tryProjectIntegrationRouting(input);
  if (!result.valid || result.projection === undefined) throw new IntegrationRoutingError(result.diagnostics);
  return result.projection;
}

/** Compatibility names for callers that describe this as a route projector. */
export const tryProjectIntegrationRoute = tryProjectIntegrationRouting;
export const projectIntegrationRoute = projectIntegrationRouting;
export const tryProjectIntegrationRoutingProjection = tryProjectIntegrationRouting;
export const projectIntegrationRoutingProjection = projectIntegrationRouting;
export const validateIntegrationRouting = tryProjectIntegrationRouting;
export const validateIntegrationRoute = tryProjectIntegrationRouting;
