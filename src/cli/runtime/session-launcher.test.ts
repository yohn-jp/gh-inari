import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRepositoryBranchPolicy } from "../../repository-branch-policy.js";
import { createDelegatorRecord } from "../../agent-authority/delegator-operations.js";
import { loadDelegatorKeyPair } from "../../agent-authority/delegator-key.js";
import { validateDelegator } from "../../agent-authority/delegator.js";
import { setupLocalAuthority } from "../../local-control/identity.js";
import { localComponentPath, writeLocalJson } from "../../local-control/config.js";
import { startLocalSession } from "./session-launcher.js";

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
