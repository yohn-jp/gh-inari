/**
 * Core materialization for a compiled Effective Artifact Contract.
 *
 * This module is deliberately below every representation adapter.  It only
 * accepts the values allowed by the Effective Contract, applies repository
 * fixed values, and evaluates the already-parsed bounded derivation plans.
 * It does not parse Markdown, render a body/title, or access a transport.
 */
import { type EffectiveArtifactContractVersion } from "./effective-artifact-contract.js";
import { type ArtifactContract, type ArtifactContractKind } from "./artifact-contract.js";
import type { ArtifactContractProvenance } from "./ir.js";
export declare const SEMANTIC_ARTIFACT_VERSION: "1";
export type SemanticArtifactVersion = typeof SEMANTIC_ARTIFACT_VERSION;
/** Stable failures at the Effective Contract and caller-input boundaries. */
export type SemanticArtifactMaterializationViolationCode = "EFFECTIVE_CONTRACT_INVALID" | "INPUT_NOT_OBJECT" | "INPUT_UNKNOWN_FIELD" | "INPUT_AUTHORITY" | "INPUT_REQUIRED" | "INPUT_TYPE" | "INPUT_ENUM" | "INPUT_OPTION" | "INPUT_DUPLICATE" | "INPUT_MIN_LENGTH" | "INPUT_MAX_LENGTH" | "INPUT_PATTERN" | "INPUT_MIN_ITEMS" | "INPUT_MAX_ITEMS" | "INPUT_CHECKLIST_REQUIRED" | "DERIVATION_UNRESOLVED" | "DERIVATION_INVALID" | "DERIVATION_UNSUPPORTED" | "OUTPUT_INVALID";
export interface SemanticArtifactMaterializationViolation {
    readonly code: SemanticArtifactMaterializationViolationCode;
    readonly path: string;
    readonly message: string;
}
/** A fully materialized semantic instance, independent of GitHub or Markdown. */
export interface SemanticArtifact {
    readonly version: SemanticArtifactVersion;
    readonly effectiveContractVersion: EffectiveArtifactContractVersion;
    readonly artifactContractVersion: ArtifactContract["version"];
    readonly kind: ArtifactContractKind;
    readonly id: string;
    /** Materialized Core semantic properties, including Issue-valued relations. */
    readonly values: Readonly<Record<string, unknown>>;
    /** Materialized Core body-field values, when the contract declares fields. */
    readonly fields: Readonly<Record<string, unknown>>;
    readonly provenance: ArtifactContractProvenance;
    readonly generation: ArtifactContractProvenance;
    /** Non-enumerable view of the Issue-valued relation properties. */
    readonly relations?: Readonly<Record<string, unknown>>;
    /** Non-enumerable alias for callers that name semantic properties directly. */
    readonly properties?: Readonly<Record<string, unknown>>;
}
export interface SemanticArtifactMaterializationResult {
    readonly valid: boolean;
    readonly artifact?: SemanticArtifact;
    readonly violations: readonly SemanticArtifactMaterializationViolation[];
}
export declare class SemanticArtifactMaterializationError extends Error {
    readonly violations: readonly SemanticArtifactMaterializationViolation[];
    constructor(violations: readonly SemanticArtifactMaterializationViolation[]);
}
/** Materialize a complete Semantic Artifact or throw stable diagnostics. */
export declare function materializeSemanticArtifact(effectiveContract: unknown, input: unknown): SemanticArtifact;
/** Non-throwing companion for callers that need structured preflight diagnostics. */
export declare function tryMaterializeSemanticArtifact(effectiveContract: unknown, input: unknown): SemanticArtifactMaterializationResult;
/** Explicit result-named alias for Core callers that prefer result terminology. */
export declare const materializeSemanticArtifactResult: typeof tryMaterializeSemanticArtifact;
