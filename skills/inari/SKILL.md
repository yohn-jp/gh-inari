---
name: inari
description: |
  Governed GitHub Issue, pull request, Change, and template workflows through
  Inari's canonical contracts. Use for bounded repository-governance work when
  the active repository policy permits Inari command use.
---

# Inari

Inari (`inari`, distributed as `gh-inari`) exposes deterministic repository-governance contracts. This file is a thin router, not another command catalog or architecture authority.

## Authority

Read the repository's active AGENTS/governance and accepted task first. A product command's availability does not override a suspension or lifecycle restriction. Do not invoke Inari when the repository forbids it.

The [Product Architecture Canon](../../docs/ARCHITECTURE.md) and [Implementation Contract](../../docs/IMPLEMENTATION_CONTRACT.md) define the target and task boundaries. Architecture changes require owner approval; operational help cannot authorize a different identity, credential or execution model.

An ordinary Issue records intent. Implementation records bounded task scope and current authorization. Source Change identity, Implementation Session task and PR integration target are distinct; do not reconstruct them from branch names or a Source-list position.

## Operational routing

When command use is permitted, use the installed version's `inari skill` and `inari skill <scenario>` for the relevant versioned playbook, and domain `--help` for exact syntax. Do not duplicate leaf flags or invent commands from target-architecture diagrams.

Use canonical semantic input, validation and rendering for governed artifacts. Use native provider relationships through the authorized workflow; historical Parent prose does not authorize reparenting. No raw GitHub fallback may bypass a denied semantic operation.

## Completion

Execute only the authorized lifecycle. Record actual focused/full/CI evidence and keep unavailable checks explicit. Publishing a PR is not permission to review, approve, merge, close Issues or release. A documented target is not proof that the installed release implements it.
