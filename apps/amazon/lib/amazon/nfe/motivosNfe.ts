/**
 * The NF-e upload's closed vocabulary (step 14, PR 14-b): WHY an upload ended
 * where it did, which of those reasons raise the `nfeUploadRejeitado` aviso
 * (A), which of those ALSO stamp `freteInicial.estado = error` (S ⊂ A), which
 * are a log line only, and the pt-BR fragment of every reason that avisa.
 *
 * ## The sets are the ONLY source of the two effects
 *
 * Whether a reason avisa and whether it stamps is decided HERE, by membership,
 * and nowhere else — no producer restates it with an inline comparison. A
 * stamp is spent ONLY on a deterministic answer about THIS NF-e: Amazon refused
 * the submit or the note, Amazon accepted a submit and the note never appeared,
 * or our own XML can never be uploaded. Never on the valve, the read switch, a
 * lapsed grant, a transient, a deadline, the ladder's end, or an answer about
 * the ORDER entity (`EntityNotFound`). A test pins `CARIMBAM ⊂ AVISAM` (a stamp
 * nobody is told about is a pedido that silently stops shipping) and that every
 * member is in exactly one of A or log-only.
 *
 * ## The fragments
 *
 * The web renders `O envio da NF-e do pedido {pedido} ao canal não foi
 * concluído: {erro}.`, so each fragment starts lowercase, puts the remedy
 * FIRST (the cause follows the dash), and has no trailing period. ⚠️ No
 * identifier and no provider text, ever: never an access key, an order number,
 * a CNPJ, Amazon's own words or a code (step-14 plan §3 decision 19 — Amazon
 * gives no reason field; the codes stay in the log). The type of the table is
 * keyed by the A members, so a member that avisa without a fragment is a
 * COMPILE error.
 *
 * ## ⚠️ PERSISTED
 *
 * A slug is stored in `aviso.motivo`, so a rename orphans every row already
 * written. Not a Zod enum: nothing parses a motivo from an untrusted source.
 *
 * ⚠️ LIGHT on purpose: the NF-e trigger (14-c) imports this module, and its
 * import closure is pinned (`estrutura.test.ts`) to hold no SP-API value
 * import — it imports nothing.
 */

/* ------------------------------ the vocabulary ------------------------------ */

export type MotivoNfeAmazon =
  // ---- A + S: a deterministic answer about THIS NF-e ----
  | 'xml-invalido'
  | 'envio-recusado'
  | 'nfe-grande-demais'
  | 'nfe-recusada'
  | 'nfe-nao-registrada'
  // ---- A: Amazon's answer is not a refusal of this NF-e ----
  | 'aceite-nao-confirmado'
  | 'envio-nao-confirmado'
  | 'nfe-parcialmente-aceita'
  | 'status-nfe-desconhecido'
  | 'nfe-substituta'
  | 'nfe-ambigua'
  | 'nfe-cancelada'
  // ---- A: the valve, the switches, the conta, the transport ----
  | 'envio-nao-ligado'
  | 'chamadas-desligadas'
  | 'tarefas-desligadas'
  | 'conta-indisponivel'
  | 'sem-permissao'
  | 'amazon-indisponivel'
  // ---- A: the live order ----
  | 'pedido-pendente'
  | 'cancelamento-solicitado'
  | 'pedido-nao-encontrado-na-amazon'
  | 'status-pedido-desconhecido'
  // ---- log only ----
  | 'nfe-nao-pronta'
  | 'nao-amazon'
  | 'nfe-nao-e-de-venda'
  | 'nao-dba'
  | 'nf-nao-requerida'
  | 'marketplace-estrangeiro'
  | 'pedido-cancelado'
  | 'ja-aceita'
  | 'emissao-bloqueada'
  | 'conta-inativa'
  | 'taxa-limitada'
  | 'pos-envio-falhou';

/**
 * The closed set, so code names a member instead of spelling a slug. Keys are
 * the slugs in camelCase — a test pins the pairing.
 */
export const MOTIVO_NFE_AMAZON = {
  xmlInvalido: 'xml-invalido',
  envioRecusado: 'envio-recusado',
  nfeGrandeDemais: 'nfe-grande-demais',
  nfeRecusada: 'nfe-recusada',
  nfeNaoRegistrada: 'nfe-nao-registrada',
  aceiteNaoConfirmado: 'aceite-nao-confirmado',
  envioNaoConfirmado: 'envio-nao-confirmado',
  nfeParcialmenteAceita: 'nfe-parcialmente-aceita',
  statusNfeDesconhecido: 'status-nfe-desconhecido',
  nfeSubstituta: 'nfe-substituta',
  nfeAmbigua: 'nfe-ambigua',
  nfeCancelada: 'nfe-cancelada',
  envioNaoLigado: 'envio-nao-ligado',
  chamadasDesligadas: 'chamadas-desligadas',
  tarefasDesligadas: 'tarefas-desligadas',
  contaIndisponivel: 'conta-indisponivel',
  semPermissao: 'sem-permissao',
  amazonIndisponivel: 'amazon-indisponivel',
  pedidoPendente: 'pedido-pendente',
  cancelamentoSolicitado: 'cancelamento-solicitado',
  pedidoNaoEncontradoNaAmazon: 'pedido-nao-encontrado-na-amazon',
  statusPedidoDesconhecido: 'status-pedido-desconhecido',
  nfeNaoPronta: 'nfe-nao-pronta',
  naoAmazon: 'nao-amazon',
  nfeNaoEDeVenda: 'nfe-nao-e-de-venda',
  naoDba: 'nao-dba',
  nfNaoRequerida: 'nf-nao-requerida',
  marketplaceEstrangeiro: 'marketplace-estrangeiro',
  pedidoCancelado: 'pedido-cancelado',
  jaAceita: 'ja-aceita',
  emissaoBloqueada: 'emissao-bloqueada',
  contaInativa: 'conta-inativa',
  taxaLimitada: 'taxa-limitada',
  posEnvioFalhou: 'pos-envio-falhou',
} as const satisfies Record<string, MotivoNfeAmazon>;

/* --------------------------------- the sets --------------------------------- */

/** A: the reasons that raise `nfeUploadRejeitado`. */
const AVISAM = [
  MOTIVO_NFE_AMAZON.xmlInvalido,
  MOTIVO_NFE_AMAZON.envioRecusado,
  MOTIVO_NFE_AMAZON.nfeGrandeDemais,
  MOTIVO_NFE_AMAZON.nfeRecusada,
  MOTIVO_NFE_AMAZON.nfeNaoRegistrada,
  MOTIVO_NFE_AMAZON.aceiteNaoConfirmado,
  MOTIVO_NFE_AMAZON.envioNaoConfirmado,
  MOTIVO_NFE_AMAZON.nfeParcialmenteAceita,
  MOTIVO_NFE_AMAZON.statusNfeDesconhecido,
  MOTIVO_NFE_AMAZON.nfeSubstituta,
  MOTIVO_NFE_AMAZON.nfeAmbigua,
  MOTIVO_NFE_AMAZON.nfeCancelada,
  MOTIVO_NFE_AMAZON.envioNaoLigado,
  MOTIVO_NFE_AMAZON.chamadasDesligadas,
  MOTIVO_NFE_AMAZON.tarefasDesligadas,
  MOTIVO_NFE_AMAZON.contaIndisponivel,
  MOTIVO_NFE_AMAZON.semPermissao,
  MOTIVO_NFE_AMAZON.amazonIndisponivel,
  MOTIVO_NFE_AMAZON.pedidoPendente,
  MOTIVO_NFE_AMAZON.cancelamentoSolicitado,
  MOTIVO_NFE_AMAZON.pedidoNaoEncontradoNaAmazon,
  MOTIVO_NFE_AMAZON.statusPedidoDesconhecido,
] as const satisfies readonly MotivoNfeAmazon[];

/** A reason that raises the aviso. */
export type MotivoNfeQueAvisaAmazon = (typeof AVISAM)[number];

/** S ⊂ A: the reasons that ALSO stamp `freteInicial.estado = error` (typed against A). */
const CARIMBAM = [
  MOTIVO_NFE_AMAZON.xmlInvalido,
  MOTIVO_NFE_AMAZON.envioRecusado,
  MOTIVO_NFE_AMAZON.nfeGrandeDemais,
  MOTIVO_NFE_AMAZON.nfeRecusada,
  MOTIVO_NFE_AMAZON.nfeNaoRegistrada,
] as const satisfies readonly MotivoNfeQueAvisaAmazon[];

/** Log only: nothing an operator must act on, or the operator's own deliberate state. */
const SO_LOG = [
  MOTIVO_NFE_AMAZON.nfeNaoPronta,
  MOTIVO_NFE_AMAZON.naoAmazon,
  MOTIVO_NFE_AMAZON.nfeNaoEDeVenda,
  MOTIVO_NFE_AMAZON.naoDba,
  MOTIVO_NFE_AMAZON.nfNaoRequerida,
  MOTIVO_NFE_AMAZON.marketplaceEstrangeiro,
  MOTIVO_NFE_AMAZON.pedidoCancelado,
  MOTIVO_NFE_AMAZON.jaAceita,
  MOTIVO_NFE_AMAZON.emissaoBloqueada,
  MOTIVO_NFE_AMAZON.contaInativa,
  MOTIVO_NFE_AMAZON.taxaLimitada,
  MOTIVO_NFE_AMAZON.posEnvioFalhou,
] as const satisfies readonly MotivoNfeAmazon[];

/**
 * The log-only reasons written at WARNING (the rest at INFO): an operator's
 * deliberate state (`emissao-bloqueada`, `conta-inativa`), D7's scope edge
 * (`nao-dba`, `nf-nao-requerida`), an unexpected Amazon answer
 * (`marketplace-estrangeiro`) or a lost post-submit write (`pos-envio-falhou`)
 * — each countable.
 */
const SO_LOG_EM_WARNING = [
  MOTIVO_NFE_AMAZON.emissaoBloqueada,
  MOTIVO_NFE_AMAZON.contaInativa,
  MOTIVO_NFE_AMAZON.naoDba,
  MOTIVO_NFE_AMAZON.nfNaoRequerida,
  MOTIVO_NFE_AMAZON.marketplaceEstrangeiro,
  MOTIVO_NFE_AMAZON.posEnvioFalhou,
] as const satisfies readonly (typeof SO_LOG)[number][];

export const MOTIVOS_NFE_QUE_AVISAM: ReadonlySet<MotivoNfeAmazon> = new Set<MotivoNfeAmazon>(
  AVISAM,
);
export const MOTIVOS_NFE_QUE_CARIMBAM: ReadonlySet<MotivoNfeAmazon> = new Set<MotivoNfeAmazon>(
  CARIMBAM,
);
export const MOTIVOS_NFE_SO_LOG: ReadonlySet<MotivoNfeAmazon> = new Set<MotivoNfeAmazon>(SO_LOG);
export const MOTIVOS_NFE_SO_LOG_EM_WARNING: ReadonlySet<MotivoNfeAmazon> = new Set<MotivoNfeAmazon>(
  SO_LOG_EM_WARNING,
);

/** Whether `motivo` raises the aviso (a type guard for the aviso writer). */
export function motivoNfeAvisa(motivo: MotivoNfeAmazon): motivo is MotivoNfeQueAvisaAmazon {
  return MOTIVOS_NFE_QUE_AVISAM.has(motivo);
}

/* ------------------------------ the fragments ------------------------------ */

/** The pt-BR fragment of every reason that avisa (module header). */
export const FRASE_DO_ERRO_NFE_AMAZON: Readonly<Record<MotivoNfeQueAvisaAmazon, string>> = {
  // ---- A + S ----
  'xml-invalido':
    'confira o XML autorizado da NF-e — o tipo e a finalidade da nota não puderam ser lidos, e ela não foi enviada à Amazon',
  'envio-recusado':
    'confira os dados da NF-e e envie-a pela Seller Central — a Amazon recusou o envio da nota',
  'nfe-grande-demais':
    'envie a NF-e pela Seller Central; se a nota precisar ser substituída, cancele-a na SEFAZ antes de emitir outra — a Amazon recusou o arquivo por ser grande demais',
  'nfe-recusada':
    'confira na Seller Central por que a Amazon recusou a NF-e; se a nota precisar ser substituída, cancele-a na SEFAZ antes de emitir a nova — a Amazon recusou a nota depois de recebê-la',
  'nfe-nao-registrada':
    'confira na Seller Central se a NF-e consta no pedido e envie-a por lá, se preciso — a Amazon aceitou o envio, mas a nota não apareceu no pedido',
  // ---- A ----
  'aceite-nao-confirmado':
    'confira na Seller Central se a NF-e foi aceita — o ERP não conseguiu confirmar a análise da nota pela Amazon',
  'envio-nao-confirmado':
    'confira na Seller Central se a NF-e consta no pedido e envie-a por lá, se preciso — o ERP não conseguiu confirmar o envio da nota à Amazon',
  'nfe-parcialmente-aceita':
    'confira na Seller Central qual NF-e a Amazon aceitou para o pedido — ela recusou ao menos uma das notas enviadas',
  'status-nfe-desconhecido':
    'confira a NF-e do pedido na Seller Central — a Amazon informou uma situação de nota que o ERP não reconhece',
  'nfe-substituta':
    'confira na Seller Central qual NF-e a Amazon tem; se for a cancelada, envie a substituta por lá — o pedido tem uma NF-e cancelada e outra aprovada',
  'nfe-ambigua':
    'confira na Seller Central qual NF-e a Amazon tem e deixe só uma NF-e de venda aprovada no pedido — o pedido tem mais de uma aprovada, e o ERP não envia nenhuma enquanto houver mais de uma',
  'nfe-cancelada':
    'se a NF-e cancelada já tinha sido enviada à Amazon, emita a substituta e envie-a pela Seller Central antes da coleta — a nota foi cancelada na SEFAZ',
  'envio-nao-ligado':
    'reenvie a NF-e quando o envio automático à Amazon estiver ligado para este pedido — a nota não foi enviada',
  'chamadas-desligadas':
    'reenvie a NF-e quando a integração com a Amazon estiver ligada — as chamadas à Amazon estão desligadas nesta implantação',
  'tarefas-desligadas':
    'acione o suporte técnico — a fila de envio de NF-e está desligada nesta implantação, e a nota não foi agendada',
  'conta-indisponivel':
    'reconecte a conta Amazon do pedido e reenvie a NF-e — a conta não foi encontrada, não está conectada ou aguarda uma nova autorização',
  'sem-permissao':
    'confira as permissões do aplicativo na Amazon e reenvie a NF-e — a Amazon recusou o acesso ao envio de notas fiscais',
  'amazon-indisponivel':
    'reenvie a NF-e mais tarde — a Amazon não respondeu em nenhuma das tentativas',
  'pedido-pendente':
    'reenvie a NF-e quando o pagamento do pedido for confirmado — o pedido ainda está pendente na Amazon',
  'cancelamento-solicitado':
    'responda à solicitação de cancelamento do comprador na Seller Central antes de enviar a NF-e — há um cancelamento solicitado no pedido',
  'pedido-nao-encontrado-na-amazon':
    'confira se o pedido pertence a esta conta da Amazon — a Amazon não o encontrou',
  'status-pedido-desconhecido':
    'confira o pedido na Seller Central e reenvie a NF-e — a Amazon informou uma situação de pedido que o ERP não reconhece',
};

/**
 * The aviso's `params.erro` for `motivo`: its fragment, verbatim (X = ∅: no
 * provider text is ever appended).
 *
 * @throws {RangeError} a log-only motivo — it raises no aviso, so it has no
 *   fragment (a programming error at the call site).
 */
export function fraseDoErroNfeAmazon(motivo: MotivoNfeAmazon): string {
  if (!motivoNfeAvisa(motivo)) {
    throw new RangeError('motivosNfe.ts: motivo sem aviso (só log) não tem fragmento');
  }
  return FRASE_DO_ERRO_NFE_AMAZON[motivo];
}
