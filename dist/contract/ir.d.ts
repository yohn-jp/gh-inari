/**
 * Versioned, compiler-generated contract representation.
 *
 * This module deliberately describes the result of compiling a repository's
 * native template. It is not a second template language for repository
 * authors to maintain.
 */
export declare const CANONICAL_IR_VERSION: "1.0.0";
export declare const CONTRACT_SCHEMA_VERSION: "1.0.0";
export declare const JSON_SCHEMA_DIALECT: "https://json-schema.org/draft/2020-12/schema";
/** Separator used by native multi-select Issue Form artifacts. */
export declare const MULTI_SELECT_OPTION_SEPARATOR: ",";
/**
 * GitHub's syntactic closing-reference language for pull request bodies.
 * Contextual effects, such as closing only when targeting the default branch,
 * remain GitHub behavior and are deliberately outside this contract rule.
 */
export declare const LINKED_ISSUE_PATTERN: "(?:^|[^A-Za-z0-9_])(?:[Cc][Ll][Oo][Ss][Ee](?:[Ss]|[Dd])?|[Ff][Ii][Xx](?:[Ee][Ss]|[Ee][Dd])?|[Rr][Ee][Ss][Oo][Ll][Vv][Ee](?:[Ss]|[Dd])?)(?:[ \\t]+|[ \\t]*:[ \\t]*)(?:#[1-9][0-9]*|[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*#[1-9][0-9]*)(?![A-Za-z0-9_])";
export type CanonicalIrVersion = typeof CANONICAL_IR_VERSION;
export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;
export type ArtifactKind = "issue" | "pull_request";
export type TemplateSource = "issue_form" | "pull_request_template";
export type RequiredState = "required" | "optional" | "unknown";
export type SectionKind = "input" | "documentation";
export type FieldType = "string" | "enum" | "array" | "checklist";
export type ArraySelection = "list" | "multi_select";
export interface TemplateIdentity {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly source: TemplateSource;
}
/** Repository identity and source fingerprints bound to a governed contract. */
export interface ContractProvenanceRepository {
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly nameWithOwner: string;
    /** Decimal REST repository database ID when supplied by the adapter. */
    readonly repositoryId?: string;
}
export interface ContractProvenanceSource {
    readonly path: string;
    readonly ref: string;
    /** GitHub blob SHA for the source at the trusted ref. */
    readonly sha: string;
    /** SHA-256 digest of the decoded source content. */
    readonly digest: string;
}
/**
 * Repository-declared constraint on the actual pull-request head branch
 * name, sourced from the same PR policy overlay that supplies section
 * constraints. Presence is optional: a repository that declares no branch
 * rule has no branch precondition to preflight.
 */
export interface PullRequestBranchGovernance {
    readonly pattern: string;
}
export interface ContractProvenance {
    readonly authority: "repository-default-branch";
    readonly repository: ContractProvenanceRepository;
    readonly ref: string;
    /**
     * SHA of the repository's root Git tree at `ref` when governance was
     * compiled. An immutable generation identity: unlike `ref` (a mutable
     * branch name), this value changes whenever any file in the repository
     * changes, so it can be compared against the tree read immediately before
     * mutation to detect a stale governance generation.
     */
    readonly treeSha: string;
    readonly template: ContractProvenanceSource;
    readonly policy?: ContractProvenanceSource;
    /** Pull-request-only: present only when the repository's PR policy declares a branch rule. */
    readonly branchGovernance?: PullRequestBranchGovernance;
}
export interface NativeContractMetadata {
    readonly source: TemplateSource;
    readonly path: string;
    readonly title?: string;
    readonly description?: string;
    readonly labels?: readonly string[];
}
export interface SectionRenderMetadata {
    /** Zero-based position in the source template. */
    readonly order: number;
    readonly headingLevel?: number;
}
export interface FieldRenderMetadata {
    /** Zero-based position within its section. */
    readonly order: number;
}
export interface NativeOptionMetadata {
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
    readonly required?: boolean;
}
export type NativeSectionElement = "input" | "textarea" | "dropdown" | "checkboxes" | "markdown" | "heading";
export interface NativeSectionMetadata {
    readonly elementType: NativeSectionElement;
    readonly sourceId?: string;
    readonly headingLevel?: number;
    readonly markdown?: string;
}
export type NativeFieldElement = "input" | "textarea" | "dropdown" | "checkboxes" | "pr_section";
export interface NativeFieldMetadata {
    readonly elementType: NativeFieldElement;
    readonly sourceId?: string;
    readonly placeholder?: string;
    readonly defaultValue?: string | readonly string[];
    /** GitHub Issue Form textarea render language, which produces a code fence. */
    readonly render?: string;
    readonly multiple?: boolean;
    readonly options?: readonly NativeOptionMetadata[];
}
export interface FieldConstraints {
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly uniqueItems?: boolean;
}
export interface SupplementalFieldConstraint {
    readonly fieldId: string;
    readonly required?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly minItems?: number;
    readonly maxItems?: number;
    /** Require a string-like PR section to contain a GitHub closing reference. */
    readonly linkedIssue?: boolean;
    /** Minimum number of checked items for a PR checklist. */
    readonly checklistMinCompleted?: number;
    /** Require every item in a PR checklist to be checked. */
    readonly checklistRequireComplete?: boolean;
}
export interface SupplementalConstraints {
    /**
     * A deliberately small overlay for constraints absent from native
     * templates, primarily PR section policy. It is not a policy language.
     */
    readonly fields: readonly SupplementalFieldConstraint[];
}
export interface EnumOption {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
}
export interface ChecklistItem {
    readonly id: string;
    readonly label: string;
    readonly required: boolean;
    readonly description?: string;
}
interface CanonicalFieldBase {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly required: RequiredState;
    readonly render: FieldRenderMetadata;
    readonly nativeMetadata: NativeFieldMetadata;
    readonly constraints?: FieldConstraints;
}
export interface StringField extends CanonicalFieldBase {
    readonly type: "string";
    readonly defaultValue?: string;
}
export interface EnumField extends CanonicalFieldBase {
    readonly type: "enum";
    readonly options: readonly EnumOption[];
    readonly defaultValue?: string;
}
export interface ArrayField extends CanonicalFieldBase {
    readonly type: "array";
    readonly selection: ArraySelection;
    readonly items: {
        readonly type: "string";
        readonly options?: readonly EnumOption[];
    };
    readonly defaultValue?: readonly string[];
}
export interface ChecklistField extends CanonicalFieldBase {
    readonly type: "checklist";
    readonly items: readonly ChecklistItem[];
    readonly defaultValue?: readonly string[];
}
export type CanonicalField = StringField | EnumField | ArrayField | ChecklistField;
export interface CanonicalSection {
    readonly id: string;
    readonly title?: string;
    readonly description?: string;
    readonly kind: SectionKind;
    readonly content?: string;
    readonly render: SectionRenderMetadata;
    readonly nativeMetadata: NativeSectionMetadata;
    readonly fields: readonly CanonicalField[];
}
export interface CanonicalContract {
    readonly irVersion: CanonicalIrVersion;
    readonly schemaVersion: ContractSchemaVersion;
    readonly artifactKind: ArtifactKind;
    readonly templateIdentity: TemplateIdentity;
    readonly nativeMetadata: NativeContractMetadata;
    /** Sections and fields retain source order; their render.order values are checked against those arrays. */
    readonly sections: readonly CanonicalSection[];
    readonly supplementalConstraints: SupplementalConstraints;
    /** Present when the contract was compiled from a trusted remote repository source. */
    readonly provenance?: ContractProvenance;
}
export type CanonicalIrViolationCode = "IR_INVALID_JSON" | "IR_NOT_OBJECT" | "IR_MISSING_PROPERTY" | "IR_UNKNOWN_PROPERTY" | "IR_INVALID_VALUE" | "IR_UNSUPPORTED_VERSION" | "IR_UNSUPPORTED_ARTIFACT_KIND" | "IR_UNSUPPORTED_SOURCE_FORMAT" | "IR_UNSUPPORTED_FIELD_TYPE" | "IR_INVALID_IDENTIFIER" | "IR_DUPLICATE_ID" | "IR_INVALID_ORDER" | "IR_INVALID_SECTION" | "IR_INVALID_FIELD" | "IR_INVALID_NATIVE_METADATA" | "IR_INCONSISTENT_SOURCE" | "IR_INCONSISTENT_FIELD" | "IR_INVALID_OPTIONS" | "IR_INVALID_DEFAULT" | "IR_INVALID_CONSTRAINT" | "IR_INCONSISTENT_CONSTRAINT" | "IR_UNKNOWN_FIELD_REFERENCE" | "IR_CHECKLIST_REQUIRED_MISMATCH" | "IR_INVALID_PROVENANCE";
export interface CanonicalIrViolation {
    readonly code: CanonicalIrViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface CanonicalIrValidationResult {
    readonly valid: boolean;
    readonly violations: readonly CanonicalIrViolation[];
}
export declare class CanonicalIrValidationError extends Error {
    readonly violations: readonly CanonicalIrViolation[];
    constructor(violations: readonly CanonicalIrViolation[]);
}
export declare function validateCanonicalContract(input: unknown): CanonicalIrValidationResult;
export declare function isCanonicalContract(input: unknown): input is CanonicalContract;
export declare function assertCanonicalContract(input: unknown): asserts input is CanonicalContract;
export declare function serializeCanonicalContract(input: unknown): string;
export declare function deserializeCanonicalContract(serialized: string): CanonicalContract;
export {};
