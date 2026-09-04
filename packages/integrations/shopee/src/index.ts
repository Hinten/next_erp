/**
 * Shopee channel library — platform-neutral, **fetch-only**, no Firestore.
 *
 * The request signature (`sign.ts`), the hosts (`hosts.ts`), the consent URL and
 * the two token endpoints (`oauth.ts`), the two typed clients (`api.ts`), the
 * wire schemas (`types.ts`) and the error taxonomy with its code classification
 * (`errors.ts`) ship here. Everything stateful — the token store, the OAuth
 * state attempts, the push receiver, the expiry sweep — is driven by the App
 * Hosting backend `apps/shopee`, which holds the Firestore/Admin-SDK dependency.
 *
 * This is the ADR-0015 shape: a channel is a LIBRARY paired with an app, not a
 * plugin implementing an ERP-orchestration contract. ⚠️ There is deliberately no
 * `MarketplaceChannel` here and adding one back is the mistake ADR 0015 exists
 * to prevent — `packages/integrations/shopee` was one of the five throw-only
 * scaffolds deleted with that contract in #815, and it is back only because it
 * now describes Shopee's WIRE PROTOCOL and nothing about this ERP. What Shopee
 * supports is declared in `MARKETPLACE_TIPO_CAPS` (`@delfrance/schemas`), and
 * `packages/config-eslint/rules/removed-plugin-contracts.test.js` asserts this
 * shape.
 *
 * ## Non-goals — each one is somewhere else on purpose
 *
 *  - **No Firestore, no Admin SDK, no `@delfrance/data`.** ADR 0015.
 *  - **No token store, no refresh scheduling, no lease.** `refreshAccessToken`
 *    is a pure wire call; persisting the rotation, serialising it per id class,
 *    and the weekly authorization-expiry sweep are step 2.
 *  - **No proxy and no `undici`.** `fetch` is injected on every config, so
 *    `apps/shopee` can compose a static-egress fetch when the IP whitelist
 *    lands (P2 of the master plan).
 *  - **No retry, no backoff.** `ShopeeRateLimitError` carries `kind` and
 *    `retryAfterSeconds`; durable retry is the Cloud Tasks pipeline.
 *  - **No merchant flows** beyond `merchantBaseString` existing.
 *  - **No push/webhook signature verification.** That is a DIFFERENT base string
 *    (with a `|` separator, over `callback_url` + raw body) and belongs with the
 *    receiver in step 3.
 *  - **No `process.env`.** Every value is a parameter; `apps/shopee/lib/shopee/env.ts`
 *    is the one place the environment is read.
 *  - **No `build` script.** `ci.yml`'s seven-job split relies on no `packages/*`
 *    workspace defining one.
 *
 * ⚠️ `call.ts` is internal and deliberately NOT re-exported: it is the shared
 * transport `oauth.ts` and `api.ts` are both built on, not a public surface.
 */

export * from './errors';
export * from './types';
export * from './hosts';
export * from './sign';
export * from './oauth';
export * from './api';
