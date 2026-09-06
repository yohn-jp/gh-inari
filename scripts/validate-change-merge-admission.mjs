#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectExistingArtifactCandidate,
  validateExistingIssueArtifact,
  validateExistingPullRequestArtifact,
} from "../src/artifact.ts";
import {
  projectChangeFromGitHubEvidence,
  validateChangeMergeAdmission,
  validateGovernedRootIssueEvidence,
} from "../src/change.ts";
import { changeRemoteReadRequest } from "../src/change-executor.ts";
import { GitHubActionsEvidenceReader } from "../src/github/actions-change-executor.ts";
import { GitHubAdapter } from "../src/github/adapter.ts";
import { compileRepositoryGovernedContracts } from "../src/governance.ts";
import { tryObserveSemanticPullRequest } from "../src/semantic-pr-observation.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CHANGE_MERGE_ADMISSION_CHECK = "Change provenance";
export const CHANGE_MERGE_ADMISSION_CLASSIFICATIONS = Object.freeze([
  "governed-change",
  "outside-governed-change",
  "unclassified",
]);

const MAX_REPORT_DIAGNOSTICS = 8;
const MAX_REPORT_CODE_LENGTH = 96;
const MAX_REPORT_PATH_LENGTH = 256;
const MAX_REPORT_MESSAGE_LENGTH = 256;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code, pathValue, message) {
  return { code, path: pathValue, message };
}

function boundedDiagnostic(value) {
  const code =
    typeof value?.code === "string" ? value.code.slice(0, MAX_REPORT_CODE_LENGTH) : "CHANGE_ADMISSION_INVALID";
  const pathValue = typeof value?.path === "string" ? value.path.slice(0, MAX_REPORT_PATH_LENGTH) : "$";
  const message =
    typeof value?.message === "string"
      ? value.message.slice(0, MAX_REPORT_MESSAGE_LENGTH)
      : "Change admission failed closed.";
  return { code, path: pathValue, message };
}

function boundedDiagnostics(values) {
  const result = [];
  for (const value of values) {
    if (result.length >= MAX_REPORT_DIAGNOSTICS) break;
    result.push(boundedDiagnostic(value));
  }
  return result;
}

function failureReport(code = "CHANGE_MERGE_ADMISSION_UNAVAILABLE", classification = "unclassified") {
  return {
    valid: false,
    check: CHANGE_MERGE_ADMISSION_CHECK,
    classification,
    diagnostics: [diagnostic(code, "$", "Change merge admission failed closed.")],
  };
}

function reportFromAdmission(classification, admission, extraDiagnostics = []) {
  const diagnostics = boundedDiagnostics([...extraDiagnostics, ...(admission?.diagnostics ?? [])]);
  return {
    valid: admission?.valid === true && diagnostics.length === 0,
    check: CHANGE_MERGE_ADMISSION_CHECK,
    classification,
    ...(admission?.projection?.status === undefined ? {} : { status: admission.projection.status }),
    ...(admission?.change?.projection?.branch === undefined
      ? {}
      : { canonicalBranch: admission.change.projection.branch }),
    ...(admission?.change?.projection?.pullRequest === undefined
      ? {}
      : { canonicalPullRequest: admission.change.projection.pullRequest }),
    diagnostics,
  };
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function boundedRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\u0000-\u001F\u007F]/u.test(value)
    ? value
    : undefined;
}

function eventPullRequest(event) {
  if (!isRecord(event) || !isRecord(event.pull_request)) return undefined;
  const pullRequest = event.pull_request;
  const number = positiveNumber(pullRequest.number);
  const head = isRecord(pullRequest.head) ? boundedRef(pullRequest.head.ref) : undefined;
  const base = isRecord(pullRequest.base) ? boundedRef(pullRequest.base.ref) : undefined;
  if (number === undefined || head === undefined || base === undefined) return undefined;
  return {
    number,
    head,
    base,
    state: pullRequest.state === "open" || pullRequest.state === "closed" ? pullRequest.state : undefined,
    draft: typeof pullRequest.draft === "boolean" ? pullRequest.draft : undefined,
  };
}

function observedPullRequest(value) {
  if (!isRecord(value)) return undefined;
  const number = positiveNumber(value.number);
  const head = boundedRef(value.head);
  const base = boundedRef(value.base);
  if (number === undefined || head === undefined || base === undefined) return undefined;
  if (value.state !== "open" && value.state !== "closed") return undefined;
  if (typeof value.draft !== "boolean") return undefined;
  return { number, head, base, state: value.state, draft: value.draft };
}

function contractChangeClassification(contract) {
  if (!isRecord(contract) || contract.artifactKind !== "pull_request") return "unclassified";
  const constraints =
    isRecord(contract.supplementalConstraints) && Array.isArray(contract.supplementalConstraints.fields)
      ? contract.supplementalConstraints.fields
      : [];
  const linkedFields = constraints.filter((field) => isRecord(field) && field.linkedIssue === true);
  if (linkedFields.length === 0) return "outside-governed-change";
  if (linkedFields.length === 1 && typeof linkedFields[0].fieldId === "string") return "governed-change";
  return "unclassified";
}

export const classifyChangePullRequestContract = contractChangeClassification;

function compiledContracts(outcomes) {
  return outcomes.filter((outcome) => outcome.status === "compiled").map((outcome) => outcome.contract);
}

function selectPullRequestContract(contracts, body) {
  if (contracts.length === 0) return undefined;
  const candidates = contracts.map((contract) => ({
    contract,
    result: validateExistingPullRequestArtifact(contract, body),
  }));
  return selectExistingArtifactCandidate(candidates);
}

function selectIssueContract(contracts, body) {
  if (contracts.length === 0) return undefined;
  const candidates = contracts.map((contract) => ({
    contract,
    result: validateExistingIssueArtifact(contract, body),
  }));
  return selectExistingArtifactCandidate(candidates);
}

function linkedIssueNumber(contract, pullRequest, context) {
  const constraints = contract.supplementalConstraints?.fields ?? [];
  const linkedFields = constraints.filter((field) => field.linkedIssue === true);
  if (linkedFields.length !== 1 || typeof linkedFields[0]?.fieldId !== "string") {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "CHANGE_MERGE_ADMISSION_CLASSIFICATION_INVALID",
          "$.pullRequest.contract",
          "The pull-request contract does not declare exactly one Change root-Issue field.",
        ),
      ],
    };
  }
  const observation = tryObserveSemanticPullRequest({
    pullRequest,
    repository: {
      host: context.hostname,
      repositoryId: context.repositoryId,
      repository: context.nameWithOwner,
    },
  });
  const references = observation.projection?.relations.implements.references ?? [];
  if (!observation.valid || references.length !== 1) {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "CHANGE_MERGE_ADMISSION_ROOT_ISSUE_INVALID",
          "$.pullRequest.body",
          "The governed pull request does not contain a bounded root-Issue reference.",
        ),
      ],
    };
  }
  return { valid: true, number: references[0].number };
}

function repositoryReadTransport(adapter, context) {
  const prefix = `repos/${context.nameWithOwner}`;
  const transport = {
    async request(request) {
      if (
        request.hostname !== context.hostname ||
        request.method !== "GET" ||
        (request.path !== prefix && !request.path.startsWith(`${prefix}/`))
      ) {
        throw new Error("invalid repository read boundary");
      }
      const relativePath = request.path.slice(prefix.length).replace(/^\//u, "");
      return adapter.requestRepositoryApi(relativePath, "GET");
    },
  };
  return transport;
}

export function createGitHubRepositoryReadTransport(adapter, context) {
  return repositoryReadTransport(adapter, context);
}

function repositoryIdentity(contract, context, rootIssue) {
  const provenance = contract.provenance;
  if (
    !isRecord(provenance) ||
    !isRecord(provenance.repository) ||
    typeof provenance.repository.host !== "string" ||
    typeof provenance.repository.repositoryId !== "string" ||
    provenance.repository.host.toLowerCase() !== context.hostname.toLowerCase() ||
    provenance.repository.repositoryId !== context.repositoryId
  ) {
    return undefined;
  }
  return {
    repositoryHost: context.hostname,
    repositoryId: context.repositoryId,
    rootIssue,
  };
}

function observedForAdmission(pullRequest) {
  return observedPullRequest({
    number: pullRequest.number,
    head: pullRequest.head,
    base: pullRequest.base,
    state: pullRequest.state,
    draft: pullRequest.draft,
  });
}

function eventBindingDiagnostics(eventValue, observed, admission) {
  const diagnostics = [];
  if (eventValue === undefined || observed === undefined) {
    diagnostics.push(
      diagnostic(
        "CHANGE_MERGE_ADMISSION_EVENT_INVALID",
        "$.pull_request",
        "The pull_request event identity is invalid.",
      ),
    );
    return diagnostics;
  }
  if (eventValue.number !== observed.number) {
    diagnostics.push(
      diagnostic(
        "CHANGE_MERGE_ADMISSION_EVENT_IDENTITY_MISMATCH",
        "$.pull_request.number",
        "The event PR does not match the authoritative PR read.",
      ),
    );
  }
  if (eventValue.head !== observed.head || eventValue.base !== observed.base) {
    diagnostics.push(
      diagnostic(
        "CHANGE_MERGE_ADMISSION_EVENT_IDENTITY_MISMATCH",
        "$.pull_request",
        "The event PR refs do not match the authoritative PR read.",
      ),
    );
  }
  const canonicalPullRequest = admission?.change?.projection?.pullRequest;
  if (canonicalPullRequest === undefined || observed.number !== canonicalPullRequest) {
    diagnostics.push(
      diagnostic(
        "CHANGE_MERGE_ADMISSION_PULL_REQUEST_IDENTITY_MISMATCH",
        "$.pull_request.number",
        "The evaluated PR is not the canonical Change pull request.",
      ),
    );
  }
  const physical = admission?.physicalPullRequest;
  if (physical !== undefined && physical.number === observed.number) {
    if (physical.head !== observed.head) {
      diagnostics.push(
        diagnostic(
          "CHANGE_MERGE_ADMISSION_BRANCH_MISMATCH",
          "$.pull_request.head.ref",
          "The evaluated PR head does not match authoritative Change evidence.",
        ),
      );
    }
    if (physical.base !== observed.base) {
      diagnostics.push(
        diagnostic(
          "CHANGE_MERGE_ADMISSION_BASE_MISMATCH",
          "$.pull_request.base.ref",
          "The evaluated PR base does not match authoritative Change evidence.",
        ),
      );
    }
    if (physical.state !== observed.state || physical.draft !== observed.draft) {
      diagnostics.push(
        diagnostic(
          "CHANGE_MERGE_ADMISSION_EVENT_IDENTITY_MISMATCH",
          "$.pull_request",
          "The evaluated PR lifecycle fields do not match authoritative Change evidence.",
        ),
      );
    }
  }
  return diagnostics;
}

/**
 * Bind one GitHub-shaped PR event to the existing Core merge-admission
 * authority. This function does not derive Change identity or provenance;
 * it only supplies bounded event identity and preserves the Core result.
 */
export function validateChangeMergeAdmissionEvent({
  event,
  projection,
  contract,
  body,
  observedPullRequest,
  canonicalChange,
}) {
  const eventValue = eventPullRequest(event);
  const observed = observedPullRequestValue(observedPullRequest);
  const projected = projectChangeFromGitHubEvidence(projection);
  const canonical = canonicalChange ?? projected.change ?? (isRecord(projection) ? projection.change : undefined);
  const admission = validateChangeMergeAdmission({
    change: canonical,
    projection,
    pullRequest: { contract, body },
  });
  const binding = eventBindingDiagnostics(eventValue, observed, admission);
  return reportFromAdmission("governed-change", admission, binding);
}

function observedPullRequestValue(value) {
  if (value === undefined) return undefined;
  return observedPullRequest(value);
}

async function readRootIssueGovernance(adapter, rootIssue, identity, baseBranch) {
  const issue = await adapter.getIssue(rootIssue);
  if (issue.number !== rootIssue) {
    return [
      diagnostic(
        "CHANGE_MERGE_ADMISSION_ROOT_ISSUE_MISMATCH",
        "$.issue.number",
        "The root Issue read does not match the Change identity.",
      ),
    ];
  }
  const outcomes = await compileRepositoryGovernedContracts(adapter, "issue");
  const selection = selectIssueContract(compiledContracts(outcomes), issue.body);
  if (selection?.contract === undefined || !selection.result.valid) {
    return [
      diagnostic(
        "CHANGE_MERGE_ADMISSION_ROOT_ISSUE_GOVERNANCE_INVALID",
        "$.issue.body",
        "The root Issue is not a canonical governed artifact.",
      ),
    ];
  }
  return validateGovernedRootIssueEvidence({ contract: selection.contract, body: issue.body }, identity, baseBranch);
}

/** Read target-repository evidence and project the merge-boundary decision. */
export async function validateGitHubPullRequestEvent({ event, root = REPOSITORY_ROOT, adapter } = {}) {
  const eventValue = eventPullRequest(event);
  if (eventValue === undefined) return failureReport("CHANGE_MERGE_ADMISSION_EVENT_INVALID");

  const github =
    adapter ??
    new GitHubAdapter({
      cwd: root,
      ...(process.env.GITHUB_REPOSITORY === undefined ? {} : { repository: process.env.GITHUB_REPOSITORY }),
      ...(process.env.GITHUB_SERVER_URL === undefined
        ? {}
        : { hostname: new URL(process.env.GITHUB_SERVER_URL).hostname }),
    });

  try {
    const context = await github.getRepositoryContext();
    if (context.repositoryId === undefined || !REPOSITORY_NAME_PATTERN.test(context.nameWithOwner)) {
      return failureReport("CHANGE_MERGE_ADMISSION_REPOSITORY_IDENTITY_INVALID");
    }
    if (!isRecord(event?.repository) || event.repository.full_name !== context.nameWithOwner) {
      return failureReport("CHANGE_MERGE_ADMISSION_REPOSITORY_IDENTITY_MISMATCH");
    }

    const observed = await github.getPullRequest(eventValue.number);
    if (observed.number !== eventValue.number) return failureReport("CHANGE_MERGE_ADMISSION_EVENT_IDENTITY_MISMATCH");
    const prOutcomes = await compileRepositoryGovernedContracts(github, "pr");
    const selection = selectPullRequestContract(compiledContracts(prOutcomes), observed.body);
    if (selection?.contract === undefined || !selection.result.valid) {
      return failureReport("CHANGE_MERGE_ADMISSION_PR_GOVERNANCE_INVALID");
    }

    const classification = contractChangeClassification(selection.contract);
    if (classification === "outside-governed-change") {
      return {
        valid: true,
        check: CHANGE_MERGE_ADMISSION_CHECK,
        classification,
        template: selection.contract.templateIdentity.id,
        diagnostics: [],
      };
    }
    if (classification !== "governed-change") return failureReport("CHANGE_MERGE_ADMISSION_CLASSIFICATION_INVALID");

    const rootResult = linkedIssueNumber(selection.contract, observed, context);
    if (!rootResult.valid) {
      return {
        valid: false,
        check: CHANGE_MERGE_ADMISSION_CHECK,
        classification,
        template: selection.contract.templateIdentity.id,
        diagnostics: boundedDiagnostics(rootResult.diagnostics),
      };
    }
    const identity = repositoryIdentity(selection.contract, context, rootResult.number);
    if (identity === undefined)
      return failureReport("CHANGE_MERGE_ADMISSION_GOVERNANCE_PROVENANCE_INVALID", classification);

    const provenance = selection.contract.provenance;
    const transport = repositoryReadTransport(github, context);
    const readerOptions = {
      repository: { hostname: context.hostname, owner: context.owner, name: context.name },
      identity,
      pullRequestNumber: eventValue.number,
      branchGovernance: provenance?.branchGovernance,
      transport,
    };
    const reader = new GitHubActionsEvidenceReader(readerOptions);
    const projection = await reader.read(changeRemoteReadRequest(rootResult.number));
    const rootDiagnostics = await readRootIssueGovernance(
      github,
      rootResult.number,
      identity,
      projection.baseBranch ?? provenance?.ref,
    );
    const report = validateChangeMergeAdmissionEvent({
      event,
      projection,
      contract: selection.contract,
      body: observed.body,
      observedPullRequest: observedForAdmission(observed),
    });
    return {
      ...report,
      template: selection.contract.templateIdentity.id,
      diagnostics: boundedDiagnostics([...rootDiagnostics, ...report.diagnostics]),
      valid: report.valid && rootDiagnostics.length === 0,
    };
  } catch {
    return failureReport("CHANGE_MERGE_ADMISSION_UNAVAILABLE");
  }
}

async function main() {
  const eventPathArgIndex = process.argv.indexOf("--event");
  if (eventPathArgIndex === -1) {
    process.stdout.write(`${JSON.stringify(failureReport("CHANGE_MERGE_ADMISSION_EVENT_INVALID"))}\n`);
    process.exitCode = 1;
    return;
  }
  const eventPath = process.argv[eventPathArgIndex + 1];
  if (eventPath === undefined) {
    process.stdout.write(`${JSON.stringify(failureReport("CHANGE_MERGE_ADMISSION_EVENT_INVALID"))}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    const report = await validateGitHubPullRequestEvent({ event, root: process.cwd() });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.valid) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify(failureReport())}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
