import { createHash } from "node:crypto";
import { validateBranchName } from "./branch-naming.js";
import { delegatorPublicKeyFingerprint } from "./agent-authority/delegator-key.js";
import { validateDelegator, type Delegator } from "./agent-authority/delegator.js";
import { renderDelegatorArtifact } from "./agent-authority/delegator-trust.js";
import { extractTemplateIdentityMarker, renderPullRequestArtifact } from "./artifact.js";
import {
  compileSemanticTemplateSync,
  discoverSemanticTemplatesSync,
  readSemanticTemplateSync,
} from "./semantic-template.js";
import type { RepositoryIdentity } from "./github/effect-authorizer.js";
import type {
  RuntimeAuthorityPublicationBroker,
  RuntimeAuthorityPublicationCapability,
  RuntimeAuthorityPullRequest,
} from "./github/runtime-authority-publication-capability.js";

export const RUNTIME_AUTHORITY_PUBLICATION_REQUEST_VERSION = 1 as const;
export const RUNTIME_AUTHORITY_PUBLICATION_EVENT = "inari.runtime-authority.publish" as const;
const MAX_REQUEST_BYTES = 64 * 1024;
const ISSUER_BOT_LOGIN = "inari-issuer[bot]";
const AUTHORITY_TEMPLATE_SOURCE_PATH = ".github/inari/pull-requests/authority.json";

export interface RuntimeAuthorityPublicationRequest {
  readonly version: typeof RUNTIME_AUTHORITY_PUBLICATION_REQUEST_VERSION;
  readonly authority: Delegator;
}

export interface RuntimeAuthorityPublicationResult {
  readonly status: "created" | "existing";
  readonly authorityId: string;
  readonly branch: string;
  readonly pullRequest: { readonly number: number; readonly url: string };
}

export class RuntimeAuthorityPublicationError extends Error {
  readonly code = "RUNTIME_AUTHORITY_PUBLICATION_FAILED" as const;

  constructor() {
    super(
      "Runtime Authority trust publication failed closed. Resolve the repository publication state and rerun setup.",
    );
    this.name = "RuntimeAuthorityPublicationError";
  }
}

export function runtimeAuthorityPublicationBranch(authorityId: string): string {
  if (typeof authorityId !== "string" || authorityId.length === 0 || authorityId.length > 128) {
    throw new RuntimeAuthorityPublicationError();
  }
  const identityDigest = createHash("sha256").update(authorityId, "utf8").digest("hex").slice(0, 16);
  return `feat/1066-runtime-authority-bootstrap-${identityDigest}`;
}

export function runtimeAuthorityPublicationTitle(authorityId: string): string {
  if (typeof authorityId !== "string" || authorityId.length === 0 || authorityId.length > 128) {
    throw new RuntimeAuthorityPublicationError();
  }
  return `Trust Runtime Authority ${authorityId}`;
}

export function runtimeAuthorityPublicationBody(authorityInput: unknown): string {
  return authorityPullRequestBody(validatePublicAuthority(authorityInput));
}

export function createRuntimeAuthorityPublicationRequest(authorityInput: unknown): RuntimeAuthorityPublicationRequest {
  const authority = validatePublicAuthority(authorityInput);
  return Object.freeze({ version: RUNTIME_AUTHORITY_PUBLICATION_REQUEST_VERSION, authority });
}

export function validateRuntimeAuthorityPublicationRequest(input: unknown): RuntimeAuthorityPublicationRequest {
  if (!isRecord(input) || Object.keys(input).some((key) => !["version", "authority"].includes(key))) {
    throw new RuntimeAuthorityPublicationError();
  }
  if (input.version !== RUNTIME_AUTHORITY_PUBLICATION_REQUEST_VERSION || !hasOwn(input, "authority")) {
    throw new RuntimeAuthorityPublicationError();
  }
  const request = createRuntimeAuthorityPublicationRequest(input.authority);
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REQUEST_BYTES) {
    throw new RuntimeAuthorityPublicationError();
  }
  return request;
}

export async function publishRuntimeAuthority(
  requestInput: unknown,
  target: RepositoryIdentity,
  broker: RuntimeAuthorityPublicationBroker,
): Promise<RuntimeAuthorityPublicationResult> {
  const request = validateRuntimeAuthorityPublicationRequest(requestInput);
  const artifact = renderDelegatorArtifact(request.authority);
  const branch = runtimeAuthorityPublicationBranch(request.authority.id);
  if (validateBranchName(branch).length > 0) throw new RuntimeAuthorityPublicationError();
  const title = runtimeAuthorityPublicationTitle(request.authority.id);
  const body = authorityPullRequestBody(request.authority);

  return broker.withRuntimeAuthorityPublicationCapability({ target }, async (capability) => {
    const defaultBranch = await capability.getDefaultBranch();
    const base = defaultBranch.name;

    const existingPullRequests = await capability.findPullRequests(branch, base);
    if (existingPullRequests.length > 1) throw new RuntimeAuthorityPublicationError();
    if (existingPullRequests.length === 1) {
      const existing = existingPullRequests[0];
      if (existing === undefined) throw new RuntimeAuthorityPublicationError();
      await verifyPublication(capability, existing, branch, base, artifact.path, artifact.content, title, body, target);
      return result("existing", request.authority.id, branch, existing);
    }

    let branchHead = await capability.gitData.readRef(branch);
    if (branchHead === undefined) {
      const baseCommit = await capability.gitData.readCommit(defaultBranch.sha);
      const baseTree = await capability.gitData.readTree(baseCommit.treeSha);
      if (baseTree.entries.some((entry) => entry.path === artifact.path)) throw new RuntimeAuthorityPublicationError();
      const blob = await capability.gitData.createBlob({
        content: Buffer.from(artifact.content, "utf8").toString("base64"),
      });
      if (blob.sha !== gitBlobSha(artifact.content)) throw new RuntimeAuthorityPublicationError();
      const tree = await capability.gitData.createTree({
        baseTreeSha: baseCommit.treeSha,
        entries: [{ path: artifact.path, mode: "100644", type: "blob", sha: blob.sha }],
      });
      const commit = await capability.gitData.createCommit({
        message: `Runtime Authority: publish ${request.authority.id}`,
        treeSha: tree.sha,
        parents: [defaultBranch.sha],
      });
      try {
        await capability.createBranch(branch, commit.sha);
      } catch {
        // A concurrent identical publication can win the canonical ref create.
        // The authoritative branch diff and public artifact are verified below.
      }
      branchHead = await capability.gitData.readRef(branch);
      if (branchHead === undefined) throw new RuntimeAuthorityPublicationError();
    }

    await verifyBranch(capability, branch, base, artifact.path, artifact.content);
    let pullRequest: RuntimeAuthorityPullRequest;
    try {
      pullRequest = await capability.createPullRequest({ head: branch, base, title, body });
    } catch {
      const raced = await capability.findPullRequests(branch, base);
      if (raced.length !== 1 || raced[0] === undefined) throw new RuntimeAuthorityPublicationError();
      await verifyPublication(capability, raced[0], branch, base, artifact.path, artifact.content, title, body, target);
      return result("existing", request.authority.id, branch, raced[0]);
    }
    await verifyPublication(
      capability,
      pullRequest,
      branch,
      base,
      artifact.path,
      artifact.content,
      title,
      body,
      target,
    );
    return result("created", request.authority.id, branch, pullRequest);
  });
}

function validatePublicAuthority(input: unknown): Delegator {
  const result = validateDelegator(input);
  if (!result.valid || result.value === undefined) throw new RuntimeAuthorityPublicationError();
  return result.value;
}

async function verifyPublication(
  capability: RuntimeAuthorityPublicationCapability,
  pullRequest: RuntimeAuthorityPullRequest,
  branch: string,
  base: string,
  path: string,
  content: string,
  title: string,
  body: string,
  target: RepositoryIdentity,
): Promise<void> {
  if (
    pullRequest.state !== "open" ||
    pullRequest.draft ||
    pullRequest.headBranch !== branch ||
    pullRequest.headRepository.toLowerCase() !== target.nameWithOwner.toLowerCase() ||
    pullRequest.baseBranch !== base ||
    pullRequest.author !== ISSUER_BOT_LOGIN ||
    pullRequest.title !== title ||
    pullRequest.body !== body ||
    pullRequest.changedFiles !== 1
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const files = await capability.readPullRequestFiles(pullRequest.number);
  if (files.length !== 1 || files[0] !== path) throw new RuntimeAuthorityPublicationError();
  await verifyBranch(capability, branch, base, path, content);
}

async function verifyBranch(
  capability: RuntimeAuthorityPublicationCapability,
  branch: string,
  base: string,
  path: string,
  content: string,
): Promise<void> {
  const comparison = await capability.compareBranch(base, branch);
  if (comparison.aheadBy !== 1 || comparison.changedPaths.length !== 1 || comparison.changedPaths[0] !== path) {
    throw new RuntimeAuthorityPublicationError();
  }
  const head = await capability.gitData.readRef(branch);
  if (head === undefined) throw new RuntimeAuthorityPublicationError();
  const commit = await capability.gitData.readCommit(head.sha);
  const tree = await capability.gitData.readTree(commit.treeSha);
  const entries = tree.entries.filter((entry) => entry.path === path);
  if (
    entries.length !== 1 ||
    entries[0]?.mode !== "100644" ||
    entries[0]?.type !== "blob" ||
    capability.gitData.readBlob === undefined
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  if ((await capability.gitData.readBlob(entries[0].sha)) !== content) throw new RuntimeAuthorityPublicationError();
}

function authorityPullRequestBody(authority: Delegator): string {
  const artifact = renderDelegatorArtifact(authority);
  const fingerprint = delegatorPublicKeyFingerprint(authority.key);
  const root = process.cwd();
  const identity = discoverSemanticTemplatesSync(root).find(
    (candidate) => candidate.kind === "pull_request" && candidate.sourcePath === AUTHORITY_TEMPLATE_SOURCE_PATH,
  );
  if (identity === undefined) throw new RuntimeAuthorityPublicationError();
  const contract = compileSemanticTemplateSync(root, readSemanticTemplateSync(root, identity));
  const rendered = renderPullRequestArtifact(contract, {
    fields: {
      authority_pr:
        "Runtime Authority PRs change a trust-root under `.github/inari/authorities/**`.\n" +
        "This is a trust-boundary change, not an ordinary implementation change.",
      change_type: "bootstrap",
      authority_id: authority.id,
      key_fingerprint: fingerprint,
      validity_window: `- Not before: ${authority.notBefore}\n- Not after: ${authority.notAfter ?? "No expiry"}`,
      max_session_ttl: `${authority.maxSessionTtlSeconds} seconds`,
      capability_ceiling: authority.capabilityCeiling.map((capability) => `- ${capability}`).join("\n"),
      no_private_key_material: "Confirmed: no private-key material is present in Git, this PR, logs, or artifacts.",
      signer_provisioning:
        "The Runtime Authority private key remains in the operator's local private configuration. The publication payload and commit contain only the validated public trust record.",
      rollback_recovery:
        "Close this PR to cancel publication. If merged, disable this authority in a separate reviewed trust PR. After this trust PR is merged, rerun `inari setup`.",
      review_focus: `Verify the public key fingerprint and the bounded validity, TTL, and capability ceiling in \`${artifact.path}\`.`,
    },
  });
  const marker = extractTemplateIdentityMarker(rendered);
  if (
    marker.status !== "valid" ||
    marker.marker?.kind !== "pull_request" ||
    marker.marker.path !== identity.generatedPath
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const canonicalMarker = `<!-- inari:template ${JSON.stringify({
    version: "1",
    kind: "pull_request",
    path: AUTHORITY_TEMPLATE_SOURCE_PATH,
  })} -->`;
  return `${marker.body}\n${canonicalMarker}\n`;
}

function result(
  status: RuntimeAuthorityPublicationResult["status"],
  authorityId: string,
  branch: string,
  pullRequest: RuntimeAuthorityPullRequest,
): RuntimeAuthorityPublicationResult {
  return Object.freeze({
    status,
    authorityId,
    branch,
    pullRequest: Object.freeze({ number: pullRequest.number, url: pullRequest.url }),
  });
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
