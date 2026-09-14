import assert from "node:assert/strict";
import { test } from "node:test";
import { changeReadRequest } from "../change-execution-port.js";
import { GitHubActionsEvidenceReader } from "./actions-change-executor.js";
import { GitHubChangeStateProjector } from "./change-state-projector.js";
import type { GitHubAppRepositoryReadTransport } from "./app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "./change-effect-adapter.js";

const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const IDENTITY = { repositoryHost: "github.com", repositoryId: "1", rootIssue: 42 } as const;
const BRANCH = "feat/42-shared-projection";

function transport(): GitHubAppRepositoryReadTransport {
  return {
    request: async (request) => {
      if (request.path === "repos/acme/inari") {
        return { status: 200, body: { id: 1, default_branch: "main" } };
      }
      if (request.path === "repos/acme/inari/issues/42") {
        return { status: 200, body: { number: 42, title: "feat: Shared projection", state: "open" } };
      }
      if (request.path === `repos/acme/inari/git/ref/heads/${encodeURIComponent(BRANCH)}`) {
        return { status: 404, body: {} };
      }
      if (request.path === "repos/acme/inari/git/matching-refs/heads/") {
        return { status: 200, body: [] };
      }
      if (request.path.startsWith("repos/acme/inari/pulls?state=all&head=")) {
        return { status: 200, body: [] };
      }
      throw new Error(`unexpected provider request: ${request.path}`);
    },
  };
}

test("Actions compatibility and Direct App composition share the same semantic projection", async () => {
  const request = changeReadRequest(42);
  const actions = new GitHubActionsEvidenceReader({
    repository: REPOSITORY,
    identity: IDENTITY,
    transport: transport(),
  });
  const directApp = new GitHubChangeStateProjector({
    repository: REPOSITORY,
    identity: IDENTITY,
    transport: transport(),
  });

  assert.deepEqual(await actions.read(request), await directApp.read(request));
});
