import { FirebaseError } from 'firebase/app';
import { notifications } from '@mantine/notifications';
import { deveReconciliarAposSalvar, type SavePedidoResultado } from '@delfrance/data/pedido';
import { callReconciliarPagamentoPedido } from '@/lib/pedidos/clientPort';

const RECONCILE_TOTAL_ERROR_ID = 'pedido-reconcile-total-falhou';

/**
 * After a pedido save that moved `valorCobrado`, re-derive `estado` from the
 * payments (#703). Before this, only a PAGAMENTO mutation ran the reconcile, so
 * an edit that pushed the total across the paid sum left `estado` stale until
 * the next payment change.
 *
 * Decided from the save's own committed read (`deveReconciliarAposSalvar`), and
 * the server re-applies the same gate inside its transaction
 * (`somenteSeItensEditaveis`) — the Mercado Livre import can promote a pedido to
 * `emProcessamento` in the gap, and reconciling it then strands it.
 *
 * Best-effort, like the Pagamentos tab's reconcile: the pedido is already saved,
 * so a failure is never a save error — but it is surfaced, because only a human
 * can settle a stale estado. Callers fire it without awaiting so navigation is
 * not held for a callable cold start; the toast is global and survives it.
 */
export async function reconciliarEstadoSeTotalMudou(
  pedidoId: string,
  resultado: SavePedidoResultado,
): Promise<void> {
  if (!deveReconciliarAposSalvar(resultado)) return;
  try {
    await callReconciliarPagamentoPedido(pedidoId, { somenteSeItensEditaveis: true });
  } catch (err) {
    if (!(err instanceof FirebaseError)) throw err;
    console.error('reconciliarPagamentoPedido (após salvar o pedido) falhou', err);
    // Mantine IGNORES a `show` whose id is already mounted — hide first, as in
    // `PagamentosSection`, or a second failure inside the autoClose window
    // renders nothing.
    notifications.hide(RECONCILE_TOTAL_ERROR_ID);
    notifications.show({
      id: RECONCILE_TOTAL_ERROR_ID,
      color: 'red',
      title: 'Estado do pedido não atualizado',
      message: `O pedido foi salvo, mas o estado não pôde ser recalculado a partir dos pagamentos (${err.code}). Ajuste o estado manualmente na aba Estado/Histórico.`,
      autoClose: 8000,
    });
  }
}
