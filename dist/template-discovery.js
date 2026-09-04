import { lstat, readdir } from "node:fs/promises";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeTemplateResolutionCandidate, resolveTemplateSync, TemplateResolutionError, isTemplateSelectorValue, } from "./template-resolver.js";
const GITHUB_DIRECTORY = ".github";
const ISSUE_TEMPLATE_DIRECTORY = "ISSUE_TEMPLATE";
const PULL_REQUEST_TEMPLATE_DIRECTORY = "PULL_REQUEST_TEMPLATE";
const DEFAULT_PULL_REQUEST_TEMPLATE = "pull_request_template";
const CONFIG_TEMPLATE_NAMES = new Set(["config.yml", "config.yaml"]);
const ISSUE_TEMPLATE_EXTENSIONS = new Set([".md", ".yml", ".yaml"]);
const PULL_REQUEST_TEMPLATE_EXTENSIONS = new Set([".md", ".txt"]);
const PULL_REQUEST_TEMPLATE_LOCATIONS = ["", "docs", GITHUB_DIRECTORY];
export class TemplateDiscoveryError extends Error {
    code;
    details;
    constructor(code, message, details = {}, options) {
        super(message, options);
        this.name = "TemplateDiscoveryError";
        this.code = code;
        this.details = details;
    }
    toJSON() {
        return { code: this.code, message: this.message, details: this.details };
    }
}
export class TemplateFilesystemError extends TemplateDiscoveryError {
    constructor(message, details = {}, cause) {
        super("TEMPLATE_FILESYSTEM_MALFORMED", message, details, { cause });
        this.name = "TemplateFilesystemError";
    }
}
export class TemplateNotFoundError extends TemplateDiscoveryError {
    constructor(selector, candidates) {
        super("TEMPLATE_NOT_FOUND", `No repository-native template matches ${selectorLabel(selector)}.`, {
            selector,
            candidates,
        });
        this.name = "TemplateNotFoundError";
    }
}
export class TemplateSelectionAmbiguousError extends TemplateDiscoveryError {
    constructor(selector, candidates) {
        super("TEMPLATE_SELECTION_AMBIGUOUS", `Template selection is ambiguous for ${selectorLabel(selector)}.`, {
            selector,
            candidates,
        });
        this.name = "TemplateSelectionAmbiguousError";
    }
}
export class TemplateNameConflictError extends TemplateDiscoveryError {
    constructor(selector, candidates) {
        super("TEMPLATE_NAME_CONFLICT", `Template name ${selectorLabel(selector)} identifies multiple repository-native templates.`, { selector, candidates });
        this.name = "TemplateNameConflictError";
    }
}
export class InvalidTemplateSelectorError extends TemplateDiscoveryError {
    constructor(selector) {
        super("INVALID_TEMPLATE_SELECTOR", "Template selector must contain a non-empty id, type, kind, name, or path.", {
            selector: isTemplateSelectorValue(selector) ? selector : undefined,
        });
        this.name = "InvalidTemplateSelectorError";
    }
}
/**
 * Discover the repository-native paths supported by the v1 compiler.
 * Template contents are intentionally not read; parsing belongs to later layers.
 */
export async function discoverTemplates(repositoryRoot = process.cwd()) {
    const root = resolveRepositoryRoot(repositoryRoot);
    await assertDirectory(root, "repository root");
    const [issueTemplatePaths, pullRequestTemplatePaths] = await Promise.all([
        discoverIssueTemplates(root),
        discoverPullRequestTemplates(root),
    ]);
    return discoverTemplatesFromPaths([...issueTemplatePaths, ...pullRequestTemplatePaths], root);
}
/** Synchronous counterpart for callers that already operate synchronously. */
export function discoverTemplatesSync(repositoryRoot = process.cwd()) {
    const root = resolveRepositoryRoot(repositoryRoot);
    assertDirectorySync(root, "repository root");
    const issueTemplatePaths = discoverIssueTemplatesSync(root);
    const pullRequestTemplatePaths = discoverPullRequestTemplatesSync(root);
    return discoverTemplatesFromPaths([...issueTemplatePaths, ...pullRequestTemplatePaths], root);
}
/**
 * Apply the same repository-native path semantics to a local filesystem or a
 * trusted remote Git tree. Contents and filesystem shape are validated by
 * the caller; this function owns only path classification and identity.
 */
export function discoverTemplatesFromPaths(templatePaths, repositoryRoot = "<repository>") {
    const templates = templatePaths.flatMap((templatePath) => {
        const normalizedPath = normalizeRepositoryPath(templatePath);
        const type = classifyTemplatePath(normalizedPath);
        return type === undefined ? [] : [createIdentityFromRepositoryPath(normalizedPath, type)];
    });
    return createDiscoveryResult(repositoryRoot, templates);
}
/** Classify one supported repository-native template path. */
export function classifyTemplatePath(templatePath) {
    const parts = normalizeRepositoryPath(templatePath).split("/");
    if (isTemplatePathNested(parts)) {
        throw new TemplateFilesystemError(`Nested template directories are unsupported: ${templatePath}.`, {
            path: templatePath,
            reason: "nested template directory",
        });
    }
    const fileName = parts.at(-1);
    if (fileName === undefined)
        return undefined;
    if (parts.length === 3 && parts[0] === GITHUB_DIRECTORY && parts[1] === ISSUE_TEMPLATE_DIRECTORY) {
        return classifyIssueTemplate(fileName)?.type;
    }
    if (parts.length === 1 && isDefaultPullRequestTemplateFilename(fileName)) {
        return "pull-request-default";
    }
    if (parts.length === 2 && isPullRequestLocation(parts[0]) && isDefaultPullRequestTemplateFilename(fileName)) {
        return "pull-request-default";
    }
    if (parts.length === 2 && sameName(parts[0], PULL_REQUEST_TEMPLATE_DIRECTORY)) {
        return classifyPullRequestTemplate(fileName)?.type;
    }
    if (parts.length === 3 &&
        isPullRequestLocation(parts[0]) &&
        sameName(parts[1], PULL_REQUEST_TEMPLATE_DIRECTORY)) {
        return classifyPullRequestTemplate(fileName)?.type;
    }
    return undefined;
}
/** Whether a path is one of the native template container directories. */
export function isTemplateContainerPath(templatePath) {
    const parts = normalizeRepositoryPath(templatePath).split("/");
    return ((parts.length === 2 && parts[0] === GITHUB_DIRECTORY && parts[1] === ISSUE_TEMPLATE_DIRECTORY) ||
        (parts.length === 1 && sameName(parts[0], PULL_REQUEST_TEMPLATE_DIRECTORY)) ||
        (parts.length === 2 &&
            isPullRequestLocation(parts[0]) &&
            sameName(parts[1], PULL_REQUEST_TEMPLATE_DIRECTORY)));
}
/** Whether a path is inside a native template directory. */
export function isTemplatePathInNativeDirectory(templatePath) {
    const parts = normalizeRepositoryPath(templatePath).split("/");
    return ((parts.length >= 2 && parts[0] === GITHUB_DIRECTORY && parts[1] === ISSUE_TEMPLATE_DIRECTORY) ||
        (parts.length >= 1 && sameName(parts[0], PULL_REQUEST_TEMPLATE_DIRECTORY)) ||
        (parts.length >= 2 &&
            isPullRequestLocation(parts[0]) &&
            sameName(parts[1], PULL_REQUEST_TEMPLATE_DIRECTORY)));
}
function isTemplatePathNested(parts) {
    return ((parts.length > 3 && parts[0] === GITHUB_DIRECTORY && parts[1] === ISSUE_TEMPLATE_DIRECTORY) ||
        (parts.length > 2 && sameName(parts[0], PULL_REQUEST_TEMPLATE_DIRECTORY)) ||
        (parts.length > 3 &&
            isPullRequestLocation(parts[0]) &&
            sameName(parts[1], PULL_REQUEST_TEMPLATE_DIRECTORY)));
}
function isPullRequestLocation(location) {
    return location === "docs" || location === GITHUB_DIRECTORY;
}
/**
 * Select one identity. A string first means an exact ID or path, then a name;
 * name selection is case-insensitive and fails closed when it is not unique.
 */
export function selectTemplate(discovery, selector) {
    return selectFromCandidates(discovery.templates, selector);
}
export function selectIssueTemplate(discovery, selector) {
    return selectFromCandidates(discovery.issueTemplates, selector);
}
export function selectPullRequestTemplate(discovery, selector) {
    return selectFromCandidates(discovery.pullRequestTemplates, selector);
}
function resolveRepositoryRoot(repositoryRoot) {
    const root = typeof repositoryRoot === "string" ? repositoryRoot : fileURLToPath(repositoryRoot);
    return path.resolve(root);
}
async function discoverIssueTemplates(repositoryRoot) {
    const directory = path.join(repositoryRoot, GITHUB_DIRECTORY, ISSUE_TEMPLATE_DIRECTORY);
    if (!(await optionalDirectory(directory)))
        return [];
    const entries = await readDirectory(directory);
    return collectDirectoryTemplates(directory, entries, "issue").map((entryPath) => toRepositoryPath(repositoryRoot, entryPath));
}
function discoverIssueTemplatesSync(repositoryRoot) {
    const directory = path.join(repositoryRoot, GITHUB_DIRECTORY, ISSUE_TEMPLATE_DIRECTORY);
    if (!optionalDirectorySync(directory))
        return [];
    const entries = readDirectorySync(directory);
    return collectDirectoryTemplates(directory, entries, "issue").map((entryPath) => toRepositoryPath(repositoryRoot, entryPath));
}
async function discoverPullRequestTemplates(repositoryRoot) {
    const discovered = await Promise.all(PULL_REQUEST_TEMPLATE_LOCATIONS.map((location) => discoverPullRequestTemplatesAtLocation(repositoryRoot, location)));
    return discovered.flat();
}
function discoverPullRequestTemplatesSync(repositoryRoot) {
    return PULL_REQUEST_TEMPLATE_LOCATIONS.flatMap((location) => discoverPullRequestTemplatesAtLocationSync(repositoryRoot, location));
}
async function discoverPullRequestTemplatesAtLocation(repositoryRoot, location) {
    const parent = path.join(repositoryRoot, location);
    if (!(await optionalDirectory(parent)))
        return [];
    const entries = await readDirectory(parent);
    const templates = [];
    for (const entry of entries) {
        const entryPath = path.join(parent, entry.name);
        if (isDefaultPullRequestTemplateFilename(entry.name)) {
            if (!entry.isFile()) {
                throw new TemplateFilesystemError(`Expected a regular file at ${entryPath}.`, {
                    path: entryPath,
                    reason: entry.isSymbolicLink() ? "symbolic link" : "not a regular file",
                });
            }
            templates.push(toRepositoryPath(repositoryRoot, entryPath));
            continue;
        }
        if (sameName(entry.name, PULL_REQUEST_TEMPLATE_DIRECTORY)) {
            if (!entry.isDirectory()) {
                throw new TemplateFilesystemError(`Expected a directory at ${entryPath}.`, {
                    path: entryPath,
                    reason: entry.isSymbolicLink() ? "symbolic link" : "not a directory",
                });
            }
            const children = await readDirectory(entryPath);
            templates.push(...collectDirectoryTemplates(entryPath, children, "pull-request").map((childPath) => toRepositoryPath(repositoryRoot, childPath)));
        }
    }
    return templates;
}
function discoverPullRequestTemplatesAtLocationSync(repositoryRoot, location) {
    const parent = path.join(repositoryRoot, location);
    if (!optionalDirectorySync(parent))
        return [];
    const entries = readDirectorySync(parent);
    const templates = [];
    for (const entry of entries) {
        const entryPath = path.join(parent, entry.name);
        if (isDefaultPullRequestTemplateFilename(entry.name)) {
            if (!entry.isFile()) {
                throw new TemplateFilesystemError(`Expected a regular file at ${entryPath}.`, {
                    path: entryPath,
                    reason: entry.isSymbolicLink() ? "symbolic link" : "not a regular file",
                });
            }
            templates.push(toRepositoryPath(repositoryRoot, entryPath));
            continue;
        }
        if (sameName(entry.name, PULL_REQUEST_TEMPLATE_DIRECTORY)) {
            if (!entry.isDirectory()) {
                throw new TemplateFilesystemError(`Expected a directory at ${entryPath}.`, {
                    path: entryPath,
                    reason: entry.isSymbolicLink() ? "symbolic link" : "not a directory",
                });
            }
            const children = readDirectorySync(entryPath);
            templates.push(...collectDirectoryTemplates(entryPath, children, "pull-request").map((childPath) => toRepositoryPath(repositoryRoot, childPath)));
        }
    }
    return templates;
}
function collectDirectoryTemplates(directory, entries, kind) {
    const templates = [];
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (!entry.isFile()) {
            throw new TemplateFilesystemError(`Template location contains a non-regular entry: ${entryPath}.`, {
                path: entryPath,
                reason: entry.isDirectory() ? "nested directory" : "symbolic link or special file",
            });
        }
        const candidate = kind === "issue" ? classifyIssueTemplate(entry.name) : classifyPullRequestTemplate(entry.name);
        if (candidate === undefined)
            continue;
        templates.push(entryPath);
    }
    return templates;
}
function classifyIssueTemplate(fileName) {
    if (CONFIG_TEMPLATE_NAMES.has(fileName.toLowerCase()))
        return undefined;
    const extension = normalizedExtension(fileName);
    if (!ISSUE_TEMPLATE_EXTENSIONS.has(extension))
        return undefined;
    if (extension === ".md")
        return { type: "issue-markdown" };
    return { type: "issue-form" };
}
function classifyPullRequestTemplate(fileName) {
    return hasPullRequestTemplateExtension(fileName) ? { type: "pull-request" } : undefined;
}
function hasPullRequestTemplateExtension(fileName) {
    return PULL_REQUEST_TEMPLATE_EXTENSIONS.has(normalizedExtension(fileName));
}
function isDefaultPullRequestTemplateFilename(fileName) {
    const extension = normalizedExtension(fileName);
    return (hasPullRequestTemplateExtension(fileName) &&
        sameName(fileName.slice(0, -extension.length), DEFAULT_PULL_REQUEST_TEMPLATE));
}
function normalizedExtension(fileName) {
    return path.extname(fileName).toLowerCase();
}
function createIdentityFromRepositoryPath(relativePath, type) {
    const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    const extension = path.extname(fileName);
    const name = type === "pull-request-default" ? "default" : fileName.slice(0, -extension.length);
    if (name.trim().length === 0) {
        throw new TemplateFilesystemError(`Template filename has no selectable name: ${relativePath}.`, {
            path: relativePath,
            reason: "empty template name",
        });
    }
    const identity = {
        id: `${type}:${relativePath}`,
        type,
        kind: type.startsWith("issue") ? "issue" : "pull-request",
        name,
        path: relativePath,
    };
    return Object.freeze(identity);
}
function normalizeRepositoryPath(templatePath) {
    const normalized = templatePath.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (normalized.length === 0 ||
        normalized.startsWith("/") ||
        parts.some((part) => part.length === 0 || part === "." || part === "..")) {
        throw new TemplateFilesystemError(`Template path is not a normalized repository-relative path: ${templatePath}.`, {
            path: templatePath,
            reason: "invalid repository-relative path",
        });
    }
    return normalized;
}
function toRepositoryPath(repositoryRoot, absolutePath) {
    return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}
function createDiscoveryResult(repositoryRoot, templates) {
    const sortedTemplates = [...templates].sort((left, right) => compareStrings(left.id, right.id));
    assertUniqueIds(sortedTemplates);
    const issueTemplates = sortedTemplates.filter((template) => template.kind === "issue");
    const pullRequestTemplates = sortedTemplates.filter((template) => template.kind === "pull-request");
    return Object.freeze({
        repositoryRoot,
        templates: Object.freeze(sortedTemplates),
        issueTemplates: Object.freeze(issueTemplates),
        pullRequestTemplates: Object.freeze(pullRequestTemplates),
    });
}
function assertUniqueIds(templates) {
    for (let index = 1; index < templates.length; index += 1) {
        if (templates[index - 1]?.id === templates[index]?.id) {
            const duplicate = templates[index];
            throw new TemplateDiscoveryError("TEMPLATE_ID_CONFLICT", `Repository-native template identity is duplicated: ${duplicate?.id ?? "unknown"}.`, { candidates: duplicate === undefined ? [] : [duplicate] });
        }
    }
}
function emptyDiscovery(repositoryRoot) {
    return createDiscoveryResult(repositoryRoot, []);
}
function selectFromCandidates(candidates, selector) {
    if ((typeof selector === "string" && selector.trim().length === 0) ||
        (selector !== undefined && typeof selector !== "string" && !isTemplateSelectorValue(selector))) {
        throw new InvalidTemplateSelectorError(selector);
    }
    try {
        return resolveTemplateSync({
            candidates: candidates.map(nativeTemplateResolutionCandidate),
            selector,
        });
    }
    catch (error) {
        if (!(error instanceof TemplateResolutionError))
            throw error;
        if (error.code === "TEMPLATE_RESOLUTION_NO_CANDIDATES")
            throw new TemplateNotFoundError(selector, []);
        if (error.code === "TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS") {
            if (error.details.match === "name")
                throw new TemplateNameConflictError(selector, candidates);
            throw new TemplateSelectionAmbiguousError(selector, candidates);
        }
        if (error.code === "TEMPLATE_RESOLUTION_SELECTOR_NOT_FOUND")
            throw new TemplateNotFoundError(selector, []);
        if (error.code === "TEMPLATE_RESOLUTION_AMBIGUOUS")
            throw new TemplateSelectionAmbiguousError(selector, candidates);
        throw error;
    }
}
function sameName(left, right) {
    return canonicalName(left) === canonicalName(right);
}
function canonicalName(name) {
    return name.normalize("NFC").toLocaleLowerCase("en-US");
}
function selectorLabel(selector) {
    if (selector === undefined)
        return "the default selection";
    if (typeof selector === "string")
        return JSON.stringify(selector);
    const value = selector.id ?? selector.path ?? selector.name ?? selector.type ?? selector.kind;
    return value === undefined ? "the requested selector" : JSON.stringify(value);
}
function compareStrings(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
async function optionalDirectory(directory) {
    const stats = await optionalStats(directory);
    if (stats === undefined)
        return false;
    if (!stats.isDirectory()) {
        throw new TemplateFilesystemError(`Expected a directory at ${directory}.`, {
            path: directory,
            reason: stats.isSymbolicLink() ? "symbolic link" : "not a directory",
        });
    }
    return true;
}
function optionalDirectorySync(directory) {
    const stats = optionalStatsSync(directory);
    if (stats === undefined)
        return false;
    if (!stats.isDirectory()) {
        throw new TemplateFilesystemError(`Expected a directory at ${directory}.`, {
            path: directory,
            reason: stats.isSymbolicLink() ? "symbolic link" : "not a directory",
        });
    }
    return true;
}
async function optionalRegularFile(filePath) {
    const stats = await optionalStats(filePath);
    if (stats === undefined)
        return false;
    if (!stats.isFile()) {
        throw new TemplateFilesystemError(`Expected a regular file at ${filePath}.`, {
            path: filePath,
            reason: stats.isSymbolicLink() ? "symbolic link" : "not a regular file",
        });
    }
    return true;
}
function optionalRegularFileSync(filePath) {
    const stats = optionalStatsSync(filePath);
    if (stats === undefined)
        return false;
    if (!stats.isFile()) {
        throw new TemplateFilesystemError(`Expected a regular file at ${filePath}.`, {
            path: filePath,
            reason: stats.isSymbolicLink() ? "symbolic link" : "not a regular file",
        });
    }
    return true;
}
async function optionalStats(targetPath) {
    try {
        return await lstat(targetPath);
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return undefined;
        throw new TemplateFilesystemError(`Cannot inspect repository-native template path: ${targetPath}.`, {
            path: targetPath,
            reason: "filesystem access error",
        }, error);
    }
}
function optionalStatsSync(targetPath) {
    try {
        return lstatSync(targetPath);
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return undefined;
        throw new TemplateFilesystemError(`Cannot inspect repository-native template path: ${targetPath}.`, {
            path: targetPath,
            reason: "filesystem access error",
        }, error);
    }
}
async function assertDirectory(directory, label) {
    const stats = await optionalStats(directory);
    if (stats === undefined) {
        throw new TemplateFilesystemError(`Expected ${label} to exist at ${directory}.`, {
            path: directory,
            reason: "missing",
        });
    }
    if (!stats.isDirectory()) {
        throw new TemplateFilesystemError(`Expected ${label} to be a directory at ${directory}.`, {
            path: directory,
            reason: stats.isSymbolicLink() ? "symbolic link" : "not a directory",
        });
    }
}
function assertDirectorySync(directory, label) {
    const stats = optionalStatsSync(directory);
    if (stats === undefined) {
        throw new TemplateFilesystemError(`Expected ${label} to exist at ${directory}.`, {
            path: directory,
            reason: "missing",
        });
    }
    if (!stats.isDirectory()) {
        throw new TemplateFilesystemError(`Expected ${label} to be a directory at ${directory}.`, {
            path: directory,
            reason: stats.isSymbolicLink() ? "symbolic link" : "not a directory",
        });
    }
}
async function readDirectory(directory) {
    try {
        return await readdir(directory, { withFileTypes: true });
    }
    catch (error) {
        throw new TemplateFilesystemError(`Cannot read repository-native template directory: ${directory}.`, {
            path: directory,
            reason: "filesystem access error",
        }, error);
    }
}
function readDirectorySync(directory) {
    try {
        return readdirSync(directory, { withFileTypes: true });
    }
    catch (error) {
        throw new TemplateFilesystemError(`Cannot read repository-native template directory: ${directory}.`, {
            path: directory,
            reason: "filesystem access error",
        }, error);
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=template-discovery.js.map