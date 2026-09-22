import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENDPOINT_CAPABILITY_KINDS,
  ENDPOINT_READ_OPERATION_CAPABILITIES,
  endpointCapabilityForOperation,
  validateEndpointCapability,
} from "./endpoint-capability.js";

test("accepts exactly the closed V1 Endpoint read-capability vocabulary", () => {
  assert.deepEqual(ENDPOINT_CAPABILITY_KINDS, ["repository.read", "work.read", "presence.read"]);
  for (const kind of ENDPOINT_CAPABILITY_KINDS) {
    const result = validateEndpointCapability({ kind });
    assert.equal(result.valid, true);
    assert.deepEqual(result.value, { kind });
  }
});

test("rejects Agent capabilities and unknown Endpoint capabilities", () => {
  for (const value of [
    { kind: "change.implement", issue: 917 },
    { kind: "pullRequest.create", head: "feature/read", base: "main", max: 1 },
    { kind: "repository.admin" },
  ]) {
    const result = validateEndpointCapability(value);
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0]?.code, "ENDPOINT_CAPABILITY_UNSUPPORTED_KIND");
  }

  assert.equal(validateEndpointCapability({ kind: "work.read", extra: true }).valid, false);
});

test("maps every V1 read operation to its exact same-named capability", () => {
  for (const operation of ENDPOINT_CAPABILITY_KINDS) {
    assert.deepEqual(ENDPOINT_READ_OPERATION_CAPABILITIES[operation], { kind: operation });
    assert.strictEqual(endpointCapabilityForOperation(operation), ENDPOINT_READ_OPERATION_CAPABILITIES[operation]);
  }
  assert.throws(() => endpointCapabilityForOperation("change.implement"), /Unsupported Endpoint read operation/);
});
