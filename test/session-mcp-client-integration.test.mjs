import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  adaptManagedRuntimeSession,
  assertDelegator,
  beginManagedRuntimeSession,
  completeManagedRuntimeSession,
  createSessionBundleSigner,
  createSessionCredentialBundle,
  generateDelegatorKeyPair,
  issueSessionCertificate,
  verifySessionRequest,
} = await tsImport("../src/agent-authority/index.ts", import.meta.url);
const { createSessionMcpClient, INARI_CHANGE_EXECUTE_TOOL_NAME } = await tsImport(
  "../src/mcp/session-client.ts",
  import.meta.url,
);

const REPOSITORY = Object.freeze({ id: "1330755860", name: "yohn-jp/gh-inari" });
const NOW = new Date("2026-09-20T04:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const REQUEST = Object.freeze({ version: 1, issue: 891 });
const OPERATION = "change.execute";

function createRuntimeAuthority(runtimeKey) {
  return assertDelegator({
    version: 1,
    kind: "runtime-authority",
    id: "session-mcp-certification",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement"],
  });
}

function createManagedSigner(runtimeKey, runtimeAuthority) {
  const begin = beginManagedRuntimeSession({
    repository: REPOSITORY,
    task: { kind: "issue", number: 891 },
    capabilities: [{ kind: "change.implement", issue: 891 }],
    ttlSeconds: 600,
  });
  const certificate = issueSessionCertificate({
    repository: REPOSITORY,
    runtimeAuthority,
    runtimeKey,
    request: begin.issuanceRequest,
    now: NOW,
  });
  const managed = completeManagedRuntimeSession({
    session: begin.session,
    issuanceRequest: begin.issuanceRequest,
    certificate,
  });
  return adaptManagedRuntimeSession(managed);
}

function createBundleSigner(runtimeKey, runtimeAuthority) {
  const created = createSessionCredentialBundle({
    request: {
      version: 1,
      kind: "inari-session-issuance-request",
      runtimeAuthority,
      repository: REPOSITORY,
      task: { kind: "issue", number: 891 },
      capabilities: [{ kind: "change.implement", issue: 891 }],
      ttlSeconds: 600,
    },
    runtimeKey,
    now: NOW,
  });
  return { created, signer: createSessionBundleSigner(created) };
}

test("managed and bundle Session profiles use one MCP handoff and verifier boundary", async () => {
  const runtimeKey = generateDelegatorKeyPair();
  const runtimeAuthority = createRuntimeAuthority(runtimeKey);
  const managedSigner = createManagedSigner(runtimeKey, runtimeAuthority);
  const { created: bundle, signer: bundleSigner } = createBundleSigner(runtimeKey, runtimeAuthority);
  const calls = [];
  const callTool = {
    async callTool(request) {
      calls.push(request);
      return { structuredContent: { accepted: true } };
    },
  };

  const managedClient = createSessionMcpClient({
    signer: managedSigner,
    callTool,
    requestId: () => "managed-mcp-request",
    now: () => NOW_SECONDS,
    ttlSeconds: 60,
  });
  const bundleClient = createSessionMcpClient({
    signer: bundleSigner,
    callTool,
    requestId: () => "bundle-mcp-request",
    now: () => NOW_SECONDS,
    ttlSeconds: 60,
  });

  const managedResult = await managedClient.execute({ request: REQUEST, operation: OPERATION });
  const bundleResult = await bundleClient.execute({ request: REQUEST, operation: OPERATION });

  assert.equal(managedResult.ok, true);
  assert.equal(bundleResult.ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.name, INARI_CHANGE_EXECUTE_TOOL_NAME);
    assert.deepEqual(Object.keys(call.arguments), ["envelope"]);
    assert.equal(verifySessionRequest(call.arguments.envelope, { now: NOW_SECONDS }).valid, true);
    assert.equal(call.arguments.envelope.operation, OPERATION);
    assert.deepEqual(call.arguments.envelope.request, REQUEST);
  }

  const substituted = {
    ...calls[1].arguments.envelope,
    certificate: calls[0].arguments.envelope.certificate,
  };
  assert.equal(verifySessionRequest(substituted, { now: NOW_SECONDS }).valid, false);

  assert.equal("privateKey" in managedSigner, false);
  assert.equal("privateKey" in bundleSigner, false);
  assert.equal("sessionPrivateKey" in bundleSigner, false);
  assert.equal("d" in managedSigner.publicKey, false);
  assert.equal("d" in bundleSigner.publicKey, false);
  const evidence = JSON.stringify(calls);
  assert.doesNotMatch(
    evidence,
    /PRIVATE KEY|sessionPrivateKey|runtimeKey|runtimeAuthority|Delegator|installation|oauth|bearer|api[_ -]?key/iu,
  );
  assert.doesNotMatch(evidence, /credential\s+bundle/iu);
  assert.equal(evidence.includes(bundle.bundle.sessionPrivateKey), false);
});
