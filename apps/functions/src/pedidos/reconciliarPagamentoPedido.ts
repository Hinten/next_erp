import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { PERM, hasPerm } from '@delfrance/auth';
import { PedidoReconcileNotFoundError, reconcilePedidoEstado } from '@delfrance/data/admin';
import type { EstadoPedido } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

const reconciliarInputSchema = z.object({ pedidoId: z.string().min(1) });

export interface ReconciliarPagamentoPedidoResult {
  transition: EstadoPedido | null;
}

/**
 * Server-owned pedido `estado` reconcile for the web client (#308). The
 * client SDK can't read a query inside `runTransaction`, so the pedido's
 * pagamentos and its `valorCobrado` couldn't be summed as one atomic snapshot
 * client-side — two concurrent reconciles (different tabs/sessions) could
 * settle on a stale estado. This callable delegates to the Admin-SDK
 * `reconcilePedidoEstado` (`@delfrance/data/admin`), which reads the pedido
 * AND every pagamento in ONE transaction. Same auth model as `aplicarEstoque`.
 *
 * ⚠️ On the app's critical path: `PagamentosSection`'s `reconcileEstado()`
 * calls this callable — a hard cutover, with no client-side fallback left — so
 * the pedido estado auto-transition only works once this is DEPLOYED (deploy is
 * manual — see the "Deploying" section in `apps/functions/CLAUDE.md`).
 */
export const reconciliarPagamentoPedido = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Usuário não autenticado.');
  }
  const token = request.auth.token as { permissions?: string; su?: boolean };
  if (token.su !== true && !hasPerm(token.permissions, PERM.pedido.write)) {
    throw new HttpsError('permission-denied', 'Sem permissão para atualizar o pedido.');
  }
  const parsed = reconciliarInputSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'pedidoId inválido.');
  }

  try {
    // No `usuarioRef`: the historicoEstadoPedido row comes from the
    // `onPedidoEstadoChanged` trigger, which derives the actor from the pedido
    // write's auth context. This reconcile writes via the Admin SDK, so the row
    // records a null usuário — an automatic, payment-driven transition is
    // system-caused. The operator is still captured in the log line below.
    const result = await reconcilePedidoEstado(getDb(), {
      pedidoId: parsed.data.pedidoId,
    });
    logger.info(
      `reconciliarPagamentoPedido: ${parsed.data.pedidoId} → ${result.transition ?? '(sem transição)'} (por ${request.auth.uid})`,
    );
    return result satisfies ReconciliarPagamentoPedidoResult;
  } catch (err) {
    // A pedido deleted between the client's read and this call is the caller's
    // problem, not a server fault — map it to `not-found` so the UI can say so
    // instead of surfacing an opaque `internal`.
    if (err instanceof PedidoReconcileNotFoundError) {
      throw new HttpsError('not-found', 'Pedido não encontrado.');
    }
    throw err;
  }
});
