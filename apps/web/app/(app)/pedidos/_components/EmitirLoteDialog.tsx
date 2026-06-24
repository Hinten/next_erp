'use client';

/**
 * Batch NF-e emission dialog. Opens when the user selects >1 pedidos
 * and triggers "Emitir NF-e" on the `/pedidos` TableView. Fires one
 * POST to `/api/nfe/emitir-lote` and renders the per-pedido outcomes
 * grouped into three buckets (Sucesso / Falhas / Não emitidas),
 * mirroring Flutter's `.old/lib/nfe/widgets.dart:91-141:EmitirNFeDialog`.
 *
 * Single POST, render-on-result — no streaming. SEFAZ-SP HOM resolves
 * batches in ~5-15 s; SSE on Firebase App Hosting would add complexity
 * without reaching a different terminal state.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Group, Loader, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import {
  isNFeEmitError,
  type NFeBatchEmitResult,
  type NFeEmitError,
  type NFeEmitResult,
} from '@delfrance/integrations-nfe/http-provider';

import { useNFeClient } from '@/lib/nfe/client';

import { BUCKET_META, BUCKET_ORDER, classifyEmitResult } from './emitirLoteBuckets';

export interface EmitirLoteDialogProps {
  readonly opened: boolean;
  readonly pedidoIds: ReadonlyArray<string>;
  readonly onClose: () => void;
}

type DialogState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'done'; readonly result: NFeBatchEmitResult }
  | { readonly kind: 'error'; readonly message: string };

export function EmitirLoteDialog({ opened, pedidoIds, onClose }: EmitirLoteDialogProps) {
  const client = useNFeClient();
  const [state, setState] = useState<DialogState>({ kind: 'idle' });

  // Fire one request when the dialog opens with a non-empty selection.
  // The effect re-runs if `pedidoIds` identity changes (e.g. the user
  // re-opens with a different selection), in which case we cancel
  // the in-flight request via the `cancelled` flag.
  useEffect(() => {
    if (!opened) {
      setState({ kind: 'idle' });
      return;
    }
    if (!client) {
      setState({ kind: 'error', message: 'Você não está logado.' });
      return;
    }
    if (pedidoIds.length === 0) {
      setState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'pending' });
    client.emitirLote(pedidoIds).then(
      (r) => {
        if (!cancelled) setState({ kind: 'done', result: r });
      },
      (e) => {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [opened, pedidoIds, client]);

  const total = pedidoIds.length;
  const results = state.kind === 'done' ? state.result.results : [];
  // One counter per bucket, in display order — including the blue "Em
  // processamento" bucket for async-pending notes (cStat 103), which used to be
  // wrongly counted as Falhas (#259).
  const counts = BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: BUCKET_META[bucket].label,
    color: BUCKET_META[bucket].color,
    count: results.filter((r) => classifyEmitResult(r) === bucket).length,
  }));
  const closable = state.kind !== 'pending';

  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (closable) onClose();
      }}
      title={total === 1 ? 'Emitindo Nota Fiscal' : `Emitindo ${total} Notas Fiscais`}
      closeOnEscape={closable}
      closeOnClickOutside={closable}
      withCloseButton={closable}
      size="lg"
    >
      <Stack>
        {counts.map(({ bucket, label, color, count }) => (
          <Group justify="space-between" key={bucket}>
            <Text fw={600} c={color}>
              {label}:
            </Text>
            <Text fw={600} c={color}>
              {count}/{total}
            </Text>
          </Group>
        ))}

        {state.kind === 'pending' && (
          <Group justify="center" mt="md">
            <Loader />
          </Group>
        )}

        {state.kind === 'error' && (
          <Text c="red" ta="center">
            {state.message}
          </Text>
        )}

        {state.kind === 'done' && results.length > 0 && (
          <ScrollArea.Autosize mah={240} mt="md">
            <Stack gap="xs">
              {results.map((r, i) => (
                <ResultRow key={`${r.pedidoId}-${i}`} result={r} />
              ))}
            </Stack>
          </ScrollArea.Autosize>
        )}

        {closable && (
          <Group justify="flex-end" mt="md">
            <Button onClick={onClose}>Fechar</Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}

function ResultRow({ result }: { readonly result: NFeEmitResult | NFeEmitError }) {
  const color = BUCKET_META[classifyEmitResult(result)].color;
  return (
    <Group justify="space-between" wrap="nowrap" gap="xs">
      <Text size="sm" fw={500} truncate maw={140}>
        {result.pedidoId}
      </Text>
      <Group
        gap="xs"
        wrap="nowrap"
        style={{ flexGrow: 1, minWidth: 0, justifyContent: 'flex-end' }}
      >
        <Badge size="sm" color={color} variant="light">
          {isNFeEmitError(result) ? result.errorCode : result.cStat}
        </Badge>
        <Text size="xs" c="dimmed" truncate maw={300}>
          {isNFeEmitError(result) ? result.errorMessage : result.xMotivo}
        </Text>
      </Group>
    </Group>
  );
}
