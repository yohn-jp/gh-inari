import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENDPOINT_ONBOARDING_APP_USER_AUTH_PROFILE,
  ENDPOINT_ONBOARDING_DESCRIPTOR_VERSION,
  EndpointOnboardingDescriptorError,
  createEndpointOnboardingDescriptor,
  decodeEndpointOnboardingDescriptor,
  encodeEndpointOnboardingDescriptor,
} from "./endpoint-onboarding.js";

const input = {
  githubHost: "github.com",
  appId: "123456",
  appClientId: "Iv1.public-client",
  appSlug: "inari",
  appInstallationUrl: "https://github.com/apps/inari/installations/new",
  appUserAuthProfile: ENDPOINT_ONBOARDING_APP_USER_AUTH_PROFILE,
  relayConnectionBase: "wss://hosted.example/v1/relay/connect",
} as const;

test("endpoint onboarding descriptor is versioned, bounded, and secret-free", () => {
  const descriptor = createEndpointOnboardingDescriptor(input);
  assert.deepEqual(descriptor, { version: ENDPOINT_ONBOARDING_DESCRIPTOR_VERSION, ...input });
  assert.equal("repositoryId" in descriptor, false);
  assert.equal("credential" in descriptor, false);
  assert.deepEqual(decodeEndpointOnboardingDescriptor(encodeEndpointOnboardingDescriptor(descriptor)), descriptor);
});

test("endpoint onboarding decoder rejects unknown version and fields", () => {
  assert.throws(
    () => decodeEndpointOnboardingDescriptor({ version: 2, ...input }),
    (error: unknown) =>
      error instanceof EndpointOnboardingDescriptorError && error.code === "ENDPOINT_ONBOARDING_UNSUPPORTED_VERSION",
  );
  assert.throws(
    () => decodeEndpointOnboardingDescriptor({ version: 1, ...input, repositoryId: "1330755860" }),
    (error: unknown) =>
      error instanceof EndpointOnboardingDescriptorError && error.code === "ENDPOINT_ONBOARDING_UNKNOWN_FIELD",
  );
});

test("endpoint onboarding decoder rejects unbounded text and invalid URLs", () => {
  assert.throws(
    () => createEndpointOnboardingDescriptor({ ...input, appClientId: "x".repeat(129) }),
    (error: unknown) =>
      error instanceof EndpointOnboardingDescriptorError && error.code === "ENDPOINT_ONBOARDING_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => createEndpointOnboardingDescriptor({ ...input, appInstallationUrl: "http://github.com/apps/inari" }),
    (error: unknown) =>
      error instanceof EndpointOnboardingDescriptorError && error.code === "ENDPOINT_ONBOARDING_INVALID_URL",
  );
  assert.throws(
    () =>
      createEndpointOnboardingDescriptor({
        ...input,
        relayConnectionBase: "https://relay.example/connect?backend=other",
      }),
    (error: unknown) =>
      error instanceof EndpointOnboardingDescriptorError && error.code === "ENDPOINT_ONBOARDING_INVALID_URL",
  );
});
