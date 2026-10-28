/**
 * **The Shopee DRAFT's shared rules** (#1911) — what a `prodshopee` document
 * with no `item_id` (a draft, `ehRascunhoShopee`) means to every surface that
 * decides about one: the publish lock's timing, the codes a refused draft
 * operation answers with, the reading of the lock, the "brand still to choose"
 * test, and which sibling links make a publish a SECOND listing.
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
 * checked immediately before EACH `add_item` call (a route run's
 * `prazoDaRequisicao` is its start + TETO_ROTA_SHOPEE_MS; the CLI has none). So
 * no create starts at or after `expiraEm − MARGEM`. A lock nobody cleared is
 * then read, by {@link estadoPublicacaoRascunhoShopee}:
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

import { AGUARDAR_KIT_INCERTO_SHOPEE_MS } from '../../shopeeAcaoSugerida';
import { publicacaoEmCursoShopeeSchema } from './shopeeLink';
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
 * request's deadline (`prazoDaRequisicao = nowMs + TETO_ROTA_SHOPEE_MS`), so a
 * create is never STARTED by a request the platform may cut off mid-send.
 * ⚠️ Changing either number alone breaks that promise silently.
 */
export const TETO_ROTA_SHOPEE_MS = 180_000;

/**
 * MILLISECONDS. The headroom the per-leg send gate keeps before
 * `min(expiraEm, prazoDaRequisicao)` — it covers the client's token step that
 * runs between the gate and the request reaching Shopee.
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

/** A stored MILLISECOND instant, or `null` when the value is not a safe integer. */
function msLegivel(bruto: unknown): number | null {
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
 * `criacaoIncertaDesde`, the record of an earlier create whose outcome is
 * unknown — absent on every document that has none.
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
  const desdeDaIncerteza = msLegivel(incertaBruta);

  const trava = link.publicacaoEmCurso;
  if (trava === null || trava === undefined) {
    return comIncerteza ? { tipo: 'incerta', desdeMs: desdeDaIncerteza } : LIVRE;
  }

  const lida = publicacaoEmCursoShopeeSchema.safeParse(trava);
  if (!lida.success) return { tipo: 'incerta', desdeMs: desdeDaIncerteza };
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

  return { tipo: 'incerta', desdeMs: desdeDaIncerteza ?? desde };
}

/* -------------------------------------------------------------------------- */
/*                         The brand still to choose                           */
/* -------------------------------------------------------------------------- */

/**
 * Is this a DRAFT whose brand was never chosen (#1911, D10)? A draft stores
 * the brand the operator picked; "Sem marca" is the explicit `brand_id: 0`, so
 * only a `brand_id` that is `null` or ABSENT means "nobody chose". It is the
 * test behind the listing assembly's `marca-nao-escolhida` refusal, and a
 * browser surface that warns about the same thing imports it (#1369).
 *
 * - **EQUAL (no brand chosen):** a draft with `brand_id: null`; a draft with no
 *   `brand_id` key.
 * - **DISTINCT:** `brand_id: 0` ("Sem marca" IS a choice); any other stored
 *   value, a malformed one included — this answers "was a brand chosen", and
 *   what a malformed id sends is the assembly's question;
 * - **DISTINCT:** any link that is not a draft ({@link ehRascunhoShopee}) — an
 *   imported listing with `brand_id: null` was never the operator's to pick
 *   here — and a `null` document.
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
  return link.brand_id === null || link.brand_id === undefined;
}

/* -------------------------------------------------------------------------- */
/*                   The links that make a SECOND listing (D15)                */
/* -------------------------------------------------------------------------- */

/**
 * One sibling link a publish (or a new draft) would sit beside — the item of a
 * 409's `vinculos[]`. `itemId` is the listing's id, `null` for a draft.
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
    const itemId = data.item_id;
    if (anuncioShopeeVivo(data) && typeof itemId === 'number') {
      saida.push({ linkDocId: id, itemId, rascunho: false });
    } else if (ehRascunhoShopee(data)) {
      saida.push({ linkDocId: id, itemId: null, rascunho: true });
    }
  }
  return saida;
}
