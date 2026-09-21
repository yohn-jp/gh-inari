/**
 * Repository-bound release preparation.
 *
 * The release-preparation-plan module is deliberately provider neutral. This
 * module is the small local adapter that reads this repository's declared
 * version contract, writes the projected files, and runs the fixed package
 * verification command. It never commits, pushes, tags, publishes, or calls
 * GitHub.
 */

import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  planReleasePreparation,
  type ReleaseHistoryEvidence,
  type ReleasePreparationPlan,
  type ReleasePreparationRepositoryContract,
  type ReleaseVersionIntent,
} from "./release-preparation-plan.js";

const execFileAsync = promisify(execFile);

export const RELEASE_PREPARATION_OPERATION = "release.prepare" as const;
export const RELEASE_PUBLICATION_ISSUE = 926 as const;
export const RELEASE_DOCUMENT_DIRECTORY = "docs/releases" as const;
export const RELEASE_VERIFICATION = Object.freeze({ command: "pnpm", args: ["run", "verify"] as const });

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_DOCUMENTS = 100;
const VERSION_LINE = /^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/mu;
const LOCK_IMPORTER = /(^  \.:\n)([\s\S]*?)(?=^  \S|$)/mu;
const LOCK_VERSION_LINE = /^([ \t]{4}version[ \t]*:[ \t]*)([^\s#]+)([ \t]*(?:#.*)?)$/mu;
const SAFE_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA = /^[0-9a-f]{7,128}$/iu;
const RELEASE_MARKER = "<!-- inari:release-preparation ";

type JsonRecord = Record<string, unknown>;

export interface ReleasePreparationVerificationResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly status: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ReleasePreparationVerificationRunner {
  (command: string, args: readonly string[], cwd: string): Promise<ReleasePreparationVerificationResult>;
}

export interface ReleasePreparationWorkspaceInput {
  readonly repositoryRoot: string;
  readonly plan: ReleasePreparationPlan;
  readonly runVerification?: ReleasePreparationVerificationRunner;
}

export interface ReleasePreparationResult {
  readonly ok: true;
  readonly operation: typeof RELEASE_PREPARATION_OPERATION;
  readonly branch: string;
  readonly identity: ReleasePreparationPlan["identity"];
  readonly previousRelease: ReleasePreparationPlan["identity"]["previousRelease"];
  readonly targetVersion: string;
  readonly source: ReleasePreparationPlan["identity"]["targetSource"];
  readonly includedChanges: ReleasePreparationPlan["includedChanges"];
  readonly changedPaths: readonly string[];
  readonly publication: ReleasePreparationPlan["publication"];
  readonly publicationHandoff: {
    readonly kind: "governed-pull-request";
    readonly sourceIssue: typeof RELEASE_PUBLICATION_ISSUE;
  };
  readonly verification: ReleasePreparationVerificationResult;
  readonly planDigest: string;
  readonly idempotent: boolean;
}

export interface ReleasePreparationInput {
  readonly repositoryRoot: string;
  readonly history: ReleaseHistoryEvidence;
  readonly intent: ReleaseVersionIntent | ReleaseVersionIntent["kind"];
  readonly runVerification?: ReleasePreparationVerificationRunner;
}

export class ReleasePreparationError extends Error {
  readonly code: string;
  readonly diagnostics: readonly string[];

  constructor(code: string, message: string, diagnostics: readonly string[] = []) {
    super(message);
    this.name = "ReleasePreparationError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
}

interface ExistingReleaseMarker {
  readonly targetVersion: string;
  readonly sourceRevision: string;
  readonly previousVersion: string;
  readonly planDigest: string;
}

interface RepositoryFiles {
  readonly packageJson: JsonRecord;
  readonly pluginJson: JsonRecord;
  readonly marketplaceJson: JsonRecord;
  readonly packageVersion: string;
  readonly lockVersion: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeRoot(repositoryRoot: string): string {
  const root = path.resolve(repositoryRoot);
  if (root === path.parse(root).root)
    throw new ReleasePreparationError("RELEASE_WORKSPACE_INVALID", "Repository root must not be the filesystem root.");
  return root;
}

function relativePath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new ReleasePreparationError("RELEASE_WORKSPACE_INVALID", `Unsafe release path "${candidate}".`);
  return relative.split(path.sep).join("/");
}

async function readBounded(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  if (buffer.byteLength > MAX_FILE_BYTES)
    throw new ReleasePreparationError("RELEASE_WORKSPACE_INVALID", `Release input is too large: ${filePath}.`);
  return buffer.toString("utf8");
}

async function readJson(filePath: string): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBounded(filePath)) as unknown;
  } catch (error: unknown) {
    throw new ReleasePreparationError(
      "RELEASE_WORKSPACE_CONFLICT",
      `Cannot read release metadata ${filePath}: ${errorMessage(error)}.`,
    );
  }
  if (!isRecord(parsed))
    throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", `Release metadata ${filePath} must be an object.`);
  return parsed;
}

function jsonVersion(value: JsonRecord, filePath: string): string {
  if (typeof value.version !== "string" || !SAFE_VERSION.test(value.version))
    throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", `${filePath} has no valid package version.`);
  return value.version;
}

function marketplaceVersion(value: JsonRecord): string {
  const plugins = value.plugins;
  const source =
    Array.isArray(plugins) && isRecord(plugins[0]) && isRecord(plugins[0].source) ? plugins[0].source : undefined;
  if (source === undefined || typeof source.version !== "string" || !source.version.startsWith("^"))
    throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", "Marketplace source version is missing.");
  const version = source.version.slice(1);
  if (!SAFE_VERSION.test(version))
    throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", "Marketplace source version is invalid.");
  return source.version;
}

function lockMetadata(lockfile: string, fallback: string): { readonly version: string; readonly hasVersion: boolean } {
  const importer = LOCK_IMPORTER.exec(lockfile)?.[2];
  if (importer === undefined)
    throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", "pnpm-lock.yaml has no root importer.");
  const match = LOCK_VERSION_LINE.exec(importer);
  if (match === null) return { version: fallback, hasVersion: false };
  const version = match[2]?.trim();
  if (version === undefined || !SAFE_VERSION.test(version))
    throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", "pnpm-lock.yaml package version is invalid.");
  return { version, hasVersion: true };
}

async function readRepositoryFiles(root: string): Promise<RepositoryFiles> {
  const packageJson = await readJson(path.join(root, "package.json"));
  const pluginJson = await readJson(path.join(root, ".codex-plugin", "plugin.json"));
  const marketplaceJson = await readJson(path.join(root, ".agents", "plugins", "marketplace.json"));
  const packageVersion = jsonVersion(packageJson, "package.json");
  const pluginVersion = jsonVersion(pluginJson, ".codex-plugin/plugin.json");
  const marketplace = marketplaceVersion(marketplaceJson);
  const lock = lockMetadata(await readBounded(path.join(root, "pnpm-lock.yaml")), packageVersion);
  if (pluginVersion !== packageVersion || marketplace !== `^${packageVersion}` || lock.version !== packageVersion)
    throw new ReleasePreparationError(
      "RELEASE_WORKSPACE_CONFLICT",
      "Version-bearing repository metadata is already divergent.",
      [
        `package.json=${packageVersion}`,
        `.codex-plugin/plugin.json=${pluginVersion}`,
        `.agents/plugins/marketplace.json=${marketplace}`,
        `pnpm-lock.yaml=${lock.version}`,
      ],
    );
  return {
    packageJson,
    pluginJson,
    marketplaceJson,
    packageVersion,
    lockVersion: lock.version,
  };
}

function repositoryContract(files: RepositoryFiles): ReleasePreparationRepositoryContract {
  const current = files.packageVersion;
  return {
    packageName: typeof files.packageJson.name === "string" ? files.packageJson.name : "gh-inari",
    currentVersion: current,
    versionBearingArtifacts: [
      { path: "package.json", kind: "package", field: "version", currentValue: current, format: "exact" },
      {
        path: "pnpm-lock.yaml",
        kind: "lockfile",
        field: "importers..version",
        currentValue: files.lockVersion,
        format: "exact",
      },
      {
        path: ".codex-plugin/plugin.json",
        kind: "codex-plugin",
        field: "version",
        currentValue: typeof files.pluginJson.version === "string" ? files.pluginJson.version : current,
        format: "exact",
      },
      {
        path: ".agents/plugins/marketplace.json",
        kind: "marketplace",
        field: "plugins[0].source.version",
        currentValue: marketplaceVersion(files.marketplaceJson),
        format: "caret",
      },
    ],
    releaseDocumentDirectory: RELEASE_DOCUMENT_DIRECTORY,
    verification: RELEASE_VERIFICATION,
    publication: { kind: "governed-pull-request", sourceIssue: RELEASE_PUBLICATION_ISSUE },
  };
}

export async function readReleasePreparationRepositoryContract(
  repositoryRoot: string,
): Promise<ReleasePreparationRepositoryContract> {
  const root = safeRoot(repositoryRoot);
  return repositoryContract(await readRepositoryFiles(root));
}

function parseMarker(content: string): ExistingReleaseMarker | undefined {
  const escapedMarker = RELEASE_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escapedMarker}([^\\n]+) -->`, "u").exec(content);
  if (match === null) return undefined;
  try {
    const parsed = JSON.parse(match[1] ?? "") as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.targetVersion !== "string" ||
      !SAFE_VERSION.test(parsed.targetVersion) ||
      typeof parsed.previousVersion !== "string" ||
      !SAFE_VERSION.test(parsed.previousVersion) ||
      typeof parsed.sourceRevision !== "string" ||
      !SHA.test(parsed.sourceRevision) ||
      typeof parsed.planDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(parsed.planDigest)
    )
      return undefined;
    return {
      targetVersion: parsed.targetVersion,
      previousVersion: parsed.previousVersion,
      sourceRevision: parsed.sourceRevision,
      planDigest: parsed.planDigest,
    };
  } catch {
    return undefined;
  }
}

async function findExistingMarker(root: string, sourceRevision: string): Promise<ExistingReleaseMarker | undefined> {
  const directory = path.join(root, RELEASE_DOCUMENT_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const markers: ExistingReleaseMarker[] = [];
  for (const entry of entries.slice(0, MAX_RELEASE_DOCUMENTS)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const marker = parseMarker(await readBounded(path.join(directory, entry.name)));
    if (marker?.sourceRevision === sourceRevision) markers.push(marker);
  }
  if (markers.length === 0) return undefined;
  const first = markers[0] as ExistingReleaseMarker;
  if (markers.some((marker) => marker.targetVersion !== first.targetVersion || marker.planDigest !== first.planDigest))
    throw new ReleasePreparationError("RELEASE_TARGET_CONFLICT", "Multiple prepared release identities conflict.");
  return first;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], { cwd: root, shell: false, maxBuffer: 256 * 1024 });
    return String(result.stdout).trim();
  } catch (error: unknown) {
    throw new ReleasePreparationError(
      "RELEASE_GIT_UNAVAILABLE",
      `Git ${args.join(" ")} failed: ${errorMessage(error)}.`,
    );
  }
}

async function gitStatus(root: string): Promise<readonly GitStatusEntry[]> {
  let output: string;
  try {
    const result = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], {
      cwd: root,
      shell: false,
      maxBuffer: 256 * 1024,
    });
    output = String(result.stdout);
  } catch (error: unknown) {
    throw new ReleasePreparationError("RELEASE_GIT_UNAVAILABLE", `Git status failed: ${errorMessage(error)}.`);
  }
  const entries: GitStatusEntry[] = [];
  for (const record of output.split("\0")) {
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const candidate = record.slice(3);
    entries.push({ status, path: candidate.split(path.sep).join("/") });
  }
  return entries;
}

function releaseDocument(plan: ReleasePreparationPlan): string {
  const marker = {
    version: 1,
    targetVersion: plan.identity.targetVersion,
    previousVersion: plan.identity.previousRelease.version,
    sourceRevision: plan.identity.targetSource.sourceRevision,
    planDigest: plan.digest,
  };
  const changes = plan.includedChanges
    .map((change) => {
      const title = change.title.replace(/[\r\n]+/gu, " ").trim();
      return `- #${change.number}: ${title} (${change.mergeCommitSha})`;
    })
    .join("\n");
  return [
    `# Release ${plan.identity.targetVersion}`,
    "",
    `${RELEASE_MARKER}${JSON.stringify(marker)} -->`,
    "",
    "## Summary",
    "",
    `Prepared from ${plan.identity.targetSource.ref} at ${plan.identity.targetSource.sourceRevision}; previous release ${plan.identity.previousRelease.tag} (${plan.identity.previousRelease.sourceRevision}).`,
    "",
    "## Included changes",
    "",
    changes === "" ? "No governed changes were included." : changes,
    "",
    "## Verification",
    "",
    `The fixed command \`${[plan.verification.command, ...plan.verification.args].join(" ")}\` passed before publication handoff.`,
    "",
  ].join("\n");
}

function replaceJsonVersion(content: string, target: string, filePath: string): string {
  if (!VERSION_LINE.test(content))
    throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", `${filePath} has no writable version field.`);
  return content.replace(VERSION_LINE, `$1${target}$2`);
}

function replaceLockVersion(content: string, target: string): string {
  const importer = LOCK_IMPORTER.exec(content);
  if (importer === null)
    throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", "pnpm-lock.yaml has no root importer.");
  if (LOCK_VERSION_LINE.test(importer[2] ?? "")) {
    const nextImporter = (importer[2] ?? "").replace(LOCK_VERSION_LINE, `$1${target}$3`);
    return (
      content.slice(0, importer.index + (importer[1]?.length ?? 0)) +
      nextImporter +
      content.slice(importer.index + importer[0].length)
    );
  }
  const insertion = `    version: ${target}\n`;
  const start = (importer.index ?? 0) + (importer[1]?.length ?? 0);
  return content.slice(0, start) + insertion + content.slice(start);
}

function artifactContent(artifact: ReleasePreparationPlan["versionArtifacts"][number], original: string): string {
  if (artifact.kind === "lockfile") return replaceLockVersion(original, artifact.targetValue);
  if (artifact.kind === "marketplace") return replaceJsonVersion(original, artifact.targetValue, artifact.path);
  return replaceJsonVersion(original, artifact.targetValue, artifact.path);
}

async function readExisting(
  root: string,
  relative: string,
): Promise<{ readonly exists: boolean; readonly content: string }> {
  const filePath = path.join(root, relative);
  try {
    await access(filePath, fsConstants.R_OK);
    return { exists: true, content: await readBounded(filePath) };
  } catch {
    return { exists: false, content: "" };
  }
}

async function writeFiles(
  root: string,
  desired: ReadonlyMap<string, string>,
  originals: ReadonlyMap<string, { readonly exists: boolean; readonly content: string }>,
): Promise<void> {
  try {
    for (const [relative, content] of desired) {
      const filePath = path.join(root, relativePath(root, relative));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    }
  } catch (error: unknown) {
    await restoreFiles(root, originals);
    throw new ReleasePreparationError(
      "RELEASE_WRITE_FAILED",
      `Release preparation could not write all files: ${errorMessage(error)}.`,
    );
  }
}

async function restoreFiles(
  root: string,
  originals: ReadonlyMap<string, { readonly exists: boolean; readonly content: string }>,
): Promise<void> {
  for (const [relative, original] of originals) {
    const filePath = path.join(root, relativePath(root, relative));
    try {
      if (original.exists) await writeFile(filePath, original.content, "utf8");
      else await rm(filePath, { force: true });
    } catch {
      // The original failure remains authoritative; best-effort rollback avoids
      // masking it while preserving the no-partial-success contract where possible.
    }
  }
}

async function defaultVerification(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<ReleasePreparationVerificationResult> {
  try {
    const result = await execFileAsync(command, [...args], { cwd, shell: false, maxBuffer: 2 * 1024 * 1024 });
    return { command, args: [...args], status: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error: unknown) {
    const typed = error as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown };
    const status = typeof typed.code === "number" ? typed.code : 1;
    return {
      command,
      args: [...args],
      status,
      stdout: typeof typed.stdout === "string" ? typed.stdout : undefined,
      stderr: typeof typed.stderr === "string" ? typed.stderr : errorMessage(error),
    };
  }
}

function expectedPaths(plan: ReleasePreparationPlan): readonly string[] {
  return [...plan.versionArtifacts.map((artifact) => artifact.path), plan.releaseDocument.path]
    .map((entry) => entry.split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en-US"));
}

function assertFixedVerification(plan: ReleasePreparationPlan): void {
  if (
    plan.verification.command !== RELEASE_VERIFICATION.command ||
    plan.verification.args.length !== RELEASE_VERIFICATION.args.length ||
    plan.verification.args.some((arg, index) => arg !== RELEASE_VERIFICATION.args[index])
  )
    throw new ReleasePreparationError(
      "RELEASE_VERIFICATION_INVALID",
      "Release verification must be fixed to pnpm run verify.",
    );
}

/** Apply one already validated release plan to a clean exact-source worktree. */
export async function prepareReleaseWorkspace(
  input: ReleasePreparationWorkspaceInput,
): Promise<ReleasePreparationResult> {
  const root = safeRoot(input.repositoryRoot);
  assertFixedVerification(input.plan);
  const sourceRevision = await git(root, ["rev-parse", "HEAD"]);
  if (sourceRevision !== input.plan.identity.targetSource.sourceRevision)
    throw new ReleasePreparationError(
      "RELEASE_SOURCE_CONFLICT",
      `Workspace source ${sourceRevision} does not match planned source ${input.plan.identity.targetSource.sourceRevision}.`,
    );
  const branch = await git(root, ["branch", "--show-current"]);
  const paths = expectedPaths(input.plan);
  const status = await gitStatus(root);
  const originals = new Map<string, { readonly exists: boolean; readonly content: string }>();
  const desired = new Map<string, string>();
  for (const artifact of input.plan.versionArtifacts) {
    const relative = relativePath(root, artifact.path);
    const original = await readExisting(root, relative);
    if (!original.exists)
      throw new ReleasePreparationError("RELEASE_WORKSPACE_CONFLICT", `Missing release artifact ${relative}.`);
    originals.set(relative, original);
    desired.set(relative, artifactContent(artifact, original.content));
  }
  const documentPath = relativePath(root, input.plan.releaseDocument.path);
  const existingDocument = await readExisting(root, documentPath);
  originals.set(documentPath, existingDocument);
  desired.set(documentPath, releaseDocument(input.plan));
  const isPrepared =
    status.length > 0 &&
    status.every((entry) => paths.includes(entry.path)) &&
    [...desired].every(([relative, content]) => {
      const original = originals.get(relative);
      return original !== undefined && original.exists && original.content === content;
    });
  if (status.length > 0 && !isPrepared)
    throw new ReleasePreparationError(
      "RELEASE_WORKSPACE_DIRTY",
      "Release preparation requires a clean exact-source worktree.",
    );
  const alreadyPrepared = [...desired].every(([relative, content]) => originals.get(relative)?.content === content);
  if (!alreadyPrepared) await writeFiles(root, desired, originals);
  let verify: ReleasePreparationVerificationResult;
  try {
    verify = await (input.runVerification ?? defaultVerification)(
      input.plan.verification.command,
      input.plan.verification.args,
      root,
    );
  } catch (error: unknown) {
    if (!alreadyPrepared) await restoreFiles(root, originals);
    throw new ReleasePreparationError(
      "RELEASE_VERIFICATION_FAILED",
      `pnpm run verify could not complete: ${errorMessage(error)}.`,
    );
  }
  if (verify.status !== 0) {
    if (!alreadyPrepared) await restoreFiles(root, originals);
    throw new ReleasePreparationError(
      "RELEASE_VERIFICATION_FAILED",
      "pnpm run verify failed before release readiness.",
      [
        `status=${verify.status}`,
        ...(verify.stderr === undefined || verify.stderr.trim() === ""
          ? []
          : [verify.stderr.trim().split(/\r?\n/u)[0] as string]),
      ],
    );
  }
  return {
    ok: true,
    operation: RELEASE_PREPARATION_OPERATION,
    branch,
    identity: input.plan.identity,
    previousRelease: input.plan.identity.previousRelease,
    targetVersion: input.plan.identity.targetVersion,
    source: input.plan.identity.targetSource,
    includedChanges: input.plan.includedChanges,
    changedPaths: paths,
    publication: input.plan.publication,
    publicationHandoff: { kind: "governed-pull-request", sourceIssue: RELEASE_PUBLICATION_ISSUE },
    verification: verify,
    planDigest: input.plan.digest,
    idempotent: alreadyPrepared,
  };
}

/** Read current repository evidence, project #928's plan, and prepare locally. */
export async function prepareRelease(input: ReleasePreparationInput): Promise<ReleasePreparationResult> {
  const root = safeRoot(input.repositoryRoot);
  const history = input.history;
  const files = await readRepositoryFiles(root);
  const marker = await findExistingMarker(root, history.targetSource.sourceRevision);
  if (marker !== undefined && files.packageVersion === history.previousRelease.version)
    throw new ReleasePreparationError(
      "RELEASE_TARGET_CONFLICT",
      "A prepared release marker exists while the workspace still has the previous version.",
    );
  let repository = repositoryContract(files);
  if (files.packageVersion !== history.previousRelease.version) {
    if (
      marker === undefined ||
      marker.targetVersion !== files.packageVersion ||
      marker.previousVersion !== history.previousRelease.version
    )
      throw new ReleasePreparationError(
        "RELEASE_TARGET_CONFLICT",
        "Workspace version differs from the previous release without matching prepared state.",
      );
    for (const artifact of repository.versionBearingArtifacts) {
      if (artifact.currentValue !== (artifact.format === "caret" ? `^${files.packageVersion}` : files.packageVersion))
        throw new ReleasePreparationError(
          "RELEASE_TARGET_CONFLICT",
          `Prepared artifact ${artifact.path} is divergent.`,
        );
    }
    repository = {
      ...repository,
      currentVersion: history.previousRelease.version,
      versionBearingArtifacts: repository.versionBearingArtifacts.map((artifact) => ({
        ...artifact,
        currentValue:
          artifact.format === "caret" ? `^${history.previousRelease.version}` : history.previousRelease.version,
      })),
    };
  }
  const plan = planReleasePreparation({ history, intent: input.intent, repository });
  if (
    marker !== undefined &&
    (marker.targetVersion !== plan.identity.targetVersion || marker.planDigest !== plan.digest)
  )
    throw new ReleasePreparationError(
      "RELEASE_TARGET_CONFLICT",
      "Existing prepared release state conflicts with the requested intent or source projection.",
    );
  return prepareReleaseWorkspace({ repositoryRoot: root, plan, runVerification: input.runVerification });
}

export const prepareNpmRelease = prepareRelease;
export const prepareNpmReleaseWorkspace = prepareReleaseWorkspace;
