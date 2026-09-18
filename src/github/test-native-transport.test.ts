import type { GitHubArtifactRequest, GitHubArtifactTransport } from "./adapter.js";
import { GitHubAuthenticationError } from "./errors.js";
import type { GitHubNativeHttpResponse } from "./native-http-transport.js";

/** Transitional fixture seam used while the ordinary adapter tests move to HTTP assertions. */
export interface FixtureCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes?: Uint8Array;
}

export interface FixtureCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly binaryStdout?: boolean;
}

export interface FixtureCommandTransport {
  run(args: readonly string[], options?: FixtureCommandOptions): Promise<FixtureCommandResult>;
}

interface FixtureCommandResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes?: Uint8Array;
}

/**
 * Adapts existing deterministic command fixtures to the native request seam.
 * It is test-only and deliberately absent from the built product. The fixture
 * still receives a command-shaped request so the semantic tests can be
 * migrated independently from their provider response data.
 */
export function nativeTestTransport(
  fixture: FixtureCommandTransport,
  options: { readonly localRepository?: boolean } = {},
): GitHubArtifactTransport {
  let initialized = false;
  let identityObserved = false;
  let contextResolved = false;

  const run = (args: readonly string[], options: FixtureCommandOptions = {}): Promise<FixtureCommandResponse> =>
    fixture.run(args, options);

  const initialize = async (request: GitHubArtifactRequest): Promise<void> => {
    if (initialized) return;
    initialized = true;
    const queued = fixtureQueue(fixture);
    const first = queued?.[0];
    const usesCommandBootstrap =
      queued === undefined || !isFixtureResponse(first) || first.stdout.includes("gh version") || queued.length === 0;
    if (!usesCommandBootstrap) return;
    const commandOptions: FixtureCommandOptions = { timeoutMs: 10_000 };
    const version = await run(["--version"], commandOptions);
    if (version.exitCode !== 0) throw new Error("Native fixture provider readiness failed.");
    const authArgs = ["auth", "status", "--hostname", request.hostname];
    const auth = await run(authArgs, commandOptions);
    if (auth.exitCode !== 0) throw new GitHubAuthenticationError(request.hostname);

    // The old local-repository fixtures have an explicit metadata response
    // queued before the immutable repository id.  Explicit repository
    // fixtures start with the id instead, so do not consume a synthetic
    // repository-view response for those targets.
    if (options.localRepository === true && queued !== undefined && looksLikeRepositoryMetadataResponse(queued[0])) {
      await run(["repo", "view", "--json", "nameWithOwner,url"], commandOptions);
    }
  };

  const command = (request: GitHubArtifactRequest, include = true): string[] => {
    const args = ["api", request.path, "--hostname", request.hostname, "--method", request.method];
    if (include) args.push("--include");
    if (request.body !== undefined) {
      for (const [name, value] of Object.entries(request.body)) {
        if (Array.isArray(value)) {
          for (const item of value) args.push("--raw-field", `${name}[]=${String(item)}`);
        } else if (typeof value === "boolean" || typeof value === "number") {
          args.push("--field", `${name}=${String(value)}`);
        } else if (value !== null && value !== undefined) {
          args.push("--raw-field", `${name}=${String(value)}`);
        }
      }
    }
    return args;
  };

  const response = (result: FixtureCommandResponse): GitHubNativeHttpResponse => {
    if (result.exitCode !== 0) {
      const status = /\bHTTP\s+(\d{3})\b/u.exec(result.stderr)?.[1];
      if (status !== undefined) return { status: Number(status), body: undefined };
      throw new Error(result.stderr || "Native fixture provider request failed.");
    }
    const included = parseIncluded(result.stdout);
    if (included !== undefined) return included;
    const text = result.stdout.trim();
    if (text.length === 0) return { status: 204, body: undefined };
    try {
      return { status: 200, body: JSON.parse(text) as unknown };
    } catch {
      return { status: 200, body: text };
    }
  };

  return {
    request: async (request) => {
      await initialize(request);
      if (!identityObserved && request.path === "user") {
        identityObserved = true;
        return { status: 200, body: { login: "octocat" } };
      }
      const isRepositoryIdentity =
        !contextResolved && request.method === "GET" && /^repos\/[^/]+\/[^/]+$/u.test(request.path);
      const result = await run(
        isRepositoryIdentity ? [...command(request, false), "--jq", ".id"] : command(request, shouldInclude(request)),
      );
      if (isRepositoryIdentity) contextResolved = true;
      if (isRepositoryIdentity) return repositoryIdentityResponse(result);
      return response(result);
    },
    requestGraphql: async (request) => {
      await initialize({ hostname: request.hostname, method: "GET", path: "user" });
      return response(
        await run([
          "api",
          "graphql",
          "--hostname",
          request.hostname,
          "-f",
          `query=${request.query}`,
          ...Object.entries(request.variables ?? {}).flatMap(([name, value]) => [
            typeof value === "number" ? "-F" : "-f",
            `${name}=${String(value)}`,
          ]),
        ]),
      );
    },
    requestBinary: async (request) => {
      await initialize({ hostname: request.hostname, method: "GET", path: "user" });
      const result = await run(["api", request.path, "--hostname", request.hostname, "--method", request.method], {
        binaryStdout: true,
        timeoutMs: 10_000,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || "Native fixture binary request failed.");
      return { status: 200, ...(result.stdoutBytes === undefined ? {} : { bytes: result.stdoutBytes }) };
    },
  };
}

function fixtureQueue(fixture: FixtureCommandTransport): unknown[] | undefined {
  const value = fixture as unknown as { responses?: unknown; steps?: unknown };
  if (Array.isArray(value.responses)) return value.responses;
  if (Array.isArray(value.steps)) return value.steps;
  return undefined;
}

function looksLikeRepositoryMetadata(value: string): boolean {
  return value.includes("nameWithOwner") && value.includes("url");
}

function looksLikeRepositoryMetadataResponse(value: unknown): boolean {
  if (!isFixtureResponse(value)) return false;
  return looksLikeRepositoryMetadata(value.stdout);
}

function isFixtureResponse(value: unknown): value is FixtureCommandResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "stdout" in value &&
    typeof (value as { stdout?: unknown }).stdout === "string"
  );
}

function repositoryIdentityResponse(result: FixtureCommandResponse): GitHubNativeHttpResponse {
  if (result.exitCode !== 0) throw new Error(result.stderr || "Native fixture repository identity request failed.");
  const id = Number(result.stdout.trim());
  if (!Number.isSafeInteger(id) || id < 1) {
    const text = result.stdout.trim();
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = text;
    }
    return { status: 200, body };
  }
  return { status: 200, body: { id } };
}

function shouldInclude(request: GitHubArtifactRequest): boolean {
  if (request.method !== "GET") return false;
  const path = request.path;
  return (
    path.length === 0 ||
    /^repos\/[^/]+\/[^/]+$/u.test(path) ||
    path.includes("?") ||
    /\/(?:comments|reviews|files|check-runs|status|parent|dependencies)(?:\/|\?|$)/u.test(path) ||
    path.includes("/protection/") ||
    path.includes("/git/ref/")
  );
}

function parseIncluded(value: string): GitHubNativeHttpResponse | undefined {
  const lines = value.split(/\r?\n/u);
  const statusIndex = lines.findIndex((line) => /^HTTP\/[^ ]+\s+\d{3}(?:\s|$)/u.test(line));
  if (statusIndex < 0) return undefined;
  const match = /^HTTP\/[^ ]+\s+(\d{3})/u.exec(lines[statusIndex] ?? "");
  if (match === null) return undefined;
  let separator = statusIndex + 1;
  const headers: Record<string, string> = {};
  while (separator < lines.length && lines[separator] !== "") {
    const delimiter = lines[separator]?.indexOf(":") ?? -1;
    if (delimiter > 0 && lines[separator] !== undefined) {
      const name = lines[separator].slice(0, delimiter).trim().toLowerCase();
      if (name === "link") headers[name] = lines[separator].slice(delimiter + 1).trim();
    }
    separator += 1;
  }
  const bodyText = lines
    .slice(separator + 1)
    .join("\n")
    .trim();
  let body: unknown;
  try {
    body = bodyText.length === 0 ? undefined : (JSON.parse(bodyText) as unknown);
  } catch {
    body = bodyText;
  }
  return {
    status: Number(match[1]),
    body,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}
