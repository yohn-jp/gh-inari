import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIssueFormYaml } from "./contract/issue-form.js";
import { parsePullRequestTemplate } from "./pull-request-template.js";
import { renderIssueArtifact, renderPullRequestArtifact } from "./artifact.js";
import { assertArtifactObservationIdentityCurrent } from "./artifact-observation-identity.js";
import {
  executeArtifactReconciliation,
  type ArtifactReconciliationRequest,
} from "./artifact-reconciliation-executor.js";
import { GitHubTransportError, type GitHubAdapter } from "./github/index.js";
import type { GitHubIssue, GitHubPullRequest } from "./github/types.js";

const ISSUE_SOURCE = [
  "name: Feature",
  "description: Feature",
  "body:",
  "  - type: textarea",
  "    id: summary",
  "    attributes:",
  "      label: Summary",
  "    validations:",
  "      required: true",
  "  - type: textarea",
  "    id: context",
  "    attributes:",
  "      label: Context",
  "    validations:",
  "      required: true",
  "",
].join("\n");

const PR_SOURCE = "## Summary\n\nDescribe the change.\n";
const ISSUE_PATH = ".github/ISSUE_TEMPLATE/feature.yml";
const PR_PATH = ".github/PULL_REQUEST_TEMPLATE.md";
const REPOSITORY_CONTEXT = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "123",
} as const;

function issueBody(
  fields: Readonly<Record<string, unknown>> = { summary: "A summary", context: "More context" },
): string {
  const contract = compileIssueFormYaml(ISSUE_SOURCE, {
    id: "feature",
    name: "Feature",
    path: ISSUE_PATH,
    type: "issue-form",
    kind: "issue",
  });
  return renderIssueArtifact(contract, { fields });
}

function pullRequestBody(): string {
  const contract = parsePullRequestTemplate(PR_SOURCE, {
    id: "default",
    type: "pull-request-default",
    kind: "pull-request",
    name: "Default",
    path: PR_PATH,
  });
  return renderPullRequestArtifact(contract, { fields: { summary: "A summary" } });
}

interface FixtureOptions {
  readonly domain?: "issue" | "pr";
  readonly body: string;
  readonly templates?: readonly { readonly path: string; readonly source: string }[];
  readonly failObservation?: boolean;
  readonly failVerificationRead?: boolean;
  readonly staleBeforeEffect?: boolean;
  readonly failAfterApplyingEffect?: boolean;
}

function fixture(options: FixtureOptions): {
  readonly adapter: GitHubAdapter;
  readonly snapshot: () => GitHubIssue | GitHubPullRequest;
  readonly counts: { reads: number; updates: number };
} {
  const domain = options.domain ?? "issue";
  const templates = options.templates ?? [
    { path: domain === "issue" ? ISSUE_PATH : PR_PATH, source: domain === "issue" ? ISSUE_SOURCE : PR_SOURCE },
  ];
  const blobs = new Map(templates.map((template, index) => [`blob-${index}`, template.source]));
  const remote =
    domain === "issue"
      ? ({
          number: 80,
          title: "feat: reconcile",
          body: options.body,
          state: "open",
          url: "https://github.com/acme/inari/issues/80",
          labels: [],
          assignees: [],
          repositoryId: "123",
          repositoryHost: "github.com",
        } satisfies GitHubIssue)
      : ({
          number: 81,
          title: "feat: reconcile",
          body: options.body,
          state: "open",
          url: "https://github.com/acme/inari/pull/81",
          draft: false,
          head: "feature/reconcile",
          base: "main",
          labels: [],
          assignees: [],
        } satisfies GitHubPullRequest);
  let current: GitHubIssue | GitHubPullRequest = { ...remote };
  const counts = { reads: 0, updates: 0 };
  const entries = templates.map((template, index) => ({
    path: template.path,
    type: "blob" as const,
    sha: `blob-${index}`,
  }));
  const adapter = {
    async resolveRepositoryContext() {
      return REPOSITORY_CONTEXT;
    },
    async getRepositoryDefaultBranch() {
      return "main";
    },
    async getRepositoryTree() {
      return { sha: "tree-1", entries };
    },
    async getRepositoryBlob(sha: string) {
      const source = blobs.get(sha);
      if (source === undefined) throw new Error(`Unknown fixture blob ${sha}`);
      return source;
    },
    async getIssue(number: number) {
      if (options.failObservation || (options.failVerificationRead && counts.updates > 0)) {
        throw new GitHubTransportError("issue.read", "read unavailable");
      }
      if (number !== remote.number) throw new Error("unexpected Issue number");
      counts.reads += 1;
      return { ...current } as GitHubIssue;
    },
    async getPullRequest(number: number) {
      if (options.failObservation || (options.failVerificationRead && counts.updates > 0)) {
        throw new GitHubTransportError("pull_request.read", "read unavailable");
      }
      if (number !== remote.number) throw new Error("unexpected pull request number");
      counts.reads += 1;
      return { ...current } as GitHubPullRequest;
    },
    async updateIssue(
      number: number,
      artifact: {
        readonly title: string;
        readonly body: string;
        readonly labels?: readonly string[];
        readonly assignees?: readonly string[];
      },
      _deadline: undefined,
      observationIdentity: Parameters<typeof assertArtifactObservationIdentityCurrent>[1],
    ) {
      counts.updates += 1;
      if (options.staleBeforeEffect) current = { ...current, title: "feat: concurrent edit" } as GitHubIssue;
      assertArtifactObservationIdentityCurrent("issue", observationIdentity, current, number);
      current = {
        ...current,
        title: artifact.title,
        body: artifact.body,
        ...(artifact.labels === undefined ? {} : { labels: artifact.labels }),
        ...(artifact.assignees === undefined ? {} : { assignees: artifact.assignees }),
      } as GitHubIssue;
      if (options.failAfterApplyingEffect) throw new GitHubTransportError("issue.update", "update response lost");
      return { ...current } as GitHubIssue;
    },
    async updatePullRequest(
      number: number,
      artifact: {
        readonly title: string;
        readonly body: string;
        readonly base: string;
        readonly maintainerCanModify?: boolean;
      },
      _deadline: undefined,
      observationIdentity: Parameters<typeof assertArtifactObservationIdentityCurrent>[1],
    ) {
      counts.updates += 1;
      if (options.staleBeforeEffect) current = { ...current, title: "feat: concurrent edit" } as GitHubPullRequest;
      assertArtifactObservationIdentityCurrent("pr", observationIdentity, current, number);
      current = {
        ...current,
        title: artifact.title,
        body: artifact.body,
        base: artifact.base,
        ...(artifact.maintainerCanModify === undefined ? {} : { maintainerCanModify: artifact.maintainerCanModify }),
      } as GitHubPullRequest;
      if (options.failAfterApplyingEffect) {
        throw new GitHubTransportError("pull_request.update", "update response lost");
      }
      return { ...current } as GitHubPullRequest;
    },
  };
  return {
    adapter: adapter as unknown as GitHubAdapter,
    snapshot: () => ({ ...current }),
    counts,
  };
}

function request(domain: "issue" | "pr" = "issue"): ArtifactReconciliationRequest {
  return { version: 1, domain, number: domain === "issue" ? 80 : 81 };
}

function reorderedIssueBody(body: string): string {
  const marker = body.match(/<!-- inari:template [^\n]* -->/u)?.[0];
  assert.ok(marker !== undefined);
  const markerFreeBody = body.replace(marker, "");
  const summaryStart = markerFreeBody.indexOf("### Summary");
  const contextStart = markerFreeBody.indexOf("### Context");
  assert.ok(summaryStart >= 0 && contextStart > summaryStart);
  const prefix = markerFreeBody.slice(0, summaryStart);
  const summary = markerFreeBody.slice(summaryStart, contextStart).trim();
  const context = markerFreeBody.slice(contextStart).trim();
  return `${prefix}${context}\n\n${summary}\n\n${marker}\n`;
}

test("single Issue reconciliation reports a canonical artifact unchanged", async () => {
  const f = fixture({ body: issueBody() });
  const result = await executeArtifactReconciliation(f.adapter, request());

  assert.equal(result.outcome, "unchanged");
  assert.equal(result.effect, "not-started");
  assert.equal(f.counts.updates, 0);
});

test("single Issue reconciliation recovers only a marked artifact with complete material coverage", async () => {
  const canonical = issueBody();
  const f = fixture({ body: reorderedIssueBody(canonical) });
  const result = await executeArtifactReconciliation(f.adapter, request());

  assert.equal(result.outcome, "reconciled", JSON.stringify(result));
  assert.equal(result.effect, "applied");
  assert.equal(result.recovery?.templatePath, ISSUE_PATH);
  assert.deepEqual(result.recovery?.diagnostics, [{ code: "EXISTING_WRONG_TEMPLATE", path: "$.sections.summary" }]);
  assert.equal(result.recovery?.coverage?.complete, true);
  assert.equal(f.snapshot().body, canonical);
  assert.equal(f.counts.updates, 1);
});

test("marked recovery preserves parser evidence and blocks duplicate headings", async () => {
  const canonical = issueBody();
  const marker = canonical.match(/<!-- inari:template [^\n]* -->/u)?.[0];
  assert.ok(marker !== undefined);
  const duplicateHeading = reorderedIssueBody(canonical).replace(
    "### Summary",
    "### Summary\n\nA second summary\n\n### Summary",
  );
  const f = fixture({ body: duplicateHeading });
  const result = await executeArtifactReconciliation(f.adapter, request());

  assert.equal(result.outcome, "blocked", JSON.stringify(result));
  assert.equal(result.failure?.code, "RECOVERY_COVERAGE_INCOMPLETE");
  assert.equal(result.recovery?.templatePath, ISSUE_PATH);
  assert.equal(result.recovery?.coverage?.complete, false);
  assert.equal(result.recovery?.diagnostics[0]?.code, "EXISTING_WRONG_TEMPLATE");
  assert.equal(f.counts.updates, 0);
});

test("marked recovery blocks malformed dependency markers and preserves diagnostics", async () => {
  const malformedDependencyMarker = '{"version":"1"}';
  const f = fixture({
    body: `${reorderedIssueBody(issueBody()).trimEnd()}\n<!-- inari:issue-dependencies ${malformedDependencyMarker} -->\n`,
  });
  const result = await executeArtifactReconciliation(f.adapter, request());

  assert.equal(result.outcome, "blocked");
  assert.equal(result.failure?.code, "RECOVERY_DEPENDENCY_MARKER_INVALID");
  assert.equal(result.recovery?.dependencyMarker, "malformed");
  assert.ok(result.recovery?.diagnostics.some((diagnostic) => diagnostic.path === "$.dependencies"));
  assert.equal(f.counts.updates, 0);
});

test("single Issue reconciliation blocks marked recovery that would discard unmatched material", async () => {
  const canonical = issueBody();
  const reordered = reorderedIssueBody(canonical).replace(/^###/mu, "Unmatched caller material\n\n###");
  const f = fixture({ body: reordered });
  const result = await executeArtifactReconciliation(f.adapter, request());

  assert.equal(result.outcome, "blocked");
  assert.equal(result.effect, "not-started");
  assert.notEqual(f.snapshot().body, canonical);
  assert.equal(f.counts.updates, 0);
});

test("single reconciliation blocks ambiguous template selection without mutation", async () => {
  const canonical = issueBody();
  const withoutMarker = canonical
    .split("\n")
    .filter((line) => !line.startsWith("<!-- inari:template"))
    .join("\n");
  const f = fixture({
    body: withoutMarker,
    templates: [
      { path: ISSUE_PATH, source: ISSUE_SOURCE },
      { path: ".github/ISSUE_TEMPLATE/feature-copy.yml", source: ISSUE_SOURCE },
    ],
  });
  const result = await executeArtifactReconciliation(f.adapter, request());

  assert.equal(result.outcome, "blocked");
  assert.equal(result.routing?.kind, "template-selection-required");
  assert.equal(f.counts.updates, 0);
});

test("pre-effect artifact observation staleness is safe to retry after rereading", async () => {
  const f = fixture({ body: reorderedIssueBody(issueBody()), staleBeforeEffect: true });
  const result = await executeArtifactReconciliation(f.adapter, request());

  assert.equal(result.outcome, "safe-pre-effect-retry", JSON.stringify(result));
  assert.equal(result.effect, "not-started");
  assert.equal(result.retry, "safe");
  assert.equal(result.failure?.code, "ARTIFACT_OBSERVATION_STALE");
  assert.equal(f.snapshot().title, "feat: concurrent edit");
});

test("a lost update response after a possible effect is never reported retryable", async () => {
  const f = fixture({
    domain: "pr",
    body: pullRequestBody().replace("## Summary", "## Summary ##"),
    failAfterApplyingEffect: true,
  });
  const result = await executeArtifactReconciliation(f.adapter, request("pr"));

  assert.equal(result.outcome, "possible-effect-ambiguity");
  assert.equal(result.effect, "possible");
  assert.equal(result.retry, "fresh-observation-required");
  assert.equal(f.snapshot().body, pullRequestBody());
});

test("an authoritative reread failure after a successful provider response remains ambiguous", async () => {
  const f = fixture({
    domain: "pr",
    body: pullRequestBody().replace("## Summary", "## Summary ##"),
    failVerificationRead: true,
  });
  const result = await executeArtifactReconciliation(f.adapter, request("pr"));

  assert.equal(result.outcome, "possible-effect-ambiguity");
  assert.equal(result.effect, "applied");
  assert.equal(result.retry, "fresh-observation-required");
  assert.equal(result.failure?.stage, "verify");
  assert.equal(f.counts.updates, 1);
});

test("pull request normalization is verified by a fresh current-canonical read", async () => {
  const canonical = pullRequestBody();
  const f = fixture({ domain: "pr", body: canonical.replace("## Summary", "## Summary ##") });
  const result = await executeArtifactReconciliation(f.adapter, request("pr"));

  assert.equal(result.outcome, "reconciled");
  assert.equal(result.effect, "applied");
  assert.equal(f.snapshot().body, canonical);
  assert.equal(f.counts.updates, 1);
});

test("provider failure while observing has a safe pre-effect retry outcome", async () => {
  const f = fixture({ body: issueBody(), failObservation: true });
  const result = await executeArtifactReconciliation(f.adapter, request());

  assert.equal(result.outcome, "safe-pre-effect-retry");
  assert.equal(result.effect, "not-started");
  assert.equal(result.retry, "safe");
  assert.equal(f.counts.updates, 0);
});
