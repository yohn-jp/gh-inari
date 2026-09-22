/** Public, secret-free deployment metadata for local Endpoint onboarding. */

export const ENDPOINT_ONBOARDING_DESCRIPTOR_VERSION = 1 as const;
export const ENDPOINT_ONBOARDING_PATH = "/.well-known/inari" as const;
export const ENDPOINT_ONBOARDING_APP_USER_AUTH_PROFILE = "device-flow" as const;

const MAX_HOST_BYTES = 255;
const MAX_TEXT_BYTES = 128;
const MAX_URL_BYTES = 2_048;
const JSON_ENCODER = new TextEncoder();
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f]/u;
const APP_ID_PATTERN = /^[1-9][0-9]{0,63}$/u;
const APP_SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,127})$/u;

const DESCRIPTOR_KEYS = [
  "version",
  "githubHost",
  "appId",
  "appClientId",
  "appSlug",
  "appInstallationUrl",
  "appUserAuthProfile",
  "appCallbackUrl",
  "relayConnectionBase",
] as const;

export type EndpointOnboardingDescriptorErrorCode =
  | "ENDPOINT_ONBOARDING_INVALID_ROOT"
  | "ENDPOINT_ONBOARDING_MALFORMED_JSON"
  | "ENDPOINT_ONBOARDING_MISSING_FIELD"
  | "ENDPOINT_ONBOARDING_UNKNOWN_FIELD"
  | "ENDPOINT_ONBOARDING_UNSUPPORTED_VERSION"
  | "ENDPOINT_ONBOARDING_INVALID_TEXT"
  | "ENDPOINT_ONBOARDING_LIMIT_EXCEEDED"
  | "ENDPOINT_ONBOARDING_INVALID_HOST"
  | "ENDPOINT_ONBOARDING_INVALID_URL"
  | "ENDPOINT_ONBOARDING_INVALID_PROFILE";

export class EndpointOnboardingDescriptorError extends TypeError {
  readonly code: EndpointOnboardingDescriptorErrorCode;
  readonly path: string;

  constructor(code: EndpointOnboardingDescriptorErrorCode, path: string, message: string) {
    super(message);
    this.name = "EndpointOnboardingDescriptorError";
    this.code = code;
    this.path = path;
  }
}

export interface EndpointOnboardingDescriptor {
  readonly version: typeof ENDPOINT_ONBOARDING_DESCRIPTOR_VERSION;
  readonly githubHost: string;
  readonly appId: string;
  readonly appClientId: string;
  readonly appSlug: string;
  readonly appInstallationUrl: string;
  readonly appUserAuthProfile: typeof ENDPOINT_ONBOARDING_APP_USER_AUTH_PROFILE;
  /** Exact browser OAuth callback; omitted for legacy Device Flow-only deployments. */
  readonly appCallbackUrl?: string;
  readonly relayConnectionBase: string;
}

export interface EndpointOnboardingDescriptorInput {
  readonly githubHost: string;
  readonly appId: string;
  readonly appClientId: string;
  readonly appSlug: string;
  readonly appInstallationUrl: string;
  readonly appUserAuthProfile: string;
  readonly appCallbackUrl?: string;
  readonly relayConnectionBase: string;
}

function fail(code: EndpointOnboardingDescriptorErrorCode, path: string, message: string): never {
  throw new EndpointOnboardingDescriptorError(code, path, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) fail("ENDPOINT_ONBOARDING_INVALID_ROOT", "$", "Descriptor must be a plain object.");
  return value;
}

function assertClosedDescriptor(value: Record<string, unknown>): void {
  const allowed = new Set<string>(DESCRIPTOR_KEYS);
  const symbol = Reflect.ownKeys(value).find((key): key is symbol => typeof key === "symbol");
  if (symbol !== undefined) {
    fail("ENDPOINT_ONBOARDING_UNKNOWN_FIELD", "$", "Symbol properties are not part of the descriptor schema.");
  }
  const unknown = Reflect.ownKeys(value)
    .filter((key): key is string => typeof key === "string")
    .find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    fail(
      "ENDPOINT_ONBOARDING_UNKNOWN_FIELD",
      `$.${unknown}`,
      `Field "${unknown}" is not part of the descriptor schema.`,
    );
  }
  for (const key of DESCRIPTOR_KEYS) {
    if (key === "appCallbackUrl") continue;
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("ENDPOINT_ONBOARDING_MISSING_FIELD", `$.${key}`, `Required field "${key}" is missing.`);
    }
  }
}

function boundedText(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("ENDPOINT_ONBOARDING_INVALID_TEXT", path, "Descriptor text must be a non-empty string.");
  }
  const normalized = value.normalize("NFC");
  if (UNSAFE_TEXT_PATTERN.test(normalized) || /[\ud800-\udfff]/u.test(normalized)) {
    fail("ENDPOINT_ONBOARDING_INVALID_TEXT", path, "Descriptor text contains unsafe or unpaired Unicode characters.");
  }
  if (JSON_ENCODER.encode(normalized).byteLength > maxBytes) {
    fail("ENDPOINT_ONBOARDING_LIMIT_EXCEEDED", path, "Descriptor text exceeds its byte ceiling.");
  }
  return normalized;
}

function boundedHost(value: unknown, path: string): string {
  const host = boundedText(value, path, MAX_HOST_BYTES).toLowerCase();
  if (host.length > 253 || host.includes(":")) {
    fail("ENDPOINT_ONBOARDING_INVALID_HOST", path, "GitHub host must be a DNS hostname without a port.");
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}/`);
  } catch {
    fail("ENDPOINT_ONBOARDING_INVALID_HOST", path, "GitHub host must be a valid DNS hostname.");
  }
  if (parsed.hostname !== host || parsed.username !== "" || parsed.password !== "") {
    fail("ENDPOINT_ONBOARDING_INVALID_HOST", path, "GitHub host must be a valid DNS hostname.");
  }
  return host;
}

function boundedUrl(value: unknown, path: string, protocols: readonly string[]): string {
  const text = boundedText(value, path, MAX_URL_BYTES);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail("ENDPOINT_ONBOARDING_INVALID_URL", path, "Descriptor URL is invalid.");
  }
  if (
    !protocols.includes(parsed.protocol) ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    fail("ENDPOINT_ONBOARDING_INVALID_URL", path, "Descriptor URL uses an unsupported origin.");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    fail("ENDPOINT_ONBOARDING_INVALID_URL", path, "Descriptor URL must not contain query or fragment data.");
  }
  return parsed.toString();
}

function normalizeDescriptor(value: unknown): EndpointOnboardingDescriptor {
  const input = record(value);
  assertClosedDescriptor(input);
  if (input.version !== ENDPOINT_ONBOARDING_DESCRIPTOR_VERSION) {
    fail("ENDPOINT_ONBOARDING_UNSUPPORTED_VERSION", "$.version", "Descriptor version is not supported.");
  }
  const appId = boundedText(input.appId, "$.appId", MAX_TEXT_BYTES);
  if (!APP_ID_PATTERN.test(appId)) {
    fail("ENDPOINT_ONBOARDING_INVALID_TEXT", "$.appId", "App ID must be a positive decimal identifier.");
  }
  const appSlug = boundedText(input.appSlug, "$.appSlug", MAX_TEXT_BYTES);
  if (!APP_SLUG_PATTERN.test(appSlug)) {
    fail("ENDPOINT_ONBOARDING_INVALID_TEXT", "$.appSlug", "App slug is invalid.");
  }
  const appUserAuthProfile = input.appUserAuthProfile;
  if (appUserAuthProfile !== ENDPOINT_ONBOARDING_APP_USER_AUTH_PROFILE) {
    fail("ENDPOINT_ONBOARDING_INVALID_PROFILE", "$.appUserAuthProfile", "App-user auth profile is unsupported.");
  }
  const appCallbackUrl =
    input.appCallbackUrl === undefined ? undefined : boundedUrl(input.appCallbackUrl, "$.appCallbackUrl", ["https:"]);
  return Object.freeze({
    version: ENDPOINT_ONBOARDING_DESCRIPTOR_VERSION,
    githubHost: boundedHost(input.githubHost, "$.githubHost"),
    appId,
    appClientId: boundedText(input.appClientId, "$.appClientId", MAX_TEXT_BYTES),
    appSlug,
    appInstallationUrl: boundedUrl(input.appInstallationUrl, "$.appInstallationUrl", ["https:"]),
    appUserAuthProfile,
    ...(appCallbackUrl === undefined ? {} : { appCallbackUrl }),
    relayConnectionBase: boundedUrl(input.relayConnectionBase, "$.relayConnectionBase", ["wss:"]),
  });
}

/** Validate and construct a descriptor from deployment metadata. */
export function createEndpointOnboardingDescriptor(
  input: EndpointOnboardingDescriptorInput,
): EndpointOnboardingDescriptor {
  return normalizeDescriptor({ version: ENDPOINT_ONBOARDING_DESCRIPTOR_VERSION, ...input });
}

/** Decode a descriptor object or its JSON representation using the closed contract. */
export function decodeEndpointOnboardingDescriptor(value: unknown): EndpointOnboardingDescriptor {
  if (typeof value === "string") {
    if (JSON_ENCODER.encode(value).byteLength > MAX_URL_BYTES * 8) {
      fail("ENDPOINT_ONBOARDING_LIMIT_EXCEEDED", "$", "Descriptor JSON exceeds its byte ceiling.");
    }
    try {
      return normalizeDescriptor(JSON.parse(value) as unknown);
    } catch (error) {
      if (error instanceof EndpointOnboardingDescriptorError) throw error;
      fail("ENDPOINT_ONBOARDING_MALFORMED_JSON", "$", "Descriptor JSON is malformed.");
    }
  }
  return normalizeDescriptor(value);
}

/** Encode a validated descriptor as canonical JSON. */
export function encodeEndpointOnboardingDescriptor(value: unknown): string {
  return JSON.stringify(decodeEndpointOnboardingDescriptor(value));
}
