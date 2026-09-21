import assert from "node:assert/strict";
import test from "node:test";
import { GitHubAppDeviceFlowClient, GitHubAppUserCredentialError } from "./app-user-credential.js";

const NOW = new Date("2026-09-21T00:00:00.000Z");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Device Flow handles pending and slow-down before returning opaque credential metadata", async () => {
  const requests: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
  const waits: number[] = [];
  let polls = 0;
  const client = new GitHubAppDeviceFlowClient({
    clientId: "client-id",
    now: () => NOW,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetch: (async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), body });
      if (String(input).endsWith("/login/device/code")) {
        return json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 600,
          interval: 2,
        });
      }
      polls += 1;
      if (polls === 1) return json({ error: "authorization_pending" });
      if (polls === 2) return json({ error: "slow_down" });
      return json({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        token_type: "bearer",
        expires_in: 3_600,
        refresh_token_expires_in: 15_552_000,
      });
    }) as typeof globalThis.fetch,
  });

  const credential = await client.authorize();
  assert.deepEqual(credential.metadata, {
    accessTokenExpiresAt: "2026-09-21T01:00:00.000Z",
    refreshTokenExpiresAt: "2027-03-20T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(credential.metadata).includes("secret"), false);
  assert.deepEqual(waits, [2_000, 7_000]);
  assert.equal(requests[0]?.url, "https://github.com/login/device/code");
  assert.equal(requests[1]?.url, "https://github.com/login/oauth/access_token");
});

test("Device Flow refresh rotates credentials without a client secret", async () => {
  const requests: Record<string, unknown>[] = [];
  const client = new GitHubAppDeviceFlowClient({
    clientId: "client-id",
    now: () => NOW,
    fetch: (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        token_type: "bearer",
        expires_in: 3_600,
        refresh_token_expires_in: 15_552_000,
      });
    }) as typeof globalThis.fetch,
  });
  const original = await client.refresh(
    // The opaque constructor is intentionally used only in this credential-bound test fixture.
    new (await import("./app-user-credential.js")).GitHubAppUserCredential({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: "2026-09-21T00:00:01.000Z",
      refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
    }),
  );
  assert.equal(original.metadata.accessTokenExpiresAt, "2026-09-21T01:00:00.000Z");
  assert.equal(requests[0]?.client_id, "client-id");
  assert.equal(requests[0]?.grant_type, "refresh_token");
  assert.equal(requests[0]?.refresh_token, "old-refresh");
  assert.equal(Object.prototype.hasOwnProperty.call(requests[0] ?? {}, "client_secret"), false);
});

test("Device Flow provider failures are bounded and redact response secrets", async () => {
  const client = new GitHubAppDeviceFlowClient({
    clientId: "client-id",
    fetch: (async () => json({ error: "secret-token-value" }, 401)) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => client.requestDeviceCode(),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAppUserCredentialError);
      assert.equal(String(error).includes("secret-token-value"), false);
      return error.reason === "provider";
    },
  );
});
