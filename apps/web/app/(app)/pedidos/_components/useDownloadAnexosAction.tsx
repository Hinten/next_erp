'use client';

/**
 * `/pedidos` TableView bulk action "Download Anexos" — port of Flutter
 * `DownloadAnexosAction` (`.old/lib/pedido/pages/pedidoTableView.dart`).
 *
 * Downloads each distinct product attachment as a separate browser file
 * (no ZIP), with IndexedDB byte cache. See `lib/pedido/downloadAnexos.ts`.
 */
import { useMemo } from 'react';
import { notifications } from '@mantine/notifications';
import { IconPaperclip } from '@tabler/icons-react';
import type { Pedido } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import { getFirebaseFirestore } from '@/lib/firebase/client';
import { downloadAnexos } from '@/lib/pedido/downloadAnexos';

export function useDownloadAnexosAction(): { readonly action: ActionConfig<Pedido> } {
  const action = useMemo<ActionConfig<Pedido>>(
    () => ({
      id: 'download-anexos',
      label: 'Download Anexos',
      color: 'gray',
      icon: <IconPaperclip size={16} />,
      requiresSelection: true,
      run: async (rows) => {
        if (rows.length === 0) {
          notifications.show({
            color: 'gray',
            message: 'Selecione um pedido para baixar os Anexos',
          });
          return;
        }

        const db = getFirebaseFirestore();
        const result = await downloadAnexos(
          db,
          rows.map((r) => r.id),
        );

        if (result.noneFound) {
          const one = rows.length === 1;
          notifications.show({
            color: 'gray',
            message: one
              ? `Nenhum anexo encontrado no pedido ${rows[0]!.data.numero ?? rows[0]!.id}`
              : 'Nenhum anexo encontrado para os pedidos selecionados',
          });
          return;
        }

        if (result.downloaded === 0) {
          // Anexos existed but every resolve/download failed — do not claim
          // "none found" (Copilot review on #642).
          notifications.show({
            color: 'orange',
            message: result.errors[0] ?? 'Não foi possível baixar os anexos. Tente novamente.',
          });
          return;
        }

        if (result.errors.length > 0) {
          notifications.show({
            color: 'orange',
            message: `${result.downloaded} anexo(s) baixado(s); ${result.errors.length} falha(s). ${result.errors[0]}`,
          });
        }
        // Success is silent when all files downloaded (legacy behavior) — the
        // browser download UI is the feedback.
      },
    }),
    [],
  );

  return { action };
}
