'use client';

/**
 * `useShopeeClient()` — a memoized typed client bound to the current Firebase
 * auth state, talking to the `apps/shopee` marketplace routes on their own App
 * Hosting backend. Mirrors `useMercadoPagoClient` (`lib/mercado-pago/client.ts`):
 * returns `null` while logged out so components can disable their buttons, and
 * passes `() => user.getIdToken()` so token refreshes propagate.
 *
 * The client is defined here and not in `@delfrance/integrations-shopee` on
 * purpose: that package signs every request with the partner key, which must
 * never be bundled into a browser. The browser never sees a Shopee access or
 * refresh token — it reads the connection STATUS, mints a consent URL, since
 * step 15 fetches a pedido's shipping LABEL, since step 17 reads a return's
 * live state and runs one seller action on it, and since step 18 browses a
 * conta's category tree, its item bands and its size-chart templates (four
 * reads, for the `/medidas` Shopee tab). Since step 21 it also runs the three
 * on-demand pushes (stock, price, pause/reactivate), publishes and re-verifies
 * ONE listing, and starts / polls / cancels the two account-wide jobs (the mass
 * import and the price update), each named exactly like the
 * `lib/mercado-livre/client.ts` method doing the same job, so a shared component
 * types against either client structurally. Since #1911 it creates, edits and
 * discards a listing DRAFT through the draft routes, reads three more taxonomy
 * answers for the draft editor — the item bands WHOLE (`limitesDoItem`, beside
 * `limites`' size-chart slice), Shopee's category suggestion and a leaf
 * category's attribute tree (`atributos`, P13) — pages a category's brands for
 * a conta's Marcas section (`marcas`), and reads a leaf category's standardised
 * variation tree for a grupo's Shopee tab (`variacoes`).
 * Every method of {@link ShopeeClient} — thirty today; re-count the
 * interface, never bump this number — is answered by `apps/shopee` over an
 * authenticated cross-origin call (its `proxy.ts` allows exactly
 * `/api/marketplace/*`).
 *
 * ⚠️ This client retries NOTHING. Whether a failed READ is re-attempted is the
 * query's decision (`shopeeQueryRetry`, `./erros.ts`), and that predicate never
 * repeats a 502: a Shopee rate limit reaches the browser as a 502 carrying
 * `kind`, and the size-chart list fans out one detail read per template.
 *
 * ⚠️ The three error classes carry a `Client` infix. `@delfrance/integrations-shopee`
 * already exports `ShopeeHttpError` and `ShopeeNetworkError` for Shopee's own
 * wire, and those names mean something different — a failure talking to SHOPEE,
 * not to our backend. Two classes with one name in one repo is a narrowing bug
 * waiting to happen.
 */
import { useMemo } from 'react';
import type { z } from 'zod';
import type {
  AcaoStatusAnuncio,
  AtributoShopeeRequisicao,
  CamposRascunhoShopee,
  corpoAtualizarRascunhoShopeeSchema,
  corpoCriarRascunhoShopeeSchema,
  corpoDescartarRascunhoShopeeSchema,
  importacaoShopeeOptionsSchema,
  MarcaRascunhoShopee,
} from '@delfrance/schemas';

import { envelopeDeErro, lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { useAuth } from '@/lib/auth/useAuth';
import { filenameFromDisposition } from '@/lib/http/filenameFromDisposition';

import {
  ACAO_RECLAMACAO_SHOPEE,
  DETALHES_ERRO_SHOPEE_VAZIOS,
  anuncioStatusShopeeSchema,
  canceladoShopeeSchema,
  detalheTabelaMedidasDtoSchema,
  detalhesErroShopeeSchema,
  envioEstoqueManualShopeeSchema,
  envioPrecoManualShopeeSchema,
  jobIdShopeeSchema,
  listaTabelasMedidasDtoSchema,
  massImportStatusShopeeSchema,
  oauthStartResponseSchema,
  priceSyncHistoricoShopeeSchema,
  priceSyncRelatorioPaginaShopeeSchema,
  priceSyncStatusShopeeSchema,
  respostaAtributosShopeeSchema,
  respostaAtualizarRascunhoShopeeSchema,
  respostaCategoriasShopeeSchema,
  respostaCriarRascunhoShopeeSchema,
  respostaDescartarRascunhoShopeeSchema,
  respostaLimitesDoItemShopeeSchema,
  respostaLimitesShopeeSchema,
  respostaMarcasShopeeSchema,
  respostaPublicarShopeeSchema,
  respostaRecomendacaoCategoriaShopeeSchema,
  respostaReverificarShopeeSchema,
  respostaVariacoesShopeeSchema,
  shopeeContaStatusSchema,
  shopeeEtiquetaPendenteSchema,
  shopeeReclamacaoAcaoRespostaSchema,
  shopeeReclamacaoEstadoSchema,
  type AnuncioStatusShopee,
  type CanceladoShopee,
  type DetalheTabelaMedidasDto,
  type DetalhesErroShopee,
  type EnvioEstoqueManualShopee,
  type EnvioPrecoManualShopee,
  type EscolhaDeEnvio,
  type JobIdShopee,
  type ListaTabelasMedidasDto,
  type MassImportStatusShopee,
  type PriceSyncHistoricoShopee,
  type PriceSyncRelatorioPaginaShopee,
  type PriceSyncStatusShopee,
  type RespostaAtributosShopee,
  type RespostaAtualizarRascunhoShopee,
  type RespostaCategoriasShopee,
  type RespostaCriarRascunhoShopee,
  type RespostaDescartarRascunhoShopee,
  type RespostaLimitesDoItemShopee,
  type RespostaLimitesShopee,
  type RespostaMarcasShopee,
  type RespostaPublicarShopee,
  type RespostaRecomendacaoCategoriaShopee,
  type RespostaReverificarShopee,
  type RespostaVariacoesShopee,
  type ShopeeContaStatus,
  type ShopeeEtiquetaPendente,
  type ShopeeOauthStart,
  type ShopeeReclamacaoAcaoResposta,
  type ShopeeReclamacaoEstado,
  type SolucaoDevolucaoShopee,
} from './wire';

const DEFAULT_SHOPEE_URL = 'http://localhost:3009';

/** Non-2xx response from the `apps/shopee` backend. */
export class ShopeeClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine code from the backend (`SHOPEE_NETWORK_ERROR`, `SHOPEE_BAD_RESPONSE`, …). */
    readonly code: string | null,
    /**
     * SHOPEE's own error code, when a label refusal carries one (the
     * `recusa-desconhecida` 409's optional `shopeeCode`) — for a caller or a
     * console that wants it on a support screenshot. `message` stays the
     * backend's sentence either way; `null` whenever the body has none.
     */
    readonly shopeeCode: string | null = null,
    /**
     * The backend's classification of a SHOPEE failure (`kind` on the
     * `SHOPEE_HTTP_ERROR` 502 body): `burst` / `daily` are Shopee's rate
     * limits, `transient` its own hiccup, `reauth`, `other`. A FREE string —
     * a kind a newer backend adds must not cost the error — and `null`
     * whenever the body has none, which is every non-Shopee failure.
     *
     * ⚠️ Read it, never the status: a rate limit and a malformed request are
     * BOTH a 502, and only `kind` tells "wait" from "this will never work".
     */
    readonly kind: string | null = null,
    /**
     * The extras the error body carried beyond `{ error, code }` — the pause's
     * `pausadoAte`, an oversize selection's `limite`/`solicitados`, a publish
     * refusal's `problemas` (each with its `acao`), the running job's `jobId`,
     * … — each read tolerantly (`detalhesErroShopeeSchema`): a key the body
     * lacks, or carries malformed, is `null` here and never costs the error.
     *
     * ⚠️ The ONE place these live. There are no top-level `jobId` / `pausadoAte`
     * fields on this class — a caller reads `err.detalhes.jobId`.
     */
    readonly detalhes: DetalhesErroShopee = DETALHES_ERRO_SHOPEE_VAZIOS,
  ) {
    super(message);
    this.name = 'ShopeeClientHttpError';
  }
}

/**
 * The backend answered 2xx and the body was not the shape this app claims — the
 * wrong fields, no body at all, or not JSON.
 *
 * ⚠️ Nothing here describes what WE send: it is a browser-side `Error` that
 * never leaves the tab, and `status` records the 2xx the backend sent US. That
 * combination — transport fine, payload unusable — is exactly what a
 * `return parsed as T` used to report as a success (#1295 → #1302).
 *
 * ⚠️ A SUBCLASS of {@link ShopeeClientHttpError}, matching both siblings for the
 * same reason: catch sites narrow to that class and `throw err` for anything
 * else, so a brand-new sibling class would sail past every one of them and land
 * as an unhandled rejection instead of a message. `code === 'RESPOSTA_INVALIDA'`
 * is what tells the two apart where it matters.
 */
export class ShopeeClientRespostaInvalidaError extends ShopeeClientHttpError {
  constructor(
    message: string,
    /** The real 2xx the backend sent — never a hardcoded 200. */
    status: number,
    /**
     * The field paths that failed, de-duplicated with array indices collapsed.
     * ⚠️ Paths only, never values: an OAuth response body is a live credential
     * often enough that the rule has to hold unconditionally (#1015).
     */
    readonly campos: string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA');
    this.name = 'ShopeeClientRespostaInvalidaError';
  }
}

/** Network-level failure reaching the `apps/shopee` backend. */
export class ShopeeClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ShopeeClientNetworkError';
  }
}

/**
 * Read a response BODY, turning a connection that dies mid-body into the same
 * {@link ShopeeClientNetworkError} a failed `fetch` becomes.
 *
 * ⚠️ Wrapping only `fetch` is not enough: the headers can arrive and the socket
 * still drop while the body streams, and `text()` / `blob()` then reject with a
 * bare `TypeError` ("terminated" in Node, "network error" in Chrome). Unwrapped,
 * that escaped every handler in the label loop — an unhandled rejection on the
 * `/pedidos` row and a skipped reset on the checkout (#1748 review). The loop
 * reads one body per poll for up to two minutes, so the window is wide.
 *
 * An abort WE asked for rethrows untouched: the caller tells its own deadline
 * apart by `signal.aborted`, and must keep seeing the abort itself. Any error
 * that is not a `TypeError` is not a transport failure and rethrows too.
 */
async function lerCorpo<T>(ler: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await ler();
  } catch (err) {
    if (signal?.aborted === true) throw err;
    if (err instanceof TypeError) throw new ShopeeClientNetworkError(err.message, err);
    throw err;
  }
}

/**
 * What to say when the backend answered a non-2xx WITHOUT our JSON envelope —
 * the case where the request never reached one of its routes at all.
 *
 * Written for the OPERATOR, who cannot inspect a deployment: it says what to do,
 * and carries the status only so support can act on a screenshot. The four
 * branches match the statuses `apps/shopee/lib/shopee/core/respond.ts` actually
 * emits (400 / 404 / 500 / 502 / 503) plus the auth failures `verifyCaller`
 * answers before any route body runs.
 */
export function shopeeHttpFallbackMessage(status: number): string {
  if (status === 401 || status === 403) {
    return 'Sem permissão para esta operação na Shopee.';
  }
  if (status === 404) {
    return `A integração com a Shopee não respondeu (HTTP ${String(status)}). Atualize a página e, se continuar, avise o suporte.`;
  }
  if (status >= 500) {
    return `A integração com a Shopee falhou (HTTP ${String(status)}). Tente novamente em instantes.`;
  }
  return `Falha na comunicação com a Shopee (HTTP ${String(status)}).`;
}

/**
 * One call of the label flow (`POST /api/marketplace/shopee/etiqueta`, #1523).
 *
 * - `pacote` — only after a `baixar-por-pacote` answer: the ONE package this
 *   call downloads.
 * - `envio` — only on the call right after an `escolher-envio` answer: the
 *   operator's choice for that question's package.
 *
 * Absent keys are OMITTED from the body — the route's body is strict, and so is
 * each `envio` shape's key set, which is why the client rebuilds both by name.
 */
export interface ShopeeEtiquetaPedido {
  pedidoId: string;
  formato: 'pdf' | 'zpl2';
  pacote?: string;
  envio?: EscolhaDeEnvio;
}

/**
 * What one label call answered: the file (200), or a wait / a question (202).
 * A refusal (409), a permission gap (403) and every other non-2xx THROW
 * {@link ShopeeClientHttpError}, whose `message` is the backend's own sentence.
 *
 * `contentType` is the response header VERBATIM (a proxy may append a charset);
 * deciding what a type means is the caller's job, not the transport's.
 */
export type ShopeeEtiquetaResposta =
  | { tipo: 'arquivo'; blob: Blob; filename: string; contentType: string }
  | ({ tipo: 'pendente' } & ShopeeEtiquetaPendente);

/** Which return a seller action is about — every action carries all three. */
interface AlvoDaReclamacaoShopee {
  integracaoId: string;
  /**
   * The pedido the operator is LOOKING AT. The backend refuses (409
   * `pedido-divergente`) when the return's order maps to another one, so a
   * stale tab can never act on return X from pedido Y.
   */
  pedidoId: string;
  returnSn: string;
}

/**
 * One seller action on a Shopee return (`POST …/reclamacao/acao`), typed PER
 * ACTION so a missing "what you saw" echo is a compile error rather than a 400:
 *
 * - `confirmar` — refund without the item back; echoes the refund the panel
 *   showed, in integer centavos (`valorExibidoMinor`);
 * - `ofertar` — propose a solution; `valorReembolsoMinor` (centavos) only for an
 *   adjustable one, and ABSENT — never `0` — otherwise;
 * - `aceitar-oferta` — accept the buyer's offer; echoes the amount AND the
 *   solution the panel showed.
 *
 * The backend refuses with 409 when the live return no longer matches an echo,
 * so a buyer counter-offer landing between the read and the click is never
 * accepted unseen. Money travels as integer centavos, never a browser float.
 */
export type ReclamacaoAcaoShopeeInput =
  | (AlvoDaReclamacaoShopee & {
      acao: typeof ACAO_RECLAMACAO_SHOPEE.confirmar;
      valorExibidoMinor: number | null;
    })
  | (AlvoDaReclamacaoShopee & {
      acao: typeof ACAO_RECLAMACAO_SHOPEE.ofertar;
      solucao: SolucaoDevolucaoShopee;
      valorReembolsoMinor?: number;
    })
  | (AlvoDaReclamacaoShopee & {
      acao: typeof ACAO_RECLAMACAO_SHOPEE.aceitarOferta;
      valorExibidoMinor: number | null;
      solucaoExibida: SolucaoDevolucaoShopee | null;
    });

/**
 * One publish of an EXISTING link (`POST …/publicar`, step 21). Each optional key
 * is OMITTED from the body when absent — never sent as `null`.
 *
 * - `linkDocId` — WHICH of the conta's links (a produto may hold more than one);
 * - `status` — the listing status asked for (`SHOPEE_ITEM_STATUS_WRITABLE`'s two
 *   values, mirrored here because that package must never reach a browser);
 * - `categoryId` — used only when the resolved link has no category;
 * - `principal` — the native kit's principal produto;
 * - `recriar` / `converterEmKit` — the two kit arms. ⚠️ The route refuses both
 *   together, and `recriar` without `linkDocId` (400 each).
 * - `confirmarSegundoAnuncio` (#1911) — the operator confirmed a SECOND listing
 *   of the produto on the conta (D15) before a draft's publish: without it the
 *   reservation refuses 409 `rascunhoContaJaTemAnuncio` with `detalhes.vinculos`.
 * - `confirmarCriacaoIncerta` (#1911) — the operator's Seller-Centre
 *   attestation about a draft's uncertain last create. The route honours it
 *   ONLY for the refusals `criacao-incerta-sem-sku` and
 *   `criacao-incerta-ja-vinculada`, ignores it everywhere else, and it never
 *   skips the look-up.
 * - `criacaoIncertaAdota` (#1911 P11 review, §I1) — what that attestation
 *   EXPECTS the look-up to decide: the unlinked listing id(s) the publish
 *   adopts, or `[]` for a deliberate create. The look-up honours the
 *   attestation only when its FRESH verdict is that one, and otherwise refuses
 *   with a fresh row, nothing sent. Sent ONLY beside
 *   `confirmarCriacaoIncerta: true` (dropped from the body without it); the
 *   flag alone keeps the CLI's meaning (no expectation, no guard) — the web's
 *   draft publish never sends it alone (`corpoPublicarRascunhoShopee`).
 *
 * ⚠️ A DRAFT is published by its `linkDocId` alone — never `categoryId` (the
 * draft carries its own) and never a kit flag. The route's parser is not
 * strict: a backend older than a key IGNORES it, a mistyped one is a 400 —
 * hence the literal `true`, omitted when absent.
 *
 * ⚠️ **Deploy order (review R7-roundtrip#4).** Because an older backend
 * ignores what it does not know, the web's draft Publicar is only as safe as
 * the apps/shopee it reaches: the FIRST apps/web deploy carrying P10/P11 —
 * whichever PR triggers it — goes out only after apps/shopee App Hosting (and
 * the Shopee functions codebase, `firebase.shopee.deploy.json`) is live at
 * batch A (#2048–#2054) or later, and P11's `criacaoIncertaAdota` needs the
 * P11 server: a backend without the guard drops the expectation and honours
 * the bare flag, so an exit labelled «adota … — não cria outro» could create.
 * apps/shopee FIRST, then apps/web.
 */
export interface PublicarShopeeInput {
  integracaoId: string;
  produtoId: string;
  linkDocId?: string;
  status?: 'NORMAL' | 'UNLIST';
  categoryId?: number;
  principal?: string;
  recriar?: true;
  converterEmKit?: true;
  confirmarSegundoAnuncio?: true;
  confirmarCriacaoIncerta?: true;
  criacaoIncertaAdota?: readonly number[];
}

/**
 * A draft's fields as a draft body names them (#1911): the projection's shape
 * (`CamposRascunhoShopee`, `@delfrance/schemas`) WITHOUT the reserved
 * `logistic_info`, which no draft body accepts yet. `marca` is ONE value over
 * the stored pair; `description: null` is "the produto's own"; `attributes`
 * travel in the REQUEST shape.
 */
export type CamposDoCorpoRascunhoShopee = Omit<CamposRascunhoShopee, 'logistic_info'>;

/**
 * Create a draft (`POST …/rascunho`).
 *
 * - `linkDocId` — the id the CLIENT generated: exactly Firestore's auto-id shape
 *   (`PADRAO_ID_RASCUNHO_SHOPEE`, 20 letters or digits; never a UUID). A create
 *   at an id holding a document that is not this draft is a 409
 *   `rascunhoIdEmUso`; this draft with OTHER content, a 409 `rascunhoConflito`.
 * - `conteudo` — EVERY field; `attributes` is the attribute editor's
 *   normalised list (`corpoCriarRascunhoShopee`), `null` when the form holds
 *   none. `item_name` `null` or blank is a CODELESS 400 (the editor never lets
 *   it out).
 * - `confirmarSegundoAnuncio` — the operator confirmed a SECOND listing on the
 *   conta (after a 409 `rascunhoContaJaTemAnuncio`); omitted when absent.
 */
export interface CriarRascunhoShopeeInput {
  integracaoId: string;
  produtoId: string;
  linkDocId: string;
  conteudo: CamposDoCorpoRascunhoShopee;
  confirmarSegundoAnuncio?: true;
}

/**
 * Edit a draft (`POST …/rascunho/atualizar`). `linkDocId` is any existing
 * draft's id — a legacy one included, so it is NEVER held to the create's id
 * shape.
 *
 * - `patch` — the CHANGED fields only, at least one; an absent key is "not
 *   changed".
 * - `base` — what the operator SAW, VERBATIM, for exactly the fields
 *   `camposDaBaseDoRascunhoShopee(patch)` names (`@delfrance/schemas`): the
 *   patch's, plus `attributes` when the patch changes `category_id` without
 *   them. Any other key set is a CODELESS 400 — read it from that function,
 *   never hand-roll it.
 */
export interface AtualizarRascunhoShopeeInput {
  integracaoId: string;
  produtoId: string;
  linkDocId: string;
  base: Partial<CamposDoCorpoRascunhoShopee>;
  patch: Partial<CamposDoCorpoRascunhoShopee>;
}

/**
 * Discard a draft (`POST …/rascunho/descartar`).
 *
 * - `base` — what the operator SAW for EVERY field, verbatim (`null` allowed):
 *   a draft edited meanwhile is refused (409 `rascunhoConflito`), never
 *   discarded unseen.
 * - `confirmarCriacaoIncerta` — the operator's attestation, after checking in
 *   Seller Centre, that the uncertain last create left nothing this draft must
 *   become (after a 409 `rascunhoCriacaoIncerta`); omitted when absent.
 */
export interface DescartarRascunhoShopeeInput {
  integracaoId: string;
  produtoId: string;
  linkDocId: string;
  base: CamposDoCorpoRascunhoShopee;
  confirmarCriacaoIncerta?: true;
}

export interface ShopeeClient {
  /** Mint the Shopee consent URL for an `integracao` conta (PERM.integracao.write). */
  oauthStart(integracaoId: string): Promise<ShopeeOauthStart>;
  /** Connection status — the two clocks. Always 200 (PERM.integracao.read). */
  conta(integracaoId: string): Promise<ShopeeContaStatus>;
  /**
   * ONE call of the label flow (PERM.frete.read; an arrange needs frete.write,
   * answered as a 403 otherwise). Stateless on both sides: the caller loops on
   * the 202s, and re-calling IS the resume path.
   *
   * ⚠️ An abort through `opts.signal` surfaces like every other transport
   * failure — a {@link ShopeeClientNetworkError} whose `cause` is the
   * `DOMException` — while the request is in flight; an abort during the BODY
   * read rejects with that `DOMException` itself. A caller telling its own
   * deadline apart reads `signal.aborted`, which covers both. A connection that
   * drops mid-body WITHOUT an abort is a {@link ShopeeClientNetworkError} too
   * (`lerCorpo`), never a bare `TypeError`.
   */
  etiqueta(
    p: ShopeeEtiquetaPedido,
    opts?: { signal?: AbortSignal },
  ): Promise<ShopeeEtiquetaResposta>;
  /**
   * Live state of one Shopee return (`PERM.incidenteResolucao.read`).
   *
   * ⚠️ Never cache the result: `acoesDisponiveis` is stale the moment it
   * leaves the backend, so the panel refetches rather than remembering.
   */
  reclamacaoEstado(input: {
    integracaoId: string;
    returnSn: string;
  }): Promise<ShopeeReclamacaoEstado>;
  /**
   * Run one seller action on a Shopee return (`PERM.incidenteResolucao.write`).
   *
   * ⚠️ **Irreversible, and it moves money.** Writes NOTHING locally — the
   * returns importer stays the single writer of the incidente, so the caller
   * learns the outcome by refetching {@link reclamacaoEstado}.
   *
   * ⚠️ A {@link ShopeeClientNetworkError} here means the outcome is UNKNOWN,
   * not that the action failed: a gateway timeout reaches the browser as a
   * network error with no CORS headers. Never retry it automatically.
   */
  reclamacaoAcao(input: ReclamacaoAcaoShopeeInput): Promise<ShopeeReclamacaoAcaoResposta>;
  /**
   * The conta's category tree, one level at a time (`PERM.integracao.read`):
   * the ROOTS when `categoryId` is `null` (the query key is then OMITTED,
   * never sent empty), ONE node with its ancestors and children otherwise. An
   * id the tree does not hold is a 404 `SHOPEE_CATEGORIA_DESCONHECIDA`.
   */
  categorias(input: {
    integracaoId: string;
    categoryId: number | null;
  }): Promise<RespostaCategoriasShopee>;
  /**
   * One category's item bands, read for its `sizeChartLimit` only
   * (`PERM.integracao.read`). ADVICE — never a reason to refuse a pick.
   */
  limites(input: { integracaoId: string; categoryId: number }): Promise<RespostaLimitesShopee>;
  /**
   * The size-chart templates of ONE leaf category (`PERM.integracao.read`). A
   * non-leaf answers `leaf: false` with no templates; a category Shopee refuses
   * for templates is a 404 `SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA`.
   *
   * ⚠️ UNCACHED on the backend (a template made a minute ago must appear), and
   * it costs one Shopee detail read per template — never poll it.
   */
  tabelaMedidasLista(input: {
    integracaoId: string;
    categoryId: number;
  }): Promise<ListaTabelasMedidasDto>;
  /**
   * One template, projected by the backend (`PERM.integracao.read`). A
   * template the shop no longer has is a 404 `SHOPEE_TABELA_MEDIDAS_INEXISTENTE`
   * — the stored pick is stale, and the operator must choose another.
   */
  tabelaMedidasDetalhe(input: {
    integracaoId: string;
    sizeChartId: number;
  }): Promise<DetalheTabelaMedidasDto>;

  // ---- Step 21 (#1529): the pushes, the listing actions and the two jobs. ----
  // Named exactly like `MercadoLivreClient`'s methods (`lib/mercado-livre/client.ts`).

  /**
   * Push the CURRENT stock of up to 50 produtos to their Shopee listings, right
   * now (PERM.integracao.write). SYNCHRONOUS: one row per LISTING.
   *
   * Per-listing failure is DATA — a valid request answers 200 even when every
   * listing failed — so only conta-level refusals throw
   * {@link ShopeeClientHttpError}: 400 `SHOPEE_SELECAO_EXCEDE_LIMITE`
   * (`detalhes.limite` / `solicitados`), 400 `SHOPEE_CONTA_SEM_DEPOSITO`, 409
   * `SHOPEE_CONTA_PAUSADA` (`detalhes.pausadoAte`).
   *
   * ⚠️ An abort through `signal` surfaces as a {@link ShopeeClientNetworkError}
   * whose `cause` is the `DOMException` while the request is in flight, and as
   * the `DOMException` itself during the body read — read `signal.aborted` to
   * tell your own cancel apart. The server may still finish the push.
   */
  enviarEstoque(input: {
    integracaoId: string;
    produtoIds: string[];
    /** Default false. */
    reenviarComErro?: boolean;
    signal?: AbortSignal;
  }): Promise<EnvioEstoqueManualShopee>;
  /**
   * Push the CURRENT price of up to 50 produtos to their Shopee listings, right
   * now (PERM.integracao.write) — one row per MODEL. Per-row failure is DATA;
   * conta-level refusals throw (400 `SHOPEE_SELECAO_EXCEDE_LIMITE`, 400
   * `SHOPEE_CONTA_SEM_TABELA_NORMAL`, 409 `SHOPEE_CONTA_PAUSADA`, 422
   * `SHOPEE_PRECO_CONTA_RECUSADA` with `detalhes.motivo` / `regiao`).
   *
   * `baixarPreco` (default false) lets the send LOWER a price. ⚠️ There is NO
   * `incluirNaoPublicados` here: the Shopee route never reads it, so the client
   * never sends it.
   *
   * The abort convention is {@link enviarEstoque}'s.
   */
  enviarPrecos(input: {
    integracaoId: string;
    produtoIds: string[];
    baixarPreco?: boolean;
    signal?: AbortSignal;
  }): Promise<EnvioPrecoManualShopee>;
  /**
   * PAUSE or REACTIVATE listings on Shopee (PERM.integracao.write).
   *
   * ⚠️ Two callers, one method, and the difference is `linkDocId`: the produto
   * tab names ONE listing (and then `produtoIds` must hold exactly that
   * produto), while the produtos table omits it and the run covers every
   * listing the selection holds on that conta. Per-listing refusal is DATA.
   *
   * The abort convention is {@link enviarEstoque}'s.
   */
  definirStatusAnuncios(input: {
    integracaoId: string;
    produtoIds: string[];
    acao: AcaoStatusAnuncio;
    linkDocId?: string;
    signal?: AbortSignal;
  }): Promise<AnuncioStatusShopee>;
  /**
   * Publish an EXISTING link — an ordinary listing, a native kit, or a listing
   * DRAFT's first create (#1911) (PERM.integracao.write). The answer is
   * tagged: `tipo: 'item'`, `tipo: 'kit'` — a kit whose `desfecho` is
   * `incerto` is its 202: the caller waits `aguardarMs` and re-sends the
   * IDENTICAL input — or `tipo: 'item-incerto'`, the 202 of a draft's create
   * whose outcome nobody knows (never "falhou"; the next publish of the same
   * draft looks the listing up first).
   *
   * The ERP's own refusal is a 422 `SHOPEE_PUBLISH_BLOCKED` — usually decided
   * before any Shopee write, but the model leg of an UPDATE refuses AFTER
   * `update_item`, and the body names no etapa that would tell the two apart;
   * a refusal classified onto a Shopee call is a 422 `SHOPEE_PUBLISH_REJECTED`
   * (`detalhes.etapa`, where it landed). Both carry `detalhes.problemas`, each
   * with its machine-readable `acao`. 404
   * `SHOPEE_ANUNCIO_NAO_ENCONTRADO` when the conta holds no such link — for a
   * draft, one discarded meanwhile. A draft's lock answers the 409s of
   * `CODIGO_FALHA_SHOPEE`'s #1911 block (`publicacaoEmAndamento`,
   * `rascunhoJaPublicado`, `publicacaoExpirada`, `rascunhoContencao`,
   * `rascunhoCriacaoIncerta`, `rascunhoContaJaTemAnuncio`).
   *
   * ⚠️ **No `signal`, on purpose.** Creating a kit is not idempotent: an abort
   * would turn a publish the server goes on to finish into an "unknown" the
   * operator re-clicks.
   */
  publicar(input: PublicarShopeeInput): Promise<RespostaPublicarShopee>;
  /**
   * Re-read ONE listing from Shopee and reconcile its link (PERM.integracao.write).
   * A listing Shopee no longer has comes back 200 `removido`. 404
   * `SHOPEE_ANUNCIO_SEM_VINCULO` when this conta holds no link for the produto;
   * 409 `SHOPEE_ANUNCIO_NAO_PUBLICADO` (`detalhes.linkDocId`) when the link was
   * never published.
   */
  reverificarAnuncio(input: {
    integracaoId: string;
    produtoId: string;
    linkDocId?: string;
  }): Promise<RespostaReverificarShopee>;
  /**
   * Start the mass import ("Importar todos os anúncios") for the conta
   * (PERM.integracao.write) — 202 `{ jobId }`; poll with
   * {@link massImportStatus}. One already running is a 409
   * `SHOPEE_MASS_IMPORT_RUNNING` (its id, when the backend sends it, in
   * `detalhes.jobId`); a closed queue is a 503 `SHOPEE_MASS_IMPORT_ENQUEUE_FAILED`.
   */
  startMassImport(input: {
    integracaoId: string;
    /** Each option absent ⇒ the backend's default. */
    options?: z.input<typeof importacaoShopeeOptionsSchema>;
  }): Promise<JobIdShopee>;
  /** Poll a mass-import job (PERM.integracao.read). 404s on an unknown or foreign jobId. */
  massImportStatus(input: { integracaoId: string; jobId: string }): Promise<MassImportStatusShopee>;
  /**
   * Cancel a running mass import (PERM.integracao.write). One that already
   * finished is a 409 `SHOPEE_MASS_IMPORT_NOT_RUNNING`.
   */
  cancelMassImport(input: { integracaoId: string; jobId: string }): Promise<CanceladoShopee>;
  /**
   * Start the account-wide price update ("Atualizar preços")
   * (PERM.integracao.write) — 202 `{ jobId }`; poll with {@link priceSyncStatus}.
   * One already running is a 409 `SHOPEE_PRICE_SYNC_RUNNING` (`detalhes.jobId`
   * when sent); a closed queue is a 503 `SHOPEE_PRICE_SYNC_ENQUEUE_FAILED`.
   */
  startPriceSync(input: {
    integracaoId: string;
    /** Default false — a price DECREASE is skipped unless opted in. */
    baixarPreco?: boolean;
  }): Promise<JobIdShopee>;
  /** Poll a price-update job (PERM.integracao.write). 404s on an unknown or foreign jobId. */
  priceSyncStatus(input: { integracaoId: string; jobId: string }): Promise<PriceSyncStatusShopee>;
  /**
   * Cancel a running price update (PERM.integracao.write). One that already
   * finished is a 409 `SHOPEE_PRICE_SYNC_NOT_RUNNING` — one word from the start
   * route's `SHOPEE_PRICE_SYNC_RUNNING`, and the opposite meaning.
   */
  cancelPriceSync(input: { integracaoId: string; jobId: string }): Promise<CanceladoShopee>;
  /**
   * The conta's PAST price updates, newest first (PERM.integracao.write).
   * `limite` (1..50) is REFUSED out of range rather than clamped; absent ⇒ the
   * route's default.
   */
  priceSyncHistorico(input: {
    integracaoId: string;
    limite?: number;
  }): Promise<PriceSyncHistoricoShopee>;
  /**
   * One PAGE of a run's complete per-model report (PERM.integracao.write), for the
   * CSV. Loop on `proximoDepois` until it is `null`; `depois` is the previous
   * page's `proximoDepois`.
   */
  priceSyncRelatorio(input: {
    integracaoId: string;
    jobId: string;
    depois?: string | null;
  }): Promise<PriceSyncRelatorioPaginaShopee>;

  // ---- #1911: listing drafts, the three taxonomy reads the draft editor adds,
  // the brand page a conta's Marcas section reads, and the variation tree a
  // grupo's Shopee tab reads. ----
  // A refusal of the DRAFT is a ShopeeClientHttpError whose `code` is one of
  // `CODIGO_FALHA_SHOPEE`'s #1911 block (`./erros.ts`), its extras on `detalhes`
  // (`linkDocId`, `conflitos`, `aguardarMs`, `vinculos`, `motivo`). Two answers
  // carry NO code — a 400 for a refused body and the 404 of a conta that is not
  // Shopee's — and their `message` is the route's own sentence.

  /**
   * Create a listing draft (PERM.integracao.write). BOTH 2xx are a success:
   * **201** `criado: true` (made now) and **200** `criado: false` (the same
   * draft with the same content was already there — a double click, or a retry
   * whose first answer was lost). 404 `rascunhoInexistente` here means the
   * PRODUTO is gone; a conta that is not Shopee's is a codeless 404.
   */
  criarRascunho(input: CriarRascunhoShopeeInput): Promise<RespostaCriarRascunhoShopee>;
  /**
   * Edit a listing draft (PERM.integracao.write) — `gravados` lists the fields
   * WRITTEN (`[]` = nothing differed). 409 `rascunhoConflito` when what is
   * stored is not the `base`: NOTHING was written.
   */
  atualizarRascunho(input: AtualizarRascunhoShopeeInput): Promise<RespostaAtualizarRascunhoShopee>;
  /**
   * Discard a listing draft — its document is deleted (PERM.integracao.write).
   * Only while it is still a draft and no publish holds it; a draft whose last
   * create may have reached Shopee also needs `confirmarCriacaoIncerta`.
   */
  descartarRascunho(input: DescartarRascunhoShopeeInput): Promise<RespostaDescartarRascunhoShopee>;
  /**
   * The categories Shopee SUGGESTS for a product name (PERM.integracao.read) —
   * OFFERED, never applied (`applied: false`). A suggested id this shop's tree
   * lacks degrades its ROW and is counted in `unresolved`.
   *
   * ⚠️ `nome` only. The route's optional `imagemCapa` is an image id from
   * Shopee's `upload_image`, which the browser never holds, so this client
   * never sends it.
   */
  recomendacaoCategoria(input: {
    integracaoId: string;
    nome: string;
  }): Promise<RespostaRecomendacaoCategoriaShopee>;
  /**
   * The item bands WHOLE — price, stock, title / description lengths, images,
   * days to ship, weight and dimensions, the size-chart flags, the GTIN rule —
   * for the draft editor (PERM.integracao.read). The shop-wide bands when
   * `categoryId` is `null` (the query key OMITTED); one category's otherwise.
   *
   * ⚠️ The opposite tolerance of {@link limites}: every band is REQUIRED, so a
   * malformed one refuses the answer (`ShopeeClientRespostaInvalidaError`),
   * where the size-chart slice drops it unread.
   */
  limitesDoItem(input: {
    integracaoId: string;
    categoryId: number | null;
  }): Promise<RespostaLimitesDoItemShopee>;
  /**
   * The attribute tree of ONE leaf category (PERM.integracao.read) — what a
   * listing draft's «Atributos» section renders and its publish gate checks
   * (#1911 P13): which attributes are mandatory, the input each takes, the
   * selectable values, and the attributes a chosen value unlocks. A non-leaf
   * answers `leaf: false` with an empty list; an id the tree does not hold is
   * a 404 `SHOPEE_CATEGORIA_DESCONHECIDA`.
   *
   * ⚠️ `truncated: true` is a VALUE, not a failure: the tree is deeper than the
   * answer holds, so it is NOT complete. A body without it is a
   * {@link ShopeeClientRespostaInvalidaError}, at any depth of the tree.
   * `categoryId` is required — there is no shop-wide tree.
   */
  atributos(input: { integracaoId: string; categoryId: number }): Promise<RespostaAtributosShopee>;
  /**
   * ONE page of a LEAF category's brands, straight from Shopee
   * (PERM.integracao.read) — the registration picker of a conta's Marcas
   * section. A non-leaf answers `leaf: false` with no brands; an id the tree
   * does not hold is a 404 `SHOPEE_CATEGORIA_DESCONHECIDA`.
   *
   * - No paging loop here: the caller asks for the next page with
   *   `offset: nextOffset` while `hasNextPage` — never on `nextOffset` alone,
   *   and never `offset + pageSize`.
   * - `status` — `1` the approved brands (the route's default), `2` the ones
   *   under review; mirrored as literals because the Shopee package that names
   *   them must never reach a browser. Any other value is a 400.
   * - Each optional key is OMITTED when absent (the route's defaults apply);
   *   `offset: 0` is SENT.
   *
   * ⚠️ Shopee's brand API is slow and there is no name search: page through it,
   * never poll it.
   */
  marcas(input: {
    integracaoId: string;
    categoryId: number;
    offset?: number;
    pageSize?: number;
    status?: 1 | 2;
  }): Promise<RespostaMarcasShopee>;
  /**
   * Shopee's STANDARDISED variation tree of ONE leaf category
   * (PERM.integracao.read) — what a grupo's Shopee tab binds its variantes to
   * (#1911 P14). A non-leaf answers `leaf: false` with an empty list; an id the
   * tree does not hold is a 404 `SHOPEE_CATEGORIA_DESCONHECIDA`.
   *
   * ⚠️ A body without `pathUsed` is a {@link ShopeeClientRespostaInvalidaError}:
   * the route always echoes the path it called. Read it through
   * `useVariacoesShopee` (`./variacoes`), which also owns the copy of a failure.
   */
  variacoes(input: { integracaoId: string; categoryId: number }): Promise<RespostaVariacoesShopee>;
}

/** The label route. */
const ETIQUETA_PATH = '/api/marketplace/shopee/etiqueta';

/** The two returns routes (#1525, step 17). */
const RECLAMACAO_ESTADO_PATH = '/api/marketplace/shopee/reclamacao/estado';
const RECLAMACAO_ACAO_PATH = '/api/marketplace/shopee/reclamacao/acao';

/** The two taxonomy routes the size-chart tab reads (step 10's) and the two size-chart reads (#1526, step 18). */
const CATEGORIAS_PATH = '/api/marketplace/shopee/taxonomia/categorias';
const LIMITES_PATH = '/api/marketplace/shopee/taxonomia/limites';
const TABELA_MEDIDAS_LISTA_PATH = '/api/marketplace/shopee/tabela-medidas/lista';
const TABELA_MEDIDAS_DETALHE_PATH = '/api/marketplace/shopee/tabela-medidas/detalhe';

/** The three on-demand pushes, the publish and the re-verify (#1529, step 21). */
const ENVIAR_ESTOQUE_PATH = '/api/marketplace/shopee/enviar-estoque';
const ENVIAR_PRECOS_PATH = '/api/marketplace/shopee/enviar-precos';
const ANUNCIO_STATUS_PATH = '/api/marketplace/shopee/anuncio-status';
const PUBLICAR_PATH = '/api/marketplace/shopee/publicar';
const REVERIFICAR_ANUNCIO_PATH = '/api/marketplace/shopee/reverificar-anuncio';

/** The two account-wide jobs (#1529, step 21): the mass import and the price update. */
const IMPORTAR_TODOS_PATH = '/api/marketplace/shopee/importar-todos';
const IMPORTAR_TODOS_STATUS_PATH = '/api/marketplace/shopee/importar-todos/status';
const IMPORTAR_TODOS_CANCELAR_PATH = '/api/marketplace/shopee/importar-todos/cancelar';
const ATUALIZAR_PRECOS_PATH = '/api/marketplace/shopee/atualizar-precos';
const ATUALIZAR_PRECOS_STATUS_PATH = '/api/marketplace/shopee/atualizar-precos/status';
const ATUALIZAR_PRECOS_CANCELAR_PATH = '/api/marketplace/shopee/atualizar-precos/cancelar';
const ATUALIZAR_PRECOS_HISTORICO_PATH = '/api/marketplace/shopee/atualizar-precos/historico';
const ATUALIZAR_PRECOS_RELATORIO_PATH = '/api/marketplace/shopee/atualizar-precos/relatorio';

/** The three draft routes (#1911) — POST sub-paths, because CORS admits only GET/POST/OPTIONS. */
const RASCUNHO_PATH = '/api/marketplace/shopee/rascunho';
const RASCUNHO_ATUALIZAR_PATH = '/api/marketplace/shopee/rascunho/atualizar';
const RASCUNHO_DESCARTAR_PATH = '/api/marketplace/shopee/rascunho/descartar';

/** The draft editor's extra taxonomy read (#1911); the bands reuse {@link LIMITES_PATH}. */
const RECOMENDACAO_CATEGORIA_PATH = '/api/marketplace/shopee/taxonomia/recomendacao-categoria';

/** A leaf category's attribute tree — a draft's «Atributos» section and its publish gate (#1911 P13). */
const ATRIBUTOS_PATH = '/api/marketplace/shopee/taxonomia/atributos';

/** A category's brands, one page — the Marcas section's registration picker (#1911). */
const MARCAS_PATH = '/api/marketplace/shopee/taxonomia/marcas';

/** A leaf category's standardised variation tree — a grupo's Shopee tab (#1911 P14). */
const VARIACOES_PATH = '/api/marketplace/shopee/taxonomia/variacoes';

/**
 * A query string from named parameters, each value percent-encoded and an
 * `undefined` one OMITTED — never sent as `key=` or `key=undefined`, which the
 * routes would read as a present-but-invalid id (a 400) instead of an absent one.
 */
function consulta(params: Readonly<Record<string, string | number | undefined>>): string {
  const pares: string[] = [];
  for (const [chave, valor] of Object.entries(params)) {
    if (valor === undefined) continue;
    pares.push(`${chave}=${encodeURIComponent(String(valor))}`);
  }
  return pares.join('&');
}

/**
 * Log a body the operator will never see, capped so a whole HTML document
 * cannot flood the console.
 */
function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(
    `[shopee] resposta não-JSON em ${path} (HTTP ${String(status)})`,
    corpo.slice(0, 500),
  );
}

/**
 * The error for a non-2xx — the ONE copy, shared by every route of this client.
 * Our JSON envelope's `error` and `code` when the backend sent one, the status
 * fallback otherwise. A label refusal's `error` IS its `mensagem` (truth:
 * `apps/shopee/lib/shopee/etiqueta/respostaEtiqueta.ts`); its `shopeeCode`, when
 * a string, is carried on the error WITHOUT touching the message — and so is
 * the `SHOPEE_HTTP_ERROR` body's `kind` (step 18: the rate-limit copy reads
 * it). Since step 21 the extras a caller acts on (`pausadoAte`, `limite`,
 * `problemas`, `jobId`, …) ride on `detalhes`, read by ONE tolerant schema from
 * the same parsed body. Every other key (`nfe`, `tentarApos`, `upstreamStatus`,
 * `sizeChartId`) is tolerated and ignored here.
 */
function erroHttp(path: string, res: Response, text: string): ShopeeClientHttpError {
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // ⚠️ The body must NOT become `{ error: text }`: a proxy's whole HTML
      // document would then end up verbatim in `err.message` and bury the
      // real cause behind a wall of markup. It stays reachable on the
      // console instead.
      if (err instanceof SyntaxError) {
        logarCorpoNaoJson(path, res.status, text);
      } else throw err;
    }
  }
  const errBody = envelopeDeErro(parsed);
  return new ShopeeClientHttpError(
    errBody?.error ?? shopeeHttpFallbackMessage(res.status),
    res.status,
    errBody?.code ?? null,
    textoDoCorpo(parsed, 'shopeeCode'),
    textoDoCorpo(parsed, 'kind'),
    detalhesDoCorpo(parsed),
  );
}

/**
 * The error body's extras, each field read on its own (`detalhesErroShopeeSchema`
 * catches per field). Only a body that is not an OBJECT at all — no body, an
 * array, a scalar, a non-JSON page — falls back to "every extra absent": the
 * error must always construct.
 */
function detalhesDoCorpo(parsed: unknown): DetalhesErroShopee {
  const leitura = detalhesErroShopeeSchema.safeParse(parsed ?? {});
  return leitura.success ? leitura.data : DETALHES_ERRO_SHOPEE_VAZIOS;
}

/**
 * A non-empty string at `chave` on an error body, else `null` — nothing is
 * coerced (a number, a boolean, `''` all read as absent). The ONE reader for
 * both `shopeeCode` and `kind`.
 */
function textoDoCorpo(parsed: unknown, chave: 'shopeeCode' | 'kind'): string | null {
  if (parsed === null || typeof parsed !== 'object' || !(chave in parsed)) return null;
  const valor: unknown = (parsed as Record<string, unknown>)[chave];
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/** A 2xx JSON body read against its schema, or the one error each failure earns. */
function lerCorpoJson<S extends z.ZodType>(
  path: string,
  status: number,
  text: string,
  schema: S,
): z.infer<S> {
  const leitura = lerRespostaJson(text, schema);
  if (leitura.ok) return leitura.data;

  if (leitura.motivo !== 'formato') {
    // ⚠️ EMPTY and NON-JSON share this branch, and they must: neither is
    // version skew — in both, the request failed to reach a route that
    // answers JSON. Sending someone to deploy a backend that was never the
    // problem is the defect this wording exists to avoid.
    logarCorpoNaoJson(
      path,
      status,
      leitura.motivo === 'nao-json' ? leitura.texto : '(corpo vazio)',
    );
    throw new ShopeeClientRespostaInvalidaError(
      `A integração com a Shopee respondeu HTTP ${String(status)} sem um corpo JSON — ` +
        'o pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o ' +
        'suporte.',
      status,
      [],
    );
  }

  throw new ShopeeClientRespostaInvalidaError(
    'O backend da Shopee respondeu num formato que este aplicativo não reconhece. ' +
      `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
      'backend e esta tela estão em versões diferentes — faça o deploy de `apps/shopee` e ' +
      'recarregue a página.',
    status,
    leitura.campos,
  );
}

/** The MIME essence of a `Content-Type` — lower-cased, parameters dropped. */
function essenciaDoTipo(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The extension of each type the label route serves, keyed by MIME essence —
 * the three its byte sniff can name (truth:
 * `packages/integrations/shopee/src/arquivo.ts`). A `Map`, not an object: an
 * essence is a string off the wire, and `'constructor'` must not resolve.
 */
const EXTENSAO_DA_ETIQUETA: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'pdf'],
  ['application/zip', 'zip'],
  ['text/plain', 'txt'],
]);

/**
 * The label request body, rebuilt BY NAME: absent keys omitted, and each
 * `envio` shape with exactly its own keys. The route refuses any other key
 * (400), so a caller's object carrying one more field must not reach it.
 */
function corpoDaEtiqueta(p: ShopeeEtiquetaPedido): Record<string, unknown> {
  const envio: EscolhaDeEnvio | undefined =
    p.envio === undefined
      ? undefined
      : p.envio.modo === 'dropoff'
        ? { pacote: p.envio.pacote, modo: 'dropoff' }
        : {
            pacote: p.envio.pacote,
            modo: 'pickup',
            enderecoId: p.envio.enderecoId,
            horarioId: p.envio.horarioId,
          };
  return {
    pedidoId: p.pedidoId,
    formato: p.formato,
    ...(p.pacote === undefined ? {} : { pacote: p.pacote }),
    ...(envio === undefined ? {} : { envio }),
  };
}

/**
 * The returns action body, rebuilt BY NAME and per action: exactly the keys
 * that action carries, an absent optional one OMITTED (never `null`-filled).
 * The route's body is strict and forbids each key outside its own action
 * (400), so a caller object carrying one more field — a `solucao` left over on
 * a `confirmar` — must not reach it.
 */
function corpoDaReclamacao(p: ReclamacaoAcaoShopeeInput): Record<string, unknown> {
  const alvo = { integracaoId: p.integracaoId, pedidoId: p.pedidoId, returnSn: p.returnSn };
  switch (p.acao) {
    case ACAO_RECLAMACAO_SHOPEE.confirmar:
      return { ...alvo, acao: p.acao, valorExibidoMinor: p.valorExibidoMinor };
    case ACAO_RECLAMACAO_SHOPEE.ofertar:
      return {
        ...alvo,
        acao: p.acao,
        solucao: p.solucao,
        ...(p.valorReembolsoMinor === undefined
          ? {}
          : { valorReembolsoMinor: p.valorReembolsoMinor }),
      };
    case ACAO_RECLAMACAO_SHOPEE.aceitarOferta:
      return {
        ...alvo,
        acao: p.acao,
        valorExibidoMinor: p.valorExibidoMinor,
        solucaoExibida: p.solucaoExibida,
      };
    default: {
      // Exhaustive: a fourth action is a compile error here, never a body
      // sent with whatever keys the caller happened to pass.
      const nunca: never = p;
      throw new TypeError(`ação de devolução desconhecida: ${JSON.stringify(nunca)}`);
    }
  }
}

/**
 * The publish body, rebuilt BY NAME: the two ids, then each optional key only
 * when it is not `undefined` — OMITTED, never `null`-filled, so the body says
 * exactly what the caller chose and nothing else. A caller object carrying one
 * more field never reaches the route. `criacaoIncertaAdota` rides ONLY with
 * `confirmarCriacaoIncerta: true` (an expectation of no attestation is
 * nothing), copied id by id.
 */
function corpoDaPublicacao(p: PublicarShopeeInput): Record<string, unknown> {
  return {
    integracaoId: p.integracaoId,
    produtoId: p.produtoId,
    ...(p.linkDocId === undefined ? {} : { linkDocId: p.linkDocId }),
    ...(p.status === undefined ? {} : { status: p.status }),
    ...(p.categoryId === undefined ? {} : { categoryId: p.categoryId }),
    ...(p.principal === undefined ? {} : { principal: p.principal }),
    ...(p.recriar === undefined ? {} : { recriar: p.recriar }),
    ...(p.converterEmKit === undefined ? {} : { converterEmKit: p.converterEmKit }),
    ...(p.confirmarSegundoAnuncio === undefined
      ? {}
      : { confirmarSegundoAnuncio: p.confirmarSegundoAnuncio }),
    ...(p.confirmarCriacaoIncerta === undefined
      ? {}
      : { confirmarCriacaoIncerta: p.confirmarCriacaoIncerta }),
    ...(p.confirmarCriacaoIncerta === true && p.criacaoIncertaAdota !== undefined
      ? { criacaoIncertaAdota: p.criacaoIncertaAdota.map((id) => id) }
      : {}),
  };
}

/*
 * #1911 — the three draft bodies. Every one is rebuilt BY NAME, down to each
 * attribute value, and typed against the draft route's OWN body schema
 * (`@delfrance/schemas`): the route parses STRICT, so a key a caller's object
 * carries beyond these — `item_id`, `logistic_info`, a decoder's bookkeeping —
 * would be a 400, and a renamed field is a compile error here instead. Values
 * travel VERBATIM: nothing is trimmed, defaulted or normalised (a `base` is
 * compared, byte for byte, against what is stored).
 */

/** The brand pair, by name — `null` stays `null` ("no brand chosen"). */
function marcaPorNome(marca: MarcaRascunhoShopee | null): MarcaRascunhoShopee | null {
  return marca === null
    ? null
    : { brand_id: marca.brand_id, original_brand_name: marca.original_brand_name };
}

/** An attribute list, by name; an absent optional key of a value stays absent. */
function atributosPorNome(atributos: readonly AtributoShopeeRequisicao[] | null) {
  return atributos === null
    ? null
    : atributos.map((atributo) => ({
        attribute_id: atributo.attribute_id,
        attribute_value_list: atributo.attribute_value_list.map((valor) => ({
          value_id: valor.value_id,
          ...(valor.original_value_name === undefined
            ? {}
            : { original_value_name: valor.original_value_name }),
          ...(valor.value_unit === undefined ? {} : { value_unit: valor.value_unit }),
        })),
      }));
}

/** EVERY draft field, by name — the create's `conteudo`, the discard's `base`. */
function camposPorNome(campos: CamposDoCorpoRascunhoShopee) {
  return {
    item_name: campos.item_name,
    description: campos.description,
    category_id: campos.category_id,
    marca: marcaPorNome(campos.marca),
    attributes: atributosPorNome(campos.attributes),
  };
}

/**
 * Only the fields the caller NAMED, by name — an edit's `patch` and `base`. A
 * key whose value is `undefined` is absent; `null` is a value and is sent.
 */
function camposNomeadosPorNome(campos: Partial<CamposDoCorpoRascunhoShopee>) {
  return {
    ...(campos.item_name === undefined ? {} : { item_name: campos.item_name }),
    ...(campos.description === undefined ? {} : { description: campos.description }),
    ...(campos.category_id === undefined ? {} : { category_id: campos.category_id }),
    ...(campos.marca === undefined ? {} : { marca: marcaPorNome(campos.marca) }),
    ...(campos.attributes === undefined ? {} : { attributes: atributosPorNome(campos.attributes) }),
  };
}

function corpoDoRascunhoCriado(
  p: CriarRascunhoShopeeInput,
): z.input<typeof corpoCriarRascunhoShopeeSchema> {
  return {
    integracaoId: p.integracaoId,
    produtoId: p.produtoId,
    linkDocId: p.linkDocId,
    conteudo: camposPorNome(p.conteudo),
    ...(p.confirmarSegundoAnuncio === undefined
      ? {}
      : { confirmarSegundoAnuncio: p.confirmarSegundoAnuncio }),
  };
}

function corpoDoRascunhoAtualizado(
  p: AtualizarRascunhoShopeeInput,
): z.input<typeof corpoAtualizarRascunhoShopeeSchema> {
  return {
    integracaoId: p.integracaoId,
    produtoId: p.produtoId,
    linkDocId: p.linkDocId,
    base: camposNomeadosPorNome(p.base),
    patch: camposNomeadosPorNome(p.patch),
  };
}

function corpoDoRascunhoDescartado(
  p: DescartarRascunhoShopeeInput,
): z.input<typeof corpoDescartarRascunhoShopeeSchema> {
  return {
    integracaoId: p.integracaoId,
    produtoId: p.produtoId,
    linkDocId: p.linkDocId,
    base: camposPorNome(p.base),
    ...(p.confirmarCriacaoIncerta === undefined
      ? {}
      : { confirmarCriacaoIncerta: p.confirmarCriacaoIncerta }),
  };
}

export function createShopeeClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): ShopeeClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  /**
   * One JSON round trip: a GET, or a POST exactly when `body` is given.
   *
   * ⚠️ `getAuthToken()` stays OUTSIDE the try, on purpose: a token failure is
   * a `FirebaseError`, not a transport failure, and the caller narrows it on
   * its own (the returns panel does, so an irreversible confirm never ends in
   * silence). Wrapping it here would relabel it a network error.
   *
   * `signal` is only FORWARDED (the three pushes take one). The abort keeps the
   * client's one convention, `etiqueta`'s: in flight it is a
   * {@link ShopeeClientNetworkError} whose `cause` is the `DOMException`, during
   * the body read the `DOMException` itself — the caller tells its own cancel
   * apart by `signal.aborted`, which covers both.
   */
  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<z.infer<S>> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(signal === undefined ? {} : { signal }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new ShopeeClientNetworkError(err instanceof Error ? err.message : 'fetch falhou', err);
    }

    const text = await lerCorpo(() => res.text(), signal);
    if (!res.ok) throw erroHttp(path, res, text);
    return lerCorpoJson(path, res.status, text, schema);
  }

  /**
   * The label call: 200 = the file's bytes, 202 = JSON, anything else fails.
   *
   * ⚠️ The 200 is the one success path a schema cannot reach — the body is
   * bytes — so what can still go wrong is checked by hand: a 200 that is not
   * the label at all. Each of those becomes {@link ShopeeClientRespostaInvalidaError},
   * NEVER a `Blob` the caller would print: a blank label, or a printer fed a
   * chunk of markup.
   */
  async function etiqueta(
    p: ShopeeEtiquetaPedido,
    opts?: { signal?: AbortSignal },
  ): Promise<ShopeeEtiquetaResposta> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${ETIQUETA_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(corpoDaEtiqueta(p)),
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
      });
    } catch (err) {
      throw new ShopeeClientNetworkError(err instanceof Error ? err.message : 'fetch falhou', err);
    }

    const sinal = opts?.signal;
    if (!res.ok) {
      throw erroHttp(ETIQUETA_PATH, res, await lerCorpo(() => res.text(), sinal));
    }

    // ---- 202: a wait or a question — JSON only. ----
    if (res.status === 202) {
      const pendente = lerCorpoJson(
        ETIQUETA_PATH,
        res.status,
        await lerCorpo(() => res.text(), sinal),
        shopeeEtiquetaPendenteSchema,
      );
      return { ...pendente, tipo: 'pendente' };
    }

    // ---- Any 2xx that is neither: the route answers exactly 200 or 202 (W16). ----
    if (res.status !== 200) {
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} em vez da etiqueta — ` +
          'o pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o ' +
          'suporte.',
        res.status,
        [],
      );
    }

    // ---- 200: the bytes. ----
    const contentType = res.headers.get('content-type');
    const essencia = contentType === null ? null : essenciaDoTipo(contentType);
    // A proxy login page or an App Hosting error page arrives as HTML: the
    // request never reached the route, which answers a label or nothing.
    if (essencia === 'text/html') {
      logarCorpoNaoJson(ETIQUETA_PATH, res.status, await lerCorpo(() => res.text(), sinal));
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} com uma página HTML ` +
          'em vez da etiqueta — o pedido não chegou à rota esperada. Atualize a página e, se ' +
          'continuar, avise o suporte.',
        res.status,
        [],
      );
    }
    // ⚠️ A JSON 200 is a contract breach, never a label (W16): the route answers
    // JSON only on a 202. Its body is not logged — it would be a question
    // carrying the seller's addresses, or something newer than this build.
    if (essencia === 'application/json') {
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} com JSON em vez da ` +
          'etiqueta. Normalmente isso significa que o backend e esta tela estão em versões ' +
          'diferentes — faça o deploy de `apps/shopee` e recarregue a página.',
        res.status,
        [],
      );
    }

    const blob = await lerCorpo(() => res.blob(), sinal);
    // "A 2xx with an empty body is a failed label" — never a blank print.
    if (blob.size === 0) {
      logarCorpoNaoJson(ETIQUETA_PATH, res.status, '(corpo vazio)');
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} sem a etiqueta (corpo ` +
          'vazio). Tente de novo e, se continuar, avise o suporte.',
        res.status,
        [],
      );
    }

    // The fallback name, for a `Content-Disposition` the browser cannot see (a
    // backend whose proxy predates the Expose header). The route byte-sniffs
    // the real type and names the real file.
    //
    // ⚠️ The extension follows the RESPONSE's `Content-Type`, never the
    // requested `formato`: Shopee may answer a zpl2 request with a PDF (R-u),
    // and a PDF saved as `.zip` is ML #1680's defect. `Content-Type` is
    // CORS-safelisted, so it is readable exactly when the disposition is not.
    // The `formato` guess is left only for a type the route never serves
    // (absent, or not one of its three).
    const extensao =
      (essencia === null ? undefined : EXTENSAO_DA_ETIQUETA.get(essencia)) ??
      (p.formato === 'pdf' ? 'pdf' : 'zip');
    return {
      tipo: 'arquivo',
      blob,
      filename:
        filenameFromDisposition(res.headers.get('content-disposition')) ??
        `etiqueta-${p.pedidoId}.${extensao}`,
      contentType: contentType ?? (p.formato === 'pdf' ? 'application/pdf' : 'application/zip'),
    };
  }

  return {
    oauthStart: (integracaoId) =>
      call(
        `/api/marketplace/shopee/oauth/start?integracaoId=${encodeURIComponent(integracaoId)}`,
        oauthStartResponseSchema,
      ),
    conta: (integracaoId) =>
      call(
        `/api/marketplace/shopee/conta?integracaoId=${encodeURIComponent(integracaoId)}`,
        shopeeContaStatusSchema,
      ),
    etiqueta,
    reclamacaoEstado: (input) =>
      call(
        `${RECLAMACAO_ESTADO_PATH}?integracaoId=${encodeURIComponent(input.integracaoId)}` +
          `&returnSn=${encodeURIComponent(input.returnSn)}`,
        shopeeReclamacaoEstadoSchema,
      ),
    reclamacaoAcao: (input) =>
      call(RECLAMACAO_ACAO_PATH, shopeeReclamacaoAcaoRespostaSchema, corpoDaReclamacao(input)),
    // The four step-18 reads: GETs, no body (W18 — only a call WITH a body is a
    // POST), every parameter percent-encoded, each body parsed against its
    // schema by the shared `call()`.
    categorias: (input) =>
      call(
        `${CATEGORIAS_PATH}?${consulta({
          integracaoId: input.integracaoId,
          categoryId: input.categoryId ?? undefined,
        })}`,
        respostaCategoriasShopeeSchema,
      ),
    limites: (input) =>
      call(
        `${LIMITES_PATH}?${consulta({
          integracaoId: input.integracaoId,
          categoryId: input.categoryId,
        })}`,
        respostaLimitesShopeeSchema,
      ),
    tabelaMedidasLista: (input) =>
      call(
        `${TABELA_MEDIDAS_LISTA_PATH}?${consulta({
          integracaoId: input.integracaoId,
          categoryId: input.categoryId,
        })}`,
        listaTabelasMedidasDtoSchema,
      ),
    tabelaMedidasDetalhe: (input) =>
      call(
        `${TABELA_MEDIDAS_DETALHE_PATH}?${consulta({
          integracaoId: input.integracaoId,
          sizeChartId: input.sizeChartId,
        })}`,
        detalheTabelaMedidasDtoSchema,
      ),
    // Step 21: every POST body rebuilt BY NAME (an absent optional key OMITTED,
    // a caller's stray key never forwarded); every GET's parameters through
    // `consulta()`. Only the three pushes forward a `signal`.
    enviarEstoque: (input) =>
      call(
        ENVIAR_ESTOQUE_PATH,
        envioEstoqueManualShopeeSchema,
        {
          integracaoId: input.integracaoId,
          produtoIds: input.produtoIds,
          reenviarComErro: input.reenviarComErro ?? false,
        },
        input.signal,
      ),
    enviarPrecos: (input) =>
      call(
        ENVIAR_PRECOS_PATH,
        envioPrecoManualShopeeSchema,
        {
          integracaoId: input.integracaoId,
          produtoIds: input.produtoIds,
          // ⚠️ `?? false`, and NO `incluirNaoPublicados` — the Shopee route reads
          // only `baixarPreco` (Mercado Livre's client sends both).
          baixarPreco: input.baixarPreco ?? false,
        },
        input.signal,
      ),
    definirStatusAnuncios: (input) =>
      call(
        ANUNCIO_STATUS_PATH,
        anuncioStatusShopeeSchema,
        {
          integracaoId: input.integracaoId,
          produtoIds: input.produtoIds,
          acao: input.acao,
          ...(input.linkDocId ? { linkDocId: input.linkDocId } : {}),
        },
        input.signal,
      ),
    publicar: (input) =>
      call(PUBLICAR_PATH, respostaPublicarShopeeSchema, corpoDaPublicacao(input)),
    reverificarAnuncio: (input) =>
      call(REVERIFICAR_ANUNCIO_PATH, respostaReverificarShopeeSchema, {
        integracaoId: input.integracaoId,
        produtoId: input.produtoId,
        ...(input.linkDocId ? { linkDocId: input.linkDocId } : {}),
      }),
    startMassImport: (input) =>
      call(IMPORTAR_TODOS_PATH, jobIdShopeeSchema, {
        integracaoId: input.integracaoId,
        // `options: null` is a 400 on the route — absent means the defaults.
        ...(input.options === undefined ? {} : { options: input.options }),
      }),
    massImportStatus: (input) =>
      call(
        `${IMPORTAR_TODOS_STATUS_PATH}?${consulta({
          integracaoId: input.integracaoId,
          jobId: input.jobId,
        })}`,
        massImportStatusShopeeSchema,
      ),
    cancelMassImport: (input) =>
      call(IMPORTAR_TODOS_CANCELAR_PATH, canceladoShopeeSchema, {
        integracaoId: input.integracaoId,
        jobId: input.jobId,
      }),
    startPriceSync: (input) =>
      call(ATUALIZAR_PRECOS_PATH, jobIdShopeeSchema, {
        integracaoId: input.integracaoId,
        baixarPreco: input.baixarPreco ?? false,
      }),
    priceSyncStatus: (input) =>
      call(
        `${ATUALIZAR_PRECOS_STATUS_PATH}?${consulta({
          integracaoId: input.integracaoId,
          jobId: input.jobId,
        })}`,
        priceSyncStatusShopeeSchema,
      ),
    cancelPriceSync: (input) =>
      call(ATUALIZAR_PRECOS_CANCELAR_PATH, canceladoShopeeSchema, {
        integracaoId: input.integracaoId,
        jobId: input.jobId,
      }),
    priceSyncHistorico: (input) =>
      call(
        `${ATUALIZAR_PRECOS_HISTORICO_PATH}?${consulta({
          integracaoId: input.integracaoId,
          limite: input.limite,
        })}`,
        priceSyncHistoricoShopeeSchema,
      ),
    priceSyncRelatorio: (input) =>
      call(
        `${ATUALIZAR_PRECOS_RELATORIO_PATH}?${consulta({
          integracaoId: input.integracaoId,
          jobId: input.jobId,
          depois: input.depois ?? undefined,
        })}`,
        priceSyncRelatorioPaginaShopeeSchema,
      ),
    // #1911: the three draft POSTs, each body rebuilt by name against the
    // route's own schema; each 2xx parsed with the route's own answer schema
    // (`call()` takes the create's 201 and its 200 alike). No `signal`: a
    // draft write the server goes on to finish must not read "unknown".
    criarRascunho: (input) =>
      call(RASCUNHO_PATH, respostaCriarRascunhoShopeeSchema, corpoDoRascunhoCriado(input)),
    atualizarRascunho: (input) =>
      call(
        RASCUNHO_ATUALIZAR_PATH,
        respostaAtualizarRascunhoShopeeSchema,
        corpoDoRascunhoAtualizado(input),
      ),
    descartarRascunho: (input) =>
      call(
        RASCUNHO_DESCARTAR_PATH,
        respostaDescartarRascunhoShopeeSchema,
        corpoDoRascunhoDescartado(input),
      ),
    recomendacaoCategoria: (input) =>
      call(
        `${RECOMENDACAO_CATEGORIA_PATH}?${consulta({
          integracaoId: input.integracaoId,
          nome: input.nome,
        })}`,
        respostaRecomendacaoCategoriaShopeeSchema,
      ),
    limitesDoItem: (input) =>
      call(
        `${LIMITES_PATH}?${consulta({
          integracaoId: input.integracaoId,
          categoryId: input.categoryId ?? undefined,
        })}`,
        respostaLimitesDoItemShopeeSchema,
      ),
    atributos: (input) =>
      call(
        `${ATRIBUTOS_PATH}?${consulta({
          integracaoId: input.integracaoId,
          categoryId: input.categoryId,
        })}`,
        respostaAtributosShopeeSchema,
      ),
    marcas: (input) =>
      call(
        `${MARCAS_PATH}?${consulta({
          integracaoId: input.integracaoId,
          categoryId: input.categoryId,
          offset: input.offset,
          pageSize: input.pageSize,
          status: input.status,
        })}`,
        respostaMarcasShopeeSchema,
      ),
    variacoes: (input) =>
      call(
        `${VARIACOES_PATH}?${consulta({
          integracaoId: input.integracaoId,
          categoryId: input.categoryId,
        })}`,
        respostaVariacoesShopeeSchema,
      ),
  };
}

export function useShopeeClient(): ShopeeClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_SHOPEE_URL ?? DEFAULT_SHOPEE_URL;
    return createShopeeClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
