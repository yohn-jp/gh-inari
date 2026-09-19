import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_PROVENANCE_RECORD_OPERATION,
  CHANGE_PROVENANCE_RECORD_VERSION,
  ChangeProvenanceRecordError,
  createChangeProvenanceRecord,
  isChangeProvenanceRecordValid,
  renderChangeProvenanceRecord,
  validateChangeProvenanceRecord,
  verifyChangeProvenanceRecord,
} from "./change-provenance-record.js";
import { assertRuntimeAuthority } from "./agent-authority/runtime-authority.js";
import {
  exportRuntimeAuthorityPublicKey,
  generateRuntimeAuthorityKeyPair,
  importRuntimeAuthorityPrivateKey,
} from "./agent-authority/runtime-key.js";

const NOW = new Date("2026-09-13T00:00:00.000Z");

function authority(pair: ReturnType<typeof generateRuntimeAuthorityKeyPair>) {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "runtime-change",
    key: pair.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
}

test("Change provenance records are deterministic, canonical, and optionally attributed", () => {
  const pair = generateRuntimeAuthorityKeyPair();
  const trusted = authority(pair);
  const options = {
    rootIssue: 513,
    runtimeAuthority: trusted,
    runtimeKey: pair,
    now: NOW,
    actor: { type: "agent" as const, name: "Luna" },
  };
  const first = createChangeProvenanceRecord(options);
  const second = createChangeProvenanceRecord(options);

  assert.deepEqual(first, second);
  assert.equal(renderChangeProvenanceRecord(first), renderChangeProvenanceRecord(second));
  assert.equal(
    renderChangeProvenanceRecord(first),
    `${JSON.stringify(JSON.parse(renderChangeProvenanceRecord(first)))}` + "\n",
  );
  assert.deepEqual(verifyChangeProvenanceRecord(renderChangeProvenanceRecord(first), trusted), {
    version: CHANGE_PROVENANCE_RECORD_VERSION,
    rootIssue: 513,
    operation: CHANGE_PROVENANCE_RECORD_OPERATION,
    actor: { type: "agent", name: "Luna" },
  });
  assert.equal("id" in (first.actor ?? {}), false);
});

test("omitting actor remains valid and verification uses only the repository trust anchor", () => {
  const pair = generateRuntimeAuthorityKeyPair();
  const trusted = authority(pair);
  const record = createChangeProvenanceRecord({
    rootIssue: 514,
    runtimeAuthority: trusted,
    runtimeKey: pair,
    now: NOW,
  });
  const rendered = renderChangeProvenanceRecord(record);

  assert.equal(record.actor, undefined);
  assert.deepEqual(verifyChangeProvenanceRecord(rendered, trusted), {
    version: 1,
    rootIssue: 514,
    operation: "change.issue",
  });
  assert.equal(isChangeProvenanceRecordValid(rendered, trusted), true);
});

test("independent active Runtime Authorities sign and verify against the same repository trust set", () => {
  const firstKey = generateRuntimeAuthorityKeyPair();
  const secondKey = generateRuntimeAuthorityKeyPair();
  const first = assertRuntimeAuthority({
    ...authority(firstKey),
    id: "runtime-a",
  });
  const second = assertRuntimeAuthority({
    ...authority(secondKey),
    id: "runtime-b",
  });
  const firstRecord = createChangeProvenanceRecord({
    rootIssue: 533,
    runtimeAuthority: first,
    runtimeKey: firstKey,
    now: NOW,
  });
  const secondRecord = createChangeProvenanceRecord({
    rootIssue: 533,
    runtimeAuthority: second,
    runtimeKey: secondKey,
    now: NOW,
  });

  assert.equal(firstRecord.signature.kid, first.id);
  assert.equal(secondRecord.signature.kid, second.id);
  assert.doesNotThrow(() => verifyChangeProvenanceRecord(firstRecord, first));
  assert.doesNotThrow(() => verifyChangeProvenanceRecord(secondRecord, second));
  assert.throws(() => verifyChangeProvenanceRecord(firstRecord, second));
});

test("tampering, unknown requester data, and a substituted runtime key fail closed", () => {
  const pair = generateRuntimeAuthorityKeyPair();
  const trusted = authority(pair);
  const record = createChangeProvenanceRecord({
    rootIssue: 515,
    runtimeAuthority: trusted,
    runtimeKey: pair,
    now: NOW,
  });
  const parsed = JSON.parse(renderChangeProvenanceRecord(record)) as Record<string, unknown>;

  const tampered = { ...parsed, rootIssue: 516 };
  assert.throws(
    () => verifyChangeProvenanceRecord(JSON.stringify(tampered), trusted),
    (error: unknown) =>
      error instanceof ChangeProvenanceRecordError && error.code === "CHANGE_PROVENANCE_RECORD_SIGNATURE_INVALID",
  );
  const requester = { ...parsed, requester: "human:requester" };
  assert.equal(validateChangeProvenanceRecord(requester).valid, false);

  const other = generateRuntimeAuthorityKeyPair();
  assert.throws(
    () => createChangeProvenanceRecord({ rootIssue: 515, runtimeAuthority: trusted, runtimeKey: other, now: NOW }),
    (error: unknown) =>
      error instanceof ChangeProvenanceRecordError && error.code === "CHANGE_PROVENANCE_RECORD_UNTRUSTED_KEY",
  );
});

test("the existing Runtime key PEM mechanism round-trips the signing key", () => {
  const pair = generateRuntimeAuthorityKeyPair();
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  assert.equal(typeof pem, "string");
  assert.deepEqual(exportRuntimeAuthorityPublicKey(importRuntimeAuthorityPrivateKey(pem as string)), pair.publicKeyJwk);
});

test("canonical provenance records remain canonical when formatted as repository artifacts", () => {
  const pair = generateRuntimeAuthorityKeyPair();
  const trusted = authority(pair);
  const record = createChangeProvenanceRecord({
    rootIssue: 742,
    runtimeAuthority: trusted,
    runtimeKey: pair,
    now: NOW,
  });
  const rendered = renderChangeProvenanceRecord(record);

  assert.equal(rendered, `${JSON.stringify(JSON.parse(rendered))}\n`);
  assert.deepEqual(verifyChangeProvenanceRecord(rendered, trusted), {
    version: CHANGE_PROVENANCE_RECORD_VERSION,
    rootIssue: 742,
    operation: CHANGE_PROVENANCE_RECORD_OPERATION,
  });
});
