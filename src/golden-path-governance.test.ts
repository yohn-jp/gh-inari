import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverGoldenPathGovernance,
  type GoldenPathKnownGovernance,
  type GoldenPathGovernanceDiscoveryResult,
} from "./golden-path-governance.js";
import { GitHubAdapter, type GhCommandResult, type GhTransport, type GhTransportOptions } from "./github/index.js";

class StubTransport implements GhTransport {
  readonly calls: readonly string[][];
  private readonly history: string[][] = [];
  private readonly responses: Array<GhCommandResult | Error>;

  constructor(responses: Array<GhCommandResult | Error>) {
    this.responses = [...responses];
    this.calls = this.history;
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.history.push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    if (response instanceof Error) throw response;
    return response;
  }
}

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

function blob(sha: string, source: string): GhCommandResult {
  return command(JSON.stringify({ sha, encoding: "base64", content: Buffer.from(source, "utf8").toString("base64") }));
}

function adapterResponses(
  entries: readonly { readonly path: string; readonly sha: string }[],
  blobs: readonly { readonly sha: string; readonly source: string }[],
  treeSha = "tree-sha",
): GhCommandResult[] {
  return [
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({ sha: treeSha, truncated: false, tree: entries.map((entry) => ({ ...entry, type: "blob" })) }),
    ),
    ...blobs.map(({ sha, source }) => blob(sha, source)),
  ];
}

function nativeIssueSource(name: string): string {
  return `name: ${name}\ndescription: governed issue\nbody:\n  - type: input\n    id: summary\n    attributes:\n      label: Summary\n    validations:\n      required: true\n`;
}

function nativeAdapter(
  entries: readonly { readonly path: string; readonly sha: string }[],
  blobs: readonly { readonly sha: string; readonly source: string }[],
  treeSha = "tree-sha",
): GitHubAdapter {
  return new GitHubAdapter({
    repository: "acme/repository",
    transport: new StubTransport(adapterResponses(entries, blobs, treeSha)),
  });
}

function assertResolved(result: GoldenPathGovernanceDiscoveryResult) {
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") throw new Error("expected resolved governance");
  return result;
}

test("known native governance resolves directly to governed creation and preserves generation", async () => {
  const result = assertResolved(
    await discoverGoldenPathGovernance(
      nativeAdapter(
        [{ path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "bug-sha" }],
        [{ sha: "bug-sha", source: nativeIssueSource("Bug") }],
      ),
      { domain: "issue", selector: "bug" },
    ),
  );
  assert.equal(result.source, "native-template");
  assert.equal(
    "template" in result.provenance ? result.provenance.template.path : undefined,
    ".github/ISSUE_TEMPLATE/bug.yml",
  );
  assert.equal(result.generation.treeSha, "tree-sha");
  assert.equal(result.nextAction.action, "direct-governed-create");
});

test("missing governance returns a bounded discovery action without a local fallback", async () => {
  const result = await discoverGoldenPathGovernance(nativeAdapter([], []), { domain: "issue" });
  assert.equal(result.status, "discovery-required");
  assert.equal(result.reason, "NO_GOVERNANCE_CANDIDATES");
  assert.equal(result.nextAction.action, "inspect-governance");
  assert.deepEqual(result.diagnostic.candidates, []);
});

test("ambiguous native templates expose only bounded selector evidence", async () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    path: `.github/ISSUE_TEMPLATE/template-${String(index).padStart(2, "0")}.yml`,
    sha: `sha-${index}`,
  }));
  const result = await discoverGoldenPathGovernance(
    nativeAdapter(
      entries,
      entries.map((entry, index) => ({ sha: entry.sha, source: nativeIssueSource(`Template ${index}`) })),
    ),
    { domain: "issue", templateResolver: { isInteractive: () => false } },
  );
  assert.equal(result.status, "ambiguous");
  assert.equal(result.reason, "SELECTOR_AMBIGUOUS");
  assert.equal(result.nextAction.action, "provide-template-selector");
  assert.equal(result.diagnostic.candidates.length, 8);
  assert.equal(result.diagnostic.candidateCount, 12);
  assert.equal(result.diagnostic.candidatesTruncated, true);
});

test("stale expected generation fails closed before direct creation", async () => {
  const result = await discoverGoldenPathGovernance(
    nativeAdapter(
      [{ path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "bug-sha" }],
      [{ sha: "bug-sha", source: nativeIssueSource("Bug") }],
    ),
    { domain: "issue", selector: "bug", expectedGeneration: "old-tree" },
  );
  assert.equal(result.status, "stale");
  assert.equal(result.reason, "GENERATION_STALE");
  assert.equal(result.nextAction.action, "refresh-governance");
  assert.equal(result.generation?.treeSha, "tree-sha");
});

test("known contract provenance is authoritative over an unrelated cached provenance", async () => {
  const oldResult = assertResolved(
    await discoverGoldenPathGovernance(
      nativeAdapter(
        [{ path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "old-sha" }],
        [{ sha: "old-sha", source: nativeIssueSource("Old") }],
        "old-tree",
      ),
      { domain: "issue", selector: "bug" },
    ),
  );
  if (!("template" in oldResult.provenance)) throw new Error("expected native provenance");
  const unrelatedFreshProvenance = {
    ...oldResult.provenance,
    treeSha: "fresh-tree",
    template: { ...oldResult.provenance.template, sha: "fresh-sha" },
  };
  const knownWithUnrelatedEvidence = {
    source: "native-template" as const,
    contract: oldResult.contract,
    provenance: unrelatedFreshProvenance,
  } as unknown as GoldenPathKnownGovernance;
  const result = await discoverGoldenPathGovernance(
    nativeAdapter(
      [{ path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "fresh-sha" }],
      [{ sha: "fresh-sha", source: nativeIssueSource("Fresh") }],
      "fresh-tree",
    ),
    { domain: "issue", known: knownWithUnrelatedEvidence },
  );
  assert.equal(result.status, "stale");
  assert.equal(result.reason, "GENERATION_STALE");
  assert.equal(result.nextAction.action, "refresh-governance");
});

test("incompatible Artifact Contract source fails closed with remediation", async () => {
  const result = await discoverGoldenPathGovernance(
    nativeAdapter(
      [{ path: ".github/inari/issues/default.json", sha: "invalid-sha" }],
      [{ sha: "invalid-sha", source: "{not-json" }],
    ),
    { domain: "issue", source: "artifact-contract", selector: "default" },
  );
  assert.equal(result.status, "incompatible");
  assert.equal(result.reason, "ARTIFACT_CONTRACT_SOURCE_INVALID");
  assert.equal(result.nextAction.action, "repair-governance");
});

test("known source and contract provenance shapes cannot be mixed", async () => {
  const nativeResult = assertResolved(
    await discoverGoldenPathGovernance(
      nativeAdapter(
        [{ path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "bug-sha" }],
        [{ sha: "bug-sha", source: nativeIssueSource("Bug") }],
      ),
      { domain: "issue", selector: "bug" },
    ),
  );
  const result = await discoverGoldenPathGovernance(new GitHubAdapter({ repository: "acme/repository" }), {
    domain: "issue",
    source: "artifact-contract",
    known: { source: "artifact-contract", contract: nativeResult.contract },
  });
  assert.equal(result.status, "incompatible");
  assert.equal(result.reason, "GOVERNANCE_SOURCE_INVALID");
  assert.equal(result.nextAction.action, "repair-governance");
});

test("an explicit selector resumes the bounded route after ambiguity", async () => {
  const entries = [
    { path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "bug-sha" },
    { path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha" },
  ];
  const rawResult = await discoverGoldenPathGovernance(
    nativeAdapter(entries, [{ sha: "feature-sha", source: nativeIssueSource("Feature") }]),
    { domain: "issue", selector: "feature", templateResolver: { isInteractive: () => false } },
  );
  const result = assertResolved(rawResult);
  assert.equal(
    "template" in result.provenance ? result.provenance.template.path : undefined,
    ".github/ISSUE_TEMPLATE/feature.yml",
  );
  assert.equal(result.nextAction.action, "direct-governed-create");
});

test("Artifact Contract governance honors the shared configured default", async () => {
  const contract = JSON.stringify({
    version: "1",
    kind: "issue",
    id: "feature",
    properties: {
      title: { presence: "required", authority: { kind: "supplied" } },
    },
  });
  const transport = new StubTransport(
    adapterResponses(
      [
        { path: ".github/inari/issues/bug.json", sha: "bug-sha" },
        { path: ".github/inari/issues/feature.json", sha: "feature-sha" },
        { path: ".github/inari/template-resolution.yml", sha: "config-sha" },
      ],
      [
        { sha: "config-sha", source: "version: 1\ndefaults:\n  issue: feature\n" },
        { sha: "feature-sha", source: contract },
      ],
    ),
  );
  const result = assertResolved(
    await discoverGoldenPathGovernance(new GitHubAdapter({ repository: "acme/repository", transport }), {
      domain: "issue",
      source: "artifact-contract",
    }),
  );
  assert.equal(result.source, "artifact-contract");
  assert.equal(
    "source" in result.provenance ? result.provenance.source.path : undefined,
    ".github/inari/issues/feature.json",
  );
  assert.equal(result.nextAction.action, "direct-governed-create");
});
