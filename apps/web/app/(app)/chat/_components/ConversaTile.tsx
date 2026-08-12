'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Avatar, Box, Checkbox, Group, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconAlertCircle, IconChecks, IconClock, IconPencil } from '@tabler/icons-react';
import { ESTADO_ENVIO, type Conversa, type EstadoEnvioMensagem } from '@delfrance/schemas';
import { etiquetaTint } from '@/lib/chat/etiquetaCores';
import { lastMensagemPreview } from '@/lib/chat/preview';
import { hasDraft } from '@/lib/chat/draft';
import { useLastMensagem } from '../_hooks/useLastMensagem';

/** Initials fallback for the avatar (first two words of the name). */
function initials(nome: string): string {
  const parts = nome.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + second).toUpperCase();
}

function formatTime(ms: number | null | undefined): string {
  if (ms == null) return '';
  return new Date(ms).toLocaleString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}

/**
 * Delivery-state tick for the last message (legacy `MsgStatusWidget`). Inbound
 * customer messages (`recebido`) get no tick — the tile isn't a "you sent this"
 * receipt for those. `null` renders nothing.
 */
function DeliveryTick({ estado }: { estado: EstadoEnvioMensagem | undefined }) {
  if (estado == null) return null;
  switch (estado) {
    case ESTADO_ENVIO.erro:
      return (
        <Tooltip label="Erro no envio" withArrow>
          <IconAlertCircle
            size={14}
            color="var(--mantine-color-red-6)"
            aria-label="Erro no envio"
          />
        </Tooltip>
      );
    case ESTADO_ENVIO.enviando:
    case ESTADO_ENVIO.salva:
      return <IconClock size={14} color="var(--mantine-color-gray-5)" aria-label="Enviando" />;
    case ESTADO_ENVIO.enviado:
      return <IconChecks size={14} color="var(--mantine-color-gray-5)" aria-label="Enviado" />;
    default:
      return null;
  }
}

export interface ConversaTileProps {
  id: string;
  conversa: Conversa;
  active: boolean;
  href: string;
  meuUid?: string | null;
  /** Show the bulk-selection checkbox. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

/**
 * A single conversa row in the inbox list: avatar, name, last-message preview,
 * etiqueta tint (contrast-aware text), draft indicator, time + delivery tick,
 * active highlight, and optional bulk-selection checkbox. The row body is a
 * keyboard-focusable link that preserves the current filters (`href`).
 */
export function ConversaTile({
  id,
  conversa,
  active,
  href,
  meuUid,
  selectable = false,
  selected = false,
  onToggleSelect,
}: ConversaTileProps) {
  const { data: lastMsg, loading } = useLastMensagem(id, conversa.ultima_modificacao);
  const tint = etiquetaTint(conversa.cor_etiqueta);
  const draft = useMemo(() => hasDraft(id), [id]);

  const preview = loading ? '…' : lastMensagemPreview(lastMsg, { meuUid });
  const timeMs = lastMsg?.timestamp ?? conversa.ultima_modificacao;

  const mutedColor = tint ? tint.color : 'var(--mantine-color-dimmed)';

  return (
    <Group gap={6} wrap="nowrap" align="stretch">
      {selectable && (
        <Checkbox
          checked={selected}
          onChange={() => onToggleSelect?.(id)}
          aria-label={`Selecionar ${conversa.nome}`}
          styles={{ root: { alignSelf: 'center' } }}
        />
      )}
      <Box
        component={Link}
        href={href}
        aria-current={active ? 'true' : undefined}
        p="xs"
        style={(theme) => ({
          flex: 1,
          minWidth: 0,
          display: 'block',
          textDecoration: 'none',
          color: tint ? tint.color : 'inherit',
          borderRadius: theme.radius.sm,
          background: tint ? tint.background : active ? theme.colors.blue[0] : undefined,
          borderLeft: active ? `3px solid ${theme.colors.blue[6]}` : '3px solid transparent',
        })}
      >
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Avatar
            src={conversa.urlAvatar || undefined}
            radius="xl"
            size={40}
            color="blue"
            name={conversa.nome}
          >
            {initials(conversa.nome)}
          </Avatar>
          <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between" wrap="nowrap" gap={4}>
              <Text fw={600} size="sm" lineClamp={1}>
                {conversa.nome}
              </Text>
              {timeMs != null && (
                <Text size="xs" c={mutedColor} style={{ whiteSpace: 'nowrap' }}>
                  {formatTime(timeMs)}
                </Text>
              )}
            </Group>
            <Group justify="space-between" wrap="nowrap" gap={4}>
              <Text size="xs" c={mutedColor} lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
                {preview}
              </Text>
              <Group gap={4} wrap="nowrap">
                {draft && (
                  <Tooltip label="Rascunho não enviado" withArrow>
                    <ThemeIcon variant="transparent" size={16} color="gray" aria-label="Rascunho">
                      <IconPencil size={14} />
                    </ThemeIcon>
                  </Tooltip>
                )}
                <DeliveryTick estado={lastMsg?.estadoEnvio} />
              </Group>
            </Group>
          </Stack>
        </Group>
      </Box>
    </Group>
  );
}
