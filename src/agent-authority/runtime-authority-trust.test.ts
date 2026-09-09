import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY,
  RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX,
  RUNTIME_AUTHORITY_CONTRACT_VERSION,
  RUNTIME_AUTHORITY_KIND,
  loadRuntimeAuthorityTrust,
  renderRuntimeAuthorityArtifact,
  resolveRuntimeAuthority,
  type RuntimeAuthoritySourceReader,
} from "./index.js";

function ed25519Jwk(): { kty: "OKP"; crv: "Ed25519"; x: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string };
}

function authority(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: RUNTIME_AUTHORITY_CONTRACT_VERSION,
    kind: RUNTIME_AUTHORITY_KIND,
    id: "runtime-a",
    key: ed25519Jwk(),
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 7200,
    capabilityCeiling: ["change.implement"],
    ...overrides,
  };
}

interface ReaderOptions {
  readonly repositoryId?: string;
  readonly ref?: string;
  readonly authorities?: readonly Record<string, unknown>[];
  readonly tree?: readonly { path: string; type: "blob" | "tree"; sha: string }[];
  readonly blobs?: Readonly<Record<string, string>>;
  readonly branchOnly?: string;
}

function reader(
  options: ReaderOptions = {},
): RuntimeAuthoritySourceReader & { readonly refs: string[]; readonly branchRefs: string[] } {
  const ref = options.ref ?? "main";
  const records = options.authorities ?? [authority()];
  const rendered = records.map((record) => renderRuntimeAuthorityArtifact(record));
  const blobs = new Map<string, string>(rendered.map((artifact, index) => [`blob-${index}`, artifact.content]));
  for (const [sha, source] of Object.entries(options.blobs ?? {})) blobs.set(sha, source);
  const treeEntries =
    options.tree ??
    rendered.map((artifact, index) => ({
      path: artifact.path,
      type: "blob" as const,
      sha: `blob-${index}`,
    }));
  const refs: string[] = [];
  const branchRefs: string[] = [];
  return {
    refs,
    branchRefs,
    async resolveRepositoryContext() {
      return {
        hostname: "github.com",
        host: "github.com",
        owner: "yohn-jp",
        name: "gh-inari",
        nameWithOwner: "yohn-jp/gh-inari",
        url: "https://github.com/yohn-jp/gh-inari",
        repositoryId: options.repositoryId ?? "123456789",
      };
    },
    async getRepositoryDefaultBranch() {
      return ref;
    },
    async findBranch(requestedBranch) {
      branchRefs.push(requestedBranch);
      if (options.branchOnly !== undefined && requestedBranch !== options.branchOnly) {
        throw new Error(`unexpected branch ${requestedBranch}`);
      }
      return { name: requestedBranch, ref: `refs/heads/${requestedBranch}`, sha: "commit-main" };
    },
    async getRepositoryTree(requestedRef) {
      refs.push(requestedRef);
      if (requestedRef !== "commit-main") {
        throw new Error(`unexpected commit ${requestedRef}`);
      }
      return { sha: "tree-main", entries: treeEntries };
    },
    async getRepositoryBlob(sha) {
      const source = blobs.get(sha);
      if (source === undefined) throw new Error(`missing blob ${sha}`);
      return source;
    },
  };
}

test("renders a public authority artifact at the canonical path and content", () => {
  const record = authority({ id: "runtime.render" });
  const rendered = renderRuntimeAuthorityArtifact(record);
  assert.equal(rendered.path, `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime.render.json`);
  assert.equal(rendered.path.startsWith(`${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}/`), true);
  assert.deepEqual(JSON.parse(rendered.content), record);
  assert.equal(rendered.content.includes("\n"), false);
  assert.equal("d" in (rendered.authority.key as unknown as Record<string, unknown>), false);
});

test("loads only the repository default branch and records immutable trust provenance", async () => {
  const source = reader({ branchOnly: "main" });
  const resolved = await resolveRuntimeAuthority(source, "runtime-a", { now: new Date("2026-06-01T00:00:00Z") });
  assert.deepEqual(source.branchRefs, ["main"]);
  assert.deepEqual(source.refs, ["commit-main"]);
  assert.equal(resolved.provenance.authority, "repository-default-branch");
  assert.equal(resolved.provenance.ref, "main");
  assert.equal(resolved.provenance.policySha, "commit-main");
  assert.equal(resolved.provenance.treeSha, "tree-main");
  assert.equal(resolved.provenance.repository.repositoryId, "123456789");
  assert.equal(resolved.provenance.source.path, `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`);
});

test("does not accept a Runtime Authority artifact that exists only on a working branch", async () => {
  const source = reader({
    authorities: [],
    tree: [{ path: "refs/heads/feature/.github/inari/authorities/working.json", type: "blob", sha: "working" }],
    blobs: { working: JSON.stringify(authority({ id: "working" })) },
    branchOnly: "main",
  });
  await assert.rejects(
    resolveRuntimeAuthority(source, "working", { now: new Date("2026-06-01T00:00:00Z") }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_NOT_FOUND",
  );
  assert.deepEqual(source.branchRefs, ["main"]);
  assert.deepEqual(source.refs, ["commit-main"]);
});

test("fails closed when the authoritative directory is missing", async () => {
  const source = reader({ authorities: [], tree: [] });
  await assert.rejects(
    loadRuntimeAuthorityTrust(source),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_NOT_FOUND",
  );
});

test("fails closed on malformed JSON and schema-invalid trust records", async () => {
  const malformed = reader({
    tree: [{ path: `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`, type: "blob", sha: "bad" }],
    blobs: { bad: "{" },
  });
  await assert.rejects(
    loadRuntimeAuthorityTrust(malformed),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_SOURCE_INVALID",
  );

  const invalid = reader({
    tree: [{ path: `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`, type: "blob", sha: "invalid" }],
    blobs: { invalid: JSON.stringify(authority({ maxSessionTtlSeconds: 86_401 })) },
  });
  await assert.rejects(
    loadRuntimeAuthorityTrust(invalid),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_SOURCE_INVALID",
  );
});

test("requires the artifact filename identifier to match the signed trust record identifier", async () => {
  const source = reader({
    tree: [{ path: `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`, type: "blob", sha: "mismatch" }],
    blobs: { mismatch: JSON.stringify(authority({ id: "runtime-b" })) },
  });
  await assert.rejects(
    loadRuntimeAuthorityTrust(source),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_SOURCE_INVALID",
  );
});

test("permits distinct active records during rotation overlap and retains revoked records in the snapshot", async () => {
  const oldAuthority = authority({
    id: "runtime-old",
    key: ed25519Jwk(),
    notAfter: "2026-12-31T00:00:00Z",
  });
  const newAuthority = authority({ id: "runtime-new", key: ed25519Jwk() });
  const revokedAuthority = authority({ id: "runtime-revoked", key: ed25519Jwk(), status: "disabled" });
  const source = reader({ authorities: [oldAuthority, newAuthority, revokedAuthority] });
  const snapshot = await loadRuntimeAuthorityTrust(source);
  assert.equal(snapshot.authorities.length, 3);
  await resolveRuntimeAuthority(source, "runtime-old", { now: new Date("2026-06-01T00:00:00Z") });
  await resolveRuntimeAuthority(source, "runtime-new", { now: new Date("2026-06-01T00:00:00Z") });
  await assert.rejects(
    resolveRuntimeAuthority(source, "runtime-revoked", { now: new Date("2026-06-01T00:00:00Z") }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_INACTIVE",
  );
});

test("rejects an expired authority at lookup time", async () => {
  const source = reader({
    authorities: [authority({ notAfter: "2026-05-31T23:59:59Z" })],
  });
  await assert.rejects(
    resolveRuntimeAuthority(source, "runtime-a", { now: new Date("2026-06-01T00:00:00Z") }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_INACTIVE",
  );
});

test("rejects ambiguous duplicate identifiers and public keys", async () => {
  const duplicateId = reader({
    authorities: [authority({ id: "runtime-a" }), authority({ id: "runtime-a" })],
  });
  await assert.rejects(
    loadRuntimeAuthorityTrust(duplicateId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_AMBIGUOUS",
  );

  const sharedKey = ed25519Jwk();
  const duplicateKey = reader({
    authorities: [authority({ id: "runtime-a", key: sharedKey }), authority({ id: "runtime-b", key: sharedKey })],
  });
  await assert.rejects(
    loadRuntimeAuthorityTrust(duplicateKey),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_AMBIGUOUS",
  );
});

test("does not infer trust across repositories", async () => {
  const trusted = reader({ repositoryId: "repository-a" });
  await resolveRuntimeAuthority(trusted, "runtime-a", { now: new Date("2026-06-01T00:00:00Z") });

  const otherRepository = reader({ repositoryId: "repository-b", authorities: [], tree: [] });
  await assert.rejects(
    resolveRuntimeAuthority(otherRepository, "runtime-a", { now: new Date("2026-06-01T00:00:00Z") }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_NOT_FOUND",
  );
});

test("fails closed when immutable repository identity is unavailable", async () => {
  const source = reader({ repositoryId: "" });
  await assert.rejects(
    loadRuntimeAuthorityTrust(source),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_REPOSITORY_ID_UNAVAILABLE",
  );
});

test("exposes schema diagnostics for malformed artifacts", async () => {
  const source = reader({
    tree: [{ path: `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`, type: "blob", sha: "bad-schema" }],
    blobs: { "bad-schema": JSON.stringify(authority({ key: { kty: "RSA" } })) },
  });
  await assert.rejects(
    loadRuntimeAuthorityTrust(source),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUNTIME_AUTHORITY_SOURCE_INVALID",
  );
});
