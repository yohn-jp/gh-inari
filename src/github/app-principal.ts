/**
 * Canonical App Principal identity surface.
 *
 * Provider-facing identity is distinct from repository Authority, Session
 * Principal, Delegator, and the Effect Authorizer. Issuer-named constants and
 * provenance fields remain available through the underlying compatibility
 * contract.
 */
export {
  INARI_APP_PRINCIPAL,
  INARI_APP_PRINCIPAL_KIND,
  INARI_APP_PRINCIPAL_SLUG,
  INARI_ISSUER_APP_KIND,
  INARI_ISSUER_APP_SLUG,
  INARI_ISSUER_PRINCIPAL,
  isTrustedInariAppPrincipal,
  isTrustedInariIssuerPrincipal,
  type InariAppPrincipal,
  type InariIssuerPrincipal,
} from "../issuer-identity.js";

export {
  createAppPrincipal,
  createInariAppPrincipalIdentity,
  createInariIssuerAppIdentity,
  validateAppPrincipalIdentity,
  validateInariAppPrincipalIdentity,
  validateInariIssuerAppIdentity,
} from "./effect-authorizer.js";
export type {
  AppPrincipal,
  AppPrincipalIdentity,
  InariAppPrincipalIdentity,
  InariIssuerAppIdentity,
} from "./effect-authorizer.js";
