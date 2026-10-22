/**
 * Amazon Selling Partner API channel library: platform-neutral and
 * **fetch-only**, no Firestore.
 *
 * What ships here: the two Login with Amazon token exchanges (`lwa.ts`), the
 * Seller Central consent URL that starts the authorization (`consentimento.ts`),
 * a GET-only SP-API client for the North America host that serves the BR store
 * (`client.ts`), the backstop poll's one list read, `searchOrders`
 * (`pedidos.ts`, step 4), the per-call deadlines, the typed errors, and the wire
 * schemas those consume. Everything stateful (the credential store, the OAuth routes,
 * the access-token cache, the sweeps) is driven by the App Hosting backend
 * `apps/amazon`, which holds the Firestore/Admin-SDK dependency.
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
 *  - **No SigV4.** SP-API has not required AWS signing since 2023-10-02.
 *  - **No SP-API write method and no request body.** Every SP-API request is a
 *    `GET` by construction; there is no write to the provider before the
 *    cutover. The only POST is the LWA token exchange.
 *  - **No OAuth route, no credential store, no token cache.** The access token
 *    is supplied per call by the caller and never kept here.
 *  - **No `client_credentials` (grantless) grant yet.** No pre-cutover step
 *    calls a grantless operation from code (`createDestination` /
 *    `createSubscription` are a manual action, master plan §4.26); the first
 *    planned consumer is P2's secret rotation, and it arrives with that step.
 *  - **No retry, no backoff, no rate limiter.** The rate-limit error carries
 *    `x-amzn-RateLimit-Limit` when Amazon sent it; durable retry belongs to the
 *    app.
 *  - **No logging.** `onChamada` is the hook; the app decides what is kept.
 *  - **No body excerpt on any error.** Response text never rides an exception.
 *  - **No `process.env`.** Every value is a parameter.
 *  - **No resource schema before its consumer.** Each operation's arrives with
 *    the step that first reads it (`searchOrders`' page schema with step 4).
 *  - **No `build` script.** `ci.yml`'s seven-job split relies on no `packages/*`
 *    workspace defining one.
 *
 * `transporte.ts` is internal and deliberately not re-exported.
 */
export * from './errors';
export * from './prazos';
export * from './types';
export * from './client';
export * from './lwa';
export * from './consentimento';
export * from './pedidos';
