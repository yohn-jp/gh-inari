import assert from "node:assert/strict";
import { test } from "node:test";
import { runControlledCertification } from "../scripts/relay-certification.mjs";

test("relay profile certifies semantic parity and bounded transport failures", async () => {
  const report = await runControlledCertification();
  const required = [
    "cross-repository-route",
    "wrong-delegator-key",
    "capability-denial",
    "malformed-message",
    "oversized-message",
    "expired-message",
    "runtime-unavailable",
    "pre-delivery-failure",
    "disconnect-after-delivery",
    "lost-result",
    "reconnect",
    "late-result",
    "duplicate-result",
    "hibernation-reconstruction",
    "ambiguous-effect-recovery",
  ];

  assert.equal(report.profile, "relay");
  assert.equal(report.certificationStatus, "blocked");
  assert.equal(report.profiles.includes("relay"), true);
  assert.equal(report.semanticParity.status, "blocked");
  assert.equal(report.semanticParity.expected.status, "succeeded");
  assert.equal(report.semanticParity.actual.status, "failed");
  assert.equal(report.semanticParity.productionFailure.code, "RELAY_HANDSHAKE_INCOMPATIBLE");
  assert.equal(report.scenarios["cross-repository-route"].relayCode, "RELAY_SESSION_REPOSITORY_MISMATCH");
  assert.equal(report.scenarios["cross-repository-route"].dispatches, 0);
  assert.equal(report.scenarios["wrong-delegator-key"].denied, true);
  assert.equal(report.scenarios["wrong-delegator-key"].runtimeJobFrames, 0);
  assert.equal(report.scenarios["wrong-delegator-key"].sourceControl, true);
  assert.equal(report.scenarios["capability-denial"].result.outcome, "denied");
  assert.equal(report.scenarios["capability-denial"].providerExecutions, 0);
  assert.equal(report.scenarios["malformed-message"].closeCode, 1008);
  assert.equal(report.scenarios["oversized-message"].closeCode, 1009);
  assert.equal(report.scenarios["runtime-unavailable"].providerExecutions, 0);
  assert.equal(report.scenarios["pre-delivery-failure"].retryable, true);
  assert.equal(report.scenarios["expired-message"].relayCode, "RELAY_SESSION_AMBIGUOUS_DELIVERY");
  assert.equal(report.scenarios["disconnect-after-delivery"].executions, 1);
  assert.equal(report.scenarios["disconnect-after-delivery"].delivery, "possibly-delivered");
  assert.equal(report.scenarios["disconnect-after-delivery"].resultSentAfterReconnect, true);
  assert.equal(report.scenarios["lost-result"].recovery, "recovery-required");
  assert.equal(report.scenarios["lost-result"].automaticRetry, "forbidden");
  assert.equal(report.scenarios.reconnect.phase, "possibly-delivered");
  assert.equal(report.scenarios["late-result"].transition, "applied");
  assert.match(report.scenarios["late-result"].productionFailure, /late terminal result/);
  assert.equal(report.scenarios["duplicate-result"], "duplicate-result-ignored");
  assert.equal(report.scenarios["hibernation-reconstruction"].preserved, true);
  assert.equal(report.scenarios["hibernation-reconstruction"].replayFramesAfterReconstruction, 0);
  assert.equal(report.scenarios["ambiguous-effect-recovery"].result.outcome, "recovery-required");
  assert.deepEqual(Object.keys(report.scenarios).sort(), [...required].sort());
  assert.deepEqual(report.evidence, {
    bounded: true,
    secretSafe: true,
    rawProviderPayloads: false,
    transportMetadataCompared: false,
  });
  assert.equal(report.live.status, "pending");
});
