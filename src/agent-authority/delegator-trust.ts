/**
 * Repository-native Delegator trust artifacts.
 *
 * The repository is the trust-policy authority for these records. This module
 * only reads the configured authoritative protected ref (the repository's
 * default branch in V1), validates every authority artifact found there, and
 * returns bounded provenance for the immutable snapshot that was used. It
 * never reads the caller's checkout or accepts a caller-supplied working ref.
 *
 * Delegator registration, rotation/revocation workflow, and delegated writes to
 * this directory belong to later governance slices. A disabled or expired
 * record remains representable in a snapshot for that governance, but cannot
 * be resolved as active authorization.
 */

import { createHash } from "node:crypto";
import {
  DELEGATOR_ARTIFACT_DIRECTORY,
  DELEGATOR_ARTIFACT_PATH_PREFIX,
  MAX_DELEGATOR_ID_LENGTH,
  DELEGATOR_ID_PATTERN,
  assertDelegator,
  canonicalDelegatorJson,
  isDelegatorActive,
  validateDelegator,
  type Delegator,
} from "./delegator.js";
import type { RepositoryGovernanceSourceReader } from "../governance.js";
import type { GitHubBranch, RepositoryContext, RepositoryTree, RepositoryTreeEntry } from "../github/types.js";

/** The structural seam used to read repository authority without consulting a local checkout. */
export interface DelegatorSourceReader extends RepositoryGovernanceSourceReader {
  /** Resolve the default branch to its immutable commit before reading its tree. */
  findBranch(branch: string): Promise<GitHubBranch | undefined>;
}

export const DELEGATOR_MAX_RECORDS = 256 as const;
/** @deprecated Compatibility spelling for the trust snapshot record bound. */
export const RUNTIME_AUTHORITY_MAX_RECORDS = DELEGATOR_MAX_RECORDS;

export type DelegatorTrustErrorCode =
  | "RUNTIME_AUTHORITY_SOURCE_UNAVAILABLE"
  | "RUNTIME_AUTHORITY_SOURCE_INVALID"
  | "RUNTIME_AUTHORITY_REPOSITORY_ID_UNAVAILABLE"
  | "RUNTIME_AUTHORITY_NOT_FOUND"
  | "RUNTIME_AUTHORITY_INACTIVE"
  | "RUNTIME_AUTHORITY_AMBIGUOUS";

export interface DelegatorTrustErrorDetails {
  readonly operation?: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly authorityId?: string;
  readonly policySha?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

/** Stable fail-closed failure for repository Delegator resolution. */
export class DelegatorTrustError extends Error {
  readonly code: DelegatorTrustErrorCode;
  readonly details: Readonly<DelegatorTrustErrorDetails>;
  readonly diagnostics: readonly unknown[];

  constructor(
    code: DelegatorTrustErrorCode,
    message: string,
    details: DelegatorTrustErrorDetails = {},
    diagnostics: readonly unknown[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DelegatorTrustError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export interface DelegatorRepositoryIdentity {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly nameWithOwner: string;
  readonly repositoryId: string;
}

export interface DelegatorArtifactSource {
  readonly path: string;
  readonly ref: string;
  /** Git blob SHA selected from the authoritative tree. */
  readonly sha: string;
  /** SHA-256 of the decoded artifact content. */
  readonly digest: string;
}

/** Provenance for the exact protected-ref trust snapshot used for admission. */
export interface DelegatorTrustProvenance {
  readonly authority: "repository-default-branch";
  readonly repository: DelegatorRepositoryIdentity;
  readonly ref: string;
  /** Immutable commit SHA resolved from the canonical protected ref. */
  readonly policySha: string;
  readonly treeSha: string;
  readonly source: DelegatorArtifactSource;
}

export interface LoadedDelegator {
  readonly authority: Delegator;
  readonly path: string;
  readonly provenance: DelegatorTrustProvenance;
}

/** All structurally valid records observed in one authoritative protected-ref generation. */
export interface DelegatorTrustSnapshot {
  readonly repository: DelegatorRepositoryIdentity;
  readonly ref: string;
  /** Immutable commit SHA resolved from `ref` for this policy snapshot. */
  readonly policySha: string;
  readonly treeSha: string;
  readonly authorities: readonly LoadedDelegator[];
}

export interface DelegatorLookupOptions {
  /** Clock used for active-window evaluation; injectable for deterministic admission/tests. */
  readonly now?: Date;
}

export interface RenderedDelegatorArtifact {
  readonly path: string;
  readonly content: string;
  readonly authority: Delegator;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function repositoryName(context: RepositoryContext): string {
  return context.nameWithOwner.length > 0 ? context.nameWithOwner : `${context.owner}/${context.name}`;
}

function requireRepositoryIdentity(context: RepositoryContext): DelegatorRepositoryIdentity {
  if (!isNonEmptyText(context.repositoryId)) {
    throw new DelegatorTrustError(
      "RUNTIME_AUTHORITY_REPOSITORY_ID_UNAVAILABLE",
      "Delegator trust cannot be established without the immutable repository database identity.",
      { operation: "repository.resolve", repository: repositoryName(context), reason: "repository ID is missing" },
    );
  }
  return {
    host: context.hostname,
    owner: context.owner,
    name: context.name,
    nameWithOwner: context.nameWithOwner,
    repositoryId: context.repositoryId,
  };
}

function validateLookupId(authorityId: string): void {
  if (
    !isNonEmptyText(authorityId) ||
    authorityId.length > MAX_DELEGATOR_ID_LENGTH ||
    !DELEGATOR_ID_PATTERN.test(authorityId)
  ) {
    throw new DelegatorTrustError(
      "RUNTIME_AUTHORITY_NOT_FOUND",
      "Delegator lookup requires a valid authority identifier.",
      { authorityId, reason: "invalid authority identifier" },
    );
  }
}

/** Return the only repository path at which an authority record may live. */
export function delegatorArtifactPath(authorityId: string): string {
  validateLookupId(authorityId);
  return `${DELEGATOR_ARTIFACT_PATH_PREFIX}${authorityId}.json`;
}

/** Render one validated public trust record into its canonical repository artifact. */
export function renderDelegatorArtifact(input: unknown): RenderedDelegatorArtifact {
  const authority = assertDelegator(input);
  return Object.freeze({
    path: delegatorArtifactPath(authority.id),
    content: canonicalDelegatorJson(authority),
    authority,
  });
}

/** Render only the canonical JSON content for a Delegator artifact. */
export function renderDelegator(input: unknown): string {
  return renderDelegatorArtifact(input).content;
}

interface AuthorityEntry {
  readonly id: string;
  readonly entry: RepositoryTreeEntry;
}

function validateTree(tree: RepositoryTree, context: DelegatorRepositoryIdentity, ref: string): void {
  if (typeof tree !== "object" || tree === null || !isNonEmptyText(tree.sha) || !Array.isArray(tree.entries)) {
    throw sourceInvalid(
      context,
      ref,
      DELEGATOR_ARTIFACT_DIRECTORY,
      !isNonEmptyText(tree?.sha) ? "tree SHA is empty" : "tree entries are missing",
    );
  }
  const paths = new Set<string>();
  for (const entry of tree.entries) {
    if (typeof entry !== "object" || entry === null) {
      throw sourceInvalid(context, ref, DELEGATOR_ARTIFACT_DIRECTORY, "tree entry is malformed");
    }
    const entryPath = typeof entry.path === "string" ? entry.path : DELEGATOR_ARTIFACT_DIRECTORY;
    if (!isNonEmptyText(entry.path) || !isNonEmptyText(entry.sha) || (entry.type !== "blob" && entry.type !== "tree")) {
      throw sourceInvalid(context, ref, entryPath, "tree entry is malformed");
    }
    if (paths.has(entry.path)) {
      throw ambiguous(context, ref, entry.path, "tree contains duplicate paths");
    }
    paths.add(entry.path);
  }
}

function discoverAuthorityEntries(
  tree: RepositoryTree,
  context: DelegatorRepositoryIdentity,
  ref: string,
): readonly AuthorityEntry[] {
  const entries: AuthorityEntry[] = [];
  const prefix = DELEGATOR_ARTIFACT_PATH_PREFIX;
  for (const entry of tree.entries) {
    if (entry.path === DELEGATOR_ARTIFACT_DIRECTORY) {
      if (entry.type !== "tree") throw sourceInvalid(context, ref, entry.path, "authority directory is not a tree");
      continue;
    }
    if (!entry.path.startsWith(prefix)) continue;

    const relative = entry.path.slice(prefix.length);
    if (entry.type !== "blob" || relative.includes("/") || !relative.endsWith(".json")) {
      throw sourceInvalid(context, ref, entry.path, "authority path must be a direct JSON blob");
    }
    const id = relative.slice(0, -".json".length);
    if (!DELEGATOR_ID_PATTERN.test(id)) {
      throw sourceInvalid(context, ref, entry.path, "authority filename is not a valid authority identifier");
    }
    entries.push({ id, entry });
  }
  if (entries.length === 0) {
    throw new DelegatorTrustError(
      "RUNTIME_AUTHORITY_NOT_FOUND",
      `No Delegator trust records were found at ${DELEGATOR_ARTIFACT_DIRECTORY} on ref "${ref}".`,
      { repository: context.nameWithOwner, ref, path: DELEGATOR_ARTIFACT_DIRECTORY },
    );
  }
  if (entries.length > DELEGATOR_MAX_RECORDS) {
    throw sourceInvalid(context, ref, DELEGATOR_ARTIFACT_DIRECTORY, "too many authority records");
  }
  return Object.freeze(entries.sort((left, right) => (left.entry.path < right.entry.path ? -1 : 1)));
}

function sourceInvalid(
  context: DelegatorRepositoryIdentity,
  ref: string,
  path: string,
  reason: string,
  diagnostics: readonly unknown[] = [],
): DelegatorTrustError {
  return new DelegatorTrustError(
    "RUNTIME_AUTHORITY_SOURCE_INVALID",
    `Delegator source at "${path}" is invalid: ${reason}.`,
    { repository: context.nameWithOwner, ref, path, reason },
    diagnostics,
  );
}

function ambiguous(
  context: DelegatorRepositoryIdentity,
  ref: string,
  path: string,
  reason: string,
): DelegatorTrustError {
  return new DelegatorTrustError(
    "RUNTIME_AUTHORITY_AMBIGUOUS",
    `Delegator trust at "${path}" is ambiguous: ${reason}.`,
    { repository: context.nameWithOwner, ref, path, reason },
  );
}

async function readSource<T>(
  operation: string,
  context: DelegatorRepositoryIdentity | undefined,
  ref: string | undefined,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof DelegatorTrustError) throw error;
    throw new DelegatorTrustError(
      "RUNTIME_AUTHORITY_SOURCE_UNAVAILABLE",
      `Unable to establish Delegator trust during ${operation}.`,
      {
        operation,
        ...(context === undefined ? {} : { repository: context.nameWithOwner }),
        ...(ref === undefined ? {} : { ref }),
        reason: error instanceof Error ? error.message : "repository source read failed",
      },
      [],
      { cause: error },
    );
  }
}

function parseAuthorityBlob(
  source: string,
  authorityEntry: AuthorityEntry,
  context: DelegatorRepositoryIdentity,
  ref: string,
): Delegator {
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    throw sourceInvalid(context, ref, authorityEntry.entry.path, "artifact is not valid JSON");
  }
  const validation = validateDelegator(raw, "$");
  if (!validation.valid || validation.value === undefined) {
    throw sourceInvalid(
      context,
      ref,
      authorityEntry.entry.path,
      "artifact failed Delegator validation",
      validation.diagnostics,
    );
  }
  if (validation.value.id !== authorityEntry.id) {
    throw sourceInvalid(
      context,
      ref,
      authorityEntry.entry.path,
      `artifact id "${validation.value.id}" does not match its filename id "${authorityEntry.id}"`,
    );
  }
  return validation.value;
}

function createProvenance(
  context: DelegatorRepositoryIdentity,
  ref: string,
  policySha: string,
  treeSha: string,
  entry: RepositoryTreeEntry,
  source: string,
): DelegatorTrustProvenance {
  return {
    authority: "repository-default-branch",
    repository: context,
    ref,
    policySha,
    treeSha,
    source: {
      path: entry.path,
      ref,
      sha: entry.sha,
      digest: createHash("sha256").update(source, "utf8").digest("hex"),
    },
  };
}

/**
 * Load every Delegator record from one authoritative protected-ref
 * generation. Inactive records are retained in the snapshot so revocation and
 * rotation state remains observable, but resolution below rejects them.
 */
export async function loadDelegatorTrust(reader: DelegatorSourceReader): Promise<DelegatorTrustSnapshot> {
  const context = await readSource("repository.resolve", undefined, undefined, () => reader.resolveRepositoryContext());
  const repository = requireRepositoryIdentity(context);
  const ref = await readSource("repository.default_branch", repository, undefined, () =>
    reader.getRepositoryDefaultBranch(),
  );
  if (!isNonEmptyText(ref)) throw sourceInvalid(repository, ref, DELEGATOR_ARTIFACT_DIRECTORY, "ref is empty");
  const branch = await readSource("repository.authority.ref", repository, ref, () => reader.findBranch(ref));
  if (typeof branch !== "object" || branch === null || !isNonEmptyText(branch.sha)) {
    throw sourceInvalid(repository, ref, DELEGATOR_ARTIFACT_DIRECTORY, "canonical ref has no commit SHA");
  }
  const policySha = branch.sha;
  const tree = await readSource("repository.governance.tree", repository, ref, () =>
    reader.getRepositoryTree(policySha),
  );
  validateTree(tree, repository, ref);
  const entries = discoverAuthorityEntries(tree, repository, ref);
  const authorities: LoadedDelegator[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const authorityEntry of entries) {
    const source = await readSource("repository.governance.blob", repository, ref, () =>
      reader.getRepositoryBlob(authorityEntry.entry.sha),
    );
    const authority = parseAuthorityBlob(source, authorityEntry, repository, ref);
    if (ids.has(authority.id)) {
      throw ambiguous(
        repository,
        ref,
        authorityEntry.entry.path,
        `authority id "${authority.id}" appears more than once`,
      );
    }
    const keyFingerprint = authority.key.x;
    if (keys.has(keyFingerprint)) {
      throw ambiguous(repository, ref, authorityEntry.entry.path, "the same public key appears in multiple records");
    }
    ids.add(authority.id);
    keys.add(keyFingerprint);
    authorities.push({
      authority,
      path: authorityEntry.entry.path,
      provenance: createProvenance(repository, ref, policySha, tree.sha, authorityEntry.entry, source),
    });
  }
  return Object.freeze({
    repository,
    ref,
    policySha,
    treeSha: tree.sha,
    authorities: Object.freeze(authorities),
  });
}

/**
 * Resolve one active Delegator by its repository-local identifier.
 * The complete directory is validated first, so malformed or ambiguous
 * neighboring records cannot be hidden by selecting a healthy record.
 */
export async function resolveDelegator(
  reader: DelegatorSourceReader,
  authorityId: string,
  options: DelegatorLookupOptions = {},
): Promise<LoadedDelegator> {
  validateLookupId(authorityId);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new DelegatorTrustError("RUNTIME_AUTHORITY_SOURCE_INVALID", "Delegator lookup clock is invalid.", {
      authorityId,
      reason: "now must be a valid Date",
    });
  }
  const snapshot = await loadDelegatorTrust(reader);
  const matches = snapshot.authorities.filter((candidate) => candidate.authority.id === authorityId);
  if (matches.length === 0) {
    throw new DelegatorTrustError(
      "RUNTIME_AUTHORITY_NOT_FOUND",
      `Delegator "${authorityId}" is not trusted by repository ${snapshot.repository.nameWithOwner}.`,
      { repository: snapshot.repository.nameWithOwner, ref: snapshot.ref, authorityId },
    );
  }
  if (matches.length !== 1) {
    throw new DelegatorTrustError(
      "RUNTIME_AUTHORITY_AMBIGUOUS",
      `Delegator "${authorityId}" resolves to multiple trust records.`,
      { repository: snapshot.repository.nameWithOwner, ref: snapshot.ref, authorityId },
    );
  }
  const resolved = matches[0];
  if (!isDelegatorActive(resolved.authority, now)) {
    throw new DelegatorTrustError(
      "RUNTIME_AUTHORITY_INACTIVE",
      `Delegator "${authorityId}" is disabled or outside its validity window.`,
      {
        repository: snapshot.repository.nameWithOwner,
        ref: snapshot.ref,
        authorityId,
        status: resolved.authority.status,
        reason: "authority is not active at the lookup time",
      },
    );
  }
  return resolved;
}

/** Explicit alias for callers that name the operation by its key identifier. */
export const loadDelegator = resolveDelegator;

/**
 * Compatibility exports for the former Delegator trust surface.
 * Every alias delegates to the Delegator implementation above so legacy
 * imports cannot create a second trust-resolution path.
 */
export type RuntimeAuthoritySourceReader = DelegatorSourceReader;
export type RuntimeAuthorityTrustErrorCode = DelegatorTrustErrorCode;
export type RuntimeAuthorityTrustErrorDetails = DelegatorTrustErrorDetails;
export { DelegatorTrustError as RuntimeAuthorityTrustError };
export type RuntimeAuthorityRepositoryIdentity = DelegatorRepositoryIdentity;
export type RuntimeAuthorityArtifactSource = DelegatorArtifactSource;
export type RuntimeAuthorityTrustProvenance = DelegatorTrustProvenance;
export type LoadedRuntimeAuthority = LoadedDelegator;
export type RuntimeAuthorityTrustSnapshot = DelegatorTrustSnapshot;
export type RuntimeAuthorityLookupOptions = DelegatorLookupOptions;
export type RenderedRuntimeAuthorityArtifact = RenderedDelegatorArtifact;
export const runtimeAuthorityArtifactPath = delegatorArtifactPath;
export const renderRuntimeAuthorityArtifact = renderDelegatorArtifact;
export const renderRuntimeAuthority = renderDelegator;
export const loadRuntimeAuthorityTrust = loadDelegatorTrust;
export const resolveRuntimeAuthority = resolveDelegator;
export const loadRuntimeAuthority = resolveDelegator;
