import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore as FirebaseAdminFirestore,
  Transaction,
} from 'firebase-admin/firestore';
import {
  ESTADO_FRETE,
  isFreteMarketplaceOwned,
  nowMicros,
  podeAutorizarDespacho,
  sumPagamentosPagos,
  type EstadoFrete,
  type EstadoPedido,
  type Pagamento,
} from '@delfrance/schemas';

import { nextPedidoEstado } from '../pedido/usecases';
import { pagamentoCollection, pedidoCollection } from './collections';

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
 * Shared tail of both admin reconciles: given the pedido's already-read
 * snapshot and the (already computed) `valorPago`, applies {@link
 * nextPedidoEstado} and — only on a transition — writes the new `estado` and
 * flips `freteInicial.estado` to `despachoAutorizado` ONLY from a
 * pre-authorization estado ({@link podeAutorizarDespacho}) — or from a malformed
 * block carrying no estado at all, which the flip repairs — and never on a
 * marketplace-owned frete block (#702). Returns the new estado, or `null` when
 * no transition applies.
 *
 * The `historicoEstadoPedido` audit row is NOT written here: the
 * `onPedidoEstadoChanged` trigger observes the pedido write below and records
 * the transition. Both callers run on the Admin SDK, so that row carries a null
 * usuário — an automatic, payment-driven transition has no end user behind it.
 */
function applyEstadoTransition(
  tx: Transaction,
  pedidoRef: DocumentReference,
  pedidoSnap: DocumentSnapshot,
  valorPago: number,
): EstadoPedido | null {
  const estado = pedidoSnap.get('estado') as EstadoPedido;
  const total =
    typeof pedidoSnap.get('valorCobrado') === 'number'
      ? (pedidoSnap.get('valorCobrado') as number)
      : 0;
  const next = nextPedidoEstado(estado, total, valorPago);
  if (next === null) return null;

  const pedidoPatch: Record<string, unknown> = {
    estado: next.estado,
    ultimaModificacao: nowMicros(),
  };
  if (next.autorizarDespacho) {
    const frete = pedidoSnap.get('freteInicial');
    if (frete && typeof frete === 'object') {
      const freteRecord = frete as Record<string, unknown>;
      const freteEstado = freteRecord.estado as EstadoFrete | undefined;
      // Authorize dispatch ONLY from a state that precedes authorization, and never
      // on a freight block the marketplace importer owns (#702). This used to be
      // `!isFreteJaPostado(...)`, which answers the label-reprint question and let a
      // `pago` transition regress `empacotado` / `emSeparacao` / `checkFinalizado`
      // back to `despachoAutorizado` — erasing warehouse progress, and (via
      // `CAMPOS_OBSERVADOS`) re-running the estoque sync against a state that no
      // longer removes stock.
      //
      // The ownership tipo is read off `externalOptionIntegracao`, which lives on the
      // frete block itself — no extra transaction read, which matters because
      // `reconcilePedidoFromPagamento` has already written the pagamento by the time
      // this runs and Firestore forbids a read after a write.
      const podeAutorizar = !freteEstado || podeAutorizarDespacho(freteEstado);
      const marketplaceOwned = isFreteMarketplaceOwned(
        freteRecord.externalOptionIntegracao as string | null | undefined,
      );
      if (podeAutorizar && !marketplaceOwned) {
        pedidoPatch.freteInicial = { ...freteRecord, estado: ESTADO_FRETE.despachoAutorizado };
      }
    }
  }
  tx.update(pedidoRef, pedidoPatch);

  return next.estado;
}

/**
 * Server-side (Admin SDK) reconcile of a pedido's `estado` from ONE inbound
 * payment. It replaced a client-side reconcile that used to live in
 * `../pedido/usecases` and carried a documented atomicity caveat (#308): the
 * Firebase JS SDK can't read a query inside `runTransaction`, so `valorPago`
 * was summed BEFORE the tx and two reconciles could settle on a stale estado.
 * The Admin SDK CAN query in-transaction, so this path reads the whole payment
 * set atomically with the pedido — no race. **Webhook writers (Mercado Pago)
 * are the primary caller.** See {@link reconcilePedidoEstado} for the
 * callable-facing counterpart that reconciles from the CURRENT payment set
 * instead of upserting one — that one now serves the web client.
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
 *     `freteInicial.estado` to `despachoAutorizado` — only from a
 *     pre-authorization estado ({@link podeAutorizarDespacho}) and never on a
 *     marketplace-owned frete block (#702) — and stamps the pedido
 *     `ultimaModificacao` (µs).
 *
 * The `historicoEstadoPedido` audit row for a transition is written by the
 * `onPedidoEstadoChanged` trigger observing the pedido write, with a null
 * usuário — this path runs on the Admin SDK and has no end user behind it.
 *
 * Returns the new estado (or `null` when the pagamento was written but no estado
 * transition applies), plus whether the delivery was skipped as stale.
 *
 * Datetime units: `ultimaModificacao` / `dataCadastro` are MICROSECONDS since
 * epoch (`nowMicros()`), the pagamento/pedido standard.
 */
export async function reconcilePedidoFromPagamento(
  db: FirebaseAdminFirestore,
  input: {
    pedidoId: string;
    pagamentoId: string;
    pagamento: Pagamento;
  },
): Promise<{ transition: EstadoPedido | null; skippedStale: boolean }> {
  const { pedidoId, pagamentoId, pagamento } = input;

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

    const transition = applyEstadoTransition(tx, pedidoRef, pedidoSnap, valorPago);
    return { transition, skippedStale: false };
  });
}

/**
 * Server-side (Admin SDK) reconcile of a pedido's `estado` from its CURRENT
 * pagamentos — the callable-facing counterpart to {@link
 * reconcilePedidoFromPagamento}. Where that one upserts ONE inbound (webhook)
 * payment, this one assumes every pagamento was already written by its own
 * path (client CRUD via `savePagamento`/`deletePagamento`) and just settles
 * `estado` from the current payment set — the fully-consistent replacement for
 * the client-side reconcile deleted from `../pedido/usecases` in #308, which
 * summed `valorPago` with a `getDocs` BEFORE `runTransaction` (the Firebase JS
 * SDK can't query inside a transaction), so two concurrent reconciles could
 * settle on a stale estado. This one reads the pedido AND every pagamento in
 * the SAME transaction — no race.
 *
 * Exposed via the `reconciliarPagamentoPedido` Cloud Function callable
 * (`apps/functions`), and this IS the web client's reconcile path:
 * `PagamentosSection`'s `reconcileEstado()` calls that callable, which
 * delegates here. The cutover was hard — the old client-side
 * `reconcilePedidoEstadoFromPagamentos` was deleted, there is no fallback — so
 * the callable must be DEPLOYED for the Pagamentos tab's estado transition to
 * happen at all (deploy is a manual, coordinated step; the e2e that exercises
 * this exact flow, `apps/web/e2e/pedidos-pagamento.vendas.e2e.spec.ts`, hits
 * real staging Cloud Functions).
 *
 * Takes NO `usuarioRef`: the `historicoEstadoPedido` row is written by the
 * `onPedidoEstadoChanged` trigger from the pedido write's auth context, and this
 * runs on the Admin SDK — so the transition is recorded with a null usuário even
 * though the calling operator is known to the callable. That is deliberate: an
 * automatic, payment-driven transition is system-caused, not user-caused.
 */
export async function reconcilePedidoEstado(
  db: FirebaseAdminFirestore,
  input: { pedidoId: string },
): Promise<{ transition: EstadoPedido | null }> {
  const { pedidoId } = input;

  return db.runTransaction(async (tx) => {
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) throw new PedidoReconcileNotFoundError(pedidoId);

    const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));
    const valorPago = sumPagamentosPagos(
      pagamentosSnap.docs.map((d) => ({
        valor: typeof d.get('valor') === 'number' ? (d.get('valor') as number) : 0,
        status_pagamento: d.get('status_pagamento') as number | null | undefined,
      })),
    );

    const transition = applyEstadoTransition(tx, pedidoRef, pedidoSnap, valorPago);
    return { transition };
  });
}
