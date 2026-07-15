import type { DocumentData, Firestore as FirebaseAdminFirestore } from 'firebase-admin/firestore';
import {
  isFreteJaPostado,
  nowMicros,
  sumPagamentosPagos,
  type EstadoFrete,
  type EstadoPedido,
  type Pagamento,
} from '@delfrance/schemas';

import { nextPedidoEstado } from '../pedido/usecases';
import {
  historicoEstadoPedidoCollection,
  pagamentoCollection,
  pedidoCollection,
} from './collections';

/**
 * Thrown when the reconcile targets a pedido that no longer exists. The webhook
 * caller parks the delivery as failed (and does NOT ack it as processed) so a
 * later redelivery — after the pedido is (re)created — can settle it.
 */
export class PedidoReconcileNotFoundError extends Error {
  constructor(readonly pedidoId: string) {
    super(`Pedido ${pedidoId} não encontrado — reconcile abortado.`);
    this.name = 'PedidoReconcileNotFoundError';
  }
}

/**
 * The ONLY pagamento fields a gateway redelivery is authoritative over — the
 * inverse of the client-edit preservation set. On an UPDATE the write is
 * inverted: the stored doc is the base and just these keys are overlaid from the
 * incoming (webhook-derived) `Pagamento`, so EVERYTHING NOT LISTED HERE survives
 * an operator's edits (`nFat`, `vencimento`, `juros`, `duplicata`,
 * `descricaoPagamento`, the out-of-band `cartao` / `cheque` /
 * `metodoPagamentoOuterRef` / `dataCadastro`, …). Without the inversion a
 * redelivery would rebuild the doc from the mapper output and wipe those edits.
 * `ultimaModificacao` is gateway-owned AND the update-if-newer key, so it lands
 * from the incoming doc as-is (never re-stamped to `now`).
 */
const GATEWAY_OWNED = [
  'valor',
  'status_pagamento',
  'ultimaModificacao',
  'dataAprovacao',
  'dataCancelamento',
  'tarifas',
  'parcelas',
  'aVista',
  'forma_de_pagamento',
] as const;

/**
 * Server-side (Admin SDK) reconcile of a pedido's `estado` from ONE inbound
 * payment — the fully-consistent counterpart to the client
 * `reconcilePedidoEstadoFromPagamentos` (`../pedido/usecases`). That client path
 * carries a documented atomicity caveat (#308): the Firebase JS SDK can't read a
 * query inside `runTransaction`, so `valorPago` is summed BEFORE the tx and two
 * reconciles can briefly settle on a stale estado. The Admin SDK CAN query
 * in-transaction, so this path reads the whole payment set atomically with the
 * pedido — no race. **Webhook writers (Mercado Pago) are the primary caller.**
 *
 * In one transaction it:
 *  1. reads the pedido (missing → {@link PedidoReconcileNotFoundError});
 *  2. reads ALL pagamentos of the pedido in-tx;
 *  3. **update-if-newer guard** — if the stored pagamento at `pagamentoId` is at
 *     least as fresh as the incoming one (`ultimaModificacao` µs), returns
 *     `{ transition: null, skippedStale: true }` WITHOUT writing (drops stale /
 *     duplicate redeliveries idempotently);
 *  4. upserts the incoming pagamento at the FIXED id `pagamentoId`: on an UPDATE
 *     the merge is INVERTED — the stored doc is the base and only the
 *     {@link GATEWAY_OWNED} fields are overlaid from the incoming pagamento, so
 *     operator-edited fields (nFat, vencimento, juros, …) survive a redelivery;
 *     a CREATE writes the full mapped doc and mints `dataCadastro`;
 *  5. recomputes `valorPago` from the in-tx set (with the upserted payment's
 *     incoming values) via the shared {@link sumPagamentosPagos} rule;
 *  6. applies {@link nextPedidoEstado} (which gates on the payment-driven
 *     estados) and, ONLY on a transition, writes the new `estado`, flips
 *     `freteInicial.estado` to `despachoAutorizado` (never regressing an
 *     already-posted frete — same rule as the client reconcile), appends a
 *     `historicoEstadoPedido` audit row, and stamps the pedido
 *     `ultimaModificacao` (µs).
 *
 * Returns the new estado (or `null` when the pagamento was written but no estado
 * transition applies), plus whether the delivery was skipped as stale.
 *
 * Datetime units: `ultimaModificacao` / `dataCadastro` / the history `data` are
 * all MICROSECONDS since epoch (`nowMicros()`), the pagamento/pedido standard.
 */
export async function reconcilePedidoFromPagamento(
  db: FirebaseAdminFirestore,
  input: {
    pedidoId: string;
    pagamentoId: string;
    pagamento: Pagamento;
    usuarioRef?: string | null;
  },
): Promise<{ transition: EstadoPedido | null; skippedStale: boolean }> {
  const { pedidoId, pagamentoId, pagamento } = input;
  const usuarioRef = input.usuarioRef ?? null;

  return db.runTransaction(async (tx) => {
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) throw new PedidoReconcileNotFoundError(pedidoId);

    // The atomic read the client SDK can't do (#308): the whole payment set,
    // in the same snapshot as the pedido.
    const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));
    const existing = pagamentosSnap.docs.find((d) => d.id === pagamentoId) ?? null;

    // Update-if-newer guard: a stored pagamento at least as fresh as the incoming
    // one (same or newer `ultimaModificacao`) means this is a stale/duplicate
    // delivery — skip without writing (idempotent redelivery).
    if (existing) {
      const existingMod = existing.get('ultimaModificacao');
      const incomingMod = pagamento.ultimaModificacao;
      if (
        typeof existingMod === 'number' &&
        typeof incomingMod === 'number' &&
        existingMod >= incomingMod
      ) {
        return { transition: null, skippedStale: true };
      }
    }

    // Upsert the pagamento at its fixed (gateway-stable) id.
    let toWrite: Record<string, unknown>;
    if (existing) {
      // UPDATE — INVERTED merge: the stored doc is the base (operator edits and
      // out-of-band first-write fields survive) and only the {@link GATEWAY_OWNED}
      // fields are overlaid from the incoming (webhook-derived) pagamento.
      const existingData = existing.data() ?? {};
      const incoming = pagamento as unknown as Record<string, unknown>;
      toWrite = { ...existingData };
      for (const key of GATEWAY_OWNED) {
        if (incoming[key] !== undefined) toWrite[key] = incoming[key];
      }
    } else {
      // CREATE — the full mapped doc, plus the first-seen `dataCadastro` stamp
      // (the field the list sorts by; buildPagamentoOp mints it on create).
      toWrite = { ...pagamento };
      if (toWrite.dataCadastro == null) toWrite.dataCadastro = nowMicros();
    }
    const pagamentoRef = pagamentoCollection.docRef(db, { pedidoId }, pagamentoId);
    tx.set(pagamentoRef, pagamentoCollection.parse(toWrite) as DocumentData);

    // Recompute valorPago from the in-tx set, replacing the upserted doc with the
    // incoming values, using the SAME status filter the client path uses.
    const paymentsForSum = pagamentosSnap.docs
      .filter((d) => d.id !== pagamentoId)
      .map((d) => ({
        valor: typeof d.get('valor') === 'number' ? (d.get('valor') as number) : 0,
        status_pagamento: d.get('status_pagamento') as number | null | undefined,
      }));
    paymentsForSum.push({
      valor: pagamento.valor,
      status_pagamento: pagamento.status_pagamento,
    });
    const valorPago = sumPagamentosPagos(paymentsForSum);

    const estado = pedidoSnap.get('estado') as EstadoPedido;
    const total =
      typeof pedidoSnap.get('valorCobrado') === 'number'
        ? (pedidoSnap.get('valorCobrado') as number)
        : 0;
    const next = nextPedidoEstado(estado, total, valorPago);
    if (next === null) {
      return { transition: null, skippedStale: false };
    }

    const pedidoPatch: Record<string, unknown> = {
      estado: next.estado,
      ultimaModificacao: nowMicros(),
    };
    if (next.autorizarDespacho) {
      const frete = pedidoSnap.get('freteInicial');
      if (frete && typeof frete === 'object') {
        const freteRecord = frete as Record<string, unknown>;
        const freteEstado = freteRecord.estado as EstadoFrete | undefined;
        // Only authorize dispatch from a pre-shipment state — never regress an
        // in-flight frete (postado / a caminho / entregue) back to authorized.
        if (!freteEstado || !isFreteJaPostado(freteEstado)) {
          pedidoPatch.freteInicial = { ...freteRecord, estado: 'despachoAutorizado' };
        }
      }
    }
    tx.update(pedidoRef, pedidoPatch);

    // Append a `historicoEstadoPedido` audit row — same shape as
    // `buildEstadoHistoryOp` (`../pedido/usecases`); `data` is a µs stamp.
    const historyId = historicoEstadoPedidoCollection.newDocId(db, { pedidoId });
    const historyRef = historicoEstadoPedidoCollection.docRef(db, { pedidoId }, historyId);
    tx.set(
      historyRef,
      historicoEstadoPedidoCollection.parse({
        estado: next.estado,
        usuarioHistoricoEstadosPedidoOuterRef: usuarioRef,
        data: nowMicros(),
      }) as DocumentData,
    );

    return { transition: next.estado, skippedStale: false };
  });
}
