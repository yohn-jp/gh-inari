import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { InMemoryAppUserCredentialStore } from "./github/app-user-credential-store.js";
import { GitHubAppUserCredentialBrokerError } from "./github/app-user-credential-broker.js";
import { GitHubAppUserCredentialError, createAppUserCredential } from "./github/app-user-credential.js";
import { setupRepository, RepositorySetupError } from "./repository-setup.js";
import type { GitHubAppRepositoryReadCapability } from "./github/app-installation-credential-broker.js";
import { createEndpointOnboardingDescriptor } from "./endpoint-onboarding.js";
import { DELEGATOR_ARTIFACT_DIRECTORY } from "./agent-authority/delegator.js";

const descriptor = createEndpointOnboardingDescriptor({
  githubHost: "github.com",
  appId: "42",
  appClientId: "public-client",
  appSlug: "inari",
  appInstallationUrl: "https://github.com/apps/inari/installations/new",
  appUserAuthProfile: "device-flow",
  relayConnectionBase: "wss://relay.example.test/connect",
});

test("machine setup fails with typed auth-required before Device Flow", async () => {
  await assert.rejects(
    () =>
      setupRepository({
        root: process.cwd(),
        repository: "acme/inari",
        endpoint: "https://endpoint.example.test",
        endpointDescriptor: descriptor,
        credentialStore: new InMemoryAppUserCredentialStore(),
        json: true,
      }),
    (error: unknown) => error instanceof RepositorySetupError && error.code === "REPOSITORY_SETUP_AUTH_REQUIRED",
  );
});

test("missing App installation reports the bounded install action without local trust writes", async () => {
  const broker = {
    async withRepositoryReadCapability<T>(
      _request: unknown,
      _operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      throw new GitHubAppUserCredentialBrokerError("installation-scope", { reason: "scope" } as never);
    },
  } as unknown as import("./github/app-provider-credential-broker.js").AppProviderCredentialBroker;
  const result = await setupRepository({
    root: process.cwd(),
    repository: "acme/inari",
    endpoint: "https://endpoint.example.test",
    endpointDescriptor: descriptor,
    appUserBroker: broker,
  });
  assert.equal(result.state, "app-install-required");
  assert.equal(result.appInstallationUrl, descriptor.appInstallationUrl);
  assert.equal(result.authority, undefined);
});

test("setup publishes only the public trust record and reports trust-pending until protected-ref trust is visible", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".setup-test-"));
  const configHome = await mkdtemp(path.join(os.tmpdir(), "inari-setup-profile-"));
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ token: "unrelated-worktree-secret" }), "utf8");
  const scope = {
    app: { kind: "github-app", slug: "inari-issuer", appId: "42", principal: "app:inari-issuer" },
    installation: { appId: "42", installationId: "7", repositoryHost: "github.com" },
    repository: { repositoryHost: "github.com", repositoryId: "99", nameWithOwner: "acme/inari" },
    repositorySelection: "selected",
    permissions: { contents: "read", issues: "read", pull_requests: "read" },
    expiresAt: "2027-01-01T00:00:00.000Z",
  } as const;
  const broker = {
    async withRepositoryReadCapability<T>(
      _request: unknown,
      operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation({
        providerPrincipal: scope.app,
        scope,
        transport: {
          request: async ({ path: requestPath }) => {
            if (requestPath.endsWith("/git/ref/heads/main"))
              return { status: 200, body: { ref: "refs/heads/main", object: { sha: "a".repeat(40) } } };
            if (requestPath.includes("/git/trees/"))
              return { status: 200, body: { sha: "b".repeat(40), truncated: false, tree: [] } };
            return { status: 200, body: { default_branch: "main" } };
          },
        },
      });
    },
  } as unknown as import("./github/app-provider-credential-broker.js").AppProviderCredentialBroker;
  try {
    const result = await setupRepository({
      root,
      configHome,
      repository: "acme/inari",
      endpoint: "https://endpoint.example.test",
      endpointDescriptor: descriptor,
      appUserBroker: broker,
      authorityPublisher: async (options) => {
        assert.equal(options.repository.repositoryNameWithOwner, "acme/inari");
        assert.deepEqual(Object.keys(options.authority).sort(), [
          "capabilityCeiling",
          "id",
          "key",
          "kind",
          "maxSessionTtlSeconds",
          "notAfter",
          "notBefore",
          "status",
          "version",
        ]);
        assert.doesNotMatch(JSON.stringify(options), /unrelated-worktree-secret|\.mcp\.json|privateKeyPath/u);
        return {
          status: "created",
          authorityId: options.authority.id,
          branch: "feat/1066-runtime-authority-bootstrap-0123456789abcdef",
          pullRequest: { number: 17, url: "https://github.com/acme/inari/pull/17" },
        };
      },
    });
    assert.equal(result.state, "trust-pending");
    assert.equal(result.publication?.pullRequest.number, 17);
    assert.equal(result.readiness?.ok, false);
    assert.equal(result.readiness?.state, "unknown-authority");
    const profile = JSON.parse(await readFile(result.profilePath as string, "utf8")) as { state: string };
    assert.equal(profile.state, "trust-pending");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});

test("setup fails closed on Endpoint profile drift without rotating or overwriting local authority state", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".setup-test-"));
  const configHome = await mkdtemp(path.join(os.tmpdir(), "inari-setup-profile-"));
  const scope = {
    app: { kind: "github-app", slug: "inari-issuer", appId: "42", principal: "app:inari-issuer" },
    installation: { appId: "42", installationId: "7", repositoryHost: "github.com" },
    repository: { repositoryHost: "github.com", repositoryId: "99", nameWithOwner: "acme/inari" },
    repositorySelection: "selected",
    permissions: { contents: "read", issues: "read", pull_requests: "read" },
    expiresAt: "2027-01-01T00:00:00.000Z",
  } as const;
  const broker = {
    async withRepositoryReadCapability<T>(
      _request: unknown,
      operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation({
        providerPrincipal: scope.app,
        scope,
        transport: {
          request: async ({ path: requestPath }) => {
            if (requestPath.endsWith("/git/ref/heads/main"))
              return { status: 200, body: { ref: "refs/heads/main", object: { sha: "a".repeat(40) } } };
            if (requestPath.includes("/git/trees/"))
              return { status: 200, body: { sha: "b".repeat(40), truncated: false, tree: [] } };
            return { status: 200, body: { default_branch: "main" } };
          },
        },
      });
    },
  } as unknown as import("./github/app-provider-credential-broker.js").AppProviderCredentialBroker;
  const driftedDescriptor = createEndpointOnboardingDescriptor({
    ...descriptor,
    appClientId: "different-public-client",
    relayConnectionBase: "wss://different-relay.example.test/connect",
  });
  try {
    const first = await setupRepository({
      root,
      configHome,
      repository: "acme/inari",
      endpoint: "https://endpoint.example.test",
      endpointDescriptor: descriptor,
      appUserBroker: broker,
    });
    assert.equal(first.state, "trust-pending");
    const profilePath = first.profilePath as string;
    const keyPath = first.authority?.privateKeyPath as string;
    const artifactPath = path.resolve(root, first.authority?.artifactPath as string);
    const before = {
      profile: await readFile(profilePath, "utf8"),
      key: await readFile(keyPath, "utf8"),
      artifact: await readFile(artifactPath, "utf8"),
    };
    await assert.rejects(
      () =>
        setupRepository({
          root,
          configHome,
          repository: "acme/inari",
          endpoint: "https://endpoint.example.test",
          endpointDescriptor: driftedDescriptor,
          appUserBroker: broker,
        }),
      (error: unknown) => error instanceof RepositorySetupError && error.code === "REPOSITORY_SETUP_PROFILE_MISMATCH",
    );
    assert.deepEqual(
      {
        profile: await readFile(profilePath, "utf8"),
        key: await readFile(keyPath, "utf8"),
        artifact: await readFile(artifactPath, "utf8"),
      },
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});

test("setup fails closed on mismatched local authority state without changing the profile or key", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".setup-test-"));
  const configHome = await mkdtemp(path.join(os.tmpdir(), "inari-setup-profile-"));
  const scope = {
    app: { kind: "github-app", slug: "inari-issuer", appId: "42", principal: "app:inari-issuer" },
    installation: { appId: "42", installationId: "7", repositoryHost: "github.com" },
    repository: { repositoryHost: "github.com", repositoryId: "99", nameWithOwner: "acme/inari" },
    repositorySelection: "selected",
    permissions: { contents: "read", issues: "read", pull_requests: "read" },
    expiresAt: "2027-01-01T00:00:00.000Z",
  } as const;
  const broker = {
    async withRepositoryReadCapability<T>(
      _request: unknown,
      operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation({
        providerPrincipal: scope.app,
        scope,
        transport: {
          request: async ({ path: requestPath }) => {
            if (requestPath.endsWith("/git/ref/heads/main"))
              return { status: 200, body: { ref: "refs/heads/main", object: { sha: "a".repeat(40) } } };
            if (requestPath.includes("/git/trees/"))
              return { status: 200, body: { sha: "b".repeat(40), truncated: false, tree: [] } };
            return { status: 200, body: { default_branch: "main" } };
          },
        },
      });
    },
  } as unknown as import("./github/app-provider-credential-broker.js").AppProviderCredentialBroker;
  try {
    const first = await setupRepository({
      root,
      configHome,
      repository: "acme/inari",
      endpoint: "https://endpoint.example.test",
      endpointDescriptor: descriptor,
      appUserBroker: broker,
    });
    assert.equal(first.state, "trust-pending");
    const profilePath = first.profilePath as string;
    const keyPath = first.authority?.privateKeyPath as string;
    const artifactPath = path.resolve(root, first.authority?.artifactPath as string);
    const profileBefore = await readFile(profilePath, "utf8");
    const keyBefore = await readFile(keyPath, "utf8");
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
    const { publicKey } = generateKeyPairSync("ed25519");
    artifact.key = publicKey.export({ format: "jwk" });
    await writeFile(artifactPath, JSON.stringify(artifact), "utf8");
    const artifactBefore = await readFile(artifactPath, "utf8");
    await assert.rejects(
      () =>
        setupRepository({
          root,
          configHome,
          repository: "acme/inari",
          endpoint: "https://endpoint.example.test",
          endpointDescriptor: descriptor,
          appUserBroker: broker,
        }),
      (error: unknown) =>
        error instanceof RepositorySetupError &&
        (error.code === "REPOSITORY_SETUP_AUTHORITY_MISMATCH" || error.code === "REPOSITORY_SETUP_AUTHORITY_FAILED"),
    );
    assert.equal(await readFile(profilePath, "utf8"), profileBefore);
    assert.equal(await readFile(keyPath, "utf8"), keyBefore);
    assert.equal(await readFile(artifactPath, "utf8"), artifactBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});

test("revoked App-user access clears the local credential and remains auth-required", async () => {
  const store = new InMemoryAppUserCredentialStore(
    createAppUserCredential({
      accessToken: "expired-access",
      refreshToken: "revoked-refresh",
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
    }),
  );
  const deviceFlow = {
    async refresh(): Promise<never> {
      throw new GitHubAppUserCredentialError("revoked");
    },
  } as unknown as import("./github/app-user-credential.js").GitHubAppDeviceFlowClient;
  await assert.rejects(
    () =>
      setupRepository({
        repository: "acme/inari",
        endpoint: "https://endpoint.example.test",
        endpointDescriptor: descriptor,
        credentialStore: store,
        deviceFlow,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        json: true,
      }),
    (error: unknown) => error instanceof RepositorySetupError && error.code === "REPOSITORY_SETUP_AUTH_REQUIRED",
  );
  assert.equal(await store.load(), undefined);
});

test("setup is a closed CLI operation and projects safe machine state", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["setup", "--json"], {
      setupRepository: async () => ({
        ok: true,
        operation: "setup",
        state: "trust-pending",
        endpoint: "https://endpoint.example.test",
        relayUrl: "wss://relay.example.test/connect",
        appInstallationUrl: "https://github.com/apps/inari/installations/new",
        repository: { repositoryHost: "github.com", repositoryId: "99", repositoryNameWithOwner: "acme/inari" },
        app: { appId: "42", installationId: "7" },
      }),
    });
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(lines[0] ?? "{}").state, "trust-pending");
    assert.doesNotMatch(lines[0] ?? "", /token|private-key-bytes|refresh/i);
  } finally {
    console.log = original;
  }
});

test("human setup output reports the trust PR and the required review action", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["setup"], {
      setupRepository: async () => ({
        ok: true,
        operation: "setup",
        state: "trust-pending",
        endpoint: "https://endpoint.example.test",
        relayUrl: "wss://relay.example.test/connect",
        appInstallationUrl: "https://github.com/apps/inari/installations/new",
        repository: { repositoryHost: "github.com", repositoryId: "99", repositoryNameWithOwner: "acme/inari" },
        app: { appId: "42", installationId: "7" },
        authority: {
          authorityId: "runtime-test",
          publicKeyFingerprint: "sha256:abc",
          privateKeyPath: "/private/runtime-key.pem",
          artifactPath: ".github/inari/authorities/runtime-test.json",
        },
        publication: {
          status: "created",
          authorityId: "runtime-test",
          branch: "feat/1066-runtime-authority-bootstrap-0123456789abcdef",
          pullRequest: { number: 17, url: "https://github.com/acme/inari/pull/17" },
        },
      }),
    });
    assert.equal(exitCode, 0);
    assert.ok(lines.some((line) => line.includes("Trust PR: #17 (https://github.com/acme/inari/pull/17)")));
    assert.ok(
      lines.some((line) => line.includes("Trust branch: feat/1066-runtime-authority-bootstrap-0123456789abcdef")),
    );
    assert.ok(lines.some((line) => line.includes("Review and merge the trust PR, then run inari setup again.")));
    assert.doesNotMatch(lines.join("\n"), /private\/runtime-key|private-key-bytes|token/u);
  } finally {
    console.log = original;
  }
});

test("fresh setup reaches ready from canonical trust and reruns idempotently", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".setup-test-"));
  const configHome = await mkdtemp(path.join(os.tmpdir(), "inari-setup-profile-"));
  const scope = {
    app: { kind: "github-app", slug: "inari-issuer", appId: "42", principal: "app:inari-issuer" },
    installation: { appId: "42", installationId: "7", repositoryHost: "github.com" },
    repository: { repositoryHost: "github.com", repositoryId: "99", nameWithOwner: "acme/inari" },
    repositorySelection: "selected",
    permissions: { contents: "read", issues: "read", pull_requests: "read" },
    expiresAt: "2027-01-01T00:00:00.000Z",
  } as const;
  const broker = {
    async withRepositoryReadCapability<T>(
      _request: unknown,
      operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation({
        providerPrincipal: scope.app,
        scope,
        transport: {
          request: async ({ path: requestPath }) => {
            if (requestPath.endsWith("/git/ref/heads/main"))
              return { status: 200, body: { ref: "refs/heads/main", object: { sha: "a".repeat(40) } } };
            if (requestPath.includes("/git/trees/")) {
              const names = await readdir(path.join(root, DELEGATOR_ARTIFACT_DIRECTORY));
              const authority = names.find((name) => name.endsWith(".json"));
              assert.ok(authority);
              return {
                status: 200,
                body: {
                  sha: "b".repeat(40),
                  truncated: false,
                  tree: [
                    { path: DELEGATOR_ARTIFACT_DIRECTORY, type: "tree", sha: "c".repeat(40) },
                    { path: `${DELEGATOR_ARTIFACT_DIRECTORY}/${authority}`, type: "blob", sha: "d".repeat(40) },
                  ],
                },
              };
            }
            if (requestPath.includes("/git/blobs/")) {
              const names = await readdir(path.join(root, DELEGATOR_ARTIFACT_DIRECTORY));
              const authority = names.find((name) => name.endsWith(".json"));
              assert.ok(authority);
              const content = await readFile(path.join(root, DELEGATOR_ARTIFACT_DIRECTORY, authority), "utf8");
              return {
                status: 200,
                body: {
                  sha: "d".repeat(40),
                  encoding: "base64",
                  content: Buffer.from(content, "utf8").toString("base64"),
                },
              };
            }
            return { status: 200, body: { default_branch: "main" } };
          },
        },
      });
    },
  } as unknown as import("./github/app-provider-credential-broker.js").AppProviderCredentialBroker;
  try {
    const first = await setupRepository({
      root,
      configHome,
      repository: "acme/inari",
      endpoint: "https://endpoint.example.test",
      endpointDescriptor: descriptor,
      appUserBroker: broker,
    });
    const second = await setupRepository({
      root,
      configHome,
      repository: "acme/inari",
      endpoint: "https://endpoint.example.test",
      endpointDescriptor: descriptor,
      appUserBroker: broker,
    });
    assert.equal(first.state, "ready");
    assert.equal(second.state, "ready");
    assert.equal(first.authority?.authorityId, second.authority?.authorityId);
    assert.equal(
      (await readdir(path.join(root, DELEGATOR_ARTIFACT_DIRECTORY))).filter((name) => name.endsWith(".json")).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});
