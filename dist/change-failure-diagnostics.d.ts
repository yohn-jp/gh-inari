import { type ChangeDiagnostic } from "./change.js";
/** The trusted Actions failure envelope stays small even when Core is valid. */
export declare const MAX_TRUSTED_FAILURE_DIAGNOSTICS_BYTES: 16384;
export declare function isSecretSafeBoundedText(value: unknown, maximum: number): value is string;
/**
 * Validate the Core diagnostic contract at a transport producer/consumer
 * boundary. No exception text or provider payload is accepted here.
 */
export declare function normalizeTrustedFailureDiagnostics(value: unknown): readonly ChangeDiagnostic[] | undefined;
export declare function isSafeTrustedFailureDiagnostics(value: unknown): value is readonly ChangeDiagnostic[];
