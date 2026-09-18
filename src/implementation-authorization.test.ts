import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_KIND,
  IMPLEMENTATION_CONTRACT_VERSION,
  renderImplementationIssueBody,
  parseImplementationContract,
} from "./implementation-contract.js";
import {
  authorizeImplementation,
  implementationIssueBodyDigest,
  inspectImplementationLifecycle,
  serializeImplementationAuthorization,
  tryAuthorizeImplementation,
  tryVerifyImplementationAuthorization,
  validateImplementationSupersession,
  deserializeImplementationAuthorization,
} from "./implementation-authorization.js";
import { tryAdmitImplementationReadiness } from "./implementation-readiness.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "415000001",
  repository: "yohn-jp/gh-inari",
} as const;
const implementation = { ...repository, number: 572 } as const;
const source = { ...repository, number: 568 } as const;
const base = { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" } as const;

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [source],
    objective: "Authorize one Implementation session.",
    nonGoals: ["Automatic re-authorization"],
    architecture: {
      decision: "Keep authorization as a Core evidence boundary.",
      affectedComponents: ["Implementation Core"],
      invariants: ["The governed body is immutable after authorization."],
      compatibilityConstraints: [],
    },
    scope: {
      readOnly: ["src/**"],
      write: ["src/implementation-authorization.ts"],
      create: ["src/implementation-authorization.test.ts"],
      delete: [],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not authorize Issue metadata."],
      immutableAreas: ["The authorization record"],
      prerequisites: ["The canonical contract is valid."],
    },
    verification: {
      acceptanceCriteria: ["Body drift invalidates authorization."],
      targetedTests: ["pnpm test"],
      requiredChecks: ["pnpm run verify"],
      postconditions: ["Only the exact authorized body remains current."],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch: "feat/572-implementation-authorization",
      dependencies: [source],
    },
    ...overrides,
  };
}

const body = renderImplementationIssueBody(parseImplementationContract(contract()));

function authorizationInput(bodyValue = body): Record<string, unknown> {
  return {
    implementation,
    body: bodyValue,
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
    authorizedAt: "2026-09-16T00:00:00.000Z",
  };
}

function readinessEvidence(
  reference: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    reference,
    authority: "implementation-conformance",
    status: "satisfied",
    freshness: "current",
    dependencies: [],
    ...overrides,
  };
}

test("canonical governed body digest ignores formatting and Issue metadata", () => {
  const equivalent = `<!-- title changed; labels changed; comments remain outside the contract -->\n${body.replaceAll("\n", "\r\n")}`;
  assert.equal(implementationIssueBodyDigest(body), implementationIssueBodyDigest(equivalent));
  assert.notEqual(
    implementationIssueBodyDigest(body),
    implementationIssueBodyDigest(
      renderImplementationIssueBody(parseImplementationContract(contract({ objective: "Changed objective." }))),
    ),
  );
});

test("explicit authorization creates immutable repository/base-bound evidence", () => {
  const record = authorizeImplementation(authorizationInput());
  assert.equal(record.governedBodyDigest, implementationIssueBodyDigest(body));
  assert.equal(record.contractVersion, IMPLEMENTATION_CONTRACT_VERSION);
  assert.deepEqual(record.repository, repository);
  assert.deepEqual(record.base, base);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.repository), true);
  assert.equal(Object.isFrozen(record.base), true);
});

test("invalid bodies and stale base evidence fail closed", () => {
  const invalid = tryAuthorizeImplementation({ ...authorizationInput(), body: "not an Implementation body" });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.status, "draft");
  assert.ok(invalid.violations.some((violation) => violation.code === "IMPLEMENTATION_AUTHORIZATION_BODY_INVALID"));

  const stale = tryAuthorizeImplementation({ ...authorizationInput(), base: { ...base, revision: "b".repeat(40) } });
  assert.equal(stale.valid, false);
  assert.ok(
    stale.violations.some((violation) => violation.code === "IMPLEMENTATION_AUTHORIZATION_BASE_REVISION_MISMATCH"),
  );
});

test("replay is idempotent and never re-authorizes body drift", () => {
  const record = authorizeImplementation(authorizationInput());
  const replay = tryAuthorizeImplementation({ ...authorizationInput(), existingAuthorization: record });
  assert.equal(replay.valid, true);
  assert.equal(replay.status, "authorized");
  assert.equal(
    serializeImplementationAuthorization(replay.authorization),
    serializeImplementationAuthorization(record),
  );

  const changedBody = renderImplementationIssueBody(
    parseImplementationContract(contract({ objective: "A materially different objective." })),
  );
  const drift = tryAuthorizeImplementation({ ...authorizationInput(changedBody), existingAuthorization: record });
  assert.equal(drift.valid, false);
  assert.equal(drift.status, "invalidated");
  assert.ok(drift.violations.some((violation) => violation.code === "IMPLEMENTATION_MODIFIED_AFTER_AUTHORIZATION"));
  assert.equal(serializeImplementationAuthorization(drift.authorization), serializeImplementationAuthorization(record));
});

test("metadata-only changes remain current while body changes invalidate", () => {
  const record = authorizeImplementation(authorizationInput());
  const current = tryVerifyImplementationAuthorization({
    authorization: record,
    issue: {
      reference: implementation,
      body,
      title: "renamed title",
      labels: ["changed"],
      assignees: ["different"],
      comments: [{ body: "discussion changed" }],
    },
    repository,
    base,
  });
  assert.equal(current.valid, true);
  assert.equal(current.authorized, true);
  assert.equal(current.status, "authorized");
});

test("lifecycle distinguishes draft, ready, authorized, superseded, and completed", () => {
  const draft = inspectImplementationLifecycle({ body: "invalid" });
  assert.equal(draft.status, "draft");

  const ready = inspectImplementationLifecycle({ body, implementation, repository, base });
  assert.equal(ready.status, "ready");

  const record = authorizeImplementation(authorizationInput());
  const superseded = tryVerifyImplementationAuthorization({
    authorization: record,
    body,
    implementation,
    repository,
    base,
    supersession: { supersededBy: [{ ...repository, number: 600 }] },
  });
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.authorized, false);

  const completed = tryVerifyImplementationAuthorization({
    authorization: record,
    body,
    implementation,
    repository,
    base,
    completed: true,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.authorized, true);
});

test("supersession requires an explicit replacement relationship", () => {
  const result = validateImplementationSupersession({
    replacement: { ...repository, number: 600 },
    supersession: { supersedes: [implementation] },
  });
  assert.equal(result.valid, true);
  assert.equal(result.supersession?.supersedes?.[0]?.number, implementation.number);

  const record = authorizeImplementation(authorizationInput());
  const serialized = serializeImplementationAuthorization(record);
  assert.deepEqual(deserializeImplementationAuthorization(serialized), record);
});

test("readiness admits satisfied dependencies and surfaces prose prerequisites as unverified", () => {
  const result = tryAdmitImplementationReadiness({
    contract: parseImplementationContract(contract()),
    implementation,
    evidence: [readinessEvidence(source)],
  });
  assert.equal(result.valid, true);
  assert.equal(result.admitted, true);
  assert.equal(result.classification, "READY");
  assert.deepEqual(result.unverifiedPrerequisites, ["The canonical contract is valid."]);
});

test("authorization rejects a blocked dependency at the Core boundary", () => {
  const result = tryAuthorizeImplementation({
    ...authorizationInput(),
    readiness: { evidence: [readinessEvidence(source, { status: "blocked" })] },
  });
  assert.equal(result.valid, false);
  assert.equal(result.readiness?.classification, "BLOCKED");
  assert.equal(result.violations[0]?.code, "IMPLEMENTATION_AUTHORIZATION_NOT_READY");
});

test("missing and stale dependency evidence fail closed", () => {
  const missing = tryAdmitImplementationReadiness({
    contract: parseImplementationContract(contract()),
    implementation,
    evidence: [],
  });
  assert.equal(missing.classification, "INVALID");
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "READINESS_DEPENDENCY_EVIDENCE_MISSING"));

  const stale = tryAdmitImplementationReadiness({
    contract: parseImplementationContract(contract()),
    implementation,
    evidence: [readinessEvidence(source, { freshness: "stale" })],
  });
  assert.equal(stale.classification, "INVALID");
  assert.ok(stale.diagnostics.some((diagnostic) => diagnostic.code === "READINESS_DEPENDENCY_STALE"));
});

test("cycles and self-dependencies cannot be admitted", () => {
  const other = { ...repository, number: 569 };
  const cycleContract = parseImplementationContract(
    contract({
      execution: {
        baseBranch: base.branch,
        baseRevision: base.revision,
        baseFreshness: base.freshness,
        branch: "feat/572",
        dependencies: [source],
      },
    }),
  );
  const cycle = tryAdmitImplementationReadiness({
    contract: cycleContract,
    implementation,
    evidence: [
      readinessEvidence(source, { dependencies: [other] }),
      readinessEvidence(other, { dependencies: [source] }),
    ],
  });
  assert.equal(cycle.classification, "INVALID");
  assert.ok(cycle.diagnostics.some((diagnostic) => diagnostic.code === "READINESS_DEPENDENCY_CYCLE"));

  const self = tryAdmitImplementationReadiness({
    contract: parseImplementationContract(
      contract({
        execution: {
          baseBranch: base.branch,
          baseRevision: base.revision,
          baseFreshness: base.freshness,
          branch: "feat/572",
          dependencies: [implementation],
        },
      }),
    ),
    implementation,
    evidence: [],
  });
  assert.equal(self.classification, "INVALID");
  assert.ok(self.diagnostics.some((diagnostic) => diagnostic.code === "READINESS_SELF_DEPENDENCY"));
});

test("superseded dependency evidence rejects authorization and replay preserves the record", () => {
  const record = authorizeImplementation(authorizationInput());
  const replay = tryAuthorizeImplementation({
    ...authorizationInput(),
    existingAuthorization: record,
    readiness: {
      evidence: [readinessEvidence(source, { supersededBy: [{ ...repository, number: 600 }] })],
    },
  });
  assert.equal(replay.valid, false);
  assert.equal(replay.status, "invalidated");
  assert.equal(replay.readiness?.classification, "INVALID");
  assert.deepEqual(replay.authorization, record);
  assert.ok(replay.readiness?.diagnostics.some((diagnostic) => diagnostic.code === "READINESS_DEPENDENCY_SUPERSEDED"));
});
