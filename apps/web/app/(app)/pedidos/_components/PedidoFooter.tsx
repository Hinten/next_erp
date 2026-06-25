'use client';

import { useMemo } from 'react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { type Firestore } from 'firebase/firestore';
import { Alert, Button, Group, NumberInput, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { derivePedidoTotals, type Pedido, type Pagamento } from '@delfrance/schemas';
import { formatReais, roundReais } from '@delfrance/core/money';
import { pagamentoCollection } from '@/lib/data/pagamentoCollection';
import { parseBrl } from '@/app/(app)/produtos/_components/CurrencyInput';
import { sumPagamentosPagos } from './PagamentoForm';
import type { FlatItem, PedidoFormState } from './types';

const brl = (n: number): string => formatReais(n);

export interface PedidoFooterProps {
  form: UseFormReturn<PedidoFormState, unknown, Pedido>;
  db: Firestore;
  /** Present in edit mode — enables the live "Vlr. Pago" / "Troco" from pagamentos. */
  pedidoId?: string;
  canWrite: boolean;
  disabled: boolean;
  submitLabel: string;
  isSubmitting: boolean;
  submitError: string | null;
}

/** A label-over-value money stat for the footer bar. */
function FooterStat({
  label,
  value,
  bold,
  color,
  testId,
}: {
  label: string;
  value: string;
  bold?: boolean;
  color?: string;
  testId?: string;
}) {
  return (
    <Stack gap={0} align="flex-end">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={bold ? 700 : 500} c={color} data-testid={testId}>
        {value}
      </Text>
    </Stack>
  );
}

/**
 * Sticky pedido summary bar (legacy "rodapé"). Rendered once outside `<Tabs>`
 * inside the form so the totals + Save stay visible on every tab while the body
 * scrolls. Totals are derived live via `derivePedidoTotals` over the watched
 * form values, so they match the saved doc exactly (validate-what-you-save).
 * "Vlr. Pago" / "Troco" subscribe to the pedido's pagamentos (edit mode only).
 */
export function PedidoFooter({
  form,
  db,
  pedidoId,
  canWrite,
  disabled,
  submitLabel,
  isSubmitting,
  submitError,
}: PedidoFooterProps) {
  const itensFlatRaw = form.watch('_itensFlat');
  const descontoTotal = form.watch('descontoTotal') ?? 0;
  const freteInicial = form.watch('freteInicial') ?? null;
  const itensDevolvidos = form.watch('itensDevolvidos') ?? null;

  // Mirror the resolver's row filter (PedidoForm): staged-deleted and in-progress
  // blank rows are dropped on save, so they must not affect the live totals.
  const realItens = useMemo(
    () =>
      (itensFlatRaw ?? []).filter(
        (r: FlatItem) => !r._delete && (!!r.produtoUid || !!r.mktplaceId),
      ),
    [itensFlatRaw],
  );

  const totals = useMemo(
    () =>
      derivePedidoTotals({
        itens: realItens,
        descontoTotal,
        freteInicial,
        itensDevolvidos,
      }),
    [realItens, descontoTotal, freteInicial, itensDevolvidos],
  );

  // Σ approved payments, live (edit mode only). `valorPago`/`troco` stay hidden in
  // create mode where there is no pedido to attach pagamentos to.
  const pagamentosQuery = useMemo(
    () =>
      pedidoId
        ? buildQuery(pagamentoCollection.ref(db, { pedidoId }), [
            orderByField('dataCadastro', 'desc'),
          ])
        : null,
    [db, pedidoId],
  );
  const { data: pagamentos } = useSnapshot<Pagamento>(pagamentosQuery);
  const valorPago = useMemo(
    () =>
      sumPagamentosPagos(
        (pagamentos ?? []).map(({ id, data: p }) => ({
          id,
          valor: p.valor,
          status_pagamento: p.status_pagamento,
        })),
      ),
    [pagamentos],
  );
  const troco = Math.max(0, roundReais(valorPago - totals.valorCobrado));

  return (
    <Paper
      withBorder
      shadow="sm"
      p="sm"
      pos="sticky"
      bottom={0}
      bg="var(--mantine-color-body)"
      style={{ zIndex: 3 }}
      data-testid="pedido-footer"
    >
      <Stack gap="xs">
        {submitError && (
          <Alert color="red" py={6}>
            {submitError}
          </Alert>
        )}
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <Group gap="lg" align="flex-end" wrap="wrap">
            <FooterStat label="Subtotal" value={brl(totals.subtotal)} />
            {totals.valorDevolucao > 0 && (
              <FooterStat label="Devoluções" value={brl(totals.valorDevolucao)} color="red" />
            )}
            <FooterStat label="Frete" value={brl(totals.valorFreteInicial)} />
            <Stack gap={0} align="flex-end">
              <Text size="xs" c="dimmed">
                Desconto
              </Text>
              <Controller
                control={form.control}
                name="descontoTotal"
                render={({ field }) => (
                  <NumberInput
                    aria-label="Desconto total"
                    value={field.value ?? 0}
                    onChange={(v) => field.onChange(parseBrl(v) ?? 0)}
                    onBlur={field.onBlur}
                    min={0}
                    decimalScale={2}
                    decimalSeparator=","
                    allowedDecimalSeparators={[',', '.']}
                    w={110}
                    size="xs"
                    disabled={disabled}
                  />
                )}
              />
            </Stack>
            <FooterStat
              label="Total"
              value={brl(totals.valorCobrado)}
              bold
              color={totals.valorCobrado < 0 ? 'red' : undefined}
              testId="footer-total"
            />
            {valorPago > 0 && <FooterStat label="Vlr. Pago" value={brl(valorPago)} />}
            {troco > 0 && <FooterStat label="Troco" value={brl(troco)} />}
          </Group>
          <Tooltip label="Sem permissão de escrita" disabled={canWrite} withArrow>
            <Button type="submit" loading={isSubmitting} disabled={disabled}>
              {submitLabel}
            </Button>
          </Tooltip>
        </Group>
      </Stack>
    </Paper>
  );
}
