/**
 * Mercado Livre channel library — platform-neutral (fetch-only, no Firestore).
 *
 * The OAuth core (`oauth.ts`), the typed REST client (`api.ts`, 62 operations),
 * the error taxonomy (`errors.ts`), the payload schemas (`types.ts`) and the pure
 * ML↔ERP mappers ship here. Token persistence, refresh and every stateful flow
 * are driven by the App Hosting backend (`apps/mercado-livre`), which holds the
 * Firestore/Admin-SDK dependency. Webhook receivers live there too.
 *
 * ⚠️ **There is no `createMercadoLivreChannel` any more (#815).** It returned a
 * `MarketplaceChannel` whose `syncProducts`, `pullOrders`, `pushTracking` and
 * `oauthFlow.callback` all threw — not because the integration was incomplete,
 * but because each of those needs Firestore and so could never live behind a
 * contract in `packages/core`. Of the ~25 members it declared, exactly one was
 * ever called through the object: `oauthFlow.start`, a one-line wrapper around
 * `buildAuthorizeUrl` (`./oauth`). Callers reach that function directly now.
 *
 * What a channel IS, is declared in `MARKETPLACE_TIPO_CAPS`
 * (`@delfrance/schemas`); its shared data shapes live in
 * `@delfrance/core/marketplace`. See ADR 0015 and the `marketplace-integration`
 * skill.
 */

export * from './errors';
export * from './types';
// ⚠️ No numeric coercer is exported here any more. The rule that reads a quoted
// provider number lives in `@delfrance/core/wire` (`parseWireDecimal`,
// `wireNumber()`, `wireInt()`) — Mercado Pago hit the identical exposure on the
// SAME payment resource through `GET /v1/payments/{id}` (#1251), so a per-channel
// copy was always going to drift (#810). Import it from core directly.
export * from './shipmentFields';
export * from './oauth';
export * from './api';
export * from './incidents';
export * from './incidentRespond';
export * from './mapping/attributes';
export * from './mapping/itemPayload';
export * from './mapping/importItem';
export * from './mapping/importVariations';
export * from './mapping/localId';
export * from './mapping/importUserProduct';
export * from './mapping/pictures';
export * from './zplDanfeFilter';
// AI attribute suggestion — pure logic only. No AI SDK is imported anywhere in
// this package: the schema is a plain JSON Schema and the prompt a plain
// object, so whichever runtime A2 settles on consumes them unchanged.
export * from './ai/attributeSchema';
export * from './ai/attributePrompt';
export * from './ai/attributeApply';
export * from './ai/medidasSchema';
export * from './ai/medidasReference';
export * from './ai/medidasPrompt';
export * from './ai/medidasApply';
