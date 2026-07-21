'use client';

/**
 * Bulk price recalculation (#544) — port of the Flutter
 * `alterarPrecoMassa2.dart` / `recalcularPrecos.dart` screens. Streams every
 * parent produto, recomputes its price against the target lista de preços'
 * fórmulas (pure `computeRecalculoRow`), shows the results, and applies the
 * change with one of three modes (`aumentar` / `diminuir` / `aplicarTudo`).
 *
 * State is a single discriminated union rather than several booleans — only
 * one phase can ever be "active", so this rules out the impossible
 * combinations a flag-per-phase version would allow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Progress,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';

import { getFirebaseFirestore } from '@/lib/firebase/client';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { saveBlob } from '@/lib/nfe/saveBlob';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import {
  countParentProdutos,
  loadKitResolucao,
  pageParentProdutos,
  type ProdutoPrecoRow,
} from '@/lib/produtos/bulkPreco/loadCatalogo';
import {
  computeRecalculoRow,
  listaTemAlgumaFormula,
} from '@/lib/produtos/bulkPreco/computeRecalculo';
import {
  APLICAR_MODES,
  APLICAR_MODE_LABELS,
  deveAplicar,
  type AplicarMode,
} from '@/lib/produtos/bulkPreco/aplicarModes';
import { applyPrecoAlteracoes } from '@/lib/produtos/bulkPreco/applyPrecoAlteracoes';
import { buildPrecoAlteracoesCsv, precoCsvFilename } from '@/lib/produtos/bulkPreco/precoCsv';
import type { ApplyOutcome, ApplyProgress, PrecoAlteracao } from '@/lib/produtos/bulkPreco/types';
import { AlteracoesTable } from './AlteracoesTable';

/** Rows computed per synchronous slice before yielding back to the event loop
 * (`await new Promise(r => setTimeout(r, 0))`) — keeps the tab responsive over
 * a large catalog. The legacy chunk-of-5 doesn't apply here: it existed
 * because that version read each produto's cost/weight inline per item; this
 * port batches every read up front (`pageParentProdutos` + `loadKitResolucao`)
 * so the compute step is pure and CPU-bound, not I/O-bound — the 5-way budget
 * only still matters for the apply step's writes. */
const COMPUTE_SLICE_SIZE = 250;

type Fase =
  | { fase: 'selecionar' }
  | { fase: 'calculando'; carregados: number; total: number | null }
  | { fase: 'pronto'; rows: PrecoAlteracao[]; ok: number; comErro: number }
  | { fase: 'aplicando'; progress: ApplyProgress }
  | { fase: 'concluido'; rows: PrecoAlteracao[]; outcomes: ApplyOutcome[]; comErro: number };

function isAbort(err: unknown): err is DOMException {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function RecalcularPrecosScreen() {
  const db = useMemo(() => getFirebaseFirestore(), []);
  const searchParams = useSearchParams();
  const listaIdParam = searchParams.get('listaId');

  // SERVER-side `ativo == true` filter (legacy `ativo__isEqualTo(true)`
  // parity): filtering client-side AFTER `limit(200)` could silently hide
  // active listas whose nome sorts past 200 inactive ones. Enterprise
  // Firestore runs the unindexed equality as a scan (tiny collection).
  const listasQuery = useMemo(
    () =>
      buildQuery(listaDePrecosCollection.ref(db, {}), [
        whereEqual('ativo', true),
        orderByField('nome'),
        limit(200),
      ]),
    [db],
  );
  const listasSnap = useSnapshot(listasQuery);
  const listasAtivas = useMemo(() => listasSnap.data ?? [], [listasSnap.data]);
  const selectData = useMemo(
    () => listasAtivas.map((r) => ({ value: r.id, label: r.data.nome })),
    [listasAtivas],
  );

  const [listaId, setListaId] = useState<string | null>(null);
  const [paramInvalido, setParamInvalido] = useState(false);
  const [mode, setMode] = useState<AplicarMode>('aplicarTudo');
  // Blast-radius guardrail (owner decision, 2026-07-21): Aplicar sweeps the
  // WHOLE parent catalog, so it always confirms the will-apply count first.
  const [confirmandoAplicar, setConfirmandoAplicar] = useState(false);
  const [fase, setFase] = useState<Fase>({ fase: 'selecionar' });
  const abortRef = useRef<AbortController | null>(null);

  // Apply the `?listaId=` deep-link preselect exactly once, the first time the
  // listas snapshot resolves to SERVER truth — never again, so a later manual
  // pick in the Select can't be clobbered by a subsequent re-emission of the
  // same snapshot. Gating on `loading` alone is wrong: with the IndexedDB
  // persistent cache, `useSnapshot` resolves `loading: false` on the FIRST
  // emission, which is `fromCache: true` — on a cold/stale cache that snapshot
  // may not yet contain the target lista (or may still show one deactivated
  // on the server), so we'd wrongly flag `paramInvalido` and then never get a
  // second chance to correct it once `appliedParamRef` is set. Wait for
  // `fromCache === false` instead (same rule as ObjectView.tsx re-seeding from
  // server truth) so the preselect is validated against authoritative data.
  const appliedParamRef = useRef(false);
  useEffect(() => {
    if (appliedParamRef.current || !listaIdParam || listasSnap.fromCache !== false) return;
    appliedParamRef.current = true;
    const match = listasAtivas.find((r) => r.id === listaIdParam);
    if (match) setListaId(listaIdParam);
    else setParamInvalido(true);
  }, [listaIdParam, listasSnap.fromCache, listasAtivas]);

  const selectedLista = useMemo(
    () => listasAtivas.find((r) => r.id === listaId)?.data ?? null,
    [listasAtivas, listaId],
  );
  const semFormulas = selectedLista !== null && !listaTemAlgumaFormula(selectedLista);
  const podeCalcular = fase.fase === 'selecionar' && listaId !== null && !semFormulas;

  const handleCalcular = useCallback(async () => {
    if (!listaId || !selectedLista) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setFase({ fase: 'calculando', carregados: 0, total: null });

    try {
      const total = await countParentProdutos(db);
      setFase({ fase: 'calculando', carregados: 0, total });

      const allRows: ProdutoPrecoRow[] = [];
      for await (const page of pageParentProdutos(db, { signal: controller.signal })) {
        allRows.push(...page);
        setFase({ fase: 'calculando', carregados: allRows.length, total });
      }

      const kitResolucao = await loadKitResolucao(db, allRows);

      const computed: PrecoAlteracao[] = [];
      for (let i = 0; i < allRows.length; i += COMPUTE_SLICE_SIZE) {
        if (controller.signal.aborted) {
          throw new DOMException('Cálculo cancelado', 'AbortError');
        }
        for (const row of allRows.slice(i, i + COMPUTE_SLICE_SIZE)) {
          computed.push(computeRecalculoRow(row, kitResolucao, listaId, selectedLista));
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const comErro = computed.filter((r) => r.erro !== null).length;
      setFase({ fase: 'pronto', rows: computed, ok: computed.length - comErro, comErro });
    } catch (err) {
      if (isAbort(err)) {
        setFase({ fase: 'selecionar' });
        return;
      }
      if (err instanceof FirebaseError) {
        showErrorNotification({
          title: 'Falha ao carregar catálogo',
          message: `${err.code} — ${err.message}`,
        });
        setFase({ fase: 'selecionar' });
        return;
      }
      throw err;
    }
  }, [db, listaId, selectedLista]);

  const handleBaixarCsv = useCallback(
    (rows: readonly PrecoAlteracao[]) => {
      saveBlob(
        new Blob([buildPrecoAlteracoesCsv(rows)], { type: 'text/csv;charset=utf-8' }),
        precoCsvFilename(selectedLista?.nome ?? 'lista', new Date()),
      );
    },
    [selectedLista],
  );

  const handleAplicar = useCallback(
    async (rows: PrecoAlteracao[], comErro: number) => {
      if (!listaId) return;
      const controller = new AbortController();
      abortRef.current = controller;

      // Legacy parity: the relatório CSV is saved the moment "Aplicar" is
      // pressed — before any write — not only via the manual download button.
      handleBaixarCsv(rows);

      const applyRows = rows
        .filter(
          (r): r is PrecoAlteracao & { precoNovo: number } =>
            r.erro === null && r.precoNovo !== null,
        )
        .map((r) => ({ produtoId: r.produtoId, novoValor: r.precoNovo }));

      setFase({
        fase: 'aplicando',
        progress: { done: 0, total: applyRows.length, sucesso: 0, erro: 0 },
      });

      try {
        const outcomes = await applyPrecoAlteracoes(db, {
          targetListaId: listaId,
          rows: applyRows,
          gate: (precoAtualFresco, novo) => deveAplicar(mode, precoAtualFresco, novo),
          onProgress: (progress) => setFase({ fase: 'aplicando', progress }),
          signal: controller.signal,
        });
        setFase({ fase: 'concluido', rows, outcomes, comErro });
      } catch (err) {
        if (err instanceof FirebaseError) {
          showErrorNotification({
            title: 'Falha ao aplicar preços',
            message: `${err.code} — ${err.message}`,
          });
          setFase({ fase: 'pronto', rows, ok: rows.length - comErro, comErro });
          return;
        }
        throw err;
      }
    },
    [db, listaId, mode, handleBaixarCsv],
  );

  const handleReset = useCallback(() => {
    setFase({ fase: 'selecionar' });
    setListaId(null);
    setParamInvalido(false);
    setMode('aplicarTudo');
  }, []);

  const pctCalculando =
    fase.fase === 'calculando' && fase.total && fase.total > 0
      ? (fase.carregados / fase.total) * 100
      : 0;
  const pctAplicando =
    fase.fase === 'aplicando' && fase.progress.total > 0
      ? (fase.progress.done / fase.progress.total) * 100
      : 0;

  const aplicarCount =
    fase.fase === 'pronto'
      ? fase.rows.filter(
          (r) =>
            r.erro === null && r.precoNovo !== null && deveAplicar(mode, r.precoAtual, r.precoNovo),
        ).length
      : 0;

  return (
    <Stack>
      <Paper withBorder p="md" radius="md">
        <Stack>
          <Select
            label="Lista de preços"
            placeholder={listasSnap.loading ? 'Carregando…' : 'Selecione uma lista de preços'}
            data={selectData}
            value={listaId}
            onChange={(value) => {
              setListaId(value);
              setParamInvalido(false);
            }}
            disabled={fase.fase !== 'selecionar' || listasSnap.loading}
            searchable
            clearable
          />

          {listasSnap.error && (
            <Alert color="red" title="Erro ao carregar listas de preços">
              {listasSnap.error.message}
            </Alert>
          )}

          {paramInvalido && <Alert color="red">Lista de preços inválida ou inativa</Alert>}

          {semFormulas && listaId && (
            <Alert color="yellow" title="Sem fórmulas de cálculo">
              Esta lista não tem fórmulas de cálculo.{' '}
              <Anchor component={Link} href={`/listas-de-precos/${listaId}`}>
                Edite a lista primeiro.
              </Anchor>
            </Alert>
          )}

          {fase.fase === 'selecionar' && (
            <Group justify="flex-end">
              <Button onClick={handleCalcular} disabled={!podeCalcular}>
                Calcular
              </Button>
            </Group>
          )}

          {fase.fase === 'calculando' && (
            <Stack gap={4}>
              <Progress value={pctCalculando} animated />
              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  {fase.carregados}
                  {fase.total != null ? ` / ${fase.total}` : ''} produto(s) carregado(s)…
                </Text>
                <Button variant="subtle" color="red" onClick={() => abortRef.current?.abort()}>
                  Cancelar
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Paper>

      {fase.fase === 'pronto' && (
        <Paper withBorder p="md" radius="md">
          <Stack>
            <Group justify="space-between">
              <Group gap="xs">
                <Badge color="teal" variant="light">
                  {fase.ok} produto(s)
                </Badge>
                <Badge color="red" variant="light">
                  {fase.comErro} com erro
                </Badge>
              </Group>
              <Button
                variant="default"
                leftSection={<IconDownload size={16} />}
                onClick={() => handleBaixarCsv(fase.rows)}
              >
                Baixar CSV
              </Button>
            </Group>

            <AlteracoesTable rows={fase.rows} />

            <Group justify="space-between" align="flex-end" wrap="wrap">
              <Select
                label="Modo de aplicação"
                data={APLICAR_MODES.map((m) => ({ value: m, label: APLICAR_MODE_LABELS[m] }))}
                value={mode}
                onChange={(value) => value && setMode(value as AplicarMode)}
                allowDeselect={false}
              />
              <Text size="sm" c="dimmed">
                {aplicarCount} produto(s) serão atualizados
              </Text>
              <Group>
                <Button variant="default" onClick={() => setFase({ fase: 'selecionar' })}>
                  Voltar
                </Button>
                <Button onClick={() => setConfirmandoAplicar(true)} disabled={aplicarCount === 0}>
                  Aplicar
                </Button>
              </Group>
            </Group>
          </Stack>

          <Modal
            opened={confirmandoAplicar}
            onClose={() => setConfirmandoAplicar(false)}
            title="Confirmar aplicação"
            centered
          >
            <Stack>
              <Text size="sm">
                Aplicar novos preços em <strong>{aplicarCount}</strong> produto(s) na lista{' '}
                <strong>{selectedLista?.nome ?? ''}</strong> (
                {APLICAR_MODE_LABELS[mode].toLowerCase()})? Esta ação altera o catálogo inteiro
                conforme o modo selecionado e não pode ser desfeita em lote.
              </Text>
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setConfirmandoAplicar(false)}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    setConfirmandoAplicar(false);
                    void handleAplicar(fase.rows, fase.comErro);
                  }}
                >
                  Confirmar
                </Button>
              </Group>
            </Stack>
          </Modal>
        </Paper>
      )}

      {fase.fase === 'aplicando' && (
        <Paper withBorder p="md" radius="md">
          <Stack gap={4}>
            <Progress value={pctAplicando} animated />
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
        </Paper>
      )}

      {fase.fase === 'concluido' && (
        <ConcluidoPanel fase={fase} onReset={handleReset} onBaixarCsv={handleBaixarCsv} />
      )}
    </Stack>
  );
}

interface ConcluidoPanelProps {
  fase: Extract<Fase, { fase: 'concluido' }>;
  onReset: () => void;
  onBaixarCsv: (rows: readonly PrecoAlteracao[]) => void;
}

/** Extracted so the outcome-tallying stays out of the main render body — the
 * only phase whose summary needs a reduce over `outcomes`. */
function ConcluidoPanel({ fase, onReset, onBaixarCsv }: ConcluidoPanelProps) {
  const aplicados = fase.outcomes.filter((o) => o.status === 'aplicado').length;
  const semAlteracao = fase.outcomes.filter((o) => o.status === 'semAlteracao').length;
  const pulados = fase.outcomes.filter((o) => o.status === 'pulado').length;
  const errosEscrita = fase.outcomes.filter((o) => o.status === 'erro');

  return (
    <Paper withBorder p="md" radius="md">
      <Stack>
        <Text fw={600}>Recálculo concluído</Text>
        <Group gap="xs">
          <Badge color="teal" variant="light">
            {aplicados} aplicado(s)
          </Badge>
          <Badge color="gray" variant="light">
            {semAlteracao} sem alteração
          </Badge>
          <Badge color="yellow" variant="light">
            {pulados} pulado(s) pelo modo
          </Badge>
          <Badge color="red" variant="light">
            {fase.comErro} erro(s) de cálculo
          </Badge>
          <Badge color="red" variant="light">
            {errosEscrita.length} erro(s) de escrita
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
            onClick={() => onBaixarCsv(fase.rows)}
          >
            Baixar CSV novamente
          </Button>
          <Button onClick={onReset}>Recalcular outra lista</Button>
        </Group>
      </Stack>
    </Paper>
  );
}
