/** Bounded discovery state for the currently running local Runtime processes. */

import { randomBytes } from "node:crypto";
import {
  localComponentPath,
  readLocalJson,
  removeLocalJson,
  replaceLocalJson,
  type LocalConfigValidator,
} from "./config.js";

export const LOCAL_RUNTIME_DISCOVERY_VERSION = 1 as const;
export type LocalRuntimeComponent = "admission" | "executor";

export interface LocalRuntimeEndpoint {
  readonly version: typeof LOCAL_RUNTIME_DISCOVERY_VERSION;
  readonly component: LocalRuntimeComponent;
  readonly id: string;
  readonly endpoint: string;
  readonly instanceId: string;
}

export type LocalRuntimeEndpointScheme = "http" | "https";

export type LocalRuntimeDiscoveryErrorCode =
  | "LOCAL_RUNTIME_ENDPOINT_NOT_DISCOVERED"
  | "LOCAL_RUNTIME_ENDPOINT_IDENTITY_MISMATCH"
  | "LOCAL_RUNTIME_ENDPOINT_INVALID";

export class LocalRuntimeDiscoveryError extends Error {
  readonly code: LocalRuntimeDiscoveryErrorCode;

  constructor(code: LocalRuntimeDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "LocalRuntimeDiscoveryError";
    this.code = code;
  }
}

function invalid(): LocalRuntimeDiscoveryError {
  return new LocalRuntimeDiscoveryError("LOCAL_RUNTIME_ENDPOINT_INVALID", "Local Runtime discovery state is invalid.");
}

function endpointId(value: unknown, component: LocalRuntimeComponent): string {
  const prefix = component === "admission" ? "adm_" : "exec_";
  if (typeof value !== "string" || !value.startsWith(prefix) || !/^[A-Za-z0-9_-]{16,64}$/u.test(value.slice(4))) {
    throw invalid();
  }
  return value;
}

export function validateLocalRuntimeEndpoint(value: unknown): LocalRuntimeEndpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["version", "component", "id", "endpoint", "instanceId"].includes(key)) ||
    record.version !== LOCAL_RUNTIME_DISCOVERY_VERSION ||
    (record.component !== "admission" && record.component !== "executor")
  ) {
    throw invalid();
  }
  const component = record.component;
  let endpoint: URL;
  try {
    if (typeof record.endpoint !== "string" || record.endpoint.length > 256) throw invalid();
    endpoint = new URL(record.endpoint);
  } catch {
    throw invalid();
  }
  if (
    (component === "admission" && endpoint.protocol !== "http:") ||
    (component === "executor" && endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port.length === 0 ||
    !Number.isInteger(Number(endpoint.port)) ||
    Number(endpoint.port) < 1 ||
    Number(endpoint.port) > 65535 ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.pathname !== "/" ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    typeof record.instanceId !== "string" ||
    !/^[A-Za-z0-9_-]{24,64}$/u.test(record.instanceId)
  ) {
    throw invalid();
  }
  return Object.freeze({
    version: LOCAL_RUNTIME_DISCOVERY_VERSION,
    component,
    id: endpointId(record.id, component),
    endpoint: endpoint.origin,
    instanceId: record.instanceId,
  });
}

const endpointValidator: LocalConfigValidator<LocalRuntimeEndpoint> = validateLocalRuntimeEndpoint;

function discoveryPath(component: LocalRuntimeComponent): string {
  return `endpoints/${component}.json`;
}

export function localRuntimeDiscoveryPath(
  component: LocalRuntimeComponent,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return localComponentPath("runtime", discoveryPath(component), environment);
}

export function readLocalRuntimeEndpoint(
  component: LocalRuntimeComponent,
  environment: NodeJS.ProcessEnv = process.env,
): LocalRuntimeEndpoint | undefined {
  return readLocalJson("runtime", discoveryPath(component), endpointValidator, environment);
}

export function requireLocalRuntimeEndpoint(
  component: LocalRuntimeComponent,
  expectedId: string,
  environment: NodeJS.ProcessEnv = process.env,
): LocalRuntimeEndpoint {
  const current = readLocalRuntimeEndpoint(component, environment);
  if (current === undefined) {
    throw new LocalRuntimeDiscoveryError(
      "LOCAL_RUNTIME_ENDPOINT_NOT_DISCOVERED",
      `Local ${component === "admission" ? "Admission" : "Executor"} is not currently available.`,
    );
  }
  if (current.id !== expectedId) {
    throw new LocalRuntimeDiscoveryError(
      "LOCAL_RUNTIME_ENDPOINT_IDENTITY_MISMATCH",
      `Discovered local ${component === "admission" ? "Admission" : "Executor"} identity does not match setup.`,
    );
  }
  return current;
}

export function publishLocalRuntimeEndpoint(
  component: LocalRuntimeComponent,
  id: string,
  port: number,
  environment: NodeJS.ProcessEnv = process.env,
  scheme: LocalRuntimeEndpointScheme = "http",
): LocalRuntimeEndpoint {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
  if (component === "admission" && scheme !== "http") throw invalid();
  const candidate = validateLocalRuntimeEndpoint({
    version: LOCAL_RUNTIME_DISCOVERY_VERSION,
    component,
    id,
    endpoint: `${scheme}://127.0.0.1:${port}`,
    instanceId: randomBytes(24).toString("base64url"),
  });
  return replaceLocalJson("runtime", discoveryPath(component), candidate, endpointValidator, environment);
}

export function clearLocalRuntimeEndpoint(
  announcement: LocalRuntimeEndpoint,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return removeLocalJson(
    "runtime",
    discoveryPath(announcement.component),
    endpointValidator,
    (current) => current.instanceId === announcement.instanceId,
    environment,
  );
}
