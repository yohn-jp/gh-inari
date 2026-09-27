# Local and Explicit Remote Runtime Transport

Status: transport/security contract under
[Product Architecture Canon](./ARCHITECTURE.md) and
[Runtime Component Boundaries](./RUNTIME_COMPONENT_BOUNDARIES.md).

Loopback remains the default. Exposing a listener, authenticating a component,
and authorizing an Inari operation are separate decisions.

## 1. Baseline local behavior

The existing `INARI_LOCAL_RUNTIME_BIND=0.0.0.0` setup selection records
all-interface listening in component configuration. It is a listen policy,
not an advertised remote destination or automatic discovery mechanism.

In the observed baseline, local discovery connects Admission to Executor at
`127.0.0.1` and CLI to the discovered local Admission route. Ports are
OS-assigned and recorded in owned discovery state. Do not restore fixed-port
fallbacks or claim all-interface binding alone makes remote composition ready.

## 2. Component TLS material

Each non-loopback component uses owner-only material:

```text
mtls-certificate.pem
mtls-private-key.pem
mtls-ca-certificate.pem
```

The certificate/private key must match, the certificate must be valid, and
the CA must be a valid trusted issuer. Private files/directories use the
owner's restrictive storage contract (`0600`/`0700` where applicable).

Existing URI identities include:

```text
urn:inari:local:admission:<admission-id>
urn:inari:local:executor:<executor-id>
```

The accepted Control observation extension uses its separate `control` role
and explicit expected Control identity. Availability on a Source branch is
not proof that the current main/deployed endpoint supports that extension.

Neither the App key nor the Delegator key is a TLS credential. TLS private
bytes never enter semantic input, agent environment, status HTML, repository
artifacts, or browser persistent storage.

## 3. Peer identity and route authorization

Verify CA trust, validity, key match, exact configured URI role/identity, and
the expected component ID in the public protocol. A valid client certificate
from the CA does not authorize every role or route.

Admission accesses its execution/evidence routes. Control uses explicitly
admitted owner-observation/management routes. Non-loopback owner observation
must not accept Admission identity; Control identity must not invoke reserved
execution/evidence routes. The browser is not the Control mTLS principal.

Session/subject/capability authorization remains required after transport
admission. TLS authentication never supplies repository or task authority.

## 4. Explicit remote target

Remote composition accepts operator-specified endpoint, expected component
identity, trusted CA/certificate material, and the admitted client role.
It uses the existing public owner protocol rather than shared owner files.

Unavailable, wrong-identity, malformed/oversized, unsupported-version, or
unauthorized responses fail closed. A remote failure does not select local
files or a different endpoint without explicit configuration.

Initial scope does not add automatic certificate issuance, distribution,
remote discovery, generic service registry, or remote Authority. Provisioning
and persistent endpoint references must have a named implementation owner
before the corresponding public path is declared complete.

## 5. Console and SSH

A local Console can remain on dynamic loopback and be reached through one
explicit SSH forward. SSH tunneling does not require public listener exposure
or replacing the Console's operator/Origin/CSRF checks.

The Console host owns only its listeners and Runtime children. It must not
stop or adopt a reachable process solely because it answers a health request.
Repository-aware actions remain generation-bound and least-privilege even
when the browser has machine-scoped discovery access.

## 6. Rotation and migration

Transport identity rotation does not rotate delegation or App keys. Verify the
candidate transport identity and expected peer configuration before removing
working material. Do not bypass peer validation during transition.

Changing back to loopback or migrating configuration is an explicit owner
operation. The historical fresh-INARI_CONFIG_HOME procedure is a separate
isolated setup option, not permission to delete or overwrite existing user
configuration and active state.

## 7. Verification

Test correct role/identity, wrong client/server, expired/untrusted/mismatched
certificate, missing private material, route-role crossover, wrong component
response ID, and no remote-to-local fallback.

Prove dynamic discovery/collision handling separately from explicit remote
endpoint composition. Separate process/config-home fixtures prove that
boundary, not an actual separate host/network unless executed there.
