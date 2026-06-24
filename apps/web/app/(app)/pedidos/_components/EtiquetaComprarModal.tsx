'use client';

/**
 * Buy-etiqueta confirm + progress modal for the `/pedidos` row action. Ports the
 * legacy `emitirOuImprimirFrete` posted-state risk confirmation (condensed to a
 * single "Estou ciente do risco" checkbox), then resolves the cart from the
 * pedido doc and buys via `client.comprar`, showing the print link on success.
 */
import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { Pedido } from '@delfrance/schemas';

import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useFreightClient } from '@/lib/freight/client';
import { freightErrorMessage } from '@/lib/freight/errorMessage';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import { resolveEtiquetaCartInput } from './etiquetaActions';

interface BuyResult {
  readonly printUrl: string;
  readonly tracking: string | null;
}

export function EtiquetaComprarModal({
  opened,
  onClose,
  pedido,
  pedidoId,
  intFreteId,
  needsPostedConfirm,
}: {
  opened: boolean;
  onClose: () => void;
  pedido: Pedido;
  pedidoId: string;
  intFreteId: string | null;
  needsPostedConfirm: boolean;
}) {
  const db = getFirebaseFirestore();
  const client = useFreightClient();
  const [ack, setAck] = useState(false);
  const [buying, setBuying] = useState(false);
  const [result, setResult] = useState<BuyResult | null>(null);

  // Show the ME account saldo before confirming (the legacy showed it in the
  // buy dialog). Fresh each open (staleTime 0) — a prior buy changes it.
  const conta = useQuery({
    queryKey: ['freightConta', intFreteId],
    enabled: opened && client != null && intFreteId != null,
    staleTime: 0,
    queryFn: () => client!.conta(intFreteId!),
  });
  const saldo = conta.data?.balance?.balance ?? null;
  const saldoLabel = conta.isLoading
    ? 'Carregando…'
    : saldo != null
      ? `R$ ${saldo.toFixed(2)}`
      : 'Desconhecido';
  const custoFrete = pedido.freteInicial?.custoFinal ?? pedido.freteInicial?.custoCalculado ?? null;
  const saldoInsuficiente = saldo != null && custoFrete != null && saldo < custoFrete;

  function handleClose() {
    setAck(false);
    setBuying(false);
    setResult(null);
    onClose();
  }

  async function handleBuy() {
    if (!client) return;
    setBuying(true);
    // The resolve reads several docs and can throw — keep it inside the try so
    // `finally` always clears `buying` (otherwise a failed read leaves the modal
    // stuck in a loading state).
    try {
      const resolved = await resolveEtiquetaCartInput(db, pedido, pedidoId);
      if (!resolved.ok) {
        showErrorNotification({
          title: 'Não foi possível comprar a etiqueta',
          message: resolved.error,
        });
        return;
      }
      const r = await client.comprar(
        resolved.intFreteId,
        pedidoId,
        resolved.payload,
        pedido.freteInicial?.printLabelId ?? null,
      );
      setResult({ printUrl: r.printUrl, tracking: r.tracking });
    } catch (err) {
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({ title: 'Falha ao comprar etiqueta', message: msg });
    } finally {
      setBuying(false);
    }
  }

  return (
    <Modal opened={opened} onClose={handleClose} title="Comprar etiqueta" centered>
      {result ? (
        <Stack>
          <Alert color="green" variant="light">
            Etiqueta comprada com sucesso.
            {result.tracking ? ` Rastreio: ${result.tracking}` : ''}
          </Alert>
          <Group justify="flex-end">
            <Button
              variant="light"
              onClick={() => window.open(result.printUrl, '_blank', 'noopener,noreferrer')}
            >
              Abrir etiqueta
            </Button>
            <Button onClick={handleClose}>Fechar</Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Text size="sm">
            Pedido {pedido.numero ?? pedidoId}. A compra debita o saldo da conta Melhor Envio e gera
            a etiqueta.
          </Text>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Saldo Atual
            </Text>
            <Text size="sm" fw={500}>
              {saldoLabel}
            </Text>
          </Group>
          {saldoInsuficiente && (
            <Alert color="orange" variant="light">
              Saldo insuficiente para o frete
              {custoFrete != null ? ` (R$ ${custoFrete.toFixed(2)})` : ''}. A compra pode ser
              recusada pelo Melhor Envio.
            </Alert>
          )}
          {needsPostedConfirm && (
            <Alert color="orange" title="Atenção" variant="light">
              Este frete já tem uma etiqueta emitida — reemitir pode gerar etiquetas duplicadas e
              problemas operacionais.
              <Checkbox
                mt="sm"
                label="Estou ciente do risco"
                checked={ack}
                onChange={(e) => setAck(e.currentTarget.checked)}
              />
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose} disabled={buying}>
              Cancelar
            </Button>
            <Button
              onClick={handleBuy}
              loading={buying}
              disabled={!client || (needsPostedConfirm && !ack)}
              color={needsPostedConfirm ? 'orange' : undefined}
            >
              Comprar etiqueta
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
