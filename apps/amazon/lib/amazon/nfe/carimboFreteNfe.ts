/**
 * The NF-e upload's two Firestore writes to the PEDIDO (step 14, PR 14-c): the
 * STAMP — `freteInicial.estado = error` when Amazon provably refused THIS NF-e
 * ({@link carimbarFreteNfeAmazon}) — and its CLEAR — back to
 * `aguardandoAgendamento` once step 14's own Delivery-API acceptance is read
 * ({@link limparCarimboNfeAmazon}). Nothing else on the pedido is ever written
 * by the NF-e upload.
 *
 * ## What decides that a stamp happens — not this module
 *
 * WHETHER an outcome stamps is `motivosNfe.ts`'s `MOTIVOS_NFE_QUE_CARIMBAM`, the
 * only source of that answer; the task consults it before calling here. This
 * module decides only whether the STORED freight may still take the stamp (or
 * the clear), from a FRESH read, through the pure {@link preverCarimboNfeAmazon}
 * and {@link preverLimpezaNfeAmazon}.
 *
 * ## The stamp's guards, in order (each a no-write answer)
 *
 *  1. no pedido ⇒ `sem-pedido` (an update never creates);
 *  2. `freteInicial` not a map ⇒ `sem-frete`;
 *  3. `externalOptionIntegracao` not EXACTLY `amz` ⇒ `outra-integradora` (an
 *     absent owner refuses too: a block not proved the channel's is never ours
 *     to mark);
 *  4. stored `error` ⇒ `ja-carimbado`, ZERO writes — a replay never re-stamps,
 *     or every replay would move `ultimaModificacao`;
 *  5. stored estado outside the enum ⇒ `estado-ilegivel`;
 *  6. stored estado outside `ESTADOS_FRETE_CARIMBAVEIS_NFE_AMAZON`
 *     (`frete/estadoFreteAmazon.ts`) ⇒ `fora-do-escopo` — never over
 *     `aguardandoPostagem` or anything after it (a physical fact makes the stamp
 *     obsolete), a failure, a return or another modality's estado;
 *  7. the freight verdict `estadoFreteAmazonAplicavel(stored, error, { maisNovo:
 *     true, logistica })` must say write (an AFN order's block is never ours to
 *     move) ⇒ else `veredito-recusou`;
 *  8. the stored block must parse (`freteDoPedidoSchema`, as the importer's own
 *     update path requires) ⇒ else `frete-ilegivel`.
 *
 * ## The clear's guards
 *
 * 1–3 and 5 as above; then `estadoFreteAposAceiteNfeAmazon(stored)` — ONLY a
 * stored `error` clears, to `aguardandoAgendamento`; anything else ⇒
 * `sem-carimbo`, ZERO writes. ⚠️ Applied DIRECTLY, never through the freight
 * verdict: the verdict REFUSES `error → aguardandoAgendamento` (gate 5, so the
 * importer's order-level `ACCEPTED` never clears the stamp), and that refusal
 * stays pinned. Only step 14's own Delivery-API acceptance clears it (step-14
 * plan §3 decision 12).
 *
 * ## The write — Shopee's shape, rule 7 tier 1
 *
 * `update({ freteInicial: { ...stored, estado }, ultimaModificacao }, {
 * lastUpdateTime: snap.updateTime })` on THIS attempt's own read:
 *
 * - `freteInicial` is ONE top-level key and an update masks at top-level keys,
 *   so the block is rebuilt WHOLE from the snapshot — `pacotes`, `codRastreio`
 *   and the nested `freteInicial.ultimaModificacao` CARRIED as stored. ⚠️ That
 *   nested field is Amazon's ORDER clock (`camposFreteAmazon`'s
 *   `relogioPedidoUs`), which the importer rewrites whenever it differs: it is
 *   never assigned here, so the next import of an UNCHANGED order still answers
 *   `sem-mudanca`.
 * - the TOP-LEVEL `ultimaModificacao` (µs, monotone: `max(stored, now)`; what
 *   the TableView update monitor reads) is the one bumped. The stored side goes
 *   through `coerceToMicros` (legacy ms integers, ISO text); `nowUs` arrives
 *   already in µs (`avisos.ts`'s `agoraUsDe`, the caller's).
 * - ⚠️ NEVER `lastMarketplaceUpdate` (the importer's watermark: writing it would
 *   make the next import read the stamp as a fresher Amazon observation) and
 *   never another field.
 *
 * A lost precondition (FAILED_PRECONDITION 9, or NOT_FOUND 5 — the stamp
 * REPLACES the `exists` check) RE-READS and RE-DECIDES everything from the
 * winner's document — the losing patch is never re-applied — at most
 * {@link MAX_TENTATIVAS_CARIMBO_NFE_AMAZON} attempts, then the NAMED
 * {@link AmazonNfeCarimboEmConflitoError} (the task contains it after a submit).
 * Against the importer this re-derivation IS the guard: whichever of the two
 * commits second re-derives from the other's result. Between the task's OWN
 * writes for one order there is no event clock: the queue's
 * `maxConcurrentDispatches: 1` orders them (`functions/src/index.test.ts`).
 *
 * ⚠️ Stock-neutral by construction: `error` and `aguardandoAgendamento` are both
 * outside `ESTADOS_FRETE_REMOVE_ESTOQUE`, and the stamp is written only over an
 * estado outside it, so the stock sync never sees a removal undone.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document atomic-write
 * API — not even in a comment (`firestore-transaction-inventory.test.js` greps
 * the bare word): the stamp is tier 1, a single-document precondition.
 *
 * No log line here: the task's ONE dispatch line carries the returned motivo.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { coerceToMicros } from '@delfrance/core/datetime';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  ESTADO_FRETE,
  INTEGRACAO_FRETE,
  MARKETPLACE_PEDIDO_TIPO,
  type EstadoFrete,
  estadoFreteSchema,
  freteDoPedidoSchema,
} from '@delfrance/schemas';

import {
  ESTADOS_FRETE_CARIMBAVEIS_NFE_AMAZON,
  estadoFreteAmazonAplicavel,
  estadoFreteAposAceiteNfeAmazon,
  logisticaAmazon,
} from '../frete/estadoFreteAmazon';

/** Read-decide-write attempts before {@link AmazonNfeCarimboEmConflitoError}. */
export const MAX_TENTATIVAS_CARIMBO_NFE_AMAZON = 3;

/** What one stamp or clear did. Only `carimbado` and `limpo` wrote anything. */
export type MotivoCarimboNfeAmazon =
  | 'carimbado'
  | 'limpo'
  | 'sem-pedido'
  | 'sem-frete'
  | 'outra-integradora'
  | 'ja-carimbado'
  | 'estado-ilegivel'
  | 'fora-do-escopo'
  | 'veredito-recusou'
  | 'frete-ilegivel'
  | 'sem-carimbo';

/** The patch a stamp or a clear writes — exactly these two top-level keys. */
export interface PatchCarimboNfeAmazon {
  readonly freteInicial: Record<string, unknown>;
  readonly ultimaModificacao: number;
}

/** A decision: the patch is non-null exactly when the motivo writes. */
export type PrevisaoCarimboNfeAmazon =
  | { readonly motivo: 'carimbado' | 'limpo'; readonly patch: PatchCarimboNfeAmazon }
  | {
      readonly motivo: Exclude<MotivoCarimboNfeAmazon, 'carimbado' | 'limpo'>;
      readonly patch: null;
    };

/**
 * The stamp kept losing its precondition: the pedido kept moving under it.
 * Retryable; NAMED so the NF-e task contains it after a submit (a throw there
 * would resubmit through the queue).
 */
export class AmazonNfeCarimboEmConflitoError extends Error {
  readonly pedidoId: string;
  readonly tentativas: number;

  constructor(pedidoId: string, tentativas: number) {
    super(
      `o pedido ${pedidoId} mudou durante as ${String(tentativas)} tentativas de gravar o ` +
        'estado do frete da NF-e',
    );
    this.name = 'AmazonNfeCarimboEmConflitoError';
    this.pedidoId = pedidoId;
    this.tentativas = tentativas;
  }
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/** The top-level clock after a write: µs, never below what is stored. */
function ultimaModificacaoUs(raw: Readonly<Record<string, unknown>>, nowUs: number): number {
  const guardada = coerceToMicros(raw.ultimaModificacao);
  return guardada === null || nowUs > guardada ? nowUs : guardada;
}

/** Guards 1–3 and 5 of both decisions; the owned block and its estado, or a refusal. */
function blocoDoCanal(raw: Readonly<Record<string, unknown>> | null):
  | { readonly ok: true; readonly bloco: Record<string, unknown>; readonly estado: EstadoFrete }
  | {
      readonly ok: false;
      readonly motivo: 'sem-pedido' | 'sem-frete' | 'outra-integradora' | 'estado-ilegivel';
    } {
  if (raw === null) return { ok: false, motivo: 'sem-pedido' };
  const bloco = objeto(raw.freteInicial);
  if (bloco === null) return { ok: false, motivo: 'sem-frete' };
  // Strict equality on the stored slug: absent, another channel, another case
  // — a block not PROVED the channel's is never ours to move.
  if (bloco.externalOptionIntegracao !== INTEGRACAO_FRETE.amazon) {
    return { ok: false, motivo: 'outra-integradora' };
  }
  const estado = estadoFreteSchema.safeParse(bloco.estado);
  if (!estado.success) return { ok: false, motivo: 'estado-ilegivel' };
  return { ok: true, bloco, estado: estado.data };
}

/** The whole block, re-validated as the importer's update path requires, at `estado`. */
function blocoReescrito(
  bloco: Record<string, unknown>,
  estado: EstadoFrete,
): Record<string, unknown> | null {
  const guardado = freteDoPedidoSchema.safeParse(bloco);
  // ⚠️ The stored block FIRST: an update masks at the top-level key, so any
  // field not carried here would be ERASED — the nested ORDER clock included.
  return guardado.success ? { ...guardado.data, estado } : null;
}

/** The order's logistics as the stored `marketplace` block of THIS importer says it. */
function logisticaArmazenada(raw: Readonly<Record<string, unknown>>) {
  const marketplace = objeto(raw.marketplace);
  return logisticaAmazon(
    marketplace?.tipo === MARKETPLACE_PEDIDO_TIPO.amazon ? marketplace.fulfilledBy : undefined,
  );
}

/**
 * The STAMP decision, pure, over the stored pedido (`null`: absent) — module
 * header. Nothing here reads a clock or writes; `raw` is never mutated.
 */
export function preverCarimboNfeAmazon(
  raw: Readonly<Record<string, unknown>> | null,
  nowUs: number,
): PrevisaoCarimboNfeAmazon {
  const lido = blocoDoCanal(raw);
  if (!lido.ok) return { motivo: lido.motivo, patch: null };
  // BEFORE the scope: the replay is told apart from "outside the scope".
  if (lido.estado === ESTADO_FRETE.error) return { motivo: 'ja-carimbado', patch: null };
  if (!ESTADOS_FRETE_CARIMBAVEIS_NFE_AMAZON.has(lido.estado)) {
    return { motivo: 'fora-do-escopo', patch: null };
  }
  const pedido = raw as Readonly<Record<string, unknown>>;
  const veredito = estadoFreteAmazonAplicavel(lido.estado, ESTADO_FRETE.error, {
    maisNovo: true,
    logistica: logisticaArmazenada(pedido),
  });
  if (!veredito.escrever) return { motivo: 'veredito-recusou', patch: null };
  const freteInicial = blocoReescrito(lido.bloco, ESTADO_FRETE.error);
  if (freteInicial === null) return { motivo: 'frete-ilegivel', patch: null };
  return {
    motivo: 'carimbado',
    patch: { freteInicial, ultimaModificacao: ultimaModificacaoUs(pedido, nowUs) },
  };
}

/**
 * The CLEAR decision, pure (module header): only from a stored `error`, and
 * DIRECTLY through `estadoFreteAposAceiteNfeAmazon` — never the freight verdict.
 */
export function preverLimpezaNfeAmazon(
  raw: Readonly<Record<string, unknown>> | null,
  nowUs: number,
): PrevisaoCarimboNfeAmazon {
  const lido = blocoDoCanal(raw);
  if (!lido.ok) return { motivo: lido.motivo, patch: null };
  const destino = estadoFreteAposAceiteNfeAmazon(lido.estado);
  if (destino === null) return { motivo: 'sem-carimbo', patch: null };
  const freteInicial = blocoReescrito(lido.bloco, destino);
  if (freteInicial === null) return { motivo: 'frete-ilegivel', patch: null };
  return {
    motivo: 'limpo',
    patch: {
      freteInicial,
      ultimaModificacao: ultimaModificacaoUs(raw as Readonly<Record<string, unknown>>, nowUs),
    },
  };
}

/** One read-decide-write loop, tier 1 (module header). */
async function gravarComPrecondicao(
  db: Firestore,
  pedidoId: string,
  prever: (raw: Readonly<Record<string, unknown>> | null) => PrevisaoCarimboNfeAmazon,
): Promise<MotivoCarimboNfeAmazon> {
  const ref = pedidoCollection.docRef(db, {}, pedidoId);
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_CARIMBO_NFE_AMAZON; tentativa += 1) {
    const snap = await ref.get();
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
    // ⚠️ Every guard and every written value re-derived from THIS attempt's read.
    const previsao = prever(raw);
    if (previsao.patch === null || snap.updateTime === undefined) return previsao.motivo;
    try {
      await ref.update(
        pedidoCollection.parseMerge({
          freteInicial: previsao.patch.freteInicial,
          ultimaModificacao: previsao.patch.ultimaModificacao,
        }) as Record<string, unknown>,
        { lastUpdateTime: snap.updateTime },
      );
      return previsao.motivo;
    } catch (err) {
      // Rule 6: only a lost precondition (or the pedido gone since the read) is
      // re-decided; anything else propagates.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  throw new AmazonNfeCarimboEmConflitoError(pedidoId, MAX_TENTATIVAS_CARIMBO_NFE_AMAZON);
}

/**
 * Stamp ONE pedido's freight `error` after a proven refusal of THIS NF-e
 * (module header). A Firestore failure propagates; a precondition lost three
 * times throws {@link AmazonNfeCarimboEmConflitoError}.
 */
export function carimbarFreteNfeAmazon(
  db: Firestore,
  pedidoId: string,
  nowUs: number,
): Promise<MotivoCarimboNfeAmazon> {
  return gravarComPrecondicao(db, pedidoId, (raw) => preverCarimboNfeAmazon(raw, nowUs));
}

/**
 * Clear step 14's own stamp after Amazon ACCEPTED the NF-e (module header):
 * `error` → `aguardandoAgendamento`, and nothing from any other estado.
 */
export function limparCarimboNfeAmazon(
  db: Firestore,
  pedidoId: string,
  nowUs: number,
): Promise<MotivoCarimboNfeAmazon> {
  return gravarComPrecondicao(db, pedidoId, (raw) => preverLimpezaNfeAmazon(raw, nowUs));
}
