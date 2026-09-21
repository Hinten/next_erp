/**
 * **Pause / re-list a selection of Shopee listings** (#1519, step 11 — S10).
 *
 * One operator action — the produto's Shopee tab naming ONE listing, or a
 * selection from the produtos table — becomes at most three Shopee calls: one
 * `unlist_item` for the whole accepted batch, a per-entry `update_item` fallback
 * for the re-list door Shopee refused, and ONE `get_item_base_info` read-back.
 *
 * The envelope is field-for-field the one `apps/mercado-livre`'s
 * `anuncios/anuncioStatusManual.ts` answers, with `canal: 'shopee'`: that file's
 * own header says the shape exists so a second marketplace's
 * `POST /api/marketplace/<canal>/anuncio-status` can answer the same way, and
 * `apps/web`'s channel registry says adding a channel is one provider file, one
 * backend route and one row there. The route lands in step 11, the row in
 * step 21.
 *
 * ## ⚠️ `membros` is ALWAYS `null`
 *
 * Mercado Livre carries it because a User-Products listing is a family of N
 * items moved one by one. Shopee has no families: `unlist_item` is item-level
 * and `model_status` is read-only for BR, so there is no per-variation pause.
 * The key is kept so the envelope stays byte-compatible with what the web
 * registry expects, and its permanent `null` is documented rather than silently
 * omitted.
 *
 * ## ⚠️ The pre-check is a cheap FILTER on a possibly-stale reading, never the guard
 *
 * `podeMoverAnuncioShopee` (`@delfrance/schemas`) is the SAME predicate
 * `apps/web` renders the button from — a second copy here is the failure #1239
 * and #786 were extracted to avoid. It runs against what we last STORED, so it
 * is a SKIP that saves a call, and Shopee's own `failure_list` is the authority:
 * roughly half the promotion types refuse an unlist, an UPCOMING promotion locks
 * as hard as a running one, and `get_item_base_info.has_promotion` is
 * ongoing-only — so no pre-check can see the case that refuses most often.
 * ⚠️ `estadoAnuncio === null` (every link step 9 imported) is NOT skipped.
 *
 * ## ⚠️ `item_status` comes from the READ-BACK, never from `success_list[].unlist`
 *
 * That field echoes the REQUESTED flag; it is not a status (the package's own
 * `unlistItem` docblock says so, and a re-list answers `unlist: false` on
 * success). Mercado Livre's rule is the same one from the other side — the
 * write-back records the PROVIDER's answer, never our request — except that here
 * the answer is not a listing, so the write-back needs a second call. An
 * accepted id ABSENT from that read-back is a `falha`, and NOTHING is written for
 * it: claiming `enviado` without a reading is claiming a state nobody observed.
 *
 * ## ⚠️ Two doors, ONE literal, and never a third attempt
 *
 * {@link ordemDasPortas} derives the order from `RELIST_PRIMEIRO`
 * (`constantesAnuncio.ts`). A `pausar` has exactly ONE door — `unlist_item` —
 * because the only `item_status` this step ever sends is `NORMAL`. A `reativar`
 * has two, and an entry reaches the second one ONLY when the first refused it
 * with `error_set_normal_unlisted_item`; a promotion lock, a banned/reviewing
 * listing and holiday mode are TERMINAL and spend no second call. If both doors
 * refuse, the entry is `falha` carrying the LAST door's real code. There is no
 * other re-list API for a BR shop item.
 *
 * ## Writes (root `CLAUDE.md` rule 7)
 *
 * One `mergeIfExists` per link that produced a reading, with a **FLAT** patch —
 * `mergeIfExists` is `update()` plus a NOT_FOUND narrow and it THROWS on a
 * nested object, so `ultimaPublicacao` / `falhaPublicacao` can never ride this
 * path. `mergeIfExists` and never `merge`: the link may have been deleted between
 * the resolve and here, and an admin `merge` is an UPSERT that would resurrect it
 * as a ghost carrying only the patch keys. The three status fields have four
 * writers in step 11 and all four write only what they just READ — last read
 * wins, which is why the overlap is safe.
 *
 * ## What it does NOT do
 *
 * It touches no aviso. A re-listed item is not proof a violation lifted, and
 * pausing one is not a violation; the resolvers live on the READ paths
 * (`reverificarAnuncio.ts`, the push handlers, the publish read-back). It writes
 * no `item_name`, `category_id`, `attributes` or `logistic_info` either — those
 * belong to the import and the publisher.
 *
 * Clock-free and Next-free: `deps.nowMs` is the ONE clock read of the request and
 * arrives as a parameter, every Firestore access goes through a
 * `@delfrance/data/admin/collections` handle, and nothing here opens a
 * multi-document atomic write.
 *
 * **Cost**: 2 Firestore reads per requested produto (the produto document for
 * its name, the `prodshopee` subcollection for its link), ≤ 1 write per accepted
 * link, and ≤ 2 + N Shopee calls where N is the number of entries the re-list
 * door had to retry one by one.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_UNLIST_MAX_ITEMS,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeRateLimitError,
  shopeeCodeSemPrefixoDeModulo,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
} from '@delfrance/integrations-shopee';
import {
  ACAO_STATUS_ANUNCIO,
  ESTADO_ANUNCIO_SHOPEE,
  podeMoverAnuncioShopee,
  type AcaoStatusAnuncio,
  type EstadoAnuncioShopee,
} from '@delfrance/schemas';
import { produtoCollection, produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';

import { loadShopeeContext } from '../core/shopee';
import { itemStatusDe, montarItemLido, type ItemLido } from '../produtos/itemLido';
import { itemStatusDeLink } from '../produtos/mapeamento';
import { RELIST_PRIMEIRO } from './constantesAnuncio';
import { resolverLinkPorProduto, type LinkDeAnuncio } from './linkAnuncio';
import { agendadoParaMsDe, estadoDoAnuncio } from './statusAnuncio';

/* -------------------------------------------------------------------------- */
/*                               the envelope                                  */
/* -------------------------------------------------------------------------- */

export type AnuncioStatusOutcome = 'enviado' | 'pulado' | 'falha' | 'nao-tentado';

export interface AnuncioStatusListing {
  readonly produtoId: string;
  readonly produtoNome: string | null;
  /** `String(item_id)`, or `null` when this produto was never published. */
  readonly anuncioId: string | null;
  /** The ERP link doc id — the UI's key back into the produto's Shopee tab. */
  readonly linkDocId: string | null;
  readonly outcome: AnuncioStatusOutcome;
  /** Machine-readable; `null` only on `'enviado'`. */
  readonly motivo: string | null;
  /** Operator-facing pt-BR — always present, always safe to render. */
  readonly mensagem: string;
  /**
   * ⚠️ The raw `item_status` — **never the request**, and never `success_list[].unlist`.
   *
   * On a row that reached the read-back it is what the READ-BACK reported. On a
   * `pulado` / `nao-tentado` / `sem-leitura-apos` row nothing was read, so it is
   * the STORED reading (`statusArmazenado`) — the pre-action value, carried so the
   * panel has something to show for a row that changed nothing. `null` only when
   * the stored document held no usable string.
   *
   * ⚠️ So a caller rendering it as "what the listing is now" is right for an
   * attempted row and stale for a skipped one; the discriminator is `outcome`,
   * not this field. The shape is field-for-field parity with the ML envelope's
   * `linhaPulada`, which a test pins.
   */
  readonly statusFinal: string | null;
  readonly estadoAnuncio: EstadoAnuncioShopee | null;
  /** ⚠️ Permanently `null` — Shopee has no listing families. See the header. */
  readonly membros: null;
}

export interface AnuncioStatusSemAnuncio {
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly motivo: string;
  readonly mensagem: string;
}

export interface AnuncioStatusResponse {
  readonly canal: 'shopee';
  readonly integracaoId: string;
  readonly acao: AcaoStatusAnuncio;
  /** Deduped request size. */
  readonly solicitados: number;
  /**
   * Listings discovered. ⚠️ The ML envelope calls this "families"; Shopee has
   * none, and one produto resolves to at most ONE link here, so it is the count
   * of produtos that had an anúncio in this conta.
   */
  readonly familias: number;
  readonly resumo: {
    readonly aplicados: number;
    readonly pulados: number;
    readonly falhas: number;
    readonly naoTentados: number;
  };
  readonly listings: readonly AnuncioStatusListing[];
  readonly produtosSemAnuncio: readonly AnuncioStatusSemAnuncio[];
  /** ISO-8601 — set only when Shopee answered the DAILY quota. See {@link proximaViradaDaCotaMs}. */
  readonly pausadoAte: string | null;
}

export interface AnuncioStatusInput {
  readonly integracaoId: string;
  readonly produtoIds: readonly string[];
  readonly acao: AcaoStatusAnuncio;
  /**
   * Narrows the run to ONE listing — the produto tab's per-anúncio button. Only
   * meaningful with a single produtoId; the route enforces that and
   * {@link definirStatusAnunciosShopee} asserts it.
   */
  readonly linkDocId?: string | null;
}

export interface PausarAnuncioDeps {
  /**
   * The client seam. Default: `loadShopeeContext(db, id).createShopClient()` —
   * the chain every other Shopee path uses, with the token riding as a FUNCTION
   * so one that lapses mid-batch is renewed rather than replayed dead.
   */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /**
   * The avisos counter seam, supplied by the caller that can make the runtime
   * `firebase-admin` import. ⚠️ **Unused today, and deliberately required**: this
   * module writes no aviso (see the header), and the day one of its outcomes
   * earns one the dep is already on every call site instead of being a signature
   * change across the route, the CLI and their tests.
   */
  readonly increment: (by: number) => unknown;
  /** The ONE clock read of this request, in MILLISECONDS. */
  readonly nowMs: number;
}

/* -------------------------------------------------------------------------- */
/*                            the motivo vocabulary                            */
/* -------------------------------------------------------------------------- */

/**
 * Every motivo this module produces, ONE spelling each.
 *
 * The first seven are `MotivoAnuncioNaoMovivel`'s members, re-stated here as KEYS
 * so {@link MENSAGEM_POR_MOTIVO} can be exhaustive over them; the rest are this
 * module's own. ⚠️ A motivo is NOT persisted — it rides the response — so there
 * is no schema enum to reach for, and this const is what stops a slug being
 * written twice with one typo.
 */
export const MOTIVO_STATUS_ANUNCIO = {
  semItemId: 'sem-item-id',
  anuncioRemovido: 'anuncio-removido',
  anuncioBanido: 'anuncio-banido',
  anuncioEmRevisao: 'anuncio-em-revisao',
  anuncioAgendado: 'anuncio-agendado',
  jaPausado: 'ja-pausado',
  jaAtivo: 'ja-ativo',
  semAnuncio: 'sem-anuncio',
  bloqueadoPorPromocao: 'bloqueado-por-promocao',
  anuncioBanidoOuEmRevisao: 'anuncio-banido-ou-em-revisao',
  lojaEmFerias: 'loja-em-ferias',
  relistagemRecusada: 'relistagem-recusada',
  recusadoPelaShopee: 'recusado-pela-shopee',
  semLeituraApos: 'sem-leitura-apos',
  naoTentado: 'nao-tentado',
} as const;

/**
 * pt-BR for every reason a listing comes back unchanged. This run is the ONLY
 * surface where these reach a human, so each names the CAUSE **and** the REMEDY
 * — `anuncioStatusManual.ts`'s rule verbatim. None carries a Shopee body.
 *
 * ⚠️ Fifteen entries, not design-W1 §6.3's "nine": its own table already lists
 * twelve, and the three additions each have a producer in this file
 * (`relistagem-recusada` when a `pausar` somehow meets the re-list refusal and
 * there is no second door, `recusado-pela-shopee` for a `failed_reason` carrying
 * no code token at all, and `sem-anuncio`, whose narrowed variant is built at
 * the call site exactly as the ML module does).
 */
const MENSAGEM_POR_MOTIVO: Record<string, string> = {
  [MOTIVO_STATUS_ANUNCIO.semItemId]: 'Este produto ainda não foi publicado na Shopee.',
  [MOTIVO_STATUS_ANUNCIO.anuncioRemovido]:
    'A Shopee removeu este anúncio — depois da exclusão ela não aceita mais nenhuma alteração. ' +
    'Publique um novo anúncio para este produto.',
  [MOTIVO_STATUS_ANUNCIO.anuncioBanido]:
    'Anúncio banido pela Shopee: ela recusa pausar e reativar um anúncio banido. Corrija a ' +
    'violação no Seller Centre e aguarde a nova revisão.',
  [MOTIVO_STATUS_ANUNCIO.anuncioEmRevisao]:
    'Anúncio em revisão pela Shopee: ela recusa pausar e reativar enquanto revisa. Aguarde o ' +
    'resultado e tente de novo.',
  [MOTIVO_STATUS_ANUNCIO.anuncioAgendado]:
    'Este anúncio tem publicação agendada — reativar agora cancelaria o agendamento. Use ' +
    '"Pausar anúncio" para cancelar o agendamento, ou aguarde a data marcada.',
  [MOTIVO_STATUS_ANUNCIO.jaPausado]: 'Este anúncio já está pausado.',
  [MOTIVO_STATUS_ANUNCIO.jaAtivo]: 'Este anúncio já está ativo.',
  [MOTIVO_STATUS_ANUNCIO.semAnuncio]: 'Este produto não tem anúncio nesta conta Shopee.',
  [MOTIVO_STATUS_ANUNCIO.bloqueadoPorPromocao]:
    'A Shopee bloqueou a alteração porque o anúncio está em promoção — uma promoção AGENDADA ' +
    'bloqueia igual a uma em andamento. Encerre ou cancele a promoção no Seller Centre e tente ' +
    'de novo.',
  [MOTIVO_STATUS_ANUNCIO.anuncioBanidoOuEmRevisao]:
    'A Shopee recusou: anúncios banidos ou em revisão não podem ser pausados nem reativados. A ' +
    'leitura que tínhamos estava desatualizada — use "Reverificar anúncio" para atualizá-la.',
  [MOTIVO_STATUS_ANUNCIO.lojaEmFerias]:
    'A loja está em modo férias na Shopee. Desative o modo férias no Seller Centre antes de ' +
    'alterar anúncios.',
  [MOTIVO_STATUS_ANUNCIO.relistagemRecusada]:
    'A Shopee recusou reativar este anúncio por unlist_item e não havia uma segunda via para ' +
    'tentar. Reative o anúncio no Seller Centre.',
  [MOTIVO_STATUS_ANUNCIO.recusadoPelaShopee]:
    'A Shopee recusou a alteração sem informar um código que este ERP reconheça.',
  [MOTIVO_STATUS_ANUNCIO.semLeituraApos]:
    'A alteração foi enviada, mas a Shopee não devolveu o estado deste anúncio na releitura — ' +
    'nada foi gravado. Tente de novo, ou use "Reverificar anúncio".',
  [MOTIVO_STATUS_ANUNCIO.naoTentado]:
    'Não tentado — a Shopee atingiu a cota DIÁRIA de chamadas desta aplicação, que zera às ' +
    '00:00 (UTC+8). Se a aplicação estiver sob penalidade a cota fica reduzida por até 2 dias ' +
    'úteis, então tente de novo amanhã e abra um ticket na Open Platform se persistir.',
};

function mensagemDeMotivo(motivo: string): string {
  return MENSAGEM_POR_MOTIVO[motivo] ?? 'Anúncio não alterado.';
}

/* -------------------------------------------------------------------------- */
/*                      classifying one refused entry                          */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **All THREE spellings, two of them with typos Shopee will never fix.** A
 * predicate matching one of them matches a third of the cases, and
 * `faq 140` makes the promotion lock the most common refusal there is.
 */
const TOKENS_PROMOCAO = [
  'error_cannt_unlisted_in_promotion',
  'error_in_item_promotion_unlsit_lock',
  'error_unlist_in_promotion',
] as const;

/** "Banned and Reviewing Products cannot be delisted" — the pre-check's reading was stale. */
const TOKEN_BANIDO_OU_EM_REVISAO = 'error_busi_cannot_delist_reviewing_or_banned_item';

/**
 * ⚠️ Documented on `delete_item` and NOT on `unlist_item` — classified anyway,
 * because an error list that omits a code is not a promise it cannot arrive.
 */
const TOKEN_LOJA_EM_FERIAS = 'error_holiday_on_del_item';

/** The re-list door said no. The ONLY refusal that earns the second door. */
const TOKEN_RELISTAGEM_RECUSADA = 'error_set_normal_unlisted_item';

/**
 * A bare Shopee code at the START of the reason — how the unclassified motivo is
 * named, and the reason {@link razaoSemPrefixoDeModulo} is load-bearing rather
 * than decorative: `product.error_param` yields nothing here until the ONE module
 * segment is stripped.
 */
const RE_CODIGO_ANCORADO = /^error_[a-z0-9_]*/;

interface RecusaClassificada {
  readonly motivo: string;
  readonly mensagem: string;
  /** Only `error_set_normal_unlisted_item`. Everything else is terminal. */
  readonly tentarOutraPorta: boolean;
}

/**
 * Exactly ONE leading `<module>.` segment removed, through the PACKAGE's
 * stripper — there is one prefix stripper in this repo and it is not here.
 * Shopee prints the same code both ways, often on the same page: `unlist_item`'s
 * error list says `error_param` while its own Error example prints
 * `product.error_param`.
 */
function razaoSemPrefixoDeModulo(reason: string | null | undefined): string {
  const bruto = (reason ?? '').trim();
  if (bruto === '') return '';
  return shopeeCodeSemPrefixoDeModulo(bruto) ?? bruto;
}

/**
 * One `failure_list[].failed_reason` — or an envelope `error` — → our verdict.
 *
 * ⚠️ The class match is a **substring** test, because `failed_reason` is a
 * SENTENCE that embeds the code token. The unclassified motivo is an ANCHORED
 * match instead, so it names a code rather than a whole sentence, and Shopee's
 * prose rides `mensagem` verbatim prefixed with "A Shopee recusou: " — it is
 * provider prose about the seller's own listing, never a datum.
 *
 * ⚠️ The four families here are `unlist_item`'s own and are DISJOINT from
 * `problemasPublicacao.ts`'s publish families: its promotion row carries the
 * EDIT locks (`error_cannt_edit_*_in_promotion`) and its holiday row carries
 * `error_holiday_on_add_item`. No code is classified twice in this app.
 */
function classificarRecusa(reason: string | null | undefined): RecusaClassificada {
  const texto = razaoSemPrefixoDeModulo(reason);

  for (const token of TOKENS_PROMOCAO) {
    if (texto.includes(token)) return terminal(MOTIVO_STATUS_ANUNCIO.bloqueadoPorPromocao);
  }
  if (texto.includes(TOKEN_BANIDO_OU_EM_REVISAO)) {
    return terminal(MOTIVO_STATUS_ANUNCIO.anuncioBanidoOuEmRevisao);
  }
  if (texto.includes(TOKEN_LOJA_EM_FERIAS)) {
    return terminal(MOTIVO_STATUS_ANUNCIO.lojaEmFerias);
  }
  if (texto.includes(TOKEN_RELISTAGEM_RECUSADA)) {
    return {
      motivo: MOTIVO_STATUS_ANUNCIO.relistagemRecusada,
      mensagem: mensagemDeMotivo(MOTIVO_STATUS_ANUNCIO.relistagemRecusada),
      tentarOutraPorta: true,
    };
  }

  const ancorado = RE_CODIGO_ANCORADO.exec(texto);
  if (ancorado === null) {
    return {
      motivo: MOTIVO_STATUS_ANUNCIO.recusadoPelaShopee,
      mensagem:
        texto === ''
          ? mensagemDeMotivo(MOTIVO_STATUS_ANUNCIO.recusadoPelaShopee)
          : `A Shopee recusou: ${texto}`,
      tentarOutraPorta: false,
    };
  }
  return { motivo: ancorado[0], mensagem: `A Shopee recusou: ${texto}`, tentarOutraPorta: false };
}

function terminal(motivo: string): RecusaClassificada {
  return { motivo, mensagem: mensagemDeMotivo(motivo), tentarOutraPorta: false };
}

/* -------------------------------------------------------------------------- */
/*                                 the doors                                   */
/* -------------------------------------------------------------------------- */

export type PortaDeStatus = 'unlist' | 'update_item';

/**
 * Which calls this action tries, in order.
 *
 * ⚠️ `pausar` has exactly ONE door. The only `item_status` step 11 ever sends is
 * `NORMAL` (the re-list fallback), so there is no `update_item` pause door to
 * order against.
 *
 * ⚠️ `reativar` takes its order from the single literal `RELIST_PRIMEIRO`, which
 * the sandbox probe flips: with `'update_item'` the two calls swap and the engine
 * loop is byte-identical, because both doors are the same function shape over a
 * set of ids. `primeiro` is a PARAMETER defaulting to that literal so the
 * ordering itself is testable on both values without a second constant.
 */
export function ordemDasPortas(
  acao: AcaoStatusAnuncio,
  primeiro: PortaDeStatus = RELIST_PRIMEIRO,
): readonly PortaDeStatus[] {
  if (acao === ACAO_STATUS_ANUNCIO.pausar) return ['unlist'];
  return primeiro === 'update_item' ? ['update_item', 'unlist'] : ['unlist', 'update_item'];
}

interface ResultadoDaPorta {
  readonly sucessos: ReadonlySet<number>;
  readonly recusas: ReadonlyMap<number, RecusaClassificada>;
  /** Shopee's DAILY quota stopped this door; everything unresolved is `nao-tentado`. */
  readonly cotaDiaria: boolean;
}

/** The daily quota resets at a wall clock; a BURST limit is a transient and propagates. */
function ehCotaDiaria(err: unknown): boolean {
  return err instanceof ShopeeRateLimitError && err.kind === SHOPEE_ERROR_KIND.daily;
}

/**
 * ONE `unlist_item` for the whole batch — `unlist: true` pauses, `false` re-lists.
 *
 * Per-entry results are DATA: a valid request answers **200 even when every entry
 * was refused**. They are reconciled **BY `item_id`, never by position** — the
 * rule every batched read in this app follows. A whole-call failure propagates
 * untouched (the route maps it and nothing is written), with two exceptions: the
 * daily quota, which the caller turns into `pausadoAte`; and an envelope error
 * that classifies as the re-list refusal, which is that refusal for EVERY id of
 * the call and therefore earns the second door.
 */
async function portaUnlist(
  client: ShopeeClient,
  ids: readonly number[],
  acao: AcaoStatusAnuncio,
): Promise<ResultadoDaPorta> {
  const sucessos = new Set<number>();
  const recusas = new Map<number, RecusaClassificada>();
  try {
    const res = await client.unlistItem({
      item_list: ids.map((item_id) => ({
        item_id,
        unlist: acao === ACAO_STATUS_ANUNCIO.pausar,
      })),
    });
    for (const linha of res.response.success_list) sucessos.add(linha.item_id);
    for (const linha of res.response.failure_list) {
      recusas.set(linha.item_id, classificarRecusa(linha.failed_reason));
    }
  } catch (err) {
    if (ehCotaDiaria(err)) return { sucessos, recusas, cotaDiaria: true };
    // ⚠️ Narrow (rule 6). A rate limit is excluded explicitly: `ShopeeRateLimitError`
    // EXTENDS `ShopeeApiError`, so a bare `instanceof` would swallow a burst limit
    // into a per-entry refusal.
    if (err instanceof ShopeeApiError && !(err instanceof ShopeeRateLimitError)) {
      const envelope = classificarRecusa(err.code);
      if (envelope.tentarOutraPorta) {
        for (const id of ids) recusas.set(id, envelope);
        return { sucessos, recusas, cotaDiaria: false };
      }
    }
    throw err;
  }
  return { sucessos, recusas, cotaDiaria: false };
}

/**
 * The re-list fallback: `update_item { item_id, item_status: 'NORMAL' }`, one
 * entry at a time and bounded by the entry count.
 *
 * ⚠️ This is the ONE call in step 11 that sends `item_status`, and it sends
 * **NOTHING ELSE** in the body — the ML rule verbatim: a status bundled with
 * other fields is silently ignored on some listings.
 */
async function portaUpdateItem(
  client: ShopeeClient,
  ids: readonly number[],
): Promise<ResultadoDaPorta> {
  const sucessos = new Set<number>();
  const recusas = new Map<number, RecusaClassificada>();
  for (const itemId of ids) {
    try {
      await client.updateItem({
        item_id: itemId,
        item_status: SHOPEE_ITEM_STATUS_WRITABLE.normal,
      });
      sucessos.add(itemId);
    } catch (err) {
      if (ehCotaDiaria(err)) return { sucessos, recusas, cotaDiaria: true };
      if (!(err instanceof ShopeeApiError) || err instanceof ShopeeRateLimitError) throw err;
      recusas.set(itemId, classificarRecusa(err.code));
    }
  }
  return { sucessos, recusas, cotaDiaria: false };
}

/* -------------------------------------------------------------------------- */
/*                              the quota clock                                */
/* -------------------------------------------------------------------------- */

const MS_POR_DIA = 86_400_000;
const DESLOCAMENTO_UTC8_MS = 8 * 3_600_000;

/**
 * The next 00:00 UTC+8 strictly after `nowMs` — Shopee's documented daily-quota
 * reset, in milliseconds.
 *
 * ⚠️ Pure arithmetic on the parameter: no clock is read (there is none under this
 * folder) and no ambient process timezone is consulted (`no-ambient-timezone` —
 * `apps/nfe` runs on `America/Sao_Paulo` while every other backend is UTC, so a
 * local-time derivation would answer three hours apart depending on which service
 * ran it). The +8 offset is a FACT about Shopee's reset, not about our host.
 *
 * ⚠️ `retryAfterSeconds` is deliberately NOT consulted: the daily quota resets at
 * a fixed wall-clock instant, so a `Retry-After` a proxy may have attached says
 * less than the documented reset does.
 */
export function proximaViradaDaCotaMs(nowMs: number): number {
  const local = nowMs + DESLOCAMENTO_UTC8_MS;
  return (Math.floor(local / MS_POR_DIA) + 1) * MS_POR_DIA - DESLOCAMENTO_UTC8_MS;
}

/* -------------------------------------------------------------------------- */
/*                                the engine                                   */
/* -------------------------------------------------------------------------- */

interface AlvoDeStatus {
  readonly link: LinkDeAnuncio;
  readonly produtoNome: string | null;
}

interface AlvoAceito extends AlvoDeStatus {
  readonly itemId: number;
}

async function clienteShopee(
  db: Firestore,
  integracaoId: string,
  deps: PausarAnuncioDeps,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/** One masked point read. A blank stored name is an absence, never an empty label. */
async function nomeDoProduto(db: Firestore, produtoId: string): Promise<string | null> {
  const snap = await produtoCollection.docRef(db, {}, produtoId).get();
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  const nome = raw.nome;
  return typeof nome === 'string' && nome.trim() !== '' ? nome : null;
}

/** The stored `item_status`, for a row that never reached a read-back. */
function statusArmazenado(link: LinkDeAnuncio): string | null {
  const bruto = link.raw.item_status;
  return typeof bruto === 'string' ? bruto : null;
}

function linhaSemChamada(
  alvo: AlvoDeStatus,
  outcome: AnuncioStatusOutcome,
  motivo: string,
): AnuncioStatusListing {
  return {
    produtoId: alvo.link.produtoId,
    produtoNome: alvo.produtoNome,
    anuncioId: alvo.link.itemId === null ? null : String(alvo.link.itemId),
    linkDocId: alvo.link.linkDocId,
    outcome,
    motivo,
    mensagem: mensagemDeMotivo(motivo),
    statusFinal: statusArmazenado(alvo.link),
    estadoAnuncio: alvo.link.estadoAnuncio,
    membros: null,
  };
}

/**
 * ⚠️ It reports what the READ-BACK confirmed, never the action requested. A
 * re-list Shopee settled somewhere else is a listing that is still not selling,
 * and saying "reativado" there would be a green row over a dead listing.
 */
function mensagemDeSucesso(acao: AcaoStatusAnuncio, estado: EstadoAnuncioShopee): string {
  const pausar = acao === ACAO_STATUS_ANUNCIO.pausar;
  const verbo = pausar ? 'pausado' : 'reativado';
  const esperado = pausar ? ESTADO_ANUNCIO_SHOPEE.pausado : ESTADO_ANUNCIO_SHOPEE.ativo;
  if (estado !== esperado) {
    return `Anúncio ${verbo}, mas a Shopee reporta o anúncio como "${estado}".`;
  }
  return `Anúncio ${verbo}.`;
}

/**
 * The read-back row for one id, as the SAME `ItemLido` seam step 9 builds — or
 * `null` when the batch answered no readable row for it.
 *
 * ⚠️ The presence test comes FIRST: `montarItemLido` throws for an absent row
 * (it is a caller bug there), and here an absent row is an expected outcome.
 */
function itemLidoDaReleitura(payload: ShopeeItemBaseInfo | null, itemId: number): ItemLido | null {
  if (payload === null) return null;
  const legiveis = payload.item_list.filter((linha) => linha !== null);
  if (!legiveis.some((linha) => linha.item_id === itemId)) return null;
  return montarItemLido({ itemId, payload });
}

/**
 * Pause or re-list every eligible listing of the selected produtos.
 *
 * @throws ShopeeConfigError when the selection exceeds
 *   {@link SHOPEE_UNLIST_MAX_ITEMS}, or when `linkDocId` arrives with anything
 *   other than exactly one produtoId. ⚠️ Both are ASSERTIONS on a caller bug —
 *   `respond.ts` maps `ShopeeConfigError` to **500**, so the ROUTE must refuse an
 *   oversized or contradictory body with its own 400 before calling. The
 *   selection is never truncated: silently dropping the 51st produto is a request
 *   half-performed with a 200 over it.
 */
export async function definirStatusAnunciosShopee(
  db: Firestore,
  entrada: AnuncioStatusInput,
  deps: PausarAnuncioDeps,
): Promise<AnuncioStatusResponse> {
  const solicitados = [...new Set(entrada.produtoIds)];
  if (solicitados.length > SHOPEE_UNLIST_MAX_ITEMS) {
    throw new ShopeeConfigError(
      `definirStatusAnunciosShopee: ${String(solicitados.length)} produtos excedem o limite de ` +
        `${String(SHOPEE_UNLIST_MAX_ITEMS)} do unlist_item. A seleção não é truncada — recuse a ` +
        'requisição e peça uma seleção menor.',
    );
  }
  const linkDocId =
    entrada.linkDocId == null || entrada.linkDocId === '' ? null : entrada.linkDocId;
  if (linkDocId !== null && solicitados.length !== 1) {
    throw new ShopeeConfigError(
      'definirStatusAnunciosShopee: linkDocId só faz sentido com exatamente um produtoId ' +
        `(recebidos ${String(solicitados.length)}).`,
    );
  }

  const listings: AnuncioStatusListing[] = [];
  const produtosSemAnuncio: AnuncioStatusSemAnuncio[] = [];
  const alvos: AlvoDeStatus[] = [];

  // ---- Step 1: resolve serially, order preserved.
  for (const produtoId of solicitados) {
    const produtoNome = await nomeDoProduto(db, produtoId);
    const link = await resolverLinkPorProduto(db, entrada.integracaoId, produtoId, linkDocId);
    if (link === null) {
      produtosSemAnuncio.push({
        produtoId,
        produtoNome,
        motivo: MOTIVO_STATUS_ANUNCIO.semAnuncio,
        mensagem:
          linkDocId !== null
            ? 'Anúncio não encontrado neste produto para esta conta Shopee.'
            : mensagemDeMotivo(MOTIVO_STATUS_ANUNCIO.semAnuncio),
      });
      continue;
    }
    alvos.push({ link, produtoNome });
  }

  // ---- Step 2: the pre-check, from the STORED reading. No Shopee call.
  const aceitos: AlvoAceito[] = [];
  for (const alvo of alvos) {
    const veredicto = podeMoverAnuncioShopee(
      { item_id: alvo.link.itemId, estadoAnuncio: alvo.link.estadoAnuncio },
      entrada.acao,
    );
    if (!veredicto.pode) {
      listings.push(linhaSemChamada(alvo, 'pulado', veredicto.motivo));
      continue;
    }
    // The predicate's first rung refuses a non-positive `item_id`, so this is
    // unreachable — it is here because `itemId` is `number | null` on the type and
    // a cast would be a promise the compiler cannot keep.
    if (alvo.link.itemId === null) {
      listings.push(linhaSemChamada(alvo, 'pulado', MOTIVO_STATUS_ANUNCIO.semItemId));
      continue;
    }
    aceitos.push({ ...alvo, itemId: alvo.link.itemId });
  }

  let pausadoAte: string | null = null;
  const sucessos = new Set<number>();
  const recusas = new Map<number, RecusaClassificada>();

  // ⚠️ ONE client for the whole run — the doors and the read-back share it, so a
  // token that lapses mid-batch is renewed by the context's own function rather
  // than by a second load.
  let client: ShopeeClient | null = null;

  if (aceitos.length > 0) {
    client = await clienteShopee(db, entrada.integracaoId, deps);

    // ---- Steps 3 and 4: the doors, in order, each over what the previous refused.
    let pendentes: readonly number[] = aceitos.map((a) => a.itemId);
    for (const porta of ordemDasPortas(entrada.acao)) {
      if (pendentes.length === 0) break;
      const r =
        porta === 'unlist'
          ? await portaUnlist(client, pendentes, entrada.acao)
          : await portaUpdateItem(client, pendentes);

      for (const id of r.sucessos) {
        sucessos.add(id);
        recusas.delete(id);
      }
      for (const [id, recusa] of r.recusas) {
        if (!sucessos.has(id)) recusas.set(id, recusa);
      }
      if (r.cotaDiaria) {
        pausadoAte = new Date(proximaViradaDaCotaMs(deps.nowMs)).toISOString();
        break;
      }
      pendentes = [...r.recusas]
        .filter(([id, recusa]) => recusa.tentarOutraPorta && !sucessos.has(id))
        .map(([id]) => id);
    }
  }

  const atendidos = aceitos.filter((a) => sucessos.has(a.itemId) || recusas.has(a.itemId));
  const naoTentados = aceitos.filter((a) => !sucessos.has(a.itemId) && !recusas.has(a.itemId));

  // ---- Step 5: ONE read-back. NEVER `get_item_list`, which has no id filter.
  let releitura: ShopeeItemBaseInfo | null = null;
  if (pausadoAte === null && atendidos.length > 0 && client !== null) {
    try {
      releitura = await client.getItemBaseInfo({ itemIds: atendidos.map((a) => a.itemId) });
    } catch (err) {
      if (!ehCotaDiaria(err)) throw err;
      pausadoAte = new Date(proximaViradaDaCotaMs(deps.nowMs)).toISOString();
    }
  }

  // ---- Step 6: one `mergeIfExists` per link that produced a reading.
  for (const alvo of atendidos) {
    const item = itemLidoDaReleitura(releitura, alvo.itemId);
    if (item === null) {
      listings.push(linhaSemChamada(alvo, 'falha', MOTIVO_STATUS_ANUNCIO.semLeituraApos));
      continue;
    }

    const bruto = itemStatusDe(item);
    const { estado, deboost } = estadoDoAnuncio(
      {
        kind: 'lido',
        itemStatus: bruto,
        deboost: item.base.deboost,
        agendadoParaMs: agendadoParaMsDe(item.base.scheduled_publish_time),
      },
      deps.nowMs,
    );
    const sucesso = sucessos.has(alvo.itemId);

    // FLAT by construction (C15): scalars only. A nested `ultimaPublicacao` or
    // `falhaPublicacao` here is a runtime TypeError, which is the point.
    const patch: Record<string, unknown> = {
      // ⚠️ From the READ-BACK. `success_list[].unlist` is an echo of our request.
      item_status: itemStatusDeLink(item),
      estadoAnuncio: estado,
      deboost,
      // The ERP's own intent moves ONLY on a success: a pulado or a falha leaves
      // the stored intent exactly as it was.
      ...(sucesso ? { pausadoPeloErp: entrada.acao === ACAO_STATUS_ANUNCIO.pausar } : {}),
      ultimaModificacao: deps.nowMs,
    };
    const escrito = await produtoShopeeLinkCollection.mergeIfExists(
      db,
      { produtoId: alvo.link.produtoId },
      alvo.link.linkDocId,
      patch,
    );
    if (!escrito) {
      console.warn('[shopee/anuncios] vínculo de listagem desapareceu antes da escrita', {
        produtoId: alvo.link.produtoId,
        linkDocId: alvo.link.linkDocId,
        itemId: alvo.itemId,
      });
    }

    const recusa = recusas.get(alvo.itemId);
    listings.push({
      produtoId: alvo.link.produtoId,
      produtoNome: alvo.produtoNome,
      anuncioId: String(alvo.itemId),
      linkDocId: alvo.link.linkDocId,
      outcome: sucesso ? 'enviado' : 'falha',
      motivo: sucesso ? null : (recusa?.motivo ?? MOTIVO_STATUS_ANUNCIO.recusadoPelaShopee),
      mensagem: sucesso
        ? mensagemDeSucesso(entrada.acao, estado)
        : (recusa?.mensagem ?? mensagemDeMotivo(MOTIVO_STATUS_ANUNCIO.recusadoPelaShopee)),
      statusFinal: bruto,
      estadoAnuncio: estado,
      membros: null,
    });
  }

  for (const alvo of naoTentados) {
    listings.push(linhaSemChamada(alvo, 'nao-tentado', MOTIVO_STATUS_ANUNCIO.naoTentado));
  }

  const resumo = {
    aplicados: listings.filter((l) => l.outcome === 'enviado').length,
    pulados: listings.filter((l) => l.outcome === 'pulado').length,
    falhas: listings.filter((l) => l.outcome === 'falha').length,
    naoTentados: listings.filter((l) => l.outcome === 'nao-tentado').length,
  };

  // ONE line per run. Ids, counts, enum tokens and booleans only — never a
  // Shopee body, never provider prose, never a URL.
  // eslint-disable-next-line no-console -- expected on every healthy run; a warn nobody can act on is what hides the real ones
  console.info('[shopee/anuncios] status de anúncios', {
    integracaoId: entrada.integracaoId,
    acao: entrada.acao,
    solicitados: solicitados.length,
    familias: alvos.length,
    ...resumo,
    semAnuncio: produtosSemAnuncio.length,
    cotaDiaria: pausadoAte !== null,
    portas: ordemDasPortas(entrada.acao),
  });

  return {
    canal: 'shopee',
    integracaoId: entrada.integracaoId,
    acao: entrada.acao,
    solicitados: solicitados.length,
    familias: alvos.length,
    resumo,
    listings,
    produtosSemAnuncio,
    pausadoAte,
  };
}
