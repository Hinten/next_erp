'use client';

/**
 * "Atualizar preços" (Step 11 PR-D) as a TableView action (#816) — a price-push
 * job for the selected conta, one at a time (`maxSelection: 1`).
 *
 * `baixarPreco` is re-armed STRUCTURALLY: `run` replaces the whole dialog
 * state object, so every open starts from the safe default. It used to be an
 * imperative `setBaixarPreco(false)` in the button's `onClick`, guarded only
 * by a comment — a stale "permitir baixar preços" from a previous run must
 * never leak into a new opt-in, and now no code path can open the dialog
 * without resetting it.
 */
import { useCallback, useMemo, useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { Integracao } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { describePriceSyncStartError } from './mercadoLivreJobErrors';
import { type ContaJobOutcome, type ContaRef, contaRefFromRow } from './startJobsForContas';
import { useContaJobFan } from './useContaJobFan';

export interface PriceSyncActionState {
  readonly opened: boolean;
  readonly contas: readonly ContaRef[];
  /** The operator's explicit opt-in to price DECREASES — false on every open. */
  readonly baixarPreco: boolean;
  readonly setBaixarPreco: (value: boolean) => void;
  readonly busy: boolean;
  readonly entries: readonly ContaJobOutcome[];
  readonly close: () => void;
  readonly start: () => Promise<void>;
  readonly dismiss: (contaId: string) => void;
}

interface DialogState {
  readonly opened: boolean;
  readonly contas: readonly ContaRef[];
  readonly baixarPreco: boolean;
}

const CLOSED: DialogState = { opened: false, contas: [], baixarPreco: false };

export function usePriceSyncAction(): {
  readonly action: ActionConfig<Integracao>;
  readonly state: PriceSyncActionState;
} {
  const client = useMercadoLivreClient();
  const fan = useContaJobFan(describePriceSyncStartError);
  const [dialog, setDialog] = useState<DialogState>(CLOSED);

  const action = useMemo<ActionConfig<Integracao>>(
    () => ({
      id: 'ml-atualizar-precos',
      label: 'Atualizar preços',
      requiresSelection: true,
      // One conta at a time — same reasoning as the mass import: a price push
      // walks every linked produto of an account against the ML rate limit.
      maxSelection: 1,
      run: (rows) => {
        if (!client) {
          notifications.show({
            color: 'red',
            message: 'Faça login novamente para usar as ações do Mercado Livre.',
          });
          return;
        }
        // A fresh object, never a patch — this is the re-arm.
        setDialog({ opened: true, contas: rows.map(contaRefFromRow), baixarPreco: false });
      },
    }),
    [client],
  );

  const close = useCallback(() => {
    setDialog((cur) => ({ ...cur, opened: false }));
  }, []);

  const setBaixarPreco = useCallback((value: boolean) => {
    setDialog((cur) => ({ ...cur, baixarPreco: value }));
  }, []);

  const start = useCallback(async () => {
    if (!client) return;
    const { contas, baixarPreco } = dialog;
    await fan.run(contas, (contaId) =>
      client.startPriceSync({ integracaoId: contaId, baixarPreco }),
    );
    setDialog(CLOSED);
  }, [client, dialog, fan]);

  return {
    action,
    state: {
      opened: dialog.opened,
      contas: dialog.contas,
      baixarPreco: dialog.baixarPreco,
      setBaixarPreco,
      busy: fan.busy,
      entries: fan.entries,
      close,
      start,
      dismiss: fan.dismiss,
    },
  };
}
