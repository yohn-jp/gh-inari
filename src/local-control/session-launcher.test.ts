import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { loadDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { validateDelegator, type Delegator } from "../agent-authority/delegator.js";
import { setupLocalAuthority } from "./identity.js";
import { localComponentPath, validateLocalAuthorityConfig, writeLocalJson } from "./config.js";
import type { LocalAdmissionClient } from "./admission-client.js";
import {
  closeLocalSession,
  readLocalSessionBinding,
  startLocalSession,
  type LocalSessionRepositoryIdentity,
} from "./session-launcher.js";
import { verifyLocalSessionBinding, type LocalSessionBinding } from "./session-binding.js";

const ISSUE = 1029;
const NOW = new Date("2026-09-01T12:00:00.000Z");
const REPOSITORY = { id: "1330755860", name: "acme/inari" };

interface Fixture {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly authority: Delegator;
  readonly privateKeyPath: string;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-session-launcher-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "config"), PATH: process.env.PATH ?? "" };
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/inari.git"], { cwd: root });
  setupLocalAuthority(environment);
  const privateKeyPath = localComponentPath("authority", "private-key.pem", environment);
  const keyPair = loadDelegatorKeyPair(privateKeyPath);
  const authority = createDelegatorRecord({
    id: "local-session-launcher-test",
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort", "change.merge"],
  });
  writeLocalJson(
    "admission",
    "runtime-authority.json",
    authority,
    (value) => {
      const validation = validateDelegator(value);
      if (!validation.valid || validation.value === undefined) throw new Error("invalid fixture authority");
      return validation.value;
    },
    environment,
  );
  return { root, environment, authority, privateKeyPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

interface CapturedChild {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: boolean | undefined;
  readonly stdio: unknown;
}

function fakeSpawner(exitCode: number, captures: CapturedChild[]): typeof spawn {
  return ((
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; stdio?: unknown },
  ) => {
    captures.push({
      command,
      args: [...args],
      cwd: options.cwd ?? "",
      env: options.env ?? {},
      shell: options.shell,
      stdio: options.stdio,
    });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", exitCode, null));
    return child as ChildProcess;
  }) as typeof spawn;
}

function fakeAdmission() {
  const registrations: LocalSessionBinding[] = [];
  const closes: LocalSessionBinding[] = [];
  const client: LocalAdmissionClient = {
    async registerSession(binding) {
      registrations.push(binding);
      return { id: binding.sessionId, status: "active" };
    },
    async closeSession(binding) {
      closes.push(binding);
      return { id: binding.sessionId, status: "closed" };
    },
    async executeIntent() {
      throw new Error("session launcher must not execute Change operations");
    },
  };
  return { client, registrations, closes };
}

const resolveRepository = async (): Promise<LocalSessionRepositoryIdentity> => ({
  host: "github.com",
  repositoryId: REPOSITORY.id,
  nameWithOwner: REPOSITORY.name,
});

test("issues and registers one bounded binding, launches exact argv, isolates the child selector, and propagates exit", async () => {
  const state = await fixture();
  const admission = fakeAdmission();
  const children: CapturedChild[] = [];
  const parentEnvironment: NodeJS.ProcessEnv = { ...state.environment, PARENT_ONLY: "unchanged" };
  try {
    const exitCode = await startLocalSession({
      cwd: state.root,
      issue: ISSUE,
      command: process.execPath,
      commandArgs: ["-e", "process.exit(19)", "one argument"],
      environment: parentEnvironment,
      admission: admission.client,
      resolveRepository,
      spawnChild: fakeSpawner(19, children),
      now: NOW,
    });

    assert.equal(exitCode, 19);
    assert.equal(admission.registrations.length, 1);
    const binding = admission.registrations[0];
    assert.ok(binding);
    assert.match(binding.sessionId, /^sess_[A-Za-z0-9_-]{43}$/u);
    assert.ok(binding.sessionId.length <= 128);
    assert.deepEqual(binding.repository, REPOSITORY);
    assert.deepEqual(binding.task, { kind: "issue", number: ISSUE });
    assert.deepEqual(
      verifyLocalSessionBinding(binding, state.authority, { now: NOW }).value,
      binding,
      "the separately custodied local Authority must sign the registered binding",
    );
    assert.ok(binding.capabilities.some((claim) => claim.kind === "change.implement" && claim.issue === ISSUE));
    assert.equal(children.length, 1);
    assert.equal(children[0]?.command, process.execPath);
    assert.deepEqual(children[0]?.args, ["-e", "process.exit(19)", "one argument"]);
    assert.equal(children[0]?.cwd, state.root);
    assert.equal(children[0]?.shell, false);
    assert.equal(children[0]?.stdio, "inherit");
    assert.deepEqual(children[0]?.env, { ...parentEnvironment, INARI_SESSION_ID: binding.sessionId });
    assert.equal(parentEnvironment.INARI_SESSION_ID, undefined);
    assert.equal(admission.closes.length, 0);

    const sessionFiles = await readdir(path.join(state.environment.INARI_CONFIG_HOME as string, "cli", "sessions"));
    assert.deepEqual(sessionFiles, [`${binding.sessionId}.json`]);
    assert.equal(
      sessionFiles.some((name) => name.includes("current")),
      false,
    );
  } finally {
    await state.cleanup();
  }
});

test("an inherited Session ID is reused with its exact binding and malformed IDs fail before admission", async () => {
  const state = await fixture();
  const admission = fakeAdmission();
  const children: CapturedChild[] = [];
  let repositoryResolutions = 0;
  try {
    await startLocalSession({
      cwd: state.root,
      issue: ISSUE,
      command: "agent",
      commandArgs: [],
      environment: state.environment,
      admission: admission.client,
      resolveRepository,
      spawnChild: fakeSpawner(0, children),
      now: NOW,
    });
    const firstBinding = admission.registrations[0];
    assert.ok(firstBinding);
    await unlink(state.privateKeyPath);

    const inheritedEnvironment = { ...state.environment, INARI_SESSION_ID: firstBinding.sessionId };
    await startLocalSession({
      cwd: state.root,
      issue: ISSUE,
      command: "agent",
      commandArgs: ["--continue"],
      environment: inheritedEnvironment,
      admission: admission.client,
      resolveRepository: async () => {
        repositoryResolutions += 1;
        throw new Error("cached binding should supply repository identity");
      },
      spawnChild: fakeSpawner(0, children),
      now: NOW,
    });
    assert.equal(repositoryResolutions, 0);
    assert.deepEqual(admission.registrations[1], firstBinding);
    assert.equal(children[1]?.env.INARI_SESSION_ID, firstBinding.sessionId);

    const malformedAdmission = fakeAdmission();
    await assert.rejects(
      startLocalSession({
        cwd: state.root,
        issue: ISSUE,
        command: "agent",
        commandArgs: [],
        environment: { ...state.environment, INARI_SESSION_ID: "not/a/session" },
        admission: malformedAdmission.client,
        resolveRepository,
        spawnChild: fakeSpawner(0, []),
        now: NOW,
      }),
      { code: "ADMISSION_SESSION_SELECTOR_INVALID" },
    );
    assert.equal(malformedAdmission.registrations.length, 0);
  } finally {
    await state.cleanup();
  }
});

test("close requires the inherited selector, closes only its exact binding, and needs no Authority key", async () => {
  const state = await fixture();
  const admission = fakeAdmission();
  const children: CapturedChild[] = [];
  try {
    await startLocalSession({
      cwd: state.root,
      issue: ISSUE,
      command: "agent",
      commandArgs: [],
      environment: state.environment,
      admission: admission.client,
      resolveRepository,
      spawnChild: fakeSpawner(0, children),
      now: NOW,
    });
    const first = admission.registrations[0];
    assert.ok(first);
    const otherEnvironment = { ...state.environment, INARI_SESSION_ID: "sess_other-selected-session" };
    const otherAdmission = fakeAdmission();
    await startLocalSession({
      cwd: state.root,
      issue: ISSUE,
      command: "agent",
      commandArgs: [],
      environment: otherEnvironment,
      admission: otherAdmission.client,
      resolveRepository,
      spawnChild: fakeSpawner(0, children),
      now: NOW,
    });
    const second = otherAdmission.registrations[0];
    assert.ok(second);
    await unlink(state.privateKeyPath);

    const missingSelectorAdmission = fakeAdmission();
    await assert.rejects(
      closeLocalSession({ environment: state.environment, admission: missingSelectorAdmission.client }),
      { code: "ADMISSION_SESSION_SELECTOR_REQUIRED" },
    );
    assert.equal(missingSelectorAdmission.closes.length, 0);

    const closed = await closeLocalSession({
      environment: { ...state.environment, INARI_SESSION_ID: second.sessionId },
      admission: admission.client,
    });
    assert.deepEqual(closed, { id: second.sessionId, status: "closed" });
    assert.equal(admission.closes.length, 1);
    assert.deepEqual(admission.closes[0], second);
    assert.notEqual(admission.closes[0]?.sessionId, first.sessionId);
    assert.equal(readLocalSessionBinding(first.sessionId, state.environment)?.sessionId, first.sessionId);
  } finally {
    await state.cleanup();
  }
});
