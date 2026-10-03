import assert from "node:assert/strict";
import { execFileSync, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLocalAdmissionClient } from "./admission-client.js";
import { createRepositoryBranchPolicy } from "../../repository-branch-policy.js";
import { createDelegatorRecord } from "../../agent-authority/delegator-operations.js";
import { loadDelegatorKeyPair } from "../../agent-authority/delegator-key.js";
import { validateDelegator } from "../../agent-authority/delegator.js";
import { setupLocalAuthority } from "../../local-control/identity.js";
import { localComponentPath, writeLocalJson } from "../../local-control/config.js";
import type { LocalSessionBinding } from "../../local-control/session-binding.js";
import {
  readLocalSessionChangeIssueProvenance,
  startLocalSession,
  storeLocalSessionChangeIssueProvenance,
} from "./session-launcher.js";

test("Session launcher rejects stale injected branch policy before registration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-policy-launcher-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["checkout", "-q", "-b", "work/375-session"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/inari.git"], { cwd: root });
    const environment = { INARI_CONFIG_HOME: path.join(root, "config"), PATH: process.env.PATH ?? "" };
    setupLocalAuthority(environment);
    const keyPair = loadDelegatorKeyPair(localComponentPath("authority", "private-key.pem", environment));
    const authority = createDelegatorRecord({
      id: "launcher-policy-test",
      key: keyPair,
      notBefore: new Date("2026-08-01T00:00:00.000Z"),
      maxSessionTtlSeconds: 3600,
      capabilityCeiling: ["change.implement", "branch.advance"],
    });
    writeLocalJson(
      "admission",
      "runtime-authority.json",
      authority,
      (value) => {
        const valid = validateDelegator(value);
        if (!valid.valid || valid.value === undefined) throw new Error("invalid authority");
        return valid.value;
      },
      environment,
    );
    const generation = { ref: "trunk", treeSha: "a".repeat(40) };
    const acquired = createRepositoryBranchPolicy({
      generation: {
        authority: "repository-default-branch",
        repository: {
          host: "github.com",
          repositoryId: "123",
          owner: "acme",
          name: "inari",
          nameWithOwner: "acme/inari",
        },
        ...generation,
      },
      rule: { pattern: "^work/[0-9]+-[a-z]+$", format: "work/{issueNumber}-{slug}" },
    });
    assert.equal(acquired.status, "available");
    if (acquired.status !== "available") return;
    let registrations = 0;
    await assert.rejects(
      startLocalSession({
        cwd: root,
        issue: 375,
        command: "true",
        commandArgs: [],
        environment,
        now: new Date("2026-09-01T12:00:00.000Z"),
        resolveRepository: async () => ({ host: "github.com", repositoryId: "123", nameWithOwner: "acme/inari" }),
        admission: {
          resolveRepository: async () => ({ host: "github.com", repositoryId: "123", nameWithOwner: "acme/inari" }),
          registerSession: async () => {
            registrations += 1;
            return { id: "unused", status: "active" };
          },
          closeSession: async () => ({ id: "unused", status: "closed" }),
          readBranchPolicy: async () => assert.fail("branch policy is not read by the launcher"),
          readPullRequestContext: async () => assert.fail("contracts are not read by the launcher"),
          executeIntent: async () => {
            throw new Error("unreachable");
          },
        },
        branchObservation: {
          policy: acquired.policy,
          target: { repository: { repositoryHost: "github.com", repositoryId: "123" }, implementation: 375 },
          observedGeneration: { ref: "trunk", treeSha: "b".repeat(40) },
          naming: { slug: "session" },
        },
      }),
      /branch|policy/u,
    );
    assert.equal(registrations, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1213 a Source-bound Session keeps the Implementation task and issues per-Source claims and provenance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-source-launcher-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["checkout", "-q", "-b", "fix/1213-source-binding"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/inari.git"], { cwd: root });
    const environment: NodeJS.ProcessEnv = {
      INARI_CONFIG_HOME: path.join(root, "config"),
      PATH: process.env.PATH ?? "",
    };
    setupLocalAuthority(environment);
    const keyPair = loadDelegatorKeyPair(localComponentPath("authority", "private-key.pem", environment));
    const authority = createDelegatorRecord({
      id: "launcher-source-test",
      key: keyPair,
      notBefore: new Date("2026-08-01T00:00:00.000Z"),
      maxSessionTtlSeconds: 3600,
      capabilityCeiling: ["change.implement", "change.ready", "branch.advance", "pullRequest.create"],
    });
    writeLocalJson(
      "admission",
      "runtime-authority.json",
      authority,
      (value) => {
        const valid = validateDelegator(value);
        if (!valid.valid || valid.value === undefined) throw new Error("invalid authority");
        return valid.value;
      },
      environment,
    );
    const acquired = createRepositoryBranchPolicy({
      generation: {
        authority: "repository-default-branch",
        repository: {
          host: "github.com",
          repositoryId: "123",
          owner: "acme",
          name: "inari",
          nameWithOwner: "acme/inari",
        },
        ref: "main",
        treeSha: "a".repeat(40),
      },
    });
    assert.equal(acquired.status, "available");
    if (acquired.status !== "available") return;
    const repository = { repositoryHost: "github.com", repositoryId: "123" };
    const sources = [
      { ...repository, number: 1208 },
      { ...repository, number: 1209 },
      { repositoryHost: "github.com", repositoryId: "987", number: 7 },
    ];
    const implementationBinding = {
      version: 1,
      kind: "implementation-session-binding",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...repository, number: 1213 },
        governedBodyDigest: "c".repeat(64),
      },
      repository,
      base: { branch: "main", revision: "d".repeat(40), freshness: "d".repeat(40) },
      task: { kind: "issue", number: 1213 },
      sources,
    } as const;
    const branchObservation = {
      policy: acquired.policy,
      target: { repository, implementation: 1213 },
      observedGeneration: { ref: "main", treeSha: "a".repeat(40) },
      binding: { repository, implementation: 1213, branch: "fix/1213-source-binding" },
      sources,
      implementationBinding,
    };
    const registered: LocalSessionBinding[] = [];
    const admission = createLocalAdmissionClient({
      endpoint: "http://127.0.0.1:43123",
      fetchImpl: async (input, init) => {
        assert.equal(new URL(String(input)).pathname, "/v1/sessions");
        assert.equal(init?.method, "POST");
        const { binding } = JSON.parse(String(init.body)) as { binding: LocalSessionBinding };
        t.mock.timers.tick(13_800);
        init.signal?.throwIfAborted();
        registered.push(binding);
        return new Response(JSON.stringify({ ok: true, session: { id: binding.sessionId, status: "active" } }));
      },
    });
    const start = (overrides: Partial<Parameters<typeof startLocalSession>[0]> = {}) =>
      startLocalSession({
        cwd: root,
        issue: 1213,
        command: "true",
        commandArgs: [],
        environment,
        now: new Date("2026-09-01T12:00:00.000Z"),
        resolveRepository: async () => ({ host: "github.com", repositoryId: "123", nameWithOwner: "acme/inari" }),
        admission,
        branchObservation,
        ...overrides,
      });

    // Owner Sources without the current authorized Implementation projection fail closed.
    const { implementationBinding: _missing, ...withoutBinding } = branchObservation;
    await assert.rejects(start({ branchObservation: withoutBinding }), {
      code: "ADMISSION_SESSION_IMPLEMENTATION_BINDING_REQUIRED",
    });
    assert.equal(registered.length, 0);

    // Registration exceeding 10 seconds must still reach the child command.
    assert.equal(await start(), 0);
    const binding = registered[0];
    assert.ok(binding);
    assert.deepEqual(binding.task, { kind: "issue", number: 1213 });
    assert.deepEqual(binding.capabilities, [
      { kind: "change.implement", issue: 1208 },
      { kind: "change.ready", issue: 1208 },
      { kind: "change.implement", issue: 1209 },
      { kind: "change.ready", issue: 1209 },
      { kind: "pullRequest.create", head: "fix/1213-source-binding", base: "main", max: 1 },
      { kind: "branch.advance", branch: "fix/1213-source-binding" },
    ]);
    assert.equal(binding.branchObservation?.implementation, 1213);
    assert.equal("sources" in (binding.branchObservation ?? {}), false);
    assert.deepEqual(binding.implementationBinding?.sources, [
      { ...repository, number: 1208 },
      { ...repository, number: 1209 },
      { repositoryHost: "github.com", repositoryId: "987", number: 7 },
    ]);
    await assert.rejects(
      start({
        branchObservation: {
          ...branchObservation,
          target: { repository, implementation: 4242 },
        },
      }),
      { code: "ADMISSION_SESSION_BRANCH_MISMATCH" },
    );
    assert.equal(registered.length, 1);

    const missingCeilingEnvironment: NodeJS.ProcessEnv = {
      INARI_CONFIG_HOME: path.join(root, "missing-ceiling-config"),
      PATH: process.env.PATH ?? "",
    };
    setupLocalAuthority(missingCeilingEnvironment);
    const missingCeilingKeyPair = loadDelegatorKeyPair(
      localComponentPath("authority", "private-key.pem", missingCeilingEnvironment),
    );
    const authorityWithoutPullRequest = createDelegatorRecord({
      id: "launcher-source-without-pr-test",
      key: missingCeilingKeyPair,
      notBefore: new Date("2026-08-01T00:00:00.000Z"),
      maxSessionTtlSeconds: 3600,
      capabilityCeiling: ["change.implement", "change.ready", "branch.advance"],
    });
    writeLocalJson(
      "admission",
      "runtime-authority.json",
      authorityWithoutPullRequest,
      (value) => {
        const valid = validateDelegator(value);
        if (!valid.valid || valid.value === undefined) throw new Error("invalid authority");
        return valid.value;
      },
      missingCeilingEnvironment,
    );
    await assert.rejects(start({ environment: missingCeilingEnvironment }), {
      code: "ADMISSION_SESSION_CAPABILITY_UNAVAILABLE",
    });
    assert.equal(registered.length, 1);
    for (const issue of [1208, 1209])
      assert.equal(readLocalSessionChangeIssueProvenance(binding, environment, issue)?.rootIssue, issue);
    for (const issue of [1213, 7, 4242])
      assert.equal(readLocalSessionChangeIssueProvenance(binding, environment, issue), undefined);
    const sessions = path.join(environment.INARI_CONFIG_HOME as string, "cli", "sessions");
    assert.deepEqual((await readdir(sessions)).sort(), ["change-issue-provenance", `${binding.sessionId}.json`].sort());
    assert.deepEqual((await readdir(path.join(sessions, "change-issue-provenance", binding.sessionId))).sort(), [
      "1208.json",
      "1209.json",
    ]);

    // Provenance for one Source cannot be stored as another Source's artifact.
    const other = readLocalSessionChangeIssueProvenance(binding, environment, 1208);
    assert.ok(other);
    assert.throws(
      () =>
        storeLocalSessionChangeIssueProvenance(
          { ...binding, capabilities: binding.capabilities.slice(2) },
          other,
          environment,
        ),
      { code: "ADMISSION_CHANGE_PROVENANCE_MISMATCH" },
    );

    // Reuse reads the stored per-Source provenance without the Authority key.
    await unlink(localComponentPath("authority", "private-key.pem", environment));
    assert.equal(await start({ environment: { ...environment, INARI_SESSION_ID: binding.sessionId } }), 0);
    assert.deepEqual(registered[1], binding);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1213 a Session launches with the full Source-bound lifecycle for more than three Sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-many-sources-launcher-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["checkout", "-q", "-b", "fix/1213-source-binding"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/inari.git"], { cwd: root });
    const environment: NodeJS.ProcessEnv = {
      INARI_CONFIG_HOME: path.join(root, "config"),
      PATH: process.env.PATH ?? "",
    };
    setupLocalAuthority(environment);
    const keyPair = loadDelegatorKeyPair(localComponentPath("authority", "private-key.pem", environment));
    const lifecycle = ["change.implement", "change.ready", "change.abort", "change.merge"] as const;
    const authority = createDelegatorRecord({
      id: "launcher-many-sources-test",
      key: keyPair,
      notBefore: new Date("2026-08-01T00:00:00.000Z"),
      maxSessionTtlSeconds: 3600,
      capabilityCeiling: [...lifecycle, "branch.advance", "pullRequest.create"],
    });
    writeLocalJson(
      "admission",
      "runtime-authority.json",
      authority,
      (value) => {
        const valid = validateDelegator(value);
        if (!valid.valid || valid.value === undefined) throw new Error("invalid authority");
        return valid.value;
      },
      environment,
    );
    const acquired = createRepositoryBranchPolicy({
      generation: {
        authority: "repository-default-branch",
        repository: {
          host: "github.com",
          repositoryId: "123",
          owner: "acme",
          name: "inari",
          nameWithOwner: "acme/inari",
        },
        ref: "main",
        treeSha: "a".repeat(40),
      },
    });
    assert.equal(acquired.status, "available");
    if (acquired.status !== "available") return;
    const repository = { repositoryHost: "github.com", repositoryId: "123" };
    const sameRepository = [1201, 1202, 1203, 1204, 1205];
    const sources = [
      ...sameRepository.map((number) => ({ ...repository, number })),
      { repositoryHost: "github.com", repositoryId: "987", number: 7 },
    ];
    const implementationBinding = {
      version: 1,
      kind: "implementation-session-binding",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...repository, number: 1213 },
        governedBodyDigest: "c".repeat(64),
      },
      repository,
      base: { branch: "main", revision: "d".repeat(40), freshness: "d".repeat(40) },
      task: { kind: "issue", number: 1213 },
      sources,
    } as const;
    const registered: LocalSessionBinding[] = [];
    const exitCode = await startLocalSession({
      cwd: root,
      issue: 1213,
      command: "true",
      commandArgs: [],
      environment,
      now: new Date("2026-09-01T12:00:00.000Z"),
      resolveRepository: async () => ({ host: "github.com", repositoryId: "123", nameWithOwner: "acme/inari" }),
      admission: {
        resolveRepository: async () => ({
          host: "github.com" as const,
          repositoryId: "123",
          nameWithOwner: "acme/inari",
        }),
        registerSession: async (binding: LocalSessionBinding) => {
          registered.push(binding);
          return { id: binding.sessionId, status: "active" };
        },
        closeSession: async () => ({ id: "unused", status: "closed" }),
        readBranchPolicy: async () => assert.fail("branch policy is not read by the launcher"),
        readPullRequestContext: async () => assert.fail("contracts are not read by the launcher"),
        executeIntent: async () => {
          throw new Error("unreachable");
        },
      },
      branchObservation: {
        policy: acquired.policy,
        target: { repository, implementation: 1213 },
        observedGeneration: { ref: "main", treeSha: "a".repeat(40) },
        binding: { repository, implementation: 1213, branch: "fix/1213-source-binding" },
        sources,
        implementationBinding,
      },
      spawnChild: (() => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0));
        return child;
      }) as unknown as typeof spawn,
    });
    assert.equal(exitCode, 0);
    const binding = registered[0];
    assert.ok(binding);
    assert.deepEqual(binding.task, { kind: "issue", number: 1213 });
    assert.deepEqual(binding.capabilities, [
      ...sameRepository.flatMap((issue) => lifecycle.map((kind) => ({ kind, issue }))),
      { kind: "pullRequest.create", head: "fix/1213-source-binding", base: "main", max: 1 },
      { kind: "branch.advance", branch: "fix/1213-source-binding" },
    ]);
    for (const issue of sameRepository)
      assert.equal(readLocalSessionChangeIssueProvenance(binding, environment, issue)?.rootIssue, issue);
    for (const issue of [1213, 7, 4242])
      assert.equal(readLocalSessionChangeIssueProvenance(binding, environment, issue), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
