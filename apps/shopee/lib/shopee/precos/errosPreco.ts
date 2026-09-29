/**
 * The price sync's PERSISTED vocabulary, its pt-BR table rendered at READ time,
 * the set of refusals that STAMP the link, and the manual push's guard class
 * (#1521, step 13).
 *
 * The split is step 12's (`estoque/errosEstoque.ts`): the vocabulary, its
 * companion const, the message table and the classes in one small module; the
 * code→motivo classifier and every producer elsewhere.
 *
 * ## ONE union, and the SAME words as stock
 *
 * A price send is refused at five altitudes — the plan (a family with nothing
 * to price), the manual request, the conta (a shop the ERP will not price), the
 * item's pre-wire gates, and Shopee's answer per model — and every one of them
 * lands in ONE {@link MotivoPrecoShopee} with ONE total
 * {@link MENSAGEM_POR_MOTIVO_PRECO}. Separate unions per altitude are the drift
 * shape: every surface would render several maps, and a condition that moves
 * altitude would gain a second slug.
 *
 * ⚠️ Where a condition is the one the stock sync already names, the slug is
 * the stock SPELLING (`kit-derivado`, `produto-nao-encontrado`,
 * `bloqueado-por-promocao`, `forma-de-modelo-divergente`, …) — one word for one
 * condition, so an operator reading a stock refusal beside a price refusal of
 * the same listing sees the same word. The spellings are shared; the TYPE is
 * not: this module never imports the stock union, because each folder owns its
 * vocabulary and a member added to one must not silently widen the other.
 *
 * ## ⚠️ The vocabulary is PERSISTED and is not free to rename
 *
 * A slug is stored on the link document (`precoRecusaMotivo`), written into
 * the job's report rows, and returned in the manual push's body. Adding a
 * member is cheap; renaming one orphans every row already written.
 *
 * ## ⚠️ And no member that nothing can produce
 *
 * The other half of the same rule: a declared reason nobody writes is a filter
 * the UI renders and the code never fills. That is why several plausible names
 * are ABSENT on purpose — an unknown listing status SENDS (Shopee's own refusal
 * then classifies it), the daily quota and the burst limit are PAUSE values of
 * the conta rather than row refusals, and a per-item "too many models" is the
 * plan's `modelos-excedem-limite`. The two job-only members arrived with the
 * second PR together with their producer, the account-wide job
 * (`atualizarPrecos.ts`). `motivosProduzidos.test.ts` mechanises the rule by
 * scanning the producers' raw text.
 *
 * ## Not a Zod enum
 *
 * `delfrance/prefer-schema-enum` keys on the DECLARATION behind a literal's
 * position, and this is a hand-written union — the stock vocabulary's position.
 * The companion const is declared anyway, so the set is enumerable by a test
 * and code writes a name instead of spelling a slug.
 */
import { ShopeeError } from '@delfrance/integrations-shopee';

/* ------------------------------ the vocabulary ----------------------------- */

/**
 * Why a produto, an item, a model or a whole conta did not send a price.
 *
 * Each member is a MECHANISM; the sentence is
 * {@link MENSAGEM_POR_MOTIVO_PRECO}'s. Forty-six members: forty-four from the
 * first PR, and the account-wide job's two terminal rows.
 */
export type MotivoPrecoShopee =
  // ---- the plan, per family / listing (7) ----
  | 'sem-link'
  | 'sem-item-id'
  | 'kit-derivado'
  | 'anuncio-removido'
  | 'forma-de-modelo-divergente'
  | 'sem-modelos'
  | 'modelos-excedem-limite'
  // ---- the manual request (3) ----
  | 'produto-nao-encontrado'
  | 'tempo-esgotado'
  | 'conta-pausada'
  // ---- the sender's pre-wire gates (9) ----
  | 'preco-nao-encontrado'
  | 'preco-igual'
  | 'preco-menor-bloqueado'
  | 'preco-atual-ilegivel'
  | 'razao-de-precos-excedida'
  | 'moeda-divergente'
  | 'modelo-ausente'
  | 'anuncio-banido'
  | 'anuncio-em-revisao'
  // ---- Shopee's refusal, the code table (13) ----
  | 'modelo-invalido'
  | 'anuncio-inexistente'
  | 'anuncio-de-outra-loja'
  | 'anuncio-nao-editavel'
  | 'loja-vsku'
  | 'bloqueado-por-promocao'
  | 'preco-riscado'
  | 'preco-fora-da-faixa'
  | 'preco-invalido'
  | 'preco-acima-do-limite-do-frete'
  | 'conflito-com-atacado'
  | 'preco-recusado'
  | 'recusa-desconhecida'
  // ---- after the write, per model (3) ----
  | 'envio-parcial'
  | 'modelo-sem-resposta'
  | 'preco-nao-atualizado'
  // ---- the conta verdict (6) ----
  | 'sem-shop-id'
  | 'sem-tabela-normal'
  | 'conta-nao-configurada'
  | 'loja-banida-ou-congelada'
  | 'loja-cross-border'
  | 'regiao-nao-suportada'
  // ---- conta-wide, ends the run (3) ----
  | 'reauth'
  | 'loja-com-penalidade'
  | 'sem-permissao'
  // ---- the account-wide job's terminal rows (2) ----
  | 'job-interrompido'
  | 'job-cancelado';

/**
 * The closed set, for iteration and so code names a member instead of spelling
 * a slug. Keys are the slugs in camelCase — a test pins the pairing.
 */
export const MOTIVO_PRECO_SHOPEE = {
  // ---- the plan, per family / listing (7) ----
  semLink: 'sem-link',
  semItemId: 'sem-item-id',
  kitDerivado: 'kit-derivado',
  anuncioRemovido: 'anuncio-removido',
  formaDeModeloDivergente: 'forma-de-modelo-divergente',
  semModelos: 'sem-modelos',
  modelosExcedemLimite: 'modelos-excedem-limite',
  // ---- the manual request (3) ----
  produtoNaoEncontrado: 'produto-nao-encontrado',
  tempoEsgotado: 'tempo-esgotado',
  contaPausada: 'conta-pausada',
  // ---- the sender's pre-wire gates (9) ----
  precoNaoEncontrado: 'preco-nao-encontrado',
  precoIgual: 'preco-igual',
  precoMenorBloqueado: 'preco-menor-bloqueado',
  precoAtualIlegivel: 'preco-atual-ilegivel',
  razaoDePrecosExcedida: 'razao-de-precos-excedida',
  moedaDivergente: 'moeda-divergente',
  modeloAusente: 'modelo-ausente',
  anuncioBanido: 'anuncio-banido',
  anuncioEmRevisao: 'anuncio-em-revisao',
  // ---- Shopee's refusal, the code table (13) ----
  modeloInvalido: 'modelo-invalido',
  anuncioInexistente: 'anuncio-inexistente',
  anuncioDeOutraLoja: 'anuncio-de-outra-loja',
  anuncioNaoEditavel: 'anuncio-nao-editavel',
  lojaVsku: 'loja-vsku',
  bloqueadoPorPromocao: 'bloqueado-por-promocao',
  precoRiscado: 'preco-riscado',
  precoForaDaFaixa: 'preco-fora-da-faixa',
  precoInvalido: 'preco-invalido',
  precoAcimaDoLimiteDoFrete: 'preco-acima-do-limite-do-frete',
  conflitoComAtacado: 'conflito-com-atacado',
  precoRecusado: 'preco-recusado',
  recusaDesconhecida: 'recusa-desconhecida',
  // ---- after the write, per model (3) ----
  envioParcial: 'envio-parcial',
  modeloSemResposta: 'modelo-sem-resposta',
  precoNaoAtualizado: 'preco-nao-atualizado',
  // ---- the conta verdict (6) ----
  semShopId: 'sem-shop-id',
  semTabelaNormal: 'sem-tabela-normal',
  contaNaoConfigurada: 'conta-nao-configurada',
  lojaBanidaOuCongelada: 'loja-banida-ou-congelada',
  lojaCrossBorder: 'loja-cross-border',
  regiaoNaoSuportada: 'regiao-nao-suportada',
  // ---- conta-wide, ends the run (3) ----
  reauth: 'reauth',
  lojaComPenalidade: 'loja-com-penalidade',
  semPermissao: 'sem-permissao',
  // ---- the account-wide job's terminal rows (2) ----
  jobInterrompido: 'job-interrompido',
  jobCancelado: 'job-cancelado',
} as const satisfies Record<string, MotivoPrecoShopee>;

/* ---------------------------- the rendered table --------------------------- */

/**
 * The pt-BR sentence for EVERY member, rendered at READ time — the stored row
 * keeps the slug, so fixing a wording fixes every row already written.
 *
 * ⚠️ `Record<MotivoPrecoShopee, string>`, never `Record<string, string>`, and
 * there is no `?? fallback` on a member lookup anywhere. #1226 is the lesson,
 * measured on the Mercado Livre twin: a new skip reason compiled, no test
 * failed, and the manual push answered four words with no cause and no remedy.
 * Typed this way, a member without a sentence is a COMPILE error here.
 *
 * ⚠️ **No PII and no provider payload.** Never a produto name, an `item_name`,
 * an id, a token, a shop number or a raw response body. Shopee's own code
 * travels separately (the row's `codigo`, the link's `precoRecusaCodigo`),
 * where a reader can look it up without it being pasted into prose.
 */
export const MENSAGEM_POR_MOTIVO_PRECO: Record<MotivoPrecoShopee, string> = {
  // ---- the plan ----
  'sem-link': 'Este produto não tem anúncio vinculado nesta conta Shopee.',
  'sem-item-id':
    'O vínculo com a Shopee não tem o número do anúncio (item_id); reimporte o anúncio.',
  'kit-derivado':
    'O anúncio é um kit nativo da Shopee (kitNativo); o ERP não envia preço para ele.',
  'anuncio-removido': 'O anúncio foi excluído na Shopee; não há preço a enviar.',
  'forma-de-modelo-divergente':
    'As variações do anúncio na Shopee não batem com as do ERP; reimporte o anúncio.',
  'sem-modelos':
    'O anúncio tem variações, mas nenhuma variação vinculada utilizável; reimporte o anúncio.',
  'modelos-excedem-limite':
    'O anúncio tem mais variações do que a Shopee aceita numa atualização de preço (50).',
  // ---- the manual request ----
  'produto-nao-encontrado': 'Produto não encontrado.',
  'tempo-esgotado': 'O tempo do envio manual acabou antes deste item; envie-o novamente.',
  'conta-pausada':
    'A cota de chamadas da Shopee está esgotada; tente novamente após o horário indicado.',
  // ---- the sender's pre-wire gates ----
  'preco-nao-encontrado': 'O produto não tem preço na tabela de preços da conta.',
  'preco-igual': 'O preço na Shopee já é igual ao do ERP.',
  'preco-menor-bloqueado': 'O novo preço é menor que o atual e a redução não foi autorizada.',
  'preco-atual-ilegivel':
    'A Shopee não informou o preço atual; sem ele a redução não pode ser conferida. Envie autorizando a redução para forçar.',
  'razao-de-precos-excedida':
    'A diferença entre o maior e o menor preço das variações excede o limite da Shopee para a região.',
  'moeda-divergente':
    'A moeda do anúncio na Shopee não é a moeda da loja; o ERP não envia o preço.',
  'modelo-ausente': 'Esta variação não existe mais no anúncio da Shopee; reimporte o anúncio.',
  'anuncio-banido': 'O anúncio está banido na Shopee.',
  'anuncio-em-revisao': 'O anúncio está em revisão na Shopee.',
  // ---- Shopee's refusal ----
  'modelo-invalido': 'A Shopee não reconheceu esta variação; reimporte o anúncio.',
  'anuncio-inexistente': 'O anúncio não existe mais na Shopee.',
  'anuncio-de-outra-loja': 'O anúncio pertence a outra loja.',
  'anuncio-nao-editavel':
    'A Shopee não permite editar este anúncio agora (status ou pendência de conformidade).',
  'loja-vsku': 'Anúncio de SKU virtual: a Shopee não permite alterar o preço pela API.',
  'bloqueado-por-promocao':
    'O preço está travado por uma promoção agendada ou em andamento na Shopee.',
  'preco-riscado':
    'O anúncio está numa promoção de preço riscado na Shopee; o preço não pode ser alterado agora.',
  'preco-fora-da-faixa': 'O preço está fora da faixa permitida pela Shopee para a categoria.',
  'preco-invalido': 'A Shopee recusou o formato do preço.',
  'preco-acima-do-limite-do-frete':
    'O preço excede o limite de um canal de envio ativo no anúncio.',
  'conflito-com-atacado':
    'O anúncio tem preço de atacado incompatível com o novo preço; ajuste o atacado na Shopee.',
  // Shopee's ONE answer for several deterministic causes, and its own text
  // ("please try later") is false for all of them — so the sentence names the
  // causes the SG sandbox probe measured instead of repeating Shopee's advice.
  'preco-recusado':
    'A Shopee recusou a atualização de preço sem detalhar o motivo. Causas medidas: a diferença entre o maior e o menor preço das variações (incluindo as que não foram enviadas) acima do limite, anúncio excluído, ou variações do anúncio alteradas na Shopee. Confira o anúncio e reimporte-o se as variações mudaram.',
  'recusa-desconhecida': 'A Shopee recusou o envio por um motivo não reconhecido (veja o código).',
  // ---- after the write ----
  'envio-parcial': 'Parte das variações foi atualizada e parte foi recusada.',
  'modelo-sem-resposta': 'A Shopee não confirmou nem recusou esta variação.',
  'preco-nao-atualizado': 'A Shopee aceitou o envio, mas a conferência não mostra o novo preço.',
  // ---- the conta verdict ----
  'sem-shop-id': 'A conta Shopee não tem a loja (shop_id) vinculada; reconecte a conta.',
  'sem-tabela-normal': 'A conta Shopee não tem tabela de preços normal configurada.',
  'conta-nao-configurada': 'A conta Shopee não está configurada corretamente.',
  'loja-banida-ou-congelada': 'A loja está banida ou congelada na Shopee.',
  'loja-cross-border': 'Loja cross-border: o preço da Shopee não é em reais; o ERP não envia.',
  'regiao-nao-suportada': 'A loja não é do Brasil; o ERP só envia preços em reais para lojas BR.',
  // ---- conta-wide ----
  reauth: 'A autorização da loja expirou; reconecte a conta Shopee.',
  'loja-com-penalidade': 'A loja está sob penalidade na Shopee.',
  'sem-permissao': 'O aplicativo não tem permissão para alterar preços nesta loja.',
  // ---- the account-wide job ----
  'job-interrompido':
    'A atualização foi interrompida antes deste ponto; os itens restantes não foram tentados.',
  'job-cancelado': 'A atualização foi cancelada; os itens restantes não foram tentados.',
};

/**
 * The sentence for a model row that WAS sent — the one rendering that has no
 * motivo behind it.
 */
export const MENSAGEM_ENVIO_PRECO_LIMPO = 'Preço enviado à Shopee.';

/**
 * The sentence for a stored motivo this release does not know — a row written
 * by a newer (or an older) release, or a corrupted field.
 *
 * ⚠️ Generic on purpose: echoing the unknown value would paste an unvalidated
 * stored string into prose an operator reads, which is exactly what the
 * no-provider-payload rule on the table above forbids.
 */
const MENSAGEM_MOTIVO_NAO_RECONHECIDO = 'Não enviado (motivo não reconhecido).';

/**
 * The members as a SET of strings — membership for an UNTRUSTED stored value.
 *
 * ⚠️ Never `motivo in MENSAGEM_POR_MOTIVO_PRECO` and never a bare index into
 * it: both read the object's PROTOTYPE, so a stored `constructor` would render
 * a function's source as the operator's sentence and `__proto__` an object. A
 * `Set` holds the members and nothing it inherited.
 */
const MEMBROS: ReadonlySet<string> = new Set<string>(Object.values(MOTIVO_PRECO_SHOPEE));

function ehMotivoDePreco(valor: string): valor is MotivoPrecoShopee {
  return MEMBROS.has(valor);
}

/**
 * Render a STORED motivo (a report row, a link field, an envelope row) into its
 * pt-BR sentence at read time.
 *
 * - `null` ⇒ {@link MENSAGEM_ENVIO_PRECO_LIMPO}: a row without a motivo is a
 *   clean send (step 12's `motivo === null ? limpo : tabela` rendering, and the
 *   report route renders EVERY row through this function, the sent ones
 *   included);
 * - a member ⇒ its sentence;
 * - anything else — an unknown slug, an empty string, a prototype key ⇒
 *   `'Não enviado (motivo não reconhecido).'`, never the raw value.
 */
export function mensagemDoMotivoDePreco(motivo: string | null): string {
  if (motivo === null) return MENSAGEM_ENVIO_PRECO_LIMPO;
  return ehMotivoDePreco(motivo)
    ? MENSAGEM_POR_MOTIVO_PRECO[motivo]
    : MENSAGEM_MOTIVO_NAO_RECONHECIDO;
}

/* ------------------------ the refusals that stamp -------------------------- */

/**
 * The refusals that STAMP the link's `precoRecusa*` fields — a DETERMINISTIC
 * property of the listing (or of our binding to it) that an operator has to
 * fix, and that the next send would meet again unchanged.
 *
 * ⚠️ What is deliberately OUT, each for a stated reason:
 * - a LOCK (`bloqueado-por-promocao`, `preco-riscado`): the listing is healthy
 *   and the lock ends on its own — stamping it would mark a listing broken for
 *   the length of a promotion;
 * - `preco-igual`: nothing was refused, and stamping an equal observation as a
 *   success would attribute to the ERP a price a seller may have set by hand;
 * - `preco-nao-atualizado`: the write was ACCEPTED and only its confirmation
 *   failed — the listing is fine, the ERP simply cannot certify the value;
 * - the conta-wide fatals (`reauth`, `loja-com-penalidade`, `sem-permissao`)
 *   and every conta verdict: a property of the SHOP, not of this listing;
 * - the job's two terminal rows (`job-interrompido`, `job-cancelado`): they
 *   name a RUN that stopped, and are written into a report, never onto a link;
 * - every plan and gate skip: nothing reached Shopee to be refused.
 *
 * `preco-recusado` is IN: Shopee's catch-all price refusal was measured as
 * deterministic on the sandbox (a ratio, a deleted listing, a changed variation
 * structure), never a transient.
 */
export const MOTIVOS_QUE_CARIMBAM: ReadonlySet<MotivoPrecoShopee> = new Set<MotivoPrecoShopee>([
  'anuncio-inexistente',
  'anuncio-de-outra-loja',
  'forma-de-modelo-divergente',
  'moeda-divergente',
  'razao-de-precos-excedida',
  'modelo-invalido',
  'preco-fora-da-faixa',
  'preco-invalido',
  'preco-acima-do-limite-do-frete',
  'conflito-com-atacado',
  'loja-vsku',
  'anuncio-nao-editavel',
  'recusa-desconhecida',
  'preco-recusado',
]);

/* ------------------------------ the guard class ---------------------------- */

/**
 * The three conta-level refusals of the MANUAL price push — the codes its route
 * turns into a 4xx before any item is considered.
 *
 * ⚠️ `SHOPEE_CONTA_PAUSADA` is the SAME string the stock push answers: the web
 * reads one code for one condition, and the condition (the conta's quota pause)
 * is literally the stock sync's pause, READ here and never written.
 */
export const CODIGO_GUARDA_PRECO = {
  contaSemTabelaNormal: 'SHOPEE_CONTA_SEM_TABELA_NORMAL',
  contaPausada: 'SHOPEE_CONTA_PAUSADA',
  contaRecusada: 'SHOPEE_PRECO_CONTA_RECUSADA',
} as const;

/** The closed set of {@link CODIGO_GUARDA_PRECO} values. */
export type CodigoGuardaPreco = (typeof CODIGO_GUARDA_PRECO)[keyof typeof CODIGO_GUARDA_PRECO];

/**
 * The HTTP status each guard code answers with — TOTAL over
 * {@link CodigoGuardaPreco}.
 *
 * - 400: the conta cannot answer this request at all (no normal price table:
 *   there is no price to read, and waiting changes nothing);
 * - 409: not NOW (the conta's quota pause: the identical request succeeds once
 *   it expires);
 * - 422: the request is well-formed and the conta is configured, but the ERP
 *   will not price this SHOP (every refusal of the conta verdict — region,
 *   cross-border, banned shop, unusable credentials). A 400 would tell the
 *   caller to fix its body, which cannot help.
 */
export const STATUS_POR_CODIGO_DE_GUARDA_PRECO: Record<CodigoGuardaPreco, number> = {
  SHOPEE_CONTA_SEM_TABELA_NORMAL: 400,
  SHOPEE_CONTA_PAUSADA: 409,
  SHOPEE_PRECO_CONTA_RECUSADA: 422,
};

/**
 * A conta-level refusal of the manual price push, fail-fast: each one stops the
 * whole request, so none can be reported per item.
 *
 * ⚠️ It carries a NUMBER, never a response object. Everything under this folder
 * is reachable from the Cloud Functions bundle, so Next's own server module
 * must not be imported anywhere in it — the route maps this class onto a
 * response in its own catch, and the dependency runs one way.
 *
 * ⚠️ The status is DERIVED from the code through the total table above, never
 * passed in: a third code is a compile error instead of an `undefined` status,
 * and no call site can pair a code with the wrong number.
 *
 * ⚠️ It EXTENDS `ShopeeError` (the step-9/11 blocked-error position), so the
 * route's generic Shopee arm would still answer it if its own arm were lost —
 * but as a generic failure, never at the derived status. So the route narrows
 * THIS class FIRST, and so must any per-item ladder that treats a thrown
 * `ShopeeError` as a row: a conta-level refusal reported as N identical item
 * failures is the misreport this class exists to prevent.
 */
export class ShopeeEnvioPrecoGuardError extends ShopeeError {
  readonly code: CodigoGuardaPreco;
  readonly status: number;
  /** Extra fields the route echoes in the body (e.g. `pausadoAte`, `motivo`, `regiao`). */
  readonly extra: Record<string, unknown>;

  constructor(code: CodigoGuardaPreco, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ShopeeEnvioPrecoGuardError';
    this.code = code;
    this.status = STATUS_POR_CODIGO_DE_GUARDA_PRECO[code];
    this.extra = extra;
  }
}

/* ---------------------------- the job's two classes ------------------------- */

/**
 * The HTTP answer and code of {@link ShopeeEnvioPrecoEmAndamentoError} — the
 * start route maps the class onto exactly this pair.
 */
export const CODIGO_ENVIO_PRECO_EM_ANDAMENTO = 'SHOPEE_PRICE_SYNC_RUNNING';

/**
 * The account-wide job's start guard: this conta already has a live `running`
 * price job (an ORPHAN is reclaimed instead, and a PARKED job is live). ONE
 * run per conta at a time — with the start race ACCEPTED by decision, see the
 * job module.
 *
 * ⚠️ It EXTENDS `ShopeeError`, the step-9 twin's position, so the start route
 * must narrow it BEFORE its generic Shopee arm — which would otherwise answer
 * a busy conta as a generic failure instead of 409.
 */
export class ShopeeEnvioPrecoEmAndamentoError extends ShopeeError {
  readonly code = CODIGO_ENVIO_PRECO_EM_ANDAMENTO;
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'ShopeeEnvioPrecoEmAndamentoError';
  }
}

/**
 * The HTTP code the start route answers when the price queue cannot take the
 * job — the valve is closed, or a genuine enqueue outage (503 both ways: from
 * the operator's side the action is the same).
 */
export const CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU = 'SHOPEE_PRICE_SYNC_ENQUEUE_FAILED';

/**
 * The price queue's scheduler was asked to enqueue while `SHOPEE_TASKS_DISABLED`
 * is `'1'`.
 *
 * The start refuses BEFORE creating a job (so the valve leaves no document
 * behind), and a dispatch that meets it stamps the job `failed` on the FIRST
 * attempt: a retry cannot open a valve, and no sweep drains this queue later.
 *
 * ⚠️ Its OWN class, never the push pipeline's `ShopeeTasksDisabledError`: that
 * one is inside the per-conta containment set, so a price job that raised it
 * would be CONTAINED as one conta's `lastError` instead of stamping the job.
 * A bare `Error`, not a `ShopeeError`, because nothing Shopee-shaped went wrong.
 */
export class ShopeePriceSyncTasksDisabledError extends Error {
  readonly code = CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU;
  readonly status = 503;

  constructor() {
    super(
      'SHOPEE_TASKS_DISABLED=1 — a fila do envio de preços está desabilitada; ' +
        'não há sweep por trás deste caminho, então nenhum job é criado (ou o job em curso é encerrado como failed).',
    );
    this.name = 'ShopeePriceSyncTasksDisabledError';
  }
}
