/**
 * Canonical identity contract for the Inari App Principal.
 *
 * The issuer names are retained because this identity is also recorded in
 * Change publication/provenance contracts. They are not repository Authority
 * names and do not grant semantic or credential authority.
 */

export const INARI_ISSUER_APP_KIND = "github-app" as const;
export const INARI_ISSUER_APP_SLUG = "inari-issuer" as const;
export const INARI_ISSUER_PRINCIPAL = "app:inari-issuer" as const;

/** Canonical App Principal names; issuer constants remain compatibility names. */
export const INARI_APP_PRINCIPAL_KIND = INARI_ISSUER_APP_KIND;
export const INARI_APP_PRINCIPAL_SLUG = INARI_ISSUER_APP_SLUG;
export const INARI_APP_PRINCIPAL = INARI_ISSUER_PRINCIPAL;

export type InariIssuerPrincipal = typeof INARI_ISSUER_PRINCIPAL;
export type InariAppPrincipal = typeof INARI_APP_PRINCIPAL;

export function isTrustedInariIssuerPrincipal(value: unknown): value is InariIssuerPrincipal {
  return value === INARI_ISSUER_PRINCIPAL;
}

export function isTrustedInariAppPrincipal(value: unknown): value is InariAppPrincipal {
  return value === INARI_APP_PRINCIPAL;
}
