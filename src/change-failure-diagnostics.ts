import {
  CHANGE_CONTRACT_VERSION,
  MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH,
  MAX_CHANGE_DIAGNOSTICS,
  createChangeDiagnosticReport,
  type ChangeDiagnostic,
} from "./change.js";

/** The trusted Actions failure envelope stays small even when Core is valid. */
export const MAX_TRUSTED_FAILURE_DIAGNOSTICS_BYTES = 16_384 as const;

const DIAGNOSTIC_KEYS = new Set(["version", "code", "path", "message"]);
const UNSAFE_DIAGNOSTIC_TEXT =
  /(?:-----BEGIN|bearer\s+|(?:access|refresh|installation|github|oauth)?[-_ ]?token\b|private\s*key|password|secret|credential|authorization|cookie|raw\s+(?:github|provider|api)?\s*(?:body|response|payload|exception|error)|(?:github|provider|api)\s+(?:api\s+)?(?:body|response|payload)|(?:^|[\\/])(?:etc|home|mnt|opt|private|root|run|srv|tmp|users|var|workspace)(?:[\\/]|$)|[A-Za-z]:[\\/]|(?:ghp|github_pat|gho|ghs|ghr)_[A-Za-z0-9_]+|https?:\/\/)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeDiagnosticText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/u.test(value) &&
    !UNSAFE_DIAGNOSTIC_TEXT.test(value)
  );
}

export function isSecretSafeBoundedText(value: unknown, maximum: number): value is string {
  return safeDiagnosticText(value, maximum);
}

/**
 * Validate the Core diagnostic contract at a transport producer/consumer
 * boundary. No exception text or provider payload is accepted here.
 */
export function normalizeTrustedFailureDiagnostics(value: unknown): readonly ChangeDiagnostic[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CHANGE_DIAGNOSTICS) {
    throw new TypeError("Trusted Change diagnostics exceed their bounded count.");
  }
  for (const candidate of value) {
    if (!isRecord(candidate) || [...Object.keys(candidate)].some((key) => !DIAGNOSTIC_KEYS.has(key))) {
      throw new TypeError("Trusted Change diagnostics contain an unsupported property.");
    }
    if (
      candidate.version !== CHANGE_CONTRACT_VERSION ||
      typeof candidate.code !== "string" ||
      !safeDiagnosticText(candidate.path, MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH) ||
      !safeDiagnosticText(candidate.message, MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH)
    ) {
      throw new TypeError("Trusted Change diagnostics are malformed or unsafe.");
    }
  }
  const diagnostics = createChangeDiagnosticReport(value as readonly ChangeDiagnostic[]).diagnostics;
  const serialized = JSON.stringify(diagnostics);
  if (utf8Bytes(serialized) > MAX_TRUSTED_FAILURE_DIAGNOSTICS_BYTES) {
    throw new RangeError("Trusted Change diagnostics exceed their bounded byte size.");
  }
  return Object.freeze([...diagnostics]);
}

export function isSafeTrustedFailureDiagnostics(value: unknown): value is readonly ChangeDiagnostic[] {
  try {
    normalizeTrustedFailureDiagnostics(value);
    return true;
  } catch {
    return false;
  }
}
