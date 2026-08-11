import assert from "node:assert/strict";
import { test } from "node:test";
import { GhTransportTimeoutError, ProcessGhTransport } from "./index.js";

test("resolves stdout, stderr, and exit code for a real completed process", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  const result = await transport.run(["-e", "process.stdout.write('out'); process.stderr.write('err');"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("resolves a non-zero exit code without a timeout configured", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  const result = await transport.run(["-e", "process.exit(3);"]);

  assert.equal(result.exitCode, 3);
});

test("rejects with a distinct timeout error and terminates a process that exceeds timeoutMs", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  await assert.rejects(
    transport.run(["-e", "setTimeout(() => {}, 60000);"], { timeoutMs: 50 }),
    (error: unknown) => error instanceof GhTransportTimeoutError && error.timeoutMs === 50,
  );
});

test("rejects on timeout even when the killed process still exits with code 0", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  await assert.rejects(
    transport.run(["-e", "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 60000);"], {
      timeoutMs: 50,
    }),
    (error: unknown) => error instanceof GhTransportTimeoutError,
  );
});

test("force-kills a process that ignores SIGTERM after the timeout", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  const start = Date.now();
  await assert.rejects(
    transport.run(["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000);"], { timeoutMs: 50 }),
    (error: unknown) => error instanceof GhTransportTimeoutError,
  );
  assert.ok(Date.now() - start < 5000, "process ignoring SIGTERM must still be force-killed promptly");
});
