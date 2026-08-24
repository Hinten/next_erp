'use client';

import { useEffect, useMemo, useState } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FirebaseError } from 'firebase/app';
import { Alert, Tabs, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconExclamationCircle, IconLock } from '@tabler/icons-react';
import { PERM } from '@delfrance/auth';
import {
  ESTADO_PEDIDO,
  derivePedidoTotals,
  ESTADO_NFE,
  ESTADO_NFE_LABELS,
  ESTADO_PEDIDO_LABELS,
  nfeFiscalEncerrada,
  pedidoPageIssues,
  travarInclusaoProduto,
  travarPagamentoComNFe,
  type EstadoPedido,
  type Pedido,
  pedidoSchema,
  idFromRef,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { useServerTruthSeed, useUnsavedChangesGuard } from '@delfrance/ui';
import { nfeCollection } from '@/lib/data/nfeCollection';
import { usePermission } from '@/lib/auth';
import { useAuth } from '@/lib/auth/useAuth';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  CheckoutTab,
  DevolucaoTab,
  EstadoHistoricoTab,
  EstoqueSyncTab,
  FiscalTab,
  FreteTab,
  IncidentesTab,
  ModificacoesTab,
  PlaceholderTab,
  PrincipalTab,
} from './tabs';
import { PagamentosSection } from './PagamentosSection';
import { PedidoFooter } from './PedidoFooter';
import { regroupItens } from './regroupItens';
import { flattenItens } from './flattenItens';
import { normalizeFreteInicial } from './freteDerivation';
import { pedidoTabs, summarizePedidoErrors, TAB_OF_FIELD } from './pedidoErrorTabs';
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
   * The pedido's live `estado` from the page snapshot. When it changes
   * externally (e.g. the pagamento auto-reconcile flips it to `pago`), the form
   * syncs its own estado field so the Estado/Histórico tab stays in step —
   * unless the user is editing estado manually.
   */
  liveEstado?: EstadoPedido;
  /**
   * Direction seed, consumed ONLY in create mode (`buildDefaults` starts the
   * form at `{ ...EMPTY_DEFAULTS, ehSaida }`). In edit mode the loaded doc's
   * spread always wins and this prop is ignored. Defaults to true (saída).
   */
  ehSaida?: boolean;
  /**
   * `fromCache` of the page snapshot these `defaultValues` came from. Supply it
   * in edit mode so the form repaints once the AUTHORITATIVE copy arrives: with
   * the IndexedDB cache the first emission can be stale, and `useForm` reads
   * `defaultValues` only at mount, so without this the operator edits — and
   * saves — a document version that is no longer current.
   */
  fromCache?: boolean;
  /**
   * Called whenever the form (re)seeds from `defaultValues`, with `true` when
   * the values are server truth.
   *
   * ⚠️ This is how anything DERIVED from the same snapshot stays in step — the
   * edit page re-seeds its concurrency baseline here. Deriving it in a separate
   * effect would let the form correct to server truth while the baseline still
   * held the cached copy, and that mismatch reads as a phantom conflict (#972).
   */
  onSeeded?: (serverTruth: boolean) => void;
  /**
   * Receives the resolved (validate-what-you-save) doc values plus RHF's
   * `dirtyFields` so the edit page can build a partial patch (`buildPedidoPatch`)
   * and write only the touched fields. Create-mode callers ignore `dirtyFields`.
   *
   * Return `false` when the save did NOT commit (e.g. a concurrency conflict or
   * nothing-changed) so "Salvar e continuar editando" keeps the edits dirty
   * instead of marking the form pristine.
   */
  onSubmit: (
    values: Pedido,
    dirtyFields: Readonly<Record<string, unknown>>,
    opts: { continueEditing: boolean },
  ) => Promise<void | boolean>;
}

const EMPTY_DEFAULTS: PedidoFormState = {
  id: null,
  ehSaidaOriginal: null,
  ehSaida: true,
  hasUserInteraction: null,
  estado: ESTADO_PEDIDO.iniciado,
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
 * `_rowId` keys), normalizes `freteInicial` and derives `valorCobrado` before
 * delegating to zodResolver — validation and the saved doc see the same value
 * (validate-what-you-save):
 *
 *   - `valorCobrado` = legacy `Pedido.total` (subtotal − desconto + frete).
 *     It is the ONLY money cache still persisted; the other five Flutter wrote
 *     were removed (#796) because each was a pure function of `itens` or
 *     `freteInicial` on the same document. `PedidoFooter` still shows them —
 *     derived live from watched form state, never from the doc.
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
  // Drop non-real rows before regrouping: staged-deleted rows (`_delete`) and
  // in-progress empty rows (no produto and no marketplace id — the "Adicionar
  // produto" button appends a blank row before a produto is picked). Strip both
  // synthetic fields (`_rowId`, `_delete`) so neither reaches Firestore.
  const cleanItens = (_itensFlat ?? [])
    .filter((row) => {
      const r = row as FlatItem;
      if (r._delete) return false;
      return !!r.produtoUid || !!r.mktplaceId;
    })
    .map((row) => {
      const { _rowId, _delete, ...item } = row as FlatItem;
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
  };
  type ResolverResult = Awaited<ReturnType<Resolver<PedidoFormState, unknown, Pedido>>>;
  const result = (await baseResolver(merged, context, options)) as ResolverResult;

  // Cross-document / UI-required rules live in the page model (single source);
  // the resolver runs the subset that applies to the doc form and routes each
  // issue to its tab. Keeping these out of the plain `pedidoSchema` avoids
  // breaking parse/read-back of legacy docs. ('itens' is held by the form as the
  // synthetic `_itensFlat` field.) Payment-coverage is intentionally omitted —
  // the page model only enforces it for an integrated save (pagamentos supplied).
  const extraErrors: Record<string, { type: string; message: string }> = {};
  for (const issue of pedidoPageIssues({
    id: merged.id,
    ehSaida: merged.ehSaida,
    ehSaidaOriginal: merged.ehSaidaOriginal,
    itens: merged.itens,
    integracaoPedidoOuterRef: merged.integracaoPedidoOuterRef,
    chNFeReferenciadas: merged.chNFeReferenciadas,
  })) {
    const field = issue.path === 'itens' ? '_itensFlat' : issue.path;
    extraErrors[field] = { type: 'pageModel', message: issue.message };
  }
  // Item-level cross-field rule (legacy `descontoUnitario` validator): a per-item
  // discount may not exceed its unit price. Block the save and route it to the
  // Principal tab — the offending row also shows an inline error on its desconto
  // input. Don't clobber an existing `_itensFlat` issue (e.g. "no items").
  if (
    !extraErrors._itensFlat &&
    cleanItens.some((it) => (it.descontoUnitario ?? 0) > it.precoDeVenda)
  ) {
    extraErrors._itensFlat = {
      type: 'descontoMaiorQuePreco',
      message: 'Há itens com desconto maior que o preço.',
    };
  }
  if (Object.keys(extraErrors).length === 0) return result;
  return { values: {}, errors: { ...result.errors, ...extraErrors } } as unknown as ResolverResult;
};

/**
 * Notice atop the NF-e-gated tabs (Fiscal / Pagamento). While the NF-e snapshot
 * is still loading the tab is default-denied, so explain the temporary lock;
 * once resolved, show the state-specific lock reason (or nothing).
 */
function NfeLockNotice({ loading, lockText }: { loading: boolean; lockText: string | null }) {
  if (loading) {
    return (
      <Alert color="gray" mb="md">
        Carregando dados da NF-e…
      </Alert>
    );
  }
  if (lockText) {
    return (
      <Alert color="yellow" icon={<IconLock size={16} />} mb="md">
        {lockText}
      </Alert>
    );
  }
  return null;
}

function buildDefaults(existing?: Pedido, pedidoId?: string, ehSaida = true): PedidoFormState {
  if (!existing) return { ...EMPTY_DEFAULTS, ehSaida };
  return {
    ...EMPTY_DEFAULTS,
    ...existing,
    // Transient page-model context (edit mode): the doc id + the loaded `ehSaida`
    // so the resolver can enforce the direction-flag immutability rule.
    id: pedidoId ?? null,
    ehSaidaOriginal: existing.ehSaida ?? null,
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
  liveEstado,
  ehSaida = true,
  fromCache,
  onSeeded,
  onSubmit,
}: PedidoFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>('principal');
  const db = useMemo(() => getFirebaseFirestore(), []);
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.pedido.write);

  const initial = useMemo(
    () => buildDefaults(defaultValues, pedidoId, ehSaida),
    [defaultValues, pedidoId, ehSaida],
  );

  // Direction is immutable (enforced by the page model via `ehSaidaOriginal`),
  // so the initial values — not a watch — are the source of truth.
  const isEntrada = initial.ehSaida === false;
  const visibleTabs = new Set(pedidoTabs(isEntrada));

  const form = useForm<PedidoFormState, unknown, Pedido>({
    resolver: pedidoResolver,
    defaultValues: initial,
    mode: 'onBlur',
  });

  // Warn before navigating away from an unsaved pedido. The schema-driven
  // screens get this from ObjectView; PedidoForm is a custom form, so wire the
  // shared guard directly.
  useUnsavedChangesGuard(form.formState.isDirty);

  // Paint the first emission, then correct to server truth once — the same
  // contract ObjectView follows, wired here because this form takes
  // `defaultValues` at mount only. A dirty form is never repainted.
  useServerTruthSeed({
    id: pedidoId,
    fromCache,
    isDirty: form.formState.isDirty,
    onSeed: (serverTruth) => {
      form.reset(buildDefaults(defaultValues, pedidoId, ehSaida));
      onSeeded?.(serverTruth);
    },
  });

  // Keep the form's estado in step with an external change (the pagamento
  // auto-reconcile flips it to pago/aguardando in Firestore). Skip when the user
  // is editing estado manually so their unsaved change isn't clobbered.
  useEffect(() => {
    if (liveEstado === undefined) return;
    // Don't race an in-flight save or clobber a manual estado edit.
    if (form.formState.isSubmitting) return;
    if (form.getFieldState('estado').isDirty) return;
    if (form.getValues('estado') !== liveEstado) {
      form.setValue('estado', liveEstado, { shouldDirty: false });
    }
  }, [liveEstado, form]);

  // Two save paths share one handler: the primary submit ("Salvar"/"Criar")
  // navigates away; "Salvar e continuar editando" reloads in place. The footer's
  // continue button runs the second RHF submit programmatically, so the page's
  // onSubmit gets `continueEditing` without a shared ref.
  async function handleSubmit(values: Pedido, continueEditing: boolean) {
    setSubmitError(null);
    try {
      const saved = await onSubmit(
        values,
        form.formState.dirtyFields as Readonly<Record<string, unknown>>,
        { continueEditing },
      );
      // "Salvar e continuar editando" stays on the page; re-baseline the form to
      // the just-saved values so it's no longer dirty — otherwise the unsaved-
      // changes guard would prompt on the next navigation (and a hard reload here
      // would trip its `beforeunload` confirmation). Skip when the save did not
      // commit (`false`: conflict / nothing changed) so edits stay dirty.
      if (continueEditing && saved !== false) {
        form.reset(form.getValues());
      }
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

  // Edit-capability locking (port of legacy `travar_pedido` / `travar_fiscal`,
  // `cadastroPedidoProvider.dart:134-145` + `pedidoCadastro.dart:396-609`):
  //  - items + general data (Principal tab) lock once the estado leaves the
  //    cart/checkout phase (`travarInclusaoProduto`);
  //  - the Fiscal tab locks once any NF-e is aprovada.
  // The `canWrite` permission gate applies on top. The legacy read the NF-e once
  // (async, racy); the reactive `useSnapshot` here keeps the lock in step live.
  // `liveEstado` (the persisted snapshot estado) is the right source — matching
  // the legacy "loaded estado" — and avoids subscribing the whole form to a watch.
  const estadoNow: EstadoPedido = liveEstado ?? ESTADO_PEDIDO.iniciado;
  const nfeQuery = useMemo(
    () =>
      pedidoId
        ? buildQuery(nfeCollection.ref(db, { pedidoId }), [
            orderByField('ultima_modificacao', 'desc'),
            limit(1),
          ])
        : null,
    [db, pedidoId],
  );
  const { data: nfeData, loading: nfeLoading } = useSnapshot(nfeQuery);
  const nfeEstado = nfeData?.[0]?.data?.estado ?? null;
  const nfeAprovada = nfeEstado === ESTADO_NFE.aprovada;
  // A cancelada / numeração-inutilizada NF-e also locks the Fiscal tab and
  // pagamentos — and hard, without the aprovada-only pedido-estado carve-outs.
  const nfeEncerrada = nfeEstado != null && nfeFiscalEncerrada(nfeEstado);
  const nfeBloqueiaFiscal = nfeAprovada || nfeEncerrada;
  // Default-deny both NF-e-gated tabs (Fiscal + Pagamento) while the snapshot is
  // still resolving (edit mode): an aprovada/cancelada/inutilizada NF-e must not
  // be editable in the load window before the subscription lands.
  const nfeCarregando = pedidoId != null && nfeLoading;
  const itensTravados = travarInclusaoProduto(estadoNow);
  // Estado lock (legacy `travar_pedido`): items + general data, the Frete tab,
  // the Devolução tab and the footer desconto all lock once the pedido leaves the
  // cart/checkout phase. Observações internas is the sole exception — always
  // editable (legacy `pedidoCadastro.dart:532`), so it stays on the bare
  // write-permission `disabled`.
  const dadosGeraisDisabled = disabled || itensTravados;
  // Default-deny: while the NF-e snapshot is still resolving (edit mode), keep
  // Fiscal locked so an aprovada NF-e can't be bypassed in the load window.
  const fiscalDisabled = disabled || nfeBloqueiaFiscal || nfeCarregando;
  // Pagamento lock (legacy `canSavePagamentos`): an aprovada NF-e blocks payment
  // edits except in the carve-out estados (`travarPagamentoComNFe`); a cancelada /
  // inutilizada NF-e blocks them outright. No blocking NF-e → pagamentos stay
  // editable regardless of estado — a soft "unexpected payment" warning
  // (PagamentosSection) covers the already-paid case instead.
  const pagamentosBloqueadosPorNFe =
    nfeEncerrada || (nfeAprovada && travarPagamentoComNFe(estadoNow));
  const pagamentosTravados = nfeCarregando || pagamentosBloqueadosPorNFe;
  const dadosGeraisLockNotice = itensTravados
    ? `Edição bloqueada — pedido no estado "${ESTADO_PEDIDO_LABELS[estadoNow]}". Dados gerais, itens, frete e devolução só podem ser editados na fase de carrinho/checkout.`
    : null;
  const nfeEstadoLabel = nfeEstado ? ESTADO_NFE_LABELS[nfeEstado] : null;
  const fiscalLockNotice = nfeBloqueiaFiscal
    ? `Dados fiscais bloqueados — a NF-e deste pedido está "${nfeEstadoLabel}".`
    : null;
  const pagamentoLockNotice = pagamentosBloqueadosPorNFe
    ? `Pagamentos bloqueados — a NF-e deste pedido está "${nfeEstadoLabel}".`
    : null;

  return (
    // noValidate: Zod owns validation — native constraint validation would
    // silently block the submit when a `required` control is empty inside a
    // hidden tab (see ObjectView's form for the full story).
    <form
      noValidate
      onSubmit={form.handleSubmit((values) => handleSubmit(values, false), onInvalid)}
      // Flex column that fills the page (the page Stack sets a viewport-tall
      // min-height): the tab area grows so the sticky footer is pushed to the
      // bottom even when a tab's content is short — it no longer floats up.
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        gap: 'var(--mantine-spacing-md)',
      }}
    >
      <div style={{ flex: '1 0 auto', minHeight: 0 }}>
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
            {visibleTabs.has('link-pgto') && (
              <Tabs.Tab value="link-pgto" {...tabErrorProps('link-pgto')}>
                Link Pgto
              </Tabs.Tab>
            )}
            {visibleTabs.has('incidentes') && (
              <Tabs.Tab value="incidentes" {...tabErrorProps('incidentes')}>
                Incidentes
              </Tabs.Tab>
            )}
            {visibleTabs.has('devolucao') && (
              <Tabs.Tab value="devolucao" {...tabErrorProps('devolucao')}>
                Devolução
              </Tabs.Tab>
            )}
            {visibleTabs.has('checkout') && (
              // Read-only (checkout is a dispatch audit log): no tabErrorProps —
              // nothing here validates.
              <Tabs.Tab value="checkout">Checkout</Tabs.Tab>
            )}
            <Tabs.Tab value="estado" {...tabErrorProps('estado')}>
              Estado/Histórico
            </Tabs.Tab>
            {/* Read-only (#408): no tabErrorProps — nothing here validates. */}
            <Tabs.Tab value="estoque">Estoque</Tabs.Tab>
            {/* Read-only audit feed: no tabErrorProps — it owns no form field. */}
            <Tabs.Tab value="modificacoes">Modificações</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="principal" pt="md">
            {dadosGeraisLockNotice && (
              <Alert color="yellow" icon={<IconLock size={16} />} mb="md">
                {dadosGeraisLockNotice}
              </Alert>
            )}
            <PrincipalTab
              form={form}
              db={db}
              disabled={dadosGeraisDisabled}
              observacoesDisabled={disabled}
              vendedorLabel={user?.email ?? user?.uid ?? undefined}
            />
          </Tabs.Panel>

          <Tabs.Panel value="fiscal" pt="md">
            <NfeLockNotice loading={nfeCarregando} lockText={fiscalLockNotice} />
            <FiscalTab form={form} db={db} disabled={fiscalDisabled} />
          </Tabs.Panel>

          <Tabs.Panel value="frete" pt="md">
            {dadosGeraisLockNotice && (
              <Alert color="yellow" icon={<IconLock size={16} />} mb="md">
                {dadosGeraisLockNotice}
              </Alert>
            )}
            <FreteTab form={form} db={db} disabled={dadosGeraisDisabled} pedidoId={pedidoId} />
          </Tabs.Panel>

          <Tabs.Panel value="pagamento" pt="md">
            {pedidoId ? (
              <>
                <NfeLockNotice loading={nfeCarregando} lockText={pagamentoLockNotice} />
                <PagamentosSection
                  pedidoId={pedidoId}
                  disabled={disabled || pagamentosTravados}
                  estado={estadoNow}
                  // `getValues` (not `watch`): the total is stable while the
                  // Pagamento tab is open (items are edited on Principal), so no
                  // subscription/re-render is needed.
                  pedidoTotal={form.getValues('valorCobrado') ?? 0}
                />
              </>
            ) : (
              // Payment is fully ported (PagamentosSection below); it's just
              // unavailable until the doc exists, since pagamentos are a
              // subcollection keyed by pedidoId. Match the sibling create-mode
              // empty states (Estoque / Estado / Incidentes) — NOT PlaceholderTab,
              // which wrongly reads "em breve, use o app antigo".
              <Text c="dimmed" size="sm">
                Salve o pedido para registrar pagamentos.
              </Text>
            )}
          </Tabs.Panel>

          {visibleTabs.has('link-pgto') && (
            <Tabs.Panel value="link-pgto" pt="md">
              <PlaceholderTab name="Link de pagamento" />
            </Tabs.Panel>
          )}

          {visibleTabs.has('incidentes') && (
            <Tabs.Panel value="incidentes" pt="md">
              <IncidentesTab
                pedidoId={pedidoId}
                disabled={disabled}
                // ⚠️ The ML claim lives on the account the pedido came through.
                // Absent for a pedido with no integração, which is exactly when
                // the panel must not render.
                integracaoId={
                  defaultValues?.integracaoPedidoOuterRef
                    ? idFromRef(defaultValues.integracaoPedidoOuterRef)
                    : null
                }
              />
            </Tabs.Panel>
          )}

          {visibleTabs.has('devolucao') && (
            <Tabs.Panel value="devolucao" pt="md">
              {dadosGeraisLockNotice && (
                <Alert color="yellow" icon={<IconLock size={16} />} mb="md">
                  {dadosGeraisLockNotice}
                </Alert>
              )}
              <DevolucaoTab
                form={form}
                db={db}
                disabled={dadosGeraisDisabled}
                pedidoId={pedidoId}
              />
            </Tabs.Panel>
          )}

          {visibleTabs.has('checkout') && (
            <Tabs.Panel value="checkout" pt="md">
              <CheckoutTab pedidoId={pedidoId} />
            </Tabs.Panel>
          )}

          <Tabs.Panel value="estado" pt="md">
            <EstadoHistoricoTab form={form} disabled={disabled} pedidoId={pedidoId} />
          </Tabs.Panel>

          <Tabs.Panel value="estoque" pt="md">
            <EstoqueSyncTab pedidoId={pedidoId} />
          </Tabs.Panel>

          <Tabs.Panel value="modificacoes" pt="md">
            <ModificacoesTab pedidoId={pedidoId} />
          </Tabs.Panel>
        </Tabs>
      </div>

      <PedidoFooter
        form={form}
        db={db}
        pedidoId={pedidoId}
        canWrite={canWrite}
        disabled={disabled}
        descontoDisabled={dadosGeraisDisabled}
        submitLabel={submitLabel}
        isSubmitting={form.formState.isSubmitting}
        submitError={submitError}
        ehSaida={!isEntrada}
        onSaveAndContinue={
          pedidoId
            ? form.handleSubmit((values) => handleSubmit(values, true), onInvalid)
            : undefined
        }
      />
    </form>
  );
}
