# Inari Architecture Vocabulary

Status: normative vocabulary for the architecture established by Issues #542
and #543. This document names responsibility, identity, credential, provider,
and deployment boundaries. It does not change authentication behavior,
provider permissions, Change/XState semantics, or public and wire contracts.

Issue #542 remains the intent and topology authority for the broader
architecture. This document makes its provider-principal, credential-domain,
and observation vocabulary concrete. Domain documents retain their detailed
decisions, but new architecture prose MUST use the terms defined here. Existing
names remain valid only as implementation or compatibility names unless this
document explicitly maps them.

## 1. Architectural boundary

GitHub is the sole repository **Authority**: it owns the durable repository
facts and provider-enforced state from which Inari derives semantic
projections. A process, workflow, Runtime Host, XState actor, App, or
credential is not an Authority merely because it can authenticate or execute
code.

The following terms describe different dimensions and MUST NOT be collapsed
into one another:

| Term                   | Meaning                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Role**               | One architectural responsibility or decision ownership. A Role says what must be done, not where it runs.                                                    |
| **Component**          | Code, module, process, or service that implements one or more Roles. Co-location does not merge the logical boundaries.                                      |
| **Principal**          | An authenticated identity that can prove identity or possession. A Principal is not automatically an Authority or a semantic requester.                      |
| **Canon**              | Authoritative governed data or rules held by the Authority. Canon is data, not an executing component.                                                       |
| **Port**               | A stable transport-neutral contract between Components or Roles.                                                                                             |
| **Adapter**            | A concrete binding between a Port and a protocol, provider, CLI, or Runtime Host.                                                                            |
| **Transport**          | The mechanism that moves a request or result. Transport metadata cannot create semantic authority.                                                           |
| **Runtime Host**       | The compute environment in which Components execute, such as local Node.js, an Actions Runner, or a Cloudflare Worker.                                       |
| **Deployment Profile** | An explicit composition of Components, Adapters, Transports, credentials, and Runtime Hosts.                                                                 |
| **Trust Boundary**     | A boundary across which identity or credential authority changes and therefore requires explicit proof, scope, or containment.                               |
| **Executor**           | The operation-coordination Role that admits a request or plan and carries it through a verified terminal result. It is not a Port, Adapter, or Runtime Host. |

`same executable/process != same responsibility`. A compact deployment may
co-locate Roles, but co-location never permits a Session, Delegator, provider,
or transport credential to be treated as another credential domain.

### 1.1 Execution boundaries

`Executor` is reserved for operation coordination after admission. A Port
defines a contract; an Adapter binds that contract to a provider or Transport;
neither one becomes the semantic Executor merely because it can send requests or
apply provider effects. Runtime Hosts, including Actions Runners and Workers,
are deployment environments rather than Executors.

The Change boundary uses these canonical names:

- `ChangeExecutionPort` is the transport-neutral request/read contract.
- `ActionsChangeExecutionAdapter` and the Direct-App adapter implement that
  Port and own transport mechanics only.
- `TrustedChangeExecutor` and Session-authorized coordination are Executor
  implementations that admit operations and verify terminal results.
- `LocalSemanticIssueExecutor`, `LocalSemanticBranchExecutor`, and
  `LocalSemanticPullRequestExecutor` (including their bounded relation and
  mutation profiles) are explicit local semantic execution profiles. They do
  not collapse into privileged Change coordination.

The deprecated `ChangeRemoteExecutor` and
`GitHubActionsChangeRemoteExecutor` exports remain compatibility aliases to the
canonical Port and Adapter; they contain no parallel behavior.

## 2. Provider principals

### 2.1 Canonical terms

**Provider Principal** is the authenticated identity under which access to the
GitHub provider occurs. It describes provider-facing identity only; it is not
the repository Authority, a Session Principal, or a semantic capability
authority.

| Principal               | Definition                                                                                | Current binding                                                                            | Explicit non-meaning                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **App Principal**       | A Provider Principal backed by the Inari GitHub App.                                      | The `inari-issuer` App and its installation-scoped provider access.                        | Not GitHub Authority, Session Authenticator, or semantic Executor.                               |
| **User Principal**      | A Provider Principal backed by an explicitly trusted user’s existing GitHub credential.   | The bounded local `gh auth` path used through `ProcessGhTransport`.                        | Not App execution and not a reusable Session or Delegator credential.                            |
| **Transport Principal** | An identity supplied by execution infrastructure for transport or Runtime Host admission. | Trusted execution evidence associated with a workflow, Worker, server, or other transport. | Not automatically the requester identity, a Session Principal, or semantic capability authority. |

The umbrella term **Provider Principal** is required when the identity may be
App-backed, user-backed, or another explicitly admitted provider identity.

### 2.2 GitHub Principal compatibility mapping

**GitHub Principal** is the concrete App-specific Provider Principal for the
Inari GitHub App. It is not the umbrella term for every identity that can call
GitHub. In current implementation vocabulary, `inari-issuer`,
`INARI_ISSUER_PRINCIPAL`, and related issuer identity names remain compatible
implementation/provenance names for this App Principal; they do not rename or
broaden the Provider Principal category.

Therefore:

- an App-backed GitHub read or effect is performed as an **App Principal**;
- a trusted local `gh auth` read or effect is performed as a **User Principal**;
- an Actions or other infrastructure identity is classified as a
  **Transport Principal** for transport/runtime admission unless a separate
  provider identity is explicitly established;
- authenticating as any of these principals does not make the principal the
  repository Authority or grant semantic capabilities by itself.

## 3. Credential domains

Credential names describe trust domains, not implementation formats. The four
domains are distinct and one class MUST NOT be inferred from another:

| Credential domain         | Canonical meaning                                                                                 | Allowed use                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Delegation Credential** | Long-lived Delegator key material used only to create bounded delegation or attestation.          | Signing a bounded Session certificate or governed provenance; never direct GitHub provider access.                                                           |
| **Session Credential**    | Ephemeral Session key plus Delegator-signed certificate and request proof-of-possession material. | Authenticating one bounded Agent Session request; never App installation access or further delegation.                                                       |
| **Provider Credential**   | A bounded credential used to access GitHub as a Provider Principal.                               | Provider reads or already-admitted effects within the target repository and permission ceiling.                                                              |
| **Transport Credential**  | A credential used only to enter or operate a Transport or Runtime integration.                    | Transport/runtime admission; never semantic requester identity or GitHub provider authority unless a separate Provider Credential is explicitly established. |

The compatibility name **Runtime Authority** refers to the Delegator Role in
existing API and wire contracts. It is not a Runtime Host, repository
Authority, Change state owner, or Provider Principal. The Delegator key is a
Delegation Credential and never becomes an App, User, Session, or Transport
Credential.

Agent Sessions never receive Delegation Credentials, reusable Provider
Credentials, or Transport Credentials belonging to trusted infrastructure.
Provider credentials are scoped and discarded at their existing trusted
credential boundary; the domain label does not authorize a caller to request
or retain one.

## 4. Deployment profile classification

The same semantic operation can use different provider and transport bindings.
The bindings below are classification rules, not new execution paths.

| Deployment profile        | Runtime Host / Transport                                                                                | Provider identity and credential                                                                                                                                                                                                        | Boundary rule                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Local trusted-human**   | Local Node.js process; `gh` process transport.                                                          | **User Principal** + the trusted user’s existing **Provider Credential** from `gh auth`.                                                                                                                                                | This is a valid user-backed profile; it must not be labeled App execution.                                                                                         |
| **Direct App / Worker**   | Cloudflare Worker or server; HTTPS transport.                                                           | **App Principal** + a bounded installation **Provider Credential** obtained and contained by the App Credential Broker.                                                                                                                 | Worker/runtime admission and Session authentication remain separate from App provider identity.                                                                    |
| **Actions compatibility** | GitHub Actions Runner as Runtime Host; workflow dispatch/call and bounded result artifact as Transport. | `GITHUB_TOKEN` is an Actions-provided bounded **Provider Credential** for the provider identity it authenticates. App installation key/token material used for effects is also a trusted **Provider Credential** for the App Principal. | Workflow/runtime fields and actor metadata are transport/runtime evidence; they cannot by themselves establish a semantic requester or enlarge Session capability. |

For the Actions profile specifically:

- `GITHUB_WORKFLOW_REF`, the protected `GITHUB_REF`, event information, and
  related workflow claims establish trusted-execution context only after the
  executor verifies the protected workflow boundary;
- `GITHUB_ACTOR` and `GITHUB_TRIGGERING_ACTOR` are runtime/transport metadata,
  not caller-supplied Session authority. A trusted executor may record its own
  authenticated actor as bounded provenance only after independently proving
  the protected executor context; the raw transport field does not create the
  semantic requester or capability authorization;
- `GITHUB_TOKEN` is used for bounded provider evidence reads. It is not a
  Delegation Credential, Session Credential, or transport-only credential;
- App private-key and installation-token handling remains inside the trusted
  App Principal Credential Broker boundary. No Actions workflow input or result artifact
  carries those credentials to a caller.

This preserves the distinction between the person or Agent Session that
requested an operation, the infrastructure that transported it, and the
Provider Principal that performed a bounded GitHub read or effect.

## 5. Observation Projector

The **Observation Projector** is the pure Role that converts already-bounded,
provider-normalized evidence into provider-neutral **Operational Observation**.
It performs no GitHub I/O, no transport operation, no mutation, and no
semantic policy decision.

The canonical implementation is
[`src/operational-observation.ts`](../src/operational-observation.ts):

```text
Provider Adapter / Evidence Reader
    -- bounded GitHub I/O --> provider-normalized evidence
    -- no I/O --> Observation Projector
    -- deterministic conversion --> Operational Observation
    -- separate semantic interpretation --> State Projector / Core
```

The `observeOperationalIssue` and `observeOperationalPullRequest` entrypoints
and their `tryObserve...` variants validate and normalize the evidence into
the versioned (`version: 1`) Operational Observation model. They preserve
bounded resource state, provider provenance, and collection availability while
remaining independent of GitHub transport and credentials.

The Observation Projector is distinct from the semantic **State Projector**:

- the Observation Projector describes what bounded provider evidence says;
- the State Projector interprets admissible evidence together with Canon and
  semantic contracts to derive Inari state;
- neither projector is the GitHub Authority, a credential broker, or a
  transport adapter.

Provider I/O belongs to adapters such as
[`src/github/adapter.ts`](../src/github/adapter.ts),
[`src/github/app-repository-evidence-reader.ts`](../src/github/app-repository-evidence-reader.ts),
and the bounded process/API transports. The class name
`GitHubActionsEvidenceReader` in
[`src/github/actions-change-executor.ts`](../src/github/actions-change-executor.ts)
is a compatibility/naming-debt case: the reader is reused by the deployment-
agnostic Direct App composition and its responsibility is provider evidence
acquisition, not Actions-specific semantics.

## 6. Current vocabulary map

This map records the safe classification for the current implementation. #548
applies the explicit compatibility migration for execution ports, transport
adapters, and local semantic execution profiles described above.

| Current symbol or surface                                                                              | Canonical classification                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/github/app-principal.ts`                                                                          | Canonical App Principal identity surface; issuer-named identity constants remain compatibility/provenance names.                 |
| `src/github/app-installation-credential-broker.ts`                                                     | Credential Broker containing App Principal Provider Credentials and issuing bounded provider capabilities.                       |
| `src/github/effect-authorizer.ts` / `InariEffectAuthorizer`                                            | Effect Authorizer around App Principal provider effects; it admits only already-planned effects.                                 |
| `src/github/issuer-authority.ts` / `InariIssuerAppAuthority`                                           | Compatibility module and class alias for the canonical Effect Authorizer; it is not repository Authority.                        |
| `src/github/transport.ts` / `ProcessGhTransport`                                                       | Local process Transport at the User Principal Provider Credential boundary.                                                      |
| `src/github/app-repository-evidence-reader.ts`                                                         | Provider Adapter / Evidence Reader for bounded App-backed repository evidence.                                                   |
| `src/change-execution-port.ts`                                                                         | Transport-neutral Change Port; it defines request/result contracts and normalization, not orchestration.                         |
| `src/github/actions-change-execution-adapter.ts`                                                       | Actions Transport Adapter implementing `ChangeExecutionPort`; it dispatches/polls transport and does not own semantic admission. |
| `src/agent-authority/direct-app-client.ts`                                                             | Direct-App Transport Adapter implementing `ChangeExecutionPort`; Session/App authority remains outside this adapter.             |
| `src/change-trusted-executor.ts` / `TrustedChangeExecutor`                                             | Trusted Change Executor that coordinates admitted operation effects and verifies terminal projection.                            |
| `src/github/actions-change-executor.ts` / `GitHubActionsEvidenceReader`                                | Provider Evidence Reader with a legacy Actions-specific name; not a separate semantic Executor.                                  |
| `src/semantic-issue-executor.ts`, `src/semantic-branch-executor.ts`, and `src/semantic-pr-executor.ts` | Local semantic execution profiles with explicit `LocalSemantic...Executor` names.                                                |
| `src/github/direct-app-execution.ts`                                                                   | Deployment-agnostic composition that wires existing Roles; not a new authority.                                                  |
| `.github/workflows/inari-change-executor.yml`                                                          | Actions Deployment Profile: Runner Runtime Host plus workflow Transport and trusted provider bindings.                           |
| `src/operational-observation.ts`                                                                       | Observation Projector; pure provider-evidence normalization with no GitHub I/O.                                                  |

Existing wire and provenance names remain compatible where they still carry
issuer semantics. Public contracts remain compatible through the aliases
documented above. Future renames require an explicit compatibility or
migration decision. In particular, better prose must not silently turn a User
Principal into an App Principal, a Transport Principal into a requester, a
Provider Credential into a Session Credential, or an Observation Projector into
a semantic policy engine.
Principal, a Transport Principal into a requester, a Provider Credential into
a Session Credential, or an Observation Projector into a semantic policy
engine.
