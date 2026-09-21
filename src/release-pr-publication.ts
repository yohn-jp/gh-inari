/**
 * Provider-neutral handoff for the existing Issue-less release pull request.
 *
 * Release publication is deliberately separate from IntegrationRouting.  The
 * only route it admits is release/<semantic-version> into the governed
 * default branch, at the exact source revision supplied by release
 * preparation.
 */

import { DEFAULT_BRANCH_NAME } from "./branch-naming.js";
import type {
  PrPublicationProvider,
  PrPublicationReleaseWorkIdentity,
  PrPublicationRepositoryIdentity,
  PrPublicationRequest,
  PrPublicationResult,
} from "./pr-publication.js";

export const RELEASE_PR_PUBLICATION_CONTRACT_VERSION = 1 as const;
export const RELEASE_PR_PUBLICATION_KIND = "release-pr-publication" as const;
export const RELEASE_PR_PUBLICATION_DEFAULT_BASE = DEFAULT_BRANCH_NAME;
export const RELEASE_PR_PUBLICATION_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export interface ReleasePrPublicationRoute {
  readonly version: typeof RELEASE_PR_PUBLICATION_CONTRACT_VERSION;
  readonly kind: typeof RELEASE_PR_PUBLICATION_KIND;
  readonly role: "release";
  readonly targetVersion: string;
  readonly head: string;
  readonly base: typeof RELEASE_PR_PUBLICATION_DEFAULT_BASE;
  readonly expectedHead: string;
  readonly expectedBase: typeof RELEASE_PR_PUBLICATION_DEFAULT_BASE;
  readonly headRevision: string;
}

export interface ReleasePrPublicationInput {
  readonly repository: PrPublicationRepositoryIdentity;
  readonly targetVersion: string;
  readonly sourceRevision: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

function validSourceRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{7,128}$/iu.test(value);
}

/** Derive the one permitted release route from a prepared release identity. */
export function deriveReleasePrPublicationRoute(
  targetVersion: string,
  sourceRevision: string,
): ReleasePrPublicationRoute {
  if (!RELEASE_PR_PUBLICATION_VERSION_PATTERN.test(targetVersion))
    throw new TypeError("Release target version must be a semantic version.");
  if (!validSourceRevision(sourceRevision)) throw new TypeError("Release source revision must be a commit SHA.");
  return Object.freeze({
    version: RELEASE_PR_PUBLICATION_CONTRACT_VERSION,
    kind: RELEASE_PR_PUBLICATION_KIND,
    role: "release" as const,
    targetVersion,
    head: `release/${targetVersion}`,
    base: RELEASE_PR_PUBLICATION_DEFAULT_BASE,
    expectedHead: `release/${targetVersion}`,
    expectedBase: RELEASE_PR_PUBLICATION_DEFAULT_BASE,
    headRevision: sourceRevision,
  });
}

/** Build the explicit Core request consumed by the user-context publisher. */
export function createReleasePrPublicationRequest(input: ReleasePrPublicationInput): PrPublicationRequest {
  const route = deriveReleasePrPublicationRoute(input.targetVersion, input.sourceRevision);
  return Object.freeze({
    version: 1,
    kind: "pr-publication" as const,
    repository: input.repository,
    workIdentity: {
      release: {
        targetVersion: input.targetVersion,
        sourceRevision: input.sourceRevision,
      },
    } as PrPublicationReleaseWorkIdentity,
    routing: route,
    expectedHead: route.head,
    expectedBase: route.base,
    headRevision: route.headRevision,
    title: input.title,
    body: input.body,
    ...(input.draft === undefined ? {} : { draft: input.draft }),
    ...(input.maintainerCanModify === undefined ? {} : { maintainerCanModify: input.maintainerCanModify }),
  });
}

/** Publish a prepared Issue-less release through the same Core publisher. */
export async function publishReleasePullRequest(
  input: ReleasePrPublicationInput,
  provider: PrPublicationProvider,
): Promise<PrPublicationResult> {
  const { publishPullRequest } = await import("./pr-publication.js");
  return publishPullRequest(createReleasePrPublicationRequest(input), provider);
}
