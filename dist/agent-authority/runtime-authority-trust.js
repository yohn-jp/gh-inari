/**
 * Repository-native Runtime Authority trust artifacts.
 *
 * The repository is the trust-policy authority for these records. This module
 * only reads the configured authoritative protected ref (the repository's
 * default branch in V1), validates every authority artifact found there, and
 * returns bounded provenance for the immutable snapshot that was used. It
 * never reads the caller's checkout or accepts a caller-supplied working ref.
 *
 * Runtime registration, rotation/revocation workflow, and delegated writes to
 * this directory belong to later governance slices. A disabled or expired
 * record remains representable in a snapshot for that governance, but cannot
 * be resolved as active authorization.
 */
import { createHash } from "node:crypto";
import { RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY, RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX, MAX_RUNTIME_AUTHORITY_ID_LENGTH, RUNTIME_AUTHORITY_ID_PATTERN, assertRuntimeAuthority, canonicalRuntimeAuthorityJson, isRuntimeAuthorityActive, validateRuntimeAuthority, } from "./runtime-authority.js";
export const RUNTIME_AUTHORITY_MAX_RECORDS = 256;
/** Stable fail-closed failure for repository Runtime Authority resolution. */
export class RuntimeAuthorityTrustError extends Error {
    code;
    details;
    diagnostics;
    constructor(code, message, details = {}, diagnostics = [], options) {
        super(message, options);
        this.name = "RuntimeAuthorityTrustError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.diagnostics = Object.freeze([...diagnostics]);
    }
}
function isNonEmptyText(value) {
    return typeof value === "string" && value.length > 0;
}
function repositoryName(context) {
    return context.nameWithOwner.length > 0 ? context.nameWithOwner : `${context.owner}/${context.name}`;
}
function requireRepositoryIdentity(context) {
    if (!isNonEmptyText(context.repositoryId)) {
        throw new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_REPOSITORY_ID_UNAVAILABLE", "Runtime Authority trust cannot be established without the immutable repository database identity.", { operation: "repository.resolve", repository: repositoryName(context), reason: "repository ID is missing" });
    }
    return {
        host: context.hostname,
        owner: context.owner,
        name: context.name,
        nameWithOwner: context.nameWithOwner,
        repositoryId: context.repositoryId,
    };
}
function validateLookupId(authorityId) {
    if (!isNonEmptyText(authorityId) ||
        authorityId.length > MAX_RUNTIME_AUTHORITY_ID_LENGTH ||
        !RUNTIME_AUTHORITY_ID_PATTERN.test(authorityId)) {
        throw new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_NOT_FOUND", "Runtime Authority lookup requires a valid authority identifier.", { authorityId, reason: "invalid authority identifier" });
    }
}
/** Return the only repository path at which an authority record may live. */
export function runtimeAuthorityArtifactPath(authorityId) {
    validateLookupId(authorityId);
    return `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}${authorityId}.json`;
}
/** Render one validated public trust record into its canonical repository artifact. */
export function renderRuntimeAuthorityArtifact(input) {
    const authority = assertRuntimeAuthority(input);
    return Object.freeze({
        path: runtimeAuthorityArtifactPath(authority.id),
        content: canonicalRuntimeAuthorityJson(authority),
        authority,
    });
}
/** Render only the canonical JSON content for a Runtime Authority artifact. */
export function renderRuntimeAuthority(input) {
    return renderRuntimeAuthorityArtifact(input).content;
}
function validateTree(tree, context, ref) {
    if (typeof tree !== "object" || tree === null || !isNonEmptyText(tree.sha) || !Array.isArray(tree.entries)) {
        throw sourceInvalid(context, ref, RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY, !isNonEmptyText(tree?.sha) ? "tree SHA is empty" : "tree entries are missing");
    }
    const paths = new Set();
    for (const entry of tree.entries) {
        if (typeof entry !== "object" || entry === null) {
            throw sourceInvalid(context, ref, RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY, "tree entry is malformed");
        }
        const entryPath = typeof entry.path === "string" ? entry.path : RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY;
        if (!isNonEmptyText(entry.path) || !isNonEmptyText(entry.sha) || (entry.type !== "blob" && entry.type !== "tree")) {
            throw sourceInvalid(context, ref, entryPath, "tree entry is malformed");
        }
        if (paths.has(entry.path)) {
            throw ambiguous(context, ref, entry.path, "tree contains duplicate paths");
        }
        paths.add(entry.path);
    }
}
function discoverAuthorityEntries(tree, context, ref) {
    const entries = [];
    const prefix = RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX;
    for (const entry of tree.entries) {
        if (entry.path === RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY) {
            if (entry.type !== "tree")
                throw sourceInvalid(context, ref, entry.path, "authority directory is not a tree");
            continue;
        }
        if (!entry.path.startsWith(prefix))
            continue;
        const relative = entry.path.slice(prefix.length);
        if (entry.type !== "blob" || relative.includes("/") || !relative.endsWith(".json")) {
            throw sourceInvalid(context, ref, entry.path, "authority path must be a direct JSON blob");
        }
        const id = relative.slice(0, -".json".length);
        if (!RUNTIME_AUTHORITY_ID_PATTERN.test(id)) {
            throw sourceInvalid(context, ref, entry.path, "authority filename is not a valid authority identifier");
        }
        entries.push({ id, entry });
    }
    if (entries.length === 0) {
        throw new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_NOT_FOUND", `No Runtime Authority trust records were found at ${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY} on ref "${ref}".`, { repository: context.nameWithOwner, ref, path: RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY });
    }
    if (entries.length > RUNTIME_AUTHORITY_MAX_RECORDS) {
        throw sourceInvalid(context, ref, RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY, "too many authority records");
    }
    return Object.freeze(entries.sort((left, right) => (left.entry.path < right.entry.path ? -1 : 1)));
}
function sourceInvalid(context, ref, path, reason, diagnostics = []) {
    return new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_SOURCE_INVALID", `Runtime Authority source at "${path}" is invalid: ${reason}.`, { repository: context.nameWithOwner, ref, path, reason }, diagnostics);
}
function ambiguous(context, ref, path, reason) {
    return new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_AMBIGUOUS", `Runtime Authority trust at "${path}" is ambiguous: ${reason}.`, { repository: context.nameWithOwner, ref, path, reason });
}
async function readSource(operation, context, ref, read) {
    try {
        return await read();
    }
    catch (error) {
        if (error instanceof RuntimeAuthorityTrustError)
            throw error;
        throw new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_SOURCE_UNAVAILABLE", `Unable to establish Runtime Authority trust during ${operation}.`, {
            operation,
            ...(context === undefined ? {} : { repository: context.nameWithOwner }),
            ...(ref === undefined ? {} : { ref }),
            reason: error instanceof Error ? error.message : "repository source read failed",
        }, [], { cause: error });
    }
}
function parseAuthorityBlob(source, authorityEntry, context, ref) {
    let raw;
    try {
        raw = JSON.parse(source);
    }
    catch {
        throw sourceInvalid(context, ref, authorityEntry.entry.path, "artifact is not valid JSON");
    }
    const validation = validateRuntimeAuthority(raw, "$");
    if (!validation.valid || validation.value === undefined) {
        throw sourceInvalid(context, ref, authorityEntry.entry.path, "artifact failed Runtime Authority validation", validation.diagnostics);
    }
    if (validation.value.id !== authorityEntry.id) {
        throw sourceInvalid(context, ref, authorityEntry.entry.path, `artifact id "${validation.value.id}" does not match its filename id "${authorityEntry.id}"`);
    }
    return validation.value;
}
function createProvenance(context, ref, policySha, treeSha, entry, source) {
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
 * Load every Runtime Authority record from one authoritative protected-ref
 * generation. Inactive records are retained in the snapshot so revocation and
 * rotation state remains observable, but resolution below rejects them.
 */
export async function loadRuntimeAuthorityTrust(reader) {
    const context = await readSource("repository.resolve", undefined, undefined, () => reader.resolveRepositoryContext());
    const repository = requireRepositoryIdentity(context);
    const ref = await readSource("repository.default_branch", repository, undefined, () => reader.getRepositoryDefaultBranch());
    if (!isNonEmptyText(ref))
        throw sourceInvalid(repository, ref, RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY, "ref is empty");
    const branch = await readSource("repository.authority.ref", repository, ref, () => reader.findBranch(ref));
    if (typeof branch !== "object" || branch === null || !isNonEmptyText(branch.sha)) {
        throw sourceInvalid(repository, ref, RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY, "canonical ref has no commit SHA");
    }
    const policySha = branch.sha;
    const tree = await readSource("repository.governance.tree", repository, ref, () => reader.getRepositoryTree(policySha));
    validateTree(tree, repository, ref);
    const entries = discoverAuthorityEntries(tree, repository, ref);
    const authorities = [];
    const ids = new Set();
    const keys = new Set();
    for (const authorityEntry of entries) {
        const source = await readSource("repository.governance.blob", repository, ref, () => reader.getRepositoryBlob(authorityEntry.entry.sha));
        const authority = parseAuthorityBlob(source, authorityEntry, repository, ref);
        if (ids.has(authority.id)) {
            throw ambiguous(repository, ref, authorityEntry.entry.path, `authority id "${authority.id}" appears more than once`);
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
 * Resolve one active Runtime Authority by its repository-local identifier.
 * The complete directory is validated first, so malformed or ambiguous
 * neighboring records cannot be hidden by selecting a healthy record.
 */
export async function resolveRuntimeAuthority(reader, authorityId, options = {}) {
    validateLookupId(authorityId);
    const now = options.now ?? new Date();
    if (Number.isNaN(now.getTime())) {
        throw new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_SOURCE_INVALID", "Runtime Authority lookup clock is invalid.", {
            authorityId,
            reason: "now must be a valid Date",
        });
    }
    const snapshot = await loadRuntimeAuthorityTrust(reader);
    const matches = snapshot.authorities.filter((candidate) => candidate.authority.id === authorityId);
    if (matches.length === 0) {
        throw new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_NOT_FOUND", `Runtime Authority "${authorityId}" is not trusted by repository ${snapshot.repository.nameWithOwner}.`, { repository: snapshot.repository.nameWithOwner, ref: snapshot.ref, authorityId });
    }
    if (matches.length !== 1) {
        throw new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_AMBIGUOUS", `Runtime Authority "${authorityId}" resolves to multiple trust records.`, { repository: snapshot.repository.nameWithOwner, ref: snapshot.ref, authorityId });
    }
    const resolved = matches[0];
    if (!isRuntimeAuthorityActive(resolved.authority, now)) {
        throw new RuntimeAuthorityTrustError("RUNTIME_AUTHORITY_INACTIVE", `Runtime Authority "${authorityId}" is disabled or outside its validity window.`, {
            repository: snapshot.repository.nameWithOwner,
            ref: snapshot.ref,
            authorityId,
            status: resolved.authority.status,
            reason: "authority is not active at the lookup time",
        });
    }
    return resolved;
}
/** Explicit alias for callers that name the operation by its key identifier. */
export const loadRuntimeAuthority = resolveRuntimeAuthority;
//# sourceMappingURL=runtime-authority-trust.js.map