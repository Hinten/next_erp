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
 *   before writing. 41 members: step 11's 22 plus the nineteen native-kit
 *   refusals of step 19's kit core (`kits/planoKit.ts`, PR 5).
 * - {@link MOTIVO_PROBLEMA_PUBLICACAO} — what a `problemas[]` entry may carry:
 *   those 41 plus the twelve only a WIRE rejection can produce (step 18 added the
 *   two size-chart refusals on `size_chart_info`; step 19 the seven native-kit
 *   refusals, whose ONE producer is `kits/recusaKit.ts`). A problema is a
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
   * The listing is a **NATIVE Shopee kit** — `kitNativo` on the stored link
   * (what Shopee reported about the live listing), or `ehKitVirtual` on a first
   * publish. Kit publishing is its own step (`add_kit_item`), so it is refused
   * here rather than published as if it were a plain produto.
   *
   * ⚠️ **NOT the ERP's `ehKit`**, which publishes as an ordinary listing whose
   * quantity merely derives from its components. Step 11 keyed this member on
   * that flag and blocked the entire legacy kit catalogue; step 12 (#1520)
   * narrowed the predicate. The SLUG is deliberately unchanged — it is
   * persisted in `falhaPublicacao.problemas[]`, so renaming it would orphan
   * every stored refusal.
   */
  | 'produto-e-kit'
  /*
   * ---- Step 19 (#1527): the native-kit refusals of the kit core (PR 5). ----
   * Each one is decided by READING (the produto, its children, the links, the
   * component resolution, the duplicate scan) before any Shopee WRITE, and each
   * is produced in `kits/` — spelled there through this constant only.
   */
  /** The kit produto has NO sellable unit (no child at all): nothing to make a kit model of. */
  | 'kit-sem-unidade-vendavel'
  /** A sellable unit (a family child, or a família de um's member) whose `componentesKit` is empty. */
  | 'kit-sem-componentes'
  /** More children than a kit takes models (`SHOPEE_KIT_MAX_MODELOS`, 9 — L2). */
  | 'kit-variacoes-demais'
  /** The children vary on more than ONE grupo; a kit has exactly one tier (L2). */
  | 'kit-dois-eixos'
  /** A kit model with ONE component row needs `quantity >= 2` (announcement 1262; R-5). */
  | 'kit-componente-unico-quantidade'
  /** K has no SKU: the duplicate scan and step 9's import key on it. Create arms only. */
  | 'kit-sem-sku'
  /** K's SKU has leading/trailing whitespace, which the scan and the import trim. Create arms only. */
  | 'kit-sku-com-espacos'
  /** Another ROOT produto shares K's SKU, so step 9's parent rung could not land on K (R-14). */
  | 'kit-sku-repetido'
  /** A component has no listing in this conta (no `prodshopee`/`variashopee` reaches it). */
  | 'componente-nao-publicado'
  /** A component whose listing HAS variations, with no model the ERP can name. */
  | 'componente-sem-modelo'
  /** A component that is itself a native Shopee kit — kit of kits is not supported. */
  | 'componente-e-kit-nativo'
  /** A component whose listing is neither `NORMAL` nor `UNLIST` (or unreadable). */
  | 'componente-anuncio-inativo'
  /** A kit model outside the served `component_count_limit_of_single_model` band (R-f). */
  | 'componentes-fora-da-faixa'
  /** The kit spans 2+ Shopee items and no `--principal` was named (L1). */
  | 'principal-obrigatorio'
  /** The named `--principal` is not part of the kit's composition. */
  | 'principal-invalido'
  /** The L6 scan found a Shopee kit with K's SKU that is not this produto's ("importe-o"). */
  | 'kit-ja-existe-na-shopee'
  /** The L6 scan stopped at its page ceiling: nothing was created. */
  | 'busca-de-kit-incompleta'
  /** Two or more LIVE native-kit links of the produto in this conta (native links only, L10(3)). */
  | 'vinculos-ambiguos'
  /** The link was superseded by a native kit (L8): publish no longer targets it. */
  | 'vinculo-substituido';

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
  kitSemUnidadeVendavel: 'kit-sem-unidade-vendavel',
  kitSemComponentes: 'kit-sem-componentes',
  kitVariacoesDemais: 'kit-variacoes-demais',
  kitDoisEixos: 'kit-dois-eixos',
  kitComponenteUnicoQuantidade: 'kit-componente-unico-quantidade',
  kitSemSku: 'kit-sem-sku',
  kitSkuComEspacos: 'kit-sku-com-espacos',
  kitSkuRepetido: 'kit-sku-repetido',
  componenteNaoPublicado: 'componente-nao-publicado',
  componenteSemModelo: 'componente-sem-modelo',
  componenteEKitNativo: 'componente-e-kit-nativo',
  componenteAnuncioInativo: 'componente-anuncio-inativo',
  componentesForaDaFaixa: 'componentes-fora-da-faixa',
  principalObrigatorio: 'principal-obrigatorio',
  principalInvalido: 'principal-invalido',
  kitJaExisteNaShopee: 'kit-ja-existe-na-shopee',
  buscaDeKitIncompleta: 'busca-de-kit-incompleta',
  vinculosAmbiguos: 'vinculos-ambiguos',
  vinculoSubstituido: 'vinculo-substituido',
} as const satisfies Record<string, MotivoPublicacaoBloqueada>;

/**
 * Everything a `problemas[]` entry may carry: every pre-write refusal, plus the
 * twelve only a WIRE rejection (or, for the size-chart photo, a failed upload of
 * it) can produce.
 *
 * The same superset relationship `MOTIVO_FALHA_JOB` has to
 * `MOTIVO_IMPORT_BLOQUEADO` on the import side, and for the same reason: a
 * {@link ShopeePublishBlockedError} may never carry one of the extra twelve,
 * because none of them is a decision reached by READING the produto.
 *
 * ⚠️ The seven native-kit members (step 19) are classified by SENTENCE AND code
 * in `kits/recusaKit.ts` — their only producer, which spells each one through
 * this constant and never as a quoted slug (`errosPublicacao.test.ts` O7 accepts
 * only the constant spelling for them).
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
   * Shopee did not accept the `size_chart_info.size_chart_id` we SENT (step 18):
   * the template was deleted in Seller Centre, or is not one this listing's
   * category takes. The pick is the operator's, so the publish is refused (a
   * 422 on `size_chart_info`, no retry without the key) and the fix is a
   * re-pick in `/medidas`. ⚠️ It never falls back to the tabela's photo.
   */
  | 'tabela-de-medidas-recusada'
  /**
   * The tabela's first photo, sent as an IMAGE chart
   * (`size_chart_info.size_chart`), was refused — by Shopee's size-chart image
   * validator (announcement 1337), or because its own `upload_image` failed.
   * Refuses the publish like a stale template (Lucas's Q1c): a 422 on
   * `size_chart_info`, never on `image`, and no retry without the chart.
   */
  | 'tabela-de-medidas-foto-recusada'
  /**
   * Step 19 — `product.error_busi` "Invalid product setting" on a kit: this
   * write does not apply to a kit (measured on `update_stock`). Permanent.
   */
  | 'operacao-invalida-para-kit'
  /**
   * Step 19 — `product.error_busi` carrying Shopee's database "Too many
   * connections" (measured on `add_kit_item`). TRANSIENT: the write may have
   * landed, so a create re-reads before it ever resends.
   */
  | 'instabilidade-shopee'
  /**
   * Step 19 — `product.error_server` "generate kit image toggle closed": the
   * feature is off in this shop. Permanent despite the code's `transient` kind;
   * the cover goes through `upload_image` instead.
   */
  | 'imagem-de-kit-desligada'
  /**
   * Step 19 — the code `.` with "product is not found" (a non-kit id, measured)
   * or `error_param` "The information you queried is not found" (documented).
   * ⚠️ A DELETED kit still reads, so this is "not a kit", never "deleted".
   */
  | 'kit-inexistente'
  /**
   * Step 19 — `error_busi_cannot_edit_vsku` on a kit op: this shop/app may not
   * create or edit kits through OpenAPI (a whitelist only the Shopee manager
   * opens). A store-level refusal, never a fault of the produto.
   */
  | 'kit-bloqueado-pela-shopee'
  /**
   * Step 19 — `product.error_busi` "The amount of component in this Kit
   * Variation …": a kit model's component band. The only way the band is
   * learnt when `get_kit_item_limit` is not served.
   */
  | 'faixa-de-componentes'
  /**
   * Step 19 — `product.error_busi` "mupltiple main sku" (probe #2): a second
   * main component in the kit. The package guard makes it unreachable; the row
   * exists so a guard drift reads as a refusal, never as "maybe created".
   */
  | 'kit-principal-duplicado'
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
  tabelaDeMedidasRecusada: 'tabela-de-medidas-recusada',
  tabelaDeMedidasFotoRecusada: 'tabela-de-medidas-foto-recusada',
  operacaoInvalidaParaKit: 'operacao-invalida-para-kit',
  instabilidadeShopee: 'instabilidade-shopee',
  imagemDeKitDesligada: 'imagem-de-kit-desligada',
  kitInexistente: 'kit-inexistente',
  kitBloqueadoPelaShopee: 'kit-bloqueado-pela-shopee',
  faixaDeComponentes: 'faixa-de-componentes',
  kitPrincipalDuplicado: 'kit-principal-duplicado',
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
  | 'leitura-de-volta'
  /** Step 19 — the native-kit create (PR 5). A rejection here leaves nothing on the channel. */
  | 'add_kit_item'
  /** Step 19 — the native-kit republish (PR 5). */
  | 'update_kit_item'
  /** Step 19 — the recriar's delete of the OLD kit (its producer lands with PR 6). */
  | 'delete_item';

/**
 * The closed set of etapas.
 *
 * Not required by `delfrance/prefer-schema-enum` (that rule only knows Zod
 * enums, and this is a hand-written union), and declared anyway for the two
 * reasons the repo's own convention names: the value is PERSISTED, so one
 * spelling is worth having, and a type-only union cannot be enumerated by the
 * test that asserts these thirteen and no more (step 19 appended the three
 * native-kit operations after step 11's ten).
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
  addKitItem: 'add_kit_item',
  updateKitItem: 'update_kit_item',
  deleteItem: 'delete_item',
} as const satisfies Record<string, EtapaPublicacao>;

/**
 * The headline's first clause — WHO refused, WHERE, and with which code.
 *
 * - Shopee refused, with a code ⇒ `Publicação recusada pela Shopee em <etapa> (<code>)`.
 * - Shopee refused, no code (a re-list `failed_reason` that names none, an
 *   `upload_image` refusal whose code the resolver keeps only as its closed
 *   motivo) ⇒ the same clause WITHOUT the parentheses — never an empty `()`.
 * - The publisher stopped before Shopee could judge ⇒
 *   `Publicação interrompida em <etapa>`: no "pela Shopee" (step 18's photo
 *   that never uploaded; the problema says what happened and what to do).
 *
 * Exported for the CLI's line, so the two renderings cannot disagree on who
 * refused.
 */
export function cabecalhoDaRecusa(
  etapa: EtapaPublicacao,
  shopeeCode: string,
  recusadaPelaShopee: boolean,
): string {
  const codigo = shopeeCode === '' ? '' : ` (${shopeeCode})`;
  return recusadaPelaShopee
    ? `Publicação recusada pela Shopee em ${etapa}${codigo}`
    : `Publicação interrompida em ${etapa}${codigo}`;
}

/**
 * Shopee refused a call, and the refusal was classified onto request fields.
 *
 * ⚠️ Writes may already have landed — that is the whole difference from
 * {@link ShopeePublishBlockedError}, and why {@link etapa} is not optional.
 *
 * ⚠️ ONE producer is not a Shopee answer: step 18's size-chart photo that never
 * uploaded is refused HERE too (etapa `fotos`, before any listing write — a
 * Blocked error may not carry its motivo), with
 * {@link ShopeePublishRejectedError.recusadaPelaShopee} `false` when Shopee never
 * saw the photo.
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
  /**
   * `false` ONLY for step 18's size-chart photo that never reached Shopee's
   * judgement — a failed download (a network blip included), a file the
   * publisher skips, a missing arquivo. The publish is still refused (Lucas's
   * Q1c, etapa `fotos`), but the headline must not say Shopee refused it:
   * Shopee never saw the photo. Every other producer is a Shopee answer.
   */
  readonly recusadaPelaShopee: boolean;

  constructor(init: {
    readonly etapa: EtapaPublicacao;
    readonly shopeeCode: string;
    readonly produtoId: string;
    readonly itemId: number | null;
    readonly problemas: readonly ProblemaPublicacao[];
    /** Default `true` — see {@link ShopeePublishRejectedError.recusadaPelaShopee}. */
    readonly recusadaPelaShopee?: boolean;
  }) {
    const total = init.problemas.length;
    const alvo = init.itemId === null ? '' : ` (item ${String(init.itemId)})`;
    const recusadaPelaShopee = init.recusadaPelaShopee ?? true;
    super(
      `${cabecalhoDaRecusa(init.etapa, init.shopeeCode, recusadaPelaShopee)} ` +
        `no produto ${init.produtoId}${alvo}: ${String(total)} problema${total === 1 ? '' : 's'}`,
    );
    this.name = 'ShopeePublishRejectedError';
    this.recusadaPelaShopee = recusadaPelaShopee;
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
