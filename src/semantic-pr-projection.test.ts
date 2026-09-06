import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import {
  GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES,
  planSemanticPullRequest,
  projectSemanticPullRequest,
  serializeSemanticPullRequestMutationPlan,
  deserializeSemanticPullRequestMutationPlan,
  tryProjectSemanticPullRequest,
  validateSemanticPullRequestMutationPlan,
  SemanticPullRequestProjectionError,
} from "./semantic-pr-projection.js";

const provenance: ArtifactContractProvenance = {
  authority: "repository-default-branch",
  repository: {
    host: "github.com",
    owner: "yohn-jp",
    name: "gh-inari",
    nameWithOwner: "yohn-jp/gh-inari",
    repositoryId: "1234",
  },
  ref: "main",
  treeSha: "tree-sha",
  source: {
    path: ".github/inari/canon/pull-request.json",
    ref: "main",
    sha: "blob-sha",
    digest: "source-digest",
  },
};

const contract = parseArtifactContract({
  version: "1",
  kind: "pull_request",
  id: "projection",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {slug}" } },
    },
    head: { presence: "required", authority: { kind: "derived", derive: { op: "format", template: "{type}/{slug}" } } },
    base: { presence: "required", authority: { kind: "fixed", value: "main" } },
    type: { presence: "required", authority: { kind: "supplied" }, constraints: { values: ["feat", "fix"] } },
    implements: { presence: "required", authority: { kind: "supplied" } },
  },
  fields: [
    {
      id: "summary",
      primitive: "text",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1 },
    },
    {
      id: "slug",
      primitive: "text",
      presence: "required",
      authority: { kind: "derived", derive: { op: "slug", from: "summary" } },
    },
  ],
});

function issue(number: number) {
  return {
    repositoryHost: "github.com",
    repositoryId: "1234",
    repository: "yohn-jp/gh-inari",
    number,
  };
}

function artifact(summary = "Project semantic PR") {
  return materializeSemanticArtifact(compileEffectiveArtifactContract(contract, { provenance }), {
    type: "feat",
    summary,
    implements: [issue(283)],
  });
}

const native = [GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.nativeImplementsRelation];
const recognized = [GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.recognizedClosingReference];
const fallback = [GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.bodyRelationFallback];

test("projects supplied and derived PR identity directly from the Semantic Artifact", () => {
  const result = projectSemanticPullRequest({ artifact: artifact(), capabilities: native });
  assert.equal(result.title, "feat: project-semantic-pr");
  assert.equal(result.head, "feat/project-semantic-pr");
  assert.equal(result.base, "main");
  assert.equal(result.relations.implements.representation, "native");
  assert.match(result.body, /## summary/);
  assert.match(result.body, /Project semantic PR/);
});

test("selects native, recognized convention, then body fallback in capability order", () => {
  const nativeProjection = projectSemanticPullRequest({
    artifact: artifact(),
    capabilities: [...recognized, ...native],
  });
  assert.equal(nativeProjection.relations.implements.representation, "native");
  assert.doesNotMatch(nativeProjection.body, /Closes #283/);

  const conventionProjection = projectSemanticPullRequest({ artifact: artifact(), capabilities: recognized });
  assert.equal(conventionProjection.relations.implements.representation, "recognized-convention");
  assert.match(conventionProjection.body, /Closes #283/);

  const fallbackProjection = projectSemanticPullRequest({ artifact: artifact(), capabilities: fallback });
  assert.equal(fallbackProjection.relations.implements.representation, "body-fallback");
  assert.match(fallbackProjection.body, /inari:semantic-relation/);
});

test("projection has no title/head/base override path", () => {
  const overridden = { ...artifact(), title: "caller override" };
  assert.throws(
    () => projectSemanticPullRequest({ artifact: overridden, capabilities: native }),
    (error: unknown) =>
      error instanceof SemanticPullRequestProjectionError && error.violations[0]?.code === "SEMANTIC_ARTIFACT_INVALID",
  );
  assert.throws(
    () => projectSemanticPullRequest({ artifact: artifact(), capabilities: native, title: "caller override" }),
    (error: unknown) =>
      error instanceof SemanticPullRequestProjectionError &&
      error.violations[0]?.code === "PROJECTION_INPUT_UNKNOWN_PROPERTY",
  );
});

test("plans retain immutable provenance, desired state, preconditions, and effects", () => {
  const first = planSemanticPullRequest({ artifact: artifact(), capabilities: recognized });
  const second = planSemanticPullRequest({ artifact: artifact(), capabilities: recognized });
  assert.equal(serializeSemanticPullRequestMutationPlan(first), serializeSemanticPullRequestMutationPlan(second));
  assert.equal(first.version, "1");
  assert.deepEqual(first.generation, first.provenance);
  assert.deepEqual(first.preconditions[0], { kind: "GOVERNANCE_GENERATION_MATCH", generation: first.generation });
  assert.equal(first.effects[0]?.kind, "CREATE_PULL_REQUEST");
  assert.deepEqual(first.effects[0]?.desired, first.desired);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.generation), true);
  assert.equal(Object.isFrozen(first.desired), true);
});

test("fails closed for missing relation capability and incompatible artifacts", () => {
  const noCapability = tryProjectSemanticPullRequest({ artifact: artifact(), capabilities: [] });
  assert.equal(noCapability.valid, false);
  assert.equal(noCapability.violations[0]?.code, "RELATION_UNREPRESENTABLE");

  const malformed = structuredClone(artifact()) as unknown as Record<string, unknown>;
  malformed.kind = "issue";
  const result = tryProjectSemanticPullRequest({ artifact: malformed, capabilities: native });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === "SEMANTIC_ARTIFACT_INCOMPATIBLE"));
});

function validPlan(): Record<string, unknown> {
  const plan = planSemanticPullRequest({ artifact: artifact(), capabilities: recognized });
  return JSON.parse(serializeSemanticPullRequestMutationPlan(plan)) as Record<string, unknown>;
}

function expectInvalid(tampered: unknown): void {
  const result = validateSemanticPullRequestMutationPlan(tampered);
  assert.equal(result.valid, false);
  assert.ok(result.violations.length > 0);
}

test("mutation plan validation is a closed-world nested binding boundary", () => {
  assert.equal(validateSemanticPullRequestMutationPlan(validPlan()).valid, true);

  const roundTripped = deserializeSemanticPullRequestMutationPlan(
    serializeSemanticPullRequestMutationPlan(
      planSemanticPullRequest({ artifact: artifact(), capabilities: recognized }),
    ),
  );
  assert.deepEqual(roundTripped, planSemanticPullRequest({ artifact: artifact(), capabilities: recognized }));

  // artifact digest tampering
  {
    const plan = validPlan();
    (plan.artifact as Record<string, unknown>).digest = "not-a-sha256-digest";
    expectInvalid(plan);
  }

  // artifact identity unknown property
  {
    const plan = validPlan();
    (plan.artifact as Record<string, unknown>).extra = "tampered";
    expectInvalid(plan);
  }

  // desired title tampering breaks binding with effects[0].desired
  {
    const plan = validPlan();
    (plan.desired as Record<string, unknown>).title = "tampered title";
    expectInvalid(plan);
  }

  // desired head tampering breaks binding with target-absence precondition
  {
    const plan = validPlan();
    (plan.desired as Record<string, unknown>).head = "tampered-head";
    expectInvalid(plan);
  }

  // desired base tampering breaks binding with target-absence precondition
  {
    const plan = validPlan();
    (plan.desired as Record<string, unknown>).base = "tampered-base";
    expectInvalid(plan);
  }

  // desired nested unknown property
  {
    const plan = validPlan();
    (plan.desired as Record<string, unknown>).metadata = {
      ...((plan.desired as Record<string, unknown>).metadata as Record<string, unknown>),
      extra: "tampered",
    };
    expectInvalid(plan);
  }

  // effect kind tampering
  {
    const plan = validPlan();
    const effects = plan.effects as Record<string, unknown>[];
    effects[0] = { ...effects[0], kind: "DELETE_PULL_REQUEST" };
    expectInvalid(plan);
  }

  // effect desired tampering diverges from top-level desired
  {
    const plan = validPlan();
    const effects = plan.effects as Record<string, unknown>[];
    effects[0] = {
      ...effects[0],
      desired: { ...(effects[0].desired as Record<string, unknown>), title: "effect-only title" },
    };
    expectInvalid(plan);
  }

  // governance precondition generation tampering
  {
    const plan = validPlan();
    const preconditions = plan.preconditions as Record<string, unknown>[];
    const governanceIndex = preconditions.findIndex((entry) => entry.kind === "GOVERNANCE_GENERATION_MATCH");
    preconditions[governanceIndex] = {
      ...preconditions[governanceIndex],
      generation: { ...(preconditions[governanceIndex].generation as Record<string, unknown>), ref: "tampered-ref" },
    };
    expectInvalid(plan);
  }

  // target-absence precondition head tampering
  {
    const plan = validPlan();
    const preconditions = plan.preconditions as Record<string, unknown>[];
    const targetIndex = preconditions.findIndex((entry) => entry.kind === "PULL_REQUEST_TARGET_ABSENT");
    preconditions[targetIndex] = { ...preconditions[targetIndex], head: "tampered-head" };
    expectInvalid(plan);
  }

  // target-absence precondition base tampering
  {
    const plan = validPlan();
    const preconditions = plan.preconditions as Record<string, unknown>[];
    const targetIndex = preconditions.findIndex((entry) => entry.kind === "PULL_REQUEST_TARGET_ABSENT");
    preconditions[targetIndex] = { ...preconditions[targetIndex], base: "tampered-base" };
    expectInvalid(plan);
  }

  // missing required precondition
  {
    const plan = validPlan();
    plan.preconditions = (plan.preconditions as Record<string, unknown>[]).filter(
      (entry) => entry.kind !== "PULL_REQUEST_TARGET_ABSENT",
    );
    expectInvalid(plan);
  }

  // duplicate precondition
  {
    const plan = validPlan();
    const preconditions = plan.preconditions as Record<string, unknown>[];
    plan.preconditions = [...preconditions, preconditions[0]];
    expectInvalid(plan);
  }

  // unknown precondition kind
  {
    const plan = validPlan();
    const preconditions = plan.preconditions as Record<string, unknown>[];
    plan.preconditions = [...preconditions, { kind: "UNKNOWN_PRECONDITION" }];
    expectInvalid(plan);
  }
});
