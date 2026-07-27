'use client';

/**
 * Inline cancelamento form, shown on the per-NF-e screen when the NF-e is
 * aprovada. Collects the SEFAZ-required justification (`xJust`, 15–255) and
 * POSTs to `/api/nfe/cancelar` for the specific `nfeId`. On success the NF-e
 * flips to `cancelada` on its own (the screen subscribes to the nfev4 doc via
 * `onSnapshot`) and a new audit row appears, so we just toast — then prompt the
 * operator to also cancel the pedido (#74, legacy
 * `cancelamentoNFe.dart:229-261`). That follow-up is optional and best-effort:
 * a failure to cancel the pedido must never read as the NF-e cancelamento
 * having failed.
 */
import { useState } from 'react';
import { Alert, Button, Group, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import {
  NFeHttpError,
  NFeNetworkError,
  NFeRejectedError,
} from '@delfrance/integrations-nfe/http-provider';
import { cancelarPedido } from '@delfrance/data/pedido';

import { useNFeClient } from '@/lib/nfe/client';
import { useAuth } from '@/lib/auth/useAuth';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import { useConfirmDialog } from '@/app/(app)/pedidos/_components/ConfirmDialog';

const XJUST_MIN = 15;
const XJUST_MAX = 255;

export interface CancelarNFeFormProps {
  readonly pedidoId: string;
  readonly nfeId: string;
  readonly numero?: number | null;
}

export function CancelarNFeForm({ pedidoId, nfeId, numero }: CancelarNFeFormProps) {
  const client = useNFeClient();
  const { user } = useAuth();
  const { confirm, element: confirmDialog } = useConfirmDialog();
  const [xJust, setXJust] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = xJust.trim();
  const tooShort = trimmed.length < XJUST_MIN;
  const tooLong = trimmed.length > XJUST_MAX;
  const invalid = tooShort || tooLong;

  async function promptCancelarPedido() {
    const cancelarTambem = await confirm({
      title: 'Cancelar pedido?',
      message: 'Também deseja cancelar o pedido?',
    });
    if (!cancelarTambem) return;
    try {
      await cancelarPedido(createClientPedidoPort(getFirebaseFirestore()), {
        pedidoId,
        usuarioRef: user ? `documents/usuarios/${user.uid}` : null,
      });
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
      // `cancelarPedido` can fail after already writing the estado (e.g. the
      // história append), so this must not assert the pedido stayed
      // unchanged — just point the operator at it.
      notifications.show({
        color: 'yellow',
        message: 'Não foi possível confirmar o cancelamento do pedido — verifique o pedido.',
      });
    }
  }

  async function handleConfirm() {
    if (!client) {
      showErrorNotification({ title: 'Não autenticado', message: 'Você não está logado.' });
      return;
    }
    if (invalid) return;
    setSubmitting(true);
    let cancelamentoOk = false;
    try {
      await client.cancelar(pedidoId, nfeId, trimmed);
      cancelamentoOk = true;
      notifications.show({
        color: 'teal',
        title: 'NF-e cancelada',
        message: `O cancelamento da NF-e${numero != null ? ` nº ${numero}` : ''} foi homologado pela SEFAZ.`,
      });
      setXJust('');
    } catch (err) {
      // The client throws NFeHttpError subclasses (incl. NFeRejectedError) or
      // NFeNetworkError; anything else is an unexpected bug — let it surface.
      if (!(err instanceof NFeHttpError) && !(err instanceof NFeNetworkError)) throw err;
      const message =
        err instanceof NFeRejectedError
          ? err.cStat && err.cStat !== '(unknown)'
            ? `SEFAZ rejeitou o cancelamento (cStat ${err.cStat}): ${err.xMotivo}`
            : err.xMotivo
          : err.message;
      showErrorNotification({ title: 'Falha ao cancelar a NF-e', message });
    } finally {
      setSubmitting(false);
    }
    // Independent of the try/catch above so a pedido-cancel failure can never
    // be mistaken for (or roll back) the already-reported NF-e cancelamento.
    if (cancelamentoOk) await promptCancelarPedido();
  }

  return (
    <Stack gap="sm">
      {confirmDialog}
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={18} />}
        title="Ação irreversível"
      >
        O cancelamento é definitivo e registrado na SEFAZ. Só é possível cancelar dentro do prazo
        legal (24&nbsp;horas após a autorização).
      </Alert>

      <Textarea
        label="Justificativa do cancelamento"
        description={`${trimmed.length}/${XJUST_MAX} caracteres (mínimo ${XJUST_MIN})`}
        placeholder="Descreva o motivo do cancelamento"
        autosize
        minRows={3}
        maxRows={6}
        value={xJust}
        onChange={(e) => setXJust(e.currentTarget.value)}
        error={
          trimmed.length > 0 && tooShort
            ? `A justificativa deve ter ao menos ${XJUST_MIN} caracteres.`
            : tooLong
              ? `A justificativa deve ter no máximo ${XJUST_MAX} caracteres.`
              : undefined
        }
        maxLength={XJUST_MAX}
        disabled={submitting}
      />

      <Group justify="flex-end">
        <Button
          color="red"
          onClick={handleConfirm}
          loading={submitting}
          disabled={invalid || !client}
        >
          Cancelar NF-e
        </Button>
      </Group>
    </Stack>
  );
}
