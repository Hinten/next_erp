'use client';

/**
 * "Importar todos os anúncios" (#621) as a TableView bulk action (#816). The
 * button used to sit on one conta's detail page; it now acts on the channel
 * list's selection, starting one independent job per selected conta.
 *
 * Shape follows `useEmitirNFeAction` (`lib/nfe/bulkEmit.ts`): the hook returns
 * the `ActionConfig` plus the state its dialog renders, and the page mounts
 * the dialog as a sibling of `<TableView>`.
 */
import { useCallback, useMemo, useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { Integracao } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import {
  type MercadoLivreMassImportOptions,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { describeMassImportStartError } from './mercadoLivreJobErrors';
import { type ContaJobOutcome, type ContaRef, contaRefFromRow } from './startJobsForContas';
import { useContaJobFan } from './useContaJobFan';

export interface MassImportActionState {
  readonly opened: boolean;
  /** The contas captured when the action fired — the dialog lists them. */
  readonly contas: readonly ContaRef[];
  readonly busy: boolean;
  readonly entries: readonly ContaJobOutcome[];
  readonly close: () => void;
  readonly start: (options: MercadoLivreMassImportOptions) => Promise<void>;
  readonly dismiss: (contaId: string) => void;
}

export function useMassImportAction(): {
  readonly action: ActionConfig<Integracao>;
  readonly state: MassImportActionState;
} {
  const client = useMercadoLivreClient();
  const fan = useContaJobFan(describeMassImportStartError);
  const [dialog, setDialog] = useState<{ opened: boolean; contas: readonly ContaRef[] }>({
    opened: false,
    contas: [],
  });

  const action = useMemo<ActionConfig<Integracao>>(
    () => ({
      id: 'ml-importar-todos',
      label: 'Importar todos os anúncios',
      requiresSelection: true,
      // No `confirm`: the options dialog IS the confirmation. No
      // `refreshOnComplete`: starting a job mutates no integração doc, and the
      // refresh would clear the selection the operator still wants for the
      // other action. No `fallbackToSingleVisibleRow`: this is a long,
      // quota-consuming job — it never runs against a row nobody picked.
      run: (rows) => {
        if (!client) {
          notifications.show({
            color: 'red',
            message: 'Faça login novamente para usar as ações do Mercado Livre.',
          });
          return;
        }
        setDialog({ opened: true, contas: rows.map(contaRefFromRow) });
      },
    }),
    [client],
  );

  const close = useCallback(() => {
    setDialog((cur) => ({ ...cur, opened: false }));
  }, []);

  const start = useCallback(
    async (options: MercadoLivreMassImportOptions) => {
      if (!client) return;
      const contas = dialog.contas;
      await fan.run(contas, (contaId) =>
        client.startMassImport({ integracaoId: contaId, options }),
      );
      setDialog({ opened: false, contas: [] });
    },
    [client, dialog.contas, fan],
  );

  return {
    action,
    state: {
      opened: dialog.opened,
      contas: dialog.contas,
      busy: fan.busy,
      entries: fan.entries,
      close,
      start,
      dismiss: fan.dismiss,
    },
  };
}
