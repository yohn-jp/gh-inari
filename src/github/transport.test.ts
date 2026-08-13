import assert from "node:assert/strict";
import { test } from "node:test";
import { GhTransportOutputLimitError, GhTransportTimeoutError, ProcessGhTransport } from "./index.js";

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

test("resolves output that stays within the configured per-stream byte bounds", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  const result = await transport.run(["-e", "process.stdout.write('out'); process.stderr.write('err');"], {
    maxStdoutBytes: 3,
    maxStderrBytes: 3,
  });

  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("rejects and terminates a process that exceeds the stdout byte bound", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  await assert.rejects(
    transport.run(["-e", "process.stdout.write('12345'); setTimeout(() => {}, 60000);"], {
      maxStdoutBytes: 4,
      maxStderrBytes: 0,
    }),
    (error: unknown) =>
      error instanceof GhTransportOutputLimitError &&
      error.code === "GH_OUTPUT_LIMIT_EXCEEDED" &&
      error.stream === "stdout" &&
      error.limitBytes === 4 &&
      error.outputBytes === 5,
  );
});

test("rejects and terminates a process that exceeds the stderr byte bound", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  await assert.rejects(
    transport.run(["-e", "process.stderr.write('12345'); setTimeout(() => {}, 60000);"], {
      maxStdoutBytes: 0,
      maxStderrBytes: 4,
    }),
    (error: unknown) =>
      error instanceof GhTransportOutputLimitError &&
      error.stream === "stderr" &&
      error.limitBytes === 4 &&
      error.outputBytes === 5,
  );
});

test("counts UTF-8 bytes across multibyte chunk boundaries", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  const result = await transport.run(
    [
      "-e",
      "const bytes = Buffer.from('😀', 'utf8'); process.stdout.write(bytes.subarray(0, 1)); setImmediate(() => process.stdout.write(bytes.subarray(1)));",
    ],
    { maxStdoutBytes: 4, maxStderrBytes: 0 },
  );

  assert.equal(result.stdout, "😀");
});

test("counts a multibyte character by bytes when enforcing the bound", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  await assert.rejects(
    transport.run(["-e", "process.stdout.write(Buffer.from('😀', 'utf8')); setTimeout(() => {}, 60000);"], {
      maxStdoutBytes: 3,
      maxStderrBytes: 0,
    }),
    (error: unknown) =>
      error instanceof GhTransportOutputLimitError &&
      error.stream === "stdout" &&
      error.limitBytes === 3 &&
      error.outputBytes === 4,
  );
});

test("rejects invalid output byte bounds", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  for (const maxStdoutBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      transport.run(["-e", "process.exit(0);"], { maxStdoutBytes }),
      (error: unknown) => error instanceof RangeError,
    );
  }
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

test("rejects non-positive and non-finite timeoutMs instead of arming an unbounded or immediate timer", async () => {
  const transport = new ProcessGhTransport(process.execPath);

  for (const invalidTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      transport.run(["-e", "process.exit(0);"], { timeoutMs: invalidTimeoutMs }),
      (error: unknown) => error instanceof RangeError,
    );
  }
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
