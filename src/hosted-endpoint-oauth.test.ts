import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostedEndpointOAuthHandler, HOSTED_ENDPOINT_OAUTH_EXCHANGE_PATH } from "./hosted-endpoint-oauth.js";

const redirectUri = "https://dashboard.example.test/oauth/callback";
const origin = "https://dashboard.example.test";
const verifier = "a".repeat(43);
const serverSecret = "s".repeat(32);

function handler(
  fetcher: typeof globalThis.fetch = async () => new Response("unused"),
): ReturnType<typeof createHostedEndpointOAuthHandler> {
  return createHostedEndpointOAuthHandler({
    clientId: "public-client",
    clientSecret: serverSecret,
    redirectUri,
    fetch: fetcher,
  });
}

function request(body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://dashboard.example.test${HOSTED_ENDPOINT_OAUTH_EXCHANGE_PATH}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

test("Hosted OAuth exchange sends the server secret and returns only a short-lived token", async () => {
  let outgoing: RequestInit | undefined;
  const exchange = handler(async (_input, init) => {
    outgoing = init;
    return new Response(
      JSON.stringify({
        access_token: "ghu-browser-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "never-returned",
      }),
      { status: 200 },
    );
  });
  const response = await exchange(request({ code: "one-code", codeVerifier: verifier, redirectUri }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.accessToken, "ghu-browser-token");
  assert.equal(typeof body.expiresAt, "number");
  assert.deepEqual(Object.keys(body).sort(), ["accessToken", "expiresAt"]);
  const params = new URLSearchParams(String(outgoing?.body));
  assert.equal(params.get("client_id"), "public-client");
  assert.equal(params.get("client_secret"), serverSecret);
  assert.equal(params.get("code_verifier"), verifier);
  assert.equal(JSON.stringify(body).includes(serverSecret), false);
  assert.equal(JSON.stringify(body).includes("never-returned"), false);
});

test("Hosted OAuth exchange rejects wrong origin, redirect, method, and malformed provider responses", async () => {
  let calls = 0;
  const exchange = handler(async () => {
    calls += 1;
    return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
  });
  assert.equal(
    (
      await exchange(
        request(
          { code: "c", codeVerifier: verifier, redirectUri },
          {
            headers: { origin: "https://attacker.example", "content-type": "application/json" },
          },
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (await exchange(request({ code: "c", codeVerifier: verifier, redirectUri: "https://other.example/callback" })))
      .status,
    403,
  );
  assert.equal(
    (await exchange(new Request(`https://dashboard.example.test${HOSTED_ENDPOINT_OAUTH_EXCHANGE_PATH}`))).status,
    405,
  );
  const malformed = handler(
    async () => new Response(JSON.stringify({ error: "bad", refresh_token: "secret" }), { status: 200 }),
  );
  const malformedResponse = await malformed(request({ code: "c", codeVerifier: verifier, redirectUri }));
  assert.equal(malformedResponse.status, 502);
  assert.equal(calls, 0);
  assert.equal((await malformedResponse.text()).includes("secret"), false);
});
