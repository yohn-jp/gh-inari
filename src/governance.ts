import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  compileIssueFormTemplate,
  compileIssueFormYaml,
  type IssueFormTemplateIdentity,
} from "./contract/issue-form.js";
import {
  assertCanonicalContract,
  type CanonicalContract,
  type ContractProvenance,
  type ContractProvenanceSource,
} from "./contract/ir.js";
import { GitHubAdapter, type RepositoryContext, type RepositoryTreeEntry } from "./github/index.js";
import { compilePullRequestPolicyFile, compilePullRequestPolicyOverlay } from "./pr-policy.js";
import { compilePullRequestTemplate, parsePullRequestTemplate } from "./pull-request-template.js";
import {
  discoverTemplates,
  selectIssueTemplate,
  selectPullRequestTemplate,
  discoverTemplatesFromPaths,
  classifyTemplatePath,
  isTemplateContainerPath,
  isTemplatePathInNativeDirectory,
  type TemplateDiscoveryResult,
  type TemplateSelector,
} from "./template-discovery.js";

export type GovernedArtifactDomain = "issue" | "pr";

export type GovernanceErrorCode =
  "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN" | "GOVERNANCE_SOURCE_UNAVAILABLE" | "GOVERNANCE_SOURCE_INVALID";

export interface GovernanceErrorDetails {
  readonly operation?: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly reason?: string;
  readonly [key: string]: string | undefined;
}

/** Stable, machine-readable failures for repository governance acquisition. */
export class GovernanceError extends Error {
  readonly code: GovernanceErrorCode;
  readonly details: Readonly<GovernanceErrorDetails>;

  constructor(
    code: GovernanceErrorCode,
    message: string,
    details: GovernanceErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GovernanceError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: GovernanceErrorCode; message: string; details: Readonly<GovernanceErrorDetails> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Arbitrary local policy files are never accepted by governed remote operations. */
export function rejectGovernedPolicyOverride(policyPath: string | boolean | undefined): void {
  if (typeof policyPath !== "string") return;
  throw new GovernanceError(
    "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN",
    "Governed remote operations cannot use an arbitrary --policy file; policy must come from the target repository.",
    { path: policyPath, reason: "external policy override" },
  );
}

/**
 * Compile governance from a checked-out repository source.
 *
 * This is the local counterpart to compileRepositoryGovernedContract. CLI
 * local schema/validate/render commands and repository workflows both call
 * this function so template, policy, and contract semantics remain owned by
 * the product compiler rather than by handwritten workflow scripts.
 */
export async function compileLocalGovernedContract(
  domain: GovernedArtifactDomain,
  root: string,
  selector?: string | TemplateSelector,
  policyPath?: string | boolean,
): Promise<CanonicalContract> {
  const discovery = await discoverTemplates(root);
  let contract: CanonicalContract;
  if (domain === "issue") {
    contract = await compileIssueFormTemplate(discovery, selector);
  } else {
    contract = await compilePullRequestTemplate(root, selector);
  }
  if (domain !== "pr") return contract;

  const selectedPolicy = await resolveLocalPolicyPath(root, policyPath);
  if (selectedPolicy === undefined) return contract;
  return compilePullRequestPolicyFile(contract, selectedPolicy, {
    templateIdentities: discovery.pullRequestTemplates,
  });
}

/** Compile every repository-native Issue Form with the shared compiler. */
export async function compileLocalIssueFormContracts(root: string): Promise<readonly CanonicalContract[]> {
  const discovery = await discoverTemplates(root);
  return Promise.all(discovery.issueTemplates.map((template) => compileIssueFormTemplate(discovery, template.id)));
}

async function resolveLocalPolicyPath(
  root: string,
  policyPath: string | boolean | undefined,
): Promise<string | undefined> {
  if (typeof policyPath === "string") return path.resolve(root, policyPath);
  const candidates = [path.join(root, ".github", "inari", "pr-policy.yml"), path.join(root, ".inari", "pr-policy.yml")];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next repository-native policy location.
    }
  }
  return undefined;
}

/**
 * Resolve and compile governance from the target repository's default branch.
 * No local repository files are consulted by this path.
 */
export async function compileRepositoryGovernedContract(
  adapter: GitHubAdapter,
  domain: GovernedArtifactDomain,
  selector?: string | TemplateSelector,
): Promise<CanonicalContract> {
  const source = await readRepositoryGovernanceSource(adapter);
  const { context, ref, tree, discovery } = source;
  const selectedTemplate =
    domain === "issue" ? selectIssueTemplate(discovery, selector) : selectPullRequestTemplate(discovery, selector);
  const templateEntry = findBlob(tree, selectedTemplate.path, context, ref);
  const templateSource = await readGovernedValue("repository.governance.blob", context, ref, () =>
    adapter.getRepositoryBlob(templateEntry.sha),
  );

  let contract: CanonicalContract;
  if (domain === "issue") {
    contract = compileIssueFormYaml(templateSource, selectedTemplate as IssueFormTemplateIdentity);
  } else {
    contract = parsePullRequestTemplate(templateSource, selectedTemplate);
  }

  const policyEntry = domain === "pr" ? findPolicy(tree) : undefined;
  let policySource: ContractProvenanceSource | undefined;
  if (policyEntry !== undefined) {
    if (policyEntry.type !== "blob") throw invalidSource(context, policyEntry.path, "policy path is not a file");
    const source = await readGovernedValue("repository.governance.blob", context, ref, () =>
      adapter.getRepositoryBlob(policyEntry.sha),
    );
    contract = compilePullRequestPolicyOverlay(contract, source, {
      templateIdentities: discovery.pullRequestTemplates,
    });
    policySource = sourceIdentity(policyEntry, ref, source);
  }

  const bound: CanonicalContract = {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: {
        host: context.hostname,
        owner: context.owner,
        name: context.name,
        nameWithOwner: context.nameWithOwner,
      },
      ref,
      template: sourceIdentity(templateEntry, ref, templateSource),
      ...(policySource === undefined ? {} : { policy: policySource }),
    },
  };
  assertCanonicalContract(bound);
  return bound;
}

/** Discover all authoritative templates without compiling or reading a body. */
export async function discoverRepositoryTemplates(adapter: GitHubAdapter): Promise<TemplateDiscoveryResult> {
  return (await readRepositoryGovernanceSource(adapter)).discovery;
}

interface RepositoryGovernanceSource {
  readonly context: RepositoryContext;
  readonly ref: string;
  readonly tree: readonly RepositoryTreeEntry[];
  readonly discovery: TemplateDiscoveryResult;
}

async function readRepositoryGovernanceSource(adapter: GitHubAdapter): Promise<RepositoryGovernanceSource> {
  const context = await adapter.resolveRepositoryContext();
  const ref = await readGovernedValue("repository.default_branch", context, undefined, () =>
    adapter.getRepositoryDefaultBranch(),
  );
  const tree = await readGovernedValue("repository.governance.tree", context, ref, () =>
    adapter.getRepositoryTree(ref),
  );
  return { context, ref, tree, discovery: createRemoteDiscovery(context, tree) };
}

function createRemoteDiscovery(
  context: RepositoryContext,
  tree: readonly RepositoryTreeEntry[],
): TemplateDiscoveryResult {
  for (const entry of tree) {
    const isContainer = isTemplateContainerPath(entry.path);
    if (entry.type === "tree") {
      if (isContainer) continue;
      let classified: string | undefined;
      try {
        classified = classifyTemplatePath(entry.path);
      } catch (error: unknown) {
        throw invalidSource(context, entry.path, error instanceof Error ? error.message : "invalid template path");
      }
      if (isTemplatePathInNativeDirectory(entry.path) || classified !== undefined) {
        throw invalidSource(context, entry.path, "template path is not a regular file");
      }
      continue;
    }
    if (isContainer) throw invalidSource(context, entry.path, "template path is not a regular file");
    try {
      classifyTemplatePath(entry.path);
    } catch (error: unknown) {
      throw invalidSource(context, entry.path, error instanceof Error ? error.message : "invalid template path");
    }
  }
  try {
    return discoverTemplatesFromPaths(
      tree.filter((entry) => entry.type === "blob").map((entry) => entry.path),
      context.url,
    );
  } catch (error: unknown) {
    throw invalidSource(context, "<template tree>", error instanceof Error ? error.message : "invalid template path");
  }
}

function findBlob(
  tree: readonly RepositoryTreeEntry[],
  filePath: string,
  context: RepositoryContext,
  ref: string,
): RepositoryTreeEntry {
  const entry = tree.find((candidate) => candidate.path === filePath);
  if (entry === undefined || entry.type !== "blob") {
    throw new GovernanceError(
      "GOVERNANCE_SOURCE_INVALID",
      `Trusted governance source "${filePath}" was not a regular file at ref "${ref}".`,
      { repository: context.nameWithOwner, ref, path: filePath, reason: "missing or non-file source" },
    );
  }
  return entry;
}

function findPolicy(tree: readonly RepositoryTreeEntry[]): RepositoryTreeEntry | undefined {
  const preferred = tree.find((entry) => entry.path === ".github/inari/pr-policy.yml");
  if (preferred !== undefined) return preferred;
  return tree.find((entry) => entry.path === ".inari/pr-policy.yml");
}

function sourceIdentity(entry: RepositoryTreeEntry, ref: string, content: string): ContractProvenanceSource {
  return {
    path: entry.path,
    ref,
    sha: entry.sha,
    digest: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function invalidSource(context: RepositoryContext, path: string, reason: string): GovernanceError {
  return new GovernanceError(
    "GOVERNANCE_SOURCE_INVALID",
    `Repository governance source at "${path}" is invalid: ${reason}.`,
    { repository: context.nameWithOwner, path, reason },
  );
}

async function readGovernedValue<T>(
  operation: string,
  context: RepositoryContext,
  ref: string | undefined,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof GovernanceError) throw error;
    throw new GovernanceError(
      error instanceof Error && error.name === "GitHubApiResponseError"
        ? "GOVERNANCE_SOURCE_INVALID"
        : "GOVERNANCE_SOURCE_UNAVAILABLE",
      `Unable to establish trusted repository governance during ${operation}.`,
      {
        operation,
        repository: context.nameWithOwner,
        ...(ref === undefined ? {} : { ref }),
        reason: error instanceof Error ? error.message : "remote source read failed",
      },
      { cause: error },
    );
  }
}
