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
 */

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
