'use client';

/**
 * Batch warehouse-print dialog. Opens from the `/pedidos` TableView "Imprimir"
 * action with the selected pedido ids. It:
 *  1. builds every pedido's print model in concurrent waves (progress bar);
 *  2. renders the `<ComumSheet>`s off-screen and waits for all images to load;
 *  3. on the user's "Imprimir" click (a real gesture, so `print()` isn't
 *     blocked) prints them in an isolated iframe via `react-to-print`;
 *  4. after the dialog closes, marks the printed pedidos `foiImpresso` +
 *     `dtImpressao`.
 *
 * Mirrors `EmitirLoteDialog`'s shape (opened / pedidoIds / onClose props).
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Loader, Modal, Progress, Stack, Text } from '@mantine/core';
import { useReactToPrint } from 'react-to-print';

import { getFirebaseFirestore } from '@/lib/firebase/client';
import { buildModelsInWaves, markPedidosPrinted } from '@/lib/pedido-print/batch';
import type { PedidoPrintModel } from '@/lib/pedido-print/model';

import { awaitImages } from './awaitImages';
import { ComumSheet } from './ComumSheet';

export interface PrintComumDialogProps {
  readonly opened: boolean;
  readonly pedidoIds: ReadonlyArray<string>;
  readonly onClose: () => void;
}

type Phase = 'building' | 'preparing' | 'ready' | 'printing' | 'done' | 'error';

export function PrintComumDialog({ opened, pedidoIds, onClose }: PrintComumDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const modelsRef = useRef<PedidoPrintModel[]>([]);
  const [phase, setPhase] = useState<Phase>('building');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [models, setModels] = useState<PedidoPrintModel[]>([]);
  const [failures, setFailures] = useState<ReadonlyArray<{ pedidoId: string; message: string }>>(
    [],
  );
  const [message, setMessage] = useState<string | null>(null);

  const handlePrint = useReactToPrint({
    contentRef,
    documentTitle: 'Pedidos',
    pageStyle: '@page { size: A4; margin: 10mm; }',
    onAfterPrint: () => {
      const ids = modelsRef.current.map((m) => m.pedidoId);
      if (ids.length > 0) {
        void markPedidosPrinted(getFirebaseFirestore(), ids, Date.now() * 1000).catch(
          () => undefined,
        );
      }
      setPhase('done');
    },
  });

  // Phase 1 — build models when the dialog opens.
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    // Reset + kick off the async build on open — the established open-a-modal
    // effect pattern (cf. EmitirLoteDialog). The advisory set-state-in-effect
    // rule is kept at 'warn' in eslint.config for exactly this; disabled locally
    // so the --max-warnings 0 pre-commit lint passes.
    /* eslint-disable react-hooks/set-state-in-effect */
    setPhase('building');
    setProgress({ done: 0, total: pedidoIds.length });
    setModels([]);
    setFailures([]);
    setMessage(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    modelsRef.current = [];

    buildModelsInWaves(
      getFirebaseFirestore(),
      pedidoIds,
      { withStock: true, withKits: true },
      (done, total) => {
        if (!cancelled) setProgress({ done, total });
      },
    ).then(
      (result) => {
        if (cancelled) return;
        setFailures(result.failures);
        if (result.models.length === 0) {
          setMessage('Nenhum pedido pôde ser carregado.');
          setPhase('error');
          return;
        }
        modelsRef.current = result.models;
        setModels(result.models);
        setPhase('preparing');
      },
      (e: unknown) => {
        if (cancelled) return;
        setMessage(e instanceof Error ? e.message : String(e));
        setPhase('error');
      },
    );

    return () => {
      cancelled = true;
    };
  }, [opened, pedidoIds]);

  // Phase 2 — once the sheets are mounted, preload their images.
  useEffect(() => {
    if (phase !== 'preparing') return;
    let cancelled = false;
    void awaitImages(contentRef.current).then(() => {
      if (!cancelled) setPhase('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const total = pedidoIds.length;
  const loaded = models.length;
  const closable = phase !== 'building' && phase !== 'preparing' && phase !== 'printing';

  return (
    <>
      <Modal
        opened={opened}
        onClose={() => {
          if (closable) onClose();
        }}
        title={`Imprimir ${total} pedido${total === 1 ? '' : 's'}`}
        closeOnEscape={closable}
        closeOnClickOutside={closable}
        withCloseButton={closable}
        centered
      >
        <Stack>
          {phase === 'building' && (
            <>
              <Text size="sm">
                Carregando pedidos… {progress.done}/{progress.total}
              </Text>
              <Progress value={total ? (progress.done / total) * 100 : 0} animated />
            </>
          )}

          {phase === 'preparing' && (
            <Group justify="center" gap="sm">
              <Loader size="sm" />
              <Text size="sm">Carregando imagens…</Text>
            </Group>
          )}

          {phase === 'ready' && (
            <>
              <Text size="sm">
                {loaded} pedido{loaded === 1 ? '' : 's'} pronto{loaded === 1 ? '' : 's'} para
                impressão.
              </Text>
              {failures.length > 0 && (
                <Alert color="yellow" variant="light">
                  {failures.length} pedido{failures.length === 1 ? '' : 's'} não pôde
                  {failures.length === 1 ? '' : 'ram'} ser carregado
                  {failures.length === 1 ? '' : 's'}.
                </Alert>
              )}
              <Group justify="flex-end">
                <Button variant="subtle" onClick={onClose}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    setPhase('printing');
                    handlePrint();
                  }}
                >
                  Imprimir
                </Button>
              </Group>
            </>
          )}

          {phase === 'printing' && (
            <Group justify="center" gap="sm">
              <Loader size="sm" />
              <Text size="sm">Abrindo a impressão…</Text>
            </Group>
          )}

          {phase === 'done' && (
            <>
              <Text size="sm">
                Impressão enviada. {loaded} pedido{loaded === 1 ? '' : 's'} marcado
                {loaded === 1 ? '' : 's'} como impresso{loaded === 1 ? '' : 's'}.
              </Text>
              <Group justify="flex-end">
                <Button onClick={onClose}>Fechar</Button>
              </Group>
            </>
          )}

          {phase === 'error' && (
            <>
              <Alert color="red" variant="light">
                {message ?? 'Falha ao preparar a impressão.'}
              </Alert>
              <Group justify="flex-end">
                <Button onClick={onClose}>Fechar</Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>

      {/* Off-screen print content — react-to-print clones this into an iframe. */}
      <div style={{ position: 'absolute', left: -100000, top: 0 }} aria-hidden>
        <div ref={contentRef}>
          {models.map((m, i) => (
            <div key={m.pedidoId} style={{ breakAfter: i < models.length - 1 ? 'page' : 'auto' }}>
              <ComumSheet model={m} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
