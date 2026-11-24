'use client';

import { useState, type SubmitEvent } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Group,
  MultiSelect,
  NativeSelect,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  type MultiSelectProps,
} from '@mantine/core';
import { DonutChart } from '@mantine/charts';
import { useDisclosure } from '@mantine/hooks';
import { skipToken, useQuery } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';
import { PageHeader } from '@delfrance/ui';
import { formatReais } from '@delfrance/core/money';
import {
  bucketOf,
  estadoPedidoSchema,
  ESTADO_BUCKET_LABELS,
  ESTADO_PEDIDO_LABELS,
  INTEGRACAO_TIPO_LABELS,
} from '@delfrance/schemas';
import { usePermission } from '@/lib/auth/usePermission';
import { useIntegracoes } from '@/lib/data/useIntegracoes';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  defaultSalesReportDates,
  loadSalesReport,
  salesReportDateRange,
  type SalesMovement,
  type SalesReport,
  type SalesReportFilters,
} from '@/lib/reports/salesReport';

const BUCKET_COLOR: Record<string, string> = {
  aberto: 'blue.6',
  processo: 'yellow.6',
  concluido: 'green.6',
  cancelado: 'red.6',
};

const STATES = Object.entries(ESTADO_BUCKET_LABELS).map(([bucket, group]) => ({
  group,
  items: estadoPedidoSchema.options
    .filter((state) => bucketOf(state) === bucket)
    .map((state) => ({ value: state, label: ESTADO_PEDIDO_LABELS[state] })),
}));

const MOVEMENTS = [
  { value: 'saidas', label: 'Saídas' },
  { value: 'entradas', label: 'Entradas' },
  { value: 'todos', label: 'Todos' },
] satisfies { value: SalesMovement; label: string }[];

interface Submission {
  filters: SalesReportFilters;
  key: string;
  revision: number;
}

function SalesFilterSelect(props: MultiSelectProps) {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <MultiSelect
      {...props}
      dropdownOpened={opened}
      onDropdownOpen={open}
      onDropdownClose={close}
      onOptionSubmit={close}
    />
  );
}

function SalesChannelFilter({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const integrations = useIntegracoes(getFirebaseFirestore());
  return (
    <Stack gap={4}>
      <SalesFilterSelect
        label="Canais de venda"
        placeholder={integrations.status === 'pending' ? 'Carregando canais…' : 'Todos os canais'}
        data={integrations.rows.map(({ id, data }) => ({
          value: id,
          label: `${data.nome} (${INTEGRACAO_TIPO_LABELS[data.tipo]})${data.ativo === false ? ' — inativo' : ''}`,
        }))}
        value={value}
        onChange={onChange}
        disabled={
          integrations.status === 'pending' ||
          (integrations.status === 'error' && value.length === 0)
        }
        searchable
        clearable
        clearButtonProps={{ 'aria-label': 'Limpar canais de venda' }}
        nothingFoundMessage="Nenhum canal encontrado"
      />
      {integrations.status === 'error' && (
        <Group gap="xs">
          <Text size="sm" c="red" role="alert">
            Não foi possível carregar os canais de venda.
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => void integrations.query.refetch()}
            loading={integrations.query.isFetching}
          >
            Recarregar canais
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function SalesResults({ total, byBucket, byEstado }: SalesReport) {
  const donut = byBucket
    .filter((b) => b.count > 0)
    .map((b) => ({
      name: ESTADO_BUCKET_LABELS[b.bucket],
      value: b.count,
      color: BUCKET_COLOR[b.bucket] ?? 'gray.5',
    }));

  return (
    <>
      <Group align="flex-start">
        <DonutChart
          data={donut}
          size={240}
          thickness={36}
          withLabelsLine={false}
          withLabels={false}
          chartLabel={`${total} pedidos`}
        />
        <Stack
          component="ul"
          aria-label="Resumo por estado"
          flex={1}
          gap="xs"
          style={{ flexBasis: 280, minWidth: 0, listStyle: 'none', margin: 0, padding: 0 }}
        >
          {byBucket.map((b) => (
            <Group
              component="li"
              key={b.bucket}
              justify="space-between"
              py={4}
              px="xs"
              style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
            >
              <Group gap="xs">
                <Box
                  aria-hidden="true"
                  bg={BUCKET_COLOR[b.bucket] ?? 'gray.5'}
                  w={12}
                  h={12}
                  style={{ borderRadius: 2, flexShrink: 0 }}
                />
                <Text size="sm">{ESTADO_BUCKET_LABELS[b.bucket]}</Text>
              </Group>
              <Group gap="md">
                <Text size="sm" c="dimmed">
                  {b.count} pedido(s)
                </Text>
                <Text size="sm" fw={600}>
                  {formatReais(b.receita)}
                </Text>
              </Group>
            </Group>
          ))}
        </Stack>
      </Group>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Estado</Table.Th>
            <Table.Th>Bucket</Table.Th>
            <Table.Th align="right">Pedidos</Table.Th>
            <Table.Th align="right">Receita</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {byEstado.map((row) => (
            <Table.Tr key={row.estado}>
              <Table.Td>{row.label}</Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {ESTADO_BUCKET_LABELS[row.bucket]}
                </Text>
              </Table.Td>
              <Table.Td align="right">{row.count}</Table.Td>
              <Table.Td align="right">{formatReais(row.receita)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}

export default function VendasPorEstadoPage() {
  const { allowed: canReadChannels } = usePermission(PERM.integracao.read);
  const [[start, end], setDates] = useState(defaultSalesReportDates);
  const [movement, setMovement] = useState<SalesMovement>('saidas');
  const [states, setStates] = useState<string[]>([]);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<Submission | null>(null);
  const range = salesReportDateRange(start, end);
  const filters: SalesReportFilters | null = range && {
    ...range,
    movement,
    estados: [...states].sort().map((state) => estadoPedidoSchema.parse(state)),
    accountIds: canReadChannels ? [...accountIds].sort() : [],
  };
  const draftKey = JSON.stringify(filters);
  const changed = submitted !== null && submitted.key !== draftKey;
  const query = useQuery({
    queryKey: ['sales-report', submitted?.key, submitted?.revision],
    queryFn: submitted
      ? () => loadSalesReport(getFirebaseFirestore(), submitted.filters)
      : skipToken,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    networkMode: 'always',
  });
  const loading = submitted !== null && !changed && query.isFetching;

  function consult(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!filters || loading) return;
    setSubmitted((previous) => ({
      filters,
      key: draftKey,
      revision: (previous?.revision ?? 0) + 1,
    }));
  }

  return (
    <Stack>
      <PageHeader
        title="Vendas por estado"
        description="Acompanhe a situação dos pedidos pelo período de criação."
      />
      <form onSubmit={consult}>
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
            <TextInput
              type="date"
              label="Data inicial"
              value={start}
              onChange={(event) => setDates([event.currentTarget.value, end])}
            />
            <TextInput
              type="date"
              label="Data final"
              value={end}
              onChange={(event) => setDates([start, event.currentTarget.value])}
              error={!range && 'Informe um período válido.'}
            />
            <NativeSelect
              label="Movimento"
              data={MOVEMENTS}
              value={movement}
              onChange={(event) => {
                const selected = MOVEMENTS.find(({ value }) => value === event.currentTarget.value);
                if (selected) setMovement(selected.value);
              }}
            />
            <SalesFilterSelect
              label="Estados do pedido"
              placeholder="Todos os estados"
              data={STATES}
              value={states}
              onChange={setStates}
              searchable
              clearable
              clearButtonProps={{ 'aria-label': 'Limpar estados do pedido' }}
              nothingFoundMessage="Nenhum estado encontrado"
            />
            {canReadChannels && <SalesChannelFilter value={accountIds} onChange={setAccountIds} />}
          </SimpleGrid>
          <Group>
            <Button type="submit" disabled={!range} loading={loading}>
              Consultar
            </Button>
          </Group>
        </Stack>
      </form>

      {!submitted || changed ? (
        <Text c="dimmed" role="status">
          {changed
            ? 'Os filtros foram alterados. Clique em Consultar para atualizar.'
            : 'Selecione os filtros e clique em Consultar.'}
        </Text>
      ) : loading ? (
        <Stack role="status" aria-label="Carregando relatório de vendas">
          <Skeleton height={320} />
        </Stack>
      ) : query.error ? (
        <Alert color="red" title="Não foi possível consultar as vendas">
          {query.error.message}
        </Alert>
      ) : query.data?.total === 0 ? (
        <Text c="dimmed" role="status">
          Nenhum pedido encontrado para os filtros selecionados.
        </Text>
      ) : query.data ? (
        <SalesResults {...query.data} />
      ) : null}

      <Anchor component={Link} href="/relatorios" size="sm">
        ← Voltar a Relatórios
      </Anchor>
    </Stack>
  );
}
