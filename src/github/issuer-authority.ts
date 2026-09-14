/**
 * @deprecated The App-side mutation boundary is the Effect Authorizer.
 *
 * This module remains as a source-compatible path for existing consumers.
 * There is one implementation in `effect-authorizer.ts`; all exports below
 * are aliases/re-exports and do not create a second authorization path.
 */
export * from "./effect-authorizer.js";
