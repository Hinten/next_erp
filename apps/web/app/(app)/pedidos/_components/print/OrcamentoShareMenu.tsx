'use client';

/**
 * The pedido footer's "Compartilhar / imprimir orçamento" control (issue #302).
 * The IconShare button opens a small menu to download the orçamento as a JPEG
 * image OR a PDF file, **separately** (each is a silent download — no print
 * dialog). On click it assembles the print model from Firestore, mounts the
 * {@link OrcamentoSheet} off-screen, and `useOrcamentoExport` captures it.
 *
 * Disabled until the pedido is saved (no `pedidoId` ⇒ nothing to assemble).
 */
import { useEffect, useState } from 'react';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileTypePdf, IconPhoto, IconShare } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';

import type { PedidoPrintModel } from '@/lib/pedido-print/model';

import { OrcamentoSheet } from './OrcamentoSheet';
import { useOrcamentoExport, type OrcamentoFormat } from './useOrcamentoExport';

const ERROR_TITLE = 'Falha ao gerar o orçamento';

export interface OrcamentoShareMenuProps {
  readonly db: Firestore;
  /** Present only in edit mode — a saved pedido to assemble the orçamento from. */
  readonly pedidoId?: string;
}

export function OrcamentoShareMenu({ db, pedidoId }: OrcamentoShareMenuProps) {
  const [model, setModel] = useState<PedidoPrintModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<OrcamentoFormat | null>(null);
  const { ref, exporting, error, exportAs } = useOrcamentoExport(model);

  // Once the model loads, the hidden sheet is mounted — run the requested
  // export, then clear so a later click rebuilds fresh.
  useEffect(() => {
    if (!model || !pending) return;
    let cancelled = false;
    void exportAs(pending).finally(() => {
      if (!cancelled) {
        setModel(null);
        setPending(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [model, pending, exportAs]);

  // Surface a capture failure as a notification.
  useEffect(() => {
    if (error) notifications.show({ color: 'red', title: ERROR_TITLE, message: error });
  }, [error]);

  function start(format: OrcamentoFormat) {
    if (!pedidoId || loading || exporting || model) return;
    setLoading(true);
    setPending(format);
    // Lazy-load the assembly chain (Firestore reads + its deps) only on click —
    // keeps it out of the pedido-form bundle and out of importers' module graph.
    import('@/lib/pedido-print/assemble')
      .then(({ buildPrintModel }) => buildPrintModel(db, pedidoId, {}))
      .then(
        (m) => setModel(m),
        (e: unknown) => {
          setPending(null);
          notifications.show({
            color: 'red',
            title: ERROR_TITLE,
            message: e instanceof Error ? e.message : String(e),
          });
        },
      )
      .finally(() => setLoading(false));
  }

  const busy = loading || exporting;

  return (
    <>
      <Menu shadow="md" position="top-end" withArrow>
        <Menu.Target>
          <Tooltip
            label={
              pedidoId
                ? 'Compartilhar / imprimir orçamento'
                : 'Salve o pedido para gerar o orçamento'
            }
            withArrow
          >
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Compartilhar orçamento"
              loading={busy}
              disabled={!pedidoId}
            >
              <IconShare size={18} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Baixar orçamento</Menu.Label>
          <Menu.Item leftSection={<IconPhoto size={16} />} onClick={() => start('image')}>
            Imagem (JPEG)
          </Menu.Item>
          <Menu.Item leftSection={<IconFileTypePdf size={16} />} onClick={() => start('pdf')}>
            PDF
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

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
