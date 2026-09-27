---
name: inari
description: |
  Route governed GitHub Issue, pull request, template, and Change work to
  Inari's canonical contracts and installed guidance, subject to repository
  execution policy. Use when authoring or inspecting governed artifacts.
---

# Inari

Inari (`inari`, from the `gh-inari` package) exposes deterministic repository
contracts and bounded governed operations. `gh-inari` is the same public
executable's npm alias, not a separate execution engine.

## Start with repository authority

Read the repository's AGENTS and applicable execution policy first. An active
restriction or suspension of Inari invocation takes precedence over the
operational examples here. This Skill never grants permission to bypass it.

For this repository, [Product Architecture Canon](../../docs/ARCHITECTURE.md)
owns the target and [Implementation Contract](../../docs/IMPLEMENTATION_CONTRACT.md)
owns bounded task/Source relationships. Architecture changes require explicit
owner/design-review approval; implementation choices stay within the accepted
contract.

## Route to current guidance

When repository policy permits Inari invocation, use installed `inari skill`
and `inari skill <scenario>` for the versioned operational playbook, and
`inari <domain> --help` for exact current grammar. Do not copy a static
subcommand list, invent flags, or assume the latest target is implemented in
an older package.

Relevant workflows include governed artifact schema/validation/rendering,
creation, bounded observation/discovery, semantics-preserving reconciliation,
native relationship handling, and template synchronization.

An ordinary Issue describes intent/outcome. An Implementation separately owns
task scope, base/branch, dependencies, verification, and authorization.
Source Change, task, Session, leaf PR, and integration PR are not one identity.

## Preserve boundaries

Interfaces use the same Core and admitted owner ports. Hosted authenticates
and relays, not a second semantic/provider engine. Remote access gives no
shell, raw provider proxy, user-token forwarding, or automatic App write grant.

Do not manufacture a capability for a read, infer parentage from branch names,
weaken protected paths, or report provider/transport success as verified
semantic completion. Use the canonical bounded diagnostic/recovery result.

## End at the requested lifecycle

Read-only audit/review does not authorize edits. PR publication does not
authorize merge or Issue closure. Report exact candidate and executed checks;
pending, stale, blocked, and not-run evidence are not pass.
