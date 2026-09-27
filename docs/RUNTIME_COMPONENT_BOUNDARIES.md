# Runtime Component Boundaries

Status: normative target under [Product Architecture Canon](./ARCHITECTURE.md). One product/distribution contains distinct owners connected through public contracts. Module isolation is not OS sandboxing.

## 1. Owners

`runtime-contracts` owns transport-neutral DTOs, validators and public ports, not provider I/O or secret handling. `setup-application` owns secret-free action/state/recovery projection. It depends on public contracts, not private component implementations.

CLI and Console present operations/results. Admission owns caller/Session authentication, capability admission and Session lifecycle. Executor owns Inari Access custody, repository bindings, provider evidence and admitted execution. Authority owns delegation signing. Composition wires owners and supervises only processes/listeners it actually owns.

Hosted authentication has narrowly scoped transient GitHub-user verification and assertion signing. Relay owns locator routing and bounded delivery. Neither imports private Runtime owners or becomes a semantic execution host.

## 2. Public seams and dependency direction

Producers expose their public owner ports; consumers depend on the neutral contract rather than sibling worktrees, private modules or owner filesystem paths. Existing Admission, Executor execution, Authority signing, Runtime status, Setup observation/action/journal and secret enrollment ports remain the starting point.

Executor owner observation is a separate Control capability from Admission execution/evidence access. A remote Console calls the same observation contract over authenticated transport, not a new config-file reader. Admission Session listing is an owner-side bounded read projection with immutable repository filtering; the browser does not scan Session files or enforce isolation by client-side filtering alone.

The existing component catalog and `scripts/check-runtime-boundaries.mjs` are executable checks for the implemented module graph. The guard's static import/re-export, literal dynamic import and TypeScript resolution rules remain fail-closed. No unresolvable import, nonliteral dynamic import or new historical-ledger exception is a migration shortcut.

At the observed main baseline the old migration ledger is empty. Do not reintroduce private-owner imports to connect a new frontend. Future contract extensions must update the corresponding ownership proofs without weakening them.

## 3. Repository registry and binding

Repository contexts use immutable host plus repository ID for semantic equality. The accepted registry path convention uses the numeric ID and validates the host; host collisions fail rather than aliasing. Repository names are mutable display/lookup metadata, not storage identity.

Repository Setup records contain public component IDs, App/installation references, Authority fingerprints, endpoint references and relevant generation/revision. They contain no PEM, user/provider token, Session secret, copied environment or owner key path.

Executor custody is keyed by App identity. A repository binding names its App, installation and exact verified credential generation/fingerprint. Intentional shared-App bindings reuse the same owner credential without copying PEM; dedicated Apps remain distinct.

Authority custody is keyed by Authority identity. Multiple repository trust records may refer to the same public identity without duplicating the private key. Repository trust is still independently established on each protected canonical ref.

Canonical adopted records override legacy input. Observation never performs migration or creates missing owner files. Adoption validates identity, persists durably and rereads before canonical state is selected; it never destroys legacy state implicitly.

## 4. State and owner evidence

Keep configuration, health, provider binding, protected-ref trust and Session readiness distinct. Session lifecycle, execution outcome and Relay connectivity are additional independent observations. Each known fact carries its owner, observation time and relevant generation.

Unavailable evidence is unknown/unavailable, not absent or healthy. Aggregate UI status is derived and never written back as authority. A generation-bound action is revalidated immediately before its owner effect.

Admission owns immutable Session binding plus lifecycle records. Expiry is derived from current time and binding; closing is an owner operation. Listing is bounded, deterministic and repository-checked. Global views aggregate those same authorized records, not another Session database.

## 5. Setup and secret enrollment

Setup orchestrates existing owner actions and a bounded journal. It never stores a parallel completed-step workflow authority. Retry/restart recomputes from owner evidence, preserving uncertain outcomes instead of repeating effects blindly.

Secret enrollment is a separate bounded streaming owner port. Generic Setup JSON contains only intent and public receipts. Only Executor parses/stores App PEM; only Authority parses/stores its private signing material. A forwarding layer must not inspect, log or persist enrollment bytes. Enrollment is available before normal repository readiness to avoid circular bootstrap requirements.

Dedicated App Manifest conversion occurs at Executor so the private key is born inside its custody boundary. Public App identity/fingerprint is returned, not the conversion body. OAuth client configuration needed for that same App's Hosted profile is a distinct explicit prerequisite; generic Setup must not retain otherwise unused secrets for hypothetical future use.

## 6. Control, Admission and remote placement

Browser operator authentication uses the established bounded context, Host/Origin/CSRF checks, expiry, confirmation and generation validation. Loopback alone is not authentication. Browser context does not become a component mTLS principal.

Control may invoke explicitly authorized owner observation/enrollment/setup actions. Admission may invoke its execution/evidence routes. Neither transport role implies the other's authority. The `control`, `admission` and `executor` identities remain distinct even when processes share a host.

Remote placement initially uses an explicit endpoint, expected component identity and operator-provided TLS trust. Automatic PKI, ambient backend discovery, generic SSH execution and remote Authority are not included. Separate Executor deployment must not depend on a shared secret filesystem. See [Non-loopback Runtime](./LOCAL_RUNTIME_NON_LOOPBACK.md).

## 7. Console and lifecycle

One machine-scoped Console serves repository list/overview and repository-specific Setup, Runtime, trust, Sessions and diagnostics. `setup console` and `runtime console` are current entry-point names; convergence makes them select routes on the same host, not competing apps or authorization systems.

A repository switch changes the selected context. It never retargets an existing owner's action/session to another repository. Effectful contexts remain repository- and generation-bound. A remote UI is a presentation adapter and receives only the controls its authenticated operator is entitled to use.

Disconnect prevents new relevant work, resolves active Sessions, detaches bindings, then performs only selected cleanup. Shared App/Authority material cannot be removed while referenced. Rotation prepares and verifies a candidate, switches the binding safely, proves the new path, then retires old access. A directory deletion is not a lifecycle implementation.

## 8. Implementation status and evidence

The main baseline already contains component ports/guards and local setup/runtime work. Multi-repository custody/observation work exists on its separately audited Source lineage; that is not evidence of main integration. Assertion ingress, relay-locator routing and remaining Console/onboarding composition are target work.

Tests must prove exact owner boundaries, wrong repository/peer/generation denials, read-only observation, no shared-filesystem dependency, secret exclusion, restart and interrupted lifecycle recovery. Source helper tests, separate-process tests and actual separate-host proof must remain distinguishable. See [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md).
