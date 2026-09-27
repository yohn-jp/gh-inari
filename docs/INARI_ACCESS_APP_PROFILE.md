# Inari Access GitHub App Profile

Canonical public profile copy for the Inari GitHub App. Detailed contracts are
in [Inari Access](./INARI_ISSUER_APP.md).

## App name

**Inari Access**

## Description

**Governed GitHub access for AI agents and automated runtimes.**

Inari Access supplies the GitHub identity used by Inari for explicitly
authorized repository operations without giving agents reusable GitHub
credentials.

## What it does

Inari separates intent, caller authentication, authorization, and execution.
Repository policy and Inari determine permission. Inari Access supplies the
bounded provider identity for the admitted operation.

The App supports repository evidence reads and authorized branch/pull-request
publication lifecycle. Installation is the GitHub-side permission ceiling,
not a grant for every caller to exercise it.

## Credential boundaries

App private keys and installation credentials stay inside the user-owned
Executor. Agents do not receive them.

The approved remote target uses this App's user authorization profile at
Hosted. Hosted verifies caller and repository eligibility transiently and
relays a signed bounded assertion, not the user token. User authentication
and installation execution retain separate credential custody.

This target must be implemented and certified before advertised as deployed
capability. It does not introduce a separate Identity App or Hosted provider
execution service.

## Independent review

The initial App effect profile does not approve or merge PRs. Human review,
repository protection, and merge policy remain independent. Commit authorship
is distinct from App proposal publication.

## Why install it?

Install Inari Access on repositories where Inari should perform governed
operations. A dedicated App separates App-key custody per repository;
explicit manual/shared App use remains supported through the same verified
binding model without per-repository key copies.
