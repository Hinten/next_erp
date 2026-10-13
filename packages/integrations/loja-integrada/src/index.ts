/**
 * Loja Integrada channel library: platform-neutral, **fetch-only** and
 * **GET-only**, no Firestore.
 *
 * The modules that ship here (transport, typed errors, Tastypie paging, the
 * response schemas and the token validator) are exported from this barrel as
 * they land. Everything stateful (the credential store, the connect route, the
 * sweeps) is driven by the App Hosting backend `apps/loja-integrada`, which
 * holds the Firestore/Admin-SDK dependency.
 *
 * This is the ADR-0015 shape: a channel is a LIBRARY paired with an app, not a
 * plugin implementing an ERP-orchestration contract. There is deliberately no
 * `MarketplaceChannel` here, and adding one back is the mistake ADR 0015 exists
 * to prevent. What the channel supports is declared in `MARKETPLACE_TIPO_CAPS`
 * (`@delfrance/schemas`), and
 * `packages/config-eslint/rules/removed-plugin-contracts.test.js` asserts this
 * shape.
 *
 * ## Non-goals (each one is somewhere else on purpose)
 *
 *  - **No Firestore, no Admin SDK, no `@delfrance/data`.** ADR 0015.
 *  - **No write method and no request body.** Every request is a `GET` by
 *    construction; there is no write to the provider before the cutover.
 *  - **No token store, no refresh, no OAuth.** The credential is a Personal
 *    Token supplied per call by the caller and never kept here.
 *  - **No retry, no backoff, no rate limiter.** The rate-limit error carries its
 *    scope and `Retry-After`; durable retry belongs to the app.
 *  - **No logging.** `onChamada` is the hook; the app decides what is kept.
 *  - **No body excerpt on any error.** Response text never rides an exception.
 *  - **No `process.env`.** Every value is a parameter.
 *  - **No `build` script.** `ci.yml`'s seven-job split relies on no `packages/*`
 *    workspace defining one.
 */
export * from './errors';
export * from './prazos';
export * from './types';
export * from './client';
export * from './paginacao';
export * from './api';
