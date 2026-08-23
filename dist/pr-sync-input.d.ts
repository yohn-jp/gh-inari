import { type ArtifactInputDocument } from "./artifact.js";
import { type JsonSchemaDocument } from "./contract/schema.js";
/** The single declaration for the machine-readable `pr sync --from` envelope. */
export declare const PR_SYNC_INPUT_CONTRACT: {
    readonly id: "urn:inari:input:pull-request-sync:1";
    readonly version: 1;
    readonly kind: "pull_request_sync";
    readonly properties: {
        readonly fields: {
            readonly valueKind: "semantic-fields";
            readonly type: "object";
            readonly required: true;
            readonly description: "Semantic fields declared by the selected pull-request template.";
        };
        readonly title: {
            readonly valueKind: "non-empty-string";
            readonly type: "string";
            readonly required: true;
            readonly description: "The desired pull-request title.";
        };
        readonly head: {
            readonly valueKind: "non-empty-string";
            readonly type: "string";
            readonly required: true;
            readonly description: "The desired pull-request head branch.";
        };
        readonly base: {
            readonly valueKind: "non-empty-string";
            readonly type: "string";
            readonly required: true;
            readonly description: "The desired pull-request base branch.";
        };
        readonly draft: {
            readonly valueKind: "boolean";
            readonly type: "boolean";
            readonly required: false;
            readonly description: "Whether the pull request should remain a draft.";
        };
        readonly maintainerCanModify: {
            readonly valueKind: "boolean";
            readonly type: "boolean";
            readonly required: false;
            readonly description: "Whether maintainers may modify the pull request.";
        };
    };
};
type PrSyncPropertyName = keyof typeof PR_SYNC_INPUT_CONTRACT.properties;
type PrSyncPropertyDefinition = (typeof PR_SYNC_INPUT_CONTRACT.properties)[PrSyncPropertyName];
type RequiredPrSyncPropertyName = {
    [Name in PrSyncPropertyName]: (typeof PR_SYNC_INPUT_CONTRACT.properties)[Name]["required"] extends true ? Name : never;
}[PrSyncPropertyName];
type OptionalPrSyncPropertyName = Exclude<PrSyncPropertyName, RequiredPrSyncPropertyName>;
type PrSyncValue<Definition extends PrSyncPropertyDefinition> = Definition["valueKind"] extends "semantic-fields" ? Readonly<Record<string, unknown>> : Definition["valueKind"] extends "non-empty-string" ? string : boolean;
/** Type derived from the canonical property declaration above. */
export type PullRequestSyncInput = {
    readonly [Name in RequiredPrSyncPropertyName]: PrSyncValue<(typeof PR_SYNC_INPUT_CONTRACT.properties)[Name]>;
} & {
    readonly [Name in OptionalPrSyncPropertyName]?: PrSyncValue<(typeof PR_SYNC_INPUT_CONTRACT.properties)[Name]>;
};
export interface PullRequestSyncInputProjection {
    readonly contract: typeof PR_SYNC_INPUT_CONTRACT;
    readonly schema: JsonSchemaDocument;
    readonly minimalExample: PullRequestSyncInput;
}
/** Return the bounded top-level shape used by help and machine consumers. */
export declare function projectPullRequestSyncInput(contractInput: unknown): PullRequestSyncInputProjection;
/** A valid top-level example, with semantic values generated from the selected contract. */
export declare function minimalPullRequestSyncInput(contractInput: unknown): PullRequestSyncInput;
/** Parse the canonical JSON envelope before semantic field validation. */
export declare function parsePullRequestSyncInput(input: unknown): ArtifactInputDocument;
/** Apply the same required top-level contract to direct-field input and CLI overrides. */
export declare function assertPullRequestSyncInputComplete(input: ArtifactInputDocument): ArtifactInputDocument;
export declare function renderPullRequestSyncInputHelp(): string;
export {};
