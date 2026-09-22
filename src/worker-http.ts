/**
 * Small HTTP response helpers shared by the two Cloudflare Worker
 * entrypoints (`worker.ts` direct-App and `hosted-worker.ts` hosted-relay).
 * Deployment/composition, routing, and authority all remain owned by each
 * Worker; this module owns none of that, only response shape.
 */

/** JSON response with the two headers every Worker JSON reply in this repo sets. */
export function jsonResponse(status: number, body: object, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

/** Plain-text 405 with the required `Allow` header. */
export function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed.", { status: 405, headers: { allow, "cache-control": "no-store" } });
}

/** Parse a request URL's pathname without throwing on a malformed URL. */
export function safePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}
