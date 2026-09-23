import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRuntimeAuthorityPublicationHttpHandler,
  RUNTIME_AUTHORITY_PUBLICATION_HTTP_PATH,
  type RuntimeAuthorityPublicationPublisher,
} from "./runtime-authority-publication-http.js";
import type { RuntimeAuthorityPublicationResult } from "../runtime-authority-publication.js";

const ENDPOINT = `https://issuer.example.com${RUNTIME_AUTHORITY_PUBLICATION_HTTP_PATH}`;
const RESULT: RuntimeAuthorityPublicationResult = Object.freeze({
  status: "created",
  authorityId: "runtime-example",
  branch: "inari/runtime-authority/0123456789abcdef",
  pullRequest: Object.freeze({ number: 1, url: "https://github.com/acme/inari/pull/1" }),
});

function request(
  body: unknown,
  init: { readonly method?: string; readonly contentType?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (init.contentType !== null) headers["content-type"] = init.contentType ?? "application/json";
  return new Request(ENDPOINT, {
    method: init.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("publishes only the received request through the injected publisher and returns the bounded result", async () => {
  let received: unknown;
  const publisher: RuntimeAuthorityPublicationPublisher = {
    publish: async (input) => {
      received = input;
      return RESULT;
    },
  };
  const handler = createRuntimeAuthorityPublicationHttpHandler({ publisher });
  const response = await handler(request({ version: 1, authority: { id: "runtime-example" } }));

  assert.equal(response.status, 200);
  const body = (await response.json()) as { readonly ok: boolean; readonly result: unknown };
  assert.equal(body.ok, true);
  assert.deepEqual(body.result, RESULT);
  assert.deepEqual(received, { version: 1, authority: { id: "runtime-example" } });
});

test("rejects a request on the wrong path or method before invoking the publisher", async () => {
  let calls = 0;
  const publisher: RuntimeAuthorityPublicationPublisher = { publish: async () => ((calls += 1), RESULT) };
  const handler = createRuntimeAuthorityPublicationHttpHandler({ publisher });

  const wrongPath = await handler(new Request("https://issuer.example.com/v1/execute", { method: "POST" }));
  assert.equal(wrongPath.status, 404);

  const wrongMethod = await handler(new Request(ENDPOINT, { method: "GET" }));
  assert.equal(wrongMethod.status, 405);

  assert.equal(calls, 0);
});

test("rejects a non-JSON content type before invoking the publisher", async () => {
  let calls = 0;
  const publisher: RuntimeAuthorityPublicationPublisher = { publish: async () => ((calls += 1), RESULT) };
  const handler = createRuntimeAuthorityPublicationHttpHandler({ publisher });

  const response = await handler(request({ version: 1 }, { contentType: "text/plain" }));

  assert.equal(response.status, 415);
  assert.equal(calls, 0);
});

test("rejects a request body over the configured bound before invoking the publisher", async () => {
  let calls = 0;
  const publisher: RuntimeAuthorityPublicationPublisher = { publish: async () => ((calls += 1), RESULT) };
  const handler = createRuntimeAuthorityPublicationHttpHandler({ publisher, maxBodyBytes: 16 });

  const response = await handler(request({ version: 1, authority: { id: "too-large-for-the-bound" } }));

  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test("maps every publisher failure to one bounded, non-leaking error response", async () => {
  const publisher: RuntimeAuthorityPublicationPublisher = {
    publish: async () => {
      throw new Error("internal detail must never leak: access-secret");
    },
  };
  const handler = createRuntimeAuthorityPublicationHttpHandler({ publisher });

  const response = await handler(request({ version: 1 }));

  assert.equal(response.status, 400);
  const text = await response.text();
  assert.doesNotMatch(text, /access-secret/u);
  const body = JSON.parse(text) as { readonly ok: boolean; readonly error: { readonly code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "RUNTIME_AUTHORITY_PUBLICATION_FAILED");
});

test("this transport never exposes a merge or approval capability", () => {
  const publisher: RuntimeAuthorityPublicationPublisher = { publish: async () => RESULT };
  const handler = createRuntimeAuthorityPublicationHttpHandler({ publisher });
  // The returned handler is one function -- request in, response out. There
  // is no additional operation to invoke a merge or approval, unlike a
  // governed PR surface that exposes one.
  assert.equal(typeof handler, "function");
  assert.equal(handler.length, 1);
});
