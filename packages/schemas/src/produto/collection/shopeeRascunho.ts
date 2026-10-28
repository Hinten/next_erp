/**
 * **The Shopee DRAFT's shared rules** (#1911) — what a `prodshopee` document
 * with no `item_id` (a draft, `ehRascunhoShopee`) means to every surface that
 * decides about one: the publish lock's timing, the codes a refused draft
 * operation answers with, the reading of the lock, the "brand still to choose"
 * test, which sibling links make a publish a SECOND listing, the draft
 * route's contract — its three bodies and answers, THE projection of a stored
 * draft's editable fields and THE comparison of two of their values — and the
 * UNCERTAIN first create (D5): the attempt window a lost create is looked for
 * in, and the publish's 202.
 *
 * ⚠️ ONE module (#1369). `apps/shopee` decides with these and the produto's
 * Shopee tab in `apps/web` renders with them; `apps/web` has no dependency edge
 * to `apps/shopee`, so the alternative is a browser copy that drifts toward
 * plausible while both read correct.
 *
 * NOT a collection — the draft IS a `prodshopee` document
 * ({@link produtoShopeeLinkSchema}'s shape), so there is no `registry.ts` entry
 * and nothing here reaches a ruleset.
 *
 * ⚠️ **Pure and total.** No Firestore, no Shopee, and NO CLOCK: every reading
 * takes its instant as a parameter, and the caller passes the route's clock.
 * Every instant is MILLISECONDS.
 *
 * ## The publish lock's timeline
 *
 * A run that publishes a draft takes the lock `{desde, expiraEm = desde +
 * PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS, token}` BEFORE it reads what it will send,
 * and it may START a create only while
 *
 * ```
 * agora() + MARGEM_ENVIO_SHOPEE_MS < min(expiraEm, prazoDaRequisicao)
 * ```
 *
 * checked immediately before EACH `add_item` call, right after that call's
 * credential warm (a route run's `prazoDaRequisicao` is its handler's first
 * instant + TETO_ROTA_SHOPEE_MS; the CLI has none). The one await left between
 * the check and the request is the client's own token ask, which the warm made
 * a single credential read — so MARGEM covers it, and no create's request
 * starts at or after `expiraEm` (`apps/shopee`'s `anuncios/README.md` names
 * the residual). A lock nobody cleared is then read, by
 * {@link estadoPublicacaoRascunhoShopee}:
 *
 * ```
 *  desde ─────────── expiraEm ─────────────── expiraEm + AGUARDAR ──────────▶
 *        em-andamento           em-andamento                        incerta
 *        posExpiracao: false    posExpiracao: true (the grace)
 * ```
 *
 * The grace is what keeps a takeover honest: whatever looks for (or re-sends)
 * the create runs at least AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS after the latest
 * instant a send could have started — the same wait an uncertain kit create
 * asks for.
 */
import { z } from 'zod';

import { textoUtilizavelShopee } from '../../faixaShopee';
import { naoDocId } from '../../shared/outerRef';
import { AGUARDAR_KIT_INCERTO_SHOPEE_MS } from '../../shopeeAcaoSugerida';
import { itemIdEnderecavelShopee, publicacaoEmCursoShopeeSchema } from './shopeeLink';
import { anuncioShopeeVivo, ehRascunhoShopee } from './shopeeLinkLeitura';
import { vinculoShopeeEhDaConta } from './vinculosShopee';

/* -------------------------------------------------------------------------- */
/*                                The constants                                */
/* -------------------------------------------------------------------------- */

/**
 * MILLISECONDS. How long a publish lock stays LIVE once taken: the publishing
 * run writes `expiraEm = desde + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS`.
 *
 * ⚠️ Deliberately ABOVE {@link TETO_ROTA_SHOPEE_MS}: a route run's own deadline
 * binds before its lock's expiry, so by the time a lock taken by a request has
 * expired, that request is already past its ceiling.
 */
export const PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS = 300_000;

/**
 * MILLISECONDS. The `apps/shopee` request ceiling — `runConfig.timeoutSeconds:
 * 180` in `apps/shopee/apphosting.yaml`. The publish route turns it into the
 * request's deadline (`prazoDaRequisicao = nowMs + TETO_ROTA_SHOPEE_MS`, with
 * `nowMs` read as the handler's FIRST statement — before the caller's token is
 * verified and the body parsed), so a create is never STARTED by a request the
 * platform may cut off mid-send. What ran before the handler (a cold boot) is
 * not measured; {@link MARGEM_ENVIO_SHOPEE_MS} absorbs it.
 * ⚠️ Changing either number alone breaks that promise silently.
 */
export const TETO_ROTA_SHOPEE_MS = 180_000;

/**
 * MILLISECONDS. The headroom the per-leg send gate keeps before
 * `min(expiraEm, prazoDaRequisicao)` — it covers the client's token ask that
 * runs between the gate and the request reaching Shopee, and the part of a
 * route request before its handler ran.
 *
 * ⚠️ Bounded only because the publisher WARMS the credential before the gate
 * (`aquecerCredencial`, batch-A review): the ask is then one credential read.
 * Unwarmed, a token inside its refresh skew turns it into a provider refresh
 * with NO deadline (the Shopee transport sets none, #1094), which no margin
 * covers.
 */
export const MARGEM_ENVIO_SHOPEE_MS = 30_000;

/**
 * MILLISECONDS. How long an ITEM create whose outcome is unknown is waited out
 * before anything looks for or re-sends it — and the post-expiry GRACE of
 * {@link estadoPublicacaoRascunhoShopee}.
 *
 * ⚠️ An ALIAS of the kit's `AGUARDAR_KIT_INCERTO_SHOPEE_MS`, never a second
 * number (#1369): both answer "how long until Shopee's listing reads reflect a
 * create the route ceiling may have cut off".
 */
export const AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS = AGUARDAR_KIT_INCERTO_SHOPEE_MS;

/**
 * ⚠️ SECONDS, not milliseconds. How far BEFORE the start of an uncertain
 * create's attempt (its `desde`, the route's clock) the window that create is
 * looked for in opens — {@link inicioDaJanelaDaCriacaoShopeeS}.
 *
 * A listing's `create_time` is Shopee's clock, in whole seconds; the attempt's
 * start is ours. The slack absorbs the skew between the two clocks: a listing
 * the attempt created can never read as created BEFORE its window, so it is
 * never ignored as "older". The price is the other direction, accepted: a
 * listing created up to this long BEFORE the attempt reads as inside the
 * window too (the reason a same-SKU listing already linked to the produto is
 * a refusal the operator may override, not a silent exclusion).
 */
export const FOLGA_JANELA_CRIACAO_SHOPEE_S = 300;

/* -------------------------------------------------------------------------- */
/*                                  The codes                                  */
/* -------------------------------------------------------------------------- */

/**
 * The machine `code` of a refused draft operation (#1911), each with the HTTP
 * status its line names. The producer (`apps/shopee`) and the reader
 * (`apps/web`) import THIS object, so a renamed code is a compile error on both
 * sides of a deploy, never a retyped literal.
 */
export const CODIGO_RASCUNHO_SHOPEE = {
  /**
   * 409 — another run holds the draft's lock (live, or inside its post-expiry
   * grace), or a SIBLING link of the same conta is locked or uncertain. Detail:
   * `aguardarMs`, plus `vinculos` when the holder is a sibling.
   */
  publicacaoEmAndamento: 'SHOPEE_PUBLICACAO_EM_ANDAMENTO',
  /** 409 — the named link is no longer a draft: a listing exists. Detail: `linkDocId`. */
  jaPublicado: 'SHOPEE_RASCUNHO_JA_PUBLICADO',
  /**
   * 409 — the send gate refused BEFORE the create: the lock or the request
   * would have run out mid-send. Nothing was sent to Shopee.
   */
  publicacaoExpirada: 'SHOPEE_PUBLICACAO_EXPIRADA',
  /** 409 — the lock was lost to concurrent writes on every attempt to take it. */
  contencao: 'SHOPEE_RASCUNHO_CONTENCAO',
  /**
   * 409 — the draft's last create may have reached Shopee (the reading is
   * `incerta`): the operation is refused rather than risk a second listing or
   * erase the only record of the attempt.
   */
  criacaoIncerta: 'SHOPEE_RASCUNHO_CRIACAO_INCERTA',
  /**
   * 409 — the conta already holds a live listing or another draft of this
   * produto, and the request did not confirm a SECOND listing (D15). Detail:
   * `vinculos`.
   */
  contaJaTemAnuncio: 'SHOPEE_RASCUNHO_CONTA_JA_TEM_ANUNCIO',
  /**
   * 409 — the stored draft is not what the request says the operator SAW (its
   * `base`), or a create retry at the same id carries other content. Nothing
   * was written. Detail: `conflitos` ({@link conflitoRascunhoShopeeSchema};
   * `[]` when the write lost to concurrent writes on every attempt).
   */
  conflito: 'SHOPEE_RASCUNHO_CONFLITO',
  /**
   * 409 — a create named an id that already holds a document which is not THIS
   * draft (another produto's, another conta's, or a listing). Nothing written.
   */
  idEmUso: 'SHOPEE_RASCUNHO_ID_EM_USO',
  /**
   * 409 — the category of a draft whose last create may have reached Shopee
   * (the reading is `incerta`) cannot change: the uncertain attempt may have
   * created the listing in the OLD category.
   */
  categoriaTravada: 'SHOPEE_RASCUNHO_CATEGORIA_TRAVADA',
  /**
   * 422 — the produto cannot carry a draft. Detail: `motivo`
   * ({@link MOTIVO_RASCUNHO_INVALIDO_SHOPEE}).
   */
  produtoInvalido: 'SHOPEE_RASCUNHO_PRODUTO_INVALIDO',
  /** 404 — the named draft does not exist on this produto, or belongs to another conta. */
  inexistente: 'SHOPEE_RASCUNHO_INEXISTENTE',
} as const satisfies Record<string, string>;
export type CodigoRascunhoShopee =
  (typeof CODIGO_RASCUNHO_SHOPEE)[keyof typeof CODIGO_RASCUNHO_SHOPEE];

/* -------------------------------------------------------------------------- */
/*                         The reading of the lock                             */
/* -------------------------------------------------------------------------- */

/** Where a draft's publish stands, read from its stored document and an instant. */
export type EstadoPublicacaoRascunhoShopee =
  | { readonly tipo: 'livre' }
  | {
      readonly tipo: 'em-andamento';
      /** MILLISECONDS — the lock's `desde`. */
      readonly desdeMs: number;
      /** MILLISECONDS — the lock's `expiraEm` (already PAST when `posExpiracao`). */
      readonly expiraEmMs: number;
      /** MILLISECONDS until this reading stops being `em-andamento` — always > 0. */
      readonly aguardarMs: number;
      /** The document also records an earlier create whose outcome is unknown. */
      readonly aposIncerteza: boolean;
      /** The lock has expired and this is its grace: no run may send any more, but one may still be sending. */
      readonly posExpiracao: boolean;
    }
  | {
      readonly tipo: 'incerta';
      /** MILLISECONDS — the earliest attempt start the document records, or `null` when it records none it can read. */
      readonly desdeMs: number | null;
    };

const LIVRE: EstadoPublicacaoRascunhoShopee = { tipo: 'livre' };

/**
 * A stored safe integer — a MILLISECOND instant, a category or brand id — or
 * `null` when the value is anything else (absent included).
 */
function inteiroLegivel(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isSafeInteger(bruto) ? bruto : null;
}

/**
 * THE reading of a draft's publish lock (#1911, D4) — the publish's
 * reservation, the draft operations and the produto's Shopee tab all decide or
 * render with this, never with `publicacaoEmCurso` compared raw.
 *
 * Inputs: the stored document (unvalidated — a soft-read hands the raw body
 * over) and the reader's instant, in MILLISECONDS. Two keys are read:
 * `publicacaoEmCurso` (through {@link publicacaoEmCursoShopeeSchema}) and
 * `criacaoIncertaDesde` (`produtoShopeeLinkSchema`'s field, #1911 D5), the
 * record of an earlier create whose outcome is unknown — absent on every
 * document that has none. `incerta`'s `desdeMs` IS
 * {@link janelaDaCriacaoIncertaShopee}'s start (one reading, never two).
 *
 * - a READABLE lock and `nowMs < expiraEm` ⇒ **`em-andamento`**,
 *   `posExpiracao: false`, `aguardarMs = expiraEm − nowMs`, `aposIncerteza` =
 *   whether `criacaoIncertaDesde` is set;
 * - a readable lock, NO `criacaoIncertaDesde`, and `expiraEm ≤ nowMs <
 *   expiraEm + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS` ⇒ STILL **`em-andamento`**
 *   (`posExpiracao: true`, `aguardarMs = expiraEm + AGUARDAR − nowMs`): the
 *   run may have started a send just before `expiraEm − MARGEM`, and its
 *   outcome is not observable yet;
 * - a readable lock past that grace, a readable lock past `expiraEm` WITH
 *   `criacaoIncertaDesde` set (that wait was already served), or an UNREADABLE
 *   lock ⇒ **`incerta`**;
 * - no lock (`null` or absent) and `criacaoIncertaDesde` set ⇒ **`incerta`**;
 * - otherwise (incl. a `null` document) ⇒ **`livre`**.
 *
 * ⚠️ The direction of every doubt is AWAY from `livre`: an expired lock is
 * never "free" (the run that held it may have created the listing), a
 * malformed lock is never "absent", and a `criacaoIncertaDesde` that is set but
 * not a readable instant still counts as set (`desdeMs` then falls back to the
 * lock's `desde`, else `null`). `livre` is only ever "nothing on record".
 *
 * Reads the lock whatever the document is — whether it is still a DRAFT is the
 * caller's question ({@link ehRascunhoShopee}).
 *
 * Boundaries (pinned in `shopeeRascunho.test.ts`): `expiraEm − 1` ⇒
 * em-andamento/`posExpiracao: false`; `expiraEm` ⇒ em-andamento/`posExpiracao:
 * true`; `expiraEm + 240 000 − 1` ⇒ em-andamento/`posExpiracao: true`;
 * `expiraEm + 240 000` ⇒ incerta; `expiraEm` WITH `criacaoIncertaDesde` ⇒
 * incerta.
 */
export function estadoPublicacaoRascunhoShopee(
  link: Record<string, unknown> | null,
  nowMs: number,
): EstadoPublicacaoRascunhoShopee {
  if (link === null) return LIVRE;

  const incertaBruta = link.criacaoIncertaDesde;
  const comIncerteza = incertaBruta !== null && incertaBruta !== undefined;
  const incerta = (): EstadoPublicacaoRascunhoShopee => ({
    tipo: 'incerta',
    desdeMs: janelaDaCriacaoIncertaShopee(link)?.desdeMs ?? null,
  });

  const trava = link.publicacaoEmCurso;
  if (trava === null || trava === undefined) {
    return comIncerteza ? incerta() : LIVRE;
  }

  const lida = publicacaoEmCursoShopeeSchema.safeParse(trava);
  if (!lida.success) return incerta();
  const { desde, expiraEm } = lida.data;

  if (nowMs < expiraEm) {
    return {
      tipo: 'em-andamento',
      desdeMs: desde,
      expiraEmMs: expiraEm,
      aguardarMs: expiraEm - nowMs,
      aposIncerteza: comIncerteza,
      posExpiracao: false,
    };
  }

  const fimDaCarencia = expiraEm + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS;
  if (!comIncerteza && nowMs < fimDaCarencia) {
    return {
      tipo: 'em-andamento',
      desdeMs: desde,
      expiraEmMs: expiraEm,
      aguardarMs: fimDaCarencia - nowMs,
      aposIncerteza: false,
      posExpiracao: true,
    };
  }

  return incerta();
}

/* -------------------------------------------------------------------------- */
/*              The uncertain first create's ATTEMPT WINDOW (D5)               */
/* -------------------------------------------------------------------------- */

/** The window an uncertain create of a draft is looked for in. */
export interface JanelaDaCriacaoIncertaShopee {
  /** MILLISECONDS — the start of the earliest attempt the document records. */
  readonly desdeMs: number;
}

/**
 * THE attempt window of a draft's uncertain first create (#1911, K1-7/K1-8) —
 * the evidence that a create of THIS draft was ever attempted, and since when.
 *
 * `desdeMs` = the stored `criacaoIncertaDesde` when it is a readable instant,
 * else the stored lock's `desde` when the lock is readable
 * ({@link publicacaoEmCursoShopeeSchema}), else NO window (`null`).
 *
 * - **`null` ⇔ no attempt evidence** — every legacy draft (neither key), a
 *   draft never sent, a `null` document. Also a document whose record is
 *   unreadable on both keys: nothing there says WHEN.
 * - The record of the uncertain attempt wins over the lock: it is the EARLIEST
 *   start, and a later lock (a re-send's) would narrow the window past the
 *   listing the first attempt created.
 * - ⚠️ Read it from the document BEFORE a write that replaces the lock: a
 *   takeover's new lock carries a LATER `desde`. That write carries this
 *   window's start into `criacaoIncertaDesde` (`./shopeeLink.ts`'s writer
 *   inventory), so a released takeover never loses it.
 *
 * Two callers decide with it, both through {@link criadoNaJanelaShopee}: the
 * publish's look-up of an uncertain create before any new `add_item`
 * (ENSURE, `apps/shopee`'s `anuncios/criacaoIncerta.ts`), and the product
 * import, which adopts a draft only when it carries a window AND the listing
 * was created inside it (`produtos/resolveProduto.ts`). In `@delfrance/schemas`
 * so neither app module imports the other (#1369).
 *
 * Reads the two keys whatever the document is — whether it is still a DRAFT is
 * the caller's question ({@link ehRascunhoShopee}). Pure, total.
 */
export function janelaDaCriacaoIncertaShopee(
  link: Record<string, unknown> | null,
): JanelaDaCriacaoIncertaShopee | null {
  if (link === null) return null;
  const registrada = inteiroLegivel(link.criacaoIncertaDesde);
  if (registrada !== null) return { desdeMs: registrada };
  const trava = publicacaoEmCursoShopeeSchema.safeParse(link.publicacaoEmCurso);
  return trava.success ? { desdeMs: trava.data.desde } : null;
}

/**
 * SECONDS — the earliest Shopee `create_time` (and `update_time`) a listing
 * created by an attempt that started at `desdeMs` can carry:
 * `⌊desdeMs / 1000⌋ − FOLGA_JANELA_CRIACAO_SHOPEE_S`. The ONE computation of
 * the window's opening — the look-up's `update_time_from` and
 * {@link criadoNaJanelaShopee}'s comparison both read it.
 */
export function inicioDaJanelaDaCriacaoShopeeS(desdeMs: number): number {
  return Math.floor(desdeMs / 1000) - FOLGA_JANELA_CRIACAO_SHOPEE_S;
}

/** Where a listing's creation falls against an attempt window. */
export type PosicaoNaJanelaShopee = 'dentro' | 'fora' | 'desconhecido';

/**
 * Was this listing created inside the attempt window that opened at `desdeMs`
 * (#1911, K1-7/K1-8)? `createTimeS` is the listing's `create_time` as Shopee
 * reports it (`get_item_base_info`), in SECONDS.
 *
 * - **`'dentro'`** — `createTimeS ≥` {@link inicioDaJanelaDaCriacaoShopeeS}
 *   (`desdeMs`). Inclusive. No upper bound: a create is never in the future of
 *   the look-up, and a listing created after the attempt is exactly what the
 *   attempt may have made.
 * - **`'fora'`** — created before the window opened: an older listing, never
 *   the uncertain attempt's.
 * - **`'desconhecido'`** — `createTimeS` is `null` (Shopee left it unset), or
 *   not a POSITIVE safe integer (a `0` is no instant Shopee would report for a
 *   real listing), or `desdeMs` is not a safe integer. ⚠️ Never folded into
 *   `'fora'`: the look-up treats an unknown creation as a DOUBT (refuse, the
 *   operator checks), and the import does not adopt on it — the fail-closed
 *   direction on both sides. A `'fora'` answered for an unknown would let a
 *   listing the attempt created be ignored, and a second one created.
 *
 * Pure, total.
 */
export function criadoNaJanelaShopee(
  createTimeS: number | null,
  desdeMs: number,
): PosicaoNaJanelaShopee {
  if (createTimeS === null || !Number.isSafeInteger(createTimeS) || createTimeS <= 0) {
    return 'desconhecido';
  }
  if (!Number.isSafeInteger(desdeMs)) return 'desconhecido';
  return createTimeS >= inicioDaJanelaDaCriacaoShopeeS(desdeMs) ? 'dentro' : 'fora';
}

/* -------------------------------------------------------------------------- */
/*                         The brand still to choose                           */
/* -------------------------------------------------------------------------- */

/**
 * Is this a DRAFT whose brand was never chosen (#1911, D10)? A draft stores
 * the brand the operator picked; "Sem marca" is the explicit `brand_id: 0`, so
 * a chosen brand is a `brand_id` that is a safe NON-NEGATIVE integer — the
 * only values the draft route ever writes. It is the test behind the listing
 * assembly's `marca-nao-escolhida` refusal, and a browser surface that warns
 * about the same thing imports it (#1369).
 *
 * ⚠️ **FAIL-CLOSED** (#1911 P5, the §2.1 amendment): anything that is not such
 * an integer counts as NOT chosen — `null`, absent, and a malformed value
 * (`'77'`, `''`, `false`, `1.5`, `NaN`, `-1`, beyond 2^53). Before the
 * amendment a malformed id read "chosen" here while
 * {@link camposDoRascunhoShopee} read it `marca: null`, so the editor showed
 * "no brand" while the publish went on with whatever brand its cascade
 * supplied — an unchosen brand sent. Now the publish refuses and the operator
 * picks.
 *
 * - **EQUAL (no brand chosen):** `brand_id` `null`, absent, or any value that
 *   is not a safe non-negative integer.
 * - **DISTINCT:** `brand_id: 0` ("Sem marca" IS a choice) and every positive
 *   safe integer;
 * - **DISTINCT:** any link that is not a draft ({@link ehRascunhoShopee}) — an
 *   imported listing with `brand_id: null` was never the operator's to pick
 *   here — and a `null` document.
 *
 * Against the projection: `camposDoRascunhoShopee(link).marca === null` ⇒
 * this is `true`, for every draft (the unsafe mismatch is gone). The converse
 * fails only for a NEGATIVE safe integer, which the projection reads verbatim
 * (reading is not validating) — the safe direction: the editor shows the
 * stored id beside the pendência, and the publish refuses.
 *
 * Pure, total over `unknown`.
 */
export function rascunhoSemMarcaShopee(
  link: {
    readonly item_id?: unknown;
    readonly kitNativo?: unknown;
    readonly brand_id?: unknown;
  } | null,
): boolean {
  if (link === null || !ehRascunhoShopee(link)) return false;
  const brandId = inteiroLegivel(link.brand_id);
  return brandId === null || brandId < 0;
}

/* -------------------------------------------------------------------------- */
/*                   The links that make a SECOND listing (D15)                */
/* -------------------------------------------------------------------------- */

/**
 * One sibling link a publish (or a new draft) would sit beside — the item of a
 * 409's `vinculos[]`. `itemId` is the listing's id, `null` for a draft — and
 * for a live listing whose stored id cannot address it (`1.5`, beyond 2^53),
 * read through `itemIdEnderecavelShopee` so the field always fits `int()`.
 * Plain `z.object` (unknown keys stripped), so the reader tolerates a newer
 * producer's extra keys.
 */
export const vinculoConflitanteShopeeSchema = z.object({
  linkDocId: z.string().min(1),
  itemId: z.number().int().nullable(),
  rascunho: z.boolean(),
});
export type VinculoConflitanteShopee = z.infer<typeof vinculoConflitanteShopeeSchema>;

/**
 * The links of ONE produto that make a new listing on the conta `integracaoId`
 * a SECOND one (#1911, D15) — those whose publish needs the operator's
 * explicit confirmation. A link qualifies when it
 *
 * 1. belongs to the conta ({@link vinculoShopeeEhDaConta}, both stored ref
 *    encodings);
 * 2. is not `excluirLinkDocId` (the draft being published or created itself);
 * 3. is a LIVE listing ({@link anuncioShopeeVivo} — a SUPERSEDED listing is
 *    still on Shopee and counts; a `removido` one does not) **or** a DRAFT
 *    ({@link ehRascunhoShopee} — it will become one).
 *
 * A corrupt link (`item_id: 0`, `'123'`, `kitNativo: true` with no `item_id`)
 * is neither, and does not count. Input order is kept.
 *
 * Every caller decides with THIS set — the publish's reservation, the draft
 * create and the web's confirmation — so the duplicate the confirmation warns
 * about is the same duplicate the server refuses.
 *
 * Pure: the caller hands over the documents it read (`{id, data}`), unvalidated.
 */
export function vinculosQueExigemConfirmacaoShopee(
  links: readonly { readonly id: string; readonly data: Record<string, unknown> }[],
  integracaoId: string,
  excluirLinkDocId?: string,
): VinculoConflitanteShopee[] {
  const saida: VinculoConflitanteShopee[] = [];
  for (const { id, data } of links) {
    if (id === excluirLinkDocId || !vinculoShopeeEhDaConta(data, integracaoId)) continue;
    // MEMBERSHIP is "alive" (`isFinite`); the id it CARRIES is the addressable
    // one — the same reader the publish's own 409 list uses (#1369).
    if (anuncioShopeeVivo(data)) {
      saida.push({ linkDocId: id, itemId: itemIdEnderecavelShopee(data.item_id), rascunho: false });
    } else if (ehRascunhoShopee(data)) {
      saida.push({ linkDocId: id, itemId: null, rascunho: true });
    }
  }
  return saida;
}

/* -------------------------------------------------------------------------- */
/*              A produto that cannot carry a draft (the 422's motivo)         */
/* -------------------------------------------------------------------------- */

/**
 * Why a draft create refused the produto (#1911, K2-10) — the `motivo` of a 422
 * {@link CODIGO_RASCUNHO_SHOPEE}`.produtoInvalido`:
 *
 * - `filho` — a variation child: its MODEL lives on the parent's listing, so a
 *   child never carries a listing (nor a draft) of its own;
 * - `kit-virtual` — a virtual kit's first publish is a NATIVE kit, built by the
 *   kit arm, never an ordinary listing drafted here.
 *
 * ⚠️ A route-only answer, deliberately NOT the persisted publish-refusal slugs
 * (`falhaPublicacao`'s vocabulary): the publish dispatcher's slugs have exactly
 * one producer each, pinned in `apps/shopee`, and an answer nobody stores must
 * not mix with what the produto's history keeps.
 */
export const motivoRascunhoInvalidoShopeeSchema = z.enum(['filho', 'kit-virtual']);
export type MotivoRascunhoInvalidoShopee = z.infer<typeof motivoRascunhoInvalidoShopeeSchema>;
export const MOTIVO_RASCUNHO_INVALIDO_SHOPEE = {
  filho: 'filho',
  kitVirtual: 'kit-virtual',
} as const satisfies Record<string, MotivoRascunhoInvalidoShopee>;

/* -------------------------------------------------------------------------- */
/*                 The draft's editable fields — THE projection                */
/* -------------------------------------------------------------------------- */

/**
 * One editable field of a draft (#1911) — the unit the draft route compares,
 * writes (`gravados`) and reports in a conflict, and the unit the produto's
 * Shopee tab marks as touched.
 *
 * - `marca` is ONE field over TWO stored keys, `brand_id` + `original_brand_name`
 *   (D10): the pair is never written, compared or reported apart.
 * - `attributes` and `logistic_info` are RESERVED — in the vocabulary from the
 *   start, so it never changes shape under a reader, but no body accepts them,
 *   {@link camposDoRascunhoShopee} does not produce them and they compare
 *   DISTINCT until their decoders join this module.
 *
 * The enum's option order is the CANONICAL order: every list of fields this
 * module answers ({@link camposPresentesDoRascunhoShopee}) follows it.
 */
export const campoRascunhoShopeeSchema = z.enum([
  'item_name',
  'description',
  'category_id',
  'marca',
  'attributes',
  'logistic_info',
]);
export type CampoRascunhoShopee = z.infer<typeof campoRascunhoShopeeSchema>;
export const CAMPO_RASCUNHO_SHOPEE = {
  itemName: 'item_name',
  description: 'description',
  categoryId: 'category_id',
  marca: 'marca',
  attributes: 'attributes',
  logisticInfo: 'logistic_info',
} as const satisfies Record<string, CampoRascunhoShopee>;

/**
 * A draft's brand as ONE value: the id the operator chose and the name that
 * follows it. `brand_id: 0` is Shopee's "No Brand" — a choice, never "not
 * chosen" (which is the whole value being `null`).
 */
export interface MarcaRascunhoShopee {
  readonly brand_id: number;
  readonly original_brand_name: string | null;
}

/**
 * The editable fields of a stored draft, as {@link camposDoRascunhoShopee}
 * reads them. `null` = nothing stored (or nothing READABLE stored).
 */
export interface CamposRascunhoShopee {
  readonly item_name: string | null;
  /** `null` = the listing uses the produto's own description (D2). */
  readonly description: string | null;
  readonly category_id: number | null;
  /** `null` = no brand chosen yet. */
  readonly marca: MarcaRascunhoShopee | null;
  /** RESERVED — not produced yet. */
  readonly attributes?: readonly unknown[] | null;
  /** RESERVED — not produced yet. */
  readonly logistic_info?: readonly unknown[] | null;
}

/** A stored string, VERBATIM; anything else (absent included) is `null`. */
function textoGuardado(bruto: unknown): string | null {
  return typeof bruto === 'string' ? bruto : null;
}

/**
 * THE projection of a stored draft onto its editable fields (#1911) — the ONE
 * place "what the draft holds" is decided. The draft route compares the
 * operator's `base` against it and reports conflicts in its terms; the
 * produto's Shopee tab builds the `base` it sends from it (#1369: one reading,
 * never a browser copy).
 *
 * Input: the stored document, unvalidated (a soft-read hands the raw body over).
 *
 * - **Absent ≡ `null`** — decided HERE, once: a legacy draft with no
 *   `item_name` key reads `item_name: null`, exactly like an explicit `null`.
 * - **Verbatim.** Never trims, never folds blank to `null`: a stored legacy
 *   `''` stays `''` and `'Camiseta '` keeps its space. A `base` is what the
 *   operator SAW, so the projection must be what is STORED.
 * - **`marca` is `null` ⇔ `brand_id` is `null`/absent**; otherwise it is the
 *   pair, with the stored `original_brand_name` (verbatim, else `null`).
 * - **An unreadable value reads `null`** — a non-string text, a `category_id`
 *   or `brand_id` that is not a safe integer. The type cannot hold it, and
 *   `null` keeps the draft EDITABLE: the operator sees an empty field, writes a
 *   value, and the compare still catches every concurrent edit, since every
 *   value the draft route writes is readable.
 * - `attributes` / `logistic_info` are not projected yet (RESERVED).
 *
 * Pure, total over any record; reads whatever the document is — whether it is
 * still a DRAFT is the caller's question ({@link ehRascunhoShopee}).
 */
export function camposDoRascunhoShopee(link: Record<string, unknown>): CamposRascunhoShopee {
  const brandId = inteiroLegivel(link.brand_id);
  return {
    item_name: textoGuardado(link.item_name),
    description: textoGuardado(link.description),
    category_id: inteiroLegivel(link.category_id),
    marca:
      brandId === null
        ? null
        : { brand_id: brandId, original_brand_name: textoGuardado(link.original_brand_name) },
  };
}

/** Does `valor` look like a brand pair (an object carrying `brand_id`)? */
function ehParDeMarca(valor: unknown): valor is { readonly brand_id: unknown } {
  return typeof valor === 'object' && valor !== null && 'brand_id' in valor;
}

/**
 * THE comparison of two values of one draft field (#1911) — the draft route's
 * baseline compare (stored vs the operator's `base`), its "nothing to write"
 * test (stored vs `patch`) and its create-retry test (stored vs `conteudo`) all
 * ask THIS, over values in {@link camposDoRascunhoShopee}'s form.
 *
 * A fold, deliberately NARROW — "same" must never swallow an edit:
 *
 * - **EQUAL:** `undefined` ≡ `null` (an absent key is the projection's `null`);
 *   two brand pairs with the same `brand_id` and different names (the name
 *   FOLLOWS the id; the publish's read-back repairs it).
 * - **DISTINCT:** `'Camiseta'` vs `'Camiseta '` (no trim); `''` vs `null` (a
 *   stored `''` is not "nothing"); `100` vs `'100'` (no coercion); brand `0`
 *   ("No Brand", chosen) vs `null` (not chosen).
 * - **RESERVED** `attributes` / `logistic_info`: always DISTINCT, even `null`
 *   vs `null`, until their structural compare joins with their decoders. A
 *   compare that answers "different" when unsure raises a conflict the human
 *   sees; one that answers "same" drops an edit silently.
 *
 * Scalars compare with `===`. Pure, total.
 */
export function mesmoValorDoRascunhoShopee<C extends CampoRascunhoShopee>(
  campo: C,
  a: CamposRascunhoShopee[C] | undefined,
  b: CamposRascunhoShopee[C] | undefined,
): boolean {
  const x: unknown = a ?? null;
  const y: unknown = b ?? null;
  switch (campo as CampoRascunhoShopee) {
    case CAMPO_RASCUNHO_SHOPEE.marca:
      if (x === null || y === null) return x === y;
      return ehParDeMarca(x) && ehParDeMarca(y) && x.brand_id === y.brand_id;
    case CAMPO_RASCUNHO_SHOPEE.attributes:
    case CAMPO_RASCUNHO_SHOPEE.logisticInfo:
      return false;
    case CAMPO_RASCUNHO_SHOPEE.itemName:
    case CAMPO_RASCUNHO_SHOPEE.description:
    case CAMPO_RASCUNHO_SHOPEE.categoryId:
      return x === y;
  }
}

/**
 * The fields a parsed `base`, `patch` or `conteudo` NAMES — every key whose
 * value is not `undefined` — in the canonical order of
 * {@link campoRascunhoShopeeSchema}. The update body's own check (`base` names
 * exactly `patch`'s fields) uses it, so the route iterating the same list
 * compares exactly the fields that check accepted.
 */
export function camposPresentesDoRascunhoShopee(
  valores: Partial<Record<CampoRascunhoShopee, unknown>>,
): CampoRascunhoShopee[] {
  return campoRascunhoShopeeSchema.options.filter((campo) => valores[campo] !== undefined);
}

/* -------------------------------------------------------------------------- */
/*                         The draft route's bodies                            */
/* -------------------------------------------------------------------------- */

/** The longest `item_name` a draft write accepts — an abuse bound; Shopee's band is the publisher's. */
export const MAX_ITEM_NAME_RASCUNHO_SHOPEE = 2_000;

/** The longest `description` a draft write accepts — an abuse bound; Shopee's band is the publisher's. */
export const MAX_DESCRIPTION_RASCUNHO_SHOPEE = 10_000;

/**
 * The id a draft CREATE may name: exactly Firestore's auto-id shape, 20
 * characters of `[A-Za-z0-9]` — the client generates it. A native-kit link's
 * derived id is 64 lowercase-hex characters, so the two can never collide.
 * Edits and discards name an EXISTING document, which only has to be a usable
 * document id (a legacy draft's id is whatever the legacy app gave it).
 */
export const PADRAO_ID_RASCUNHO_SHOPEE = /^[A-Za-z0-9]{20}$/;

/** {@link PADRAO_ID_RASCUNHO_SHOPEE} as a body field. */
export const idRascunhoShopeeSchema = z.string().regex(PADRAO_ID_RASCUNHO_SHOPEE, {
  message: 'linkDocId deve ter 20 letras ou dígitos (o formato de id do Firestore).',
});

/**
 * A usable Firestore document id ({@link naoDocId}): never `''`, never a `/`,
 * never `.` or `..` — refused HERE, before it can reach `.doc(id)`.
 */
const idDeDocumentoSchema = z.string().refine((id) => !naoDocId(id), {
  message: 'deve ser um id de documento (sem "/" nem "..").',
});

/**
 * The brand pair a write accepts, NORMALISED: `brand_id: 0` drops the name
 * (Shopee's "No Brand" has its own); a blank name is `null` (nothing to say).
 * A non-blank name is kept VERBATIM.
 */
const marcaConteudoSchema = z
  .strictObject({
    brand_id: z.number().int().nonnegative(),
    original_brand_name: z.string().nullable(),
  })
  .transform(
    (marca): MarcaRascunhoShopee => ({
      brand_id: marca.brand_id,
      original_brand_name:
        marca.brand_id === 0 || textoUtilizavelShopee(marca.original_brand_name) === null
          ? null
          : marca.original_brand_name,
    }),
  );

/** The write's 400 when `item_name` is `null` or blank. */
export const MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE =
  'item_name deve ser um texto não vazio — o título de um rascunho nunca fica em branco.';

/**
 * **The draft WRITE whitelist** (#1911, D1/D2) — every field a draft create
 * (`conteudo`) or edit (`patch`) may set, NORMALISED to what is stored. Every
 * key optional; an unknown key — `item_id`, a lifecycle field, a reserved field
 * — is a 400, never silently dropped (`.strict`).
 *
 * | key | accepts | stored as |
 * |---|---|---|
 * | `item_name` | a non-blank string ≤ {@link MAX_ITEM_NAME_RASCUNHO_SHOPEE} (`null` refused) | verbatim |
 * | `description` | a string ≤ {@link MAX_DESCRIPTION_RASCUNHO_SHOPEE}, or `null` | verbatim; blank ⇒ `null` ("the produto's") |
 * | `category_id` | a positive safe integer, or `null` | verbatim (the leaf check is the publisher's) |
 * | `marca` | `{brand_id: int ≥ 0, original_brand_name: string or null}`, or `null` | BOTH stored keys always: `null` ⇒ both `null`; `0` ⇒ name `null`; blank name ⇒ `null` |
 *
 * "Blank" is {@link textoUtilizavelShopee}'s — the one test of usable text.
 */
export const conteudoRascunhoShopeeSchema = z.strictObject({
  // `.nullable()` only so `null` reaches the refine and is REFUSED with a
  // sentence — a draft's title is never cleared (the stored schema's `min(1)`).
  item_name: z
    .string()
    .max(MAX_ITEM_NAME_RASCUNHO_SHOPEE)
    .nullable()
    .refine((nome) => nome !== null && textoUtilizavelShopee(nome) !== null, {
      message: MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE,
    })
    .optional(),
  description: z
    .string()
    .max(MAX_DESCRIPTION_RASCUNHO_SHOPEE)
    .nullable()
    .transform((texto) => (textoUtilizavelShopee(texto) === null ? null : texto))
    .optional(),
  category_id: z.number().int().positive().nullable().optional(),
  marca: marcaConteudoSchema.nullable().optional(),
});
export type ConteudoRascunhoShopee = z.output<typeof conteudoRascunhoShopeeSchema>;

/**
 * **What the operator SAW** (#1911, K2-4) — the `base` of an edit or a discard:
 * {@link camposDoRascunhoShopee}'s shape, every key optional, values VERBATIM.
 * Nullable, no minimum length, no maximum, no trim, no blank ⇒ `null`: a base
 * is compared against the STORED projection, never written, so normalising it
 * would turn a legacy `''` into a conflict on every save, and a bound would
 * make a legacy draft uneditable. Strict, like the bodies.
 *
 * Every value {@link camposDoRascunhoShopee} can produce parses here unchanged.
 */
export const baseRascunhoShopeeSchema = z.strictObject({
  item_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category_id: z.number().int().nullable().optional(),
  marca: z
    .strictObject({
      brand_id: z.number().int(),
      original_brand_name: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type BaseRascunhoShopee = z.output<typeof baseRascunhoShopeeSchema>;

/**
 * `POST /api/marketplace/shopee/rascunho` — create the draft at the
 * client-generated `linkDocId` ({@link PADRAO_ID_RASCUNHO_SHOPEE}). `conteudo`
 * absent or `null` ⇒ nothing but the defaults. `confirmarSegundoAnuncio: true`
 * is the operator's confirmation that the conta's live listing or other draft
 * of this produto is not a reason to stop (D15); absent or `null` is `false` —
 * only a literal `true` confirms.
 */
export const corpoCriarRascunhoShopeeSchema = z.strictObject({
  integracaoId: idDeDocumentoSchema,
  produtoId: idDeDocumentoSchema,
  linkDocId: idRascunhoShopeeSchema,
  conteudo: conteudoRascunhoShopeeSchema.nullable().optional(),
  confirmarSegundoAnuncio: z.boolean().nullable().optional(),
});
export type CorpoCriarRascunhoShopee = z.output<typeof corpoCriarRascunhoShopeeSchema>;

/** The update body's 400 when `patch` names no field. */
export const MSG_PATCH_VAZIO_RASCUNHO_SHOPEE = 'patch deve alterar ao menos um campo.';

/** The update body's 400 when `base` and `patch` name different fields. */
export const MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE =
  'base deve trazer exatamente os campos de patch, com os valores que o operador viu.';

/**
 * `POST /api/marketplace/shopee/rascunho/atualizar` — edit a draft. `patch` is
 * the write ({@link conteudoRascunhoShopeeSchema}, normalised); `base` is what
 * the operator saw for EXACTLY those fields ({@link baseRascunhoShopeeSchema},
 * verbatim) — the route compares it against the stored projection before
 * writing. `patch` must name at least one field
 * ({@link MSG_PATCH_VAZIO_RASCUNHO_SHOPEE}); `base` must name exactly `patch`'s
 * fields ({@link MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE}), so a field is
 * never written unchecked nor checked unwritten.
 */
export const corpoAtualizarRascunhoShopeeSchema = z
  .strictObject({
    integracaoId: idDeDocumentoSchema,
    produtoId: idDeDocumentoSchema,
    linkDocId: idDeDocumentoSchema,
    base: baseRascunhoShopeeSchema,
    patch: conteudoRascunhoShopeeSchema,
  })
  .superRefine((corpo, ctx) => {
    const alterados = camposPresentesDoRascunhoShopee(corpo.patch);
    if (alterados.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['patch'], message: MSG_PATCH_VAZIO_RASCUNHO_SHOPEE });
      return;
    }
    const vistos = camposPresentesDoRascunhoShopee(corpo.base);
    const mesmos =
      vistos.length === alterados.length && vistos.every((campo, i) => campo === alterados[i]);
    if (!mesmos) {
      ctx.addIssue({
        code: 'custom',
        path: ['base'],
        message: MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE,
      });
    }
  });
export type CorpoAtualizarRascunhoShopee = z.output<typeof corpoAtualizarRascunhoShopeeSchema>;

/**
 * `POST /api/marketplace/shopee/rascunho/descartar` — delete a draft. `base`
 * carries EVERY projected field (K1-13): the route refuses the discard when the
 * stored draft is not what the operator saw, so an edit made meanwhile — in
 * another tab, by another operator — is never discarded unseen.
 * `confirmarCriacaoIncerta: true` is the operator's attestation that the
 * uncertain last create did NOT reach Shopee (K1-6); without it (absent or
 * `null` — only a literal `true` attests), a draft whose reading is `incerta`
 * is kept, because the draft is the only record of that attempt.
 */
export const corpoDescartarRascunhoShopeeSchema = z.strictObject({
  integracaoId: idDeDocumentoSchema,
  produtoId: idDeDocumentoSchema,
  linkDocId: idDeDocumentoSchema,
  base: baseRascunhoShopeeSchema.required(),
  confirmarCriacaoIncerta: z.boolean().nullable().optional(),
});
export type CorpoDescartarRascunhoShopee = z.output<typeof corpoDescartarRascunhoShopeeSchema>;

/* -------------------------------------------------------------------------- */
/*                        The draft route's answers                            */
/* -------------------------------------------------------------------------- */

/**
 * The create's 2xx: **201** `criado: true` — the draft was created now; **200**
 * `criado: false` — it already existed, for the same conta and produto, with
 * the SAME content (a double click, or a retry whose first answer was lost).
 * A retry carrying other content is a 409 `conflito`, never this.
 */
export const respostaCriarRascunhoShopeeSchema = z.object({
  linkDocId: z.string().min(1),
  criado: z.boolean(),
});
export type RespostaCriarRascunhoShopee = z.infer<typeof respostaCriarRascunhoShopeeSchema>;

/**
 * The edit's 200: the fields WRITTEN, canonical order. `[]` = the patch equals
 * what is stored, and nothing was written.
 */
export const respostaAtualizarRascunhoShopeeSchema = z.object({
  linkDocId: z.string().min(1),
  gravados: z.array(campoRascunhoShopeeSchema),
});
export type RespostaAtualizarRascunhoShopee = z.infer<typeof respostaAtualizarRascunhoShopeeSchema>;

/**
 * The discard's 200. `criacaoIncerta: true` = the draft deleted was `incerta`
 * (discarded on the operator's attestation): if a listing appears on Shopee
 * after all, it is imported, never re-created.
 */
export const respostaDescartarRascunhoShopeeSchema = z.object({
  linkDocId: z.string().min(1),
  descartado: z.literal(true),
  criacaoIncerta: z.boolean(),
});
export type RespostaDescartarRascunhoShopee = z.infer<typeof respostaDescartarRascunhoShopeeSchema>;

/**
 * One item of a 409 {@link CODIGO_RASCUNHO_SHOPEE}`.conflito`'s `conflitos[]`:
 * the field, and what is stored NOW, in {@link camposDoRascunhoShopee}'s form
 * (so the tab can show it beside what the operator typed). Plain `z.object`, so
 * the reader tolerates a newer producer's extra keys.
 */
export const conflitoRascunhoShopeeSchema = z.object({
  campo: campoRascunhoShopeeSchema,
  atual: z.unknown(),
});
export type ConflitoRascunhoShopee = z.infer<typeof conflitoRascunhoShopeeSchema>;

/* -------------------------------------------------------------------------- */
/*                  The publish's 202 — an uncertain first create (D5)         */
/* -------------------------------------------------------------------------- */

/**
 * The **202** of `POST /api/marketplace/shopee/publicar` when the FIRST
 * `add_item` of an ordinary listing ended with an outcome nobody can know
 * (#1911, D5): Shopee may or may not have created the listing. Accepted, not
 * done — never "falhou". The draft's lock stays live for `aguardarMs`, so every
 * tab, operator and the CLI hear 409 `publicacaoEmAndamento` until then; the
 * next publish of the draft first LOOKS for the listing by SKU before any new
 * `add_item`.
 *
 * - `arma: 'item'` + `desfecho: 'incerto'` — the tag. The item arm's 200 has no
 *   `arma`, and every kit arm's `arma` is a `kit-*` value, so a reader tries the
 *   kit arm first, then this one, then the item 200.
 * - `linkDocId` — the DRAFT that records the attempt. Never `null`: a live
 *   create with no named link mints a draft first (K1-5).
 * - `aguardarMs` — MILLISECONDS until the draft's lock stops being
 *   `em-andamento`: the wait before a re-send. Always > 0.
 * - `reenvioVerificaSku` — whether that re-send can look the listing up: the
 *   produto's SKU is not blank under the import's SKU fold. `false` ⇒ the
 *   re-send refuses (`criacao-incerta-sem-sku`) until the operator confirms in
 *   Seller Centre that nothing was created.
 * - `recusa` — Shopee's own `codigo` and sentence (`fraseShopee`, `null` when
 *   it sent none) when Shopee ANSWERED with an error whose outcome is still
 *   unknown; `null` when no answer arrived at all (network, timeout).
 *
 * ⚠️ `mensagem` (the CLI's sentence) is sent and deliberately NOT declared — the
 * kit's 202 precedent: the browser renders its own copy, and a plain
 * `z.object` drops the key on parse.
 */
export const respostaItemIncertoShopeeSchema = z.object({
  arma: z.literal('item'),
  desfecho: z.literal('incerto'),
  linkDocId: z.string().min(1),
  aguardarMs: z.number().int().positive(),
  reenvioVerificaSku: z.boolean(),
  recusa: z
    .object({
      codigo: z.string(),
      fraseShopee: z.string().nullable(),
    })
    .nullable(),
});
export type RespostaItemIncertoShopee = z.infer<typeof respostaItemIncertoShopeeSchema>;
