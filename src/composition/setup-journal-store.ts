/**
 * Persisted, secret-free Setup journal (#1120).
 *
 * Implements `SetupJournalPort` over one bounded file per repository, so a
 * fresh CLI or browser process sees the same unfinished and unknown attempts
 * and the Setup Application reconciles them instead of replaying effects.
 *
 * Every entry is the canonical `SetupJournalEntry` and passes the contract
 * validator (including the secret-material guard) before it is stored.
 * Appends are atomic compare-and-replace. Retention is bounded by entry count
 * and bytes; it first drops superseded entries, then settled outcomes, and
 * never drops recovery evidence (an unfinished attempt or an operation's
 * latest `unknown`/`succeeded`/confirmed-`cancelled` outcome). When only such
 * evidence remains and the bound is still exceeded the append fails, which
 * the Application reports as an unjournaled attempt before any effect.
 */
import {
  LocalControlError,
  MAX_LOCAL_CONFIG_BYTES,
  readExistingLocalJson,
  replaceLocalJsonIfCurrent,
} from "../local-control/config.js";
import {
  MAX_SETUP_JOURNAL_ENTRIES,
  assertSecretFreeSetupJson,
  validateSetupJournalEntry,
  type SetupJournalEntry,
  type SetupJournalPort,
} from "../runtime-contracts/index.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import { SETUP_STATE_DIRECTORY, setupStateFileKey } from "./setup-config-store.js";

export const SETUP_JOURNAL_VERSION = 1 as const;
/** Byte budget of one journal file, below the local configuration bound. */
export const MAX_SETUP_JOURNAL_BYTES = MAX_LOCAL_CONFIG_BYTES - 4 * 1024;
const MAX_APPEND_ATTEMPTS = 4;

interface SetupJournalFile {
  readonly version: typeof SETUP_JOURNAL_VERSION;
  readonly repository: { readonly repositoryHost: string; readonly repositoryId: string };
  readonly entries: readonly SetupJournalEntry[];
}

export type SetupJournalStoreErrorCode =
  "SETUP_JOURNAL_UNREADABLE" | "SETUP_JOURNAL_FULL" | "SETUP_JOURNAL_STORAGE_FAILED";

export class SetupJournalStoreError extends Error {
  readonly code: SetupJournalStoreErrorCode;

  constructor(code: SetupJournalStoreErrorCode, message: string) {
    super(message);
    this.name = "SetupJournalStoreError";
    this.code = code;
  }
}

function validateJournalFile(value: unknown): SetupJournalFile {
  assertSecretFreeSetupJson(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid journal");
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => !["version", "repository", "entries"].includes(key)))
    throw new Error("invalid journal");
  if (file.version !== SETUP_JOURNAL_VERSION) throw new Error("invalid journal");
  const repository = file.repository as Record<string, unknown> | null;
  if (
    repository === null ||
    typeof repository !== "object" ||
    Object.keys(repository).length !== 2 ||
    typeof repository.repositoryHost !== "string" ||
    typeof repository.repositoryId !== "string"
  )
    throw new Error("invalid journal");
  if (!Array.isArray(file.entries) || file.entries.length > MAX_SETUP_JOURNAL_ENTRIES)
    throw new Error("invalid journal");
  const entries = file.entries.map((entry) => validateSetupJournalEntry(entry));
  if (
    entries.some(
      (entry) =>
        entry.generation.repository.repositoryHost !== repository.repositoryHost ||
        entry.generation.repository.repositoryId !== repository.repositoryId,
    )
  )
    throw new Error("invalid journal");
  return Object.freeze({
    version: SETUP_JOURNAL_VERSION,
    repository: Object.freeze({ repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId }),
    entries: Object.freeze(entries),
  });
}

function bytes(file: SetupJournalFile): number {
  return Buffer.byteLength(`${JSON.stringify(file)}\n`, "utf8");
}

/**
 * Indexes of entries that carry recovery evidence: every entry of an
 * unfinished attempt and each operation's latest outcome whose effect may
 * have applied.
 */
function protectedIndexes(entries: readonly SetupJournalEntry[]): Set<number> {
  const keep = new Set<number>();
  const latest = new Map<string, number>();
  entries.forEach((entry, index) => latest.set(entry.actionId, index));
  for (const index of latest.values()) {
    const last = entries[index]!;
    if (last.phase !== "completed") {
      // The whole unfinished attempt back to the previous terminal entry.
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        const entry = entries[cursor]!;
        if (entry.actionId !== last.actionId) continue;
        if (cursor !== index && entry.phase === "completed") break;
        keep.add(cursor);
      }
      continue;
    }
    const confirmed = entries
      .slice(0, index)
      .some((entry) => entry.actionId === last.actionId && entry.phase === "confirmed");
    if (last.outcome === "unknown" || last.outcome === "succeeded" || (last.outcome === "cancelled" && confirmed))
      keep.add(index);
  }
  return keep;
}

/** Bounded retention: superseded entries go first, then settled latest outcomes; evidence is never dropped. */
function retain(file: SetupJournalFile): SetupJournalFile {
  let entries = [...file.entries];
  const fits = (): boolean =>
    entries.length <= MAX_SETUP_JOURNAL_ENTRIES && bytes({ ...file, entries }) <= MAX_SETUP_JOURNAL_BYTES;
  while (!fits()) {
    const keep = protectedIndexes(entries);
    const latest = new Map<string, number>();
    entries.forEach((entry, index) => latest.set(entry.actionId, index));
    const latestIndexes = new Set(latest.values());
    let drop = entries.findIndex((_, index) => !keep.has(index) && !latestIndexes.has(index));
    if (drop < 0) drop = entries.findIndex((_, index) => !keep.has(index));
    if (drop < 0)
      throw new SetupJournalStoreError(
        "SETUP_JOURNAL_FULL",
        "The setup journal holds only unreconciled recovery evidence; reconcile before starting another attempt.",
      );
    entries = entries.filter((_, index) => index !== drop);
  }
  return Object.freeze({ ...file, entries: Object.freeze(entries) });
}

export interface SetupJournalStoreOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export class SetupJournalStore implements SetupJournalPort {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: SetupJournalStoreOptions = {}) {
    this.#environment = options.environment ?? process.env;
  }

  #path(repository: Pick<RepositoryIdentity, "repositoryHost" | "repositoryId">): string {
    return `${SETUP_STATE_DIRECTORY}/${setupStateFileKey(repository)}.journal.json`;
  }

  #load(repository: Pick<RepositoryIdentity, "repositoryHost" | "repositoryId">): SetupJournalFile | undefined {
    let file: SetupJournalFile | undefined;
    try {
      file = readExistingLocalJson("runtime", this.#path(repository), validateJournalFile, this.#environment);
    } catch {
      throw new SetupJournalStoreError("SETUP_JOURNAL_UNREADABLE", "The setup journal could not be read safely.");
    }
    if (
      file !== undefined &&
      (file.repository.repositoryHost !== repository.repositoryHost ||
        file.repository.repositoryId !== repository.repositoryId)
    )
      throw new SetupJournalStoreError("SETUP_JOURNAL_UNREADABLE", "The setup journal is for another repository.");
    return file;
  }

  async append(input: SetupJournalEntry): Promise<void> {
    const entry = validateSetupJournalEntry(input);
    const repository = entry.generation.repository;
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const current = this.#load(repository);
      const next = retain({
        version: SETUP_JOURNAL_VERSION,
        repository: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId },
        entries: [...(current?.entries ?? []), entry],
      });
      try {
        replaceLocalJsonIfCurrent(
          "runtime",
          this.#path(repository),
          current,
          next,
          validateJournalFile,
          this.#environment,
        );
        return;
      } catch (error: unknown) {
        // A concurrent append won the compare-and-replace; reread and append again.
        if (error instanceof LocalControlError && error.code === "LOCAL_CONTROL_CONFIG_CONFLICT") continue;
        throw new SetupJournalStoreError("SETUP_JOURNAL_STORAGE_FAILED", "The setup journal could not be persisted.");
      }
    }
    throw new SetupJournalStoreError("SETUP_JOURNAL_STORAGE_FAILED", "The setup journal kept changing during append.");
  }

  async read(repository: RepositoryIdentity): Promise<readonly SetupJournalEntry[]> {
    return this.#load(repository)?.entries ?? [];
  }
}
