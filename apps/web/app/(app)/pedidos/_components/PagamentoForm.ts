import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  round2,
  type FormaPagamento,
  type Pagamento,
  type StatusPagamento,
} from '@delfrance/schemas';

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
}

export const EMPTY_PAGAMENTO_FORM: PagamentoFormState = {
  forma: String(FORMA_PAGAMENTO.dinheiro),
  status: '',
  valor: null,
  parcelas: 1,
  descricao: '',
  vencimento: null,
  aVista: true,
  duplicata: false,
  nFat: '',
};

/** Populate the form from an existing pagamento doc (edit mode). */
export function formFromPagamento(p: Pagamento): PagamentoFormState {
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
  };
}

/** Empty (or whitespace-only) → null; otherwise the trimmed value. */
function trimToNull(s: string): string | null {
  const trimmed = s.trim();
  return trimmed === '' ? null : trimmed;
}

/** Which optional fields the form shows for each forma. Always shown: forma,
 * status, valor, descrição. The cartão/cheque DETAIL fields stay deferred. */
export interface PagamentoFieldVisibility {
  parcelas: boolean;
  vencimento: boolean;
  nFat: boolean;
  duplicata: boolean;
  aVista: boolean;
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
    vencimento: cheque || boleto || deposito,
    nFat: boleto,
    duplicata: boleto,
  };
}

/** Payment statuses that do NOT count toward "paid" (refused/cancelled/refunded). */
const NON_PAYING_STATUS: ReadonlySet<number> = new Set([
  STATUS_PAGAMENTO.recusado,
  STATUS_PAGAMENTO.cancelado,
  STATUS_PAGAMENTO.estornado,
  STATUS_PAGAMENTO.devolvido,
  STATUS_PAGAMENTO.estornado_totalmente,
]);

export interface PagamentoSummary {
  id: string;
  valor: number;
  status_pagamento?: number | null;
}

/**
 * The amount still owed so the pedido becomes fully paid: the pedido total minus
 * the sum of the OTHER payments (excluding the one being edited and any
 * refused/cancelled/refunded status). Never negative. Drives the Valor autofill.
 */
export function remainingToPay(
  pedidoTotal: number,
  pagamentos: ReadonlyArray<PagamentoSummary>,
  editingId: string | null,
): number {
  const covered = pagamentos
    .filter((p) => p.id !== editingId && !NON_PAYING_STATUS.has(p.status_pagamento ?? -1))
    .reduce((sum, p) => sum + (p.valor ?? 0), 0);
  return Math.max(0, round2(pedidoTotal - covered));
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
  return null;
}

/**
 * Build the full pagamento record handed to `savePagamento`. Spreads the existing
 * doc first so the passthrough/out-of-band fields (`cartao`, `cheque`,
 * `metodoPagamentoOuterRef`, `dataCadastro`, `dataAprovacao`, …) survive, then
 * overrides the edited fields. Assumes the form passed {@link validatePagamentoForm}.
 */
export function pagamentoDataFromForm(
  form: PagamentoFormState,
  base: Pagamento | null,
): Record<string, unknown> {
  // Fields hidden for the chosen forma are reset to their defaults so a forma
  // switch never persists a stale value (e.g. parcelas left from a card payment).
  const vis = pagamentoFieldVisibility(form.forma);
  return {
    ...((base as unknown as Record<string, unknown>) ?? {}),
    forma_de_pagamento: Number(form.forma) as FormaPagamento,
    status_pagamento: form.status === '' ? null : (Number(form.status) as StatusPagamento),
    valor: form.valor ?? 0,
    parcelas: vis.parcelas ? form.parcelas : 1,
    descricaoPagamento: trimToNull(form.descricao),
    vencimento: vis.vencimento ? form.vencimento : null,
    aVista: vis.aVista ? form.aVista : true,
    duplicata: vis.duplicata ? form.duplicata : false,
    nFat: vis.nFat ? trimToNull(form.nFat) : null,
  };
}
