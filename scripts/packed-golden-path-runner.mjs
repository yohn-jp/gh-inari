#!/usr/bin/env node

/**
 * Deterministic Actions-boundary runner for packed certification.
 *
 * This file is launched by the fake `gh` transport only after the packed
 * executable has been installed into a fresh consumer. It imports the
 * installed package's Core/executor modules and delegates every lifecycle
 * decision to TrustedChangeExecutor. The JSON state below is provider
 * observation/effect state; it never projects a lifecycle state itself.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const TREE_SHA = "packed-golden-path-tree";
const REPOSITORY_ID = "415000001";
const OWNER = "yohn-jp";
const NAME = "gh-inari";
const HOST = "github.com";
const BASE_BRANCH = "main";
const BRANCH_PATTERN = "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$";
const REQUESTER = "github:packed-certification";
const ISSUER = "app:inari-issuer";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value, maximum = 512) {
  const text = String(value)
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--")) throw new Error(`unexpected argument: ${option}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options[option.slice(2)] = value;
    index += 1;
  }
  for (const key of ["package-root", "consumer-root", "state", "request", "result"]) {
    if (typeof options[key] !== "string" || options[key].length === 0) throw new Error(`--${key} is required`);
  }
  return options;
}

function sha1Blob(source) {
  const bytes = Buffer.from(source, "utf8");
  return crypto.createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function sha256(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sourceFiles(consumerRoot) {
  const files = {
    issue: ".github/ISSUE_TEMPLATE/feature.yml",
    pullRequest: ".github/PULL_REQUEST_TEMPLATE/default.md",
    policy: ".github/inari/pr-policy.yml",
  };
  const contents = {};
  for (const [key, relative] of Object.entries(files)) {
    const filePath = path.join(consumerRoot, relative);
    if (!fs.existsSync(filePath)) throw new Error(`consumer governance source is missing: ${relative}`);
    contents[key] = fs.readFileSync(filePath, "utf8");
  }
  return { files, contents };
}

function ensureGovernance(state, consumerRoot) {
  const { files, contents } = sourceFiles(consumerRoot);
  const entries = Object.entries(files).map(([key, relative]) => ({
    path: relative,
    type: "blob",
    sha: sha1Blob(contents[key]),
  }));
  const existing = state.governance;
  if (
    !isRecord(existing) ||
    existing.treeSha !== TREE_SHA ||
    JSON.stringify(existing.entries) !== JSON.stringify(entries)
  ) {
    state.governance = { treeSha: TREE_SHA, entries, contents };
  }
  return state.governance;
}

function titleFor(issue) {
  return issue % 2 === 0 ? "test: Packed recovery status" : "test: Packed artifact Golden Path";
}

function slugFor(title) {
  return title
    .slice(title.indexOf(":") + 1)
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function identityFor(state, issue) {
  return { repositoryHost: HOST, repositoryId: String(state.repository.id), rootIssue: issue };
}

function targetFor(state) {
  return { repositoryHost: HOST, repositoryId: String(state.repository.id), nameWithOwner: `${OWNER}/${NAME}` };
}

function initializeChange(state, issue) {
  const key = String(issue);
  if (isRecord(state.changes?.[key])) return state.changes[key];
  const title = titleFor(issue);
  const slug = slugFor(title);
  const change = {
    issue,
    title,
    body: undefined,
    branch: `test/${issue}-${slug}`,
    branchExists: false,
    pullRequest: issue * 10,
    pullRequestExists: false,
    pullRequestState: "open",
    pullRequestDraft: true,
    pullRequestBody: undefined,
    failDeleteOnce: issue % 2 === 0,
  };
  if (!isRecord(state.changes)) state.changes = {};
  state.changes[key] = change;
  return change;
}

async function packageModules(packageRoot) {
  const dist = (name) => pathToFileURL(path.join(packageRoot, "dist", name)).href;
  const optional = async (name) => {
    const filePath = path.join(packageRoot, "dist", name);
    if (!fs.existsSync(filePath)) return undefined;
    return import(dist(name));
  };
  const [artifact, governance, change, trusted, identity] = await Promise.all([
    import(dist("artifact.js")),
    import(dist("governance.js")),
    import(dist("change.js")),
    import(dist("change-trusted-executor.js")),
    import(dist("issuer-identity.js")),
  ]);
  const [handoff, status, recovery] = await Promise.all([
    optional("change-handoff.js"),
    optional("golden-path-status.js"),
    optional("golden-path-recovery.js"),
  ]);
  return { artifact, governance, change, trusted, identity, handoff, status, recovery };
}

async function compileBoundContracts(packageRoot, consumerRoot, state) {
  const modules = await packageModules(packageRoot);
  const governance = ensureGovernance(state, consumerRoot);
  const compile = modules.governance.compileLocalGovernedContract;
  const issueContract = await compile("issue", consumerRoot, "feature");
  const pullRequestContract = await compile("pr", consumerRoot, "default", ".github/inari/pr-policy.yml");
  const repository = {
    host: HOST,
    owner: OWNER,
    name: NAME,
    nameWithOwner: `${OWNER}/${NAME}`,
    repositoryId: String(state.repository.id),
  };
  const provenance = (contract, sourcePath, includeBranch) => {
    const source = governance.entries.find((entry) => entry.path === sourcePath);
    if (source === undefined) throw new Error(`governance source was not indexed: ${sourcePath}`);
    const content =
      governance.contents[
        Object.entries({
          issue: ".github/ISSUE_TEMPLATE/feature.yml",
          pullRequest: ".github/PULL_REQUEST_TEMPLATE/default.md",
          policy: ".github/inari/pr-policy.yml",
        }).find(([, value]) => value === sourcePath)?.[0]
      ];
    const bound = {
      ...contract,
      provenance: {
        authority: "repository-default-branch",
        repository,
        ref: BASE_BRANCH,
        treeSha: governance.treeSha,
        template: {
          path: sourcePath,
          ref: BASE_BRANCH,
          sha: source.sha,
          digest: sha256(content),
        },
        ...(includeBranch ? { branchGovernance: { pattern: BRANCH_PATTERN } } : {}),
      },
    };
    return bound;
  };
  return {
    modules,
    issue: provenance(issueContract, ".github/ISSUE_TEMPLATE/feature.yml", false),
    pullRequest: provenance(pullRequestContract, ".github/PULL_REQUEST_TEMPLATE/default.md", true),
  };
}

function inputFor(state, change, contracts, operation) {
  const identity = identityFor(state, change.issue);
  const branches = change.branchExists ? [{ name: change.branch, sha: COMMIT_SHA }] : [];
  const pullRequests = change.pullRequestExists
    ? [
        {
          number: change.pullRequest,
          head: change.branch,
          base: BASE_BRANCH,
          state: change.pullRequestState,
          draft: change.pullRequestState === "closed" ? false : change.pullRequestDraft,
          merged: false,
          provenance: { issuer: ISSUER },
        },
      ]
    : [];
  const issueBody = change.body;
  const issueValues = {
    problem: "A packed artifact must complete the governed Change lifecycle.",
    capability: "Certify the installed package through the complete Golden Path.",
    contract: "The certification harness must exercise the production lifecycle contracts deterministically.",
    acceptance: "- [ ] Tests",
    non_goals: "Live GitHub dogfood remains outside this deterministic harness.",
  };
  const prValues = {
    summary: "Exercise the complete packed Golden Path.",
    linked_issue: `Closes #${change.issue}`,
    changes: "Run the installed artifact through issuance, handoff, Ready, and recovery checks.",
    validation: ["typecheck", "tests", "build"],
  };
  const renderedIssue =
    issueBody ?? contracts.modules.artifact.renderIssueArtifact(contracts.issue, { fields: issueValues });
  const renderedPr =
    change.pullRequestBody ??
    contracts.modules.artifact.renderPullRequestArtifact(contracts.pullRequest, { fields: prValues });
  const evidence = {
    issue: { status: "available", value: { number: change.issue, state: "open" } },
    branches: { status: "available", value: branches },
    pullRequests: { status: "available", value: pullRequests },
  };
  return {
    change: identity,
    provenance: change.pullRequestExists ? { issuer: ISSUER } : undefined,
    branchGovernance: { pattern: BRANCH_PATTERN },
    naming: { type: "test", slug: slugFor(change.title) },
    baseBranch: BASE_BRANCH,
    evidence,
    governedIssue: { contract: contracts.issue, body: renderedIssue },
    ...(operation === "ready" || operation === "abort"
      ? {
          readyEvidence: {
            issue: { contract: contracts.issue, body: renderedIssue },
            pullRequest: { contract: contracts.pullRequest, body: renderedPr },
          },
        }
      : {}),
  };
}

function effectEvidence(effect) {
  switch (effect.kind) {
    case "CREATE_BRANCH":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        createdCommitSha: COMMIT_SHA,
      };
    case "CREATE_PULL_REQUEST":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        rootIssue: effect.rootIssue,
        pullRequest: effect.rootIssue * 10,
      };
    case "MARK_PULL_REQUEST_READY":
    case "CLOSE_PULL_REQUEST":
      return { kind: effect.kind, pullRequest: effect.pullRequest };
    case "DELETE_BRANCH":
      return {
        kind: effect.kind,
        branch: effect.branch,
        ...(effect.expectedCommitSha === undefined ? {} : { expectedCommitSha: effect.expectedCommitSha }),
        outcome: "deleted",
      };
    default:
      throw new Error(`unsupported effect: ${String(effect.kind)}`);
  }
}

function applyProviderEffect(change, effect) {
  if (effect.kind === "DELETE_BRANCH" && change.failDeleteOnce) {
    change.failDeleteOnce = false;
    throw new Error("deterministic provider failure at DELETE_BRANCH");
  }
  switch (effect.kind) {
    case "CREATE_BRANCH":
      change.branch = effect.branch;
      change.branchExists = true;
      break;
    case "CREATE_PULL_REQUEST":
      change.pullRequestExists = true;
      change.pullRequest = effect.rootIssue * 10;
      change.pullRequestState = "open";
      change.pullRequestDraft = true;
      break;
    case "MARK_PULL_REQUEST_READY":
      change.pullRequestDraft = false;
      break;
    case "CLOSE_PULL_REQUEST":
      change.pullRequestState = "closed";
      change.pullRequestDraft = false;
      break;
    case "DELETE_BRANCH":
      change.branchExists = false;
      break;
    default:
      throw new Error(`unsupported effect: ${String(effect.kind)}`);
  }
}

function issuerFor(state, change, statePath) {
  return {
    async applyEffects(request) {
      const effect = request.effects?.[0];
      if (!isRecord(effect)) throw new Error("effect request was empty");
      applyProviderEffect(change, effect);
      writeJson(statePath, state);
      return {
        version: 1,
        authority: "issuer",
        issuer: { kind: "github-app", slug: "inari-issuer", appId: "415", principal: ISSUER },
        repository: targetFor(state),
        installation: { appId: "415", installationId: "415", repositoryHost: HOST },
        permissions: {},
        effects: [{ kind: effect.kind, status: "applied", evidence: effectEvidence(effect) }],
      };
    },
  };
}

function writeFailure(resultPath, error) {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "CHANGE_EXECUTION_EFFECT_FAILED";
  const details = {
    stage: "projection-execution",
    trustedCode: code,
    diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : [],
    ...(error?.evidence === undefined ? {} : { evidence: error.evidence }),
  };
  writeJson(resultPath, {
    ok: false,
    error: {
      code: "CHANGE_ACTIONS_RUNTIME_INVALID",
      message: bounded(error?.message ?? error),
      details,
    },
  });
}

function requireInstalledModule(modules, name) {
  const module = modules[name];
  if (module === undefined) throw new Error(`installed package is missing the ${name} Golden Path contract`);
  return module;
}

function statusInput(state, issue, projection, executionOutcome, recovery) {
  return {
    environment: {
      status: "available",
      packageIdentity: { name: NAME, version: "0.11.0" },
      capabilities: ["golden-path"],
    },
    governance: {
      status: "available",
      repositoryHost: HOST,
      repositoryId: String(state.repository.id),
    },
    issue: {
      status: "present",
      number: issue,
      state: "open",
      governed: true,
      repositoryHost: HOST,
      repositoryId: String(state.repository.id),
    },
    changeProjection: projection,
    implementation: { status: "ready", ready: true, complete: true, evidence: true },
    ready: { status: "eligible", eligible: true, preconditions: true, evidence: true },
    review: { status: "complete", action: "review" },
    ...(executionOutcome === undefined ? {} : { executionOutcome }),
    ...(recovery === undefined ? {} : { recovery }),
    subject: {
      repositoryHost: HOST,
      repositoryId: String(state.repository.id),
      rootIssue: issue,
    },
  };
}

async function execute(options, request) {
  const fallback = {
    repository: { id: REPOSITORY_ID },
    governance: undefined,
    changes: {},
  };
  const state = readJson(options.state, fallback);
  if (!isRecord(state.repository)) state.repository = { id: REPOSITORY_ID };
  if (String(state.repository.id) !== REPOSITORY_ID) state.repository.id = REPOSITORY_ID;
  const issue = Number(request.issue);
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error("request issue must be positive");
  const change = initializeChange(state, issue);
  const contracts = await compileBoundContracts(options["package-root"], options["consumer-root"], state);
  const input = inputFor(state, change, contracts, request.operation);
  const reader = {
    requiresGovernedIssueValidation: true,
    async read() {
      return inputFor(state, change, contracts, request.operation);
    },
  };
  const target = targetFor(state);
  const execution = {
    version: 1,
    runtime: "github-actions",
    event: "workflow_dispatch",
    repository: target,
    workflowRef: "refs/heads/main",
    workflowSha: COMMIT_SHA,
    workflowTrust: "protected",
    codeExecution: "trusted-only",
    fork: false,
    pullRequest: false,
    requester: typeof request.requester === "string" ? request.requester : REQUESTER,
  };
  const executor = new contracts.modules.trusted.TrustedChangeExecutor({
    reader,
    issuerAuthority: issuerFor(state, change, options.state),
    execution,
    target,
  });
  if (request.operation === "show") {
    const projection = await executor.read({
      version: 1,
      operation: "show",
      issue,
      requester: execution.requester,
    });
    writeJson(options.state, state);
    return { projection };
  }
  if (request.operation === "handoff") {
    const projection = await executor.read({
      version: 1,
      operation: "show",
      issue,
      requester: execution.requester,
    });
    const handoffModule = requireInstalledModule(contracts.modules, "handoff");
    const result = handoffModule.tryProjectImplementationHandoff(projection);
    if (!result.valid || result.handoff === undefined)
      throw new Error(`implementation handoff projection was invalid: ${JSON.stringify(result.diagnostics)}`);
    writeJson(options.state, state);
    return { projection, handoff: result.handoff };
  }
  if (request.operation === "status") {
    const projection = await executor.read({
      version: 1,
      operation: "show",
      issue,
      requester: execution.requester,
    });
    const statusModule = requireInstalledModule(contracts.modules, "status");
    const result = statusModule.tryProjectGoldenPathStatus(
      statusInput(state, issue, projection, request.executionOutcome, request.recovery),
    );
    if (!result.valid || result.projection === undefined)
      throw new Error(`Golden Path status projection was invalid: ${JSON.stringify(result.diagnostics)}`);
    writeJson(options.state, state);
    return { projection, status: result.projection };
  }
  if (request.operation === "recovery") {
    const projection = await executor.read({
      version: 1,
      operation: "show",
      issue,
      requester: execution.requester,
    });
    const recoveryModule = requireInstalledModule(contracts.modules, "recovery");
    const recovery = recoveryModule.projectGoldenPathRecovery({
      projection,
      evidence: request.evidence,
    });
    if (recovery === null) throw new Error("Golden Path recovery projection was unexpectedly absent");
    writeJson(options.state, state);
    return { projection, recovery };
  }
  // The installed Core owns planning, lifecycle state, idempotency, and
  // recovery. This runner only supplies provider observations/effects.
  const result = await executor.execute({
    version: Number(request.version) || 1,
    operation: request.operation,
    issue,
    requester: execution.requester,
  });
  writeJson(options.state, state);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const request = JSON.parse(options.request);
  try {
    const result = await execute(options, request);
    writeJson(options.result, result);
  } catch (error) {
    writeFailure(options.result, error);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(bounded(error));
    process.exitCode = 1;
  });
}

export { applyProviderEffect, parseArguments, slugFor };
