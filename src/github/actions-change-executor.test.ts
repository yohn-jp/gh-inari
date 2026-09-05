import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  GitHubActionsApiTransport,
  GitHubActionsCredentialBroker,
  GitHubActionsEvidenceReader,
  deriveChangeNamingFromIssueTitle,
} from "./actions-change-executor.js";
import type {
  GitHubChangeEffectRequest,
  GitHubChangeEffectResponse,
  GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerCredentialRequest,
  type IssuerRepositoryIdentity,
} from "./issuer-authority.js";
import { changeRemoteMutationRequest } from "../change-executor.js";

const repository = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const target: IssuerRepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "218000001",
  nameWithOwner: "acme/inari",
};

test("Issue title naming is resolved by the executable runtime and not by workflow YAML", () => {
  assert.deepEqual(deriveChangeNamingFromIssueTitle("feat: Execute Change plans safely"), {
    type: "feat",
    slug: "execute-change-plans-safely",
  });
  assert.deepEqual(deriveChangeNamingFromIssueTitle("fix: normalize café input"), {
    type: "fix",
    slug: "normalize-cafe-input",
  });
  assert.throws(() => deriveChangeNamingFromIssueTitle("unclassified work"));
});

class ReadTransport implements GitHubChangeEffectTransport {
  readonly calls: GitHubChangeEffectRequest[] = [];

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    this.calls.push(request);
    if (request.path.endsWith("repos/acme/inari/")) {
      return { status: 200, body: { id: 218000001, default_branch: "main" } };
    }
    if (request.path.endsWith("issues/218")) {
      return { status: 200, body: { number: 218, title: "feat: Execute Change plans safely", state: "open" } };
    }
    if (request.path.includes("git/ref/heads/feat%2F218-execute-change-plans-safely")) {
      return { status: 404, body: { message: "Not Found" } };
    }
    if (request.path.includes("pulls?state=all")) return { status: 200, body: [] };
    throw new Error("unexpected read");
  }
}

test("Actions evidence reader returns only bounded Core projection input", async () => {
  const transport = new ReadTransport();
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
  });
  const result = await reader.read(changeRemoteMutationRequest("issue", 218));

  assert.deepEqual(result.naming, {
    type: "feat",
    slug: "execute-change-plans-safely",
  });
  assert.deepEqual(result.evidence.branches, { status: "available", value: [] });
  assert.deepEqual(result.evidence.pullRequests, { status: "available", value: [] });
  assert.equal(JSON.stringify(result).includes("Not Found"), false);
});

test("App installation token is confined to the broker transport and never its scope/result", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = "installation-secret-token";
  const calls: RequestInit[] = [];
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {});
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          token,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
          repositories: [{ id: Number(target.repositoryId), full_name: target.nameWithOwner }],
        }),
        { status: 201 },
      );
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ ref: "refs/heads/feat/218-safe", object: { type: "commit", sha: "a".repeat(40) } }),
      {
        status: 201,
      },
    );
  };
  const broker = new GitHubActionsCredentialBroker({
    appId: "218",
    installationId: "219",
    privateKeyPem,
    repository,
    target,
    fetch,
  });
  const request: IssuerCredentialRequest = {
    version: 1,
    authority: "issuer",
    app: { kind: "github-app", slug: "inari-issuer", appId: "218", principal: INARI_ISSUER_PRINCIPAL },
    execution: {
      version: 1,
      runtime: "github-actions",
      event: "workflow_dispatch",
      repository: target,
      workflowRef: "refs/heads/main",
      workflowSha: "a".repeat(40),
      workflowTrust: "protected",
      codeExecution: "trusted-only",
      fork: false,
      pullRequest: false,
    },
    target,
    permissions: { contents: "write" },
  };
  let capabilityScope: unknown;
  await broker.withScopedInstallationCredential(request, async (capability) => {
    capabilityScope = capability.scope;
    await capability.apply({ kind: "CREATE_BRANCH", branch: "feat/218-safe", baseBranch: "main" });
  });
  assert.equal(JSON.stringify(capabilityScope).includes(token), false);
  assert.equal(JSON.stringify(capabilityScope).includes(privateKeyPem), false);
  assert.match(String(calls[1]?.headers && JSON.stringify(calls[1]?.headers)), /Bearer installation-secret-token/u);
});

test("API transport does not return credential-bearing headers or unbounded response data", async () => {
  const token = "read-token";
  let received: RequestInit | undefined;
  const transport = new GitHubActionsApiTransport({
    token,
    fetch: async (_input, init) => {
      received = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const result = await transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" });
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.match(JSON.stringify(received?.headers), /Bearer read-token/u);
});
