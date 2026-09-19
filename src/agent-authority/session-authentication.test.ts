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
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "../implementation-contract.js";
import {
  authorizeImplementation,
  type ImplementationAuthorizationVerificationInput,
} from "../implementation-authorization.js";
import { projectImplementationSessionAuthorizationBinding } from "../implementation-session-binding.js";

const NOW = new Date("2026-09-12T00:00:30.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const REPOSITORY_ID = "123456789";
const AUTHORITY_ID = "runtime-authentication-test";
const COMMIT_SHA = "a".repeat(40);
const BLOB_SHA = "c".repeat(40);
const IMPLEMENTATION_REPOSITORY = {
  repositoryHost: "github.com",
  repositoryId: REPOSITORY_ID,
  repository: "acme/inari",
} as const;
const IMPLEMENTATION = { ...IMPLEMENTATION_REPOSITORY, number: 374 } as const;
const IMPLEMENTATION_SOURCE = { ...IMPLEMENTATION_REPOSITORY, number: 373 } as const;
const IMPLEMENTATION_BASE = {
  branch: "main",
  revision: "implementation-base-revision",
  freshness: "implementation-base-freshness",
} as const;
const IMPLEMENTATION_BODY = renderImplementationIssueBody(
  parseImplementationContract({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository: IMPLEMENTATION_REPOSITORY,
    sources: [IMPLEMENTATION_SOURCE],
    objective: "Authenticate one bound implementation session.",
    nonGoals: ["Provider trust resolution"],
    architecture: {
      decision: "Bind the certificate to the exact current Implementation authorization.",
      affectedComponents: ["Session authentication"],
      invariants: ["Replay after authorization drift fails closed."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Authentication rereads the current authorization."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: IMPLEMENTATION_BASE.branch,
      baseRevision: IMPLEMENTATION_BASE.revision,
      baseFreshness: IMPLEMENTATION_BASE.freshness,
      branch: "feat/374-implementation-session",
      dependencies: [IMPLEMENTATION_SOURCE],
    },
  }),
);

function currentImplementationAuthorization(
  overrides: Partial<ImplementationAuthorizationVerificationInput> = {},
): ImplementationAuthorizationVerificationInput {
  const authorization = authorizeImplementation({
    implementation: IMPLEMENTATION,
    body: IMPLEMENTATION_BODY,
    repository: IMPLEMENTATION_REPOSITORY,
    base: IMPLEMENTATION_BASE,
    readiness: {
      evidence: [
        {
          reference: IMPLEMENTATION_SOURCE,
          authority: "implementation-conformance",
          status: "satisfied",
          freshness: "current",
          dependencies: [],
        },
      ],
    },
  });
  return {
    authorization,
    implementation: IMPLEMENTATION,
    body: IMPLEMENTATION_BODY,
    repository: IMPLEMENTATION_REPOSITORY,
    base: IMPLEMENTATION_BASE,
    ...overrides,
  };
}

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
    providerPrincipal: scope.app,
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

test("Session authentication treats request exp as an exclusive boundary", async () => {
  const runtime = runtimeAuthority();
  const request = sessionRequest(runtime.authority, runtime.key);
  const fixture = capability(runtime.authority);
  const broker = {
    async withRepositoryReadCapability<T>(
      _input: unknown,
      operation: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation(fixture.capability);
    },
  };
  const authenticateAt = (seconds: number) =>
    authenticateSessionRequest({
      broker,
      repository: REPOSITORY,
      request,
      now: new Date(seconds * 1000),
    });

  const beforeExpiry = await authenticateAt(NOW_SECONDS + 59);
  assert.equal(beforeExpiry.request.expiresAt, NOW_SECONDS + 60);
  await assert.rejects(() => authenticateAt(NOW_SECONDS + 60), SessionAuthenticationError);
  await assert.rejects(() => authenticateAt(NOW_SECONDS + 61), SessionAuthenticationError);
});

test("rejects replay when a bound Implementation authorization is no longer current", async () => {
  const runtime = runtimeAuthority(undefined, { capabilityCeiling: ["change.implement"] });
  const current = currentImplementationAuthorization();
  const binding = projectImplementationSessionAuthorizationBinding({
    ...current,
    task: { kind: "issue", number: IMPLEMENTATION.number },
  });
  const session = createManagedSession();
  const issuanceRequest = session.createIssuanceRequest({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    task: { kind: "issue", number: IMPLEMENTATION.number },
    implementationBinding: binding,
    capabilities: [{ kind: "change.implement", issue: IMPLEMENTATION.number }],
    ttlSeconds: 600,
  });
  const issued = issueSessionCertificate({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    runtimeAuthority: runtime.authority,
    runtimeKey: runtime.key,
    request: issuanceRequest,
    implementationSession: true,
    implementationAuthorization: current,
    now: NOW,
  });
  session.acceptCertificate(issued.compact);
  const request = signSessionRequest({
    session,
    request: { issue: IMPLEMENTATION.number },
    operation: "change.implement",
    requestId: "request-bound-implementation",
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });
  const fixture = capability(runtime.authority);
  const broker = {
    async withRepositoryReadCapability<T>(
      _input: unknown,
      operation: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T> {
      return operation(fixture.capability);
    },
  };

  const authenticated = await authenticateSessionRequest({
    broker,
    repository: REPOSITORY,
    request,
    implementationAuthorization: current,
    now: NOW,
  });
  assert.deepEqual(authenticated.implementationBinding, binding);
  assert.deepEqual(authenticated.implementationScope?.scope, {
    readOnly: ["src/**"],
    write: ["src/**"],
    create: [],
    delete: [],
    deny: [],
  });

  await assert.rejects(
    authenticateSessionRequest({
      broker,
      repository: REPOSITORY,
      request,
      implementationAuthorization: {
        ...current,
        base: { ...IMPLEMENTATION_BASE, revision: "stale-base-revision" },
      },
      now: NOW,
    }),
    (error: unknown) => error instanceof SessionAuthenticationError && error.reason === "implementation-authorization",
  );

  await assert.rejects(
    authenticateSessionRequest({
      broker,
      repository: REPOSITORY,
      request,
      implementationAuthorization: {
        ...current,
        supersession: { supersededBy: [{ ...IMPLEMENTATION_REPOSITORY, number: 375 }] },
      },
      now: NOW,
    }),
    (error: unknown) => error instanceof SessionAuthenticationError && error.reason === "implementation-authorization",
  );
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
