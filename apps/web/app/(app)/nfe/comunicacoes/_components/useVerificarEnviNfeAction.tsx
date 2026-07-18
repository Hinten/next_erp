'use client';

/**
 * "Verificar novamente" toolbar action for the /nfe/comunicacoes TableView —
 * re-runs the SEFAZ consultation for the NF-es referenced by ONE selected
 * enviNfe audit msg (`POST /api/nfe/verificar` via `client.verificar`).
 *
 * Shape mirrors `useEmitirNFeAction` (lib/nfe/bulkEmit.ts): the hook returns
 * the `ActionConfig` plus the modal state the page binds to
 * `<VerificarResultadosModal>`. Single-selection is enforced inside `run()`
 * with a notification (repo convention — no generic ActionConfig changes).
 */
import { useState } from 'react';
import {
  NFeHttpError,
  NFeNetworkError,
  type NFeVerificarResult,
} from '@delfrance/integrations-nfe/http-provider';
import type { EnviNFeMsg } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import { useNFeClient } from '@/lib/nfe/client';
import { notificationForNFeError } from '@/lib/nfe/errors';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

export interface VerificarResultadosModalState {
  readonly opened: boolean;
  readonly result: NFeVerificarResult | null;
  readonly close: () => void;
}

export function useVerificarEnviNfeAction(filialId: string | null): {
  readonly action: ActionConfig<EnviNFeMsg>;
  readonly modal: VerificarResultadosModalState;
} {
  const client = useNFeClient();
  const [state, setState] = useState<{
    opened: boolean;
    result: NFeVerificarResult | null;
  }>({ opened: false, result: null });

  const action: ActionConfig<EnviNFeMsg> = {
    id: 'verificar-envinfe',
    label: 'Verificar novamente',
    requiresSelection: true,
    // Mutating action — a verification can update nfev4 estados and appends
    // new audit docs, so re-run the one-shot table query when it finishes.
    refreshOnComplete: true,
    run: async (rows) => {
      if (rows.length !== 1) {
        showErrorNotification({
          title: 'Verificar novamente',
          message: 'Selecione exatamente 1 comunicação para verificar.',
        });
        return;
      }
      if (!client) {
        showErrorNotification({
          title: 'Você não está logado',
          message: 'Faça login para verificar a NF-e.',
        });
        return;
      }
      if (!filialId) {
        // Defensive — the table (and thus the action) only renders with a filial.
        showErrorNotification({
          title: 'Filial não selecionada',
          message: 'Selecione uma filial para verificar a comunicação.',
        });
        return;
      }
      try {
        const result = await client.verificar(filialId, [rows[0]!.id]);
        setState({ opened: true, result });
      } catch (err) {
        if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
          showErrorNotification(notificationForNFeError(err));
          return;
        }
        throw err;
      }
    },
  };

  const modal: VerificarResultadosModalState = {
    opened: state.opened,
    result: state.result,
    close: () => setState((s) => ({ ...s, opened: false })),
  };

  return { action, modal };
}
