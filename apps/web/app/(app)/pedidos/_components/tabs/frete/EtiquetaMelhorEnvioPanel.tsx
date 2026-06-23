'use client';

/**
 * Melhor Envio etiqueta panel (F5.3) — **print + track** for a pedido that
 * already has a bought ME label. Buying the label lives exclusively in the
 * `/pedidos` list row action (`EtiquetaRowAction`); this object-view panel only
 * reprints + tracks an existing label via the `apps/melhor-envio` routes
 * (`useFreightClient`).
 */
import { useState } from 'react';
import { Button, Code, Divider, Group, Modal, Stack, Text } from '@mantine/core';
import { IconPrinter, IconTruckDelivery } from '@tabler/icons-react';

import { useFreightClient } from '@/lib/freight/client';
import { freightErrorMessage } from '@/lib/freight/errorMessage';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import { fretePath, type PedidoFormHandle } from './fields';

export function EtiquetaMelhorEnvioPanel({
  form,
  intFreteId,
}: {
  form: PedidoFormHandle;
  intFreteId: string;
}) {
  const client = useFreightClient();
  const printLabelId = form.watch(fretePath('printLabelId')) as string | null;

  const [busy, setBusy] = useState<null | 'imprimir' | 'rastrear'>(null);
  const [rastreio, setRastreio] = useState<unknown>(null);

  async function handleImprimir() {
    if (!client || !printLabelId) return;
    setBusy('imprimir');
    try {
      const { url } = await client.imprimir(intFreteId, printLabelId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({ title: 'Falha ao imprimir etiqueta', message: msg });
    } finally {
      setBusy(null);
    }
  }

  async function handleRastrear() {
    if (!client || !printLabelId) return;
    setBusy('rastrear');
    try {
      const { tracking } = await client.rastrear(intFreteId, printLabelId);
      setRastreio(tracking);
    } catch (err) {
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({ title: 'Falha ao rastrear', message: msg });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack gap="xs">
      <Divider label="Etiqueta" labelPosition="left" />

      {!printLabelId && (
        <Text size="sm" c="dimmed">
          Compre a etiqueta pela ação “Comprar etiqueta” na listagem de pedidos.
        </Text>
      )}

      {printLabelId && (
        <>
          <Group gap="sm">
            <Button
              type="button"
              variant="light"
              leftSection={<IconPrinter size={16} />}
              onClick={handleImprimir}
              loading={busy === 'imprimir'}
              disabled={!client || busy !== null}
            >
              Imprimir
            </Button>
            <Button
              type="button"
              variant="light"
              leftSection={<IconTruckDelivery size={16} />}
              onClick={handleRastrear}
              loading={busy === 'rastrear'}
              disabled={!client || busy !== null}
            >
              Rastrear
            </Button>
          </Group>

          <Text size="xs" c="dimmed">
            Etiqueta: <Code>{printLabelId}</Code>
          </Text>
        </>
      )}

      <Modal
        opened={rastreio !== null}
        onClose={() => setRastreio(null)}
        title="Rastreio Melhor Envio"
        size="lg"
      >
        <Code block>{JSON.stringify(rastreio, null, 2)}</Code>
      </Modal>
    </Stack>
  );
}
