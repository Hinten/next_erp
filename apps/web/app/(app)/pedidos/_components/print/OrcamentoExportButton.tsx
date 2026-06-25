'use client';

/**
 * "Imprimir orçamento" button for a single pedido. On click it assembles the
 * print model from Firestore, mounts the {@link OrcamentoSheet} off-screen, and
 * `useOrcamentoExport` captures it once → silently downloads the JPEG + PDF
 * (no print dialog). The sheet is unmounted as soon as the capture resolves.
 */
import { useEffect, useState } from 'react';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileInvoice } from '@tabler/icons-react';

import { getFirebaseFirestore } from '@/lib/firebase/client';
import { buildPrintModel } from '@/lib/pedido-print/assemble';
import type { PedidoPrintModel } from '@/lib/pedido-print/model';

import { OrcamentoSheet } from './OrcamentoSheet';
import { useOrcamentoExport } from './useOrcamentoExport';

export interface OrcamentoExportButtonProps {
  readonly pedidoId: string;
  readonly label?: string;
}

const ERROR_TITLE = 'Falha ao gerar o orçamento';

export function OrcamentoExportButton({
  pedidoId,
  label = 'Imprimir orçamento',
}: OrcamentoExportButtonProps) {
  const [model, setModel] = useState<PedidoPrintModel | null>(null);
  const [loading, setLoading] = useState(false);
  const { ref, exporting, error, run } = useOrcamentoExport(model);

  // Once the model loads, the hidden sheet is mounted — capture it, then clear.
  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    void run().finally(() => {
      if (!cancelled) setModel(null);
    });
    return () => {
      cancelled = true;
    };
  }, [model, run]);

  // Surface a capture failure as a notification.
  useEffect(() => {
    if (error) notifications.show({ color: 'red', title: ERROR_TITLE, message: error });
  }, [error]);

  function onClick() {
    if (loading || exporting || model) return;
    setLoading(true);
    buildPrintModel(getFirebaseFirestore(), pedidoId, {})
      .then(
        (m) => setModel(m),
        (e: unknown) => {
          notifications.show({
            color: 'red',
            title: ERROR_TITLE,
            message: e instanceof Error ? e.message : String(e),
          });
        },
      )
      .finally(() => setLoading(false));
  }

  return (
    <>
      <Button
        variant="default"
        leftSection={<IconFileInvoice size={16} />}
        onClick={onClick}
        loading={loading || exporting}
      >
        {label}
      </Button>
      {model && (
        <div
          aria-hidden
          style={{ position: 'fixed', left: -100000, top: 0, pointerEvents: 'none' }}
        >
          <OrcamentoSheet ref={ref} model={model} />
        </div>
      )}
    </>
  );
}
