/**
 * Initiating-Runtime Authority owner (#1108).
 *
 * The local Runtime Authority private key is loaded and used only here. The
 * existing Delegator key custody, Session-binding signer and Change-provenance
 * signer are reused unchanged; this module only makes their private-key use
 * explicit in the Authority owner. Admission and Executor never import it.
 */
import {
  delegatorPublicKeyFingerprint,
  exportDelegatorPublicKey,
  loadDelegatorKeyPair,
  type DelegatorKeyPair,
} from "../agent-authority/delegator-key.js";
import { createLocalDelegatorSignedChangeProvenanceRecord } from "../agent-authority/delegator-operations.js";
import type { Delegator } from "../agent-authority/delegator.js";
import type { SignedChangeProvenanceRecord } from "../change-provenance-record.js";
import { localComponentPath, readLocalJson, validateLocalAuthorityConfig } from "../local-control/config.js";
import {
  createLocalSessionBinding,
  type CreateLocalSessionBindingOptions,
  type LocalSessionBinding,
} from "../local-control/session-binding.js";
import type { AuthoritySigningPort } from "../runtime-contracts/index.js";
import { AuthorityStoreError, openLocalAuthorityCustody, type LocalAuthoritySelector } from "./authority-store.js";

export class LocalRuntimeAuthorityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalRuntimeAuthorityError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new LocalRuntimeAuthorityError(code, message);
}

export type LocalRuntimeSessionBindingRequest = Omit<
  CreateLocalSessionBindingOptions,
  "runtimeAuthority" | "runtimeKey"
>;

/**
 * Local Runtime Authority signer. The public pinned `authority` record may be
 * read by callers; the private key stays inside this closure.
 */
export interface LocalRuntimeAuthority extends AuthoritySigningPort {
  readonly authority: Delegator;
  issueSessionBinding(request: LocalRuntimeSessionBindingRequest): LocalSessionBinding;
}

export interface OpenLocalRuntimeAuthorityOptions {
  readonly environment: NodeJS.ProcessEnv;
  /** Public Admission-pinned Runtime Authority trust, resolved by the caller after key custody is checked. */
  readonly trustedAuthority: () => Delegator;
  /** Signing time for Change provenance. */
  readonly now?: Date;
  /**
   * Exact Authority-ID-scoped custody entry to open. When omitted the legacy
   * single `authority/config.json + private-key.pem` custody is opened.
   */
  readonly authoritySelector?: LocalAuthoritySelector;
}

function openLegacyCustody(options: OpenLocalRuntimeAuthorityOptions): {
  readonly runtimeKey: DelegatorKeyPair;
  readonly authority: Delegator;
} {
  const { environment } = options;
  const authorityConfig = readLocalJson("authority", "config.json", validateLocalAuthorityConfig, environment);
  if (authorityConfig === undefined) fail("LOCAL_CONTROL_INVALID_CONFIG", "Local Runtime Authority is not configured.");
  const privateKeyPath = localComponentPath("authority", authorityConfig.privateKeyFile, environment);
  let runtimeKey: DelegatorKeyPair;
  try {
    runtimeKey = loadDelegatorKeyPair(privateKeyPath);
  } catch {
    fail("RUNTIME_AUTHORITY_KEY_NOT_FOUND", "Local Runtime Authority private key could not be loaded.");
  }
  const publicKey = exportDelegatorPublicKey(runtimeKey);
  if (
    publicKey.x !== authorityConfig.publicKey.x ||
    delegatorPublicKeyFingerprint(runtimeKey) !== authorityConfig.publicKeyFingerprint
  ) {
    fail("RUNTIME_AUTHORITY_KEY_MISMATCH", "Local Runtime Authority key does not match its custody descriptor.");
  }

  const authority = options.trustedAuthority();
  if (authority.key.x !== authorityConfig.publicKey.x) {
    fail("ADMISSION_AUTHORITY_MISMATCH", "Local Runtime Authority key does not match Admission trust.");
  }
  return { runtimeKey, authority };
}

/**
 * Open one exact Authority-ID-scoped entry. Custody (ID, descriptor, key and
 * optional fingerprint pin) is proven before trust is read; the trusted
 * canonical record must then carry the same Authority ID and public key.
 */
function openSelectedCustody(
  options: OpenLocalRuntimeAuthorityOptions,
  selector: LocalAuthoritySelector,
): { readonly runtimeKey: DelegatorKeyPair; readonly authority: Delegator } {
  let custody: ReturnType<typeof openLocalAuthorityCustody>;
  try {
    custody = openLocalAuthorityCustody(selector, options.environment);
  } catch (error: unknown) {
    if (error instanceof AuthorityStoreError) fail(error.code, error.message);
    throw error;
  }
  const authority = options.trustedAuthority();
  if (
    authority.id !== custody.identity.authorityId ||
    authority.key.x !== custody.identity.publicKey.x ||
    delegatorPublicKeyFingerprint(authority.key) !== custody.identity.publicKeyFingerprint
  ) {
    fail("ADMISSION_AUTHORITY_MISMATCH", "Local Runtime Authority identity does not match Admission trust.");
  }
  return { runtimeKey: custody.key, authority };
}

/**
 * Load local Runtime Authority key custody, check it against its custody
 * descriptor and the Admission-pinned public trust, and return a signer.
 */
export function openLocalRuntimeAuthority(options: OpenLocalRuntimeAuthorityOptions): LocalRuntimeAuthority {
  const { runtimeKey, authority } =
    options.authoritySelector === undefined
      ? openLegacyCustody(options)
      : openSelectedCustody(options, options.authoritySelector);

  return Object.freeze({
    authority,
    issueSessionBinding(request: LocalRuntimeSessionBindingRequest): LocalSessionBinding {
      return createLocalSessionBinding({ ...request, runtimeAuthority: authority, runtimeKey });
    },
    async signChangeProvenance(rootIssue: number): Promise<SignedChangeProvenanceRecord> {
      return createLocalDelegatorSignedChangeProvenanceRecord(rootIssue, {
        authorityId: authority.id,
        privateKey: runtimeKey,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    },
  });
}
