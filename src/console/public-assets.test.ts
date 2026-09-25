import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SETUP_CONSOLE_ASSETS,
  SETUP_CONSOLE_CONTENT_SECURITY_POLICY,
  lookupSetupConsoleAsset,
  readSetupConsoleAsset,
  setupConsoleAssetHeaders,
} from "./public-assets.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/setup-console");

test("only exact GET/HEAD asset paths resolve; query, fragment, encoding and traversal do not", () => {
  assert.equal(lookupSetupConsoleAsset("GET", "/")?.file, "index.html");
  assert.equal(lookupSetupConsoleAsset("HEAD", "/setup-console.js")?.file, "setup-console.js");
  assert.equal(lookupSetupConsoleAsset("GET", "/styles.css")?.contentType, "text/css; charset=utf-8");
  for (const target of [
    "/?bearer=x",
    "/#csrf",
    "/index.html",
    "/../package.json",
    "/%2e%2e/package.json",
    "//styles.css",
    "/api/setup/state",
    "/setup-console.js?v=1",
    "/x".repeat(40),
    undefined,
  ]) {
    assert.equal(lookupSetupConsoleAsset("GET", target), undefined, String(target));
  }
  assert.equal(lookupSetupConsoleAsset("POST", "/"), undefined);
  assert.equal(lookupSetupConsoleAsset(undefined, "/"), undefined);
});

test("asset headers are bounded, no-store and same-origin only", () => {
  const index = lookupSetupConsoleAsset("GET", "/")!;
  const headers = setupConsoleAssetHeaders(index, 10);
  assert.equal(headers["content-length"], "10");
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["content-security-policy"], SETUP_CONSOLE_CONTENT_SECURITY_POLICY);
  assert.match(SETUP_CONSOLE_CONTENT_SECURITY_POLICY, /connect-src 'self'/u);
  assert.doesNotMatch(SETUP_CONSOLE_CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval|\*/u);
  assert.throws(() => setupConsoleAssetHeaders(index, index.maxBytes + 1));
  assert.throws(() => setupConsoleAssetHeaders(index, -1));
  // No header or asset metadata carries a credential, a port or a server.
  assert.deepEqual(Object.keys(SETUP_CONSOLE_ASSETS[0]!).sort(), ["contentType", "file", "maxBytes", "path"]);
});

test("reads fixed assets with a size bound and refuses unknown or oversized files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "setup-console-assets-"));
  try {
    await writeFile(path.join(directory, "index.html"), "<!doctype html>");
    const index = lookupSetupConsoleAsset("GET", "/")!;
    assert.equal(Buffer.from(await readSetupConsoleAsset(directory, index)).toString("utf8"), "<!doctype html>");
    const styles = lookupSetupConsoleAsset("GET", "/styles.css")!;
    await writeFile(path.join(directory, "styles.css"), Buffer.alloc(styles.maxBytes + 1));
    await assert.rejects(readSetupConsoleAsset(directory, styles));
    await assert.rejects(
      readSetupConsoleAsset(directory, { path: "/", file: "../secret", contentType: "text/plain", maxBytes: 10 }),
    );
    await assert.rejects(readSetupConsoleAsset(path.join(directory, "missing"), index));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("static wizard assets hold no operator credential and are listed by the lookup", async () => {
  const html = await readFile(path.join(appRoot, "index.html"), "utf8");
  const css = await readFile(path.join(appRoot, "styles.css"), "utf8");
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/u);
  assert.match(html, /href="\/styles.css"/u);
  assert.doesNotMatch(html, /bearer|csrf|token|<script(?![^>]*src=)/iu);
  assert.doesNotMatch(css, /url\(/u);
  for (const item of SETUP_CONSOLE_ASSETS) assert.ok(item.maxBytes > 0 && item.path.startsWith("/"));
});
