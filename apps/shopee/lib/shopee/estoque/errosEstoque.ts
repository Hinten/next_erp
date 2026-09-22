/**
 * The stock sync's PERSISTED vocabulary, its rendered pt-BR table, its per-model
 * outcome row and its two error classes (#1520, step 12).
 *
 * The split mirrors `anuncios/errosPublicacao.ts`: the vocabulary, the const,
 * the message table and the classes in one small module; the code→motivo
 * classifier and every producer elsewhere.
 *
 * ## ONE union, not two
 *
 * A stock send is refused at four different altitudes — before a conta is even
 * walked (a valve), per conta (a shop-level gate), per listing (the link's own
 * state), and per model (Shopee's `failure_list`) — and it is tempting to give
 * each its own union. It is also the drift shape: every surface that renders one
 * would have to render all four, the render tables would be four maps, and the
 * day a condition moves altitude (a per-listing refusal that turns out to be
 * conta-wide) it gains a second slug for one condition. So: ONE
 * {@link MotivoEstoqueShopee}, one total {@link MENSAGEM_POR_MOTIVO}, and every
 * surface renders through the same lookup. Five pairs of synonyms were deduped
 * for exactly that reason — one condition, one slug, even when two detectors
 * find it.
 *
 * ## ⚠️ The vocabulary is PERSISTED and is not free to rename
 *
 * A slug is stored on the link document (`estoqueRecusaMotivo`,
 * `estoqueRecusaCodigo`'s companion), returned in the manual push's body, and
 * will be a filter value in the web surface. Adding a member is cheap; renaming
 * one orphans every row already written — verbatim the rule
 * `errosPublicacao.ts` states for its three vocabularies.
 *
 * ## ⚠️ And no member that nothing can produce
 *
 * The other half of the same rule, and the one that is easy to break while
 * feeling thorough: a declared reason nobody writes is a filter the UI renders
 * and the code never fills. `nao-publicado` is the worked example here — the
 * `publicado` gate was REMOVED from this ERP's stock discovery under #1087/#804
 * and the query does not read the field, so a "not published" refusal could
 * never be written. It is deliberately absent, as are the four listing states
 * that actually SEND (scheduled, paused by the ERP, unknown, and an unlisted
 * listing). `errosImportacao.ts`'s `kit-nao-importado` is the precedent.
 *
 * ## Not a Zod enum
 *
 * `delfrance/prefer-schema-enum` keys on the DECLARATION behind a literal's
 * position, and this is a hand-written union — the same place
 * `ETAPA_PUBLICACAO` takes and documents. The companion const is declared
 * anyway, so the set is enumerable by a test and so code writes a name instead
 * of a slug.
 */
import { limitarMensagemProblema } from '../anuncios/errosPublicacao';

/* ------------------------------ the vocabulary ----------------------------- */

/**
 * Why a listing, a conta, a model or a whole tick did not send a quantity.
 *
 * Each member is a MECHANISM; the sentence is {@link MENSAGEM_POR_MOTIVO}'s.
 */
export type MotivoEstoqueShopee =
  // ---- read side, per listing (12) ----
  | 'sem-link'
  | 'sem-item-id'
  | 'conta-fora-do-produto'
  | 'anuncio-removido'
  | 'anuncio-banido'
  | 'anuncio-em-revisao'
  | 'kit-derivado'
  | 'sem-modelos'
  | 'familia-sem-quantidade'
  | 'recusa-anterior'
  | 'task-excede-limite'
  | 'produto-nao-encontrado'
  // ---- conta side (9) ----
  | 'sem-shop-id'
  | 'sem-deposito'
  | 'conta-pausada'
  | 'conta-nao-configurada'
  | 'loja-fbs'
  | 'loja-cbsc'
  | 'loja-banida-ou-congelada'
  | 'loja-outlet'
  | 'multi-armazem'
  // ---- valves (4) ----
  | 'sync-desabilitado'
  | 'tasks-desabilitadas'
  | 'payload-invalido'
  | 'pausa-reenqueues-esgotados'
  // ---- write side, the error table (18) ----
  | 'piso-de-reserva-nao-atendido'
  | 'piso-acima-da-banda'
  | 'bloqueado-por-promocao'
  | 'forma-de-modelo-divergente'
  | 'modelo-invalido'
  | 'anuncio-inexistente'
  | 'anuncio-de-outra-loja'
  | 'anuncio-nao-editavel'
  | 'estrutura-de-estoque-divergente'
  | 'loja-cnsc-nao-migrada'
  | 'loja-com-penalidade'
  | 'loja-armazem'
  | 'loja-vsku'
  | 'sem-permissao'
  | 'loja-em-ferias'
  | 'cota-diaria'
  | 'reauth'
  | 'recusa-desconhecida'
  // ---- per model (2) ----
  | 'modelo-sem-resposta'
  | 'envio-parcial'
  // ---- the manual push (1) ----
  | 'tempo-esgotado'
  // ---- an ANNOTATION, never a refusal (1) ----
  | 'clampado-na-reserva';

/**
 * The closed set, for iteration and so code names a member instead of spelling
 * a slug.
 *
 * ⚠️ `nao-publicado` is deliberately ABSENT — see the module docblock.
 */
export const MOTIVO_ESTOQUE_SHOPEE = {
  // ---- read side, per listing (12) ----
  semLink: 'sem-link',
  semItemId: 'sem-item-id',
  contaForaDoProduto: 'conta-fora-do-produto',
  anuncioRemovido: 'anuncio-removido',
  anuncioBanido: 'anuncio-banido',
  anuncioEmRevisao: 'anuncio-em-revisao',
  kitDerivado: 'kit-derivado',
  semModelos: 'sem-modelos',
  familiaSemQuantidade: 'familia-sem-quantidade',
  recusaAnterior: 'recusa-anterior',
  taskExcedeLimite: 'task-excede-limite',
  produtoNaoEncontrado: 'produto-nao-encontrado',
  // ---- conta side (9) ----
  semShopId: 'sem-shop-id',
  semDeposito: 'sem-deposito',
  contaPausada: 'conta-pausada',
  contaNaoConfigurada: 'conta-nao-configurada',
  lojaFbs: 'loja-fbs',
  lojaCbsc: 'loja-cbsc',
  lojaBanidaOuCongelada: 'loja-banida-ou-congelada',
  lojaOutlet: 'loja-outlet',
  multiArmazem: 'multi-armazem',
  // ---- valves (4) ----
  syncDesabilitado: 'sync-desabilitado',
  tasksDesabilitadas: 'tasks-desabilitadas',
  payloadInvalido: 'payload-invalido',
  pausaReenqueuesEsgotados: 'pausa-reenqueues-esgotados',
  // ---- write side, the error table (18) ----
  pisoDeReservaNaoAtendido: 'piso-de-reserva-nao-atendido',
  pisoAcimaDaBanda: 'piso-acima-da-banda',
  bloqueadoPorPromocao: 'bloqueado-por-promocao',
  formaDeModeloDivergente: 'forma-de-modelo-divergente',
  modeloInvalido: 'modelo-invalido',
  anuncioInexistente: 'anuncio-inexistente',
  anuncioDeOutraLoja: 'anuncio-de-outra-loja',
  anuncioNaoEditavel: 'anuncio-nao-editavel',
  estruturaDeEstoqueDivergente: 'estrutura-de-estoque-divergente',
  lojaCnscNaoMigrada: 'loja-cnsc-nao-migrada',
  lojaComPenalidade: 'loja-com-penalidade',
  lojaArmazem: 'loja-armazem',
  lojaVsku: 'loja-vsku',
  semPermissao: 'sem-permissao',
  lojaEmFerias: 'loja-em-ferias',
  cotaDiaria: 'cota-diaria',
  reauth: 'reauth',
  recusaDesconhecida: 'recusa-desconhecida',
  // ---- per model (2) ----
  modeloSemResposta: 'modelo-sem-resposta',
  envioParcial: 'envio-parcial',
  // ---- the manual push (1) ----
  tempoEsgotado: 'tempo-esgotado',
  // ---- an ANNOTATION, never a refusal (1) ----
  clampadoNaReserva: 'clampado-na-reserva',
} as const satisfies Record<string, MotivoEstoqueShopee>;

/**
 * The pt-BR sentence for EVERY member — cause AND remedy, in the operator's
 * words.
 *
 * ⚠️ `Record<MotivoEstoqueShopee, string>`, never `Record<string, string>`, and
 * there is **no `?? fallback` anywhere**. #1226 is the lesson, measured on the
 * Mercado Livre twin: a new skip reason compiled, no test failed, and the manual
 * push answered four words with no cause and no remedy. Typed this way, adding a
 * member is a COMPILE error here — which is the only mechanism that has ever
 * worked for this.
 *
 * ⚠️ **No PII and no provider payload.** Never a produto name, never an
 * `item_name`, never an id, a token, a shop number or a raw response body. Every
 * sentence is a mechanism plus the action that fixes it; the provider's own code
 * travels separately, in the link document's `estoqueRecusaCodigo`, where a
 * reader can look it up without it being pasted into prose a human reads.
 */
export const MENSAGEM_POR_MOTIVO: Record<MotivoEstoqueShopee, string> = {
  // ---- read side, per listing ----
  'sem-link':
    'Este produto não tem anúncio vinculado nesta conta. Importe ou publique o anúncio; até lá nada é enviado.',
  'sem-item-id':
    'O vínculo deste produto com a Shopee existe, mas não guarda o número do anúncio, então não há o que atualizar. Reimporte o anúncio ou publique-o de novo para regravar o vínculo.',
  'conta-fora-do-produto':
    'O anúncio encontrado pertence a outra conta Shopee, não à que está sendo sincronizada. Confira em qual conta o produto está vinculado; nada é enviado por esta.',
  'anuncio-removido':
    'O anúncio está removido na Shopee e não aceita mais edição de estoque. Publique um anúncio novo para este produto se ele voltar a ser vendido.',
  'anuncio-banido':
    'A Shopee baniu este anúncio, e um anúncio banido não aceita alteração de estoque. Resolva a pendência no Seller Centre; o envio volta sozinho quando o anúncio for liberado.',
  'anuncio-em-revisao':
    'O anúncio está em revisão pela Shopee e fica bloqueado para edição enquanto isso. Nada é enviado até a revisão terminar, e o envio volta sozinho depois.',
  'kit-derivado':
    'A Shopee monta este anúncio como kit (add_kit_item) e calcula o estoque pelos componentes dela. O ERP não envia quantidade. Se isto estiver errado, confira o vínculo do anúncio — o campo é kitNativo, não "é kit" do produto.',
  'sem-modelos':
    'O anúncio não tem nenhum modelo vinculado no ERP, então não há quantidade para enviar. Reimporte o anúncio para recriar os vínculos de modelo.',
  'familia-sem-quantidade':
    'Nenhum dos produtos desta família resolveu uma quantidade para enviar. Confira o estoque e os componentes do kit; sem um número não há envio.',
  'recusa-anterior':
    'Já recusado com o anúncio exatamente neste estado. O ERP não repete a mesma chamada até o anúncio mudar — use "reenviar mesmo com erro" para forçar.',
  'task-excede-limite':
    'O anúncio tem mais modelos do que cabem em uma chamada, e a sobra foi dividida em outra parte. Nenhuma quantidade se perde; esta linha existe só para a divisão ficar visível.',
  'produto-nao-encontrado':
    'O produto pedido não foi encontrado no ERP. Confira o identificador enviado; nada foi buscado na Shopee por ele.',
  // ---- conta side ----
  'sem-shop-id':
    'A conta não guarda o identificador da loja na Shopee, então nenhuma chamada pode ser assinada. Refaça a autorização da conta no ERP.',
  'sem-deposito':
    'A conta não tem depósito vinculado, e sem depósito não há de onde tirar a quantidade. Vincule um depósito à conta na tela de integrações.',
  'conta-pausada':
    'Esta conta está em pausa depois de uma recusa da Shopee, e o envio só volta quando a pausa vencer. Veja o motivo da pausa na conta; o envio manual também respeita esse prazo.',
  'conta-nao-configurada':
    'A integração desta conta não está configurada por completo no ERP. Termine a configuração na tela de integrações para que o envio possa rodar.',
  'loja-fbs':
    'A loja é FBS pura: o estoque é da Shopee e o estoque do vendedor precisa ficar em 0. Nenhum envio é possível enquanto a loja estiver assim.',
  'loja-cbsc':
    'Esta é uma loja de venda transfronteiriça, cujo estoque é gerenciado por outro fluxo da Shopee. O envio comum de estoque não vale aqui, e nada é enviado.',
  'loja-banida-ou-congelada':
    'A Shopee baniu ou congelou esta loja, e nenhuma escrita é aceita enquanto isso durar. Resolva a pendência com a Shopee; o envio volta sozinho depois.',
  'loja-outlet':
    'Este anúncio é de outlet, que tem uma operação de estoque própria na Shopee. O envio comum não vale para ele, e nada é enviado.',
  'multi-armazem':
    'A loja tem mais de um armazém. Um envio precisaria informar TODOS os location_id na mesma chamada, e o ERP guarda um depósito por conta. Enquanto isso, nenhum envio sai.',
  // ---- valves ----
  'sync-desabilitado':
    'A sincronização automática de estoque está desligada (SHOPEE_STOCK_SYNC_ENABLED). O envio manual continua funcionando.',
  'tasks-desabilitadas':
    'A fila de envio de estoque está desligada neste ambiente, então nada foi despachado. É um estado da implantação, não da conta; ligue a fila para retomar.',
  'payload-invalido':
    'A tarefa de envio chegou em um formato que o ERP não reconhece, e foi descartada sem chamar a Shopee. É um defeito nosso; nada foi alterado no anúncio.',
  'pausa-reenqueues-esgotados':
    'A tarefa já se reagendou o máximo de vezes permitido enquanto a conta estava em pausa, e foi descartada. A próxima varredura recria o envio quando a pausa vencer.',
  // ---- write side, the error table ----
  'piso-de-reserva-nao-atendido':
    'A Shopee reservou mais unidades para uma promoção do que o ERP tem disponível, e recusou o envio mesmo elevado ao piso. Reduza a reserva da promoção no Seller Centre ou aumente o estoque, e reenvie.',
  'piso-acima-da-banda':
    'A reserva da promoção é maior que o máximo que a categoria aceita neste anúncio. Só a promoção pode ser reduzida — o ERP não pode enviar um número acima da banda.',
  'bloqueado-por-promocao':
    'A Shopee bloqueou a edição de estoque enquanto uma promoção está ativa neste anúncio. O ERP tenta de novo em 60 minutos; encerre a promoção no Seller Centre para liberar antes.',
  'forma-de-modelo-divergente':
    'A estrutura de modelos do anúncio na Shopee não é a que o ERP tem vinculada. Reimporte o anúncio para acertar os vínculos antes de enviar de novo.',
  'modelo-invalido':
    'A Shopee não reconheceu um dos modelos enviados como pertencente a este anúncio. Reimporte o anúncio para atualizar os vínculos de modelo.',
  'anuncio-inexistente':
    'A Shopee não encontrou este anúncio. Ele pode ter sido apagado no Seller Centre; publique um anúncio novo para o produto se ele continuar à venda.',
  'anuncio-de-outra-loja':
    'A Shopee respondeu que este anúncio pertence a outra loja. Confira em qual conta o produto está vinculado; nada é enviado por esta.',
  'anuncio-nao-editavel':
    'A Shopee recusou a edição deste anúncio ("item status can not support editing"). Normalmente há uma pendência de conformidade aberta — resolva-a no Seller Centre; o próximo envio é liberado sozinho quando o status mudar.',
  'estrutura-de-estoque-divergente':
    'A Shopee recusou a forma do estoque enviado para este anúncio, normalmente por causa de armazéns. Confira a configuração de armazéns da loja; nada foi alterado.',
  'loja-cnsc-nao-migrada':
    'Esta loja ainda não foi migrada para o modelo que aceita esta chamada de estoque. A migração é feita pela Shopee; até lá nada é enviado.',
  'loja-com-penalidade':
    'A loja está sob uma penalidade da Shopee, que bloqueia a edição de estoque. Resolva a penalidade no Seller Centre; o envio volta sozinho depois.',
  'loja-armazem':
    'Esta loja opera com armazém da Shopee, onde o estoque do vendedor não é o que vale. Nenhum envio é possível enquanto a loja estiver assim.',
  'loja-vsku':
    'Esta loja usa o modelo de SKU virtual, cujo estoque é calculado pela própria Shopee. O envio comum não vale para ela, e nada é enviado.',
  'sem-permissao':
    'O aplicativo não tem permissão para alterar estoque nesta loja. Refaça a autorização da conta concedendo os acessos pedidos.',
  'loja-em-ferias':
    'A loja está em modo férias total na Shopee, que bloqueia a edição de estoque. Desligue o modo férias no Seller Centre; o envio volta sozinho depois.',
  'cota-diaria':
    'A cota diária de chamadas da Shopee acabou (é por aplicativo, compartilhada por todas as contas). O envio volta sozinho após as 00:00 no horário de Singapura (UTC+8).',
  reauth:
    'A autorização desta conta na Shopee perdeu a validade. Refaça a autorização no ERP; até lá nenhuma chamada é aceita.',
  'recusa-desconhecida':
    'A Shopee recusou o envio com um código que o ERP ainda não classificou. Veja o código guardado no vínculo do anúncio, e confira o anúncio no Seller Centre antes de reenviar.',
  // ---- per model ----
  'modelo-sem-resposta':
    'A Shopee não respondeu nada sobre este modelo, nem aceitando nem recusando. O anúncio fica fora de sincronia até um envio limpo; o próximo envio tenta de novo.',
  'envio-parcial':
    'Parte dos modelos foi aceita e parte recusada na mesma chamada. Veja o motivo de cada modelo; o anúncio continua fora de sincronia até um envio limpo.',
  // ---- the manual push ----
  'tempo-esgotado':
    'O prazo do envio manual acabou antes de chegar a este produto. Nada foi enviado por ele; peça o envio de novo com menos produtos de uma vez.',
  // ---- an ANNOTATION ----
  'clampado-na-reserva':
    'Enviado ACIMA do disponível no ERP para atender à reserva de uma promoção da Shopee. Reduza a reserva ou reponha o estoque; o próximo envio sem elevação resolve o aviso.',
};

/**
 * The members that ANNOTATE a send rather than refusing one.
 *
 * Declared once here so no caller re-lists them — the shape
 * `VEREDITOS_QUE_AVISAM` already uses in this channel. Today it holds exactly
 * one member, and that is the point: `clampado-na-reserva` rides a SUCCESSFUL
 * send (the quantity was raised to meet a promotion's reservation and Shopee
 * accepted it), so counting it as a refusal would report a synced listing as
 * failed and hide the one thing the operator has to act on.
 */
export const MOTIVOS_QUE_ANOTAM: ReadonlySet<MotivoEstoqueShopee> = new Set<MotivoEstoqueShopee>([
  'clampado-na-reserva',
]);

/** `true` when the motivo means "nothing was sent" — the complement of {@link MOTIVOS_QUE_ANOTAM}. */
export function ehRecusa(m: MotivoEstoqueShopee): boolean {
  return !MOTIVOS_QUE_ANOTAM.has(m);
}

/* --------------------------- the per-model outcome -------------------------- */

/** What Shopee said about ONE model in the call that carried it. */
export type ResultadoModelo = 'enviado' | 'recusado' | 'sem-resposta';

/**
 * The closed set of {@link ResultadoModelo}.
 *
 * ⚠️ `sem-resposta` is a real third state, not a defensive default: one
 * `update_stock` answers a `success_list` and a `failure_list`, and a model that
 * appears in NEITHER has to be reported as unattributed rather than folded into
 * either. Folding it into `enviado` reports a quantity that may never have
 * landed; folding it into `recusado` invents a refusal Shopee never made.
 */
export const RESULTADO_MODELO = {
  enviado: 'enviado',
  recusado: 'recusado',
  semResposta: 'sem-resposta',
} as const satisfies Record<string, ResultadoModelo>;

/**
 * ONE model's row in a send — the unit every surface renders and the manual
 * push returns.
 *
 * ⚠️ `modelId` `0` is the NO-MODEL item and a legitimate value at every hop: a
 * listing without variations carries exactly one row whose id is zero. Any
 * truthiness check on it turns the simplest listing there is into a structure
 * error.
 */
export interface LinhaDeModeloEnviada {
  /** Shopee's `model_id`; `0` is the no-model item. */
  readonly modelId: number;
  /** The CHILD produto the model maps to (the anchor itself on a no-model item). */
  readonly produtoId: string;
  /** The child link document, when one is bound. */
  readonly varLinkDocId: string | null;
  /** What the plan computed for this model, before any floor. */
  readonly quantidadeSolicitada: number;
  /** What was actually sent, after the floor; `null` when nothing was. */
  readonly quantidadeEnviada: number | null;
  readonly resultado: ResultadoModelo;
  readonly motivo: MotivoEstoqueShopee | null;
  /**
   * Shopee's own `failed_reason` / error code, VERBATIM — module prefix and all.
   *
   * The stripped form exists for CLASSIFICATION only; storing it here would
   * throw away which module refused, and two modules share suffixes.
   */
  readonly codigo: string | null;
  /** Rendered pt-BR — ALWAYS present, never a slug and never provider prose. */
  readonly mensagem: string;
  /** Whether the sent quantity was raised to meet a promotion's reservation. */
  readonly clampado: boolean;
  /** The floor that raised it, when one is known. */
  readonly piso: number | null;
}

/**
 * Cap one stock `mensagem` at the SAME bound a publish problema uses.
 *
 * ⚠️ It delegates rather than declaring a second cap. Both values end up in the
 * same place — a link document field plus an HTTP body — so a second number
 * would mean one surface truncating and the other not, and the divergence would
 * only ever be visible on the one oversized string nobody tested with. One cap,
 * one function, one place to change it.
 */
export function limitarMensagemEstoque(texto: string): string {
  return limitarMensagemProblema(texto);
}

/* ------------------------------ the two classes ---------------------------- */

/**
 * The stock queue's OWN "tasks are switched off here" error.
 *
 * ⚠️ It is deliberately NOT the channel's shared tasks-disabled class, and the
 * difference is the whole point. That one is named in `core/containment.ts`'s
 * `erroContidoPorConta`, which records the failure on the conta's cursor and
 * lets the loop continue — correct for a notification sweep, and the
 * silent-outage shape here. The valve is a DEPLOYMENT state, not a conta state:
 * containing it would write N identical `lastError` strings, one per conta, and
 * report a green tick while nothing synced at all. That is verbatim the #778
 * argument the containment module already makes for a configuration error.
 *
 * So the sweep must fail its tick LOUDLY, and this class must never be added to
 * `erroContidoPorConta` — a test asserts that module's text does not name it.
 * The two surfaces that DO want a soft answer narrow this class explicitly: the
 * sender records a discard, and the manual push reports the listing as
 * not-attempted with a rendered sentence.
 */
export class ShopeeStockTasksDisabledError extends Error {
  constructor() {
    super('SHOPEE_TASKS_DISABLED=1 — a fila de estoque está desabilitada nesta implantação');
    this.name = 'ShopeeStockTasksDisabledError';
  }
}

/**
 * The two conta-level refusals of the MANUAL envio — the codes its route turns
 * into a 4xx.
 *
 * ⚠️ Exactly two, and the shortness is a decision. A shop-form refusal (FBS,
 * cross-border) and a holiday refusal are NOT here: the sender reports those PER
 * LISTING with a rendered pt-BR sentence, which is strictly more informative
 * than a status code, and the manual push force-sends by design. What is left is
 * the pair that genuinely stops the whole request before any listing is
 * considered.
 */
export const CODIGO_GUARDA_ENVIO = {
  contaSemDeposito: 'SHOPEE_CONTA_SEM_DEPOSITO',
  contaPausada: 'SHOPEE_CONTA_PAUSADA',
} as const;

/** The closed set of {@link CODIGO_GUARDA_ENVIO} values. */
export type CodigoGuardaEnvio = (typeof CODIGO_GUARDA_ENVIO)[keyof typeof CODIGO_GUARDA_ENVIO];

/**
 * The HTTP status each guard code answers with — TOTAL over
 * {@link CodigoGuardaEnvio}.
 *
 * 400 for "the conta cannot answer this request at all" (no depósito bound:
 * there is no quantity to read, and no amount of waiting changes it) and 409 for
 * "not now" (the conta is paused: the identical request succeeds once the pause
 * expires). The distinction is what tells an operator whether to fix something
 * or to wait.
 */
export const STATUS_POR_CODIGO_DE_GUARDA: Record<CodigoGuardaEnvio, number> = {
  SHOPEE_CONTA_SEM_DEPOSITO: 400,
  SHOPEE_CONTA_PAUSADA: 409,
};

/**
 * A conta-level refusal of the manual envio, fail-fast: none of these can be
 * reported per listing because each one stops the whole request.
 *
 * ⚠️ It carries a NUMBER, never a response object. Everything under this folder
 * is reachable from the Cloud Functions bundle, so Next's own server module must
 * not be imported anywhere in it — the route maps this class onto a response in
 * its own catch, and the dependency runs one way. (Naming that module even in
 * prose is what a raw-text grep of this folder looks for, so it is described
 * rather than spelled.)
 *
 * ⚠️ The status is DERIVED from the code rather than passed in. The Mercado
 * Livre twin takes both as arguments, which lets a call site pair a code with
 * the wrong number; here the table above is total over the two codes and a third
 * code is a compile error instead of an `undefined` status.
 */
export class ShopeeEnvioEstoqueGuardError extends Error {
  readonly code: CodigoGuardaEnvio;
  readonly status: number;
  /** Extra fields the route echoes in the body (e.g. when the pause expires). */
  readonly extra: Record<string, unknown>;

  constructor(code: CodigoGuardaEnvio, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ShopeeEnvioEstoqueGuardError';
    this.code = code;
    this.status = STATUS_POR_CODIGO_DE_GUARDA[code];
    this.extra = extra;
  }
}
