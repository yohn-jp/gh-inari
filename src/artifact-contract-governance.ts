/**
 * Repository Canon resolution for the Semantic Artifact pipeline.
 *
 * This module is the repository-facing Core adapter boundary. It resolves an
 * Artifact Contract Canon from the authoritative default branch and compiles
 * it through the shared Effective Artifact Contract compiler. It
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
  type EffectiveArtifactContract,
  type ArtifactContractProvenance,
} from "./contract/index.js";
import { GitHubAdapter, type RepositoryContext, type RepositoryTreeEntry } from "./github/index.js";
import { resolveRemoteArtifactContractIdentity, type RepositoryArtifactContractIdentity } from "./governance.js";
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

function parseCanonSource(source: string, path: string, kind: RepositoryEffectiveArtifactKind): ArtifactContract {
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
  try {
    const contract = parseArtifactContract(raw);
    if (contract.kind !== kind) {
      throw new ArtifactContractResolutionError(
        "ARTIFACT_CONTRACT_KIND_INVALID",
        "$.kind",
        `Artifact Contract Canon "${path}" must declare kind "${kind}".`,
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
  const contract = parseCanonSource(source, entry.path, kind);
  const provenance = sourceProvenance(context, ref, tree.sha, entry, source);
  return compileEffectiveArtifactContract(contract, { provenance, capabilities: options.capabilities });
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
