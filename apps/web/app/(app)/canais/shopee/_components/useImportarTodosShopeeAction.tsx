'use client';

/**
 * "Importar todos os anúncios" for a Shopee conta (#1529, step 21-5) as a
 * TableView action — Mercado Livre's `useMassImportAction` shape: the hook
 * returns the `ActionConfig` plus the state its dialog and the rail render, and
 * the page mounts the dialog as a sibling of `<TableView>`.
 *
 * ⚠️ A busy start ATTACHES instead of failing. The backend allows one import per
 * conta and its 409 names the running job (`detalhes.jobId`), so the start
 * closure turns that 409 into the running `jobId` and the rail polls it — a card
 * the operator can follow and cancel, never a dead button. The job's id lands in
 * `reatados`, and its card says the options picked now were NOT applied.
 */
import { useCallback, useMemo, useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { z } from 'zod';
import type { Integracao, importacaoShopeeOptionsSchema } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import {
  type ContaJobOutcome,
  type ContaRef,
  contaRefFromRow,
} from '@/lib/marketplace/contaJobs/types';
import { useContaJobFan } from '@/lib/marketplace/contaJobs/useContaJobFan';
import { useShopeeClient } from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE } from '@/lib/shopee/erros';
import { descreverFalhaAoIniciarImportacao, jobIdDoJobEmAndamento } from './shopeeJobErrors';

/** The options body as the dialog builds it — each key absent ⇒ the backend's default. */
export type OpcoesImportacaoShopee = z.input<typeof importacaoShopeeOptionsSchema>;

export interface ImportarTodosShopeeActionState {
  readonly opened: boolean;
  /** The contas captured when the action fired — the dialog lists them. */
  readonly contas: readonly ContaRef[];
  readonly busy: boolean;
  readonly entries: readonly ContaJobOutcome[];
  /** Jobs this session ATTACHED to through a busy start's 409 — their cards say so. */
  readonly reatados: ReadonlySet<string>;
  readonly close: () => void;
  readonly start: (options: OpcoesImportacaoShopee) => Promise<void>;
  readonly dismiss: (contaId: string) => void;
}

interface DialogState {
  readonly opened: boolean;
  readonly contas: readonly ContaRef[];
}

const FECHADO: DialogState = { opened: false, contas: [] };

export function useImportarTodosShopeeAction(): {
  readonly action: ActionConfig<Integracao>;
  readonly state: ImportarTodosShopeeActionState;
} {
  const client = useShopeeClient();
  const fan = useContaJobFan(descreverFalhaAoIniciarImportacao);
  const [dialog, setDialog] = useState<DialogState>(FECHADO);
  const [reatados, setReatados] = useState<ReadonlySet<string>>(new Set());

  const action = useMemo<ActionConfig<Integracao>>(
    () => ({
      id: 'shopee-importar-todos',
      label: 'Importar todos os anúncios',
      requiresSelection: true,
      // ONE conta at a time: the job walks a whole shop against Shopee's quota
      // for minutes. Several runs one after another still each get a card.
      maxSelection: 1,
      // No `confirm` (the options dialog IS the confirmation), no
      // `refreshOnComplete` (a start mutates no integração doc, and a refresh
      // would clear the selection), no `fallbackToSingleVisibleRow`.
      run: (rows) => {
        if (!client) {
          notifications.show({
            color: 'red',
            message: 'Faça login novamente para usar as ações da Shopee.',
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
    async (options: OpcoesImportacaoShopee) => {
      if (!client) return;
      await fan.run(dialog.contas, async (contaId) => {
        try {
          return await client.startMassImport({ integracaoId: contaId, options });
        } catch (err) {
          const jobId = jobIdDoJobEmAndamento(err, CODIGO_FALHA_SHOPEE.importacaoEmAndamento);
          // Rule 6: everything that is not THIS flow's busy start goes on to the
          // fan-out's describer (and, if it is not ours at all, is rethrown).
          if (jobId === null) throw err;
          setReatados((cur) => new Set(cur).add(jobId));
          return { jobId };
        }
      });
      setDialog(FECHADO);
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
      reatados,
      close,
      start,
      dismiss: fan.dismiss,
    },
  };
}
