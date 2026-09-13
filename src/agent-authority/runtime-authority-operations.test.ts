import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRuntimeAuthorityRecord,
  checkRuntimeAuthorityRotationOrder,
  deriveRuntimeAuthorityIdentity,
  projectRuntimeSigningEnvironment,
  verifyRuntimeAuthorityReadiness,
} from "./runtime-authority-operations.js";
import { renderRuntimeAuthorityArtifact, type RuntimeAuthoritySourceReader } from "./runtime-authority-trust.js";
import { generateRuntimeAuthorityKeyPair } from "./runtime-key.js";
import type { RuntimeAuthority } from "./runtime-authority.js";

function authorityFromPair(
  id: string,
  pair = generateRuntimeAuthorityKeyPair(),
  overrides: Partial<RuntimeAuthority> = {},
) {
  return {
    pair,
    authority: createRuntimeAuthorityRecord({
      id,
      key: pair,
      notBefore: "2026-01-01T00:00:00Z",
      maxSessionTtlSeconds: 7200,
      capabilityCeiling: ["change.implement", "change.ready"],
      ...overrides,
    }),
  };
}

function reader(authorities: readonly RuntimeAuthority[], unavailable = false): RuntimeAuthoritySourceReader {
  const rendered = authorities.map((authority) => renderRuntimeAuthorityArtifact(authority));
  const blobs = new Map(rendered.map((artifact, index) => [`blob-${index}`, artifact.content]));
  return {
    async resolveRepositoryContext() {
      return {
        hostname: "github.com",
        host: "github.com",
        owner: "yohn-jp",
        name: "gh-inari",
        nameWithOwner: "yohn-jp/gh-inari",
        url: "https://github.com/yohn-jp/gh-inari",
        repositoryId: "522000001",
      };
    },
    async getRepositoryDefaultBranch() {
      return "main";
    },
    async findBranch(branch) {
      if (unavailable) throw new Error("provider secret and response body must not cross the boundary");
      return { name: branch, ref: `refs/heads/${branch}`, sha: "commit-522" };
    },
    async getRepositoryTree() {
      return {
        sha: "tree-522",
        entries: rendered.map((artifact, index) => ({
          path: artifact.path,
          type: "blob" as const,
          sha: `blob-${index}`,
        })),
      };
    },
    async getRepositoryBlob(sha) {
      const source = blobs.get(sha);
      if (source === undefined) throw new Error("missing blob");
      return source;
    },
  };
}

test("constructs a canonical public authority from generated key material with deterministic identity", () => {
  const { pair, authority } = authorityFromPair("runtime-bootstrap");
  const repeated = createRuntimeAuthorityRecord({
    id: authority.id,
    key: pair.privateKey,
    notBefore: authority.notBefore,
    notAfter: authority.notAfter,
    maxSessionTtlSeconds: authority.maxSessionTtlSeconds,
    capabilityCeiling: authority.capabilityCeiling,
  });
  const firstIdentity = deriveRuntimeAuthorityIdentity(authority.id, pair);
  const secondIdentity = deriveRuntimeAuthorityIdentity(authority.id, pair.publicKeyJwk);
  assert.deepEqual(repeated, authority);
  assert.equal(firstIdentity.publicKeyFingerprint, secondIdentity.publicKeyFingerprint);
  assert.equal(JSON.stringify(authority).includes("privateKey"), false);
  assert.equal(JSON.stringify(authority).includes('"d"'), false);
  assert.equal(firstIdentity.publicKeyFingerprint.startsWith("sha256:"), true);
});

test("readiness proves canonical protected-ref trust, key match, and a bounded signature probe", async () => {
  const { pair, authority } = authorityFromPair("runtime-ready");
  const result = await verifyRuntimeAuthorityReadiness(reader([authority]), {
    authorityId: authority.id,
    privateKey: pair.privateKey,
    now: new Date("2026-06-01T00:00:00Z"),
    probeIssue: 522,
    sessionTtlSeconds: 3600,
    capabilities: ["change.implement"],
  });
  assert.deepEqual(result.ok, true);
  assert.equal(result.state, "ready");
  assert.equal(result.canonical?.ref, "main");
  assert.equal(result.canonical?.policySha, "commit-522");
  assert.deepEqual(result.probe, { operation: "change.issue", issue: 522, verified: true });
  assert.equal(JSON.stringify(result).includes("BEGIN PRIVATE KEY"), false);
});

test("readiness returns stable states for missing, malformed, mismatched, inactive, and unavailable bindings", async () => {
  const first = authorityFromPair("runtime-first");
  const other = authorityFromPair("runtime-other");
  const missing = await verifyRuntimeAuthorityReadiness(reader([first.authority]), {});
  assert.equal(missing.state, "missing-deployment-binding");

  const malformed = await verifyRuntimeAuthorityReadiness(reader([first.authority]), {
    authorityId: first.authority.id,
    privateKey: "not-a-private-key-secret",
  });
  assert.equal(malformed.state, "invalid-private-key");
  assert.equal(JSON.stringify(malformed).includes("not-a-private-key-secret"), false);

  const mismatch = await verifyRuntimeAuthorityReadiness(reader([first.authority]), {
    authorityId: first.authority.id,
    privateKey: other.pair.privateKey,
    now: new Date("2026-06-01T00:00:00Z"),
  });
  assert.equal(mismatch.state, "key-mismatch");

  const inactive = authorityFromPair("runtime-inactive", first.pair, { status: "disabled" });
  const inactiveResult = await verifyRuntimeAuthorityReadiness(reader([inactive.authority]), {
    authorityId: inactive.authority.id,
    privateKey: inactive.pair.privateKey,
    now: new Date("2026-06-01T00:00:00Z"),
  });
  assert.equal(inactiveResult.state, "inactive-authority");

  const unavailable = await verifyRuntimeAuthorityReadiness(reader([first.authority], true), {
    authorityId: first.authority.id,
    privateKey: first.pair.privateKey,
    now: new Date("2026-06-01T00:00:00Z"),
  });
  assert.equal(unavailable.state, "canonical-trust-unavailable");
});

test("readiness enforces Runtime TTL and capability ceilings", async () => {
  const { pair, authority } = authorityFromPair("runtime-ceiling");
  const ttl = await verifyRuntimeAuthorityReadiness(reader([authority]), {
    authorityId: authority.id,
    privateKey: pair.privateKey,
    now: new Date("2026-06-01T00:00:00Z"),
    sessionTtlSeconds: 7201,
  });
  assert.equal(ttl.state, "ttl-exceeds-ceiling");
  const capability = await verifyRuntimeAuthorityReadiness(reader([authority]), {
    authorityId: authority.id,
    privateKey: pair.privateKey,
    now: new Date("2026-06-01T00:00:00Z"),
    capabilities: ["branch.advance"],
  });
  assert.equal(capability.state, "capability-exceeds-ceiling");
});

test("rotation order requires trusted replacement readiness before activation and migration before revocation", () => {
  const blockedActivation = checkRuntimeAuthorityRotationOrder({
    currentAuthorityId: "runtime-a",
    nextAuthorityId: "runtime-b",
    phase: "activate",
    nextReadiness: { ok: false, state: "unknown-authority", authorityId: "runtime-b" },
  });
  assert.equal(blockedActivation.ok, false);
  const ready = { ok: true, state: "ready" as const, authorityId: "runtime-b" };
  assert.equal(
    checkRuntimeAuthorityRotationOrder({
      currentAuthorityId: "runtime-a",
      nextAuthorityId: "runtime-b",
      phase: "activate",
      nextReadiness: ready,
    }).state,
    "ready-to-activate",
  );
  assert.equal(
    checkRuntimeAuthorityRotationOrder({
      currentAuthorityId: "runtime-a",
      nextAuthorityId: "runtime-b",
      phase: "revoke",
      signerAuthorityId: "runtime-a",
      nextReadiness: ready,
    }).ok,
    false,
  );
  assert.equal(
    checkRuntimeAuthorityRotationOrder({
      currentAuthorityId: "runtime-a",
      nextAuthorityId: "runtime-b",
      phase: "revoke",
      signerAuthorityId: "runtime-b",
      nextReadiness: ready,
    }).state,
    "ready-to-revoke",
  );
});

test("runtime-signing environment projection reports only public configuration metadata", () => {
  const projection = projectRuntimeSigningEnvironment({
    INARI_RUNTIME_AUTHORITY_ID: "runtime-a",
    INARI_RUNTIME_AUTHORITY_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----secret",
  });
  assert.deepEqual(projection, {
    environment: "runtime-signing",
    authorityId: "runtime-a",
    privateKeyConfigured: true,
    privateKeyExposed: false,
  });
  assert.equal(JSON.stringify(projection).includes("BEGIN PRIVATE KEY"), false);
});
