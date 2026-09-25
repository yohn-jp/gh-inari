/**
 * Bounded same-origin static asset lookup for the local setup wizard (#1119).
 *
 * This module only maps an exact request path to one of the fixed wizard
 * assets, returns its content metadata and security headers, and reads it
 * with a size bound from a caller-supplied asset directory. It starts no
 * server, allocates no port and mints no operator credential: hosting,
 * bootstrap delivery and root build wiring belong to #1121.
 */
import { open } from "node:fs/promises";
import path from "node:path";

export interface SetupConsoleAsset {
  /** Exact same-origin request path. */
  readonly path: string;
  /** File name inside the built wizard asset directory. */
  readonly file: string;
  readonly contentType: string;
  readonly maxBytes: number;
}

const asset = (requestPath: string, file: string, contentType: string, maxBytes: number): SetupConsoleAsset =>
  Object.freeze({ path: requestPath, file, contentType, maxBytes });

export const SETUP_CONSOLE_ASSETS: readonly SetupConsoleAsset[] = Object.freeze([
  asset("/", "index.html", "text/html; charset=utf-8", 64 * 1024),
  asset("/setup-console.js", "setup-console.js", "text/javascript; charset=utf-8", 1024 * 1024),
  asset("/styles.css", "styles.css", "text/css; charset=utf-8", 64 * 1024),
]);

/** Page policy: same-origin scripts, styles and API calls only; no framing, forms or plugins. */
export const SETUP_CONSOLE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const MAX_REQUEST_TARGET_LENGTH = 64;

/**
 * Resolves a request to a wizard asset. Only GET/HEAD of an exact asset path
 * with no query, fragment, encoding or traversal matches.
 */
export function lookupSetupConsoleAsset(
  method: string | undefined,
  requestTarget: string | undefined,
): SetupConsoleAsset | undefined {
  if (method !== "GET" && method !== "HEAD") return undefined;
  if (typeof requestTarget !== "string" || requestTarget.length > MAX_REQUEST_TARGET_LENGTH) return undefined;
  return SETUP_CONSOLE_ASSETS.find((item) => item.path === requestTarget);
}

export function setupConsoleAssetHeaders(
  item: SetupConsoleAsset,
  byteLength: number,
): Readonly<Record<string, string>> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > item.maxBytes) {
    throw new Error("Setup console asset exceeds its bound.");
  }
  return Object.freeze({
    "content-type": item.contentType,
    "content-length": String(byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": SETUP_CONSOLE_CONTENT_SECURITY_POLICY,
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-frame-options": "DENY",
  });
}

/** Reads one fixed asset from `directory`, refusing non-regular files and anything above its bound. */
export async function readSetupConsoleAsset(directory: string, item: SetupConsoleAsset): Promise<Uint8Array> {
  if (!SETUP_CONSOLE_ASSETS.includes(item)) throw new Error("Unknown setup console asset.");
  const handle = await open(path.join(path.resolve(directory), item.file), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > item.maxBytes) throw new Error("Setup console asset exceeds its bound.");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
  } finally {
    await handle.close();
  }
}
