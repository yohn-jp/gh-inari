# Inari Access GitHub App profile

This document is the canonical public profile copy for the Inari GitHub App.

## App name

**Inari Access**

## Description

**Governed GitHub access for AI agents and automated runtimes.**

Inari Access is the GitHub App used by Inari to perform explicitly authorized
repository operations without giving agents or runtimes a reusable GitHub
credential.

### What it does

Inari separates **intent**, **authorization**, and **execution**. Repository
policy and Inari determine which operation is allowed; Inari Access provides
the GitHub identity used to perform the resulting authorized operation.

The App is used to:

- read repository evidence required for authorization;
- obtain short-lived, repository-scoped GitHub credentials inside Inari's
  trusted runtime;
- create and delete governed branches;
- create, mark ready, or close governed pull requests; and
- apply only the GitHub permissions required for the authorized operation.

### Security model

Inari Access is deliberately not a general-purpose GitHub credential for an
agent.

Credentials are scoped to the selected repository and operation, remain
inside the trusted credential boundary, and are discarded after use. Agents
do not receive the App private key or installation access tokens.

The App does not approve reviews or merge pull requests. Human review,
repository protection, and merge policy remain independent authorization
boundaries.

### Why install it?

Install Inari Access on repositories where Inari should be able to execute
governed GitHub operations. Installation defines the GitHub-side permission
ceiling; Inari's own authorization model further constrains which operations
may actually be performed.

For the implementation and trust-boundary contract, see
[Inari App Principal and Effect Authorizer](./INARI_ISSUER_APP.md).
