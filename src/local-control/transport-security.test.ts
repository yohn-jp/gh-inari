import assert from "node:assert/strict";
import { createPrivateKey, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { localComponentDirectory } from "./config.js";
import {
  clearLocalRuntimeEndpoint,
  publishLocalRuntimeEndpoint,
  type LocalRuntimeEndpoint,
} from "./runtime-discovery.js";

const ADMISSION_ID = "adm_0123456789abcdef";
const WRONG_ADMISSION_ID = "adm_fedcba9876543210";
const EXECUTOR_ID = "exec_0123456789abcdef";
const WRONG_EXECUTOR_ID = "exec_fedcba9876543210";

interface TestCertificate {
  readonly certificate: string;
  readonly privateKey: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

function der(tag: number, content: Buffer): Buffer {
  let length: Buffer;
  if (content.length < 128) {
    length = Buffer.from([content.length]);
  } else {
    const octets: number[] = [];
    let value = content.length;
    while (value > 0) {
      octets.unshift(value & 0xff);
      value >>>= 8;
    }
    length = Buffer.from([0x80 | octets.length, ...octets]);
  }
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

function sequence(...values: readonly Buffer[]): Buffer {
  return der(0x30, Buffer.concat(values));
}

function objectIdentifier(value: string): Buffer {
  const parts = value.split(".").map(Number);
  const bytes: number[] = [(parts[0] as number) * 40 + (parts[1] as number)];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    let remaining = Math.floor(part / 128);
    while (remaining > 0) {
      encoded.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function certificateName(commonName: string): Buffer {
  return sequence(der(0x31, sequence(objectIdentifier("2.5.4.3"), der(0x0c, Buffer.from(commonName, "utf8")))));
}

function bitString(value: Buffer, unusedBits = 0): Buffer {
  return der(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
}

function extension(oid: string, value: Buffer, critical = false): Buffer {
  return sequence(objectIdentifier(oid), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
}

function keyUsage(usage: "ca" | "service"): Buffer {
  return usage === "ca" ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0xa0]), 5);
}

function certificatePem(bytes: Buffer): string {
  const base64 =
    bytes
      .toString("base64")
      .match(/.{1,64}/gu)
      ?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

function privateKeyPem(key: KeyObject): string {
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

function signedCertificate(input: {
  readonly serial: Buffer;
  readonly publicKeyDer: Buffer;
  readonly issuer: Buffer;
  readonly subject: Buffer;
  readonly extensions: readonly Buffer[];
  readonly signingKey: KeyObject;
}): string {
  const algorithm = sequence(objectIdentifier("1.2.840.113549.1.1.11"), der(0x05, Buffer.alloc(0)));
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const utcTime = (date: Date): Buffer => {
    const part = (value: number): string => String(value).padStart(2, "0");
    return der(
      0x17,
      Buffer.from(
        `${part(date.getUTCFullYear() % 100)}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}${part(date.getUTCHours())}${part(date.getUTCMinutes())}${part(date.getUTCSeconds())}Z`,
      ),
    );
  };
  const serial = input.serial[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), input.serial]) : input.serial;
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    input.issuer,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    input.subject,
    input.publicKeyDer,
    der(0xa3, sequence(...input.extensions)),
  );
  const signature = createSign("RSA-SHA256").update(tbs).sign(input.signingKey);
  return certificatePem(sequence(tbs, algorithm, bitString(signature)));
}

async function writeCertificateFiles(certificate: TestCertificate): Promise<void> {
  await writeFile(certificate.certificate, certificate.certificatePem, { mode: 0o600 });
  await writeFile(certificate.privateKey, certificate.privateKeyPem, { mode: 0o600 });
}

async function issueCertificate(
  directory: string,
  role: "admission" | "executor" | "control",
  id: string,
  ca: TestCertificate,
): Promise<TestCertificate> {
  const prefix = `${role}-${id}`;
  const privateKeyPath = path.join(directory, `${prefix}-key.pem`);
  const certificate = path.join(directory, `${prefix}-certificate.pem`);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const output: TestCertificate = {
    certificate,
    privateKey: privateKeyPath,
    certificatePem: signedCertificate({
      serial: randomBytes(16),
      publicKeyDer: pair.publicKey.export({ format: "der", type: "spki" }),
      issuer: certificateName("Inari local Runtime test CA"),
      subject: certificateName(prefix),
      extensions: [
        extension("2.5.29.19", sequence(), true),
        extension("2.5.29.15", keyUsage("service"), true),
        extension("2.5.29.37", sequence(objectIdentifier("1.3.6.1.5.5.7.3.1"), objectIdentifier("1.3.6.1.5.5.7.3.2"))),
        extension("2.5.29.17", sequence(der(0x86, Buffer.from(`urn:inari:local:${role}:${id}`))), true),
      ],
      signingKey: createPrivateKey(ca.privateKeyPem),
    }),
    privateKeyPem: privateKeyPem(pair.privateKey),
  };
  await writeCertificateFiles(output);
  await chmod(privateKeyPath, 0o600);
  return output;
}

async function createCertificates(directory: string): Promise<{
  readonly ca: TestCertificate;
  readonly admission: TestCertificate;
  readonly wrongAdmission: TestCertificate;
  readonly executor: TestCertificate;
  readonly wrongExecutor: TestCertificate;
}> {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ca: TestCertificate = {
    certificate: path.join(directory, "ca-certificate.pem"),
    privateKey: path.join(directory, "ca-private-key.pem"),
    certificatePem: signedCertificate({
      serial: randomBytes(16),
      publicKeyDer: pair.publicKey.export({ format: "der", type: "spki" }),
      issuer: certificateName("Inari local Runtime test CA"),
      subject: certificateName("Inari local Runtime test CA"),
      extensions: [
        extension("2.5.29.19", sequence(der(0x01, Buffer.from([0xff]))), true),
        extension("2.5.29.15", keyUsage("ca"), true),
      ],
      signingKey: pair.privateKey,
    }),
    privateKeyPem: privateKeyPem(pair.privateKey),
  };
  await writeCertificateFiles(ca);
  await chmod(ca.privateKey, 0o600);
  return {
    ca,
    admission: await issueCertificate(directory, "admission", ADMISSION_ID, ca),
    wrongAdmission: await issueCertificate(directory, "admission", WRONG_ADMISSION_ID, ca),
    executor: await issueCertificate(directory, "executor", EXECUTOR_ID, ca),
    wrongExecutor: await issueCertificate(directory, "executor", WRONG_EXECUTOR_ID, ca),
  };
}

async function installComponentIdentity(
  configHome: string,
  component: "admission" | "executor",
  identity: TestCertificate,
  ca: TestCertificate,
): Promise<void> {
  const environment = { INARI_CONFIG_HOME: configHome };
  const directory = localComponentDirectory(component, environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await copyFile(identity.certificate, path.join(directory, "mtls-certificate.pem"));
  await copyFile(identity.privateKey, path.join(directory, "mtls-private-key.pem"));
  await copyFile(ca.certificate, path.join(directory, "mtls-ca-certificate.pem"));
  await Promise.all(
    ["mtls-certificate.pem", "mtls-private-key.pem", "mtls-ca-certificate.pem"].map((name) =>
      chmod(path.join(directory, name), 0o600),
    ),
  );
}

const SERVER_PROGRAM = `
import { createLocalExecutorHttpServer } from "./src/local-control/executor-server.ts";
import { loadLocalMtlsIdentity } from "./src/local-control/transport-security.ts";
const executorId = process.env.INARI_TEST_EXECUTOR_ID;
const admissionId = process.env.INARI_TEST_ADMISSION_ID;
const tlsExecutorId = process.env.INARI_TEST_EXECUTOR_TLS_ID || executorId;
const transport = loadLocalMtlsIdentity("executor", tlsExecutorId, admissionId, process.env);
const server = createLocalExecutorHttpServer({
  config: { version: 1, id: executorId, listen: { host: "0.0.0.0", port: 8765 }, provider: { kind: "github", credentialProfile: "default" } },
  listenPort: 0,
  version: "mtls-test",
  executorId,
  execute: async () => ({ version: 1, status: "succeeded" }),
  readEvidence: async () => ({}),
  transport,
});
server.once("listening", () => {
  const address = server.address();
  if (address === null || typeof address === "string") process.exit(3);
  console.log(JSON.stringify({ port: address.port }));
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`;

const CLIENT_PROGRAM = `
import { LocalExecutorClient } from "./src/local-control/executor-client.ts";
import { loadLocalMtlsIdentity } from "./src/local-control/transport-security.ts";
import { requireLocalRuntimeEndpoint } from "./src/local-control/runtime-discovery.ts";
const admissionId = process.env.INARI_TEST_ADMISSION_ID;
const executorId = process.env.INARI_TEST_EXECUTOR_ID;
const endpoint = requireLocalRuntimeEndpoint("executor", executorId, process.env).endpoint;
let transport;
if (process.env.INARI_TEST_WRONG_CLIENT_CERT) {
  const { readFileSync } = await import("node:fs");
  const directory = process.env.INARI_CONFIG_HOME + "/admission/";
  transport = {
    certificate: readFileSync(process.env.INARI_TEST_WRONG_CLIENT_CERT),
    privateKey: readFileSync(process.env.INARI_TEST_WRONG_CLIENT_KEY),
    caCertificate: readFileSync(directory + "mtls-ca-certificate.pem"),
    peerId: executorId,
    peerRole: "executor",
  };
} else {
  transport = loadLocalMtlsIdentity("admission", admissionId, executorId, process.env);
}
try {
  const client = new LocalExecutorClient({ id: executorId, endpoint, transport });
  const health = await client.verifyReady();
  console.log(JSON.stringify({ ok: true, executorId: health.executorId }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error && typeof error === "object" && "code" in error ? error.code : "unknown" }));
  process.exitCode = 2;
}
`;

interface CapturedChild {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function startChild(program: string, environment: NodeJS.ProcessEnv): CapturedChild {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function nextJsonLine(process_: CapturedChild): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const line = process_
      .stdout()
      .split("\n")
      .find((candidate) => candidate.startsWith("{"));
    if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
    if (process_.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Child did not report startup: ${process_.stderr()}`);
}

async function exitResult(
  process_: CapturedChild,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return once(process_.child, "close").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
  }));
}

test(
  "real local processes require Admission to present mTLS and verify the configured Executor certificate identity",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-mtls-"));
    const configHome = path.join(root, "config");
    const wrongServerConfigHome = path.join(root, "wrong-server-config");
    const wrongCaConfigHome = path.join(root, "wrong-ca-config");
    const wrongCaDirectory = path.join(root, "wrong-ca");
    await mkdir(configHome, { mode: 0o700 });
    await mkdir(wrongServerConfigHome, { mode: 0o700 });
    await mkdir(wrongCaConfigHome, { mode: 0o700 });
    await mkdir(wrongCaDirectory, { mode: 0o700 });
    const certificates = await createCertificates(root);
    const wrongCa = await createCertificates(wrongCaDirectory);
    await installComponentIdentity(configHome, "admission", certificates.admission, certificates.ca);
    await installComponentIdentity(configHome, "executor", certificates.executor, certificates.ca);
    await installComponentIdentity(wrongServerConfigHome, "admission", certificates.admission, certificates.ca);
    await installComponentIdentity(wrongServerConfigHome, "executor", certificates.wrongExecutor, certificates.ca);
    await installComponentIdentity(wrongCaConfigHome, "executor", certificates.executor, wrongCa.ca);

    const commonEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      INARI_CONFIG_HOME: configHome,
      INARI_TEST_ADMISSION_ID: ADMISSION_ID,
      INARI_TEST_EXECUTOR_ID: EXECUTOR_ID,
    };
    let server: CapturedChild | undefined;
    let announcement: LocalRuntimeEndpoint | undefined;
    try {
      server = startChild(SERVER_PROGRAM, commonEnvironment);
      const startup = await nextJsonLine(server);
      assert.equal(typeof startup.port, "number");
      announcement = publishLocalRuntimeEndpoint(
        "executor",
        EXECUTOR_ID,
        startup.port as number,
        commonEnvironment,
        "https",
      );

      const successfulClient = startChild(CLIENT_PROGRAM, commonEnvironment);
      const successfulExit = await exitResult(successfulClient);
      assert.equal(successfulExit.code, 0, successfulClient.stderr());
      assert.deepEqual(JSON.parse(successfulClient.stdout()), { ok: true, executorId: EXECUTOR_ID });

      const wrongClientEnvironment = {
        ...commonEnvironment,
        INARI_TEST_WRONG_CLIENT_CERT: certificates.wrongAdmission.certificate,
        INARI_TEST_WRONG_CLIENT_KEY: certificates.wrongAdmission.privateKey,
      };
      const wrongClient = startChild(CLIENT_PROGRAM, wrongClientEnvironment);
      const wrongClientExit = await exitResult(wrongClient);
      assert.equal(wrongClientExit.code, 2);
      assert.deepEqual(JSON.parse(wrongClient.stdout()), { ok: false, code: "EXECUTOR_UNAVAILABLE" });

      const wrongServer = startChild(SERVER_PROGRAM, {
        ...commonEnvironment,
        INARI_CONFIG_HOME: wrongServerConfigHome,
        INARI_TEST_EXECUTOR_TLS_ID: WRONG_EXECUTOR_ID,
      });
      const wrongServerStartup = await nextJsonLine(wrongServer);
      announcement = publishLocalRuntimeEndpoint(
        "executor",
        EXECUTOR_ID,
        wrongServerStartup.port as number,
        commonEnvironment,
        "https",
      );
      const wrongServerClient = startChild(CLIENT_PROGRAM, commonEnvironment);
      const wrongServerExit = await exitResult(wrongServerClient);
      assert.equal(wrongServerExit.code, 2);
      assert.deepEqual(JSON.parse(wrongServerClient.stdout()), { ok: false, code: "EXECUTOR_UNAVAILABLE" });
      wrongServer.child.kill("SIGTERM");
      const wrongServerExitStatus = await exitResult(wrongServer);
      assert.equal(wrongServerExitStatus.code, 0);

      const missingIdentityEnvironment: NodeJS.ProcessEnv = {
        ...commonEnvironment,
        INARI_CONFIG_HOME: path.join(root, "missing-config"),
      };
      await mkdir(missingIdentityEnvironment.INARI_CONFIG_HOME as string, { mode: 0o700 });
      const missingIdentity = startChild(SERVER_PROGRAM, missingIdentityEnvironment);
      const missingIdentityExit = await exitResult(missingIdentity);
      assert.notEqual(missingIdentityExit.code, 0);
      assert.equal(missingIdentity.stdout(), "");

      const wrongCaEnvironment: NodeJS.ProcessEnv = {
        ...commonEnvironment,
        INARI_CONFIG_HOME: wrongCaConfigHome,
      };
      const wrongCaChild = startChild(SERVER_PROGRAM, wrongCaEnvironment);
      const wrongCaExit = await exitResult(wrongCaChild);
      assert.notEqual(wrongCaExit.code, 0);
      assert.equal(wrongCaChild.stdout(), "");
    } finally {
      if (announcement !== undefined) clearLocalRuntimeEndpoint(announcement, commonEnvironment);
      if (server !== undefined && server.child.exitCode === null) {
        server.child.kill("SIGTERM");
        await exitResult(server);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

const CONTROL_ID = "ctl_0123456789abcdef";
const WRONG_CONTROL_ID = "ctl_fedcba9876543210";

const OBSERVED_SERVER_PROGRAM = `
import { createLocalExecutorHttpServer } from "./src/local-control/executor-server.ts";
import { loadLocalMtlsIdentity } from "./src/local-control/transport-security.ts";
import { observeLocalExecutorOwner } from "./src/executor/observation.ts";
const executorId = process.env.INARI_TEST_EXECUTOR_ID;
const transport = loadLocalMtlsIdentity("executor", executorId, process.env.INARI_TEST_ADMISSION_ID, process.env);
const executed = () => { console.log(JSON.stringify({ executed: true })); throw new Error("forbidden"); };
const server = createLocalExecutorHttpServer({
  config: { version: 1, id: executorId, listen: { host: "0.0.0.0", port: 8765 }, provider: { kind: "github", credentialProfile: "default" } },
  listenPort: 0,
  version: "control-test",
  executorId,
  execute: executed,
  resolveRepository: executed,
  readEvidence: executed,
  readBranchPolicy: executed,
  readGovernedContract: executed,
  observeOwner: async () => observeLocalExecutorOwner({ environment: process.env }),
  transport,
  ...(process.env.INARI_TEST_CONTROL_ID ? { controlPeerId: process.env.INARI_TEST_CONTROL_ID } : {}),
});
server.once("listening", () => {
  const address = server.address();
  if (address === null || typeof address === "string") process.exit(3);
  console.log(JSON.stringify({ port: address.port, local: observeLocalExecutorOwner({ environment: process.env }) }));
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`;

test(
  "#1223 a separately hosted Executor is observable over Control mTLS, and Admission and Control stay route-separated",
  { timeout: 120_000 },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const { generateKeyPairSync: rsa } = await import("node:crypto");
    const { ExecutorAppCredentialStore } = await import("../executor/credential-store.js");
    const { ExecutorRepositoryBindingStore } = await import("../executor/repository-binding-store.js");
    const { writeLocalJson, validateLocalExecutorConfig } = await import("./config.js");
    const { ExecutorObservationClient } = await import("./executor-observation-client.js");
    const { LocalExecutorClient, requestLocalExecutorOverMtls } = await import("./executor-client.js");
    const { createLocalControlMtlsIdentity } = await import("./transport-security.js");
    const executorHttp = await import("./executor-http.js");

    const root = await mkdtemp(path.join(os.tmpdir(), "inari-control-mtls-"));
    // The Executor host owns this config home; the Control client below never reads it.
    const executorHome = path.join(root, "executor-host");
    await mkdir(executorHome, { mode: 0o700 });
    const certificates = await createCertificates(root);
    const control = await issueCertificate(root, "control", CONTROL_ID, certificates.ca);
    const wrongControl = await issueCertificate(root, "control", WRONG_CONTROL_ID, certificates.ca);
    await installComponentIdentity(executorHome, "executor", certificates.executor, certificates.ca);
    const executorEnvironment = { INARI_CONFIG_HOME: executorHome };
    writeLocalJson(
      "executor",
      "config.json",
      {
        version: 1,
        id: EXECUTOR_ID,
        listen: { host: "0.0.0.0", port: 0 },
        provider: { kind: "github", credentialProfile: "default" },
      },
      validateLocalExecutorConfig,
      executorEnvironment,
    );
    const issuerKey = Buffer.from(
      rsa("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const apps = new ExecutorAppCredentialStore(executorEnvironment);
    const credential = apps.markProviderVerified("123", apps.save(EXECUTOR_ID, "123", issuerKey).record.generation);
    new ExecutorRepositoryBindingStore(executorEnvironment).publish({
      repositoryHost: "github.com",
      repositoryId: "101",
      nameWithOwner: "acme/one",
      appId: "123",
      installationId: "77",
      generation: credential.generation,
      fingerprint: credential.fingerprint,
    });

    const material = async (identity: TestCertificate) => ({
      certificate: await readFile(identity.certificate),
      privateKey: await readFile(identity.privateKey),
      caCertificate: await readFile(certificates.ca.certificate),
    });
    const controlIdentity = createLocalControlMtlsIdentity(CONTROL_ID, EXECUTOR_ID, await material(control));
    const wrongControlIdentity = createLocalControlMtlsIdentity(
      WRONG_CONTROL_ID,
      EXECUTOR_ID,
      await material(wrongControl),
    );
    const admissionMaterial = await material(certificates.admission);
    const admissionIdentity = { ...admissionMaterial, peerRole: "executor" as const, peerId: EXECUTOR_ID };
    // Control material never validates as another role's identity, and vice versa.
    assert.throws(() => createLocalControlMtlsIdentity(CONTROL_ID, EXECUTOR_ID, admissionMaterial));
    const controlMaterial = await material(control);
    assert.throws(() => createLocalControlMtlsIdentity(WRONG_CONTROL_ID, EXECUTOR_ID, controlMaterial));

    const serverEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      INARI_CONFIG_HOME: executorHome,
      INARI_TEST_ADMISSION_ID: ADMISSION_ID,
      INARI_TEST_EXECUTOR_ID: EXECUTOR_ID,
      INARI_TEST_CONTROL_ID: CONTROL_ID,
    };
    const children: CapturedChild[] = [];
    try {
      const server = startChild(OBSERVED_SERVER_PROGRAM, serverEnvironment);
      children.push(server);
      const startup = await nextJsonLine(server);
      const endpoint = `https://127.0.0.1:${startup.port as number}`;

      // Control observes the remote Executor with explicit endpoint and identity only.
      const observed = await new ExecutorObservationClient({
        endpoint,
        executorId: EXECUTOR_ID,
        transport: controlIdentity,
      }).observe();
      assert.deepEqual(observed, startup.local);
      assert.deepEqual(
        observed.bindings.map((item) => [item.repositoryId, item.appId, item.status]),
        [["101", "123", "bound"]],
      );
      const serialized = JSON.stringify(observed);
      for (const needle of [executorHome, "PRIVATE KEY", ".pem", issuerKey.toString("utf8").slice(40, 90)])
        assert.equal(serialized.includes(needle), false, needle);

      const call = async (identity: typeof controlIdentity, route: string, method: string) => {
        const response = await requestLocalExecutorOverMtls(
          new URL(route, endpoint),
          method === "GET"
            ? { method }
            : { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1 }) },
          identity,
        );
        await response.arrayBuffer();
        return response.status;
      };
      // Control may use only owner observation (and the health probe).
      assert.equal(await call(controlIdentity, executorHttp.LOCAL_EXECUTOR_HEALTH_PATH, "GET"), 200);
      for (const route of [
        executorHttp.LOCAL_EXECUTOR_EXECUTIONS_PATH,
        executorHttp.LOCAL_EXECUTOR_EVIDENCE_PATH,
        executorHttp.LOCAL_EXECUTOR_REPOSITORY_PATH,
        executorHttp.LOCAL_EXECUTOR_BRANCH_POLICY_PATH,
        executorHttp.LOCAL_EXECUTOR_GOVERNED_CONTRACT_PATH,
      ])
        assert.equal(await call(controlIdentity, route, "POST"), 403, route);
      // Admission keeps its execution routes but may not observe owner state.
      assert.equal(
        (await new LocalExecutorClient({ id: EXECUTOR_ID, endpoint, transport: admissionIdentity }).verifyReady())
          .executorId,
        EXECUTOR_ID,
      );
      assert.equal(await call(admissionIdentity, executorHttp.LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH, "GET"), 403);
      await assert.rejects(
        new ExecutorObservationClient({ endpoint, executorId: EXECUTOR_ID, transport: admissionIdentity }).observe(),
        { code: "EXECUTOR_OBSERVATION_FORBIDDEN" },
      );
      // An unconfigured Control identity is refused at the TLS layer.
      await assert.rejects(
        new ExecutorObservationClient({ endpoint, executorId: EXECUTOR_ID, transport: wrongControlIdentity }).observe(),
        { code: "EXECUTOR_OBSERVATION_UNAVAILABLE" },
      );
      // Admission's request reached no forbidden handler.
      assert.equal(server.stdout().includes('"executed"'), false);

      // Without an explicitly supplied Control peer the Executor accepts no Control identity at all.
      const noControl = startChild(OBSERVED_SERVER_PROGRAM, { ...serverEnvironment, INARI_TEST_CONTROL_ID: "" });
      children.push(noControl);
      const noControlStartup = await nextJsonLine(noControl);
      await assert.rejects(
        new ExecutorObservationClient({
          endpoint: `https://127.0.0.1:${noControlStartup.port as number}`,
          executorId: EXECUTOR_ID,
          transport: controlIdentity,
        }).observe(),
        { code: "EXECUTOR_OBSERVATION_UNAVAILABLE" },
      );
    } finally {
      for (const child of children)
        if (child.child.exitCode === null) {
          child.child.kill("SIGTERM");
          await exitResult(child);
        }
      await rm(root, { recursive: true, force: true });
    }
  },
);
