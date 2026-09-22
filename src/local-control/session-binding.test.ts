import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import {
  createLocalSessionBinding,
  validateLocalSessionBinding,
  verifyLocalSessionBinding,
} from "./session-binding.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const REPOSITORY = { id: "1330755860", name: "yohn-jp/gh-inari" };
const CAPABILITIES = [{ kind: "change.implement", issue: 1027 }] as const;

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
