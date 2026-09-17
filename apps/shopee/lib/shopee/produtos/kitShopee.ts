/**
 * ONE Shopee **kit** listing → the ERP (#1517, step 9, arm K1). The importer the
 * mass-import job's kit queue, the single-item route and the rehearsal CLI drive
 * for a `tag.kit` listing — never {@link importarAnuncioShopee}, which refuses a
 * kit outright rather than minting a simple produto for something that is not
 * one.
 *
 * ## What this module exports (P6's seam)
 *
 *  - `importarKitShopee(deps, entrada)` — the BOUND name, an
 *    `ImportarKitShopeeFn`: prepare → apply → the result with its `kit` block.
 *  - `prepararImportacaoKitShopee(deps, entrada): Promise<PreparoKitShopee>` —
 *    **write-free**: the component resolution table PLUS the ordered plan, so
 *    the CLI's dry run prints exactly what a live run would write. It THROWS the
 *    same refusals a live run would, exactly like the listing importer's own
 *    write-free half.
 *  - `resolverComponentesDoKit(db, integracaoId, kit)` — write-free and it never
 *    throws, so a dry run can print the table of a kit that is REFUSED. This is
 *    what the CLI prints for a blocked kit.
 *  - `anuncioDerivadoDoKit(entrada)` — the kit page read as a listing (below).
 *
 * ## ⚠️ The kit page is a DIFFERENT page, and every difference is silent
 *
 * `get_kit_item_info.response.product_info` spells four containers differently
 * from `get_item_base_info` — `attributes` (not `attribute_list`), `brand_info`
 * (not `brand`), `pre_order_info` (not `pre_order`), `tier_variation_list` (not
 * `tier_variation`) — declares `category_id` as an int64 ARRAY while its own
 * sample sends a SCALAR, says `images` in the table and `image` in the sample,
 * and types a tier option's `image` as an ARRAY where the item page types an
 * object. Reading one spelling only costs a field with no error anywhere.
 *
 * {@link anuncioDerivadoDoKit} resolves all of that ONCE, into a record shaped
 * like a listing, **built through the package's own row schema** so the shape is
 * never this module's invention. Everything downstream — the cascade, the pure
 * mapper, the taxonomy, the categoria chain, the links, the photos, the writer —
 * is the SAME code the ordinary listing import runs. A kit is not a second
 * import; it is one translation plus three extra decisions (the composition, the
 * kit flags, and the refusal to stock any of it).
 *
 * ⚠️ The derived record KEEPS `tag.kit`. It is a kit and says so: the routing
 * guard in `importarAnuncio.ts` must stay effective if this record ever escapes
 * this module, which is why the plan is built here from the shared PURE planner
 * (which has no routing guard, and should not) rather than by handing the record
 * back to the listing importer.
 *
 * ## ⚠️ Components are RESOLVED, never created
 *
 * Every `model_list[].component_list[]` row goes through the order path's
 * `resolverProdutoDaLinhaShopee`. This is the one place where the family hop is
 * CORRECT: what a kit consumes is the SELLABLE UNIT, which is exactly what that
 * cascade answers — while the LISTING direction must bind the parent, which is
 * why the import cascade of `resolveProduto.ts` exists separately. Nothing is
 * ever created for a component, and the verdict is READ and never persisted (its
 * miss kinds are an order incidente's vocabulary, not this import's).
 *
 * If ANY component of ANY model does not resolve, the kit is refused with
 * `kit-componente-nao-vinculado` **before any write**, and the job contains it
 * as one failure row.
 *
 * ## ⚠️ The chicken-and-egg, which is K1's real cost
 *
 * On a FIRST catalogue import the components are imported by the SAME run, so a
 * kit whose components have not been reached yet refuses. That is why the job
 * drains `filaKits` LAST, after every ordinary listing of the page, and why a
 * fresh catalogue still needs a SECOND full run before its kits bind. A wall of
 * `kit-componente-nao-vinculado` on pass one is the design working, not a bug.
 *
 * ## ⚠️ A kit NEVER gets an estoque row
 *
 * Not on the parent, not on a child, whatever `importarEstoque` says. There is
 * no stock field anywhere on the kit page — not on the read, not on either write
 * op — and the derivation rule is undocumented, so a kit's availability is
 * DERIVED from its components (`componentesKit` + the kit stock pure logic) and
 * a stored row would be a second, stale answer competing with it. The plan is
 * stripped of both estoque legs structurally, not left to the absence of a
 * field: the payload cannot carry stock today, and a tolerant read that started
 * accepting one tomorrow must not silently start stocking kits.
 *
 * ## ⚠️ `ehKit` is TRUE on the PARENT (C7)
 *
 * A one-model kit is parent + ONE child (a família de um), and both carry
 * `ehKit: true` and the SAME `componentesKit` — the mirror. A 2..9-model kit has
 * `componentesKit: null` on the parent and each child's own map on the child.
 * The reason is the shipped order resolver: it refuses to hop a KIT to its sole
 * member (`raiz.ehKit ? raiz.produtoId : …`), so a parent flagged `false` would
 * bind every line of the listing to the member instead of to the document that
 * owns the composition an operator edits. An empty composition is harmless on
 * the read side (the kit stock helper answers `null`, which the caller adds as
 * `0`), so the flag costs nothing where it is not yet filled.
 *
 * Next-free, clock-free: `nowMs` arrives on the deps, read ONCE per dispatch.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  type ShopeeKitItem,
  type ShopeeKitModel,
  type ShopeePriceInfo,
} from '@delfrance/integrations-shopee';

import {
  resolverProdutoDaLinhaShopee,
  type ResolvedShopeeLineProduto,
} from '../pedidos/produtoResolve';
import { caminhoDaCategoriaDoAnuncio } from './categoriaShopee';
import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from './errosImportacao';
import { idsDeImagemJaImportados } from './fotosShopee';
import { aplicarImportacaoShopee } from './importarAnuncio';
import type {
  GrupoMemo,
  ImportarAnuncioDeps,
  ImportarKitShopeeFn,
  ItemLido,
  PrepararImportacaoShopeeDeps,
  ResultadoImportacaoShopee,
} from './itemLido';
import {
  planejarImportacaoShopee,
  type EscritaDeProduto,
  type PlanoFilhoShopee,
  type PlanoImportacaoShopee,
  type PreparoFilhoShopee,
  type PreparoImportacaoShopee,
} from './planoImportacao';
import {
  idDoPaiPlanejado,
  resolverFilhosDaListagem,
  resolverPaiDaListagem,
} from './resolveProduto';
import { criarMemoDeGrupos } from './taxonomiaShopee';
import { planejarTaxonomia, tiersDoItem } from './taxonomiaShopeeCore';

/** The currency a kit's money is in — see {@link precoDoModeloDeKit}. */
const MOEDA_DO_KIT = 'BRL';

/** `quantity` floor. `kitSchema.quantidade` is `int().min(1)`. */
const QUANTIDADE_MINIMA = 1;

/* -------------------------------------------------------------------------- */
/*  The component table                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One `component_list[]` row, resolved.
 *
 * ⚠️ `via` is the cascade's own verdict, carried for the CLI's table and the log
 * line and **persisted nowhere**: those slugs pick an order incidente's subtipo,
 * and an import that stored them would make one vocabulary answer two questions.
 */
export interface ComponenteDoKitShopee {
  /** The kit MODEL this component composes. */
  readonly modelId: number;
  /** `component_item_id`. */
  readonly itemId: number;
  /** `component_model_id`, `0` when the component is not a variation. */
  readonly modelIdDoComponente: number;
  /** `component_item_or_model_sku`, verbatim. */
  readonly sku: string | null;
  /** `quantity`, floored at {@link QUANTIDADE_MINIMA}. */
  readonly quantidade: number;
  /** The ERP produto the component bound to; `null` ⇒ the kit is refused. */
  readonly produtoId: string | null;
  readonly via: ResolvedShopeeLineProduto['via'];
}

/** What {@link prepararImportacaoKitShopee} read and decided, before any write. */
export interface PreparoKitShopee {
  /** The ordered write plan, kit fields already folded in. */
  readonly plano: PlanoImportacaoShopee;
  /** Every component of every model, in payload order. */
  readonly componentes: readonly ComponenteDoKitShopee[];
  /** The kit page read as a listing — what the mapper actually saw. */
  readonly anuncio: ItemLido;
  /** Distinct component PRODUTOS across every model — the result's `componentes`. */
  readonly produtosComponentes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*  1. The kit page, read as a listing                                         */
/* -------------------------------------------------------------------------- */

/**
 * `category_id`: declared an int64 ARRAY, sampled as a SCALAR.
 *
 * Both parse; the FIRST element of an array is taken, because the ERP's
 * `categoriaProdutoOuterRef` is one leaf and Shopee's own item page carries a
 * single int32 for the same concept. An empty array is no category at all.
 */
function categoriaDoKit(valor: number | readonly number[] | null | undefined): number | null {
  if (Array.isArray(valor)) return valor.length > 0 ? (valor[0] as number) : null;
  return typeof valor === 'number' ? valor : null;
}

/**
 * The kit's BRL price, as a `price_info[]` the shared reader understands.
 *
 * ⚠️ `model_list[].original_price` is the kit page's ONLY money field and it
 * carries **no currency**. It is read as BRL because the kit feature itself is
 * Brazil-only — `announcement 1310` restricts kits to whitelisted local BR SIP
 * sellers — so a kit that exists at all belongs to a BRL shop. That assumption
 * is named here rather than hidden in a mapper.
 *
 * ⚠️ …and a DECLARED currency always beats an assumed one: the kit model schema
 * is `.passthrough()`, so if Shopee ever sends the item page's own `price_info`
 * here it survives the parse and WINS. That is also what makes "a non-BRL price
 * writes nothing" expressible at all on this page — the shared
 * `precoBrlDe`/`planejarPreco` pair then answers `moeda-nao-brl` and the child
 * gets no price, instead of a foreign number landing on the normal table.
 *
 * ⚠️ The NORMAL table and only it. The Shopee legacy also wrote a lower current
 * price to the conta's promotional table; Mercado Livre refused exactly that
 * (#803) because the promotional tabela belongs to promotions the operator
 * authors in the ERP, and step 9 takes the same stance for every channel — the
 * kit included, which is why nothing here ever looks at that ref.
 */
function precoDoModeloDeKit(modelo: ShopeeKitModel): readonly ShopeePriceInfo[] | null {
  const declarado = (modelo as { price_info?: unknown }).price_info;
  if (Array.isArray(declarado)) return declarado as readonly ShopeePriceInfo[];
  const preco = modelo.original_price;
  if (typeof preco !== 'number' || !Number.isFinite(preco)) return null;
  return [{ currency: MOEDA_DO_KIT, original_price: preco } as ShopeePriceInfo];
}

/**
 * One kit model → one `get_model_list`-shaped model.
 *
 * ⚠️ No `stock_info_v2`, ever — there is none on this page, and inventing one is
 * the single thing the kit read explicitly forbids.
 */
function modeloDerivadoDoKit(modelo: ShopeeKitModel): Record<string, unknown> {
  return {
    model_id: modelo.model_id,
    // Verbatim. A one-model kit is a família de um whose member's sku is the
    // seller's own `model_sku`, never a suffix derived from the parent's: the
    // suffix helper of the schemas package exists for a Mercado Livre sole
    // member that carries no sku at all, and applying it here would rename the
    // seller's model sku on the next publish.
    model_sku: modelo.model_sku,
    tier_index: [...(modelo.tier_index ?? [])],
    price_info: precoDoModeloDeKit(modelo),
  };
}

/**
 * The kit page, read as a LISTING — one translation, once, so that every module
 * downstream reads the spellings it already knows.
 *
 * ⚠️ A tier option's `image` is DROPPED rather than coerced: the kit page types
 * it as an ARRAY where the item page types an object, and nothing in step 9
 * reads a per-option image (they are a recorded gap, Mercado Livre parity). A
 * coercion would invent a shape; passing the array through would fail the parse
 * of the WHOLE kit for a field nobody reads.
 *
 * ⚠️ `item_id` comes from the record's own `itemId` — the id that was ASKED for
 * and the key everything reconciles by — never from the payload's echo.
 */
export function anuncioDerivadoDoKit(entrada: ItemLido, kit: ShopeeKitItem): ItemLido {
  const modelos = kit.model_list;
  const base = shopeeItemBaseInfoRowSchema.parse({
    item_id: entrada.itemId,
    item_name: kit.item_name,
    item_sku: kit.item_sku,
    category_id: categoriaDoKit(kit.category_id),
    // The read's own status, whichever page carried it. An unknown value folds
    // to `null` on the link document; it never fails an item.
    item_status: kit.item_status ?? entrada.base.item_status ?? null,
    description: kit.description,
    description_type: kit.description_type,
    description_info: kit.description_info,
    // The four renames, each one a silent `null` if copied across.
    attribute_list: kit.attributes,
    brand: kit.brand_info,
    pre_order: kit.pre_order_info,
    weight: kit.weight,
    dimension: kit.dimension,
    logistic_info: kit.logistic_info,
    // The table spelling first, then the sample's. Neither is invented.
    image: kit.images ?? kit.image ?? null,
    has_model: modelos.length > 0,
    // ⚠️ KEPT: this record is a kit and says so, so the listing importer's
    // routing refusal still fires if it ever reaches it.
    tag: entrada.base.tag ?? { kit: true },
  });

  const models =
    modelos.length > 0
      ? shopeeModelListPayloadSchema.parse({
          model: modelos.map(modeloDerivadoDoKit),
          tier_variation: (kit.tier_variation_list ?? []).map((tier) => ({
            name: tier.name,
            option_list: (tier.option_list ?? []).map((opcao) => ({
              option: opcao.option,
              image: null,
            })),
          })),
        })
      : null;

  return { base, models, taxInfo: entrada.taxInfo, kit, itemId: entrada.itemId };
}

/* -------------------------------------------------------------------------- */
/*  2. The components                                                          */
/* -------------------------------------------------------------------------- */

function quantidadeDoComponente(bruta: number | null | undefined): number {
  // A component that is PRESENT is at least one unit. `kitSchema.quantidade` is
  // `int().min(1)`, so a missing, zero or fractional count would throw at parse
  // time with a Zod path instead of writing a composition an operator can read.
  if (typeof bruta !== 'number' || !Number.isFinite(bruta)) return QUANTIDADE_MINIMA;
  return Math.max(QUANTIDADE_MINIMA, Math.trunc(bruta));
}

/**
 * Resolve every component of every model. **Reads only, and never throws** — a
 * dry run has to be able to PRINT the table of a kit that will be refused.
 *
 * ⚠️ `resolverProdutoDaLinhaShopee`, the ORDER path's cascade, deliberately: a
 * component is consumed as a SELLABLE UNIT, so the família-de-um hop that would
 * be wrong for the listing itself is exactly right here. Its diagnostics log
 * order-shaped warnings; that is the price of having one tested cascade instead
 * of two.
 */
export async function resolverComponentesDoKit(
  db: Firestore,
  integracaoId: string,
  kit: ShopeeKitItem,
): Promise<readonly ComponenteDoKitShopee[]> {
  const saida: ComponenteDoKitShopee[] = [];
  for (const modelo of kit.model_list) {
    for (const componente of modelo.component_list) {
      const modelIdDoComponente = componente.component_model_id ?? 0;
      const veredicto = await resolverProdutoDaLinhaShopee(db, {
        integracaoId,
        itemId: componente.component_item_id,
        // `0`/absent skips the variation rung, as it must: `0` is Shopee's "no
        // variation" sentinel and a link written for it binds anything.
        modelId: modelIdDoComponente,
        sku: componente.component_item_or_model_sku ?? null,
      });
      saida.push({
        modelId: modelo.model_id,
        itemId: componente.component_item_id,
        modelIdDoComponente,
        sku: componente.component_item_or_model_sku ?? null,
        quantidade: quantidadeDoComponente(componente.quantity),
        produtoId: veredicto.produtoId,
        via: veredicto.via,
      });
    }
  }
  return saida;
}

/** The kit page, or the refusal. */
function exigirDetalheDoKit(entrada: ItemLido): ShopeeKitItem {
  if (entrada.kit !== null) return entrada.kit;
  throw new ShopeeImportBlockedError(
    MOTIVO_IMPORT_BLOQUEADO.kitSemDetalhe,
    entrada.itemId,
    'get_kit_item_info não trouxe product_info',
  );
}

/**
 * Every component must already exist in the ERP, or the whole kit is refused.
 *
 * ⚠️ ALL components are resolved before this runs, so the table the CLI prints
 * is complete even when the kit is refused; the message names the FIRST miss,
 * which is the one an operator binds by hand first.
 */
function exigirComponentesVinculados(
  componentes: readonly ComponenteDoKitShopee[],
  itemId: number,
): void {
  const semVinculo = componentes.find((c) => c.produtoId === null);
  if (semVinculo === undefined) return;
  throw new ShopeeImportBlockedError(
    MOTIVO_IMPORT_BLOQUEADO.kitComponenteNaoVinculado,
    itemId,
    `modelo ${String(semVinculo.modelId)}, componente item ${String(semVinculo.itemId)}/` +
      `modelo ${String(semVinculo.modelIdDoComponente)}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  3. The composition                                                         */
/* -------------------------------------------------------------------------- */

/** One `componentesKit` map plus the key array that must agree with it. */
interface ComposicaoDoKit {
  /**
   * ⚠️ `timestamp` is `number | null` because `kitSchema` declares it nullable
   * and the web kit editor writes `null` for a fresh entry — a stored `null`
   * that is carried forward stays `null` rather than being re-stamped.
   */
  readonly mapa: Record<
    string,
    { quantidade: number; limitarEstoque: boolean; timestamp: number | null }
  >;
  readonly chaves: readonly string[];
}

/**
 * The `componentesKit` of ONE kit model, keyed by the COMPONENT produto's doc id.
 *
 * ⚠️ Two component rows that resolve to the SAME produto are **SUMMED**, never
 * overwritten: a kit of "2 × parafuso + 3 × parafuso" holds five, and a map
 * keyed by produto id cannot hold the two rows separately. Overwriting would
 * silently under-count the composition — and the kit's derived availability with
 * it — in the one shape the map cannot represent literally.
 *
 * `limitarEstoque` is `true` for every entry: a component the kit consumes
 * constrains what the kit can sell, which is the whole point of deriving a kit's
 * availability instead of stocking it.
 *
 * ⚠️ The STAMP of an unchanged entry is carried FORWARD from what is stored, and
 * `nowMs` is written only where the composition actually moved. A stamp records
 * when an entry was EDITED; it is not part of what the kit is — the schemas
 * package's own kit comparator leaves it outside the fold for that reason, and
 * `componentesKit` is deliberately NOT in `PRODUTO_HISTORY_IGNORE_FIELDS`, so a
 * re-stamp on every pass would file one unattributed `historicoDeModificacoes`
 * row per kit produto per import for a composition nobody touched. The kit
 * arm re-imports by design (a fresh catalogue refuses most kits on pass one).
 */
function composicaoDoModelo(
  componentes: readonly ComponenteDoKitShopee[],
  nowMs: number,
  armazenada: Record<string, unknown> | null,
): ComposicaoDoKit {
  const mapa: ComposicaoDoKit['mapa'] = {};
  for (const componente of componentes) {
    const produtoId = componente.produtoId;
    if (produtoId === null) continue;
    const anterior = mapa[produtoId]?.quantidade ?? 0;
    mapa[produtoId] = {
      quantidade: anterior + componente.quantidade,
      limitarEstoque: true,
      timestamp: nowMs,
    };
  }
  for (const [produtoId, entrada] of Object.entries(mapa)) {
    const guardado = carimboArmazenadoDoComponente(armazenada, produtoId, entrada.quantidade);
    if (guardado !== null) mapa[produtoId] = { ...entrada, timestamp: guardado.carimbo };
  }
  return { mapa, chaves: Object.keys(mapa) };
}

/**
 * The stored stamp of ONE component entry, when that entry is unchanged.
 *
 * ⚠️ Compared FIELD BY FIELD and never through a shared equality helper: the
 * fold this makes is tiny and local (`quantidade` and `limitarEstoque` decide,
 * `timestamp` deliberately does not), and routing it through a general one would
 * both widen it and pull `produtos/` into an inventory it has no entry in.
 *
 * ⚠️ A stored `timestamp` of `null` is a legal value the web kit editor writes
 * for a fresh entry, which is why the answer is wrapped rather than returned
 * bare — `null` as "no stamp to keep" and `{ carimbo: null }` as "keep the null"
 * are different answers.
 */
function carimboArmazenadoDoComponente(
  armazenada: Record<string, unknown> | null,
  produtoId: string,
  quantidade: number,
): { readonly carimbo: number | null } | null {
  if (armazenada === null) return null;
  const bruto = armazenada[produtoId];
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const entrada = bruto as Record<string, unknown>;
  if (entrada.quantidade !== quantidade) return null;
  if (entrada.limitarEstoque !== true) return null;
  const carimbo = entrada.timestamp;
  if (carimbo === null) return { carimbo: null };
  if (typeof carimbo !== 'number' || !Number.isFinite(carimbo)) return null;
  return { carimbo };
}

/** Distinct component PRODUTOS across every model, in first-seen order. */
function produtosDosComponentes(componentes: readonly ComponenteDoKitShopee[]): readonly string[] {
  const vistos: string[] = [];
  for (const componente of componentes) {
    const produtoId = componente.produtoId;
    if (produtoId !== null && !vistos.includes(produtoId)) vistos.push(produtoId);
  }
  return vistos;
}

/* -------------------------------------------------------------------------- */
/*  4. The plan, with the kit's three extra decisions folded in                */
/* -------------------------------------------------------------------------- */

/** The three kit fields, as a patch fragment. `null` clears a stale mirror. */
function camposDeKit(composicao: ComposicaoDoKit | null): Record<string, unknown> {
  return {
    ehKit: true,
    componentesKit: composicao === null ? null : composicao.mapa,
    componentesKitKeys: composicao === null ? null : [...composicao.chaves],
  };
}

/**
 * Are the three kit fields already exactly what this document holds?
 *
 * ⚠️ Field by field, for the reason spelled out at
 * {@link carimboArmazenadoDoComponente}. It treats two compositions as the same
 * only when the SAME component ids carry the SAME `quantidade`, the same
 * `limitarEstoque` and the same `timestamp` — the stamp included HERE, because
 * by the time this runs the stamp of an unchanged entry has already been carried
 * forward, so a difference in it means the composition really moved.
 */
function camposDeKitJaArmazenados(
  armazenado: Record<string, unknown>,
  composicao: ComposicaoDoKit | null,
): boolean {
  if (armazenado.ehKit !== true) return false;

  const chavesGuardadas = armazenado.componentesKitKeys;
  const chaves = composicao === null ? null : composicao.chaves;
  if (chaves === null) {
    if (chavesGuardadas !== null) return false;
  } else {
    if (!Array.isArray(chavesGuardadas)) return false;
    if (chavesGuardadas.length !== chaves.length) return false;
    if (chavesGuardadas.some((chave, i) => chave !== chaves[i])) return false;
  }

  const mapaGuardado = armazenado.componentesKit;
  if (composicao === null) return mapaGuardado === null;
  if (typeof mapaGuardado !== 'object' || mapaGuardado === null || Array.isArray(mapaGuardado)) {
    return false;
  }
  const guardado = mapaGuardado as Record<string, unknown>;
  if (Object.keys(guardado).length !== composicao.chaves.length) return false;
  for (const [produtoId, entrada] of Object.entries(composicao.mapa)) {
    const bruto = guardado[produtoId];
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return false;
    const linha = bruto as Record<string, unknown>;
    if (linha.quantidade !== entrada.quantidade) return false;
    if (linha.limitarEstoque !== entrada.limitarEstoque) return false;
    if (linha.timestamp !== entrada.timestamp) return false;
  }
  return true;
}

/**
 * Fold the kit fields into an existing produto write, MINT one, or plan none.
 *
 * ⚠️ The mint matters: on a re-import the shared mapper plans no produto write
 * at all for an unchanged document, and a composition that is NOT yet stored
 * still has to land. The minted patch carries `ultimaModificacao` — the same key
 * the mapper's own update patch always carries — plus the three kit fields, and
 * nothing else.
 *
 * ⚠️ And the NON-mint matters just as much: when the mapper planned nothing AND
 * the document already holds exactly these three fields, this answers `null`. A
 * byte-identical kit re-import must write no produto at all, exactly like a
 * byte-identical listing re-import — otherwise every pass files an unattributed
 * `historicoDeModificacoes` row on the parent and on every child.
 */
function comCamposDeKitNoProduto(
  escrita: EscritaDeProduto | null,
  produtoId: string,
  composicao: ComposicaoDoKit | null,
  nowMs: number,
  armazenado: Record<string, unknown> | null,
): EscritaDeProduto | null {
  if (escrita === null) {
    if (armazenado !== null && camposDeKitJaArmazenados(armazenado, composicao)) return null;
    return {
      produtoId,
      criar: false,
      data: { ultimaModificacao: nowMs, ...camposDeKit(composicao) },
    };
  }
  return { ...escrita, data: { ...escrita.data, ...camposDeKit(composicao) } };
}

/** The `componentesKit` map a produto document already holds, or `null`. */
function mapaDeComponentesArmazenado(
  raw: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const bruto = raw?.componentesKit;
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  return bruto as Record<string, unknown>;
}

/** What {@link comCamposDeKit} has to READ from the documents already stored. */
export interface ArmazenadosDoKit {
  /** The parent produto as read, or `null` when the cascade resolved none. */
  readonly pai: Record<string, unknown> | null;
  /** Index-aligned with `plano.filhos`, i.e. with `get_model_list` order. */
  readonly filhos: readonly (Record<string, unknown> | null)[];
}

/**
 * The listing plan → the KIT plan: `ehKit` everywhere, the composition on the
 * documents that own it, and no estoque anywhere.
 *
 * ⚠️ EXPORTED for one test, and the export is the point: `estoquePai: null` and
 * the per-child `estoque: null` here are the BELT of a belt-and-braces pair
 * whose braces are {@link anuncioDerivadoDoKit} never emitting a
 * `stock_info_v2`. Neither half alone is observable end to end — the derived
 * listing carries no stock, so the shared planner plans none, so removing either
 * override changes nothing a whole-import test can see. Each half is therefore
 * pinned directly, or it is pinned by nothing.
 *
 * ⚠️ The 1-model MIRROR (C7). A one-model kit is a família de um, and the order
 * resolver binds the PARENT for a kit — so the parent has to hold the same
 * composition the child does, exactly like the sole-member mirror the schemas
 * package builds for a family of one. With 2..9 models the parent carries
 * `componentesKit: null`, because there is no single composition to mirror and a
 * merged one would be a fourth answer nobody wrote.
 */
export function comCamposDeKit(
  plano: PlanoImportacaoShopee,
  componentes: readonly ComponenteDoKitShopee[],
  nowMs: number,
  armazenados: ArmazenadosDoKit,
): PlanoImportacaoShopee {
  const porModelo = new Map<number, ComposicaoDoKit>();
  for (const [i, filho] of plano.filhos.entries()) {
    porModelo.set(
      filho.modelId,
      composicaoDoModelo(
        componentes.filter((c) => c.modelId === filho.modelId),
        nowMs,
        mapaDeComponentesArmazenado(armazenados.filhos[i] ?? null),
      ),
    );
  }

  const umModeloSo = plano.filhos.length === 1 ? plano.filhos[0] : undefined;
  const espelho = umModeloSo !== undefined ? (porModelo.get(umModeloSo.modelId) ?? null) : null;

  const filhos: PlanoFilhoShopee[] = plano.filhos.map((filho, i) => ({
    ...filho,
    produto: comCamposDeKitNoProduto(
      filho.produto,
      // ⚠️ The id the WRITER will use — index-aligned with `filhos` by
      // construction — never `filho.produto?.produtoId`, which is absent on a
      // byte-identical re-import.
      plano.filhoUnico.idsPlanejados[i] ?? filho.produto?.produtoId ?? plano.produtoId,
      porModelo.get(filho.modelId) ?? null,
      nowMs,
      armazenados.filhos[i] ?? null,
    ),
    // A kit child is assembled, never stocked. Structural, not incidental.
    estoque: null,
  }));

  return {
    ...plano,
    produtoPai: comCamposDeKitNoProduto(
      plano.produtoPai,
      plano.produtoId,
      espelho,
      nowMs,
      armazenados.pai,
    ),
    estoquePai: null,
    filhos,
  };
}

/* -------------------------------------------------------------------------- */
/*  5. The write-free half                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything the kit's plan needs, READ.
 *
 * The listing importer's own reader is not reused because it REFUSES a kit
 * before its first read — that guard is about routing, and this module is where
 * the routing ended. What IS reused is every decision below it: the cascade, the
 * taxonomy pre-pass, the categoria chain and the photo cache, all called exactly
 * as the listing reader calls them.
 *
 * ⚠️ No estoque row is read, for either the parent or a child: a kit writes
 * none, and a read whose only possible use is a write that never happens is a
 * scanned-data bill with nothing to show for it.
 */
async function lerPreparoDoKit(
  deps: PrepararImportacaoShopeeDeps,
  anuncio: ItemLido,
): Promise<PreparoImportacaoShopee> {
  const db = deps.db;

  const pai = await resolverPaiDaListagem(db, deps.integracaoId, anuncio);
  const paiId = pai.existente?.id ?? idDoPaiPlanejado(deps.integracaoId, anuncio.itemId);

  const temModelos = anuncio.models !== null;
  const grupos: GrupoMemo = temModelos
    ? await (deps.grupos ?? criarMemoDeGrupos(db)).carregar()
    : { docs: [] };

  const categorias = await caminhoDaCategoriaDoAnuncio(deps.categorias, anuncio.base.category_id);

  const modelos = anuncio.models?.model ?? [];
  const tiers = temModelos
    ? tiersDoItem({ tiers: anuncio.models?.tier_variation ?? [], padronizados: [] })
    : [];
  // The same deliberate double planning the listing reader documents: the pure
  // planner is deterministic, so asking it twice cannot answer twice — and the
  // combination rung needs a combination to compare before the plan exists.
  const combos =
    tiers.length > 0
      ? planejarTaxonomia({
          tiers,
          modelos,
          candidatos: grupos.docs,
          integracaoId: deps.integracaoId,
          categoryId: anuncio.base.category_id ?? 0,
          nomeCategoria: '',
          nowMs: deps.nowMs,
        }).combos
      : [];

  const resolucoes = await resolverFilhosDaListagem(
    db,
    deps.integracaoId,
    paiId,
    pai.existente !== null,
    modelos,
    combos.map((c) => ({ variacoesUid: c.variacoesUid })),
  );

  const filhos: PreparoFilhoShopee[] = resolucoes.map((resolucao) => ({
    modelo: resolucao.modelo,
    existente: resolucao.existente,
    vinculoDeOutraFamilia: resolucao.vinculoDeOutraFamilia,
    link: resolucao.link,
    estoque: null,
  }));

  return {
    entrada: anuncio,
    integracaoId: deps.integracaoId,
    nowMs: deps.nowMs,
    options: deps.options,
    tabelaNormalOuterRef: deps.tabelaNormalOuterRef,
    tabelaPromocionalOuterRef: deps.tabelaPromocionalOuterRef,
    depositoOuterRef: deps.depositoOuterRef,
    pai: {
      existente: pai.existente,
      extraData: pai.extraData,
      linkSobFilho: pai.linkSobFilho,
      jaTemFilhos: pai.jaTemFilhos,
      estoque: null,
    },
    filhos,
    linkPai: pai.link,
    grupos,
    categorias,
    imagensJaCacheadas:
      deps.options.importarFotos && pai.existente !== null
        ? await idsDeImagemJaImportados(db, paiId, deps.integracaoId)
        : [],
  };
}

/**
 * Everything one kit import will do, decided and READ — and nothing written.
 *
 * ⚠️ The components are resolved FIRST, before the listing cascade: a kit whose
 * components are not in the ERP yet is the common case on a first catalogue
 * pass, and refusing it there costs the fewest reads.
 */
export async function prepararImportacaoKitShopee(
  deps: PrepararImportacaoShopeeDeps,
  entrada: ItemLido,
): Promise<PreparoKitShopee> {
  const kit = exigirDetalheDoKit(entrada);
  const componentes = await resolverComponentesDoKit(deps.db, deps.integracaoId, kit);
  exigirComponentesVinculados(componentes, entrada.itemId);

  const anuncio = anuncioDerivadoDoKit(entrada, kit);
  const lido = await lerPreparoDoKit(deps, anuncio);
  const plano = comCamposDeKit(planejarImportacaoShopee(lido), componentes, deps.nowMs, {
    pai: lido.pai.existente?.raw ?? null,
    filhos: lido.filhos.map((filho) => filho.existente?.raw ?? null),
  });

  return { plano, componentes, anuncio, produtosComponentes: produtosDosComponentes(componentes) };
}

/* -------------------------------------------------------------------------- */
/*  6. The whole thing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * preparar → aplicar. The BOUND name the job injects and the route dispatches to.
 *
 * ⚠️ The writer is the LISTING importer's writer, unchanged: same order (the
 * taxonomy first, the guarded price patch before the produto merge, the parent
 * link before the children, `filhoUnicoId` after the child set is final, photos
 * last and retriable), same never-overwrite creates, same counters.
 *
 * ⚠️ No bounded re-plan on a lost race, unlike the listing importer. A kit that
 * loses the grupo or the price precondition is refused for THIS pass and the job
 * contains it; the next pass re-plans against what the winner wrote. The
 * alternative was a second copy of the "did somebody else write first?"
 * predicate, and two copies of that decision would drift toward plausible while
 * both read correct — for a listing shape whose tier tree is a single tier and
 * whose races are correspondingly rare.
 */
export const importarKitShopee: ImportarKitShopeeFn = async (
  deps: ImportarAnuncioDeps,
  entrada: ItemLido,
): Promise<ResultadoImportacaoShopee> => {
  const preparo = await prepararImportacaoKitShopee(deps, entrada);
  const resultado = await aplicarImportacaoShopee(deps, preparo.plano);
  return {
    ...resultado,
    kit: {
      componentes: preparo.produtosComponentes.length,
      // The kit produto IS the parent, so the two cannot disagree — a separate
      // boolean here would only ever be a second way to say the same thing.
      criado: resultado.criado,
    },
  };
};
