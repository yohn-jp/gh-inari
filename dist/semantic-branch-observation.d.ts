/**
 * Pure Core observation and drift comparison for semantic branch projections.
 *
 * A Git ref is bounded evidence only.  This module does not derive semantic
 * branch identity, consult Repository Canon, perform GitHub I/O, or mutate
 * GitHub state.  `source` and `generation` are explicit evidence supplied by
 * the observation boundary; neither is guessed from arbitrary provider data.
 */
import type { ArtifactContractProvenance } from "./contract/ir.js";
import type { DesiredBranchProjection } from "./semantic-branch-projection.js";
export declare const SEMANTIC_BRANCH_OBSERVED_PROJECTION_VERSION: "1";
export type SemanticBranchObservedProjectionVersion = typeof SEMANTIC_BRANCH_OBSERVED_PROJECTION_VERSION;
/** Alias named after the operation for callers that use observation vocabulary. */
export declare const SEMANTIC_BRANCH_OBSERVATION_VERSION: "1";
export declare const SEMANTIC_BRANCH_OBSERVATION_LIMITS: Readonly<{
    readonly refLength: 512;
    readonly nameLength: 255;
    readonly sourceLength: 512;
    readonly shaLength: 64;
    readonly diagnostics: 100;
    readonly diagnosticMessageLength: 500;
}>;
/** The bounded Git ref response accepted by the Core observation boundary. */
export interface SemanticBranchRefEvidence {
    readonly ref: string;
    readonly object: {
        readonly type: "commit";
        readonly sha: string;
    };
}
/**
 * Explicit evidence accompanying a bounded Git ref.  `source` and
 * `generation` are not reconstructed from the ref name or commit SHA.
 */
export interface SemanticBranchObservationInput {
    readonly ref: SemanticBranchRefEvidence | string;
    readonly object?: SemanticBranchRefEvidence["object"];
    readonly source: string;
    readonly generation: ArtifactContractProvenance;
}
/** Representation-independent observed branch state. */
export interface ObservedBranchProjection {
    readonly version: SemanticBranchObservedProjectionVersion;
    readonly kind: "branch";
    readonly name: string;
    readonly source: string;
    readonly generation: ArtifactContractProvenance;
}
export type SemanticBranchObservationViolationCode = "OBSERVATION_INPUT_INVALID" | "OBSERVATION_INPUT_UNKNOWN_PROPERTY" | "OBSERVED_BRANCH_REF_INVALID" | "OBSERVED_BRANCH_VALUE_INVALID" | "OBSERVED_BRANCH_GENERATION_INVALID";
export interface SemanticBranchObservationViolation {
    readonly code: SemanticBranchObservationViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface SemanticBranchObservationResult {
    readonly valid: boolean;
    readonly projection?: ObservedBranchProjection;
    readonly violations: readonly SemanticBranchObservationViolation[];
}
export declare class SemanticBranchObservationError extends Error {
    readonly violations: readonly SemanticBranchObservationViolation[];
    constructor(violations: readonly SemanticBranchObservationViolation[]);
}
export type SemanticBranchDriftCode = "DESIRED_PROJECTION_INVALID" | "OBSERVED_PROJECTION_INVALID" | "NAME_DRIFT" | "SOURCE_DRIFT" | "GENERATION_DRIFT";
export interface SemanticBranchDriftDiagnostic {
    readonly code: SemanticBranchDriftCode;
    readonly path: string;
    readonly message: string;
    readonly expected?: unknown;
    readonly actual?: unknown;
}
export interface SemanticBranchComparisonResult {
    readonly valid: boolean;
    readonly diagnostics: readonly SemanticBranchDriftDiagnostic[];
    /** Alias for consumers that call the comparison output a drift report. */
    readonly drift: readonly SemanticBranchDriftDiagnostic[];
}
/** Normalize bounded Git ref evidence into an immutable observed projection. */
export declare function tryObserveSemanticBranch(input: unknown): SemanticBranchObservationResult;
/** Throwing observation entry point for Core callers. */
export declare function observeSemanticBranch(input: unknown): ObservedBranchProjection;
export declare const tryObserveSemanticBranchProjection: typeof tryObserveSemanticBranch;
export declare const observeSemanticBranchProjection: typeof observeSemanticBranch;
/** Compare Core desired branch state with bounded observed evidence. */
export declare function compareSemanticBranchProjection(desired: DesiredBranchProjection | {
    readonly desired: unknown;
    readonly observed: unknown;
} | unknown, observed?: ObservedBranchProjection | unknown): SemanticBranchComparisonResult;
export declare const compareSemanticBranchObservation: typeof compareSemanticBranchProjection;
export declare const compareSemanticBranchProjectionDrift: typeof compareSemanticBranchProjection;
