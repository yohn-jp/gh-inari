/** Explicit marker carried by a governed Issue selected for live self-dogfood. */
export const SELF_DOGFOOD_ISSUE_MARKER = "inari:self-dogfood:v1" as const;

export interface SelfDogfoodIssueMarker {
  readonly version: 1;
  readonly kind: "self-dogfood";
}

const SELF_DOGFOOD_ISSUE_MARKER_VALUE: SelfDogfoodIssueMarker = Object.freeze({
  version: 1,
  kind: "self-dogfood",
});

/** Project only the exact explicit marker; an Issue number/title never implies disposability. */
export function projectSelfDogfoodIssueMarker(body: string | null | undefined): SelfDogfoodIssueMarker | undefined {
  if (typeof body !== "string") return undefined;
  return body.split(/\r?\n/u).some((line) => line.trim() === SELF_DOGFOOD_ISSUE_MARKER)
    ? SELF_DOGFOOD_ISSUE_MARKER_VALUE
    : undefined;
}
