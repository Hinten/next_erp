/**
 * The Amazon stock sync's closed vocabulary (step 12, PR 12-d): WHY a SKU's
 * line ended where it did, the counters a run adds to its line, and the
 * refusals a person must fix.
 *
 * ## The outcomes
 *
 * Every per-SKU line ends with exactly one {@link MotivoEstoqueAmazon}:
 *
 *  - the end of a send: `enviado`, `igual` (Amazon already shows the ERP
 *    quantity), `simulado` (dry-run), `desligado` (the valve is off),
 *    `fora-do-canario`;
 *  - the link verdict's refusals ({@link RecusaVinculoEstoqueAmazon}) and
 *    `sem-caminho` (the patch path cannot carry the SKU);
 *  - the listing gate's refusals ({@link RecusaListingEstoqueAmazon});
 *  - the conta, the unit and the read: `unidade-ausente`,
 *    `conta-sem-deposito`, `conta-indisponivel`, `deposito-mudou`,
 *    `nao-confirmado` (a search miss no GET confirmed);
 *  - a failure or a budget: `leitura-falhou`, `escrita-falhou`,
 *    `escrita-incerta`, `prazo-da-tarefa`, `pausado`, `orcamento-esgotado`,
 *    `snapshot-lento`, `janela-grande`;
 *  - the form a batch took: `em-patches`, `em-feed`, `em-reconciliacao`,
 *    `repassado-para-patches`;
 *  - `ja-visto`: a reconcile page skipped the SKU, because it is evaluated on
 *    the page of its smallest link-doc path.
 *
 * ## Counted, never refused
 *
 * {@link ContadorEstoqueAmazon}: shapes the sync accepts and only COUNTS, so a
 * dry-run shows how many sends rest on each of them — a `PACKAGE_HIERARCHY`
 * container (`pacote`), an answer with no relationship block for the BR store
 * (`semRelacoes`), a BR summary without an ASIN (`semAsinNaAmazon`), a link
 * without one (`semAsinNoVinculo`), a search miss a GET found
 * (`confirmadoPorGet`), and an ERP 0 that comes from no estoque row at the
 * depósito (`zeroSemLinha`).
 *
 * ## The refusals a person must fix
 *
 * {@link RECUSAS_HUMANAS_ESTOQUE_AMAZON}: an ambiguous link, a link whose
 * produto is gone, a child link carrying its parent's SKU or ASIN, a unit with
 * variations, and a parent pointer that cannot be checked. Each leaves a
 * listing selling at its last quantity until someone fixes the data, so a run
 * that counts one raises the conta's `estoque-vinculos-recusados` aviso.
 * `envio-desligado` is NOT one: it is the operator's own choice for that
 * listing.
 *
 * ## Tokens
 *
 * Every slug and every counter is a token the reconcile run's counter map
 * accepts (`CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX`, in the schemas package), and
 * the two sets are disjoint, so one map holds both. A test pins it.
 *
 * ⚠️ PERSISTED as counter keys: a rename orphans every count already stored.
 * Not a Zod enum: nothing parses a motivo from an untrusted source.
 *
 * ⚠️ LIGHT on purpose: it imports nothing.
 */

/* ------------------------------ the outcomes ------------------------------ */

export type MotivoEstoqueAmazon =
  // ---- the end of a send ----
  | 'enviado'
  | 'igual'
  | 'simulado'
  | 'desligado'
  | 'fora-do-canario'
  // ---- the link verdict, and the patch path ----
  | 'vinculo-ambiguo'
  | 'produto-ausente'
  | 'filho-com-sku-do-pai'
  | 'unidade-com-variacoes'
  | 'envio-desligado'
  | 'pai-do-vinculo-ilegivel'
  | 'sem-caminho'
  // ---- the listing gate ----
  | 'nao-listado'
  | 'pai'
  | 'afn'
  | 'asin-divergente'
  // ---- the conta, the unit, the read ----
  | 'unidade-ausente'
  | 'conta-sem-deposito'
  | 'conta-indisponivel'
  | 'deposito-mudou'
  | 'nao-confirmado'
  // ---- a failure or a budget ----
  | 'leitura-falhou'
  | 'escrita-falhou'
  | 'escrita-incerta'
  | 'prazo-da-tarefa'
  | 'pausado'
  | 'orcamento-esgotado'
  | 'snapshot-lento'
  | 'janela-grande'
  // ---- the form a batch took ----
  | 'em-patches'
  | 'em-feed'
  | 'em-reconciliacao'
  | 'repassado-para-patches'
  // ---- a reconcile page's skip ----
  | 'ja-visto';

/**
 * The closed set, so code names a member instead of spelling a slug. Keys are
 * the slugs in camelCase — a test pins the pairing.
 */
export const MOTIVO_ESTOQUE_AMAZON = {
  enviado: 'enviado',
  igual: 'igual',
  simulado: 'simulado',
  desligado: 'desligado',
  foraDoCanario: 'fora-do-canario',
  vinculoAmbiguo: 'vinculo-ambiguo',
  produtoAusente: 'produto-ausente',
  filhoComSkuDoPai: 'filho-com-sku-do-pai',
  unidadeComVariacoes: 'unidade-com-variacoes',
  envioDesligado: 'envio-desligado',
  paiDoVinculoIlegivel: 'pai-do-vinculo-ilegivel',
  semCaminho: 'sem-caminho',
  naoListado: 'nao-listado',
  pai: 'pai',
  afn: 'afn',
  asinDivergente: 'asin-divergente',
  unidadeAusente: 'unidade-ausente',
  contaSemDeposito: 'conta-sem-deposito',
  contaIndisponivel: 'conta-indisponivel',
  depositoMudou: 'deposito-mudou',
  naoConfirmado: 'nao-confirmado',
  leituraFalhou: 'leitura-falhou',
  escritaFalhou: 'escrita-falhou',
  escritaIncerta: 'escrita-incerta',
  prazoDaTarefa: 'prazo-da-tarefa',
  pausado: 'pausado',
  orcamentoEsgotado: 'orcamento-esgotado',
  snapshotLento: 'snapshot-lento',
  janelaGrande: 'janela-grande',
  emPatches: 'em-patches',
  emFeed: 'em-feed',
  emReconciliacao: 'em-reconciliacao',
  repassadoParaPatches: 'repassado-para-patches',
  jaVisto: 'ja-visto',
} as const satisfies Record<string, MotivoEstoqueAmazon>;

/* ------------------------------- the subsets ------------------------------- */

/** The link verdict's refusals (`vinculoEstoque.ts`), in the order it checks them. */
const RECUSAS_DO_VINCULO = [
  MOTIVO_ESTOQUE_AMAZON.vinculoAmbiguo,
  MOTIVO_ESTOQUE_AMAZON.produtoAusente,
  MOTIVO_ESTOQUE_AMAZON.paiDoVinculoIlegivel,
  MOTIVO_ESTOQUE_AMAZON.filhoComSkuDoPai,
  MOTIVO_ESTOQUE_AMAZON.unidadeComVariacoes,
  MOTIVO_ESTOQUE_AMAZON.envioDesligado,
] as const satisfies readonly MotivoEstoqueAmazon[];

/** A refusal of the link verdict. */
export type RecusaVinculoEstoqueAmazon = (typeof RECUSAS_DO_VINCULO)[number];

/** The listing gate's refusals (`gateListing.ts`), in the order it checks them. */
const RECUSAS_DO_LISTING = [
  MOTIVO_ESTOQUE_AMAZON.naoListado,
  MOTIVO_ESTOQUE_AMAZON.pai,
  MOTIVO_ESTOQUE_AMAZON.afn,
  MOTIVO_ESTOQUE_AMAZON.asinDivergente,
] as const satisfies readonly MotivoEstoqueAmazon[];

/** A refusal of the listing gate. */
export type RecusaListingEstoqueAmazon = (typeof RECUSAS_DO_LISTING)[number];

/** The refusals a person must fix (module header): typed against the link verdict's. */
const RECUSAS_HUMANAS = [
  MOTIVO_ESTOQUE_AMAZON.vinculoAmbiguo,
  MOTIVO_ESTOQUE_AMAZON.produtoAusente,
  MOTIVO_ESTOQUE_AMAZON.filhoComSkuDoPai,
  MOTIVO_ESTOQUE_AMAZON.unidadeComVariacoes,
  MOTIVO_ESTOQUE_AMAZON.paiDoVinculoIlegivel,
] as const satisfies readonly RecusaVinculoEstoqueAmazon[];

export const RECUSAS_VINCULO_ESTOQUE_AMAZON: ReadonlySet<MotivoEstoqueAmazon> =
  new Set<MotivoEstoqueAmazon>(RECUSAS_DO_VINCULO);

export const RECUSAS_LISTING_ESTOQUE_AMAZON: ReadonlySet<MotivoEstoqueAmazon> =
  new Set<MotivoEstoqueAmazon>(RECUSAS_DO_LISTING);

export const RECUSAS_HUMANAS_ESTOQUE_AMAZON: ReadonlySet<MotivoEstoqueAmazon> =
  new Set<MotivoEstoqueAmazon>(RECUSAS_HUMANAS);

/* ------------------------------- the counters ------------------------------ */

export type ContadorEstoqueAmazon =
  | 'pacote'
  | 'semRelacoes'
  | 'semAsinNaAmazon'
  | 'semAsinNoVinculo'
  | 'confirmadoPorGet'
  | 'zeroSemLinha';

/** The closed set of counters (module header); each key is its own token. */
export const CONTADOR_ESTOQUE_AMAZON = {
  pacote: 'pacote',
  semRelacoes: 'semRelacoes',
  semAsinNaAmazon: 'semAsinNaAmazon',
  semAsinNoVinculo: 'semAsinNoVinculo',
  confirmadoPorGet: 'confirmadoPorGet',
  zeroSemLinha: 'zeroSemLinha',
} as const satisfies Record<string, ContadorEstoqueAmazon>;
