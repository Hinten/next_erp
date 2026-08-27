'use client';

import { Alert, List } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  ACAO_BLOQUEADA_LABELS,
  bloqueioDespachoAtivo,
  bloqueioFinalizarAtivo,
  bloqueioNFeAtivo,
  type BloqueioPedido,
} from '@delfrance/schemas';

/**
 * The pedido-level dispute banner (#1322).
 *
 * ⚠️ This exists because the pedido looks HEALTHY. During a marketplace
 * mediation ML keeps the order `paid`, so `estado` reads "Pago", the cliente is
 * bound, the endereço is valid, the frete block is fine and stock is committed
 * — every existing lock notice in the form stays silent. An operator opening
 * the order sees nothing wrong and ships goods that are about to be refunded.
 *
 * It renders the two markers separately because they mean different things and
 * block different actions: a DISPUTE is money still uncertain on an order that
 * may not have shipped, a DEVOLUÇÃO is goods already with the buyer coming
 * back. And it lists what is actually refused right now, derived from the same
 * predicates the guards use — a banner that says "blocked" without saying what
 * sends the operator hunting.
 */
export function BloqueioMarketplaceAlert({ bloqueio }: { bloqueio?: BloqueioPedido }) {
  if (!bloqueio) return null;
  const { disputaAbertaEm, devolucaoAbertaEm } = bloqueio;
  if (disputaAbertaEm == null && devolucaoAbertaEm == null) return null;

  const bloqueadas = [
    bloqueioDespachoAtivo(bloqueio) ? ACAO_BLOQUEADA_LABELS.despacho : null,
    bloqueioNFeAtivo(bloqueio) ? ACAO_BLOQUEADA_LABELS.nfe : null,
    bloqueioFinalizarAtivo(bloqueio) ? ACAO_BLOQUEADA_LABELS.finalizar : null,
  ].filter((x): x is string => x !== null);

  const titulo =
    devolucaoAbertaEm != null && disputaAbertaEm != null
      ? 'Reclamação e devolução abertas no marketplace'
      : devolucaoAbertaEm != null
        ? 'Devolução em andamento no marketplace'
        : 'Reclamação aberta no marketplace';

  return (
    <Alert color="orange" icon={<IconAlertTriangle size={16} />} title={titulo} mb="md">
      {disputaAbertaEm != null && <>Reclamação aberta desde {formatarData(disputaAbertaEm)}. </>}
      {devolucaoAbertaEm != null && <>Devolução aberta desde {formatarData(devolucaoAbertaEm)}. </>}
      {bloqueadas.length > 0 ? (
        <>
          Enquanto isso, estas ações estão bloqueadas:
          <List size="sm" mt={4}>
            {bloqueadas.map((b) => (
              <List.Item key={b}>{b}</List.Item>
            ))}
          </List>
          Resolva a reclamação na aba Incidentes, ou libere a ação por lá.
        </>
      ) : (
        // Every block released by an audited override — say so, rather than
        // showing a warning with no consequence and leaving the operator to
        // guess whether it still applies.
        <>Os bloqueios desta reclamação foram liberados por um operador.</>
      )}
    </Alert>
  );
}

/** µs-epoch → pt-BR date. */
function formatarData(micros: number): string {
  return new Date(Math.round(micros / 1000)).toLocaleDateString('pt-BR');
}
