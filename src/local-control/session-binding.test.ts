import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { createRepositoryBranchPolicy } from "../repository-branch-policy.js";
import { observeLocalBranch } from "../cli/runtime/branch-observation.js";
import {
  createLocalSessionBinding,
  validateLocalSessionBinding,
  verifyLocalSessionBinding,
} from "./session-binding.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const REPOSITORY = { id: "1330755860", name: "yohn-jp/gh-inari" };
const CAPABILITIES = [{ kind: "change.implement", issue: 1027 }] as const;

test("policy observation is signed while legacy binding payload remains valid", () => {
  const { keyPair } = authorityFixture();
  const branch = "work/1027-session";
  const generation = { ref: "trunk", treeSha: "a".repeat(40) };
  const acquired = createRepositoryBranchPolicy({
    generation: {
      authority: "repository-default-branch",
      repository: {
        host: "github.com",
        repositoryId: REPOSITORY.id,
        owner: "yohn-jp",
        name: "gh-inari",
        nameWithOwner: REPOSITORY.name,
      },
      ...generation,
    },
    rule: { pattern: "^work/[0-9]+-[a-z]+$", format: "work/{issueNumber}-{slug}" },
  });
  assert.equal(acquired.status, "available");
  if (acquired.status !== "available") return;
  const observation = observeLocalBranch({
    policy: acquired.policy,
    target: { repository: { repositoryHost: "github.com", repositoryId: REPOSITORY.id }, implementation: 1027 },
    observedGeneration: generation,
    observedBranch: branch,
    naming: { slug: "session" },
  });
  const delegated = createDelegatorRecord({
    id: "policy-binding",
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement", "branch.advance"],
  });
  const options = {
    sessionId: "session-policy",
    repository: REPOSITORY,
    task: { kind: "issue", number: 1027 },
    capabilities: [
      { kind: "change.implement", issue: 1027 },
      { kind: "branch.advance", branch },
    ],
    ttlSeconds: 120,
    runtimeAuthority: delegated,
    runtimeKey: keyPair,
    now: NOW,
    branchObservation: observation,
  } as const;
  const binding = createLocalSessionBinding(options);
  assert.throws(() => createLocalSessionBinding({ ...options, branchObservation: undefined }));
  assert.deepEqual(verifyLocalSessionBinding(binding, delegated, { now: NOW }).value, binding);
  assert.equal(
    verifyLocalSessionBinding(
      { ...binding, branchObservation: { ...observation, expectedBranch: "work/1028-session" } },
      delegated,
      { now: NOW },
    ).valid,
    false,
  );
  assert.equal(bindingFixture().binding.branchObservation, undefined);
});

test("restricted change.implement Authority issues, verifies, and adopts a policy-bound Session without branch.advance", () => {
  const keyPair = generateDelegatorKeyPair();
  const branch = "work/1027-session";
  const generation = { ref: "trunk", treeSha: "b".repeat(40) };
  const acquired = createRepositoryBranchPolicy({
    generation: {
      authority: "repository-default-branch",
      repository: {
        host: "github.com",
        repositoryId: REPOSITORY.id,
        owner: "yohn-jp",
        name: "gh-inari",
        nameWithOwner: REPOSITORY.name,
      },
      ...generation,
    },
    rule: { pattern: "^work/[0-9]+-[a-z]+$", format: "work/{issueNumber}-{slug}" },
  });
  assert.equal(acquired.status, "available");
  if (acquired.status !== "available") return;
  const observation = observeLocalBranch({
    policy: acquired.policy,
    target: { repository: { repositoryHost: "github.com", repositoryId: REPOSITORY.id }, implementation: 1027 },
    observedGeneration: generation,
    observedBranch: branch,
    naming: { slug: "session" },
  });
  const restricted = createDelegatorRecord({
    id: "policy-restricted",
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement"],
  });
  const binding = createLocalSessionBinding({
    sessionId: "session-policy-restricted",
    repository: REPOSITORY,
    task: { kind: "issue", number: 1027 },
    capabilities: CAPABILITIES,
    ttlSeconds: 120,
    runtimeAuthority: restricted,
    runtimeKey: keyPair,
    now: NOW,
    branchObservation: observation,
  });
  assert.deepEqual(binding.branchObservation, observation);
  assert.equal(
    binding.capabilities.some((claim) => claim.kind === "branch.advance"),
    false,
  );
  assert.deepEqual(verifyLocalSessionBinding(binding, restricted, { now: NOW }).value, binding);
  assert.deepEqual(validateLocalSessionBinding(JSON.parse(JSON.stringify(binding))).value, binding);
  for (const tampered of [
    { ...observation, expectedBranch: "work/1028-session" },
    { ...observation, implementation: 1028 },
    { ...observation, repository: { ...observation.repository, repositoryId: "1" } },
    { ...observation, observedGeneration: { ...observation.observedGeneration, treeSha: "c".repeat(40) } },
  ]) {
    assert.equal(
      verifyLocalSessionBinding({ ...binding, branchObservation: tampered }, restricted, { now: NOW }).valid,
      false,
    );
  }
  assert.throws(() =>
    createLocalSessionBinding({
      sessionId: "session-policy-mismatch",
      repository: REPOSITORY,
      task: { kind: "issue", number: 1027 },
      capabilities: [...CAPABILITIES, { kind: "branch.advance", branch: "work/1027-other" }],
      ttlSeconds: 120,
      runtimeAuthority: createDelegatorRecord({
        id: "policy-mismatch",
        key: keyPair,
        notBefore: new Date("2026-08-01T00:00:00.000Z"),
        maxSessionTtlSeconds: 3600,
        capabilityCeiling: ["change.implement", "branch.advance"],
      }),
      runtimeKey: keyPair,
      now: NOW,
      branchObservation: observation,
    }),
  );
});

function authorityFixture() {
  const keyPair = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id: "local-runtime",
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready"],
  });
  return { keyPair, authority };
}

function bindingFixture(sessionId = "session-1027") {
  const { keyPair, authority } = authorityFixture();
  const binding = createLocalSessionBinding({
    sessionId,
    repository: REPOSITORY,
    task: { kind: "issue", number: 1027 },
    capabilities: CAPABILITIES,
    ttlSeconds: 120,
    runtimeAuthority: authority,
    runtimeKey: keyPair,
    now: NOW,
  });
  return { binding, keyPair, authority };
}

test("issues a closed canonical binding verified by its active Runtime Authority", () => {
  const { binding, authority } = bindingFixture();
  const result = verifyLocalSessionBinding(binding, authority, { now: NOW });
  assert.equal(result.valid, true);
  assert.equal(result.status, "active");
  assert.deepEqual(result.value, binding);
  assert.deepEqual(binding.repository, REPOSITORY);
  assert.deepEqual(binding.task, { kind: "issue", number: 1027 });
  assert.deepEqual(binding.capabilities, CAPABILITIES);
  assert.equal(binding.authority.id, authority.id);
  assert.match(binding.authority.publicKeyFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal("sessionKey" in binding, false);
  assert.equal("privateKey" in binding, false);
  assert.equal(JSON.stringify(binding).includes("privateKey"), false);
});

test("rejects a mismatched payload, malformed shape, and unknown binding version without secret diagnostics", () => {
  const { binding, authority } = bindingFixture();
  const changed = { ...binding, repository: { ...binding.repository, id: "1330755861" } };
  const invalidSignature = verifyLocalSessionBinding(changed, authority, { now: NOW });
  assert.equal(invalidSignature.valid, false);
  assert.equal(invalidSignature.diagnostics[0]?.code, "LOCAL_SESSION_BINDING_SIGNATURE_INVALID");

  const unsupported = validateLocalSessionBinding({ ...binding, version: 2 });
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.diagnostics[0]?.code, "LOCAL_SESSION_BINDING_UNSUPPORTED_VERSION");
  assert.equal(JSON.stringify(unsupported.diagnostics).includes("secret-marker"), false);

  const malformed = validateLocalSessionBinding({ ...binding, privateKey: "secret-marker" });
  assert.equal(malformed.valid, false);
  assert.equal(JSON.stringify(malformed.diagnostics).includes("secret-marker"), false);

  const unbound = { ...binding } as Record<string, unknown>;
  delete unbound.task;
  assert.equal(validateLocalSessionBinding(unbound).valid, false);
});

test("rejects a binding when the supplied trusted Authority key differs", () => {
  const { binding } = bindingFixture();
  const other = authorityFixture();
  const mismatchedAuthority = createDelegatorRecord({
    id: binding.authority.id,
    key: other.keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready"],
  });
  const result = verifyLocalSessionBinding(binding, mismatchedAuthority, { now: NOW });
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0]?.code, "LOCAL_SESSION_BINDING_TRUST_MISMATCH");
});

test("uses injected clock input for exclusive expiry and enforces Authority capability and TTL ceilings", () => {
  const { binding, authority } = bindingFixture();
  assert.equal(
    verifyLocalSessionBinding(binding, authority, { now: new Date((binding.exp - 1) * 1000) }).status,
    "active",
  );
  assert.equal(verifyLocalSessionBinding(binding, authority, { now: new Date(binding.exp * 1000) }).status, "expired");

  const { keyPair, authority: narrowAuthority } = authorityFixture();
  assert.throws(
    () =>
      createLocalSessionBinding({
        sessionId: "session-outside-ceiling",
        repository: REPOSITORY,
        task: { kind: "issue", number: 1027 },
        capabilities: [{ kind: "change.abort", issue: 1027 }],
        ttlSeconds: 120,
        runtimeAuthority: narrowAuthority,
        runtimeKey: keyPair,
        now: NOW,
      }),
    /capability/u,
  );
  assert.throws(
    () =>
      createLocalSessionBinding({
        sessionId: "session-long-ttl",
        repository: REPOSITORY,
        task: { kind: "issue", number: 1027 },
        capabilities: CAPABILITIES,
        ttlSeconds: 3_601,
        runtimeAuthority: authority,
        runtimeKey: keyPair,
        now: NOW,
      }),
    /TTL/u,
  );
});
