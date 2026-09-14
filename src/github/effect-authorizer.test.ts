import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeEffect, ChangeEffectSuccessEvidence } from "../change.js";
import {
  INITIAL_CHANGE_EFFECT_PERMISSION_REQUIREMENTS,
  APP_PRINCIPAL_MAXIMUM_PERMISSIONS,
  INARI_APP_PRINCIPAL_KIND,
  INARI_APP_PRINCIPAL_SLUG,
  INARI_APP_PRINCIPAL,
  EFFECT_AUTHORIZER_CONTRACT_VERSION,
  InariEffectAuthorizer,
  EffectAuthorizerError,
  createInariAppPrincipalIdentity,
  requiredPermissionsForEffects,
  validateInariAppPrincipalIdentity,
  validateAppInstallationScope,
  validateEffectAuthorizerMutationRequest,
  validateTrustedExecutionContext,
  type AppInstallationScope,
  type EffectAuthorizerCredentialRequest,
  type EffectAuthorizerMutationRequest,
  type RepositoryIdentity,
  type TrustedExecutionContext,
  type TrustedInstallationCredentialBroker,
} from "./effect-authorizer.js";
import {
  InariIssuerAppAuthority as LegacyIssuerAppAuthority,
  IssuerAuthorityError as LegacyIssuerAuthorityError,
} from "./issuer-authority.js";

const repository: RepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "100000217",
  nameWithOwner: "acme/inari",
};

const execution: TrustedExecutionContext = {
  version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
  runtime: "github-actions",
  event: "workflow_dispatch",
  repository,
  workflowRef: "refs/heads/main",
  workflowSha: "a".repeat(40),
  workflowTrust: "protected",
  codeExecution: "trusted-only",
  fork: false,
  pullRequest: false,
  requester: "human:requester",
};

const effects = [
  {
    kind: "CREATE_BRANCH",
    branch: "feat/217-establish-least-privilege-inari-issuer-app-authority",
    baseBranch: "main",
  },
  {
    kind: "CREATE_PULL_REQUEST",
    branch: "feat/217-establish-least-privilege-inari-issuer-app-authority",
    baseBranch: "main",
    rootIssue: 217,
    title: "Change #217",
    body: "Closes #217",
    draft: true,
  },
] as const;

const app = createInariAppPrincipalIdentity("123456");
const scope: AppInstallationScope = {
  app,
  installation: {
    appId: app.appId,
    installationId: "654321",
    repositoryHost: repository.repositoryHost,
  },
  repository,
  repositorySelection: "selected",
  permissions: { contents: "write", pull_requests: "write" },
  expiresAt: "2026-09-06T00:00:00.000Z",
};

function successEvidence(effect: ChangeEffect): ChangeEffectSuccessEvidence {
  switch (effect.kind) {
    case "CREATE_BRANCH":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        createdCommitSha: "0123456789abcdef0123456789abcdef01234567",
      };
    case "CREATE_PROVENANCE_COMMIT":
      return {
        kind: effect.kind,
        branch: effect.branch,
        rootIssue: effect.rootIssue,
        path: effect.path,
        createdCommitSha: "0123456789abcdef0123456789abcdef01234567",
      };
    case "CREATE_PULL_REQUEST":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        rootIssue: effect.rootIssue,
        pullRequest: 901,
      };
    case "MARK_PULL_REQUEST_READY":
    case "CLOSE_PULL_REQUEST":
      return { kind: effect.kind, pullRequest: effect.pullRequest };
    case "DELETE_BRANCH":
      return effect.expectedCommitSha === undefined
        ? { kind: effect.kind, branch: effect.branch }
        : { kind: effect.kind, branch: effect.branch, expectedCommitSha: effect.expectedCommitSha, outcome: "deleted" };
  }
}

function request(overrides: Partial<EffectAuthorizerMutationRequest> = {}): EffectAuthorizerMutationRequest {
  return {
    version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
    authority: "issuer",
    execution,
    target: repository,
    effects,
    ...overrides,
  };
}

function brokerFor(
  candidateScope: unknown = scope,
  onEffect: (effect: unknown) => Promise<void> = async () => undefined,
): { broker: TrustedInstallationCredentialBroker; calls: EffectAuthorizerCredentialRequest[] } {
  const calls: EffectAuthorizerCredentialRequest[] = [];
  return {
    calls,
    broker: {
      async withScopedInstallationCredential(credentialRequest, operation) {
        calls.push(credentialRequest);
        await operation({
          scope: candidateScope,
          apply: async (effect: ChangeEffect) => {
            await onEffect(effect);
            return successEvidence(effect);
          },
        } as never);
      },
    },
  };
}

test("App Principal identity is explicit and has no reviewer authority", () => {
  assert.deepEqual(app, {
    kind: INARI_APP_PRINCIPAL_KIND,
    slug: INARI_APP_PRINCIPAL_SLUG,
    appId: "123456",
    principal: INARI_APP_PRINCIPAL,
  });
  assert.deepEqual(APP_PRINCIPAL_MAXIMUM_PERMISSIONS, {
    contents: "write",
    issues: "read",
    pull_requests: "write",
  });
  const authorizer = new InariEffectAuthorizer({ appId: app.appId, broker: brokerFor().broker });
  assert.deepEqual(authorizer.appPrincipal, app);
  assert.strictEqual(authorizer.identity, authorizer.appPrincipal);
  assert.equal("approve" in authorizer, false);
  assert.equal(validateInariAppPrincipalIdentity(app).valid, true);
});

test("legacy issuer-authority exports are aliases of the canonical Effect Authorizer", () => {
  assert.equal(LegacyIssuerAppAuthority, InariEffectAuthorizer);
  assert.equal(LegacyIssuerAuthorityError, EffectAuthorizerError);
});

test("each initial Change effect requests only its minimum permission", () => {
  const createBranch = [effects[0]];
  const createPullRequest = [effects[1]];
  assert.deepEqual(requiredPermissionsForEffects(createBranch), { contents: "write" });
  assert.deepEqual(requiredPermissionsForEffects(createPullRequest), { pull_requests: "write" });
  assert.deepEqual(requiredPermissionsForEffects(effects), { contents: "write", pull_requests: "write" });
  assert.deepEqual(INITIAL_CHANGE_EFFECT_PERMISSION_REQUIREMENTS.CREATE_BRANCH, { contents: "write" });
  assert.deepEqual(INITIAL_CHANGE_EFFECT_PERMISSION_REQUIREMENTS.CREATE_PULL_REQUEST, { pull_requests: "write" });
});

test("trusted mutation requests are normalized without credential fields", () => {
  const result = validateEffectAuthorizerMutationRequest(request());
  assert.equal(result.valid, true);
  assert.deepEqual(result.value?.permissions, { contents: "write", pull_requests: "write" });
  assert.equal(JSON.stringify(result.value).includes("token"), false);
  assert.equal(JSON.stringify(result.value).includes("privateKey"), false);
});

test("reviewer or approval authority cannot be substituted for issuer authority", () => {
  const result = validateEffectAuthorizerMutationRequest({
    ...request(),
    authority: "reviewer",
  } as unknown);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_REVIEW_AUTHORITY"));

  const withReviewerField = validateEffectAuthorizerMutationRequest({
    ...request(),
    reviewer: "human:reviewer",
  } as unknown);
  assert.equal(withReviewerField.valid, false);
  assert.ok(withReviewerField.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_UNKNOWN_PROPERTY"));
});

test("pull-request and fork execution fail closed before the broker is called", () => {
  const pullRequest = validateTrustedExecutionContext({ ...execution, event: "pull_request" });
  assert.equal(pullRequest.valid, false);
  assert.ok(pullRequest.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_UNSUPPORTED_EVENT"));

  const pullRequestTarget = validateTrustedExecutionContext({ ...execution, event: "pull_request_target" });
  assert.equal(pullRequestTarget.valid, false);
  assert.ok(pullRequestTarget.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_UNSUPPORTED_EVENT"));

  const fork = validateTrustedExecutionContext({ ...execution, fork: true });
  assert.equal(fork.valid, false);
  assert.ok(fork.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_UNTRUSTED_EXECUTION"));

  const untrustedCode = validateTrustedExecutionContext({ ...execution, codeExecution: "untrusted" });
  assert.equal(untrustedCode.valid, false);
  assert.ok(untrustedCode.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_UNTRUSTED_EXECUTION"));
});

test("execution and target repository identities must match", () => {
  const targetMismatch = validateEffectAuthorizerMutationRequest({
    ...request(),
    target: { ...repository, repositoryId: "100000218" },
  });
  assert.equal(targetMismatch.valid, false);
  assert.ok(targetMismatch.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_SCOPE_MISMATCH"));

  const hostMismatch = validateTrustedExecutionContext({
    ...execution,
    repository: { ...repository, repositoryHost: "ghe.example.com" },
  });
  assert.equal(hostMismatch.valid, true);
});

test("installation scope proves App, host, repository, selected scope, expiry, and permissions", () => {
  const valid = validateAppInstallationScope(scope, {
    app,
    target: repository,
    requiredPermissions: { contents: "write", pull_requests: "write" },
    now: new Date("2026-09-05T00:00:00.000Z"),
  });
  assert.equal(valid.valid, true);

  const installationMismatch = validateAppInstallationScope(
    {
      ...scope,
      installation: { ...scope.installation, repositoryHost: "ghe.example.com" },
    },
    { app, target: repository, requiredPermissions: scope.permissions, now: new Date("2026-09-05T00:00:00.000Z") },
  );
  assert.equal(installationMismatch.valid, false);
  assert.ok(installationMismatch.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_SCOPE_MISMATCH"));

  const extraPermission = validateAppInstallationScope(
    { ...scope, permissions: { ...scope.permissions, issues: "write" } },
    { app, target: repository, requiredPermissions: scope.permissions, now: new Date("2026-09-05T00:00:00.000Z") },
  );
  assert.equal(extraPermission.valid, false);
  assert.ok(extraPermission.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_PERMISSION_MISMATCH"));

  const expired = validateAppInstallationScope(scope, {
    app,
    target: repository,
    requiredPermissions: scope.permissions,
    now: new Date("2026-09-07T00:00:00.000Z"),
  });
  assert.equal(expired.valid, false);
  assert.ok(expired.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_CREDENTIAL_EXPIRED"));
});

test("Effect Authorizer holds the broker boundary and returns only bounded mutation receipts", async () => {
  const applied: unknown[] = [];
  const { broker, calls } = brokerFor(scope, async (effect) => {
    applied.push(effect);
  });
  const authority = new InariEffectAuthorizer({
    appId: app.appId,
    broker,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  });
  const result = await authority.applyEffects(request());

  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as unknown as EffectAuthorizerCredentialRequest)?.permissions, {
    contents: "write",
    pull_requests: "write",
  });
  assert.deepEqual(applied, effects);
  assert.deepEqual(result.effects, [
    {
      kind: "CREATE_BRANCH",
      status: "applied",
      evidence: {
        kind: "CREATE_BRANCH",
        branch: effects[0].branch,
        baseBranch: effects[0].baseBranch,
        createdCommitSha: "0123456789abcdef0123456789abcdef01234567",
      },
    },
    {
      kind: "CREATE_PULL_REQUEST",
      status: "applied",
      evidence: {
        kind: "CREATE_PULL_REQUEST",
        branch: effects[1].branch,
        baseBranch: effects[1].baseBranch,
        rootIssue: effects[1].rootIssue,
        pullRequest: 901,
      },
    },
  ]);
  assert.deepEqual(result.installation, scope.installation);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("privateKey"), false);
  assert.equal(serialized.includes("authorization"), false);
});

test("scope mismatch and capability credential fields are rejected without reaching mutation", async () => {
  const mismatched = { ...scope, repository: { ...scope.repository, repositoryId: "100000218" } };
  const { broker } = brokerFor(mismatched);
  const authority = new InariEffectAuthorizer({
    appId: app.appId,
    broker,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  });
  await assert.rejects(authority.applyEffects(request()), (error: unknown) => {
    assert.ok(error instanceof EffectAuthorizerError);
    assert.equal(error.code, "ISSUER_SCOPE_MISMATCH");
    return true;
  });

  const secret = "installation-token-must-not-escape";
  const { broker: credentialLeakBroker } = brokerFor({ ...scope, token: secret });
  const credentialLeakAuthority = new InariEffectAuthorizer({
    appId: app.appId,
    broker: credentialLeakBroker,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  });
  await assert.rejects(credentialLeakAuthority.applyEffects(request()), (error: unknown) => {
    assert.ok(error instanceof EffectAuthorizerError);
    assert.equal(error.code, "ISSUER_UNKNOWN_PROPERTY");
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("broker failures are sanitized so credential-bearing errors cannot cross the boundary", async () => {
  const secret = "private-key-material";
  const broker: TrustedInstallationCredentialBroker = {
    async withScopedInstallationCredential() {
      throw new EffectAuthorizerError([
        {
          version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
          code: "ISSUER_CREDENTIAL_BOUNDARY",
          path: "$.credential",
          message: `provider failed with token ${secret}`,
        },
      ]);
    },
  };
  const authority = new InariEffectAuthorizer({
    appId: app.appId,
    broker,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  });
  await assert.rejects(authority.applyEffects(request()), (error: unknown) => {
    assert.ok(error instanceof EffectAuthorizerError);
    assert.equal(error.code, "ISSUER_CREDENTIAL_BOUNDARY");
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});

test("unsupported effect and extra credential permissions fail closed", () => {
  assert.throws(
    () => requiredPermissionsForEffects([{ kind: "APPROVE_PULL_REQUEST" }] as unknown),
    (error: unknown) => error instanceof EffectAuthorizerError && error.code === "ISSUER_INVALID_EFFECT",
  );
  const result = validateAppInstallationScope(
    { ...scope, permissions: { ...scope.permissions, administration: "write" } },
    { app, target: repository, requiredPermissions: scope.permissions, now: new Date("2026-09-05T00:00:00.000Z") },
  );
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ISSUER_PERMISSION_MISMATCH"));
});
