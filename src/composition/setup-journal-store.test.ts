import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_SETUP_JOURNAL_ENTRIES,
  findSetupSecretMaterial,
  type SetupActionOutcome,
  type SetupJournalEntry,
  type SetupJournalPhase,
} from "../runtime-contracts/index.js";
import { setupStateFileKey } from "./setup-config-store.js";
import { SetupJournalStore } from "./setup-journal-store.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const generation = { repository, configuration: "cfg-1" };

function entry(
  actionId: string,
  phase: SetupJournalPhase,
  outcome?: SetupActionOutcome,
  second = 0,
  message = "m",
): SetupJournalEntry {
  return {
    version: 1,
    actionId,
    owner: "executor",
    generation,
    phase,
    ...(outcome === undefined ? {} : { outcome }),
    recordedAt: new Date(Date.UTC(2026, 8, 25, 0, 0, second)).toISOString(),
    diagnostics: [{ code: "SETUP_TEST", message }],
  };
}

function home(): { environment: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-setup-journal-"));
  return { root, environment: { INARI_CONFIG_HOME: root } };
}

test("unfinished and unknown attempts survive a process restart", async () => {
  const { root, environment } = home();
  try {
    const first = new SetupJournalStore({ environment });
    await first.append(entry("executor.configure:1", "requested"));
    await first.append(entry("executor.configure:1", "confirmed"));
    await first.append(entry("executor.bind-repository:1", "requested"));
    await first.append(entry("executor.bind-repository:1", "completed", "unknown"));
    const restarted = new SetupJournalStore({ environment: { INARI_CONFIG_HOME: root } });
    const entries = await restarted.read(repository);
    assert.deepEqual(
      entries.map((item) => `${item.actionId}/${item.phase}/${item.outcome ?? "-"}`),
      [
        "executor.configure:1/requested/-",
        "executor.configure:1/confirmed/-",
        "executor.bind-repository:1/requested/-",
        "executor.bind-repository:1/completed/unknown",
      ],
    );
    const stored: unknown = JSON.parse(
      readFileSync(path.join(root, "runtime", "setup", `${setupStateFileKey(repository)}.journal.json`), "utf8"),
    );
    assert.deepEqual(findSetupSecretMaterial(stored), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret-bearing or invalid entries are rejected before storage", async () => {
  const { root, environment } = home();
  try {
    const store = new SetupJournalStore({ environment });
    await assert.rejects(store.append(entry("a:1", "requested", undefined, 0, "-----BEGIN PRIVATE KEY-----")), {
      code: "RUNTIME_CONTRACT_SECRET_MATERIAL",
    });
    await assert.rejects(store.append({ ...entry("a:1", "requested"), outcome: "succeeded" }));
    assert.deepEqual(await store.read(repository), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention is bounded and keeps recovery evidence over settled history", async () => {
  const { root, environment } = home();
  try {
    const store = new SetupJournalStore({ environment });
    await store.append(entry("keep-unknown:1", "requested"));
    await store.append(entry("keep-unknown:1", "completed", "unknown"));
    await store.append(entry("keep-open:1", "requested"));
    for (let index = 0; index < MAX_SETUP_JOURNAL_ENTRIES + 10; index += 1) {
      await store.append(entry(`settled:${index}`, "requested", undefined, index % 60));
      await store.append(entry(`settled:${index}`, "completed", "failed", index % 60));
    }
    const entries = await store.read(repository);
    assert.ok(entries.length <= MAX_SETUP_JOURNAL_ENTRIES);
    const ids = entries.map((item) => `${item.actionId}/${item.phase}`);
    assert.ok(ids.includes("keep-unknown:1/completed"));
    assert.ok(ids.includes("keep-open:1/requested"));
    assert.ok(ids.includes(`settled:${MAX_SETUP_JOURNAL_ENTRIES + 9}/completed`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a journal holding only recovery evidence refuses further attempts instead of dropping evidence", async () => {
  const { root, environment } = home();
  try {
    const store = new SetupJournalStore({ environment });
    for (let index = 0; index < MAX_SETUP_JOURNAL_ENTRIES; index += 1)
      await store.append(entry(`open:${index}`, "requested"));
    await assert.rejects(store.append(entry("another:1", "requested")), { code: "SETUP_JOURNAL_FULL" });
    assert.equal((await store.read(repository)).length, MAX_SETUP_JOURNAL_ENTRIES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable journal fails closed", async () => {
  const { root, environment } = home();
  try {
    const store = new SetupJournalStore({ environment });
    await store.append(entry("a:1", "requested"));
    writeFileSync(path.join(root, "runtime", "setup", `${setupStateFileKey(repository)}.journal.json`), "[]", {
      mode: 0o600,
    });
    await assert.rejects(store.read(repository), { code: "SETUP_JOURNAL_UNREADABLE" });
    await assert.rejects(store.append(entry("a:1", "confirmed")), { code: "SETUP_JOURNAL_UNREADABLE" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
