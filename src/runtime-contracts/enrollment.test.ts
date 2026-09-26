import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SECRET_ENROLLMENT_BYTES,
  SECRET_ENROLLMENT_OWNERS,
  validateSecretEnrollmentReceipt,
  validateSecretEnrollmentRequest,
  type SecretEnrollmentPort,
} from "./enrollment.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };

test("the Issuer private key is enrolled only by the Executor", () => {
  assert.deepEqual(SECRET_ENROLLMENT_OWNERS, { "executor-issuer-private-key": "executor" });
});

test("enrollment requests are secret-free and byte-bounded", () => {
  const request = {
    version: 1,
    kind: "executor-issuer-private-key",
    operationId: "op-1",
    repository,
    declaredBytes: 1700,
  };
  assert.equal(validateSecretEnrollmentRequest(request).declaredBytes, 1700);
  assert.throws(
    () => validateSecretEnrollmentRequest({ ...request, declaredBytes: MAX_SECRET_ENROLLMENT_BYTES + 1 }),
    /declaredBytes/u,
  );
  assert.throws(() => validateSecretEnrollmentRequest({ ...request, kind: "provider-token" }), /enrollment kind/u);
  assert.throws(() => validateSecretEnrollmentRequest({ ...request, pem: "-----BEGIN PRIVATE KEY-----" }), {
    code: "RUNTIME_CONTRACT_SECRET_MATERIAL",
  });
});

test("enrollment requests may carry bounded, secret-free action inputs", () => {
  const request = {
    version: 1,
    kind: "executor-issuer-private-key",
    operationId: "op-1",
    repository,
    declaredBytes: 1700,
  };
  assert.equal("inputs" in validateSecretEnrollmentRequest(request), false);
  assert.deepEqual(validateSecretEnrollmentRequest({ ...request, inputs: { "app-id": "123" } }).inputs, {
    "app-id": "123",
  });
  assert.throws(
    () => validateSecretEnrollmentRequest({ ...request, inputs: { "app-id": "-----BEGIN PRIVATE KEY-----" } }),
    { code: "RUNTIME_CONTRACT_SECRET_MATERIAL" },
  );
  assert.throws(() => validateSecretEnrollmentRequest({ ...request, inputs: { privateKey: "x" } }), {
    code: "RUNTIME_CONTRACT_SECRET_MATERIAL",
  });
  assert.throws(() => validateSecretEnrollmentRequest({ ...request, inputs: ["123"] }), /inputs/u);
  assert.throws(() => validateSecretEnrollmentRequest({ ...request, inputs: { "app-id": 123 } }), /app-id/u);
  assert.throws(() => validateSecretEnrollmentRequest({ ...request, inputs: { "app-id": "" } }), /app-id/u);
  assert.throws(
    () => validateSecretEnrollmentRequest({ ...request, inputs: { "app-id": "1".repeat(481) } }),
    /app-id/u,
  );
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`input-${index}`, "x"]));
  assert.throws(() => validateSecretEnrollmentRequest({ ...request, inputs: many }), /at most 16/u);
});

test("receipts are public and carry a fingerprint exactly when enrolled", () => {
  const receipt = {
    version: 1,
    kind: "executor-issuer-private-key",
    operationId: "op-1",
    repository,
    outcome: "enrolled",
    publicFingerprint: `sha256:${"0".repeat(64)}`,
    diagnostics: [],
  };
  assert.equal(validateSecretEnrollmentReceipt(receipt).outcome, "enrolled");
  assert.throws(() => validateSecretEnrollmentReceipt({ ...receipt, publicFingerprint: undefined }), /fingerprint/u);
  assert.throws(() => validateSecretEnrollmentReceipt({ ...receipt, outcome: "rejected" }), /fingerprint/u);
  assert.throws(() => validateSecretEnrollmentReceipt({ ...receipt, privateKey: "x" }), {
    code: "RUNTIME_CONTRACT_SECRET_MATERIAL",
  });
});

test("the port streams bytes to the owner and returns only a receipt", async () => {
  let received = 0;
  const port: SecretEnrollmentPort = {
    owner: "executor",
    kinds: ["executor-issuer-private-key"],
    async enroll(request, secret) {
      for await (const chunk of secret) received += chunk.byteLength;
      return {
        version: 1,
        kind: request.kind,
        operationId: request.operationId,
        repository: request.repository,
        outcome: "rejected",
        diagnostics: [{ code: "ENROLLMENT_KEY_INVALID", message: "The key is not an RSA private key." }],
      };
    },
  };
  async function* stream(): AsyncIterable<Uint8Array> {
    yield new Uint8Array(3);
    yield new Uint8Array(4);
  }
  const request = validateSecretEnrollmentRequest({
    version: 1,
    kind: "executor-issuer-private-key",
    operationId: "op-1",
    repository,
    declaredBytes: 7,
  });
  const receipt = validateSecretEnrollmentReceipt(await port.enroll(request, stream()));
  assert.equal(received, 7);
  assert.equal(receipt.outcome, "rejected");
});
