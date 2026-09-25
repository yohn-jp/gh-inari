// Repository branch policy certification (#1113).
//
// Proves that an alternative repository branch convention on a non-`main`
// default branch composes through the actual local Session -> Admission ->
// Executor path and the branch/PR capability primitives, and that a wrong
// repository, Implementation, branch, or stale policy generation fails before
// any provider mutation. The only fakes are provider transports: every
// Session, Admission, Change projection, branch-advance, Git data, and PR
// publication authority is the production module. Run with `--import tsx`
// (as `pnpm test` does) so every module shares one instance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDelegatorRecord } from "../src/agent-authority/delegator-operations.ts";
import { generateDelegatorKeyPair } from "../src/agent-authority/delegator-key.ts";
import { createRepositoryBranchPolicy } from "../src/repository-branch-policy.ts";
import { observeLocalBranch } from "../src/cli/runtime/branch-observation.ts";
import { createLocalSessionBinding } from "../src/local-control/session-binding.ts";
import { validateExecutionIntent } from "../src/local-control/execution-intent.ts";
import { admitSession, authorizeExecutionIntent } from "../src/admission/authorization.ts";
import { executeAuthorizedExecution } from "../src/authorized-execution.ts";
import { executeBranchAdvanceEffects } from "../src/agent-authority/branch-advance.ts";
import { GitHubBranchAdvanceCapabilityImpl } from "../src/github/git-data-capability.ts";
import { GitHubChangeStateProjector } from "../src/github/change-state-projector.ts";
import { projectChangeFromGitHubEvidence } from "../src/change.ts";
import { changeReadRequest } from "../src/change-execution-port.ts";
import { publishPullRequest } from "../src/pr-publication.ts";
import { renderImplementationIssueBody } from "../src/implementation-contract.ts";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const REPOSITORY_ID = "469113001";
const OWNER = "acme";
const NAME = "inari";
const NAME_WITH_OWNER = `${OWNER}/${NAME}`;
const REPOSITORY = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, repository: NAME_WITH_OWNER };
const IDENTITY = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, nameWithOwner: NAME_WITH_OWNER };
const IMPLEMENTATION = 42;
// An alternative repository convention: not gh-inari's <feat|fix|...>/<issue>-<slug>.
const ALTERNATIVE_BRANCH = "story/42-alternative-policy";
const ALTERNATIVE_PATTERN = "^story/[0-9]+-[a-z0-9-]+$";
// The branch/policy under certification; each test selects one scenario (tests in a file run serially).
const scenario = { branch: ALTERNATIVE_BRANCH, pattern: ALTERNATIVE_PATTERN };
const DEFAULT_BRANCH = "trunk";
const policySource = () => `version: 1\nsections: []\nbranch:\n  pattern: ${JSON.stringify(scenario.pattern)}\n`;
const GENERATION = { ref: DEFAULT_BRANCH, treeSha: "e".repeat(40) };
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const HEAD_TREE = "c".repeat(40);
const NEW_TREE = "d".repeat(40);
const NEW_COMMIT = "f".repeat(40);
const CONTENT = Buffer.from("export const policy = true;\n", "utf8").toString("base64");
const SCOPE = Object.freeze({
  app: { kind: "github-app", slug: "inari-issuer", appId: "1113", principal: "app:inari-issuer" },
  installation: { appId: "1113", installationId: "1113001", repositoryHost: "github.com" },
  repository: IDENTITY,
  repositorySelection: "selected",
  permissions: { contents: "write", metadata: "read", pull_requests: "write" },
  expiresAt: "2099-01-01T00:00:00.000Z",
});
const APP = { ...SCOPE.app, installationId: SCOPE.installation.installationId };

function gitBlobSha(base64) {
  const bytes = Buffer.from(base64, "base64");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]))
    .digest("hex");
}

function implementationBody({ branch = scenario.branch, repositoryId = REPOSITORY_ID } = {}) {
  const repository = { ...REPOSITORY, repositoryId };
  return renderImplementationIssueBody({
    version: 1,
    kind: "implementation",
    repository,
    sources: [{ ...repository, number: IMPLEMENTATION }],
    objective: "Certify repository-governed branch naming end to end.",
    nonGoals: ["Deriving branch names from a product-wide convention."],
    architecture: {
      decision: "Repository branch policy is the only ordinary naming authority.",
      affectedComponents: ["Change", "branch advance", "PR publication"],
      invariants: ["Admitted branch equals mutated branch."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: ["src/**"], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Alternative naming executes."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: DEFAULT_BRANCH,
      baseRevision: BASE_SHA,
      baseFreshness: BASE_SHA,
      branch,
      dependencies: [],
    },
  });
}

/** One in-memory provider: reads for Evidence/Admission, and recorded mutations. */
function createProvider(options = {}) {
  const state = {
    body: options.body ?? implementationBody(),
    policyDefault: options.policyDefault ?? DEFAULT_BRANCH,
    branchSha: HEAD_SHA,
    pulls: [],
    mutations: [],
    commits: new Map([
      [HEAD_SHA, HEAD_TREE],
      [NEW_COMMIT, NEW_TREE],
    ]),
  };
  const base = `repos/${NAME_WITH_OWNER}`;
  const branchRef = () => ({ ref: `refs/heads/${scenario.branch}`, object: { type: "commit", sha: state.branchSha } });
  const readTransport = {
    request: async (request) => {
      if (request.method !== "GET") throw new Error("Evidence reads cannot mutate.");
      const target = request.path;
      if (target === base) return { status: 200, body: { id: Number(REPOSITORY_ID), default_branch: DEFAULT_BRANCH } };
      if (target === `${base}/issues/${IMPLEMENTATION}`)
        return {
          status: 200,
          body: { number: IMPLEMENTATION, title: "impl: certify alternative policy", state: "open", body: state.body },
        };
      if (target === `${base}/git/ref/heads/${encodeURIComponent(scenario.branch)}`)
        return { status: 200, body: branchRef() };
      if (target.startsWith(`${base}/git/ref/heads/`)) return { status: 404, body: {} };
      if (target === `${base}/git/matching-refs/heads/`) return { status: 200, body: [branchRef()] };
      if (target.startsWith(`${base}/pulls?state=all&head=`)) {
        const head = decodeURIComponent(new URL(`https://x/${target}`).searchParams.get("head") ?? "").split(":")[1];
        return {
          status: 200,
          body: state.pulls
            .filter((pull) => pull.head === head)
            .map((pull) => ({
              number: pull.number,
              state: "open",
              draft: true,
              head: { ref: pull.head, sha: state.branchSha, repo: { full_name: NAME_WITH_OWNER } },
              base: { ref: pull.base },
              user: { login: "inari-issuer[bot]" },
            })),
        };
      }
      throw new Error(`unexpected provider read: ${target}`);
    },
  };
  const governance = {
    resolveRepositoryContext: async () => ({
      hostname: "github.com",
      host: "github.com",
      owner: OWNER,
      name: NAME,
      nameWithOwner: NAME_WITH_OWNER,
      url: `https://github.com/${NAME_WITH_OWNER}`,
      repositoryId: REPOSITORY_ID,
    }),
    getRepositoryDefaultBranch: async () => state.policyDefault,
    getRepositoryTree: async () => ({
      sha: GENERATION.treeSha,
      entries: [{ path: ".github/inari/pr-policy.yml", type: "blob", sha: "9".repeat(40) }],
    }),
    getRepositoryBlob: async () => policySource(),
  };
  const gitTransport = {
    request: async (request) => {
      const target = request.path.slice(base.length + 1);
      if (request.method === "GET" && target.startsWith("git/ref/heads/"))
        return decodeURIComponent(target.slice("git/ref/heads/".length)) === scenario.branch
          ? { status: 200, body: branchRef() }
          : { status: 404, body: {} };
      if (request.method === "GET" && target.startsWith("git/commits/")) {
        const sha = target.slice("git/commits/".length);
        return { status: 200, body: { sha, tree: { sha: state.commits.get(sha) } } };
      }
      if (request.method === "GET" && target.startsWith("git/trees/")) {
        const sha = decodeURIComponent(target.slice("git/trees/".length).split("?")[0]);
        return {
          status: 200,
          body: {
            sha,
            truncated: false,
            tree: [{ path: "src/existing.ts", mode: "100644", type: "blob", sha: "1".repeat(40) }],
          },
        };
      }
      state.mutations.push(`${request.method} ${target}`);
      if (target === "git/blobs") return { status: 201, body: { sha: gitBlobSha(request.body.content) } };
      if (target === "git/trees") return { status: 201, body: { sha: NEW_TREE } };
      if (target === "git/commits") return { status: 201, body: { sha: NEW_COMMIT } };
      throw new Error(`unexpected provider Git request: ${request.method} ${target}`);
    },
    requestGraphql: async (request) => {
      const update = request.variables.input.refUpdates[0];
      state.mutations.push(`updateRefs ${update.name}`);
      if (update.name === `refs/heads/${scenario.branch}` && update.beforeOid === state.branchSha)
        state.branchSha = update.afterOid;
      return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
    },
  };
  const broker = {
    withBranchAdvanceCapability: async (request, operation) => {
      assert.equal(request.target.repositoryId, REPOSITORY_ID);
      return operation(
        new GitHubBranchAdvanceCapabilityImpl({
          repository: { hostname: "github.com", owner: OWNER, name: NAME },
          repositoryId: REPOSITORY_ID,
          repositoryNodeId: "R_kgDO1113",
          scope: SCOPE,
          transport: gitTransport,
        }),
      );
    },
  };
  const pullRequests = {
    getRepositoryIdentity: async () => REPOSITORY,
    listPullRequests: async () =>
      state.pulls.map((pull) => ({ ...pull, repository: REPOSITORY, headRevision: pull.headRevision })),
    readPullRequest: async (number) => {
      const found = state.pulls.find((pull) => pull.number === number);
      if (found === undefined) throw new Error("not found");
      return { ...found, repository: REPOSITORY };
    },
    createPullRequest: async (input) => {
      state.mutations.push(`createPullRequest ${input.head} -> ${input.base}`);
      const created = {
        number: 1113,
        url: `https://github.com/${NAME_WITH_OWNER}/pull/1113`,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        headRevision: input.headRevision,
        draft: input.draft,
      };
      state.pulls.push(created);
      return { ...created, repository: REPOSITORY };
    },
  };
  return { state, readTransport, governance, broker, pullRequests };
}

/** The Executor's evidence composition: shared GitHubChangeStateProjector + Core Change projection. */
async function executorEvidence(provider, request, runtimeAuthority) {
  const trust = {
    repository: IDENTITY,
    authority: { ref: `refs/heads/${DEFAULT_BRANCH}`, sha: BASE_SHA },
    runtimeAuthority,
  };
  if (request.issue === undefined) return trust;
  const projector = new GitHubChangeStateProjector({
    repository: { hostname: "github.com", owner: OWNER, name: NAME },
    identity: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, rootIssue: request.issue },
    transport: provider.readTransport,
    remoteGovernance: provider.governance,
  });
  const change = projectChangeFromGitHubEvidence(await projector.read(changeReadRequest(request.issue)));
  const reference = { ...REPOSITORY, number: IMPLEMENTATION };
  return {
    ...trust,
    change,
    implementation: {
      implementation: reference,
      issue: { reference, body: provider.state.body },
      repository: REPOSITORY,
      base: { branch: DEFAULT_BRANCH, revision: BASE_SHA, freshness: BASE_SHA },
      readiness: { evidence: [] },
      change,
    },
  };
}

/** The Executor's delegate composition with provider transports as the only fakes. */
function executorDelegates(provider) {
  return {
    branchAdvance: ({ request, branchAuthorization, provenance }) =>
      executeBranchAdvanceEffects({
        repository: IDENTITY,
        provenance,
        broker: provider.broker,
        request,
        authorization: branchAuthorization,
      }),
    publishPullRequest: async ({ request }) => ({
      publication: await publishPullRequest(request, provider.pullRequests),
      app: APP,
    }),
  };
}

function policy(generation = GENERATION) {
  const acquisition = createRepositoryBranchPolicy({
    generation: {
      authority: "repository-default-branch",
      repository: {
        host: "github.com",
        repositoryId: REPOSITORY_ID,
        owner: OWNER,
        name: NAME,
        nameWithOwner: NAME_WITH_OWNER,
      },
      ...generation,
    },
    rule: { pattern: scenario.pattern },
  });
  assert.equal(acquisition.status, "available");
  return acquisition.policy;
}

function observation({
  generation = GENERATION,
  observedGeneration = GENERATION,
  observedBranch = scenario.branch,
} = {}) {
  const repository = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID };
  return {
    policy: policy(generation),
    target: { repository, implementation: IMPLEMENTATION },
    observedGeneration,
    observedBranch,
    binding: { repository, implementation: IMPLEMENTATION, branch: scenario.branch },
  };
}

function authorityFixture() {
  const keyPair = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id: "runtime-branch-policy-certification",
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "branch.advance", "pullRequest.create"],
  });
  return { keyPair, authority };
}

function session(fixture, sessionId, branchObservation = observeLocalBranch(observation())) {
  return createLocalSessionBinding({
    sessionId,
    repository: { id: REPOSITORY_ID, name: NAME_WITH_OWNER },
    task: { kind: "issue", number: IMPLEMENTATION },
    capabilities: [
      { kind: "branch.advance", branch: scenario.branch },
      { kind: "pullRequest.create", head: scenario.branch, base: DEFAULT_BRANCH, max: 1 },
    ],
    ttlSeconds: 600,
    runtimeAuthority: fixture.authority,
    runtimeKey: fixture.keyPair,
    now: NOW,
    branchObservation,
  });
}

function intent(requestId, operation, request, repositoryId = REPOSITORY_ID) {
  const result = validateExecutionIntent({
    version: 1,
    requestId,
    repository: { repositoryHost: "github.com", repositoryId, repositoryNameWithOwner: NAME_WITH_OWNER },
    operation,
    request,
  });
  assert.ok(result.valid && result.intent !== undefined, `${requestId}: ${JSON.stringify(result.diagnostics)}`);
  return result.intent;
}

function publishIntent(requestId, overrides = {}) {
  const head = overrides.head ?? scenario.branch;
  const implementation = { ...REPOSITORY, number: overrides.implementation ?? IMPLEMENTATION };
  return intent(
    requestId,
    "pullRequest.publish",
    {
      version: 1,
      kind: "pr-publication",
      repository: REPOSITORY,
      workIdentity: { implementation },
      routing: {
        version: 1,
        kind: "integration-routing",
        mode: "standalone",
        role: "implementation",
        implementation,
        branches: { default: DEFAULT_BRANCH, implementation: head },
      },
      expectedHead: head,
      expectedBase: DEFAULT_BRANCH,
      headRevision: HEAD_SHA,
      title: "Certify repository branch policy",
      body: `Closes #${implementation.number}`,
      draft: true,
    },
    overrides.repositoryId,
  );
}

function advanceIntent(requestId, overrides = {}) {
  return intent(
    requestId,
    "branch.advance",
    {
      version: 1,
      issue: overrides.issue ?? IMPLEMENTATION,
      branch: overrides.branch ?? scenario.branch,
      expectedHead: HEAD_SHA,
      changes: [{ operation: "upsert", path: "src/policy.ts", mode: "100644", content: CONTENT }],
      commit: { message: "Advance the repository-governed branch" },
    },
    overrides.repositoryId,
  );
}

async function withAdmission(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-branch-policy-certification-"));
  try {
    await run({ INARI_CONFIG_HOME: path.join(root, "config") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function admissionOptions(environment, fixture, provider, branchObservation = observation()) {
  return {
    runtimeAuthority: fixture.authority,
    environment,
    now: () => NOW,
    branchObservation,
    readEvidence: (request) => executorEvidence(provider, request, fixture.authority),
  };
}

async function certifyExecution(branch, pattern) {
  scenario.branch = branch;
  scenario.pattern = pattern;
  await withAdmission(async (environment) => {
    const fixture = authorityFixture();
    const provider = createProvider();
    const binding = session(fixture, "session-alternative-policy");
    assert.equal(binding.branchObservation.expectedBranch, scenario.branch);
    assert.equal(binding.branchObservation.evidence.defaultBranch, DEFAULT_BRANCH);
    const options = admissionOptions(environment, fixture, provider);
    assert.equal((await admitSession(binding, options)).status, "active");

    // PR publication: exact alternative head against the non-main default base.
    const publish = await authorizeExecutionIntent(publishIntent("request-publish"), binding.sessionId, options);
    assert.deepEqual(publish.subject, {
      kind: "pullRequest",
      issue: IMPLEMENTATION,
      head: scenario.branch,
      base: DEFAULT_BRANCH,
    });
    const published = await executeAuthorizedExecution(publish, executorDelegates(provider));
    assert.equal(published.status, "succeeded", JSON.stringify(published.failure ?? published.publication));
    assert.equal(published.publication.classification, "created");
    assert.equal(published.provenance.stage, "verified");
    assert.deepEqual(provider.state.mutations, [`createPullRequest ${scenario.branch} -> ${DEFAULT_BRANCH}`]);

    // Branch advance: the admitted branch is exactly the mutated branch.
    const advance = await authorizeExecutionIntent(advanceIntent("request-advance"), binding.sessionId, options);
    assert.deepEqual(advance.subject, { kind: "branch", issue: IMPLEMENTATION, branch: scenario.branch });
    assert.deepEqual(advance.capability, { kind: "branch.advance", branch: scenario.branch });
    const advanced = await executeAuthorizedExecution(advance, executorDelegates(provider));
    assert.equal(advanced.status, "succeeded", JSON.stringify(advanced.failure ?? advanced.branchAdvance));
    assert.equal(advanced.branchAdvance.outcome, "advanced");
    assert.equal(advanced.branchAdvance.branch, scenario.branch);
    assert.equal(advanced.provenance.stage, "verified");
    assert.deepEqual(advanced.provenance.subject, { kind: "branch", issue: IMPLEMENTATION, branch: scenario.branch });
    assert.equal(provider.state.branchSha, NEW_COMMIT);
    assert.deepEqual(provider.state.mutations.slice(1), [
      "POST git/blobs",
      "POST git/trees",
      "POST git/commits",
      `updateRefs refs/heads/${scenario.branch}`,
    ]);
  });
}

test("an alternative branch convention on a non-main default executes through Session, Admission, Executor, branch and PR capabilities", async () => {
  await certifyExecution(ALTERNATIVE_BRANCH, ALTERNATIVE_PATTERN);
});

test("an exactly policy-bound historical-looking branch naming another Issue executes for its Implementation", async () => {
  // Implementation #42 is governed onto feat/999-special: spelling never re-derives Implementation identity.
  await certifyExecution("feat/999-special", "^[a-z]+/[0-9]+-[a-z-]+$");
});

test("a branch named main on a trunk default executes through Session, Admission, Executor, branch and PR capabilities", async () => {
  await certifyExecution("main", "^(main|story/[0-9]+-[a-z0-9-]+)$");
});

test("main is bound only by actual default-branch evidence at the Session policy and capability boundary", () => {
  const fixture = authorityFixture();
  const pattern = "^(main|story/[0-9]+-[a-z0-9-]+)$";
  const repository = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID };
  const bound = (defaultBranch) => {
    const generation = { ref: defaultBranch, treeSha: GENERATION.treeSha };
    scenario.pattern = pattern;
    return observeLocalBranch({
      policy: policy(generation),
      target: { repository, implementation: IMPLEMENTATION },
      observedGeneration: generation,
      observedBranch: "main",
      binding: { repository, implementation: IMPLEMENTATION, branch: "main" },
    });
  };
  try {
    // Default trunk: `main` is an ordinary governed Implementation branch.
    const observation = bound("trunk");
    assert.equal(observation.expectedBranch, "main");
    const binding = createLocalSessionBinding({
      sessionId: "session-main-on-trunk",
      repository: { id: REPOSITORY_ID, name: NAME_WITH_OWNER },
      task: { kind: "issue", number: IMPLEMENTATION },
      capabilities: [
        { kind: "branch.advance", branch: "main" },
        { kind: "pullRequest.create", head: "main", base: DEFAULT_BRANCH, max: 1 },
      ],
      ttlSeconds: 600,
      runtimeAuthority: fixture.authority,
      runtimeKey: fixture.keyPair,
      now: NOW,
      branchObservation: observation,
    });
    assert.deepEqual(binding.capabilities[0], { kind: "branch.advance", branch: "main" });
    // Default main: the actual default branch is refused by the policy authority.
    assert.throws(() => bound("main"), /unavailable: BRANCH_NAME_RESERVED/u);
  } finally {
    scenario.pattern = ALTERNATIVE_PATTERN;
  }
});

test("wrong repository, Implementation, branch, and stale generation fail before provider mutation", async () => {
  scenario.branch = ALTERNATIVE_BRANCH;
  scenario.pattern = ALTERNATIVE_PATTERN;
  await withAdmission(async (environment) => {
    const fixture = authorityFixture();
    const provider = createProvider();
    const binding = session(fixture, "session-negative");
    const options = admissionOptions(environment, fixture, provider);
    assert.equal((await admitSession(binding, options)).status, "active");
    const denied = async (label, promise, pattern) => {
      await assert.rejects(promise, pattern, label);
      assert.deepEqual(provider.state.mutations, [], label);
    };

    // Wrong repository.
    await denied(
      "intent repository",
      authorizeExecutionIntent(
        advanceIntent("wrong-repository", { repositoryId: "469113999" }),
        binding.sessionId,
        options,
      ),
      /repository does not match/u,
    );
    const foreign = createProvider({ body: implementationBody({ repositoryId: "469113999" }) });
    await denied(
      "Implementation contract repository",
      authorizeExecutionIntent(
        advanceIntent("foreign-contract"),
        binding.sessionId,
        admissionOptions(environment, fixture, foreign),
      ),
      /repository does not match reader scope/u,
    );
    assert.deepEqual(foreign.state.mutations, []);

    // Wrong Implementation.
    await denied(
      "branch task",
      authorizeExecutionIntent(
        advanceIntent("wrong-implementation", { issue: 43, branch: "story/43-alternative-policy" }),
        binding.sessionId,
        options,
      ),
      /does not match the Session policy branch|task does not match/u,
    );
    await denied(
      "publication task",
      authorizeExecutionIntent(
        publishIntent("wrong-publication-implementation", { implementation: 43, head: "story/43-alternative-policy" }),
        binding.sessionId,
        options,
      ),
      /task does not match/u,
    );
    assert.throws(
      () =>
        observeLocalBranch({
          ...observation(),
          target: { ...observation().target, implementation: 43 },
        }),
      /unavailable/u,
    );

    // Wrong branch.
    await denied(
      "branch advance",
      authorizeExecutionIntent(advanceIntent("wrong-branch", { branch: "story/42-other" }), binding.sessionId, options),
      /Session policy branch/u,
    );
    await denied(
      "PR head",
      authorizeExecutionIntent(publishIntent("wrong-head", { head: "story/42-other" }), binding.sessionId, options),
      { name: "CapabilityAdmissionError", reason: "canonical-identity" },
    );
    await denied(
      "observed branch",
      authorizeExecutionIntent(advanceIntent("observed-branch"), binding.sessionId, {
        ...options,
        branchObservation: observation({ observedBranch: "story/42-other" }),
      }),
      /invalid or stale/u,
    );
    const offPolicy = createProvider({ body: implementationBody({ branch: "feat/42-alternative-policy" }) });
    await denied(
      "contract branch outside repository policy",
      authorizeExecutionIntent(
        advanceIntent("off-policy"),
        binding.sessionId,
        admissionOptions(environment, fixture, offPolicy),
      ),
      /BRANCH_POLICY_MISMATCH/u,
    );
    const contradicting = createProvider({ body: implementationBody({ branch: "story/42-contract-branch" }) });
    await denied(
      "Session branch contradicts governed Change branch",
      authorizeExecutionIntent(
        advanceIntent("contradicting"),
        binding.sessionId,
        admissionOptions(environment, fixture, contradicting),
      ),
      { name: "CapabilityAdmissionError", reason: "canonical-identity" },
    );
    assert.deepEqual(offPolicy.state.mutations, []);
    assert.deepEqual(contradicting.state.mutations, []);

    // Stale generation.
    const moved = { ref: DEFAULT_BRANCH, treeSha: "7".repeat(40) };
    await denied(
      "Session generation is stale at Admission",
      authorizeExecutionIntent(advanceIntent("stale-observation"), binding.sessionId, {
        ...options,
        branchObservation: observation({ generation: moved, observedGeneration: moved }),
      }),
      /contradicts Session binding/u,
    );
    await denied(
      "observed generation differs from policy generation",
      authorizeExecutionIntent(advanceIntent("stale-policy"), binding.sessionId, {
        ...options,
        branchObservation: observation({ observedGeneration: moved }),
      }),
      /invalid or stale/u,
    );
    const renamedDefault = createProvider({ policyDefault: "develop" });
    await denied(
      "Executor policy generation differs from provider default",
      authorizeExecutionIntent(
        advanceIntent("stale-executor"),
        binding.sessionId,
        admissionOptions(environment, fixture, renamedDefault),
      ),
      /generation does not match/u,
    );
    assert.deepEqual(renamedDefault.state.mutations, []);
  });
});
