import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import {
  RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX,
  RUNTIME_AUTHORITY_CONTRACT_VERSION,
  RUNTIME_AUTHORITY_KIND,
  canonicalRuntimeAuthorityJson,
  type RuntimeAuthority,
} from "./agent-authority/runtime-authority.js";
import { loadRuntimeAuthorityKeyPair } from "./agent-authority/runtime-key.js";
import {
  RuntimeAuthorityLifecycleError,
  requireRuntimeAuthorityNoFollowFlag,
} from "./agent-authority/runtime-authority-lifecycle.js";

interface CapturedOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function captureCli(argv: string[], repositoryRoot: string): Promise<CapturedOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    return {
      exitCode: await runCli(argv, { repositoryRoot }),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function publicKey(): { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string } {
  const { publicKey: key } = generateKeyPairSync("ed25519");
  return key.export({ format: "jwk" }) as { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
}

function authority(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: RUNTIME_AUTHORITY_CONTRACT_VERSION,
    kind: RUNTIME_AUTHORITY_KIND,
    id,
    key: publicKey(),
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 7200,
    capabilityCeiling: ["change.implement"],
    ...overrides,
  };
}

function artifactPath(repositoryRoot: string, id: string): string {
  return path.join(repositoryRoot, ...`${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}${id}.json`.split("/"));
}

async function writeInput(repositoryRoot: string, name: string, value: unknown): Promise<string> {
  const inputPath = path.join(repositoryRoot, name);
  await writeFile(inputPath, JSON.stringify(value, null, 2), "utf8");
  return inputPath;
}

function jsonOutput(result: CapturedOutput): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("Runtime Authority storage fails closed when O_NOFOLLOW is unavailable", () => {
  assert.throws(
    () => requireRuntimeAuthorityNoFollowFlag(undefined, "register"),
    (error: unknown) =>
      error instanceof RuntimeAuthorityLifecycleError &&
      error.code === "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED" &&
      error.details.reason === "O_NOFOLLOW is unavailable",
  );
});

test("authority generate writes a local key, exports public material, and does not register trust", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "inari-authority-cli-"));
  try {
    const first = await captureCli(["authority", "generate", "--private-key", "runtime.pem", "--json"], repositoryRoot);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    const firstOutput = JSON.parse(first.stdout) as {
      readonly ok: boolean;
      readonly privateKeyPath: string;
      readonly publicKey: { readonly x: string; readonly d?: string };
      readonly publicKeyJson: string;
      readonly repositoryTrustChanged: boolean;
    };
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.privateKeyPath, path.join(repositoryRoot, "runtime.pem"));
    assert.equal(firstOutput.repositoryTrustChanged, false);
    assert.equal("d" in firstOutput.publicKey, false);
    assert.equal(JSON.parse(firstOutput.publicKeyJson).x, firstOutput.publicKey.x);

    const keyPath = path.join(repositoryRoot, "runtime.pem");
    assert.equal((await readFile(keyPath, "utf8")).includes(firstOutput.publicKey.x), false);
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
    assert.equal(loadRuntimeAuthorityKeyPair(keyPath).publicKeyJwk.x, firstOutput.publicKey.x);

    const duplicate = await captureCli(
      ["authority", "generate", "--private-key", "runtime.pem", "--json"],
      repositoryRoot,
    );
    assert.equal(duplicate.exitCode, 2);
    assert.match(duplicate.stdout, /RUNTIME_AUTHORITY_KEY_EXISTS/u);
    assert.equal(duplicate.stdout.includes("BEGIN PRIVATE KEY"), false);

    const replacement = await captureCli(
      ["authority", "generate", "--private-key", "runtime.pem", "--replace", "--json"],
      repositoryRoot,
    );
    assert.equal(replacement.exitCode, 0);
    const replacementOutput = JSON.parse(replacement.stdout) as {
      readonly publicKey: { readonly x: string };
      readonly repositoryTrustChanged: boolean;
    };
    assert.notEqual(replacementOutput.publicKey.x, firstOutput.publicKey.x);
    assert.equal(replacementOutput.repositoryTrustChanged, false);
    await assert.rejects(lstat(path.join(repositoryRoot, ".github", "inari", "authorities")));
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("authority generate has an explicit human-readable trust boundary", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "inari-authority-cli-help-"));
  try {
    const result = await captureCli(["authority", "generate", "--private-key", "runtime.pem"], repositoryRoot);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Generated local Runtime Authority keypair\./u);
    assert.match(result.stdout, /Public key:/u);
    assert.match(result.stdout, /Repository trust was not modified\./u);
    assert.equal(result.stdout.includes("BEGIN PRIVATE KEY"), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("authority register creates one canonical active trust artifact exclusively", async () => {
  const repositoryRoot = await mkdtemp(path.join(process.cwd(), ".inari-authority-register-"));
  try {
    const record = authority("runtime-register");
    const inputPath = await writeInput(repositoryRoot, "authority.json", record);
    const result = await captureCli(["authority", "register", "--from", inputPath, "--json"], repositoryRoot);
    assert.equal(result.exitCode, 0);
    const output = jsonOutput(result);
    assert.equal(output.ok, true);
    assert.equal(output.operation, "authority.register");
    assert.equal(output.path, `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-register.json`);
    assert.equal(output.changed, true);
    assert.equal(
      await readFile(artifactPath(repositoryRoot, "runtime-register"), "utf8"),
      canonicalRuntimeAuthorityJson(record as unknown as RuntimeAuthority),
    );

    const duplicate = await captureCli(["authority", "register", "--from", inputPath, "--json"], repositoryRoot);
    assert.equal(duplicate.exitCode, 2);
    assert.match(duplicate.stdout, /RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_EXISTS/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("authority register rejects inactive, malformed, duplicate-key, and private-key inputs", async () => {
  const repositoryRoot = await mkdtemp(path.join(process.cwd(), ".inari-authority-register-invalid-"));
  try {
    const first = authority("runtime-first");
    const firstPath = await writeInput(repositoryRoot, "first.json", first);
    assert.equal(
      (await captureCli(["authority", "register", "--from", firstPath, "--json"], repositoryRoot)).exitCode,
      0,
    );

    const duplicateKey = authority("runtime-second", { key: first.key });
    const duplicateKeyPath = await writeInput(repositoryRoot, "duplicate-key.json", duplicateKey);
    const duplicateKeyResult = await captureCli(
      ["authority", "register", "--from", duplicateKeyPath, "--json"],
      repositoryRoot,
    );
    assert.equal(duplicateKeyResult.exitCode, 2);
    assert.match(duplicateKeyResult.stdout, /RUNTIME_AUTHORITY_LIFECYCLE_DUPLICATE_PUBLIC_KEY/u);

    const disabledPath = await writeInput(
      repositoryRoot,
      "disabled.json",
      authority("runtime-disabled", { status: "disabled" }),
    );
    const disabledResult = await captureCli(
      ["authority", "register", "--from", disabledPath, "--json"],
      repositoryRoot,
    );
    assert.equal(disabledResult.exitCode, 2);
    assert.match(disabledResult.stdout, /RUNTIME_AUTHORITY_LIFECYCLE_STATUS_INVALID/u);

    const malformedPath = path.join(repositoryRoot, "malformed.json");
    await writeFile(malformedPath, "{", "utf8");
    const malformedResult = await captureCli(
      ["authority", "register", "--from", malformedPath, "--json"],
      repositoryRoot,
    );
    assert.equal(malformedResult.exitCode, 2);
    assert.match(malformedResult.stdout, /INPUT_INVALID_JSON/u);

    const privateKeyResult = await captureCli(
      ["authority", "register", "--from", firstPath, "--private-key", "runtime.pem", "--json"],
      repositoryRoot,
    );
    assert.equal(privateKeyResult.exitCode, 1);
    assert.match(privateKeyResult.stdout, /INVALID_OPTION/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("authority rotate adds an active overlap record and never rewrites the current artifact", async () => {
  const repositoryRoot = await mkdtemp(path.join(process.cwd(), ".inari-authority-rotate-"));
  try {
    const current = authority("runtime-old");
    const currentInput = await writeInput(repositoryRoot, "current.json", current);
    assert.equal(
      (await captureCli(["authority", "register", "--from", currentInput, "--json"], repositoryRoot)).exitCode,
      0,
    );
    const before = await readFile(artifactPath(repositoryRoot, "runtime-old"), "utf8");

    const next = authority("runtime-new");
    const rotationPath = await writeInput(repositoryRoot, "rotation.json", {
      version: 1,
      kind: "runtime-authority-rotation",
      currentAuthorityId: "runtime-old",
      nextAuthority: next,
    });
    const result = await captureCli(["authority", "rotate", "--from", rotationPath, "--json"], repositoryRoot);
    assert.equal(result.exitCode, 0);
    const output = jsonOutput(result);
    assert.equal(output.operation, "authority.rotate");
    assert.equal(output.path, `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-new.json`);
    assert.equal(await readFile(artifactPath(repositoryRoot, "runtime-old"), "utf8"), before);
    const nextArtifact = JSON.parse(await readFile(artifactPath(repositoryRoot, "runtime-new"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(nextArtifact.status, "active");

    const sameKeyRotationPath = await writeInput(repositoryRoot, "same-key-rotation.json", {
      version: 1,
      kind: "runtime-authority-rotation",
      currentAuthorityId: "runtime-old",
      nextAuthority: authority("runtime-other", { key: current.key }),
    });
    const sameKeyResult = await captureCli(
      ["authority", "rotate", "--from", sameKeyRotationPath, "--json"],
      repositoryRoot,
    );
    assert.equal(sameKeyResult.exitCode, 2);
    assert.match(sameKeyResult.stdout, /RUNTIME_AUTHORITY_LIFECYCLE_DUPLICATE_PUBLIC_KEY/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("authority revoke is active-to-disabled only and deterministically idempotent", async () => {
  const repositoryRoot = await mkdtemp(path.join(process.cwd(), ".inari-authority-revoke-"));
  try {
    const record = authority("runtime-revoke", { capabilityCeiling: ["change.implement", "change.ready"] });
    const inputPath = await writeInput(repositoryRoot, "authority.json", record);
    assert.equal(
      (await captureCli(["authority", "register", "--from", inputPath, "--json"], repositoryRoot)).exitCode,
      0,
    );

    const revoked = await captureCli(["authority", "revoke", "runtime-revoke", "--json"], repositoryRoot);
    assert.equal(revoked.exitCode, 0);
    const revokedOutput = jsonOutput(revoked);
    assert.equal(revokedOutput.changed, true);
    const disabled = JSON.parse(await readFile(artifactPath(repositoryRoot, "runtime-revoke"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(disabled.status, "disabled");
    for (const key of [
      "version",
      "kind",
      "id",
      "key",
      "notBefore",
      "notAfter",
      "maxSessionTtlSeconds",
      "capabilityCeiling",
    ])
      assert.deepEqual(disabled[key], (record as Record<string, unknown>)[key]);
    const afterFirstRevoke = await readFile(artifactPath(repositoryRoot, "runtime-revoke"), "utf8");

    const repeated = await captureCli(["authority", "revoke", "runtime-revoke", "--json"], repositoryRoot);
    assert.equal(repeated.exitCode, 0);
    assert.equal(jsonOutput(repeated).changed, false);
    assert.equal(await readFile(artifactPath(repositoryRoot, "runtime-revoke"), "utf8"), afterFirstRevoke);

    const missing = await captureCli(["authority", "revoke", "missing", "--json"], repositoryRoot);
    assert.equal(missing.exitCode, 2);
    assert.match(missing.stdout, /RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_NOT_FOUND/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
