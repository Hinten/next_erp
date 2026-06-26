'use client';

import { useMemo } from 'react';
import { Controller, useWatch, type UseFormReturn } from 'react-hook-form';
import { type Firestore } from 'firebase/firestore';
import { Alert, Button, Group, NumberInput, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { derivePedidoTotals, type Pedido, type Pagamento } from '@delfrance/schemas';
import { formatReais, roundReais } from '@delfrance/core/money';
import { pagamentoCollection } from '@/lib/data/pagamentoCollection';
import { parseBrl } from '@/app/(app)/produtos/_components/CurrencyInput';
import { sumPagamentosPagos } from './PagamentoForm';
import { OrcamentoShareMenu } from './print/OrcamentoShareMenu';
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
  /**
   * Programmatic "save and stay" submit. When provided (edit mode), a second
   * "Salvar e continuar editando" button runs this instead of navigating away.
   */
  onSaveAndContinue?: () => void;
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
  onSaveAndContinue,
}: PedidoFooterProps) {
  // `useWatch` (not `form.watch`): this is a child component that receives `form`
  // as a prop, so it must subscribe to the control itself — `form.watch()` only
  // re-renders the component that called `useForm()`, leaving the footer frozen
  // on the initial values.
  const itensFlatRaw = useWatch({ control: form.control, name: '_itensFlat' });
  const descontoTotal = useWatch({ control: form.control, name: 'descontoTotal' }) ?? 0;
  const freteInicial = useWatch({ control: form.control, name: 'freteInicial' }) ?? null;
  const itensDevolvidos = useWatch({ control: form.control, name: 'itensDevolvidos' }) ?? null;

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
            <FooterStat
              label="Devoluções"
              value={brl(totals.valorDevolucao)}
              color={totals.valorDevolucao > 0 ? 'red' : undefined}
            />
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
            {/* Vlr. Pago is a payments figure — shown only in edit mode (a real
                pedido), but there it stays visible even at R$ 0,00. */}
            {pedidoId && <FooterStat label="Vlr. Pago" value={brl(valorPago)} />}
            {troco > 0 && <FooterStat label="Troco" value={brl(troco)} />}
          </Group>
          <Group gap="xs" wrap="nowrap" align="center">
            <OrcamentoShareMenu db={db} pedidoId={pedidoId} />
            {pedidoId && onSaveAndContinue && (
              <Tooltip label="Sem permissão de escrita" disabled={canWrite} withArrow>
                <Button
                  type="button"
                  variant="default"
                  loading={isSubmitting}
                  disabled={disabled}
                  onClick={onSaveAndContinue}
                >
                  Salvar e continuar editando
                </Button>
              </Tooltip>
            )}
            <Tooltip label="Sem permissão de escrita" disabled={canWrite} withArrow>
              <Button type="submit" loading={isSubmitting} disabled={disabled}>
                {submitLabel}
              </Button>
            </Tooltip>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
