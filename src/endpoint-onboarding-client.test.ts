import assert from "node:assert/strict";
import { test } from "node:test";
import { createEndpointOnboardingDescriptor } from "./endpoint-onboarding.js";
import { EndpointOnboardingClientError, fetchEndpointOnboardingDescriptor } from "./endpoint-onboarding-client.js";

const descriptor = createEndpointOnboardingDescriptor({
  githubHost: "github.com",
  appId: "42",
  appClientId: "public-client",
  appSlug: "inari",
  appInstallationUrl: "https://github.com/apps/inari/installations/new",
  appUserAuthProfile: "device-flow",
  relayConnectionBase: "wss://relay.example.test/connect",
});

test("Endpoint onboarding client consumes only the public descriptor", async () => {
  let requested = "";
  const result = await fetchEndpointOnboardingDescriptor({
    endpoint: "https://endpoint.example.test/",
    fetch: (async (input) => {
      requested = String(input);
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  assert.deepEqual(result, descriptor);
  assert.equal(requested, "https://endpoint.example.test/.well-known/inari");
});

test("Endpoint onboarding client rejects non-success and malformed metadata safely", async () => {
  await assert.rejects(
    () =>
      fetchEndpointOnboardingDescriptor({
        endpoint: "https://endpoint.example.test",
        fetch: (async () => new Response("no", { status: 404 })) as typeof globalThis.fetch,
      }),
    (error: unknown) =>
      error instanceof EndpointOnboardingClientError && error.code === "ENDPOINT_ONBOARDING_REQUEST_FAILED",
  );
  await assert.rejects(
    () =>
      fetchEndpointOnboardingDescriptor({
        endpoint: "https://endpoint.example.test",
        fetch: (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch,
      }),
    (error: unknown) =>
      error instanceof EndpointOnboardingClientError && error.code === "ENDPOINT_ONBOARDING_RESPONSE_INVALID",
  );
});
