/**
 * Portuguese copy for Shopee's returns vocabulary (#1525, step 17) — the ONE
 * label table the returns panel reads (#1369: two tables drift apart).
 *
 * ⚠️ **Every lookup is TOTAL: an unknown value comes back RAW, never blank and
 * never guessed.** Shopee adds vocabulary without notice (its reason list grew
 * to 32 in 2026, and two spellings of one reason coexist), and an operator
 * deciding whether to refund must see `SOME_NEW_STATUS` rather than an empty
 * cell that reads as "nothing here". An ABSENT value (`null` or `''`) renders
 * as an em dash, which is a different claim from "Shopee said something we
 * have no copy for", and the operator can tell the two apart.
 *
 * ⚠️ **Maps, not object literals.** Every key is a string off the wire, and
 * `'constructor'` or `'toString'` must not resolve to a function on
 * `Object.prototype` — the `EXTENSAO_DA_ETIQUETA` rule in `client.ts`.
 *
 * Nothing here is a GATE. A label explains a field; whether an action is
 * available is the backend's `acoesDisponiveis`, read live.
 */

/** The em dash for a genuinely absent value. */
const AUSENTE = '—';

function rotular(tabela: ReadonlyMap<string, string>, v: string | null | undefined): string {
  if (v == null || v === '') return AUSENTE;
  return tabela.get(v) ?? v;
}

/** `ReturnStatus` — the return's own lifecycle state. */
const STATUS_DEVOLUCAO: ReadonlyMap<string, string> = new Map([
  ['REQUESTED', 'solicitada'],
  ['PROCESSING', 'em processamento'],
  ['ACCEPTED', 'aceita'],
  ['SELLER_DISPUTE', 'em disputa pelo vendedor'],
  ['JUDGING', 'em análise pela Shopee'],
  ['CLOSED', 'encerrada'],
  ['CANCELLED', 'cancelada'],
]);

/** The solution as the backend normalised it — two members, never Shopee's int. */
const SOLUCAO_DEVOLUCAO: ReadonlyMap<string, string> = new Map([
  ['RETURN_REFUND', 'Devolução e reembolso'],
  ['REFUND', 'Apenas reembolso'],
]);

/**
 * `ReturnReason` (and `reassessed_request_reason`, the same value set).
 *
 * ⚠️ Shopee's two guides spell several reasons differently and BOTH reach the
 * API (`NOT_RECEIPT` on a detail, `NONRECEIPT` in the guide; `CHANGE_MIND` and
 * `CHANGE_OF_MIND`; the guide's own `MUITAL_AGREE` typo beside `MUTUAL_AGREE`),
 * so each spelling is its own row with the same label. A row per spelling, not
 * a normaliser: nothing here decides equality, and a typo fixed by a fold would
 * also "fix" a token Shopee meant differently.
 */
const MOTIVO_DEVOLUCAO: ReadonlyMap<string, string> = new Map([
  ['NONE', 'Sem motivo'],
  ['NO_REASON', 'Sem motivo informado'],
  ['NONRECEIPT', 'Produto não recebido'],
  ['NOT_RECEIPT', 'Produto não recebido'],
  ['WRONG_ITEM', 'Produto errado'],
  ['SELLER_SENT_WRONG_ITEM', 'O vendedor enviou o produto errado'],
  ['ITEM_DAMAGED', 'Produto danificado'],
  ['ITEM_WRONGDAMAGED', 'Produto errado ou danificado'],
  ['PHYSICAL_DMG', 'Dano físico'],
  ['FUNCTIONAL_DMG', 'Defeito de funcionamento'],
  ['BROKEN_PRODUCTS', 'Produto quebrado'],
  ['SCRATCHED', 'Produto arranhado'],
  ['DAMAGED_PACKAGE', 'Embalagem danificada'],
  ['DAMAGED_OTHERS', 'Outros danos'],
  ['SPILLED_CONTENTS', 'Conteúdo vazado'],
  ['SPOILED_ROTTEN', 'Produto estragado'],
  ['EXPIRED_PRODUCT', 'Produto vencido'],
  ['DIFF_DESC', 'Diferente do anúncio'],
  ['DIFFERENT_DESCRIPTION', 'Diferente do anúncio'],
  ['SIZE_DEVIATION', 'Tamanho diferente do anunciado'],
  ['LOOK_DEVIATION', 'Aparência diferente da anunciada'],
  ['DATE_DEVIATION', 'Validade diferente da anunciada'],
  ['ITEM_MISSING', 'Item faltando'],
  ['ITEM_FAKE', 'Produto falsificado'],
  ['ITEM_NOT_FIT', 'Não serviu'],
  ['USED', 'Produto usado'],
  ['EXPECTATION_FAILED', 'Não atendeu às expectativas'],
  ['CHANGE_MIND', 'O comprador desistiu'],
  ['CHANGE_OF_MIND', 'O comprador desistiu'],
  ['MUTUAL_AGREE', 'Acordo entre comprador e vendedor'],
  ['MUITAL_AGREE', 'Acordo entre comprador e vendedor'],
  ['SUSPICIOUS_PARCEL', 'Pacote suspeito'],
  ['WRONG_ORDER_INFO', 'Dados do pedido errados'],
  ['WRONG_ADDRESS', 'Endereço errado'],
  ['OTHER', 'Outro motivo'],
]);

/** `NegotiationStatus` — whose turn it is in a counter-offer. */
const STATUS_NEGOCIACAO: ReadonlyMap<string, string> = new Map([
  ['PENDING_RESPOND', 'aguardando sua resposta'],
  ['PENDING_BUYER_RESPOND', 'aguardando o comprador'],
  ['TERMINATED', 'encerrada'],
]);

/** `SellerProofStatus` — whether Shopee asked the seller for evidence. */
const STATUS_PROVA: ReadonlyMap<string, string> = new Map([
  ['NOT_NEEDED', 'não pedidas'],
  ['PENDING', 'pedidas pela Shopee'],
  ['UPLOADED', 'enviadas'],
  ['OVERDUE', 'prazo vencido'],
]);

/**
 * `SellerCompensationStatus` — nine values in both guides.
 *
 * ⚠️ The list page's own samples drop the `COMPENSATION_` prefix
 * (`PENDING_REQUEST`, `NOT_REQUIRED`), and which spelling a real BR shop sends
 * is unverified, so BOTH spellings of every value are rows here. Spelled out,
 * not stripped at lookup: a lower-cased or fused token stays raw.
 */
const STATUS_COMPENSACAO: ReadonlyMap<string, string> = new Map(
  (
    [
      ['NOT_APPLICABLE', 'não se aplica'],
      ['INITIAL_STAGE', 'em fase inicial'],
      ['PENDING_REQUEST', 'pode ser pedida'],
      ['NOT_REQUIRED', 'não necessária'],
      ['REQUESTED', 'pedida'],
      ['APPROVED', 'aprovada'],
      ['REJECTED', 'recusada'],
      ['CANCELLED', 'cancelada'],
      ['NOT_ELIGIBLE', 'sem direito'],
    ] as const
  ).flatMap(([token, rotulo]): [string, string][] => [
    [`COMPENSATION_${token}`, rotulo],
    [token, rotulo],
  ]),
);

/** `return_refund_request_type` — an INT on the wire. */
const TIPO_REQUISICAO: ReadonlyMap<number, string> = new Map([
  [0, 'Devolução normal'],
  [1, 'Devolução durante o transporte'],
  [2, 'Devolução no ato da entrega'],
]);

/** The backend's deadline codes (`prazos[].tipo`). */
const PRAZO: ReadonlyMap<string, string> = new Map([
  ['resposta-vendedor', 'Responder à solicitação até'],
  ['final-vendedor', 'Prazo final do vendedor'],
  ['envio-comprador', 'Comprador devolver até'],
  ['evidencias', 'Enviar evidências até'],
  ['compensacao', 'Pedir compensação até'],
  ['proposta', 'Responder à proposta até'],
]);

/**
 * The backend's "do it on the Seller Centre" codes (`pendenciasForaDoErp`) —
 * each a sentence naming WHERE, so a step the ERP cannot take is never a dead
 * end.
 */
const PENDENCIA_FORA_DO_ERP: ReadonlyMap<string, string> = new Map([
  ['contestar', 'Para contestar a devolução, abra a disputa pelo Seller Centre da Shopee.'],
  ['enviar-evidencias', 'A Shopee pediu evidências — envie pelo Seller Centre.'],
  ['organizar-coleta', 'A coleta do produto devolvido é sua — organize pelo Seller Centre.'],
]);

export function rotuloStatusDevolucaoShopee(v: string | null | undefined): string {
  return rotular(STATUS_DEVOLUCAO, v);
}

export function rotuloSolucaoDevolucao(v: string | null | undefined): string {
  return rotular(SOLUCAO_DEVOLUCAO, v);
}

export function rotuloMotivoDevolucaoShopee(v: string | null | undefined): string {
  return rotular(MOTIVO_DEVOLUCAO, v);
}

export function rotuloStatusNegociacao(v: string | null | undefined): string {
  return rotular(STATUS_NEGOCIACAO, v);
}

export function rotuloStatusProva(v: string | null | undefined): string {
  return rotular(STATUS_PROVA, v);
}

export function rotuloStatusCompensacao(v: string | null | undefined): string {
  return rotular(STATUS_COMPENSACAO, v);
}

/** An unknown request type comes back as its number, never blank. */
export function rotuloTipoRequisicao(v: number | null | undefined): string {
  if (v == null) return AUSENTE;
  return TIPO_REQUISICAO.get(v) ?? String(v);
}

export function rotuloPrazo(tipo: string | null | undefined): string {
  return rotular(PRAZO, tipo);
}

export function rotuloPendenciaForaDoErp(v: string | null | undefined): string {
  return rotular(PENDENCIA_FORA_DO_ERP, v);
}
