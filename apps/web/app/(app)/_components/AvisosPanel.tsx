'use client';

import Link from 'next/link';
import { Anchor, Badge, Button, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import {
  SEVERIDADE_AVISO,
  rotaInternaSegura,
  urlExternaSegura,
  type SeveridadeAviso,
} from '@delfrance/schemas';
import { microsToMillis } from '@delfrance/core/datetime';
import { HOSTS_EXTERNOS_PERMITIDOS, MENSAGENS_POR_TIPO } from '@/lib/avisos/mensagens';
import type { AvisoRow } from '@/lib/avisos/useAvisos';

const COR_POR_SEVERIDADE: Record<SeveridadeAviso, string> = {
  [SEVERIDADE_AVISO.critico]: 'red',
  [SEVERIDADE_AVISO.atencao]: 'yellow',
  [SEVERIDADE_AVISO.informativo]: 'gray',
};

/**
 * The provider's deadline (`aviso.prazo`, µs) as the operator's local date and
 * time. Rendered from the FIELD, never from a `params` entry: a deadline in
 * `params` would be interpolated raw by the wording and read as a µs integer,
 * which is why producers keep it out of there. This is a browser surface, so the
 * local zone is the operator's own and the right one to show.
 */
function formatarPrazo(prazoUs: number): string {
  return new Date(microsToMillis(prazoUs)).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface AvisosPanelProps {
  rows: AvisoRow[];
  loading: boolean;
  naoLidos: number;
  onMarcarLido: (avisoId: string) => Promise<void> | void;
  onMarcarTodosLidos: () => Promise<void> | void;
  onNavegar?: () => void;
}

/**
 * The list body, shared by the bell popover and the `/inicio` page so the two
 * cannot disagree about what an aviso looks like.
 *
 * Wording, not the row, decides what the operator reads: the document stores
 * structured params and this renders them through `MENSAGENS_POR_TIPO`, so a
 * clearer sentence reaches avisos written months ago.
 */
export function AvisosPanel({
  rows,
  loading,
  naoLidos,
  onMarcarLido,
  onMarcarTodosLidos,
  onNavegar,
}: AvisosPanelProps) {
  if (loading) {
    return (
      <Group justify="center" p="md">
        <Loader size="sm" />
      </Group>
    );
  }

  if (rows.length === 0) {
    return (
      <Stack p="md" gap={4}>
        <Text size="sm" fw={500}>
          Nenhum aviso pendente
        </Text>
        <Text size="xs" c="dimmed">
          Avisos sobre canais, pedidos e notas fiscais aparecem aqui.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap={0}>
      <Group justify="space-between" px="sm" py="xs">
        <Text size="xs" c="dimmed">
          {naoLidos > 0 ? `${String(naoLidos)} não lido(s)` : 'Tudo lido'}
        </Text>
        {naoLidos > 0 && (
          <Button size="compact-xs" variant="subtle" onClick={() => void onMarcarTodosLidos()}>
            Marcar todas como lidas
          </Button>
        )}
      </Group>

      {rows.map((row) => (
        <LinhaAviso key={row.id} row={row} onMarcarLido={onMarcarLido} onNavegar={onNavegar} />
      ))}
    </Stack>
  );
}

function LinhaAviso({
  row,
  onMarcarLido,
  onNavegar,
}: {
  row: AvisoRow;
  onMarcarLido: AvisosPanelProps['onMarcarLido'];
  onNavegar?: () => void;
}) {
  const { aviso, naoLido, id } = row;
  const mensagem = MENSAGENS_POR_TIPO[aviso.tipo];
  // Provider-supplied and therefore untrusted: `null` unless it is https on an
  // expected host, so a hostile value degrades to "no link", never to an href.
  const externa = urlExternaSegura(aviso.urlExterna, HOSTS_EXTERNOS_PERMITIDOS);
  // The internal route gets the same treatment rather than being trusted because
  // `avisos` is serverOwned: `rota` is built from provider-supplied ids and, once
  // stored, outlives the code that wrote it.
  const interna = rotaInternaSegura(aviso.urlInterna?.rota);

  return (
    <Stack
      gap={4}
      px="sm"
      py="xs"
      style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
      data-testid="aviso-row"
      data-nao-lido={naoLido ? 'true' : 'false'}
    >
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Group gap="xs" wrap="nowrap">
          <Badge size="xs" color={COR_POR_SEVERIDADE[aviso.severidade]} variant="light">
            {aviso.severidade}
          </Badge>
          <Text size="sm" fw={naoLido ? 700 : 500}>
            {mensagem.titulo}
          </Text>
        </Group>
        {aviso.ocorrencias > 1 && (
          <Text size="xs" c="dimmed" title="Ocorrências desde o primeiro aviso">
            ×{aviso.ocorrencias}
          </Text>
        )}
      </Group>

      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {mensagem.corpo(aviso.params)}
      </Text>

      {aviso.prazo != null && (
        <Text size="xs" fw={500} data-testid="aviso-prazo">
          Prazo: {formatarPrazo(aviso.prazo)}
        </Text>
      )}

      {mensagem.runbook !== undefined && (
        <Text size="xs" c="dimmed" fs="italic">
          {mensagem.runbook}
        </Text>
      )}

      <Group gap="sm">
        {interna !== null && (
          <Anchor
            component={Link}
            href={interna}
            size="xs"
            onClick={() => {
              onNavegar?.();
            }}
          >
            Abrir
          </Anchor>
        )}
        {externa !== null && (
          <Anchor href={externa} size="xs" target="_blank" rel="noopener noreferrer">
            Abrir no canal
          </Anchor>
        )}
        {naoLido && (
          <UnstyledButton onClick={() => void onMarcarLido(id)}>
            <Text size="xs" c="dimmed">
              Marcar como lida
            </Text>
          </UnstyledButton>
        )}
      </Group>
    </Stack>
  );
}
