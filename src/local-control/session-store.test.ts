import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { localComponentDirectory, localComponentPath } from "./config.js";
import { createLocalSessionBinding, type LocalSessionBinding } from "./session-binding.js";
import {
  AdmissionSessionStoreError,
  closeAdmissionSession,
  createAdmissionSession,
  readAdmissionSession,
} from "./session-store.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const REPOSITORY = { id: "1330755860", name: "yohn-jp/gh-inari" };

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-admission-session-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

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

function bindingFixture(
  keyPair: ReturnType<typeof generateDelegatorKeyPair>,
  authority: ReturnType<typeof authorityFixture>["authority"],
  sessionId: string,
  issue = 1027,
  ttlSeconds = 120,
): LocalSessionBinding {
  return createLocalSessionBinding({
    sessionId,
    repository: REPOSITORY,
    task: { kind: "issue", number: issue },
    capabilities: [{ kind: "change.implement", issue }],
    ttlSeconds,
    runtimeAuthority: authority,
    runtimeKey: keyPair,
    now: NOW,
  });
}

function hasCode(code: string) {
  return (error: unknown): boolean => error instanceof AdmissionSessionStoreError && error.code === code;
}

test("creates bounded atomic per-Session records and exact active reuse is idempotent", async () => {
  const { root, environment } = await temporaryEnvironment();
  const { keyPair, authority } = authorityFixture();
  const binding = bindingFixture(keyPair, authority, "session-active");
  try {
    const first = createAdmissionSession(binding, authority, { environment, now: NOW });
    const second = createAdmissionSession(binding, authority, { environment, now: NOW });
    assert.equal(first.status, "active");
    assert.deepEqual(second, first);

    const recordPath = localComponentPath("admission", "sessions/session-active.json", environment);
    const persisted = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
    assert.deepEqual(persisted, first.record);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    assert.equal((await stat(localComponentDirectory("admission", environment))).mode & 0o077, 0);
    const sessionsDirectory = path.join(localComponentDirectory("admission", environment), "sessions");
    assert.equal((await stat(sessionsDirectory)).mode & 0o077, 0);
    assert.deepEqual(await readdir(sessionsDirectory), ["session-active.json"]);
    assert.deepEqual(readAdmissionSession("session-active", authority, { environment, now: NOW }), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects mismatched and closed reuse while close preserves the immutable binding", async () => {
  const { root, environment } = await temporaryEnvironment();
  const { keyPair, authority } = authorityFixture();
  const binding = bindingFixture(keyPair, authority, "session-close");
  const mismatched = bindingFixture(keyPair, authority, "session-close", 1028);
  try {
    createAdmissionSession(binding, authority, { environment, now: NOW });
    assert.throws(
      () => createAdmissionSession(mismatched, authority, { environment, now: NOW }),
      hasCode("ADMISSION_SESSION_STORE_CONFLICT"),
    );

    const closed = closeAdmissionSession(binding, authority, { environment, now: NOW });
    assert.equal(closed.status, "closed");
    assert.equal(closed.record.state, "closed");
    assert.equal(closed.record.closedAt, Math.floor(NOW.getTime() / 1000));
    assert.deepEqual(closed.record.binding, binding);
    assert.equal(readAdmissionSession("session-close", authority, { environment, now: NOW })?.status, "closed");
    assert.throws(
      () => createAdmissionSession(binding, authority, { environment, now: NOW }),
      hasCode("ADMISSION_SESSION_STORE_CLOSED"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derives expiry deterministically from the injected clock and refuses expired reuse", async () => {
  const { root, environment } = await temporaryEnvironment();
  const { keyPair, authority } = authorityFixture();
  const binding = bindingFixture(keyPair, authority, "session-expired");
  try {
    createAdmissionSession(binding, authority, { environment, now: NOW });
    assert.equal(
      readAdmissionSession("session-expired", authority, { environment, now: new Date((binding.exp - 1) * 1000) })
        ?.status,
      "active",
    );
    const expiry = new Date(binding.exp * 1000);
    assert.equal(readAdmissionSession("session-expired", authority, { environment, now: expiry })?.status, "expired");
    assert.throws(
      () => createAdmissionSession(binding, authority, { environment, now: expiry }),
      hasCode("ADMISSION_SESSION_STORE_EXPIRED"),
    );
    const closed = closeAdmissionSession(binding, authority, { environment, now: expiry });
    assert.equal(closed.status, "closed");
    assert.deepEqual(closed.record.binding, binding);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists distinct concurrent Session ids independently with no shared selector", async () => {
  const { root, environment } = await temporaryEnvironment();
  const { keyPair, authority } = authorityFixture();
  const bindings = [
    bindingFixture(keyPair, authority, "session-parallel-a"),
    bindingFixture(keyPair, authority, "session-parallel-b"),
  ];
  try {
    const snapshots = await Promise.all(
      bindings.map(async (binding) => {
        await Promise.resolve();
        return createAdmissionSession(binding, authority, { environment, now: NOW });
      }),
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.record.binding.sessionId),
      ["session-parallel-a", "session-parallel-b"],
    );
    assert.deepEqual((await readdir(path.join(localComponentDirectory("admission", environment), "sessions"))).sort(), [
      "session-parallel-a.json",
      "session-parallel-b.json",
    ]);
    for (const binding of bindings) {
      const loaded = readAdmissionSession(binding.sessionId, authority, { environment, now: NOW });
      assert.equal(loaded?.record.binding.sessionId, binding.sessionId);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a record is presented with a different trusted Authority", async () => {
  const { root, environment } = await temporaryEnvironment();
  const { keyPair, authority } = authorityFixture();
  const binding = bindingFixture(keyPair, authority, "session-trust");
  const other = authorityFixture();
  const mismatchedAuthority = createDelegatorRecord({
    id: authority.id,
    key: other.keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready"],
  });
  try {
    createAdmissionSession(binding, authority, { environment, now: NOW });
    assert.throws(
      () => readAdmissionSession(binding.sessionId, mismatchedAuthority, { environment, now: NOW }),
      hasCode("ADMISSION_SESSION_STORE_TRUST_MISMATCH"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
