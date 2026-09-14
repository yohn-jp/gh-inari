import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDelegatorKeyPair, exportDelegatorPublicKey } from "./delegator-key.js";
import {
  DELEGATOR_ARTIFACT_DIRECTORY,
  DELEGATOR_ARTIFACT_PATH_PREFIX,
  DELEGATOR_CONTRACT_VERSION,
  DELEGATOR_KIND,
  assertDelegator,
  canonicalDelegatorJson,
  validateDelegator,
  type Delegator,
} from "./delegator.js";
import {
  RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY,
  RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX,
  RUNTIME_AUTHORITY_CONTRACT_VERSION,
  RUNTIME_AUTHORITY_KIND,
  assertRuntimeAuthority,
  canonicalRuntimeAuthorityJson,
  validateRuntimeAuthority,
} from "./runtime-authority.js";
import { delegatorArtifactPath, renderDelegatorArtifact } from "./delegator-trust.js";
import { renderRuntimeAuthorityArtifact, runtimeAuthorityArtifactPath } from "./runtime-authority-trust.js";
import { parseDelegatorRotation, registerDelegator } from "./delegator-lifecycle.js";
import { parseRuntimeAuthorityRotation, registerRuntimeAuthority } from "./runtime-authority-lifecycle.js";
import {
  evaluateSessionCertificateAgainstDelegator,
  evaluateSessionCertificateAgainstRuntimeAuthority,
} from "./session-certificate.js";
import { createDelegatorRecord, deriveDelegatorIdentity } from "./delegator-operations.js";
import { createRuntimeAuthorityRecord, deriveRuntimeAuthorityIdentity } from "./runtime-authority-operations.js";
import { exportRuntimeAuthorityPublicKey, generateRuntimeAuthorityKeyPair } from "./runtime-key.js";

function record(): Delegator {
  return createDelegatorRecord({
    id: "delegator-compatibility",
    key: generateDelegatorKeyPair(),
    notBefore: "2026-01-01T00:00:00Z",
    maxSessionTtlSeconds: 7200,
    capabilityCeiling: ["change.implement"],
  });
}

test("Delegator uses the legacy persisted kind and artifact path", () => {
  assert.equal(DELEGATOR_CONTRACT_VERSION, RUNTIME_AUTHORITY_CONTRACT_VERSION);
  assert.equal(DELEGATOR_KIND, "runtime-authority");
  assert.equal(DELEGATOR_KIND, RUNTIME_AUTHORITY_KIND);
  assert.equal(DELEGATOR_ARTIFACT_DIRECTORY, ".github/inari/authorities");
  assert.equal(DELEGATOR_ARTIFACT_DIRECTORY, RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY);
  assert.equal(DELEGATOR_ARTIFACT_PATH_PREFIX, RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX);

  const authority = record();
  assert.deepEqual(validateDelegator(authority), validateRuntimeAuthority(authority));
  assert.deepEqual(assertDelegator(authority), assertRuntimeAuthority(authority));
  assert.equal(canonicalDelegatorJson(authority), canonicalRuntimeAuthorityJson(authority));
  assert.equal(delegatorArtifactPath(authority.id), runtimeAuthorityArtifactPath(authority.id));
  assert.deepEqual(renderDelegatorArtifact(authority), renderRuntimeAuthorityArtifact(authority));
});

test("legacy key and operation imports are aliases of the canonical Delegator implementation", () => {
  const key = generateDelegatorKeyPair();
  const legacyKey = generateRuntimeAuthorityKeyPair();
  assert.equal(exportDelegatorPublicKey, exportRuntimeAuthorityPublicKey);
  assert.equal(generateDelegatorKeyPair, generateRuntimeAuthorityKeyPair);
  assert.equal(key.publicKeyJwk.kty, legacyKey.publicKeyJwk.kty);

  assert.equal(createRuntimeAuthorityRecord, createDelegatorRecord);
  assert.equal(deriveRuntimeAuthorityIdentity, deriveDelegatorIdentity);
  assert.equal(assertRuntimeAuthority, assertDelegator);
  assert.equal(parseRuntimeAuthorityRotation, parseDelegatorRotation);
  assert.equal(registerRuntimeAuthority, registerDelegator);
  assert.equal(evaluateSessionCertificateAgainstRuntimeAuthority, evaluateSessionCertificateAgainstDelegator);
});
