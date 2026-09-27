# Security Policy

## Supported versions

The project is pre-1.0. Security fixes target main and the latest 0.x release;
there is no long-term-support branch. A target design document is not a
statement that an unreleased or undeployed security feature is available.

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](../../security/advisories/new) rather than a
public Issue. If unavailable, open an Issue with minimal nonsensitive detail
and ask a maintainer to establish a private channel.

Include affected version/commit, impact, and a minimal safe reproduction.
Do not include credentials, private keys, raw authorization headers, OAuth
codes/verifiers, or sensitive repository payloads in public evidence.

The project aims to acknowledge reports within five business days. Response
is best-effort for an independently maintained project without a dedicated
security team.

## Security architecture

The [Product Architecture Canon](./docs/ARCHITECTURE.md) and
[Caller Authentication](./docs/AGENT_CAPABILITY_AUTHORIZATION.md) define the
approved trust model and detailed threats.

Repository policy and protected trust constrain Inari operations. Caller,
Delegator, transport principal, App provider actor, author, reviewer, and
merger are distinct. Source Change and Implementation task identity must not
be confused to bypass authorization.

Admission holds no GitHub provider/user credentials. Executor contains Inari
Access App custody and bounded installation read/effect capabilities.
Authority holds delegation keys. Neither key belongs in agent children,
repository data, generic UI state, or Hosted execution.

## Hosted target

Hosted transiently authenticates Inari Access user OAuth and repository
eligibility, then sends a short-lived request-bound signed assertion instead
of forwarding the user token. It has no durable user credential or repository
semantic database. Necessary service secrets and bounded replay/delivery state
are distinct from user data retention.

Runtime explicitly trusts the assertion issuer for attested facts and still
requires actual subject/operation authorization. Visibility alone is not an
App write grant. A valid issuer signature cannot detect a dishonest issuer.

TLS termination is not end-to-end encryption against Hosted. Transient token
handling is not zero exposure or immediate revocation. Detailed custody and
retention guarantees must be proved on the actual implementation/deployment.

## Runtime and effect safety

Relay ID is a public locator authenticated by a separate transport key.
It grants no repository access. Remote access is limited to admitted Inari
protocol operations, not a shell, raw provider proxy, or generic file/network
endpoint.

Control mTLS and Admission execution are separately authorized roles. Local
loopback is not a replacement for operator, Origin, CSRF, freshness, or task
checks. Module import isolation is not an OS sandbox.

Effects use exact repository/App/installation binding and minimum admitted
permissions. Success requires authoritative reread and postcondition proof.
Unknown outcomes preserve possible execution; retry/cleanup may not destroy
advanced or unrelated work.

## Migration and operational evidence

Independent Direct App and old Hosted semantic/provider engines are retired
target architectures. Their source or deployment may still exist until
explicitly migrated; documentation does not disable them or certify removal.

Bounded old-data readers preserve their original validation and provenance.
No migration silently changes trust, widens capability, deletes user keys,
or destroys historical evidence. Live Ruleset, OAuth, release, and deployment
verification remain separate authorized operations.
