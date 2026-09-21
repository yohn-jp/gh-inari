import assert from "node:assert/strict";
import { test } from "node:test";
import {
  tryAdaptIntegrationRouting,
  tryProjectIntegrationRoutingAdapter,
  tryValidateIntegrationRouting,
} from "./integration-routing-adapters.js";

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" } as const;
const implementation = { ...repository, number: 700 } as const;
const sourceIssue = { ...repository, number: 680 } as const;
const epic = { ...repository, number: 640 } as const;

function route(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "integration-routing",
    mode: "issue-integration",
    role: "implementation",
    implementation,
    sourceIssue,
    epic,
    relationships: { implementationParent: sourceIssue, sourceIssueParent: epic },
    branches: {
      default: "main",
      implementation: "feat/700-routing",
      issue: "issue/680-routing",
      epic: "epic/640-routing",
    },
    head: "feat/700-routing",
    base: "issue/680-routing",
    ...overrides,
  };
}

test("CLI/MCP adapter envelopes delegate to one Core routing result", () => {
  const direct = tryAdaptIntegrationRouting(route());
  const wrapped = tryAdaptIntegrationRouting({ routing: route() });
  const inputWrapped = tryAdaptIntegrationRouting({ input: route() });
  assert.equal(direct.valid, true);
  assert.deepEqual(wrapped, direct);
  assert.deepEqual(inputWrapped, direct);
  assert.deepEqual(tryProjectIntegrationRoutingAdapter(route()), direct);
  assert.deepEqual(tryValidateIntegrationRouting(route()), direct);
});

test("adapter preserves Core mismatch diagnostics and rejects invalid routes", () => {
  const result = tryAdaptIntegrationRouting({ routing: route({ base: "epic/640-routing" }) });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "INTEGRATION_ROUTING_BASE_MISMATCH"));
});
