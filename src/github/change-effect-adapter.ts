import {
  MAX_CHANGE_BRANCH_LENGTH,
  MAX_CHANGE_HOST_LENGTH,
  validateChangeEffect,
  type ChangeDiagnostic,
  type ChangeEffect,
  type ChangeEffectKind,
  type ChangeIssuanceFailureEvidence,
} from "../change.js";

/** The repository target is resolved by the trusted caller, not by this adapter. */
export interface GitHubChangeEffectRepository {
  readonly hostname: string;
  readonly owner: string;
  readonly name: string;
}

export type GitHubChangeEffectHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** API request data owned by the GitHub adapter boundary. */
export interface GitHubChangeEffectRequest {
  readonly hostname: string;
  readonly method: GitHubChangeEffectHttpMethod;
  readonly path: string;
  readonly body?: Readonly<Record<string, string | number | boolean>>;
}

/** The transport returns an opaque response which is consumed and discarded by the adapter. */
export interface GitHubChangeEffectResponse {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * Explicit execution boundary for a future App, Actions, or service transport.
 * Credentials and transport errors remain owned by the implementation.
 */
export interface GitHubChangeEffectTransport {
  request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse>;
}

export interface GitHubChangeEffectAdapterOptions {
  readonly repository: GitHubChangeEffectRepository;
  readonly transport: GitHubChangeEffectTransport;
}

export const GITHUB_CHANGE_EFFECT_FAILURE_CODES = Object.freeze({
  CREATE_BRANCH: "BRANCH_CREATE_FAILED",
  CREATE_PULL_REQUEST: "PULL_REQUEST_CREATE_FAILED",
  MARK_PULL_REQUEST_READY: "PULL_REQUEST_READY_FAILED",
  CLOSE_PULL_REQUEST: "PULL_REQUEST_CLOSE_FAILED",
  DELETE_BRANCH: "BRANCH_DELETE_FAILED",
} as const satisfies Readonly<Record<ChangeEffectKind, string>>);

export type GitHubChangeEffectFailureCode = (typeof GITHUB_CHANGE_EFFECT_FAILURE_CODES)[ChangeEffectKind];

const GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES: Readonly<Record<ChangeEffectKind, string>> = Object.freeze({
  CREATE_BRANCH: "The branch creation effect failed.",
  CREATE_PULL_REQUEST: "The pull request creation effect failed.",
  MARK_PULL_REQUEST_READY: "The pull request ready effect failed.",
  CLOSE_PULL_REQUEST: "The pull request close effect failed.",
  DELETE_BRANCH: "The branch deletion effect failed.",
});

/** Bounded success evidence; GitHub response bodies and URLs are intentionally absent. */
export type GitHubChangeEffectSuccessEvidence =
  | {
      readonly kind: "CREATE_BRANCH";
      readonly branch: string;
      readonly baseBranch: string;
    }
  | {
      readonly kind: "CREATE_PULL_REQUEST";
      readonly branch: string;
      readonly baseBranch: string;
      readonly rootIssue: number;
      readonly pullRequest: number;
    }
  | {
      readonly kind: "MARK_PULL_REQUEST_READY";
      readonly pullRequest: number;
    }
  | {
      readonly kind: "CLOSE_PULL_REQUEST";
      readonly pullRequest: number;
    }
  | {
      readonly kind: "DELETE_BRANCH";
      readonly branch: string;
    };

export type GitHubChangeEffectFailureEvidence = ChangeIssuanceFailureEvidence;

export interface GitHubChangeEffectSuccessResult {
  readonly status: "succeeded";
  readonly effect: ChangeEffect;
  readonly evidence: GitHubChangeEffectSuccessEvidence;
}

export interface GitHubChangeEffectFailureResult {
  readonly status: "failed";
  readonly effect: ChangeEffect;
  /** This is directly compatible with Core's compensation/recovery input. */
  readonly failure: GitHubChangeEffectFailureEvidence;
}

export type GitHubChangeEffectResult = GitHubChangeEffectSuccessResult | GitHubChangeEffectFailureResult;

/** Raised before transport execution when the supplied effect is not a Core effect contract value. */
export class GitHubChangeEffectContractError extends Error {
  readonly code = "CHANGE_EFFECT_INVALID" as const;
  readonly diagnostics: readonly ChangeDiagnostic[];

  constructor(diagnostics: readonly ChangeDiagnostic[] = []) {
    super("The GitHub Change effect adapter accepts only a valid explicit Core ChangeEffect.");
    this.name = "GitHubChangeEffectContractError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export class GitHubChangeEffectConfigurationError extends Error {
  readonly code = "GITHUB_CHANGE_EFFECT_CONFIGURATION_INVALID" as const;

  constructor() {
    super("The GitHub Change effect adapter requires a valid repository and transport boundary.");
    this.name = "GitHubChangeEffectConfigurationError";
  }
}

/**
 * Thin projection of one explicit Core effect onto GitHub's REST resources.
 * It deliberately executes no plan, retry, idempotency, lifecycle, naming, or
 * compensation logic.
 */
export class GitHubChangeEffectAdapter {
  private readonly repository: GitHubChangeEffectRepository;
  private readonly transport: GitHubChangeEffectTransport;

  constructor(options: GitHubChangeEffectAdapterOptions) {
    assertRepository(options?.repository);
    if (!isRecord(options?.transport) || typeof options.transport.request !== "function") {
      throw new GitHubChangeEffectConfigurationError();
    }
    this.repository = { ...options.repository };
    this.transport = options.transport;
  }

  /** Execute exactly one explicit effect and normalize every execution failure. */
  async execute(effect: ChangeEffect): Promise<GitHubChangeEffectResult> {
    const explicitEffect = assertExplicitChangeEffect(effect);
    try {
      return {
        status: "succeeded",
        effect: explicitEffect,
        evidence: await this.executeExplicitEffect(explicitEffect),
      };
    } catch {
      return {
        status: "failed",
        effect: explicitEffect,
        failure: createFailureEvidence(explicitEffect),
      };
    }
  }

  private async executeExplicitEffect(effect: ChangeEffect): Promise<GitHubChangeEffectSuccessEvidence> {
    switch (effect.kind) {
      case "CREATE_BRANCH":
        return this.createBranch(effect);
      case "CREATE_PULL_REQUEST":
        return this.createPullRequest(effect);
      case "MARK_PULL_REQUEST_READY":
        return this.markPullRequestReady(effect);
      case "CLOSE_PULL_REQUEST":
        return this.closePullRequest(effect);
      case "DELETE_BRANCH":
        return this.deleteBranch(effect);
    }
  }

  private async createBranch(
    effect: Extract<ChangeEffect, { readonly kind: "CREATE_BRANCH" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const baseReference = await this.request(
      {
        method: "GET",
        path: `${this.repositoryPath()}/git/ref/heads/${encodeURIComponent(effect.baseBranch)}`,
      },
      200,
    );
    const baseSha = parseGitReference(baseReference, `refs/heads/${effect.baseBranch}`);
    const createdReference = await this.request(
      {
        method: "POST",
        path: `${this.repositoryPath()}/git/refs`,
        body: { ref: `refs/heads/${effect.branch}`, sha: baseSha },
      },
      201,
    );
    parseGitReference(createdReference, `refs/heads/${effect.branch}`);
    return { kind: effect.kind, branch: effect.branch, baseBranch: effect.baseBranch };
  }

  private async createPullRequest(
    effect: Extract<ChangeEffect, { readonly kind: "CREATE_PULL_REQUEST" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const response = await this.request(
      {
        method: "POST",
        path: `${this.repositoryPath()}/pulls`,
        body: {
          head: effect.branch,
          base: effect.baseBranch,
          issue: effect.rootIssue,
          draft: effect.draft,
        },
      },
      201,
    );
    const record = responseRecord(response);
    const pullRequest = responseNumber(record.number);
    if (record.state !== "open" || record.draft !== true) throw new InvalidGitHubResponseError();
    responseBranch(record.head, effect.branch);
    responseBranch(record.base, effect.baseBranch);
    return {
      kind: effect.kind,
      branch: effect.branch,
      baseBranch: effect.baseBranch,
      rootIssue: effect.rootIssue,
      pullRequest,
    };
  }

  private async markPullRequestReady(
    effect: Extract<ChangeEffect, { readonly kind: "MARK_PULL_REQUEST_READY" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const response = await this.request(
      {
        method: "PATCH",
        path: `${this.repositoryPath()}/pulls/${effect.pullRequest}`,
        body: { draft: false },
      },
      200,
    );
    const record = responseRecord(response);
    if (responseNumber(record.number) !== effect.pullRequest || record.state !== "open" || record.draft !== false) {
      throw new InvalidGitHubResponseError();
    }
    return { kind: effect.kind, pullRequest: effect.pullRequest };
  }

  private async closePullRequest(
    effect: Extract<ChangeEffect, { readonly kind: "CLOSE_PULL_REQUEST" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const response = await this.request(
      {
        method: "PATCH",
        path: `${this.repositoryPath()}/pulls/${effect.pullRequest}`,
        body: { state: "closed" },
      },
      200,
    );
    const record = responseRecord(response);
    if (responseNumber(record.number) !== effect.pullRequest || record.state !== "closed") {
      throw new InvalidGitHubResponseError();
    }
    return { kind: effect.kind, pullRequest: effect.pullRequest };
  }

  private async deleteBranch(
    effect: Extract<ChangeEffect, { readonly kind: "DELETE_BRANCH" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const response = await this.request(
      {
        method: "DELETE",
        path: `${this.repositoryPath()}/git/refs/heads/${encodeURIComponent(effect.branch)}`,
      },
      204,
    );
    if (response !== undefined && response !== null && response !== "") throw new InvalidGitHubResponseError();
    return { kind: effect.kind, branch: effect.branch };
  }

  private async request(
    request: Omit<GitHubChangeEffectRequest, "hostname">,
    expectedStatus: number,
  ): Promise<unknown> {
    try {
      const response = await this.transport.request({ ...request, hostname: this.repository.hostname });
      if (!isRecord(response) || !isHttpStatus(response.status) || response.status !== expectedStatus) {
        throw new InvalidGitHubResponseError();
      }
      return response.body;
    } catch (error) {
      if (error instanceof InvalidGitHubResponseError) throw error;
      throw new InvalidGitHubResponseError();
    }
  }

  private repositoryPath(): string {
    return `repos/${this.repository.owner}/${this.repository.name}`;
  }
}

function assertExplicitChangeEffect(input: unknown): ChangeEffect {
  try {
    const result = validateChangeEffect(input);
    if (!result.valid || result.effect === undefined) throw new GitHubChangeEffectContractError(result.diagnostics);
  } catch (error) {
    if (error instanceof GitHubChangeEffectContractError) throw error;
    throw new GitHubChangeEffectContractError();
  }
  // Keep the caller's explicit values. Core validation is a gate, not an
  // instruction for this adapter to canonicalize or repair the effect.
  return input as ChangeEffect;
}

function createFailureEvidence(effect: ChangeEffect): GitHubChangeEffectFailureEvidence {
  return {
    effect,
    code: GITHUB_CHANGE_EFFECT_FAILURE_CODES[effect.kind],
    message: GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES[effect.kind],
  };
}

function parseGitReference(value: unknown, expectedRef: string): string {
  const record = responseRecord(value);
  if (record.ref !== expectedRef || !isRecord(record.object) || record.object.type !== "commit") {
    throw new InvalidGitHubResponseError();
  }
  return responseBoundedString(record.object.sha);
}

function responseBranch(value: unknown, expected: string): void {
  if (!isRecord(value) || value.ref !== expected) throw new InvalidGitHubResponseError();
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidGitHubResponseError();
  return value;
}

function responseNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidGitHubResponseError();
  }
  return value;
}

function responseBoundedString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CHANGE_BRANCH_LENGTH ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new InvalidGitHubResponseError();
  }
  return value;
}

function assertRepository(value: unknown): asserts value is GitHubChangeEffectRepository {
  if (
    !isRecord(value) ||
    !validHostname(value.hostname) ||
    !validRepositorySegment(value.owner) ||
    !validRepositorySegment(value.name)
  ) {
    throw new GitHubChangeEffectConfigurationError();
  }
}

function validHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHANGE_HOST_LENGTH &&
    !/[\u0000-\u001F\u007F\s/]/u.test(value)
  );
}

function validRepositorySegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHANGE_BRANCH_LENGTH &&
    /^[A-Za-z0-9_.-]+$/u.test(value)
  );
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class InvalidGitHubResponseError extends Error {
  constructor() {
    super("GitHub response was invalid.");
    this.name = "InvalidGitHubResponseError";
  }
}
