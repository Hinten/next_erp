/**
 * Loja Integrada channel library: platform-neutral, **fetch-only**, no
 * Firestore. A **GET-only read client** and, apart from it, a **write client**
 * that is the package's only writer.
 *
 * The modules that ship here (transport, typed errors, Tastypie paging, the
 * response schemas, the token validator, the order import's reads, the status
 * write-back's two writes and the four catalogue reads — categories, brands,
 * grades and one grade's options) are exported from this barrel as they land.
 * Everything stateful (the credential store, the connect route, the sweeps and
 * the write engine) is driven by the App Hosting backend `apps/loja-integrada`
 * and its functions, which hold the Firestore/Admin-SDK dependency.
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
 *  - **No write method on the read client, and no body on any read.** Every
 *    request `criarClienteLeituraLi` makes is a `GET` by construction.
 *    `escrita.ts` is the only writer, and every `PUT` it can send is held to
 *    the write routes (`rotasEscrita.ts`): two paths, each with one strict body,
 *    so no write can carry a codigo outside the three write-back situações or
 *    clear a tracking code. `pedidosEscrita.ts` holds the two operations. The
 *    app's write engine (master-plan step 7) is their only caller there, behind
 *    the write valves, and a name-keyed guard in the app enforces it.
 *  - **No decision about a write.** Whether one is due, safe or already
 *    reflected is the app's, from a fresh read made just before it.
 *  - **No token store, no refresh, no OAuth.** The credential is a Personal
 *    Token supplied per call by the caller and never kept here.
 *  - **No retry, no backoff, no rate limiter.** The rate-limit error carries its
 *    scope and `Retry-After`; durable retry belongs to the app.
 *  - **No logging.** `onChamada` is the hook; the app decides what is kept.
 *  - **No body excerpt on any error.** Response text never rides an exception.
 *  - **No `process.env`.** Every value is a parameter.
 *  - **No `build` script.** `ci.yml`'s seven-job split relies on no `packages/*`
 *    workspace defining one.
 *
 * ⚠️ `client.ts` is exported NAME BY NAME, not with `export *`: it also holds
 * the shared request core (`executarLi`), which `escrita.ts` builds on and which
 * stays out of reach — a caller holding it could send a `PUT` without the
 * write client. A new public export of `client.ts` is added here by hand. The
 * manifest's `exports` map publishes this barrel alone, so a deep import of
 * `src/client` does not resolve either.
 */
export * from './errors';
export * from './prazos';
export * from './types';
export {
  type ChamadaLi,
  type CredencialLi,
  criarClienteLeituraLi,
  type LiLeituraClient,
  MAX_REF_CREDENCIAL,
  type OpcoesClienteLi,
  type PedidoGetLi,
  type RespostaLi,
  type ResultadoChamadaLi,
  TOKEN_REMOVIDO,
  URL_BASE_LI,
} from './client';
export * from './escrita';
export * from './paginacao';
export * from './api';
export * from './pedidoTipos';
export * from './pedidos';
export * from './pedidosEscrita';
export * from './catalogo';
