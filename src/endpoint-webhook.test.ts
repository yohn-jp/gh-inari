import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  type EndpointIdentity,
  type EndpointInstallationIdentity,
  type EndpointRepositoryIdentity,
} from "./endpoint-authorization.js";
import {
  ENDPOINT_WEBHOOK_CONTRACT_VERSION,
  EndpointWebhookReplayGuard,
  admitEndpointWebhook,
  createEndpointWebhookHandler,
  handoffEndpointWebhookHint,
  verifyGitHubWebhookSignature,
} from "./endpoint-webhook.js";
import { createEndpointObservation } from "./endpoint-reconciliation.js";

const secret = "webhook-test-secret";
const endpoint: EndpointIdentity = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "endpoint",
  id: "shared-prod",
  deployment: "shared-hosted",
};
const installation: EndpointInstallationIdentity = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "installation",
  endpointId: endpoint.id,
  installationId: "9001",
};
const repository: EndpointRepositoryIdentity = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "repository",
  endpointId: endpoint.id,
  installationId: installation.installationId,
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "yohn-jp/gh-inari",
};

const payload = JSON.stringify({
  action: "completed",
  installation: { id: 9001 },
  repository: { id: 1330755860, full_name: "yohn-jp/gh-inari" },
  state: "ignored",
});

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body) as unknown as BufferSource),
  );
  return "sha256=" + [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    secret,
    endpoint,
    installation,
    repositories: [repository],
    now: "2026-09-22T00:00:00.000Z",
    replay: new EndpointWebhookReplayGuard(),
    ...overrides,
  };
}

function delivery(id = "delivery-1", body = payload, overrides: Record<string, unknown> = {}) {
  return {
    body,
    signature: "pending",
    deliveryId: id,
    event: "repository",
    occurredAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

test("verifies GitHub HMAC without accepting malformed signatures", async () => {
  const valid = await signature(payload);
  assert.equal(await verifyGitHubWebhookSignature(secret, payload, valid), true);
  assert.equal(await verifyGitHubWebhookSignature(secret, payload, valid.slice(0, -1) + "0"), false);
  assert.equal(await verifyGitHubWebhookSignature(secret, payload, "sha256=secret"), false);
});

test("valid signature is necessary but endpoint, installation, and repository admission remain closed", async () => {
  const signed = await signature(payload);
  const first = await admitEndpointWebhook({ ...delivery(), signature: signed }, options());
  assert.equal(first.version, ENDPOINT_WEBHOOK_CONTRACT_VERSION);
  assert.equal(first.classification, "admitted");
  assert.equal(first.admitted, true);
  assert.deepEqual(first.hint, {
    id: "delivery-1",
    occurredAt: "2026-09-22T00:00:00.000Z",
    endpointId: endpoint.id,
    installationId: installation.installationId,
    repositoryId: repository.repositoryId,
  });
  const crossRepository = JSON.stringify({
    installation: { id: 9001 },
    repository: { id: 7, full_name: "other/repository" },
  });
  const rejected = await admitEndpointWebhook(
    { ...delivery("delivery-2", crossRepository), signature: await signature(crossRepository) },
    options(),
  );
  assert.equal(rejected.classification, "rejected");
  assert.equal(rejected.admitted, false);
  assert.equal(rejected.diagnostics[0]?.code, "ENDPOINT_WEBHOOK_REPOSITORY_UNBOUND");
});

test("duplicate, retry, replay, and stale classifications are deterministic", async () => {
  const replay = new EndpointWebhookReplayGuard();
  const signed = await signature(payload);
  const base = options({ replay });
  assert.equal((await admitEndpointWebhook({ ...delivery(), signature: signed }, base)).classification, "admitted");
  assert.equal((await admitEndpointWebhook({ ...delivery(), signature: signed }, base)).classification, "duplicate");
  assert.equal(
    (await admitEndpointWebhook({ ...delivery("delivery-1", payload, { retry: true }), signature: signed }, base))
      .classification,
    "retry",
  );
  const changed = JSON.stringify({
    installation: { id: 9001 },
    repository: { id: 1330755860, full_name: "yohn-jp/gh-inari" },
    changed: true,
  });
  assert.equal(
    (await admitEndpointWebhook({ ...delivery("delivery-1", changed), signature: await signature(changed) }, base))
      .classification,
    "replay",
  );
  const old = await admitEndpointWebhook(
    { ...delivery("delivery-old"), signature: signed, occurredAt: "2026-09-21T23:00:00.000Z" },
    options({ replay: new EndpointWebhookReplayGuard(), maxAgeMs: 60_000 }),
  );
  assert.equal(old.classification, "stale");
});

test("admitted delivery hands off only a reconciliation hint", async () => {
  const signed = await signature(payload);
  const result = await admitEndpointWebhook({ ...delivery(), signature: signed }, options());
  const initial = createEndpointObservation({ key: "github.com:1330755860" });
  const reconciled = handoffEndpointWebhookHint(initial, result);
  assert.equal(reconciled.state, "reconciling");
  assert.equal(reconciled.authoritative, null);
  assert.deepEqual(reconciled.pendingHints, [{ id: "delivery-1", occurredAt: "2026-09-22T00:00:00.000Z" }]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("host-style handler is bounded, method-limited, and never returns secret material", async () => {
  const signed = await signature(payload);
  const handler = createEndpointWebhookHandler({ admission: options() });
  assert.equal((await handler(new Request("https://hosted.example/v1/webhooks/github"))).status, 405);
  const response = await handler(
    new Request("https://hosted.example/v1/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signed,
        "x-github-delivery": "delivery-handler",
        "x-github-event": "repository",
      },
      body: payload,
    }),
  );
  assert.equal(response.status, 202);
  const output = await response.text();
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('"state"'), false);
});
