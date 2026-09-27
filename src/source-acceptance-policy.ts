/**
 * Current repository-owned Source acceptance reviewer policy.
 *
 * The policy is read only from the repository's configured default branch.
 * This module owns strict artifact shape validation and snapshot provenance;
 * reviewer identity classification, independence, and acceptance completion
 * remain separate decisions.
 */

import { createHash } from "node:crypto";
import type { DelegatorSourceReader } from "./agent-authority/delegator-trust.js";
import { compileJsonSchema } from "./contract/json-schema-runtime.js";
import { JSON_SCHEMA_DIALECT } from "./contract/ir.js";
import type { RepositoryContext, RepositoryTree, RepositoryTreeEntry } from "./github/types.js";

export const SOURCE_ACCEPTANCE_POLICY_VERSION = 1 as const;
export const SOURCE_ACCEPTANCE_POLICY_KIND = "source-acceptance-policy" as const;
export const SOURCE_ACCEPTANCE_POLICY_PATH = ".github/inari/source-acceptance-policy.json" as const;

const MAX_POLICY_SOURCE_BYTES = 1_048_576;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const GIT_OBJECT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SAFE_PROVIDER_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const USER_ID_PATTERN = "^[1-9][0-9]{0,19}$";

const SOURCE_ACCEPTANCE_POLICY_SCHEMA = Object.freeze({
  $schema: JSON_SCHEMA_DIALECT,
  type: "object",
  additionalProperties: false,
  required: ["version", "kind", "generation", "reviewerUserIds"],
  properties: {
    version: { type: "integer", const: SOURCE_ACCEPTANCE_POLICY_VERSION },
    kind: { type: "string", const: SOURCE_ACCEPTANCE_POLICY_KIND },
    generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    reviewerUserIds: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 20, pattern: USER_ID_PATTERN },
    },
  },
});

const validatePolicyArtifact = compileJsonSchema(SOURCE_ACCEPTANCE_POLICY_SCHEMA);

export interface SourceAcceptancePolicy {
  readonly version: typeof SOURCE_ACCEPTANCE_POLICY_VERSION;
  readonly kind: typeof SOURCE_ACCEPTANCE_POLICY_KIND;
  readonly generation: number;
  /** Decimal immutable GitHub user IDs. No login or permission inference is made here. */
  readonly reviewerUserIds: readonly string[];
}

export interface SourceAcceptancePolicyRepositoryIdentity {
  readonly host: string;
  readonly id: string;
}

export interface SourceAcceptancePolicySourceProvenance {
  readonly path: typeof SOURCE_ACCEPTANCE_POLICY_PATH;
  readonly ref: string;
  /** Git blob object ID selected from the complete protected-ref tree. */
  readonly blobSha: string;
  /** SHA-256 of the exact UTF-8 artifact source returned by the reader. */
  readonly digest: string;
}

export interface SourceAcceptancePolicyProvenance {
  readonly authority: "repository-default-branch";
  readonly repository: SourceAcceptancePolicyRepositoryIdentity;
  readonly ref: string;
  /** Immutable commit resolved from the repository's current default branch. */
  readonly commitSha: string;
  readonly treeSha: string;
  readonly source: SourceAcceptancePolicySourceProvenance;
  readonly generation: number;
}

export interface LoadedSourceAcceptancePolicy {
  readonly policy: SourceAcceptancePolicy;
  readonly provenance: SourceAcceptancePolicyProvenance;
}

export type SourceAcceptancePolicyLoadErrorCode =
  | "SOURCE_ACCEPTANCE_POLICY_SOURCE_UNAVAILABLE"
  | "SOURCE_ACCEPTANCE_POLICY_SOURCE_INVALID"
  | "SOURCE_ACCEPTANCE_POLICY_NOT_FOUND"
  | "SOURCE_ACCEPTANCE_POLICY_AMBIGUOUS"
  | "SOURCE_ACCEPTANCE_POLICY_REPOSITORY_ID_UNAVAILABLE";

export interface SourceAcceptancePolicyLoadErrorDetails {
  readonly operation?: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly reason?: string;
}

/** Stable fail-closed error for current Source acceptance policy loading. */
export class SourceAcceptancePolicyLoadError extends Error {
  readonly code: SourceAcceptancePolicyLoadErrorCode;
  readonly details: Readonly<SourceAcceptancePolicyLoadErrorDetails>;

  constructor(
    code: SourceAcceptancePolicyLoadErrorCode,
    message: string,
    details: SourceAcceptancePolicyLoadErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SourceAcceptancePolicyLoadError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeProviderText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_PROVIDER_TEXT_PATTERN.test(value)
  );
}

function repositoryLabel(context: RepositoryContext): string | undefined {
  return isSafeProviderText(context.nameWithOwner, 512) ? context.nameWithOwner : undefined;
}

function requireRepositoryIdentity(context: RepositoryContext): SourceAcceptancePolicyRepositoryIdentity {
  if (
    !isSafeProviderText(context.hostname, 255) ||
    typeof context.repositoryId !== "string" ||
    !REPOSITORY_ID_PATTERN.test(context.repositoryId)
  ) {
    throw new SourceAcceptancePolicyLoadError(
      "SOURCE_ACCEPTANCE_POLICY_REPOSITORY_ID_UNAVAILABLE",
      "Source acceptance policy cannot be trusted without immutable repository identity.",
      {
        operation: "repository.resolve",
        repository: repositoryLabel(context),
        reason: "repository identity is invalid",
      },
    );
  }
  return Object.freeze({ host: context.hostname, id: context.repositoryId });
}

function sourceInvalid(
  operation: string,
  repository: SourceAcceptancePolicyRepositoryIdentity | undefined,
  ref: string | undefined,
  path: string,
  reason: string,
): SourceAcceptancePolicyLoadError {
  return new SourceAcceptancePolicyLoadError(
    "SOURCE_ACCEPTANCE_POLICY_SOURCE_INVALID",
    `Source acceptance policy evidence at "${path}" is invalid.`,
    {
      operation,
      ...(repository === undefined ? {} : { repository: repository.id }),
      ...(ref === undefined ? {} : { ref }),
      path,
      reason,
    },
  );
}

function ambiguous(
  repository: SourceAcceptancePolicyRepositoryIdentity,
  ref: string,
  path: string,
  reason: string,
): SourceAcceptancePolicyLoadError {
  return new SourceAcceptancePolicyLoadError(
    "SOURCE_ACCEPTANCE_POLICY_AMBIGUOUS",
    `Source acceptance policy evidence at "${path}" is ambiguous.`,
    { repository: repository.id, ref, path, reason },
  );
}

async function readSource<T>(
  operation: string,
  repository: SourceAcceptancePolicyRepositoryIdentity | undefined,
  ref: string | undefined,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof SourceAcceptancePolicyLoadError) throw error;
    throw new SourceAcceptancePolicyLoadError(
      "SOURCE_ACCEPTANCE_POLICY_SOURCE_UNAVAILABLE",
      `Unable to establish current Source acceptance policy evidence during ${operation}.`,
      {
        operation,
        ...(repository === undefined ? {} : { repository: repository.id }),
        ...(ref === undefined ? {} : { ref }),
        path: SOURCE_ACCEPTANCE_POLICY_PATH,
        reason: "protected-ref evidence read failed",
      },
      { cause: error },
    );
  }
}

function validateTree(
  tree: RepositoryTree,
  repository: SourceAcceptancePolicyRepositoryIdentity,
  ref: string,
): RepositoryTreeEntry {
  if (
    !isRecord(tree) ||
    typeof tree.sha !== "string" ||
    !GIT_OBJECT_SHA_PATTERN.test(tree.sha) ||
    !Array.isArray(tree.entries) ||
    ("truncated" in tree && tree.truncated !== false)
  ) {
    throw sourceInvalid(
      "repository.governance.tree",
      repository,
      ref,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "tree is malformed",
    );
  }

  const paths = new Set<string>();
  let policyEntry: RepositoryTreeEntry | undefined;
  for (const entry of tree.entries) {
    if (
      !isRecord(entry) ||
      !isSafeProviderText(entry.path, 1024) ||
      typeof entry.sha !== "string" ||
      !GIT_OBJECT_SHA_PATTERN.test(entry.sha) ||
      (entry.type !== "blob" && entry.type !== "tree")
    ) {
      throw sourceInvalid(
        "repository.governance.tree",
        repository,
        ref,
        SOURCE_ACCEPTANCE_POLICY_PATH,
        "tree entry is malformed",
      );
    }
    if (paths.has(entry.path)) {
      throw ambiguous(repository, ref, entry.path, "the protected-ref tree contains a duplicate path");
    }
    paths.add(entry.path);
    if (entry.path === SOURCE_ACCEPTANCE_POLICY_PATH) {
      if (entry.type !== "blob") {
        throw sourceInvalid(
          "repository.governance.tree",
          repository,
          ref,
          SOURCE_ACCEPTANCE_POLICY_PATH,
          "policy path is not a blob",
        );
      }
      policyEntry = entry as unknown as RepositoryTreeEntry;
    }
  }
  if (policyEntry === undefined) {
    throw new SourceAcceptancePolicyLoadError(
      "SOURCE_ACCEPTANCE_POLICY_NOT_FOUND",
      `No Source acceptance policy was found at ${SOURCE_ACCEPTANCE_POLICY_PATH} on the current default branch.`,
      { repository: repository.id, ref, path: SOURCE_ACCEPTANCE_POLICY_PATH },
    );
  }
  return policyEntry;
}

/**
 * Detect duplicate JSON object member names before using JSON.parse's
 * last-member-wins behavior. The full JSON parser validates syntax separately.
 */
function hasDuplicateObjectMemberNames(source: string): boolean {
  const objectKeys: Set<string>[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      let afterString = index;
      while (afterString < source.length && /\s/u.test(source[afterString] as string)) afterString += 1;
      if (source[afterString] === ":" && objectKeys.length > 0) {
        const key = JSON.parse(source.slice(start, index)) as unknown;
        if (typeof key === "string") {
          const currentObject = objectKeys[objectKeys.length - 1];
          if (currentObject?.has(key)) return true;
          currentObject?.add(key);
        }
      }
      continue;
    }
    if (character === "{") objectKeys.push(new Set<string>());
    else if (character === "}") objectKeys.pop();
    index += 1;
  }
  return false;
}

function parsePolicy(
  source: unknown,
  repository: SourceAcceptancePolicyRepositoryIdentity,
  ref: string,
): SourceAcceptancePolicy {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_POLICY_SOURCE_BYTES) {
    throw sourceInvalid(
      "repository.governance.blob",
      repository,
      ref,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "policy source is malformed or oversized",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw sourceInvalid(
      "repository.governance.blob",
      repository,
      ref,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "policy source is not valid JSON",
    );
  }
  if (hasDuplicateObjectMemberNames(source)) {
    throw sourceInvalid(
      "repository.governance.blob",
      repository,
      ref,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "policy JSON has duplicate object member names",
    );
  }

  const validation = validatePolicyArtifact.validate(parsed);
  if (!validation.valid || !isRecord(parsed)) {
    throw sourceInvalid(
      "repository.governance.blob",
      repository,
      ref,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "policy artifact failed strict schema validation",
    );
  }
  if (!Number.isSafeInteger(parsed.generation) || !Array.isArray(parsed.reviewerUserIds)) {
    throw sourceInvalid(
      "repository.governance.blob",
      repository,
      ref,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "policy generation or reviewer list is invalid",
    );
  }

  return Object.freeze({
    version: SOURCE_ACCEPTANCE_POLICY_VERSION,
    kind: SOURCE_ACCEPTANCE_POLICY_KIND,
    generation: parsed.generation as number,
    reviewerUserIds: Object.freeze([...(parsed.reviewerUserIds as string[])]),
  });
}

/**
 * Load one strict policy from the current repository default branch.
 * Every call performs fresh protected-ref, complete-tree, and exact-blob reads;
 * no local checkout, alternate path, caller ref, or policy cache is consulted.
 */
export async function loadSourceAcceptancePolicy(reader: DelegatorSourceReader): Promise<LoadedSourceAcceptancePolicy> {
  const context = await readSource("repository.resolve", undefined, undefined, () => reader.resolveRepositoryContext());
  if (!isRecord(context)) {
    throw sourceInvalid(
      "repository.resolve",
      undefined,
      undefined,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "repository context is malformed",
    );
  }
  const repository = requireRepositoryIdentity(context as RepositoryContext);
  const ref = await readSource("repository.default_branch", repository, undefined, () =>
    reader.getRepositoryDefaultBranch(),
  );
  if (!isSafeProviderText(ref, 255)) {
    throw sourceInvalid(
      "repository.default_branch",
      repository,
      undefined,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "default branch is invalid",
    );
  }

  const branch = await readSource("repository.canonical_ref", repository, ref, () => reader.findBranch(ref));
  if (
    !isRecord(branch) ||
    branch.name !== ref ||
    branch.ref !== `refs/heads/${ref}` ||
    typeof branch.sha !== "string" ||
    !GIT_OBJECT_SHA_PATTERN.test(branch.sha)
  ) {
    throw sourceInvalid(
      "repository.canonical_ref",
      repository,
      ref,
      SOURCE_ACCEPTANCE_POLICY_PATH,
      "default branch resolution is stale or malformed",
    );
  }
  const commitSha = branch.sha;

  const tree = await readSource("repository.governance.tree", repository, ref, () =>
    reader.getRepositoryTree(commitSha),
  );
  const policyEntry = validateTree(tree, repository, ref);
  const source = await readSource("repository.governance.blob", repository, ref, () =>
    reader.getRepositoryBlob(policyEntry.sha),
  );
  const policy = parsePolicy(source, repository, ref);

  return Object.freeze({
    policy,
    provenance: Object.freeze({
      authority: "repository-default-branch",
      repository,
      ref,
      commitSha,
      treeSha: tree.sha,
      source: Object.freeze({
        path: SOURCE_ACCEPTANCE_POLICY_PATH,
        ref,
        blobSha: policyEntry.sha,
        digest: createHash("sha256").update(source, "utf8").digest("hex"),
      }),
      generation: policy.generation,
    }),
  });
}
