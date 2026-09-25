import { GitHubAdapterCore, type GitHubAdapterAuthenticationProvider, type GitHubAdapterOptions } from "./adapter.js";
import { attachGitHubProviderFailure, githubProviderFailure, readGitHubProviderFailure } from "./provider-failure.js";
import { GitHubAuthenticationError, type GitHubAdapterError } from "./errors.js";
import { GitHubNativeHttpTransport } from "./native-http-transport.js";
import { resolveGitHubUserCredential, GitHubUserCredentialError } from "./user-credential.js";
import { resolveAuthenticatedGitHubUser, GitHubUserIdentityError } from "./user-identity.js";

const standaloneAuthenticationProvider: GitHubAdapterAuthenticationProvider = {
  createTransport: (options) => {
    let credential;
    try {
      credential = resolveGitHubUserCredential({
        hostname: options.hostname,
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.credentialFallbackProvider === undefined
          ? {}
          : { fallbackProvider: options.credentialFallbackProvider }),
      });
    } catch (error) {
      if (error instanceof GitHubUserCredentialError) throw new GitHubAuthenticationError(options.hostname, error);
      throw error;
    }
    const native = new GitHubNativeHttpTransport({
      token: credential.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    });
    return {
      request: (request) => native.request(request),
      requestGraphql: (request) => native.requestGraphql(request),
      requestBinary: (request) => native.requestBinary(request),
    };
  },
  authenticate: async ({ hostname, request, mapProviderError }) => {
    try {
      await resolveAuthenticatedGitHubUser({ request }, hostname);
    } catch (error) {
      if (error instanceof GitHubAuthenticationError) throw error;
      const mapped: GitHubAdapterError =
        error instanceof GitHubUserIdentityError
          ? error.cause === undefined
            ? attachGitHubProviderFailure(
                new GitHubAuthenticationError(undefined, error),
                githubProviderFailure("authentication", { retryable: false }),
              )
            : mapProviderError(error.cause)
          : mapProviderError(error);
      if (mapped instanceof GitHubAuthenticationError) {
        throw attachGitHubProviderFailure(
          new GitHubAuthenticationError(hostname, error),
          readGitHubProviderFailure(mapped),
        );
      }
      throw mapped;
    }
  },
};

/** Public standalone adapter retaining user-credential discovery compatibility. */
export class GitHubAdapter extends GitHubAdapterCore {
  constructor(options: GitHubAdapterOptions = {}) {
    super(options, standaloneAuthenticationProvider);
  }
}
