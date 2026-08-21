/**
 * Portuguese copy for Mercado Livre's claim vocabulary (#364).
 *
 * ⚠️ **Every lookup falls back to the raw ML value, never to a blank or a
 * guess.** ML adds vocabulary without notice, and on this screen an unknown
 * value must still be legible: an operator deciding whether to refund needs to
 * see `some_new_status` rather than an empty cell that reads as "nothing here".
 * That is also why none of these maps is exhaustive by type — a `Record` over a
 * closed union would force a parse failure the moment ML shipped a new word.
 */

/** What a party wants out of the claim (`expected_resolution`). */
const RESOLUCAO_ESPERADA: Record<string, string> = {
  refund: 'Devolver o dinheiro',
  product: 'Receber o produto',
  change_product: 'Trocar o produto',
  return_product: 'Devolver o produto e receber o dinheiro',
  partial_refund: 'Reembolso parcial',
};

/** Whether that expectation is still open. */
const STATUS_EXPECTATIVA: Record<string, string> = {
  pending: 'pendente',
  accepted: 'aceita',
  rejected: 'recusada',
};

/** Which side asked. */
const PAPEL: Record<string, string> = {
  complainant: 'Comprador',
  respondent: 'Você',
  mediator: 'Mediador do Mercado Livre',
};

/** The seller verbs, as a button reads them. */
const ACAO: Record<string, string> = {
  refund: 'Reembolsar integralmente',
  allow_partial_refund: 'Reembolso parcial…',
  allow_return: 'Aceitar devolução',
  allow_return_label: 'Aceitar devolução',
  open_dispute: 'Abrir mediação',
  send_message_to_complainant: 'Responder ao comprador',
  send_message_to_mediator: 'Responder ao mediador',
};

export function rotuloResolucaoEsperada(v: string | null): string {
  if (v == null || v === '') return '—';
  return RESOLUCAO_ESPERADA[v] ?? v;
}

export function rotuloStatusExpectativa(v: string | null): string {
  if (v == null || v === '') return '—';
  return STATUS_EXPECTATIVA[v] ?? v;
}

export function rotuloPapel(v: string | null): string {
  if (v == null || v === '') return '—';
  return PAPEL[v] ?? v;
}

export function rotuloAcao(v: string): string {
  return ACAO[v] ?? v;
}

/**
 * The one-line caption for a claim type.
 *
 * ⚠️ Descriptive only. It says what ML *tends* to offer for this claim family,
 * never what the seller may do — that is `acoesDisponiveis`, read live. Wording
 * it as a fact about the buyer keeps it from being read as a rule.
 */
export function legendaTipoReclamacao(tipo: 'PNR' | 'PDD' | null): string | null {
  if (tipo === 'PNR') {
    return 'Produto não recebido — normalmente o comprador espera o produto ou o dinheiro de volta.';
  }
  if (tipo === 'PDD') {
    return 'Produto com defeito ou diferente — normalmente resolve-se com devolução ou reembolso parcial.';
  }
  return null;
}

/**
 * A due date as the operator should read it.
 *
 * ⚠️ Renders in the browser's zone deliberately: this is a deadline a human acts
 * on, and the ERP's server zones (`America/Sao_Paulo` on nfe, UTC elsewhere) are
 * irrelevant to when they must click. Returns `null` for an unparseable value
 * rather than `Invalid Date`.
 */
export function formatarPrazo(iso: string | null): string | null {
  if (iso == null || iso === '') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
