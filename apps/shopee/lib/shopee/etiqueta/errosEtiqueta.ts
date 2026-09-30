/**
 * The label flow's vocabulary (#1523, step 15): WHY a click on "Imprimir
 * etiqueta" ended in a refusal, and the pt-BR sentence the operator reads for
 * each reason.
 *
 * The split is step 14's (`nfe/errosNfe.ts`): the vocabulary, its companion
 * const and the ONE text table in one small module; every producer elsewhere.
 * Where step 14 already names the same condition, the SPELLING is its
 * (`nao-shopee`, `conta-nao-configurada`, `conta-inativa`, `pedido-fbs`,
 * `pedido-cancelado`, `status-desconhecido`, `ip-nao-declarado`,
 * `recusa-desconhecida`); the TYPE is not shared — each folder owns its
 * vocabulary, so a member added to one never silently widens the other.
 *
 * ⚠️ **PERSISTED on the wire.** The slug rides the route's 409 body as
 * `motivo`, and the web branches on it, so a rename is a wire change on both
 * sides of a deploy.
 *
 * ⚠️ **No identifier and no provider payload in a sentence.** Never an order
 * number, a package number, a tracking number or Shopee's own text: the
 * sentence is ours, and it describes the mechanism, not the data.
 *
 * One producer lives HERE by design (reconcile §2.3): the classifier
 * {@link classificarErroDeEtiqueta} at the bottom — Shopee's failure of one
 * label operation → the runner's verdict. It is the only place a label refusal
 * is read, so the table and the vocabulary it answers in move together.
 */
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeArquivoVazioError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  shopeeErrorFromEnvelope,
} from '@delfrance/integrations-shopee';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { codigoCanonicoShopee, fraseCanonicaShopee } from '../core/recusaShopee';
import { ShopeeRefreshEmAndamentoError } from '../core/tokenStore';
import {
  INTERVALO_DOCUMENTO_MS,
  TENTAR_EM_CREDENCIAL_MS,
  TENTAR_EM_LIMITE_MS,
  TENTAR_EM_SHOPEE_MS,
} from './constantesEtiqueta';
import type { FaseEtiqueta } from './faseEtiqueta';

/* ------------------------------ the vocabulary ------------------------------ */

/**
 * The closed set of refusal reasons, grouped by the altitude that produces
 * them. Keys are the slugs in camelCase — a test pins the pairing — so code
 * names a member instead of spelling a slug.
 */
export const MOTIVO_ETIQUETA_SHOPEE = {
  // ---- the pedido and the conta (the route's own rungs) ----
  naoShopee: 'nao-shopee',
  freteDeOutraIntegracao: 'frete-de-outra-integracao',
  contaNaoConfigurada: 'conta-nao-configurada',
  contaInativa: 'conta-inativa',
  // ---- the order Shopee holds ----
  pedidoFbs: 'pedido-fbs',
  pedidoCancelado: 'pedido-cancelado',
  pedidoEmCancelamento: 'pedido-em-cancelamento',
  semPacotes: 'sem-pacotes',
  pacoteInexistente: 'pacote-inexistente',
  // ---- the package phase ----
  statusDesconhecido: 'status-desconhecido',
  nfePendente: 'nfe-pendente',
  pacoteNaoPronto: 'pacote-nao-pronto',
  retidoPelaShopee: 'retido-pela-shopee',
  janelaFechada: 'janela-fechada',
  pacoteInelegivel: 'pacote-inelegivel',
  // ---- the shipping mode ----
  semEnderecoDeColeta: 'sem-endereco-de-coleta',
  agenciaPrecisaEscolha: 'agencia-precisa-escolha',
  modoNaoSuportado: 'modo-nao-suportado',
  semEtiquetaShopee: 'sem-etiqueta-shopee',
  // ---- Shopee's refusal of the ship or of the document ----
  cadastroDoVendedor: 'cadastro-do-vendedor',
  pedidoDeReserva: 'pedido-de-reserva',
  somenteSellerCentre: 'somente-seller-centre',
  etiquetaIndisponivel: 'etiqueta-indisponivel',
  documentoFalhou: 'documento-falhou',
  tipoInvalido: 'tipo-invalido',
  pacotesMudaram: 'pacotes-mudaram',
  // ---- the limits and the infrastructure ----
  limiteDiario: 'limite-diario',
  ipNaoDeclarado: 'ip-nao-declarado',
  recusaDesconhecida: 'recusa-desconhecida',
} as const;

/** One refusal reason — a member of {@link MOTIVO_ETIQUETA_SHOPEE}. */
export type MotivoEtiquetaShopee =
  (typeof MOTIVO_ETIQUETA_SHOPEE)[keyof typeof MOTIVO_ETIQUETA_SHOPEE];

/* ------------------------------ the text table ------------------------------ */

/**
 * The pt-BR FRAGMENT for every member — the ONE text table of this folder.
 *
 * Each entry is a **lowercase fragment with no trailing period**;
 * {@link mensagemDoMotivoEtiqueta} capitalizes it and adds the period. Where
 * the operator has something to DO, the remedy comes FIRST and the cause
 * follows the dash; where nothing is theirs to do, the fragment states the
 * fact. (The step-14 shape, `FRASE_DO_MOTIVO_NFE`.)
 *
 * ⚠️ `Record<MotivoEtiquetaShopee, string>`, and there is no `?? fallback` on a
 * lookup anywhere: a member without a fragment is a COMPILE error here, never
 * a blank at runtime.
 */
const FRASE_DO_MOTIVO_ETIQUETA: Record<MotivoEtiquetaShopee, string> = {
  // ---- the pedido and the conta ----
  'nao-shopee':
    'o pedido não veio da Shopee, e esta integração só imprime etiquetas de pedidos da Shopee',
  'frete-de-outra-integracao':
    'confira o frete do pedido — ele está vinculado a outra integração de frete, e a etiqueta da Shopee não é emitida para ele',
  'conta-nao-configurada':
    'reconecte a conta Shopee do pedido — ela não foi encontrada ou não está configurada',
  'conta-inativa': 'reative a conta Shopee no ERP para imprimir a etiqueta — ela está desativada',
  // ---- the order Shopee holds ----
  'pedido-fbs':
    'o pedido é atendido pelo fulfillment da Shopee (FBS), e a etiqueta é emitida pela própria Shopee',
  'pedido-cancelado': 'o pedido foi cancelado na Shopee, e não há etiqueta a imprimir',
  'pedido-em-cancelamento':
    'responda ao pedido de cancelamento do comprador na Central do Vendedor antes de organizar o envio — o pedido está em cancelamento na Shopee',
  'sem-pacotes':
    'tente de novo em alguns minutos — a Shopee ainda não informou nenhum pacote para o pedido',
  'pacote-inexistente':
    'clique em Imprimir de novo — o pacote indicado não existe mais neste pedido na Shopee',
  // ---- the package phase ----
  'status-desconhecido':
    'confira o pedido na Central do Vendedor — a Shopee informou uma situação de envio que o ERP não reconhece, e o ERP não age sobre ela',
  'nfe-pendente':
    'envie a NF-e do pedido à Shopee antes de imprimir a etiqueta — a Shopee só libera o envio com a nota fiscal anexada',
  'pacote-nao-pronto':
    'aguarde a Shopee liberar o envio e tente de novo — o pacote ainda não está pronto para ser enviado',
  'retido-pela-shopee':
    'tente de novo mais tarde — a Shopee reteve o envio do pacote temporariamente (por exemplo, por falta de capacidade da transportadora)',
  'janela-fechada':
    'a transportadora já coletou o pacote (ou o envio já terminou), e a etiqueta não pode mais ser impressa pelo ERP',
  'pacote-inelegivel':
    'confira o pedido na Central do Vendedor — o envio do pacote foi cancelado ou recusado na Shopee, e não há etiqueta a imprimir',
  // ---- the shipping mode ----
  'sem-endereco-de-coleta':
    'marque um endereço de coleta na Central do Vendedor e clique de novo — a loja não tem endereço de coleta para este envio',
  'agencia-precisa-escolha':
    'escolha a agência na Central do Vendedor e clique de novo — a Shopee oferece mais de uma agência para este envio',
  'modo-nao-suportado':
    'organize o envio na Central do Vendedor e clique de novo — a Shopee pede dados de envio que o ERP não preenche',
  'sem-etiqueta-shopee':
    'este envio é feito pela logística do próprio vendedor, e a Shopee não emite etiqueta para ele',
  // ---- Shopee's refusal of the ship or of the document ----
  'cadastro-do-vendedor':
    'confira os dados da loja na Central do Vendedor — a Shopee recusou o envio por um problema no cadastro do vendedor',
  'pedido-de-reserva':
    'o pedido é uma reserva de envio antecipado (Advance Fulfillment) da Shopee, e o ERP não organiza esse envio',
  'somente-seller-centre':
    'imprima a etiqueta pela Central do Vendedor — a Shopee só permite imprimir a etiqueta deste pedido por lá',
  'etiqueta-indisponivel':
    'tente de novo mais tarde ou imprima pela Central do Vendedor — a Shopee ainda não libera a etiqueta na situação atual do pedido',
  'documento-falhou':
    'tente de novo mais tarde ou imprima pela Central do Vendedor — a Shopee não conseguiu gerar a etiqueta, nem na segunda tentativa',
  'tipo-invalido':
    'tente o outro formato de etiqueta — a Shopee recusou o tipo de etiqueta pedido para este envio',
  'pacotes-mudaram':
    'clique em Imprimir de novo — os pacotes do pedido mudaram na Shopee durante a impressão',
  // ---- the limits and the infrastructure ----
  'limite-diario':
    'tente de novo depois da virada do dia — a cota diária de chamadas da Shopee acabou',
  'ip-nao-declarado':
    'acione o suporte técnico — o IP do servidor do ERP não está liberado no aplicativo da Shopee',
  'recusa-desconhecida':
    'confira o pedido na Central do Vendedor — a Shopee recusou a etiqueta por um motivo que o ERP não reconhece',
};

/**
 * The route's and the CLI's SENTENCE for a motivo: the fragment with its first
 * letter capitalized and a closing period.
 */
export function mensagemDoMotivoEtiqueta(motivo: MotivoEtiquetaShopee): string {
  const frase = FRASE_DO_MOTIVO_ETIQUETA[motivo];
  return `${frase.charAt(0).toLocaleUpperCase('pt-BR')}${frase.slice(1)}.`;
}

/* ------------------------------ the classifier ----------------------------- */

/*
 * THE refusal table of the label flow: one failure of one label operation →
 * what the runner does about it. The rows are design D1 §4's E0–E26, walked in
 * the order below (the first row that matches answers), with reconcile R-m's
 * and §2.3's amendments. The shape is step 14's `nfe/classificarNfe.ts`.
 *
 * ## `null` means "not ours — rethrow"
 *
 * A verdict is returned only for what the label flow can ACT on. Everything
 * else answers `null`, the caller rethrows, and the app's one error mapper
 * (`core/respond.ts`) answers as it does for every route: a dead grant (409
 * reauth), our own misconfiguration (`ShopeeConfigError`), an unreadable body
 * (`ShopeeSchemaError`, 502), and anything that is not the package's error at
 * all. There is deliberately no label-specific error class and no second path
 * to a 409 (R-m).
 *
 * ## ⚠️ Needles read `providerMessage`, NEVER the thrown Error's `.message`
 *
 * The thrown sentence is `Shopee <path> respondeu <code> (HTTP n) — <text>`: on
 * `/api/v2/logistics/ship_order` its haystack says `ship_order` before Shopee
 * has said a word. Sentences are folded ONCE by {@link fraseCanonicaShopee} and
 * codes by {@link codigoCanonicoShopee} (trim, ONE module segment, trim) — the
 * same two folds step 14's table reads, from `core/recusaShopee.ts`. So
 * ` logistics.package_already_shipped` (the ship page prints the leading space)
 * ≡ `package_already_shipped`, while `x.logistics.package_already_shipped` keeps
 * its `logistics.` and falls to E26.
 *
 * ## ⚠️ `logistics.error_param` is SIX rows, split by the sentence
 *
 * One code answers E2 (`Order has been shipped.` ⇒ already arranged), E5 (`being
 * allocated` ⇒ wait), E8 (`has been splitted` ⇒ the packages changed), E10 (not
 * ready ⇒ refuse), E11 (the slot ⇒ choose again) and E13 (`Seller Info Error`).
 * A code-only row would read an allocation wait as an arranged package; each
 * pair is pinned by a same-code near-miss test.
 *
 * ## ⚠️ An unknown outcome of `ship_order` is `verificar`, never a refusal
 *
 * `ship_order` is not idempotent, and a network drop, an HTTP error without an
 * envelope, Shopee's lock codes (E6) and its own transient codes (E7) do not
 * mean "not arranged". On `programar` they answer `verificar`: the next call
 * re-reads `is_shipment_arranged`, and nothing re-sends the ship in-call. On
 * every OTHER operation the same failures are a plain wait (E7b) — a read or a
 * document call is safe to repeat.
 *
 * ## ⚠️ The daily-quota kind is TRUSTED only with its sentence
 *
 * The package classifies `error_limit` as the daily quota even behind a module
 * prefix (a `product.error_limit` IS the quota). The `ship_order` page, though,
 * lists `logistics.error_limit` three times with other meanings — `The batch
 * request reach limit 50.`, `Can not update order logistics in current
 * status.`, `Parcel count should not exceed limit.` — and telling an operator
 * "try again after midnight" for those is a lie. So a daily kind answers
 * `limite-diario` only when Shopee's sentence names the daily limit, or when
 * there is no sentence at all; otherwise the rows decide (E26 for those three).
 *
 * ## ⚠️ Every lookup is a `Set`, never an object literal
 *
 * The keys arrive verbatim from a provider; on an object literal `constructor`
 * answers an `Object.prototype` member (the package's rule, `errors.ts`).
 *
 * Pure and total: the clock is the `nowMs` parameter, read only for the daily
 * quota's reset. No I/O, no environment.
 */

/** Which label operation failed — decides the `fase` of a wait and the ship-only rows. */
export type OperacaoEtiqueta =
  | 'detalhe-pedido'
  | 'detalhe-pacote'
  | 'parametro-envio'
  | 'programar'
  | 'rastreio'
  | 'parametro-documento'
  | 'criar-documento'
  | 'resultado-documento'
  | 'baixar';

/**
 * What the runner does with one failure (reconcile §2.3).
 *
 * - `ja-programado` — the package is ALREADY arranged: re-derive and carry on.
 * - `nfe-pendente` — Shopee holds the ship for the NF-e: the route's 409 and the
 *   one re-drive.
 * - `verificar` — the outcome of `ship_order` is UNKNOWN: answer 202 and let the
 *   next call re-read; never a blind re-send.
 * - `aguardar` — resumable: wait `tentarEmMs` (in-call inside the budget, else
 *   the 202's `tentarEmMs`).
 * - `pacotes-mudaram` / `reenviar-sem-pacote` — the two `package_number`
 *   answers of R-l: re-derive the package list once / re-send once without it.
 * - `reescolher-envio` — the chosen slot or address is no longer valid: ask again.
 * - `fase-desatualizada` — the document step ran ahead of Shopee: re-derive once.
 * - `baixar-separado` — these packages cannot share one file: per-package files.
 * - `tipo-invalido` — the document type was refused: fall back to `suggest` once.
 * - `recusa` — terminal for this click, with the operator's motivo.
 */
export type VereditoDeErro =
  | { tipo: 'ja-programado' }
  | { tipo: 'nfe-pendente' }
  | { tipo: 'verificar' }
  | { tipo: 'aguardar'; fase: FaseEtiqueta; tentarEmMs: number }
  | { tipo: 'pacotes-mudaram' }
  | { tipo: 'reenviar-sem-pacote' }
  | { tipo: 'reescolher-envio' }
  | { tipo: 'fase-desatualizada' }
  | { tipo: 'baixar-separado' }
  | { tipo: 'tipo-invalido' }
  | { tipo: 'recusa'; motivo: MotivoEtiquetaShopee; tentarApos?: number };

/**
 * The phase a WAIT reports, by the operation that failed.
 *
 * ⚠️ The two order/package reads open every call — a reprint of an arranged
 * package included — and there is no neutral phase, so they report the FIRST
 * one, `programando`. `Record<…>`, so a new operation is a compile error here.
 */
const FASE_DA_OPERACAO: Readonly<Record<OperacaoEtiqueta, FaseEtiqueta>> = {
  'detalhe-pedido': 'programando',
  'detalhe-pacote': 'programando',
  'parametro-envio': 'programando',
  programar: 'programando',
  rastreio: 'aguardando-rastreio',
  'parametro-documento': 'gerando-documento',
  'criar-documento': 'gerando-documento',
  'resultado-documento': 'gerando-documento',
  baixar: 'baixando',
};

/**
 * The wait for a Shopee-side "not now" (E5 allocation, E6 lock off the ship,
 * E7b transient): D1 row 5's 10 000, named once in `constantesEtiqueta.ts`
 * ({@link TENTAR_EM_SHOPEE_MS}) — not a second copy of the burst floor, which
 * only happens to share the value.
 */
const ESPERA_DA_SHOPEE_MS = TENTAR_EM_SHOPEE_MS;

// ---- the codes and the needles (canonical codes; folded sentences) ----

/** E0 — the daily quota's own sentence (common list: "…reached the daily API call limit…"). */
const AGULHA_COTA_DIARIA = 'daily';

/** E1 — the ship page prints it with a LEADING SPACE; the code fold absorbs it. */
const CODIGO_JA_ENVIADO = 'package_already_shipped';

/** The one code that carries five rows, told apart by the sentence. */
const CODIGO_PARAMETRO = 'error_param';

/** E2 — `logistics.error_param: Order has been shipped.` */
const AGULHA_JA_ENVIADO = 'order has been shipped';

/** E16 — `order_finalized` (reconcile folds D1's `pedido-encerrado` into `pedido-cancelado`). */
const CODIGO_PEDIDO_FINALIZADO = 'order_finalized';

/** E16 — `error_status: The order has been cancelled.` (its sibling text is NOT a cancellation). */
const CODIGO_STATUS = 'error_status';
const AGULHA_CANCELADO = 'has been cancelled';

/**
 * E3/E4 — the NF-e family, whatever the sentence: `logistics.lack_of_invoice_data`
 * (three texts on the ship page), the bare `lack_of_invoice_data`, and
 * announcement 1521's `error_pending_invoice` — five spellings, two canonical
 * codes.
 */
const CODIGOS_NFE_PENDENTE: ReadonlySet<string> = new Set<string>([
  'lack_of_invoice_data',
  'error_pending_invoice',
]);

/** E5 — `logistics.error_param: The order is being allocated, please wait…` */
const AGULHA_ALOCANDO = 'being allocated';

/**
 * E8 — the package list changed under us. D1's three, plus the two codes the
 * document and tracking pages use for a package number that no longer exists
 * (`package_number_not_found`, `package_not_exist`) — the same fact.
 */
const CODIGOS_PACOTES_MUDARAM: ReadonlySet<string> = new Set<string>([
  'ship_order_need_pacakge_number',
  'package_number_not_exist',
  'package_number_not_found',
  'package_not_exist',
]);
const AGULHA_DIVIDIDO = 'has been splitted';

/** E9 — `ship_order` only: the order is NOT split, re-send without the number. */
const CODIGO_SEM_PACOTE = 'ship_order_not_need_pacakge_number';

/** E10 — the package is not ready to ship. */
const CODIGO_NAO_PRONTO = 'ship_order_not_ready_to_ship';
const AGULHAS_NAO_PRONTO: readonly string[] = [
  'not ready to ship',
  'only be obtained when package is ready',
  'not to_process',
];

/** E11 — `ship_order` only: the chosen slot/address is no longer valid. */
const CODIGOS_REESCOLHER: ReadonlySet<string> = new Set<string>([
  'ship_order_pickup_time_invalid',
  'ship_order_need_address_pickup_time',
  'error_pickup_time',
]);
const AGULHAS_REESCOLHER: readonly string[] = [
  'pickup_time_id received is invalid',
  'timeslot is unavailable',
  'invalid pickup time',
];

/** E12 — the shop's pickup/dropoff setup cannot serve this ship. */
const CODIGOS_SEM_ENDERECO: ReadonlySet<string> = new Set<string>([
  'error_sender_address',
  'no_supported_pickup_address',
  'no_supported_dropoff_branch',
  'no_available_time_slot',
  'no_valid_shipping_parameters',
  'invalid_address_version',
]);

/** E13 — `logistics.error_param: Seller Info Error. Please check and input your …` */
const AGULHA_CADASTRO = 'seller info error';

/** E17 — the page prints `can_not_print_combine_order` followed by a TAB. */
const CODIGOS_SOMENTE_SELLER_CENTRE: ReadonlySet<string> = new Set<string>([
  'can_not_print_jit_order',
  'can_not_print_combine_order',
]);

/** E18 — FAQ 530: the order's state does not allow a label yet. */
const CODIGOS_ETIQUETA_INDISPONIVEL: ReadonlySet<string> = new Set<string>([
  'order_status_error',
  'package_can_not_print',
]);

/** E19 / E23 — the document step ran ahead of Shopee. */
const CODIGOS_FASE_DESATUALIZADA: ReadonlySet<string> = new Set<string>([
  'shipping_document_should_print_first',
  'tracking_number_invalid',
]);

/** E20 — `download_later`: the file is still being processed. */
const CODIGO_BAIXAR_DEPOIS = 'download_later';

/** E21 — these packages cannot share one file. */
const CODIGO_BAIXAR_SEPARADO = 'packages_can_not_download_together';

/** E24 — the document type was refused. */
const CODIGO_TIPO_INVALIDO = 'shipping_document_type_invalid';

/** E25 — the app's egress IP is not on Shopee's allow-list. */
const CODIGO_IP_NAO_DECLARADO = 'source_ip_undeclared';

/** E6 — Shopee's own locks: another ship may be in flight (a second tab). */
const CODIGOS_TRAVA: ReadonlySet<string> = new Set<string>([
  'error_too_many_invoke_function',
  'logistic_order_is_locked_on_creating',
]);

/**
 * E7 — Shopee could not reach its own systems, whatever the operation (D1 rows
 * 7/7b, plus the page's `error_connection` / `error_core_server` / `error_config`
 * siblings and E22's `package_print_failed`).
 */
const CODIGOS_TRANSITORIOS: ReadonlySet<string> = new Set<string>([
  'error_timeout',
  'error_third_party_server',
  'error_network',
  'error_server',
  'unknown_error',
  'error_connection',
  'error_core_server',
  'error_config',
  'package_print_failed',
]);

/**
 * E7 — the sentences of a Shopee hiccup under a code that also means other
 * things (`logistics.error_param: System error, please try again later.`,
 * `logistics.error_other: System error, …`). AFTER every specific row.
 */
const AGULHAS_TRANSITORIAS: readonly string[] = ['system error', 'try again later', 'try later'];

// ---- the verdicts ----

function aguardar(fase: FaseEtiqueta, tentarEmMs: number): VereditoDeErro {
  return { tipo: 'aguardar', fase, tentarEmMs };
}

function recusa(motivo: MotivoEtiquetaShopee): VereditoDeErro {
  return { tipo: 'recusa', motivo };
}

/**
 * No answer, or Shopee's own hiccup: on the SHIP an unknown outcome
 * (`verificar`), on every other operation a plain wait.
 */
function semResposta(op: OperacaoEtiqueta): VereditoDeErro {
  return op === 'programar'
    ? { tipo: 'verificar' }
    : aguardar(FASE_DA_OPERACAO[op], ESPERA_DA_SHOPEE_MS);
}

/** `Retry-After` in ms, or 0 when absent or unusable. */
function retryAfterMs(err: ShopeeApiError): number {
  if (!(err instanceof ShopeeRateLimitError)) return 0;
  const s = err.retryAfterSeconds;
  return s !== null && Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

/**
 * Classify one failure of one label operation (see the section docblock).
 *
 * @param op the operation that failed — it decides the phase of a wait and
 *   gates the three ship-only verdicts (`verificar`, `reenviar-sem-pacote`,
 *   `reescolher-envio`).
 * @param err whatever the operation threw.
 * @param nowMs the call's ONE clock read, for the daily quota's reset.
 * @returns the verdict, or `null` ⇒ the caller rethrows `err` untouched.
 */
export function classificarErroDeEtiqueta(
  op: OperacaoEtiqueta,
  err: unknown,
  nowMs: number,
): VereditoDeErro | null {
  // ---- the classes, before any code is read ----

  // Another instance holds the token-refresh lease: the next call finds the
  // fresh pair. An APP class (not a `ShopeeError`), so it is read first.
  if (err instanceof ShopeeRefreshEmAndamentoError) {
    return aguardar('renovando-credencial', TENTAR_EM_CREDENCIAL_MS);
  }
  if (!(err instanceof ShopeeError)) return null;

  // An empty download: wait for the file. BEFORE the schema rule below — it IS
  // a `ShopeeSchemaError`. The runner allows it once per call; the next one it
  // rethrows, and `respond.ts`'s schema arm answers 502.
  if (err instanceof ShopeeArquivoVazioError) {
    return aguardar(FASE_DA_OPERACAO[op], INTERVALO_DOCUMENTO_MS);
  }

  // No envelope at all: a network drop, or an edge answer (HTML under the IP
  // allow-list). On the ship the outcome is UNKNOWN.
  if (err instanceof ShopeeNetworkError || err instanceof ShopeeHttpError) return semResposta(op);

  // Our misconfiguration, an unreadable body: not the label flow's to decide.
  if (!(err instanceof ShopeeApiError)) return null;

  const nu = codigoCanonicoShopee(err.code);
  const det = fraseCanonicaShopee(err.providerMessage);

  // ---- E0: the kinds the transport already decided ----
  // Read off `kind`, never the class: a partial error copies its kind.
  if (err.kind === SHOPEE_ERROR_KIND.burst) {
    return aguardar('limite-de-requisicoes', Math.max(retryAfterMs(err), TENTAR_EM_LIMITE_MS));
  }
  if (err.kind === SHOPEE_ERROR_KIND.daily && (det === '' || det.includes(AGULHA_COTA_DIARIA))) {
    return {
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
      tentarApos: proximaViradaDaCotaMs(nowMs),
    };
  }
  if (err.kind === SHOPEE_ERROR_KIND.reauth) return null;

  const param = nu === CODIGO_PARAMETRO;

  // ---- E1/E2: already arranged — resume, never an error. ----
  if (nu === CODIGO_JA_ENVIADO) return { tipo: 'ja-programado' };
  if (param && det.includes(AGULHA_JA_ENVIADO)) return { tipo: 'ja-programado' };

  // ---- E16: the order is over — NEVER read as arranged. ----
  if (nu === CODIGO_PEDIDO_FINALIZADO) return recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado);
  if (nu === CODIGO_STATUS && det.includes(AGULHA_CANCELADO)) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado);
  }

  // ---- E3/E4: Shopee holds the ship for the NF-e. ----
  if (CODIGOS_NFE_PENDENTE.has(nu)) return { tipo: 'nfe-pendente' };

  // ---- E5: still allocating — a wait, on the ship too (nothing was arranged). ----
  if (param && det.includes(AGULHA_ALOCANDO)) {
    return aguardar(FASE_DA_OPERACAO[op], ESPERA_DA_SHOPEE_MS);
  }

  // ---- E8/E9: the `package_number` pair (R-l). ----
  if (CODIGOS_PACOTES_MUDARAM.has(nu) || (param && det.includes(AGULHA_DIVIDIDO))) {
    return { tipo: 'pacotes-mudaram' };
  }
  if (nu === CODIGO_SEM_PACOTE && op === 'programar') return { tipo: 'reenviar-sem-pacote' };

  // ---- E10: not ready to ship. ----
  if (nu === CODIGO_NAO_PRONTO || (param && AGULHAS_NAO_PRONTO.some((a) => det.includes(a)))) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteNaoPronto);
  }

  // ---- E11: the chosen slot/address is stale — ask again (the ship only). ----
  if (
    op === 'programar' &&
    (CODIGOS_REESCOLHER.has(nu) || (param && AGULHAS_REESCOLHER.some((a) => det.includes(a))))
  ) {
    return { tipo: 'reescolher-envio' };
  }

  // ---- E12–E15, E17, E18: deterministic refusals. ----
  if (CODIGOS_SEM_ENDERECO.has(nu)) return recusa(MOTIVO_ETIQUETA_SHOPEE.semEnderecoDeColeta);
  if (param && det.includes(AGULHA_CADASTRO)) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.cadastroDoVendedor);
  }
  if (nu === 'ship_order_pff_init') return recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoFbs);
  if (nu === 'error_booking_order') return recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoDeReserva);
  if (CODIGOS_SOMENTE_SELLER_CENTRE.has(nu)) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.somenteSellerCentre);
  }
  if (CODIGOS_ETIQUETA_INDISPONIVEL.has(nu)) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.etiquetaIndisponivel);
  }

  // ---- E19–E21, E23, E24: the document steps. ----
  if (CODIGOS_FASE_DESATUALIZADA.has(nu)) return { tipo: 'fase-desatualizada' };
  if (nu === CODIGO_BAIXAR_DEPOIS) return aguardar(FASE_DA_OPERACAO[op], INTERVALO_DOCUMENTO_MS);
  if (nu === CODIGO_BAIXAR_SEPARADO) return { tipo: 'baixar-separado' };
  if (nu === CODIGO_TIPO_INVALIDO) return { tipo: 'tipo-invalido' };

  // ---- E25: infrastructure. ----
  if (nu === CODIGO_IP_NAO_DECLARADO) return recusa(MOTIVO_ETIQUETA_SHOPEE.ipNaoDeclarado);

  // ---- E6/E7: Shopee's locks and hiccups. AFTER every specific row. ----
  if (
    CODIGOS_TRAVA.has(nu) ||
    CODIGOS_TRANSITORIOS.has(nu) ||
    err.kind === SHOPEE_ERROR_KIND.transient ||
    AGULHAS_TRANSITORIAS.some((a) => det.includes(a))
  ) {
    return semResposta(op);
  }

  // ---- E26: a refusal nobody taught us. After a ship the next call re-derives anyway. ----
  return recusa(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida);
}

/**
 * The path a ROW failure is attributed to in the synthetic error below. It
 * only ever reaches the error's formatted `message`, which nothing classifies
 * and nothing logs.
 */
const CAMINHO_DA_LINHA = 'linha-de-lote';

/**
 * Classify ONE failed row of a batch document page (`fail_error` /
 * `fail_message`, read through the package's `falhaDaLinha`) with the SAME
 * table as a thrown failure.
 *
 * ⚠️ One table, not two: the row is turned into exactly the error the
 * transport would have built for an ENVELOPE carrying that code and sentence
 * (`shopeeErrorFromEnvelope` — the same class and the same `kind`, so a
 * row-level `error_limit` reads as the daily quota exactly where an envelope
 * would), and {@link classificarErroDeEtiqueta} answers it. A second row table
 * would drift from the first by construction.
 *
 * ⚠️ The code and the sentence arrive VERBATIM (a leading space or a trailing
 * TAB included); the classifier's own folds apply, as they do to an envelope.
 *
 * @returns the verdict, or `null` when the table has nothing to say (a
 *   reauth-kind code on a row). There is nothing to rethrow for a row, so the
 *   caller decides what `null` means — the runner answers it as an unknown
 *   refusal.
 */
export function classificarFalhaDeLinha(
  op: OperacaoEtiqueta,
  falha: { readonly code: string; readonly mensagem: string | null },
  nowMs: number,
): VereditoDeErro | null {
  const erro = shopeeErrorFromEnvelope(
    { error: falha.code, message: falha.mensagem, request_id: null, warning: null },
    { path: CAMINHO_DA_LINHA, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
  return classificarErroDeEtiqueta(op, erro, nowMs);
}
