import { roundReais } from '@delfrance/core/money';
import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  cartaoSchema,
  chequeSchema,
  isPagamentoPagante,
  sumPagamentosPagos,
  type FormaPagamento,
  type Pagamento,
  type StatusPagamento,
} from '@delfrance/schemas';

// Re-exported so the existing pagamento consumers (PagamentosSection, the
// footer, this file's test) keep importing it from here; the rule itself now
// lives in @delfrance/schemas so the client + admin estado reconciles share one
// definition of "how much is paid".
export { sumPagamentosPagos };

/**
 * Flat form state for the Pagamento editor. Enum-coded fields are kept as the
 * Mantine `Select` string values (`status` is `''` until picked); the pure
 * builders below coerce them back to the wire types. Keeping this UI-agnostic
 * lets `PagamentoForm.test.ts` exercise the save logic without React. Mirrors
 * `tabs/incidenteForm.ts`.
 */
export interface PagamentoFormState {
  /** `FormaPagamento` int as a string. */
  forma: string;
  /** `StatusPagamento` int as a string; `''` = no status. */
  status: string;
  /** Amount in reais; `null` until typed. */
  valor: number | null;
  parcelas: number;
  descricao: string;
  /** Due date, µs epoch. */
  vencimento: number | null;
  aVista: boolean;
  duplicata: boolean;
  nFat: string;

  // Card detail (cartão crédito/débito) → written to `pagamento.cartao`.
  /** `Bandeira` code ('01'..'99'); `''` = none picked. */
  bandeira: string;
  numeroCartao: string;
  cAut: string;

  // Cheque detail → written to `pagamento.cheque`.
  banco: string;
  agencia: string;
  conta: string;
  /** Cheque number; kept as a string in the form, coerced to int on save. */
  numeroCheque: string;
  titular: string;
  cpfCnpj: string;
  telefone: string;
  /** "Bom para" date, µs epoch. */
  bomPara: number | null;
}

export const EMPTY_PAGAMENTO_FORM: PagamentoFormState = {
  forma: String(FORMA_PAGAMENTO.dinheiro),
  // New payments default to "aprovado" — most are entered after the fact,
  // already settled (the page model's payment-vs-total check only counts
  // aprovado payments). The user can still change it before saving.
  status: String(STATUS_PAGAMENTO.aprovado),
  valor: null,
  parcelas: 1,
  descricao: '',
  vencimento: null,
  aVista: true,
  duplicata: false,
  nFat: '',
  bandeira: '',
  numeroCartao: '',
  cAut: '',
  banco: '',
  agencia: '',
  conta: '',
  numeroCheque: '',
  titular: '',
  cpfCnpj: '',
  telefone: '',
  bomPara: null,
};

/** Populate the form from an existing pagamento doc (edit mode). The embedded
 * `cartao` / `cheque` maps are opaque (`z.unknown()`) on the doc, so parse them
 * leniently — a missing or legacy-shaped object just yields empty fields. */
export function formFromPagamento(p: Pagamento): PagamentoFormState {
  const cartao = cartaoSchema.safeParse(p.cartao);
  const cheque = chequeSchema.safeParse(p.cheque);
  return {
    forma: String(p.forma_de_pagamento),
    status: p.status_pagamento != null ? String(p.status_pagamento) : '',
    valor: p.valor,
    parcelas: p.parcelas,
    descricao: p.descricaoPagamento ?? '',
    vencimento: p.vencimento ?? null,
    aVista: p.aVista,
    duplicata: p.duplicata,
    nFat: p.nFat ?? '',
    bandeira: cartao.success ? (cartao.data.bandeira ?? '') : '',
    numeroCartao: cartao.success ? (cartao.data.numeroCartao ?? '') : '',
    cAut: cartao.success ? (cartao.data.cAut ?? '') : '',
    banco: cheque.success ? (cheque.data.banco ?? '') : '',
    agencia: cheque.success ? (cheque.data.agencia ?? '') : '',
    conta: cheque.success ? (cheque.data.conta ?? '') : '',
    numeroCheque: cheque.success && cheque.data.numero != null ? String(cheque.data.numero) : '',
    titular: cheque.success ? (cheque.data.titular ?? '') : '',
    cpfCnpj: cheque.success ? (cheque.data.cpf_cnpj ?? '') : '',
    telefone: cheque.success ? (cheque.data.telefone ?? '') : '',
    bomPara: cheque.success ? (cheque.data.bomPara ?? null) : null,
  };
}

/** Empty (or whitespace-only) → null; otherwise the trimmed value. */
function trimToNull(s: string): string | null {
  const trimmed = s.trim();
  return trimmed === '' ? null : trimmed;
}

/** Which optional fields/sections the form shows for each forma. Always shown:
 * forma, status, valor, descrição. `cartao` toggles the card-detail group
 * (bandeira/número/autorização); `cheque` toggles the cheque-detail group. */
export interface PagamentoFieldVisibility {
  parcelas: boolean;
  vencimento: boolean;
  nFat: boolean;
  duplicata: boolean;
  aVista: boolean;
  cartao: boolean;
  cheque: boolean;
}

export function pagamentoFieldVisibility(forma: string): PagamentoFieldVisibility {
  const f = Number(forma);
  const cartaoCredito = f === FORMA_PAGAMENTO.cartao_credito;
  const cartaoDebito = f === FORMA_PAGAMENTO.cartao_debito;
  const creditoLoja = f === FORMA_PAGAMENTO.credito_loja;
  const boleto = f === FORMA_PAGAMENTO.boleto_bancario;
  const cheque = f === FORMA_PAGAMENTO.cheque;
  const deposito = f === FORMA_PAGAMENTO.deposito_bancario;
  return {
    parcelas: cartaoCredito || creditoLoja,
    aVista: cartaoCredito || cartaoDebito || creditoLoja,
    // Cheque has its own "Bom para" date in the cheque group, so it doesn't also
    // show the generic vencimento.
    vencimento: boleto || deposito,
    nFat: boleto,
    duplicata: boleto,
    cartao: cartaoCredito || cartaoDebito,
    cheque,
  };
}

export interface PagamentoSummary {
  id: string;
  valor: number;
  status_pagamento?: number | null;
}

/**
 * The amount still owed so the pedido becomes fully paid: the pedido total minus
 * the sum of the OTHER {@link isPagamentoPagante} payments (excluding the one
 * being edited). Never negative. Drives the Valor autofill.
 */
export function remainingToPay(
  pedidoTotal: number,
  pagamentos: ReadonlyArray<PagamentoSummary>,
  editingId: string | null,
): number {
  const covered = pagamentos
    .filter((p) => p.id !== editingId && isPagamentoPagante(p.status_pagamento))
    .reduce((sum, p) => sum + (p.valor ?? 0), 0);
  return Math.max(0, roundReais(pedidoTotal - covered));
}

/**
 * Validate the form before `savePagamento` so the Zod converter never sees an
 * invalid pagamento (which would throw an uncaught `ZodError`). `valor` must be a
 * number ≥ 0 (`pagamentoSchema` is `min(0)`); `parcelas` ≥ 1. Returns a
 * user-facing message, or `null` when valid.
 */
export function validatePagamentoForm(form: PagamentoFormState): string | null {
  if (form.valor == null || form.valor < 0) return 'Informe um valor válido.';
  if (!Number.isInteger(form.parcelas) || form.parcelas < 1)
    return 'As parcelas devem ser ao menos 1.';
  // Forma "Outros" (tPag=99) requires a description — SEFAZ rejects an NF-e
  // without `<xPag>` (cStat 441).
  if (form.forma === String(FORMA_PAGAMENTO.outros) && !form.descricao.trim())
    return 'Descrição é obrigatória para a forma "Outros".';
  return null;
}

/** Narrow an opaque (`z.unknown()`) value to a plain object for spreading; any
 * non-object (null, array, primitive) yields `{}`. */
function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Build the embedded `cartao` map from the form (card formas only). Spreads any
 * existing card first so the catalog-derived fields (`tarifa`, `tarifaFixa`,
 * `cnpj_instituicao`, `prazoRecebimento`) survive untouched, then overrides the
 * editable fields. `tpIntegra` stays `'2'` (não integrado) unless the base set it.
 */
function buildCartao(form: PagamentoFormState, base: Pagamento | null): Record<string, unknown> {
  return {
    tpIntegra: '2',
    ...asRecord(base?.cartao),
    bandeira: form.bandeira === '' ? null : form.bandeira,
    numeroCartao: trimToNull(form.numeroCartao),
    cAut: trimToNull(form.cAut),
  };
}

/** Build the embedded `cheque` map from the form (cheque forma only). */
function buildCheque(form: PagamentoFormState, base: Pagamento | null): Record<string, unknown> {
  const numeroStr = form.numeroCheque.trim();
  const numero = Number(numeroStr);
  return {
    ...asRecord(base?.cheque),
    banco: trimToNull(form.banco),
    agencia: trimToNull(form.agencia),
    conta: trimToNull(form.conta),
    numero: numeroStr === '' || !Number.isFinite(numero) ? null : Math.trunc(numero),
    titular: trimToNull(form.titular),
    cpf_cnpj: trimToNull(form.cpfCnpj),
    telefone: trimToNull(form.telefone),
    bomPara: form.bomPara,
  };
}

/**
 * Build the full pagamento record handed to `savePagamento`. Spreads the existing
 * doc first so the passthrough/out-of-band fields (`metodoPagamentoOuterRef`,
 * `dataCadastro`, `dataAprovacao`, …) survive, then overrides the edited fields.
 * The `cartao` / `cheque` maps are rebuilt for their forma (and reset to `null`
 * otherwise). Assumes the form passed {@link validatePagamentoForm}.
 */
export function pagamentoDataFromForm(
  form: PagamentoFormState,
  base: Pagamento | null,
): Record<string, unknown> {
  // Fields hidden for the chosen forma are reset to their defaults so a forma
  // switch never persists a stale value (e.g. parcelas left from a card payment).
  const vis = pagamentoFieldVisibility(form.forma);
  const duplicata = vis.duplicata ? form.duplicata : false;
  return {
    ...((base as unknown as Record<string, unknown>) ?? {}),
    forma_de_pagamento: Number(form.forma) as FormaPagamento,
    status_pagamento: form.status === '' ? null : (Number(form.status) as StatusPagamento),
    valor: form.valor ?? 0,
    parcelas: vis.parcelas ? form.parcelas : 1,
    descricaoPagamento: trimToNull(form.descricao),
    vencimento: vis.vencimento ? form.vencimento : null,
    // A duplicata is by definition a prazo. The aVista switch is hidden for
    // boleto (the only forma where duplicata is settable), so falling back to
    // `true` here would store the contradiction `aVista: true, duplicata: true`
    // — which every consumer (NF-e indPag, financeiro) would have to re-correct.
    aVista: vis.aVista ? form.aVista : !duplicata,
    duplicata,
    nFat: vis.nFat ? trimToNull(form.nFat) : null,
    cartao: vis.cartao ? buildCartao(form, base) : null,
    cheque: vis.cheque ? buildCheque(form, base) : null,
  };
}
