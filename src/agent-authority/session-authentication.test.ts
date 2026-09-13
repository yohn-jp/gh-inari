import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalRuntimeAuthorityJson,
  createManagedSession,
  generateRuntimeAuthorityKeyPair,
  issueSessionCertificate,
  signSessionRequest,
  type RuntimeAuthority,
} from "./index.js";
import { assertRuntimeAuthority } from "./runtime-authority.js";
import { authenticateSessionRequest, SessionAuthenticationError } from "./session-authentication.js";
import type { GitHubAppRepositoryReadCapability } from "../github/app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "../github/change-effect-adapter.js";

const NOW = new Date("2026-09-12T00:00:30.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const REPOSITORY_ID = "123456789";
const AUTHORITY_ID = "runtime-authentication-test";
const COMMIT_SHA = "a".repeat(40);
const BLOB_SHA = "c".repeat(40);

function runtimeAuthority(
  key = generateRuntimeAuthorityKeyPair(),
  overrides: Record<string, unknown> = {},
): {
  authority: RuntimeAuthority;
  key: ReturnType<typeof generateRuntimeAuthorityKeyPair>;
} {
  return {
    key,
    authority: assertRuntimeAuthority({
      version: 1,
      kind: "runtime-authority",
      id: AUTHORITY_ID,
      key: key.publicKeyJwk,
      status: "active",
      notBefore: "2026-01-01T00:00:00Z",
      notAfter: null,
      maxSessionTtlSeconds: 3_600,
      capabilityCeiling: ["change.implement"],
      ...overrides,
    }),
  };
}

function sessionRequest(authority: RuntimeAuthority, key: ReturnType<typeof generateRuntimeAuthorityKeyPair>) {
  const session = createManagedSession();
  const issuanceRequest = session.createIssuanceRequest({
    repository: { id: REPOSITORY_ID, name: "old-owner/old-name" },
    task: { kind: "issue", number: 374 },
    capabilities: [{ kind: "change.implement", issue: 374 }],
    ttlSeconds: 600,
  });
  const issued = issueSessionCertificate({
    repository: { id: REPOSITORY_ID, name: "old-owner/old-name" },
    runtimeAuthority: authority,
    runtimeKey: key,
    request: issuanceRequest,
    now: NOW,
  });
  session.acceptCertificate(issued.compact);
  return signSessionRequest({
    session,
    request: { issue: 374 },
    operation: "change.implement",
    requestId: "request-authentication-test",
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });
}

function capability(
  authority: RuntimeAuthority,
  overrides: {
    readonly repositoryId?: string;
    readonly scopeRepositoryId?: string;
    readonly root?: Record<string, unknown>;
    readonly scopeNameWithOwner?: string;
  } = {},
): {
  readonly capability: GitHubAppRepositoryReadCapability;
  readonly calls: string[];
  readonly enter: { value: boolean };
} {
  const calls: string[] = [];
  const enter = { value: false };
  const repositoryId = overrides.repositoryId ?? REPOSITORY_ID;
  const root = {
    id: Number(repositoryId),
    full_name: "acme/inari",
    fork: false,
    default_branch: "main",
    ...overrides.root,
  };
  const content = Buffer.from(canonicalRuntimeAuthorityJson(authority), "utf8").toString("base64");
  const scope: GitHubAppRepositoryReadCapability["scope"] = {
    app: { kind: "github-app", slug: "inari-issuer", appId: "1", principal: "app:inari-issuer" },
    installation: { appId: "1", installationId: "2", repositoryHost: "github.com" },
    repository: {
      repositoryHost: "github.com",
      repositoryId: overrides.scopeRepositoryId ?? repositoryId,
      nameWithOwner: overrides.scopeNameWithOwner ?? "acme/inari",
    },
    repositorySelection: "selected" as const,
    permissions: { contents: "read" as const, issues: "read" as const, pull_requests: "read" as const },
    expiresAt: "2026-09-12T00:10:00Z",
  };
  const readCapability: GitHubAppRepositoryReadCapability = {
    scope,
    transport: {
      async request(request) {
        calls.push(request.path);
        if (request.path === "repos/acme/inari") return { status: 200, body: root };
        if (request.path === "repos/acme/inari/git/ref/heads/main") {
          return {
            status: 200,
            body: { ref: "refs/heads/main", object: { type: "commit", sha: COMMIT_SHA } },
          };
        }
        if (request.path.includes("/git/trees/")) {
          return {
            status: 200,
            body: {
              sha: "b".repeat(40),
              truncated: false,
              tree: [
                {
                  path: `.github/inari/authorities/${AUTHORITY_ID}.json`,
                  type: "blob",
                  sha: BLOB_SHA,
                },
              ],
            },
          };
        }
        if (request.path.includes("/git/blobs/")) {
          return { status: 200, body: { sha: BLOB_SHA, encoding: "base64", content } };
        }
        return { status: 404, body: {} };
      },
    },
  };
  return { capability: readCapability, calls, enter };
}

test("authenticates from one fresh App read capability and emits only bounded authority", async () => {
  const runtime = runtimeAuthority();
  const request = sessionRequest(runtime.authority, runtime.key);
  const fixture = capability(runtime.authority);
  let brokerRequest: unknown;
  const broker = {
    async withRepositoryReadCapability<T>(
      input: unknown,
      operation: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      brokerRequest = input;
      fixture.enter.value = true;
      return operation(fixture.capability);
    },
  };

  const context = await authenticateSessionRequest({
    broker,
    repository: REPOSITORY,
    request,
    now: NOW,
  });

  assert.deepEqual(brokerRequest, {});
  assert.deepEqual(context.repository, {
    repositoryHost: "github.com",
    repositoryId: REPOSITORY_ID,
    nameWithOwner: "acme/inari",
  });
  assert.deepEqual(context.runtimeAuthority, { id: AUTHORITY_ID, kid: AUTHORITY_ID });
  assert.equal(context.session.id.startsWith("session:"), false);
  assert.equal(context.session.certificateJti, context.verifiedRequest.certificate.payload.jti);
  assert.deepEqual(context.task, { kind: "issue", number: 374 });
  assert.deepEqual(context.capabilities, [{ kind: "change.implement", issue: 374 }]);
  assert.deepEqual(context.authority, { ref: "main", sha: COMMIT_SHA });
  assert.deepEqual(context.request, {
    requestId: request.requestId,
    operation: request.operation,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });
  assert.equal(context.verifiedRequest.envelope.certificate, request.certificate);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.repository), true);
  assert.equal(JSON.stringify(context).includes("installation-token"), false);
  assert.deepEqual(fixture.calls, [
    "repos/acme/inari",
    "repos/acme/inari",
    "repos/acme/inari/git/ref/heads/main",
    "repos/acme/inari/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1",
    "repos/acme/inari/git/blobs/cccccccccccccccccccccccccccccccccccccccc",
  ]);
  assert.equal(fixture.enter.value, true);
});

test("succeeds across a provider-resolved repository rename with unchanged immutable repository ID", async () => {
  const runtime = runtimeAuthority();
  const request = sessionRequest(runtime.authority, runtime.key);
  const fixture = capability(runtime.authority, { scopeNameWithOwner: "acme/old-inari-name" });
  const broker = {
    async withRepositoryReadCapability<T>(
      _input: unknown,
      operation: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation(fixture.capability);
    },
  };

  const context = await authenticateSessionRequest({
    broker,
    repository: REPOSITORY,
    request,
    now: NOW,
  });

  assert.deepEqual(context.repository, {
    repositoryHost: "github.com",
    repositoryId: REPOSITORY_ID,
    nameWithOwner: "acme/inari",
  });
});

test("fails closed when the scoped credential's immutable repository ID differs from the freshly resolved one", async () => {
  const runtime = runtimeAuthority();
  const request = sessionRequest(runtime.authority, runtime.key);
  const fixture = capability(runtime.authority, { scopeRepositoryId: "987654321" });
  const broker = {
    async withRepositoryReadCapability<T>(
      _input: unknown,
      operation: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation(fixture.capability);
    },
  };
  await assert.rejects(
    authenticateSessionRequest({ broker, repository: REPOSITORY, request, now: NOW }),
    (error: unknown) => error instanceof SessionAuthenticationError && error.reason === "repository",
  );
});

test("rejects a Runtime key substitution and an invalid Session PoP", async () => {
  const trusted = runtimeAuthority();
  const substituted = runtimeAuthority();
  const substitutedRequest = sessionRequest(substituted.authority, substituted.key);
  const fixture = capability(trusted.authority);
  const broker = {
    async withRepositoryReadCapability<T>(
      _input: unknown,
      operation: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation(fixture.capability);
    },
  };
  await assert.rejects(
    authenticateSessionRequest({ broker, repository: REPOSITORY, request: substitutedRequest, now: NOW }),
    (error: unknown) => error instanceof SessionAuthenticationError && error.reason === "runtime-signature",
  );

  const validRequest = sessionRequest(trusted.authority, trusted.key);
  const invalidPop = { ...validRequest, signature: Buffer.alloc(64, 1).toString("base64url") };
  await assert.rejects(
    authenticateSessionRequest({ broker, repository: REPOSITORY, request: invalidPop, now: NOW }),
    (error: unknown) => error instanceof SessionAuthenticationError && error.reason === "session-request",
  );
});

test("rejects repository substitution and disabled current trust", async () => {
  const trusted = runtimeAuthority();
  const request = sessionRequest(trusted.authority, trusted.key);
  const substitutedFixture = capability(trusted.authority, { repositoryId: "987654321" });
  const broker = {
    async withRepositoryReadCapability<T>(
      _input: unknown,
      operation: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation(substitutedFixture.capability);
    },
  };
  await assert.rejects(
    authenticateSessionRequest({ broker, repository: REPOSITORY, request, now: NOW }),
    (error: unknown) => error instanceof SessionAuthenticationError && error.reason === "certificate",
  );

  const disabled = runtimeAuthority(trusted.key, { status: "disabled" });
  const disabledRequest = sessionRequest(trusted.authority, trusted.key);
  const disabledFixture = capability(disabled.authority);
  const disabledBroker = {
    async withRepositoryReadCapability<T>(
      _input: unknown,
      operation: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation(disabledFixture.capability);
    },
  };
  await assert.rejects(
    authenticateSessionRequest({ broker: disabledBroker, repository: REPOSITORY, request: disabledRequest, now: NOW }),
    (error: unknown) => error instanceof SessionAuthenticationError && error.reason === "runtime-trust",
  );
});
