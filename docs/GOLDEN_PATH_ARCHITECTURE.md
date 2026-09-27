# Inari Golden Path Composition

Status: normative composition under [Product Architecture Canon](./ARCHITECTURE.md). A Golden Path is an end-to-end product contract, not a separate command, workflow engine, authorization system or state store.

## 1. Common goal

A caller discovers the repository contract, submits only permitted semantic intent, obtains admitted task/operation context, performs a governed operation and receives a verified result or a bounded next action. Local and remote paths differ at authentication/transport, not at semantic execution.

The lifecycle summary is Issue → Change → PR → Merge. It does not collapse Source, Implementation, Session, leaf publication and integration into one identity. See [Implementation Contract](./IMPLEMENTATION_CONTRACT.md) and [Change Control Plane](./CHANGE_CONTROL_PLANE.md).

## 2. Repository connection

```text
resolve immutable repository
  -> register/adopt secret-free context
  -> prepare dedicated App or select explicit manual existing App
  -> Executor-owned Manifest conversion/enrollment
  -> human installation consent
  -> verify App/installation/repository and bind at Executor
  -> Authority creation or exact-identity adoption
  -> publish public trust record through governed operator path
  -> human review/merge
  -> reread protected trust
  -> observe Admission, Runtime and repository readiness
```

App creation, enrollment, installation, publication, trust and readiness are different facts. Setup never silently regenerates a trusted key or widens a capability ceiling. A healthy process is not a connected/authorized repository.

Stages are projected from owner evidence and the bounded operation journal. Restart recomputes the next action; it does not trust a browser's completed-step flag or repeat an uncertain external effect.

## 3. Local delegated work

Resolve the current Source/Implementation contract and exact integration route, obtain current task authorization, and issue/admit the local Session through existing owner boundaries. Source lifecycle operations bind the selected Source; leaf publication and branch advance bind the Implementation.

Prepare and execute through the shared Core/Admission/Executor pipeline. Report reviewability only after the canonical ready postcondition. Independent CI, review, approval and explicit merge remain separate gates. Completion at the leaf does not imply Source/Epic closure.

## 4. Remote human-operated work

```text
user-owned Runtime establishes authenticated Relay connection
  -> confirmed stable public relay URL is supplied to the client
  -> client authenticates through Inari Access OAuth at Hosted
  -> Hosted verifies user + repository/App-installation eligibility
  -> short-lived request-bound assertion; user credential discarded
  -> Relay delivers to that Runtime
  -> Runtime verifies assertion and current Executor binding
  -> Runtime admits the subject and requested semantic operation
  -> same Executor/Core/effect/reread path as local
```

The cloud client needs neither a Runtime Authority private key nor a new Session-key issuance protocol. It also gains no arbitrary shell, filesystem, network proxy or operator-admin access. Repository visibility and knowledge of a URL do not grant mutation authority.

An offline Runtime returns transport unavailability. Hosted does not fall back to direct GitHub reads/effects or another repository's connection. Authentication renewal does not replay an uncertain mutation.

## 5. Setup and operator interfaces

One machine Console serves independent repository contexts. CLI and UI consume the same Setup/Control action metadata and state. Remote UI, when supplied, is only another presentation client; operator enrollment and destructive operations require their existing explicit authorization.

Configuration, component health, provider binding, repository trust, Session readiness, Session lifecycle, Relay reachability and execution outcomes remain independently observable. A summary may aggregate them without discarding their evidence or freshness.

## 6. Recovery and exit conditions

Success requires verified owner/provider postconditions. Before a retry, acquire fresh authoritative evidence and classify the action as no-op, safe remaining effect, explicit compensation, human action or recovery-required.

Wrong repository/App/Source/task, stale generation, missing authority and unknown effect outcomes are bounded results, not generic success or an invitation to use raw GitHub commands. Cleanup preserves advanced branches, shared credentials and unrelated repository state.

Disconnect first prevents new relevant work, then resolves active Sessions, detaches bindings and performs only explicitly selected cleanup. Rotation verifies the candidate before switching and retiring old access.

## 7. Certification

A public path is proven through the installed package and actual intended ingress. Helper-created ready/trust/connected fixtures cannot prove onboarding. Browser claims require the actual browser; live deployment claims require the actual deployment/provider.

Prove clean setup, exact-identity adoption, resume, two-repository isolation, alternative branch policy, Source/task separation, denied operations, expiry/replay, response loss, reconnect, rotation and interrupted disconnect. Local and Hosted proof must demonstrate common semantic execution rather than separate success stubs.

Source, package, process/browser, controlled-provider and live-provider results remain separately reported. An unexecuted or environment-blocked step is not passed. See [Verification Architecture](./VERIFICATION_ARCHITECTURE.md).

## 8. Baseline and migration

At the observed baseline, Local Source-bound Session composition exists, while Hosted assertions, relay-locator routing and unified multi-repository operator completion require further work. This document does not close those tasks or certify an unchanged release. The implementation sequence and retirement gates are recorded in [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md).
