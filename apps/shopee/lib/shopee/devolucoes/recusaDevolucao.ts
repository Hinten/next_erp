/**
 * The returns flow's REFUSAL vocabulary (#1525, step 17): WHY a seller action on
 * a Shopee return was refused — by our own live pre-check or by Shopee — the
 * pt-BR sentence the operator reads for each reason, and THE classifier of
 * Shopee's refusals of a returns operation (reconcile R-6).
 *
 * ## ONE vocabulary for both refusers
 *
 * The actions gate (`estadoDevolucao.ts`, which re-reads the return live before
 * every write) and Shopee's own answer to `confirm` / `offer` / `accept_offer`
 * name the SAME conditions — "the status does not allow it", "there is no buyer
 * offer", "the return is in dispute". Two near-identical tables (one per
 * refuser) were designed and merged here before either shipped: two copies of
 * one vocabulary drift toward plausible while disagreeing (#1369), and the web
 * would then branch on two spellings of one fact.
 *
 * ⚠️ **PERSISTED on the wire.** The slug rides the `reclamacao/acao` route's 409
 * body as `motivo`, and the web branches on it, so a rename is a wire change on
 * both sides of a deploy.
 *
 * ⚠️ **No identifier and no provider payload in a sentence.** Never an order
 * number, a return number or Shopee's own text (it can echo what we sent): the
 * sentence is ours, and it describes the mechanism, not the data.
 *
 * ## The classifier reads two FOLDS, never the thrown sentence
 *
 * {@link classificarRecusaDevolucaoShopee} compares the envelope code through
 * `codigoCanonicoShopee` (trim, ONE module segment stripped, trim) and the
 * provider's sentence through `fraseCanonicaShopee` (whitespace collapsed,
 * `Wrong parameters, detail:` dropped, lower-cased, trailing periods dropped) —
 * the app's established seam (`core/recusaShopee.ts`), not a third copy of
 * either fold. ⚠️ It reads `providerMessage`, NEVER `err.message`: that one is
 * OUR formatted sentence (`Shopee <path> respondeu <code> …`), and on
 * `/api/v2/returns/…` its haystack already says `returns` before Shopee has said
 * a word.
 *
 * ⚠️ **Why the one-segment strip is safe HERE — and the pin that keeps it so.**
 * None of the six v1 pages documents a dotted code: every code they list is
 * `error_*`, `err_data` or `rraoc_*`. The dotted family (`number.error`,
 * `return.status.illegal`, `dispute.rr.not.allow`) belongs to `dispute` and its
 * siblings, which step 17 DEFERS (R-5) — and there the strip is exactly the
 * hazard: `number.error` folds to `error`. So the table's keys are pinned
 * STRUCTURALLY to `/^(error_|err_|rraoc_)/` ({@link CODIGOS_DA_RECUSA_DEVOLUCAO},
 * `recusaDevolucao.test.ts`): a strip can then only ever land on a key Shopee
 * spells with that prefix, never on a bare `error`. The deferred half brings a
 * full-code classifier with it.
 *
 * ## `null` means "not a refusal we know"
 *
 * The caller decides what an unknown refusal is: the importer lets it propagate
 * to the code-29 arm's class table, and the action route answers 502 with
 * Shopee's code through `codigoSeguro`. Nothing here guesses.
 *
 * Pure and total: no clock, no I/O, no environment.
 */
import type { ShopeeApiError } from '@delfrance/integrations-shopee';
import { z } from 'zod';

import { codigoCanonicoShopee, fraseCanonicaShopee } from '../core/recusaShopee';

/* ------------------------------ the vocabulary ------------------------------ */

/** The closed set of refusal reasons — the route's 409 `motivo`. */
export const motivoRecusaDevolucaoSchema = z.enum([
  'devolucao-encerrada',
  'status-nao-permite',
  'devolucao-em-disputa',
  'tipo-requisicao-nao-permite',
  'validacao-pelo-armazem',
  'tipo-reembolso-nao-permite',
  'solucao-indisponivel',
  'valor-nao-ajustavel',
  'valor-obrigatorio',
  'valor-fora-da-faixa',
  'sem-proposta-do-comprador',
  'proposta-propria',
  'negociacao-nao-permite',
  'evidencia-inicial-pendente',
  'em-analise-pela-shopee',
  'valor-mudou',
  'proposta-mudou',
  'pedido-divergente',
  'devolucao-inexistente',
  'parametro-invalido',
]);

/** One refusal reason. */
export type MotivoRecusaDevolucao = z.infer<typeof motivoRecusaDevolucaoSchema>;

/**
 * {@link MotivoRecusaDevolucao} by name, so code names a member instead of
 * spelling a slug. Keys are the slugs in camelCase — a test pins the pairing,
 * and that the members are exactly the schema's.
 */
export const MOTIVO_RECUSA_DEVOLUCAO = {
  // ---- the return's state (our gate and Shopee's) ----
  devolucaoEncerrada: 'devolucao-encerrada',
  statusNaoPermite: 'status-nao-permite',
  devolucaoEmDisputa: 'devolucao-em-disputa',
  tipoRequisicaoNaoPermite: 'tipo-requisicao-nao-permite',
  validacaoPeloArmazem: 'validacao-pelo-armazem',
  tipoReembolsoNaoPermite: 'tipo-reembolso-nao-permite',
  // ---- the offer (our gate; Shopee's `error_param` is the arbiter) ----
  solucaoIndisponivel: 'solucao-indisponivel',
  valorNaoAjustavel: 'valor-nao-ajustavel',
  valorObrigatorio: 'valor-obrigatorio',
  valorForaDaFaixa: 'valor-fora-da-faixa',
  // ---- the negotiation ----
  semPropostaDoComprador: 'sem-proposta-do-comprador',
  propostaPropria: 'proposta-propria',
  negociacaoNaoPermite: 'negociacao-nao-permite',
  // ---- Shopee holds the case ----
  evidenciaInicialPendente: 'evidencia-inicial-pendente',
  emAnalisePelaShopee: 'em-analise-pela-shopee',
  // ---- "what you saw" drifted (R-15 — our gate only, rule 7 tier 3) ----
  valorMudou: 'valor-mudou',
  propostaMudou: 'proposta-mudou',
  pedidoDivergente: 'pedido-divergente',
  // ---- the request itself ----
  devolucaoInexistente: 'devolucao-inexistente',
  parametroInvalido: 'parametro-invalido',
} as const satisfies Record<string, MotivoRecusaDevolucao>;

/* ------------------------------ the text table ------------------------------ */

/**
 * The pt-BR SENTENCE for every member — the route's `error`, shown verbatim by
 * the web. Where the operator has something to DO, the remedy comes FIRST and
 * the cause follows the dash; where nothing is theirs to do, it states the fact.
 *
 * ⚠️ `Record<MotivoRecusaDevolucao, string>`, and no lookup anywhere carries a
 * `?? fallback`: a member without a sentence is a COMPILE error here, never a
 * blank at runtime.
 */
export const FRASE_RECUSA_DEVOLUCAO: Record<MotivoRecusaDevolucao, string> = {
  [MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada]:
    'A devolução já foi encerrada na Shopee, e não há mais ação do vendedor a tomar.',
  [MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite]:
    'Atualize a reclamação e confira a situação — a situação atual da devolução na Shopee não permite esta ação.',
  [MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa]:
    'Acompanhe o caso na Central do Vendedor — a devolução está em disputa na Shopee, e esta ação não é permitida até a decisão.',
  [MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite]:
    'Resolva a devolução pela Central do Vendedor — o tipo desta solicitação de devolução não permite que a loja a aceite.',
  [MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem]:
    'Aguarde a validação do armazém da Shopee — esta devolução é validada pelo armazém, e a loja não pode aceitá-la.',
  [MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite]:
    'Resolva a devolução pela Central do Vendedor — o tipo desta devolução não permite que a loja responda com reembolso pelo ERP.',
  [MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel]:
    'Escolha outra solução — a Shopee não oferece a solução escolhida para esta devolução.',
  [MOTIVO_RECUSA_DEVOLUCAO.valorNaoAjustavel]:
    'Envie a proposta sem valor — a Shopee não permite ajustar o valor do reembolso nesta solução.',
  [MOTIVO_RECUSA_DEVOLUCAO.valorObrigatorio]:
    'Informe o valor do reembolso — a Shopee exige um valor para esta solução.',
  [MOTIVO_RECUSA_DEVOLUCAO.valorForaDaFaixa]:
    'Informe um valor dentro da faixa que a Shopee permite para esta devolução — o valor proposto ficou fora dela.',
  [MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador]:
    'Atualize a reclamação — o comprador não tem proposta pendente para a loja aceitar.',
  [MOTIVO_RECUSA_DEVOLUCAO.propostaPropria]:
    'Aguarde a resposta do comprador — a proposta pendente é da própria loja, e a loja não pode aceitá-la.',
  [MOTIVO_RECUSA_DEVOLUCAO.negociacaoNaoPermite]:
    'Atualize a reclamação e confira a negociação — a situação atual da negociação na Shopee não permite esta ação.',
  [MOTIVO_RECUSA_DEVOLUCAO.evidenciaInicialPendente]:
    'Aguarde o comprador — a Shopee ainda espera as evidências iniciais dele, e a devolução é cancelada se ele não as enviar no prazo.',
  [MOTIVO_RECUSA_DEVOLUCAO.emAnalisePelaShopee]:
    'Aguarde a análise da Shopee — ela está revisando o caso e vai retornar com uma decisão.',
  [MOTIVO_RECUSA_DEVOLUCAO.valorMudou]:
    'Confira o novo valor e confirme de novo — o valor da devolução mudou na Shopee desde que a tela foi carregada.',
  [MOTIVO_RECUSA_DEVOLUCAO.propostaMudou]:
    'Confira a nova proposta e confirme de novo — a proposta do comprador mudou na Shopee desde que a tela foi carregada.',
  [MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente]:
    'Abra a devolução pelo pedido dela — esta devolução pertence a outro pedido na Shopee.',
  [MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente]:
    'Atualize o pedido — a Shopee não encontrou esta devolução, ou ela não está mais disponível.',
  [MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido]:
    'Confira a solução e o valor e tente de novo — a Shopee recusou um dos dados da ação.',
};

/* ------------------------------ the classifier ------------------------------ */

/**
 * The codes that decide alone, whatever the sentence — each spelled as the six
 * v1 pages print it, AFTER the code fold. A `Map`, never an object literal: the
 * key arrives verbatim from a provider, and `constructor` on an object literal
 * answers an `Object.prototype` member (the package's `errors.ts` rule).
 */
const RECUSA_POR_CODIGO: ReadonlyMap<string, MotivoRecusaDevolucao> = new Map<
  string,
  MotivoRecusaDevolucao
>([
  // `confirm` / `offer` / `accept_offer`: "The return status cannot support this action".
  ['error_return_status', MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite],
  // `offer` / `accept_offer`: "The negotiation status cannot support this action".
  ['error_negotiation_status', MOTIVO_RECUSA_DEVOLUCAO.negociacaoNaoPermite],
  // `offer`: "cannot offer refund to buyer when return has ongoing dispute".
  ['error_ongoing_dispute', MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa],
  // `accept_offer`: "…because there is no (counter) proposal from buyer".
  ['error_no_buyer_offer', MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador],
  // `offer` / `accept_offer`: "Cannot accept your own offer." — `err_data`, sic,
  // NOT `error_data` (whose rows are the needles below).
  ['err_data', MOTIVO_RECUSA_DEVOLUCAO.propostaPropria],
  // `confirm`: "…because the Return Refund Request Type = {return_type}".
  ['error_return_request_type', MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite],
  // `confirm`: "…the validation_type of Return/Refund request = warehouse_validation".
  ['error_validation', MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem],
  // `confirm`: "Type of return does not allow seller to offer refund".
  ['rraoc_refund_not_allowed', MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite],
  // Every page: the amount bounds, the solution not on offer, an invalid
  // return_sn — our request, whatever the sentence.
  ['error_param', MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido],
]);

/** The one code with SEVERAL meanings on these pages — the sentence decides. */
const CODIGO_DADOS = 'error_data';

/**
 * `error_data`'s rows, against the FOLDED sentence, walked IN THIS ORDER (the
 * first needle found answers). Any other `error_data` sentence — `Query shop
 * info failed. Please try later.` on `get_return_detail` — answers `null`.
 *
 * ⚠️ **The "not available" needle is ANCHORED** to `get_return_detail`'s own
 * sentence ("The return detail is not available."), never a bare
 * `not available`: the bare one also matched a transient like "Service is
 * temporarily not available, please try later." — and the importer PARKS an
 * inexistente as "não existe na Shopee", the estado route answers it 404. And
 * `accept offer is not available` still comes first: the `accept_offer` page's
 * "Accept offer is not available for this return" is a NEGOTIATION refusal,
 * not a vanished return. A test pins both.
 */
const AGULHAS_DE_DADOS: readonly (readonly [agulha: string, motivo: MotivoRecusaDevolucao])[] = [
  ['accept offer is not available', MOTIVO_RECUSA_DEVOLUCAO.negociacaoNaoPermite],
  // `get_available_solutions` / `offer`: "Type of return does not allow seller to offer refund".
  ['does not allow seller to offer refund', MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite],
  // `offer` / `confirm`: "The return case is missing initial evidence from the buyer and …".
  ['missing initial evidence', MOTIVO_RECUSA_DEVOLUCAO.evidenciaInicialPendente],
  // Several pages: "Shopee is reviewing the case and will get back to you."
  ['shopee is reviewing', MOTIVO_RECUSA_DEVOLUCAO.emAnalisePelaShopee],
  // Several pages: "Invalid return status: {status}".
  ['invalid return status', MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite],
  // `get_return_list` / `get_return_detail`: "The return you queried doesn't
  // exist." and "The return detail is not available."
  ["doesn't exist", MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente],
  ['return detail is not available', MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente],
];

/**
 * Every code the classifier reads — DERIVED from the table it reads, so the
 * structural pin (`/^(error_|err_|rraoc_)/`, no dot) can never test a copy. A
 * key outside that pattern is how a one-segment strip of a dotted code
 * (`number.error` → `error`) would start landing on a row.
 */
export const CODIGOS_DA_RECUSA_DEVOLUCAO: readonly string[] = Object.freeze([
  ...RECUSA_POR_CODIGO.keys(),
  CODIGO_DADOS,
]);

/**
 * Classify Shopee's refusal of a returns operation (see the module docblock).
 *
 * The code is compared after `codigoCanonicoShopee` (so `returns.error_param`
 * and ` error_param\t` read as `error_param`, while `x.returns.error_param`
 * keeps its `returns.` and `Error_Param` its case); the sentence — read ONLY
 * for `error_data` — after `fraseCanonicaShopee(err.providerMessage)`.
 *
 * @returns the motivo, or `null` ⇒ not a refusal this table knows; the caller
 *   decides (the importer propagates it, the route answers 502 with the code
 *   through `codigoSeguro`).
 */
export function classificarRecusaDevolucaoShopee(
  err: ShopeeApiError,
): MotivoRecusaDevolucao | null {
  const codigo = codigoCanonicoShopee(err.code);
  const porCodigo = RECUSA_POR_CODIGO.get(codigo);
  if (porCodigo !== undefined) return porCodigo;
  if (codigo !== CODIGO_DADOS) return null;

  const frase = fraseCanonicaShopee(err.providerMessage);
  for (const [agulha, motivo] of AGULHAS_DE_DADOS) {
    if (frase.includes(agulha)) return motivo;
  }
  return null;
}
