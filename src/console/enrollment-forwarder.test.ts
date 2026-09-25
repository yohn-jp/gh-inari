import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Readable } from "node:stream";
import { enrollmentUpload } from "./enrollment-forwarder.js";
import type { IncomingMessage } from "node:http";
test("opaque upload preserves bytes and enforces declared length", async () => {
  const request = Object.assign(Readable.from([Buffer.from([0, 255, 1])]), {
    headers: { "content-length": "3" },
  }) as IncomingMessage;
  const upload = enrollmentUpload(request);
  assert.equal(upload.declaredBytes, 3);
  const parts: Uint8Array[] = [];
  for await (const part of upload.stream) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), Buffer.from([0, 255, 1]));
  const overflow = Object.assign(Readable.from([Buffer.alloc(4)]), {
    headers: { "content-length": "3" },
  }) as IncomingMessage;
  await assert.rejects(async () => {
    for await (const _ of enrollmentUpload(overflow).stream) void _;
  });
  const oversized = Object.assign(Readable.from([]), { headers: { "content-length": "65537" } }) as IncomingMessage;
  assert.throws(() => enrollmentUpload(oversized));
});
