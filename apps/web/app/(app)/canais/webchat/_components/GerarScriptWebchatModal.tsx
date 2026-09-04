'use client';

import { useMemo, useState } from 'react';
import { Button, Code, CopyButton, Group, Modal, Stack, Text } from '@mantine/core';
import type { ActionConfig } from '@delfrance/ui';
import type { Webchat } from '@delfrance/schemas';
import { buildEmbedScript, buildEmbedScriptBase64 } from './embedSnippet';

interface DialogState {
  readonly opened: boolean;
  readonly docId: string | null;
  readonly nome: string | null;
}

const CLOSED: DialogState = { opened: false, docId: null, nome: null };

/**
 * "Gerar Script Webchat" TableView bulk action (#558): meaningful for exactly
 * one `webchat` doc at a time (`maxSelection: 1`) — it turns the selected doc
 * into the embed `<script>` snippet `apps/webchat/public/loader.js` expects.
 */
export function useGerarScriptWebchatAction(): {
  readonly action: ActionConfig<Webchat>;
  readonly opened: boolean;
  readonly docId: string | null;
  readonly nome: string | null;
  readonly close: () => void;
} {
  const [dialog, setDialog] = useState<DialogState>(CLOSED);

  const action: ActionConfig<Webchat> = {
    id: 'gerar-script-webchat',
    label: 'Gerar Script Webchat',
    requiresSelection: true,
    maxSelection: 1,
    fallbackToSingleVisibleRow: true,
    run: (rows) => {
      const row = rows[0];
      if (!row) return;
      setDialog({ opened: true, docId: row.id, nome: row.data.nome });
    },
  };

  return {
    action,
    opened: dialog.opened,
    docId: dialog.docId,
    nome: dialog.nome,
    close: () => setDialog(CLOSED),
  };
}

export function GerarScriptWebchatModal({
  opened,
  docId,
  nome,
  onClose,
}: {
  opened: boolean;
  docId: string | null;
  nome: string | null;
  onClose: () => void;
}) {
  const script = useMemo(() => (docId ? buildEmbedScript(docId) : ''), [docId]);
  const scriptBase64 = useMemo(() => (docId ? buildEmbedScriptBase64(docId) : ''), [docId]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Script de instalação${nome ? ` — ${nome}` : ''}`}
      size="lg"
    >
      <Stack gap="md">
        <Text size="sm">
          Copie o trecho abaixo e cole no HTML do site onde o widget deve aparecer.
        </Text>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text fw={500} size="sm">
              Script
            </Text>
            <CopyButton value={script}>
              {({ copied, copy }) => (
                <Button size="compact-xs" variant="subtle" onClick={copy}>
                  {copied ? 'Copiado' : 'Copiar'}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Code block>{script}</Code>
        </Stack>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text fw={500} size="sm">
              Script (base64)
            </Text>
            <CopyButton value={scriptBase64}>
              {({ copied, copy }) => (
                <Button size="compact-xs" variant="subtle" onClick={copy}>
                  {copied ? 'Copiado' : 'Copiar'}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Code block style={{ wordBreak: 'break-all' }}>
            {scriptBase64}
          </Code>
        </Stack>
      </Stack>
    </Modal>
  );
}
