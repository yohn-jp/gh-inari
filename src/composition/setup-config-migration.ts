/**
 * Explicit, bounded adoption of legacy secret-free setup metadata into the
 * canonical repository registry (#1198).
 *
 * Sources, read only through their current validators/public stores:
 * - legacy `runtime/setup/<key>.json` SetupConfigRecord;
 * - legacy `runtime-profiles/*` LocalRuntimeProfile matched by immutable
 *   `repositoryHost + repositoryId` (never by name).
 *
 * Migration is copy/adopt + reread, never move: legacy files are not
 * modified or removed. A canonical record that already exists always wins
 * and is returned unchanged without reading legacy state, so later legacy
 * drift can never replace it. Conflicting App, installation, Authority or
 * endpoint evidence between the sources fails closed before any canonical
 * write. A Runtime profile contributes only public fields that the legacy
 * setup record lacks; its private-key path, relay URL and health `state` are
 * never copied, and no identity is generated.
 */
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import {
  LocalRuntimeProfileError,
  LocalRuntimeProfileStore,
  type LocalRuntimeProfile,
} from "../local-runtime-profile.js";
import {
  SETUP_CONFIG_VERSION,
  SetupConfigStore,
  SetupConfigStoreError,
  validateSetupConfigRecord,
  type SetupConfigApp,
  type SetupConfigAuthority,
  type SetupConfigRecord,
} from "./setup-config-store.js";

export type SetupConfigMigrationErrorCode =
  /** Legacy sources disagree on repository, App, installation, Authority or endpoint evidence. */
  | "SETUP_CONFIG_MIGRATION_CONFLICT"
  /** A legacy source could not be read or validated safely. */
  | "SETUP_CONFIG_MIGRATION_UNREADABLE"
  /** The canonical record could not be written and verified. */
  | "SETUP_CONFIG_MIGRATION_FAILED";

export class SetupConfigMigrationError extends Error {
  readonly code: SetupConfigMigrationErrorCode;

  constructor(code: SetupConfigMigrationErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SetupConfigMigrationError";
    this.code = code;
  }
}

export type SetupConfigMigrationOutcome =
  /** A canonical record already existed; nothing was read from legacy state or written. */
  | "canonical"
  /** A canonical record was created from legacy sources and reread. */
  | "adopted"
  /** No canonical and no legacy source exists; nothing was written. */
  | "absent";

export interface SetupConfigMigrationResult {
  readonly outcome: SetupConfigMigrationOutcome;
  readonly record?: SetupConfigRecord;
  /** Legacy sources that contributed to an adopted record. */
  readonly sources: readonly ("runtime-setup" | "runtime-profile")[];
}

export interface SetupConfigMigrationOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

function conflict(message: string): SetupConfigMigrationError {
  return new SetupConfigMigrationError("SETUP_CONFIG_MIGRATION_CONFLICT", message);
}

function reconcileApp(setup: SetupConfigApp | undefined, profile: LocalRuntimeProfile["app"]): SetupConfigApp {
  if (setup === undefined) {
    return {
      appId: profile.appId,
      installationId: profile.installationId,
      ...(profile.clientId === undefined ? {} : { clientId: profile.clientId }),
    };
  }
  if (setup.appId !== profile.appId) throw conflict("Legacy setup and Runtime profile record different App IDs.");
  if (setup.installationId !== undefined && setup.installationId !== profile.installationId)
    throw conflict("Legacy setup and Runtime profile record different App installations.");
  if (setup.clientId !== undefined && profile.clientId !== undefined && setup.clientId !== profile.clientId)
    throw conflict("Legacy setup and Runtime profile record different App client IDs.");
  const clientId = setup.clientId ?? profile.clientId;
  return {
    appId: setup.appId,
    installationId: setup.installationId ?? profile.installationId,
    ...(clientId === undefined ? {} : { clientId }),
  };
}

function reconcileAuthority(
  setup: SetupConfigAuthority | undefined,
  profile: LocalRuntimeProfile["authority"],
): SetupConfigAuthority {
  if (
    setup !== undefined &&
    (setup.authorityId !== profile.authorityId || setup.publicKeyFingerprint !== profile.publicKeyFingerprint)
  )
    throw conflict("Legacy setup and Runtime profile record different Runtime Authorities.");
  // Only the public identity is carried; the private-key path stays in the profile.
  return { authorityId: profile.authorityId, publicKeyFingerprint: profile.publicKeyFingerprint };
}

/**
 * Pure reconciliation of verified legacy sources into the canonical record
 * candidate. Throws `SETUP_CONFIG_MIGRATION_CONFLICT` without side effects.
 */
export function reconcileLegacySetupConfig(
  repository: RepositoryIdentity,
  setup: SetupConfigRecord | undefined,
  profile: LocalRuntimeProfile | undefined,
): SetupConfigRecord | undefined {
  if (setup === undefined && profile === undefined) return undefined;
  if (
    setup !== undefined &&
    (setup.repository.repositoryHost !== repository.repositoryHost ||
      setup.repository.repositoryId !== repository.repositoryId)
  )
    throw conflict("Legacy setup configuration is for another repository.");
  if (
    profile !== undefined &&
    (profile.repository.repositoryHost !== repository.repositoryHost ||
      profile.repository.repositoryId !== repository.repositoryId)
  )
    throw conflict("Runtime profile is for another repository.");
  if (profile !== undefined && setup?.endpoint !== undefined && setup.endpoint !== profile.endpoint)
    throw conflict("Legacy setup and Runtime profile record different Runtime Endpoints.");
  const base: Record<string, unknown> = {
    ...(setup ?? { version: SETUP_CONFIG_VERSION, revision: 0 }),
    repository: {
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
      nameWithOwner: repository.nameWithOwner,
    },
  };
  if (profile !== undefined) {
    base.endpoint = setup?.endpoint ?? profile.endpoint;
    base.app = reconcileApp(setup?.app, profile.app);
    base.authority = reconcileAuthority(setup?.authority, profile.authority);
  }
  const previousRevision = setup?.revision ?? 0;
  const contributed =
    setup === undefined ||
    JSON.stringify({ endpoint: base.endpoint, app: base.app, authority: base.authority }) !==
      JSON.stringify({ endpoint: setup.endpoint, app: setup.app, authority: setup.authority });
  base.revision = contributed ? previousRevision + 1 : previousRevision;
  try {
    return validateSetupConfigRecord(base);
  } catch (error: unknown) {
    throw new SetupConfigMigrationError(
      "SETUP_CONFIG_MIGRATION_UNREADABLE",
      "Legacy setup metadata is not valid secret-free setup configuration.",
      { cause: error },
    );
  }
}

/**
 * Adopt legacy setup metadata for one explicitly observed repository into
 * `repositories/<repositoryId>/setup.json`. Idempotent: once the canonical
 * record exists the call returns it unchanged.
 */
export async function migrateLegacySetupConfig(
  repository: RepositoryIdentity,
  options: SetupConfigMigrationOptions = {},
): Promise<SetupConfigMigrationResult> {
  const environment = options.environment ?? process.env;
  const store = new SetupConfigStore({ environment });
  const unreadable = (error: unknown): SetupConfigMigrationError =>
    new SetupConfigMigrationError("SETUP_CONFIG_MIGRATION_UNREADABLE", "Setup metadata could not be read safely.", {
      cause: error,
    });
  let existing: SetupConfigRecord | undefined;
  try {
    existing = store.readCanonical(repository);
  } catch (error: unknown) {
    throw unreadable(error);
  }
  if (existing !== undefined) return Object.freeze({ outcome: "canonical", record: existing, sources: [] });

  let setup: SetupConfigRecord | undefined;
  let profile: LocalRuntimeProfile | undefined;
  try {
    setup = store.readLegacy(repository);
  } catch (error: unknown) {
    throw unreadable(error);
  }
  try {
    profile = await new LocalRuntimeProfileStore({ environment }).findForRepositoryIdentity(repository);
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeProfileError && error.code === "LOCAL_RUNTIME_PROFILE_MISMATCH")
      throw new SetupConfigMigrationError(
        "SETUP_CONFIG_MIGRATION_CONFLICT",
        "Runtime profiles for the repository are ambiguous or inconsistent.",
        { cause: error },
      );
    throw unreadable(error);
  }
  const candidate = reconcileLegacySetupConfig(repository, setup, profile);
  if (candidate === undefined) return Object.freeze({ outcome: "absent", sources: [] });

  let adopted: SetupConfigRecord;
  try {
    adopted = store.adopt(repository, candidate);
  } catch (error: unknown) {
    if (error instanceof SetupConfigStoreError && error.code === "SETUP_CONFIG_CONFLICT")
      throw new SetupConfigMigrationError("SETUP_CONFIG_MIGRATION_CONFLICT", error.message, { cause: error });
    throw new SetupConfigMigrationError(
      "SETUP_CONFIG_MIGRATION_FAILED",
      "Canonical setup configuration could not be written.",
      { cause: error },
    );
  }
  let reread: SetupConfigRecord | undefined;
  try {
    reread = store.readCanonical(repository);
  } catch (error: unknown) {
    throw new SetupConfigMigrationError(
      "SETUP_CONFIG_MIGRATION_FAILED",
      "Canonical setup configuration could not be reread.",
      { cause: error },
    );
  }
  if (reread === undefined || JSON.stringify(reread) !== JSON.stringify(adopted))
    throw new SetupConfigMigrationError(
      "SETUP_CONFIG_MIGRATION_FAILED",
      "Canonical setup configuration did not verify after adoption.",
    );
  const sources: ("runtime-setup" | "runtime-profile")[] = [];
  if (setup !== undefined) sources.push("runtime-setup");
  if (profile !== undefined) sources.push("runtime-profile");
  return Object.freeze({ outcome: "adopted", record: reread, sources: Object.freeze(sources) });
}
