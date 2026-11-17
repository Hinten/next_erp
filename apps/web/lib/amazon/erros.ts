/**
 * The failures of a call to the `apps/amazon` conta routes, and the pt-BR copy
 * each one earns.
 *
 * Three classes, one per way a call can fail:
 *
 * | class | when | `codigo` |
 * | --- | --- | --- |
 * | {@link AmazonBackendError} | a non-2xx answer | the envelope's `code`, or `null` when the body is not our envelope |
 * | {@link AmazonRespostaInvalidaError} | a 2xx whose body is not the shape the contract claims | `null` |
 * | {@link AmazonRedeError} | the request never got an answer (or its body dropped mid-read) | — |
 *
 * ⚠️ Copy is keyed on `codigo` FIRST and on the status only for a body that is
 * not our envelope. A status is not one meaning: a 503 is the read switch being
 * off (retrying cannot help) or a platform hiccup (it can), and a 500 is a
 * missing variable, a Firebase Admin that failed to start, or a crash — each
 * asks the operator for something different.
 *
 * Two families of `codigo` exist on these routes:
 *
 *  1. {@link CODIGO_ERRO_AMAZON} — the conta routes' own codes, a closed set in
 *     the shared contract (`@delfrance/schemas`, `contaAmazon.ts`). The copy is a
 *     `Record` over it, so a code the contract gains fails typecheck here until
 *     it has a sentence.
 *  2. `verifyCaller`'s codes (`@delfrance/data/admin/auth`): a 401 carrying the
 *     Firebase Auth code (`auth/id-token-expired`, `auth/id-token-revoked`, …)
 *     and a 500 carrying the Admin init code (`app/…`). Open-ended — Firebase
 *     owns the list — so they are matched by FAMILY (the prefix), never one by
 *     one. Its CODELESS answers (a 401 for a missing Bearer token, the 403 for a
 *     missing permission) are matched by status.
 *
 * A `codigo` from neither family — one a newer backend added — shows the
 * backend's own sentence: it is pt-BR text this repo wrote, built from ids and
 * variable names only (the contract promises no envelope carries a token, a
 * code, a state, a seller id or a ref).
 *
 * The label route (`POST /api/marketplace/amazon/etiqueta`, step 15) has its
 * OWN copy, {@link mensagemErroEtiquetaAmazon}: its codes are a third closed
 * set ({@link CODIGO_ERRO_ETIQUETA_AMAZON}), its 409s carry a `motivo`, and its
 * codeless answers mean something other than a conta route's (a codeless 5xx
 * there can be a scheduling call still running at Amazon, so it asks for a
 * wait, never for a retry).
 */
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ETIQUETA_AMAZON,
  MOTIVO_ETIQUETA_AMAZON,
  motivoEtiquetaAmazonSchema,
  type CodigoErroAmazon,
  type CodigoErroEtiquetaAmazon,
  type MotivoEtiquetaAmazon,
} from '@delfrance/schemas';

/** A non-2xx answer from the `apps/amazon` backend. */
export class AmazonBackendError extends Error {
  /** Field PATHS the backend blamed (`issues` on the envelope), never values. */
  readonly campos: readonly string[];
  /**
   * The label route's `motivo` (a 409's closed backend slug), as a PLAIN string:
   * a slug a newer backend adds must still reach the copy, which narrows it.
   * `null` for every other answer and every other call.
   */
  readonly motivo: string | null;

  constructor(
    /**
     * The backend's own sentence (`error` on the envelope) when the body was our
     * envelope, else a sentence built from the status. Never a raw body: a
     * proxy's whole HTML page would bury the cause.
     */
    message: string,
    readonly status: number,
    /**
     * The envelope's `code`, or `null` when the body was not our envelope (an
     * HTML page, `verifyCaller`'s codeless 401/403). A plain string: a code a
     * newer backend adds must still reach the copy. ⚠️ Key copy on THIS, never
     * on `status` alone.
     */
    readonly codigo: string | null,
    campos: readonly string[] = [],
    motivo: string | null = null,
  ) {
    super(message);
    this.name = 'AmazonBackendError';
    this.campos = campos;
    this.motivo = motivo;
  }
}

/**
 * The backend answered 2xx and the body was not the shape the contract claims —
 * the wrong fields, no body at all, or not JSON (a proxy's HTML page).
 *
 * ⚠️ A SUBCLASS of {@link AmazonBackendError}, matching the sibling clients:
 * catch sites narrow to the base and rethrow anything else, so a sibling class
 * would land as an unhandled rejection instead of a message. Narrow it FIRST:
 * it is never retryable, whatever its status.
 */
export class AmazonRespostaInvalidaError extends AmazonBackendError {
  constructor(
    message: string,
    /** The real 2xx the backend sent — never a hardcoded 200. */
    status: number,
    /** Field PATHS that failed, never values. */
    campos: readonly string[],
  ) {
    super(message, status, null, campos);
    this.name = 'AmazonRespostaInvalidaError';
  }
}

/**
 * The request never got an answer: a refused connection, a CORS refusal, a
 * socket that dropped mid-body.
 *
 * ⚠️ The message is a FIXED sentence: the transport's own text stays on
 * `cause`, so nothing a runtime chose to put in it can reach the operator's
 * screen or a log through `err.message`.
 */
export class AmazonRedeError extends Error {
  constructor(override readonly cause?: unknown) {
    super('Falha de rede ao contatar o backend da Amazon.');
    this.name = 'AmazonRedeError';
  }
}

/**
 * The copy for each conta-route code. TOTAL by typecheck over
 * {@link CodigoErroAmazon}: a code the contract gains does not compile here
 * until it has a sentence.
 *
 * `AMAZON_CONFIG_AUSENTE` gets the backend's own sentence appended by
 * {@link mensagemErroAmazon} — it names the missing variables, never a value.
 */
export const MENSAGENS_CODIGO_ERRO_AMAZON: Readonly<Record<CodigoErroAmazon, string>> = {
  [CODIGO_ERRO_AMAZON.ID_INVALIDO]:
    'O endereço desta página não traz um id de conta válido. Volte à lista de contas.',
  [CODIGO_ERRO_AMAZON.CONTA_NAO_ENCONTRADA]:
    'O backend da Amazon não encontrou esta conta, ou ela não é uma conta da Amazon. Volte à ' +
    'lista de contas.',
  [CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS]:
    'A integração com a Amazon fica desligada até a virada: até a migração para este sistema ' +
    '(ou por configuração do backend), nenhuma chamada à Amazon é feita. Nada foi enviado à ' +
    'Amazon nem salvo. Se a migração já ocorreu, avise o suporte.',
  [CODIGO_ERRO_AMAZON.CONFIG_AUSENTE]:
    'O backend da Amazon está sem a configuração da conexão. Avise quem cuida do deploy.',
};

/** Is `codigo` one of the conta routes' own codes? */
export function ehCodigoErroAmazon(codigo: string | null): codigo is CodigoErroAmazon {
  return codigo !== null && Object.hasOwn(MENSAGENS_CODIGO_ERRO_AMAZON, codigo);
}

/** `verifyCaller` answers a rejected ID token with the Firebase Auth code (401). */
const PREFIXO_CODIGO_AUTH = 'auth/';
/** `verifyCaller` answers a Firebase Admin that failed to start with the app code (500). */
const PREFIXO_CODIGO_APP = 'app/';

const MENSAGEM_SESSAO =
  'O backend da Amazon não aceitou sua sessão (o login expirou ou foi revogado). Recarregue a ' +
  'página e entre de novo.';
const MENSAGEM_ADMIN =
  'O backend da Amazon não conseguiu iniciar o acesso ao banco de dados (configuração do ' +
  'servidor). Avise quem cuida do deploy.';
const MENSAGEM_SEM_PERMISSAO =
  'Você não tem permissão para esta operação no backend da Amazon (requer a permissão de ' +
  'integrações).';

/**
 * What to say when the backend answered a non-2xx WITHOUT a code — the request
 * never reached a conta route (a proxy page, a platform timeout, a backend that
 * predates these routes), or it is `verifyCaller`'s codeless 401/403.
 */
export function mensagemHttpAmazon(status: number): string {
  if (status === 401) return MENSAGEM_SESSAO;
  if (status === 403) return MENSAGEM_SEM_PERMISSAO;
  if (status === 404) {
    return (
      `O backend da Amazon não respondeu por esta rota (HTTP ${String(status)}). Atualize a ` +
      'página e, se continuar, avise o suporte.'
    );
  }
  if (status >= 500) {
    return `O backend da Amazon falhou (HTTP ${String(status)}). Tente novamente em instantes.`;
  }
  return `Falha na comunicação com o backend da Amazon (HTTP ${String(status)}).`;
}

/**
 * The operator's copy for a failed call. TOTAL over {@link AmazonBackendError}:
 * a conta-route code, then a `verifyCaller` code family, then the backend's own
 * sentence for a code this build does not know, then the status.
 *
 * {@link AmazonRespostaInvalidaError} keeps the sentence the client built for
 * it (it names the field paths and says what to do).
 */
export function mensagemErroAmazon(err: AmazonBackendError): string {
  if (err instanceof AmazonRespostaInvalidaError) return err.message;
  const { codigo } = err;
  if (ehCodigoErroAmazon(codigo)) {
    const copia = MENSAGENS_CODIGO_ERRO_AMAZON[codigo];
    return codigo === CODIGO_ERRO_AMAZON.CONFIG_AUSENTE ? `${copia} ${err.message}` : copia;
  }
  if (codigo !== null && codigo.startsWith(PREFIXO_CODIGO_AUTH)) return MENSAGEM_SESSAO;
  if (codigo !== null && codigo.startsWith(PREFIXO_CODIGO_APP)) return MENSAGEM_ADMIN;
  if (codigo !== null) return err.message;
  return mensagemHttpAmazon(err.status);
}

/**
 * Whether repeating the SAME call could plausibly help.
 *
 * Never for a 2xx this build cannot read, a conta-route code (each is a verdict:
 * a bad id, no such conta, the switch off, a missing variable), a rejected
 * session or a Firebase Admin that failed to start — each answers the same way
 * until someone acts. A codeless 5xx may be transient; `501` is as permanent as
 * a 4xx.
 */
export function repetivelAmazon(err: AmazonBackendError): boolean {
  if (err instanceof AmazonRespostaInvalidaError) return false;
  if (err.codigo !== null) return false;
  return err.status >= 500 && err.status !== 501;
}

/* -------------------------------------------------------------------------- */
/*                     The Easy Ship label route (step 15)                     */
/* -------------------------------------------------------------------------- */

/**
 * The one sentence for "Amazon did not answer in time": the route's
 * `AMAZON_INDISPONIVEL`, and every CODELESS 5xx of the label call (a platform
 * 500, an instance lost mid-request, App Hosting's own 504).
 *
 * ⚠️ It asks for a WAIT, never for "tente de novo": the label call can be the
 * call that SCHEDULES the pickup, and one cut on our side may still be running
 * at Amazon. An immediate second click would then send a second first-time
 * schedule beside it — the one case Amazon documents nothing about. A reprint
 * about a minute later reads the order first, and finds the schedule.
 */
export const MENSAGEM_ETIQUETA_AMAZON_AGUARDE =
  'A Amazon não respondeu a tempo. Aguarde cerca de 1 minuto e reimprima pela lista de pedidos.';

/** The exit every refused first schedule shares: Seller Central schedules, then the ERP reprints. */
const AGENDE_NA_SELLER_CENTRAL =
  'agende a coleta na Seller Central; depois a reimpressão pelo ERP funciona.';

/**
 * The copy for each code of the label route. TOTAL by typecheck over
 * {@link CodigoErroEtiquetaAmazon}: a code the contract gains does not compile
 * here until it has a sentence.
 *
 * The three 409s (`NAO_ELEGIVEL`, `AGUARDANDO_NFE`, `RECUSADA`) show these only
 * when the answer carries NO `motivo`; with one, the motivo's sentence
 * ({@link MENSAGENS_MOTIVO_ETIQUETA_AMAZON}) says more.
 */
export const MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON: Readonly<
  Record<CodigoErroEtiquetaAmazon, string>
> = {
  [CODIGO_ERRO_ETIQUETA_AMAZON.CORPO_INVALIDO]:
    'O backend da Amazon recusou o pedido de etiqueta como inválido; nada foi enviado à Amazon. ' +
    'Atualize a página e, se continuar, avise o suporte.',
  [CODIGO_ERRO_ETIQUETA_AMAZON.PEDIDO_NAO_ENCONTRADO]:
    'O backend da Amazon não encontrou este pedido; nada foi enviado à Amazon. Atualize a ' +
    'página e confira o pedido.',
  [CODIGO_ERRO_ETIQUETA_AMAZON.SEM_PERMISSAO]:
    'A coleta deste pedido ainda não foi agendada na Amazon, e agendar exige a permissão de ' +
    'escrita de frete. Peça a alguém com essa permissão para imprimir a etiqueta.',
  [CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL]:
    'A etiqueta deste pedido não pode ser impressa pelo ERP agora; nada foi enviado à Amazon. ' +
    'Confira o pedido na Seller Central.',
  [CODIGO_ERRO_ETIQUETA_AMAZON.AGUARDANDO_NFE]:
    'A Amazon ainda não aceitou a NF-e deste pedido, e a etiqueta só sai depois do aceite. ' +
    'Confira o aviso de NF-e do pedido.',
  [CODIGO_ERRO_ETIQUETA_AMAZON.RECUSADA]:
    'A Amazon recusou agendar a coleta deste pedido; nada foi impresso. Confira o pedido na ' +
    'Seller Central.',
  [CODIGO_ERRO_ETIQUETA_AMAZON.INDISPONIVEL]:
    'A Amazon não entregou uma etiqueta utilizável para este pedido — imprima-a pela Seller ' +
    'Central.',
  [CODIGO_ERRO_ETIQUETA_AMAZON.AMAZON_INDISPONIVEL]: MENSAGEM_ETIQUETA_AMAZON_AGUARDE,
  [CODIGO_ERRO_ETIQUETA_AMAZON.CONTA_INDISPONIVEL]:
    'A conta Amazon deste pedido não pode ser usada agora (desativada, desconectada ou com a ' +
    'autorização pendente). Confira a conta em Canais e, até lá, imprima a etiqueta pela ' +
    'Seller Central.',
  [CODIGO_ERRO_ETIQUETA_AMAZON.DESLIGADA]:
    'A impressão de etiquetas da Amazon pelo ERP está desligada para este pedido. Imprima a ' +
    'etiqueta pela Seller Central.',
};

/**
 * The copy for each `motivo` a 409 of the label route can carry. TOTAL by
 * typecheck over {@link MotivoEtiquetaAmazon}.
 *
 * Of the three NF-e waits only `nfe-em-processamento` asks the operator to wait
 * and reprint: a note Amazon refused, or never received, does not resolve
 * itself however many reprints it gets, so those two send the operator to the
 * pedido's NF-e aviso. A refused FIRST schedule that the ERP will keep refusing
 * (`nf-nao-requerida`, `nfe-ambigua`, `nfe-substituta`, `nfe-cancelada`) names
 * its exit: schedule in Seller Central, after which the order reads as
 * scheduled and the ERP reprint prints.
 *
 * ⚠️ The two with a CANCELLED sale note put the NF-e step before that exit:
 * Amazon's order-level acceptance survives a cancellation, so Seller Central
 * would book the pickup over a note that no longer holds. The step is in the
 * sentence itself, not only in the NF-e aviso, which may not exist yet at a
 * checkout's first print.
 *
 * `coleta-cancelada` promises no ERP reprint: nothing guarantees that a
 * reschedule in Seller Central clears the cancelled package this refusal was
 * keyed on, so its exit prints there too.
 */
export const MENSAGENS_MOTIVO_ETIQUETA_AMAZON: Readonly<Record<MotivoEtiquetaAmazon, string>> = {
  [MOTIVO_ETIQUETA_AMAZON.naoAmazon]:
    'Este pedido não está ligado a uma conta Amazon no ERP, então a etiqueta não sai por esta ' +
    'integração. Confira o pedido.',
  [MOTIVO_ETIQUETA_AMAZON.outraIntegradora]:
    'O frete deste pedido não está com a Amazon (outra integração de frete, ou nenhuma). ' +
    'Confira o frete do pedido.',
  [MOTIVO_ETIQUETA_AMAZON.pedidoBloqueado]:
    'Este pedido está retido com erro no ERP, e a etiqueta não sai pelo ERP enquanto ele ' +
    'estiver assim. Imprima a etiqueta pela Seller Central.',
  [MOTIVO_ETIQUETA_AMAZON.mercadoriaFora]:
    'O frete deste pedido diz que a mercadoria já saiu, e a etiqueta não é reimpressa pelo ERP. ' +
    'Se ainda precisar dela, imprima pela Seller Central.',
  [MOTIVO_ETIQUETA_AMAZON.pedidoCancelado]: 'Este pedido foi cancelado. Não envie a mercadoria.',
  [MOTIVO_ETIQUETA_AMAZON.pedidoPendente]:
    'Este pedido ainda está pendente na Amazon, e a etiqueta só sai depois que a Amazon liberar ' +
    'o envio.',
  [MOTIVO_ETIQUETA_AMAZON.cancelamentoSolicitado]:
    'O comprador pediu o cancelamento deste pedido. Responda à solicitação na Seller Central ' +
    'antes de enviar a mercadoria.',
  [MOTIVO_ETIQUETA_AMAZON.naoDba]:
    'Este pedido não usa a coleta da Amazon (Delivery by Amazon), então a etiqueta não sai por ' +
    'esta integração.',
  [MOTIVO_ETIQUETA_AMAZON.jaEnviado]:
    'A Amazon diz que este pedido já foi enviado, e a etiqueta não é reimpressa pelo ERP. Se ' +
    'ainda precisar dela, imprima pela Seller Central.',
  [MOTIVO_ETIQUETA_AMAZON.statusPedidoInesperado]:
    'A Amazon devolveu este pedido num status que o ERP não reconhece. Imprima a etiqueta pela ' +
    'Seller Central.',
  [MOTIVO_ETIQUETA_AMAZON.pacoteDesconhecido]:
    'A Amazon devolveu um pacote deste pedido num estado que o ERP não reconhece. Imprima a ' +
    'etiqueta pela Seller Central.',
  [MOTIVO_ETIQUETA_AMAZON.coletaCancelada]:
    'A Amazon cancelou a coleta deste pedido. Reagende a coleta e imprima a etiqueta pela ' +
    'Seller Central.',
  [MOTIVO_ETIQUETA_AMAZON.marketplaceEstrangeiro]:
    'Este pedido é de um marketplace da Amazon fora do Brasil, então a etiqueta não sai por ' +
    'esta integração.',
  [MOTIVO_ETIQUETA_AMAZON.nfNaoRequerida]:
    'A Amazon marcou este pedido como sem NF-e exigida, e o ERP só agenda a coleta depois que a ' +
    `Amazon aceita a NF-e: ${AGENDE_NA_SELLER_CENTRAL}`,
  [MOTIVO_ETIQUETA_AMAZON.nfeAmbigua]:
    'Este pedido tem mais de uma NF-e de venda autorizada, e o ERP não agenda a coleta assim. ' +
    `Veja o aviso de NF-e do pedido e ${AGENDE_NA_SELLER_CENTRAL}`,
  [MOTIVO_ETIQUETA_AMAZON.nfeSubstituta]:
    'Este pedido tem uma NF-e de venda cancelada ao lado da autorizada, e o ERP não agenda a ' +
    'coleta nesse caso. Confira na Seller Central qual NF-e a Amazon tem (se for a cancelada, ' +
    `envie a autorizada por lá) e só então ${AGENDE_NA_SELLER_CENTRAL}`,
  [MOTIVO_ETIQUETA_AMAZON.nfeCancelada]:
    'A NF-e de venda deste pedido foi cancelada, e o ERP não agenda a coleta nesse caso. ' +
    `Emita a NF-e substituta, envie-a pela Seller Central e só então ${AGENDE_NA_SELLER_CENTRAL}`,
  [MOTIVO_ETIQUETA_AMAZON.dimensoesAusentes]:
    'A Amazon recusou agendar a coleta: faltam dimensões ou peso no anúncio do produto. ' +
    'Corrija o anúncio na Seller Central e reimprima pela lista de pedidos.',
  [MOTIVO_ETIQUETA_AMAZON.agendamentoRecusado]:
    'A Amazon recusou agendar a coleta deste pedido. Confira o pedido e a coleta na Seller ' +
    'Central.',
  [MOTIVO_ETIQUETA_AMAZON.nfeEmProcessamento]:
    'A Amazon ainda está processando a NF-e deste pedido (costuma levar alguns minutos). ' +
    'Aguarde e reimprima pela lista de pedidos.',
  [MOTIVO_ETIQUETA_AMAZON.nfeRecusadaPelaAmazon]:
    'A Amazon recusou a NF-e deste pedido. Veja o aviso de NF-e do pedido e confira o pedido ' +
    'na Seller Central.',
  [MOTIVO_ETIQUETA_AMAZON.nfeNaoEnviada]:
    'A Amazon não recebeu a NF-e deste pedido. Veja o aviso de NF-e do pedido e confira o ' +
    'pedido na Seller Central.',
};

/**
 * A `motivo` this build does not know (a slug a newer backend added): a neutral
 * sentence, never the status and never the raw slug.
 */
export const MENSAGEM_MOTIVO_ETIQUETA_AMAZON_DESCONHECIDO =
  'A Amazon recusou a etiqueta deste pedido — confira o pedido na Seller Central.';

/** The codes whose answer carries a `motivo` (the route's 409s). */
const CODIGOS_COM_MOTIVO: ReadonlySet<string> = new Set<CodigoErroEtiquetaAmazon>([
  CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL,
  CODIGO_ERRO_ETIQUETA_AMAZON.AGUARDANDO_NFE,
  CODIGO_ERRO_ETIQUETA_AMAZON.RECUSADA,
]);

/** Is `codigo` one of the label route's own codes? */
export function ehCodigoErroEtiquetaAmazon(
  codigo: string | null,
): codigo is CodigoErroEtiquetaAmazon {
  return codigo !== null && Object.hasOwn(MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON, codigo);
}

const MENSAGEM_ETIQUETA_SEM_PERMISSAO =
  'Você não tem permissão para imprimir etiquetas da Amazon (requer a permissão de frete).';

/**
 * The read switch's reused code on the label call: the conta panel's sentence
 * (left untouched in {@link MENSAGENS_CODIGO_ERRO_AMAZON}) plus the way to get
 * the label meanwhile, which the panel's sentence has no reason to name.
 */
const MENSAGEM_ETIQUETA_CHAMADAS_DESLIGADAS =
  `${MENSAGENS_CODIGO_ERRO_AMAZON[CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS]} Enquanto isso, ` +
  'imprima a etiqueta pela Seller Central.';

/**
 * What to say when the label call answered a non-2xx WITHOUT a code: a request
 * that never reached the route body (a proxy page, a platform 500 or 504, a
 * backend that predates the route), or `verifyCaller`'s codeless 401/403.
 *
 * ⚠️ Never {@link mensagemHttpAmazon}: its 403 names the integrações
 * permission (the label route checks frete), and its 5xx says to try again —
 * the one thing this call must never invite (see
 * {@link MENSAGEM_ETIQUETA_AMAZON_AGUARDE}).
 */
export function mensagemHttpEtiquetaAmazon(status: number): string {
  if (status === 401) return MENSAGEM_SESSAO;
  if (status === 403) return MENSAGEM_ETIQUETA_SEM_PERMISSAO;
  if (status >= 500) return MENSAGEM_ETIQUETA_AMAZON_AGUARDE;
  if (status === 404) {
    return (
      `O backend da Amazon não respondeu pela rota de etiqueta (HTTP ${String(status)}). Imprima ` +
      'a etiqueta pela Seller Central e avise o suporte.'
    );
  }
  return (
    `Falha na comunicação com o backend da Amazon (HTTP ${String(status)}). Imprima a etiqueta ` +
    'pela Seller Central e avise o suporte.'
  );
}

/**
 * The operator's copy for a failed label call. TOTAL over
 * {@link AmazonBackendError}, in order:
 *
 *  1. an unreadable 2xx keeps the sentence the client built for it;
 *  2. a label-route code: for a 409, its `motivo` narrowed through
 *     `motivoEtiquetaAmazonSchema` (a known slug ⇒ its sentence, an unknown one
 *     ⇒ {@link MENSAGEM_MOTIVO_ETIQUETA_AMAZON_DESCONHECIDO}, none ⇒ the code's
 *     own); any other code ⇒ the code's own;
 *  3. the read switch's reused code, `AMAZON_CHAMADAS_DESLIGADAS` (the conta
 *     panel's sentence plus the Seller Central exit);
 *  4. `verifyCaller`'s code families (`auth/…`, `app/…`);
 *  5. a code this build does not know ⇒ the backend's own sentence;
 *  6. no code ⇒ {@link mensagemHttpEtiquetaAmazon}.
 */
export function mensagemErroEtiquetaAmazon(err: AmazonBackendError): string {
  if (err instanceof AmazonRespostaInvalidaError) return err.message;
  const { codigo } = err;
  if (ehCodigoErroEtiquetaAmazon(codigo)) {
    if (CODIGOS_COM_MOTIVO.has(codigo) && err.motivo !== null) {
      const motivo = motivoEtiquetaAmazonSchema.safeParse(err.motivo);
      return motivo.success
        ? MENSAGENS_MOTIVO_ETIQUETA_AMAZON[motivo.data]
        : MENSAGEM_MOTIVO_ETIQUETA_AMAZON_DESCONHECIDO;
    }
    return MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON[codigo];
  }
  if (codigo === CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS) {
    return MENSAGEM_ETIQUETA_CHAMADAS_DESLIGADAS;
  }
  if (codigo !== null && codigo.startsWith(PREFIXO_CODIGO_AUTH)) return MENSAGEM_SESSAO;
  if (codigo !== null && codigo.startsWith(PREFIXO_CODIGO_APP)) return MENSAGEM_ADMIN;
  if (codigo !== null) return err.message;
  return mensagemHttpEtiquetaAmazon(err.status);
}
