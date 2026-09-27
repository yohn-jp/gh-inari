/**
 * Repository Canon resolution for the Semantic Artifact pipeline.
 *
 * This module is the repository-facing Core adapter boundary. It resolves an
 * Artifact Contract Canon or numeric-v1 semantic-template source from the
 * authoritative default branch and compiles it through the shared Effective
 * Artifact Contract compiler. Numeric-v1 sources use the existing compatibility
 * producer and require their committed native projection to match. It
 * does not select semantic values, derive identities, or project GitHub
 * representations, and it does not define its own Canon location or
 * selector policy: discovery and template-resolution precedence are
 * delegated to the same repository governance authority every other
 * governed artifact uses (`governance.ts`, `template-resolver.ts`).
 */

import { createHash } from "node:crypto";
import {
  ArtifactContractValidationError,
  parseArtifactContract,
  type ArtifactContract,
  compileEffectiveArtifactContract,
  EffectiveArtifactContractCompilationError,
  type EffectiveArtifactContract,
  type ArtifactContractProvenance,
} from "./contract/index.js";
import { GitHubAdapter, type RepositoryContext, type RepositoryTreeEntry } from "./github/index.js";
import {
  compileSemanticTemplateArtifactContract,
  parseSemanticTemplate,
  renderSemanticNative,
  SemanticTemplateError,
  type SemanticTemplateSource,
} from "./semantic-template.js";
import {
  createRemoteArtifactContractIdentities,
  resolveRemoteArtifactContractIdentity,
  type RepositoryArtifactContractIdentity,
} from "./governance.js";
import {
  parseTemplateResolutionConfig,
  TEMPLATE_RESOLUTION_CONFIG_PATH,
  TemplateResolutionError,
} from "./template-resolver.js";
import type { TemplateSelector } from "./template-discovery.js";

export type RepositoryEffectiveArtifactKind = "issue" | "branch" | "pull_request";

export type ArtifactContractResolutionErrorCode =
  | "ARTIFACT_CONTRACT_NOT_FOUND"
  | "ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS"
  | "ARTIFACT_CONTRACT_SOURCE_INVALID"
  | "ARTIFACT_CONTRACT_KIND_INVALID";

export interface ArtifactContractResolutionDiagnostic {
  readonly code: ArtifactContractResolutionErrorCode;
  readonly path: string;
  readonly message: string;
}

/** Stable machine-readable failure for repository Canon resolution. */
export class ArtifactContractResolutionError extends Error {
  readonly code: ArtifactContractResolutionErrorCode;
  readonly path: string;
  readonly diagnostics: readonly unknown[];
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ArtifactContractResolutionErrorCode,
    path: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    diagnostics: readonly unknown[] = [{ code, path, message }],
  ) {
    super(message);
    this.name = "ArtifactContractResolutionError";
    this.code = code;
    this.path = path;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.details = details;
  }
}

export interface RepositoryEffectiveArtifactContractOptions {
  readonly capabilities?: readonly string[];
}

export type EffectiveArtifactContractOutcome =
  | {
      readonly status: "compiled";
      readonly identity: RepositoryArtifactContractIdentity;
      readonly contract: EffectiveArtifactContract;
    }
  | {
      readonly status: "failed";
      readonly identity: RepositoryArtifactContractIdentity;
      readonly message: string;
      readonly failureCode?: string;
    };

type RepositoryContractSource = ArtifactContract | SemanticTemplateSource;
const MAX_ARTIFACT_CONTRACT_DIAGNOSTICS = 8;

/**
 * Resolve the authoritative Artifact Contract Canon identity using the same
 * repository governance discovery and template-resolution precedence as every
 * other governed artifact. This module does not read arbitrary repository
 * files.
 */
async function selectCanonIdentity(
  tree: readonly RepositoryTreeEntry[],
  kind: RepositoryEffectiveArtifactKind,
  selector: string | TemplateSelector | undefined,
  configuredDefault: string | TemplateSelector | undefined,
  context: RepositoryContext,
  ref: string,
): Promise<RepositoryArtifactContractIdentity> {
  try {
    return await resolveRemoteArtifactContractIdentity(tree, kind, selector, configuredDefault);
  } catch (error: unknown) {
    if (!(error instanceof TemplateResolutionError)) throw error;
    throw artifactContractResolutionErrorFromTemplateResolution(error, context, ref);
  }
}

async function readConfiguredDefault(
  adapter: GitHubAdapter,
  tree: readonly RepositoryTreeEntry[],
  kind: RepositoryEffectiveArtifactKind,
): Promise<string | TemplateSelector | undefined> {
  if (kind === "branch") return undefined;
  const entry = tree.find((candidate) => candidate.path === TEMPLATE_RESOLUTION_CONFIG_PATH);
  if (entry === undefined) return undefined;
  if (entry.type !== "blob") {
    throw new ArtifactContractResolutionError(
      "ARTIFACT_CONTRACT_SOURCE_INVALID",
      entry.path,
      `Template resolution config "${entry.path}" is not a regular file.`,
    );
  }
  const source = await adapter.getRepositoryBlob(entry.sha);
  try {
    const config = parseTemplateResolutionConfig(source, entry.path);
    return config.defaults[kind === "pull_request" ? "pr" : "issue"];
  } catch (error: unknown) {
    if (error instanceof TemplateResolutionError) {
      throw new ArtifactContractResolutionError(
        "ARTIFACT_CONTRACT_SOURCE_INVALID",
        entry.path,
        error.message,
        { reason: error.details.reason, path: entry.path },
        [error.toJSON()],
      );
    }
    throw error;
  }
}

function artifactContractResolutionErrorFromTemplateResolution(
  error: TemplateResolutionError,
  context: RepositoryContext,
  ref: string,
): ArtifactContractResolutionError {
  const details = { repository: context.nameWithOwner, ref, ...error.details };
  switch (error.code) {
    case "TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS":
    case "TEMPLATE_RESOLUTION_DEFAULT_AMBIGUOUS":
    case "TEMPLATE_RESOLUTION_AMBIGUOUS":
      return new ArtifactContractResolutionError(
        "ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS",
        "$.selector",
        error.message,
        details,
      );
    default:
      return new ArtifactContractResolutionError("ARTIFACT_CONTRACT_NOT_FOUND", "$.selector", error.message, details);
  }
}

function findCanonEntry(
  tree: readonly RepositoryTreeEntry[],
  identity: RepositoryArtifactContractIdentity,
  context: RepositoryContext,
  ref: string,
): RepositoryTreeEntry {
  const entry = tree.find((candidate) => candidate.path === identity.sourcePath && candidate.type === "blob");
  if (entry === undefined) {
    throw new ArtifactContractResolutionError(
      "ARTIFACT_CONTRACT_NOT_FOUND",
      "$.source",
      `Artifact Contract Canon "${identity.sourcePath}" was not found for ${context.nameWithOwner} at ref "${ref}".`,
      { repository: context.nameWithOwner, ref, path: identity.sourcePath },
    );
  }
  return entry;
}

function sourceProvenance(
  context: RepositoryContext,
  ref: string,
  treeSha: string,
  entry: RepositoryTreeEntry,
  source: string,
): ArtifactContractProvenance {
  return {
    authority: "repository-default-branch",
    repository: {
      host: context.hostname,
      owner: context.owner,
      name: context.name,
      nameWithOwner: context.nameWithOwner,
      ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
    },
    ref,
    treeSha,
    source: {
      path: entry.path,
      ref,
      sha: entry.sha,
      digest: createHash("sha256").update(source, "utf8").digest("hex"),
    },
  };
}

function parseCanonSource(
  source: string,
  path: string,
  identity: RepositoryArtifactContractIdentity,
): RepositoryContractSource {
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new ArtifactContractResolutionError(
      "ARTIFACT_CONTRACT_SOURCE_INVALID",
      path,
      `Artifact Contract Canon "${path}" is not valid JSON.`,
      { reason: error instanceof Error ? error.message : "invalid JSON" },
    );
  }

  if (identity.kind !== "branch" && isRecord(raw) && raw.version === 1) {
    let semantic: SemanticTemplateSource;
    try {
      semantic = parseSemanticTemplate(source, path);
    } catch (error: unknown) {
      if (error instanceof SemanticTemplateError) {
        throw semanticTemplateResolutionError(path, error);
      }
      throw new ArtifactContractResolutionError(
        "ARTIFACT_CONTRACT_SOURCE_INVALID",
        path,
        `Artifact Contract Canon "${path}" failed semantic-template v1 validation.`,
        { reason: error instanceof Error ? error.message : "invalid semantic template" },
      );
    }
    if (semantic.kind !== identity.kind) {
      throw new ArtifactContractResolutionError(
        "ARTIFACT_CONTRACT_KIND_INVALID",
        "$.kind",
        `Artifact Contract Canon "${path}" must declare kind "${identity.kind}".`,
        { kind: semantic.kind },
      );
    }
    return semantic;
  }

  try {
    const contract = parseArtifactContract(raw);
    if (contract.kind !== identity.kind) {
      throw new ArtifactContractResolutionError(
        "ARTIFACT_CONTRACT_KIND_INVALID",
        "$.kind",
        `Artifact Contract Canon "${path}" must declare kind "${identity.kind}".`,
        { kind: contract.kind },
      );
    }
    return contract;
  } catch (error: unknown) {
    if (error instanceof ArtifactContractResolutionError) throw error;
    if (error instanceof ArtifactContractValidationError) {
      throw new ArtifactContractResolutionError(
        "ARTIFACT_CONTRACT_SOURCE_INVALID",
        path,
        `Artifact Contract Canon "${path}" failed Core validation.`,
        { violations: error.violations },
        error.violations,
      );
    }
    throw new ArtifactContractResolutionError(
      "ARTIFACT_CONTRACT_SOURCE_INVALID",
      path,
      `Artifact Contract Canon "${path}" failed Core validation.`,
      { reason: error instanceof Error ? error.message : "invalid contract" },
    );
  }
}

function semanticTemplateResolutionError(path: string, error: SemanticTemplateError): ArtifactContractResolutionError {
  const violations = error.violations.slice(0, MAX_ARTIFACT_CONTRACT_DIAGNOSTICS);
  return new ArtifactContractResolutionError(
    "ARTIFACT_CONTRACT_SOURCE_INVALID",
    path,
    `Artifact Contract Canon "${path}" failed semantic-template v1 validation.`,
    { violationCount: error.violations.length, violations },
    violations.map((violation) => ({
      code: "ARTIFACT_CONTRACT_SOURCE_INVALID",
      path: violation.path,
      message: violation.message,
    })),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSemanticTemplateSource(source: RepositoryContractSource): source is SemanticTemplateSource {
  return typeof source.version === "number";
}

async function verifySemanticNativeProjection(
  adapter: GitHubAdapter,
  tree: readonly RepositoryTreeEntry[],
  identity: RepositoryArtifactContractIdentity,
  source: SemanticTemplateSource,
): Promise<void> {
  const entry = tree.find((candidate) => candidate.path === identity.generatedPath);
  if (entry === undefined) {
    throw new ArtifactContractResolutionError(
      "ARTIFACT_CONTRACT_SOURCE_INVALID",
      identity.generatedPath,
      `Generated native projection "${identity.generatedPath}" was not found in the trusted repository tree.`,
      { sourcePath: identity.sourcePath, generatedPath: identity.generatedPath },
    );
  }
  if (entry.type !== "blob") {
    throw new ArtifactContractResolutionError(
      "ARTIFACT_CONTRACT_SOURCE_INVALID",
      identity.generatedPath,
      `Generated native projection "${identity.generatedPath}" is not a regular file.`,
      { sourcePath: identity.sourcePath, generatedPath: identity.generatedPath },
    );
  }

  let expected: string;
  try {
    expected = renderSemanticNative(source, identity.generatedPath);
  } catch (error: unknown) {
    throw new ArtifactContractResolutionError(
      "ARTIFACT_CONTRACT_SOURCE_INVALID",
      identity.sourcePath,
      `Semantic-template v1 source "${identity.sourcePath}" cannot produce its native projection.`,
      { reason: error instanceof Error ? error.message : "invalid semantic template" },
    );
  }

  const actual = await adapter.getRepositoryBlob(entry.sha);
  if (actual !== expected) {
    throw new ArtifactContractResolutionError(
      "ARTIFACT_CONTRACT_SOURCE_INVALID",
      identity.generatedPath,
      `Generated native projection "${identity.generatedPath}" does not match the semantic source at the trusted ref.`,
      { sourcePath: identity.sourcePath, generatedPath: identity.generatedPath },
    );
  }
}

async function compileRepositorySource(
  adapter: GitHubAdapter,
  tree: readonly RepositoryTreeEntry[],
  identity: RepositoryArtifactContractIdentity,
  context: RepositoryContext,
  ref: string,
  treeSha: string,
  entry: RepositoryTreeEntry,
  source: string,
  options: RepositoryEffectiveArtifactContractOptions,
): Promise<EffectiveArtifactContract> {
  const parsed = parseCanonSource(source, entry.path, identity);
  const provenance = sourceProvenance(context, ref, treeSha, entry, source);
  if (!isSemanticTemplateSource(parsed)) {
    return compileEffectiveArtifactContract(parsed, { provenance, capabilities: options.capabilities });
  }

  await verifySemanticNativeProjection(adapter, tree, identity, parsed);
  try {
    const contract = compileSemanticTemplateArtifactContract(parsed);
    return compileEffectiveArtifactContract(contract, { provenance, capabilities: options.capabilities });
  } catch (error: unknown) {
    if (error instanceof SemanticTemplateError) {
      throw semanticTemplateResolutionError(entry.path, error);
    }
    if (error instanceof ArtifactContractValidationError) {
      throw new ArtifactContractResolutionError(
        "ARTIFACT_CONTRACT_SOURCE_INVALID",
        entry.path,
        `Artifact Contract Canon "${entry.path}" failed Core validation.`,
        { violations: error.violations.slice(0, MAX_ARTIFACT_CONTRACT_DIAGNOSTICS) },
        error.violations.slice(0, MAX_ARTIFACT_CONTRACT_DIAGNOSTICS),
      );
    }
    throw error;
  }
}

/**
 * Resolve the authoritative Artifact Contract Canon and compile its Effective
 * Artifact Contract. All repository identity and generation fields come from
 * the adapter's default-branch/tree/blob reads.
 */
export async function compileRepositoryEffectiveArtifactContract(
  adapter: GitHubAdapter,
  kind: RepositoryEffectiveArtifactKind,
  selector?: string | TemplateSelector,
  options: RepositoryEffectiveArtifactContractOptions = {},
): Promise<EffectiveArtifactContract> {
  const context = await adapter.resolveRepositoryContext();
  const ref = await adapter.getRepositoryDefaultBranch();
  const tree = await adapter.getRepositoryTree(ref);
  const configuredDefault =
    selector === undefined ? await readConfiguredDefault(adapter, tree.entries, kind) : undefined;
  const identity = await selectCanonIdentity(tree.entries, kind, selector, configuredDefault, context, ref);
  const entry = findCanonEntry(tree.entries, identity, context, ref);
  const source = await adapter.getRepositoryBlob(entry.sha);
  return compileRepositorySource(adapter, tree.entries, identity, context, ref, tree.sha, entry, source, options);
}

/**
 * Compile every repository-owned Artifact Contract Canon for read-only
 * discovery after an unselected, non-interactive ambiguity. Mutating and
 * materialization commands continue to use the single-contract resolver.
 */
export async function compileRepositoryEffectiveArtifactContracts(
  adapter: GitHubAdapter,
  kind: RepositoryEffectiveArtifactKind,
  options: RepositoryEffectiveArtifactContractOptions = {},
): Promise<readonly EffectiveArtifactContractOutcome[]> {
  const context = await adapter.resolveRepositoryContext();
  const ref = await adapter.getRepositoryDefaultBranch();
  const tree = await adapter.getRepositoryTree(ref);
  const identities = createRemoteArtifactContractIdentities(tree.entries).filter((identity) => identity.kind === kind);
  const outcomes: EffectiveArtifactContractOutcome[] = [];
  for (const identity of identities) {
    try {
      const entry = findCanonEntry(tree.entries, identity, context, ref);
      const source = await adapter.getRepositoryBlob(entry.sha);
      outcomes.push({
        status: "compiled",
        identity,
        contract: await compileRepositorySource(
          adapter,
          tree.entries,
          identity,
          context,
          ref,
          tree.sha,
          entry,
          source,
          options,
        ),
      });
    } catch (error: unknown) {
      if (
        !(error instanceof ArtifactContractResolutionError) &&
        !(error instanceof ArtifactContractValidationError) &&
        !(error instanceof EffectiveArtifactContractCompilationError)
      )
        throw error;
      outcomes.push({
        status: "failed",
        identity,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ArtifactContractResolutionError ? { failureCode: error.code } : {}),
      });
    }
  }
  return outcomes;
}

/** Resolve and compile a pull-request Artifact Contract from the repository Canon. */
export async function compileRepositoryEffectivePullRequestContract(
  adapter: GitHubAdapter,
  selector?: string | TemplateSelector,
  options: RepositoryEffectiveArtifactContractOptions = {},
): Promise<EffectiveArtifactContract> {
  return compileRepositoryEffectiveArtifactContract(adapter, "pull_request", selector, options);
}

/** Resolve and compile an Issue Artifact Contract from the repository Canon. */
export async function compileRepositoryEffectiveIssueContract(
  adapter: GitHubAdapter,
  selector?: string | TemplateSelector,
  options: RepositoryEffectiveArtifactContractOptions = {},
): Promise<EffectiveArtifactContract> {
  return compileRepositoryEffectiveArtifactContract(adapter, "issue", selector, options);
}

/** Resolve and compile a Branch Artifact Contract from the repository Canon. */
export async function compileRepositoryEffectiveBranchContract(
  adapter: GitHubAdapter,
  selector?: string | TemplateSelector,
  options: RepositoryEffectiveArtifactContractOptions = {},
): Promise<EffectiveArtifactContract> {
  return compileRepositoryEffectiveArtifactContract(adapter, "branch", selector, options);
}
