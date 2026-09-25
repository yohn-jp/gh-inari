import { CAPABILITY_KINDS, type CapabilityKind } from "../agent-authority/capability.js";
import { delegatorPublicKeyFingerprint, type DelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { canonicalDelegatorJson, type Delegator } from "../agent-authority/delegator.js";
import type { LocalRuntimeProfile } from "../local-runtime-profile.js";

/** Authority-owned selection request. Generic Setup actions carry no key or grant intent. */
export interface SetupTrustRequest {
  readonly repository: LocalRuntimeProfile["repository"];
  readonly profile?: LocalRuntimeProfile;
  readonly authorityId: string;
  readonly key: DelegatorKeyPair;
  readonly local: readonly Delegator[];
  readonly canonical?: readonly Delegator[];
  /** Explicit intent for new preparation or an exact-match assertion on adoption. */
  readonly capabilityIntent?: readonly CapabilityKind[];
  readonly maxSessionTtlSeconds: number;
}

export class SetupTrustSelectionError extends Error {
  constructor(
    readonly code: "IDENTITY_CONFLICT" | "RECORD_UNAVAILABLE" | "INTENT_REQUIRED" | "EXPLICIT_TRUST_CHANGE_REQUIRED",
  ) {
    super(code);
    this.name = "SetupTrustSelectionError";
  }
}

function sameCapabilities(left: readonly CapabilityKind[], right: readonly CapabilityKind[]): boolean {
  return left.length === right.length && left.every((capability) => right.includes(capability));
}

/** Canonical trust takes precedence; conflicting local material blocks before a write. */
export function selectSetupAuthority(request: SetupTrustRequest): Delegator {
  const fingerprint = delegatorPublicKeyFingerprint(request.key.publicKeyJwk);
  if (
    request.profile !== undefined &&
    (request.profile.repository.repositoryId !== request.repository.repositoryId ||
      request.profile.repository.repositoryHost !== request.repository.repositoryHost ||
      request.profile.authority.authorityId !== request.authorityId ||
      request.profile.authority.publicKeyFingerprint !== fingerprint)
  )
    throw new SetupTrustSelectionError("IDENTITY_CONFLICT");

  const candidates = [...request.local, ...(request.canonical ?? [])];
  const matching = candidates.filter(
    (record) => record.id === request.authorityId || delegatorPublicKeyFingerprint(record.key) === fingerprint,
  );
  if (
    matching.some(
      (record) => record.id !== request.authorityId || delegatorPublicKeyFingerprint(record.key) !== fingerprint,
    ) ||
    matching.some((record) => canonicalDelegatorJson(record) !== canonicalDelegatorJson(matching[0]))
  )
    throw new SetupTrustSelectionError("IDENTITY_CONFLICT");

  const selected =
    (request.canonical ?? []).find((record) => record.id === request.authorityId) ??
    request.local.find((record) => record.id === request.authorityId);
  if (selected !== undefined) {
    if (
      request.capabilityIntent !== undefined &&
      !sameCapabilities(selected.capabilityCeiling, request.capabilityIntent)
    )
      throw new SetupTrustSelectionError("EXPLICIT_TRUST_CHANGE_REQUIRED");
    return selected;
  }
  if (request.profile !== undefined) throw new SetupTrustSelectionError("RECORD_UNAVAILABLE");
  if (
    request.capabilityIntent === undefined ||
    request.capabilityIntent.length === 0 ||
    request.capabilityIntent.some((capability) => !CAPABILITY_KINDS.includes(capability))
  )
    throw new SetupTrustSelectionError("INTENT_REQUIRED");
  return createDelegatorRecord({
    id: request.authorityId,
    key: request.key,
    maxSessionTtlSeconds: request.maxSessionTtlSeconds,
    capabilityCeiling: request.capabilityIntent,
  });
}
