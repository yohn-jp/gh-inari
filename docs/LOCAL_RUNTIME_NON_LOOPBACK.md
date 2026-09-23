# Non-loopback local Runtime

Loopback is the default. To select all-interface listening for a new local
Runtime setup, set `INARI_LOCAL_RUNTIME_BIND=0.0.0.0` before running both
`inari executor setup` and `inari admission setup`. The setting is recorded in
each component's local configuration. `0.0.0.0` is only a listen address;
Admission discovers and connects to Executor at `127.0.0.1` over HTTPS, and CLI
discovers the Admission route at `127.0.0.1`. OS-assigned ports are recorded
only in local Runtime discovery state.

Non-loopback services refuse to start until both components have valid mTLS
material under their private configuration directories. Each component uses
these owner-only files:

| File                      | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `mtls-certificate.pem`    | This component's certificate, with a URI SAN for its configured component ID |
| `mtls-private-key.pem`    | This component's private key                                                 |
| `mtls-ca-certificate.pem` | Public CA certificate that issued both component certificates                |

Issue distinct certificates for the IDs in `admission/config.json` and
`executor/config.json`. The Admission certificate must include
`URI:urn:inari:local:admission:<admission-id>`; the Executor certificate must
include `URI:urn:inari:local:executor:<executor-id>`. The issuing CA must be a
valid CA certificate. Each private key must match its component certificate.
Keep the Admission and Executor private keys in their respective component
directories and set their file mode to `0600`; the directories are created
with mode `0700`. Do not pass key bytes through CLI arguments, Session input,
or Agent child environment.

The trust CA certificate is public material. The Runtime Authority signing
key and the GitHub App-user credentials remain in their existing custody
locations; they are not used as TLS identities.

The runtime verifies certificate validity, private-key matching, CA trust,
and the peer's configured URI identity. Admission also keeps the existing
Executor ID check in its health protocol. Session and Capability authorization
continues at Admission and remains required for governed operations.

The TLS private-key bytes stay in their component directories. Runtime code
does not put them in Agent child environments, CLI semantic input, status HTML,
or repository artifacts.

The bind policy is recorded during setup. To return to loopback, set
`INARI_LOCAL_RUNTIME_BIND=loopback` and set up both components in a fresh
`INARI_CONFIG_HOME`; loopback remains the default when the variable is unset.
