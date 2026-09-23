/** Secret-free HTML status projection for a loopback local Runtime service. */

export interface LocalRuntimeStatusPageInput {
  readonly component: "admission" | "executor";
  readonly id: string;
  readonly readiness: "ready" | "not-ready";
  readonly endpoint: string;
  readonly pinnedPeer?: { readonly component: "admission" | "executor"; readonly id: string };
}

export function isLocalRuntimeLoopbackAddress(address: string | undefined): boolean {
  if (address === "127.0.0.1" || address === "::1") return true;
  const ipv4Mapped = address?.startsWith("::ffff:") === true ? address.slice(7) : address;
  const parts = ipv4Mapped?.split(".").map(Number);
  return (
    parts !== undefined &&
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 127
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Render only explicitly selected operational fields; never serialize config or Session records. */
export function createLocalRuntimeStatusPage(input: LocalRuntimeStatusPageInput): Response {
  const componentName = input.component === "admission" ? "Admission" : "Executor";
  const identityLabel = input.component === "admission" ? "Admission identity" : "Executor identity";
  const peer = input.pinnedPeer;
  const peerRow =
    peer === undefined
      ? ""
      : ["        <dt>Pinned peer</dt><dd>", escapeHtml(peer.component), " ", escapeHtml(peer.id), "</dd>"].join("");
  const body = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <meta name="robots" content="noindex, nofollow">',
    "    <title>Local " + componentName + " status</title>",
    "  </head>",
    "  <body>",
    "    <main>",
    "      <h1>Local " + componentName + "</h1>",
    "      <dl>",
    "        <dt>" + identityLabel + "</dt><dd>" + escapeHtml(input.id) + "</dd>",
    "        <dt>Readiness</dt><dd>" + escapeHtml(input.readiness) + "</dd>",
    "        <dt>Bound endpoint</dt><dd>" + escapeHtml(input.endpoint) + "</dd>",
    peerRow,
    "      </dl>",
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
