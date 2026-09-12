import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../cli.js";
import { canonicalJsonString, base64UrlEncodeText, type CanonicalJsonValue } from "./codec.js";
import * as sessionIssuance from "./session-issuance.js";
import {
  SESSION_CREDENTIAL_BUNDLE_KIND,
  SESSION_ISSUANCE_REQUEST_KIND,
  SESSION_ISSUANCE_REQUEST_VERSION,
  SessionCredentialBundleError,
  canonicalSessionCredentialBundleJson,
  createSessionCredentialBundle,
  inspectSessionCredentialBundle,
  loadSessionCredentialBundle,
  parseSessionCredentialBundle,
  persistSessionCredentialBundle,
  type SessionIssuanceRequestDocument,
} from "./session-bundle.js";
import { decodeSessionCertificateCompact } from "./session-certificate.js";
import { assertRuntimeAuthority, type RuntimeAuthority } from "./runtime-authority.js";
import {
  exportRuntimeAuthorityPublicKey,
  generateRuntimeAuthorityKeyPair,
  type RuntimeAuthorityKeyPair,
} from "./runtime-key.js";

const REPOSITORY = Object.freeze({ id: "123456789", name: "yohn-jp/gh-inari" });
const NOW = new Date("2026-09-12T12:00:00Z");

function authority(runtimeKey: RuntimeAuthorityKeyPair): RuntimeAuthority {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "manual-session-runtime",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2020-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement", "change.ready"],
  });
}

function requestFor(
  runtimeKey: RuntimeAuthorityKeyPair,
  overrides: Record<string, unknown> = {},
): SessionIssuanceRequestDocument {
  return {
    version: SESSION_ISSUANCE_REQUEST_VERSION,
    kind: SESSION_ISSUANCE_REQUEST_KIND,
    runtimeAuthority: authority(runtimeKey),
    repository: REPOSITORY,
    task: { kind: "issue", number: 372 },
    capabilities: [{ kind: "change.implement", issue: 372 }],
    ttlSeconds: 1800,
    agent: { name: "codex", version: "1", runtime: "node" },
    ...overrides,
  } as SessionIssuanceRequestDocument;
}

async function captureCli(
  argv: string[],
  repositoryRoot: string,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string[];
  readonly stderr: string[];
}> {
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

async function writeRuntimeKey(directory: string, key: RuntimeAuthorityKeyPair): Promise<string> {
  const filePath = path.join(directory, "runtime.pem");
  const pem = key.privateKey.export({ format: "pem", type: "pkcs8" });
  assert.equal(typeof pem, "string");
  await writeFile(filePath, pem, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

test("manual issuance creates one canonical bundle and safe inspection metadata", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const created = createSessionCredentialBundle({ request: requestFor(runtimeKey), runtimeKey, now: NOW });

  assert.deepEqual(Object.keys(created.bundle).sort(), [
    "agent",
    "certificate",
    "kind",
    "sessionPrivateKey",
    "version",
  ]);
  assert.equal(created.bundle.kind, SESSION_CREDENTIAL_BUNDLE_KIND);
  assert.equal(decodeSessionCertificateCompact(created.bundle.certificate).valid, true);
  assert.equal(
    exportRuntimeAuthorityPublicKey(
      createPrivateKey({ key: created.bundle.sessionPrivateKey, format: "pem", type: "pkcs8" }),
    ).x,
    created.certificate.payload.sessionKey.x,
  );
  assert.equal(created.certificate.payload.iat, Math.floor(NOW.getTime() / 1000));
  assert.equal(created.certificate.payload.exp - created.certificate.payload.nbf, 1800);
  assert.equal(canonicalSessionCredentialBundleJson(created.bundle).includes("PRIVATE KEY"), true);
  assert.equal(
    canonicalSessionCredentialBundleJson(created.bundle).includes(
      runtimeKey.privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    ),
    false,
  );

  const parsed = parseSessionCredentialBundle(
    JSON.parse(canonicalSessionCredentialBundleJson(created.bundle)) as unknown,
  );
  const inspected = inspectSessionCredentialBundle(parsed);
  const serializedInspection = JSON.stringify(inspected);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.repository.id, REPOSITORY.id);
  assert.equal(inspected.task?.number, 372);
  assert.deepEqual(inspected.capabilities, [{ kind: "change.implement", issue: 372 }]);
  assert.equal(inspected.runtime.authorityId, "manual-session-runtime");
  assert.equal(inspected.session.id, created.certificate.payload.sub.slice("session:".length));
  assert.equal(serializedInspection.includes("PRIVATE KEY"), false);
  assert.equal(serializedInspection.includes('"d"'), false);
  assert.equal(serializedInspection.includes(created.bundle.certificate), false);
});

test("manual issuance generates valid, distinct Session IDs without consuming #371 ID-generation exports", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const first = createSessionCredentialBundle({ request: requestFor(runtimeKey), runtimeKey, now: NOW });
  const second = createSessionCredentialBundle({ request: requestFor(runtimeKey), runtimeKey, now: NOW });

  const opaqueIdPattern = /^[A-Za-z0-9._-]{1,128}$/u;
  const firstSessionId = first.certificate.payload.sub.slice("session:".length);
  const secondSessionId = second.certificate.payload.sub.slice("session:".length);

  assert.match(firstSessionId, opaqueIdPattern);
  assert.match(secondSessionId, opaqueIdPattern);
  assert.notEqual(firstSessionId, secondSessionId);

  assert.equal(Reflect.has(sessionIssuance, "opaqueId"), false);
  assert.equal(Reflect.has(sessionIssuance, "SESSION_ID_BYTES"), false);
});

test("bundle import rejects tampering, expiry drift, and cross-session substitution", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const first = createSessionCredentialBundle({ request: requestFor(runtimeKey), runtimeKey, now: NOW });
  const second = createSessionCredentialBundle({ request: requestFor(runtimeKey), runtimeKey, now: NOW });

  assert.throws(
    () => parseSessionCredentialBundle({ ...first.bundle, sessionPrivateKey: second.bundle.sessionPrivateKey }),
    (error: unknown) =>
      error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_CERTIFICATE_KEY_MISMATCH",
  );
  assert.throws(
    () => parseSessionCredentialBundle({ ...first.bundle, sessionPrivateKey: `${first.bundle.sessionPrivateKey}x` }),
    (error: unknown) =>
      error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_INVALID_PRIVATE_KEY",
  );

  const decoded = decodeSessionCertificateCompact(first.bundle.certificate);
  assert.equal(decoded.valid, true);
  const value = decoded.value;
  assert.ok(value);
  const [header] = value.signingInput.split(".");
  const invalidExpiryPayload = { ...value.payload, exp: value.payload.nbf };
  const invalidExpiryCertificate = `${header}.${base64UrlEncodeText(canonicalJsonString(invalidExpiryPayload as unknown as CanonicalJsonValue))}.${value.signature}`;
  assert.throws(
    () => parseSessionCredentialBundle({ ...first.bundle, certificate: invalidExpiryCertificate }),
    (error: unknown) => error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_INVALID_EXPIRY",
  );

  const driftedPayload = base64UrlEncodeText(`${canonicalJsonString(value.payload as unknown as CanonicalJsonValue)} `);
  assert.throws(
    () =>
      parseSessionCredentialBundle({ ...first.bundle, certificate: `${header}.${driftedPayload}.${value.signature}` }),
    (error: unknown) =>
      error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_CERTIFICATE_INVALID",
  );
});

test("bundle files are exclusive, owner-only, and fail closed for symlinks and unsafe permissions", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".inari-session-bundle-storage-"));
  try {
    const runtimeKey = generateRuntimeAuthorityKeyPair();
    const created = createSessionCredentialBundle({ request: requestFor(runtimeKey), runtimeKey, now: NOW });
    const bundlePath = path.join(directory, "bundle.json");
    assert.equal(persistSessionCredentialBundle(bundlePath, created.bundle), bundlePath);
    assert.equal((await lstat(bundlePath)).mode & 0o777, 0o600);
    assert.equal(loadSessionCredentialBundle(bundlePath).certificate.payload.jti, created.certificate.payload.jti);
    assert.throws(
      () => persistSessionCredentialBundle(bundlePath, created.bundle),
      (error: unknown) =>
        error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_OUTPUT_EXISTS",
    );

    const unsafePath = path.join(directory, "unsafe.json");
    await writeFile(unsafePath, "sentinel", { mode: 0o644 });
    assert.throws(
      () => loadSessionCredentialBundle(unsafePath),
      (error: unknown) =>
        error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_UNSAFE_STORAGE",
    );
    assert.throws(
      () => persistSessionCredentialBundle(unsafePath, created.bundle),
      (error: unknown) =>
        error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_UNSAFE_STORAGE",
    );

    const nonCanonicalPath = path.join(directory, "non-canonical.json");
    await writeFile(nonCanonicalPath, JSON.stringify(created.bundle, null, 2), { mode: 0o600 });
    assert.throws(
      () => loadSessionCredentialBundle(nonCanonicalPath),
      (error: unknown) =>
        error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_NON_CANONICAL_ENCODING",
    );

    const linkTarget = path.join(directory, "link-target.json");
    await writeFile(linkTarget, "sentinel", { mode: 0o600 });
    const linkPath = path.join(directory, "link.json");
    await symlink(linkTarget, linkPath);
    assert.throws(
      () => persistSessionCredentialBundle(linkPath, created.bundle),
      (error: unknown) =>
        error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_UNSAFE_STORAGE",
    );
    assert.equal(await readFile(linkTarget, "utf8"), "sentinel");

    const outside = await mkdtemp(path.join(os.tmpdir(), "inari-session-bundle-outside-"));
    const parentLink = path.join(directory, "parent-link");
    try {
      await symlink(outside, parentLink);
      assert.throws(
        () => persistSessionCredentialBundle(path.join(parentLink, "bundle.json"), created.bundle),
        (error: unknown) =>
          error instanceof SessionCredentialBundleError && error.code === "SESSION_BUNDLE_UNSAFE_STORAGE",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session CLI issues and inspects a packed-format bundle without disclosing either private key", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".inari-session-bundle-cli-"));
  try {
    const runtimeKey = generateRuntimeAuthorityKeyPair();
    const runtimeKeyPath = await writeRuntimeKey(directory, runtimeKey);
    const requestPath = path.join(directory, "request.json");
    const bundlePath = path.join(directory, "bundle.json");
    const request = requestFor(runtimeKey);
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });

    const issued = await captureCli(
      ["session", "issue", "--from", requestPath, "--private-key", runtimeKeyPath, "--to", bundlePath, "--json"],
      directory,
    );
    assert.equal(issued.exitCode, 0, issued.stderr.join("\n"));
    const issuedOutput = JSON.parse(issued.stdout.at(-1) ?? "{}") as Record<string, unknown>;
    assert.equal(issuedOutput.ok, true);
    assert.equal(issuedOutput.operation, "session.issue");
    assert.equal(issuedOutput.bundlePath, bundlePath);
    assert.equal(JSON.stringify(issuedOutput).includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(issuedOutput).includes('"d"'), false);
    assert.equal((await lstat(bundlePath)).mode & 0o777, 0o600);

    const inspected = await captureCli(["session", "inspect", "--from", bundlePath, "--json"], directory);
    assert.equal(inspected.exitCode, 0, inspected.stderr.join("\n"));
    const inspectedOutput = JSON.parse(inspected.stdout.at(-1) ?? "{}") as Record<string, unknown>;
    assert.equal(inspectedOutput.ok, true);
    assert.equal(inspectedOutput.operation, "session.inspect");
    assert.equal(JSON.stringify(inspectedOutput).includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(inspectedOutput).includes('"d"'), false);

    const missingRuntimeKey = await captureCli(
      ["session", "issue", "--from", requestPath, "--to", path.join(directory, "missing.json"), "--json"],
      directory,
    );
    assert.equal(missingRuntimeKey.exitCode, 1);
    assert.equal(JSON.stringify(missingRuntimeKey).includes("PRIVATE KEY"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the canonical command contract exposes the frozen Session issue and inspect invocations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-session-command-help-"));
  try {
    const issue = await captureCli(["session", "issue", "--help"], directory);
    const inspect = await captureCli(["session", "inspect", "--help"], directory);
    assert.equal(issue.exitCode, 0);
    assert.match(
      issue.stdout.join("\n"),
      /Usage: inari session issue --from <path> --private-key <path> --to <semantic-file>/u,
    );
    assert.match(inspect.stdout.join("\n"), /Usage: inari session inspect --from <path>/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
