# Inari Access GitHub App profile

This is the public profile copy for Inari Access. The detailed boundary is [Inari Access: App Principal and Credential Profiles](./INARI_ISSUER_APP.md); target-versus-release status is recorded in [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md).

## App name

**Inari Access**

## Description

**Governed GitHub access for AI agents and automated runtimes.**

Inari separates intent, authorization and execution. Repository policy and Inari determine whether an operation is allowed; Inari Access provides the GitHub App identity used for the resulting authorized operation.

### Governed execution

Inari Access reads bounded repository evidence and supplies short-lived, repository-scoped installation authority inside the user-owned Executor. The admitted effect set includes governed branches and pull-request creation, ready and close operations. Agents do not receive the App private key or installation tokens.

The App is not a general-purpose agent credential, an independent policy owner, a reviewer or a merge authority. Human review, repository protection and explicit merge policy remain separate gates.

### User authorization

The target remote-access profile also uses Inari Access user authorization to authenticate a GitHub user and verify repository eligibility. Hosted uses the GitHub user credential transiently and forwards only a short-lived signed assertion to the user's Runtime, not the credential.

Repository visibility does not grant Inari mutation rights. Runtime still admits the caller and requested operation, and Executor still performs admitted effects through its own installation credential. Availability of this profile must be confirmed for the installed/deployed revision; this copy does not certify an unimplemented flow.

### Installation and ownership

Install Inari Access only on repositories where the intended Inari deployment should operate. Installation establishes the GitHub-side ceiling; Runtime policy further limits what may actually happen.

Dedicated repository Apps and explicitly shared manual Apps use the same custody and binding rules. Secrets remain with their owning component. Hosted authentication, user-owned execution, caller identity and provider identity are never interchangeable.
