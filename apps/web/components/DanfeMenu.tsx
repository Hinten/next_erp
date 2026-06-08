'use client';

/**
 * "Imprimir DANFE" menu — downloads the DANFE for an authorized (or cancelada)
 * NF-e. PR1 offers the **Simplificado (PDF)** and the **Etiqueta (ZPL)** for
 * Zebra printers; PR2 adds the A4 retrato/paisagem options here.
 *
 * Rendering happens server-side in `apps/nfe` (pdfkit/bwip-js never enter the
 * web bundle); this only calls the typed HTTP client and saves the Blob.
 */
import { useState } from 'react';
import { Button, type ButtonProps, Menu } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileText, IconPrinter, IconTag } from '@tabler/icons-react';

import {
  NFeHttpError,
  NFeNetworkError,
  type NFeDanfeFormat,
} from '@delfrance/integrations-nfe/http-provider';

import { useNFeClient } from '@/lib/nfe/client';
import { downloadDanfe } from '@/lib/nfe/downloadDanfe';

export interface DanfeMenuProps {
  readonly pedidoId: string;
  readonly nfeId: string;
  readonly size?: ButtonProps['size'];
  readonly variant?: ButtonProps['variant'];
}

export function DanfeMenu({ pedidoId, nfeId, size = 'xs', variant = 'light' }: DanfeMenuProps) {
  const client = useNFeClient();
  const [busy, setBusy] = useState(false);

  const run = async (format: NFeDanfeFormat): Promise<void> => {
    if (!client) return;
    setBusy(true);
    try {
      await downloadDanfe(client, pedidoId, nfeId, format);
    } catch (err) {
      // Both an HTTP-status error and a transport/network failure are expected,
      // user-facing outcomes — surface a notification. Network failures throw
      // `NFeNetworkError` (not an `NFeHttpError` subclass), so handle it too;
      // only truly unexpected errors rethrow.
      if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao gerar a DANFE',
          message: err.message,
        });
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu withinPortal position="bottom-start" shadow="md">
      <Menu.Target>
        <Button
          color="blue"
          variant={variant}
          size={size}
          loading={busy}
          disabled={!client}
          leftSection={<IconPrinter size={14} />}
        >
          Imprimir DANFE
        </Button>
      </Menu.Target>
      <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
        <Menu.Item
          leftSection={<IconFileText size={14} />}
          onClick={() => void run('retrato')}
        >
          Retrato A4 (PDF)
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileText size={14} />}
          onClick={() => void run('simplificado')}
        >
          Simplificado (PDF)
        </Menu.Item>
        <Menu.Item leftSection={<IconTag size={14} />} onClick={() => void run('zpl2')}>
          Etiqueta (ZPL)
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
