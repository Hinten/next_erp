'use client';

/**
 * Apply confirmation + progress dialog for the bulk manual price editor
 * (#545) — port of the legacy `recalcularPrecosDialog`/`aplicarNaDatabase`
 * (`.old/lib/produtos/pages/alterarPrecoMassa.dart:195-378`).
 *
 * Rows are partitioned BEFORE anything is sent to `applyPrecoAlteracoes`:
 * calc-time errors and bounds-skipped rows never reach the direction gate or
 * the write step (the legacy null-deref bug at L214/218 this port avoids —
 * see `strategies.ts`'s `buildPreviewRows` doc). The direction gate itself
 * (`passaDirecao`) is re-checked against the FRESH price at write time via
 * `applyPrecoAlteracoes`'s `gate` — the count shown in the confirm step is a
 * preview computed from the (possibly stale) preview rows, not a guarantee.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Group, Modal, Progress, Stack, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';

import { saveBlob } from '@/lib/nfe/saveBlob';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import { applyPrecoAlteracoes } from '@/lib/produtos/bulkPreco/applyPrecoAlteracoes';
import { passaDirecao } from '@/lib/produtos/bulkPreco/strategies';
import type { ApplyOutcome, ApplyProgress, PrecoAlteracao } from '@/lib/produtos/bulkPreco/types';
import { alterarPrecoCsvFilename, buildAlterarPrecoCsv } from './alterarPrecoCsv';

export interface AplicarDialogProps {
  opened: boolean;
  onClose: () => void;
  db: Firestore;
  targetListaId: string;
  listaNome: string;
  /** Full preview rows — including calc-erro/foraDosLimites ones, so the
   * post-apply CSV can still report on every selected produto. */
  rows: PrecoAlteracao[];
  aumentar: boolean;
  baixar: boolean;
  /** Called once the apply step finishes (any outcome) — lets the page reset
   * the selection. Not called on a pre-write (FirebaseError) failure. */
  onApplied?: () => void;
}

type Fase =
  | { fase: 'confirmar' }
  | { fase: 'aplicando'; progress: ApplyProgress }
  | { fase: 'concluido'; outcomes: ApplyOutcome[] };

type CandidateRow = PrecoAlteracao & { precoNovo: number };

function isCandidateRow(row: PrecoAlteracao): row is CandidateRow {
  return row.erro === null && row.foraDosLimites !== true && row.precoNovo !== null;
}

export function AplicarDialog({
  opened,
  onClose,
  db,
  targetListaId,
  listaNome,
  rows,
  aumentar,
  baixar,
  onApplied,
}: AplicarDialogProps) {
  const [fase, setFase] = useState<Fase>({ fase: 'confirmar' });
  const abortRef = useRef<AbortController | null>(null);
  // Frozen the instant `handleConfirmar` starts writing — `rows` is a LIVE
  // prop derived from the page's selection, and `onApplied` (invoked right
  // after `applyPrecoAlteracoes` resolves) clears that selection in the SAME
  // React batch as the 'concluido' transition (React's automatic batching
  // spans a promise continuation). Without this snapshot, `errorRows`/
  // `foraRows` below — and the post-apply CSV — would deterministically
  // recompute off an already-emptied `rows` array the instant the summary
  // renders, always reporting 0 regardless of what was actually skipped.
  const [snapshot, setSnapshot] = useState<{
    rows: PrecoAlteracao[];
    errosCalculo: number;
    foraDosLimites: number;
  } | null>(null);

  // Fresh confirm state every time the dialog (re)opens for a new run.
  useEffect(() => {
    if (opened) {
      setFase({ fase: 'confirmar' });
      setSnapshot(null);
    }
  }, [opened]);

  const errorRows = useMemo(() => rows.filter((r) => r.erro !== null), [rows]);
  const foraRows = useMemo(
    () => rows.filter((r) => r.erro === null && r.foraDosLimites === true),
    [rows],
  );
  const candidateRows = useMemo(() => rows.filter(isCandidateRow), [rows]);
  const passaCount = useMemo(
    () =>
      candidateRows.filter((r) => passaDirecao(r.precoAtual, r.precoNovo, { aumentar, baixar }))
        .length,
    [candidateRows, aumentar, baixar],
  );

  const handleConfirmar = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    // Snapshot BEFORE the write — see the `snapshot` state doc above.
    const rowsSnapshot = rows;
    const errosCalculoSnapshot = errorRows.length;
    const foraDosLimitesSnapshot = foraRows.length;
    setFase({
      fase: 'aplicando',
      progress: { done: 0, total: candidateRows.length, sucesso: 0, erro: 0 },
    });

    try {
      const outcomes = await applyPrecoAlteracoes(db, {
        targetListaId,
        rows: candidateRows.map((r) => ({ produtoId: r.produtoId, novoValor: r.precoNovo })),
        gate: (fresh, novo) => passaDirecao(fresh, novo, { aumentar, baixar }),
        onProgress: (progress) => setFase({ fase: 'aplicando', progress }),
        signal: controller.signal,
      });
      setSnapshot({
        rows: rowsSnapshot,
        errosCalculo: errosCalculoSnapshot,
        foraDosLimites: foraDosLimitesSnapshot,
      });
      setFase({ fase: 'concluido', outcomes });
      onApplied?.();
    } catch (err) {
      if (err instanceof FirebaseError) {
        showErrorNotification({
          title: 'Falha ao aplicar preços',
          message: `${err.code} — ${err.message}`,
        });
        setFase({ fase: 'confirmar' });
        return;
      }
      throw err;
    }
  }, [db, targetListaId, candidateRows, rows, errorRows, foraRows, aumentar, baixar, onApplied]);

  const handleBaixarRelatorio = useCallback(
    (opts?: { outcomes?: ApplyOutcome[]; rowsOverride?: PrecoAlteracao[] }) => {
      const outcomeMap = opts?.outcomes
        ? new Map(opts.outcomes.map((o) => [o.produtoId, o]))
        : undefined;
      saveBlob(
        new Blob([buildAlterarPrecoCsv(opts?.rowsOverride ?? rows, outcomeMap)], {
          type: 'text/csv;charset=utf-8',
        }),
        alterarPrecoCsvFilename(listaNome, new Date()),
      );
    },
    [rows, listaNome],
  );

  const emAndamento = fase.fase === 'aplicando';
  const pct =
    fase.fase === 'aplicando' && fase.progress.total > 0
      ? (fase.progress.done / fase.progress.total) * 100
      : 0;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Aplicar alteração de preços"
      closeOnClickOutside={!emAndamento}
      closeOnEscape={!emAndamento}
      withCloseButton={!emAndamento}
      centered
    >
      {fase.fase === 'confirmar' && (
        <Stack>
          <Text>Aplicar alteração de preços em {candidateRows.length} produtos?</Text>
          <Text size="sm" c="dimmed">
            {passaCount} produto(s) serão efetivamente alterados pela direção escolhida (checagem
            final feita com o preço atualizado no momento da gravação).
            {errorRows.length + foraRows.length > 0 &&
              ` ${errorRows.length + foraRows.length} produto(s) serão ignorados (erro ou fora dos limites).`}
          </Text>
          <Group justify="space-between">
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              onClick={() => handleBaixarRelatorio()}
            >
              Baixar Relatório
            </Button>
            <Group>
              <Button variant="default" onClick={onClose}>
                Cancelar
              </Button>
              <Button onClick={() => void handleConfirmar()} disabled={candidateRows.length === 0}>
                Aplicar
              </Button>
            </Group>
          </Group>
        </Stack>
      )}

      {fase.fase === 'aplicando' && (
        <Stack gap="xs">
          <Progress value={pct} animated />
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {fase.progress.done} / {fase.progress.total} — {fase.progress.sucesso} aplicado(s),{' '}
              {fase.progress.erro} erro(s)
            </Text>
            <Button variant="subtle" color="red" onClick={() => abortRef.current?.abort()}>
              Cancelar
            </Button>
          </Group>
        </Stack>
      )}

      {fase.fase === 'concluido' && (
        <ConcluidoSummary
          outcomes={fase.outcomes}
          errosCalculo={snapshot?.errosCalculo ?? 0}
          foraDosLimites={snapshot?.foraDosLimites ?? 0}
          onBaixarRelatorio={() =>
            handleBaixarRelatorio({ outcomes: fase.outcomes, rowsOverride: snapshot?.rows })
          }
          onFechar={onClose}
        />
      )}
    </Modal>
  );
}

interface ConcluidoSummaryProps {
  outcomes: ApplyOutcome[];
  errosCalculo: number;
  foraDosLimites: number;
  onBaixarRelatorio: () => void;
  onFechar: () => void;
}

function ConcluidoSummary({
  outcomes,
  errosCalculo,
  foraDosLimites,
  onBaixarRelatorio,
  onFechar,
}: ConcluidoSummaryProps) {
  const aplicados = outcomes.filter((o) => o.status === 'aplicado').length;
  const semAlteracao = outcomes.filter((o) => o.status === 'semAlteracao').length;
  const pulados = outcomes.filter((o) => o.status === 'pulado').length;
  const errosEscrita = outcomes.filter((o) => o.status === 'erro');
  // Every selected produto lands in exactly one bucket: written OK, left
  // alone, skipped by direction, skipped by bounds, or errored (at either
  // calc time or write time) — the "Erros" total below combines both.
  const totalErros = errosCalculo + errosEscrita.length;

  return (
    <Stack>
      <Text fw={600}>Alteração de preços concluída</Text>
      <Group gap="xs">
        <Badge color="teal" variant="light">
          {aplicados} aplicado(s)
        </Badge>
        <Badge color="gray" variant="light">
          {semAlteracao} sem alteração
        </Badge>
        <Badge color="yellow" variant="light">
          {pulados} pulado(s)
        </Badge>
        <Badge color="yellow" variant="light">
          {foraDosLimites} fora dos limites
        </Badge>
        <Badge color="red" variant="light">
          {totalErros} erro(s)
        </Badge>
      </Group>

      {errosEscrita.length > 0 && (
        <Stack gap={2}>
          {errosEscrita.slice(0, 10).map((o) => (
            <Text key={o.produtoId} size="xs" c="red">
              {o.produtoId}: {o.erro}
            </Text>
          ))}
          {errosEscrita.length > 10 && (
            <Text size="xs" c="dimmed">
              … e mais {errosEscrita.length - 10} erro(s).
            </Text>
          )}
        </Stack>
      )}

      <Group justify="space-between">
        <Button
          variant="default"
          leftSection={<IconDownload size={16} />}
          onClick={onBaixarRelatorio}
        >
          Baixar Relatório
        </Button>
        <Button onClick={onFechar}>Fechar</Button>
      </Group>
    </Stack>
  );
}
