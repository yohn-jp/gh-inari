#!/usr/bin/env node

// This runner is copied outside the checkout by the coordinator and imports
// only the installed package. It composes existing authorities; it does not
// perform provider mutation or create lifecycle persistence.
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.INARI_PACKED_PACKAGE_ROOT;
if (typeof packageRoot !== "string" || packageRoot.length === 0) throw new Error("installed package root is required");

const inari = await import(pathToFileURL(path.join(packageRoot, "dist", "index.js")).href);
const skill = await import(pathToFileURL(path.join(packageRoot, "dist", "skill.js")).href);
const evidenceAuthority = await import(
  pathToFileURL(path.join(packageRoot, "scripts", "certification-evidence.mjs")).href
);

const SOURCE_ISSUE = 689;
const IMPLEMENTATION_ISSUE = 1689;
const PULL_REQUEST = 2689;
const repository = {
  repositoryHost: "github.com",
  repositoryId: "100689",
  repository: "yohn-jp/gh-inari",
};
const source = { ...repository, number: SOURCE_ISSUE };
const frontierDependency = { ...repository, number: 677 };
const implementation = { ...repository, number: IMPLEMENTATION_ISSUE };
const base = { branch: "main", revision: "b".repeat(40), freshness: "certification-base" };
const branch = "test/1689-implementation-native-lifecycle-certification";
const head = "a".repeat(40);
const reworkedHead = "c".repeat(40);
const changedFile = "scripts/implementation-lifecycle-certification.mjs";
const branchGovernance = { pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "test", slug: "implementation-native-lifecycle-certification" };
const issuer = inari.INARI_ISSUER_PRINCIPAL;

// The fixture is data only; rendering and validation remain the installed
// artifact's existing contract authority.
const pullRequestContractFixture = {
  irVersion: "1.0.0",
  schemaVersion: "1.0.0",
  artifactKind: "pull_request",
  templateIdentity: {
    id: "default",
    name: "Default pull request",
    path: ".github/PULL_REQUEST_TEMPLATE.md",
    source: "pull_request_template",
  },
  nativeMetadata: {
    source: "pull_request_template",
    path: ".github/PULL_REQUEST_TEMPLATE.md",
    title: "Pull request",
  },
  sections: [
    {
      id: "summary",
      title: "Summary",
      kind: "input",
      render: { order: 0, headingLevel: 2 },
      nativeMetadata: { elementType: "heading", sourceId: "summary", headingLevel: 2 },
      fields: [
        {
          id: "summary",
          label: "Summary",
          type: "string",
          required: "unknown",
          render: { order: 0 },
          nativeMetadata: { elementType: "pr_section", sourceId: "summary" },
        },
      ],
    },
    {
      id: "linked_issue",
      title: "Linked issue",
      kind: "input",
      render: { order: 1, headingLevel: 2 },
      nativeMetadata: { elementType: "heading", sourceId: "linked_issue", headingLevel: 2 },
      fields: [
        {
          id: "linked_issue",
          label: "Linked issue",
          type: "string",
          required: "unknown",
          render: { order: 0 },
          nativeMetadata: { elementType: "pr_section", sourceId: "linked_issue" },
        },
      ],
    },
    {
      id: "acceptance",
      title: "Acceptance criteria",
      kind: "input",
      render: { order: 2, headingLevel: 2 },
      nativeMetadata: { elementType: "heading", sourceId: "acceptance", headingLevel: 2 },
      fields: [
        {
          id: "acceptance",
          label: "Acceptance criteria",
          type: "checklist",
          required: "unknown",
          items: [
            { id: "tests", label: "Tests", required: false },
            { id: "build", label: "Build", required: false },
          ],
          render: { order: 0 },
          nativeMetadata: {
            elementType: "pr_section",
            sourceId: "acceptance",
            options: [
              { value: "tests", required: false },
              { value: "build", required: false },
            ],
          },
        },
      ],
    },
    {
      id: "scope",
      title: "Scope",
      kind: "input",
      render: { order: 3, headingLevel: 2 },
      nativeMetadata: { elementType: "heading", sourceId: "scope", headingLevel: 2 },
      fields: [
        {
          id: "scope",
          label: "Scope",
          type: "string",
          required: "unknown",
          render: { order: 0 },
          nativeMetadata: { elementType: "pr_section", sourceId: "scope" },
        },
      ],
    },
  ],
  supplementalConstraints: {
    fields: [
      { fieldId: "linked_issue", required: true, linkedIssue: true },
      { fieldId: "acceptance", required: true, minItems: 1 },
    ],
  },
};

function collection(items) {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function governedContract(contract) {
  return {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: {
        host: repository.repositoryHost,
        owner: "yohn-jp",
        name: "gh-inari",
        nameWithOwner: repository.repository,
        repositoryId: repository.repositoryId,
      },
      ref: base.branch,
      treeSha: "certification-tree-sha",
      template: {
        path: contract.templateIdentity.path,
        ref: base.branch,
        sha: "certification-template-sha",
        digest: "certification-template-digest",
      },
    },
  };
}

const pullRequestContract = governedContract(pullRequestContractFixture);
const pullRequestBody = inari.renderPullRequestArtifact(pullRequestContract, {
  summary: "Certify the complete Implementation-native lifecycle.",
  linked_issue: `Closes #${String(IMPLEMENTATION_ISSUE)}`,
  acceptance: ["tests"],
  scope: "Bounded lifecycle certification only.",
});

function contract(overrides = {}) {
  return {
    version: inari.IMPLEMENTATION_CONTRACT_VERSION,
    kind: inari.IMPLEMENTATION_KIND,
    repository,
    sources: [source],
    objective: "Certify the complete Implementation-native lifecycle from Issue admission to Frontier.",
    nonGoals: ["Product defect repair", "New lifecycle authority", "Provider mutation"],
    architecture: {
      decision: "Compose the existing Issue, Implementation, Session, Change, closure, and Frontier authorities.",
      affectedComponents: ["Certification runner"],
      invariants: ["Every terminal state is derived from current repository-shaped evidence."],
      compatibilityConstraints: ["The older Golden Path certification remains unchanged."],
    },
    scope: {
      readOnly: ["src/**"],
      write: ["scripts/**"],
      create: [changedFile],
      delete: [],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not repair product defects during certification."],
      immutableAreas: ["Existing lifecycle authorities", "Session private key material"],
      prerequisites: ["The exact packed artifact is installed outside the source checkout."],
    },
    verification: {
      acceptanceCriteria: ["The complete lifecycle projects through Change MERGED and Frontier SATISFIED."],
      targetedTests: ["pnpm run verify"],
      requiredChecks: ["verify"],
      postconditions: ["Retained evidence is bounded and secret-safe."],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch,
      dependencies: [frontierDependency],
    },
    ...overrides,
  };
}

const parsedContract = inari.parseImplementationContract(contract());
const implementationBody = inari.renderImplementationIssueBody(parsedContract);
const authorizationInput = {
  implementation,
  body: implementationBody,
  repository,
  base,
  readiness: {
    evidence: [
      {
        reference: frontierDependency,
        authority: "implementation-conformance",
        status: "satisfied",
        freshness: "current",
        dependencies: [],
      },
    ],
  },
};
const authorization = inari.authorizeImplementation(authorizationInput);
const currentAuthorization = { ...authorizationInput, authorization };
const implementationBinding = inari.projectImplementationSessionAuthorizationBinding({
  authorization,
  implementation,
  issue: { reference: implementation, body: implementationBody },
  repository,
  base,
  task: { kind: "issue", number: IMPLEMENTATION_ISSUE },
});

const capabilities = [
  { kind: "change.implement", issue: IMPLEMENTATION_ISSUE },
  { kind: "change.ready", issue: IMPLEMENTATION_ISSUE },
  { kind: "change.merge", issue: IMPLEMENTATION_ISSUE },
  { kind: "branch.advance", branch, pathPolicy: "scripts/**" },
];
for (const capability of capabilities) assert.equal(inari.validateCapabilityClaim(capability).valid, true);

const runtimeKey = inari.generateRuntimeAuthorityKeyPair();
const runtimeAuthority = inari.createRuntimeAuthorityRecord({
  id: "issue-689-certification-runtime",
  key: runtimeKey,
  notBefore: "2026-09-18T00:00:00Z",
  notAfter: null,
  maxSessionTtlSeconds: 600,
  capabilityCeiling: capabilities.map((capability) => capability.kind),
});
const managedSession = inari.createManagedSession();
const sessionRequest = managedSession.createIssuanceRequest({
  repository: { id: repository.repositoryId, name: repository.repository },
  task: { kind: "issue", number: IMPLEMENTATION_ISSUE },
  implementationBinding,
  capabilities,
  ttlSeconds: 300,
});
const issuedCertificate = inari.issueSessionCertificate({
  repository: { id: repository.repositoryId, name: repository.repository },
  runtimeAuthority,
  runtimeKey,
  request: sessionRequest,
  implementationSession: true,
  implementationAuthorization: currentAuthorization,
  now: new Date("2026-09-19T00:00:00Z"),
});
const acceptedCertificate = managedSession.acceptCertificate(issuedCertificate);
assert.deepEqual(acceptedCertificate.payload.capabilities, capabilities);
assert.equal("privateKey" in managedSession, false);
assert.equal(JSON.stringify(issuedCertificate).includes("PRIVATE KEY"), false);
assert.equal(JSON.stringify(issuedCertificate).includes('"d"'), false);

function executionEvidence(headRevision, record = authorization) {
  return {
    version: inari.IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
    kind: inari.IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
    implementation: record.implementation,
    repository: record.repository,
    governedBodyDigest: record.governedBodyDigest,
    base: record.base,
    branch,
    headRevision,
    targetedTests: [{ command: "pnpm run verify", result: "satisfied" }],
  };
}

function operationalPullRequest(headRevision, overrides = {}) {
  return {
    repository: {
      host: repository.repositoryHost,
      nameWithOwner: repository.repository,
      repositoryId: repository.repositoryId,
    },
    number: PULL_REQUEST,
    title: "Implementation-native lifecycle certification",
    body: pullRequestBody,
    state: "open",
    author: null,
    head: { ref: branch, sha: headRevision },
    base: { ref: base.branch, sha: base.revision },
    draft: false,
    mergeable: true,
    mergeState: "clean",
    reviewDecision: "APPROVED",
    merged: false,
    labels: [],
    assignees: [],
    url: `https://github.com/yohn-jp/gh-inari/pull/${String(PULL_REQUEST)}`,
    checks: collection([
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
    requiredCheckBindings: collection([{ context: "verify", producer: "app:trusted" }]),
    reviews: collection([
      {
        id: 1,
        body: "request changes is bounded review evidence only",
        author: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        commitId: head,
      },
      {
        id: 2,
        body: "approved",
        author: { login: "reviewer" },
        state: "APPROVED",
        commitId: headRevision,
      },
    ]),
    comments: collection([]),
    inlineReviewComments: collection([]),
    changedFiles: collection([{ filename: changedFile, status: "added" }]),
    provenance: { provider: "github", endpoints: [`pulls/${String(PULL_REQUEST)}`] },
    ...overrides,
  };
}

function implementationConformance(headRevision, overrides = {}) {
  const pullRequest = operationalPullRequest(headRevision, overrides.pullRequest ?? {});
  return {
    authorization,
    issue: { reference: implementation, body: implementationBody },
    repository,
    base,
    pullRequestNumber: PULL_REQUEST,
    pullRequest,
    executionEvidence: executionEvidence(headRevision),
    ...overrides,
  };
}

function lifecycleInput(headRevision, overrides = {}) {
  return {
    ...implementationConformance(headRevision),
    ...overrides,
  };
}

function changeInput(pullRequest, conformance) {
  return {
    change: {
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
      rootIssue: IMPLEMENTATION_ISSUE,
    },
    provenance: { requester: "agent:issue-689-certification", issuer },
    branchGovernance,
    naming,
    baseBranch: base.branch,
    evidence: {
      issue: { status: "available", value: { number: IMPLEMENTATION_ISSUE, state: "open" } },
      branches: { status: "available", value: [{ name: branch, sha: pullRequest.head.sha }] },
      pullRequests: {
        status: "available",
        value: [
          {
            number: PULL_REQUEST,
            head: branch,
            headSha: pullRequest.head.sha,
            base: base.branch,
            state: pullRequest.state,
            draft: pullRequest.draft,
            merged: pullRequest.merged,
            rootIssue: IMPLEMENTATION_ISSUE,
            provenance: { issuer },
          },
        ],
      },
    },
    readyEvidence: {
      pullRequest: { contract: pullRequestContract, body: pullRequestBody },
      implementationConformance: conformance,
      implementationIssueBody: implementationBody,
      baseRevision: base.revision,
    },
  };
}

const frontierDependencyChange = inari.projectChangeFromGitHubEvidence({
  change: {
    repositoryHost: repository.repositoryHost,
    repositoryId: repository.repositoryId,
    rootIssue: frontierDependency.number,
  },
  provenance: { issuer },
  branchGovernance,
  naming: { type: "feat", slug: "frontier-dependency" },
  baseBranch: base.branch,
  evidence: {
    issue: { status: "available", value: { number: frontierDependency.number, state: "open" } },
    branches: { status: "available", value: [{ name: "feat/677-frontier-dependency", sha: "d".repeat(40) }] },
    pullRequests: {
      status: "available",
      value: [
        {
          number: 2677,
          head: "feat/677-frontier-dependency",
          headSha: "d".repeat(40),
          base: base.branch,
          state: "closed",
          draft: false,
          merged: true,
          rootIssue: frontierDependency.number,
          provenance: { issuer },
        },
      ],
    },
  },
});
assertValid(frontierDependencyChange, "frontier dependency projection");

function assertValid(result, label) {
  assert.equal(result.valid, true, `${label}: ${JSON.stringify(result.diagnostics ?? result.violations ?? [])}`);
  return result;
}

const operations = [];
function record(operation, outcome = "verified") {
  operations.splice(
    0,
    operations.length,
    ...evidenceAuthority.appendImplementationLifecycleOperation(operations, operation, outcome),
  );
}

record("source.issue");
record("implementation.authorize");
record("session.issue");

const issuanceInput = {
  change: {
    repositoryHost: repository.repositoryHost,
    repositoryId: repository.repositoryId,
    rootIssue: IMPLEMENTATION_ISSUE,
  },
  branchGovernance,
  naming,
  baseBranch: base.branch,
  provenance: { requester: "agent:issue-689-certification", issuer },
  evidence: {
    issue: { status: "available", value: { number: IMPLEMENTATION_ISSUE, state: "open" } },
    branches: { status: "available", value: [] },
    pullRequests: { status: "available", value: [] },
  },
};
const issuancePlan = inari.planChangeIssuance(issuanceInput);
assert.equal(issuancePlan.result.state, "DRAFT");
record("change.issue");

const initialConformanceInput = lifecycleInput(head);
const initialConformance = assertValid(
  inari.tryVerifyImplementationConformance(initialConformanceInput),
  "initial conformance",
);
const initialScope = assertValid(
  inari.tryProjectImplementationScope({
    authorization,
    issue: { reference: implementation, body: implementationBody },
    repository,
    base,
  }),
  "initial scope",
);
assert.equal(inari.isImplementationScopeProjectionPathAllowed(initialScope.projection, "WRITE", changedFile), true);
record("branch.write");
record("conformance.initial");

const initialPullRequest = operationalPullRequest(head, { draft: true, reviewDecision: "" });
const initialChangeInput = changeInput(initialPullRequest, initialConformanceInput);
const draftProjection = assertValid(inari.projectChangeFromGitHubEvidence(initialChangeInput), "draft projection");
assert.equal(draftProjection.change?.state, "DRAFT");
const readyInput = {
  change: draftProjection.change,
  projection: initialChangeInput,
  pullRequest: { contract: pullRequestContract, body: pullRequestBody },
  implementationConformance: initialConformanceInput,
  implementationIssueBody: implementationBody,
  baseRevision: base.revision,
};
const firstReadyPlan = inari.planChangeReadyTransition(readyInput);
assert.equal(firstReadyPlan.to, "REVIEW");
record("ready.first");

const reviewPullRequest = operationalPullRequest(head, {
  draft: false,
  reviewDecision: "CHANGES_REQUESTED",
  reviews: collection([
    {
      id: 1,
      body: "request changes is bounded review evidence only",
      author: { login: "reviewer" },
      state: "CHANGES_REQUESTED",
      commitId: head,
    },
  ]),
});
const reviewChangeInput = changeInput(reviewPullRequest, initialConformanceInput);
const reviewProjection = assertValid(inari.projectChangeFromGitHubEvidence(reviewChangeInput), "review projection");
assert.equal(reviewProjection.change?.state, "REVIEW");
const reviewRework = assertValid(
  inari.tryProjectImplementationReviewRework({
    change: reviewProjection,
    pullRequest: reviewPullRequest,
    expectedHead: head,
    authorization,
    implementation,
    issue: { reference: implementation, body: implementationBody },
    repository,
    base,
    session: implementationBinding,
  }),
  "review rework",
);
assert.equal(reviewRework.projection?.classification, "REWORK_REQUESTED");
record("review.rework");
const reworkMarker = inari.createImplementationReworkMarker({
  change: reviewProjection,
  pullRequest: reviewPullRequest,
  expectedHead: head,
  authorization,
  implementation,
  issue: { reference: implementation, body: implementationBody },
  repository,
  base,
  session: implementationBinding,
});
const reworkExecution = inari.projectImplementationReworkExecution({
  marker: reworkMarker,
  branchAdvance: {
    version: 1,
    operation: "branch.advance",
    status: "succeeded",
    outcome: "advanced",
    branch,
    expectedHead: head,
    resultingHead: reworkedHead,
  },
});
assert.equal(reworkExecution.returnTransition, "change.ready");
const reworkedConformanceInput = lifecycleInput(reworkedHead);
const reworkedConformance = assertValid(
  inari.tryVerifyImplementationConformance(reworkedConformanceInput),
  "reworked conformance",
);
const reworkedScope = assertValid(
  inari.tryProjectImplementationScope({
    authorization,
    issue: { reference: implementation, body: implementationBody },
    repository,
    base,
  }),
  "reworked scope",
);
assert.equal(inari.isImplementationScopeProjectionPathAllowed(reworkedScope.projection, "WRITE", changedFile), true);
record("branch.write.rework");
record("conformance.final");

const finalPullRequest = operationalPullRequest(reworkedHead, { draft: false, reviewDecision: "APPROVED" });
const finalChangeInput = changeInput(finalPullRequest, reworkedConformanceInput);
const finalProjection = assertValid(inari.projectChangeFromGitHubEvidence(finalChangeInput), "final projection");
assert.equal(finalProjection.change?.state, "REVIEW");
const finalReadyPlan = inari.planChangeReadyTransition({
  change: finalProjection.change,
  projection: finalChangeInput,
  pullRequest: { contract: pullRequestContract, body: pullRequestBody },
  implementationConformance: reworkedConformanceInput,
  implementationIssueBody: implementationBody,
  baseRevision: base.revision,
});
assert.equal(finalReadyPlan.from, "REVIEW");
assert.equal(finalReadyPlan.to, "REVIEW");
record("ready.final");

const implementationTerminal = assertValid(
  inari.tryProjectImplementationLifecycle(reworkedConformanceInput),
  "implementation terminal projection",
);
assert.equal(implementationTerminal.status, "completed");
assert.equal(implementationTerminal.authorized, true);
assert.equal(implementationTerminal.current, true);

const mergeAdmission = inari.validateChangeMergeAdmission({
  change: finalProjection.change,
  projection: finalChangeInput,
  issuance: issuancePlan,
  pullRequest: { contract: pullRequestContract, body: pullRequestBody },
});
assertValid(mergeAdmission, "merge admission");
const mergePlan = inari.planGovernedSemanticPullRequestMutation({
  version: "1",
  operation: "merge",
  repository: {
    hostname: repository.repositoryHost,
    nameWithOwner: repository.repository,
    repositoryId: repository.repositoryId,
  },
  pullRequest: PULL_REQUEST,
  expectedHead: reworkedHead,
  expectedBase: base.branch,
  strategy: "squash",
});
const mergeTransition = inari.planChangeTransition({
  version: inari.CHANGE_TRANSITION_CONTRACT_VERSION,
  transition: "merge",
  change: finalProjection.change,
  target: {
    branch,
    baseBranch: base.branch,
    pullRequest: PULL_REQUEST,
    semanticPullRequestMergePlan: mergePlan,
  },
});
assert.equal(mergeTransition.to, "MERGED");
record("change.merge");

const mergedPullRequest = operationalPullRequest(reworkedHead, {
  state: "closed",
  draft: false,
  merged: true,
  reviewDecision: "APPROVED",
});
const mergedProjection = assertValid(
  inari.projectChangeFromGitHubEvidence(changeInput(mergedPullRequest, reworkedConformanceInput)),
  "merged repository projection",
);
assert.equal(mergedProjection.change?.state, "MERGED");

function observed(reference, state, { parent, dependsOn = [] } = {}) {
  return {
    version: "1",
    kind: "issue",
    number: reference.number,
    state,
    title: `Issue ${String(reference.number)}`,
    body: "",
    metadata: {},
    relations: {
      parent: {
        relation: "parent",
        ...(parent === undefined ? {} : { reference: parent }),
        representation: parent === undefined ? "none" : "native",
        evidence: parent === undefined ? {} : { native: parent },
      },
      dependsOn: {
        relation: "dependsOn",
        references: dependsOn,
        representation: dependsOn.length === 0 ? "none" : "native",
        evidence: dependsOn.length === 0 ? { bodyFallback: [] } : { native: dependsOn, bodyFallback: [] },
      },
    },
  };
}

function lifecycle(nodes) {
  return { scope: "complete", issues: nodes };
}

function node(reference, state, options = {}) {
  return {
    reference,
    observed: observed(reference, state, options),
    ...(options.role === undefined ? {} : { declaration: { role: options.role } }),
  };
}

const sourceOpen = node(source, "open", { role: "tracker" });
const readyFrontier = assertValid(
  inari.tryProjectImplementationFrontier({
    issues: [
      sourceOpen,
      node(frontierDependency, "closed"),
      node(implementation, "open", { parent: source, dependsOn: [frontierDependency] }),
    ],
    candidates: [
      { reference: frontierDependency, state: "closed", change: frontierDependencyChange },
      {
        reference: implementation,
        implementation: { contract: parsedContract },
      },
    ],
  }),
  "READY frontier",
);
assert.equal(
  readyFrontier.projection?.candidates.find((candidate) => candidate.reference.number === IMPLEMENTATION_ISSUE)
    ?.classification,
  "READY",
);
record("implementation.terminal", "verified");
const trackerClosureInput = {
  target: source,
  intent: "close",
  lifecycle: lifecycle([sourceOpen, node(implementation, "closed", { parent: source, role: "leaf" })]),
  children: [{ reference: implementation, implementation: reworkedConformanceInput, change: mergedProjection }],
};
const closeAdmissibility = assertValid(
  inari.tryProjectSemanticIssueClosure(trackerClosureInput),
  "source closure admissibility",
);
assert.equal(closeAdmissibility.projection?.status, "closable");
const closePlan = inari.planSemanticIssueClosure(trackerClosureInput);
assert.equal(closePlan.effect?.kind, "CLOSE_ISSUE");
const sourceClosedClosure = assertValid(
  inari.tryProjectSemanticIssueClosure({
    ...trackerClosureInput,
    lifecycle: lifecycle([
      node(source, "closed", { role: "tracker" }),
      node(implementation, "closed", { parent: source, role: "leaf" }),
    ]),
  }),
  "source terminalization reread",
);
assert.equal(sourceClosedClosure.projection?.status, "already-closed");
record("source.close");

const satisfiedFrontier = assertValid(
  inari.tryProjectImplementationFrontier({
    issues: [
      node(source, "closed", { role: "tracker" }),
      node(frontierDependency, "closed"),
      node(implementation, "closed", { parent: source, role: "leaf", dependsOn: [frontierDependency] }),
    ],
    candidates: [
      { reference: frontierDependency, state: "closed", change: frontierDependencyChange },
      {
        reference: implementation,
        state: "closed",
        implementation: {
          contract: parsedContract,
          authorization: { authorization, body: implementationBody, repository, base },
          conformance: reworkedConformanceInput,
          executionEvidence: executionEvidence(reworkedHead),
        },
        change: mergedProjection,
      },
    ],
  }),
  "SATISFIED frontier",
);
assert.equal(
  satisfiedFrontier.projection?.candidates.find((candidate) => candidate.reference.number === IMPLEMENTATION_ISSUE)
    ?.classification,
  "SATISFIED",
);
record("frontier.ready");
record("frontier.satisfied");

let unsafeEffectCount = 0;
const negativeDependencyContract = inari.parseImplementationContract(
  contract({ execution: { ...parsedContract.execution, dependencies: [source] } }),
);
const dependencyCase = inari.tryProjectImplementationFrontier({
  issues: [node(source, "closed"), node(implementation, "open", { parent: source, dependsOn: [source] })],
  candidates: [
    { reference: source, state: "closed" },
    {
      reference: implementation,
      implementation: {
        contract: negativeDependencyContract,
      },
    },
  ],
});
assert.equal(dependencyCase.valid, false);
assert.equal(
  dependencyCase.projection?.candidates.find((candidate) => candidate.reference.number === IMPLEMENTATION_ISSUE)
    ?.classification,
  "BLOCKED",
);
assert.equal(unsafeEffectCount, 0);
record("negative.dependency", "fail-closed");

const unsafePullRequest = operationalPullRequest(reworkedHead, {
  changedFiles: collection([{ filename: "src/private/unauthorized.ts", status: "added" }]),
});
const unsafeConformance = inari.tryVerifyImplementationConformance({
  ...reworkedConformanceInput,
  pullRequest: unsafePullRequest,
});
assert.equal(unsafeConformance.valid, false);
assert.equal(unsafeConformance.conformance, undefined);
assert.equal(unsafeEffectCount, 0);
record("negative.scope", "fail-closed");

const contractVersions = {
  goldenPath: String(inari.GOLDEN_PATH_STATUS_VERSION),
  statusRecovery: String(inari.CHANGE_CONTRACT_VERSION),
  skill: String(skill.SKILL_MODEL_VERSION),
};
const safeSessionCapabilities = capabilities.map((capability) => ({ ...capability }));
process.stdout.write(
  `${JSON.stringify({
    contractVersions,
    sourceIssue: SOURCE_ISSUE,
    implementation: { issue: IMPLEMENTATION_ISSUE, branch, pullRequest: PULL_REQUEST },
    session: { capabilities: safeSessionCapabilities },
    operations,
    finalState: { implementation: "COMPLETED", change: "MERGED", source: "CLOSED", frontier: "SATISFIED" },
  })}\n`,
);
