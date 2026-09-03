'use client';

import { forwardRef, useState } from 'react';
import { ActionIcon, Button, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import type { PedidoCandidate } from '@/lib/checkout/loadPedidoCheckout';

export interface PedidoFinderProps {
  /** Resolve typed/scanned text to a pedido (id or número). */
  onFind: (text: string) => void;
  busy: boolean;
  /** the ambiguous `many` result awaiting a pick, or null. */
  manyCandidates: readonly PedidoCandidate[] | null;
  onPick: (candidate: PedidoCandidate) => void;
  onDismiss: () => void;
}

/**
 * The "load a pedido" entry point — the number/id field at the top of the
 * screen (own local state, so typing here doesn't touch the reducer) plus the
 * disambiguation modal shown when `findPedidoCandidates` returns `many`.
 */
export const PedidoFinder = forwardRef<HTMLInputElement, PedidoFinderProps>(function PedidoFinder(
  { onFind, busy, manyCandidates, onPick, onDismiss },
  ref,
) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (t) onFind(t);
  };

  return (
    <>
      <TextInput
        ref={ref}
        label="Número do pedido / ID interno"
        placeholder="Bipe ou digite o pedido"
        value={text}
        autoComplete="off"
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          e.preventDefault();
          submit();
        }}
        rightSection={
          <ActionIcon variant="subtle" onClick={submit} loading={busy} aria-label="Buscar pedido">
            <IconSearch size={18} />
          </ActionIcon>
        }
      />

      <Modal
        opened={manyCandidates !== null}
        onClose={onDismiss}
        title="Vários pedidos encontrados"
        centered
      >
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Mais de um pedido corresponde. Selecione o correto:
          </Text>
          {(manyCandidates ?? []).map((c) => (
            <Button key={c.id} variant="light" justify="space-between" onClick={() => onPick(c)}>
              <span>{c.numero ?? '(sem número)'}</span>
              <Text span size="xs" c="dimmed" ml="sm">
                {c.id}
              </Text>
            </Button>
          ))}
        </Stack>
      </Modal>
    </>
  );
});
