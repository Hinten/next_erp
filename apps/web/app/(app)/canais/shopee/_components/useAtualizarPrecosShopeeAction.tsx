'use client';

/**
 * "Atualizar preços" for a Shopee conta (#1529, step 21-5) — the account-wide
 * price job, one conta at a time. Mercado Livre's `usePriceSyncAction` shape.
 *
 * `baixarPreco` is re-armed STRUCTURALLY: `run` replaces the whole dialog state,
 * so every open starts from `false` — a "permitir baixar preços" from the last
 * run never leaks into a new one.
 *
 * ⚠️ A busy start ATTACHES, exactly like the mass import's
 * (`useImportarTodosShopeeAction`): the 409 names the live run and the rail
 * polls it, with a note that the option picked now was not applied.
 */
import { useCallback, useMemo, useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { Integracao } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import {
  type ContaJobOutcome,
  type ContaRef,
  contaRefFromRow,
} from '@/lib/marketplace/contaJobs/types';
import { useContaJobFan } from '@/lib/marketplace/contaJobs/useContaJobFan';
import { useShopeeClient } from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE } from '@/lib/shopee/erros';
import { descreverFalhaAoIniciarAtualizacaoPrecos, jobIdDoJobEmAndamento } from './shopeeJobErrors';

export interface AtualizarPrecosShopeeActionState {
  readonly opened: boolean;
  readonly contas: readonly ContaRef[];
  /** The operator's explicit opt-in to price DECREASES — false on every open. */
  readonly baixarPreco: boolean;
  readonly setBaixarPreco: (value: boolean) => void;
  readonly busy: boolean;
  readonly entries: readonly ContaJobOutcome[];
  /** Runs this session ATTACHED to through a busy start's 409 — their cards say so. */
  readonly reatados: ReadonlySet<string>;
  readonly close: () => void;
  readonly start: () => Promise<void>;
  readonly dismiss: (contaId: string) => void;
}

interface DialogState {
  readonly opened: boolean;
  readonly contas: readonly ContaRef[];
  readonly baixarPreco: boolean;
}

const FECHADO: DialogState = { opened: false, contas: [], baixarPreco: false };

export function useAtualizarPrecosShopeeAction(): {
  readonly action: ActionConfig<Integracao>;
  readonly state: AtualizarPrecosShopeeActionState;
} {
  const client = useShopeeClient();
  const fan = useContaJobFan(descreverFalhaAoIniciarAtualizacaoPrecos);
  const [dialog, setDialog] = useState<DialogState>(FECHADO);
  const [reatados, setReatados] = useState<ReadonlySet<string>>(new Set());

  const action = useMemo<ActionConfig<Integracao>>(
    () => ({
      id: 'shopee-atualizar-precos',
      label: 'Atualizar preços',
      requiresSelection: true,
      // One conta at a time — the run walks every linked listing of a shop
      // against Shopee's quota.
      maxSelection: 1,
      run: (rows) => {
        if (!client) {
          notifications.show({
            color: 'red',
            message: 'Faça login novamente para usar as ações da Shopee.',
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
    await fan.run(contas, async (contaId) => {
      try {
        return await client.startPriceSync({ integracaoId: contaId, baixarPreco });
      } catch (err) {
        const jobId = jobIdDoJobEmAndamento(err, CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento);
        // Rule 6: anything else goes on to the describer, or is rethrown.
        if (jobId === null) throw err;
        setReatados((cur) => new Set(cur).add(jobId));
        return { jobId };
      }
    });
    setDialog(FECHADO);
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
      reatados,
      close,
      start,
      dismiss: fan.dismiss,
    },
  };
}
