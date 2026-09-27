# Source Acceptance Policy and Reviewer Independence

Status: normative domain contract under
[Product Architecture Canon](./ARCHITECTURE.md).

This contract governs reviewer authority and independence for the
repository-owned Source acceptance record. The record's v1 shape and exact
candidate/criteria validation remain separate. A valid record or review
carrier alone does not establish current Source completion.

## Reviewer authorization source

The sole versioned source of Source acceptance reviewer authorization is the
repository-owned Source Acceptance Policy on the protected canonical ref. The
policy has an allowlist of immutable GitHub user IDs. Its provenance binds the
immutable repository identity (`repositoryHost + repositoryId`), the
protected-ref tree and policy source digest, and the policy generation. The
policy loader must resolve and validate one current protected-ref generation
under the existing repository trust model before an authorization decision.
Missing, unreadable, invalid, ambiguous, or stale policy evidence denies
current reviewer authority.

An allowlisted login, CODEOWNERS entry, aggregate approval count, or
repository permission level does not establish Source acceptance reviewer
authority. A mutable login is not an identity key. Inari Access App, bot, and
Hosted identities cannot be Source acceptance reviewers, even if represented
in policy input. The reviewer must have a provider-proven immutable GitHub
user ID in the current allowlist.

The policy artifact may be stored at
`.github/inari/source-acceptance-policy.json`; the schema/loader work fixes
the concrete artifact contract. This example path does not create a second
authority source.

## Independence for the exact candidate

An authorized reviewer must be distinct from all of these immutable GitHub
user IDs:

- the Source Issue author (Source requester);
- the Source integration PR author;
- every human candidate contributor.

The candidate contributor set comes from the provider-observed complete PR
commit collection reaching the exact Source integration PR head. Each commit's
author immutable GitHub user ID belongs to the set. A `Co-authored-by`
contributor belongs to the set only when provider evidence reliably maps that
human to an immutable GitHub user ID. Name, email, and login text alone never
establish that mapping. The commit committer is a delivery or integration
actor and is excluded from this contributor set; the App/provider actor is
separate from commit authorship.

An unresolved human commit author or `Co-authored-by` identity prevents proof
of independence and fails closed. Incomplete, truncated, or unavailable PR
commit pagination, or failure to prove the collection reaches the exact PR
head, also fails closed. Unknown Source requester, PR author, reviewer
identity, or human/bot classification needed for this decision fails closed.
If the reviewer is among the author or proven co-author IDs, the reviewer is
not independent.

## Record consumption and lifecycle boundary

Every use of a Source acceptance record for current completion revalidates
all of the following against current provider and repository evidence:

1. The protected-ref policy generation is current and authorizes the record's
   reviewer immutable user ID.
2. The reviewer is independent of the Source requester, PR author, and the
   complete exact-head candidate contributor set.
3. The record binds the immutable repository and Source identities, governed
   Source integration PR, exact head SHA, and current Source criteria
   version/digest, with a passing result for every current criterion.

If a policy change revokes reviewer authority, an older record remains
readable as historical evidence but cannot certify current Source completion.
Changed candidate head, criteria, identity, independence, or unavailable
current evidence has the same current-use result. The existing v1 Source
acceptance record is not silently versioned; policy evaluation may supply
separate current evidence to its consumer.

Current Change `ACCEPTED` checks, required reviews, governance, and merge
policy remain separate conditions. Source acceptance is criteria evidence,
not task conformance, PR approval, mutation authorization, or merge authority.
