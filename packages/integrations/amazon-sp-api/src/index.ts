/**
 * Amazon Selling Partner API channel library: platform-neutral and
 * **fetch-only**, no Firestore.
 *
 * What ships here: the two Login with Amazon token exchanges (`lwa.ts`), the
 * Seller Central consent URL that starts the authorization (`consentimento.ts`),
 * a read client for the North America host that serves the BR store
 * (`client.ts`, `get` only), exactly ONE write client (`escrita.ts`, `post`
 * only), the backstop poll's one list read, `searchOrders` (`pedidos.ts`,
 * step 4), the importer's one order read, `getOrder` (`pedidos.ts`, step 5),
 * the Delivery-by-Amazon NF-e status read and upload, `getInvoiceStatus` and
 * `submitInvoice` (`entrega.ts`, step 14), the Restricted Data Token mint,
 * `createRestrictedDataToken` (`tokens.ts`, step 15), the Easy Ship pickup
 * scheduling, `createScheduledPackageBulk` (`easyShip.ts`, step 15), the
 * download of the Easy Ship label document and the extraction of its one ZPL
 * label (`documentosEasyShip.ts`, step 15), the listings reads and the stock
 * patch, `getListingsItem`, `searchListingsItems` and `patchListingsItem`
 * (`listings.ts`, step 12a), the `JSON_LISTINGS_FEED` submission,
 * `createFeedDocument`, `createFeed`, `getFeed` and `getFeedDocument`, with the
 * document builder and the report parser (`feeds.ts`, step 12a), the feed
 * document upload and the report download (`documentosFeed.ts`, step 12a), the
 * per-call deadlines, the typed errors, and the wire schemas those consume.
 * Everything stateful (the credential store, the OAuth routes, the access-token
 * cache, the sweeps) is driven by the App Hosting backend `apps/amazon`, which
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
 *  - **No SigV4.** SP-API has not required AWS signing since 2023-10-02.
 *  - **Exactly one write client, `escrita.ts` (`post` and `patch`), used only
 *    by the app's write engine.** The read client's `get` takes no body by
 *    construction; the SP-API writes are `submitInvoice` (`entrega.ts`),
 *    `createRestrictedDataToken` (`tokens.ts`), `createScheduledPackageBulk`
 *    (`easyShip.ts`), `patchListingsItem` (`listings.ts`), `createFeedDocument`
 *    and `createFeed` (`feeds.ts`), and nothing writes to the provider before
 *    the cutover (D11). The other POST is the LWA token exchange.
 *  - **Two non-SP-API GETs and one PUT**: the Easy Ship label download
 *    (`documentosEasyShip.ts`), the feed report download and the feed document
 *    upload (`documentosFeed.ts`), with no credential and no observer event;
 *    each `fetch` is a required option, never the global. The download sends no
 *    header at all; the upload sends `content-type` alone.
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
 *    the step that first reads it (`searchOrders`' page schema with step 4,
 *    `getOrder`'s order with step 5). Within step 5, the order schema and
 *    `buscarPedido` land in PR 5-a, ahead of their one consumer, the importer
 *    (PR 5-d of the same stack); nothing calls `buscarPedido` until then. Step
 *    14 does the same: the write client and the Delivery helpers land in PR
 *    14-a, and nothing calls them until the app's NF-e task (PR 14-c). So does
 *    step 12a: the listings and feeds helpers land in PR 12-a, ahead of the app
 *    code that calls them.
 *  - **No `build` script.** `ci.yml`'s seven-job split relies on no `packages/*`
 *    workspace defining one.
 *
 * `transporte.ts` is internal and deliberately not re-exported, and so is the
 * request core both clients share (`prepararNucleoSpApi` / `executarSpApi` in
 * `client.ts`) with its path check and one-segment encoder (`caminhoValido` /
 * `segmentoDeCaminho`): that module's public names are listed one by one below,
 * and so are `documentosEasyShip.ts`' (its CRC-32 re-export stays internal).
 * `preAssinada.ts` (the pre-signed URL guard) and `crc32.ts` (the CRC-32 and
 * the fflate error predicate), shared by the two document modules, are
 * internal too.
 */
export * from './errors';
export * from './prazos';
export * from './types';
export {
  type ChamadaAmazon,
  criarClienteSpApi,
  type CredencialSpApi,
  MARKETPLACE_ID_BR,
  MAX_REF_CREDENCIAL,
  MAX_USER_AGENT,
  type OpcoesClienteSpApi,
  type PedidoGetSpApi,
  type RespostaSpApi,
  type ResultadoChamadaAmazon,
  type SpApiLeituraClient,
  TOKEN_REMOVIDO,
  URL_BASE_SP_API,
} from './client';
export * from './escrita';
export * from './lwa';
export * from './consentimento';
export * from './pedidos';
export * from './entrega';
export * from './easyShip';
export * from './tokens';
export {
  baixarDocumentosEasyShip,
  extrairEtiquetaZplEasyShip,
  MAX_ENTRADAS_ZIP_EASY_SHIP,
  MAX_ZIP_EASY_SHIP_BYTES,
  MAX_ZPL_EASY_SHIP_BYTES,
  type OpcoesDownloadEasyShip,
} from './documentosEasyShip';
export * from './listings';
export * from './feeds';
export * from './documentosFeed';
