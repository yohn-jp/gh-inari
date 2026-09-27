# Explicit Remote Runtime Components

Status: operator/deployment contract under [Runtime Component Boundaries](./RUNTIME_COMPONENT_BOUNDARIES.md). The target uses explicit endpoint and peer configuration; it does not introduce automatic PKI or a general remote-access server.

## 1. Scope

Loopback remains the local default. SSH forwarding can expose the authenticated local Console without making every Runtime component publicly reachable. An all-interface listen address is not a routable peer identity or a discovery result.

Remote component placement uses a configured endpoint, expected component ID and trusted TLS material. Executor may be separately hosted without sharing its secret filesystem with Console, Admission or Authority. Remote Authority and automatic certificate issuance/distribution are not included in this completion scope.

## 2. Transport trust

Use distinct component certificates and owner-local private keys. The existing mTLS identity vocabulary binds role plus component ID using the `urn:inari:local:<role>:<id>` URI form. Verify certificate validity, key match, issuing trust and the exact configured peer identity, not merely a trusted CA.

`admission`, `executor` and `control` are distinct roles. Admission execution/evidence routes and Control owner-observation routes must reject the other role where that route separation applies. A browser is not a component mTLS principal and must never receive these keys.

Non-loopback startup is fail-closed without valid security material. TLS authentication does not replace repository, Session, subject or capability admission. Do not fall back to plaintext, another endpoint or local secret-file reads after authentication failure.

## 3. Current configuration versus target

At the observed main baseline, the local non-loopback configuration includes component-owned `mtls-certificate.pem`, `mtls-private-key.pem` and `mtls-ca-certificate.pem` files. Existing setup can record a listen policy, while local discovery still selects local peer addresses. That implementation is not proof of arbitrary cross-host endpoint provisioning.

The separate Executor observation producer adds a Control-authenticated HTTP seam. It does not itself complete endpoint persistence, Control certificate provisioning, remote enrollment or remote Authority. Those capabilities must be certified at their actual boundary before this guide describes them as available.

Use only the installed release's supported setup/configuration workflow. This document does not add command flags or authorize manual mutation of internal configuration to bypass readiness.

## 4. Operator browser boundary

Console authentication retains Host/Origin, CSRF, expiry, repository/config-generation binding, confirmation and request/upload size checks. Loopback and an SSH tunnel are transport properties, not user authorization.

A machine-scoped discovery view may expose only allowed public operational data. Repository actions are verified server-side against their selected immutable context. Switching a route cannot retarget an existing action or token to another repository.

## 5. Separation from Hosted Relay

Hosted Relay provides a public ingress over a user-owned outbound connection and routes by relay locator. Its transport key and assertion issuer trust are distinct from component mTLS and Authority delegation. Configuring one does not authorize the others.

Do not expose Executor's raw provider client, shell execution or unrestricted owner filesystem through either remote path. Cloud requests remain bounded Inari protocol operations.

## 6. Verification

Test correct peers, wrong role, wrong component ID, wrong server, expired/untrusted material, unavailable endpoints and restart/reconfiguration. Distinguish separate-process fixtures from real separate-host certification. No test may copy Executor private material into another component's home to simulate a working connection.
