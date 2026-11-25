'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Button,
  Group,
  MultiSelect,
  NativeSelect,
  NumberInput,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { BarChart } from '@mantine/charts';
import { zodResolver } from '@hookform/resolvers/zod';
import { skipToken, useQuery } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { formatReais } from '@delfrance/core/money';
import {
  estadoPedidoSchema,
  ESTADO_PEDIDO,
  ESTADO_PEDIDO_LABELS,
  INTEGRACAO_TIPO_LABELS,
} from '@delfrance/schemas';
import { PageHeader } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { useIntegracoes } from '@/lib/data/useIntegracoes';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { rankProductSales, type ProdutoSalesMetric } from '@/lib/reports/aggregations';
import {
  defaultOrderReportDates,
  normalizeOrderReportFilters,
  orderReportDateRange,
  type OrderReportFilters,
} from '@/lib/reports/orderReportFilters';
import { loadProductSalesReport } from '@/lib/reports/productSales';

const STATES = Object.entries(ESTADO_PEDIDO_LABELS).map(([value, label]) => ({ value, label }));
const METRICS = [
  'quantidade',
  'receita',
  'pedidos',
] as const satisfies readonly ProdutoSalesMetric[];
const formatNumber = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 }).format;
const draftSchema = z
  .object({
    start: z.string(),
    end: z.string(),
    estados: z.array(estadoPedidoSchema).min(1, 'Selecione ao menos um estado.'),
    accountIds: z.array(z.string()),
    ehSaida: z.boolean(),
  })
  .refine((draft) => orderReportDateRange(draft.start, draft.end) !== null, {
    path: ['start'],
    message: 'Informe um período válido.',
  });

type Draft = z.infer<typeof draftSchema>;

function filtersFor(draft: Draft): OrderReportFilters | null {
  const range = orderReportDateRange(draft.start, draft.end);
  if (!range || draft.estados.length === 0) return null;
  const { estados, accountIds, ehSaida } = draft;
  return normalizeOrderReportFilters({ ...range, estados, accountIds, ehSaida });
}

function ChannelPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { status, rows, query } = useIntegracoes(getFirebaseFirestore());
  return (
    <Stack gap={4}>
      <MultiSelect
        label="Canais de venda"
        placeholder={status === 'pending' ? 'Carregando canais…' : 'Todos os canais'}
        data={rows.map(({ id, data }) => ({
          value: id,
          label:
            data.ativo === false
              ? data.nome + ' (' + INTEGRACAO_TIPO_LABELS[data.tipo] + ', inativo)'
              : data.nome + ' (' + INTEGRACAO_TIPO_LABELS[data.tipo] + ')',
        }))}
        value={value}
        onChange={onChange}
        disabled={status !== 'success'}
        searchable
        clearable
        nothingFoundMessage="Nenhum canal encontrado"
      />
      {status === 'error' && (
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            Não foi possível carregar os canais.
          </Text>
          <Button size="compact-xs" variant="subtle" onClick={() => void query.refetch()}>
            Recarregar canais
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function ProductSalesReport({ canReadChannels }: { canReadChannels: boolean }) {
  const queryId = useId();
  const [[start, end]] = useState(defaultOrderReportDates);
  const [metric, setMetric] = useState<ProdutoSalesMetric>('quantidade');
  const [top, setTop] = useState({ input: 10 as number | string, limit: 10 });
  const [submission, setSubmission] = useState<{
    filters: OrderReportFilters;
    revision: number;
  } | null>(null);
  const { control, handleSubmit } = useForm<Draft>({
    resolver: zodResolver(draftSchema),
    mode: 'onChange',
    defaultValues: {
      start,
      end,
      estados: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado],
      accountIds: [],
      ehSaida: true,
    },
  });
  const [draftStart, draftEnd, estados, accountIds, ehSaida] = useWatch({
    control,
    name: ['start', 'end', 'estados', 'accountIds', 'ehSaida'],
  });
  const draftFilters = filtersFor({
    start: draftStart,
    end: draftEnd,
    estados,
    accountIds,
    ehSaida,
  });
  const changed =
    submission !== null && JSON.stringify(draftFilters) !== JSON.stringify(submission.filters);
  const query = useQuery({
    queryKey: ['product-sales', queryId, submission],
    queryFn: submission
      ? () => loadProductSalesReport(getFirebaseFirestore(), submission.filters)
      : skipToken,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const rows = useMemo(
    () => rankProductSales(query.data?.rows ?? [], metric, top.limit),
    [query.data, metric, top.limit],
  );
  const loading = query.isFetching && !changed;
  const valueLabel = submission?.filters.ehSaida === false ? 'Valor dos itens' : 'Receita';
  const labels: Record<ProdutoSalesMetric, string> = {
    quantidade: 'Quantidade',
    pedidos: 'Pedidos',
    receita: valueLabel,
  };

  function submit(draft: Draft) {
    if (loading) return;
    const filters = filtersFor(draft);
    if (filters)
      setSubmission((previous) => ({ filters, revision: (previous?.revision ?? 0) + 1 }));
  }

  return (
    <Stack gap="lg">
      <PageHeader
        title="Vendas por produto"
        description="Quantidade, pedidos e receita por produto no período selecionado."
      />

      <Paper
        component="form"
        onSubmit={(event) => void handleSubmit(submit)(event)}
        withBorder
        p="md"
      >
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            <Controller
              control={control}
              name="start"
              render={({ field, fieldState }) => (
                <TextInput
                  {...field}
                  type="date"
                  label="Data inicial"
                  error={fieldState.error?.message}
                />
              )}
            />
            <Controller
              control={control}
              name="end"
              rules={{ deps: 'start' }}
              render={({ field }) => <TextInput {...field} type="date" label="Data final" />}
            />
            <Controller
              control={control}
              name="estados"
              render={({ field, fieldState }) => (
                <MultiSelect
                  {...field}
                  label="Estados do pedido"
                  data={STATES}
                  onChange={(values) => {
                    const parsed = z.array(estadoPedidoSchema).safeParse(values);
                    if (parsed.success) field.onChange(parsed.data);
                  }}
                  error={fieldState.error?.message}
                  searchable
                  clearable
                  nothingFoundMessage="Nenhum estado encontrado"
                />
              )}
            />
            <Controller
              control={control}
              name="ehSaida"
              render={({ field }) => (
                <NativeSelect
                  {...field}
                  label="Movimento"
                  data={[
                    { value: 'saida', label: 'Saídas' },
                    { value: 'entrada', label: 'Entradas' },
                  ]}
                  value={field.value ? 'saida' : 'entrada'}
                  onChange={(event) => field.onChange(event.currentTarget.value === 'saida')}
                />
              )}
            />
            {canReadChannels && (
              <Controller
                control={control}
                name="accountIds"
                render={({ field }) => (
                  <ChannelPicker value={field.value} onChange={field.onChange} />
                )}
              />
            )}
          </SimpleGrid>
          <Group>
            <Button type="submit" loading={loading}>
              Gerar relatório
            </Button>
          </Group>
        </Stack>
      </Paper>

      {!submission ? (
        <Text c="dimmed">Selecione os filtros e clique em Gerar relatório.</Text>
      ) : changed ? (
        <Text c="dimmed" role="status">
          Os filtros foram alterados. Clique em Gerar relatório para consultar.
        </Text>
      ) : loading ? (
        <Stack role="status" aria-label="Carregando vendas por produto">
          <Skeleton height={320} />
        </Stack>
      ) : query.isError ? (
        <Alert color="red" title="Não foi possível gerar o relatório">
          <Stack align="flex-start" gap="xs">
            <Text size="sm">{query.error.message}</Text>
            <Button size="xs" variant="light" onClick={() => void query.refetch()}>
              Tentar novamente
            </Button>
          </Stack>
        </Alert>
      ) : query.data ? (
        <Stack>
          {query.data.invalidLines > 0 && (
            <Alert color="yellow" title="Dados incompletos">
              {query.data.invalidLines} item(ns) com dados inválidos foram desconsiderados.
            </Alert>
          )}
          {rows.length === 0 ? (
            <Text c="dimmed">Nenhum produto encontrado com os filtros selecionados.</Text>
          ) : (
            <>
              <Group align="flex-end">
                <NativeSelect
                  label="Ordenar por"
                  data={METRICS.map((value) => ({ value, label: labels[value] }))}
                  value={metric}
                  onChange={(event) => {
                    const next = METRICS.find((value) => value === event.currentTarget.value);
                    if (next) setMetric(next);
                  }}
                />
                <NumberInput
                  label="Top"
                  value={top.input}
                  onChange={(input) => {
                    const valid =
                      typeof input === 'number' &&
                      Number.isInteger(input) &&
                      input >= 1 &&
                      input <= 50;
                    setTop((previous) => ({ input, limit: valid ? input : previous.limit }));
                  }}
                  onBlur={() => setTop((previous) => ({ ...previous, input: previous.limit }))}
                  min={1}
                  max={50}
                  step={1}
                  allowDecimal={false}
                  w={100}
                />
              </Group>
              <BarChart
                h={320}
                data={rows.map((row) => ({ produto: row.label, [labels[metric]]: row[metric] }))}
                dataKey="produto"
                series={[{ name: labels[metric], color: 'blue.6' }]}
                valueFormatter={metric === 'receita' ? (value) => formatReais(value) : formatNumber}
                withTooltip
              />
              <Table.ScrollContainer minWidth={500}>
                <Table aria-label="Vendas por produto" striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>#</Table.Th>
                      <Table.Th>Produto</Table.Th>
                      <Table.Th ta="right">Quantidade</Table.Th>
                      <Table.Th ta="right">Pedidos</Table.Th>
                      <Table.Th ta="right">{valueLabel}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.map((row, index) => (
                      <Table.Tr key={row.produtoUid}>
                        <Table.Td>{index + 1}</Table.Td>
                        <Table.Td>
                          <Anchor
                            component={Link}
                            href={'/produtos/' + encodeURIComponent(row.produtoUid) + '/editar'}
                          >
                            {row.label}
                          </Anchor>
                        </Table.Td>
                        <Table.Td ta="right">{formatNumber(row.quantidade)}</Table.Td>
                        <Table.Td ta="right">{formatNumber(row.pedidos)}</Table.Td>
                        <Table.Td ta="right">{formatReais(row.receita)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </>
          )}
        </Stack>
      ) : null}

      <Anchor component={Link} href="/relatorios" size="sm">
        ← Voltar a Relatórios
      </Anchor>
    </Stack>
  );
}

export default function ProductSalesPage() {
  const { allowed, loading } = usePermission(PERM.integracao.read);
  if (loading) return <Skeleton height={120} />;
  return <ProductSalesReport key={String(allowed)} canReadChannels={allowed} />;
}
