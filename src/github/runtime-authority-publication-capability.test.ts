import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubChangeEffectResponse, GitHubChangeEffectTransport } from "./change-effect-adapter.js";
import {
  GitHubRuntimeAuthorityPublicationCapability,
  RuntimeAuthorityPublicationCapabilityError,
} from "./runtime-authority-publication-capability.js";

const REPOSITORY = { hostname: "github.com", owner: "acme", name: "inari", nameWithOwner: "acme/inari" } as const;
const SHA = "a".repeat(40);
/** Retired: Runtime Authority publication is not a target-repository Issue. */
const RETIRED_ISSUE_TIED_BRANCH = "feat/1066-runtime-authority-bootstrap-0123456789abcdef";
const CANONICAL_BRANCH = "inari/runtime-authority/0123456789abcdef";

function capability(
  request: (input: { readonly method: string; readonly path: string }) => Promise<GitHubChangeEffectResponse>,
): GitHubRuntimeAuthorityPublicationCapability {
  const transport: Pick<GitHubChangeEffectTransport, "request"> = {
    request: async (input) => request(input),
  };
  return new GitHubRuntimeAuthorityPublicationCapability({
    scope: {} as never,
    gitData: {} as never,
    transport,
    repository: REPOSITORY,
  });
}

test("rejects the retired Issue-tied branch format on every provider-facing operation", async () => {
  const cap = capability(async () => {
    throw new Error("must not call the provider for an invalid canonical branch");
  });
  await assert.rejects(cap.createBranch(RETIRED_ISSUE_TIED_BRANCH, SHA), RuntimeAuthorityPublicationCapabilityError);
  await assert.rejects(
    cap.compareBranch("main", RETIRED_ISSUE_TIED_BRANCH),
    RuntimeAuthorityPublicationCapabilityError,
  );
  await assert.rejects(
    cap.findPullRequests(RETIRED_ISSUE_TIED_BRANCH, "main"),
    RuntimeAuthorityPublicationCapabilityError,
  );
  await assert.rejects(
    cap.createPullRequest({ head: RETIRED_ISSUE_TIED_BRANCH, base: "main", title: "t", body: "b" }),
    RuntimeAuthorityPublicationCapabilityError,
  );
});

test("accepts only the repository-independent canonical branch identity for provider-facing operations", async () => {
  let createdRef: string | undefined;
  const cap = capability(async ({ method, path }) => {
    if (method === "POST" && path === "repos/acme/inari/git/refs") {
      createdRef = path;
      return { status: 201, body: {} };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  await cap.createBranch(CANONICAL_BRANCH, SHA);
  assert.equal(createdRef, "repos/acme/inari/git/refs");
});

test("the Issuer capability for Runtime Authority publication exposes no merge or approval operation", () => {
  const cap = capability(async () => {
    throw new Error("not reached");
  });
  const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(cap)).filter((name) => name !== "constructor");
  // The public capability contract (what `publishRuntimeAuthority` in Core is
  // typed against) is exactly this set -- no merge, approve, or review entry.
  const publicMethodNames = [
    "compareBranch",
    "createBranch",
    "createPullRequest",
    "findPullRequests",
    "getDefaultBranch",
    "readPullRequestFiles",
  ];
  for (const name of publicMethodNames) assert.ok(methodNames.includes(name), `missing ${name}`);
  for (const name of methodNames) {
    assert.doesNotMatch(name, /merge|approve|review/iu);
  }
});
