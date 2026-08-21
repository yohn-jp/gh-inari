import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { compileIssueFormTemplate, compileIssueFormYaml, } from "./contract/issue-form.js";
import { assertCanonicalContract, } from "./contract/ir.js";
import { compilePullRequestPolicyFile, compilePullRequestPolicyOverlay, parsePullRequestPolicyOverlay, } from "./pr-policy.js";
import { compilePullRequestTemplate, parsePullRequestTemplate } from "./pull-request-template.js";
import { compileSemanticTemplate, compileSemanticTemplateSource, discoverSemanticTemplates, readSemanticTemplate, selectSemanticTemplate, normalizeSemanticTemplate, } from "./semantic-template.js";
import { discoverTemplates, selectIssueTemplate, selectPullRequestTemplate, discoverTemplatesFromPaths, classifyTemplatePath, isTemplateContainerPath, isTemplatePathInNativeDirectory, TemplateNotFoundError, } from "./template-discovery.js";
/** Stable, machine-readable failures for repository governance acquisition. */
export class GovernanceError extends Error {
    code;
    details;
    constructor(code, message, details = {}, options) {
        super(message, options);
        this.name = "GovernanceError";
        this.code = code;
        this.details = details;
    }
    toJSON() {
        return { code: this.code, message: this.message, details: this.details };
    }
}
/** Arbitrary local policy files are never accepted by governed remote operations. */
export function rejectGovernedPolicyOverride(policyPath) {
    if (typeof policyPath !== "string")
        return;
    throw new GovernanceError("GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN", "Governed remote operations cannot use an arbitrary --policy file; policy must come from the target repository.", { path: policyPath, reason: "external policy override" });
}
/**
 * Compile governance from a checked-out repository source.
 *
 * This is the local counterpart to compileRepositoryGovernedContract. CLI
 * local schema/validate/render commands and repository workflows both call
 * this function so template, policy, and contract semantics remain owned by
 * the product compiler rather than by handwritten workflow scripts.
 */
export async function compileLocalGovernedContract(domain, root, selector, policyPath) {
    const discovery = await discoverTemplates(root);
    const semanticTemplates = await discoverSemanticTemplates(root);
    const semanticCandidates = semanticTemplates.filter((template) => template.kind === (domain === "issue" ? "issue" : "pull_request"));
    let contract;
    if (semanticCandidates.length > 0) {
        const semanticIdentity = selectSemanticTemplate(semanticTemplates, domain === "issue" ? "issue" : "pull_request", selector);
        contract = await compileSemanticTemplate(root, await readSemanticTemplate(root, semanticIdentity));
    }
    else if (domain === "issue") {
        contract = await compileIssueFormTemplate(discovery, selector);
    }
    else {
        contract = await compilePullRequestTemplate(root, selector);
    }
    if (domain !== "pr")
        return contract;
    const selectedPolicy = await resolveLocalPolicyPath(root, policyPath);
    if (selectedPolicy === undefined)
        return contract;
    return compilePullRequestPolicyFile(contract, selectedPolicy, {
        templateIdentities: discovery.pullRequestTemplates,
    });
}
/** Compile every repository-native Issue Form with the shared compiler. */
export async function compileLocalIssueFormContracts(root) {
    const semanticTemplates = (await discoverSemanticTemplates(root)).filter((template) => template.kind === "issue");
    if (semanticTemplates.length > 0) {
        return Promise.all(semanticTemplates.map(async (identity) => compileSemanticTemplate(root, await readSemanticTemplate(root, identity))));
    }
    const discovery = await discoverTemplates(root);
    return Promise.all(discovery.issueTemplates.map((template) => compileIssueFormTemplate(discovery, template.id)));
}
async function resolveLocalPolicyPath(root, policyPath) {
    if (typeof policyPath === "string")
        return path.resolve(root, policyPath);
    const candidates = [path.join(root, ".github", "inari", "pr-policy.yml"), path.join(root, ".inari", "pr-policy.yml")];
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        }
        catch {
            // Continue to the next repository-native policy location.
        }
    }
    return undefined;
}
/**
 * Resolve and compile governance from the target repository's default branch.
 * No local repository files are consulted by this path.
 */
export async function compileRepositoryGovernedContract(adapter, domain, selector) {
    const source = await readRepositoryGovernanceSource(adapter);
    const semanticCandidates = source.semanticTemplates.filter((template) => template.kind === (domain === "issue" ? "issue" : "pull_request"));
    if (semanticCandidates.length > 0) {
        const semanticIdentity = selectSemanticTemplate(source.semanticTemplates, domain === "issue" ? "issue" : "pull_request", selector);
        return compileRepositorySemanticContractFromSource(adapter, source, semanticIdentity);
    }
    const { discovery } = source;
    const selectedTemplate = domain === "issue" ? selectIssueTemplate(discovery, selector) : selectPullRequestTemplate(discovery, selector);
    return compileRepositoryGovernedContractFromSource(adapter, source, domain, selectedTemplate, createRepositoryPolicySourceLoader(adapter, source));
}
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
export async function compileRepositoryGovernedContracts(adapter, domain) {
    const source = await readRepositoryGovernanceSource(adapter);
    const semanticTemplates = source.semanticTemplates.filter((template) => template.kind === (domain === "issue" ? "issue" : "pull_request"));
    if (semanticTemplates.length > 0) {
        const outcomes = [];
        for (const identity of semanticTemplates) {
            try {
                outcomes.push({
                    status: "compiled",
                    contract: await compileRepositorySemanticContractFromSource(adapter, source, identity),
                });
            }
            catch (error) {
                outcomes.push({
                    status: "failed",
                    path: identity.sourcePath,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return outcomes;
    }
    const templates = domain === "issue"
        ? source.discovery.issueTemplates.filter((template) => template.type === "issue-form")
        : source.discovery.pullRequestTemplates;
    if (templates.length === 0)
        throw new TemplateNotFoundError(undefined, templates);
    const policySourceLoader = createRepositoryPolicySourceLoader(adapter, source);
    const outcomes = [];
    for (const template of templates) {
        try {
            outcomes.push({
                status: "compiled",
                contract: await compileRepositoryGovernedContractFromSource(adapter, source, domain, template, policySourceLoader),
            });
        }
        catch (error) {
            outcomes.push({
                status: "failed",
                path: template.path,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return outcomes;
}
async function compileRepositoryGovernedContractFromSource(adapter, source, domain, selectedTemplate, policySourceLoader) {
    const { context, ref, tree, discovery } = source;
    const templateEntry = findBlob(tree, selectedTemplate.path, context, ref);
    const templateSource = await readGovernedValue("repository.governance.blob", context, ref, () => adapter.getRepositoryBlob(templateEntry.sha));
    let contract;
    if (domain === "issue") {
        contract = compileIssueFormYaml(templateSource, selectedTemplate);
    }
    else {
        contract = parsePullRequestTemplate(templateSource, selectedTemplate);
    }
    let policySource;
    let branchGovernance;
    const repositoryPolicy = domain === "pr" ? await policySourceLoader() : undefined;
    if (repositoryPolicy !== undefined) {
        const overlay = parsePullRequestPolicyOverlay(repositoryPolicy.source);
        contract = compilePullRequestPolicyOverlay(contract, overlay, {
            templateIdentities: discovery.pullRequestTemplates,
        });
        policySource = sourceIdentity(repositoryPolicy.entry, ref, repositoryPolicy.source);
        branchGovernance = overlay.branch;
    }
    const bound = {
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
            ...(branchGovernance === undefined ? {} : { branchGovernance }),
        },
    };
    assertCanonicalContract(bound);
    return bound;
}
async function compileRepositorySemanticContractFromSource(adapter, source, identity) {
    const { context, ref, tree, discovery } = source;
    const sourceEntry = findBlob(tree, identity.sourcePath, context, ref);
    const serialized = await readGovernedValue("repository.governance.blob", context, ref, () => adapter.getRepositoryBlob(sourceEntry.sha));
    let semanticSource;
    try {
        semanticSource = normalizeSemanticTemplate(JSON.parse(serialized), identity.sourcePath);
    }
    catch (error) {
        throw invalidSource(context, identity.sourcePath, error instanceof Error ? error.message : "semantic source is invalid");
    }
    let contract = compileSemanticTemplateSource(semanticSource, identity.generatedPath);
    let policySource;
    let branchGovernance;
    if (semanticSource.kind === "pull_request") {
        const repositoryPolicy = await createRepositoryPolicySourceLoader(adapter, source)();
        if (repositoryPolicy !== undefined) {
            const overlay = parsePullRequestPolicyOverlay(repositoryPolicy.source);
            contract = compilePullRequestPolicyOverlay(contract, overlay, {
                templateIdentities: discovery.pullRequestTemplates,
            });
            policySource = sourceIdentity(repositoryPolicy.entry, ref, repositoryPolicy.source);
            branchGovernance = overlay.branch;
        }
    }
    const nativeEntry = findBlob(tree, identity.generatedPath, context, ref);
    const nativeSource = await readGovernedValue("repository.governance.blob", context, ref, () => adapter.getRepositoryBlob(nativeEntry.sha));
    const bound = {
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
            ...(branchGovernance === undefined ? {} : { branchGovernance }),
        },
    };
    assertCanonicalContract(bound);
    return bound;
}
function createRepositoryPolicySourceLoader(adapter, source) {
    let pending;
    return () => {
        if (pending === undefined) {
            pending = readRepositoryPolicySource(adapter, source);
        }
        return pending;
    };
}
async function readRepositoryPolicySource(adapter, source) {
    const policyEntry = findPolicy(source.tree);
    if (policyEntry === undefined)
        return undefined;
    if (policyEntry.type !== "blob")
        throw invalidSource(source.context, policyEntry.path, "policy path is not a file");
    const policySource = await readGovernedValue("repository.governance.blob", source.context, source.ref, () => adapter.getRepositoryBlob(policyEntry.sha));
    return { entry: policyEntry, source: policySource };
}
/** Discover all authoritative templates without compiling or reading a body. */
export async function discoverRepositoryTemplates(adapter) {
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
export async function verifyGovernedMutationFreshness(adapter, provenance) {
    const source = await readRepositoryGovernanceSource(adapter);
    const assessment = assessGovernanceFreshness(source, provenance);
    if (!assessment.fresh)
        throw staleGenerationError(source, provenance, assessment.reason);
}
/**
 * Judge whether a previously validated contract's governance inputs are
 * still content-equivalent to the currently observed repository governance.
 * Shared by the pre-mutation freshness gate and post-mutation reconciliation
 * so both use identical stale-generation semantics.
 */
function assessGovernanceFreshness(source, provenance) {
    if (source.context.nameWithOwner !== provenance.repository.nameWithOwner) {
        return { fresh: false, reason: "target repository does not match validated provenance" };
    }
    if (source.treeSha === provenance.treeSha)
        return { fresh: true };
    const templateEntry = source.tree.find((entry) => entry.path === provenance.template.path);
    if (templateEntry === undefined || templateEntry.type !== "blob" || templateEntry.sha !== provenance.template.sha) {
        return { fresh: false, reason: "template governance input changed" };
    }
    const currentPolicyEntry = findPolicy(source.tree);
    if (provenance.policy === undefined) {
        if (currentPolicyEntry !== undefined) {
            return { fresh: false, reason: "a policy governance input was introduced" };
        }
        return { fresh: true };
    }
    if (currentPolicyEntry === undefined ||
        currentPolicyEntry.type !== "blob" ||
        currentPolicyEntry.sha !== provenance.policy.sha) {
        return { fresh: false, reason: "policy governance input changed" };
    }
    return { fresh: true };
}
function staleGenerationError(source, provenance, reason) {
    return new GovernanceError("GOVERNANCE_GENERATION_STALE", "The target repository governance changed since this artifact was validated and rendered; recompile and revalidate before mutating.", {
        repository: source.context.nameWithOwner,
        ref: source.ref,
        reason,
        validatedRef: provenance.ref,
        validatedTreeSha: provenance.treeSha,
        currentTreeSha: source.treeSha,
    });
}
async function reconcileGovernanceAfterMutation(adapter, provenance) {
    const source = await readRepositoryGovernanceSource(adapter);
    const assessment = assessGovernanceFreshness(source, provenance);
    return {
        validatedGeneration: provenance.treeSha,
        currentGeneration: source.treeSha,
        reconciled: assessment.fresh,
        ...(assessment.fresh ? {} : { reason: assessment.reason }),
    };
}
/** Create an Issue only after verifying its governance generation is still fresh. */
export async function createGovernedIssue(adapter, artifact) {
    await verifyGovernedMutationFreshness(adapter, artifact.provenance);
    const created = await adapter.createIssue(artifact);
    const governance = await reconcileGovernanceAfterMutation(adapter, artifact.provenance);
    return { artifact: created, governance };
}
/** Update an Issue only after verifying its governance generation is still fresh. */
export async function updateGovernedIssue(adapter, issueNumber, artifact) {
    await verifyGovernedMutationFreshness(adapter, artifact.provenance);
    const updated = await adapter.updateIssue(issueNumber, artifact);
    const governance = await reconcileGovernanceAfterMutation(adapter, artifact.provenance);
    return { artifact: updated, governance };
}
/**
 * Preflight the actual pull-request head branch against the target
 * repository's authoritative branch governance, if the repository's PR
 * policy declares one.
 *
 * `artifact.head` is read directly from the same validated artifact that
 * `adapter.createPullRequest` mutates with moments later, so the branch this
 * function judges and the branch GitHub receives are structurally the same
 * value — there is no separate, potentially divergent caller-supplied name
 * to validate instead. A repository that declares no branch rule has
 * nothing to preflight, so this is a no-op for the common case and the
 * existing valid-branch mutation path is unchanged.
 */
function assertBranchGovernance(artifact) {
    const branchGovernance = artifact.provenance.branchGovernance;
    if (branchGovernance === undefined)
        return;
    let pattern;
    try {
        pattern = new RegExp(branchGovernance.pattern, "u");
    }
    catch (cause) {
        throw new GovernanceError("GOVERNANCE_SOURCE_INVALID", "The target repository's branch governance pattern is not a valid regular expression.", {
            repository: artifact.provenance.repository.nameWithOwner,
            pattern: branchGovernance.pattern,
            reason: "invalid branch governance pattern",
        }, { cause });
    }
    if (pattern.test(artifact.head))
        return;
    throw new GovernanceError("GOVERNANCE_BRANCH_INVALID", `Pull request head branch "${artifact.head}" does not satisfy the target repository's branch governance.`, {
        repository: artifact.provenance.repository.nameWithOwner,
        head: artifact.head,
        pattern: branchGovernance.pattern,
        reason: "head branch does not match required pattern",
    });
}
/**
 * Create a pull request only after preflighting its actual head branch
 * against repository branch governance and verifying its governance
 * generation is still fresh.
 */
export async function createGovernedPullRequest(adapter, artifact) {
    assertBranchGovernance(artifact);
    await verifyGovernedMutationFreshness(adapter, artifact.provenance);
    const created = await adapter.createPullRequest(artifact);
    const governance = await reconcileGovernanceAfterMutation(adapter, artifact.provenance);
    return { artifact: created, governance };
}
/** Update a pull request only after verifying its governance generation is still fresh. */
export async function updateGovernedPullRequest(adapter, pullRequestNumber, artifact) {
    await verifyGovernedMutationFreshness(adapter, artifact.provenance);
    const updated = await adapter.updatePullRequest(pullRequestNumber, artifact);
    const governance = await reconcileGovernanceAfterMutation(adapter, artifact.provenance);
    return { artifact: updated, governance };
}
async function readRepositoryGovernanceSource(adapter) {
    const context = await adapter.resolveRepositoryContext();
    const ref = await readGovernedValue("repository.default_branch", context, undefined, () => adapter.getRepositoryDefaultBranch());
    const { sha: treeSha, entries: tree } = await readGovernedValue("repository.governance.tree", context, ref, () => adapter.getRepositoryTree(ref));
    return {
        context,
        ref,
        treeSha,
        tree,
        discovery: createRemoteDiscovery(context, tree),
        semanticTemplates: createRemoteSemanticIdentities(tree),
    };
}
function createRemoteSemanticIdentities(tree) {
    const identities = [];
    for (const entry of tree) {
        if (entry.type !== "blob" || !entry.path.endsWith(".json"))
            continue;
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
        }
        else if (entry.path === ".github/inari/pull-request.json") {
            identities.push({
                id: "pull-request",
                kind: "pull_request",
                name: "Pull request",
                sourcePath: entry.path,
                generatedPath: ".github/PULL_REQUEST_TEMPLATE.md",
            });
        }
        else if (entry.path.startsWith(".github/inari/pull-requests/") && entry.path.split("/").length === 4) {
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
function createRemoteDiscovery(context, tree) {
    for (const entry of tree) {
        const isContainer = isTemplateContainerPath(entry.path);
        if (entry.type === "tree") {
            if (isContainer)
                continue;
            let classified;
            try {
                classified = classifyTemplatePath(entry.path);
            }
            catch (error) {
                throw invalidSource(context, entry.path, error instanceof Error ? error.message : "invalid template path");
            }
            if (isTemplatePathInNativeDirectory(entry.path) || classified !== undefined) {
                throw invalidSource(context, entry.path, "template path is not a regular file");
            }
            continue;
        }
        if (isContainer)
            throw invalidSource(context, entry.path, "template path is not a regular file");
        try {
            classifyTemplatePath(entry.path);
        }
        catch (error) {
            throw invalidSource(context, entry.path, error instanceof Error ? error.message : "invalid template path");
        }
    }
    try {
        return discoverTemplatesFromPaths(tree.filter((entry) => entry.type === "blob").map((entry) => entry.path), context.url);
    }
    catch (error) {
        throw invalidSource(context, "<template tree>", error instanceof Error ? error.message : "invalid template path");
    }
}
function findBlob(tree, filePath, context, ref) {
    const entry = tree.find((candidate) => candidate.path === filePath);
    if (entry === undefined || entry.type !== "blob") {
        throw new GovernanceError("GOVERNANCE_SOURCE_INVALID", `Trusted governance source "${filePath}" was not a regular file at ref "${ref}".`, { repository: context.nameWithOwner, ref, path: filePath, reason: "missing or non-file source" });
    }
    return entry;
}
function findPolicy(tree) {
    const preferred = tree.find((entry) => entry.path === ".github/inari/pr-policy.yml");
    if (preferred !== undefined)
        return preferred;
    return tree.find((entry) => entry.path === ".inari/pr-policy.yml");
}
function sourceIdentity(entry, ref, content) {
    return {
        path: entry.path,
        ref,
        sha: entry.sha,
        digest: createHash("sha256").update(content, "utf8").digest("hex"),
    };
}
function invalidSource(context, path, reason) {
    return new GovernanceError("GOVERNANCE_SOURCE_INVALID", `Repository governance source at "${path}" is invalid: ${reason}.`, { repository: context.nameWithOwner, path, reason });
}
async function readGovernedValue(operation, context, ref, read) {
    try {
        return await read();
    }
    catch (error) {
        if (error instanceof GovernanceError)
            throw error;
        throw new GovernanceError(error instanceof Error && error.name === "GitHubApiResponseError"
            ? "GOVERNANCE_SOURCE_INVALID"
            : "GOVERNANCE_SOURCE_UNAVAILABLE", `Unable to establish trusted repository governance during ${operation}.`, {
            operation,
            repository: context.nameWithOwner,
            ...(ref === undefined ? {} : { ref }),
            reason: error instanceof Error ? error.message : "remote source read failed",
        }, { cause: error });
    }
}
//# sourceMappingURL=governance.js.map