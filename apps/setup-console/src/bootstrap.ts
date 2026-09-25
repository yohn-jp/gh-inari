/**
 * In-memory operator context for the local setup wizard (#1119).
 *
 * The bootstrap (API origin, bearer, CSRF token and receiving-machine label)
 * is injected by the hosting product (#1121). This module keeps the bearer and
 * CSRF values only inside a closure: they are never enumerable, serialized,
 * stored, logged, placed in a URL or rendered. Static assets carry no token.
 */

export interface SetupConsoleBootstrap {
  /** Exact origin of the local setup API, e.g. the dynamic or SSH-forwarded loopback origin. */
  readonly apiOrigin: string;
  readonly bearer: string;
  readonly csrf: string;
  /** Human label of the machine whose Runtime receives setup effects and secrets. */
  readonly receivingMachine: string;
}

export interface SetupOperatorContext {
  readonly apiOrigin: string;
  readonly receivingMachine: string;
  /** Authorization headers for one request; never retained by callers. */
  authorizationHeaders(): Record<string, string>;
}

export class SetupConsoleBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupConsoleBootstrapError";
  }
}

const TOKEN = /^[A-Za-z0-9_-]{16,256}$/u;
const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
export const MAX_RECEIVING_MACHINE_LENGTH = 128;

function requireString(record: Record<string, unknown>, key: keyof SetupConsoleBootstrap): string {
  const value = record[key];
  if (typeof value !== "string") throw new SetupConsoleBootstrapError(`Bootstrap ${key} must be a string.`);
  return value;
}

/** Validates the injected bootstrap and captures its credentials in memory only. */
export function createSetupOperatorContext(input: unknown): SetupOperatorContext {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SetupConsoleBootstrapError("Bootstrap must be an object.");
  }
  const record = input as Record<string, unknown>;
  const allowed = ["apiOrigin", "bearer", "csrf", "receivingMachine"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new SetupConsoleBootstrapError("Bootstrap has an unknown member.");
  }
  const apiOrigin = requireString(record, "apiOrigin");
  let url: URL;
  try {
    url = new URL(apiOrigin);
  } catch {
    throw new SetupConsoleBootstrapError("Bootstrap apiOrigin must be a URL origin.");
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== apiOrigin
  ) {
    throw new SetupConsoleBootstrapError("Bootstrap apiOrigin must be an exact local HTTP origin.");
  }
  const bearer = requireString(record, "bearer");
  const csrf = requireString(record, "csrf");
  if (!TOKEN.test(bearer) || !TOKEN.test(csrf)) {
    throw new SetupConsoleBootstrapError("Bootstrap operator credentials are malformed.");
  }
  const receivingMachine = requireString(record, "receivingMachine").trim();
  if (
    receivingMachine.length === 0 ||
    receivingMachine.length > MAX_RECEIVING_MACHINE_LENGTH ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(receivingMachine)
  ) {
    throw new SetupConsoleBootstrapError("Bootstrap receivingMachine must be a short printable label.");
  }
  return Object.freeze({
    apiOrigin: url.origin,
    receivingMachine,
    authorizationHeaders: () => ({ authorization: `Bearer ${bearer}`, "x-csrf-token": csrf }),
    toJSON: () => ({ apiOrigin: url.origin, receivingMachine }),
  });
}
