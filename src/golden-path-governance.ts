/**
 * Bounded, read-only governance discovery for the Golden Path.
 *
 * This module is an agent-facing projection.  Template selection, Canon
 * resolution, compilation, and generation semantics remain owned by the
 * existing governance authorities; this layer only exposes their result as a
 * small status/next-action contract.
 */

import {
  compileRepositoryEffectiveArtifactContract,
  type ArtifactContractResolutionError,
  type RepositoryEffectiveArtifactKind,
} from "./artifact-contract-governance.js";
import {
  compileRepositoryGovernedContract,
  GovernanceError,
  verifyGovernedMutationFreshness,
  type GovernedArtifactDomain,
} from "./governance.js";
import type { ArtifactContractProvenance, CanonicalContract, ContractProvenance } from "./contract/ir.js";
import type { EffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { GitHubAdapter } from "./github/index.js";
import { TemplateDiscoveryError, type TemplateSelector } from "./template-discovery.js";
import { TemplateResolutionError, type TemplateResolverDependencies } from "./template-resolver.js";

export const GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION = "1" as const;
const MAX_DIAGNOSTIC_CANDIDATES = 8;

export type GoldenPathGovernanceSource = "native-template" | "artifact-contract";
export type GoldenPathGovernanceDomain = "issue" | "pr" | "branch" | "pull_request";
export type GoldenPathGovernanceContract = CanonicalContract | EffectiveArtifactContract;
export type GoldenPathGovernanceProvenance = ContractProvenance | ArtifactContractProvenance;

export type GoldenPathGovernanceStatus =
  "resolved" | "discovery-required" | "ambiguous" | "stale" | "incompatible" | "unavailable";

export type GoldenPathGovernanceReasonCode =
  | "RESOLVED"
  | "NO_GOVERNANCE_CANDIDATES"
  | "SELECTOR_INVALID"
  | "SELECTOR_NOT_FOUND"
  | "SELECTOR_AMBIGUOUS"
  | "DEFAULT_INVALID"
  | "DEFAULT_UNAVAILABLE"
  | "DEFAULT_AMBIGUOUS"
  | "GOVERNANCE_SOURCE_UNAVAILABLE"
  | "GOVERNANCE_SOURCE_INVALID"
  | "ARTIFACT_CONTRACT_NOT_FOUND"
  | "ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS"
  | "ARTIFACT_CONTRACT_SOURCE_INVALID"
  | "ARTIFACT_CONTRACT_KIND_INVALID"
  | "GENERATION_STALE"
  | "REQUEST_INCOMPATIBLE";

export interface GoldenPathGovernanceDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly candidates: readonly string[];
  readonly candidateCount: number;
  readonly candidatesTruncated: boolean;
}

export interface GoldenPathGovernanceNextAction {
  /** Stable action name for agent projections. */
  readonly action:
    | "direct-governed-create"
    | "inspect-governance"
    | "provide-template-selector"
    | "refresh-governance"
    | "repair-governance";
  /** Alias useful to callers that model actions by kind. */
  readonly kind: GoldenPathGovernanceNextAction["action"];
  readonly reason?: GoldenPathGovernanceReasonCode;
  readonly candidates?: readonly string[];
}

export interface GoldenPathKnownGovernance {
  readonly source: GoldenPathGovernanceSource;
  readonly contract: GoldenPathGovernanceContract;
}

export interface GoldenPathGovernanceDiscoveryRequest {
  readonly domain: GoldenPathGovernanceDomain;
  readonly source?: GoldenPathGovernanceSource;
  readonly selector?: string | TemplateSelector;
  /** Previously compiled evidence.  It is accepted only after freshness verification. */
  readonly known?: GoldenPathKnownGovernance;
  /** Optional caller expectation used to reject a result from another generation. */
  readonly expectedGeneration?: string;
  readonly capabilities?: readonly string[];
  readonly templateResolver?: TemplateResolverDependencies;
}

export interface GoldenPathGovernanceResolved {
  readonly version: typeof GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION;
  readonly status: "resolved";
  readonly domain: GoldenPathGovernanceDomain;
  readonly source: GoldenPathGovernanceSource;
  readonly contract: GoldenPathGovernanceContract;
  readonly provenance: GoldenPathGovernanceProvenance;
  readonly generation: GoldenPathGovernanceProvenance;
  readonly nextAction: GoldenPathGovernanceNextAction;
}

export interface GoldenPathGovernanceUnresolved {
  readonly version: typeof GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION;
  readonly status: Exclude<GoldenPathGovernanceStatus, "resolved">;
  readonly domain: GoldenPathGovernanceDomain;
  readonly source: GoldenPathGovernanceSource;
  readonly reason: GoldenPathGovernanceReasonCode;
  readonly nextAction: GoldenPathGovernanceNextAction;
  readonly diagnostic: GoldenPathGovernanceDiagnostic;
  readonly generation?: GoldenPathGovernanceProvenance;
}

export type GoldenPathGovernanceDiscoveryResult = GoldenPathGovernanceResolved | GoldenPathGovernanceUnresolved;

/**
 * Resolve repository governance without performing a mutation.
 *
 * `native-template` delegates to `governance.ts`; `artifact-contract`
 * delegates to Artifact Contract governance.  No local checkout or recursive
 * repository scan is consulted by either path.
 */
export async function discoverGoldenPathGovernance(
  adapter: GitHubAdapter,
  request: GoldenPathGovernanceDiscoveryRequest,
): Promise<GoldenPathGovernanceDiscoveryResult> {
  const source = request.source ?? defaultSource(request.domain);
  if (!isSourceCompatible(source, request.domain)) {
    return unresolved(request, source, "REQUEST_INCOMPATIBLE", "incompatible", {
      code: "REQUEST_INCOMPATIBLE",
      message: `Governance source "${source}" cannot resolve domain "${request.domain}".`,
      candidates: [],
      candidateCount: 0,
      candidatesTruncated: false,
    });
  }

  if (request.known !== undefined) {
    const knownResult = await assessKnownGovernance(adapter, request, source);
    if (knownResult !== undefined) return knownResult;
  }

  try {
    const contract = await compile(adapter, request, source);
    const provenance = provenanceOf(contract);
    if (request.expectedGeneration !== undefined && provenance.treeSha !== request.expectedGeneration) {
      return unresolved(
        request,
        source,
        "GENERATION_STALE",
        "stale",
        generationDiagnostic("GENERATION_STALE", provenance.treeSha, request.expectedGeneration),
        provenance,
      );
    }
    return resolved(request, source, contract, provenance);
  } catch (error: unknown) {
    return unresolvedFromError(request, source, error);
  }
}

/** Alias emphasizing that this contract is a projection rather than a workflow engine. */
export const projectGoldenPathGovernance = discoverGoldenPathGovernance;
/** Compatibility alias for callers that phrase discovery as resolution. */
export const resolveGoldenPathGovernance = discoverGoldenPathGovernance;

async function compile(
  adapter: GitHubAdapter,
  request: GoldenPathGovernanceDiscoveryRequest,
  source: GoldenPathGovernanceSource,
): Promise<GoldenPathGovernanceContract> {
  if (source === "native-template") {
    return compileRepositoryGovernedContract(adapter, request.domain as GovernedArtifactDomain, request.selector, {
      templateResolver: request.templateResolver,
    });
  }
  const kind = artifactKind(request.domain);
  return compileRepositoryEffectiveArtifactContract(adapter, kind, selectorString(request.selector), {
    capabilities: request.capabilities,
  });
}

async function assessKnownGovernance(
  adapter: GitHubAdapter,
  request: GoldenPathGovernanceDiscoveryRequest,
  source: GoldenPathGovernanceSource,
): Promise<GoldenPathGovernanceDiscoveryResult | undefined> {
  const known = request.known;
  if (known === undefined || known.source !== source) return undefined;
  let provenance: GoldenPathGovernanceProvenance;
  try {
    provenance = knownContractProvenance(request, source, known.contract);
  } catch (error: unknown) {
    return unresolvedFromError(request, source, error);
  }
  if (request.expectedGeneration !== undefined && provenance.treeSha !== request.expectedGeneration) {
    return unresolved(
      request,
      source,
      "GENERATION_STALE",
      "stale",
      generationDiagnostic("GENERATION_STALE", provenance.treeSha, request.expectedGeneration),
      provenance,
    );
  }
  try {
    if (source === "native-template") {
      await verifyGovernedMutationFreshness(adapter, provenance as ContractProvenance);
    } else {
      const tree = await adapter.getRepositoryTree(await adapter.getRepositoryDefaultBranch());
      if (tree.sha !== provenance.treeSha) {
        return unresolved(
          request,
          source,
          "GENERATION_STALE",
          "stale",
          generationDiagnostic("GENERATION_STALE", provenance.treeSha, tree.sha),
          provenance,
        );
      }
    }
    return resolved(request, source, known.contract, provenance);
  } catch (error: unknown) {
    return unresolvedFromError(request, source, error, provenance);
  }
}

function knownContractProvenance(
  request: GoldenPathGovernanceDiscoveryRequest,
  source: GoldenPathGovernanceSource,
  contract: GoldenPathGovernanceContract,
): GoldenPathGovernanceProvenance {
  const provenance = provenanceOf(contract);
  if (source === "native-template") {
    if (!isCanonicalContract(contract) || !isContractProvenance(provenance)) {
      throw new GovernanceError(
        "GOVERNANCE_SOURCE_INVALID",
        "Known native governance must retain native-template provenance.",
      );
    }
    const expectedKind = request.domain === "pr" ? "pull_request" : "issue";
    if (contract.artifactKind !== expectedKind) {
      throw new GovernanceError(
        "GOVERNANCE_SOURCE_INVALID",
        `Known native governance kind "${contract.artifactKind}" is incompatible with domain "${request.domain}".`,
      );
    }
  } else {
    if (!isEffectiveContract(contract) || isContractProvenance(provenance)) {
      throw new GovernanceError(
        "GOVERNANCE_SOURCE_INVALID",
        "Known Artifact Contract governance must retain Artifact Contract provenance.",
      );
    }
    const expectedKind = artifactKind(request.domain);
    if (contract.kind !== expectedKind) {
      throw new GovernanceError(
        "GOVERNANCE_SOURCE_INVALID",
        `Known Artifact Contract kind "${contract.kind}" is incompatible with domain "${request.domain}".`,
      );
    }
  }
  return provenance;
}

function resolved(
  request: GoldenPathGovernanceDiscoveryRequest,
  source: GoldenPathGovernanceSource,
  contract: GoldenPathGovernanceContract,
  provenance: GoldenPathGovernanceProvenance,
): GoldenPathGovernanceResolved {
  const nextAction: GoldenPathGovernanceNextAction = {
    action: "direct-governed-create",
    kind: "direct-governed-create",
  };
  return {
    version: GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION,
    status: "resolved",
    domain: request.domain,
    source,
    contract,
    provenance,
    generation: provenance,
    nextAction,
  };
}

function unresolved(
  request: GoldenPathGovernanceDiscoveryRequest,
  source: GoldenPathGovernanceSource,
  reason: GoldenPathGovernanceReasonCode,
  status: Exclude<GoldenPathGovernanceStatus, "resolved">,
  diagnostic: GoldenPathGovernanceDiagnostic,
  generation?: GoldenPathGovernanceProvenance,
): GoldenPathGovernanceUnresolved {
  const action = actionFor(status, reason, diagnostic.candidates);
  return {
    version: GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION,
    status,
    domain: request.domain,
    source,
    reason,
    nextAction: action,
    diagnostic,
    ...(generation === undefined ? {} : { generation }),
  };
}

function actionFor(
  status: Exclude<GoldenPathGovernanceStatus, "resolved">,
  reason: GoldenPathGovernanceReasonCode,
  candidates: readonly string[],
): GoldenPathGovernanceNextAction {
  const action =
    status === "ambiguous"
      ? "provide-template-selector"
      : status === "stale"
        ? "refresh-governance"
        : status === "incompatible"
          ? "repair-governance"
          : "inspect-governance";
  return {
    action,
    kind: action,
    reason,
    ...(candidates.length === 0 ? {} : { candidates }),
  };
}

function unresolvedFromError(
  request: GoldenPathGovernanceDiscoveryRequest,
  source: GoldenPathGovernanceSource,
  error: unknown,
  generation?: GoldenPathGovernanceProvenance,
): GoldenPathGovernanceUnresolved {
  const mapped = mapError(error);
  return unresolved(request, source, mapped.reason, mapped.status, mapped.diagnostic, generation);
}

function mapError(error: unknown): {
  readonly reason: GoldenPathGovernanceReasonCode;
  readonly status: Exclude<GoldenPathGovernanceStatus, "resolved">;
  readonly diagnostic: GoldenPathGovernanceDiagnostic;
} {
  if (error instanceof TemplateResolutionError) {
    const reason = templateReason(error.code);
    return {
      reason,
      status: templateStatus(error.code),
      diagnostic: diagnosticFromTemplateError(error),
    };
  }
  if (error instanceof TemplateDiscoveryError) {
    const reason = error.code === "TEMPLATE_NOT_FOUND" ? "NO_GOVERNANCE_CANDIDATES" : "GOVERNANCE_SOURCE_INVALID";
    const candidates = (error.details.candidates ?? []).map((candidate) => candidate.path);
    return {
      reason,
      status: error.code === "TEMPLATE_NOT_FOUND" ? "discovery-required" : "incompatible",
      diagnostic: boundedDiagnostic(error.code, error.message, candidates, error.details.path),
    };
  }
  if (error instanceof GovernanceError) {
    const reason =
      error.code === "GOVERNANCE_SOURCE_UNAVAILABLE"
        ? "GOVERNANCE_SOURCE_UNAVAILABLE"
        : error.code === "GOVERNANCE_GENERATION_STALE"
          ? "GENERATION_STALE"
          : "GOVERNANCE_SOURCE_INVALID";
    return {
      reason,
      status:
        error.code === "GOVERNANCE_SOURCE_UNAVAILABLE"
          ? "unavailable"
          : error.code === "GOVERNANCE_GENERATION_STALE"
            ? "stale"
            : "incompatible",
      diagnostic: boundedDiagnostic(error.code, error.message, [], error.details.path),
    };
  }
  if (isArtifactResolutionError(error)) {
    const reason = error.code;
    const status =
      error.code === "ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS"
        ? "ambiguous"
        : error.code === "ARTIFACT_CONTRACT_NOT_FOUND"
          ? "discovery-required"
          : "incompatible";
    const candidates = candidateValues(error.details?.candidates);
    return { reason, status, diagnostic: boundedDiagnostic(error.code, error.message, candidates, error.path) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    reason: "GOVERNANCE_SOURCE_UNAVAILABLE",
    status: "unavailable",
    diagnostic: boundedDiagnostic("GOVERNANCE_SOURCE_UNAVAILABLE", message, []),
  };
}

function templateReason(code: TemplateResolutionError["code"]): GoldenPathGovernanceReasonCode {
  switch (code) {
    case "TEMPLATE_RESOLUTION_NO_CANDIDATES":
      return "NO_GOVERNANCE_CANDIDATES";
    case "TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS":
    case "TEMPLATE_RESOLUTION_AMBIGUOUS":
    case "TEMPLATE_RESOLUTION_INTERACTION_FAILED":
      return "SELECTOR_AMBIGUOUS";
    case "TEMPLATE_RESOLUTION_SELECTOR_NOT_FOUND":
      return "SELECTOR_NOT_FOUND";
    case "TEMPLATE_RESOLUTION_DEFAULT_INVALID":
      return "DEFAULT_INVALID";
    case "TEMPLATE_RESOLUTION_DEFAULT_UNAVAILABLE":
      return "DEFAULT_UNAVAILABLE";
    case "TEMPLATE_RESOLUTION_DEFAULT_AMBIGUOUS":
      return "DEFAULT_AMBIGUOUS";
    case "TEMPLATE_CONFIG_INVALID":
    case "TEMPLATE_CONFIG_UNAVAILABLE":
      return "GOVERNANCE_SOURCE_INVALID";
  }
}

function templateStatus(code: TemplateResolutionError["code"]): Exclude<GoldenPathGovernanceStatus, "resolved"> {
  switch (code) {
    case "TEMPLATE_RESOLUTION_NO_CANDIDATES":
      return "discovery-required";
    case "TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS":
    case "TEMPLATE_RESOLUTION_DEFAULT_AMBIGUOUS":
    case "TEMPLATE_RESOLUTION_AMBIGUOUS":
    case "TEMPLATE_RESOLUTION_INTERACTION_FAILED":
      return "ambiguous";
    case "TEMPLATE_CONFIG_UNAVAILABLE":
      return "unavailable";
    default:
      return "incompatible";
  }
}

function diagnosticFromTemplateError(error: TemplateResolutionError): GoldenPathGovernanceDiagnostic {
  return boundedDiagnostic(
    error.code,
    error.message,
    error.details.candidates,
    undefined,
    error.details.candidateCount,
  );
}

function boundedDiagnostic(
  code: string,
  message: string,
  candidates: readonly string[],
  path?: string,
  candidateCount = candidates.length,
): GoldenPathGovernanceDiagnostic {
  const normalized = candidates.filter((candidate) => candidate.length > 0);
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    candidates: normalized.slice(0, MAX_DIAGNOSTIC_CANDIDATES),
    candidateCount,
    candidatesTruncated: candidateCount > MAX_DIAGNOSTIC_CANDIDATES,
  };
}

function generationDiagnostic(code: string, observed: string, expected: string): GoldenPathGovernanceDiagnostic {
  return boundedDiagnostic(
    code,
    `Governance generation "${observed}" does not match expected generation "${expected}".`,
    [],
  );
}

function candidateValues(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is string => typeof candidate === "string");
}

function isArtifactResolutionError(error: unknown): error is ArtifactContractResolutionError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ARTIFACT_CONTRACT_") &&
    "message" in error &&
    typeof error.message === "string"
  );
}

function provenanceOf(contract: GoldenPathGovernanceContract): GoldenPathGovernanceProvenance {
  if ("generation" in contract) return contract.provenance;
  if (contract.provenance === undefined) {
    throw new GovernanceError("GOVERNANCE_SOURCE_INVALID", "Compiled governance did not retain provenance.");
  }
  return contract.provenance;
}

function isCanonicalContract(contract: GoldenPathGovernanceContract): contract is CanonicalContract {
  return "artifactKind" in contract && "templateIdentity" in contract;
}

function isEffectiveContract(contract: GoldenPathGovernanceContract): contract is EffectiveArtifactContract {
  return "generation" in contract && "kind" in contract;
}

function isContractProvenance(value: GoldenPathGovernanceProvenance): value is ContractProvenance {
  return "template" in value;
}

function defaultSource(domain: GoldenPathGovernanceDomain): GoldenPathGovernanceSource {
  return domain === "branch" || domain === "pull_request" ? "artifact-contract" : "native-template";
}

function isSourceCompatible(source: GoldenPathGovernanceSource, domain: GoldenPathGovernanceDomain): boolean {
  if (source === "native-template") return domain === "issue" || domain === "pr";
  return domain === "issue" || domain === "pr" || domain === "branch" || domain === "pull_request";
}

function artifactKind(domain: GoldenPathGovernanceDomain): RepositoryEffectiveArtifactKind {
  return domain === "branch" ? "branch" : domain === "pull_request" || domain === "pr" ? "pull_request" : "issue";
}

function selectorString(selector: string | TemplateSelector | undefined): string | TemplateSelector | undefined {
  return selector;
}
