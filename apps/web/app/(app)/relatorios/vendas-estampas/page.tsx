'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Button,
  Grid,
  MultiSelect,
  Paper,
  Skeleton,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { ESTADO_PEDIDO, ESTADO_PEDIDO_LABELS, estadoPedidoSchema } from '@delfrance/schemas';
import { PageHeader } from '@delfrance/ui';
import { RequirePerm, useAuth } from '@/lib/auth';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  defaultPrintSalesDates,
  loadLegacyPrintOptions,
  loadPrintSales,
  printSalesDateRange,
  searchPrintOptions,
  type PrintOption,
  type PrintSalesFilters,
} from '@/lib/reports/printSales';
import { PrintSalesResults } from './PrintSalesResults';

const ORDER_STATES = Object.entries(ESTADO_PEDIDO_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const reportFormSchema = z
  .object({
    start: z.string(),
    end: z.string(),
    states: z.array(estadoPedidoSchema).min(1, 'Selecione ao menos um estado.'),
    prints: z
      .array(z.object({ id: z.string(), nome: z.string(), sku: z.string().nullable() }))
      .min(1, 'Selecione ao menos uma estampa.'),
  })
  .refine(({ start, end }) => printSalesDateRange(start, end) !== null, {
    path: ['end'],
    message: 'Informe um período válido.',
  });

function printLabel(option: PrintOption) {
  return option.sku ? option.nome + ' · ' + option.sku : option.nome;
}

function ReportForm({ userId, defaults }: { userId: string; defaults: PrintOption[] }) {
  const db = getFirebaseFirestore();
  const [dates] = useState(defaultPrintSalesDates);
  const { control, handleSubmit } = useForm({
    resolver: zodResolver(reportFormSchema),
    defaultValues: {
      ...dates,
      states: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado],
      prints: defaults,
    },
  });
  const [start, end, states, prints] = useWatch({
    control,
    name: ['start', 'end', 'states', 'prints'],
  });
  const [search, setSearch] = useState('');
  const [term] = useDebouncedValue(search.trim(), 250);
  const [submitted, setSubmitted] = useState<{ filters: PrintSalesFilters; run: number } | null>(
    null,
  );
  const options = useQuery({
    queryKey: ['print-sales-options', userId, term],
    queryFn: () => searchPrintOptions(db, term),
    enabled: term.length > 0 && search.trim() === term,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const choices = new Map(
    [...(search.trim() === term && !options.isError ? (options.data ?? []) : []), ...prints].map(
      (print) => [print.id, print],
    ),
  );
  const range = printSalesDateRange(start, end);
  const filters: PrintSalesFilters | null =
    range && states.length > 0 && prints.length > 0
      ? {
          ...range,
          estados: [...states].sort(),
          printIds: prints.map(({ id }) => id).sort(),
        }
      : null;
  const changed =
    submitted !== null && JSON.stringify(submitted.filters) !== JSON.stringify(filters);
  const report = useQuery({
    queryKey: ['print-sales', userId, submitted],
    queryFn: () => loadPrintSales(db, submitted!.filters),
    enabled: submitted !== null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  return (
    <>
      <Paper
        component="form"
        withBorder
        p="md"
        noValidate
        onSubmit={(event) =>
          void handleSubmit(() => {
            if (!filters || (report.isFetching && !changed)) return;
            setSubmitted((previous) => ({ filters, run: (previous?.run ?? 0) + 1 }));
          })(event)
        }
      >
        <Stack>
          <Controller
            name="prints"
            control={control}
            render={({ field, fieldState }) => (
              <MultiSelect
                label="Estampas"
                placeholder="Buscar por nome ou SKU"
                searchable
                clearable
                hidePickedOptions
                searchValue={search}
                onSearchChange={setSearch}
                ref={field.ref}
                onBlur={field.onBlur}
                value={field.value.map(({ id }) => id)}
                onChange={(ids) => field.onChange(ids.flatMap((id) => choices.get(id) ?? []))}
                data={[...choices.values()].map((option) => ({
                  value: option.id,
                  label: printLabel(option),
                }))}
                filter={({ options: available }) => available}
                nothingFoundMessage={
                  search.trim() === ''
                    ? 'Digite o nome ou SKU da estampa.'
                    : options.isFetching || search.trim() !== term
                      ? 'Buscando produtos…'
                      : options.isError
                        ? 'Não foi possível buscar produtos.'
                        : 'Nenhum produto encontrado.'
                }
                error={fieldState.error?.message}
                required
              />
            )}
          />
          <Grid>
            <Grid.Col span={{ base: 6, sm: 3 }}>
              <Controller
                name="start"
                control={control}
                render={({ field }) => (
                  <TextInput {...field} label="Data inicial" type="date" required />
                )}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 3 }}>
              <Controller
                name="end"
                control={control}
                render={({ field }) => (
                  <TextInput
                    {...field}
                    label="Data final"
                    type="date"
                    error={!range ? 'Informe um período válido.' : undefined}
                    required
                  />
                )}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <Controller
                name="states"
                control={control}
                render={({ field, fieldState }) => (
                  <MultiSelect
                    {...field}
                    label="Estados do pedido"
                    data={ORDER_STATES}
                    error={fieldState.error?.message}
                    searchable
                    clearable
                    required
                  />
                )}
              />
            </Grid.Col>
          </Grid>
          <Button
            type="submit"
            w="fit-content"
            disabled={!filters || (report.isFetching && !changed)}
            loading={report.isFetching && !changed}
          >
            Gerar relatório
          </Button>
        </Stack>
      </Paper>

      {!submitted ? (
        <Text c="dimmed">Selecione os filtros e clique em Gerar relatório.</Text>
      ) : changed ? (
        <Text c="dimmed" role="status">
          Os filtros foram alterados. Gere o relatório para consultar os novos resultados.
        </Text>
      ) : report.isFetching ? (
        <Skeleton height={200} role="status" aria-label="Gerando relatório" />
      ) : report.isError ? (
        <Alert color="red" title="Não foi possível gerar o relatório">
          {report.error.message}
        </Alert>
      ) : report.data ? (
        <PrintSalesResults report={report.data} prints={prints} />
      ) : null}
    </>
  );
}

function ReportContent({ userId }: { userId: string }) {
  const defaults = useQuery({
    queryKey: ['print-sales-defaults', userId],
    queryFn: () => loadLegacyPrintOptions(getFirebaseFirestore()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return (
    <Stack gap="lg">
      <PageHeader
        title="Vendas por estampa"
        description="Compare as vendas e veja quais produtos foram vendidos com as estampas selecionadas."
      />
      {defaults.isPending ? (
        <Skeleton height={168} role="status" aria-label="Carregando estampas" />
      ) : defaults.isError ? (
        <Alert color="red" title="Não foi possível carregar as estampas">
          <Button size="xs" variant="light" onClick={() => void defaults.refetch()}>
            Tentar novamente
          </Button>
        </Alert>
      ) : (
        <ReportForm userId={userId} defaults={defaults.data} />
      )}
      <Anchor component={Link} href="/relatorios" size="sm">
        ← Voltar a Relatórios
      </Anchor>
    </Stack>
  );
}

export default function VendasEstampasPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <RequirePerm bit={PERM.pedido.read | PERM.produto.read} fallback={<Skeleton height={168} />}>
      <ReportContent key={user.uid} userId={user.uid} />
    </RequirePerm>
  );
}
