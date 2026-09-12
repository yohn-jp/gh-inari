#!/usr/bin/env node

/**
 * Controlled GitHub/Actions provider for the packed-artifact certification.
 *
 * This file is a provider boundary only.  It stores bounded GitHub resource
 * state and serves the API calls made by the installed Actions executor.  The
 * installed package owns request validation, governance, lifecycle planning,
 * effect sequencing, issuer checks, projection, and recovery.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { deflateRawSync } from "node:zlib";

const OWNER = "yohn-jp";
const NAME = "gh-inari";
const HOST = "github.com";
const REPOSITORY = `${OWNER}/${NAME}`;
const REPOSITORY_ID = "415000001";
const REPOSITORY_NODE_ID = "R_415000001";
const BASE_BRANCH = "main";
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function parseFields(argv) {
  const fields = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--raw-field" && option !== "--field" && option !== "-f") continue;
    const value = argv[index + 1];
    if (typeof value !== "string") throw new Error(`${option} requires a value`);
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`${option} requires name=value`);
    fields[value.slice(0, separator)] = value.slice(separator + 1);
    index += 1;
  }
  return fields;
}

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  return index < 0 ? undefined : argv[index + 1];
}

function apiEndpoint(argv) {
  const index = argv.indexOf("api");
  if (index < 0 || typeof argv[index + 1] !== "string") throw new Error("gh api endpoint is required");
  return argv[index + 1];
}

function repositoryMetadata() {
  return {
    id: Number(REPOSITORY_ID),
    node_id: REPOSITORY_NODE_ID,
    name: NAME,
    full_name: REPOSITORY,
    default_branch: BASE_BRANCH,
    fork: false,
  };
}

function repositoryContextOutput() {
  return { nameWithOwner: REPOSITORY, url: `https://${HOST}/${REPOSITORY}` };
}

function sha1Blob(source) {
  const bytes = Buffer.from(source, "utf8");
  return crypto.createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function governanceEntries(consumerRoot) {
  const root = path.join(consumerRoot, ".github");
  if (!fs.existsSync(root)) throw new Error("consumer governance source is missing");
  const entries = [];
  const blobs = new Map();
  const visit = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const filePath = path.join(directory, name);
      const relative = `${prefix}/${name}`;
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        visit(filePath, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`unsupported governance entry: ${relative}`);
      const source = fs.readFileSync(filePath, "utf8");
      const sha = sha1Blob(source);
      entries.push({ path: relative, type: "blob", sha });
      blobs.set(sha, source);
    }
  };
  visit(root, ".github");
  return { entries, blobs };
}

function branchBody(branch, sha) {
  return { ref: `refs/heads/${branch}`, object: { type: "commit", sha } };
}

function pullRequestBody(pull) {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: pull.draft,
    node_id: pull.nodeId,
    head: { ref: pull.branch, repo: { full_name: REPOSITORY } },
    base: { ref: BASE_BRANCH, repo: { full_name: REPOSITORY } },
    user: { login: "inari-issuer[bot]" },
    merged_at: pull.mergedAt,
  };
}

function issueBody(issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  };
}

function branchNumber(branch) {
  const match = /^\w+\/(\d+)-/u.exec(branch);
  return match === null ? undefined : Number(match[1]);
}

function jsonRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error("request exceeds bounded provider input"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  const body = value === undefined ? "" : JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("provider response exceeds bound");
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function sendNoContent(response, status = 204) {
  response.writeHead(status);
  response.end();
}

function endpointParts(requestUrl) {
  const parsed = new URL(requestUrl, "http://127.0.0.1");
  const parts = parsed.pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));
  if (parts[0] === "repos" && parts[1] === OWNER && parts[2] === NAME) {
    return { parsed, parts: parts.slice(3) };
  }
  return { parsed, parts };
}

function findPull(state, number) {
  return Object.values(state.pulls ?? {}).find((candidate) => candidate.number === number);
}

function findPullByNodeId(state, nodeId) {
  return Object.values(state.pulls ?? {}).find((candidate) => candidate.nodeId === nodeId);
}

function findIssue(state, number) {
  return state.issues?.[String(number)];
}

function stateChanged(statePath, state) {
  writeJson(statePath, state);
}

function sendRepositoryResponse(argv, status, value) {
  const body = JSON.stringify(value);
  if (argv.includes("--include"))
    process.stdout.write(`HTTP/1.1 ${status} OK\ncontent-type: application/json\n\n${body}\n`);
  else process.stdout.write(`${body}\n`);
}

function repositoryApi(argv, state) {
  const endpoint = apiEndpoint(argv);
  const { parsed, parts } = endpointParts(endpoint);
  if (parts.length === 0) {
    sendRepositoryResponse(argv, 200, repositoryMetadata());
    return;
  }
  if (parts[0] === "issues" && parts.length === 2) {
    const issue = findIssue(state, Number(parts[1]));
    sendRepositoryResponse(
      argv,
      issue === undefined ? 404 : 200,
      issue === undefined ? { message: "not found" } : issueBody(issue),
    );
    return;
  }
  if (parts[0] === "git" && parts[1] === "ref" && parts[2] === "heads") {
    const branch = parts.slice(3).join("/");
    const sha = state.branches?.[branch];
    sendRepositoryResponse(
      argv,
      sha === undefined ? 404 : 200,
      sha === undefined ? { message: "not found" } : branchBody(branch, sha),
    );
    return;
  }
  if (parts[0] === "git" && parts[1] === "matching-refs") {
    const refs = Object.entries(state.branches ?? {})
      .filter(([branch]) => branch !== BASE_BRANCH)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([branch, sha]) => branchBody(branch, sha));
    sendRepositoryResponse(argv, 200, refs);
    return;
  }
  if (parts[0] === "git" && parts[1] === "trees" && parts.length === 3) {
    const consumerRoot = requireEnvironment("INARI_PACKED_CONSUMER_ROOT");
    const governance = governanceEntries(consumerRoot);
    sendRepositoryResponse(argv, 200, { sha: state.workflowSha, truncated: false, tree: governance.entries });
    return;
  }
  if (parts[0] === "git" && parts[1] === "blobs" && parts.length === 3) {
    const consumerRoot = requireEnvironment("INARI_PACKED_CONSUMER_ROOT");
    const source = governanceEntries(consumerRoot).blobs.get(parts[2]);
    sendRepositoryResponse(
      argv,
      source === undefined ? 404 : 200,
      source === undefined
        ? { message: "not found" }
        : { sha: parts[2], encoding: "base64", content: Buffer.from(source).toString("base64") },
    );
    return;
  }
  if (parts[0] === "pulls" && parts.length === 1) {
    const head = parsed.searchParams.get("head");
    const expectedHead = head?.startsWith(`${OWNER}:`) === true ? head.slice(OWNER.length + 1) : undefined;
    const base = parsed.searchParams.get("base");
    const values = Object.values(state.pulls ?? {})
      .filter(
        (pull) =>
          (expectedHead === undefined || pull.branch === expectedHead) && (base === null || base === BASE_BRANCH),
      )
      .sort((left, right) => left.number - right.number)
      .map(pullRequestBody);
    sendRepositoryResponse(argv, 200, values);
    return;
  }
  if (parts[0] === "pulls" && parts.length === 2) {
    const pull = findPull(state, Number(parts[1]));
    sendRepositoryResponse(
      argv,
      pull === undefined ? 404 : 200,
      pull === undefined ? { message: "not found" } : pullRequestBody(pull),
    );
    return;
  }
  throw new Error(`unsupported repository API endpoint: ${endpoint}`);
}

function createProviderServer(state, statePath, consumerRoot) {
  const governance = governanceEntries(consumerRoot);
  const server = http.createServer(async (request, response) => {
    try {
      const { parsed, parts } = endpointParts(request.url ?? "/");
      if (request.method === "POST" && parts[0] === "app" && parts[1] === "installations") {
        const input = await jsonRequest(request);
        const permissions = isRecord(input?.permissions) ? input.permissions : {};
        sendJson(response, 201, {
          token: "controlled-installation-token",
          expires_at: "2099-01-01T00:00:00Z",
          permissions: { ...permissions, metadata: "read" },
          repositories: [{ id: Number(REPOSITORY_ID), full_name: REPOSITORY }],
        });
        return;
      }
      if (request.method === "POST" && parts.length === 1 && parts[0] === "graphql") {
        const input = await jsonRequest(request);
        if (input?.operationName === "PullRequestReadyForReview") {
          const pullRequestId = input?.variables?.input?.pullRequestId;
          const pull = typeof pullRequestId === "string" ? findPullByNodeId(state, pullRequestId) : undefined;
          if (pull === undefined || pull.state !== "open" || pull.draft !== true) {
            sendJson(response, 200, { errors: [{ message: "controlled pull request is not a ready-eligible draft" }] });
            return;
          }
          pull.draft = false;
          stateChanged(statePath, state);
          sendJson(response, 200, {
            data: {
              markPullRequestReadyForReview: {
                pullRequest: { id: pull.nodeId, number: pull.number, state: "OPEN", isDraft: false },
              },
            },
          });
          return;
        }
        const updates = input?.variables?.input?.refUpdates;
        const update = Array.isArray(updates) ? updates[0] : undefined;
        const reference = typeof update?.name === "string" ? update.name : "";
        const branch = reference.startsWith("refs/heads/") ? reference.slice("refs/heads/".length) : undefined;
        if (branch === undefined || typeof update?.beforeOid !== "string") {
          sendJson(response, 200, { errors: [{ message: "invalid controlled ref update" }] });
          return;
        }
        const issue = branchNumber(branch);
        const issueKey = issue === undefined ? undefined : String(issue);
        if (issueKey !== undefined && state.failDeleteOnce?.[issueKey] === true) {
          state.failDeleteOnce[issueKey] = false;
          stateChanged(statePath, state);
          sendJson(response, 200, { errors: [{ message: "controlled one-shot delete failure" }] });
          return;
        }
        if (state.branches?.[branch] === undefined) {
          sendJson(response, 200, { errors: [{ message: "controlled branch is absent" }] });
          return;
        }
        if (state.branches[branch] !== update.beforeOid) {
          sendJson(response, 200, { errors: [{ message: "controlled branch commit mismatch" }] });
          return;
        }
        delete state.branches[branch];
        stateChanged(statePath, state);
        sendJson(response, 200, { data: { updateRefs: { clientMutationId: null } } });
        return;
      }

      const resource = parts;
      if (request.method === "GET" && resource.length === 0) {
        sendJson(response, 200, repositoryMetadata());
        return;
      }
      if (request.method === "GET" && resource[0] === "issues" && resource.length === 2) {
        const issue = findIssue(state, Number(resource[1]));
        if (issue === undefined) sendJson(response, 404, { message: "not found" });
        else sendJson(response, 200, issueBody(issue));
        return;
      }
      if (request.method === "GET" && resource[0] === "git" && resource[1] === "ref" && resource[2] === "heads") {
        const branch = resource.slice(3).join("/");
        const sha = state.branches?.[branch];
        if (sha === undefined) sendJson(response, 404, { message: "not found" });
        else sendJson(response, 200, branchBody(branch, sha));
        return;
      }
      if (request.method === "GET" && resource[0] === "git" && resource[1] === "matching-refs") {
        const refs = Object.entries(state.branches ?? {})
          .filter(([branch]) => branch !== BASE_BRANCH)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([branch, sha]) => branchBody(branch, sha));
        sendJson(response, 200, refs);
        return;
      }
      if (request.method === "GET" && resource[0] === "git" && resource[1] === "trees" && resource.length === 3) {
        sendJson(response, 200, {
          sha: state.workflowSha,
          truncated: false,
          tree: governance.entries,
        });
        return;
      }
      if (request.method === "GET" && resource[0] === "git" && resource[1] === "blobs" && resource.length === 3) {
        const source = governance.blobs.get(resource[2]);
        if (source === undefined) sendJson(response, 404, { message: "not found" });
        else
          sendJson(response, 200, {
            sha: resource[2],
            encoding: "base64",
            content: Buffer.from(source).toString("base64"),
          });
        return;
      }
      if (request.method === "GET" && resource[0] === "pulls" && resource.length === 1) {
        const head = parsed.searchParams.get("head");
        const expectedHead = head?.startsWith(`${OWNER}:`) === true ? head.slice(OWNER.length + 1) : undefined;
        const base = parsed.searchParams.get("base");
        const values = Object.values(state.pulls ?? {})
          .filter(
            (pull) =>
              (expectedHead === undefined || pull.branch === expectedHead) && (base === null || base === BASE_BRANCH),
          )
          .sort((left, right) => left.number - right.number)
          .map(pullRequestBody);
        sendJson(response, 200, values);
        return;
      }
      if (request.method === "GET" && resource[0] === "pulls" && resource.length === 2) {
        const pull = findPull(state, Number(resource[1]));
        if (pull === undefined) sendJson(response, 404, { message: "not found" });
        else sendJson(response, 200, pullRequestBody(pull));
        return;
      }
      if (request.method === "POST" && resource[0] === "git" && resource[1] === "refs") {
        const input = await jsonRequest(request);
        const reference = input?.ref;
        const sha = input?.sha;
        if (typeof reference !== "string" || !reference.startsWith("refs/heads/") || typeof sha !== "string") {
          sendJson(response, 422, { message: "invalid ref" });
          return;
        }
        const branch = reference.slice("refs/heads/".length);
        state.branches[branch] = sha;
        stateChanged(statePath, state);
        sendJson(response, 201, branchBody(branch, sha));
        return;
      }
      if (request.method === "POST" && resource[0] === "pulls" && resource.length === 1) {
        const input = await jsonRequest(request);
        const branch = input?.head;
        if (typeof branch !== "string" || typeof input?.body !== "string" || typeof input?.title !== "string") {
          sendJson(response, 422, { message: "invalid pull request" });
          return;
        }
        const issue = branchNumber(branch);
        if (issue === undefined) {
          sendJson(response, 422, { message: "invalid canonical branch" });
          return;
        }
        const pull = {
          number: issue * 10,
          title: input.title,
          body: input.body,
          branch,
          state: "open",
          draft: input.draft === true,
          nodeId: `PRNODE_${issue}`,
          mergedAt: null,
        };
        state.pulls[String(pull.number)] = pull;
        stateChanged(statePath, state);
        sendJson(response, 201, pullRequestBody(pull));
        return;
      }
      if (request.method === "POST" && resource[0] === "pulls" && resource.length === 2) {
        sendJson(response, 405, { message: "unsupported pull request mutation" });
        return;
      }
      if (request.method === "PATCH" && resource[0] === "pulls" && resource.length === 2) {
        const pull = findPull(state, Number(resource[1]));
        const input = await jsonRequest(request);
        if (pull === undefined) sendJson(response, 404, { message: "not found" });
        else {
          if (input?.state === "closed") {
            pull.state = "closed";
            pull.draft = false;
          }
          stateChanged(statePath, state);
          sendJson(response, 200, pullRequestBody(pull));
        }
        return;
      }
      if (request.method === "PATCH" && resource[0] === "issues" && resource.length === 2) {
        const pull = findPull(state, Number(resource[1]));
        const input = await jsonRequest(request);
        if (pull === undefined) sendJson(response, 404, { message: "not found" });
        else
          sendJson(response, 200, {
            ...pullRequestBody(pull),
            labels: input?.labels ?? [],
            assignees: input?.assignees ?? [],
          });
        return;
      }
      if (request.method === "DELETE" && resource[0] === "git" && resource[1] === "refs" && resource[2] === "heads") {
        const branch = resource.slice(3).join("/");
        if (state.branches?.[branch] === undefined) sendJson(response, 404, { message: "not found" });
        else {
          delete state.branches[branch];
          stateChanged(statePath, state);
          sendNoContent(response);
        }
        return;
      }
      sendJson(response, 404, { message: "not found" });
    } catch (error) {
      if (!response.headersSent)
        sendJson(response, 500, { message: error instanceof Error ? error.message : "provider error" });
      else response.destroy();
    }
  });
  return server;
}

function parseWorkerOutput(stdout) {
  const lines = stdout
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("installed Actions executor emitted no result");
  return JSON.parse(lines.at(-1));
}

function spawnWorker(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

function generatePrivateKey() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
}

async function dispatchWorker(state, statePath, requestJson) {
  const packageRoot = requireEnvironment("INARI_PACKED_PACKAGE_ROOT");
  const consumerRoot = requireEnvironment("INARI_PACKED_CONSUMER_ROOT");
  const worker = path.join(packageRoot, "dist", "github", "actions-change-executor.js");
  if (!fs.existsSync(worker)) throw new Error("installed Actions executor is missing from the packed package");
  const server = createProviderServer(state, statePath, consumerRoot);
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error) => (error === undefined ? resolve() : reject(error)));
  });
  const address = server.address();
  if (!isRecord(address) || typeof address.port !== "number") throw new Error("controlled provider did not bind");
  const environment = {
    ...process.env,
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    GITHUB_SERVER_URL: `https://${HOST}`,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_TOKEN: "controlled-actions-token",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/inari-change-executor.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: state.workflowSha,
    GITHUB_ACTOR: "packed-certification",
    INARI_ISSUER_APP_ID: "415",
    INARI_ISSUER_INSTALLATION_ID: "415",
    INARI_ISSUER_APP_PRIVATE_KEY: generatePrivateKey(),
    INARI_CHANGE_REQUEST: requestJson,
  };
  let workerResult;
  try {
    workerResult = await spawnWorker(process.execPath, [worker], { cwd: consumerRoot, env: environment });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  let result;
  try {
    result = parseWorkerOutput(workerResult.stdout);
  } catch (error) {
    result = {
      ok: false,
      error: {
        code: "CHANGE_ACTIONS_RUNTIME_INVALID",
        message: "Trusted Change execution failed closed.",
        details: { stage: "trusted-execution", diagnostics: [] },
      },
      providerError: error instanceof Error ? error.message : String(error),
      providerStderr: workerResult.stderr.slice(0, 512),
    };
  }
  return { result, success: workerResult.status === 0 };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function singleEntryZip(name, content) {
  const fileName = Buffer.from(name, "utf8");
  const source = Buffer.from(content, "utf8");
  const compressed = deflateRawSync(source);
  const checksum = crc32(source);
  const local = Buffer.alloc(30 + fileName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(source.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  fileName.copy(local, 30);
  const central = Buffer.alloc(46 + fileName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(source.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  fileName.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

async function actionsApi(argv) {
  const statePath = requireEnvironment("INARI_PACKED_PROVIDER_STATE");
  const state = readJson(statePath, undefined);
  if (!isRecord(state)) throw new Error("provider state is invalid");
  const endpoint = apiEndpoint(argv);
  const relativeEndpoint = endpoint.startsWith(`repos/${REPOSITORY}/`)
    ? endpoint.slice(`repos/${REPOSITORY}/`.length)
    : endpoint;
  const method = optionValue(argv, "--method") ?? "GET";
  const fields = parseFields(argv);
  if (
    relativeEndpoint.startsWith("actions/workflows/") &&
    relativeEndpoint.endsWith("/runs?event=workflow_dispatch&branch=main&per_page=100")
  ) {
    process.stdout.write(`${JSON.stringify({ workflow_runs: state.runs ?? [] })}\n`);
    return;
  }
  if (relativeEndpoint === "actions/workflows/inari-change-executor.yml/dispatches" && method === "POST") {
    const requestJson = fields["inputs[request]"];
    const correlation = fields["inputs[correlation]"];
    if (requestJson === undefined || correlation === undefined)
      throw new Error("Actions dispatch fields are incomplete");
    const runId = state.nextRunId ?? 1000;
    const artifactId = state.nextArtifactId ?? 2000;
    state.nextRunId = runId + 1;
    state.nextArtifactId = artifactId + 1;
    const run = {
      id: runId,
      status: "completed",
      conclusion: "failure",
      event: "workflow_dispatch",
      head_branch: "main",
      ref: "refs/heads/main",
      path: ".github/workflows/inari-change-executor.yml",
    };
    state.runs = [run, ...(state.runs ?? [])];
    const worker = await dispatchWorker(state, statePath, requestJson);
    const archive = singleEntryZip("result.json", JSON.stringify(worker.result));
    run.conclusion = worker.success ? "success" : "failure";
    state.artifacts[correlation] = { id: artifactId, runId, bytes: archive.toString("base64") };
    stateChanged(statePath, state);
    return;
  }
  if (relativeEndpoint.startsWith("actions/artifacts?name=") && method === "GET") {
    const name = new URL(`https://provider.invalid/${relativeEndpoint}`).searchParams.get("name");
    const artifact = name === null ? undefined : state.artifacts?.[name.replace("inari-change-result-", "")];
    process.stdout.write(
      `${JSON.stringify({ artifacts: artifact === undefined ? [] : [{ id: artifact.id, name, expired: false, workflow_run: { id: artifact.runId, repository_id: Number(REPOSITORY_ID) } }] })}\n`,
    );
    return;
  }
  const artifactMatch = /^repos\/yohn-jp\/gh-inari\/actions\/artifacts\/(\d+)\/zip$/u.exec(endpoint);
  if (artifactMatch !== null && method === "GET") {
    const artifact = Object.values(state.artifacts ?? {}).find(
      (candidate) => candidate.id === Number(artifactMatch[1]),
    );
    if (artifact === undefined) throw new Error("Actions artifact not found");
    const output = optionValue(argv, "--output");
    if (typeof output !== "string") throw new Error("Actions artifact output is required");
    fs.writeFileSync(output, Buffer.from(artifact.bytes, "base64"), { mode: 0o600 });
    return;
  }
  throw new Error(`unsupported Actions API endpoint: ${endpoint}`);
}

async function api(argv) {
  const endpoint = apiEndpoint(argv);
  const statePath = requireEnvironment("INARI_PACKED_PROVIDER_STATE");
  const state = readJson(statePath, undefined);
  if (!isRecord(state)) throw new Error("provider state is invalid");
  if (endpoint === "user") {
    process.stdout.write(`${JSON.stringify({ login: "packed-certification" })}\n`);
    return;
  }
  if (endpoint === `repos/${REPOSITORY}` && optionValue(argv, "--jq") === ".id") {
    process.stdout.write(`${REPOSITORY_ID}\n`);
    return;
  }
  if (
    endpoint.startsWith("actions/") ||
    endpoint.includes("/actions/workflows/") ||
    endpoint.includes("/actions/artifacts?") ||
    endpoint.includes("/actions/artifacts/")
  ) {
    await actionsApi(argv);
    return;
  }
  if (endpoint.startsWith(`repos/${REPOSITORY}`)) {
    repositoryApi(argv, state);
    return;
  }
  throw new Error(`unsupported gh api endpoint: ${endpoint}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === "--version") {
    process.stdout.write("gh version 2.0.0\n");
    return;
  }
  if (first === "auth" && argv[1] === "status") return;
  if (first === "extension" && argv[1] === "list") {
    process.stdout.write("gh inari\tcontrolled packed artifact\n");
    return;
  }
  if (first === "repo" && argv[1] === "view") {
    process.stdout.write(`${JSON.stringify(repositoryContextOutput())}\n`);
    return;
  }
  if (first === "inari") {
    const entry = requireEnvironment("INARI_PACKED_ENTRY");
    const result = await spawnWorker(process.execPath, [entry, ...argv.slice(1)], {
      cwd: process.cwd(),
      env: process.env,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
    return;
  }
  if (first === "api") {
    await api(argv);
    return;
  }
  throw new Error(`unsupported controlled gh command: ${argv.join(" ")}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
