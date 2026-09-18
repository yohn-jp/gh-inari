import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_KIND,
  IMPLEMENTATION_CONTRACT_VERSION,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import {
  authorizeImplementation,
  type ImplementationAuthorizationVerificationInput,
} from "./implementation-authorization.js";
import {
  IMPLEMENTATION_SESSION_BINDING_KIND,
  IMPLEMENTATION_SESSION_BINDING_VERSION,
  projectImplementationSessionAuthorizationBinding,
  tryProjectImplementationSessionAuthorizationBinding,
  validateImplementationSessionAuthorizationBinding,
} from "./implementation-session-binding.js";
import {
  createManagedSession,
  issueSessionCertificate,
  SessionCertificateIssuanceError,
} from "./agent-authority/session-issuance.js";
import { assertRuntimeAuthority, type RuntimeAuthority } from "./agent-authority/runtime-authority.js";
import { generateRuntimeAuthorityKeyPair } from "./agent-authority/runtime-key.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "123456789",
  repository: "acme/inari",
} as const;
const implementation = { ...repository, number: 682 } as const;
const source = { ...repository, number: 678 } as const;
const base = { branch: "main", revision: "a".repeat(40), freshness: "fresh-682" } as const;
const body = renderImplementationIssueBody(
  parseImplementationContract({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [source],
    objective: "Bind one Session to one current Implementation authorization.",
    nonGoals: ["Path effect enforcement"],
    architecture: {
      decision: "Reuse the existing Implementation authorization identity.",
      affectedComponents: ["Session authority"],
      invariants: ["The governed body is not copied into Session credentials."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: ["src/private/**"] },
    constraints: {
      prohibitedOperations: ["Do not create a second authorization authority."],
      immutableAreas: ["The authorization digest"],
      prerequisites: [],
    },
    verification: {
      acceptanceCriteria: ["Stale authorization fails closed."],
      targetedTests: ["pnpm test"],
      requiredChecks: ["pnpm run verify"],
      postconditions: ["The exact current authorization remains bound."],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch: "refactor/682-session-implementation-authorization-binding",
      dependencies: [source],
    },
  }),
);

function currentAuthorization(
  overrides: Partial<ImplementationAuthorizationVerificationInput> = {},
): ImplementationAuthorizationVerificationInput {
  const authorization = authorizeImplementation({
    implementation,
    body,
    repository,
    base,
    readiness: {
      evidence: [
        {
          reference: source,
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
    implementation,
    body,
    repository,
    base,
    ...overrides,
  };
}

function runtimeAuthority(key: ReturnType<typeof generateRuntimeAuthorityKeyPair>): RuntimeAuthority {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "implementation-session-binding-runtime",
    key: key.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement"],
  });
}

test("projects only the exact current authorization identity and omits Issue body", () => {
  const result = tryProjectImplementationSessionAuthorizationBinding({
    ...currentAuthorization(),
    task: { kind: "issue", number: implementation.number },
  });
  assert.equal(result.valid, true);
  assert.equal(result.binding?.version, IMPLEMENTATION_SESSION_BINDING_VERSION);
  assert.equal(result.binding?.kind, IMPLEMENTATION_SESSION_BINDING_KIND);
  assert.equal(result.binding?.authorization.implementation.number, implementation.number);
  assert.equal(result.binding?.authorization.governedBodyDigest.length, 64);
  assert.deepEqual(result.binding?.repository, repository);
  assert.deepEqual(result.binding?.base, base);
  assert.deepEqual(result.binding?.task, { kind: "issue", number: implementation.number });
  assert.equal(JSON.stringify(result.binding).includes(body), false);
});

test("body drift, base drift, supersession, task mismatch, and repository substitution fail closed", () => {
  const changedBody = body.replace("Bind one Session", "Bind a different Session");
  assert.equal(
    tryProjectImplementationSessionAuthorizationBinding({
      ...currentAuthorization({ body: changedBody }),
      task: { kind: "issue", number: implementation.number },
    }).valid,
    false,
  );
  assert.equal(
    tryProjectImplementationSessionAuthorizationBinding({
      ...currentAuthorization({ base: { ...base, revision: "b".repeat(40) } }),
      task: { kind: "issue", number: implementation.number },
    }).valid,
    false,
  );
  assert.equal(
    tryProjectImplementationSessionAuthorizationBinding({
      ...currentAuthorization({ supersession: { supersededBy: [{ ...repository, number: 683 }] } }),
      task: { kind: "issue", number: implementation.number },
    }).valid,
    false,
  );
  assert.equal(
    tryProjectImplementationSessionAuthorizationBinding({
      ...currentAuthorization(),
      task: { kind: "issue", number: 683 },
    }).valid,
    false,
  );

  const binding = projectImplementationSessionAuthorizationBinding({
    ...currentAuthorization(),
    task: { kind: "issue", number: implementation.number },
  });
  assert.equal(
    validateImplementationSessionAuthorizationBinding({
      ...binding,
      repository: { ...binding.repository, repositoryId: "987654321" },
    }).valid,
    false,
  );
});

test("implementation-native issuance cannot omit the authorization binding", () => {
  const session = createManagedSession();
  const request = session.createIssuanceRequest({
    repository: { id: repository.repositoryId, name: repository.repository as string },
    task: { kind: "issue", number: implementation.number },
    capabilities: [{ kind: "change.implement", issue: implementation.number }],
    ttlSeconds: 600,
  });
  const key = generateRuntimeAuthorityKeyPair();
  const authority = runtimeAuthority(key);

  assert.throws(
    () =>
      issueSessionCertificate({
        repository: request.repository,
        runtimeAuthority: authority,
        runtimeKey: key,
        request,
        now: new Date("2026-09-18T00:00:00Z"),
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_ISSUANCE_IMPLEMENTATION_BINDING_REQUIRED",
  );

  assert.throws(
    () =>
      issueSessionCertificate({
        repository: request.repository,
        runtimeAuthority: authority,
        runtimeKey: key,
        request,
        implementationAuthorization: currentAuthorization(),
        now: new Date("2026-09-18T00:00:00Z"),
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_ISSUANCE_IMPLEMENTATION_BINDING_REQUIRED",
  );
});

test("managed issuance signs the binding only after current authorization verification", () => {
  const binding = projectImplementationSessionAuthorizationBinding({
    ...currentAuthorization(),
    task: { kind: "issue", number: implementation.number },
  });
  const session = createManagedSession();
  const request = session.createIssuanceRequest({
    repository: { id: repository.repositoryId, name: repository.repository as string },
    task: { kind: "issue", number: implementation.number },
    implementationBinding: binding,
    capabilities: [{ kind: "change.implement", issue: implementation.number }],
    ttlSeconds: 600,
  });
  const key = generateRuntimeAuthorityKeyPair();
  const authority = runtimeAuthority(key);
  const issued = issueSessionCertificate({
    repository: request.repository,
    runtimeAuthority: authority,
    runtimeKey: key,
    request,
    implementationAuthorization: currentAuthorization(),
    now: new Date("2026-09-18T00:00:00Z"),
  });
  assert.deepEqual(issued.payload.implementationBinding, binding);
  assert.equal(JSON.stringify(issued.payload).includes(body), false);

  assert.throws(
    () =>
      issueSessionCertificate({
        repository: request.repository,
        runtimeAuthority: authority,
        runtimeKey: key,
        request,
        now: new Date("2026-09-18T00:00:00Z"),
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_ISSUANCE_IMPLEMENTATION_BINDING_REQUIRED",
  );
  assert.throws(
    () =>
      issueSessionCertificate({
        repository: request.repository,
        runtimeAuthority: authority,
        runtimeKey: key,
        request,
        implementationAuthorization: currentAuthorization({ base: { ...base, revision: "c".repeat(40) } }),
        now: new Date("2026-09-18T00:00:00Z"),
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_ISSUANCE_IMPLEMENTATION_BINDING_INVALID",
  );
});
