'use client';

/**
 * Cancelamento confirm dialog. Opened inline from the `NFCell` when the
 * latest NF-e is aprovada. Collects the SEFAZ-required justification
 * (`xJust`, 15–255 chars), warns that cancelamento is irreversible, and
 * POSTs to `/api/nfe/cancelar` via the typed client.
 *
 * On success the NFCell flips to `cancelada` on its own (it subscribes to
 * the nfev4 doc via `onSnapshot`), so we just close + toast. On failure we
 * surface the error and keep the dialog open so the operator can retry.
 */
import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { NFeRejectedError } from '@delfrance/integrations-nfe/http-provider';

import { useNFeClient } from '@/lib/nfe/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

const XJUST_MIN = 15;
const XJUST_MAX = 255;

export interface CancelarNFeDialogProps {
  readonly opened: boolean;
  readonly pedidoId: string;
  /** NF-e número, shown in the confirmation copy. */
  readonly numero?: number | null;
  readonly onClose: () => void;
}

export function CancelarNFeDialog({
  opened,
  pedidoId,
  numero,
  onClose,
}: CancelarNFeDialogProps) {
  const client = useNFeClient();
  const [xJust, setXJust] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset on close so the next open starts clean (avoids a setState-in-effect
  // reset, which the React Compiler flags).
  function close() {
    setXJust('');
    setSubmitting(false);
    onClose();
  }

  const trimmed = xJust.trim();
  const tooShort = trimmed.length < XJUST_MIN;
  const tooLong = trimmed.length > XJUST_MAX;
  const invalid = tooShort || tooLong;

  async function handleConfirm() {
    if (!client) {
      showErrorNotification({ title: 'Não autenticado', message: 'Você não está logado.' });
      return;
    }
    if (invalid) return;
    setSubmitting(true);
    try {
      await client.cancelar(pedidoId, trimmed);
      notifications.show({
        color: 'teal',
        title: 'NF-e cancelada',
        message: `O cancelamento da NF-e${numero != null ? ` nº ${numero}` : ''} foi homologado pela SEFAZ.`,
      });
      close();
    } catch (err) {
      // 422 (rejeitada) carries the SEFAZ reason; other typed HTTP errors
      // carry their own message. Keep the dialog open for a retry.
      const message =
        err instanceof NFeRejectedError
          ? err.cStat && err.cStat !== '(unknown)'
            ? `SEFAZ rejeitou o cancelamento (cStat ${err.cStat}): ${err.xMotivo}`
            : err.xMotivo
          : err instanceof Error
            ? err.message
            : 'Erro desconhecido ao cancelar a NF-e.';
      showErrorNotification({ title: 'Falha ao cancelar a NF-e', message });
      setSubmitting(false);
    }
  }

  return (
    // The Modal portals in the DOM, but React events still bubble through the
    // React tree — without this guard, clicks inside the modal reach the
    // pedidos row's onClick and navigate away. stopPropagation here only
    // blocks bubbling ABOVE this wrapper; the modal's own close handlers fire.
    <div onClick={(e) => e.stopPropagation()}>
    <Modal
      opened={opened}
      onClose={() => {
        if (!submitting) close();
      }}
      title="Cancelar NF-e"
      closeOnEscape={!submitting}
      closeOnClickOutside={!submitting}
      withCloseButton={!submitting}
      size="lg"
    >
      <Stack>
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="Ação irreversível"
        >
          O cancelamento é definitivo e registrado na SEFAZ. Só é possível
          cancelar dentro do prazo legal (24&nbsp;horas após a autorização).
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
          data-autofocus
          disabled={submitting}
        />

        {numero != null && (
          <Text size="sm" c="dimmed">
            NF-e nº {numero}
          </Text>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={close} disabled={submitting}>
            Voltar
          </Button>
          <Button
            color="red"
            onClick={handleConfirm}
            loading={submitting}
            disabled={invalid || !client}
          >
            Confirmar cancelamento
          </Button>
        </Group>
      </Stack>
    </Modal>
    </div>
  );
}
