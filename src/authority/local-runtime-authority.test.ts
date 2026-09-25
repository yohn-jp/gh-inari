import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair, loadDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import type { Delegator } from "../agent-authority/delegator.js";
import { verifyChangeProvenanceRecord } from "../change-provenance-record.js";
import { localComponentPath } from "../local-control/config.js";
import { setupLocalAuthority } from "../local-control/identity.js";
import { verifyLocalSessionBinding } from "../local-control/session-binding.js";
import { LocalRuntimeAuthorityError, openLocalRuntimeAuthority } from "./index.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const ISSUE = 1108;

async function fixture(): Promise<{
  readonly environment: NodeJS.ProcessEnv;
  readonly authority: Delegator;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-runtime-authority-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "config") };
  setupLocalAuthority(environment);
  const authority = createDelegatorRecord({
    id: "local-runtime-authority-test",
    key: loadDelegatorKeyPair(localComponentPath("authority", "private-key.pem", environment)),
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  return { environment, authority, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function code(expected: string) {
  return (error: unknown) => error instanceof LocalRuntimeAuthorityError && error.code === expected;
}

test("the Authority owner signs Session bindings and Change provenance with the custodied key", async () => {
  const state = await fixture();
  try {
    const signer = openLocalRuntimeAuthority({
      environment: state.environment,
      trustedAuthority: () => state.authority,
      now: NOW,
    });
    assert.equal(signer.authority, state.authority);
    assert.equal(Object.isFrozen(signer), true);
    assert.equal("runtimeKey" in signer, false, "the private key never leaves the Authority owner");

    const binding = signer.issueSessionBinding({
      sessionId: "sess_authority-test",
      repository: { id: "1330755860", name: "yohn-jp/gh-inari" },
      task: { kind: "issue", number: ISSUE },
      capabilities: [{ kind: "change.implement", issue: ISSUE }],
      ttlSeconds: 300,
      now: NOW,
    });
    assert.deepEqual(verifyLocalSessionBinding(binding, state.authority, { now: NOW }).value, binding);

    const record = await signer.signChangeProvenance(ISSUE);
    const payload = verifyChangeProvenanceRecord(record, state.authority);
    assert.equal(payload.rootIssue, ISSUE);
    assert.equal(payload.operation, "change.issue");
  } finally {
    await state.cleanup();
  }
});

test("the Authority owner fails closed on missing custody, key mismatch and trust mismatch", async () => {
  const state = await fixture();
  try {
    const other = createDelegatorRecord({
      id: "other-runtime-authority",
      key: generateDelegatorKeyPair(),
      notBefore: new Date("2026-08-01T00:00:00.000Z"),
      maxSessionTtlSeconds: 3_600,
      capabilityCeiling: ["change.implement"],
    });
    assert.throws(
      () => openLocalRuntimeAuthority({ environment: state.environment, trustedAuthority: () => other }),
      code("ADMISSION_AUTHORITY_MISMATCH"),
    );

    let trustRead = false;
    await unlink(localComponentPath("authority", "private-key.pem", state.environment));
    assert.throws(
      () =>
        openLocalRuntimeAuthority({
          environment: state.environment,
          trustedAuthority: () => {
            trustRead = true;
            return state.authority;
          },
        }),
      code("RUNTIME_AUTHORITY_KEY_NOT_FOUND"),
    );
    assert.equal(trustRead, false, "Admission trust is consulted only after key custody is proven");
  } finally {
    await state.cleanup();
  }

  const empty = await mkdtemp(path.join(os.tmpdir(), "inari-runtime-authority-empty-"));
  try {
    assert.throws(
      () =>
        openLocalRuntimeAuthority({
          environment: { INARI_CONFIG_HOME: path.join(empty, "config") },
          trustedAuthority: () => {
            throw new Error("unreachable");
          },
        }),
      code("LOCAL_CONTROL_INVALID_CONFIG"),
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
