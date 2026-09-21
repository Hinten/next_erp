/**
 * The producer of the `anuncioComViolacao` aviso, and the resolver every one of
 * its four call sites shares.
 *
 * Three triggers, ONE producer: Shopee's `push 16` (`violation_item_push`, the
 * BANNED / SHOPEE_DELETE / deboost delivery), `push 27`
 * (`item_scheduled_publish_failed_push`) and the operator-driven
 * `reverificar-anuncio` read all describe the same operator problem — *this
 * listing is not selling and only a human can fix it*. They must collapse onto
 * one row, which is what {@link chaveAnuncioComViolacao} buys: the dedup key IS
 * the document id, so nothing has to be compared and nothing can be lost (root
 * `CLAUDE.md` rule 7, tier 0).
 *
 * `TIPO_AVISO.anuncioComViolacao` and its pt-BR wording already exist — this
 * module is the first PRODUCER. No schema change, and no `apps/web` change.
 *
 * ## ⚠️ This module holds NO unit conversion, and no clock
 *
 * `avisos/autorizacao.ts` is the one module in this app that crosses into
 * microseconds, and it stays that way: both seams ({@link agoraUsDe} for "now",
 * {@link prazoUsDe} for a provider deadline) are imported from there rather than
 * re-derived here. Everything in this file's own signatures is MILLISECONDS, and
 * `nowMs` is always a parameter — nothing under `lib/shopee/anuncios/` reads a
 * clock, which `autorizacao.test.ts` pins as raw source text over this whole
 * directory.
 *
 * ## ⚠️ No `janela`
 *
 * The chave carries `(tipo, conta, entidade)` and deliberately no window.
 * Keying the window on the violation — its type, or its `fix_deadline_time` —
 * would make the resolver compute a key that was never created, because Shopee
 * changes the violation as the seller edits the listing. The row raised under
 * the old window would then stand forever, past `sweepAvisosResolvidos`'s
 * 90-day cutoff, on a `serverOwned` collection nobody can dismiss by hand. One
 * row per `(conta, produto)`, repeated without moving `criadoEm`, resolved the
 * moment the listing reads clean again, reopened with a fresh `criadoEm` if it
 * lapses back.
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

import { type AvisoDeps, agoraUsDe, depsDeEscrita, prazoUsDe } from '../avisos/autorizacao';

/**
 * The dedup identity — and the Firestore document id — of the violation aviso.
 *
 * ⚠️ `entidade` is the **produtoId**, never the Shopee `item_id`, for three
 * reasons that all point the same way: `urlInterna` is built from it; all four
 * resolvers hold a produto context; and a produto whose listing is republished
 * under a NEW `item_id` (a delete plus a re-publish) has to collapse onto the
 * SAME row instead of minting a second one for a problem the operator already
 * knows about.
 *
 * ⚠️ `segmentoChave` folds `/ \ . # [ ] :` and whitespace to `_`, so two
 * produtoIds differing only in a dot vs an underscore collapse onto one aviso.
 * A Firestore document id may legally contain a dot, so that is reachable rather
 * than theoretical. It is the accepted cost of a key that is also a document id,
 * documented on `chaveDeAviso` itself, and `avisoAnuncio.test.ts` pins both
 * directions for this tipo.
 */
export function chaveAnuncioComViolacao(integracaoId: string, produtoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.anuncioComViolacao,
    conta: integracaoId,
    entidade: produtoId,
  });
}

/**
 * WHY the listing needs a human — the `motivo` stored beside the tipo.
 *
 * Three reasons, three different operator remedies, which is why it is a field
 * rather than folded into `tipo`: a violation is fixed in Seller Centre, a
 * deboost by moving the listing's category, a failed scheduled publish by
 * publishing again.
 */
export type MotivoAvisoAnuncio = 'violacao' | 'deboost' | 'agendamento-falhou';

/** Named members of {@link MotivoAvisoAnuncio} — persisted, so not free to rename. */
export const MOTIVO_AVISO_ANUNCIO = {
  violacao: 'violacao',
  deboost: 'deboost',
  agendamentoFalhou: 'agendamento-falhou',
} as const satisfies Record<string, MotivoAvisoAnuncio>;

/**
 * What `params.violacao` says when the delivery carries no `violation_type`.
 *
 * ⚠️ These are the app's OWN words, and they are here rather than inline so the
 * operator inbox cannot end up rendering provider prose by accident — see the
 * warning on {@link EventoAnuncioComViolacao.violacaoTipo}. `push 27` carries no
 * violation at all, and a code-16 `item_status_details[]` row may legitimately
 * arrive with a null `violation_type`, so every arm below is reachable.
 */
const FRASE_SEM_TIPO = {
  violacao: 'violação sem tipo informado',
  deboost: 'rebaixamento na busca',
  'agendamento-falhou': 'publicação agendada falhou',
} as const satisfies Record<MotivoAvisoAnuncio, string>;

export interface EventoAnuncioComViolacao {
  readonly integracaoId: string;
  readonly produtoId: string;
  /** The Shopee listing id — rendered into the message, never used as the key. */
  readonly itemId: number;
  readonly motivo: MotivoAvisoAnuncio;
  /**
   * The FIRST `violation_type` of the delivery, or `null`.
   *
   * ⚠️ **Never `violation_reason`, and never `suggestion`.** Those two are
   * provider PROSE about a seller's listing — a real one reads as a full pt-BR
   * sentence naming the product — they are on the wire-fixture redaction
   * denylist for exactly that reason, and `params` renders straight into the
   * operator inbox. `violation_type` is a closed seven-value Shopee vocabulary
   * (`Prohibited Listing`, `Counterfeit and IP Infringement`, `Spam`,
   * `Inappropriate Image`, `Insufficient Information`, `Mall Listing
   * Improvement`, `Other Listing Improvement`) and is safe by construction.
   */
  readonly violacaoTipo: string | null;
  /**
   * `fix_deadline_time` in MILLISECONDS, or `null`.
   *
   * `push 16` documents it as *"Action required deadline. Empty if no
   * deadline"*, so `null` is a legitimate reading rather than a missing value,
   * and it is passed explicitly so the field is stated instead of left unknown.
   */
  readonly prazoMs: number | null;
  /**
   * Shopee's own delivery clock (the push envelope `timestamp`), in ms.
   *
   * ⚠️ **OMIT it when there is no provider delivery** — which is what the
   * `reverificar-anuncio` path and the publish read-back do. An absent optional
   * means "I do not know" and leaves the stored watermark alone; passing `null`
   * would RESET it, and a reset watermark is a guard that never rejects
   * anything again, so the next stale redelivery would be applied instead of
   * dropped (root `CLAUDE.md` rule 7, tier 2).
   */
  readonly relogioEventoMs?: number;
}

/**
 * Raise (or refresh) "this Shopee listing has a violation".
 *
 * `severidade: atencao` — the listing is down on ONE channel and the remedy is
 * Seller Centre or the produto's Shopee tab. `critico` is the only tier that
 * escalates out of the app, which in a three-person team must stay rare enough
 * that nobody learns to ignore it.
 *
 * ⚠️ **`params.prazo` is deliberately OMITTED.** The rendered wording
 * interpolates that param raw, so a number there would read as
 * `Prazo para corrigir: 1789000000000000.` — the µs the schema stores. Omitting
 * the param makes that branch not fire, and the `prazo` FIELD below carries the
 * deadline for the panel to format properly.
 */
export function avisarAnuncioComViolacao(
  db: Firestore,
  evento: EventoAnuncioComViolacao,
  deps: AvisoDeps,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: evento.integracaoId,
      entidade: evento.produtoId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      // Structured params, never a rendered sentence: the pt-BR wording lives in
      // `apps/web/lib/avisos/mensagens.ts` and reads exactly `anuncio` and
      // `violacao`, so fixing a wording applies to every row already written.
      params: {
        anuncio: String(evento.itemId),
        violacao: evento.violacaoTipo ?? FRASE_SEM_TIPO[evento.motivo],
      },
      motivo: evento.motivo,
      urlInterna: {
        // ⚠️ The PRODUTO, not the conta screen: an operator sent to
        // `/canais/shopee/<id>` learns nothing about which listing is banned.
        // `campo: null` because the fix is at Shopee or in the produto's Shopee
        // tab, and there is no field to focus yet.
        rota: ROTAS_AVISO.produto.build(evento.produtoId),
        campo: null,
      },
      // The provider's own deadline, copied rather than computed — we do not
      // know Shopee's business-day rules, and a deadline we invented is worse
      // than none. `null` in, `null` out.
      prazo: prazoUsDe(evento.prazoMs),
      // ⚠️ Spread-or-nothing, never `relogioEvento: undefined` and never `null`:
      // see the field's docblock above.
      ...(evento.relogioEventoMs === undefined ? {} : { relogioEvento: evento.relogioEventoMs }),
    },
    depsDeEscrita(deps),
  );
}

/**
 * Which fact closed the row. Both are persisted in `resolucaoMotivo`, so a
 * closed aviso still says WHY, and neither is free to rename.
 */
export const MOTIVO_RESOLUCAO_ANUNCIO = {
  /** The listing reads NORMAL, not deboosted, with no violation rows. */
  normalizado: 'anuncio-normalizado',
  /** Shopee no longer has the listing at all, so the violation is moot. */
  removido: 'anuncio-removido',
} as const;

/**
 * The machine resolver this tipo names — called from four places.
 *
 * 1. the **code-16** handler, when the authoritative re-read shows `NORMAL`
 *    and not deboosted and no violation rows ⇒ `normalizado`;
 * 2. **`reverificar-anuncio`**, on the same condition ⇒ `normalizado`;
 * 3. the **publish read-back**, on the same condition ⇒ `normalizado`;
 * 4. the **`removido`** arm ⇒ `removido`. A listing Shopee deleted is not
 *    "normalized", but its violation aviso is moot and nothing else would ever
 *    close it — and an aviso nothing resolves stands until retention sweeps it,
 *    on a collection with no dismiss button.
 *
 * ⚠️ The key it computes MUST be the key the producer created. It is the same
 * exported function: a resolver that derives its own key is how a row ends up
 * standing forever.
 *
 * ⚠️ It reports a **transition**, not the existence of a document — an
 * already-resolved or never-raised row answers `false`, which is what makes a
 * caller's `avisoResolvido` counter honest rather than "the document was there".
 */
export function resolverAvisoDeAnuncio(
  db: Firestore,
  alvo: { integracaoId: string; produtoId: string },
  motivo: string,
  deps: { nowMs: number },
): Promise<boolean> {
  return resolverAviso(db, chaveAnuncioComViolacao(alvo.integracaoId, alvo.produtoId), motivo, {
    agoraUs: agoraUsDe(deps),
  });
}
