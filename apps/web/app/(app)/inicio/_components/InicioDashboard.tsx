'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { PieChart } from '@mantine/charts';
import {
  DESPACHO_METRICAS,
  inicioCheckoutJanela,
  inicioDespachoHref,
  inicioDespachoJanela,
} from '@delfrance/schemas';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  CHECKOUT_PERIODOS,
  DESPACHO_KEYS,
  INICIO_CACHE_MS,
  loadCanaisInicio,
  loadCheckoutInicio,
  loadDespachoInicio,
  loadVendasInicio,
  type CheckoutPeriodo,
} from '@/lib/inicio/queries';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const COLORS = [
  'blue.6',
  'teal.6',
  'orange.6',
  'grape.6',
  'cyan.6',
  'pink.6',
  'lime.7',
  'indigo.6',
];

/** One timer at local midnight; visibility handles a sleeping/background tab. */
function useLocalCalendar() {
  const [day, setDay] = useState(() => inicioCheckoutJanela(new Date()).diaMs);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      const now = new Date();
      setDay(inicioCheckoutJanela(now).diaMs);
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      clearTimeout(timer);
      timer = setTimeout(check, next.getTime() - now.getTime() + 50);
    }
    check();
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return day;
}

function Card<T>({
  title,
  query,
  children,
}: {
  title: string;
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <Paper component="section" aria-label={title} withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>{title}</Title>
          <Button
            variant="subtle"
            size="compact-xs"
            loading={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            Atualizar
          </Button>
        </Group>
        {query.isPending ? (
          <Skeleton height={100} />
        ) : query.isError ? (
          <Alert color="red" title="Erro ao carregar">
            Não foi possível carregar estes dados. Use Atualizar para tentar novamente.
          </Alert>
        ) : (
          children(query.data)
        )}
        {query.dataUpdatedAt > 0 && (
          <Text size="xs" c="dimmed">
            Atualizado em {new Date(query.dataUpdatedAt).toLocaleString('pt-BR')}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function DespachoCard({
  uid,
  canalId,
  nome,
  day,
}: {
  uid: string;
  canalId: string;
  nome: string;
  day: number;
}) {
  const window = { canalId, ...inicioDespachoJanela(new Date(day)) };
  const query = useQuery({
    queryKey: ['inicio', uid, 'despacho', canalId, day, window.inicioUs, window.fimUs],
    staleTime: INICIO_CACHE_MS,
    queryFn: () => loadDespachoInicio(getFirebaseFirestore(), window),
  });
  return (
    <Card title={nome} query={query}>
      {(counts) => (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            {new Date(window.inicioUs / 1000).toLocaleDateString('pt-BR')} a{' '}
            {new Date(window.fimUs / 1000).toLocaleDateString('pt-BR')}
          </Text>
          {DESPACHO_KEYS.map((metrica) => (
            <Group key={metrica} justify="space-between">
              <Anchor component={Link} href={inicioDespachoHref({ ...window, metrica }) as Route}>
                {DESPACHO_METRICAS[metrica]}
              </Anchor>
              <Badge variant="light">{counts[metrica]}</Badge>
            </Group>
          ))}
        </Stack>
      )}
    </Card>
  );
}

export function CheckoutCard({ uid, day }: { uid: string; day: number }) {
  const [period, setPeriod] = useState<CheckoutPeriodo>('dia');
  const query = useQuery({
    queryKey: ['inicio', uid, 'checkout', day],
    staleTime: INICIO_CACHE_MS,
    queryFn: () => loadCheckoutInicio(getFirebaseFirestore(), inicioCheckoutJanela(new Date())),
  });
  return (
    <Card title="Checkout" query={query}>
      {(data) => (
        <Stack>
          <SimpleGrid cols={3}>
            {(Object.keys(CHECKOUT_PERIODOS) as CheckoutPeriodo[]).map((key) => (
              <Stack key={key} gap={0}>
                <Text c="dimmed">{CHECKOUT_PERIODOS[key]}</Text>
                <Text fw={700} size="xl">
                  {data.total[key]}
                </Text>
              </Stack>
            ))}
          </SimpleGrid>
          <SegmentedControl
            aria-label="Período dos checkouts"
            value={period}
            onChange={(value) => setPeriod(value as CheckoutPeriodo)}
            data={(Object.keys(CHECKOUT_PERIODOS) as CheckoutPeriodo[]).map((value) => ({
              value,
              label: CHECKOUT_PERIODOS[value],
            }))}
          />
          {data.total[period] === 0 ? (
            <Text c="dimmed">Nenhum checkout neste período.</Text>
          ) : (
            <>
              <PieChart
                mx="auto"
                size={200}
                withTooltip
                data={data.rows
                  .filter((row) => row[period] > 0)
                  .map((row, i) => ({
                    name: row.label,
                    value: row[period],
                    color: COLORS[i % COLORS.length]!,
                  }))}
              />
              <Stack gap={4} mah={240} style={{ overflowY: 'auto' }}>
                {data.rows
                  .filter((row) => row[period] > 0)
                  .map((row) => (
                    <Group key={row.userId ?? 'others'} justify="space-between">
                      <Text size="sm">{row.label}</Text>
                      <Text size="sm" fw={600}>
                        {row[period]}
                      </Text>
                    </Group>
                  ))}
              </Stack>
            </>
          )}
        </Stack>
      )}
    </Card>
  );
}

export function InicioDashboard({ uid }: { uid: string }) {
  const day = useLocalCalendar();
  const client = useQueryClient();
  const sales = useQuery({
    queryKey: ['inicio', uid, 'vendas', day],
    staleTime: INICIO_CACHE_MS,
    queryFn: loadVendasInicio,
  });
  const channels = useQuery({
    queryKey: ['inicio', uid, 'canais', day],
    staleTime: INICIO_CACHE_MS,
    queryFn: () => loadCanaisInicio(getFirebaseFirestore()),
  });
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Painel de pedidos</Title>
        <Button
          variant="light"
          onClick={() => {
            void client.invalidateQueries({ queryKey: ['inicio', uid] });
          }}
        >
          Atualizar painel
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card title="Minhas vendas — últimos 7 dias" query={sales}>
          {(data) => (
            <Stack>
              <Text fw={700} size="xl">
                {money.format(data.receita)}
              </Text>
              <Text>
                {data.quantidade} pedidos · Ticket médio {money.format(data.ticketMedio)}
              </Text>
              {data.quantidade === 0 && <Text c="dimmed">Nenhuma venda neste período.</Text>}
              <Text size="xs" c="dimmed">
                {new Date(data.inicioUs / 1000).toLocaleString('pt-BR')} a{' '}
                {new Date(data.fimUs / 1000).toLocaleString('pt-BR')}
              </Text>
            </Stack>
          )}
        </Card>
        <CheckoutCard uid={uid} day={day} />
      </SimpleGrid>
      <Title order={3}>Despacho por canal de vendas</Title>
      {channels.isPending ? (
        <Skeleton height={130} />
      ) : channels.isError ? (
        <Alert color="red" title="Erro ao carregar canais">
          Não foi possível carregar os canais. Tente atualizar o painel.
        </Alert>
      ) : channels.data.length === 0 ? (
        <Text c="dimmed">Nenhum canal de vendas ativo.</Text>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }}>
          {channels.data.map((channel) => (
            <DespachoCard
              key={channel.id}
              uid={uid}
              canalId={channel.id}
              nome={channel.data.nome}
              day={day}
            />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
