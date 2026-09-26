import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeContractError } from "./errors.js";
import { assertSecretFreeSetupJson, findSetupSecretMaterial, MAX_SETUP_JSON_BYTES } from "./secret-material.js";

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

function rejectedAs(value: unknown, kind: string): void {
  assert.throws(
    () => assertSecretFreeSetupJson(value),
    (error: unknown) =>
      error instanceof RuntimeContractError &&
      error.code === "RUNTIME_CONTRACT_SECRET_MATERIAL" &&
      error.message.includes(kind) &&
      !error.message.includes("MIIB") &&
      !error.message.includes("ghs_"),
  );
}

test("accepts ordinary secret-free setup JSON", () => {
  assert.doesNotThrow(() =>
    assertSecretFreeSetupJson({
      appId: "123456",
      privateKeyConfigured: false,
      tokenExpiresAt: null,
      publicFingerprint: "sha256:" + "a".repeat(64),
      command: { executable: "inari", argv: ["runtime", "supervise"] },
    }),
  );
  assert.deepEqual(findSetupSecretMaterial({ note: "configure the token later" }), []);
});

test("rejects PEM blocks anywhere, without echoing the value", () => {
  rejectedAs({ nested: [{ value: PEM }] }, "pem-block");
  rejectedAs(["-----BEGIN CERTIFICATE-----"], "pem-block");
});

test("rejects provider tokens and bearer credentials", () => {
  rejectedAs({ value: `ghs_${"A".repeat(36)}` }, "provider-token");
  rejectedAs({ value: `github_pat_${"a".repeat(40)}` }, "provider-token");
  rejectedAs({ header: `Bearer ${"x".repeat(40)}` }, "provider-token");
});

test("rejects secret-named fields and private JWK members", () => {
  rejectedAs({ privateKey: "anything" }, "secret-field");
  rejectedAs({ private_key_pem: "anything" }, "secret-field");
  rejectedAs({ clientSecret: "x" }, "secret-field");
  rejectedAs({ accessToken: "x" }, "secret-field");
  rejectedAs({ key: { kty: "OKP", crv: "Ed25519", x: "pub", d: "priv" } }, "private-jwk");
  assert.doesNotThrow(() => assertSecretFreeSetupJson({ key: { kty: "OKP", crv: "Ed25519", x: "pub" } }));
});

test("bounds size, depth and JSON shape", () => {
  assert.throws(() => assertSecretFreeSetupJson({ value: "x".repeat(5000) }), { code: "RUNTIME_CONTRACT_TOO_LARGE" });
  let deep: unknown = "leaf";
  for (let index = 0; index < 20; index += 1) deep = { deep };
  assert.throws(() => assertSecretFreeSetupJson(deep), { code: "RUNTIME_CONTRACT_TOO_LARGE" });
  const wide = Array.from({ length: MAX_SETUP_JSON_BYTES / 1000 + 10 }, () => "y".repeat(1000));
  assert.throws(() => assertSecretFreeSetupJson(wide), { code: "RUNTIME_CONTRACT_TOO_LARGE" });
  assert.throws(() => assertSecretFreeSetupJson({ buffer: new Uint8Array(4) }), { code: "RUNTIME_CONTRACT_INVALID" });
  assert.throws(() => assertSecretFreeSetupJson({ value: Number.NaN }), { code: "RUNTIME_CONTRACT_INVALID" });
});
