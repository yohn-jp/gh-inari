import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalRuntimeConfig, LocalRuntimeConfigError } from "./local-runtime-config.js";

test("local Runtime configuration fails closed without exposing missing secret values", () => {
  assert.throws(
    () =>
      createLocalRuntimeConfig({
        repository: "github.com/1330755860/yohn-jp/gh-inari",
        relayUrl: "wss://relay.example.test",
        delegatorId: "runtime-authority",
        privateKeyPath: "/missing/runtime-key.pem",
        environment: {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("code" in error, true);
      assert.equal(error.message.includes("missing/runtime-key.pem"), false);
      assert.equal(error.message.includes("PRIVATE_KEY"), false);
      return true;
    },
  );
});

test("relay endpoint validation is transport-only and fail-closed", () => {
  assert.throws(
    () =>
      createLocalRuntimeConfig({
        repository: "github.com/1330755860/yohn-jp/gh-inari",
        relayUrl: "https://relay.example.test",
        delegatorId: "runtime-authority",
        privateKeyPath: "/missing/runtime-key.pem",
        environment: {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof LocalRuntimeConfigError);
      assert.equal(error.code, "LOCAL_RUNTIME_CONFIG_INVALID");
      assert.equal(error.message, "Relay endpoint must use ws or wss.");
      return true;
    },
  );
});
