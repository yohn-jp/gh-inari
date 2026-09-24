/**
 * Structured command description (#1098).
 *
 * Setup actions describe a command as an executable plus an argv vector, never
 * as a shell string. Frontends render and quote it; nothing re-parses it.
 */
import { invalid } from "./errors.js";

export const MAX_COMMAND_ARGUMENTS = 64;
export const MAX_COMMAND_ARGUMENT_LENGTH = 1024;

export interface StructuredCommand {
  /** Program name or path, e.g. `inari`. Never a shell snippet. */
  readonly executable: string;
  /** Arguments after the executable, one element per argv entry. */
  readonly argv: readonly string[];
}

// NUL and line breaks would let one argument masquerade as several.
const INVALID_ARGUMENT = /[\u0000\r\n]/u;

export function validateStructuredCommand(input: unknown, path = "$"): StructuredCommand {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalid(path, "must be an object.");
  const { executable, argv, ...extra } = input as Record<string, unknown>;
  if (Object.keys(extra).length > 0) throw invalid(path, "contains unknown members.");
  if (
    typeof executable !== "string" ||
    executable.length === 0 ||
    executable.length > MAX_COMMAND_ARGUMENT_LENGTH ||
    INVALID_ARGUMENT.test(executable) ||
    /\s/u.test(executable)
  ) {
    throw invalid(`${path}.executable`, "must be one non-empty program name without whitespace.");
  }
  if (!Array.isArray(argv) || argv.length > MAX_COMMAND_ARGUMENTS) {
    throw invalid(`${path}.argv`, `must be an array of at most ${MAX_COMMAND_ARGUMENTS} arguments.`);
  }
  argv.forEach((argument, index) => {
    if (
      typeof argument !== "string" ||
      argument.length > MAX_COMMAND_ARGUMENT_LENGTH ||
      INVALID_ARGUMENT.test(argument)
    ) {
      throw invalid(`${path}.argv[${index}]`, "must be a bounded single-line string.");
    }
  });
  return Object.freeze({ executable, argv: Object.freeze([...(argv as string[])]) });
}
