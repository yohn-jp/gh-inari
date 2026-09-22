/** Request-scoped shared-hosted composition for the Endpoint HTTP surface. */

import {
  createEndpointApi,
  type EndpointApiAuthenticationRequest,
  type EndpointApiAuthenticationResult,
  type EndpointApiProjectionRequest,
} from "./endpoint-api.js";
import { createEndpointHttpHandler, ENDPOINT_HTTP_PATH, type EndpointHttpHandler } from "./endpoint-http.js";
import {
  createEndpointHumanAuthenticator,
  type EndpointHumanAuthenticationResult,
} from "./github/endpoint-human-auth.js";
import {
  createHostedEndpointPresenceReader,
  type HostedEndpointPresenceReaderFunction,
  type HostedEndpointPresenceNamespace,
} from "./hosted-endpoint-presence-reader.js";
import { createHostedEndpointWorkReader } from "./hosted-endpoint-work-reader.js";
import { validateEndpointIdentity, type EndpointIdentity } from "./endpoint-authorization.js";

export interface HostedEndpointOptions {
  /** The immutable logical Endpoint identity owned by the deployment. */
  readonly endpoint: EndpointIdentity;
  /** GitHub App database ID used by the request-scoped human authenticator. */
  readonly appId: string;
  /** Relay Durable Object namespace used by the bounded presence reader. */
  readonly presenceNamespace: HostedEndpointPresenceNamespace;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

type RepositoryReadCapability = NonNullable<
  Extract<EndpointHumanAuthenticationResult, { readonly authenticated: true }>["withRepositoryReadTransport"]
>;

function sameEndpoint(left: EndpointIdentity, right: EndpointIdentity): boolean {
  return left.id === right.id && left.deployment === right.deployment;
}

function unavailableAuthentication(): EndpointApiAuthenticationResult {
  return { authenticated: false, diagnostics: [] };
}

function endpointOf(value: unknown): EndpointIdentity | undefined {
  return validateEndpointIdentity(value).value;
}

function createRequestHandler(
  endpoint: EndpointIdentity,
  authenticator: ReturnType<typeof createEndpointHumanAuthenticator>,
  readPresence: HostedEndpointPresenceReaderFunction,
): EndpointHttpHandler {
  let withRepositoryReadTransport: RepositoryReadCapability | undefined;

  const authentication = {
    async authenticate(request: EndpointApiAuthenticationRequest): Promise<EndpointApiAuthenticationResult> {
      const requestedEndpoint = endpointOf(request.request.endpoint);
      if (requestedEndpoint === undefined || !sameEndpoint(requestedEndpoint, endpoint)) {
        return unavailableAuthentication();
      }
      const result = await authenticator.authenticate(request);
      if (result.authenticated) withRepositoryReadTransport = result.withRepositoryReadTransport;
      return result;
    },
  };

  const readWork = async (request: EndpointApiProjectionRequest) => {
    if (withRepositoryReadTransport === undefined) {
      throw new Error("Hosted Endpoint repository read capability is unavailable.");
    }
    return createHostedEndpointWorkReader({ withRepositoryReadTransport })(request);
  };

  const api = createEndpointApi({ authentication, readWork, readPresence });
  return createEndpointHttpHandler({ api, path: ENDPOINT_HTTP_PATH });
}

/** Create the request-scoped shared-hosted Endpoint HTTP handler. */
export function createHostedEndpoint(options: HostedEndpointOptions): EndpointHttpHandler {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Hosted Endpoint options are invalid.");
  }
  const endpoint = validateEndpointIdentity(options.endpoint).value;
  if (endpoint === undefined) throw new TypeError("Hosted Endpoint identity is invalid.");
  if (
    options.presenceNamespace === null ||
    typeof options.presenceNamespace !== "object" ||
    typeof options.presenceNamespace.idFromName !== "function" ||
    typeof options.presenceNamespace.get !== "function"
  ) {
    throw new TypeError("Hosted Endpoint presence namespace is invalid.");
  }

  const authenticator = createEndpointHumanAuthenticator({
    appId: options.appId,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const readPresence = createHostedEndpointPresenceReader({ namespace: options.presenceNamespace });

  return async (request: Request): Promise<Response> =>
    createRequestHandler(endpoint, authenticator, readPresence)(request);
}
