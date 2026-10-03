import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import { authorizeImplementation } from "./implementation-authorization.js";
import {
  GitHubAdapter,
  type GitHubApiResponse,
  type GitHubBranch,
  type GitHubIssue,
  type GitHubOperationalCollection,
  type GitHubOperationalPullRequestEvidence,
  type RepositoryContext,
} from "./github/index.js";

const CONTEXT: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "415000001",
};

function capturePublicCliOutput(argv: readonly string[]) {
  const moduleUrl = new URL("./cli.ts", import.meta.url).href;
  const source = `import { runCli } from ${JSON.stringify(moduleUrl)}; process.exitCode = await runCli(${JSON.stringify(argv)});`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

const BRANCH: GitHubBranch = {
  name: "main",
  ref: "refs/heads/main",
  sha: "a".repeat(40),
};

function implementationBody(): string {
  return renderImplementationIssueBody({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository: {
      repositoryHost: CONTEXT.hostname,
      repositoryId: CONTEXT.repositoryId,
      repository: CONTEXT.nameWithOwner,
    },
    sources: [
      {
        repositoryHost: CONTEXT.hostname,
        repositoryId: CONTEXT.repositoryId,
        repository: CONTEXT.nameWithOwner,
        number: 7,
      },
    ],
    objective: "Expose the Implementation CLI.",
    nonGoals: ["Automatic authorization"],
    architecture: {
      decision: "Keep the CLI as a projection over the canonical Core.",
      affectedComponents: ["CLI"],
      invariants: ["Inferred scope has no authority."],
      compatibilityConstraints: [],
    },
    scope: {
      readOnly: ["src/**"],
      write: ["src/cli-core.ts"],
      create: [],
      delete: [],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not mutate GitHub."],
      immutableAreas: ["Canonical contract semantics"],
      prerequisites: ["The canonical authorities exist."],
    },
    verification: {
      acceptanceCriteria: ["The CLI is discoverable."],
      targetedTests: ["pnpm test"],
      requiredChecks: ["pnpm run verify"],
      postconditions: ["Authorization is explicit."],
    },
    execution: {
      baseBranch: BRANCH.name,
      baseRevision: BRANCH.sha,
      baseFreshness: BRANCH.sha,
      branch: "feat/573-impl-cli",
      dependencies: [
        {
          repositoryHost: CONTEXT.hostname,
          repositoryId: CONTEXT.repositoryId,
          repository: CONTEXT.nameWithOwner,
          number: 7,
        },
      ],
    },
  });
}

function issue(body: string): GitHubIssue {
  return {
    number: 42,
    title: "impl: expose the Implementation CLI",
    body,
    state: "open",
    url: "https://github.com/acme/inari/issues/42",
    labels: ["implementation"],
    assignees: [],
    repositoryId: CONTEXT.repositoryId,
    repositoryHost: CONTEXT.hostname,
  };
}

function collection<T>(items: readonly T[]): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

class ImplementationCliAdapter extends GitHubAdapter {
  readonly relationCalls: string[] = [];
  readonly currentIssue: GitHubIssue;
  readonly currentBranch: GitHubBranch | undefined;
  readonly parentNumber: number | undefined;

  constructor(body: string, currentBranch: GitHubBranch | undefined = BRANCH, parentNumber?: number) {
    super();
    this.currentIssue = issue(body);
    this.currentBranch = currentBranch;
    this.parentNumber = parentNumber;
  }

  override async getRepositoryContext(): Promise<RepositoryContext> {
    return CONTEXT;
  }

  override async getIssue(): Promise<GitHubIssue> {
    return this.currentIssue;
  }

  override async findBranch(): Promise<GitHubBranch | undefined> {
    return this.currentBranch;
  }

  override async observePullRequest(pullRequestNumber: number): Promise<GitHubOperationalPullRequestEvidence> {
    return {
      repository: {
        host: CONTEXT.hostname,
        nameWithOwner: CONTEXT.nameWithOwner,
        repositoryId: CONTEXT.repositoryId,
      },
      number: pullRequestNumber,
      title: "Implementation PR",
      body: "PR body is not conformance authority.",
      state: "open",
      author: null,
      head: { ref: "feat/573-impl-cli", sha: "b".repeat(40) },
      base: { ref: BRANCH.name, sha: BRANCH.sha },
      draft: false,
      labels: [],
      assignees: [],
      url: `https://github.com/${CONTEXT.nameWithOwner}/pull/${pullRequestNumber}`,
      checks: collection([
        {
          id: "verify",
          name: "pnpm run verify",
          kind: "check-run",
          identity: { context: "pnpm run verify", producer: "app:trusted" },
          status: "completed",
          conclusion: "success",
        },
        { id: "test", name: "pnpm test", kind: "check-run", status: "completed", conclusion: "success" },
      ]),
      requiredCheckBindings: collection([{ context: "pnpm run verify", producer: "app:trusted" }]),
      reviews: collection([]),
      comments: collection([]),
      inlineReviewComments: collection([]),
      changedFiles: collection([{ filename: "src/cli-core.ts", status: "modified" }]),
      provenance: { provider: "github", endpoints: [`pulls/${pullRequestNumber}`] },
    };
  }

  override async requestRepositoryApi(repositoryPath: string): Promise<GitHubApiResponse> {
    this.relationCalls.push(repositoryPath);
    if (repositoryPath.endsWith("/parent")) {
      return this.parentNumber === undefined
        ? { status: 404, body: {} }
        : {
            status: 200,
            body: {
              number: this.parentNumber,
              repository_url: "https://api.github.com/repos/acme/inari",
            },
          };
    }
    if (repositoryPath.includes("/sub_issues?")) {
      return {
        status: 200,
        body: [
          {
            number: 43,
            repository_url: "https://api.github.com/repos/acme/inari",
          },
        ],
      };
    }
    throw new Error(`Unexpected relation request: ${repositoryPath}`);
  }
}

async function invoke(
  argv: readonly string[],
  adapter: ImplementationCliAdapter,
): Promise<{ readonly exitCode: number; readonly output: Record<string, unknown> }> {
  const captured = await invokeOutput(argv, adapter);
  return {
    exitCode: captured.exitCode,
    output: JSON.parse(captured.lines.at(-1) ?? "{}") as Record<string, unknown>,
  };
}

async function invokeOutput(
  argv: readonly string[],
  adapter: ImplementationCliAdapter,
): Promise<{ readonly exitCode: number; readonly lines: readonly string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    const exitCode = await runCli([...argv], {
      createAdapter: () => adapter,
      repositoryRoot: process.cwd(),
    });
    return { exitCode, lines };
  } finally {
    console.log = originalLog;
  }
}

function implementationAuthorizationRecord(body = implementationBody(), branch = BRANCH) {
  return authorizeImplementation({
    implementation: {
      repositoryHost: CONTEXT.hostname,
      repositoryId: CONTEXT.repositoryId,
      repository: CONTEXT.nameWithOwner,
      number: 42,
    },
    body,
    repository: {
      repositoryHost: CONTEXT.hostname,
      repositoryId: CONTEXT.repositoryId,
      repository: CONTEXT.nameWithOwner,
    },
    base: { branch: branch.name, revision: branch.sha, freshness: branch.sha },
    readiness: {
      evidence: [
        {
          reference: {
            repositoryHost: CONTEXT.hostname,
            repositoryId: CONTEXT.repositoryId,
            repository: CONTEXT.nameWithOwner,
            number: 7,
          },
          authority: "implementation-conformance",
          status: "satisfied",
          freshness: "current",
          dependencies: [],
        },
      ],
    },
  });
}

test("impl is discoverable and plan keeps inferred recommendations unauthorized", async () => {
  const helpResult = capturePublicCliOutput(["impl", "--help=json"]);
  assert.equal(helpResult.status, 0, helpResult.stderr);
  const help = JSON.parse(helpResult.stdout) as { commands: readonly { id: string }[] };
  assert.deepEqual(
    help.commands.map((entry) => entry.id),
    ["impl.authorize", "impl.frontier", "impl.inspect", "impl.plan", "impl.show", "impl.validate", "impl.verify"],
  );

  const adapter = new ImplementationCliAdapter("A source Issue with a checklist.\n\n- [ ] Keep scope explicit");
  const result = await invoke(["impl", "plan", "42", "--json"], adapter);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.operation, "impl.plan");
  assert.equal((result.output.authorization as Record<string, unknown>).authorized, false);
  assert.equal((result.output.recommendations as Record<string, unknown>).authoritative, false);
  assert.deepEqual(adapter.relationCalls, []);
});

function dependencyReadinessEvidence(status: "satisfied" | "blocked" | "stale" | "missing"): Record<string, unknown> {
  const reference = {
    repositoryHost: CONTEXT.hostname,
    repositoryId: CONTEXT.repositoryId,
    repository: CONTEXT.nameWithOwner,
    number: 7,
  };
  if (status === "missing") return { evidence: [] };
  return {
    evidence: [
      {
        reference,
        authority: "implementation-conformance",
        status: status === "stale" ? "satisfied" : status,
        freshness: status === "stale" ? "stale" : "current",
        dependencies: [],
      },
    ],
  };
}

async function writeReadinessFrom(
  directory: string,
  readiness: Record<string, unknown>,
  name = "readiness.json",
): Promise<string> {
  const readinessPath = path.join(directory, name);
  await writeFile(readinessPath, JSON.stringify({ readiness }), "utf8");
  return readinessPath;
}

test("impl validate and authorize use the canonical body and #572 Core", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const validated = await invoke(["impl", "validate", "42", "--json"], adapter);
  assert.equal(validated.exitCode, 0);
  assert.equal(validated.output.valid, true);
  assert.equal(validated.output.authorized, false);
  assert.equal(validated.output.current, false);
  assert.equal(validated.output.canonical, undefined);
  assert.deepEqual(validated.output.violations, []);

  const detailedValidation = await invoke(["impl", "validate", "42", "--detail", "--json"], adapter);
  assert.equal(detailedValidation.exitCode, 0);
  assert.equal((detailedValidation.output.canonical as Record<string, unknown>).valid, true);
  assert.equal((detailedValidation.output.current as Record<string, unknown>).body, implementationBody());

  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-authorize-cli-"));
  try {
    const readinessPath = await writeReadinessFrom(directory, dependencyReadinessEvidence("satisfied"));
    const authorized = await invoke(["impl", "authorize", "42", "--from", readinessPath, "--json"], adapter);
    assert.equal(authorized.exitCode, 0);
    assert.equal(authorized.output.valid, true);
    assert.equal(authorized.output.authorized, true);
    assert.equal(authorized.output.current, true);
    assert.equal(authorized.output.readiness, "READY");
    assert.equal(authorized.output.authorization, undefined);
    assert.equal(authorized.output.canonical, undefined);
    assert.deepEqual(authorized.output.violations, []);
    const repeated = await invoke(["impl", "authorize", "42", "--from", readinessPath, "--json"], adapter);
    assert.deepEqual(repeated.output, authorized.output);

    const detailed = await invoke(["impl", "authorize", "42", "--from", readinessPath, "--detail", "--json"], adapter);
    assert.equal(detailed.exitCode, 0);
    assert.equal((detailed.output.authorization as Record<string, unknown>).authorized, true);
    assert.equal(
      ((detailed.output.authorization as Record<string, unknown>).record as Record<string, unknown>).kind,
      "implementation-authorization",
    );
    assert.equal((detailed.output.canonical as Record<string, unknown>).valid, true);

    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(
      authorizationPath,
      JSON.stringify((detailed.output.authorization as Record<string, unknown>).record),
      "utf8",
    );
    const revalidated = await invoke(["impl", "validate", "42", "--from", authorizationPath, "--json"], adapter);
    assert.equal(revalidated.output.valid, true);
    assert.equal(revalidated.output.authorized, true);
    assert.equal(revalidated.output.current, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl validate and authorize human output is compact and actionable", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const validated = await invokeOutput(["impl", "validate", "42"], adapter);
  assert.equal(validated.exitCode, 0);
  const validationText = validated.lines.join("\n");
  assert.match(validationText, /Implementation #42 in acme\/inari: VALID/u);
  assert.match(validationText, /Authorized: no/u);
  assert.match(validationText, /Current: no/u);
  assert.match(validationText, /Violations: none/u);
  assert.doesNotMatch(validationText, /canonical|objective|Expose the Implementation CLI/u);

  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-authorize-human-cli-"));
  try {
    const readinessPath = await writeReadinessFrom(directory, dependencyReadinessEvidence("blocked"));
    const authorized = await invokeOutput(["impl", "authorize", "42", "--from", readinessPath], adapter);
    assert.equal(authorized.exitCode, 2);
    const authorizationText = authorized.lines.join("\n");
    assert.match(authorizationText, /Implementation #42 in acme\/inari: NOT AUTHORIZED/u);
    assert.match(authorizationText, /Valid: yes/u);
    assert.match(authorizationText, /Authorized: no/u);
    assert.match(authorizationText, /Readiness: BLOCKED/u);
    assert.match(authorizationText, /READINESS_DEPENDENCY_UNSATISFIED/u);
    assert.doesNotMatch(authorizationText, /implementation-authorization|canonical contract|"record"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl validate compact JSON retains actionable canonical violations", async () => {
  const adapter = new ImplementationCliAdapter("This is not an Implementation contract.");
  const validated = await invoke(["impl", "validate", "42", "--json"], adapter);
  assert.equal(validated.exitCode, 2);
  assert.equal(validated.output.ok, false);
  assert.equal(validated.output.valid, false);
  assert.equal(validated.output.canonical, undefined);
  assert.ok((validated.output.violations as Array<Record<string, unknown>>).length > 0);
  assert.ok(
    (validated.output.violations as Array<Record<string, unknown>>).every(
      (entry) => typeof entry.code === "string" && typeof entry.path === "string" && typeof entry.message === "string",
    ),
  );
});

test("impl validate marks a supplied stale authorization as non-current with an actionable violation", async () => {
  const originalBody = implementationBody();
  const staleAuthorization = implementationAuthorizationRecord(originalBody);
  const changedBody = originalBody.replace("Expose the Implementation CLI.", "Expose the updated Implementation CLI.");
  const adapter = new ImplementationCliAdapter(changedBody);
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-validate-stale-cli-"));
  try {
    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(authorizationPath, JSON.stringify(staleAuthorization), "utf8");
    const validated = await invoke(["impl", "validate", "42", "--from", authorizationPath, "--json"], adapter);
    assert.equal(validated.exitCode, 0);
    assert.equal(validated.output.valid, true);
    assert.equal(validated.output.authorized, false);
    assert.equal(validated.output.current, false);
    assert.ok(
      (validated.output.violations as Array<Record<string, unknown>>).some(
        (entry) => entry.code === "IMPLEMENTATION_MODIFIED_AFTER_AUTHORIZATION",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl authorize rejects when the dependency readiness evidence is unavailable", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const authorized = await invoke(["impl", "authorize", "42", "--json"], adapter);
  assert.equal(authorized.exitCode, 2);
  assert.equal(authorized.output.authorized, false);
  assert.equal(authorized.output.readiness, "INVALID");
  assert.ok(
    (authorized.output.violations as Array<Record<string, unknown>>).some(
      (entry) => entry.code === "READINESS_DEPENDENCY_EVIDENCE_MISSING",
    ),
  );
});

test("impl authorize fails closed on a blocked dependency and mints no authorization record", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-authorize-blocked-cli-"));
  try {
    const readinessPath = await writeReadinessFrom(directory, dependencyReadinessEvidence("blocked"));
    const authorized = await invoke(["impl", "authorize", "42", "--from", readinessPath, "--json"], adapter);
    assert.equal(authorized.exitCode, 2);
    assert.equal(authorized.output.authorized, false);
    assert.equal(authorized.output.readiness, "BLOCKED");
    const blocked = (authorized.output.violations as Array<Record<string, unknown>>).find(
      (entry) => entry.code === "READINESS_DEPENDENCY_UNSATISFIED",
    );
    assert.ok(blocked);
    assert.equal(typeof blocked.path, "string");
    assert.equal(typeof blocked.message, "string");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl authorize fails closed on stale dependency evidence", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-authorize-stale-cli-"));
  try {
    const readinessPath = await writeReadinessFrom(directory, dependencyReadinessEvidence("stale"));
    const authorized = await invoke(["impl", "authorize", "42", "--from", readinessPath, "--json"], adapter);
    assert.equal(authorized.exitCode, 2);
    assert.equal(authorized.output.authorized, false);
    assert.equal(authorized.output.readiness, "INVALID");
    assert.ok(
      (authorized.output.violations as Array<Record<string, unknown>>).some(
        (entry) => entry.code === "READINESS_DEPENDENCY_STALE",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl authorize replay stays idempotent for a current authorization and does not overwrite on later invalid readiness", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-authorize-replay-cli-"));
  try {
    const readyPath = await writeReadinessFrom(directory, dependencyReadinessEvidence("satisfied"));
    const first = await invoke(["impl", "authorize", "42", "--from", readyPath, "--detail", "--json"], adapter);
    assert.equal(first.exitCode, 0);
    const record = (first.output.authorization as Record<string, unknown>).record;

    const replayPath = path.join(directory, "replay.json");
    await writeFile(
      replayPath,
      JSON.stringify({ authorization: record, readiness: dependencyReadinessEvidence("satisfied") }),
      "utf8",
    );
    const replay = await invoke(["impl", "authorize", "42", "--from", replayPath, "--detail", "--json"], adapter);
    assert.equal(replay.exitCode, 0);
    assert.deepEqual((replay.output.authorization as Record<string, unknown>).record, record);

    const invalidatedPath = path.join(directory, "invalidated.json");
    await writeFile(
      invalidatedPath,
      JSON.stringify({ authorization: record, readiness: dependencyReadinessEvidence("blocked") }),
      "utf8",
    );
    const invalidated = await invoke(
      ["impl", "authorize", "42", "--from", invalidatedPath, "--detail", "--json"],
      adapter,
    );
    assert.equal(invalidated.exitCode, 2);
    assert.deepEqual((invalidated.output.authorization as Record<string, unknown>).record, record);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl authorize omitting --from entirely fails closed the same as empty evidence for a declared dependency", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const authorized = await invoke(["impl", "authorize", "42", "--json"], adapter);
  assert.equal(authorized.exitCode, 2);
  assert.equal(authorized.output.authorized, false);
  assert.equal(authorized.output.readiness, "INVALID");
  assert.ok(
    (authorized.output.violations as Array<Record<string, unknown>>).some(
      (entry) => entry.code === "READINESS_DEPENDENCY_EVIDENCE_MISSING",
    ),
  );
});

test("impl authorize surfaces free-form prerequisites as unverified without blocking or auto-satisfying them", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-authorize-prereq-cli-"));
  try {
    const readinessPath = await writeReadinessFrom(directory, dependencyReadinessEvidence("satisfied"));
    const authorized = await invoke(
      ["impl", "authorize", "42", "--from", readinessPath, "--detail", "--json"],
      adapter,
    );
    assert.equal(authorized.exitCode, 0);
    assert.equal((authorized.output.authorization as Record<string, unknown>).authorized, true);
    const readiness = (authorized.output.authorization as Record<string, unknown>).readiness as Record<string, unknown>;
    assert.deepEqual(readiness.unverifiedPrerequisites, ["The canonical authorities exist."]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl inspect uses provider relationship authority and detects stale base evidence", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody(), BRANCH, 10);
  const record = implementationAuthorizationRecord();
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-cli-"));
  try {
    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(authorizationPath, JSON.stringify(record), "utf8");
    const inspected = await invoke(
      ["impl", "inspect", "42", "--from", authorizationPath, "--capability", "github.issue.parent.native", "--json"],
      adapter,
    );
    assert.equal(inspected.exitCode, 0);
    const relationships = inspected.output.relationships as Record<string, unknown>;
    assert.equal((relationships.parent as Record<string, unknown>).reference !== undefined, true);
    assert.equal((relationships.children as Record<string, unknown>).references !== undefined, true);

    const staleAdapter = new ImplementationCliAdapter(implementationBody(), { ...BRANCH, sha: "b".repeat(40) });
    const stale = await invoke(["impl", "authorize", "42", "--json"], staleAdapter);
    assert.equal(stale.exitCode, 2);
    const violations = stale.output.violations as Array<Record<string, unknown>>;
    assert.ok(violations.some((entry) => entry.code === "IMPLEMENTATION_AUTHORIZATION_BASE_REVISION_MISMATCH"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl verify rereads the Implementation and checks the normalized PR evidence", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const record = implementationAuthorizationRecord();
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-verify-cli-"));
  try {
    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(authorizationPath, JSON.stringify(record), "utf8");
    const verified = await invoke(
      ["impl", "verify", "42", "--from", authorizationPath, "--pr", "90", "--json"],
      adapter,
    );
    assert.equal(verified.output.operation, "impl.verify");
    // The contract's targetedTests name a test-execution command ("pnpm
    // test"), which has no authoritative provider evidence distinct from a
    // same-named CI check, so it is reported unverifiable rather than
    // satisfied even though the mock PR carries a successful check with a
    // matching name.
    assert.equal(verified.output.status, "unverifiable");
    assert.equal(verified.output.valid, false);
    assert.equal(verified.exitCode, 2);
    const verification = verified.output.verification as Record<string, unknown>;
    assert.deepEqual(verification.satisfiedChecks, ["pnpm run verify"]);
    assert.deepEqual(verification.unverifiableTests, ["pnpm test"]);
    assert.equal(JSON.stringify(verified.output).includes("PR body is not conformance authority."), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl verify --execution-evidence reaches conformant when authorization, PR, and targeted-test evidence match", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const record = implementationAuthorizationRecord();
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-verify-evidence-cli-"));
  try {
    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(authorizationPath, JSON.stringify(record), "utf8");
    const evidencePath = path.join(directory, "evidence.json");
    await writeFile(
      evidencePath,
      JSON.stringify({
        version: 1,
        kind: "implementation-execution-evidence",
        implementation: record.implementation,
        repository: record.repository,
        governedBodyDigest: record.governedBodyDigest,
        base: record.base,
        branch: "feat/573-impl-cli",
        headRevision: "b".repeat(40),
        targetedTests: [{ command: "pnpm test", result: "satisfied" }],
      }),
      "utf8",
    );
    const verified = await invoke(
      [
        "impl",
        "verify",
        "42",
        "--from",
        authorizationPath,
        "--pr",
        "90",
        "--execution-evidence",
        evidencePath,
        "--json",
      ],
      adapter,
    );
    assert.equal(verified.output.status, "conformant");
    assert.equal(verified.output.valid, true);
    assert.equal(verified.exitCode, 0);
    const verification = verified.output.verification as Record<string, unknown>;
    assert.deepEqual(verification.satisfiedTests, ["pnpm test"]);
    assert.deepEqual(verification.satisfiedChecks, ["pnpm run verify"]);
    const serialized = JSON.stringify(verified.output);
    assert.equal(serialized.includes("PR body is not conformance authority."), false);
    assert.equal(serialized.includes(evidencePath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl verify --execution-evidence fails closed on a malformed evidence file without leaking its path or contents", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const record = implementationAuthorizationRecord();
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-verify-malformed-cli-"));
  try {
    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(authorizationPath, JSON.stringify(record), "utf8");
    const evidencePath = path.join(directory, "evidence.json");
    const secretMarker = "provider-secret-should-not-leak";
    await writeFile(evidencePath, JSON.stringify({ not: "valid execution evidence", marker: secretMarker }), "utf8");
    const verified = await invoke(
      [
        "impl",
        "verify",
        "42",
        "--from",
        authorizationPath,
        "--pr",
        "90",
        "--execution-evidence",
        evidencePath,
        "--json",
      ],
      adapter,
    );
    assert.equal(verified.output.valid, false);
    assert.equal(verified.output.status, "unverifiable");
    const verification = verified.output.verification as Record<string, unknown>;
    assert.deepEqual(verification.unverifiableTests, ["pnpm test"]);
    const serialized = JSON.stringify(verified.output);
    assert.equal(serialized.includes(evidencePath), false);
    assert.equal(serialized.includes(secretMarker), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl verify --execution-evidence fails closed through the existing CLI error convention when the file is unreadable", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const record = implementationAuthorizationRecord();
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-verify-missing-evidence-cli-"));
  try {
    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(authorizationPath, JSON.stringify(record), "utf8");
    const missingEvidencePath = path.join(directory, "missing-evidence.json");
    const verified = await invoke(
      [
        "impl",
        "verify",
        "42",
        "--from",
        authorizationPath,
        "--pr",
        "90",
        "--execution-evidence",
        missingEvidencePath,
        "--json",
      ],
      adapter,
    );
    assert.notEqual(verified.exitCode, 0);
    const error = verified.output.error as Record<string, unknown> | undefined;
    assert.equal(error?.code, "INPUT_READ_FAILED");
    const serialized = JSON.stringify(verified.output);
    assert.equal(serialized.includes(missingEvidencePath), false);
    assert.equal(serialized.includes(directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
