/**
 * The producer of the `reclamacaoAguardandoVendedor` aviso for a Shopee return
 * (#1525, step 17), and the machine resolver the tipo owes
 * (`packages/schemas/src/aviso.ts`, the tipo docblock: every member names its
 * resolver before it ships).
 *
 * ONE row per RETURN — `chaveDeAviso({ tipo, conta: integracaoId, entidade:
 * returnSn })`, no `janela` (the `avisos/autorizacao.ts` reason: a windowed key
 * is a key the resolver cannot recompute). The `entidade` is the return_sn
 * ALONE: it is alphanumeric (`ehReturnSnShopee`), so the segment fold never
 * touches it, and a pedido with two returns carries two rows.
 *
 * ## What the aviso says
 *
 * Open while the CONFIRMED return waits for the seller —
 * {@link pendenciaDoVendedor} (`devolucaoMapping.ts`, the ONE home of that rule)
 * answers a pendência; resolved when it answers `null` (terminal, accepted, or
 * the offer/evidence answered). Open-row `params` are exactly `{ pedido,
 * devolucao, pendencia }`; a first observation that is already resolved carries
 * only `{ pedido, devolucao }`, with no invented pending action. The wording
 * lives in `apps/web/lib/avisos/mensagens.ts`; `motivo` is Shopee's raw status token; `prazo` is the CHOSEN
 * pendência's deadline, copied in µs — and an explicit `null` when that
 * pendência has none, because a stored deadline of an earlier state would be a
 * wrong promise, not an unknown. Severity `atencao`.
 *
 * ## ⚠️ Derived from the transaction's CONFIRMED state, never from the delivery
 *
 * The input is `devolucaoTx.ts`'s {@link PrevisaoDevolucao} — what the
 * incidente holds once the transaction is over — so a stale detail can neither
 * raise nor resolve this row: it reads `ignorado-obsoleto`, which projects
 * NOTHING. Which outcomes project, and why each:
 *
 * | outcome | effect |
 * |---|---|
 * | `criado`, `atualizado` | ALWAYS — every content change, `mudouAviso` or not (below) |
 * | `ignorado-sem-mudanca` | ALWAYS — the replay (below) |
 * | `relogio-avancado` | NONE — a watermark-only advance writes nothing here either |
 * | `ignorado-obsoleto`, `ignorado-sem-pedido` | NONE — nothing was confirmed by this delivery |
 *
 * ⚠️ **`atualizado` projects even when `mudouAviso` is false.** A delivery
 * whose transaction committed and whose aviso write then failed is retried by
 * the queue — and when Shopee changed a field the aviso does not show (the
 * refund amount) in between, the retry reads `atualizado` with `mudouAviso:
 * false`. Gating on that flag lost the effect for good: a REQUESTED return sat
 * unalerted until Shopee refunded the buyer at its deadline (review on #1762).
 * The price is bounded by Shopee's content revisions, never by bare
 * `update_time` bumps (that is `relogio-avancado`, below): on an open row whose
 * effect already landed, `escreverAviso` answers `repetido` — `ocorrencias` + 1
 * and a newer clock, with `criadoEm` UNTOUCHED, so the read state
 * (`avisoNaoLido` keys on `criadoEm`) stays and nothing re-alerts; the panel's
 * `×N` then counts the return's revisions while it waits. On a resolved row it
 * advances the clock alone (`resolverAviso`).
 *
 * ⚠️ **`ignorado-sem-mudanca` re-applies on purpose.** A delivery whose
 * transaction committed and whose aviso write then failed is redelivered by the
 * queue, and its second run reads `ignorado-sem-mudanca` (`mudouAviso: false`
 * — the TRANSACTION changed nothing). Gating on `mudouAviso` alone would lose
 * that effect until the next content change. Re-applying is churn-free under
 * the event clock: on that outcome the incoming watermark EQUALS the stored one
 * and the block is the stored one, so the clock is the one the first run used —
 * `escreverAviso` drops an equal `relogioEvento` and `resolverAviso` skips a
 * stored one `>=` the given, so a replay that already landed writes nothing.
 * The one write it can cost: a row whose stored clock is OLDER than the
 * confirmed state's (the state moved by a watermark-only advance in between) is
 * refreshed once — a `repetido`, or a resolved row's clock advanced — after
 * which every further replay is equal and dropped.
 *
 * ⚠️ **`relogio-avancado` projects nothing, and its residual is stated.** The
 * clock below rises with the watermark, so projecting there would rewrite the
 * row (`ocorrencias` + 1, `atualizadoEm`) every time Shopee bumps `update_time`
 * without a content change — the churn the watermark-only patch exists to
 * avoid. The price: a lost effect whose REPLAY reads a newer `update_time` with
 * the same content stays lost until a later delivery reads
 * `ignorado-sem-mudanca` or `atualizado` (any content change).
 * Rebuilding the old clock there would need the PREVIOUS watermark, which
 * {@link EstadoConfirmadoDevolucao} does not carry (and a chain of advances
 * would not preserve it).
 *
 * ## The event clock (rule 7 tier 2)
 *
 * `relogioEvento = relogioDoAvisoDeDevolucao(relogioProvedorUs, revisao)` —
 * the CONFIRMED watermark plus the confirmed `revisao` (capped below a second):
 * monotone in the transactions' commit order, strictly rising per content
 * change, and passed to BOTH `escreverAviso` and `resolverAviso`. So two
 * deliveries of one return whose aviso effects run in the inverse order of
 * their commits cannot leave the older state standing: a late older raise is
 * dropped by the newer row's clock, and a late older resolve is skipped by it.
 * When the two effects run CONCURRENTLY, a resolve whose update loses its
 * precondition to the other write re-reads and re-decides under the clock
 * (bounded, `escreverAviso.ts`) instead of reading the loss as "already
 * resolved".
 * A resolve that finds no row atomically creates a complete resolved row with
 * that clock, so a delayed FIRST raise also loses to the newer observation.
 * Creating this row answers `inalterado`: no open notice was closed, and no
 * operator is alerted. It expires under the existing 90-day retention sweep.
 * A lost creation race re-reads the winner; exhausted clocked attempts throw
 * so the delivery retries instead of succeeding without its clock.
 *
 * ## Units
 *
 * This module converts nothing: the deadline and the watermark arrive in µs
 * (`devolucaoMapping.ts` crossed them through `microsDeSegundosShopee`), and
 * "now" crosses into µs through the seam in `avisos/autorizacao.ts`
 * ({@link agoraUsDe} / {@link depsDeEscrita}). The µs site list in
 * `apps/shopee/CLAUDE.md` still says eight.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { escreverAviso, resolverAviso, type PlanoAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  STATUS_CLAIM,
  TIPO_AVISO,
  chaveDeAviso,
  type PendenciaReclamacao,
} from '@delfrance/schemas';

import { type AvisoDeps, agoraUsDe, depsDeEscrita } from '../avisos/autorizacao';
import { pendenciaDoVendedor, relogioDoAvisoDeDevolucao } from './devolucaoMapping';
import type { EstadoConfirmadoDevolucao, PrevisaoDevolucao } from './devolucaoTx';

/* -------------------------------------------------------------------------- */
/*                                  the chave                                  */
/* -------------------------------------------------------------------------- */

/**
 * The dedup identity — and the Firestore document id — of a return's aviso.
 *
 * ⚠️ Exported so the producer, the resolver and any reader derive the SAME
 * key; a resolver that computes its own is how a row ends up standing forever.
 */
export function chaveDoAvisoDeDevolucao(integracaoId: string, returnSn: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.reclamacaoAguardandoVendedor,
    conta: integracaoId,
    entidade: returnSn,
  });
}

/* -------------------------------------------------------------------------- */
/*                                 the decision                                */
/* -------------------------------------------------------------------------- */

/**
 * Which fact closed the row. Persisted in `resolucaoMotivo`, so a closed aviso
 * still says WHY — and therefore not free to rename.
 */
export const RESOLUCAO_AVISO_DEVOLUCAO = {
  /** The return reached a terminal status (`STATUS_DEVOLUCAO_TERMINAIS`). */
  devolucaoEncerrada: 'devolucao-encerrada',
  /** Still open, but nothing waits for the seller (accepted, offer or evidence answered). */
  semPendencia: 'sem-pendencia-do-vendedor',
} as const;

export type ResolucaoAvisoDevolucao =
  (typeof RESOLUCAO_AVISO_DEVOLUCAO)[keyof typeof RESOLUCAO_AVISO_DEVOLUCAO];

/** What one confirmed return state does to its aviso. Pure data — the dry run prints it. */
export type EfeitoAvisoDevolucao =
  | { readonly efeito: 'nenhum' }
  | {
      readonly efeito: 'abrir';
      readonly pendencia: PendenciaReclamacao;
      /** µs, copied from the block; `null` when the chosen pendência has no deadline. */
      readonly prazoUs: number | null;
      /** Shopee's raw status token — the aviso's `motivo`. */
      readonly status: string;
      readonly relogioEvento: number;
    }
  | {
      readonly efeito: 'resolver';
      readonly resolucao: ResolucaoAvisoDevolucao;
      readonly relogioEvento: number;
    };

/** What {@link aplicarAvisoDeDevolucao} did to the row. */
export type ResultadoAvisoDevolucao = 'aberto' | 'resolvido' | 'inalterado';

const NENHUM: EfeitoAvisoDevolucao = { efeito: 'nenhum' };

/** The confirmed state is projected only on these — see the module table. */
function projetaOAviso(previsao: PrevisaoDevolucao): boolean {
  switch (previsao.acao) {
    case 'criado':
    case 'atualizado':
      // Every content change, `mudouAviso` or not: a lost effect's retry can
      // read `atualizado` for a field the aviso never shows (module docblock).
      return true;
    case 'ignorado-sem-mudanca':
      // The replay: idempotent under the event clock (module docblock).
      return true;
    case 'relogio-avancado':
    case 'ignorado-obsoleto':
    case 'ignorado-sem-pedido':
      return false;
    default: {
      const nunca: never = previsao.acao;
      return nunca;
    }
  }
}

/**
 * The aviso effect of ONE transaction outcome, as a pure function — the
 * `importar:devolucao` dry run prints the same answer a live delivery applies.
 *
 * `relogioProvedorUs` is the CONFIRMED state's watermark. The importer passes
 * the mapped one, which equals it on exactly the three outcomes that project:
 * `criado`/`atualizado` wrote it, and `ignorado-sem-mudanca` is the
 * equal-clock outcome by construction.
 *
 * @throws RangeError when a projecting outcome carries no confirmed block or
 *   claim status — impossible from `devolucaoTx.ts` (a write sets both, and an
 *   equal-content verdict needs both), so a loud failure beats an aviso derived
 *   from nothing.
 */
export function preverEfeitoDoAvisoDeDevolucao(
  previsao: PrevisaoDevolucao,
  relogioProvedorUs: number,
): EfeitoAvisoDevolucao {
  if (!projetaOAviso(previsao)) return NENHUM;

  const { claimStatus, bloco }: EstadoConfirmadoDevolucao = previsao.confirmado;
  if (bloco === null || claimStatus === null) {
    throw new RangeError(
      `preverEfeitoDoAvisoDeDevolucao: o desfecho ${previsao.acao} não trouxe o estado confirmado`,
    );
  }

  const relogioEvento = relogioDoAvisoDeDevolucao(relogioProvedorUs, bloco.revisao);
  const pendente = pendenciaDoVendedor(claimStatus, bloco);
  if (pendente !== null) {
    return {
      efeito: 'abrir',
      pendencia: pendente.pendencia,
      prazoUs: pendente.prazoUs,
      status: bloco.status,
      relogioEvento,
    };
  }
  return {
    efeito: 'resolver',
    resolucao:
      claimStatus === STATUS_CLAIM.fechada
        ? RESOLUCAO_AVISO_DEVOLUCAO.devolucaoEncerrada
        : RESOLUCAO_AVISO_DEVOLUCAO.semPendencia,
    relogioEvento,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  the effect                                 */
/* -------------------------------------------------------------------------- */

export interface AplicarAvisoDeDevolucaoParams {
  /** The integração document id — the dedup conta. */
  readonly integracaoId: string;
  /** The pedido document id — the aviso's link target. */
  readonly pedidoId: string;
  /** Shopee's `order_sn`, as the operator sees it — `params.pedido`. */
  readonly orderSn: string;
  /** Shopee's `return_sn` — the dedup entidade and `params.devolucao`. */
  readonly returnSn: string;
  /** The transaction's own outcome. */
  readonly previsao: PrevisaoDevolucao;
  /** The confirmed watermark, µs — see {@link preverEfeitoDoAvisoDeDevolucao}. */
  readonly relogioProvedorUs: number;
}

/**
 * Apply ONE transaction outcome to the return's aviso, OUTSIDE the transaction
 * and after it committed.
 *
 * - `'aberto'` — `escreverAviso` wrote the row (created, repeated or reopened);
 * - `'resolvido'` — `resolverAviso` closed an open row;
 * - `'inalterado'` — nothing projected, or the event clock dropped the write,
 *   or there was no open row to close (a resolved clock may still be recorded).
 *
 * A Firestore failure PROPAGATES (rule 6, no catch): the delivery fails, the
 * queue redelivers, the transaction reads `ignorado-sem-mudanca` — or
 * `atualizado`, when Shopee changed the return in between — and this effect is
 * tried again (module docblock).
 */
export async function aplicarAvisoDeDevolucao(
  db: Firestore,
  p: AplicarAvisoDeDevolucaoParams,
  deps: AvisoDeps,
): Promise<ResultadoAvisoDevolucao> {
  const efeito = preverEfeitoDoAvisoDeDevolucao(p.previsao, p.relogioProvedorUs);
  const base: Omit<PlanoAviso, 'relogioEvento'> = {
    tipo: TIPO_AVISO.reclamacaoAguardandoVendedor,
    conta: p.integracaoId,
    entidade: p.returnSn,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.shopee,
    params: { pedido: p.orderSn, devolucao: p.returnSn },
    urlInterna: { rota: ROTAS_AVISO.pedido.build(p.pedidoId), campo: null },
  };
  switch (efeito.efeito) {
    case 'nenhum':
      return 'inalterado';
    case 'abrir': {
      const { resultado } = await escreverAviso(
        db,
        {
          ...base,
          params: { ...base.params, pendencia: efeito.pendencia },
          motivo: efeito.status,
          // ⚠️ `null` is STATED, never omitted: the chosen pendência has no
          // deadline, and an earlier state's deadline must not survive it.
          prazo: efeito.prazoUs,
          relogioEvento: efeito.relogioEvento,
        },
        depsDeEscrita(deps),
      );
      return resultado === 'ignorado' ? 'inalterado' : 'aberto';
    }
    case 'resolver': {
      const fechou = await resolverAviso(
        db,
        chaveDoAvisoDeDevolucao(p.integracaoId, p.returnSn),
        efeito.resolucao,
        { agoraUs: agoraUsDe(deps) },
        { ...base, relogioEvento: efeito.relogioEvento },
      );
      return fechou ? 'resolvido' : 'inalterado';
    }
    default: {
      const nunca: never = efeito;
      return nunca;
    }
  }
}
