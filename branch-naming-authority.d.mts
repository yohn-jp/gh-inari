export interface BranchNameParts {
  readonly type: string;
  readonly issueNumber: number;
  readonly slug: string;
}

export function validateBranchName(branch: string): readonly string[];
export function deriveBranchName(parts: BranchNameParts): string;
