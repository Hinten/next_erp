'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import Link from 'next/link';
import type { Firestore } from 'firebase/firestore';
import { Alert, Anchor, Badge, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { valuesEqual } from '@delfrance/core';
import { notifications } from '@mantine/notifications';
import { useFormContext, type FieldValues } from 'react-hook-form';
import { PERM } from '@delfrance/auth';
import {
  INTEGRACAO_TIPO,
  type MlSizeChart,
  TIPO_VARIACAO,
  mlSizeChartsForConta,
  mlSizeChartSchema,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import { AfterSaveBlockedError, useSectionActive } from '@delfrance/ui';

import { buildMedidasFatos } from '@/lib/mercado-livre/medidasFatos';

import { useConfirmDialog } from '@/app/(app)/pedidos/_components/ConfirmDialog';
import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import {
  SizeChartConflictError,
  SizeChartSyncUnconfirmedError,
} from '@/lib/mercado-livre/chartConflict';
import {
  removeChartDraftsTransaction,
  saveChartTransaction,
  type ChartDraftRemoval,
  type SavedChart,
} from '@/lib/mercado-livre/chartPersistence';
import {
  SIZE_CHART_MOTIVOS,
  type SizeChartGateInput,
  sizeChartGate,
} from '@/lib/mercado-livre/sizeChartDisabled';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreChartValidationError,
  type MercadoLivreClient,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { SizeChartActionButton } from './SizeChartActionButton';
import { SizeChartEditorModal, type SizeGroupOption } from './SizeChartEditorModal';

const MAX_CONTAS = 50;
const MAX_GRUPOS = 200;

interface MedidasMercadoLivreManagerProps {
  tabMediId: string;
  db: Firestore;
  disabled?: boolean;
  flushRef?: RefObject<(() => Promise<void>) | null>;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Open lazily, then keep listeners and the flush registration across tab switches. */
export function MedidasMercadoLivreManager(props: MedidasMercadoLivreManagerProps) {
  const active = useSectionActive();
  const [visited, setVisited] = useState(active !== false);
  useEffect(() => {
    // The one-way activation latch avoids reading an unvisited persistent section.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (active !== false) setVisited(true);
  }, [active]);
  return visited ? <MedidasMercadoLivreManagerContents {...props} /> : null;
}

/** Which guia the editor is open on. `chartIndex: null` ⇒ a brand-new one. */
interface EditorTarget {
  /**
   * Bumped once per open, and the modal's React `key`.
   *
   * ⚠️ The key deliberately does NOT include `chartIndex`: a brand-new guia
   * gains an index the moment it is first persisted, and keying on that would
   * remount the modal mid-session — throwing away the operator's typing and the
   * very validation errors they reopened it to fix.
   */
  session: number;
  integracaoId: string;
  chart: MlSizeChart | null;
  chartIndex: number | null;
  /** A prior send failed without an acknowledged remote version. */
  syncUnconfirmed: boolean;
}

/**
 * The medidas editor's **Mercado Livre** tab: one card per connected ML account
 * listing the guias de tamanho stored for this tabela, each opening the
 * full-screen editor.
 *
 * Guias live on the tabMedi doc's `tabelasDeMedidasMercadoLivre[<conta>]` map.
 * Local saves update only this conta's chart list in a guarded transaction,
 * preserving the other contas and legacy fields from the migrated corpus.
 * Shopee entries live on the SIBLING field `tabelasMedidasShopee`, which the
 * transaction never touches.
 *
 * ⚠️ Unsent guias are PERSISTED as drafts (`id: null`) rather than held in React
 * state. A 75-row × 10-column grid is far too much work to lose to a reload,
 * and a draft is inert everywhere else: `resolveSizeChart` only ever considers
 * charts that carry an ML id.
 */
function MedidasMercadoLivreManagerContents({
  tabMediId,
  db,
  disabled,
  flushRef,
  onDirtyChange,
}: MedidasMercadoLivreManagerProps) {
  const client = useMercadoLivreClient();
  // Backend gates: read for domains/specs, write for sync.
  const { allowed: canRead, loading: permsLoading } = usePermission(PERM.integracao.read);
  const { allowed: canWrite } = usePermission(PERM.integracao.write);

  /**
   * The tabela's own fields as the FORM currently has them.
   *
   * ⚠️ This tab is a custom `renderInput` inside `ObjectView`, so the operator's
   * unsaved edits live in the form, not on the document. The AI agent used to
   * read only the stored copy, which meant a descrição just typed — and, worse, a
   * photo just uploaded — were invisible to it: the model was handed an empty
   * record and duly reported it had nothing to read.
   *
   * A GETTER, not a subscription: `getValues` is read at click time, so typing in
   * any field does not re-render this tab. `ObjectView` wraps everything in a
   * `FormProvider` for exactly this (`VariationManager` reads the parent's
   * unsaved `sku` the same way).
   */
  const form = useFormContext<FieldValues>();
  const getFatos = useCallback(() => buildMedidasFatos(form.getValues()), [form]);

  // Gate the integração read on `canRead`: the collection is
  // PERM.integracao.read-protected, so a produto-only editor (tabMedi uses
  // produto perms) without that bit would otherwise hit a raw Firestore
  // permission-denied. Null query → the snapshot stays idle, and we render a
  // clear message below instead.
  const contasQuery = useMemo(
    () =>
      canRead
        ? buildQuery(integracaoCollection.ref(db, {}), [
            whereEqual('tipo', INTEGRACAO_TIPO.mercadoLivre),
            limit(MAX_CONTAS),
          ])
        : null,
    [db, canRead],
  );
  const contasSnap = useSnapshot(contasQuery);
  const contas = contasSnap.data ?? [];

  // Live tabMedi doc → the charts stored per conta.
  const docRef = useMemo(
    () => tabelaDeMedidasCollection.docRef(db, {}, tabMediId),
    [db, tabMediId],
  );
  const docSnap = useDocSnapshot(docRef);
  const chartsMap = docSnap.data?.data.tabelasDeMedidasMercadoLivre ?? null;

  // Size groups (tipo 1) — a new chart's rows bind to one.
  const gruposQuery = useMemo(
    () =>
      buildQuery(grupoDeVariacoesCollection.ref(db, {}), [
        whereEqual('tipo', TIPO_VARIACAO.tamanho),
        orderByField('nome'),
        limit(MAX_GRUPOS),
      ]),
    [db],
  );
  const gruposSnap = useSnapshot(gruposQuery);
  const grupos: SizeGroupOption[] = useMemo(
    () =>
      (gruposSnap.data ?? []).map((g) => ({
        grupoId: g.id,
        nome: g.data.nome,
        variantes: (g.data.variacoes ?? []).map((v) => ({ id: v.id, nome: v.nome })),
      })),
    [gruposSnap.data],
  );

  const [target, setTarget] = useState<EditorTarget | null>(null);
  const [recoveryChartId, setRecoveryChartId] = useState('');
  /**
   * `'<contaId>#<index>'` while that guia's delete/verify call is in flight —
   * it says which row shows the spinner.
   *
   * The controls serialize operations in this tab. This is a UI lock only;
   * chart saves separately use a transaction to guard against other writers.
   * Staged draft removals use a separate transaction on the parent Save action.
   */
  const [busyChart, setBusyChart] = useState<string | null>(null);
  const { confirm, element: confirmElement } = useConfirmDialog();
  const sessionRef = useRef(0);
  const [removals, setRemovals] = useState<ChartDraftRemoval[]>([]);
  const removalsRef = useRef<ChartDraftRemoval[]>([]);
  const [removalSaving, setRemovalSaving] = useState(false);
  const removalSavingRef = useRef(false);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [committedLists, setCommittedLists] = useState<{
    snapshot: typeof chartsMap;
    lists: Record<string, MlSizeChart[]>;
  } | null>(null);
  const listSaving = removalSaving || form.formState.isSubmitting;

  const replaceRemovals = useCallback((next: ChartDraftRemoval[]) => {
    removalsRef.current = next;
    setRemovals(next);
  }, []);

  useEffect(() => {
    onDirtyChange?.(removals.length > 0);
  }, [onDirtyChange, removals.length]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const flushRemovals = useCallback(async () => {
    const pending = removalsRef.current;
    if (pending.length === 0) return;
    const gate = sizeChartGate('excluir', {
      readOnly: Boolean(disabled),
      hasClient: client != null,
      canWrite,
      hasGrupos: true,
      busy: busyChart !== null || removalSavingRef.current ? 'outraGuia' : 'none',
      enviada: false,
    });
    if (gate.disabled) throw new AfterSaveBlockedError(gate.motivo!);
    removalSavingRef.current = true;
    setRemovalSaving(true);
    setRemovalError(null);
    try {
      const lists = await removeChartDraftsTransaction({ db, tabMediId, removals: pending });
      setCommittedLists({ snapshot: chartsMap, lists });
      replaceRemovals([]);
    } catch (err) {
      if (!(err instanceof SizeChartConflictError)) throw err;
      const message =
        'Os rascunhos não foram excluídos porque a lista de guias mudou. ' +
        'Desfaça as exclusões pendentes, revise as guias atuais e marque novamente. ' +
        'Alterações já salvas na tabela foram mantidas.';
      setRemovalError(message);
      throw new AfterSaveBlockedError(message);
    } finally {
      removalSavingRef.current = false;
      setRemovalSaving(false);
    }
  }, [busyChart, canWrite, chartsMap, client, db, disabled, replaceRemovals, tabMediId]);

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flushRemovals;
    return () => {
      if (flushRef.current === flushRemovals) flushRef.current = null;
    };
  }, [flushRef, flushRemovals]);

  function undoRemoval(removal: ChartDraftRemoval): void {
    if (listSaving) return;
    const next = removalsRef.current.filter((pending) => pending !== removal);
    replaceRemovals(next);
    if (next.length === 0) setRemovalError(null);
  }

  function listGate(action: Parameters<typeof sizeChartGate>[0], input: SizeChartGateInput) {
    if (listSaving) return { disabled: true, motivo: 'Salvando as alterações da tabela…' };
    return sizeChartGate(action, input);
  }

  function openEditor(next: Omit<EditorTarget, 'session' | 'syncUnconfirmed'>): void {
    setRecoveryChartId('');
    sessionRef.current += 1;
    setTarget({ ...next, session: sessionRef.current, syncUnconfirmed: false });
  }

  /** Advance only this editor session, after its own confirmed write. */
  function acceptChart(editor: EditorTarget, saved: SavedChart, confirmedSync = false): void {
    setTarget((previous) =>
      previous?.session === editor.session
        ? {
            ...previous,
            chartIndex: saved.index,
            chart: saved.chart,
            syncUnconfirmed: confirmedSync ? false : previous.syncUnconfirmed,
          }
        : previous,
    );
  }

  function markSyncUnconfirmed(editor: EditorTarget): void {
    setTarget((previous) =>
      previous?.session === editor.session ? { ...previous, syncUnconfirmed: true } : previous,
    );
  }

  /** Persist immediately, with the opened chart guarded inside the transaction. */
  async function saveChart(
    editor: EditorTarget,
    chart: MlSizeChart,
    chartIndex: number | null,
  ): Promise<SavedChart> {
    try {
      const saved = await saveChartTransaction({
        db,
        tabMediId,
        integracaoId: editor.integracaoId,
        chart,
        chartIndex,
        original: editor.chart,
      });
      acceptChart(editor, saved);
      return saved;
    } catch (err) {
      if (!(err instanceof SizeChartConflictError)) throw err;
      if (editor.syncUnconfirmed) throw new SizeChartSyncUnconfirmedError();
      throw err;
    }
  }

  /** Persist immediately, then send only this committed target outside the transaction. */
  async function sendChart(
    ready: MercadoLivreClient,
    editor: EditorTarget,
    chart: MlSizeChart,
    chartIndex: number | null,
  ): Promise<{
    validationErrors: MercadoLivreChartValidationError[];
    chartIndex: number;
    chart: MlSizeChart;
  }> {
    let saved: SavedChart | null = editor.syncUnconfirmed
      ? null
      : await saveChart(editor, chart, chartIndex);
    let operationId = crypto.randomUUID();
    let desired = chart;
    // Retrying after a lost response must discover the durable receipt BEFORE
    // saving a stale grid over its confirmed IDs. A normal send persists first,
    // including when the status endpoint is unreachable.
    let pending: Awaited<ReturnType<MercadoLivreClient['sizeChartSyncStatus']>>['operation'];
    try {
      pending = (await ready.sizeChartSyncStatus({ integracaoId: editor.integracaoId, tabMediId }))
        .operation;
    } catch (err) {
      if (
        !(
          err instanceof MercadoLivreClientHttpError ||
          err instanceof MercadoLivreClientNetworkError
        )
      )
        throw err;
      markSyncUnconfirmed(editor);
      throw err;
    }
    const sameTarget = pending != null && pending.chartIndex === (saved?.index ?? chartIndex);
    if (
      pending != null &&
      (pending.kind ?? 'sync') === 'sync' &&
      sameTarget &&
      (valuesEqual(chart, pending.chart) || valuesEqual(chart, pending.projected))
    ) {
      operationId = pending.operationId;
      desired = pending.chart;
      saved = { index: pending.chartIndex, chart: pending.projected, tabelas: [] };
    } else if (saved == null) {
      saved = await saveChart(editor, chart, chartIndex);
    }
    let result: Awaited<ReturnType<MercadoLivreClient['sizeChartSync']>>;
    try {
      result = await ready.sizeChartSync({
        integracaoId: editor.integracaoId,
        tabMediId,
        operationId,
        chartIndex: saved.index,
        chart: desired,
        recoveryChartId: recoveryChartId || null,
      });
    } catch (err) {
      if (
        !(
          err instanceof MercadoLivreClientHttpError ||
          err instanceof MercadoLivreClientNetworkError
        )
      ) {
        throw err;
      }
      markSyncUnconfirmed(editor);
      throw err;
    }
    if (
      result.operationId !== operationId ||
      result.chartIndex !== saved.index ||
      (result.status !== 'completed' && result.status !== 'validation')
    ) {
      markSyncUnconfirmed(editor);
      throw new SizeChartSyncUnconfirmedError();
    }
    const parsed = mlSizeChartSchema.safeParse(result.tabelas[saved.index]);
    if (
      !parsed.success ||
      parsed.data.nome !== desired.nome ||
      parsed.data.domain_id !== desired.domain_id ||
      (saved.chart.id != null && saved.chart.id !== '' && parsed.data.id !== saved.chart.id)
    ) {
      markSyncUnconfirmed(editor);
      throw new SizeChartSyncUnconfirmedError();
    }
    // Partial success can assign chart/row ids while the modal stays open.
    // Only this acknowledged response advances the baseline; live snapshots do not.
    acceptChart(editor, { ...saved, chart: parsed.data }, true);
    return {
      validationErrors: result.validationErrors,
      chartIndex: saved.index,
      chart: parsed.data,
    };
  }

  async function recoverChart(editor: EditorTarget, confirmNoCreation: boolean) {
    if (!client) throw new SizeChartSyncUnconfirmedError();
    const pending = (
      await client.sizeChartSyncStatus({ integracaoId: editor.integracaoId, tabMediId })
    ).operation;
    if (
      !pending ||
      pending.status === 'completed' ||
      pending.status === 'validation' ||
      pending.status === 'abandoned'
    ) {
      setTarget((previous) =>
        previous?.session === editor.session ? { ...previous, syncUnconfirmed: false } : previous,
      );
      return { chart: null, chartIndex: editor.chartIndex ?? 0 };
    }
    const result = await client.sizeChartRecover({
      integracaoId: editor.integracaoId,
      tabMediId,
      operationId: pending.operationId,
      expectedChart: pending.chartIndex === editor.chartIndex ? editor.chart : null,
      recoveryChartId: recoveryChartId || null,
      confirmNoCreation,
    });
    if (result.chart != null) {
      if (result.chartIndex !== editor.chartIndex) throw new SizeChartSyncUnconfirmedError();
      acceptChart(editor, { index: result.chartIndex, chart: result.chart, tabelas: [] }, true);
    } else {
      setTarget((previous) =>
        previous?.session === editor.session ? { ...previous, syncUnconfirmed: false } : previous,
      );
    }
    setRecoveryChartId('');
    return result;
  }

  /**
   * Remove one guia.
   *
   * A draft (no ML id) is staged until the parent Save — nothing on ML is removed.
   *
   * A sent guia goes through `DELETE /catalog/charts/{id}`, which is a REQUEST:
   * ML acks it and only then checks, over as much as 24h, that no listing still
   * links the chart, silently keeping it if one does. So the guia STAYS in the
   * list flagged "Exclusão solicitada" until **Verificar** confirms — the
   * confirmation copy says exactly that, because an operator who expects the row
   * to vanish would otherwise read the unchanged list as a failure.
   */
  async function removeChart(
    integracaoId: string,
    index: number,
    chart: MlSizeChart,
  ): Promise<void> {
    if (!client) return;
    const chartId = chart.id ?? '';
    const nome = chart.nome ?? 'esta guia';

    if (chartId === '') {
      if (listSaving) return;
      // A conflicted preview must be undone before the slot can be reviewed again.
      if (
        removalsRef.current.some((r) => r.integracaoId === integracaoId && r.chartIndex === index)
      )
        return;
      replaceRemovals([
        ...removalsRef.current,
        { integracaoId, chartIndex: index, original: structuredClone(chart) },
      ]);
      return;
    }

    const ok = await confirm({
      title: 'Excluir guia no Mercado Livre',
      message:
        `A guia "${nome}" só será excluída se não estiver vinculada a nenhum anúncio. ` +
        'O Mercado Livre leva até 24 horas para confirmar, e até lá ela continua nesta lista ' +
        'marcada como "Exclusão solicitada" — use "Verificar" para saber o resultado.',
      confirmLabel: 'Solicitar exclusão',
    });
    if (!ok) return;

    setBusyChart(`${integracaoId}#${String(index)}`);
    try {
      // A sent guia is keyed by its ML chart id server-side, so the backend
      // resolves it by identity rather than position — no index guard needed.
      await client.sizeChartExcluir({ integracaoId, tabMediId, chartId });
      notifications.show({
        color: 'blue',
        message: 'Exclusão solicitada. Use "Verificar" mais tarde para confirmar.',
      });
    } catch (err) {
      const shown = describeChartError(err);
      if (shown == null) throw err;
      notifications.show(shown);
    } finally {
      setBusyChart(null);
    }
  }

  /** Ask ML whether a requested deletion actually happened. */
  async function verifyDeletion(
    integracaoId: string,
    index: number,
    chart: MlSizeChart,
  ): Promise<void> {
    if (!client || chart.id == null || chart.id === '') return;
    setBusyChart(`${integracaoId}#${String(index)}`);
    try {
      const result = await client.sizeChartVerificarExclusao({
        integracaoId,
        tabMediId,
        chartId: chart.id,
      });
      notifications.show(
        result.removed
          ? { color: 'green', message: 'Guia excluída no Mercado Livre.' }
          : {
              color: 'yellow',
              message:
                'A guia ainda está vinculada a pelo menos um anúncio. Desvincule-a nos anúncios para que o Mercado Livre possa excluí-la.',
              autoClose: false,
            },
      );
    } catch (err) {
      const shown = describeChartError(err);
      if (shown == null) throw err;
      notifications.show(shown);
    } finally {
      setBusyChart(null);
    }
  }

  // ⚠️ The loading gate comes FIRST, and `permsLoading` belongs in it.
  // `usePermission` answers `allowed: false` WHILE the claims resolve, so with
  // the `!canRead` return ahead of this every ordinary page load flashed a
  // permission denial at an operator who has the bit — the same false-negative
  // `publishDisabled.ts` ranks `loading` first to avoid.
  //
  // It also means nothing below can be a loading artefact: by the time a button
  // renders the claims have settled, which is why `sizeChartGate` needs no
  // `loading` input at all.
  //
  // It cannot hang: `useSnapshot(null)` sets `loading: false` on its first
  // effect, and `useTenant` resolves `loading` on every path — so a reader
  // without the bit still reaches the message below, one render later.
  if (permsLoading || contasSnap.loading || docSnap.loading || gruposSnap.loading) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  }

  // No integração.read → the contas query is idle (never issued). Say so
  // instead of falling through to the misleading "no account" empty state.
  if (!canRead) {
    return (
      <Text size="sm" c="dimmed">
        Requer permissão de leitura em integrações para gerenciar as guias de tamanho.
      </Text>
    );
  }

  const snapshotError = contasSnap.error ?? docSnap.error ?? gruposSnap.error;
  if (snapshotError) {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar os dados do Mercado Livre: {snapshotError.message}
      </Alert>
    );
  }

  if (contas.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Nenhuma conta Mercado Livre cadastrada.{' '}
        <Anchor component={Link} href="/canais/mercado-livre" size="sm">
          Cadastrar em Canais de venda
        </Anchor>
        .
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        As guias de tamanho são vinculadas a um anúncio na publicação do produto (aba Mercado Livre
        do produto). Aqui você cria, edita e envia as guias por conta.
      </Text>

      {removalError && <Alert color="red">{removalError}</Alert>}
      {removals.length > 0 && (
        <Text size="sm" c="dimmed">
          As exclusões de rascunhos serão aplicadas ao salvar a tabela. Você pode desfazê-las antes.
        </Text>
      )}

      {contas.map((conta) => {
        const committed =
          committedLists?.snapshot === chartsMap ? committedLists.lists[conta.id] : undefined;
        const stored = committed
          ? mlSizeChartsForConta({ [conta.id]: { tabelas: committed } }, conta.id)
          : mlSizeChartsForConta(chartsMap, conta.id);
        const accountRemovals = removals.filter((r) => r.integracaoId === conta.id);
        // ⚠️ ONE place decides both whether a control is disabled and what its
        // tooltip says, so the two can never disagree — the bug class here is a
        // tooltip that drifts from the boolean beside it and starts explaining a
        // state the button is not in. Everything below feeds `sizeChartGate`.
        const gateBase: Omit<SizeChartGateInput, 'busy' | 'enviada'> = {
          readOnly: Boolean(disabled),
          hasClient: client != null,
          canWrite,
          hasGrupos: grupos.length > 0,
        };

        return (
          <Card key={conta.id} withBorder padding="md" data-testid={`ml-medida-conta-${conta.id}`}>
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={600}>{conta.data.nome}</Text>
                <Badge color="gray" variant="light">
                  {stored.length} {stored.length === 1 ? 'guia' : 'guias'}
                </Badge>
              </Group>

              {stored.length === 0 && (
                <Text size="sm" c="dimmed">
                  Nenhuma guia de tamanho para esta conta.
                </Text>
              )}

              {stored.map((chart, index) => {
                const chartSent = chart.id != null && chart.id !== '';
                const pendingDeletion = chart.exclusaoSolicitadaEm != null;
                const rowBusy = busyChart === `${conta.id}#${String(index)}`;
                const rowInput: SizeChartGateInput = {
                  ...gateBase,
                  // One three-way value, not two booleans — `busyChart` cannot be
                  // this row's key and null at once, and the gate's type should
                  // not pretend it can.
                  busy: rowBusy ? 'estaGuia' : busyChart !== null ? 'outraGuia' : 'none',
                  enviada: chartSent,
                };
                const staged = accountRemovals.find(
                  (r) => r.chartIndex === index && valuesEqual(r.original, chart),
                );
                if (staged) {
                  return (
                    <StagedDraftRemoval
                      key={`rascunho-${String(index)}`}
                      removal={staged}
                      testId={`ml-guia-${conta.id}-${String(index)}`}
                      gate={listGate('excluir', rowInput)}
                      onUndo={() => undoRemoval(staged)}
                    />
                  );
                }
                return (
                  <Group
                    key={chart.id ?? `rascunho-${String(index)}`}
                    justify="space-between"
                    wrap="nowrap"
                    data-testid={`ml-guia-${conta.id}-${String(index)}`}
                  >
                    <div>
                      <Text size="sm">{chart.nome ?? '(sem nome)'}</Text>
                      <Text size="xs" c="dimmed">
                        {chart.domain_id ?? '—'} · {(chart.rows ?? []).length} tamanhos
                      </Text>
                    </div>
                    <Group gap="xs" wrap="nowrap">
                      {pendingDeletion ? (
                        <Badge color="orange" variant="light">
                          Exclusão solicitada
                        </Badge>
                      ) : chartSent ? (
                        <Badge color="green" variant="light">
                          Enviada
                        </Badge>
                      ) : (
                        <Badge color="yellow" variant="light">
                          Rascunho
                        </Badge>
                      )}
                      {pendingDeletion && (
                        <SizeChartActionButton
                          size="compact-xs"
                          variant="light"
                          loading={rowBusy}
                          gate={listGate('verificar', rowInput)}
                          onClick={() => void verifyDeletion(conta.id, index, chart)}
                        >
                          Verificar
                        </SizeChartActionButton>
                      )}
                      {/* Opening the editor is a read — deliberately NOT gated on
                          `canWrite`, which is why the gate takes the action. The
                          modal owns the write bit for its own "Enviar". */}
                      <SizeChartActionButton
                        size="compact-xs"
                        variant="light"
                        gate={listGate('editar', rowInput)}
                        onClick={() => {
                          openEditor({ integracaoId: conta.id, chart, chartIndex: index });
                        }}
                      >
                        Editar
                      </SizeChartActionButton>
                      <SizeChartActionButton
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        loading={rowBusy}
                        gate={
                          accountRemovals.some((r) => r.chartIndex === index) && !chartSent
                            ? {
                                disabled: true,
                                motivo: 'Desfaça a exclusão pendente antes de marcar esta guia.',
                              }
                            : listGate('excluir', rowInput)
                        }
                        onClick={() => void removeChart(conta.id, index, chart)}
                      >
                        Excluir
                      </SizeChartActionButton>
                    </Group>
                  </Group>
                );
              })}

              {accountRemovals
                .filter((r) => !valuesEqual(stored[r.chartIndex], r.original))
                .map((removal) => (
                  <StagedDraftRemoval
                    key={`pendente-${String(removal.chartIndex)}`}
                    removal={removal}
                    detached
                    testId={`ml-guia-pendente-${conta.id}-${String(removal.chartIndex)}`}
                    gate={listGate('excluir', {
                      ...gateBase,
                      busy: busyChart !== null ? 'outraGuia' : 'none',
                      enviada: false,
                    })}
                    onUndo={() => undoRemoval(removal)}
                  />
                ))}

              <Group>
                {/* Belongs to no row, so the lock can only ever be held elsewhere —
                    and this control stays ungated on it anyway: it only opens the
                    editor, which rebuilds the conta's array from its transaction
                    read when it saves. `enviada` is inert here; only Verificar reads it. */}
                <SizeChartActionButton
                  size="xs"
                  variant="light"
                  onClick={() => {
                    openEditor({ integracaoId: conta.id, chart: null, chartIndex: null });
                  }}
                  gate={listGate('novaGuia', {
                    ...gateBase,
                    busy: busyChart !== null ? 'outraGuia' : 'none',
                    enviada: false,
                  })}
                >
                  Nova guia
                </SizeChartActionButton>
              </Group>
              {/* Kept ALONGSIDE the tooltips, reading the same constants so the two
                  cannot drift: a tooltip is not reachable without a hover, and the
                  grupos line is real guidance — it says what to go and create.
                  `AnuncioBlock` keeps a visible copy for the same reason. */}
              {grupos.length === 0 && (
                <Text size="xs" c="dimmed">
                  {SIZE_CHART_MOTIVOS.semGrupos}
                </Text>
              )}
              {!canWrite && (
                <Text size="xs" c="dimmed">
                  {SIZE_CHART_MOTIVOS.semEscrita}
                </Text>
              )}
            </Stack>
          </Card>
        );
      })}

      {client && target && (
        <SizeChartEditorModal
          key={target.session}
          opened
          onClose={() => {
            setTarget(null);
          }}
          client={client}
          integracaoId={target.integracaoId}
          getFatos={getFatos}
          tabMediId={tabMediId}
          chart={target.chart}
          chartIndex={target.chartIndex}
          grupos={grupos}
          canWrite={canWrite}
          recoveryRequired={target.syncUnconfirmed}
          recoveryChartId={recoveryChartId}
          onRecoveryChartId={setRecoveryChartId}
          onRecover={(confirmNoCreation) => recoverChart(target, confirmNoCreation)}
          onSaveDraft={async (chart, chartIndex) => {
            await saveChart(target, chart, chartIndex);
          }}
          onSend={(chart, chartIndex) => sendChart(client, target, chart, chartIndex)}
          onDuplicate={(copy) => {
            // The copy is a NEW guia: no index, so it appends on save.
            openEditor({ integracaoId: target.integracaoId, chart: copy, chartIndex: null });
            notifications.show({
              color: 'blue',
              message: 'Cópia criada. Ajuste o nome e envie como uma guia nova.',
            });
          }}
        />
      )}

      {confirmElement}
    </Stack>
  );
}

function StagedDraftRemoval({
  removal,
  testId,
  gate,
  onUndo,
  detached = false,
}: {
  removal: ChartDraftRemoval;
  testId: string;
  gate: ReturnType<typeof sizeChartGate>;
  onUndo: () => void;
  detached?: boolean;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" data-testid={testId} data-pending-delete>
      <div style={{ opacity: 0.6 }}>
        <Text size="sm">{removal.original.nome ?? '(sem nome)'}</Text>
        <Text size="xs" c="dimmed">
          {removal.original.domain_id ?? '—'} · {(removal.original.rows ?? []).length} tamanhos
        </Text>
        {detached && (
          <Text size="xs" c="orange">
            A guia mudou de posição, foi alterada ou removida.
          </Text>
        )}
      </div>
      <Group gap="xs" wrap="nowrap">
        <Badge color="orange" variant="light">
          Será excluída ao salvar
        </Badge>
        <SizeChartActionButton
          size="compact-xs"
          variant="light"
          gate={{ disabled: true, motivo: 'Desfaça a exclusão para editar este rascunho.' }}
        >
          Editar
        </SizeChartActionButton>
        <SizeChartActionButton size="compact-xs" variant="light" gate={gate} onClick={onUndo}>
          Desfazer
        </SizeChartActionButton>
      </Group>
    </Group>
  );
}

/**
 * How to render a failure the guia list owns — a Mercado Livre client error or
 * the lost-update conflict — or **null** for anything else, which the caller
 * rethrows (root `CLAUDE.md` rule 6; same shape as `describeMassImportStartError`).
 */
function describeChartError(
  err: unknown,
): { color: string; message: string; autoClose?: false } | null {
  if (err instanceof SizeChartConflictError) {
    return { color: 'red', message: err.message, autoClose: false };
  }
  if (err instanceof MercadoLivreClientHttpError) {
    return {
      color: 'red',
      message:
        err.status === 409 && err.code === 'ML_REAUTH_REQUIRED'
          ? 'Conta Mercado Livre não conectada — reconecte em Canais de venda.'
          : err.message,
    };
  }
  if (err instanceof MercadoLivreClientNetworkError) {
    return { color: 'red', message: 'Não foi possível contatar o Mercado Livre.' };
  }
  return null;
}
