/**
 * The Amazon price push's closed vocabulary (step 13, PR 13-c): WHY a SKU's
 * line ended where it did, in the price task, a run's page and a price feed's
 * build alike.
 *
 * ## The outcomes
 *
 * Every per-SKU line ends with exactly one {@link MotivoPrecoAmazon}:
 *
 *  - the end of a send: `enviado`, `igual` (Amazon already holds the faixa),
 *    `simulado` (dry-run), `desligado` (the valve is off), `fora-do-canario`,
 *    `previa` (sent as a validation preview: nothing persisted);
 *  - the decrease guard: `reducao-sem-consentimento`, `reducao-apos-pagina`
 *    (below the faixa the run's page saw), `preco-atual-ilegivel`;
 *  - the faixa and the listing's type: `conta-sem-tabela-normal`, `sem-preco`,
 *    `faixa-invertida` (a promotional price above the normal one),
 *    `tipo-produto-ilegivel`;
 *  - the link verdict's refusals ({@link RecusaVinculoPrecoAmazon}) and
 *    `sem-caminho` (no per-SKU patch can carry the SKU);
 *  - the listing gate's refusals ({@link RecusaListingPrecoAmazon});
 *  - the read: `nao-confirmado` (a search miss no GET confirmed, or could),
 *    `leitura-falhou`, `conta-indisponivel`;
 *  - a run's bond and the feed wait: `aguardando-feed`,
 *    `execucao-substituida`, `execucao-cancelada`;
 *  - the check after a send: `superado` (a newer send owns the outcome),
 *    `erp-mudou`, `aceito`, `aceito-com-avisos`, `recusado`;
 *  - a failure or a budget: `escrita-falhou`, `escrita-incerta`,
 *    `prazo-da-tarefa`, `pausado`;
 *  - a feed member's own drops: `vinculo-mudou`, `parte-ausente`;
 *  - `ja-visto`: a run's page skipped the SKU, because it is evaluated on the
 *    page of its smallest link-doc path.
 *
 * The link verdict's fifth refusal (`envio-desligado`) is the stock flow's
 * alone: a price verdict never answers it, so it is not here.
 *
 * ## Tokens
 *
 * Every slug is a token the price run's counter map accepts
 * (`CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX`, in the schemas package): a test pins
 * it. ⚠️ PERSISTED as counter keys: a rename orphans every count already
 * stored. Not a Zod enum: nothing parses a motivo from an untrusted source.
 *
 * ⚠️ LIGHT on purpose: it imports nothing.
 */

export type MotivoPrecoAmazon =
  // ---- the end of a send ----
  | 'enviado'
  | 'igual'
  | 'simulado'
  | 'desligado'
  | 'fora-do-canario'
  | 'previa'
  // ---- the decrease guard ----
  | 'reducao-sem-consentimento'
  | 'reducao-apos-pagina'
  | 'preco-atual-ilegivel'
  // ---- the faixa and the listing's type ----
  | 'conta-sem-tabela-normal'
  | 'sem-preco'
  | 'faixa-invertida'
  | 'tipo-produto-ilegivel'
  // ---- the link verdict, and the patch path ----
  | 'vinculo-ambiguo'
  | 'produto-ausente'
  | 'pai-do-vinculo-ilegivel'
  | 'filho-com-sku-do-pai'
  | 'unidade-com-variacoes'
  | 'sem-caminho'
  // ---- the listing gate ----
  | 'nao-listado'
  | 'pai'
  | 'asin-divergente'
  // ---- the read ----
  | 'nao-confirmado'
  | 'leitura-falhou'
  | 'conta-indisponivel'
  // ---- a run's bond, and the feed wait ----
  | 'aguardando-feed'
  | 'execucao-substituida'
  | 'execucao-cancelada'
  // ---- the check after a send ----
  | 'superado'
  | 'erp-mudou'
  | 'aceito'
  | 'aceito-com-avisos'
  | 'recusado'
  // ---- a failure or a budget ----
  | 'escrita-falhou'
  | 'escrita-incerta'
  | 'prazo-da-tarefa'
  | 'pausado'
  // ---- a feed member's own drops ----
  | 'vinculo-mudou'
  | 'parte-ausente'
  // ---- a run page's skip ----
  | 'ja-visto';

/**
 * The closed set, so code names a member instead of spelling a slug. Keys are
 * the slugs in camelCase — a test pins the pairing.
 */
export const MOTIVO_PRECO_AMAZON = {
  enviado: 'enviado',
  igual: 'igual',
  simulado: 'simulado',
  desligado: 'desligado',
  foraDoCanario: 'fora-do-canario',
  previa: 'previa',
  reducaoSemConsentimento: 'reducao-sem-consentimento',
  reducaoAposPagina: 'reducao-apos-pagina',
  precoAtualIlegivel: 'preco-atual-ilegivel',
  contaSemTabelaNormal: 'conta-sem-tabela-normal',
  semPreco: 'sem-preco',
  faixaInvertida: 'faixa-invertida',
  tipoProdutoIlegivel: 'tipo-produto-ilegivel',
  vinculoAmbiguo: 'vinculo-ambiguo',
  produtoAusente: 'produto-ausente',
  paiDoVinculoIlegivel: 'pai-do-vinculo-ilegivel',
  filhoComSkuDoPai: 'filho-com-sku-do-pai',
  unidadeComVariacoes: 'unidade-com-variacoes',
  semCaminho: 'sem-caminho',
  naoListado: 'nao-listado',
  pai: 'pai',
  asinDivergente: 'asin-divergente',
  naoConfirmado: 'nao-confirmado',
  leituraFalhou: 'leitura-falhou',
  contaIndisponivel: 'conta-indisponivel',
  aguardandoFeed: 'aguardando-feed',
  execucaoSubstituida: 'execucao-substituida',
  execucaoCancelada: 'execucao-cancelada',
  superado: 'superado',
  erpMudou: 'erp-mudou',
  aceito: 'aceito',
  aceitoComAvisos: 'aceito-com-avisos',
  recusado: 'recusado',
  escritaFalhou: 'escrita-falhou',
  escritaIncerta: 'escrita-incerta',
  prazoDaTarefa: 'prazo-da-tarefa',
  pausado: 'pausado',
  vinculoMudou: 'vinculo-mudou',
  parteAusente: 'parte-ausente',
  jaVisto: 'ja-visto',
} as const satisfies Record<string, MotivoPrecoAmazon>;

/* ------------------------------- the subsets ------------------------------- */

/** The link verdict's refusals a price verdict can answer, in the order it checks them. */
const RECUSAS_DO_VINCULO = [
  MOTIVO_PRECO_AMAZON.vinculoAmbiguo,
  MOTIVO_PRECO_AMAZON.produtoAusente,
  MOTIVO_PRECO_AMAZON.paiDoVinculoIlegivel,
  MOTIVO_PRECO_AMAZON.filhoComSkuDoPai,
  MOTIVO_PRECO_AMAZON.unidadeComVariacoes,
] as const satisfies readonly MotivoPrecoAmazon[];

/** A refusal of the link verdict, for price. */
export type RecusaVinculoPrecoAmazon = (typeof RECUSAS_DO_VINCULO)[number];

/** The listing gate's refusals, in the order it checks them. */
const RECUSAS_DO_LISTING = [
  MOTIVO_PRECO_AMAZON.naoListado,
  MOTIVO_PRECO_AMAZON.pai,
  MOTIVO_PRECO_AMAZON.asinDivergente,
] as const satisfies readonly MotivoPrecoAmazon[];

/** A refusal of the listing gate, for price. */
export type RecusaListingPrecoAmazon = (typeof RECUSAS_DO_LISTING)[number];

export const RECUSAS_VINCULO_PRECO_AMAZON: ReadonlySet<MotivoPrecoAmazon> =
  new Set<MotivoPrecoAmazon>(RECUSAS_DO_VINCULO);

export const RECUSAS_LISTING_PRECO_AMAZON: ReadonlySet<MotivoPrecoAmazon> =
  new Set<MotivoPrecoAmazon>(RECUSAS_DO_LISTING);
