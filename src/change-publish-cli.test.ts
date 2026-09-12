import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import {
  createSessionCredentialBundle,
  persistSessionCredentialBundle,
  type SessionIssuanceRequestDocument,
} from "./agent-authority/session-bundle.js";
import { assertRuntimeAuthority, type RuntimeAuthority } from "./agent-authority/runtime-authority.js";
import { generateRuntimeAuthorityKeyPair, type RuntimeAuthorityKeyPair } from "./agent-authority/runtime-key.js";
import { MAX_SESSION_REQUEST_BYTES } from "./agent-authority/session-request.js";

const REPOSITORY = Object.freeze({ id: "123456789", name: "yohn-jp/gh-inari" });
const NOW = new Date("2026-09-12T12:00:00Z");
const BRANCH = "feat/467-cli-app-transport";

function authority(runtimeKey: RuntimeAuthorityKeyPair): RuntimeAuthority {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "test-runtime",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2020-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort"],
  });
}

async function createBundleFile(dir: string): Promise<string> {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const request: SessionIssuanceRequestDocument = {
    version: 1,
    kind: "inari-session-issuance-request",
    runtimeAuthority: authority(runtimeKey),
    repository: REPOSITORY,
    task: { kind: "issue", number: 467 },
    capabilities: [{ kind: "change.implement", issue: 467 }],
    ttlSeconds: 1800,
  } as SessionIssuanceRequestDocument;
  const created = createSessionCredentialBundle({ request, runtimeKey, now: NOW });
  const filePath = path.join(dir, "bundle.json");
  persistSessionCredentialBundle(filePath, created.bundle);
  return filePath;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function initRepo(dir: string): Promise<void> {
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["config", "user.email", "agent@example.com"]);
  git(dir, ["config", "user.name", "Agent"]);
}

async function commit(dir: string, message: string): Promise<string> {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function showResponseBody(branchSha: string): unknown {
  return {
    version: 1,
    ok: true,
    operation: "change.show",
    requestId: "r1",
    result: {
      version: 1,
      status: "succeeded",
      projection: {
        valid: true,
        status: "healthy",
        canonicalBranch: BRANCH,
        canonicalBaseBranch: "main",
        candidates: {
          branches: [{ candidate: { name: BRANCH, sha: branchSha }, classification: "canonical", reason: "match" }],
          pullRequests: [],
        },
        change: {
          version: 1,
          identity: { repositoryHost: "github.com", repositoryId: REPOSITORY.id, rootIssue: 467 },
          state: "DRAFT",
          provenance: {},
          projection: { branch: BRANCH },
        },
        diagnostics: [],
      },
    },
  };
}

function branchAdvanceResponseBody(expectedHead: string, resultingHead: string): unknown {
  return {
    version: 1,
    ok: true,
    operation: "branch.advance",
    requestId: "r2",
    result: {
      version: 1,
      status: "succeeded",
      branchAdvance: {
        version: 1,
        operation: "branch.advance",
        status: "succeeded",
        outcome: "advanced",
        branch: BRANCH,
        expectedHead,
        resultingHead,
      },
    },
  };
}

function installFakeFetch(handler: (url: URL, body: unknown) => { status: number; body: unknown }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const { status, body: responseBody } = handler(url, body);
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function captureCli(
  argv: string[],
  repositoryRoot: string,
): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line?: unknown) => stdout.push(String(line ?? ""));
  console.error = (line?: unknown) => stderr.push(String(line ?? ""));
  try {
    return { exitCode: await runCli(argv, { repositoryRoot }), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("change publish: Session-only successful request path with exact branch.advance compilation", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".change-publish-cli-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "keep.txt"), "keep\n");
    const base = await commit(dir, "base");
    await writeFile(path.join(dir, "added.ts"), "export const x = 1;\n");
    const head = await commit(dir, "implement feature");

    const bundlePath = await createBundleFile(dir);
    let branchAdvanceRequest: Record<string, unknown> | undefined;
    const restore = installFakeFetch((url, body) => {
      assert.equal(url.pathname, "/v1/execute");
      const envelope = body as { operation: string; request: Record<string, unknown> };
      if (envelope.operation === "change.show") return { status: 200, body: showResponseBody(base) };
      if (envelope.operation === "branch.advance") {
        branchAdvanceRequest = envelope.request;
        return { status: 200, body: branchAdvanceResponseBody(base, head) };
      }
      throw new Error(`unexpected operation ${envelope.operation}`);
    });
    try {
      const { exitCode, stdout } = await captureCli(
        [
          "change",
          "publish",
          "467",
          "--session-credential",
          bundlePath,
          "--app-endpoint",
          "https://app.example.com",
          "--commit",
          head,
          "--json",
        ],
        dir,
      );
      assert.equal(exitCode, 0, stdout.join("\n"));
      const output = JSON.parse(stdout.join(""));
      assert.equal(output.ok, true);
      assert.equal(output.outcome, "advanced");
      assert.equal(output.resultingHead, head);

      assert.ok(branchAdvanceRequest !== undefined);
      assert.equal(branchAdvanceRequest.version, 1);
      assert.equal(branchAdvanceRequest.issue, 467);
      assert.equal(branchAdvanceRequest.branch, BRANCH);
      assert.equal(branchAdvanceRequest.expectedHead, base);
      assert.deepEqual(branchAdvanceRequest.changes, [
        {
          operation: "upsert",
          path: "added.ts",
          mode: "100644",
          content: Buffer.from("export const x = 1;\n").toString("base64"),
        },
      ]);
      assert.deepEqual(branchAdvanceRequest.commit, {
        message: "implement feature",
        author: { name: "Agent", email: "agent@example.com" },
      });
    } finally {
      restore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("change publish: missing Session credential file fails closed", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".change-publish-cli-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "a.txt"), "a\n");
    await commit(dir, "base");
    const { exitCode, stdout } = await captureCli(
      [
        "change",
        "publish",
        "467",
        "--session-credential",
        path.join(dir, "missing-bundle.json"),
        "--app-endpoint",
        "https://app.example.com",
        "--json",
      ],
      dir,
    );
    assert.notEqual(exitCode, 0);
    const output = JSON.parse(stdout.join(""));
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "SESSION_CREDENTIAL_INVALID");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("change publish: insecure non-localhost App endpoint is rejected before any network send", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".change-publish-cli-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "a.txt"), "a\n");
    await commit(dir, "base");
    const bundlePath = await createBundleFile(dir);
    let fetchCalled = false;
    const restore = installFakeFetch(() => {
      fetchCalled = true;
      return { status: 200, body: { ok: false, error: { code: "X", message: "unreachable" } } };
    });
    try {
      const { exitCode, stdout } = await captureCli(
        [
          "change",
          "publish",
          "467",
          "--session-credential",
          bundlePath,
          "--app-endpoint",
          "http://example.com",
          "--json",
        ],
        dir,
      );
      assert.notEqual(exitCode, 0);
      const output = JSON.parse(stdout.join(""));
      assert.equal(output.error.code, "APP_ENDPOINT_INVALID");
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("change publish: rejects an oversized branch.advance request before network send", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".change-publish-cli-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "keep.txt"), "keep\n");
    const base = await commit(dir, "base");
    // Ten files, each individually well under the 64 KiB bound #466 enforces
    // per change, whose combined signed request still exceeds the #373
    // 64 KiB bound -- this is rejected locally before any network send.
    for (let index = 0; index < 10; index += 1) {
      await writeFile(path.join(dir, `big-${index}.txt`), "x".repeat(10_000));
    }
    const head = await commit(dir, "add oversized files");

    const bundlePath = await createBundleFile(dir);
    let branchAdvanceCalled = false;
    const restore = installFakeFetch((_url, body) => {
      const envelope = body as { operation: string };
      if (envelope.operation === "change.show") return { status: 200, body: showResponseBody(base) };
      branchAdvanceCalled = true;
      return { status: 200, body: branchAdvanceResponseBody(base, head) };
    });
    try {
      const { exitCode, stdout } = await captureCli(
        [
          "change",
          "publish",
          "467",
          "--session-credential",
          bundlePath,
          "--app-endpoint",
          "https://app.example.com",
          "--commit",
          head,
          "--json",
        ],
        dir,
      );
      assert.notEqual(exitCode, 0);
      const output = JSON.parse(stdout.join(""));
      // #466's own bounded-request validation rejects the oversized compiled
      // request before this module's own #373 64 KiB pre-check ever runs;
      // either way, the request never reaches the network.
      assert.equal(output.error.code, "CHANGE_PUBLISH_REQUEST_INVALID", JSON.stringify(output));
      assert.equal(branchAdvanceCalled, false);
    } finally {
      restore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("change publish: a bounded App transport failure is reported without leaking credential material", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".change-publish-cli-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "keep.txt"), "keep\n");
    const base = await commit(dir, "base");
    await writeFile(path.join(dir, "added.ts"), "export const x = 1;\n");
    const head = await commit(dir, "implement feature");

    const bundlePath = await createBundleFile(dir);
    const restore = installFakeFetch((_url, body) => {
      const envelope = body as { operation: string };
      if (envelope.operation === "change.show") return { status: 200, body: showResponseBody(base) };
      return {
        status: 409,
        body: { version: 1, ok: false, error: { code: "SESSION_STATE_CONFLICT", message: "expectedHead is stale." } },
      };
    });
    try {
      const { exitCode, stdout, stderr } = await captureCli(
        [
          "change",
          "publish",
          "467",
          "--session-credential",
          bundlePath,
          "--app-endpoint",
          "https://app.example.com",
          "--commit",
          head,
          "--json",
        ],
        dir,
      );
      assert.notEqual(exitCode, 0);
      const output = JSON.parse(stdout.join(""));
      assert.equal(output.ok, false);
      assert.equal(output.error.code, "BRANCH_ADVANCE_REJECTED");

      const combined = [...stdout, ...stderr].join("\n");
      assert.ok(!combined.includes("PRIVATE KEY"));
      assert.ok(!/-----BEGIN/u.test(combined));
    } finally {
      restore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
