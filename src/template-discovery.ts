import { lstat, readdir } from "node:fs/promises";
import { lstatSync, readdirSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_DIRECTORY = ".github";
const ISSUE_TEMPLATE_DIRECTORY = "ISSUE_TEMPLATE";
const PULL_REQUEST_TEMPLATE_DIRECTORY = "PULL_REQUEST_TEMPLATE";
const DEFAULT_PULL_REQUEST_TEMPLATE = "PULL_REQUEST_TEMPLATE.md";
const CONFIG_TEMPLATE_NAMES = new Set(["config.yml", "config.yaml"]);
const ISSUE_TEMPLATE_EXTENSIONS = new Set([".md", ".yml", ".yaml"]);
const PULL_REQUEST_TEMPLATE_EXTENSIONS = new Set([".md"]);

export type TemplateType = "issue-form" | "issue-markdown" | "pull-request-default" | "pull-request";

export type TemplateKind = "issue" | "pull-request";

export interface TemplateIdentity {
  readonly id: string;
  readonly type: TemplateType;
  readonly kind: TemplateKind;
  readonly name: string;
  readonly path: string;
}

export interface TemplateDiscoveryResult {
  readonly repositoryRoot: string;
  readonly templates: readonly TemplateIdentity[];
  readonly issueTemplates: readonly TemplateIdentity[];
  readonly pullRequestTemplates: readonly TemplateIdentity[];
}

export interface TemplateSelector {
  readonly id?: string;
  readonly type?: TemplateType;
  readonly kind?: TemplateKind;
  readonly name?: string;
  readonly path?: string;
}

export type TemplateDiscoveryErrorCode =
  | "TEMPLATE_FILESYSTEM_MALFORMED"
  | "TEMPLATE_ID_CONFLICT"
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_SELECTION_AMBIGUOUS"
  | "TEMPLATE_NAME_CONFLICT"
  | "INVALID_TEMPLATE_SELECTOR";

export interface TemplateDiscoveryErrorDetails {
  readonly path?: string;
  readonly reason?: string;
  readonly selector?: string | TemplateSelector;
  readonly candidates?: readonly TemplateIdentity[];
}

export class TemplateDiscoveryError extends Error {
  readonly code: TemplateDiscoveryErrorCode;
  readonly details: TemplateDiscoveryErrorDetails;

  constructor(
    code: TemplateDiscoveryErrorCode,
    message: string,
    details: TemplateDiscoveryErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TemplateDiscoveryError";
    this.code = code;
    this.details = details;
  }

  toJSON(): {
    code: TemplateDiscoveryErrorCode;
    message: string;
    details: TemplateDiscoveryErrorDetails;
  } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class TemplateFilesystemError extends TemplateDiscoveryError {
  constructor(message: string, details: TemplateDiscoveryErrorDetails = {}, cause?: unknown) {
    super("TEMPLATE_FILESYSTEM_MALFORMED", message, details, { cause });
    this.name = "TemplateFilesystemError";
  }
}

export class TemplateNotFoundError extends TemplateDiscoveryError {
  constructor(selector: string | TemplateSelector | undefined, candidates: readonly TemplateIdentity[]) {
    super("TEMPLATE_NOT_FOUND", `No repository-native template matches ${selectorLabel(selector)}.`, {
      selector,
      candidates,
    });
    this.name = "TemplateNotFoundError";
  }
}

export class TemplateSelectionAmbiguousError extends TemplateDiscoveryError {
  constructor(selector: string | TemplateSelector | undefined, candidates: readonly TemplateIdentity[]) {
    super("TEMPLATE_SELECTION_AMBIGUOUS", `Template selection is ambiguous for ${selectorLabel(selector)}.`, {
      selector,
      candidates,
    });
    this.name = "TemplateSelectionAmbiguousError";
  }
}

export class TemplateNameConflictError extends TemplateDiscoveryError {
  constructor(selector: string | TemplateSelector, candidates: readonly TemplateIdentity[]) {
    super(
      "TEMPLATE_NAME_CONFLICT",
      `Template name ${selectorLabel(selector)} identifies multiple repository-native templates.`,
      { selector, candidates },
    );
    this.name = "TemplateNameConflictError";
  }
}

export class InvalidTemplateSelectorError extends TemplateDiscoveryError {
  constructor(selector: unknown) {
    super("INVALID_TEMPLATE_SELECTOR", "Template selector must contain a non-empty id, type, kind, name, or path.", {
      selector: isTemplateSelectorValue(selector) ? selector : undefined,
    });
    this.name = "InvalidTemplateSelectorError";
  }
}

/**
 * Discover only the repository-native paths GitHub uses for the MVP.
 * Template contents are intentionally not read; parsing belongs to later layers.
 */
export async function discoverTemplates(
  repositoryRoot: string | URL = process.cwd(),
): Promise<TemplateDiscoveryResult> {
  const root = resolveRepositoryRoot(repositoryRoot);
  await assertDirectory(root, "repository root");

  const githubPath = path.join(root, GITHUB_DIRECTORY);
  if (!(await optionalDirectory(githubPath))) return emptyDiscovery(root);

  const [issueTemplates, pullRequestTemplates] = await Promise.all([
    discoverIssueTemplates(root),
    discoverPullRequestTemplates(root),
  ]);
  return createDiscoveryResult(root, [...issueTemplates, ...pullRequestTemplates]);
}

/** Synchronous counterpart for callers that already operate synchronously. */
export function discoverTemplatesSync(repositoryRoot: string | URL = process.cwd()): TemplateDiscoveryResult {
  const root = resolveRepositoryRoot(repositoryRoot);
  assertDirectorySync(root, "repository root");

  const githubPath = path.join(root, GITHUB_DIRECTORY);
  if (!optionalDirectorySync(githubPath)) return emptyDiscovery(root);

  const issueTemplates = discoverIssueTemplatesSync(root);
  const pullRequestTemplates = discoverPullRequestTemplatesSync(root);
  return createDiscoveryResult(root, [...issueTemplates, ...pullRequestTemplates]);
}

/**
 * Select one identity. A string first means an exact ID or path, then a name;
 * name selection is case-insensitive and fails closed when it is not unique.
 */
export function selectTemplate(
  discovery: TemplateDiscoveryResult,
  selector?: string | TemplateSelector,
): TemplateIdentity {
  return selectFromCandidates(discovery.templates, selector);
}

export function selectIssueTemplate(
  discovery: TemplateDiscoveryResult,
  selector?: string | TemplateSelector,
): TemplateIdentity {
  return selectFromCandidates(discovery.issueTemplates, selector);
}

export function selectPullRequestTemplate(
  discovery: TemplateDiscoveryResult,
  selector?: string | TemplateSelector,
): TemplateIdentity {
  return selectFromCandidates(discovery.pullRequestTemplates, selector);
}

function resolveRepositoryRoot(repositoryRoot: string | URL): string {
  const root = typeof repositoryRoot === "string" ? repositoryRoot : fileURLToPath(repositoryRoot);
  return path.resolve(root);
}

async function discoverIssueTemplates(repositoryRoot: string): Promise<TemplateIdentity[]> {
  const directory = path.join(repositoryRoot, GITHUB_DIRECTORY, ISSUE_TEMPLATE_DIRECTORY);
  if (!(await optionalDirectory(directory))) return [];
  const entries = await readDirectory(directory);
  return collectDirectoryTemplates(repositoryRoot, directory, entries, "issue");
}

function discoverIssueTemplatesSync(repositoryRoot: string): TemplateIdentity[] {
  const directory = path.join(repositoryRoot, GITHUB_DIRECTORY, ISSUE_TEMPLATE_DIRECTORY);
  if (!optionalDirectorySync(directory)) return [];
  const entries = readDirectorySync(directory);
  return collectDirectoryTemplates(repositoryRoot, directory, entries, "issue");
}

async function discoverPullRequestTemplates(repositoryRoot: string): Promise<TemplateIdentity[]> {
  const githubPath = path.join(repositoryRoot, GITHUB_DIRECTORY);
  const templates: TemplateIdentity[] = [];

  const defaultPath = path.join(githubPath, DEFAULT_PULL_REQUEST_TEMPLATE);
  if (await optionalRegularFile(defaultPath)) {
    templates.push(createIdentity(repositoryRoot, defaultPath, "pull-request-default"));
  }

  const directory = path.join(githubPath, PULL_REQUEST_TEMPLATE_DIRECTORY);
  if (await optionalDirectory(directory)) {
    const entries = await readDirectory(directory);
    templates.push(...collectDirectoryTemplates(repositoryRoot, directory, entries, "pull-request"));
  }
  return templates;
}

function discoverPullRequestTemplatesSync(repositoryRoot: string): TemplateIdentity[] {
  const githubPath = path.join(repositoryRoot, GITHUB_DIRECTORY);
  const templates: TemplateIdentity[] = [];

  const defaultPath = path.join(githubPath, DEFAULT_PULL_REQUEST_TEMPLATE);
  if (optionalRegularFileSync(defaultPath)) {
    templates.push(createIdentity(repositoryRoot, defaultPath, "pull-request-default"));
  }

  const directory = path.join(githubPath, PULL_REQUEST_TEMPLATE_DIRECTORY);
  if (optionalDirectorySync(directory)) {
    const entries = readDirectorySync(directory);
    templates.push(...collectDirectoryTemplates(repositoryRoot, directory, entries, "pull-request"));
  }
  return templates;
}

function collectDirectoryTemplates(
  repositoryRoot: string,
  directory: string,
  entries: readonly Dirent[],
  kind: "issue" | "pull-request",
): TemplateIdentity[] {
  const templates: TemplateIdentity[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (!entry.isFile()) {
      throw new TemplateFilesystemError(`Template location contains a non-regular entry: ${entryPath}.`, {
        path: entryPath,
        reason: entry.isDirectory() ? "nested directory" : "symbolic link or special file",
      });
    }

    const candidate = kind === "issue" ? classifyIssueTemplate(entry.name) : classifyPullRequestTemplate(entry.name);
    if (candidate === undefined) continue;
    templates.push(createIdentity(repositoryRoot, entryPath, candidate.type));
  }
  return templates;
}

function classifyIssueTemplate(fileName: string): { type: "issue-form" | "issue-markdown" } | undefined {
  if (CONFIG_TEMPLATE_NAMES.has(fileName.toLowerCase())) return undefined;
  const extension = normalizedExtension(fileName);
  if (!ISSUE_TEMPLATE_EXTENSIONS.has(extension)) return undefined;

  if (extension === ".md") return { type: "issue-markdown" };
  return { type: "issue-form" };
}

function classifyPullRequestTemplate(fileName: string): { type: "pull-request" } | undefined {
  return normalizedExtension(fileName) === ".md" ? { type: "pull-request" } : undefined;
}

function normalizedExtension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

function createIdentity(repositoryRoot: string, absolutePath: string, type: TemplateType): TemplateIdentity {
  const relativePath = toRepositoryPath(repositoryRoot, absolutePath);
  const fileName = path.basename(absolutePath);
  const extension = path.extname(fileName);
  const name = type === "pull-request-default" ? "default" : fileName.slice(0, -extension.length);
  if (name.trim().length === 0) {
    throw new TemplateFilesystemError(`Template filename has no selectable name: ${absolutePath}.`, {
      path: absolutePath,
      reason: "empty template name",
    });
  }

  const identity: TemplateIdentity = {
    id: `${type}:${relativePath}`,
    type,
    kind: type.startsWith("issue") ? "issue" : "pull-request",
    name,
    path: relativePath,
  };
  return Object.freeze(identity);
}

function toRepositoryPath(repositoryRoot: string, absolutePath: string): string {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

function createDiscoveryResult(
  repositoryRoot: string,
  templates: readonly TemplateIdentity[],
): TemplateDiscoveryResult {
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

function assertUniqueIds(templates: readonly TemplateIdentity[]): void {
  for (let index = 1; index < templates.length; index += 1) {
    if (templates[index - 1]?.id === templates[index]?.id) {
      const duplicate = templates[index];
      throw new TemplateDiscoveryError(
        "TEMPLATE_ID_CONFLICT",
        `Repository-native template identity is duplicated: ${duplicate?.id ?? "unknown"}.`,
        { candidates: duplicate === undefined ? [] : [duplicate] },
      );
    }
  }
}

function emptyDiscovery(repositoryRoot: string): TemplateDiscoveryResult {
  return createDiscoveryResult(repositoryRoot, []);
}

function selectFromCandidates(
  candidates: readonly TemplateIdentity[],
  selector?: string | TemplateSelector,
): TemplateIdentity {
  if (selector === undefined) return resolveSelection(candidates, selector, false);

  if (typeof selector === "string") {
    if (selector.trim().length === 0) throw new InvalidTemplateSelectorError(selector);

    const exactIdMatches = candidates.filter((candidate) => candidate.id === selector);
    if (exactIdMatches.length > 0) return resolveSelection(exactIdMatches, selector, false);

    const exactPathMatches = candidates.filter((candidate) => candidate.path === selector);
    if (exactPathMatches.length > 0) return resolveSelection(exactPathMatches, selector, false);

    const nameMatches = candidates.filter((candidate) => sameName(candidate.name, selector));
    return resolveSelection(nameMatches, selector, true);
  }

  if (!isTemplateSelectorValue(selector)) throw new InvalidTemplateSelectorError(selector);
  const entries = Object.entries(selector).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw new InvalidTemplateSelectorError(selector);

  const matches = candidates.filter((candidate) => matchesSelector(candidate, selector));
  return resolveSelection(matches, selector, "name" in selector && selector.name !== undefined);
}

function matchesSelector(candidate: TemplateIdentity, selector: TemplateSelector): boolean {
  if (selector.id !== undefined && candidate.id !== selector.id) return false;
  if (selector.type !== undefined && candidate.type !== selector.type) return false;
  if (selector.kind !== undefined && candidate.kind !== selector.kind) return false;
  if (selector.name !== undefined && !sameName(candidate.name, selector.name)) return false;
  if (selector.path !== undefined && candidate.path !== selector.path) return false;
  return true;
}

function resolveSelection(
  candidates: readonly TemplateIdentity[],
  selector: string | TemplateSelector | undefined,
  selectedByName: boolean,
): TemplateIdentity {
  if (candidates.length === 0) throw new TemplateNotFoundError(selector, candidates);
  if (candidates.length === 1) return candidates[0] as TemplateIdentity;
  if (selectedByName) throw new TemplateNameConflictError(selector as string | TemplateSelector, candidates);
  throw new TemplateSelectionAmbiguousError(selector, candidates);
}

function sameName(left: string, right: string): boolean {
  return canonicalName(left) === canonicalName(right);
}

function canonicalName(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en-US");
}

function selectorLabel(selector: string | TemplateSelector | undefined): string {
  if (selector === undefined) return "the default selection";
  if (typeof selector === "string") return JSON.stringify(selector);
  const value = selector.id ?? selector.path ?? selector.name ?? selector.type ?? selector.kind;
  return value === undefined ? "the requested selector" : JSON.stringify(value);
}

function isTemplateSelectorValue(value: unknown): value is TemplateSelector {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function optionalDirectory(directory: string): Promise<boolean> {
  const stats = await optionalStats(directory);
  if (stats === undefined) return false;
  if (!stats.isDirectory()) {
    throw new TemplateFilesystemError(`Expected a directory at ${directory}.`, {
      path: directory,
      reason: stats.isSymbolicLink() ? "symbolic link" : "not a directory",
    });
  }
  return true;
}

function optionalDirectorySync(directory: string): boolean {
  const stats = optionalStatsSync(directory);
  if (stats === undefined) return false;
  if (!stats.isDirectory()) {
    throw new TemplateFilesystemError(`Expected a directory at ${directory}.`, {
      path: directory,
      reason: stats.isSymbolicLink() ? "symbolic link" : "not a directory",
    });
  }
  return true;
}

async function optionalRegularFile(filePath: string): Promise<boolean> {
  const stats = await optionalStats(filePath);
  if (stats === undefined) return false;
  if (!stats.isFile()) {
    throw new TemplateFilesystemError(`Expected a regular file at ${filePath}.`, {
      path: filePath,
      reason: stats.isSymbolicLink() ? "symbolic link" : "not a regular file",
    });
  }
  return true;
}

function optionalRegularFileSync(filePath: string): boolean {
  const stats = optionalStatsSync(filePath);
  if (stats === undefined) return false;
  if (!stats.isFile()) {
    throw new TemplateFilesystemError(`Expected a regular file at ${filePath}.`, {
      path: filePath,
      reason: stats.isSymbolicLink() ? "symbolic link" : "not a regular file",
    });
  }
  return true;
}

async function optionalStats(targetPath: string): Promise<Stats | undefined> {
  try {
    return await lstat(targetPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new TemplateFilesystemError(
      `Cannot inspect repository-native template path: ${targetPath}.`,
      {
        path: targetPath,
        reason: "filesystem access error",
      },
      error,
    );
  }
}

function optionalStatsSync(targetPath: string): Stats | undefined {
  try {
    return lstatSync(targetPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new TemplateFilesystemError(
      `Cannot inspect repository-native template path: ${targetPath}.`,
      {
        path: targetPath,
        reason: "filesystem access error",
      },
      error,
    );
  }
}

async function assertDirectory(directory: string, label: string): Promise<void> {
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

function assertDirectorySync(directory: string, label: string): void {
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

async function readDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    throw new TemplateFilesystemError(
      `Cannot read repository-native template directory: ${directory}.`,
      {
        path: directory,
        reason: "filesystem access error",
      },
      error,
    );
  }
}

function readDirectorySync(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error: unknown) {
    throw new TemplateFilesystemError(
      `Cannot read repository-native template directory: ${directory}.`,
      {
        path: directory,
        reason: "filesystem access error",
      },
      error,
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
