'use client';

import { useMemo, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FirebaseError } from 'firebase/app';
import { Alert, Button, Group, Stack, Tabs, Tooltip } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { derivePedidoFreteTotals, type Pedido, pedidoSchema } from '@delfrance/schemas';
import { useUnsavedChangesGuard } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { useAuth } from '@/lib/auth/useAuth';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { FiscalTab, FreteTab, PlaceholderTab, PrincipalTab } from './tabs';
import { PagamentosSection } from './PagamentosSection';
import { regroupItens } from './regroupItens';
import { flattenItens } from './flattenItens';
import { normalizeFreteInicial } from './freteDerivation';
import type { FlatItem, PedidoFormState } from './types';

export interface PedidoFormProps {
  defaultValues?: Pedido;
  /**
   * Firestore id of the pedido being edited. Absent in create mode.
   * When present, the Pagamento tab renders the real (read-only)
   * `PagamentosSection` instead of the placeholder.
   */
  pedidoId?: string;
  submitLabel?: string;
  onSubmit: (values: Pedido) => Promise<void>;
}

const EMPTY_DEFAULTS: PedidoFormState = {
  ehSaida: true,
  hasUserInteraction: null,
  estado: 'iniciado',
  numero: null,
  vendedorPedidoOuterRef: null,
  // null (not undefined): Firestore's addDoc rejects `undefined` field values
  // (CLAUDE.md — prefer null). Required in the UI (IntegracaoPicker), but a
  // null keeps a stray submit from crashing with "Unsupported field value".
  integracaoPedidoOuterRef: null,
  operacaoPedidoOuterRef: null,
  clientePedidoOuterRef: null,
  enderecoFiscalOuterRef: null,
  listaDePrecosOuterRef: null,
  entradasRelacionadas: null,
  saidasRelacionadas: null,
  chNFeReferenciadas: null,
  itens: {},
  itensIds: [],
  itensDevolvidos: null,
  freteInicial: null,
  valorCobrado: null,
  descontoTotal: 0,
  valorCusto: null,
  valorFreteInicial: null,
  custoFreteInicial: null,
  valorDevolucao: null,
  valorCustoDevolvidos: null,
  valorDespesasIncidentes: null,
  valorFretesIncidentes: null,
  valorComissoes: null,
  impostos: null,
  timestamp: null,
  ultimaModificacao: null,
  dataFinalExpedicao: null,
  dataIndisponivelEstoque: null,
  dataRemocaoEstoque: null,
  lastMarketplaceUpdate: null,
  foiImpresso: false,
  dtImpressao: null,
  bloquearEmissaoNFe: null,
  observacoesInternas: null,
  infCpl: null,
  error: null,
  _itensFlat: [],
};

type AnyResolver = (values: unknown, ctx: unknown, opts: unknown) => unknown;
const baseResolver = zodResolver(pedidoSchema) as unknown as AnyResolver;

/**
 * Custom resolver. Regroups the flat `_itensFlat` array back into
 * `itens: Record<produtoUid, ItemDoPedido[]>` (stripping the synthetic
 * `_rowId` keys), normalizes `freteInicial` and derives the legacy money
 * caches before delegating to zodResolver — validation and the saved doc
 * see the same values (validate-what-you-save):
 *
 *   - `valorCobrado` = legacy `Pedido.total` (subtotal − desconto + frete);
 *   - `valorFreteInicial` / `custoFreteInicial` = the `Pedido.factory`
 *     reporting caches.
 *
 * The synthetic `_itensFlat` field is dropped so it never reaches
 * Firestore.
 */
const pedidoResolver: Resolver<PedidoFormState, unknown, Pedido> = async (
  values,
  context,
  options,
) => {
  const { _itensFlat, ...rest } = values;
  const cleanItens = (_itensFlat ?? []).map((row) => {
    const { _rowId, ...item } = row as FlatItem;
    return item;
  });
  const freteInicial = normalizeFreteInicial(rest.freteInicial);
  const totals = derivePedidoFreteTotals({
    itens: cleanItens,
    descontoTotal: rest.descontoTotal ?? 0,
    freteInicial,
  });
  const merged = {
    ...rest,
    itens: regroupItens(cleanItens),
    freteInicial,
    valorCobrado: totals.valorCobrado,
    valorFreteInicial: totals.valorFreteInicial,
    custoFreteInicial: totals.custoFreteInicial,
  };
  return baseResolver(merged, context, options) as Awaited<
    ReturnType<Resolver<PedidoFormState, unknown, Pedido>>
  >;
};

function buildDefaults(existing?: Pedido): PedidoFormState {
  if (!existing) return EMPTY_DEFAULTS;
  return {
    ...EMPTY_DEFAULTS,
    ...existing,
    // `freteDoPedidoSchema` is `.passthrough()`, so its inferred type has an
    // index signature `PedidoFormState` deliberately avoids (RHF path
    // inference) — structurally the same wire shape.
    freteInicial: (existing.freteInicial ?? null) as PedidoFormState['freteInicial'],
    _itensFlat: flattenItens(existing.itens ?? {}),
  };
}

export function PedidoForm({
  defaultValues,
  pedidoId,
  submitLabel = 'Salvar',
  onSubmit,
}: PedidoFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>('principal');
  const db = useMemo(() => getFirebaseFirestore(), []);
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.pedido.write);

  const initial = useMemo(() => buildDefaults(defaultValues), [defaultValues]);

  const form = useForm<PedidoFormState, unknown, Pedido>({
    resolver: pedidoResolver,
    defaultValues: initial,
    mode: 'onBlur',
  });

  // Warn before navigating away from an unsaved pedido. The schema-driven
  // screens get this from ObjectView; PedidoForm is a custom form, so wire the
  // shared guard directly.
  useUnsavedChangesGuard(form.formState.isDirty);

  async function handleSubmit(values: Pedido) {
    setSubmitError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSubmitError(err.message);
        return;
      }
      throw err;
    }
  }

  const disabled = !canWrite;

  return (
    // noValidate: Zod owns validation — native constraint validation would
    // silently block the submit when a `required` control is empty inside a
    // hidden tab (see ObjectView's form for the full story).
    <form noValidate onSubmit={form.handleSubmit(handleSubmit)}>
      <Stack>
        <Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="principal">Principal</Tabs.Tab>
            <Tabs.Tab value="fiscal">Fiscal</Tabs.Tab>
            <Tabs.Tab value="frete">Frete</Tabs.Tab>
            <Tabs.Tab value="pagamento">Pagamento</Tabs.Tab>
            <Tabs.Tab value="link-pgto">Link Pgto</Tabs.Tab>
            <Tabs.Tab value="incidentes">Incidentes</Tabs.Tab>
            <Tabs.Tab value="devolucao">Devolução</Tabs.Tab>
            <Tabs.Tab value="estado">Estado/Histórico</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="principal" pt="md">
            <PrincipalTab
              form={form}
              db={db}
              disabled={disabled}
              vendedorLabel={user?.email ?? user?.uid ?? undefined}
            />
          </Tabs.Panel>

          <Tabs.Panel value="fiscal" pt="md">
            <FiscalTab form={form} db={db} disabled={disabled} />
          </Tabs.Panel>

          <Tabs.Panel value="frete" pt="md">
            <FreteTab form={form} db={db} disabled={disabled} pedidoId={pedidoId} />
          </Tabs.Panel>

          <Tabs.Panel value="pagamento" pt="md">
            {pedidoId ? (
              <PagamentosSection pedidoId={pedidoId} />
            ) : (
              <PlaceholderTab name="Pagamento" />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="link-pgto" pt="md">
            <PlaceholderTab name="Link de pagamento" />
          </Tabs.Panel>

          <Tabs.Panel value="incidentes" pt="md">
            <PlaceholderTab name="Incidentes" />
          </Tabs.Panel>

          <Tabs.Panel value="devolucao" pt="md">
            <PlaceholderTab name="Devolução" preview={form.getValues('itensDevolvidos')} />
          </Tabs.Panel>

          <Tabs.Panel value="estado" pt="md">
            <PlaceholderTab
              name="Estado / Histórico"
              preview={{ estado: form.getValues('estado') }}
            />
          </Tabs.Panel>
        </Tabs>

        {submitError && <Alert color="red">{submitError}</Alert>}

        <Group justify="flex-end">
          <Tooltip label="Sem permissão de escrita" disabled={canWrite} withArrow>
            <Button type="submit" loading={form.formState.isSubmitting} disabled={disabled}>
              {submitLabel}
            </Button>
          </Tooltip>
        </Group>
      </Stack>
    </form>
  );
}
