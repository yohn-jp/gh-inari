export interface BranchNameParts {
  readonly type: string;
  readonly issueNumber: number;
  readonly slug: string;
}

export interface BranchGovernance {
  readonly pattern: string;
  readonly release?: { readonly pattern: string };
  readonly exemptions?: readonly string[];
}

export type BranchClassification = "unclassified" | "ordinary" | "release" | "exempt" | "invalid-release" | "invalid";

export function validateBranchName(branch: string): readonly string[];
export function validateBranchName(branch: string, governance: BranchGovernance): readonly string[];
export function deriveBranchName(parts: BranchNameParts): string;
export function classifyBranchName(
  branch: unknown,
  governance?: BranchGovernance,
): {
  readonly valid: boolean;
  readonly classification: BranchClassification;
  readonly version?: string;
  readonly violations: readonly { readonly code: string; readonly path: string; readonly message: string }[];
};
export function parseCanonicalChangeBranchName(
  branch: string,
): { readonly type: string; readonly issueNumber: number; readonly slug: string } | undefined;
