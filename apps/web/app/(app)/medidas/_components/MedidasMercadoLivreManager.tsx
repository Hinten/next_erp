'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Firestore } from 'firebase/firestore';
import { Alert, Anchor, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useFormContext, type FieldValues } from 'react-hook-form';
import { PERM } from '@delfrance/auth';
import {
  INTEGRACAO_TIPO,
  type MlSizeChart,
  TIPO_VARIACAO,
  mlSizeChartsForConta,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';

import { buildMedidasFatos } from '@/lib/mercado-livre/medidasFatos';

import { useConfirmDialog } from '@/app/(app)/pedidos/_components/ConfirmDialog';
import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { SizeChartConflictError } from '@/lib/mercado-livre/chartConflict';
import { sameChart } from '@/lib/mercado-livre/chartRows';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreChartValidationError,
  type MercadoLivreClient,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { SizeChartEditorModal, type SizeGroupOption } from './SizeChartEditorModal';

const MAX_CONTAS = 50;
const MAX_GRUPOS = 200;

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
}

/**
 * The medidas editor's **Mercado Livre** tab: one card per connected ML account
 * listing the guias de tamanho stored for this tabela, each opening the
 * full-screen editor.
 *
 * Guias live on the tabMedi doc's `tabelasDeMedidasMercadoLivre[<conta>]` map,
 * which the still-running Flutter app also authors — every write here merges
 * only this conta's key, so the two coexist.
 *
 * ⚠️ Unsent guias are PERSISTED as drafts (`id: null`) rather than held in React
 * state. A 75-row × 10-column grid is far too much work to lose to a reload,
 * and a draft is inert everywhere else: `resolveSizeChart` only ever considers
 * charts that carry an ML id.
 */
export function MedidasMercadoLivreManager({
  tabMediId,
  db,
  disabled,
}: {
  tabMediId: string;
  db: Firestore;
  disabled?: boolean;
}) {
  const client = useMercadoLivreClient();
  // Backend gates: read for domains/specs, write for sync.
  const { allowed: canRead } = usePermission(PERM.integracao.read);
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
  /**
   * `'<contaId>#<index>'` while that guia's delete/verify call is in flight —
   * it says which row shows the spinner.
   *
   * ⚠️ The DISABLING it drives is deliberately global, not per row. Every one of
   * these operations rewrites the conta's whole `tabelas` array from the live
   * snapshot, so two running at once would race: the second read would miss the
   * first's write and clobber it. One at a time is the guard.
   */
  const [busyChart, setBusyChart] = useState<string | null>(null);
  const { confirm, element: confirmElement } = useConfirmDialog();
  const sessionRef = useRef(0);

  function openEditor(next: Omit<EditorTarget, 'session'>): void {
    sessionRef.current += 1;
    setTarget({ ...next, session: sessionRef.current });
  }

  /**
   * Persist one guia into this conta's list without contacting ML.
   *
   * ⚠️ The array is rebuilt from the LIVE snapshot, not from whatever the editor
   * opened with: the Flutter app and the sync backend write the same key, and a
   * `merge()` replaces the array wholesale. If the stored list changed shape
   * under us we refuse rather than clobber — the client SDK has no
   * `lastUpdateTime` precondition, so surfacing the conflict is the only tier
   * available (root `CLAUDE.md` rule 7 / ADR 0011).
   */
  async function saveChart(
    integracaoId: string,
    chart: MlSizeChart,
    chartIndex: number | null,
    original: MlSizeChart | null,
  ): Promise<{ tabelas: MlSizeChart[]; index: number }> {
    const stored = mlSizeChartsForConta(chartsMap, integracaoId);
    // An index is not an identity — verify the slot still holds the guia this
    // editor opened, or a concurrent insert/reorder would overwrite another one.
    if (chartIndex != null && !(original != null && sameChart(stored[chartIndex], original))) {
      throw new SizeChartConflictError();
    }
    const tabelas =
      chartIndex == null
        ? [...stored, chart]
        : stored.map((c, i) => (i === chartIndex ? chart : c));
    const index = chartIndex ?? tabelas.length - 1;
    await tabelaDeMedidasCollection.merge(db, {}, tabMediId, {
      tabelasDeMedidasMercadoLivre: { [integracaoId]: { tabelas } },
      ultimaModificacao: Date.now(),
    });
    // ⚠️ A brand-new guia now EXISTS at `index`. Binding the open editor to it
    // is what stops a second "Enviar" (after ML rejected part of the chart, when
    // the modal deliberately stays open) from appending a duplicate instead of
    // replacing what was just written.
    if (chartIndex == null) {
      setTarget((prev) => (prev == null ? prev : { ...prev, chartIndex: index, chart }));
    }
    return { tabelas, index };
  }

  /**
   * Persist, then send this conta's whole list to ML.
   *
   * The whole list, not just the edited guia: the backend diffs each chart
   * against the stored doc and skips the untouched ones, so submitting only one
   * would make the others look deleted. Saving first means a rejected send
   * still leaves the operator's typing on the doc.
   */
  async function sendChart(
    ready: MercadoLivreClient,
    integracaoId: string,
    chart: MlSizeChart,
    chartIndex: number | null,
    original: MlSizeChart | null,
  ): Promise<{ validationErrors: MercadoLivreChartValidationError[]; chartIndex: number }> {
    const { tabelas, index } = await saveChart(integracaoId, chart, chartIndex, original);
    const result = await ready.sizeChartSync({ integracaoId, tabMediId, tabelas });
    return { validationErrors: result.validationErrors, chartIndex: index };
  }

  /**
   * Remove one guia.
   *
   * A draft (no ML id) is dropped locally — there is nothing on ML to remove.
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
      const ok = await confirm({
        title: 'Excluir rascunho',
        message: `O rascunho "${nome}" nunca foi enviado ao Mercado Livre e será removido desta tabela.`,
        confirmLabel: 'Excluir',
      });
      if (!ok) return;
      setBusyChart(`${integracaoId}#${String(index)}`);
      try {
        const stored = mlSizeChartsForConta(chartsMap, integracaoId);
        // An index is not an identity: the Flutter app or a completed sync may
        // have inserted or reordered guias since this list rendered, and
        // deleting position N blindly would remove somebody else's guia.
        if (!sameChart(stored[index], chart)) throw new SizeChartConflictError();
        await tabelaDeMedidasCollection.merge(db, {}, tabMediId, {
          tabelasDeMedidasMercadoLivre: {
            [integracaoId]: { tabelas: stored.filter((_, i) => i !== index) },
          },
          ultimaModificacao: Date.now(),
        });
        notifications.show({ color: 'green', message: 'Rascunho excluído.' });
      } catch (err) {
        const shown = describeChartError(err);
        if (shown == null) throw err;
        notifications.show(shown);
      } finally {
        setBusyChart(null);
      }
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

  // No integração.read → the contas query is idle (never issued). Say so
  // instead of falling through to the misleading "no account" empty state.
  if (!canRead) {
    return (
      <Text size="sm" c="dimmed">
        Requer permissão de leitura em integrações para gerenciar as guias de tamanho.
      </Text>
    );
  }

  if (contasSnap.loading || docSnap.loading || gruposSnap.loading) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
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

      {contas.map((conta) => {
        const stored = mlSizeChartsForConta(chartsMap, conta.id);

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
                        <Button
                          size="compact-xs"
                          variant="light"
                          loading={rowBusy}
                          disabled={disabled || !client || !canWrite || busyChart !== null}
                          onClick={() => void verifyDeletion(conta.id, index, chart)}
                        >
                          Verificar
                        </Button>
                      )}
                      <Button
                        size="compact-xs"
                        variant="light"
                        disabled={disabled || !client || busyChart !== null}
                        onClick={() => {
                          openEditor({ integracaoId: conta.id, chart, chartIndex: index });
                        }}
                      >
                        Editar
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        loading={rowBusy}
                        disabled={disabled || !client || !canWrite || busyChart !== null}
                        onClick={() => void removeChart(conta.id, index, chart)}
                      >
                        Excluir
                      </Button>
                    </Group>
                  </Group>
                );
              })}

              <Group>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => {
                    openEditor({ integracaoId: conta.id, chart: null, chartIndex: null });
                  }}
                  disabled={disabled || !client || grupos.length === 0}
                >
                  Nova guia
                </Button>
              </Group>
              {grupos.length === 0 && (
                <Text size="xs" c="dimmed">
                  Cadastre um grupo de variações do tipo Tamanho para criar guias.
                </Text>
              )}
              {!canWrite && (
                <Text size="xs" c="dimmed">
                  Requer permissão de escrita em integrações para enviar ao Mercado Livre.
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
          onSaveDraft={async (chart, chartIndex) => {
            await saveChart(target.integracaoId, chart, chartIndex, target.chart);
          }}
          onSend={(chart, chartIndex) =>
            sendChart(client, target.integracaoId, chart, chartIndex, target.chart)
          }
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
        err.status === 409
          ? 'Conta Mercado Livre não conectada — reconecte em Canais de venda.'
          : err.message,
    };
  }
  if (err instanceof MercadoLivreClientNetworkError) {
    return { color: 'red', message: 'Não foi possível contatar o Mercado Livre.' };
  }
  return null;
}
