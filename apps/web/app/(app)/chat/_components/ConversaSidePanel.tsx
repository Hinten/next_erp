'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconExternalLink,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconUserPlus,
} from '@tabler/icons-react';
import { ORIGEM_LABELS, type Conversa } from '@delfrance/schemas';
import { argbToRgba, hasEtiqueta } from '@/lib/chat/etiquetaCores';
import { isHttpUrl } from '@/lib/chat/safeUrl';
import { useAutorNome } from '../_hooks/useAutorNome';
import { useClienteLink } from '../_hooks/useClienteLink';

const PANEL_WIDTH = 300;

function formatMs(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  return new Date(ms).toLocaleString('pt-BR');
}

/** One participant row — resolves the uid → display name via `useAutorNome`. */
function ParticipantRow({ uid }: { uid: string }) {
  const nome = useAutorNome(uid);
  return (
    <Text size="sm" lineClamp={1}>
      {nome}
    </Text>
  );
}

function ClienteSection({ conversa }: { conversa: Conversa }) {
  const link = useClienteLink(conversa.usarioOuterRef);

  if (link.status === 'no-user') {
    return (
      <Text size="sm" c="dimmed">
        Usuário anônimo
      </Text>
    );
  }
  if (link.status === 'loading') {
    return (
      <Text size="sm" c="dimmed">
        <Loader size="xs" /> Buscando cliente…
      </Text>
    );
  }
  if (link.status === 'found') {
    return (
      <Stack gap={2}>
        <Text size="sm" fw={500} lineClamp={1}>
          {link.nome}
        </Text>
        <Anchor component={Link} href={`/clientes/${link.clienteId}`} size="sm">
          Abrir cliente
        </Anchor>
      </Stack>
    );
  }
  if (link.status === 'error') {
    // The lookup failed — don't offer "Criar cliente" (a duplicate could already
    // exist). Show a warning instead.
    return (
      <Text size="sm" c="orange">
        Não foi possível consultar o cliente
      </Text>
    );
  }
  // not-found → offer to create a cliente prefilled with the user ref + nome.
  const params = new URLSearchParams();
  if (conversa.usarioOuterRef) params.set('userCliente', conversa.usarioOuterRef);
  params.set('nome', conversa.nome);
  return (
    <Stack gap={4}>
      <Text size="sm" c="dimmed">
        Nenhum cliente vinculado.
      </Text>
      <Anchor component={Link} href={`/clientes/novo?${params.toString()}`} size="sm">
        <Group gap={4} wrap="nowrap">
          <IconUserPlus size={14} />
          Criar cliente
        </Group>
      </Anchor>
    </Stack>
  );
}

/**
 * The `/chat/[id]` right-hand context panel — the port of the legacy conversa
 * header block (`.old/lib/chat/conversa.dart:85-130`): the linked cliente
 * (avatar tap → open/create), the external profile link, and the conversa's
 * metadata (origem, datas, etiqueta, participantes). Collapsible; lives in the
 * `ChatInboxShell`'s reserved third pane.
 */
export function ConversaSidePanel({ conversa }: { conversa: Conversa }) {
  const [open, setOpen] = useState(true);
  const dataCadastro = formatMs(conversa.data_cadastro);
  const prazo = formatMs(conversa.prazo_resposta);
  const usuarios = conversa.usuarios ?? [];
  const externalLinkOk = isHttpUrl(conversa.externalLink);

  if (!open) {
    return (
      <Box style={{ borderLeft: '1px solid var(--mantine-color-gray-2)', paddingLeft: 8 }} py="xs">
        <Tooltip label="Mostrar detalhes" position="left">
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={() => setOpen(true)}
            aria-label="Mostrar detalhes"
          >
            <IconLayoutSidebarRightExpand size={18} />
          </ActionIcon>
        </Tooltip>
      </Box>
    );
  }

  return (
    <Box
      w={PANEL_WIDTH}
      style={{
        flex: `0 0 ${PANEL_WIDTH}px`,
        borderLeft: '1px solid var(--mantine-color-gray-2)',
        paddingLeft: 12,
        overflowY: 'auto',
        minHeight: 0,
      }}
    >
      <Stack gap="md" py="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600} size="sm">
            Detalhes
          </Text>
          <Tooltip label="Ocultar detalhes" position="left">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => setOpen(false)}
              aria-label="Ocultar detalhes"
            >
              <IconLayoutSidebarRightCollapse size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>

        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
            Cliente
          </Text>
          <ClienteSection conversa={conversa} />
        </div>

        {externalLinkOk && (
          <Anchor href={conversa.externalLink!} target="_blank" rel="noopener noreferrer" size="sm">
            <Group gap={4} wrap="nowrap">
              <IconExternalLink size={14} />
              Abrir perfil externo
            </Group>
          </Anchor>
        )}

        <Divider />

        <Group gap="xs">
          <Text size="xs" c="dimmed">
            Origem
          </Text>
          <Badge variant="light">{ORIGEM_LABELS[conversa.origem]}</Badge>
          {hasEtiqueta(conversa.cor_etiqueta) && (
            <Tooltip label="Etiqueta">
              <Box
                aria-label="Etiqueta"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: argbToRgba(conversa.cor_etiqueta),
                  border: '1px solid var(--mantine-color-gray-3)',
                }}
              />
            </Tooltip>
          )}
        </Group>

        {dataCadastro && (
          <div>
            <Text size="xs" c="dimmed">
              Cadastro
            </Text>
            <Text size="sm">{dataCadastro}</Text>
          </div>
        )}

        {prazo && (
          <div>
            <Text size="xs" c="dimmed">
              Prazo de resposta
            </Text>
            <Text size="sm">{prazo}</Text>
          </div>
        )}

        <Divider />

        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
            Participantes
          </Text>
          {usuarios.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nenhum atendente na conversa.
            </Text>
          ) : (
            <Stack gap={2}>
              {usuarios.map((uid) => (
                <ParticipantRow key={uid} uid={uid} />
              ))}
            </Stack>
          )}
        </div>
      </Stack>
    </Box>
  );
}
