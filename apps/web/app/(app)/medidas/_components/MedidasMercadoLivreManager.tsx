'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Firestore } from 'firebase/firestore';
import { Alert, Anchor, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import {
  INTEGRACAO_TIPO,
  type MlSizeChart,
  TIPO_VARIACAO,
  mlSizeChartsForConta,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { SizeChartConflictError } from '@/lib/mercado-livre/chartConflict';
import { sameChart } from '@/lib/mercado-livre/chartRows';
import {
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

              {stored.map((chart, index) => (
                <Group
                  key={chart.id ?? `rascunho-${String(index)}`}
                  justify="space-between"
                  wrap="nowrap"
                >
                  <div>
                    <Text size="sm">{chart.nome ?? '(sem nome)'}</Text>
                    <Text size="xs" c="dimmed">
                      {chart.domain_id ?? '—'} · {(chart.rows ?? []).length} tamanhos
                    </Text>
                  </div>
                  <Group gap="xs" wrap="nowrap">
                    {chart.id != null && chart.id !== '' ? (
                      <Badge color="green" variant="light">
                        Enviada
                      </Badge>
                    ) : (
                      <Badge color="yellow" variant="light">
                        Rascunho
                      </Badge>
                    )}
                    <Button
                      size="compact-xs"
                      variant="light"
                      disabled={disabled || !client}
                      onClick={() => {
                        openEditor({ integracaoId: conta.id, chart, chartIndex: index });
                      }}
                    >
                      Editar
                    </Button>
                  </Group>
                </Group>
              ))}

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
    </Stack>
  );
}
