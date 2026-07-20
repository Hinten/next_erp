'use client';

import { Group, Tooltip } from '@mantine/core';
import {
  IconAlertCircle,
  IconBan,
  IconCheck,
  IconCloudUpload,
  IconDeviceFloppy,
  IconQuestionMark,
  IconTrash,
} from '@tabler/icons-react';
import { ESTADO_ENVIO, type Mensagem } from '@delfrance/schemas';
import { formatVisualizado } from '@/lib/chat/mensagemTime';

const ICON_SIZE = 14;

/**
 * `errors[].toTooltip()` parity (`.old/packages/atendimento/lib/src/models.dart:1547`):
 * `[code] title`, then `\nDetails: <details>` and `\nError Data: <json>` when
 * present. Joined by newlines across the array; empty array → "Erro desconhecido".
 */
function errorsTooltip(errors: NonNullable<Mensagem['errors']>): string {
  if (errors.length === 0) return 'Erro desconhecido';
  return errors
    .map((e) => {
      let r = `[${e.code}] ${e.title}`;
      if (e.details && e.details.trim() !== '') r += `\nDetails: ${e.details}`;
      if (e.error_data && Object.keys(e.error_data).length > 0)
        r += `\nError Data: ${JSON.stringify(e.error_data)}`;
      return r;
    })
    .join('\n');
}

function dimmed(node: React.ReactNode, label: string) {
  return (
    <Tooltip label={label} withArrow>
      <span
        aria-label={label}
        style={{ color: 'var(--mantine-color-dimmed)', display: 'inline-flex' }}
      >
        {node}
      </span>
    </Tooltip>
  );
}

/**
 * Delivery-state icon cluster for an outbound bubble — port of legacy
 * `MsgStatusWidget` (`.old/lib/chat/basico/mensagem.dart:441-486`):
 *   salva → floppy, enviando → cloud-upload, enviado/recebido → single check,
 *   erro → red alert (Tooltip from `error` or `errors[]`), excluido/banida/
 *   desconhecido → dimmed icons. A non-null `visualizado` adds a SECOND check
 *   with a "Visualizado: <time>" tooltip (the read receipt).
 */
export function MensagemStatusIcon({ mensagem }: { mensagem: Mensagem }) {
  const { estadoEnvio, error, errors, visualizado } = mensagem;

  let statusNode: React.ReactNode = null;
  switch (estadoEnvio) {
    case ESTADO_ENVIO.salva:
      statusNode = dimmed(<IconDeviceFloppy size={ICON_SIZE} />, 'Salva');
      break;
    case ESTADO_ENVIO.enviando:
      statusNode = dimmed(<IconCloudUpload size={ICON_SIZE} />, 'Enviando');
      break;
    case ESTADO_ENVIO.enviado:
      statusNode = (
        <Tooltip label="Enviado" withArrow>
          <IconCheck size={ICON_SIZE} aria-label="Enviado" color="var(--mantine-color-gray-6)" />
        </Tooltip>
      );
      break;
    case ESTADO_ENVIO.recebido:
      statusNode = (
        <Tooltip label="Recebido" withArrow>
          <IconCheck size={ICON_SIZE} aria-label="Recebido" color="var(--mantine-color-gray-6)" />
        </Tooltip>
      );
      break;
    case ESTADO_ENVIO.erro: {
      const tip =
        error && error.trim() !== '' ? error : errors ? errorsTooltip(errors) : 'Erro desconhecido';
      statusNode = (
        <Tooltip label={tip} withArrow multiline w={260}>
          <IconAlertCircle
            size={ICON_SIZE}
            aria-label="Erro no envio"
            color="var(--mantine-color-red-6)"
          />
        </Tooltip>
      );
      break;
    }
    case ESTADO_ENVIO.excluido:
      statusNode = dimmed(<IconTrash size={ICON_SIZE} />, 'Excluído');
      break;
    case ESTADO_ENVIO.banida:
      statusNode = dimmed(<IconBan size={ICON_SIZE} />, 'Banido');
      break;
    case ESTADO_ENVIO.desconhecido:
      statusNode = dimmed(<IconQuestionMark size={ICON_SIZE} />, 'Desconhecido');
      break;
    default:
      statusNode = null;
  }

  return (
    <Group gap={2} wrap="nowrap" align="center">
      {statusNode}
      {visualizado != null && (
        <Tooltip label={formatVisualizado(visualizado)} withArrow>
          <IconCheck
            size={ICON_SIZE}
            aria-label="Visualizado"
            color="var(--mantine-color-blue-6)"
          />
        </Tooltip>
      )}
    </Group>
  );
}
