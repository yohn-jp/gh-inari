import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeImplementation, type ImplementationAuthorizationRecord } from "./implementation-authorization.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import {
  classifyChangeRoot,
  IMPLEMENTATION_CHANGE_IDENTITY_MODE,
  HISTORICAL_ISSUE_ROOT_CHANGE_MODE,
  tryProjectImplementationChangeIdentity,
  validateImplementationChangeIdentitySet,
} from "./implementation-change-identity.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "100",
  repository: "acme/inari",
} as const;
const source = { ...repository, number: 568 } as const;
const base = { branch: "main", revision: "base-revision", freshness: "base-revision" } as const;

function contract(number: number, branch: string): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [source],
    objective: `Implement session ${number}.`,
    nonGoals: ["Automatic source closure"],
    architecture: {
      decision: "Bind one Change to one Implementation authorization.",
      affectedComponents: ["Implementation identity"],
      invariants: ["The source Issue is not the execution root."],
      compatibilityConstraints: ["Historical Issue-rooted Changes remain readable."],
    },
    scope: {
      readOnly: ["src/**"],
      write: ["src/**"],
      create: ["src/**"],
      delete: [],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not close the source Issue implicitly."],
      immutableAreas: ["The authorization digest"],
      prerequisites: ["The current Implementation authorization is valid."],
    },
    verification: {
      acceptanceCriteria: ["Identity components remain collision-free."],
      targetedTests: [],
      requiredChecks: ["pnpm run verify"],
      postconditions: ["The binding is deterministic."],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch,
      dependencies: [source],
    },
  };
}

function authorization(
  number: number,
  branch: string,
): {
  readonly implementation: {
    readonly repositoryHost: string;
    readonly repositoryId: string;
    readonly repository: string;
    readonly number: number;
  };
  readonly body: string;
  readonly authorization: ImplementationAuthorizationRecord;
} {
  const implementation = { ...repository, number };
  const body = renderImplementationIssueBody(parseImplementationContract(contract(number, branch)));
  return {
    implementation,
    body,
    authorization: authorizeImplementation({
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
    }),
  };
}

function change(number: number, branch: string, pullRequest: number): Record<string, unknown> {
  return {
    version: 1,
    identity: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId, rootIssue: number },
    state: "DRAFT",
    provenance: { requester: "agent:implementation", issuer: "app:inari" },
    projection: { branch, pullRequest },
  };
}

function identityInput(
  number: number,
  branch = `feat/${number}-identity`,
  pullRequest = 900 + number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const current = authorization(number, branch);
  return {
    contract: contract(number, branch),
    implementation: current.implementation,
    authorization: current.authorization,
    change: change(number, branch, pullRequest),
    session: {
      task: { kind: "issue", number },
      capabilities: [
        { kind: "change.implement", issue: number },
        { kind: "branch.advance", branch },
      ],
      authorizationDigest: current.authorization.governedBodyDigest,
    },
    branch,
    baseBranch: base.branch,
    pullRequest: {
      number: pullRequest,
      relation: { relation: "implements", references: [current.implementation], representation: "native" },
      closingReference: current.implementation,
    },
    executionEvidence: {
      version: 1,
      kind: "implementation-execution-evidence",
      implementation: current.implementation,
      repository,
      governedBodyDigest: current.authorization.governedBodyDigest,
      base,
      branch,
      headRevision: `head-${number}`,
      targetedTests: [],
    },
    ...overrides,
  };
}

test("binds one Implementation authorization to the Change, Session, PR, and evidence identities", () => {
  const result = tryProjectImplementationChangeIdentity(identityInput(575));
  assert.equal(result.valid, true);
  assert.equal(result.identity?.mode, IMPLEMENTATION_CHANGE_IDENTITY_MODE);
  assert.equal(result.identity?.implementation.number, 575);
  assert.equal(result.identity?.change.identity.rootIssue, 575);
  assert.equal(result.identity?.session.task.number, 575);
  assert.equal(result.identity?.session.capability.issue, 575);
  assert.equal(result.identity?.session.branchCapability?.branch, result.identity?.branch.name);
  assert.equal(result.identity?.pullRequest.implements.number, 575);
  assert.equal(result.identity?.pullRequest.closingReference.number, 575);
  assert.equal(
    result.identity?.executionEvidence.governedBodyDigest,
    result.identity?.authorization.governedBodyDigest,
  );
  assert.equal(Object.isFrozen(result.identity), true);
});

test("two Implementation children of one source Issue have distinct execution identities", () => {
  const first = tryProjectImplementationChangeIdentity(identityInput(575));
  const second = tryProjectImplementationChangeIdentity(identityInput(576));
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.notEqual(first.identity?.identityKey, second.identity?.identityKey);
  assert.notEqual(first.identity?.change.identityKey, second.identity?.change.identityKey);
  assert.notEqual(first.identity?.branch.name, second.identity?.branch.name);
  assert.notEqual(first.identity?.pullRequest.number, second.identity?.pullRequest.number);
  assert.equal(validateImplementationChangeIdentitySet([first.identity!, second.identity!]).valid, true);
});

test("rejects source-only PR linkage and mismatched Session binding", () => {
  const sourceOnly = identityInput(575, "feat/575-identity", 1475, {
    pullRequest: {
      number: 1475,
      relation: { relation: "implements", references: [source], representation: "recognized-convention" },
      closingReference: source,
    },
  });
  const sourceResult = tryProjectImplementationChangeIdentity(sourceOnly);
  assert.equal(sourceResult.valid, false);
  assert.ok(sourceResult.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_PR_MISMATCH"));
  assert.ok(
    sourceResult.diagnostics.some(
      (entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_CLOSING_REFERENCE_MISMATCH",
    ),
  );

  const sessionResult = tryProjectImplementationChangeIdentity(
    identityInput(575, "feat/575-identity", 1475, {
      session: {
        task: { kind: "issue", number: 568 },
        capabilities: [{ kind: "change.implement", issue: 568 }],
        authorizationDigest: authorization(575, "feat/575-identity").authorization.governedBodyDigest,
      },
    }),
  );
  assert.equal(sessionResult.valid, false);
  assert.ok(
    sessionResult.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_MISMATCH"),
  );
});

test("historical Issue-rooted Changes remain readable but fail closed for native execution", () => {
  const current = authorization(575, "feat/575-identity");
  const result = classifyChangeRoot({
    change: change(568, "feat/568-historical", 900),
    implementation: current.implementation,
    sourceIssues: [source],
  });
  assert.equal(result.valid, true);
  assert.equal(result.implementationNative, false);
  assert.equal(result.mode, HISTORICAL_ISSUE_ROOT_CHANGE_MODE);
  assert.ok(result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_HISTORICAL_CHANGE"));
});

test("rejects a Change/branch that diverges from the contract's declared execution branch", () => {
  const result = tryProjectImplementationChangeIdentity(
    identityInput(575, "feat/575-identity", 1475, {
      contract: contract(575, "feat/575-attacker-branch"),
    }),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_BRANCH_MISMATCH" && entry.path === "$.branch",
    ),
  );
});

test("rejects a Session branch.advance capability that diverges from the canonical branch", () => {
  const number = 575;
  const branch = `feat/${number}-identity`;
  const result = tryProjectImplementationChangeIdentity(
    identityInput(number, branch, 1475, {
      session: {
        task: { kind: "issue", number },
        capabilities: [
          { kind: "change.implement", issue: number },
          { kind: "branch.advance", branch: "feat/575-attacker-branch" },
        ],
        authorizationDigest: authorization(number, branch).authorization.governedBodyDigest,
      },
    }),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_BRANCH_MISMATCH"),
  );
});

test("rejects conflicting Session branch.advance capabilities instead of selecting one", () => {
  const number = 575;
  const branch = `feat/${number}-identity`;
  const result = tryProjectImplementationChangeIdentity(
    identityInput(number, branch, 1475, {
      session: {
        task: { kind: "issue", number },
        capabilities: [
          { kind: "change.implement", issue: number },
          { kind: "branch.advance", branch },
          { kind: "branch.advance", branch: "feat/575-second-branch" },
        ],
        authorizationDigest: authorization(number, branch).authorization.governedBodyDigest,
      },
    }),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_SESSION_BRANCH_MISMATCH"),
  );
});

test("one Implementation cannot silently claim two branch or PR identities", () => {
  const first = tryProjectImplementationChangeIdentity(identityInput(575, "feat/575-identity", 1475));
  const second = tryProjectImplementationChangeIdentity(identityInput(575, "feat/575-other", 1476));
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  const result = validateImplementationChangeIdentitySet([first.identity!, second.identity!]);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_COLLISION"));
});

test("Implementation identity consumes the canonical source-Issue routing projection", () => {
  const branch = "feat/575-identity";
  const issueBranch = "issue/568-source";
  const current = identityInput(575, branch, 1475);
  const contractValue = current.contract as Record<string, unknown>;
  const execution = { ...(contractValue.execution as Record<string, unknown>), baseBranch: issueBranch };
  const authorizationValue = current.authorization as Record<string, unknown>;
  const authorization = {
    ...authorizationValue,
    base: { ...(authorizationValue.base as Record<string, unknown>), branch: issueBranch },
  };
  const evidenceValue = current.executionEvidence as Record<string, unknown>;
  const executionEvidence = {
    ...evidenceValue,
    base: { ...(evidenceValue.base as Record<string, unknown>), branch: issueBranch },
  };
  const result = tryProjectImplementationChangeIdentity({
    ...current,
    contract: { ...contractValue, execution },
    authorization,
    baseBranch: issueBranch,
    executionEvidence,
    routing: {
      mode: "issue-integration",
      implementation: current.implementation,
      sourceIssue: source,
      epic: { ...repository, number: 500 },
      relationships: {
        implementationParent: source,
        sourceIssueParent: { ...repository, number: 500 },
      },
      branches: {
        default: "main",
        implementation: branch,
        issue: issueBranch,
        epic: "epic/500-dashboard",
      },
      role: "implementation",
      head: branch,
      base: issueBranch,
    },
  });
  assert.equal(result.valid, true);
  assert.equal(result.identity?.routing?.expectedBase, issueBranch);

  const directEpic = tryProjectImplementationChangeIdentity({
    ...current,
    contract: { ...contractValue, execution },
    authorization,
    baseBranch: issueBranch,
    executionEvidence,
    routing: {
      mode: "issue-integration",
      implementation: current.implementation,
      sourceIssue: source,
      epic: { ...repository, number: 500 },
      relationships: {
        implementationParent: source,
        sourceIssueParent: { ...repository, number: 500 },
      },
      branches: {
        default: "main",
        implementation: branch,
        issue: issueBranch,
        epic: "epic/500-dashboard",
      },
      role: "implementation",
      head: branch,
      base: "epic/500-dashboard",
    },
  });
  assert.equal(directEpic.valid, false);
  assert.ok(directEpic.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CHANGE_IDENTITY_ROUTING_INVALID"));
});
