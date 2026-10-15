/**
 * The NF-e upload's vocabulary (#1522, step 14): what one task DID, WHY, the
 * pt-BR fragment for every reason, the three sets that decide which reasons
 * raise an aviso, stamp the frete and carry a Shopee excerpt, and the queue's
 * own tasks-disabled class.
 *
 * The split is step 12's (`estoque/errosEstoque.ts`) and step 13's
 * (`precos/errosPreco.ts`): the vocabulary, its companion const, the text table
 * and the classes in one small module; every producer elsewhere.
 *
 * ## ONE union for every altitude
 *
 * An upload stops at many altitudes — the shared dispatch predicate, the
 * pedido, the XML, the conta, the order Shopee holds, Shopee's refusal, the
 * recheck, the rate limits, the valve — and every one lands in ONE
 * {@link MotivoNfeShopee} with ONE total {@link FRASE_DO_MOTIVO_NFE}. The
 * route's 409, the CLI's line, the aviso's `erro` and the completion log all
 * read the same slug. Where step 12 or 13 already names the condition, the
 * SPELLING is theirs (`reauth`, `cota-diaria`, `sem-shop-id`,
 * `conta-nao-configurada`, `tasks-desabilitadas`, `payload-invalido`,
 * `pausa-reenqueues-esgotados`, `recusa-desconhecida`, `loja-cross-border`);
 * the TYPE is not shared — each folder owns its vocabulary, so a member added
 * to one never silently widens another.
 *
 * ## The sets are the ONLY source of the two effects
 *
 * Whether a reason raises the aviso `nfeUploadRejeitado` and whether it stamps
 * `freteInicial.estado = error` is decided HERE, by membership, and nowhere
 * else — no producer restates it with an inline comparison. A stamp is a
 * DETERMINISTIC failure of THIS NF-e (the channel refused it, SEFAZ flagged it,
 * or our own XML can never be uploaded); never the ABSENCE of an answer
 * (exhausted transients, a note that does not show up, a lapsed grant, an
 * undeclared IP, the valve, the pauses). A test pins `CARIMBAM ⊂ AVISAM`: a
 * stamp nobody is told about is a pedido that silently stops shipping.
 *
 * ## ⚠️ PERSISTED, and never a member nothing produces
 *
 * The slug is stored in `aviso.motivo` and returned in the route's body, so a
 * rename orphans every row already written. And a member nothing produces is a
 * promise the UI renders and the code never keeps — the folder's
 * `motivosProduzidos.test.ts` backstop scans the producers' raw text for each.
 *
 * ## Not a Zod enum
 *
 * A hand-written union, the step-12/13 position: nothing parses a motivo from
 * an untrusted source. The companion const is declared anyway, so the set is
 * enumerable by a test and code names a member instead of spelling a slug.
 */
import { resumirTextoDaShopee } from './redacaoNfe';

/* ------------------------------- the outcomes ------------------------------- */

/**
 * What ONE task did — the completion log's `desfecho`.
 *
 * - `enviado` — uploaded now; the recheck is queued.
 * - `ja-enviado` — Shopee already holds OUR note; nothing uploaded.
 * - `validada` — Shopee holds our note and reads it valid.
 * - `adiado` — re-enqueued with a delay to wait for SERPRO (no attempt spent).
 * - `pausado` — re-enqueued with a delay by a rate limit (no attempt spent).
 * - `reverificacao-agendada` — a recheck re-enqueued itself for one more look.
 * - `descartado` — nothing to do, and nothing an operator must act on.
 * - `recusado` — a deterministic refusal; the sets decide aviso and stamp.
 * - `erro-final` — the last attempt ended without an answer.
 */
export type DesfechoNfeShopee =
  | 'enviado'
  | 'ja-enviado'
  | 'validada'
  | 'adiado'
  | 'pausado'
  | 'reverificacao-agendada'
  | 'descartado'
  | 'recusado'
  | 'erro-final';

/** The closed set of {@link DesfechoNfeShopee}; keys are the slugs in camelCase. */
export const DESFECHO_NFE_SHOPEE = {
  enviado: 'enviado',
  jaEnviado: 'ja-enviado',
  validada: 'validada',
  adiado: 'adiado',
  pausado: 'pausado',
  reverificacaoAgendada: 'reverificacao-agendada',
  descartado: 'descartado',
  recusado: 'recusado',
  erroFinal: 'erro-final',
} as const satisfies Record<string, DesfechoNfeShopee>;

/* ------------------------------ the vocabulary ------------------------------ */

/**
 * WHY a task ended where it did. Fifty-six members, grouped by the altitude
 * that produces them; each member is a MECHANISM, and its sentence is
 * {@link FRASE_DO_MOTIVO_NFE}'s.
 *
 * ⚠️ There is no "the frete belongs to another integradora" member: the upload
 * attaches the note to the ORDER, never to a shipment, so a re-pointed frete
 * still uploads — only the frete stamp is owner-guarded, by its own outcome.
 */
export type MotivoNfeShopee =
  // ---- the shared dispatch predicate, re-checked at task level (4) ----
  | 'apagada'
  | 'nao-aprovada'
  | 'xml-ausente'
  | 'tpamb-homologacao'
  // ---- the NF-e document and the slot rule (3) ----
  | 'nfe-nao-encontrada'
  | 'sem-nfe-aprovada'
  | 'nfe-nao-e-de-venda'
  // ---- the pedido (3) ----
  | 'pedido-nao-encontrado'
  | 'nao-shopee'
  | 'emissao-bloqueada'
  // ---- our own XML, before any Shopee call (2) ----
  | 'xml-invalido'
  | 'xml-grande-demais'
  // ---- the conta and the client (4) ----
  | 'conta-nao-configurada'
  | 'conta-inativa'
  | 'sem-shop-id'
  | 'configuracao-do-app'
  // ---- the SERPRO wait (1) ----
  | 'aguardando-serpro'
  // ---- the order Shopee holds (6) ----
  | 'pedido-inexistente-no-canal'
  | 'pedido-nao-br'
  | 'pedido-fbs'
  | 'loja-cross-border'
  | 'pedido-cancelado'
  | 'pedido-exportacao'
  // ---- the note Shopee holds (9) ----
  | 'outra-nfe-anexada'
  | 'chave-ilegivel'
  | 'nfe-validada'
  | 'validacao-pendente'
  | 'status-desconhecido'
  | 'nota-dispensada'
  | 'nao-refletida-ainda'
  | 'sefaz-pendente'
  | 'nao-anexada'
  // ---- Shopee's refusal of the upload (16) ----
  | 'emissor-shopee'
  | 'cnpj-divergente'
  | 'uf-divergente'
  | 'ie-divergente'
  | 'nfe-cancelada'
  | 'data-de-emissao-invalida'
  | 'modelo-nao-55'
  | 'cfop-nao-aceito'
  | 'xml-recusado'
  | 'chave-invalida'
  | 'requisicao-invalida'
  | 'chave-em-outro-pedido'
  | 'nfe-invalida'
  | 'recusa-desconhecida'
  | 'ip-nao-declarado'
  | 'sem-suporte-a-nfe'
  // ---- the grant, the transport, the limits and the valve (8) ----
  | 'reauth'
  | 'canal-indisponivel'
  | 'reverificacao-indisponivel'
  | 'limite-de-taxa'
  | 'cota-diaria'
  | 'pausa-reenqueues-esgotados'
  | 'tasks-desabilitadas'
  | 'payload-invalido';

/**
 * The closed set, for iteration and so code names a member instead of spelling
 * a slug. Keys are the slugs in camelCase — a test pins the pairing.
 */
export const MOTIVO_NFE_SHOPEE = {
  // ---- the shared dispatch predicate (4) ----
  apagada: 'apagada',
  naoAprovada: 'nao-aprovada',
  xmlAusente: 'xml-ausente',
  tpambHomologacao: 'tpamb-homologacao',
  // ---- the NF-e document and the slot rule (3) ----
  nfeNaoEncontrada: 'nfe-nao-encontrada',
  semNfeAprovada: 'sem-nfe-aprovada',
  nfeNaoEDeVenda: 'nfe-nao-e-de-venda',
  // ---- the pedido (3) ----
  pedidoNaoEncontrado: 'pedido-nao-encontrado',
  naoShopee: 'nao-shopee',
  emissaoBloqueada: 'emissao-bloqueada',
  // ---- our own XML (2) ----
  xmlInvalido: 'xml-invalido',
  xmlGrandeDemais: 'xml-grande-demais',
  // ---- the conta and the client (4) ----
  contaNaoConfigurada: 'conta-nao-configurada',
  contaInativa: 'conta-inativa',
  semShopId: 'sem-shop-id',
  configuracaoDoApp: 'configuracao-do-app',
  // ---- the SERPRO wait (1) ----
  aguardandoSerpro: 'aguardando-serpro',
  // ---- the order Shopee holds (6) ----
  pedidoInexistenteNoCanal: 'pedido-inexistente-no-canal',
  pedidoNaoBr: 'pedido-nao-br',
  pedidoFbs: 'pedido-fbs',
  lojaCrossBorder: 'loja-cross-border',
  pedidoCancelado: 'pedido-cancelado',
  pedidoExportacao: 'pedido-exportacao',
  // ---- the note Shopee holds (9) ----
  outraNfeAnexada: 'outra-nfe-anexada',
  chaveIlegivel: 'chave-ilegivel',
  nfeValidada: 'nfe-validada',
  validacaoPendente: 'validacao-pendente',
  statusDesconhecido: 'status-desconhecido',
  notaDispensada: 'nota-dispensada',
  naoRefletidaAinda: 'nao-refletida-ainda',
  sefazPendente: 'sefaz-pendente',
  naoAnexada: 'nao-anexada',
  // ---- Shopee's refusal of the upload (16) ----
  emissorShopee: 'emissor-shopee',
  cnpjDivergente: 'cnpj-divergente',
  ufDivergente: 'uf-divergente',
  ieDivergente: 'ie-divergente',
  nfeCancelada: 'nfe-cancelada',
  dataDeEmissaoInvalida: 'data-de-emissao-invalida',
  modeloNao55: 'modelo-nao-55',
  cfopNaoAceito: 'cfop-nao-aceito',
  xmlRecusado: 'xml-recusado',
  chaveInvalida: 'chave-invalida',
  requisicaoInvalida: 'requisicao-invalida',
  chaveEmOutroPedido: 'chave-em-outro-pedido',
  nfeInvalida: 'nfe-invalida',
  recusaDesconhecida: 'recusa-desconhecida',
  ipNaoDeclarado: 'ip-nao-declarado',
  semSuporteANfe: 'sem-suporte-a-nfe',
  // ---- the grant, the transport, the limits and the valve (8) ----
  reauth: 'reauth',
  canalIndisponivel: 'canal-indisponivel',
  reverificacaoIndisponivel: 'reverificacao-indisponivel',
  limiteDeTaxa: 'limite-de-taxa',
  cotaDiaria: 'cota-diaria',
  pausaReenqueuesEsgotados: 'pausa-reenqueues-esgotados',
  tasksDesabilitadas: 'tasks-desabilitadas',
  payloadInvalido: 'payload-invalido',
} as const satisfies Record<string, MotivoNfeShopee>;

/* ------------------------------ the text table ------------------------------ */

/**
 * The pt-BR FRAGMENT for every member — the ONE text table of this folder.
 *
 * The aviso renders `O envio da NF-e do pedido {pedido} ao canal não foi
 * concluído: {erro}.`, so each entry is a **lowercase fragment with no trailing
 * period**; {@link mensagemDoMotivoNfe} capitalizes it and adds the period for
 * the route's and the CLI's sentence. Where the operator has something to DO,
 * the remedy comes FIRST and the cause follows the dash; where nothing is
 * theirs to do, the fragment states the fact.
 *
 * ⚠️ `Record<MotivoNfeShopee, string>`, and there is no `?? fallback` on a
 * lookup anywhere: a member without a fragment is a COMPILE error here, never
 * a blank at runtime.
 *
 * ⚠️ **No identifier and no provider payload.** Never a chave, a CNPJ, an IE,
 * an order number or Shopee's own text — the one channel for Shopee's text is
 * {@link fraseDoErroDoAviso}'s sanitized excerpt, and only for the members of
 * {@link MOTIVOS_COM_EXCERTO}. And no other channel's name: this is the
 * Shopee integration's text, and a sentence borrowed from another integration
 * describes that one's mechanism, not this one's.
 */
export const FRASE_DO_MOTIVO_NFE: Record<MotivoNfeShopee, string> = {
  // ---- the shared dispatch predicate ----
  apagada: 'a NF-e foi apagada, e não há documento a enviar',
  'nao-aprovada':
    'aguarde a autorização da NF-e na SEFAZ — só uma NF-e aprovada é enviada ao canal',
  'xml-ausente':
    'a NF-e aprovada não tem o XML autorizado guardado no ERP, e sem ele não há o que enviar',
  'tpamb-homologacao':
    'a NF-e foi emitida em homologação, sem valor fiscal; só uma NF-e de produção é enviada ao canal',
  // ---- the NF-e document and the slot rule ----
  'nfe-nao-encontrada':
    'a NF-e não foi encontrada; ela pode ter sido apagada depois que o envio foi agendado',
  'sem-nfe-aprovada':
    'emita e aprove a NF-e de venda do pedido antes de enviá-la — o pedido não tem NF-e aprovada em produção',
  'nfe-nao-e-de-venda':
    'a NF-e não é a nota de venda do pedido (é de entrada, complementar, de ajuste ou de devolução); só a nota de venda é enviada ao canal',
  // ---- the pedido ----
  'pedido-nao-encontrado': 'o pedido da NF-e não foi encontrado',
  'nao-shopee': 'o pedido não veio da Shopee, e esta integração só envia NF-e de pedidos da Shopee',
  'emissao-bloqueada':
    'o pedido está marcado para não emitir NF-e, e nenhuma nota dele é enviada ao canal',
  // ---- our own XML ----
  'xml-invalido':
    'confira o XML autorizado da NF-e — ele não traz uma chave de acesso legível e única, e sem ela a nota não pode ser enviada',
  'xml-grande-demais':
    'emita a NF-e com um XML menor (menos itens ou menos informações complementares) — este passa do limite de 1 MB aceito pela Shopee',
  // ---- the conta and the client ----
  'conta-nao-configurada':
    'reconecte a conta Shopee do pedido — ela não foi encontrada ou não está configurada',
  'conta-inativa': 'reative a conta Shopee no ERP para enviar a NF-e — ela está desativada',
  'sem-shop-id': 'reconecte a conta Shopee — ela não tem a loja (shop_id) vinculada',
  'configuracao-do-app':
    'acione o suporte técnico — faltam as credenciais do aplicativo Shopee no servidor',
  // ---- the SERPRO wait ----
  'aguardando-serpro':
    'aguarde alguns minutos e tente de novo — a Shopee só aceita a NF-e cerca de cinco minutos depois da autorização',
  // ---- the order Shopee holds ----
  'pedido-inexistente-no-canal':
    'a Shopee não encontrou o pedido na loja da conta; confira se ele pertence a esta conta',
  'pedido-nao-br':
    'o pedido não é de uma loja do Brasil, e a NF-e só é enviada para pedidos brasileiros',
  'pedido-fbs':
    'o pedido é atendido pelo fulfillment da Shopee (FBS), e o ERP não envia NF-e para esses pedidos',
  'loja-cross-border': 'a loja é cross-border, e o ERP não envia NF-e para pedidos cross-border',
  'pedido-cancelado': 'o pedido foi cancelado na Shopee, e a NF-e não é enviada',
  'pedido-exportacao':
    'confira se esta NF-e deveria existir — o pedido é internacional, e a nota fiscal dele é emitida pela própria Shopee',
  // ---- the note Shopee holds ----
  'outra-nfe-anexada':
    'confira qual NF-e vale para o pedido — a Shopee já tem outra NF-e anexada a ele, e o ERP não a substitui',
  'chave-ilegivel':
    'confira a NF-e anexada ao pedido na Shopee — a chave de acesso que ela mostra não é legível',
  'nfe-validada': 'a NF-e foi validada pela Shopee',
  'validacao-pendente': 'a Shopee ainda não concluiu a validação da NF-e',
  'status-desconhecido': 'a Shopee informou um status de NF-e que o ERP não reconhece',
  'nota-dispensada': 'a Shopee marca a nota do pedido como válida mesmo sem uma NF-e anexada',
  'nao-refletida-ainda': 'a Shopee aceitou a NF-e, mas ela ainda não aparece no pedido',
  'sefaz-pendente':
    'corrija a NF-e e emita outra, se preciso — a validação da nota na Shopee ficou pendente',
  'nao-anexada':
    'confira o pedido no Seller Center da Shopee — a NF-e enviada não aparece anexada a ele',
  // ---- Shopee's refusal of the upload ----
  'emissor-shopee':
    'em Seller Center → Perfil da loja → Configuração de nota fiscal, escolha «Outro» como emissor — a loja está configurada com a Shopee emitindo a NF-e',
  'cnpj-divergente':
    'confira o CNPJ da loja no Seller Center — o CNPJ do emitente da NF-e não é o cadastrado na Shopee',
  'uf-divergente':
    'confira a UF da loja no Seller Center — a UF do emitente da NF-e não é a cadastrada na Shopee',
  'ie-divergente':
    'confira a inscrição estadual da loja no Seller Center — a do emitente da NF-e não é a cadastrada na Shopee',
  'nfe-cancelada': 'emita uma nova NF-e para o pedido — esta foi cancelada na SEFAZ',
  'data-de-emissao-invalida':
    'emita uma nova NF-e com data de emissão válida — a Shopee recusou a data desta (por exemplo, anterior ao pagamento do pedido)',
  'modelo-nao-55': 'emita a nota como NF-e modelo 55 — a Shopee só aceita esse modelo',
  'cfop-nao-aceito':
    'emita uma nova NF-e com um CFOP de venda aceito pela Shopee — o CFOP desta foi recusado',
  'xml-recusado': 'confira o XML da NF-e — a Shopee recusou o arquivo como XML de nota',
  'chave-invalida': 'confira a chave de acesso da NF-e — a Shopee recusou a chave desta nota',
  'requisicao-invalida':
    'acione o suporte técnico — a Shopee recusou o formato do envio feito pelo ERP',
  'chave-em-outro-pedido':
    'confira em qual pedido esta NF-e deve ficar — a Shopee já tem a mesma nota anexada a outro pedido',
  'nfe-invalida':
    'confira a NF-e na SEFAZ e emita outra, se preciso — a Shopee continuou a considerá-la inválida depois de várias tentativas espaçadas',
  'recusa-desconhecida':
    'confira a NF-e e o pedido na Shopee — ela recusou a nota por um motivo que o ERP não reconhece',
  'ip-nao-declarado':
    'acione o suporte técnico — o IP do servidor do ERP não está liberado no aplicativo da Shopee',
  'sem-suporte-a-nfe':
    'a Shopee não aceita NF-e para este pedido (a transportadora ou a situação do pedido dispensa a nota)',
  // ---- the grant, the transport, the limits and the valve ----
  reauth: 'reconecte a conta Shopee — a autorização da loja expirou',
  'canal-indisponivel':
    'verifique no Seller Center se a NF-e ficou anexada ao pedido, ou reenvie a nota pelo ERP — a Shopee não confirmou o envio em nenhuma das tentativas',
  'reverificacao-indisponivel':
    'a Shopee não respondeu na conferência da NF-e, e o ERP não conseguiu confirmar se a nota ficou anexada',
  'limite-de-taxa': 'a Shopee limitou a frequência de chamadas, e o envio foi reagendado',
  'cota-diaria':
    'a cota diária de chamadas da Shopee acabou, e o envio foi reagendado para depois da virada do dia',
  'pausa-reenqueues-esgotados':
    'o envio parou depois de ser adiado várias vezes pelos limites de chamadas da Shopee',
  'tasks-desabilitadas':
    'acione o suporte técnico — a fila de envio de NF-e está desligada nesta implantação, e a nota não foi agendada',
  'payload-invalido': 'a tarefa de envio chegou com dados inválidos e foi descartada',
};

/**
 * The route's and the CLI's SENTENCE for a motivo: the fragment with its first
 * letter capitalized and a closing period.
 */
export function mensagemDoMotivoNfe(motivo: MotivoNfeShopee): string {
  const frase = FRASE_DO_MOTIVO_NFE[motivo];
  return `${frase.charAt(0).toLocaleUpperCase('pt-BR')}${frase.slice(1)}.`;
}

/**
 * The aviso's `params.erro`: the member's fragment, followed by `: <excerpt>`
 * ONLY when the member is in {@link MOTIVOS_COM_EXCERTO} and an excerpt exists.
 *
 * ⚠️ The excerpt is run through {@link resumirTextoDaShopee} HERE as well, so
 * an unsanitized string handed in by mistake still cannot reach the aviso —
 * the guarantee is structural, not a convention every caller must keep. The
 * sanitizer is idempotent on its own output, so a caller that already
 * sanitized pays nothing. On any other member the excerpt is DROPPED, whatever
 * it holds: Shopee's text reaches an operator only where its meaning is not
 * ours to know in advance.
 */
export function fraseDoErroDoAviso(motivo: MotivoNfeShopee, excerto: string | null): string {
  const frase = FRASE_DO_MOTIVO_NFE[motivo];
  if (!MOTIVOS_COM_EXCERTO.has(motivo)) return frase;
  const limpo = resumirTextoDaShopee(excerto);
  return limpo === null ? frase : `${frase}: ${limpo}`;
}

/* --------------------------------- the sets --------------------------------- */

/**
 * The members that raise the aviso `nfeUploadRejeitado` (one chave per pedido)
 * — the operator must act, or must at least know the pedido will not ship on
 * its own.
 *
 * ⚠️ What is deliberately OUT: every skip where nothing reached Shopee and
 * nothing is wrong (the predicate, the pedido, the order's region/FBS/
 * cross-border/cancellation); the conta gates, which LOG only (a deliberate
 * switch-off would otherwise raise one aviso per pedido); an order Shopee does
 * not know (no machine resolver could ever close that row); the log-only
 * readings of the note; the pauses while they last; and the recheck's own
 * transport failure (the upload's aviso, if any, already stands).
 */
export const MOTIVOS_QUE_AVISAM: ReadonlySet<MotivoNfeShopee> = new Set<MotivoNfeShopee>([
  'xml-invalido',
  'xml-grande-demais',
  'pedido-exportacao',
  'outra-nfe-anexada',
  'chave-ilegivel',
  'sefaz-pendente',
  'nao-anexada',
  'emissor-shopee',
  'cnpj-divergente',
  'uf-divergente',
  'ie-divergente',
  'nfe-cancelada',
  'data-de-emissao-invalida',
  'modelo-nao-55',
  'cfop-nao-aceito',
  'xml-recusado',
  'chave-invalida',
  'requisicao-invalida',
  'chave-em-outro-pedido',
  'nfe-invalida',
  'recusa-desconhecida',
  'ip-nao-declarado',
  'reauth',
  'canal-indisponivel',
  'pausa-reenqueues-esgotados',
  'tasks-desabilitadas',
]);

/**
 * The members that ALSO stamp `freteInicial.estado = error` — a DETERMINISTIC
 * failure of THIS NF-e: Shopee refused it, SEFAZ flagged it, or our own XML can
 * never be uploaded. A subset of {@link MOTIVOS_QUE_AVISAM} (a test pins it).
 *
 * ⚠️ Deliberately OUT, each an absence of an answer rather than a refusal of
 * this note: the exhausted transport (`canal-indisponivel`), a note that does
 * not show up (`nao-anexada`), the lapsed grant, the undeclared IP, the valve
 * and the pauses; and the three readings where the ATTACHED note may be the
 * valid one (another note, an illegible key, an export order). A stamp is not
 * revocable by this step, so it is spent only where a retry would meet the
 * same refusal unchanged.
 */
export const MOTIVOS_QUE_CARIMBAM: ReadonlySet<MotivoNfeShopee> = new Set<MotivoNfeShopee>([
  'xml-invalido',
  'xml-grande-demais',
  'sefaz-pendente',
  'emissor-shopee',
  'cnpj-divergente',
  'uf-divergente',
  'ie-divergente',
  'nfe-cancelada',
  'data-de-emissao-invalida',
  'modelo-nao-55',
  'cfop-nao-aceito',
  'xml-recusado',
  'chave-invalida',
  'requisicao-invalida',
  'chave-em-outro-pedido',
  'nfe-invalida',
  'recusa-desconhecida',
]);

/**
 * The members whose aviso carries a sanitized Shopee EXCERPT — the two whose
 * meaning is not ours to know in advance: SEFAZ's pending reason, and the
 * detail of a refusal no classifier row recognises. A subset of
 * {@link MOTIVOS_QUE_AVISAM}. The frete stamp carries no text at all.
 */
export const MOTIVOS_COM_EXCERTO: ReadonlySet<MotivoNfeShopee> = new Set<MotivoNfeShopee>([
  'sefaz-pendente',
  'recusa-desconhecida',
]);

/* ------------------------------ the valve class ------------------------------ */

/**
 * The NF-e queue's OWN "tasks are switched off here" error, thrown by its
 * scheduler before the transport when `SHOPEE_TASKS_DISABLED` is `'1'`.
 *
 * ⚠️ Deliberately NOT the channel's shared tasks-disabled class: that one is in
 * `core/containment.ts`'s per-conta containment set, so an NF-e enqueue that
 * raised it could be CONTAINED as one conta's `lastError` instead of reaching
 * the trigger's arm that raises the aviso, or the route's 503. The valve is a
 * DEPLOYMENT state, and there is no NF-e sweep behind it to catch up later, so
 * every caller must see THIS class and answer it explicitly. A bare `Error`,
 * not a Shopee error, because nothing Shopee-shaped went wrong.
 */
export class ShopeeNfeUploadTasksDisabledError extends Error {
  constructor() {
    super(
      'SHOPEE_TASKS_DISABLED=1 — a fila de envio de NF-e à Shopee está desabilitada nesta implantação; ' +
        'não há varredura por trás deste caminho, então nada foi agendado.',
    );
    this.name = 'ShopeeNfeUploadTasksDisabledError';
  }
}
