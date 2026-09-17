/**
 * **The two listing pushes** (#1519, step 11) — `push 16`
 * (`violation_item_push`, push_api_id 18) and `push 27`
 * (`item_scheduled_publish_failed_push`, push_api_id 30) become ONE link-document
 * patch and, at most, ONE aviso.
 *
 * Two codes, one destino, for the shipment arm's reason: they differ only in what
 * happened, both name an ITEM, and both are answered by one
 * `get_item_base_info` for that item.
 *
 * ## ⚠️ The push is a POINTER, never a payload
 *
 * {@link alvoDoPushDeAnuncio} lifts the `item_id`, code 27's scheduled instant
 * and three BOOLEANS. It lifts no `item_status`, no `deboost` and no detail row
 * as data: the handler re-reads `get_item_base_info` and writes THAT
 * (`guide 18`: a push "only notifies you that data for the specific event has
 * changed"; `guide 746` in the local voice). That is what makes a replayed or
 * out-of-order delivery idempotent — a re-read of the same listing produces the
 * same patch — and it is the whole legacy defect, three ways over: the legacy
 * looked the link up by a **global, un-conta-scoped** `item_id` query, guarded it
 * with a last-write-wins timestamp, and then wrote the hardcoded string
 * `"UNLIST"` that the push never carried. This handler is conta-scoped by the
 * DECLARED composite ({@link resolverLinkPorItemId}), has no timestamp guard
 * because it re-fetches instead, and writes only what it READ.
 *
 * The ONE exception is the fallback in step 3 below: when the violation PULL
 * refuses, the push's own detail rows are used, because the pull is *less*
 * authoritative on a moving item, not more — and even there the STATUS still
 * comes from the base-info read.
 *
 * ## ⚠️ NO clock, and no microsecond
 *
 * `nowMs` and the push's own stamps arrive as parameters; nothing under
 * `lib/shopee/anuncios/` reads the ambient clock (a raw-text test over this whole
 * directory pins it, comments included). Every number in this file is
 * MILLISECONDS; the aviso's µs seam lives in `avisos/autorizacao.ts` and is
 * reached only through `avisoAnuncio.ts`.
 *
 * ## ⚠️ It converts NO wire failure into a disposition
 *
 * `rastrearPedido.ts`'s rule verbatim: the error → `throw`/`defer`/`park` table
 * belongs to the notification arm, where the pipeline's vocabulary lives. Here
 * every error propagates untouched except the two narrows this module owns —
 * `error_item_not_found` on the base-info read (which IS this listing's verdict)
 * and the best-effort violation pull.
 *
 * ## ⚠️ Neither handler enqueues anything
 *
 * There is no synthetic-push machinery for an item push and none is needed:
 * `get_item_violation_info` is a PULL, so a violation backstop is a direct call
 * rather than a synthesized code 16 — and a synthetic one would collide on the
 * derived doc id anyway.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { wireInt } from '@delfrance/core/wire';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';
import type { ResultadoAviso } from '@delfrance/data/admin/avisos';
import {
  ESTADO_ANUNCIO_SHOPEE,
  type EstadoAnuncioShopee,
  type ShopeeViolacao,
} from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  shopeeCodeSemPrefixoDeModulo,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
  type ShopeeItemViolationRow,
} from '@delfrance/integrations-shopee';

import { loadShopeeContext } from '../core/shopee';
import { itemStatusDeLink } from '../produtos/mapeamento';
import { itemStatusDe, montarItemLido, type ItemLido } from '../produtos/itemLido';
import {
  MOTIVO_AVISO_ANUNCIO,
  MOTIVO_RESOLUCAO_ANUNCIO,
  avisarAnuncioComViolacao,
  resolverAvisoDeAnuncio,
  type MotivoAvisoAnuncio,
} from './avisoAnuncio';
import { resolverLinkPorItemId, type LinkDeAnuncio } from './linkAnuncio';
import { agendadoParaMsDe, estadoDoAnuncio, type LeituraDeAnuncio } from './statusAnuncio';
import {
  detalhesDeDeboost,
  detalhesDeStatus,
  grafiaDeboostUsada,
  violacoesDeDetalhes,
} from './violacoesAnuncio';

/** Shopee's own code for "no such item", on the batch envelope. */
const CODIGO_ITEM_NAO_ENCONTRADO = 'error_item_not_found';

/** The one log tag of this module, so a test can separate it from the aviso's. */
const TAG_LOG = '[shopee/anuncios] entrega de anúncio';

/* -------------------------------------------------------------------------- */
/*                          the parser (pure, total)                          */
/* -------------------------------------------------------------------------- */

/**
 * What a listing push CLAIMS, for the one log line and for nothing else.
 *
 * ⚠️ Booleans only. `push 18` carries `item_status`, `deboost` and the detail
 * arrays, and not one of them reaches a Firestore patch through this record —
 * which is what makes two contradicting deliveries about one listing produce
 * byte-identical writes.
 */
export interface DiagnosticoPushDeAnuncio {
  /** `item_status_details[]` carried at least one row. */
  readonly temDetalhesDeStatus: boolean;
  /** Either deboost spelling carried at least one row. */
  readonly temDetalhesDeDeboost: boolean;
  /**
   * The body used the SAMPLE spelling `deboosted_details` rather than the
   * parameter table's `deboost_details`.
   *
   * ⚠️ Push 18's own page contradicts itself here — the table says one, its
   * sample 3 prints the other — so the reader accepts BOTH
   * ({@link grafiaDeboostUsada}) and this boolean is the only record of which
   * arrived. It costs nothing and it is the only way anyone will ever learn which
   * spelling the live BR wire uses.
   */
  readonly grafiaDeboosted: boolean;
}

/**
 * What the `anuncio` arm needs off a push, or why it cannot act.
 *
 * ⚠️ `motivo` carries field PATHS and fixed prose only — never a value and never
 * a body (#1015). A parked row is read by an operator.
 */
export type AlvoDoPushDeAnuncio =
  | {
      readonly ok: true;
      readonly itemId: number;
      readonly code: number;
      /**
       * Code 27 only: the push's `scheduled_publish_time` in MILLISECONDS.
       * `null` on code 16 and on a code 27 that carried no usable schedule.
       */
      readonly agendadoParaMs: number | null;
      readonly diagnostico: DiagnosticoPushDeAnuncio;
    }
  | { readonly ok: false; readonly motivo: string };

/** `violation_item_push`. */
const CODE_VIOLACAO = 16;
/** `item_scheduled_publish_failed_push`. */
const CODE_AGENDAMENTO = 27;

/**
 * The `data` of both listing pushes, as far as this parser reads it.
 *
 * ⚠️ `wireInt()` and not `z.number()`: a push body reaches us as raw JSON that no
 * operation schema has coerced, and a serializer that quotes ONE field must not
 * cost the resource (#1087). Both members are `.catch(null)`, so no FIELD can
 * fail the parse — the only refusal is an unusable `item_id`, which is an
 * IDENTITY.
 *
 * ⚠️ `shop_id` is deliberately NOT declared. Push 18 carries it on the ENVELOPE
 * only while push 30 carries it twice (inside `data` AND on the envelope), so a
 * parser that read it here would be guessing at a uniform shape neither page
 * promises. The arm lifts it from `payload.shopId`, which
 * `parseNotificationBody` already resolves across four placements.
 */
const dataDePushDeAnuncioSchema = z
  .object({
    item_id: wireInt().nullable().catch(null),
    /** SECONDS on the wire, code 27 only. */
    scheduled_publish_time: wireInt().nullable().catch(null),
  })
  .passthrough();

/**
 * One listing push → the item it points at, or a readable refusal.
 *
 * Codes 16 and 27 only: `DISPATCH` routes exactly those two here, so a third is
 * unreachable today and a visible terminal row the day that stops.
 *
 * ⚠️ `item_id` is REQUIRED on both codes (both pages declare it) and a
 * NON-POSITIVE one is refused with the absent ones: Shopee zero-fills an absent
 * numeric on this wire, and `0` reaching {@link resolverLinkPorItemId} would run
 * a conta-scoped query for a stored `item_id: 0` — a link that binds no listing
 * (`produtoResolve.ts`'s own `model_id: 0` trap, one collection over).
 */
export function alvoDoPushDeAnuncio(
  code: number,
  data: Record<string, unknown>,
): AlvoDoPushDeAnuncio {
  if (code !== CODE_VIOLACAO && code !== CODE_AGENDAMENTO) {
    return { ok: false, motivo: 'push_code inesperado no braço de anúncio' };
  }

  const lido = dataDePushDeAnuncioSchema.safeParse(data);
  // Unreachable while every member is `.catch(null)` — a non-object `data`
  // is the one input that can fail — and it answers the same refusal rather
  // than throwing on the push path.
  if (!lido.success) return { ok: false, motivo: 'data inválido no push de anúncio' };

  const itemId = lido.data.item_id;
  if (itemId === null || itemId <= 0) {
    return { ok: false, motivo: 'push de anúncio sem item_id — nada a resolver' };
  }

  return {
    ok: true,
    itemId,
    code,
    // ⚠️ Code 27 ONLY. Push 18 documents no schedule, and lifting one from a body
    // that is not supposed to carry it would stamp `agendamentoFalhouEm` from a
    // field nobody can source.
    agendadoParaMs:
      code === CODE_AGENDAMENTO ? agendadoParaMsDe(lido.data.scheduled_publish_time) : null,
    diagnostico: diagnosticoDe(data),
  };
}

/** The three booleans, through wave 4's ONE reader of the two spellings. */
function diagnosticoDe(data: Record<string, unknown>): DiagnosticoPushDeAnuncio {
  const grafia = grafiaDeboostUsada(data);
  return {
    temDetalhesDeStatus: detalhesDeStatus(data).length > 0,
    temDetalhesDeDeboost: grafia !== null,
    grafiaDeboosted: grafia === 'deboosted_details',
  };
}

/* -------------------------------------------------------------------------- */
/*                               the contract                                 */
/* -------------------------------------------------------------------------- */

/**
 * What one delivery DID. Six members, and every one is producible.
 *
 * ⚠️ `anuncio-normalizado` is "the delivery reported nothing wrong", which is
 * WIDER than "the aviso was closed": a listing that reads `em_revisao` with no
 * violation rows is not selling, so its row is left exactly as it stands and
 * `avisoResolvido` answers `false`. Only a LIVE, clean reading closes a row —
 * see {@link tratarPushDeAnuncio}.
 */
export type AcaoPushAnuncio =
  | 'violacao-registrada'
  | 'deboost-registrado'
  | 'anuncio-normalizado'
  | 'agendamento-registrado'
  | 'ignorado-removido'
  | 'ignorado-sem-vinculo';

/** Named members of {@link AcaoPushAnuncio} — read by the arm and the task log. */
export const ACAO_PUSH_ANUNCIO = {
  violacaoRegistrada: 'violacao-registrada',
  deboostRegistrado: 'deboost-registrado',
  anuncioNormalizado: 'anuncio-normalizado',
  agendamentoRegistrado: 'agendamento-registrado',
  ignoradoRemovido: 'ignorado-removido',
  ignoradoSemVinculo: 'ignorado-sem-vinculo',
} as const satisfies Record<string, AcaoPushAnuncio>;

/** One delivery, as the arm hands it over. */
export interface AlvoDePushDeAnuncioShopee {
  readonly integracaoId: string;
  /** LOGGED only — the conta was already resolved from it by the arm. */
  readonly shopId: number;
  readonly itemId: number;
  readonly code: number;
  /** Code 27's scheduled instant, MILLISECONDS. See {@link AlvoDoPushDeAnuncio}. */
  readonly agendadoParaMs: number | null;
  /** The task's ONE clock read, MILLISECONDS. */
  readonly nowMs: number;
  readonly diagnostico: DiagnosticoPushDeAnuncio;
  /**
   * The push ENVELOPE's own timestamp, MILLISECONDS — the aviso's
   * `relogioEvento`.
   *
   * ⚠️ `null` means the delivery carried none, and it is then OMITTED from the
   * aviso rather than passed as `null`: an absent optional leaves the stored
   * watermark alone, while a `null` RESETS it, and a reset watermark is a guard
   * that never rejects anything again (root `CLAUDE.md` rule 7, tier 2).
   */
  readonly carimboMs: number | null;
  /**
   * The two detail arrays, RAW, for the violation-pull FALLBACK only.
   *
   * ⚠️ Nothing else on this record is wire data, and these two are used only
   * when `get_item_violation_info` refuses. The STATUS never comes from here.
   */
  readonly detalhesDoPush: {
    readonly status: readonly unknown[];
    readonly deboost: readonly unknown[];
  };
}

export interface ResultadoPushAnuncio {
  readonly kind: 'anuncio';
  readonly acao: AcaoPushAnuncio;
  readonly itemId: number;
  /** `null` ONLY on `ignorado-sem-vinculo`. */
  readonly produtoId: string | null;
  readonly estadoAnuncio: EstadoAnuncioShopee | null;
  readonly deboost: boolean;
  /** A COUNT, never a body. */
  readonly violacoes: number;
  /** `false` when the violation pull refused, or was never made (code 27). */
  readonly violacoesLidas: boolean;
  readonly avisoResultado: ResultadoAviso | null;
  /** A TRANSITION: `true` only when a row was OPEN and this delivery closed it. */
  readonly avisoResolvido: boolean;
  /** A short machine-readable tail for the log filter. */
  readonly detail: string;
}

export interface TratarPushDeAnuncioDeps {
  /**
   * The client seam. Default: `loadShopeeContext(db, id).createShopClient()` —
   * the same chain every other handler uses, and the token rides as a FUNCTION so
   * one that lapses mid-batch is renewed rather than replayed dead.
   */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /** `(by) => FieldValue.increment(by)` — the aviso occurrence sentinel. */
  readonly increment?: (by: number) => unknown;
}

async function clienteShopee(
  db: Firestore,
  integracaoId: string,
  deps: TratarPushDeAnuncioDeps,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/* -------------------------------------------------------------------------- */
/*                            the authoritative read                          */
/* -------------------------------------------------------------------------- */

/**
 * `get_item_base_info` for ONE id → the assembled record, or `null` when the
 * listing is not there.
 *
 * ⚠️ TWO shapes mean "not there" and both answer `null`: Shopee refusing the
 * whole (one-id) call with `error_item_not_found`, and a successful call carrying
 * no readable row for the id we asked for. The second covers the payload
 * schema's per-element `null` sentinel too — an illegible row is not a reading.
 *
 * ⚠️ The narrowing is `ShopeeApiError` + `kind === other` + the code, and it
 * accepts the MODULE-PREFIXED spelling through the package's one stripper: the
 * sandbox probe measured `product.error_param` arriving with the prefix on the
 * live wire, so comparing the bare code alone would rethrow a verdict this
 * handler owns. Everything else propagates (rule 6).
 */
async function lerBaseInfo(
  client: ShopeeClient,
  itemId: number,
): Promise<{ readonly item: ItemLido } | null> {
  let payload: ShopeeItemBaseInfo;
  try {
    payload = await client.getItemBaseInfo({ itemIds: [itemId] });
  } catch (err) {
    if (
      err instanceof ShopeeApiError &&
      err.kind === SHOPEE_ERROR_KIND.other &&
      (err.code === CODIGO_ITEM_NAO_ENCONTRADO ||
        shopeeCodeSemPrefixoDeModulo(err.code) === CODIGO_ITEM_NAO_ENCONTRADO)
    ) {
      return null;
    }
    throw err;
  }

  const temLinha = payload.item_list.some((linha) => linha !== null && linha.item_id === itemId);
  if (!temLinha) return null;

  // The SAME seam step 9's import uses, so the two directions read one listing
  // identically — and it reconciles by `item_id`, never by position.
  return { item: montarItemLido({ itemId, payload }) };
}

/** The reading the fold takes, from the row we just read. */
function leituraDe(item: ItemLido): LeituraDeAnuncio {
  return {
    kind: 'lido',
    // The RAW wire string, so the pre-2024 `DELETED` alias still folds to
    // `removido`. The WRITE uses `itemStatusDeLink`, which is the six-member
    // enum the link schema declares.
    itemStatus: itemStatusDe(item),
    deboost: item.base.deboost,
    agendadoParaMs: agendadoParaMsDe(item.base.scheduled_publish_time),
  };
}

/* -------------------------------------------------------------------------- */
/*                       the violation pull (best-effort)                     */
/* -------------------------------------------------------------------------- */

interface LeituraDeViolacoes {
  readonly violacoes: readonly ShopeeViolacao[];
  readonly descartadas: number;
  /** `false` ⇒ the rows are the PUSH's own, because the pull did not answer. */
  readonly lidas: boolean;
}

/** A per-row `fail_error` — this page's own, THIRD partial-failure encoding. */
function falhaDaLinha(linha: ShopeeItemViolationRow): string | null {
  const bruto = linha.fail_error;
  if (typeof bruto !== 'string') return null;
  return bruto.trim() === '' ? null : bruto;
}

/**
 * `get_item_violation_info` for ONE id, **best-effort** — and on any refusal the
 * PUSH's own detail rows stand in.
 *
 * Three refusal shapes, all the same verdict:
 *
 *  1. a `ShopeeApiError` of kind `other` — including the documented
 *     `error_param: item_status does not match latest violation`, and including
 *     this page's measured missing-`error` body, which surfaces as a schema
 *     failure rather than as data;
 *  2. a per-row `fail_error`, which is where this page puts a partial failure
 *     (`unlist_item` uses `success_list`/`failure_list`; there is deliberately no
 *     generic batch parser);
 *  3. no row for the id we asked for. Reconcile-by-id is this repo's rule on
 *     every batch page, and a row we never got is not an answer ABOUT this item.
 *
 * ⚠️ Using the push's rows here is the one place a push body is read as data, and
 * it is the honest one: the pull is *less* authoritative on a moving item, not
 * more, and the push's details are what Shopee sent about this very event. The
 * STATUS still comes from the base-info read.
 *
 * ⚠️ Only a `kind === 'other'` API error is caught. A rate limit, a reauth, a
 * network failure and a schema mismatch are not properties of this listing, so
 * they propagate and the arm classifies them (rule 6).
 */
async function lerViolacoes(
  client: ShopeeClient,
  alvo: AlvoDePushDeAnuncioShopee,
): Promise<LeituraDeViolacoes> {
  const doPush = (): LeituraDeViolacoes => {
    const { violacoes, descartadas } = violacoesDeDetalhes(
      alvo.detalhesDoPush.status,
      alvo.detalhesDoPush.deboost,
    );
    return { violacoes, descartadas, lidas: false };
  };

  let linha: ShopeeItemViolationRow | undefined;
  try {
    const info = await client.getItemViolationInfo({ itemIds: [alvo.itemId] });
    linha = info.item_list.find(
      (r): r is ShopeeItemViolationRow => r !== null && r.item_id === alvo.itemId,
    );
  } catch (err) {
    if (!(err instanceof ShopeeApiError) || err.kind !== SHOPEE_ERROR_KIND.other) throw err;
    // The CODE, never a body and never the provider's prose: `violation_reason`,
    // `suggestion` and `fail_message` are on the redaction denylist.
    console.warn('[shopee/anuncios] get_item_violation_info recusou; usando os detalhes do push', {
      integracaoId: alvo.integracaoId,
      itemId: alvo.itemId,
      code: alvo.code,
      shopeeCode: err.code,
    });
    return doPush();
  }

  if (linha === undefined) {
    console.warn('[shopee/anuncios] get_item_violation_info sem linha para o item', {
      integracaoId: alvo.integracaoId,
      itemId: alvo.itemId,
      code: alvo.code,
    });
    return doPush();
  }

  const falha = falhaDaLinha(linha);
  if (falha !== null) {
    console.warn('[shopee/anuncios] get_item_violation_info falhou NA LINHA', {
      integracaoId: alvo.integracaoId,
      itemId: alvo.itemId,
      code: alvo.code,
      failError: falha,
    });
    return doPush();
  }

  // ⚠️ ONE builder, shared with `reverificarAnuncio.ts`: the push and the pull
  // carry byte-identical detail objects, and a second copy of this mapping is the
  // drift shape (#1369).
  const corpo = linha as unknown as Record<string, unknown>;
  const { violacoes, descartadas } = violacoesDeDetalhes(
    detalhesDeStatus(corpo),
    detalhesDeDeboost(corpo),
  );
  return { violacoes, descartadas, lidas: true };
}

/* -------------------------------------------------------------------------- */
/*                                  the write                                 */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle write-back.
 *
 * ⚠️ **`mergeIfExists`, and the patch is FLAT** — scalars and arrays only. It is
 * `update()` plus a NOT_FOUND narrow, so a link an operator deleted meanwhile is
 * never resurrected, and it THROWS a `TypeError` on a nested plain object or a
 * dotted key. `ultimaPublicacao` and `falhaPublicacao` are nested objects and
 * belong to the publisher's `aplicarLinkDaListagem` → `merge` family (C15):
 * adding either here is a runtime failure, not a style question. `violations[]`
 * is an ARRAY and passes, and wholesale replacement is the intent.
 */
async function escreverLink(
  db: Firestore,
  link: LinkDeAnuncio,
  patch: Record<string, unknown>,
): Promise<void> {
  const escrito = await produtoShopeeLinkCollection.mergeIfExists(
    db,
    { produtoId: link.produtoId },
    link.linkDocId,
    patch,
  );
  if (!escrito) {
    console.warn('[shopee/anuncios] vínculo de listagem desapareceu antes da escrita', {
      produtoId: link.produtoId,
      linkDocId: link.linkDocId,
      campos: Object.keys(patch),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                                 the handler                                */
/* -------------------------------------------------------------------------- */

interface EfeitoDeAviso {
  readonly acao: AcaoPushAnuncio;
  readonly avisoResultado: ResultadoAviso | null;
  readonly avisoResolvido: boolean;
}

/**
 * One listing push → one link patch and at most one aviso.
 *
 * ## Code 16, in order
 *
 * 1. {@link resolverLinkPorItemId} on the DECLARED `prodshopee` composite.
 *    **Absent ⇒ `ignorado-sem-vinculo`**, `produtoId: null`, ZERO Shopee calls
 *    and ZERO writes; the arm parks naming the item, which is what tells an
 *    operator a listing exists at Shopee and should be imported.
 * 2. `get_item_base_info` — **the authoritative read**. Not there ⇒
 *    `ignorado-removido`: `{ estadoAnuncio: 'removido', violacoesLidasEm,
 *    ultimaModificacao }` and the aviso resolves with `anuncio-removido`.
 *    ⚠️ **No `item_status` is written on that arm**: the handler did not READ
 *    one, and writing a status it invented is precisely the legacy defect.
 * 3. `get_item_violation_info` — best-effort ({@link lerViolacoes}).
 * 4. The fold, then ONE flat patch:
 *    `{ item_status, estadoAnuncio, deboost, violations, violacoesLidasEm,
 *    ultimaModificacao }`. `item_status` comes from the READ, never from the push
 *    body.
 * 5. The aviso, exactly one of:
 *    - a `kind: 'status'` row, or `banido`/`removido` ⇒ raise `violacao` with the
 *      FIRST `violation_type` and the FIRST `fix_deadline_time`;
 *    - otherwise a `deboost` ⇒ raise `deboost`;
 *    - `ativo` && no deboost && no rows ⇒ **resolve** `anuncio-normalizado`.
 *      ⚠️ This arm exists because push 18 fires on deboost transitions in BOTH
 *      directions: a listing whose deboost lifted delivers a code 16 with
 *      `deboost: false`, and reading that as "nothing to do" leaves the aviso
 *      standing for ever.
 *    - anything else (a clean reading that is not live — `em_revisao`,
 *      `pausado`, `agendado`, `desconhecido`) ⇒ the patch lands and the aviso is
 *      left EXACTLY as it stands.
 *
 * ## Code 27, and what it can honestly say
 *
 * Same link resolution and the same authoritative read, then
 * `{ item_status, estadoAnuncio, deboost, agendamentoFalhouEm, ultimaModificacao }`
 * and an aviso with motivo `agendamento-falhou` and **no `prazo`**.
 *
 * ⚠️ **The push carries NO reason** — three fields in `data`, none of them an
 * error code or a message, and no page connects `add_item`'s error list to it. So
 * the aviso says exactly that and points at the listing; inventing a cause would
 * be worse than none. What `item_status` and `scheduled_publish_time` hold after
 * a failed scheduled publish is UNVERIFIED and load-bearing: whatever the read
 * says is written, and nothing is inferred.
 *
 * **Idempotence is by re-fetch.** A replayed delivery re-reads the same state,
 * produces an identical patch, and the aviso's own event-clock watermark answers
 * `ignorado`.
 */
export async function tratarPushDeAnuncio(
  db: Firestore,
  alvo: AlvoDePushDeAnuncioShopee,
  deps: TratarPushDeAnuncioDeps = {},
): Promise<ResultadoPushAnuncio> {
  const { integracaoId, itemId, code, nowMs } = alvo;

  const link = await resolverLinkPorItemId(db, integracaoId, itemId);
  if (link === null) {
    // ⚠️ ZERO Shopee calls: the ERP does not manage this listing, and the cheap
    // read comes FIRST for `rastrearPedido.ts`'s reason — the arm's re-drive
    // would otherwise spend one call per attempt for nothing.
    return registrar(alvo, {
      acao: ACAO_PUSH_ANUNCIO.ignoradoSemVinculo,
      produtoId: null,
      estadoAnuncio: null,
      deboost: false,
      violacoes: 0,
      descartadas: 0,
      violacoesLidas: false,
      avisoResultado: null,
      avisoResolvido: false,
      detail: `${ACAO_PUSH_ANUNCIO.ignoradoSemVinculo}:item ${String(itemId)} sem vínculo nesta conta`,
    });
  }

  const client = await clienteShopee(db, integracaoId, deps);
  const lido = await lerBaseInfo(client, itemId);

  if (lido === null) {
    // ONE arm for both codes: the fold's own `ausente` reading is `removido`, and
    // stamping `agendamentoFalhouEm` onto a listing Shopee no longer has would be
    // a stamp on a ghost.
    await escreverLink(db, link, {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      violacoesLidasEm: nowMs,
      ultimaModificacao: nowMs,
    });
    const resolvido = await resolverAvisoDeAnuncio(
      db,
      { integracaoId, produtoId: link.produtoId },
      MOTIVO_RESOLUCAO_ANUNCIO.removido,
      { nowMs },
    );
    return registrar(alvo, {
      acao: ACAO_PUSH_ANUNCIO.ignoradoRemovido,
      produtoId: link.produtoId,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      deboost: false,
      violacoes: 0,
      descartadas: 0,
      violacoesLidas: false,
      avisoResultado: null,
      avisoResolvido: resolvido,
      detail: `${ACAO_PUSH_ANUNCIO.ignoradoRemovido}:a Shopee não tem mais o item ${String(itemId)}`,
    });
  }

  const { estado, deboost } = estadoDoAnuncio(leituraDe(lido.item), nowMs);
  // ⚠️ From the READ, and folded to the six-member enum the link schema declares:
  // an `item_status` Shopee invents tomorrow costs ONE field (it stores `null`)
  // and `estadoAnuncio: 'desconhecido'` is the durable record of it.
  const itemStatus = itemStatusDeLink(lido.item);

  if (code === CODE_AGENDAMENTO) {
    await escreverLink(db, link, {
      item_status: itemStatus,
      estadoAnuncio: estado,
      deboost,
      // The instant the publish was DUE, as the push named it — not the delivery
      // clock, which rides `ultimaModificacao`. A newer code 27 supersedes an
      // older schedule whatever it carries, so this is a plain overwrite.
      agendamentoFalhouEm: alvo.agendadoParaMs,
      ultimaModificacao: nowMs,
    });
    const efeito = await levantar(db, alvo, link, {
      motivo: MOTIVO_AVISO_ANUNCIO.agendamentoFalhou,
      acao: ACAO_PUSH_ANUNCIO.agendamentoRegistrado,
      // ⚠️ No `violacaoTipo` and no `prazo`: the push carries neither, and
      // `avisoAnuncio.ts` supplies its own pt-BR phrase.
      violacaoTipo: null,
      prazoMs: null,
      deps,
    });
    return registrar(alvo, {
      ...efeito,
      produtoId: link.produtoId,
      estadoAnuncio: estado,
      deboost,
      violacoes: 0,
      descartadas: 0,
      // Code 27 makes no violation call at all — there is nothing to report and
      // the page would answer about a different question.
      violacoesLidas: false,
      detail: `${ACAO_PUSH_ANUNCIO.agendamentoRegistrado}:${estado}`,
    });
  }

  const leituraViolacoes = await lerViolacoes(client, alvo);
  const { violacoes, descartadas } = leituraViolacoes;

  await escreverLink(db, link, {
    // ⚠️ THE READ, never `data.item_status`. A push that says `BANNED` about a
    // listing the pull reads as `NORMAL` writes `NORMAL`.
    item_status: itemStatus,
    estadoAnuncio: estado,
    deboost,
    violations: [...violacoes],
    violacoesLidasEm: nowMs,
    ultimaModificacao: nowMs,
  });

  const efeito = await efeitoDaViolacao(db, alvo, link, {
    estado,
    deboost,
    violacoes,
    deps,
  });

  return registrar(alvo, {
    ...efeito,
    produtoId: link.produtoId,
    estadoAnuncio: estado,
    deboost,
    violacoes: violacoes.length,
    descartadas,
    violacoesLidas: leituraViolacoes.lidas,
    detail: `${efeito.acao}:${estado}`,
  });
}

/**
 * Which aviso a code-16 reading deserves — ONE row, one motivo.
 *
 * ⚠️ **`violacao` WINS over `deboost` when both hold.** Design W1 §8.4 lists the
 * deboost arm first and the two arms genuinely overlap (a `BANNED` delivery may
 * carry `deboost: true`), so one of them has to take precedence and the choice is
 * not cosmetic: the motivo picks the operator's REMEDY — a violation is fixed in
 * Seller Centre, a deboost by moving the listing's category — and labelling a
 * takedown "rebaixamento na busca" sends them to the wrong place while the
 * listing is dead. Over-naming a demotion as a violation is the cheap direction;
 * under-naming a takedown is not.
 */
async function efeitoDaViolacao(
  db: Firestore,
  alvo: AlvoDePushDeAnuncioShopee,
  link: LinkDeAnuncio,
  p: {
    readonly estado: EstadoAnuncioShopee;
    readonly deboost: boolean;
    readonly violacoes: readonly ShopeeViolacao[];
    readonly deps: TratarPushDeAnuncioDeps;
  },
): Promise<EfeitoDeAviso> {
  const derrubado =
    p.estado === ESTADO_ANUNCIO_SHOPEE.banido || p.estado === ESTADO_ANUNCIO_SHOPEE.removido;
  const temStatus = p.violacoes.some((v) => v.kind === 'status');
  const primeira = p.violacoes[0] ?? null;

  if (derrubado || temStatus) {
    return levantar(db, alvo, link, {
      motivo: MOTIVO_AVISO_ANUNCIO.violacao,
      acao: ACAO_PUSH_ANUNCIO.violacaoRegistrada,
      // The FIRST `violation_type` only — never `violation_reason` and never
      // `suggestion`, which are provider PROSE about a seller's listing and are
      // on the redaction denylist. `params` renders straight into the inbox.
      violacaoTipo: primeira?.violation_type ?? null,
      // ALREADY MILLISECONDS (`violacoesAnuncio.ts` converted it once). Never
      // multiplied again, and `null` is a legitimate reading: push 16 documents
      // the field as "Empty if no deadline".
      prazoMs: primeira?.fix_deadline_time ?? null,
      deps: p.deps,
    });
  }

  if (p.deboost) {
    return levantar(db, alvo, link, {
      motivo: MOTIVO_AVISO_ANUNCIO.deboost,
      acao: ACAO_PUSH_ANUNCIO.deboostRegistrado,
      violacaoTipo: null,
      prazoMs: primeira?.fix_deadline_time ?? null,
      deps: p.deps,
    });
  }

  if (p.estado === ESTADO_ANUNCIO_SHOPEE.ativo && p.violacoes.length === 0) {
    const resolvido = await resolverAvisoDeAnuncio(
      db,
      { integracaoId: alvo.integracaoId, produtoId: link.produtoId },
      MOTIVO_RESOLUCAO_ANUNCIO.normalizado,
      { nowMs: alvo.nowMs },
    );
    return {
      acao: ACAO_PUSH_ANUNCIO.anuncioNormalizado,
      avisoResultado: null,
      avisoResolvido: resolvido,
    };
  }

  // A clean reading that is not LIVE — `em_revisao` above all, which is exactly
  // where a listing sits between a seller's fix and Shopee's decision. The patch
  // has landed; closing the row would tell the operator the problem went away
  // while the listing is still not selling.
  return {
    acao: ACAO_PUSH_ANUNCIO.anuncioNormalizado,
    avisoResultado: null,
    avisoResolvido: false,
  };
}

/** Raise (or refresh) the one aviso row, with the shared µs-free seam. */
async function levantar(
  db: Firestore,
  alvo: AlvoDePushDeAnuncioShopee,
  link: LinkDeAnuncio,
  p: {
    readonly motivo: MotivoAvisoAnuncio;
    readonly acao: AcaoPushAnuncio;
    readonly violacaoTipo: string | null;
    readonly prazoMs: number | null;
    readonly deps: TratarPushDeAnuncioDeps;
  },
): Promise<EfeitoDeAviso> {
  const { resultado } = await avisarAnuncioComViolacao(
    db,
    {
      integracaoId: alvo.integracaoId,
      // ⚠️ The PRODUTO id is the aviso entity, never the `item_id`: a listing
      // republished under a new id has to collapse onto the row the operator
      // already knows.
      produtoId: link.produtoId,
      itemId: alvo.itemId,
      motivo: p.motivo,
      violacaoTipo: p.violacaoTipo,
      prazoMs: p.prazoMs,
      // Spread-or-nothing — see `AlvoDePushDeAnuncioShopee.carimboMs`.
      ...(alvo.carimboMs === null ? {} : { relogioEventoMs: alvo.carimboMs }),
    },
    {
      increment: p.deps.increment ?? ((by: number) => FieldValue.increment(by)),
      nowMs: alvo.nowMs,
    },
  );
  return { acao: p.acao, avisoResultado: resultado, avisoResolvido: false };
}

/* -------------------------------------------------------------------------- */
/*                                  the log                                   */
/* -------------------------------------------------------------------------- */

interface LinhaDeResultado extends EfeitoDeAviso {
  readonly produtoId: string | null;
  readonly estadoAnuncio: EstadoAnuncioShopee | null;
  readonly deboost: boolean;
  readonly violacoes: number;
  readonly descartadas: number;
  readonly violacoesLidas: boolean;
  readonly detail: string;
}

/**
 * EXACTLY ONE `console.info` per delivery, then the result.
 *
 * ⚠️ Ids, counts, enum tokens and BOOLEANS only — never a value from the body.
 * No `violation_type`, no `item_name`, no deadline: the three prose fields are on
 * the wire-fixture redaction denylist and a task log is not the place to
 * rediscover them. The refusal warns in {@link lerViolacoes} carry a Shopee CODE
 * and nothing else.
 *
 * ⚠️ `divergePushVsPull` is the only thing this line adds that nothing else sees:
 * the push CLAIMED detail rows and the reading we ended up with disagrees about
 * whether there are any. It is a boolean over PRESENCE, because no value from the
 * push is ever lifted — which is the whole design.
 */
function registrar(alvo: AlvoDePushDeAnuncioShopee, r: LinhaDeResultado): ResultadoPushAnuncio {
  const claimou = alvo.diagnostico.temDetalhesDeStatus || alvo.diagnostico.temDetalhesDeDeboost;
  const temLinhas = r.violacoes > 0;
  // eslint-disable-next-line no-console -- expected on every healthy delivery; a warn nobody can act on is what hides the real ones
  console.info(TAG_LOG, {
    integracaoId: alvo.integracaoId,
    shopId: alvo.shopId,
    itemId: alvo.itemId,
    code: alvo.code,
    produtoId: r.produtoId,
    acao: r.acao,
    estadoAnuncio: r.estadoAnuncio,
    deboost: r.deboost,
    violacoes: r.violacoes,
    descartadas: r.descartadas,
    violacoesLidas: r.violacoesLidas,
    temDetalhesDeStatus: alvo.diagnostico.temDetalhesDeStatus,
    temDetalhesDeDeboost: alvo.diagnostico.temDetalhesDeDeboost,
    grafiaDeboosted: alvo.diagnostico.grafiaDeboosted,
    divergePushVsPull: claimou !== temLinhas,
    agendadoParaMs: alvo.agendadoParaMs,
    temCarimbo: alvo.carimboMs !== null,
    avisoResultado: r.avisoResultado,
    avisoResolvido: r.avisoResolvido,
  });

  return {
    kind: 'anuncio',
    acao: r.acao,
    itemId: alvo.itemId,
    produtoId: r.produtoId,
    estadoAnuncio: r.estadoAnuncio,
    deboost: r.deboost,
    violacoes: r.violacoes,
    violacoesLidas: r.violacoesLidas,
    avisoResultado: r.avisoResultado,
    avisoResolvido: r.avisoResolvido,
    detail: r.detail,
  };
}
