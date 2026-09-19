import assert from "node:assert/strict";
import { test } from "node:test";
import { runLiveCertification } from "../scripts/relay-certification.mjs";

const configuredEnvironment = Object.freeze({
  INARI_RELAY_LIVE_URL: "https://relay.example.test",
  INARI_RELAY_LIVE_REPOSITORY_ID: "1330755860",
  INARI_RELAY_LIVE_REPOSITORY_HOST: "github.com",
  INARI_RELAY_DELEGATOR_ID: "runtime-certification",
  INARI_RELAY_DELEGATOR_PRIVATE_KEY: "fixture-private-key-must-not-be-retained",
});

const passedTransport = Object.freeze({
  async healthz() {
    return {
      httpStatus: 200,
      ok: true,
      service: "gh-inari-hosted-relay-worker",
      transport: "mcp-and-repository-relay",
    };
  },
  async mcp() {
    return { httpStatus: 200, jsonrpc: "2.0", serverName: "inari" };
  },
  async relay() {
    return {
      upgrade: true,
      possessionHandshake: true,
      connected: true,
      heartbeat: true,
      boundedMalformedFrame: true,
      malformedFrameCloseCode: 1008,
    };
  },
});

test("live certification is pending when deployment configuration is incomplete", async () => {
  const report = await runLiveCertification({ environment: {} });

  assert.equal(report.certificationStatus, "pending");
  assert.equal(report.live.status, "pending");
  assert.equal(report.live.evidence.contactedDeployment, false);
});

test("configured live transport failures are failed, not pending", async () => {
  const report = await runLiveCertification({
    environment: configuredEnvironment,
    transport: {
      async healthz() {
        throw new Error("fixture transport failure");
      },
    },
  });

  assert.equal(report.certificationStatus, "failed");
  assert.equal(report.live.status, "failed");
  assert.equal(report.live.failure.stage, "healthz");
  assert.equal(report.live.evidence.contactedDeployment, false);
  assert.doesNotMatch(JSON.stringify(report), /fixture-private-key/u);
});

test("only a complete live runner sequence is classified as passed", async () => {
  const report = await runLiveCertification({ environment: configuredEnvironment, transport: passedTransport });

  assert.equal(report.certificationStatus, "passed");
  assert.equal(report.live.status, "passed");
  assert.equal(report.live.evidence.contactedDeployment, false);
  assert.equal(report.live.evidence.transport, "injected-test-transport");
  assert.deepEqual(report.live.evidence.checks.relay, {
    upgrade: true,
    possessionHandshake: true,
    connected: true,
    heartbeat: true,
    boundedMalformedFrame: true,
    malformedFrameCloseCode: 1008,
  });
  assert.doesNotMatch(JSON.stringify(report), /fixture-private-key/u);
});
