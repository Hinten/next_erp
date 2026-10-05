'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Button, Group, Skeleton, Stack, Text } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@delfrance/ui';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { checkoutDateRange, loadCheckoutReport } from '@/lib/reports/checkouts';
import { downloadCheckoutsCsv } from '@/lib/reports/checkoutsCsv';
import { CheckoutResults } from './_components/CheckoutResults';

function defaultDates(): [string, string] {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${month}-${String(now.getDate()).padStart(2, '0')}`];
}

export default function CheckoutsPage() {
  const [dates, setDates] = useState<[string | null, string | null]>(defaultDates);
  const range = checkoutDateRange(...dates);
  const { data, isFetching, isPending, error, refetch } = useQuery({
    queryKey: ['checkout-report', range?.startMs, range?.endExclusiveMs],
    queryFn: () => loadCheckoutReport(getFirebaseFirestore(), range!),
    enabled: range !== null,
    refetchOnWindowFocus: false,
  });
  const loading = range !== null && (isPending || isFetching);
  return (
    <Stack>
      <PageHeader
        title="Checkouts"
        description="Checkouts realizados por usuário no período selecionado."
      />
      <Group align="flex-end">
        <DatePickerInput
          type="range"
          allowSingleDateInRange
          label="Período (início / fim)"
          value={dates}
          onChange={setDates}
          valueFormat="DD/MM/YYYY"
          clearable
        />
        <Button
          variant="light"
          onClick={() => void refetch()}
          disabled={!range}
          loading={isFetching}
        >
          Atualizar
        </Button>
        <Button
          variant="light"
          disabled={!range || loading || !!error || !data || data.total === 0}
          onClick={() => {
            if (data && dates[0] && dates[1]) downloadCheckoutsCsv(data, dates[0], dates[1]);
          }}
        >
          Exportar CSV
        </Button>
      </Group>
      {!range ? (
        <Text c="dimmed">Selecione as datas de início e fim para consultar.</Text>
      ) : loading ? (
        <Stack role="status" aria-label="Carregando checkouts">
          <Skeleton height={80} />
          <Skeleton height={320} />
        </Stack>
      ) : error ? (
        <Alert color="red" title="Não foi possível carregar os checkouts">
          {error.message}
        </Alert>
      ) : data ? (
        <CheckoutResults report={data} />
      ) : null}
      <Anchor component={Link} href="/relatorios" size="sm">
        ← Voltar a Relatórios
      </Anchor>
    </Stack>
  );
}
