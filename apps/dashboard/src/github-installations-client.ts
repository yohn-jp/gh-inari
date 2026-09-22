/**
 * Browser-only reads of the signed-in user's own GitHub App installations
 * and repositories, used only to prefill the Endpoint read form. This talks
 * to api.github.com directly with the user's access token; it never crosses
 * the Endpoint boundary and never mutates anything.
 */

const GITHUB_API_ORIGIN = "https://api.github.com";
const INSTALLATIONS_PATH = "/user/installations";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PER_PAGE = 100;

export interface GitHubInstallationSummary {
  readonly installationId: string;
  readonly accountLogin: string;
}

export interface GitHubRepositorySummary {
  readonly repositoryId: string;
  readonly nameWithOwner: string;
}

export class GitHubInstallationsClientError extends Error {
  readonly code = "GITHUB_INSTALLATIONS_REQUEST_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "GitHubInstallationsClientError";
  }
}

export interface GitHubInstallationsClientOptions {
  readonly getAccessToken: () => string | undefined;
  readonly fetch?: typeof globalThis.fetch;
}

export interface GitHubInstallationsClient {
  listInstallations(): Promise<readonly GitHubInstallationSummary[]>;
  listRepositories(installationId: string): Promise<readonly GitHubRepositorySummary[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new GitHubInstallationsClientError("GitHub response could not be read.");
  }
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new GitHubInstallationsClientError("GitHub response exceeds the supported size.");
  }
  if (!response.ok) throw new GitHubInstallationsClientError(`GitHub request failed with status ${response.status}.`);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new GitHubInstallationsClientError("GitHub response is not valid JSON.");
  }
}

function installationsFrom(value: unknown): readonly GitHubInstallationSummary[] {
  if (!isRecord(value) || !Array.isArray(value.installations)) {
    throw new GitHubInstallationsClientError("GitHub installations response is malformed.");
  }
  const results: GitHubInstallationSummary[] = [];
  for (const entry of value.installations) {
    if (!isRecord(entry) || !isRecord(entry.account)) continue;
    const installationId = entry.id;
    const accountLogin = entry.account.login;
    if (typeof installationId !== "number" || typeof accountLogin !== "string") continue;
    results.push(Object.freeze({ installationId: String(installationId), accountLogin }));
  }
  return Object.freeze(results);
}

function repositoriesFrom(value: unknown): readonly GitHubRepositorySummary[] {
  if (!isRecord(value) || !Array.isArray(value.repositories)) {
    throw new GitHubInstallationsClientError("GitHub repositories response is malformed.");
  }
  const results: GitHubRepositorySummary[] = [];
  for (const entry of value.repositories) {
    if (!isRecord(entry)) continue;
    const repositoryId = entry.id;
    const nameWithOwner = entry.full_name;
    if (typeof repositoryId !== "number" || typeof nameWithOwner !== "string") continue;
    results.push(Object.freeze({ repositoryId: String(repositoryId), nameWithOwner }));
  }
  return Object.freeze(results);
}

/** Create a read-only client for the signed-in user's own GitHub App installations. */
export function createGitHubInstallationsClient(
  options: GitHubInstallationsClientOptions,
): GitHubInstallationsClient {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  function authorizedGet(path: string): Promise<Response> {
    const accessToken = options.getAccessToken();
    if (accessToken === undefined) {
      throw new GitHubInstallationsClientError("Sign in before listing GitHub App installations.");
    }
    return fetcher(`${GITHUB_API_ORIGIN}${path}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
      },
    });
  }

  return Object.freeze({
    async listInstallations(): Promise<readonly GitHubInstallationSummary[]> {
      const response = await authorizedGet(`${INSTALLATIONS_PATH}?per_page=${MAX_PER_PAGE}`);
      return installationsFrom(await readJson(response));
    },
    async listRepositories(installationId: string): Promise<readonly GitHubRepositorySummary[]> {
      if (!/^[1-9][0-9]{0,19}$/u.test(installationId)) {
        throw new GitHubInstallationsClientError("Installation ID is invalid.");
      }
      const response = await authorizedGet(
        `/user/installations/${installationId}/repositories?per_page=${MAX_PER_PAGE}`,
      );
      return repositoriesFrom(await readJson(response));
    },
  });
}
