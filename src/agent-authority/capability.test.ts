import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capabilityClaimIssueNumber,
  capabilityClaimWithinCeiling,
  isCapabilityKind,
  validateCapabilityClaim,
  type CapabilityClaim,
} from "./capability.js";

test("accepts a change.implement claim", () => {
  const result = validateCapabilityClaim({ kind: "change.implement", issue: 364 });
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, { kind: "change.implement", issue: 364 });
});

test("accepts a branch.create claim bound to exactly one branch", () => {
  const result = validateCapabilityClaim({
    kind: "branch.create",
    branch: "feat/367-runtime-session-certificate-schemas",
    max: 1,
  });
  assert.equal(result.valid, true);
});

test("accepts a branch.advance claim with an optional pathPolicy", () => {
  const result = validateCapabilityClaim({
    kind: "branch.advance",
    branch: "feat/367-runtime-session-certificate-schemas",
    pathPolicy: "src/**",
  });
  assert.equal(result.valid, true);
});

test("accepts a pullRequest.create claim targeting the canonical base", () => {
  const result = validateCapabilityClaim({
    kind: "pullRequest.create",
    head: "feat/367-runtime-session-certificate-schemas",
    base: "main",
    max: 1,
  });
  assert.equal(result.valid, true);
});

test("rejects raw GitHub provider permissions as a capability kind", () => {
  const result = validateCapabilityClaim({ kind: "contents:write" });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "CAPABILITY_UNSUPPORTED_KIND"));
  assert.equal(isCapabilityKind("contents:write"), false);
  assert.equal(isCapabilityKind("pull_requests:write"), false);
});

test("rejects a change claim with a non-positive or non-integer issue", () => {
  assert.equal(validateCapabilityClaim({ kind: "change.implement", issue: 0 }).valid, false);
  assert.equal(validateCapabilityClaim({ kind: "change.implement", issue: -1 }).valid, false);
  assert.equal(validateCapabilityClaim({ kind: "change.implement", issue: 1.5 }).valid, false);
  assert.equal(validateCapabilityClaim({ kind: "change.implement", issue: "364" }).valid, false);
});

test("rejects branch.create with a non-canonical branch name", () => {
  const result = validateCapabilityClaim({ kind: "branch.create", branch: "main", max: 1 });
  assert.equal(result.valid, false);
});

test("rejects branch.create/pullRequest.create with max other than 1", () => {
  assert.equal(validateCapabilityClaim({ kind: "branch.create", branch: "feat/1-x", max: 2 }).valid, false);
  assert.equal(
    validateCapabilityClaim({ kind: "pullRequest.create", head: "feat/1-x", base: "main", max: 0 }).valid,
    false,
  );
});

test("rejects an unknown property on any claim shape", () => {
  const result = validateCapabilityClaim({ kind: "change.implement", issue: 364, scope: "*" });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "CAPABILITY_UNKNOWN_PROPERTY"));
});

test("capabilityClaimWithinCeiling enforces the Runtime ceiling intersection", () => {
  const claim: CapabilityClaim = { kind: "change.ready", issue: 364 };
  assert.equal(capabilityClaimWithinCeiling(claim, ["change.implement", "change.ready"]), true);
  assert.equal(capabilityClaimWithinCeiling(claim, ["change.implement"]), false);
});

test("capabilityClaimIssueNumber only applies to change.* claims", () => {
  assert.equal(capabilityClaimIssueNumber({ kind: "change.abort", issue: 12 }), 12);
  assert.equal(capabilityClaimIssueNumber({ kind: "branch.create", branch: "feat/1-x", max: 1 }), undefined);
});
