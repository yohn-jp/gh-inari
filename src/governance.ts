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
import {
  GitHubAdapter,
  type GitHubIssue,
  type GitHubPullRequest,
  type RepositoryContext,
  type RepositoryTreeEntry,
  type ValidatedRenderedIssueArtifact,
  type ValidatedRenderedPullRequestArtifact,
} from "./github/index.js";
import { compilePullRequestPolicyFile, compilePullRequestPolicyOverlay } from "./pr-policy.js";
import { compilePullRequestTemplate, parsePullRequestTemplate } from "./pull-request-template.js";
import {
  compileSemanticTemplate,
  compileSemanticTemplateSource,
  discoverSemanticTemplates,
  readSemanticTemplate,
  selectSemanticTemplate,
  normalizeSemanticTemplate,
  type SemanticTemplateIdentity,
} from "./semantic-template.js";
import {
  discoverTemplates,
  selectIssueTemplate,
  selectPullRequestTemplate,
  discoverTemplatesFromPaths,
  classifyTemplatePath,
  isTemplateContainerPath,
  isTemplatePathInNativeDirectory,
  TemplateNotFoundError,
  type TemplateDiscoveryResult,
  type TemplateSelector,
} from "./template-discovery.js";

export type GovernedArtifactDomain = "issue" | "pr";

export type GovernanceErrorCode =
  | "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN"
  | "GOVERNANCE_SOURCE_UNAVAILABLE"
  | "GOVERNANCE_SOURCE_INVALID"
  | "GOVERNANCE_GENERATION_STALE";

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
  const semanticTemplates = await discoverSemanticTemplates(root);
  const semanticCandidates = semanticTemplates.filter(
    (template) => template.kind === (domain === "issue" ? "issue" : "pull_request"),
  );
  let contract: CanonicalContract;
  if (semanticCandidates.length > 0) {
    const semanticIdentity = selectSemanticTemplate(
      semanticTemplates,
      domain === "issue" ? "issue" : "pull_request",
      selector,
    );
    contract = await compileSemanticTemplate(root, await readSemanticTemplate(root, semanticIdentity));
  } else if (domain === "issue") {
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
  const semanticTemplates = (await discoverSemanticTemplates(root)).filter((template) => template.kind === "issue");
  if (semanticTemplates.length > 0) {
    return Promise.all(
      semanticTemplates.map(async (identity) =>
        compileSemanticTemplate(root, await readSemanticTemplate(root, identity)),
      ),
    );
  }
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
  const semanticCandidates = source.semanticTemplates.filter(
    (template) => template.kind === (domain === "issue" ? "issue" : "pull_request"),
  );
  if (semanticCandidates.length > 0) {
    const semanticIdentity = selectSemanticTemplate(
      source.semanticTemplates,
      domain === "issue" ? "issue" : "pull_request",
      selector,
    );
    return compileRepositorySemanticContractFromSource(adapter, source, semanticIdentity);
  }
  const { discovery } = source;
  const selectedTemplate =
    domain === "issue" ? selectIssueTemplate(discovery, selector) : selectPullRequestTemplate(discovery, selector);
  return compileRepositoryGovernedContractFromSource(
    adapter,
    source,
    domain,
    selectedTemplate,
    createRepositoryPolicySourceLoader(adapter, source),
  );
}

/** One repository-native template's compilation outcome: either a usable contract or a bounded diagnostic. */
export type CompiledTemplateOutcome =
  | { readonly status: "compiled"; readonly contract: CanonicalContract }
  | { readonly status: "failed"; readonly path: string; readonly message: string };

/**
 * Compile every supported native template from the target repository's
 * trusted default-branch governance. Read commands use this candidate set to
 * identify an existing artifact without inventing a second template grammar.
 *
 * A template that fails to compile does not abort its siblings: it is
 * reported as a bounded "failed" outcome so an unrelated malformed template
 * cannot make every existing-artifact read in the repository fail. Callers
 * that need fail-closed behavior for a single selected template should use
 * compileRepositoryGovernedContract instead.
 */
export async function compileRepositoryGovernedContracts(
  adapter: GitHubAdapter,
  domain: GovernedArtifactDomain,
): Promise<readonly CompiledTemplateOutcome[]> {
  const source = await readRepositoryGovernanceSource(adapter);
  const semanticTemplates = source.semanticTemplates.filter(
    (template) => template.kind === (domain === "issue" ? "issue" : "pull_request"),
  );
  if (semanticTemplates.length > 0) {
    const outcomes: CompiledTemplateOutcome[] = [];
    for (const identity of semanticTemplates) {
      try {
        outcomes.push({
          status: "compiled",
          contract: await compileRepositorySemanticContractFromSource(adapter, source, identity),
        });
      } catch (error: unknown) {
        outcomes.push({
          status: "failed",
          path: identity.sourcePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcomes;
  }
  const templates =
    domain === "issue"
      ? source.discovery.issueTemplates.filter((template) => template.type === "issue-form")
      : source.discovery.pullRequestTemplates;
  if (templates.length === 0) throw new TemplateNotFoundError(undefined, templates);
  const policySourceLoader = createRepositoryPolicySourceLoader(adapter, source);
  const outcomes: CompiledTemplateOutcome[] = [];
  for (const template of templates) {
    try {
      outcomes.push({
        status: "compiled",
        contract: await compileRepositoryGovernedContractFromSource(
          adapter,
          source,
          domain,
          template,
          policySourceLoader,
        ),
      });
    } catch (error: unknown) {
      outcomes.push({
        status: "failed",
        path: template.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

async function compileRepositoryGovernedContractFromSource(
  adapter: GitHubAdapter,
  source: RepositoryGovernanceSource,
  domain: GovernedArtifactDomain,
  selectedTemplate: TemplateDiscoveryResult["templates"][number],
  policySourceLoader: () => Promise<RepositoryPolicySource | undefined>,
): Promise<CanonicalContract> {
  const { context, ref, tree, discovery } = source;
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

  let policySource: ContractProvenanceSource | undefined;
  const repositoryPolicy = domain === "pr" ? await policySourceLoader() : undefined;
  if (repositoryPolicy !== undefined) {
    contract = compilePullRequestPolicyOverlay(contract, repositoryPolicy.source, {
      templateIdentities: discovery.pullRequestTemplates,
    });
    policySource = sourceIdentity(repositoryPolicy.entry, ref, repositoryPolicy.source);
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
      treeSha: source.treeSha,
      template: sourceIdentity(templateEntry, ref, templateSource),
      ...(policySource === undefined ? {} : { policy: policySource }),
    },
  };
  assertCanonicalContract(bound);
  return bound;
}

async function compileRepositorySemanticContractFromSource(
  adapter: GitHubAdapter,
  source: RepositoryGovernanceSource,
  identity: SemanticTemplateIdentity,
): Promise<CanonicalContract> {
  const { context, ref, tree, discovery } = source;
  const sourceEntry = findBlob(tree, identity.sourcePath, context, ref);
  const serialized = await readGovernedValue("repository.governance.blob", context, ref, () =>
    adapter.getRepositoryBlob(sourceEntry.sha),
  );
  let semanticSource;
  try {
    semanticSource = normalizeSemanticTemplate(JSON.parse(serialized) as unknown, identity.sourcePath);
  } catch (error: unknown) {
    throw invalidSource(
      context,
      identity.sourcePath,
      error instanceof Error ? error.message : "semantic source is invalid",
    );
  }
  let contract = compileSemanticTemplateSource(semanticSource, identity.generatedPath);
  let policySource: ContractProvenanceSource | undefined;
  if (semanticSource.kind === "pull_request") {
    const repositoryPolicy = await createRepositoryPolicySourceLoader(adapter, source)();
    if (repositoryPolicy !== undefined) {
      contract = compilePullRequestPolicyOverlay(contract, repositoryPolicy.source, {
        templateIdentities: discovery.pullRequestTemplates,
      });
      policySource = sourceIdentity(repositoryPolicy.entry, ref, repositoryPolicy.source);
    }
  }
  const nativeEntry = findBlob(tree, identity.generatedPath, context, ref);
  const nativeSource = await readGovernedValue("repository.governance.blob", context, ref, () =>
    adapter.getRepositoryBlob(nativeEntry.sha),
  );
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
      treeSha: source.treeSha,
      template: sourceIdentity(nativeEntry, ref, nativeSource),
      ...(policySource === undefined ? {} : { policy: policySource }),
    },
  };
  assertCanonicalContract(bound);
  return bound;
}

interface RepositoryPolicySource {
  readonly entry: RepositoryTreeEntry;
  readonly source: string;
}

function createRepositoryPolicySourceLoader(
  adapter: GitHubAdapter,
  source: RepositoryGovernanceSource,
): () => Promise<RepositoryPolicySource | undefined> {
  let pending: Promise<RepositoryPolicySource | undefined> | undefined;
  return () => {
    if (pending === undefined) {
      pending = readRepositoryPolicySource(adapter, source);
    }
    return pending;
  };
}

async function readRepositoryPolicySource(
  adapter: GitHubAdapter,
  source: RepositoryGovernanceSource,
): Promise<RepositoryPolicySource | undefined> {
  const policyEntry = findPolicy(source.tree);
  if (policyEntry === undefined) return undefined;
  if (policyEntry.type !== "blob") throw invalidSource(source.context, policyEntry.path, "policy path is not a file");
  const policySource = await readGovernedValue("repository.governance.blob", source.context, source.ref, () =>
    adapter.getRepositoryBlob(policyEntry.sha),
  );
  return { entry: policyEntry, source: policySource };
}

/** Discover all authoritative templates without compiling or reading a body. */
export async function discoverRepositoryTemplates(adapter: GitHubAdapter): Promise<TemplateDiscoveryResult> {
  return (await readRepositoryGovernanceSource(adapter)).discovery;
}

/**
 * Verify, immediately before a governed mutation, that the artifact's
 * repository governance generation is still acceptable.
 *
 * A generation match (`treeSha` equality) is the fast path: nothing under
 * governance changed since compilation. A generation mismatch means the
 * target repository's default branch advanced, but is not itself
 * disqualifying: it is content-equivalent, and therefore still acceptable,
 * only when every governance input the contract was compiled from (its
 * template, and its policy if one was used) is still present with the exact
 * same blob SHA. Any other outcome — a changed or removed template, a
 * changed, removed, or newly introduced policy — fails closed with a stable
 * GOVERNANCE_GENERATION_STALE error; the caller must recompile and
 * revalidate against the new generation before mutating.
 */
export async function verifyGovernedMutationFreshness(
  adapter: GitHubAdapter,
  provenance: ContractProvenance,
): Promise<void> {
  const source = await readRepositoryGovernanceSource(adapter);
  if (source.context.nameWithOwner !== provenance.repository.nameWithOwner) {
    throw staleGenerationError(source, provenance, "target repository does not match validated provenance");
  }
  if (source.treeSha === provenance.treeSha) return;

  const templateEntry = source.tree.find((entry) => entry.path === provenance.template.path);
  if (templateEntry === undefined || templateEntry.type !== "blob" || templateEntry.sha !== provenance.template.sha) {
    throw staleGenerationError(source, provenance, "template governance input changed");
  }
  const currentPolicyEntry = findPolicy(source.tree);
  if (provenance.policy === undefined) {
    if (currentPolicyEntry !== undefined) {
      throw staleGenerationError(source, provenance, "a policy governance input was introduced");
    }
    return;
  }
  if (
    currentPolicyEntry === undefined ||
    currentPolicyEntry.type !== "blob" ||
    currentPolicyEntry.sha !== provenance.policy.sha
  ) {
    throw staleGenerationError(source, provenance, "policy governance input changed");
  }
}

function staleGenerationError(
  source: RepositoryGovernanceSource,
  provenance: ContractProvenance,
  reason: string,
): GovernanceError {
  return new GovernanceError(
    "GOVERNANCE_GENERATION_STALE",
    "The target repository governance changed since this artifact was validated and rendered; recompile and revalidate before mutating.",
    {
      repository: source.context.nameWithOwner,
      ref: source.ref,
      reason,
      validatedRef: provenance.ref,
      validatedTreeSha: provenance.treeSha,
      currentTreeSha: source.treeSha,
    },
  );
}

/** Create an Issue only after verifying its governance generation is still fresh. */
export async function createGovernedIssue(
  adapter: GitHubAdapter,
  artifact: ValidatedRenderedIssueArtifact,
): Promise<GitHubIssue> {
  await verifyGovernedMutationFreshness(adapter, artifact.provenance);
  return adapter.createIssue(artifact);
}

/** Update an Issue only after verifying its governance generation is still fresh. */
export async function updateGovernedIssue(
  adapter: GitHubAdapter,
  issueNumber: number,
  artifact: ValidatedRenderedIssueArtifact,
): Promise<GitHubIssue> {
  await verifyGovernedMutationFreshness(adapter, artifact.provenance);
  return adapter.updateIssue(issueNumber, artifact);
}

/** Create a pull request only after verifying its governance generation is still fresh. */
export async function createGovernedPullRequest(
  adapter: GitHubAdapter,
  artifact: ValidatedRenderedPullRequestArtifact,
): Promise<GitHubPullRequest> {
  await verifyGovernedMutationFreshness(adapter, artifact.provenance);
  return adapter.createPullRequest(artifact);
}

/** Update a pull request only after verifying its governance generation is still fresh. */
export async function updateGovernedPullRequest(
  adapter: GitHubAdapter,
  pullRequestNumber: number,
  artifact: ValidatedRenderedPullRequestArtifact,
): Promise<GitHubPullRequest> {
  await verifyGovernedMutationFreshness(adapter, artifact.provenance);
  return adapter.updatePullRequest(pullRequestNumber, artifact);
}

interface RepositoryGovernanceSource {
  readonly context: RepositoryContext;
  readonly ref: string;
  /** Immutable generation identity: the root tree SHA read alongside `tree`. */
  readonly treeSha: string;
  readonly tree: readonly RepositoryTreeEntry[];
  readonly discovery: TemplateDiscoveryResult;
  readonly semanticTemplates: readonly SemanticTemplateIdentity[];
}

async function readRepositoryGovernanceSource(adapter: GitHubAdapter): Promise<RepositoryGovernanceSource> {
  const context = await adapter.resolveRepositoryContext();
  const ref = await readGovernedValue("repository.default_branch", context, undefined, () =>
    adapter.getRepositoryDefaultBranch(),
  );
  const { sha: treeSha, entries: tree } = await readGovernedValue("repository.governance.tree", context, ref, () =>
    adapter.getRepositoryTree(ref),
  );
  return {
    context,
    ref,
    treeSha,
    tree,
    discovery: createRemoteDiscovery(context, tree),
    semanticTemplates: createRemoteSemanticIdentities(tree),
  };
}

function createRemoteSemanticIdentities(tree: readonly RepositoryTreeEntry[]): readonly SemanticTemplateIdentity[] {
  const identities: SemanticTemplateIdentity[] = [];
  for (const entry of tree) {
    if (entry.type !== "blob" || !entry.path.endsWith(".json")) continue;
    if (entry.path.startsWith(".github/inari/issues/") && entry.path.split("/").length === 4) {
      const id = entry.path.slice(".github/inari/issues/".length, -".json".length);
      if (id.length > 0) {
        identities.push({
          id,
          kind: "issue",
          name: id,
          sourcePath: entry.path,
          generatedPath: `.github/ISSUE_TEMPLATE/${id}.yml`,
        });
      }
    } else if (entry.path === ".github/inari/pull-request.json") {
      identities.push({
        id: "pull-request",
        kind: "pull_request",
        name: "Pull request",
        sourcePath: entry.path,
        generatedPath: ".github/PULL_REQUEST_TEMPLATE.md",
      });
    } else if (entry.path.startsWith(".github/inari/pull-requests/") && entry.path.split("/").length === 4) {
      const id = entry.path.slice(".github/inari/pull-requests/".length, -".json".length);
      if (id.length > 0) {
        identities.push({
          id,
          kind: "pull_request",
          name: id,
          sourcePath: entry.path,
          generatedPath: `.github/PULL_REQUEST_TEMPLATE/${id}.md`,
        });
      }
    }
  }
  return identities.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, "en-US"));
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
