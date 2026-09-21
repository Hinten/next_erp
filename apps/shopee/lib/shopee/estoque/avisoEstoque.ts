/**
 * The producer of the `estoqueAcimaDoDisponivel` aviso, and the machine
 * resolver that tipo owes.
 *
 * ONE condition, ONE row: a Shopee promotion has reserved more units of a
 * listing than the ERP actually holds, so the send was clamped **UP** to the
 * reserved floor. Shopee's own rule is the reason — `Σ seller_stock` may not
 * fall below what a live promotion reserved — so the alternative to publishing
 * above the ERP figure is a refusal that leaves the listing at a stale number.
 * We publish, and we tell the operator, because only a human can end the
 * promotion, reduce its reserved stock in Seller Centre, or restock.
 *
 * ⚠️ **A clamp is a SEND with an annotation, never a refusal** — the send
 * happened, the quantity reached Shopee, and `MOTIVOS_QUE_ANOTAM` in
 * `errosEstoque.ts` is where that distinction is declared and pinned. Nothing
 * here may be read as "the listing was skipped".
 *
 * ## ⚠️ This module holds NO unit conversion, and no clock
 *
 * `avisos/autorizacao.ts` is the one module in this app that crosses into
 * microseconds, and it stays that way: the seam ({@link agoraUsDe} for "now",
 * {@link depsDeEscrita} for the writer's deps) is imported from there rather
 * than re-derived here. Everything in this file's own signatures is
 * MILLISECONDS, and `nowMs` is always a parameter — nothing under
 * `lib/shopee/estoque/` reads a clock, which this module's own suite pins as
 * raw source text.
 *
 * ## ⚠️ No `janela`
 *
 * The chave carries `(tipo, conta, entidade)` and deliberately no window.
 * Keying the window on the promotion — its id, its end date, the reserved
 * figure — would make the resolver compute a key that was never created,
 * because Shopee changes the promotion underneath us and the reserved number
 * moves with it. The row raised under the old window would then stand forever,
 * past `sweepAvisosResolvidos`'s 90-day cutoff, on a `serverOwned` collection
 * nobody can dismiss by hand. One row per `(conta, produto)`, refreshed without
 * moving `criadoEm`, resolved by the next send of the same pair that needed no
 * clamp at all, reopened with a fresh `criadoEm` if it lapses back.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type ResultadoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { type AvisoDeps, agoraUsDe, depsDeEscrita } from '../avisos/autorizacao';

/**
 * The dedup identity — and the Firestore document id — of the clamp aviso.
 *
 * ⚠️ `entidade` is the **produtoId**, never the Shopee `item_id`, for the same
 * three reasons `anuncios/avisoAnuncio.ts` gives: `urlInterna` is built from
 * it; every caller holds a produto context; and a produto republished under a
 * NEW `item_id` must collapse onto the SAME row instead of minting a second one
 * for a problem the operator already knows about.
 *
 * ⚠️ It is EXPORTED so the producer and the resolver cannot compute two
 * different keys. A resolver that derives its own key is exactly how a row ends
 * up standing forever.
 *
 * ⚠️ `segmentoChave` folds `/ \ . # [ ] :` and whitespace to `_`, so two
 * produtoIds differing only in a dot vs an underscore collapse onto one aviso.
 * A Firestore document id may legally contain a dot, so that is reachable
 * rather than theoretical. It is the accepted cost of a key that is also a
 * document id, documented on `chaveDeAviso` itself, and this module's suite
 * pins both directions for this tipo.
 */
export function chaveEstoqueAcimaDoDisponivel(integracaoId: string, produtoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.estoqueAcimaDoDisponivel,
    conta: integracaoId,
    entidade: produtoId,
  });
}

/**
 * What the sender knows when a clamp fired. **Numbers and ids only.**
 *
 * ⚠️ There is deliberately no listing title, no promotion body and no produto
 * name here, and none may be added: `params` renders straight into the operator
 * inbox, a Shopee listing title is seller PROSE about a product, and a
 * promotion body carries provider text nobody reviewed. The wording that
 * surrounds these three numbers lives in `apps/web/lib/avisos/mensagens.ts` and
 * reads exactly `anuncio`, `reservado` and `disponivel`.
 */
export interface EntradaAvisoClamp {
  readonly integracaoId: string;
  readonly produtoId: string;
  /** The Shopee listing id — rendered into the message, never used as the key. */
  readonly itemId: number;
  /** The reserved floor the send was raised to — what Shopee promised buyers. */
  readonly piso: number;
  /** What the ERP actually holds for this produto — the smaller of the two. */
  readonly disponivel: number;
}

/**
 * Raise (or refresh) the ONE aviso per `(conta, produto)`: the promotion
 * reserved more than the ERP holds and the send was clamped UP.
 *
 * `severidade: atencao` — the listing is live and selling, the quantity did
 * reach Shopee, and the exposure is bounded by the difference between the two
 * numbers in `params`. `critico` is the only tier that escalates out of the
 * app, which in a three-person team must stay rare enough that nobody learns to
 * ignore it.
 *
 * ⚠️ **`prazo` and `relogioEvento` are OMITTED, not nulled** (spread-or-nothing
 * — here simply by never naming the keys). There is no provider deadline and no
 * provider delivery: this aviso is raised by our own send, from our own clock.
 * `camposInformados` reads an absent optional as "I do not know" and a `null` as
 * "set it to null", so passing `null` for `relogioEvento` would RESET a stored
 * watermark — and a reset watermark is a guard that never rejects anything
 * again (root `CLAUDE.md` rule 7, tier 2).
 */
export async function avisarEstoqueAcimaDoDisponivel(
  db: Firestore,
  entrada: EntradaAvisoClamp,
  deps: AvisoDeps,
): Promise<ResultadoAviso> {
  const { resultado } = await escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.estoqueAcimaDoDisponivel,
      conta: entrada.integracaoId,
      entidade: entrada.produtoId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      // Structured params, never a rendered sentence, and never anything but a
      // number as a string: the pt-BR wording is keyed on `tipo` in
      // `apps/web/lib/avisos/mensagens.ts`, so fixing a wording applies to every
      // row already written.
      params: {
        anuncio: String(entrada.itemId),
        reservado: String(entrada.piso),
        disponivel: String(entrada.disponivel),
      },
      urlInterna: {
        // ⚠️ The PRODUTO, not the conta screen: an operator sent to
        // `/canais/shopee/<id>` learns nothing about which listing is
        // oversubscribed, and the remedies — restock, or end the promotion for
        // this item — both start from the produto.
        rota: ROTAS_AVISO.produto.build(entrada.produtoId),
        campo: null,
      },
    },
    depsDeEscrita(deps),
  );
  return resultado;
}

/**
 * Which fact closed the row. Persisted in `resolucaoMotivo`, so a closed aviso
 * still says WHY, and therefore not free to rename.
 */
export const RESOLUCAO_ESTOQUE_DENTRO_DO_DISPONIVEL = 'estoque-dentro-do-disponivel' as const;

/**
 * The machine resolver this tipo owes: the next send of the same
 * `(conta, produto)` that needed **no** clamp.
 *
 * ⚠️ It is the SEND that resolves, never a read and never a sweep. The clamp is
 * observable only at the moment we compute a quantity against the reserved
 * floor, so "the promotion ended" and "the operator restocked" both reach us
 * the same way — as a send that no longer has to raise anything.
 *
 * ⚠️ The key it computes MUST be the key the producer created, which is why
 * both call {@link chaveEstoqueAcimaDoDisponivel}.
 *
 * ⚠️ It reports a **transition**, not the existence of a document — an
 * already-resolved or never-raised row answers `false`, which is what makes a
 * caller's `avisosResolvidos` counter honest rather than "the document was
 * there". Re-stamping `resolvidoEm` on every clean send would additionally push
 * the row past `sweepAvisosResolvidos`'s 90-day cutoff for ever.
 */
export function resolverEstoqueAcimaDoDisponivel(
  db: Firestore,
  entrada: { integracaoId: string; produtoId: string },
  deps: AvisoDeps,
): Promise<boolean> {
  return resolverAviso(
    db,
    chaveEstoqueAcimaDoDisponivel(entrada.integracaoId, entrada.produtoId),
    RESOLUCAO_ESTOQUE_DENTRO_DO_DISPONIVEL,
    { agoraUs: agoraUsDe(deps) },
  );
}
