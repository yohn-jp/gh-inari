import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base64UrlDecodeToBytes,
  base64UrlDecodeToText,
  base64UrlEncodeBytes,
  base64UrlEncodeText,
  canonicalJsonString,
  isBase64UrlText,
} from "./codec.js";

test("canonicalJsonString sorts object keys by UTF-16 code unit order", () => {
  assert.equal(canonicalJsonString({ b: 1, a: 2, ab: 3 }), '{"a":2,"ab":3,"b":1}');
});

test("canonicalJsonString is stable across key insertion order", () => {
  const first = canonicalJsonString({ ver: 1, iss: "runtime:x", jti: "y" });
  const second = canonicalJsonString({ jti: "y", ver: 1, iss: "runtime:x" });
  assert.equal(first, second);
});

test("canonicalJsonString serializes nested arrays and objects deterministically", () => {
  assert.equal(
    canonicalJsonString({ capabilities: [{ kind: "change.implement", issue: 364 }] }),
    '{"capabilities":[{"issue":364,"kind":"change.implement"}]}',
  );
});

test("canonicalJsonString escapes strings using ECMAScript-compatible JSON escaping", () => {
  assert.equal(canonicalJsonString('a"b\\c\n'), JSON.stringify('a"b\\c\n'));
});

test("canonicalJsonString rejects fractional, non-finite, and -0 numbers", () => {
  assert.throws(() => canonicalJsonString(1.5));
  assert.throws(() => canonicalJsonString(Number.NaN));
  assert.throws(() => canonicalJsonString(Number.POSITIVE_INFINITY));
  assert.throws(() => canonicalJsonString(-0));
  assert.throws(() => canonicalJsonString(Number.MAX_SAFE_INTEGER + 1));
});

test("canonicalJsonString rejects excessive nesting depth", () => {
  let value: unknown = 1;
  for (let depth = 0; depth < 40; depth += 1) value = [value];
  assert.throws(() => canonicalJsonString(value as never));
});

test("base64url codec round-trips text and bytes without padding", () => {
  const text = "runtime:yohn-local-runtime-2026-09";
  const encoded = base64UrlEncodeText(text);
  assert.ok(!encoded.includes("="));
  assert.equal(base64UrlDecodeToText(encoded), text);

  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const encodedBytes = base64UrlEncodeBytes(bytes);
  assert.deepEqual([...base64UrlDecodeToBytes(encodedBytes)], [...bytes]);
});

test("base64url decode rejects padded or non-base64url text", () => {
  assert.throws(() => base64UrlDecodeToBytes("abc="));
  assert.throws(() => base64UrlDecodeToBytes("abc+/"));
  assert.equal(isBase64UrlText("abc="), false);
  assert.equal(isBase64UrlText("abc-_9"), true);
});
