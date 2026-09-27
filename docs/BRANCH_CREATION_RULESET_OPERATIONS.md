# Branch and Trust Ruleset Operations

Status: operator guide subordinate to [Product Architecture Canon](./ARCHITECTURE.md), [Repository Branch Policy](./REPOSITORY_BRANCH_POLICY.md) and [Authorization](./AGENT_CAPABILITY_AUTHORIZATION.md).

## 1. Separate policy layers

Inari derives and validates governed naming/routing. GitHub repository settings enforce branch/PR protection. App permissions establish a provider ceiling. Runtime admission establishes the narrower allowed operation. No one layer replaces the others.

A document, generated policy file, valid branch name or passing source test does not prove a live Ruleset is active. Re-read current repository settings and exact required-check behavior before any operational change.

## 2. Branch creation boundary

Configure only the approved repository's governed branch scope and provider identities. Preserve ordinary, integration, release and trust branches according to their canonical roles. Do not derive repository-wide authority from a generic prefix or use a Ruleset bypass to make unsupported execution appear successful.

The Inari Access App is the provider identity for admitted normal effects, not a human reviewer or repository administrator. Delegated Sessions and Hosted assertions cannot alter protection settings. Any operational App bypass, if required by an approved protection contract, must be explicit and narrower than review/trust-root safeguards.

## 3. Trust-root boundary

Current public Authority records live under `.github/inari/authorities/**`. Trust changes require the canonical validation check and independent human review through the protected-ref workflow. App execution, a delegation key and remote caller authentication must not self-approve or bypass that trust boundary.

Keep ordinary repository work outside an overbroad trust-path condition. First registration, overlap rotation and revocation follow the existing validator semantics; a permissive settings change is not a repair for invalid trust data.

## 4. Operational sequence

Read the live inventory and record exact repository/ruleset/check identities. Validate the intended change and rollback state. Apply only explicitly authorized settings changes, then exercise a safe representative permitted case and a denied case. Re-read the resulting provider configuration and retain secret-free evidence.

Do not claim administration changes were performed when the current tool or credential cannot read/write the required setting. Report that operational boundary as unverified/blocked without substituting source code or historical settings as proof.

## 5. Completion and campaign limits

Live enforcement, product validation, package certification and release adoption are different outcomes. Each operational Issue closes only against its own exact evidence and authorization.

Publishing the architecture documents does not authorize Ruleset changes, App permission changes, approvals, merges, releases or Issue closure. The present campaign's Issue audit is read-only; any later operational execution requires its explicit approved scope.
