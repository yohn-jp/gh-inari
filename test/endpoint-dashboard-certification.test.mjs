import assert from "node:assert/strict";
import test from "node:test";
import { runEndpointDashboardCertification } from "../scripts/endpoint-dashboard-certification.mjs";

test("certifies the composed Endpoint and Dashboard boundary", async () => {
  const result = await runEndpointDashboardCertification();
  assert.equal(result.profile, "endpoint-dashboard");
  assert.equal(result.certificationStatus, "passed");
  assert.match(result.epicHeadSha, /^[0-9a-f]{40}$/u);
  assert.match(result.currentMainSha, /^[0-9a-f]{40}$/u);
  assert.equal(result.evidence.bounded, true);
  assert.equal(result.evidence.secretSafe, true);
  assert.equal(result.evidence.rawProviderPayloads, false);
  assert.equal(result.evidence.providerMutations, false);
});
