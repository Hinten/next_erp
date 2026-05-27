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
import {
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import {
  isNFeEmitError,
  type NFeBatchEmitResult,
  type NFeEmitError,
  type NFeEmitResult,
} from '@delfrance/integrations-nfe/http-provider';

import { useNFeClient } from '@/lib/nfe/client';

export interface EmitirLoteDialogProps {
  readonly opened: boolean;
  readonly pedidoIds: ReadonlyArray<string>;
  readonly onClose: () => void;
}

type Bucket = 'sucesso' | 'falhas' | 'naoEmitidas';

/**
 * Classify a single result into the three Flutter-parity buckets.
 * - Sucesso: this run's autorizadas (`estado='a'` and not reused).
 * - Falhas: this run's rejeitadas / denegadas / errored.
 * - Não emitidas: anything else — EmitError entries (load-fail,
 *   prepare-fail, bloqueada short-circuits returned as
 *   `reused: true`).
 */
function classify(r: NFeEmitResult | NFeEmitError): Bucket {
  if (isNFeEmitError(r)) return 'naoEmitidas';
  if (r.estado === 'a' && r.reused === false) return 'sucesso';
  if (r.estado === 'a' && r.reused === true) return 'naoEmitidas';
  // 'r' (rejeitada), 'd' (denegada), 'e' (error), 'i' (numeracao inutilizada),
  // 'c' (cancelada) — anything terminal-non-autorizada is a failure for this run.
  return 'falhas';
}

type DialogState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'done'; readonly result: NFeBatchEmitResult }
  | { readonly kind: 'error'; readonly message: string };

export function EmitirLoteDialog({
  opened,
  pedidoIds,
  onClose,
}: EmitirLoteDialogProps) {
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
  const sucesso = results.filter((r) => classify(r) === 'sucesso').length;
  const falhas = results.filter((r) => classify(r) === 'falhas').length;
  const naoEmitidas = results.filter((r) => classify(r) === 'naoEmitidas').length;
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
        <Group justify="space-between">
          <Text fw={600} c="teal">
            Sucesso:
          </Text>
          <Text fw={600} c="teal">
            {sucesso}/{total}
          </Text>
        </Group>
        <Group justify="space-between">
          <Text fw={600} c="red">
            Falhas:
          </Text>
          <Text fw={600} c="red">
            {falhas}/{total}
          </Text>
        </Group>
        <Group justify="space-between">
          <Text fw={600} c="yellow">
            Não emitidas:
          </Text>
          <Text fw={600} c="yellow">
            {naoEmitidas}/{total}
          </Text>
        </Group>

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

function ResultRow({
  result,
}: {
  readonly result: NFeEmitResult | NFeEmitError;
}) {
  const bucket = classify(result);
  const color = bucket === 'sucesso' ? 'teal' : bucket === 'falhas' ? 'red' : 'yellow';
  return (
    <Group justify="space-between" wrap="nowrap" gap="xs">
      <Text size="sm" fw={500} truncate maw={140}>
        {result.pedidoId}
      </Text>
      <Group gap="xs" wrap="nowrap" style={{ flexGrow: 1, minWidth: 0, justifyContent: 'flex-end' }}>
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
