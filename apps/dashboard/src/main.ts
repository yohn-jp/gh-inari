import {
  createDashboardEndpointClient,
  type DashboardEndpointClient,
  type DashboardEndpointClientOptions,
  type DashboardEndpointReadRequest,
  type DashboardEndpointResult,
} from "./endpoint-client.js";

export interface DashboardApplication {
  readonly endpoint: DashboardEndpointClient;
  readonly auth?: DashboardEndpointClientOptions["auth"];
  read(request: DashboardEndpointReadRequest): Promise<DashboardEndpointResult>;
}

/**
 * Compose the Dashboard application around the authenticated Endpoint client.
 * Presentation code receives projections from this boundary and never owns
 * repository or mutation semantics.
 */
export function createDashboardApplication(options: DashboardEndpointClientOptions): DashboardApplication {
  const endpoint = createDashboardEndpointClient(options);
  return Object.freeze({
    endpoint,
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    read: (request: DashboardEndpointReadRequest) => endpoint.read(request),
  });
}
