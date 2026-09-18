import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueReference } from "./contract/issue-reference.js";
import { planSemanticIssueClosure, type SemanticIssueClosureEvidenceInput } from "./semantic-issue-closure.js";
import {
  LocalSemanticIssueClosureExecutor,
  SemanticIssueClosureExecutorError,
  type SemanticIssueClosureProvider,
} from "./semantic-issue-closure-executor.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import { authorizeImplementation, type ImplementationAuthorizationRecord } from "./implementation-authorization.js";
import {
  IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
  IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
} from "./implementation-execution-evidence.js";

const target: IssueReference = {
  repositoryHost: "github.com",
  repositoryId: "100",
  repository: "acme/inari",
  number: 10,
};
const implementationSource = { ...target, number: 678 } as const;
const implementationBase = { branch: "main", revision: "base-revision", freshness: "base-freshness" } as const;

function implementationContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository: {
      repositoryHost: target.repositoryHost,
      repositoryId: target.repositoryId,
      repository: target.repository,
    },
    sources: [implementationSource],
    objective: "Reach closure admissibility for the target Issue.",
    nonGoals: ["Change merge"],
    architecture: {
      decision: "Compose existing evidence boundaries.",
      affectedComponents: ["Issue closure"],
      invariants: ["Completion is never caller asserted."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: ["src/private/**"] },
    constraints: {
      prohibitedOperations: ["Do not equate merge with completion."],
      immutableAreas: ["Authorization identity"],
      prerequisites: ["Current evidence is reread."],
    },
    verification: {
      acceptanceCriteria: ["Terminal state is evidence-derived."],
      targetedTests: [],
      requiredChecks: ["verify"],
      postconditions: ["Historical authorization remains inspectable."],
    },
    execution: {
      baseBranch: implementationBase.branch,
      baseRevision: implementationBase.revision,
      baseFreshness: implementationBase.freshness,
      branch: "feat/10-closure",
      dependencies: [implementationSource],
    },
    ...overrides,
  };
}

function implementationAuthorization(): ImplementationAuthorizationRecord {
  const body = renderImplementationIssueBody(parseImplementationContract(implementationContract()));
  return authorizeImplementation({
    implementation: target,
    body,
    repository: {
      repositoryHost: target.repositoryHost,
      repositoryId: target.repositoryId,
      repository: target.repository,
    },
    base: implementationBase,
    readiness: {
      evidence: [
        {
          reference: implementationSource,
          authority: "implementation-conformance",
          status: "satisfied",
          freshness: "current",
          dependencies: [],
        },
      ],
    },
  });
}

function implementationCollection(items: readonly unknown[]): Record<string, unknown> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function implementationPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { host: target.repositoryHost, nameWithOwner: target.repository, repositoryId: target.repositoryId },
    number: 9010,
    title: "Closure for Issue 10",
    body: "not lifecycle authority",
    state: "open",
    author: null,
    head: { ref: "feat/10-closure", sha: "head-revision" },
    base: { ref: "main", sha: "base-revision" },
    draft: false,
    labels: [],
    assignees: [],
    url: "https://provider.invalid/pull/9010",
    checks: implementationCollection([
      {
        id: "verify",
        name: "verify",
        kind: "check-run",
        identity: { context: "verify", producer: "app:trusted" },
        status: "completed",
        conclusion: "success",
        current: true,
      },
    ]),
    requiredCheckBindings: implementationCollection([{ context: "verify", producer: "app:trusted" }]),
    reviews: implementationCollection([]),
    comments: implementationCollection([]),
    inlineReviewComments: implementationCollection([]),
    changedFiles: implementationCollection([{ filename: "src/semantic-issue-closure.ts", status: "modified" }]),
    provenance: { provider: "github", endpoints: ["pulls/9010"] },
    ...overrides,
  };
}

function implementationExecutionEvidence(
  record: ImplementationAuthorizationRecord,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
    kind: IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
    implementation: record.implementation,
    repository: record.repository,
    governedBodyDigest: record.governedBodyDigest,
    base: record.base,
    branch: "feat/10-closure",
    headRevision: "head-revision",
    targetedTests: [],
    ...overrides,
  };
}

/** Genuine raw #686 Implementation lifecycle evidence proving completion for `target`. */
function implementationEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const record = implementationAuthorization();
  const body = renderImplementationIssueBody(parseImplementationContract(implementationContract()));
  return {
    authorization: record,
    issue: { reference: target, body },
    repository: {
      repositoryHost: target.repositoryHost,
      repositoryId: target.repositoryId,
      repository: target.repository,
    },
    base: implementationBase,
    pullRequestNumber: 9010,
    pullRequest: implementationPullRequest(),
    executionEvidence: implementationExecutionEvidence(record),
    ...overrides,
  };
}

/** Genuine raw evidence that resolves to a non-current, non-authorized (invalidated) result. */
function implementationEvidenceStale(): Record<string, unknown> {
  const driftedBody = renderImplementationIssueBody(
    parseImplementationContract(implementationContract({ objective: "A drifted objective." })),
  );
  return implementationEvidence({ issue: { reference: target, body: driftedBody } });
}

function evidence(
  state: "open" | "closed",
  implementation: Record<string, unknown> = implementationEvidence(),
): SemanticIssueClosureEvidenceInput {
  return {
    lifecycle: {
      scope: "complete",
      issues: [
        {
          reference: target,
          observed: {
            version: "1",
            kind: "issue",
            number: target.number,
            state,
            title: "Issue 10",
            body: "",
            metadata: {},
            relations: {
              parent: { relation: "parent", representation: "none", evidence: {} },
              dependsOn: {
                relation: "dependsOn",
                references: [],
                representation: "none",
                evidence: { bodyFallback: [] },
              },
            },
          },
          declaration: { role: "leaf" },
        },
      ],
    },
    implementation,
  };
}

class Provider implements SemanticIssueClosureProvider {
  readonly calls: string[] = [];
  current: SemanticIssueClosureEvidenceInput;
  readonly postState: { number: number; state: "open" | "closed" };

  constructor(current = evidence("open"), postState: "open" | "closed" = "closed") {
    this.current = current;
    this.postState = { number: target.number, state: postState };
  }

  async readEvidence(): Promise<SemanticIssueClosureEvidenceInput> {
    this.calls.push("readEvidence");
    return this.current;
  }

  async closeIssue(): Promise<void> {
    this.calls.push("closeIssue");
    this.current = evidence("closed");
  }

  async readState(): Promise<unknown> {
    this.calls.push("readState");
    return this.postState;
  }
}

function plan() {
  return planSemanticIssueClosure({ target, intent: "close", ...evidence("open") });
}

test("close executor rereads, applies one explicit effect, and verifies provider state", async () => {
  const provider = new Provider();
  const result = await new LocalSemanticIssueClosureExecutor({ provider }).execute({ version: "1", plan: plan() });
  assert.equal(result.outcome, "verified");
  assert.deepEqual(provider.calls, ["readEvidence", "closeIssue", "readState"]);
});

test("close executor rejects stale reread evidence before the effect", async () => {
  const provider = new Provider(evidence("open", implementationEvidenceStale()));
  await assert.rejects(
    new LocalSemanticIssueClosureExecutor({ provider }).execute({ version: "1", plan: plan() }),
    (error: unknown) =>
      error instanceof SemanticIssueClosureExecutorError &&
      error.code === "SEMANTIC_ISSUE_CLOSURE_EXECUTION_STALE" &&
      !provider.calls.includes("closeIssue"),
  );
});

test("already-closed retry is idempotent only for compatible evidence", async () => {
  const provider = new Provider();
  const executor = new LocalSemanticIssueClosureExecutor({ provider });
  const request = { version: "1" as const, plan: plan() };
  await executor.execute(request);
  const retry = await executor.execute(request);
  assert.equal(retry.outcome, "idempotent");
  assert.deepEqual(provider.calls, ["readEvidence", "closeIssue", "readState", "readEvidence"]);

  const incompatible = new Provider(evidence("closed", implementationEvidenceStale()));
  await assert.rejects(
    new LocalSemanticIssueClosureExecutor({ provider: incompatible }).execute(request),
    (error: unknown) =>
      error instanceof SemanticIssueClosureExecutorError &&
      error.code === "SEMANTIC_ISSUE_CLOSURE_EXECUTION_STALE" &&
      !incompatible.calls.includes("closeIssue"),
  );
});

test("close executor fails when post-close provider state is not closed", async () => {
  const provider = new Provider(evidence("open"), "open");
  await assert.rejects(
    new LocalSemanticIssueClosureExecutor({ provider }).execute({ version: "1", plan: plan() }),
    (error: unknown) =>
      error instanceof SemanticIssueClosureExecutorError &&
      error.code === "SEMANTIC_ISSUE_CLOSURE_EXECUTION_POSTCONDITION_FAILED",
  );
});
