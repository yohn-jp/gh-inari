/**
 * Core compiler for the caller-facing portion of a Canon v2 Artifact
 * Contract.
 *
 * This module consumes the normalized Artifact Contract IR.  It does not
 * parse repository input, derive semantic values, materialize an artifact, or
 * know anything about a transport/projection target.  Derivation references
 * and format parts are already parsed by artifact-contract.ts and are copied
 * into the effective metadata for the later materialization phase.
 */
import { type ArtifactContract, type ArtifactContractDerivation, type ArtifactContractKind, type DerivationReference, type FieldDeclaration, type PropertyValueDeclaration } from "./artifact-contract.js";
import { type ArtifactContractProvenance } from "./ir.js";
import type { JsonSchemaDocument } from "./schema.js";
export declare const EFFECTIVE_ARTIFACT_CONTRACT_VERSION: "1";
export type EffectiveArtifactContractVersion = typeof EFFECTIVE_ARTIFACT_CONTRACT_VERSION;
export interface EffectiveArtifactContractOptions {
    /** Representation-independent Canon provenance; `treeSha` and `source` fingerprints bind generation. */
    readonly provenance: ArtifactContractProvenance;
    /** Opaque target capability identifiers are carried, never interpreted, by this compiler. */
    readonly capabilities?: readonly string[];
}
export declare class EffectiveArtifactContractCompilationError extends Error {
    constructor(message: string);
}
export interface EffectiveArtifactContract {
    readonly version: EffectiveArtifactContractVersion;
    readonly artifactContractVersion: ArtifactContract["version"];
    readonly kind: ArtifactContractKind;
    readonly id: string;
    /** Immutable normalized source IR retained for downstream Core phases. */
    readonly contract: ArtifactContract;
    /** Normalized authority declarations for every supported property/field. */
    readonly properties: Readonly<Record<string, PropertyValueDeclaration>>;
    readonly fields?: readonly FieldDeclaration[];
    /** Exact closed-world caller input schema. */
    readonly inputSchema: JsonSchemaDocument;
    /** Parsed derivation plans and deterministic dependency/evaluation metadata. */
    readonly derivations: readonly ArtifactContractDerivation[];
    readonly dependencyGraph: Readonly<Record<string, readonly DerivationReference[]>>;
    readonly evaluationOrder: readonly string[];
    /** The same immutable Core provenance is exposed as the generation binding. */
    readonly provenance: ArtifactContractProvenance;
    readonly generation: ArtifactContractProvenance;
    readonly capabilities: readonly string[];
}
/** Compile a normalized Artifact Contract into the immutable Core discovery contract. */
export declare function compileEffectiveArtifactContract(contractInput: ArtifactContract, options: EffectiveArtifactContractOptions): EffectiveArtifactContract;
