/**
 * Bounded validation failure for the neutral Runtime contracts (#1098).
 *
 * Messages name the offending JSON path only; they never echo input values,
 * so a rejected secret cannot leak through a diagnostic.
 */
export type RuntimeContractErrorCode =
  "RUNTIME_CONTRACT_INVALID" | "RUNTIME_CONTRACT_SECRET_MATERIAL" | "RUNTIME_CONTRACT_TOO_LARGE";

export class RuntimeContractError extends Error {
  readonly code: RuntimeContractErrorCode;
  readonly path: string;

  constructor(code: RuntimeContractErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "RuntimeContractError";
    this.code = code;
    this.path = path;
  }
}

export function invalid(path: string, message: string): RuntimeContractError {
  return new RuntimeContractError("RUNTIME_CONTRACT_INVALID", path, message);
}
