'use client';

import { useEffect, useReducer, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Button,
  Group,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';
import {
  ESTADO_PEDIDO,
  ESTADO_PEDIDO_LABELS,
  INTEGRACAO_TIPO_LABELS,
  type EstadoPedido,
} from '@delfrance/schemas';
import { PageHeader } from '@delfrance/ui';
import { RequirePerm, useAuth, useTenant } from '@/lib/auth';
import {
  getFirebaseApp,
  getFirebaseFirestore,
  isUsingFirebaseEmulator,
} from '@/lib/firebase/client';
import { useIntegracoes } from '@/lib/data/useIntegracoes';
import { topProductsDateRange, type TopProductsFilters } from '@/lib/reports/topProducts';
import { topProductsCacheKey, topProductsRunner } from '@/lib/reports/topProductsSession';
import type { ReportCacheScope } from '@/lib/reports/reportCache';
import { TopProductsResults, formatQuantity } from './_components/TopProductsResults';

const REPORT_PERMISSIONS = PERM.pedido.read | PERM.produto.read | PERM.integracao.read;
const STATES = Object.entries(ESTADO_PEDIDO_LABELS).map(([value, label]) => ({ value, label }));

function defaultDates(): [string, string] {
  const now = new Date();
  const month = String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
  return [month + '-01', month + '-' + String(now.getDate()).padStart(2, '0')];
}

interface Submission {
  filters: TopProductsFilters;
  key: string;
  topN: number;
  force: boolean;
  revision: number;
}

function ReportContent({ scope }: { scope: ReportCacheScope }) {
  const db = getFirebaseFirestore();
  const integrations = useIntegracoes(db);
  const [dates, setDates] = useState(defaultDates);
  const [estados, setEstados] = useState<EstadoPedido[]>([
    ESTADO_PEDIDO.pago,
    ESTADO_PEDIDO.finalizado,
  ]);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [ehSaida, setEhSaida] = useState(true);
  const [topN, setTopN] = useState(10);
  const [submitted, setSubmitted] = useState<Submission | null>(null);
  const range = topProductsDateRange(dates[0], dates[1]);
  const filters: TopProductsFilters | null =
    range && estados.length > 0 ? { ...range, estados, accountIds, ehSaida } : null;
  const draftKey = filters ? topProductsCacheKey(scope, filters) : null;
  const changed = submitted !== null && submitted.key !== draftKey;
  const query = useQuery({
    queryKey: [
      'best-selling-products',
      scope,
      submitted?.key,
      submitted?.topN,
      submitted?.revision,
    ],
    queryFn: () =>
      topProductsRunner.run(db, scope, submitted!.filters, submitted!.topN, submitted!.force),
    enabled: submitted !== null,
    // Each explicit submission gets its own query. The persisted envelope is
    // the sole six-hour freshness authority; background events must not bill reads.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const [expiredAt, expire] = useReducer((_: number | null, value: number) => value, null);
  const expiresAt = query.data?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = window.setTimeout(() => expire(expiresAt), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const expired = expiresAt !== undefined && expiresAt === expiredAt;
  const loading = submitted !== null && query.isFetching;
  const canGenerate =
    filters !== null && integrations.status === 'success' && (!loading || changed);
  const submit = (force: boolean) => {
    if (!filters || integrations.status !== 'success') return;
    setSubmitted((previous) => ({
      filters,
      key: topProductsCacheKey(scope, filters),
      topN,
      force,
      revision: (previous?.revision ?? 0) + 1,
    }));
  };
  const changeTop = (value: string | number) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) return;
    setTopN(value);
    if (!changed && !expired && query.data) {
      setSubmitted((previous) =>
        previous
          ? {
              ...previous,
              topN: value,
              force: false,
              revision: previous.revision + 1,
            }
          : null,
      );
    }
  };

  return (
    <Stack gap="lg">
      <PageHeader
        title="Produtos mais vendidos"
        description="Ranking por quantidade, com detalhes de cada variação."
      />
      <Group align="flex-start">
        <TextInput
          type="date"
          label="Data inicial"
          value={dates[0]}
          onChange={(event) => setDates([event.currentTarget.value, dates[1]])}
          error={!range ? 'Informe um período válido.' : undefined}
        />
        <TextInput
          type="date"
          label="Data final"
          value={dates[1]}
          onChange={(event) => setDates([dates[0], event.currentTarget.value])}
        />
        <MultiSelect
          label="Canais de venda"
          placeholder="Todas as contas"
          data={integrations.rows.map(({ id, data }) => ({
            value: id,
            label:
              data.nome +
              ' (' +
              INTEGRACAO_TIPO_LABELS[data.tipo] +
              ')' +
              (data.ativo === false ? ' — inativo' : ''),
          }))}
          value={accountIds}
          onChange={setAccountIds}
          disabled={integrations.status !== 'success'}
          searchable
          clearable
          w={300}
        />
        <MultiSelect
          label="Estados do pedido"
          data={STATES}
          value={estados}
          onChange={(values) =>
            setEstados(
              values.filter((value): value is EstadoPedido =>
                Object.hasOwn(ESTADO_PEDIDO_LABELS, value),
              ),
            )
          }
          error={estados.length === 0 ? 'Selecione ao menos um estado.' : undefined}
          searchable
          clearable
          w={280}
        />
        <NumberInput
          label="Top"
          value={topN}
          onChange={changeTop}
          min={1}
          max={50}
          step={1}
          allowDecimal={false}
          disabled={loading}
          w={100}
        />
      </Group>
      <Group align="flex-end">
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Movimento
          </Text>
          <SegmentedControl
            aria-label="Movimento"
            value={ehSaida ? 'saida' : 'entrada'}
            onChange={(value) => setEhSaida(value === 'saida')}
            data={[
              { value: 'saida', label: 'Saídas' },
              { value: 'entrada', label: 'Entradas' },
            ]}
          />
        </Stack>
        <Button onClick={() => submit(false)} disabled={!canGenerate} loading={loading && !changed}>
          Gerar relatório
        </Button>
        <Button
          variant="light"
          onClick={() => submit(true)}
          disabled={!canGenerate || !submitted || changed}
          loading={loading && !changed}
        >
          Atualizar dados
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Kits são contabilizados pelos componentes da composição atual do catálogo. A composição na
        data da venda pode ter sido diferente.
      </Text>
      {integrations.status === 'pending' && <Text role="status">Carregando canais de venda…</Text>}
      {integrations.status === 'error' && (
        <Alert color="red" title="Não foi possível carregar os canais de venda">
          <Stack gap="xs">
            <Text size="sm">{integrations.query.error?.message}</Text>
            <Button size="xs" variant="light" onClick={() => void integrations.query.refetch()}>
              Tentar novamente
            </Button>
          </Stack>
        </Alert>
      )}
      {!submitted ? (
        <Text c="dimmed">Selecione os filtros e clique em Gerar relatório.</Text>
      ) : changed ? (
        <Text c="dimmed">
          Os filtros foram alterados. Clique em Gerar relatório para consultar.
        </Text>
      ) : loading ? (
        <Stack role="status" aria-label="Carregando produtos mais vendidos">
          <Skeleton height={60} />
          <Skeleton height={320} />
        </Stack>
      ) : query.error ? (
        <Alert color="red" title="Não foi possível gerar o relatório">
          {query.error.message}
        </Alert>
      ) : expired ? (
        <Alert color="yellow" title="Relatório expirado">
          As seis horas de validade terminaram. Clique em Gerar relatório para atualizar os dados.
        </Alert>
      ) : query.data ? (
        <>
          <Text size="sm" c="dimmed" role="status">
            {query.data.fromCache ? 'Dados em cache. ' : 'Dados atualizados. '}
            Gerado em {new Date(query.data.generatedAt).toLocaleString('pt-BR')}. Válido até{' '}
            {new Date(query.data.expiresAt).toLocaleString('pt-BR')}.
          </Text>
          {query.data.report.diagnostics.length > 0 && (
            <Alert color="yellow" title="Dados incompletos">
              <Stack component="ul" gap={4} m={0} pl="md">
                {query.data.report.diagnostics.map((item, index) => (
                  <Text
                    component="li"
                    size="sm"
                    key={String(index) + ':' + item.kind + ':' + item.produtoId}
                  >
                    {item.produtoId ? item.produtoId + ': ' : ''}
                    {item.message} ({formatQuantity(item.quantidade)} unidade(s) afetada(s))
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}
          <TopProductsResults rows={query.data.rows} total={query.data.report.totalQuantidade} />
        </>
      ) : null}
      <Anchor component={Link} href="/relatorios" size="sm">
        ← Voltar a Relatórios
      </Anchor>
    </Stack>
  );
}

export default function BestSellingProductsPage() {
  const { user, loading } = useAuth();
  const { claims, loading: claimsLoading } = useTenant();
  if (loading || claimsLoading) return <Skeleton height={120} />;
  if (!user) return null;
  const scope: ReportCacheScope = {
    version: 'best-selling-products:2',
    project: getFirebaseApp().options.projectId ?? '',
    database: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_ID ?? 'default',
    transport: isUsingFirebaseEmulator()
      ? 'emulator:' + (process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST ?? '127.0.0.1') + ':8080'
      : 'remote',
    userId: user.uid,
    permissions: claims?.permissions ?? '',
  };
  return (
    <RequirePerm bit={REPORT_PERMISSIONS}>
      <ReportContent key={JSON.stringify(scope)} scope={scope} />
    </RequirePerm>
  );
}
