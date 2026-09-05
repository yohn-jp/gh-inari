# Inari issuer GitHub App authority

This document is the implementation contract for Issue #217. The product and
trust-boundary authority remains
[`CHANGE_CONTROL_PLANE.md`](./CHANGE_CONTROL_PLANE.md); this document does
not introduce a second semantic authority.

## Role

The Inari GitHub App is the issuer identity and a least-privilege mutation
capability. It is not a semantic API, a frontend, a reviewer, or a merge
authority.

Inari Core computes and validates `ChangeEffect` values. The issuer authority
accepts only those explicit effects and checks the credential boundary around
their application. It does not derive branch names, choose lifecycle
transitions, validate PR policy, or implement idempotency and recovery.

## Permission ceiling

The initial issuer ceiling is deliberately limited to the permissions needed
by the initial effect set:

| Initial `ChangeEffect`    | GitHub App permission  |
| ------------------------- | ---------------------- |
| `CREATE_BRANCH`           | `contents: write`      |
| `DELETE_BRANCH`           | `contents: write`      |
| `CREATE_PULL_REQUEST`     | `pull_requests: write` |
| `MARK_PULL_REQUEST_READY` | `pull_requests: write` |
| `CLOSE_PULL_REQUEST`      | `pull_requests: write` |

`metadata: read` is GitHub's automatic baseline and is not requested as an
additional capability. The issuer does not request Issue mutation,
administration, Actions, workflow, review/approval, or merge permissions.
When one effect is applied, the short-lived credential is requested with only
that effect's required permission. A Change issuance containing branch and PR
effects requests the union of those two requirements.

## Credential boundary

The only credential boundary is
`TrustedInstallationCredentialBroker.withScopedInstallationCredential`:

```text
human / agent caller
        │ semantic request, no App credential
        ▼
trusted protected execution
        │ obtains a fresh installation credential
        │ selects one repository and requested permissions
        ▼
scoped mutation capability
        │ apply(ChangeEffect), no token return value
        ▼
GitHub effect adapter
        │
        └── credential is discarded when the scoped operation ends
```

The App private key and installation token exist only inside the trusted
broker implementation. The request, scope evidence, mutation receipt, and
authority errors contain no credential value. Broker errors are sanitized at
the authority boundary so an accidental token-bearing provider error cannot
cross to a caller.

The broker must obtain a new short-lived credential for the operation; it must
not cache or return a reusable bearer credential. The scoped capability must
expose only the repository-scoped mutation operation and must not expose a
token, private key, authorization header, or general GitHub client.

## Identity and scope proof

Every issuer operation carries all of these identities:

- App identity: `kind=github-app`, slug `inari-issuer`, configured App ID,
  principal `app:inari-issuer`.
- Installation identity: App ID, installation ID, and GitHub host.
- Repository identity: GitHub host, immutable decimal repository ID, and
  `owner/name` locator.
- Requested capability: the exact effect-derived permission set.

The broker must return scope evidence proving that:

- the App and installation identities match;
- the installation host matches the target repository host;
- the selected repository ID and locator match the target;
- the credential is restricted to the selected repository;
- the granted permissions exactly match the requested effect capability,
  apart from GitHub's automatic metadata read permission; and
- the expiry is present and in the future.

Unknown fields, missing identity, host/repository/installation mismatch,
unselected repository scope, excess permission, and expired credentials fail
closed. Owner/name is never accepted as a substitute for the host plus
repository ID tuple.

## Trusted execution

The authority accepts only an explicit trusted execution context from the
protected remote runtime:

- runtime `github-actions`;
- event `workflow_dispatch` or trusted `workflow_call`;
- protected workflow ref and immutable workflow commit SHA;
- `workflowTrust=protected` and `codeExecution=trusted-only`;
- `fork=false` and `pullRequest=false`.

`pull_request`, `pull_request_target`, fork execution, PR merge refs,
untrusted checkout, and unknown events cannot obtain issuer credentials. A
privileged runtime must execute its protected workflow and canonical Inari
dependencies without checking out or executing PR-controlled code. Repository
protection, owner review, and immutable dependency controls protect the code
that constructs the trusted context.

## Authority separation

The requester may be a human or agent, while the mutation issuer is always
the Inari App. Commit authorship remains implementation provenance. Review and
approval belong to a human or independent review authority; the issuer
authority has no approve/review operation and cannot approve its own PR. Merge
admission remains repository policy and is outside this module.

## Boundary with Issue #218

This issue establishes the typed authority and broker contract. It does not
add an Actions workflow, workflow dispatch API, checkout behavior, semantic
request routing, effect journal, projection verification, or retry executor.
Those are trusted execution responsibilities of Issue #218 and must consume
this boundary without moving semantic policy into workflow YAML.
