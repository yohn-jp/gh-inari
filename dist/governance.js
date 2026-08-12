import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { compileIssueFormTemplate, compileIssueFormYaml, } from "./contract/issue-form.js";
import { assertCanonicalContract, } from "./contract/ir.js";
import { compilePullRequestPolicyFile, compilePullRequestPolicyOverlay } from "./pr-policy.js";
import { compilePullRequestTemplate, parsePullRequestTemplate } from "./pull-request-template.js";
import { discoverTemplates, selectIssueTemplate, selectPullRequestTemplate, discoverTemplatesFromPaths, classifyTemplatePath, isTemplateContainerPath, isTemplatePathInNativeDirectory, } from "./template-discovery.js";
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
    let contract;
    if (domain === "issue") {
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
    const { context, ref, tree, discovery } = source;
    const selectedTemplate = domain === "issue" ? selectIssueTemplate(discovery, selector) : selectPullRequestTemplate(discovery, selector);
    const templateEntry = findBlob(tree, selectedTemplate.path, context, ref);
    const templateSource = await readGovernedValue("repository.governance.blob", context, ref, () => adapter.getRepositoryBlob(templateEntry.sha));
    let contract;
    if (domain === "issue") {
        contract = compileIssueFormYaml(templateSource, selectedTemplate);
    }
    else {
        contract = parsePullRequestTemplate(templateSource, selectedTemplate);
    }
    const policyEntry = domain === "pr" ? findPolicy(tree) : undefined;
    let policySource;
    if (policyEntry !== undefined) {
        if (policyEntry.type !== "blob")
            throw invalidSource(context, policyEntry.path, "policy path is not a file");
        const source = await readGovernedValue("repository.governance.blob", context, ref, () => adapter.getRepositoryBlob(policyEntry.sha));
        contract = compilePullRequestPolicyOverlay(contract, source, {
            templateIdentities: discovery.pullRequestTemplates,
        });
        policySource = sourceIdentity(policyEntry, ref, source);
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
            template: sourceIdentity(templateEntry, ref, templateSource),
            ...(policySource === undefined ? {} : { policy: policySource }),
        },
    };
    assertCanonicalContract(bound);
    return bound;
}
/** Discover all authoritative templates without compiling or reading a body. */
export async function discoverRepositoryTemplates(adapter) {
    return (await readRepositoryGovernanceSource(adapter)).discovery;
}
async function readRepositoryGovernanceSource(adapter) {
    const context = await adapter.resolveRepositoryContext();
    const ref = await readGovernedValue("repository.default_branch", context, undefined, () => adapter.getRepositoryDefaultBranch());
    const tree = await readGovernedValue("repository.governance.tree", context, ref, () => adapter.getRepositoryTree(ref));
    return { context, ref, tree, discovery: createRemoteDiscovery(context, tree) };
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