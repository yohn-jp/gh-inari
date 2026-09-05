/**
 * Canonical identity contract for the Inari issuer App.
 *
 * This module is deliberately transport-neutral. The issuer authority owns
 * the capability and credential boundary; Core and that authority consume
 * this one identity contract rather than defining issuer strings separately.
 */
export declare const INARI_ISSUER_APP_KIND: "github-app";
export declare const INARI_ISSUER_APP_SLUG: "inari-issuer";
export declare const INARI_ISSUER_PRINCIPAL: "app:inari-issuer";
export type InariIssuerPrincipal = typeof INARI_ISSUER_PRINCIPAL;
export declare function isTrustedInariIssuerPrincipal(value: unknown): value is InariIssuerPrincipal;
