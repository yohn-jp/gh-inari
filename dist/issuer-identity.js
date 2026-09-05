/**
 * Canonical identity contract for the Inari issuer App.
 *
 * This module is deliberately transport-neutral. The issuer authority owns
 * the capability and credential boundary; Core and that authority consume
 * this one identity contract rather than defining issuer strings separately.
 */
export const INARI_ISSUER_APP_KIND = "github-app";
export const INARI_ISSUER_APP_SLUG = "inari-issuer";
export const INARI_ISSUER_PRINCIPAL = "app:inari-issuer";
export function isTrustedInariIssuerPrincipal(value) {
    return value === INARI_ISSUER_PRINCIPAL;
}
//# sourceMappingURL=issuer-identity.js.map