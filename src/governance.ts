import { createHash } from "node:crypto";
import { compileIssueFormYaml, type IssueFormTemplateIdentity } from "./contract/issue-form.js";
import {
  assertCanonicalContract,
  type CanonicalContract,
  type ContractProvenance,
  type ContractProvenanceSource,
} from "./contract/ir.js";
import { GitHubAdapter, type RepositoryContext, type RepositoryTreeEntry } from "./github/index.js";
import { compilePullRequestPolicyOverlay } from "./pr-policy.js";
import { parsePullRequestTemplate } from "./pull-request-template.js";
import {
  selectIssueTemplate,
  selectPullRequestTemplate,
  type TemplateDiscoveryResult,
  type TemplateIdentity,
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
 * Resolve and compile governance from the target repository's default branch.
 * No local repository files are consulted by this path.
 */
export async function compileRepositoryGovernedContract(
  adapter: GitHubAdapter,
  domain: GovernedArtifactDomain,
  selector?: string | TemplateSelector,
): Promise<CanonicalContract> {
  const context = await adapter.resolveRepositoryContext();
  const ref = await readGovernedValue("repository.default_branch", context, undefined, () =>
    adapter.getRepositoryDefaultBranch(),
  );
  const tree = await readGovernedValue("repository.governance.tree", context, ref, () =>
    adapter.getRepositoryTree(ref),
  );
  const discovery = createRemoteDiscovery(context, tree);
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
    contract = compilePullRequestPolicyOverlay(contract, source);
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

function createRemoteDiscovery(
  context: RepositoryContext,
  tree: readonly RepositoryTreeEntry[],
): TemplateDiscoveryResult {
  const issueTemplates = directFiles(tree, ".github/ISSUE_TEMPLATE", context).flatMap((entry) => {
    const extension = extensionOf(entry.path);
    const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1).toLowerCase();
    if (fileName === "config.yml" || fileName === "config.yaml") return [];
    if (extension !== ".md" && extension !== ".yml" && extension !== ".yaml") return [];
    return [createIdentity(entry.path, extension === ".md" ? "issue-markdown" : "issue-form", "issue")];
  });
  const pullRequestTemplates: TemplateIdentity[] = [];
  const defaultPath = ".github/PULL_REQUEST_TEMPLATE.md";
  const defaultEntry = tree.find((entry) => entry.path === defaultPath);
  if (defaultEntry !== undefined) {
    if (defaultEntry.type !== "blob") throw invalidSource(context, defaultPath, "template path is not a file");
    pullRequestTemplates.push(createIdentity(defaultPath, "pull-request-default", "pull-request"));
  }
  pullRequestTemplates.push(
    ...directFiles(tree, ".github/PULL_REQUEST_TEMPLATE", context)
      .filter((entry) => extensionOf(entry.path) === ".md")
      .map((entry) => createIdentity(entry.path, "pull-request", "pull-request")),
  );
  const templates = [...issueTemplates, ...pullRequestTemplates].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  return {
    repositoryRoot: context.url,
    templates,
    issueTemplates: issueTemplates.sort((left, right) => compareStrings(left.id, right.id)),
    pullRequestTemplates: pullRequestTemplates.sort((left, right) => compareStrings(left.id, right.id)),
  };
}

function directFiles(
  tree: readonly RepositoryTreeEntry[],
  directory: string,
  context: RepositoryContext,
): readonly RepositoryTreeEntry[] {
  const prefix = `${directory}/`;
  const entries = tree.filter((entry) => entry.path.startsWith(prefix));
  for (const entry of entries) {
    const relative = entry.path.slice(prefix.length);
    if (relative.includes("/"))
      throw invalidSource(context, entry.path, "nested governance directories are unsupported");
    if (entry.type !== "blob") throw invalidSource(context, entry.path, "governance template path is not a file");
  }
  return entries;
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

function createIdentity(
  path: string,
  type: TemplateIdentity["type"],
  kind: TemplateIdentity["kind"],
): TemplateIdentity {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const extension = extensionOf(path);
  const name = type === "pull-request-default" ? "default" : fileName.slice(0, -extension.length);
  if (name.trim().length === 0) throw new Error(`Governance template path has no selectable name: ${path}.`);
  return {
    id: `${type}:${path}`,
    type,
    kind,
    name,
    path,
  };
}

function sourceIdentity(entry: RepositoryTreeEntry, ref: string, content: string): ContractProvenanceSource {
  return {
    path: entry.path,
    ref,
    sha: entry.sha,
    digest: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot < 0 ? "" : filePath.slice(dot).toLowerCase();
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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
