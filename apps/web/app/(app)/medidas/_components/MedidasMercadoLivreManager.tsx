'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { Firestore } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
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
import { pendingAfterSync } from '@/lib/mercado-livre/chartForm';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { CreateSizeChartModal, type SizeGroupOption } from './CreateSizeChartModal';

const MAX_CONTAS = 50;
const MAX_GRUPOS = 200;

/**
 * The medidas editor's **Mercado Livre** tab (Step 5c): one card per connected
 * ML account, showing the guias de tamanho stored for this tabela and letting
 * the user add new ones and send them to ML (`POST size-charts/sync`). Charts
 * stay stored on the tabMedi doc's `tabelasDeMedidasMercadoLivre[<conta>]` map,
 * which the still-running Flutter app also authors — the server merge writes
 * only this conta's key, so the two coexist.
 *
 * Self-contained like the produto Mercado Livre tab: it reads its own live doc
 * state and POSTs to the backend, decoupled from the tabela's Salvar.
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

  // Size groups (tipo 1) — the create modal binds a chart's rows to one.
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

  // Charts created this session, not yet sent — kept per conta so "Enviar"
  // submits stored + pending together.
  const [pendingByConta, setPendingByConta] = useState<Record<string, MlSizeChart[]>>({});
  const [syncing, setSyncing] = useState<string | null>(null);
  const [validationByConta, setValidationByConta] = useState<
    Record<string, Array<{ code: string | null; message: string | null }>>
  >({});
  const [modalConta, setModalConta] = useState<string | null>(null);

  async function handleSync(integracaoId: string, tabelas: MlSizeChart[]) {
    if (!client) return;
    setSyncing(integracaoId);
    setValidationByConta((prev) => ({ ...prev, [integracaoId]: [] }));
    try {
      const sentPendingCount = (pendingByConta[integracaoId] ?? []).length;
      const result = await client.sizeChartSync({ integracaoId, tabMediId, tabelas });
      if (result.validationErrors.length > 0) {
        setValidationByConta((prev) => ({
          ...prev,
          [integracaoId]: result.validationErrors.map((e) => ({
            code: e.code,
            message: e.message,
          })),
        }));
      }
      // Keep only the pending charts ML REJECTED (still id-less) — the accepted
      // ones were persisted server-side and reappear via the live doc snapshot.
      // Clearing unconditionally would lose a just-built guia on a fully-
      // rejected sync (the server writes nothing when nothing succeeds).
      setPendingByConta((prev) => ({
        ...prev,
        [integracaoId]: pendingAfterSync(sentPendingCount, result.tabelas),
      }));
      notifications.show({
        color: result.validationErrors.length > 0 ? 'yellow' : 'green',
        message:
          result.validationErrors.length > 0
            ? 'Guias enviadas com pendências — verifique os avisos.'
            : 'Guias de tamanho enviadas ao Mercado Livre.',
      });
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        if (err.status === 409) {
          notifications.show({
            color: 'red',
            message: 'Conta Mercado Livre não conectada — reconecte em Canais de venda.',
          });
        } else {
          notifications.show({ color: 'red', message: err.message });
        }
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        notifications.show({ color: 'red', message: 'Não foi possível contatar o Mercado Livre.' });
        return;
      }
      throw err;
    } finally {
      setSyncing(null);
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
        Erro ao carregar as contas Mercado Livre: {snapshotError.message}
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
        do produto). Aqui você cria e envia as guias por conta.
      </Text>

      {contas.map((conta) => {
        const stored = mlSizeChartsForConta(chartsMap, conta.id);
        const pending = pendingByConta[conta.id] ?? [];
        const validation = validationByConta[conta.id] ?? [];
        const all = [...stored, ...pending];

        return (
          <Card key={conta.id} withBorder padding="md" data-testid={`ml-medida-conta-${conta.id}`}>
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={600}>{conta.data.nome}</Text>
                <Badge color="gray" variant="light">
                  {all.length} {all.length === 1 ? 'guia' : 'guias'}
                </Badge>
              </Group>

              {all.length === 0 && (
                <Text size="sm" c="dimmed">
                  Nenhuma guia de tamanho para esta conta.
                </Text>
              )}

              {all.map((chart, i) => (
                <Group key={chart.id ?? `pending-${i}`} justify="space-between" wrap="nowrap">
                  <div>
                    <Text size="sm">{chart.nome ?? '(sem nome)'}</Text>
                    <Text size="xs" c="dimmed">
                      {chart.domain_id ?? '—'} · {(chart.rows ?? []).length} tamanhos
                    </Text>
                  </div>
                  {chart.id != null && chart.id !== '' ? (
                    <Badge color="green" variant="light">
                      Enviada
                    </Badge>
                  ) : (
                    <Badge color="yellow" variant="light">
                      Não enviada
                    </Badge>
                  )}
                </Group>
              ))}

              {validation.length > 0 && (
                <Alert color="red" variant="light" title="Pendências do Mercado Livre">
                  <List size="sm">
                    {validation.map((v, i) => (
                      <List.Item key={`${v.code ?? 'err'}-${i}`}>
                        {v.message ?? v.code ?? 'Erro de validação'}
                      </List.Item>
                    ))}
                  </List>
                </Alert>
              )}

              <Group>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => setModalConta(conta.id)}
                  disabled={disabled || !client || !canRead || grupos.length === 0}
                >
                  Nova guia
                </Button>
                <Button
                  size="xs"
                  onClick={() => handleSync(conta.id, all)}
                  loading={syncing === conta.id}
                  disabled={
                    disabled || !client || !canWrite || syncing !== null || all.length === 0
                  }
                >
                  Enviar ao Mercado Livre
                </Button>
              </Group>
              {grupos.length === 0 && (
                <Text size="xs" c="dimmed">
                  Cadastre um grupo de variações do tipo Tamanho para criar guias.
                </Text>
              )}
              {!canWrite && (
                <Text size="xs" c="dimmed">
                  Requer permissão de escrita em integrações para enviar.
                </Text>
              )}
            </Stack>
          </Card>
        );
      })}

      {client && modalConta && (
        <CreateSizeChartModal
          opened
          onClose={() => setModalConta(null)}
          client={client}
          integracaoId={modalConta}
          grupos={grupos}
          onAdd={(chart) =>
            setPendingByConta((prev) => ({
              ...prev,
              [modalConta]: [...(prev[modalConta] ?? []), chart],
            }))
          }
        />
      )}
    </Stack>
  );
}
