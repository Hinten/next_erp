'use client';

import { useMemo, useState } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FirebaseError } from 'firebase/app';
import { Alert, Button, Group, Stack, Tabs, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconExclamationCircle } from '@tabler/icons-react';
import { PERM } from '@delfrance/auth';
import {
  derivePedidoTotals,
  pedidoPageIssues,
  type Pedido,
  pedidoSchema,
} from '@delfrance/schemas';
import { useUnsavedChangesGuard } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { useAuth } from '@/lib/auth/useAuth';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  DevolucaoTab,
  EstadoHistoricoTab,
  FiscalTab,
  FreteTab,
  IncidentesTab,
  PlaceholderTab,
  PrincipalTab,
} from './tabs';
import { PagamentosSection } from './PagamentosSection';
import { regroupItens } from './regroupItens';
import { flattenItens } from './flattenItens';
import { normalizeFreteInicial } from './freteDerivation';
import { summarizePedidoErrors, TAB_OF_FIELD } from './pedidoErrorTabs';
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
  /**
   * Receives the resolved (validate-what-you-save) doc values plus RHF's
   * `dirtyFields` so the edit page can build a partial patch (`buildPedidoPatch`)
   * and write only the touched fields. Create-mode callers ignore `dirtyFields`.
   */
  onSubmit: (values: Pedido, dirtyFields: Readonly<Record<string, unknown>>) => Promise<void>;
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
  const itens = regroupItens(cleanItens);
  // `itensIds` mirrors the legacy denormalized produtoUid list (the `itens` map
  // keys), recomputed here so it never drifts from the items.
  const itensIds = Object.keys(itens);
  // Full factory port — derives every money cache the doc stores, so the saved
  // doc and the dirty patch (buildPedidoPatch) see consistent values.
  const totals = derivePedidoTotals({
    itens: cleanItens,
    descontoTotal: rest.descontoTotal ?? 0,
    freteInicial,
    itensDevolvidos: rest.itensDevolvidos,
  });
  const merged = {
    ...rest,
    itens,
    itensIds,
    freteInicial,
    valorCobrado: totals.valorCobrado,
    valorCusto: totals.valorCusto,
    valorFreteInicial: totals.valorFreteInicial,
    custoFreteInicial: totals.custoFreteInicial,
    valorDevolucao: totals.valorDevolucao,
    valorCustoDevolvidos: totals.valorCustoDevolvidos,
  };
  type ResolverResult = Awaited<ReturnType<Resolver<PedidoFormState, unknown, Pedido>>>;
  const result = (await baseResolver(merged, context, options)) as ResolverResult;

  // Cross-document / UI-required rules live in the page model (single source);
  // the resolver runs the subset that applies to the doc form — at-least-one-item
  // and integração required — and routes each issue to its tab. Keeping these out
  // of the plain `pedidoSchema` avoids breaking parse/read-back of legacy docs.
  // ('itens' is held by the form as the synthetic `_itensFlat` field.)
  const extraErrors: Record<string, { type: string; message: string }> = {};
  for (const issue of pedidoPageIssues({
    itens: merged.itens,
    integracaoPedidoOuterRef: merged.integracaoPedidoOuterRef,
  })) {
    const field = issue.path === 'itens' ? '_itensFlat' : issue.path;
    extraErrors[field] = { type: 'pageModel', message: issue.message };
  }
  if (Object.keys(extraErrors).length === 0) return result;
  return { values: {}, errors: { ...result.errors, ...extraErrors } } as unknown as ResolverResult;
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
      await onSubmit(values, form.formState.dirtyFields as Readonly<Record<string, unknown>>);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSubmitError(err.message);
        return;
      }
      throw err;
    }
  }

  // Invalid submit. Without this, an error on a non-active tab is silent: RHF
  // blocks the save and the inline message sits in a hidden panel. Jump to the
  // first erroring tab and name the offenders in a red toast — the same
  // behavior ObjectView gives its tabbed forms.
  function onInvalid(errors: FieldErrors<PedidoFormState>) {
    const summary = summarizePedidoErrors(Object.keys(errors));
    if (summary.firstTab && (!activeTab || !summary.errorTabValues.has(activeTab))) {
      setActiveTab(summary.firstTab);
    }
    notifications.show({ color: 'red', message: summary.message });
  }

  // Tabs containing invalid fields. Read the `formState.errors` proxy during
  // render (RHF mutates it in place, so it's not a usable memo dep) — this
  // subscribes the form to error changes, just like ObjectView.
  const errorTabs = new Set<string>();
  for (const key of Object.keys(form.formState.errors)) {
    const tab = TAB_OF_FIELD[key];
    if (tab) errorTabs.add(tab);
  }

  // Red text + error icon for a tab with invalid fields (mirrors SectionTabs).
  function tabErrorProps(value: string) {
    const hasError = errorTabs.has(value);
    return {
      // `c` (text color), not `color`: `color` only re-tints the active tab.
      c: hasError ? 'red' : undefined,
      'data-error': hasError || undefined,
      rightSection: hasError ? (
        <IconExclamationCircle size={14} role="img" aria-label="contém campos inválidos" />
      ) : undefined,
    };
  }

  const disabled = !canWrite;

  return (
    // noValidate: Zod owns validation — native constraint validation would
    // silently block the submit when a `required` control is empty inside a
    // hidden tab (see ObjectView's form for the full story).
    <form noValidate onSubmit={form.handleSubmit(handleSubmit, onInvalid)}>
      <Stack>
        <Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="principal" {...tabErrorProps('principal')}>
              Principal
            </Tabs.Tab>
            <Tabs.Tab value="fiscal" {...tabErrorProps('fiscal')}>
              Fiscal
            </Tabs.Tab>
            <Tabs.Tab value="frete" {...tabErrorProps('frete')}>
              Frete
            </Tabs.Tab>
            <Tabs.Tab value="pagamento" {...tabErrorProps('pagamento')}>
              Pagamento
            </Tabs.Tab>
            <Tabs.Tab value="link-pgto" {...tabErrorProps('link-pgto')}>
              Link Pgto
            </Tabs.Tab>
            <Tabs.Tab value="incidentes" {...tabErrorProps('incidentes')}>
              Incidentes
            </Tabs.Tab>
            <Tabs.Tab value="devolucao" {...tabErrorProps('devolucao')}>
              Devolução
            </Tabs.Tab>
            <Tabs.Tab value="estado" {...tabErrorProps('estado')}>
              Estado/Histórico
            </Tabs.Tab>
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
            <IncidentesTab pedidoId={pedidoId} disabled={disabled} />
          </Tabs.Panel>

          <Tabs.Panel value="devolucao" pt="md">
            <DevolucaoTab form={form} db={db} disabled={disabled} pedidoId={pedidoId} />
          </Tabs.Panel>

          <Tabs.Panel value="estado" pt="md">
            <EstadoHistoricoTab form={form} disabled={disabled} pedidoId={pedidoId} />
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
