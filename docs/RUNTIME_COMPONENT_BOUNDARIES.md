# Runtime Component Boundaries

Status: normative component, port, import, and custody contract under
[Product Architecture Canon](./ARCHITECTURE.md).

Inari ships as one product and one distribution. Components may be co-located
or explicitly connected over supported transport without merging their
responsibilities. Module isolation keeps forbidden private code out of client
components; it is not operating-system sandboxing.

## 1. Executable foundations

The existing foundations are:

- `src/runtime-contracts/` for neutral DTOs, validators, and public ports;
- `src/runtime-contracts/components.ts` for the component catalog;
- `scripts/check-runtime-boundaries.mjs` for the dependency guard;
- `test/runtime-boundaries.test.mjs` and component tests for guard/catalog
  consistency and regression proof.

The guard runs as `boundaries:check` in canonical verification. The target
extends owner observation and remote ingress without opening private import
escape hatches. A document statement does not prove a new port is wired into
the installed public path.

## 2. Component responsibilities

### Runtime contracts

Neutral contracts define closed versioned messages and ports. They do not
read files, parse private keys, contact GitHub, create owner state, or choose
provider permissions.

### Setup Application

Setup owns secret-free observation/action composition, prerequisites,
freshness, bounded journaling contracts, and the next action. It consumes
owner ports. It does not duplicate workflow legality in the browser or
replace owner state with a persisted completed-step counter.

### CLI

The CLI decodes typed input, invokes public operations, and presents bounded
results. Common shell/grammar/Help/Skill mechanics converge to CLI Canon.
Domain commands, security checks, and owner APIs remain Inari-owned.

### Console

The machine Console serves independent repository contexts over one operator
surface. Its routes select contexts; they do not silently retarget a running
Application instance. It consumes public observations/actions and never scans
Admission Session files or owner credential stores.

### Admission

Admission owns local Session lifecycle, caller-evidence verification, and
semantic task/capability/operation authorization. It consumes Executor's
bounded evidence and execution ports. It holds no GitHub user/provider token,
App key, or Authority private signing key.

A remote Repository Access Assertion is another bounded caller-evidence
input, not permission to bypass local policy or auto-issue full capabilities.
Admission consumes current Runtime operator grants for exact immutable GitHub
user IDs, provider hosts, semantic operation IDs, immutable repository IDs,
and targets from Runtime-owned owner configuration. It matches each verified
remote subject and request to a current grant and intersects that grant with
current repository/task policy. Missing or revoked grants, stale owner
configuration generations, or grants for the wrong host, user ID,
repository, operation, or target deny before effects.

The Runtime operator owns grant management and persistence at the owner
configuration boundary. That owner producer does not make Admission a
credential store or let Hosted issue semantic grants. Admission's current-
grant consumer must fail closed when the owner evidence is unavailable.

### Executor

Executor owns Inari Access App-scoped custody, installation/repository
bindings, bounded provider read capabilities, and admitted effect execution.
It contains the Credential Broker and composes Core/Lifecycle Controller with
provider adapters.

It is not an arbitrary remote shell, a public generic GitHub client, a Session
signer, or the owner of the user's OAuth token.

### Authority

Authority owns delegation/signing identities and private material. It returns
only admitted signatures/public receipts. It does not mint provider tokens,
read another owner's private store, or accept arbitrary signing requests.

### Composition and lifecycle

Composition selects owners, connects public ports, and manages the process and
listener lifecycle it actually owns. It does not parse or persist private
material merely because it forwards an enrollment stream.

Local co-location and a selected-role command do not permit ordinary CLI or
Console code to load every private component through a barrel import.

### Hosted and Relay

Hosted owns transient OAuth verification and its service-signed assertion.
Relay owns authenticated Runtime connections and bounded delivery state.
They do not own repository semantic state, task authorization, provider
execution, Runtime operator grants, or a central Inari Session store.

## 3. Existing module ownership

The catalog's current boundaries include:

```text
runtime-contracts: src/runtime-contracts/
setup-application: src/application/setup/
cli: src/cli/ and the designated local client/launcher state modules
console: designated local Console host/presentation modules
admission: src/admission/ and designated local Admission/session-store modules
executor: src/executor/ and designated Executor server modules
authority: src/authority/
composition: src/composition/ and the local supervisor
```

Exact paths and public entrypoints come from the catalog and guard, not this
illustration. A file moving within one role does not erase its private import
closure or grant another role access.

The catalog and guard role ownership must agree. Any expanded public entry
requires a concrete port/consumer justification, not a wildcard allowlist.

## 4. Public ports

The existing port set includes ExecutorExecutionPort, AdmissionSessionPort,
AuthoritySigningPort, RuntimeRoleStatusPort, SetupObservationPort,
SetupActionPort, SetupJournalPort, and SecretEnrollmentPort.

Each reuses the existing canonical request/result and identity types. A new
port must not duplicate `AuthorizedExecution`, `LocalSessionBinding`,
RepositoryIdentity, Setup observations, or delegation meaning.

The accepted multi-repository work adds ExecutorObservationPort as the neutral
public observation of App custody and repository binding. Its implementation
on a Source branch is not automatically available on main; final composition
must pin the physically integrated producer.

Session enumeration and Runtime observation are Admission/owner APIs. Console
may aggregate them but must not create a second Session database or a
browser-only repository filter as its security boundary.

## 5. Setup observation contract

Setup observations bind repository identity and owner configuration generation.
Known status requires owner identity, observation time, and generation evidence.

Five dimensions remain separate:

```text
configuration:
  unknown / unconfigured / partial / configured

health:
  unknown / not-running / unhealthy / healthy

provider-binding:
  unknown / unbound / mismatched / bound

repository-trust:
  unknown / untrusted / pending-human-trust / trusted

session-readiness:
  unknown / not-ready / ready
```

There is no persisted aggregate ready flag replacing these observations.
A healthy component cannot establish repository trust, provider binding, or
Session authority. UI summaries must preserve the underlying dimensions and
freshness.

A generation mismatch is stale evidence, not an invitation to merge records
from different configurations.

## 6. Setup actions and outcomes

An action identifies its owner, prerequisite dimensions/statuses, bounded
inputs, confirmation, and freshness. Inputs are typed text, choice,
confirmation, or enrollment; enrollment private bytes do not enter generic
action JSON.

A structured command is executable plus argv, not an interpolated shell
string. Presentation may show it without becoming the authority for its
prerequisites or permission.

Action outcomes remain succeeded, failed, cancelled, stale, action-required,
and unknown. Unknown means the effect was not conclusively observed and
requires reconciliation. A retry cannot treat it as definite nonexecution.

The action generation and expiry are checked immediately before invocation.
Repository selection or a stale browser confirmation cannot retarget an effect.

## 7. Secret-free contracts

Generic Setup JSON is validated before use. The shared guard rejects PEM,
provider/bearer tokens, private JWK members, secret-designating properties,
non-JSON values, and oversized or excessively nested content.

Diagnostics identify the failing path/class, never echo the secret value.
The neutral contract layer neither obtains nor parses secrets.

Repository registry and Setup records contain public identity references:
repository, App/installation, component, Authority/fingerprint, and appropriate
public endpoint references. Owner filesystem paths are not cross-component
bindings.

A public fingerprint is not a private key, but it also does not prove that
repository trust, provider verification, or current binding exists.

## 8. Enrollment and bootstrap

SecretEnrollmentPort consumes a secret-free request plus a bounded stream.
The existing maximum enrollment size is the owner contract's 64 KiB bound;
consumers cannot raise it by supplying a larger body length.

Only the selected owner consumes and validates private bytes. Executor owns
App PEM enrollment; Authority owns delegation key handling. Generic Setup,
Console, and composition return only public receipts and fingerprints.

Enrollment must be usable before ordinary health/provider/trust readiness;
otherwise the first key cannot be installed. This exception enables the
bootstrap operation only, not normal execution before authorization.

For Manifest onboarding, Executor exchanges the one-time conversion code and
stores the resulting PEM inside its own boundary. Console must not perform
conversion and then persist or return the credential-bearing response.

Loopback is not authentication. Browser control requires the accepted operator
session, Host/Origin, CSRF, context/freshness, and request-size checks.

## 9. Repository registry and owner-native custody

Repository identity is host plus immutable repository ID. The accepted local
registry layout uses the numeric ID as its path identity with host validation;
a collision across hosts fails rather than aliases another repository.
Current name is refreshable metadata.

Executor custody is App-scoped. Repository bindings reference App,
installation, verified generation, and fingerprint without copying PEM.
Authority custody is Authority-ID-scoped. Multiple repositories may reference
one Authority without duplicating its key; trust remains independently
established in each repository.

Migration adopts verified legacy evidence into canonical stores. Canonical
migrated state wins; stale legacy records never overwrite it. Observation does
not migrate or create directories. No read path performs destructive cleanup.

## 10. Executor observation and remote Control

ExecutorObservationPort returns one bounded, closed, versioned public record:
Executor identity, public App custody observations, and public repository
binding observations. It contains no token, PEM, key path, environment copy,
Session secret, generic provider client, or arbitrary diagnostic payload.

The owner resolves canonical evidence before explicitly labelled legacy
compatibility evidence. The consumer does not reimplement custody precedence.

Local and explicit HTTP/mTLS adapters implement the same port. The client
checks status, body bounds, schema/version, protocol, and expected Executor
identity. Failure never falls back to the local filesystem.

For non-loopback transport, Control and Admission are separate roles:
Control may use its admitted owner observation/management routes;
Admission uses its execution/evidence routes. The browser is not a Control
mTLS principal, and neither role may invoke the other's routes by possession
of any trusted client certificate.

Endpoint persistence and Control certificate provisioning must be supplied by
the explicitly owned integration contract. The initial target uses manual
explicit configuration, not automatic PKI/discovery or remote Authority.

## 11. Session and Runtime observation

Admission owns active/closed local Session records and derives expiry.
Owner-side enumeration is bounded, deterministic, and repository-filtered.
A Session lookup verifies the returned record's immutable repository/task
binding; a browser filter alone is insufficient.

Public observations may include safe identity, authorization/capability names,
branch/base/policy evidence, validity, lifecycle state, and bounded diagnostics.
They must not expose raw signed payloads, keys, tokens, arbitrary process
output, or provider responses.

Global counts and repository views derive from the same owner records. A
minimal timeline may use issued, expiry, and closed facts. It is not a generic
log platform or a new success authority.

Current Executor binding is a separate current observation, not an immutable
claim retroactively inserted into an old Session.

## 12. Import guard

The existing guard resolves module specifiers with the TypeScript resolver and
walks the value-import closure, including static/side-effect imports,
re-exports, import-equals require, and literal dynamic imports.

Forbidden private modules are reported with a witness path. Barrels cannot
hide private dependencies. Non-literal dynamic import/require and unresolved
relative modules fail because the closure cannot be proved safe.

Private groups include issuer custody, App-user credentials, Authority
signing, and Admission-private state. A role may access only its permitted
owner/public boundaries; it does not inherit another role merely by calling
its function.

Neutral runtime-contracts can value-import only themselves. Setup Application
can value-import itself and runtime-contracts. Type-only imports are still
restricted to the approved neutral types; erased runtime code is not license
to create uncontrolled type dependencies on private stores.

The exact denied-group and approved-type sets remain the executable guard's
contract and must agree with the component catalog.

## 13. Historical migration ledger

The original 17 exact-edge import exceptions were retired; the active
historical migration ledger is empty. Its frozen baseline remains a regression
proof, not permission to restore entries.

A new caller, target, owner, wildcard, unresolved module, or non-literal
import is not excused by historical migration. Removing a private import
requires removing its exception rather than keeping an evergreen escape hatch.

No new architecture migration may weaken the guard simply because a missing
public port is inconvenient. Add the smallest justified neutral contract and
owner implementation instead.

## 14. Wiring and lifecycle

Composition constructs the Setup Application from public owner ports and
supplies observe-only or supervisor-owned runtime lifecycle according to the
actual host. CLI clients do not silently become process supervisors.

Selected-role commands load only that role's private implementation.
Ordinary clients and browser controllers consume public DTOs and ports.
Enrollment bytes may pass through an explicitly bounded forwarding component
without making it their parser or persistent owner.

A separately hosted component must be representable without shared owner
filesystem access. Unsupported remote operations remain explicit gaps, not
success stubs or local fallback.

## 15. Verification and review

Prove catalog/guard agreement, forbidden transitive imports, dynamic/unresolved
specifier rejection, neutral type restrictions, empty exception ledger,
secret-free JSON, streamed size limits, pre-readiness enrollment, and sanitized
receipts/errors.

Prove local and remote port parity, wrong component/role/repository/generation
denial, no filesystem fallback, multi-repository isolation, owner-side Session
filtering, and restart/migration behavior.

Producer unit tests prove ports; composition tests prove wiring; packed and
browser scenarios prove public usability. A helper returning ready cannot
replace any of those boundaries.

Architecture changes remain owner-approved. Internal file layout may change
within these boundaries; ownership, credential custody, public meaning,
transport authorization, and proof obligations may not change incidentally.
