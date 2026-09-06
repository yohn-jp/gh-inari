/**
 * Versioned Artifact Contract IR (Core authority model).
 *
 * Authority: `docs/SEMANTIC_ARTIFACT_CONTRACTS.md` (#279 / PR #280) for the
 * authority/cardinality/derivation model, refined by the closed Canon v2
 * vocabulary frozen in #287.
 *
 * Canon v2 is a closed-world model. There are exactly three governed
 * artifact kinds (`issue`, `branch`, `pull_request`), and each kind accepts
 * exactly the Core-owned semantic properties fixed by #287 below. A
 * repository contract may only select, per recognized property:
 *
 * - `presence`   — `required | optional | unused`
 * - `authority`  — `supplied | derived | fixed | platform`
 * - Core-owned, shape-appropriate constraints
 * - a bounded Core-owned derivation, only when `authority = derived`
 *
 * Cardinality is intrinsic Core vocabulary (e.g. `parent` is always
 * zero-or-one, `dependsOn` is always many); repositories choose `presence`,
 * not multiplicity. This module never accepts an arbitrary top-level
 * property name, an arbitrary field primitive, or a freely-chosen
 * type/cardinality: unknown properties, unknown field primitives, unknown
 * authority kinds, and invalid derivations all fail closed.
 *
 * The only repository-specific extension point is `fields`: an ordered
 * list of body fields limited to four Core-owned primitives (`text`,
 * `choice`, `checklist`, `attachment`). Raw GitHub Markdown and Issue Form
 * widget types (`input`/`textarea`/`dropdown`/`checkboxes`/`upload`/
 * `markdown`) are projections of this vocabulary, not Canon semantics, and
 * are therefore out of scope for this module.
 *
 * This module is representation-independent: no GitHub Markdown, Actions,
 * MCP, or CLI concerns. It parses and validates repository-owned Artifact
 * Contract data into one normalized Core IR. It deliberately does not
 * compile an Effective Contract/input schema, materialize a Semantic
 * Artifact, or project GitHub state; those remain separate follow-up
 * leaves per the architecture document's decomposition (section 18).
 *
 * `src/semantic-template.ts` (v1) is untouched and remains the executable
 * compatibility authority. v1's `SemanticInputType` maps onto the `fields`
 * primitives here: `string` -> `text`; a plain or multi-select `array` ->
 * `choice`; `checklist` -> `checklist`. v1 has no attachment field today.
 */
import { type IssueReference } from "./issue-reference.js";
export declare const ARTIFACT_CONTRACT_VERSION: "1";
export type ArtifactContractVersion = typeof ARTIFACT_CONTRACT_VERSION;
export declare const ARTIFACT_CONTRACT_KINDS: readonly ["issue", "branch", "pull_request"];
export type ArtifactContractKind = (typeof ARTIFACT_CONTRACT_KINDS)[number];
export type Presence = "required" | "optional" | "unused";
export type Multiplicity = "single" | "many";
export interface Cardinality {
    readonly min: number;
    readonly max: number | "many";
}
/** Core-owned closed vocabulary for what shape of value a property/field holds. */
export declare const VALUE_SHAPES: readonly ["text", "classification", "label", "actor", "milestone_reference", "issue_reference", "boolean"];
export type ValueShape = (typeof VALUE_SHAPES)[number];
export declare const FIELD_PRIMITIVES: readonly ["text", "choice", "checklist", "attachment"];
export type FieldPrimitive = (typeof FIELD_PRIMITIVES)[number];
export type DerivationSpec = {
    readonly op: "copy";
    readonly from: string;
} | {
    readonly op: "format";
    readonly template: string;
} | {
    readonly op: "slug";
    readonly from: string;
};
/** A reference parsed once by the Artifact Contract compiler. */
export interface DerivationReference {
    readonly name: string;
    readonly member?: string;
}
export type DerivationFormatPart = {
    readonly kind: "literal";
    readonly value: string;
} | {
    readonly kind: "reference";
    readonly reference: DerivationReference;
};
/**
 * Core-owned derivation metadata retained on the normalized IR.  The
 * authoring `DerivationSpec` remains the serialized vocabulary; these parsed
 * references/parts are compiler output for downstream consumers.
 */
export interface ArtifactContractDerivation {
    readonly target: string;
    readonly operation: DerivationSpec;
    readonly dependencies: readonly DerivationReference[];
    readonly formatParts?: readonly DerivationFormatPart[];
}
export type FixedScalarValue = string | boolean | IssueReference;
export type FixedValue = FixedScalarValue | readonly FixedScalarValue[];
export type ValueAuthority = {
    readonly kind: "supplied";
} | {
    readonly kind: "platform";
} | {
    readonly kind: "derived";
    readonly derive: DerivationSpec;
} | {
    readonly kind: "fixed";
    readonly value: FixedValue;
};
export interface PropertyConstraints {
    /** Closed value set for `classification` (required) and `label` (optional). */
    readonly values?: readonly string[];
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    /** List-length bounds for many-valued properties. */
    readonly minItems?: number;
    readonly maxItems?: number;
}
export type PropertyValueDeclaration = {
    readonly presence: "unused";
    readonly shape: ValueShape;
    readonly cardinality: Cardinality;
} | {
    readonly presence: "required" | "optional";
    readonly shape: ValueShape;
    readonly cardinality: Cardinality;
    readonly authority: ValueAuthority;
    readonly constraints?: PropertyConstraints;
};
export interface ChecklistItemDeclaration {
    readonly id: string;
    readonly label: string;
    readonly required: boolean;
}
export interface FieldContentConstraints {
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    /** Closed option set for `choice`. */
    readonly values?: readonly string[];
    /** Selection/attachment count bounds for `choice` and `attachment`. */
    readonly minItems?: number;
    readonly maxItems?: number;
    /** Ordered items for `checklist`. */
    readonly items?: readonly ChecklistItemDeclaration[];
}
export type FieldDeclaration = {
    readonly id: string;
    readonly primitive: FieldPrimitive;
    readonly presence: "unused";
    readonly cardinality: Cardinality;
} | {
    readonly id: string;
    readonly primitive: FieldPrimitive;
    readonly presence: "required" | "optional";
    readonly cardinality: Cardinality;
    readonly authority: ValueAuthority;
    readonly constraints?: FieldContentConstraints;
};
export interface ArtifactContract {
    readonly version: ArtifactContractVersion;
    readonly kind: ArtifactContractKind;
    readonly id: string;
    readonly properties: Readonly<Record<string, PropertyValueDeclaration>>;
    /** Only present for `issue` and `pull_request`; `branch` has no body fields. */
    readonly fields?: readonly FieldDeclaration[];
    /** Parsed once from the bounded derivation declarations; never authoring input. */
    readonly derivations: readonly ArtifactContractDerivation[];
}
export type ArtifactContractViolationCode = "ARTIFACT_CONTRACT_INVALID_JSON" | "ARTIFACT_CONTRACT_NOT_OBJECT" | "ARTIFACT_CONTRACT_MISSING_PROPERTY" | "ARTIFACT_CONTRACT_UNKNOWN_PROPERTY" | "ARTIFACT_CONTRACT_INVALID_VALUE" | "ARTIFACT_CONTRACT_UNSUPPORTED_VERSION" | "ARTIFACT_CONTRACT_UNSUPPORTED_KIND" | "ARTIFACT_CONTRACT_INVALID_IDENTIFIER" | "ARTIFACT_CONTRACT_UNKNOWN_SEMANTIC_PROPERTY" | "ARTIFACT_CONTRACT_UNSUPPORTED_FIELD_PRIMITIVE" | "ARTIFACT_CONTRACT_UNKNOWN_AUTHORITY" | "ARTIFACT_CONTRACT_INVALID_CONSTRAINT" | "ARTIFACT_CONTRACT_MISSING_FIXED_VALUE" | "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE" | "ARTIFACT_CONTRACT_INVALID_DERIVATION" | "ARTIFACT_CONTRACT_UNDECLARED_DEPENDENCY" | "ARTIFACT_CONTRACT_DERIVATION_CYCLE";
export interface ArtifactContractViolation {
    readonly code: ArtifactContractViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface ArtifactContractValidationResult {
    readonly valid: boolean;
    readonly violations: readonly ArtifactContractViolation[];
}
export declare class ArtifactContractValidationError extends Error {
    readonly violations: readonly ArtifactContractViolation[];
    constructor(violations: readonly ArtifactContractViolation[]);
}
export declare function validateArtifactContract(input: unknown): ArtifactContractValidationResult;
export declare function isArtifactContract(input: unknown): boolean;
/** Validates and builds repository-owned Artifact Contract data into normalized Core IR. */
export declare function parseArtifactContract(input: unknown): ArtifactContract;
/**
 * Projects an already-normalized Core IR object back to the minimal
 * canonical authoring JSON (`presence`/`authority`/`constraints` only —
 * Core-computed `shape`/`cardinality` are not re-serialized). Callers with
 * raw, unvalidated repository data should call `parseArtifactContract`
 * first; this function trusts its typed input rather than re-validating it.
 */
export declare function serializeArtifactContract(contract: ArtifactContract): string;
export declare function deserializeArtifactContract(serialized: string): ArtifactContract;
