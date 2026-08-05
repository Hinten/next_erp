'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  NumberInput,
  Select,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { IconCash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { getDoc } from 'firebase/firestore';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { deletePagamento, saveChequeSplit, savePagamento } from '@delfrance/data/pedido';
import {
  BANDEIRA_LABELS,
  ESTADO_PEDIDO_LABELS,
  FORMA_PAGAMENTO,
  FORMA_PAGAMENTO_LABELS,
  STATUS_PAGAMENTO_LABELS,
  bandeiraCartaoSchema,
  pagamentoInesperado,
  type Bandeira,
  type EstadoPedido,
  type FormaPagamento,
  type Pagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';
import { epochToPickerString, pickerStringToEpoch } from '@delfrance/ui';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { pagamentoCollection } from '@/lib/data/pagamentoCollection';
import { bandeiraCartaoCollection } from '@/lib/data/bandeiraCartaoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { callReconciliarPagamentoPedido, createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { CurrencyInput } from '@/app/(app)/produtos/_components/CurrencyInput';
import { PagamentoStatusBadge } from '../../pagamentos/_components/StatusBadge';
import { gatewayIdFromTipo, getGateway } from '@/lib/plugins/paymentRegistry';
import {
  EMPTY_PAGAMENTO_FORM,
  buildChequeSplitPagamentos,
  formFromPagamento,
  isChequeSplit,
  pagamentoDataFromForm,
  pagamentoFieldVisibility,
  remainingToPay,
  validatePagamentoForm,
  type PagamentoFormState,
} from './PagamentoForm';

const brl = (n: number): string => formatReais(n);

/** Fixed toast id so overlapping reconcile failures reuse one notification. */
const RECONCILE_ERROR_ID = 'pedido-reconcile-falhou';

const formaOptions = (Object.entries(FORMA_PAGAMENTO_LABELS) as [string, string][]).map(
  ([value, label]) => ({ value, label }),
);
const statusOptions = [
  { value: '', label: '(nenhum)' },
  ...(Object.entries(STATUS_PAGAMENTO_LABELS) as [string, string][]).map(([value, label]) => ({
    value,
    label,
  })),
];
const INTERVALO_OPTIONS = [
  { value: 'dias', label: 'Dias' },
  { value: 'meses', label: 'Meses' },
];

/**
 * Editable list of pagamentos for a pedido — create / edit / delete plus the
 * inline status change. Immediate writes go through `savePagamento` /
 * `deletePagamento` (the use-case layer), mirroring the Incidentes tab. The card
 * (bandeira/número/autorização) and cheque detail groups are editable per forma.
 * Bandeira is picked from the `bandeirasCartao` catalog (filtered by
 * `ehCredito`), which auto-fills the catalog fields (tarifa/prazo/CNPJ) and
 * clamps parcelas to the pick's `maxParcelas`; the Mercado Pago link stays
 * pass-through. A cheque payment being ADDED with `parcelas > 1` fans out into
 * one pagamento per installment (`buildChequeSplitPagamentos` /
 * `saveChequeSplit`) instead of a single multi-parcela doc. Refunds still
 * resolve via the PaymentGateway plugin registry.
 */
export function PagamentosSection({
  pedidoId,
  disabled,
  estado,
  pedidoTotal = 0,
}: {
  pedidoId: string;
  disabled?: boolean;
  /** Live pedido estado — drives the soft "unexpected payment" warning. */
  estado?: EstadoPedido;
  /** Pedido charged total (`valorCobrado`) — drives the "valor restante" autofill. */
  pedidoTotal?: number;
}) {
  const q = useMemo(() => {
    const base = pagamentoCollection.ref(getFirebaseFirestore(), { pedidoId });
    return buildQuery(base, [orderByField('dataCadastro', 'desc')]);
  }, [pedidoId]);
  const { data, loading, error } = useSnapshot<Pagamento>(q);

  // null = form closed; { id: null } = adding; { id, base } = editing an existing doc.
  const [editing, setEditing] = useState<{ id: string | null; base: Pagamento | null } | null>(
    null,
  );
  const [form, setForm] = useState<PagamentoFormState>(EMPTY_PAGAMENTO_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  // Reconciles can overlap (e.g. flipping the status on two rows in quick
  // succession), so the indicator is refcounted — a boolean would be cleared by
  // whichever call settles FIRST, hiding the spinner while another is in flight.
  const reconcilesEmVoo = useRef(0);
  // The most recently REQUESTED bandeira pick — guards the async getDoc below
  // against resolving out of order (a slow first pick landing after a faster
  // second one would otherwise overwrite the newer catalog fields with stale
  // ones).
  const latestBandeiraPick = useRef<string | null>(null);

  // On a `bandeirasCartao` pick, fetch the catalog doc once and fold its fields
  // into the form (`bandeira` + tarifa/tarifaFixa/prazoRecebimento/CNPJ), clamping
  // parcelas to the pick's `maxParcelas`. A clear (`next === null`) just drops the
  // ref — the last-resolved catalog fields are left as-is (same "preserved"
  // semantics as an untouched existing card).
  async function handleBandeiraPick(next: unknown) {
    const ref = typeof next === 'string' ? next : null;
    latestBandeiraPick.current = ref;
    setForm((f) => ({ ...f, bandeiraCartaoRef: ref }));
    if (ref === null) return;
    const docRef = dereferenceOuterRef(getFirebaseFirestore(), ref);
    if (!docRef) return;
    try {
      const snap = await getDoc(docRef);
      // A newer pick superseded this one while the fetch was in flight — drop
      // this (stale) result instead of clobbering the newer catalog fields.
      if (latestBandeiraPick.current !== ref) return;
      const parsed = bandeiraCartaoSchema.safeParse(snap.data());
      if (!parsed.success) return;
      const catalog = parsed.data;
      setForm((f) => ({
        ...f,
        bandeira: catalog.bandeira ?? '',
        cnpjInstituicao: catalog.cnpj_instituicao,
        tarifa: catalog.tarifa,
        tarifaFixa: catalog.tarifaFixa,
        prazoRecebimento: catalog.prazoRecebimento,
        parcelas: Math.min(f.parcelas, catalog.maxParcelas),
      }));
    } catch (err) {
      // The caller fires this fire-and-forget (`void handleBandeiraPick(...)`),
      // so an uncaught rejection here would be a silent, unreported failure —
      // surface it instead of leaving the picker stuck with no explanation.
      if (!(err instanceof FirebaseError)) throw err;
      notifications.show({
        color: 'red',
        title: 'Falha ao carregar a bandeira selecionada',
        message: err.message,
      });
    }
  }

  // Auto-estado transition (legacy `cadastroPedidoProvider`): after every pagamento
  // mutation the server-owned `reconciliarPagamentoPedido` callable re-sums the
  // payments and advances/downgrades the pedido `estado` (→ pago / aguardando). The
  // `historicoEstadoPedido` row follows from the `onPedidoEstadoChanged` trigger
  // observing that write. It reads the pedido AND every pagamento in ONE Admin-SDK
  // transaction (#308) — the client SDK can't query inside a transaction, so the old
  // client-side sum raced across tabs/sessions.
  //
  // Best-effort: the pagamento itself is already committed, so a failed reconcile must
  // not surface as a save error — but it IS surfaced loudly, because the estado is now
  // genuinely stale and only a human can settle it. `functions/not-found` in particular
  // means the callable was never deployed (deploy is manual — apps/functions/CLAUDE.md).
  async function reconcileEstado() {
    reconcilesEmVoo.current += 1;
    setReconciling(true);
    try {
      await callReconciliarPagamentoPedido(pedidoId);
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
      console.error('reconciliarPagamentoPedido falhou', err);
      // Mantine IGNORES a `show` whose id is already mounted — it does not replace
      // it — so hide first. Otherwise a second failure inside the autoClose window
      // renders NOTHING, and back-to-back failures are exactly what a missing
      // deploy produces.
      notifications.hide(RECONCILE_ERROR_ID);
      notifications.show({
        id: RECONCILE_ERROR_ID,
        color: 'red',
        title: 'Estado do pedido não atualizado',
        message: `A alteração no pagamento foi gravada, mas o estado do pedido não pôde ser recalculado (${err.code}). Ajuste o estado manualmente na aba Estado/Histórico.`,
        autoClose: 8000,
      });
    } finally {
      reconcilesEmVoo.current -= 1;
      if (reconcilesEmVoo.current === 0) setReconciling(false);
    }
  }

  function openAdd() {
    setForm(EMPTY_PAGAMENTO_FORM);
    setEditing({ id: null, base: null });
    setSaveError(null);
  }
  function openEdit(id: string, pagamento: Pagamento) {
    setForm(formFromPagamento(pagamento));
    setEditing({ id, base: pagamento });
    setSaveError(null);
  }

  async function handleSave() {
    if (!editing) return;
    const validationError = validatePagamentoForm(form);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const port = createClientPedidoPort(getFirebaseFirestore());
      if (isChequeSplit(form, editing.id)) {
        await saveChequeSplit(port, {
          pedidoId,
          pagamentos: buildChequeSplitPagamentos(form, editing.base),
        });
      } else {
        await savePagamento(port, {
          pedidoId,
          pagamentoId: editing.id,
          pagamento: pagamentoDataFromForm(form, editing.base),
        });
      }
      setEditing(null);
      await reconcileEstado();
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSaveError(err.message);
        return;
      }
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePagamento(createClientPedidoPort(getFirebaseFirestore()), {
        pedidoId,
        pagamentoId: deleteTarget,
      });
      setDeleteTarget(null);
      await reconcileEstado();
    } catch (err) {
      if (err instanceof FirebaseError) {
        // `deleteTarget` is only cleared on success, so the confirm modal stays
        // open and the user can retry or cancel.
        notifications.show({
          color: 'red',
          title: 'Falha ao excluir o pagamento',
          message: err.message,
        });
        return;
      }
      throw err;
    } finally {
      setDeleting(false);
    }
  }

  // Which optional fields to show for the chosen forma, and how much is still
  // owed (drives the Valor autofill — excludes the payment being edited).
  const vis = pagamentoFieldVisibility(form.forma);
  const remaining = remainingToPay(
    pedidoTotal,
    (data ?? []).map(({ id, data: p }) => ({
      id,
      valor: p.valor,
      status_pagamento: p.status_pagamento,
    })),
    editing?.id ?? null,
  );

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Group gap="xs" align="center">
          <Title order={3}>Pagamentos</Title>
          {/* `handleSave` / `handleDelete` close their own form/modal before awaiting
              the reconcile, so this shared indicator is what covers all three call
              sites (add, edit, delete, inline status change). */}
          {reconciling && (
            <Group gap={6} c="dimmed">
              <Loader size="xs" />
              <Text size="xs">Atualizando o estado do pedido…</Text>
            </Group>
          )}
        </Group>
        {!editing && (
          <Button size="xs" onClick={openAdd} disabled={disabled || reconciling}>
            + Adicionar pagamento
          </Button>
        )}
      </Group>

      {editing && (
        <Card withBorder>
          <Stack gap="sm">
            <Text fw={500}>{editing.id ? 'Editar pagamento' : 'Novo pagamento'}</Text>
            {editing.id === null && estado && pagamentoInesperado(estado) && (
              <Alert color="yellow">
                Este pedido já está &quot;{ESTADO_PEDIDO_LABELS[estado]}&quot; — registrar um novo
                pagamento é incomum e pode gerar excedente/troco. Prossiga apenas se for
                intencional.
              </Alert>
            )}
            <Group grow align="flex-start">
              <Select
                label="Forma de pagamento"
                data={formaOptions}
                value={form.forma}
                onChange={(v) =>
                  // Clear the resolved bandeira + catalog fields on forma change,
                  // not just the picker's ref — a crédito pick filtered by
                  // ehCredito:true would otherwise still get PERSISTED after
                  // switching to débito (and vice-versa), even though the picker
                  // itself visually cleared.
                  v &&
                  setForm((f) => ({
                    ...f,
                    forma: v,
                    bandeiraCartaoRef: null,
                    bandeira: '',
                    cnpjInstituicao: null,
                    tarifa: null,
                    tarifaFixa: null,
                    prazoRecebimento: null,
                  }))
                }
                allowDeselect={false}
                searchable
                nothingFoundMessage="Nenhuma forma encontrada"
                disabled={disabled}
              />
              <Select
                label="Status"
                data={statusOptions}
                value={form.status}
                onChange={(v) => setForm((f) => ({ ...f, status: v ?? '' }))}
                disabled={disabled}
              />
            </Group>
            <Group grow align="flex-start">
              <CurrencyInput
                label="Valor"
                value={form.valor}
                onChange={(n) => setForm((f) => ({ ...f, valor: n }))}
                disabled={disabled}
                rightSection={
                  <Tooltip label={`Preencher com o valor restante (${brl(remaining)})`} withArrow>
                    <ActionIcon
                      variant="subtle"
                      aria-label="Preencher com o valor restante"
                      disabled={disabled || remaining <= 0}
                      onClick={() => setForm((f) => ({ ...f, valor: remaining }))}
                    >
                      <IconCash size={16} />
                    </ActionIcon>
                  </Tooltip>
                }
              />
              {vis.parcelas && (
                <NumberInput
                  label="Parcelas"
                  value={form.parcelas}
                  onChange={(v) => {
                    const n = typeof v === 'number' ? v : Number(v);
                    setForm((f) => ({
                      ...f,
                      parcelas: Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1,
                    }));
                  }}
                  min={1}
                  allowDecimal={false}
                  clampBehavior="strict"
                  disabled={disabled}
                />
              )}
            </Group>
            {vis.cartao && (
              <>
                <Group grow align="flex-start">
                  <CollectionSelect
                    collection={bandeiraCartaoCollection}
                    labelField="nome"
                    fieldName="pagamento-bandeira"
                    label="Bandeira"
                    hint="Preenche tarifa, prazo de recebimento e CNPJ automaticamente."
                    value={form.bandeiraCartaoRef}
                    onChange={(next) => void handleBandeiraPick(next)}
                    filters={[
                      {
                        field: 'ehCredito',
                        op: 'eq',
                        value: Number(form.forma) === FORMA_PAGAMENTO.cartao_credito,
                      },
                    ]}
                    disabled={disabled}
                  />
                  <TextInput
                    label="Número do cartão"
                    maxLength={19}
                    value={form.numeroCartao}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, numeroCartao: value }));
                    }}
                    disabled={disabled}
                  />
                  <TextInput
                    label="Cód. de autorização"
                    value={form.cAut}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, cAut: value }));
                    }}
                    disabled={disabled}
                  />
                </Group>
                {form.bandeiraCartaoRef === null && form.bandeira !== '' && (
                  <Text size="xs" c="dimmed">
                    Bandeira atual: {BANDEIRA_LABELS[form.bandeira as Bandeira] ?? form.bandeira}{' '}
                    (tarifa, prazo e CNPJ preservados do cadastro anterior). Selecione uma bandeira
                    acima para substituir.
                  </Text>
                )}
              </>
            )}
            {vis.cheque && (
              <Stack gap="sm">
                <Group grow align="flex-start">
                  <TextInput
                    label="Banco"
                    value={form.banco}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, banco: value }));
                    }}
                    disabled={disabled}
                  />
                  <TextInput
                    label="Agência"
                    value={form.agencia}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, agencia: value }));
                    }}
                    disabled={disabled}
                  />
                  <TextInput
                    label="Conta"
                    value={form.conta}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, conta: value }));
                    }}
                    disabled={disabled}
                  />
                </Group>
                <Group grow align="flex-start">
                  <NumberInput
                    label="Número do cheque"
                    value={form.numeroCheque === '' ? '' : Number(form.numeroCheque)}
                    onChange={(v) => {
                      const s = v === '' || v == null ? '' : String(v);
                      setForm((f) => ({ ...f, numeroCheque: s }));
                    }}
                    allowDecimal={false}
                    allowNegative={false}
                    hideControls
                    disabled={disabled}
                  />
                  <TextInput
                    label="Titular"
                    maxLength={255}
                    value={form.titular}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, titular: value }));
                    }}
                    disabled={disabled}
                  />
                </Group>
                <Group grow align="flex-start">
                  <TextInput
                    label="CPF/CNPJ"
                    maxLength={18}
                    value={form.cpfCnpj}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, cpfCnpj: value }));
                    }}
                    disabled={disabled}
                  />
                  <TextInput
                    label="Telefone"
                    maxLength={16}
                    value={form.telefone}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, telefone: value }));
                    }}
                    disabled={disabled}
                  />
                </Group>
                <DateTimePicker
                  label="Bom para"
                  value={epochToPickerString(form.bomPara, 'us')}
                  onChange={(v) =>
                    setForm((f) => ({ ...f, bomPara: pickerStringToEpoch(v, 'us') }))
                  }
                  valueFormat="DD/MM/YYYY HH:mm"
                  clearable
                  disabled={disabled}
                />
                {/* Split only applies to a NEW cheque payment (legacy
                    `_adicionarCheques`) — editing an existing one just updates its
                    own parcelas count, it doesn't fan out more docs. */}
                {form.parcelas > 1 && editing?.id === null && (
                  <>
                    <Group grow align="flex-start">
                      <Select
                        label="Intervalo entre os cheques"
                        data={INTERVALO_OPTIONS}
                        value={form.intervalo}
                        onChange={(v) =>
                          v &&
                          setForm((f) => ({
                            ...f,
                            intervalo: v as PagamentoFormState['intervalo'],
                          }))
                        }
                        allowDeselect={false}
                        disabled={disabled}
                      />
                      <NumberInput
                        label={
                          form.intervalo === 'dias' ? 'A cada quantos dias' : 'A cada quantos meses'
                        }
                        value={form.quantidadeIntervalo}
                        onChange={(v) => {
                          const n = typeof v === 'number' ? v : Number(v);
                          setForm((f) => ({
                            ...f,
                            quantidadeIntervalo: Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1,
                          }));
                        }}
                        min={1}
                        allowDecimal={false}
                        clampBehavior="strict"
                        disabled={disabled}
                      />
                    </Group>
                    <Text size="xs" c="dimmed">
                      Ao adicionar, {form.parcelas} pagamentos de cheque serão gerados — um por
                      parcela, com &quot;bom para&quot; espaçados pelo intervalo acima.
                    </Text>
                  </>
                )}
              </Stack>
            )}
            {(vis.vencimento || vis.nFat) && (
              <Group grow align="flex-start">
                {vis.vencimento && (
                  <DateTimePicker
                    label="Vencimento"
                    value={epochToPickerString(form.vencimento, 'us')}
                    onChange={(v) =>
                      setForm((f) => ({ ...f, vencimento: pickerStringToEpoch(v, 'us') }))
                    }
                    valueFormat="DD/MM/YYYY HH:mm"
                    clearable
                    disabled={disabled}
                  />
                )}
                {vis.nFat && (
                  <TextInput
                    label="Nº fatura/duplicata"
                    maxLength={60}
                    value={form.nFat}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setForm((f) => ({ ...f, nFat: value }));
                    }}
                    disabled={disabled}
                  />
                )}
              </Group>
            )}
            <TextInput
              label="Descrição"
              value={form.descricao}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setForm((f) => ({ ...f, descricao: value }));
              }}
              disabled={disabled}
              // Required for forma "Outros" (tPag=99) — SEFAZ cStat 441.
              withAsterisk={form.forma === String(FORMA_PAGAMENTO.outros)}
              error={
                form.forma === String(FORMA_PAGAMENTO.outros) && !form.descricao.trim()
                  ? 'Obrigatória para a forma "Outros".'
                  : undefined
              }
            />
            {(vis.aVista || vis.duplicata) && (
              <Group>
                {vis.aVista && (
                  <Switch
                    label="À vista"
                    checked={form.aVista}
                    onChange={(e) => setForm((f) => ({ ...f, aVista: e.currentTarget.checked }))}
                    disabled={disabled}
                  />
                )}
                {vis.duplicata && (
                  <Switch
                    label="Duplicata"
                    checked={form.duplicata}
                    onChange={(e) => setForm((f) => ({ ...f, duplicata: e.currentTarget.checked }))}
                    disabled={disabled}
                  />
                )}
              </Group>
            )}
            {saveError && <Alert color="red">{saveError}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEditing(null)} disabled={saving}>
                Cancelar
              </Button>
              <Button onClick={handleSave} loading={saving} disabled={disabled} color="green">
                {editing.id ? 'Salvar alterações' : 'Adicionar'}
              </Button>
            </Group>
          </Stack>
        </Card>
      )}

      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={64} />}
      {!loading && data && data.length === 0 && (
        <Text c="dimmed">Nenhum pagamento registrado neste pedido.</Text>
      )}
      {!loading && data && data.length > 0 && (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Status</Table.Th>
              <Table.Th>Forma</Table.Th>
              <Table.Th align="right">Valor</Table.Th>
              <Table.Th align="right">Parcelas</Table.Th>
              <Table.Th>Ações</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.map(({ id, data: pgto }) => (
              <PagamentoRow
                key={id}
                pedidoId={pedidoId}
                id={id}
                pagamento={pgto}
                disabled={disabled}
                onEdit={() => openEdit(id, pgto)}
                onDelete={() => setDeleteTarget(id)}
                onAfterChange={reconcileEstado}
              />
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Excluir pagamento"
        centered
      >
        <Stack>
          <Text>Tem certeza que deseja excluir este pagamento?</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button color="red" onClick={handleDelete} loading={deleting}>
              Excluir
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function PagamentoRow({
  pedidoId,
  id,
  pagamento,
  disabled,
  onEdit,
  onDelete,
  onAfterChange,
}: {
  pedidoId: string;
  id: string;
  pagamento: Pagamento;
  disabled?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** Re-run the pedido estado reconcile after an inline status change. */
  onAfterChange: () => Promise<void>;
}) {
  const [savingStatus, setSavingStatus] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  // Resolve a configured gateway for this pagamento: dereference its
  // `metodoPagamentoOuterRef` (a `documents/metodo_pgto/<id>` doc-path string) to
  // the integration doc and read its `tipo`. Only runs when set (most are null).
  // Today the registry has no implementations, so the refund button stays disabled.
  const db = getFirebaseFirestore();
  const metodoRef = useMemo(
    () => dereferenceOuterRef(db, pagamento.metodoPagamentoOuterRef),
    [db, pagamento.metodoPagamentoOuterRef],
  );
  const { data: metodo } = useQuery({
    queryKey: ['metodoPgto', metodoRef?.path ?? null],
    enabled: metodoRef != null,
    queryFn: async () => {
      const snap = await getDoc(metodoRef!);
      return snap.exists() ? (snap.data() as { tipo?: number }) : null;
    },
  });
  const gatewayId = metodo?.tipo != null ? gatewayIdFromTipo(metodo.tipo) : null;
  const gateway = gatewayId ? getGateway(gatewayId) : null;

  async function handleStatusChange(next: string | null) {
    if (next === null) return;
    const nextStatus = Number(next) as StatusPagamento;
    if (nextStatus === pagamento.status_pagamento) return;
    setSavingStatus(true);
    try {
      await savePagamento(createClientPedidoPort(getFirebaseFirestore()), {
        pedidoId,
        pagamentoId: id,
        pagamento: { ...pagamento, status_pagamento: nextStatus },
      });
      await onAfterChange();
    } catch (err) {
      // Same shape as `handleDelete`: without this a rejected save escapes as an
      // unhandled rejection and the Select silently snaps back with no message.
      if (!(err instanceof FirebaseError)) throw err;
      notifications.show({
        color: 'red',
        title: 'Falha ao atualizar o status do pagamento',
        message: err.message,
      });
    } finally {
      setSavingStatus(false);
    }
  }

  async function handleRefund() {
    if (!gateway || !pagamento.id) return;
    setRefunding(true);
    setRefundError(null);
    try {
      await gateway.refund(pagamento.id);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setRefundError(err.message);
      } else {
        throw err;
      }
    } finally {
      setRefunding(false);
    }
  }

  return (
    <>
      <Table.Tr>
        <Table.Td>
          <Stack gap={4}>
            <PagamentoStatusBadge status={pagamento.status_pagamento ?? null} />
            <Select
              data={(Object.entries(STATUS_PAGAMENTO_LABELS) as [string, string][]).map(
                ([value, label]) => ({ value, label }),
              )}
              value={pagamento.status_pagamento != null ? String(pagamento.status_pagamento) : null}
              onChange={handleStatusChange}
              disabled={savingStatus || disabled}
              size="xs"
              w={220}
            />
          </Stack>
        </Table.Td>
        <Table.Td>
          {FORMA_PAGAMENTO_LABELS[pagamento.forma_de_pagamento as FormaPagamento] ?? '—'}
        </Table.Td>
        <Table.Td align="right">{formatReais(pagamento.valor)}</Table.Td>
        <Table.Td align="right">{pagamento.parcelas}</Table.Td>
        <Table.Td>
          <Group gap="xs">
            <Button size="xs" variant="light" onClick={onEdit} disabled={disabled}>
              Editar
            </Button>
            <Button size="xs" variant="light" color="red" onClick={onDelete} disabled={disabled}>
              Excluir
            </Button>
            <Tooltip
              label={gateway ? 'Estorna via gateway' : 'Plugin de gateway não registrado (Fase 5)'}
            >
              <Button
                size="xs"
                variant="light"
                color="orange"
                disabled={!gateway || !pagamento.id || disabled}
                loading={refunding}
                onClick={handleRefund}
              >
                Estornar
              </Button>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
      {refundError && (
        <Table.Tr>
          <Table.Td colSpan={5}>
            <Alert color="red">{refundError}</Alert>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}
