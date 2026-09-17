/**
 * The two per-PRODUTO refusals of the Shopee publish direction (#1519, step 11)
 * and the PERSISTED vocabularies that go with them.
 *
 * The split mirrors `produtos/errosImportacao.ts` exactly: the vocabulary and
 * the classes in one small module, the mapper (`problemasPublicacao.ts`, which
 * turns a Shopee `error` code into a {@link ProblemaPublicacao}) elsewhere. What
 * is new is that publishing has TWO refusals rather than one, because it has a
 * before and an after:
 *
 * - {@link ShopeePublishBlockedError} — **pre-write.** The publisher read the
 *   produto, the link and the conta and decided the body cannot be built. No
 *   Shopee call was made for this produto, so nothing on the channel changed and
 *   the operator may retry the identical request once the cause is fixed.
 * - {@link ShopeePublishRejectedError} — **post-write.** A Shopee call was made
 *   and refused, and the refusal was classified onto a REQUEST field. It carries
 *   the {@link EtapaPublicacao} it died on, so "the listing exists but has no
 *   models" is distinguishable from "nothing was created".
 *
 * Without the second class a classified rejection would return 502
 * `SHOPEE_HTTP_ERROR` and drop `problemas[]` on the floor — the operator would
 * be told Shopee is broken when in fact one stale attribute on one produto was
 * refused. That is the whole reason it exists.
 *
 * ⚠️ **Next-free by declaration.** The Cloud Functions bundle reaches modules
 * under `lib/shopee/anuncios/` (the `onProdutoShopeeLinkChanged` trigger), and
 * `core/respond.ts` — which imports `next/server` — must stay out of it. The
 * dependency therefore runs ONE way: `respond.ts` imports this module to answer
 * 422, and nothing here knows an HTTP response exists.
 *
 * ## Why both are `ShopeeError` and neither is contained
 *
 * Both extend `ShopeeError`, for the reason `errosImportacao.ts` spells out:
 * `core/containment.ts`'s `erroContidoPorConta` names its classes EXPLICITLY and
 * deliberately never names the base, so inheriting from it does NOT turn one
 * refused produto into one conta's outage. That matters more here than on the
 * import side: a future bulk publish must catch a per-produto refusal PER
 * PRODUTO, not let one blocked produto abort a whole conta's tick.
 * `errosPublicacao.test.ts` pins both halves for both classes — each IS a
 * `ShopeeError`, and `erroContidoPorConta` answers `false` for each.
 *
 * ## The three vocabularies, and why there are three
 *
 * - {@link MOTIVO_PUBLICACAO_BLOQUEADA} — what the publisher may REFUSE with
 *   before writing. 22 members.
 * - {@link MOTIVO_PROBLEMA_PUBLICACAO} — what a `problemas[]` entry may carry:
 *   those 22 plus the three only a WIRE rejection can produce. A problema is a
 *   field-level observation, and after the first Shopee call there are causes no
 *   pre-write check could have seen.
 * - {@link ETAPA_PUBLICACAO} — where in the `aplicar` sequence a rejection
 *   landed. Not a reason at all; the answer to "what exists on the channel now".
 *
 * ⚠️ `imposto-incompleto` is deliberately ABSENT from all three. Lucas chose the
 * OMIT arm for `tax_info` (Q2): an incomplete BR tax block is left out of the
 * body and recorded in `taxInfoOmitido`, so nothing can refuse a publish for it.
 * Same rule as `kit-nao-importado` on the import side — a vocabulary member
 * nothing can produce is a filter a UI renders and never fills. The two codes
 * that DO mean "Shopee did not accept the block we sent" classify as the
 * problema-only `imposto-recusado`.
 *
 * ⚠️ **All three vocabularies are PERSISTED and are not free to rename.** They
 * are stored in the link document's `falhaPublicacao` (`.motivo`, `.etapa`,
 * `.problemas[].motivo`) and they reach the operator through a 422 body. Adding
 * a member is cheap; renaming one orphans every row already written.
 */
import { ShopeeError } from '@delfrance/integrations-shopee';

import { MAX_MENSAGEM_PROBLEMA } from './constantesAnuncio';

/**
 * Why the publisher refused ONE produto, before any Shopee call for it.
 *
 * Each member is a mechanism, not a sentence — the sentence is the matching
 * {@link ProblemaPublicacao.mensagem}.
 */
export type MotivoPublicacaoBloqueada =
  /** `nome` is blank; Shopee's `item_name` is required. */
  | 'sem-nome'
  /** `item_name` outside the category's `itemNameLengthLimit` band. */
  | 'nome-fora-da-faixa'
  /** `descricao` is blank; `description` is required on create. */
  | 'sem-descricao'
  /** `description` outside the category's `itemDescriptionLengthLimit` band. */
  | 'descricao-fora-da-faixa'
  /** No price at all on a produto without children. */
  | 'sem-preco'
  /** A produto WITH children where at least one child has no price. */
  | 'filho-sem-preco'
  /** A price outside the category's `priceLimit` band. */
  | 'preco-fora-da-faixa'
  /**
   * No gross or net weight. ⚠️ Never defaulted: the legacy exporter sent `1` kg
   * when the produto had none, which quietly published a freight quote nobody
   * chose.
   */
  | 'sem-peso'
  /** Any of the three axes missing — BR requires all three, not just a volume. */
  | 'sem-dimensoes'
  /** No usable photo: every candidate failed to upload, or there were none. */
  | 'sem-fotos'
  /** The category's `gtin_validation_rule` is `Mandatory` and the produto has none. */
  | 'sem-gtin'
  /** No `category_id`, or one that is not a LEAF (Shopee only accepts leaves). */
  | 'categoria-invalida'
  /** A mandatory attribute of the category has no value on the produto. */
  | 'atributo-obrigatorio'
  /**
   * A `brand_id` was resolved but its NAME could not be, and the create path
   * requires `original_brand_name`. On UPDATE the `brand` block is omitted
   * instead, so this is a create-only refusal.
   */
  | 'marca-sem-nome'
  /** A variação with no `tier_index` binding — the model could not be placed. */
  | 'variacao-sem-vinculo'
  /**
   * Two variantes resolve to the SAME tier combination. `arakene_variation_id`
   * is a LIST, so one option can legitimately bind several variantes — which is
   * exactly how two of them end up claiming one model.
   */
  | 'combinacao-duplicada'
  /** More options in one tier than the wire accepts. */
  | 'opcoes-demais'
  /**
   * An item- or model-level available stock below the shop's
   * `stock_limit.min_limit`.
   *
   * ⚠️ Measured, and it is a real divergence from Mercado Livre rather than a
   * guess: on 2026-09-17 the sandbox refused a create with `stock: 1` —
   * `Stock should be within 2-1000000 for model` — where that shop's minimum was
   * **2**. ML accepts `0` and simply shows the listing as out of stock; Shopee
   * refuses the write. So a produto with nothing available cannot be published,
   * and the problema names the band rather than silently rounding the stock up
   * to something the operator never authorised.
   */
  | 'estoque-abaixo-do-minimo'
  /** The channel builder found no channel the item fits and the shop enables. */
  | 'logistica-sem-canal'
  /**
   * The stored `estadoAnuncio` says the listing is gone. Refused rather than
   * re-created: a `removido` listing keeps its `item_id`, and `update_item`
   * against it fails — deciding to publish a NEW listing is the operator's.
   */
  | 'listagem-removida'
  /**
   * The produto is a CHILD (a variação's own produto). A listing is published
   * from the parent, and publishing a child would create a second listing for
   * the same goods.
   */
  | 'produto-e-filho'
  /**
   * The produto is a kit. Kit publishing is its own step; refused here so a kit
   * is never published as if it were a plain produto.
   */
  | 'produto-e-kit';

/**
 * The closed set, for iteration and for a route's own validation.
 *
 * ⚠️ `imposto-incompleto` is deliberately ABSENT — see the module docblock.
 */
export const MOTIVO_PUBLICACAO_BLOQUEADA = {
  semNome: 'sem-nome',
  nomeForaDaFaixa: 'nome-fora-da-faixa',
  semDescricao: 'sem-descricao',
  descricaoForaDaFaixa: 'descricao-fora-da-faixa',
  semPreco: 'sem-preco',
  filhoSemPreco: 'filho-sem-preco',
  precoForaDaFaixa: 'preco-fora-da-faixa',
  semPeso: 'sem-peso',
  semDimensoes: 'sem-dimensoes',
  semFotos: 'sem-fotos',
  semGtin: 'sem-gtin',
  categoriaInvalida: 'categoria-invalida',
  atributoObrigatorio: 'atributo-obrigatorio',
  marcaSemNome: 'marca-sem-nome',
  variacaoSemVinculo: 'variacao-sem-vinculo',
  combinacaoDuplicada: 'combinacao-duplicada',
  opcoesDemais: 'opcoes-demais',
  estoqueAbaixoDoMinimo: 'estoque-abaixo-do-minimo',
  logisticaSemCanal: 'logistica-sem-canal',
  listagemRemovida: 'listagem-removida',
  produtoEFilho: 'produto-e-filho',
  produtoEKit: 'produto-e-kit',
} as const satisfies Record<string, MotivoPublicacaoBloqueada>;

/**
 * Everything a `problemas[]` entry may carry: every pre-write refusal, plus the
 * three only a WIRE rejection can produce.
 *
 * The same superset relationship `MOTIVO_FALHA_JOB` has to
 * `MOTIVO_IMPORT_BLOQUEADO` on the import side, and for the same reason: a
 * {@link ShopeePublishBlockedError} may never carry one of the extra three,
 * because none of them is a decision reached by READING the produto.
 */
export type MotivoProblemaPublicacao =
  | MotivoPublicacaoBloqueada
  /**
   * Shopee refuses the write because the listing is inside a promotion. Nothing
   * on our side is wrong and no retry helps until the promotion ends.
   */
  | 'bloqueado-por-promocao'
  /**
   * Shopee did not accept the `tax_info` block we SENT (an invalid additional
   * information, a required field it wants filled). Distinct from "we could not
   * build it": that case omits the block and never reaches a problema.
   */
  | 'imposto-recusado'
  /**
   * A refusal the classifier could not attribute to any request field. The
   * entry's `campo` is `null` and its `mensagem` carries Shopee's own prose —
   * the one place provider text is allowed, because dropping it would leave the
   * operator with nothing at all.
   */
  | 'desconhecido';

/** The closed set for {@link MotivoProblemaPublicacao}. Same persistence rule. */
export const MOTIVO_PROBLEMA_PUBLICACAO = {
  ...MOTIVO_PUBLICACAO_BLOQUEADA,
  bloqueadoPorPromocao: 'bloqueado-por-promocao',
  impostoRecusado: 'imposto-recusado',
  desconhecido: 'desconhecido',
} as const satisfies Record<string, MotivoProblemaPublicacao>;

/**
 * ONE field-level problem, in the shape both the 422 body and
 * `falhaPublicacao.problemas[]` store.
 *
 * ⚠️ **No PII and no payload.** `mensagem` is a MECHANISM sentence — what could
 * not be decided and why — except in the one case the module docblock names
 * (`desconhecido`, where it is Shopee's own refusal prose). Never a produto
 * name, never a description, never a URL, never a raw response body, never a
 * `tax_info` value. It is persisted AND returned, so anything put here is
 * published twice.
 */
export interface ProblemaPublicacao {
  /** A Shopee REQUEST field path (`attribute_list`, `logistic_info`), or `null`. */
  readonly campo: string | null;
  readonly motivo: MotivoProblemaPublicacao;
  /** At most {@link MAX_MENSAGEM_PROBLEMA} characters — normalised by the classes. */
  readonly mensagem: string;
}

/**
 * A {@link ProblemaPublicacao} whose motivo is a PRE-WRITE refusal.
 *
 * The narrowing is what makes {@link ShopeePublishBlockedError.motivo} typed as
 * the blocked vocabulary while the class still derives it from its first
 * problema: a `bloqueado-por-promocao` entry cannot be handed to a pre-write
 * refusal, because nothing read off the produto could have produced it.
 */
export interface ProblemaDeBloqueio extends ProblemaPublicacao {
  readonly motivo: MotivoPublicacaoBloqueada;
}

/**
 * Cap one problema `mensagem` at {@link MAX_MENSAGEM_PROBLEMA} characters.
 *
 * ⚠️ The result is never LONGER than the cap — the ellipsis replaces the last
 * kept character rather than being appended past it. `respond.ts`'s `safeJson`
 * appends and so answers one character over its own bound; that is tolerable for
 * a log line and not for a value the link document stores and a schema may one
 * day check.
 *
 * Both constructors run every entry through it, so the bound holds by
 * CONSTRUCTION instead of by every producer remembering it.
 */
export function limitarMensagemProblema(texto: string): string {
  if (texto.length <= MAX_MENSAGEM_PROBLEMA) return texto;
  return `${texto.slice(0, MAX_MENSAGEM_PROBLEMA - 1)}…`;
}

/**
 * `true` when the list has at least one entry, narrowed to a non-empty tuple.
 *
 * It exists so {@link ShopeePublishBlockedError} can require a non-empty
 * `problemas` at COMPILE time — its `motivo` IS the first entry's, so an empty
 * list would have no answer and the class would need a fallback member that
 * nothing legitimately produces. A collector builds a plain array and this guard
 * is what turns it into the constructor's argument.
 */
export function temProblemaDeBloqueio(
  problemas: readonly ProblemaDeBloqueio[],
): problemas is readonly [ProblemaDeBloqueio, ...ProblemaDeBloqueio[]] {
  return problemas.length > 0;
}

/** Nothing was sent to Shopee: the body could not be built. */
export class ShopeePublishBlockedError extends ShopeeError {
  /**
   * The FIRST problema's motivo — the headline reason, not a summary.
   *
   * The producers append in the order they check, so the first entry is the one
   * a reader should see first; taking the last instead would report whichever
   * check happened to run last as the cause.
   */
  readonly motivo: MotivoPublicacaoBloqueada;
  /** Always known — the produto is what the caller asked to publish. */
  readonly produtoId: string;
  /** `null` on a FIRST publish: there is no listing yet. */
  readonly itemId: number | null;
  readonly problemas: readonly ProblemaDeBloqueio[];

  constructor(init: {
    readonly produtoId: string;
    readonly itemId: number | null;
    readonly problemas: readonly [ProblemaDeBloqueio, ...ProblemaDeBloqueio[]];
  }) {
    const motivo = init.problemas[0].motivo;
    const total = init.problemas.length;
    const alvo = init.itemId === null ? '' : ` (item ${String(init.itemId)})`;
    super(
      `Publicação bloqueada (${motivo}) no produto ${init.produtoId}${alvo}: ` +
        `${String(total)} problema${total === 1 ? '' : 's'}`,
    );
    this.name = 'ShopeePublishBlockedError';
    this.motivo = motivo;
    this.produtoId = init.produtoId;
    this.itemId = init.itemId;
    this.problemas = init.problemas.map((p) => ({
      ...p,
      mensagem: limitarMensagemProblema(p.mensagem),
    }));
  }
}

/**
 * Where in the `aplicar` sequence a rejection landed.
 *
 * ⚠️ It is not a reason — it is the answer to "what exists on the channel now".
 * A rejection at `init_tier_variation` leaves an `UNLIST` item with no models;
 * one at `add_item` leaves nothing. Persisted in `falhaPublicacao.etapa` so the
 * next attempt (and the operator) can tell those apart.
 */
export type EtapaPublicacao =
  | 'fotos'
  | 'add_item'
  | 'update_item'
  | 'init_tier_variation'
  | 'update_tier_variation'
  | 'add_model'
  | 'update_model'
  | 'get_model_list'
  | 'relistagem'
  | 'leitura-de-volta';

/**
 * The closed set of etapas.
 *
 * Not required by `delfrance/prefer-schema-enum` (that rule only knows Zod
 * enums, and this is a hand-written union), and declared anyway for the two
 * reasons the repo's own convention names: the value is PERSISTED, so one
 * spelling is worth having, and a type-only union cannot be enumerated by the
 * test that asserts these ten and no more.
 */
export const ETAPA_PUBLICACAO = {
  fotos: 'fotos',
  addItem: 'add_item',
  updateItem: 'update_item',
  initTierVariation: 'init_tier_variation',
  updateTierVariation: 'update_tier_variation',
  addModel: 'add_model',
  updateModel: 'update_model',
  getModelList: 'get_model_list',
  relistagem: 'relistagem',
  leituraDeVolta: 'leitura-de-volta',
} as const satisfies Record<string, EtapaPublicacao>;

/**
 * Shopee refused a call, and the refusal was classified onto request fields.
 *
 * ⚠️ Writes may already have landed — that is the whole difference from
 * {@link ShopeePublishBlockedError}, and why {@link etapa} is not optional.
 */
export class ShopeePublishRejectedError extends ShopeeError {
  readonly etapa: EtapaPublicacao;
  /**
   * Shopee's own `error` string, VERBATIM — module prefix and all
   * (`product.error_param`, not `error_param`).
   *
   * ⚠️ The stripped form exists for CLASSIFICATION only, and stripping it here
   * would throw away which module refused: two modules use the same suffix, and
   * the prefix is the only thing that says which page's error list to read. The
   * classifier strips a copy; this field keeps the original.
   */
  readonly shopeeCode: string;
  readonly produtoId: string;
  /** `null` when the rejection came from the very first `add_item`. */
  readonly itemId: number | null;
  /**
   * Possibly EMPTY: a wire refusal the classifier could not attribute to any
   * field still has to surface with its etapa and its code, and inventing a
   * `desconhecido` entry to fill the list would put provider prose in a place a
   * reader expects a mechanism.
   */
  readonly problemas: readonly ProblemaPublicacao[];

  constructor(init: {
    readonly etapa: EtapaPublicacao;
    readonly shopeeCode: string;
    readonly produtoId: string;
    readonly itemId: number | null;
    readonly problemas: readonly ProblemaPublicacao[];
  }) {
    const total = init.problemas.length;
    const alvo = init.itemId === null ? '' : ` (item ${String(init.itemId)})`;
    super(
      `Publicação recusada pela Shopee em ${init.etapa} (${init.shopeeCode}) ` +
        `no produto ${init.produtoId}${alvo}: ${String(total)} problema${total === 1 ? '' : 's'}`,
    );
    this.name = 'ShopeePublishRejectedError';
    this.etapa = init.etapa;
    this.shopeeCode = init.shopeeCode;
    this.produtoId = init.produtoId;
    this.itemId = init.itemId;
    this.problemas = init.problemas.map((p) => ({
      ...p,
      mensagem: limitarMensagemProblema(p.mensagem),
    }));
  }
}
