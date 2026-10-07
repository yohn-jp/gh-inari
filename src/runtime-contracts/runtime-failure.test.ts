import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFailure, runtimeFailureFromError } from "./runtime-failure.js";

const broker = (stage: string, providerFailure?: unknown) =>
  Object.assign(new Error("failed closed"), { code: "GITHUB_APP_CREDENTIAL_BROKER_FAILED", stage, providerFailure });

test("#1180 a retryable provider outage at installation-token is unavailable, not a binding mismatch", () => {
  const outage = runtimeFailureFromError(
    broker("installation-token", { failureClass: "server", retryable: true, status: 503 }),
    "repository-resolution",
  );
  assert.equal(outage.reason, "GITHUB_APP_PROVIDER_UNAVAILABLE");
  assert.equal(outage.category, "unavailable");
  // A non-retryable refusal of the token stays a binding mismatch.
  const refused = runtimeFailureFromError(
    broker("installation-token", { failureClass: "authentication", retryable: false, status: 401 }),
    "repository-resolution",
  );
  assert.equal(refused.reason, "GITHUB_APP_INSTALLATION_TOKEN_FAILED");
  assert.equal(refused.category, "binding-mismatch");
  assert.equal(
    runtimeFailureFromError(broker("installation-token"), "repository-resolution").category,
    "binding-mismatch",
  );
});

test("#1372 Executor deadlines have fixed bounded reasons, including unknown dispatched outcomes", () => {
  const request = runtimeFailure("trust-evidence", "EXECUTOR_REQUEST_TIMEOUT");
  assert.equal(request.category, "unavailable");
  assert.match(request.message, /bounded deadline/u);

  const execution = runtimeFailure("provider-execution", "EXECUTOR_EXECUTION_TIMEOUT");
  assert.equal(execution.category, "unavailable");
  assert.match(execution.message, /deadline/u);
  assert.match(execution.message, /outcome is unknown/u);
  assert.match(execution.message, /may have completed/u);
});
