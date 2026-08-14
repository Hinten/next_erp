import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore';
import { nowMillis } from '@delfrance/core/datetime';
import { histPgtoCollection } from '@delfrance/data/admin/collections';
import { pagamentoMeta, statusPagamentoSchema, type StatusPagamento } from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { resolveUsuarioOuterRef } from './registrarEstadoPedido';

/**
 * Pagamento counterpart of `onPedidoEstadoChanged`
 * (`./registrarEstadoPedido.ts`): the SOLE writer of
 * `pedidos/{pedidoId}/pagamentos/{pagamentoId}/histpgto`, the payment
 * status-change audit trail (#369). Same design, one level deeper — this
 * observes the PAGAMENTO document rather than the pedido, because a payment
 * is its own document, not an embedded block like `freteInicial`.
 *
 * Replaces the legacy `Pagamento.save()` call-site append
 * (`.old/packages/pedido/lib/src/models.dart:2013-2050`), which only ever
 * covered saves made through that one Dart method. Observing the document
 * instead makes coverage total: the web editor, the Mercado Pago webhook, any
 * script, and the still-running Flutter app (which keeps writing through its
 * own `save()`, so its rows and this trigger's rows simply coexist) all
 * produce a row.
 *
 * Targets the NAMED `default` database (gotcha #8, apps/functions/CLAUDE.md).
 */

/** Everything the row builder needs from one pagamento write. */
export interface PagamentoHistoryEntryInput {
  before: DocumentData | undefined;
  after: DocumentData | undefined;
  usuarioOuterRef: string | null;
  eventId: string;
  /** Event time as MILLISECONDS since epoch — see the unit note on `histPgtoSchema`. */
  eventTimeMillis: number;
}

/** One `histpgto` row — the shape the schema validates. */
export interface PagamentoHistoryEntry {
  status_anterior: StatusPagamento | null;
  status_atual: StatusPagamento | null;
  usuarioHistoricoPagamentoOuterRef: string | null;
  timestamp: number;
  eventId: string;
}

type ParsedStatus = { recognized: true; value: StatusPagamento | null } | { recognized: false };

/**
 * Parse a raw `status_pagamento` value. `null`/`undefined` is a legitimate
 * status (not an error); anything else must parse as a known
 * `StatusPagamento` or the value is treated as unrecognizable.
 */
function parseStatus(value: unknown): ParsedStatus {
  if (value === null || value === undefined) return { recognized: true, value: null };
  const parsed = statusPagamentoSchema.safeParse(value);
  return parsed.success ? { recognized: true, value: parsed.data } : { recognized: false };
}

/**
 * Decide whether a pagamento write is a `status_pagamento` transition worth
 * recording, and build the row for it. Pure — no I/O — mirrors
 * `buildEstadoHistoryEntry`.
 *
 * Returns `null` for: a delete (the row would outlive its parent), an update
 * that left `status_pagamento` untouched, and an `after` value that is not a
 * recognizable status. A CREATE always records the opening status (even
 * `null`), matching legacy: "every newly-created pagamento gets an initial
 * history row".
 */
export function buildPagamentoHistoryEntry(
  input: PagamentoHistoryEntryInput,
): PagamentoHistoryEntry | null {
  if (!input.after) return null;

  const isCreate = !input.before;
  const rawBefore = input.before?.status_pagamento;
  const rawAfter = input.after.status_pagamento;
  if (!isCreate && rawBefore === rawAfter) return null;

  const atual = parseStatus(rawAfter);
  if (!atual.recognized) return null;

  // A garbage "before" value (a hand-edited doc, say) still records the
  // transition rather than dropping the row — it falls back to null.
  const anterior = isCreate ? null : parseStatus(rawBefore);
  const statusAnterior = anterior?.recognized ? anterior.value : null;

  return {
    status_anterior: statusAnterior,
    status_atual: atual.value,
    usuarioHistoricoPagamentoOuterRef: input.usuarioOuterRef,
    timestamp: input.eventTimeMillis,
    eventId: input.eventId,
  };
}

/**
 * Persist one row at a deterministic id (`entry.eventId`) — the trigger is
 * at-least-once, so a redelivery must rewrite a content-identical doc rather
 * than append a duplicate.
 */
export async function recordPagamentoHistory(
  db: Firestore,
  pedidoId: string,
  pagamentoId: string,
  entry: PagamentoHistoryEntry,
): Promise<void> {
  const ref = histPgtoCollection.docRef(db, { pedidoId, pagamentoId }, entry.eventId);
  await ref.set(histPgtoCollection.parse(entry) as DocumentData);
}

/**
 * Fires on EVERY pagamento write (create/update/delete) from any writer and
 * records one row per `status_pagamento` transition.
 */
export const onPagamentoStatusChanged = onDocumentWrittenWithAuthContext(
  {
    document: `${pagamentoMeta.collectionPath}/{pagamentoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    // The middle `{pedidoId}` wildcard sits inside the meta-derived path
    // prefix, so its type isn't inferred into `event.params` (only the
    // trailing `{pagamentoId}` is) — both are present at runtime. Same
    // pattern as `onEstoqueDeleted`.
    const { pedidoId, pagamentoId } = event.params as { pedidoId: string; pagamentoId: string };
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // Same `event.time`-derived, redelivery-stable stamp as
    // `onPedidoEstadoChanged` — see that file's comment for the full
    // reasoning (the `nowMillis()` fallback only affects an unparseable
    // `event.time`, which the doc-id-keyed idempotency still tolerates).
    const parsedMillis = Date.parse(event.time);
    const eventTimeMillis = Number.isNaN(parsedMillis) ? nowMillis() : parsedMillis;

    const entry = buildPagamentoHistoryEntry({
      before,
      after,
      usuarioOuterRef: resolveUsuarioOuterRef(event.authType, event.authId),
      eventId: event.id,
      eventTimeMillis,
    });
    // Fast path: no recognizable status transition → no getDb(), no write.
    if (entry === null) return;

    const db = getDb();
    await recordPagamentoHistory(db, pedidoId, pagamentoId, entry);

    logger.info(
      `onPagamentoStatusChanged: pagamento ${pagamentoId} (pedido ${pedidoId}) → ${entry.status_atual}` +
        ` (por ${entry.usuarioHistoricoPagamentoOuterRef ?? 'sistema'})`,
    );
  },
);
