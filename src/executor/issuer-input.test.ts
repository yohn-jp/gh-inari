import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorAppCredentialStore, ExecutorCredentialStore } from "./credential-store.js";
import { ExecutorRepositoryBindingStore } from "./repository-binding-store.js";
import { issuerExecutionEnvironment } from "./enrollment/issuer-reference.js";
import { LocalExecutorError } from "./errors.js";
import { resolveLocalExecutorRepository } from "./execution.js";
import { saveLocalRuntimeProfile } from "../local-runtime-profile.js";

test("managed Issuer custody is canonical and explicit overrides must match it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-issuer-ref-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    assert.equal(issuerExecutionEnvironment("exec_1234567890123456", environment), environment);
    const pem = Buffer.from(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const store = new ExecutorCredentialStore(environment);
    const { record } = store.save("exec_1234567890123456", "123", pem);
    const code = (expected: string) => (error: unknown) =>
      error instanceof LocalExecutorError && error.code === expected && !error.message.includes("BEGIN");
    assert.throws(
      () => issuerExecutionEnvironment("exec_1234567890123456", environment),
      code("EXECUTOR_ISSUER_CUSTODY_UNVERIFIED"),
    );
    store.markProviderVerified(record.generation);
    const resolved = issuerExecutionEnvironment("exec_1234567890123456", environment);
    assert.equal(resolved.INARI_GITHUB_APP_PRIVATE_KEY_FILE, store.keyPath(record));
    assert.equal(resolved.INARI_GITHUB_APP_ID, "123");
    // #1178: an explicit override naming the same App and key converges on custody.
    const sameKey = path.join(root, "operator-same.pem");
    writeFileSync(sameKey, pem, { mode: 0o600 });
    const same = issuerExecutionEnvironment("exec_1234567890123456", {
      ...environment,
      INARI_GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY_FILE: sameKey,
    });
    assert.equal(same.INARI_GITHUB_APP_PRIVATE_KEY_FILE, store.keyPath(record));
    assert.equal(same.GITHUB_APP_PRIVATE_KEY_FILE, undefined);
    // Any contradiction is a bounded diagnostic, never a silent preference.
    const otherKey = path.join(root, "operator-other.pem");
    writeFileSync(
      otherKey,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        issuerExecutionEnvironment("exec_1234567890123456", {
          ...environment,
          INARI_GITHUB_APP_PRIVATE_KEY_FILE: otherKey,
        }),
      code("EXECUTOR_ISSUER_BINDING_CONFLICT"),
    );
    assert.throws(
      () => issuerExecutionEnvironment("exec_1234567890123456", { ...environment, INARI_GITHUB_APP_ID: "456" }),
      code("EXECUTOR_ISSUER_BINDING_CONFLICT"),
    );
    assert.throws(
      () =>
        issuerExecutionEnvironment("exec_1234567890123456", {
          ...environment,
          GITHUB_APP_PRIVATE_KEY_FILE: "/absent.pem",
        }),
      code("EXECUTOR_ISSUER_KEY_INVALID"),
    );
    assert.throws(
      () => issuerExecutionEnvironment("exec_6543210987654321", environment),
      code("EXECUTOR_ISSUER_BINDING_CONFLICT"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 the Executor input adopts verified legacy custody only after override conflicts fail closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-issuer-adopt-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const pem = Buffer.from(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const store = new ExecutorCredentialStore(environment);
    const { record } = store.save("exec_1234567890123456", "123", pem);
    const binding = {
      repositoryHost: "github.com",
      repositoryId: "1",
      nameWithOwner: "owner/one",
      installationId: "77",
    };
    store.recordBinding(record.generation, binding);
    const apps = new ExecutorAppCredentialStore(environment);
    const code = (expected: string) => (error: unknown) =>
      error instanceof LocalExecutorError && error.code === expected;
    // Explicit override conflicts stay fail-closed and adopt nothing.
    assert.throws(
      () => issuerExecutionEnvironment("exec_1234567890123456", { ...environment, INARI_GITHUB_APP_ID: "456" }),
      code("EXECUTOR_ISSUER_BINDING_CONFLICT"),
    );
    assert.equal(apps.current("123"), undefined);
    const resolved = issuerExecutionEnvironment("exec_1234567890123456", environment);
    assert.equal(resolved.INARI_GITHUB_APP_ID, "123");
    assert.equal(apps.current("123")?.generation, record.generation);
    const adopted = new ExecutorRepositoryBindingStore(environment).read("1");
    assert.deepEqual(adopted, {
      ...binding,
      appId: "123",
      generation: record.generation,
      fingerprint: record.fingerprint,
    });
    // Idempotent on every start; the legacy credential is still the one the Executor reads.
    issuerExecutionEnvironment("exec_1234567890123456", environment);
    assert.equal(store.current()?.generation, record.generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface MintCall {
  readonly installationId: string;
  readonly iss: string;
  readonly signer: string;
}

/** GitHub provider double: records which App JWT, signed by which key, minted each installation token. */
function provider(
  keys: Readonly<Record<string, KeyObject>>,
  repositories: Readonly<Record<string, { readonly id: number; readonly full_name: string }>>,
) {
  const mints: MintCall[] = [];
  const unexpected: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const minted = /^\/app\/installations\/([0-9]+)\/access_tokens$/u.exec(url.pathname);
    if (minted !== null && method === "POST") {
      const jwt = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";
      const [header, payload, signature] = jwt.split(".") as [string, string, string];
      const signer =
        Object.entries(keys).find(([, key]) =>
          verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url")),
        )?.[0] ?? "unknown";
      const iss = String((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: unknown }).iss);
      mints.push({ installationId: minted[1] as string, iss, signer });
      const body = JSON.parse(String(init?.body)) as { repositories: string[]; permissions: Record<string, string> };
      const selected = repositories[`${minted[1]}:${body.repositories[0]}`];
      if (selected === undefined) return json({ message: "Not Found" }, 404);
      return json(
        {
          token: "ghs_installationtokenfortests",
          expires_at: "2099-01-01T00:00:00Z",
          permissions: body.permissions,
          repository_selection: "selected",
          repositories: [{ ...selected, node_id: `R_${selected.id}`, name: body.repositories[0] }],
        },
        201,
      );
    }
    const repository = Object.values(repositories).find((item) => url.pathname === `/repos/${item.full_name}`);
    if (repository !== undefined && method === "GET")
      return json({ ...repository, name: repository.full_name.split("/")[1], fork: false, default_branch: "main" });
    unexpected.push(`${method} ${url.pathname}`);
    return json({ message: "Not Found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, mints, unexpected };
}

async function withFetch<T>(fetch: typeof globalThis.fetch, operation: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}

test("#1199 one Executor executes each repository with its own bound App credential", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-issuer-multi-app-"));
  try {
    const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
    const [a, b, legacy] = [pair(), pair(), pair()];
    const pemOf = (key: typeof a) => Buffer.from(key.privateKey.export({ format: "pem", type: "pkcs8" }));
    const legacyKey = path.join(root, "operator-legacy.pem");
    writeFileSync(legacyKey, pemOf(legacy), { mode: 0o600 });
    // The compatibility route names a third App; bound repositories must never use it.
    const environment = {
      INARI_CONFIG_HOME: path.join(root, "config"),
      INARI_GITHUB_APP_ID: "999",
      INARI_GITHUB_APP_PRIVATE_KEY_FILE: legacyKey,
    };
    const apps = new ExecutorAppCredentialStore(environment);
    const bindings = new ExecutorRepositoryBindingStore(environment);
    const appA = apps.markProviderVerified(
      "123",
      apps.save("exec_1234567890123456", "123", pemOf(a)).record.generation,
    );
    const appB = apps.markProviderVerified(
      "456",
      apps.save("exec_1234567890123456", "456", pemOf(b)).record.generation,
    );
    const bind = (credential: typeof appA, repositoryId: string, nameWithOwner: string, installationId: string) =>
      bindings.publish({
        repositoryHost: "github.com",
        repositoryId,
        nameWithOwner,
        appId: credential.appId,
        installationId,
        generation: credential.generation,
        fingerprint: credential.fingerprint,
      });
    bind(appA, "101", "acme/one", "77");
    bind(appB, "202", "acme/two", "88");
    const github = provider(
      {
        A: createPublicKey(a.privateKey),
        B: createPublicKey(b.privateKey),
        legacy: createPublicKey(legacy.privateKey),
      },
      {
        "77:one": { id: 101, full_name: "acme/one" },
        "88:two": { id: 202, full_name: "acme/two" },
        "99:four": { id: 404, full_name: "acme/four" },
      },
    );
    const one = await withFetch(github.fetch, () => resolveLocalExecutorRepository("acme/one", environment));
    const two = await withFetch(github.fetch, () => resolveLocalExecutorRepository("acme/two", environment));
    assert.deepEqual(one, { repositoryHost: "github.com", repositoryId: "101", nameWithOwner: "acme/one" });
    assert.deepEqual(two, { repositoryHost: "github.com", repositoryId: "202", nameWithOwner: "acme/two" });
    // Each installation token was minted by its own App ID and signed by that App's own key.
    assert.deepEqual(github.mints, [
      { installationId: "77", iss: "123", signer: "A" },
      { installationId: "88", iss: "456", signer: "B" },
    ]);
    assert.deepEqual(github.unexpected, []);

    const code = (expected: string) => (error: unknown) =>
      error instanceof LocalExecutorError && error.code === expected;
    // An explicit key reference naming a bound App must be that App's bound key.
    await assert.rejects(
      withFetch(github.fetch, () =>
        resolveLocalExecutorRepository("acme/one", { ...environment, INARI_GITHUB_APP_ID: "123" }),
      ),
      code("EXECUTOR_ISSUER_BINDING_CONFLICT"),
    );
    const sameKey = path.join(root, "operator-a.pem");
    writeFileSync(sameKey, pemOf(a), { mode: 0o600 });
    await withFetch(github.fetch, () =>
      resolveLocalExecutorRepository("acme/one", {
        ...environment,
        INARI_GITHUB_APP_ID: "123",
        INARI_GITHUB_APP_PRIVATE_KEY_FILE: sameKey,
      }),
    );

    // A replaced App B generation leaves its binding stale: refused, never routed elsewhere.
    github.mints.length = 0;
    apps.save("exec_1234567890123456", "456", pemOf(pair()), appB);
    await assert.rejects(
      withFetch(github.fetch, () => resolveLocalExecutorRepository("acme/two", environment)),
      code("EXECUTOR_ISSUER_BINDING_MISMATCH"),
    );
    // A binding naming another App's generation, or an App without custody, never satisfies execution.
    const record = (repositoryId: string, name: string, fields: Record<string, string>) =>
      writeFileSync(
        path.join(environment.INARI_CONFIG_HOME, "executor", "repository-bindings", `${repositoryId}.json`),
        JSON.stringify({
          repositoryHost: "github.com",
          repositoryId,
          nameWithOwner: name,
          appId: "123",
          installationId: "77",
          generation: appA.generation,
          fingerprint: appA.fingerprint,
          ...fields,
        }),
        { mode: 0o600 },
      );
    record("303", "acme/three", { generation: appB.generation });
    record("505", "acme/five", { appId: "789" });
    for (const name of ["acme/three", "acme/five"])
      await assert.rejects(
        withFetch(github.fetch, () => resolveLocalExecutorRepository(name, environment)),
        code("EXECUTOR_ISSUER_BINDING_MISMATCH"),
      );
    assert.deepEqual(github.mints, []);

    // The compatibility route applies only when no App-scoped binding exists.
    await assert.rejects(
      withFetch(github.fetch, () => resolveLocalExecutorRepository("acme/four", environment)),
      code("EXECUTOR_REPOSITORY_BINDING_MISSING"),
    );
    await saveLocalRuntimeProfile(
      {
        version: 1,
        state: "ready",
        endpoint: "https://endpoint.example.test",
        relayUrl: "wss://endpoint.example.test/relay",
        repository: { repositoryHost: "github.com", repositoryId: "404", repositoryNameWithOwner: "acme/four" },
        app: { appId: "999", installationId: "99" },
        authority: {
          authorityId: "executor-production-test",
          publicKeyFingerprint: `sha256:${"0".repeat(64)}`,
          privateKeyPath: path.join(root, "authority.pem"),
        },
      },
      { environment },
    );
    const four = await withFetch(github.fetch, () => resolveLocalExecutorRepository("acme/four", environment));
    assert.equal(four.repositoryId, "404");
    assert.deepEqual(github.mints, [{ installationId: "99", iss: "999", signer: "legacy" }]);
    assert.deepEqual(github.unexpected, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
