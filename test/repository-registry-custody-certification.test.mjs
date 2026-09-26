// Source-level certification of the #1187 repository registry and custody
// migration (#1201): two registered repositories, shared-vs-dedicated App
// bindings, one shared Authority reference, non-destructive legacy adoption
// through the producer migration paths, rename, fresh-process reads, no secret
// movement, and the existing Local Runtime Executor execution path for the
// adopted repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createDelegatorRecord } from "../src/agent-authority/delegator-operations.ts";
import { delegatorPublicKeyFingerprint } from "../src/agent-authority/delegator-key.ts";
import { setupLocalAdmission } from "../src/admission/setup.ts";
import { importLegacyLocalAuthority, listLocalAuthorityIdentities } from "../src/authority/index.ts";
import {
  resolveRepositoryComponentBinding,
  readExecutorCustodyEvidence,
} from "../src/composition/repository-component-binding.ts";
import { migrateLegacySetupConfig } from "../src/composition/setup-config-migration.ts";
import {
  SetupConfigStore,
  setupStateFileKey,
  validateSetupConfigRecord,
} from "../src/composition/setup-config-store.ts";
import { observeSetup } from "../src/composition/setup-observation.ts";
import { ExecutorAppCredentialStore, ExecutorCredentialStore } from "../src/executor/credential-store.ts";
import { issuerExecutionEnvironment } from "../src/executor/enrollment/issuer-reference.ts";
import { resolveLocalExecutorRepository } from "../src/executor/execution.ts";
import { ExecutorRepositoryBindingStore } from "../src/executor/repository-binding-store.ts";
import { ensureLocalExecutorConfiguration } from "../src/executor/setup.ts";
import {
  bindLocalCliAdmissionRoute,
  ensureLocalCliTopology,
  localComponentPath,
  replaceLocalJsonIfCurrent,
  writeLocalJson,
} from "../src/local-control/config.ts";
import { setupLocalAuthority } from "../src/local-control/identity.ts";
import { RepositoryRegistry } from "../src/local-control/repository-registry.ts";
import { LocalRuntimeProfileStore } from "../src/local-runtime-profile.ts";
import { findSetupSecretMaterial } from "../src/runtime-contracts/index.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENDPOINT = "https://inari.example.com";
const adopted = { repositoryHost: "github.com", repositoryId: "101", nameWithOwner: "acme/one" };
const dedicated = { repositoryHost: "github.com", repositoryId: "202", nameWithOwner: "acme/two" };
const shared = { repositoryHost: "github.com", repositoryId: "303", nameWithOwner: "acme/three" };
const SHARED_APP = "123";
const DEDICATED_APP = "456";

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const pemOf = (key) => Buffer.from(key.privateKey.export({ format: "pem", type: "pkcs8" }));

/** Every regular file below `root`, with bytes, for non-destructive evidence. */
function snapshot(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files[path.relative(root, target)] = readFileSync(target).toString("base64");
    }
  };
  visit(root);
  return files;
}

function leaks(value, home, secrets) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [home, "PRIVATE KEY", ".pem", "privateKey", ...secrets].filter((needle) => text.includes(needle));
}

/** GitHub double recording which App JWT, signed by which key, minted each installation token. */
function github(keys, repositories) {
  const mints = [];
  const unexpected = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const minted = /^\/app\/installations\/([0-9]+)\/access_tokens$/u.exec(url.pathname);
    if (minted !== null && method === "POST") {
      const jwt = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";
      const [header, payload, signature] = jwt.split(".");
      const signer =
        Object.entries(keys).find(([, key]) =>
          verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url")),
        )?.[0] ?? "unknown";
      const iss = String(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).iss);
      mints.push({ installationId: minted[1], iss, signer });
      const body = JSON.parse(String(init?.body));
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
  };
  return { fetch, mints, unexpected };
}

async function withFetch(fetch, operation) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}

/** Resolve bindings in a separate Node process that inherits no Inari/GitHub exports. */
function freshProcessBindings(home, repositories) {
  const moduleUrl = pathToFileURL(path.join(projectRoot, "src/composition/repository-component-binding.ts")).href;
  const code = `
    const { resolveRepositoryComponentBinding } = await import(${JSON.stringify(moduleUrl)});
    const repositories = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(repositories.map((repository) => resolveRepositoryComponentBinding(repository))));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code, JSON.stringify(repositories)],
    { cwd: projectRoot, env: { PATH: process.env.PATH, INARI_CONFIG_HOME: home }, encoding: "utf8" },
  );
  return JSON.parse(output);
}

const unavailableProvider = {
  resolveInstallation: async () => {
    throw new Error("not used");
  },
  readCanonicalAuthorities: async () => [],
  publishAuthority: async () => {
    throw new Error("not used");
  },
};

test("#1201 certifies the composed multi-repository registry and custody migration", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-registry-custody-cert-"));
  try {
    const home = path.join(root, "config");
    const environment = { INARI_CONFIG_HOME: home };
    const [keyA, keyB] = [pair(), pair()];

    // --- Pre-#1187 single-repository state: legacy Executor custody, Authority, setup record and profile.
    const { config: executor } = await ensureLocalExecutorConfiguration(environment);
    const legacyExecutor = new ExecutorCredentialStore(environment);
    const legacyKey = legacyExecutor.save(executor.id, SHARED_APP, pemOf(keyA)).record;
    legacyExecutor.recordBinding(legacyKey.generation, { ...adopted, installationId: "77" });
    const authority = setupLocalAuthority(environment);
    const runtimeAuthority = createDelegatorRecord({
      id: "runtime-shared",
      key: authority.config.publicKey,
      maxSessionTtlSeconds: 3600,
      notBefore: "2026-01-01T00:00:00.000Z",
      capabilityCeiling: ["change.implement"],
    });
    const authorityReference = {
      authorityId: runtimeAuthority.id,
      publicKeyFingerprint: delegatorPublicKeyFingerprint(runtimeAuthority.key),
    };
    const admission = setupLocalAdmission(runtimeAuthority, environment);
    ensureLocalCliTopology(environment);
    bindLocalCliAdmissionRoute({ id: admission.config.id }, environment);
    const legacySetupPath = `setup/${setupStateFileKey(adopted)}.json`;
    const legacySetup = writeLocalJson(
      "runtime",
      legacySetupPath,
      validateSetupConfigRecord({
        version: 1,
        repository: adopted,
        revision: 4,
        endpoint: ENDPOINT,
        app: { appId: SHARED_APP, installationId: "77" },
        executor: { configId: executor.id, issuerKeyFingerprint: legacyKey.fingerprint },
      }),
      validateSetupConfigRecord,
      environment,
    );
    await new LocalRuntimeProfileStore({ environment }).save({
      version: 1,
      state: "ready",
      endpoint: ENDPOINT,
      relayUrl: "wss://relay.example.com/connect",
      repository: {
        repositoryHost: adopted.repositoryHost,
        repositoryId: adopted.repositoryId,
        repositoryNameWithOwner: adopted.nameWithOwner,
      },
      app: { appId: SHARED_APP, installationId: "77", clientId: "Iv1.cert" },
      authority: {
        ...authorityReference,
        privateKeyPath: localComponentPath("authority", "private-key.pem", environment),
      },
    });
    const legacyFiles = snapshot(home);

    // --- Adoption through the producer migration paths only.
    const setupMigration = await migrateLegacySetupConfig(adopted, { environment });
    assert.equal(setupMigration.outcome, "adopted");
    assert.deepEqual(setupMigration.sources, ["runtime-setup", "runtime-profile"]);
    // The Local Runtime Executor start path adopts legacy single-App custody and its bindings.
    const executionEnvironment = issuerExecutionEnvironment(executor.id, { ...environment });
    const imported = importLegacyLocalAuthority({ environment, authority: runtimeAuthority });
    assert.equal(imported.status, "imported");
    // Non-destructive: every legacy file is byte-identical after adoption.
    const afterAdoption = snapshot(home);
    for (const [file, bytes] of Object.entries(legacyFiles)) assert.equal(afterAdoption[file], bytes, file);

    // --- A second repository with a dedicated App and a third sharing the adopted App; one Authority for all.
    const apps = new ExecutorAppCredentialStore(environment);
    const bindings = new ExecutorRepositoryBindingStore(environment);
    const appB = apps.markProviderVerified(
      DEDICATED_APP,
      apps.save(executor.id, DEDICATED_APP, pemOf(keyB)).record.generation,
    );
    const appA = apps.current(SHARED_APP);
    assert.equal(appA?.generation, legacyKey.generation);
    for (const [repository, credential, installationId] of [
      [dedicated, appB, "88"],
      [shared, appA, "79"],
    ])
      bindings.publish({
        ...repository,
        appId: credential.appId,
        installationId,
        generation: credential.generation,
        fingerprint: credential.fingerprint,
      });
    const store = new SetupConfigStore({ environment });
    const adoptedRecord = store.read(adopted);
    store.update(adopted, adoptedRecord.revision, { authority: authorityReference });
    for (const [repository, credential, installationId] of [
      [dedicated, appB, "88"],
      [shared, appA, "79"],
    ])
      store.update(repository, 0, {
        app: { appId: credential.appId, installationId },
        executor: { configId: executor.id, issuerKeyFingerprint: credential.fingerprint },
        authority: authorityReference,
      });

    assert.deepEqual(
      new RepositoryRegistry({ environment }).list().map((item) => item.repositoryId),
      ["101", "202", "303"],
    );
    const [first, second, third] = [adopted, dedicated, shared].map((repository) =>
      resolveRepositoryComponentBinding(repository, { environment }),
    );
    // Independent bindings, no cross-repository leakage.
    assert.deepEqual(
      [first, second, third].map((item) => [
        item.repository.repositoryId,
        item.setup?.source,
        item.app?.appId,
        item.executor?.binding?.repositoryId,
        item.executor?.binding?.installationId,
        item.executor?.binding?.status,
        item.executor?.binding?.source,
        item.conflicts.length,
      ]),
      [
        ["101", "canonical", SHARED_APP, "101", "77", "bound", "app-scoped", 0],
        ["202", "canonical", DEDICATED_APP, "202", "88", "bound", "app-scoped", 0],
        ["303", "canonical", SHARED_APP, "303", "79", "bound", "app-scoped", 0],
      ],
    );
    // Shared App intentionally binds two repositories to one credential; the dedicated App stays distinct.
    assert.equal(first.executor.appCredential.fingerprint, third.executor.appCredential.fingerprint);
    assert.notEqual(second.executor.appCredential.fingerprint, first.executor.appCredential.fingerprint);
    assert.deepEqual(readdirSync(path.join(home, "executor", "apps")).sort(), [SHARED_APP, DEDICATED_APP]);
    // One Authority referenced by every repository, one key custody entry.
    for (const item of [first, second, third]) {
      assert.deepEqual(item.authority.identity, { ...authorityReference, custody: "authority-id" });
      assert.deepEqual(item.admission, { id: admission.config.id, executorId: executor.id });
      assert.equal(item.executor.componentId, executor.id);
    }
    assert.equal(first.endpoint, ENDPOINT);
    assert.equal(listLocalAuthorityIdentities(environment).length, 1);
    assert.deepEqual(readdirSync(path.join(home, "authority", "keys")), [runtimeAuthority.id]);

    // No secret, key path or owner path in any projection or repository-state file.
    const secrets = [pemOf(keyA).toString("utf8").slice(40, 90), pemOf(keyB).toString("utf8").slice(40, 90)];
    assert.deepEqual(leaks([first, second, third], home, secrets), []);
    assert.deepEqual(findSetupSecretMaterial([first, second, third]), []);
    for (const repository of readdirSync(path.join(home, "repositories"))) {
      const directory = path.join(home, "repositories", repository);
      assert.deepEqual(readdirSync(directory).sort(), ["repository.json", "setup.json"]);
      for (const file of readdirSync(directory)) {
        assert.deepEqual(leaks(readFileSync(path.join(directory, file), "utf8"), home, secrets), [], file);
        assert.equal(statSync(path.join(directory, file)).mode & 0o077, 0);
      }
    }

    // Setup observation converges on the same canonical owner evidence for every repository.
    for (const repository of [adopted, dedicated, shared]) {
      const observed = await observeSetup(repository, { environment, provider: unavailableProvider });
      assert.equal(observed.configuration.status, "configured", JSON.stringify(observed.configuration));
      assert.equal(observed.providerBinding.status, "bound", repository.nameWithOwner);
    }

    // A fresh process without any matching legacy export reconstructs the same bindings.
    assert.deepEqual(freshProcessBindings(home, [adopted, dedicated, shared]), [first, second, third]);

    // The existing Local Runtime Executor execution path acts for the adopted repository with its
    // App-scoped credential, and for the dedicated repository with its own App, never another.
    const provider = github(
      { A: createPublicKey(keyA.privateKey), B: createPublicKey(keyB.privateKey) },
      {
        "77:one": { id: 101, full_name: "acme/one" },
        "88:two": { id: 202, full_name: "acme/two" },
        "79:three": { id: 303, full_name: "acme/three" },
      },
    );
    const resolved = await withFetch(provider.fetch, async () => [
      await resolveLocalExecutorRepository("acme/one", executionEnvironment),
      await resolveLocalExecutorRepository("acme/two", executionEnvironment),
      await resolveLocalExecutorRepository("acme/three", executionEnvironment),
    ]);
    assert.deepEqual(resolved, [adopted, dedicated, shared]);
    assert.deepEqual(provider.mints, [
      { installationId: "77", iss: SHARED_APP, signer: "A" },
      { installationId: "88", iss: DEDICATED_APP, signer: "B" },
      { installationId: "79", iss: SHARED_APP, signer: "A" },
    ]);
    assert.deepEqual(provider.unexpected, []);

    // Stale or conflicting legacy evidence never overwrites canonical records.
    replaceLocalJsonIfCurrent(
      "runtime",
      legacySetupPath,
      legacySetup,
      validateSetupConfigRecord({ ...legacySetup, revision: 9, app: { appId: "999", installationId: "1" } }),
      validateSetupConfigRecord,
      environment,
    );
    const rerun = await migrateLegacySetupConfig(adopted, { environment });
    assert.equal(rerun.outcome, "canonical");
    assert.deepEqual(resolveRepositoryComponentBinding(adopted, { environment }), first);
    assert.equal(
      readExecutorCustodyEvidence(environment).credentials.every((item) => item.source === "app-scoped"),
      true,
    );

    // Rename preserves immutable identity and bindings.
    const renamed = { ...dedicated, nameWithOwner: "acme/two-renamed" };
    store.update(renamed, store.read(dedicated).revision, {});
    for (const observed of [renamed, dedicated]) {
      const after = resolveRepositoryComponentBinding(observed, { environment });
      assert.deepEqual(after.repository, renamed);
      assert.deepEqual(after.executor, second.executor);
      assert.deepEqual(after.authority, second.authority);
    }
    assert.deepEqual(resolveRepositoryComponentBinding(shared, { environment }), third);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
