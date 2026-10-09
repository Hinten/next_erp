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
 *  - `resolverComponentesDoKit(db, integracaoId, kit, temModelos)` — write-free
 *    and it never throws, so a dry run can print the table of a kit that is
 *    REFUSED. This is what the CLI prints for a blocked kit.
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
 * ⚠️ The derived record PINS `tag.kit: true`. It is a kit and says so: the
 * routing guard in `importarAnuncio.ts` must stay effective if this record ever
 * escapes this module, which is why the plan is built here from the shared PURE
 * planner (which has no routing guard, and should not) rather than by handing
 * the record back to the listing importer. The same pin is what makes the
 * shared link builder (`dadosLinkListagem`) stamp `kitNativo: true` on the
 * listing link — the flag steps 11, 12 and 13 refuse a native kit on.
 *
 * ## ⚠️ Components are RESOLVED, never created
 *
 * Every `model_list[].component_list[]` row goes through the order path's
 * `resolverProdutoDaLinhaShopee`. This is the one place where the family hop is
 * CORRECT: what a kit consumes is the SELLABLE UNIT — while the LISTING
 * direction must bind the parent, which is why the import cascade of
 * `resolveProduto.ts` exists separately. Nothing is ever created for a
 * component, and the verdict is READ and never persisted (its miss kinds are an
 * order incidente's vocabulary, not this import's).
 *
 * Two step-19 facts (#1527) shape what the cascade is ASKED and what its answer
 * MEANS — see {@link resolverComponentesDoKit}: a plain component's
 * `component_model_id` is Shopee's HIDDEN default model id (folded to `0` by the
 * schemas' `modeloDoComponenteKit` when the component item's `has_model` is
 * `false`), and the cascade's LISTING rung answers the link's OWNER with no hop,
 * so a `prodshopee` hit is hopped to its sellable unit here
 * (`unidadeVendavelDaRaiz`, the SKU rungs' own rule).
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
 * op — and Shopee DERIVES it (measured on the SG sandbox, step 19 probe #1:
 * min ⌊component stock / quantity⌋, readable only through the kit's own
 * `get_model_list`; `update_stock` on a kit is refused), so a kit's availability is
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
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  NOME_TIER_KIT_UNICO,
  OPCAO_TIER_KIT_UNICO,
  chaveReceitaKitErp,
  componentesKitDaReceitaShopee,
  ehKitNativoAtivo,
  mesmoEnderecoDeComponente,
  modeloDoComponenteKit,
  toOuterRef,
  toOuterRefOrNull,
  type EnderecoShopeeDoComponente,
} from '@delfrance/schemas';
import {
  produtoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import { unidadeVendavelDaRaiz } from '@delfrance/data/admin/produtos';

import { agoraUsDe } from '../avisos/autorizacao';
import { idDoRef } from '../core/vinculosShopee';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from '../kits/idsKit';
import {
  resolverProdutoDaLinhaShopee,
  type ResolvedShopeeLineProduto,
} from '../pedidos/produtoResolve';
import { caminhoDaCategoriaDoAnuncio } from './categoriaShopee';
import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from './errosImportacao';
import { idsDeImagemJaImportados } from './fotosShopee';
import { aplicarImportacaoShopee } from './importarAnuncio';
import type {
  AvisoImportacaoKit,
  GrupoMemo,
  ImportarKitShopeeDeps,
  ImportarKitShopeeFn,
  ItemLido,
  PrepararImportacaoShopeeDeps,
  ResultadoImportacaoShopee,
} from './itemLido';
import { caminhoDoLinkDaListagem } from './mapeamento';
import {
  planejarImportacaoShopee,
  type DocumentoLido,
  type EscritaDeLink,
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
  type ResolucaoFilhoShopee,
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
  /**
   * The model id the cascade was ASKED for: the wire `component_model_id`
   * folded by the schemas' `modeloDoComponenteKit` with the component item's
   * `has_model`, then `?? 0`.
   *
   * - `has_model === false` ⇒ `0`: a plain component's wire id is Shopee's
   *   HIDDEN default model id (non-zero, not the `item_id`, absent from that
   *   item's own `get_model_list` — measured, step 19 probe #1), never a
   *   variation, so the line binds on the listing rung.
   * - `has_model === true` ⇒ the wire id when it is a positive int, else `0`.
   * - unknown (no base-info row) ⇒ the wire id VERBATIM (`null` ⇒ `0`) — the
   *   pre-step-19 path, never a guess.
   */
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
  readonly plano: PlanoKitShopee;
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
    // ⚠️ PINNED to `kit: true`, never copied: this record is a kit and says
    // so, so the listing importer's routing refusal still fires if it ever
    // reaches it, AND the shared link builder stamps `kitNativo: true` from
    // it. A copied `tag` would make that stamp depend on every caller building
    // its base row with `kit: true` — the job's kit drain and `lerAnuncio` both
    // do today, but a caller that did not would write `kitNativo: false` on a
    // native kit, and steps 12 and 13 would then sync a quantity and a price
    // Shopee derives from the components.
    tag: { ...(entrada.base.tag ?? {}), kit: true },
  });

  const models =
    modelos.length > 0
      ? shopeeModelListPayloadSchema.parse({
          model: modelos.map(modeloDerivadoDoKit),
          // ⚠️ The single-model SENTINEL tier is read as NO tier (R-8, below).
          tier_variation: ehTierDeKitUnico(kit)
            ? []
            : (kit.tier_variation_list ?? []).map((tier) => ({
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

/**
 * Is this a ONE-model kit whose one tier is exactly the single-model sentinel
 * pair — tier `NOME_TIER_KIT_UNICO` (`'Kit'`), one option `OPCAO_TIER_KIT_UNICO`
 * (`'Padrão'`) — the tier step 19's create publishes for a família de um
 * (#1527, R-8; Lucas L10(1))?
 *
 * ⚠️ The fixed point of create → import. That tier is a SHAPE Shopee demands of
 * a kit model, not a variation the ERP owns: planned as a taxonomy it would mint
 * a `Kit` grupo and write `Padrão` into the member's variation fields on the
 * first re-import of every família-de-um kit. So the derived listing carries NO
 * tier for it, the planner plans zero grupo writes, and the member's own
 * variation fields stay as they are.
 *
 * Exact strings, no fold: `'kit'`, `'Padrao'`, a second option, a second model
 * or a second tier are a seller's real tier and are planned as one.
 */
export function ehTierDeKitUnico(kit: ShopeeKitItem): boolean {
  if (kit.model_list.length !== 1) return false;
  const tiers = kit.tier_variation_list ?? [];
  if (tiers.length !== 1) return false;
  const tier = tiers[0];
  if (tier === undefined || tier.name !== NOME_TIER_KIT_UNICO) return false;
  const opcoes = tier.option_list ?? [];
  return opcoes.length === 1 && opcoes[0]?.option === OPCAO_TIER_KIT_UNICO;
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
 * The SELLABLE UNIT a `prodshopee` hit stands for (step 19, #1527).
 *
 * The cascade's listing rung returns the link's OWNER with no hop
 * (`produtoResolve.ts`), and a plain listing's owner is a família-de-um
 * WRAPPER whose stock lives on its sole member (#1398). Keyed on the wrapper,
 * the kit's map would break #1450 (`kitUnidadeVendavel.ts`): its ERP
 * availability would score 0, a sale would move the wrapper's stock, and
 * nothing repairs it afterwards (the repoint fires only on a `filhoUnicoId`
 * move). So the owner is read ONCE and hopped by `unidadeVendavelDaRaiz` — the
 * SKU rungs' own rule, shared and never copied: a KIT stays on itself, a
 * wrapper answers its member, anything else answers itself.
 *
 * ⚠️ `paiId` IS projected (the rule's drift guard), because this read is by id,
 * not through a `paiId == null` query: an owner that is a child answers itself
 * whatever stale `filhoUnicoId` it carries. An owner that no longer exists keeps
 * the owner id, exactly as the cascade answered it.
 */
async function unidadeVendavelDoDono(db: Firestore, donoId: string): Promise<string> {
  const snap = await produtoCollection.docRef(db, {}, donoId).get();
  if (!snap.exists) return donoId;
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  return unidadeVendavelDaRaiz({
    ehKit: raw.ehKit === true,
    produtoId: donoId,
    familia: {
      id: donoId,
      paiId: raw.paiId as string | null | undefined,
      filhoUnicoId: raw.filhoUnicoId as string | null | undefined,
    },
  });
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
 *
 * ⚠️ `temModelos` (`component_item_id → has_model`, from
 * `lerTemModelosDosComponentes`) decides which model id the cascade is asked
 * for, through the schemas' ONE default-model rule `modeloDoComponenteKit`
 * (#1369 — the create and the republish fold with the same function):
 *  - `false` ⇒ `0`. A plain component carries Shopee's HIDDEN default model id —
 *    non-zero, not the `item_id`, absent from its own empty `get_model_list`
 *    (measured, step 19 probe #1). Asked literally it misses the variation
 *    rung, and the listing rung refuses to bind a line that names a model, so
 *    the component fell to the SKU rungs and, with no SKU, refused the kit.
 *    `0` skips the variation rung and binds on the listing link — then hopped
 *    to its sellable unit ({@link unidadeVendavelDoDono}).
 *  - `true` ⇒ the wire id (a real variation), bound on its `variashopee`.
 *  - absent ⇒ unknown ⇒ the wire id VERBATIM, today's path: never read as
 *    `false`, which would bind the listing on no evidence.
 * `0`/absent skips the variation rung, as it must: `0` is Shopee's "no
 * variation" sentinel and a link written for it binds anything.
 */
export async function resolverComponentesDoKit(
  db: Firestore,
  integracaoId: string,
  kit: ShopeeKitItem,
  temModelos: ReadonlyMap<number, boolean>,
): Promise<readonly ComponenteDoKitShopee[]> {
  const saida: ComponenteDoKitShopee[] = [];
  // One owner read per distinct `prodshopee` owner, whatever the number of
  // models that name it.
  const unidadesPorDono = new Map<string, string>();
  for (const modelo of kit.model_list) {
    for (const componente of modelo.component_list) {
      const itemId = componente.component_item_id;
      const modelIdDoComponente =
        modeloDoComponenteKit({
          modelId: componente.component_model_id,
          itemTemModelos: temModelos.get(itemId) ?? null,
        }) ?? 0;
      const veredicto = await resolverProdutoDaLinhaShopee(db, {
        integracaoId,
        itemId,
        modelId: modelIdDoComponente,
        sku: componente.component_item_or_model_sku ?? null,
      });
      let produtoId = veredicto.produtoId;
      if (produtoId !== null && veredicto.via === 'prodshopee') {
        let unidade = unidadesPorDono.get(produtoId);
        if (unidade === undefined) {
          unidade = await unidadeVendavelDoDono(db, produtoId);
          unidadesPorDono.set(produtoId, unidade);
        }
        produtoId = unidade;
      }
      saida.push({
        modelId: modelo.model_id,
        itemId,
        modelIdDoComponente,
        sku: componente.component_item_or_model_sku ?? null,
        quantidade: quantidadeDoComponente(componente.quantity),
        produtoId,
        // The RUNG's verdict, unchanged by the hop: `prodshopee` still names
        // the link that answered, and the produto is its sellable unit.
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
 * ⚠️ The SUM and the forced `limitarEstoque` are NOT done here: they are the
 * schemas' `componentesKitDaReceitaShopee` (`receitaKitShopee.ts`), the ONE
 * Shopee → ERP inverse the step-19 create, republish and recipe trigger read
 * too (#1369). What stays here is only what needs the stored document: the
 * stamp carry-forward below.
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
  const receita = componentesKitDaReceitaShopee(
    componentes.map((c) => ({ produtoId: c.produtoId, quantidade: c.quantidade })),
  );
  // `fromEntries`, never a bracket assignment: a component id is a document id
  // and must land as an OWN key whatever it spells.
  const mapa: ComposicaoDoKit['mapa'] = Object.fromEntries(
    receita.chaves.map((produtoId) => {
      const quantidade = receita.mapa[produtoId]?.quantidade ?? 0;
      const guardado = carimboArmazenadoDoComponente(armazenada, produtoId, quantidade);
      return [
        produtoId,
        {
          quantidade,
          limitarEstoque: true,
          timestamp: guardado !== null ? guardado.carimbo : nowMs,
        },
      ];
    }),
  );
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

/**
 * What a kit write does to ONE document's recipe.
 *
 *  - a {@link ComposicaoDoKit} ⇒ write it (the map and its keys);
 *  - `null` ⇒ write `null` — a 2..9-model parent has no single composition, and
 *    the `null` clears a stale mirror;
 *  - `'manter'` ⇒ write NEITHER key (step 19, R-t): a pending ERP edit the
 *    aviso is tracking is KEPT, and a superseded or removed listing writes no
 *    recipe at all. `ehKit` is still written — the document is a kit either way.
 */
type ReceitaAEscrever = ComposicaoDoKit | null | 'manter';

/**
 * The kit fields, as a patch fragment. `null` clears a stale mirror.
 *
 * ⚠️ Never `ehKitVirtual` (O-7): that flag says "publish this produto as a
 * native Shopee kit", and it is the operator's — an import that set it would
 * turn every ordinary-listing kit Lucas sells today into a create candidate.
 */
function camposDeKit(receita: ReceitaAEscrever): Record<string, unknown> {
  if (receita === 'manter') return { ehKit: true };
  return {
    ehKit: true,
    componentesKit: receita === null ? null : receita.mapa,
    componentesKitKeys: receita === null ? null : [...receita.chaves],
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
  receita: ReceitaAEscrever,
): boolean {
  if (armazenado.ehKit !== true) return false;
  // Nothing of the recipe is written, so nothing of it can differ.
  if (receita === 'manter') return true;
  const composicao = receita;

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
  receita: ReceitaAEscrever,
  nowMs: number,
  armazenado: Record<string, unknown> | null,
): EscritaDeProduto | null {
  if (escrita === null) {
    if (armazenado !== null && camposDeKitJaArmazenados(armazenado, receita)) return null;
    return {
      produtoId,
      criar: false,
      data: { ultimaModificacao: nowMs, ...camposDeKit(receita) },
    };
  }
  return { ...escrita, data: { ...escrita.data, ...camposDeKit(receita) } };
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
  /**
   * Step 19, R-t — index-aligned with `plano.filhos`: the `receitaKitConferida`
   * of each child's rows on EVERY active native-kit link of the kit produto for
   * this conta (`ehKitNativoAtivo`), the imported listing's own included and
   * judged as it will read AFTER this import's merge. A non-string stamp is
   * `null`. `[]` for a child with no such row (a new child, or no active kit).
   * Read by {@link lerCarimbosContados}.
   */
  readonly carimbosContados: readonly (readonly (string | null)[])[];
}

/**
 * One kit-model row the import is about to MERGE onto whose recipe is `igual`,
 * stamped FIRST with a flat `mergeIfExists` (step 19, R-4) — see
 * {@link preCarimbarLinhasDoKit}, which says why a `shopee` row never is.
 */
export interface PreCarimboDeLinhaKit {
  /** The CHILD produto the row sits under. */
  readonly produtoId: string;
  /** The `variashopee` doc id the plan merges onto. */
  readonly docId: string;
  /** `chaveReceitaKitErp` of the recipe this import writes on that child. */
  readonly receitaKitConferida: string;
}

/** The kit plan: the listing plan rewritten for a kit, plus R-t's two outputs. */
export interface PlanoKitShopee extends PlanoImportacaoShopee {
  /**
   * The `igual` rows to stamp BEFORE any produto write — the parent's included.
   * A `shopee` row is never here: its stamp rides its own merge, after the child.
   */
  readonly preCarimbos: readonly PreCarimboDeLinhaKit[];
  /** Children whose pending ERP recipe edit this import KEPT (R-t (ii)), sorted. */
  readonly receitaDivergente: readonly string[];
}

/**
 * What a re-import does with ONE child's recipe (step 19, R-t; Lucas L10(2)).
 *
 *  - `igual` — Shopee's resolved recipe folds to the child's CURRENT
 *    fingerprint: the import proceeds and PRE-stamps (the stamp already agrees
 *    with the stored recipe), so the child's entry in the recipe aviso resolves
 *    as `importado` (how a #1450 repoint closes on a re-import). Decided on
 *    CONTENT first, never on the stamps.
 *  - `mantida` — different, AND some counted row's stamp is not the current
 *    fingerprint: the aviso is tracking an ERP edit Shopee does not hold, so the
 *    import KEEPS the ERP map, stamps nothing and reports `receita-divergente`.
 *    Silently reverting an interactive edit is the lost update rule 7 tier 3
 *    forbids.
 *  - `shopee` — different, and every counted row is stamped with the current
 *    fingerprint (or there is none): nothing is pending, so Shopee's recipe wins
 *    exactly as before step 19. Its stamp lands with the row's own merge, AFTER
 *    the child write — never pre-stamped ({@link preCarimbarLinhasDoKit}).
 *
 * The comparisons are `chaveReceitaKitErp` strings — the schemas' ERP-side
 * fingerprint, equal over key order, `limitarEstoque` and the entry stamp,
 * distinct on any `quantidade`, on a component added, removed or renamed. A
 * `null` stamp is never the current fingerprint (it never verified anything).
 *
 * ⚠️ A família de um decides on the WRAPPER too (R1-RT7-01). The operator edits
 * K, and the edit reaches the member only later, through `onProdutoChanged`'s
 * sole-member mirror — which reads K as it is THEN and never retries. While K
 * and its member disagree, the member's map is not the ERP's current recipe:
 * K's is. So when `chaveDoPai` is given and differs from `chaveAtual`, Shopee's
 * recipe is `igual` only when it folds to K's — the import then completes the
 * mirror itself — and `mantida` otherwise, whatever the stamps say: the member's
 * rows cannot be tracking an edit that has not reached the member yet, so the
 * stamp test would read "nothing pending" and revert K through the mirror.
 */
export type DecisaoReceitaDoFilho = 'igual' | 'mantida' | 'shopee';

export function decidirReceitaDoFilho(a: {
  /** `chaveReceitaKitErp` of Shopee's resolved recipe for this model. */
  readonly chaveShopee: string;
  /** `chaveReceitaKitErp` of the child's STORED `componentesKit`. */
  readonly chaveAtual: string;
  readonly carimbosContados: readonly (string | null)[];
  /**
   * `chaveReceitaKitErp` of the wrapper K's STORED `componentesKit` — given only
   * when this child is the sole member of a família de um K that holds a
   * recipe map ({@link chaveDoPaiDaFamiliaDeUm}); absent/`null` otherwise.
   */
  readonly chaveDoPai?: string | null;
}): DecisaoReceitaDoFilho {
  if (a.chaveDoPai != null && a.chaveDoPai !== a.chaveAtual) {
    return a.chaveShopee === a.chaveDoPai ? 'igual' : 'mantida';
  }
  if (a.chaveShopee === a.chaveAtual) return 'igual';
  if (a.carimbosContados.some((carimbo) => carimbo !== a.chaveAtual)) return 'mantida';
  return 'shopee';
}

/**
 * The wrapper's fingerprint for {@link decidirReceitaDoFilho}'s `chaveDoPai`
 * (R1-RT7-01): `chaveReceitaKitErp` of K's stored `componentesKit` when the kit
 * has exactly ONE model, K names `filhoId` as its `filhoUnicoId`, and K holds a
 * recipe MAP — else `null`.
 *
 * ⚠️ A K with no map at all (a legacy wrapper that was never mirrored) answers
 * `null`, so the member's own decision stands: there is no operator edit on K to
 * protect, and reading the missing map as "a pending edit to the empty recipe"
 * would keep every such kit from ever taking Shopee's recipe.
 */
export function chaveDoPaiDaFamiliaDeUm(
  pai: Record<string, unknown> | null,
  filhoId: string,
  modelos: number,
): string | null {
  if (modelos !== 1 || pai === null) return null;
  if (typeof pai.filhoUnicoId !== 'string' || pai.filhoUnicoId !== filhoId) return null;
  const mapa = mapaDeComponentesArmazenado(pai);
  return mapa === null
    ? null
    : chaveReceitaKitErp(mapa as Parameters<typeof chaveReceitaKitErp>[0]);
}

/**
 * Is Shopee's recipe for ONE kit model faithful to a produto-level map
 * (R2-F2)? `false` when two DISTINCT component addresses — `(item_id, the model
 * the cascade asked for)`, compared through the schemas' literal
 * `mesmoEnderecoDeComponente` — resolve to the SAME ERP produto.
 *
 * ⚠️ Why it matters: R-t's fingerprint is produto-level, so `{X1: 2, X2: 3}`
 * with both listings bound to C folds to `{C: 5}` — EQUAL to an ERP `{C: 5}` —
 * while THE recipe fold (`mesmaReceitaKitShopee`, per address) calls it
 * DISTINCT, and Shopee derives the kit's stock as `min(S/2, S/3)` instead of
 * `S/5`. Such a kit was never verified, so it must never be stamped as if it
 * were. The SAME address on two rows is faithful (the address fold sums them,
 * 2 + 3 ≡ 5).
 */
export function receitaFielAosEnderecos(componentes: readonly ComponenteDoKitShopee[]): boolean {
  const porProduto = new Map<string, EnderecoShopeeDoComponente>();
  for (const componente of componentes) {
    if (componente.produtoId === null) continue;
    const endereco: EnderecoShopeeDoComponente = {
      itemId: componente.itemId,
      modelId: componente.modelIdDoComponente,
    };
    const visto = porProduto.get(componente.produtoId);
    if (visto === undefined) porProduto.set(componente.produtoId, endereco);
    else if (!mesmoEnderecoDeComponente(visto, endereco)) return false;
  }
  return true;
}

/**
 * The listing link doc id a kit import writes (step 19, R-u): the parent
 * cascade's rung-1 hit, whatever its id (every pre-step-19 kit link keeps its
 * auto id), else the DETERMINISTIC new kit link id `idDoVinculoDeKit` — the
 * very id the kit create writes right after `add_kit_item`, so the create and
 * an import of the same kit converge on ONE `prodshopee`.
 */
export function idDoVinculoDaListagemDeKit(
  integracaoId: string,
  itemId: number,
  linkResolvido: string | null,
): string {
  return linkResolvido ?? idDoVinculoDeKit(integracaoId, itemId);
}

/**
 * Will the imported listing's link be an ACTIVE native kit once this import
 * merges it (`ehKitNativoAtivo` over the planned data, which spreads the stored
 * doc)? Only the produto's ACTIVE native kit writes a recipe (R-t): a
 * superseded one — the old kit a failed-delete recriar left live — or a removed
 * one still gets its status fields and its rows, but no recipe and no stamp.
 */
export function vinculoDaListagemAtivo(plano: PlanoImportacaoShopee): boolean {
  return ehKitNativoAtivo(plano.linkPai.dados);
}

/**
 * One kit-model row escrita, for a kit: the stamp decided, and an `add` turned
 * into an upsert at the deterministic row id (step 19, S3F-02).
 *
 * ⚠️ The stored stamp rides the planner's spread of the row, so it is always
 * REPLACED or DELETED here, never re-written as read: a merge that re-wrote the
 * stamp it read would put a stale value back over a pre-stamp (or over a
 * concurrent writer's). `null` = no stamp to write: the key leaves a merge
 * untouched and a NEW row gets an explicit `null` — unless `limpar`, which
 * writes the explicit `null` on an existing row too (R2-F2: a recipe that is not
 * address-faithful un-verifies whatever an earlier pass stamped).
 */
function linhaDoKit(
  link: EscritaDeLink | null,
  modelId: number,
  linkDocId: string,
  caminhoDoVinculo: string,
  carimbo: string | null,
  limpar: boolean,
): EscritaDeLink | null {
  if (link === null) return null;
  const semCarimbo = Object.fromEntries(
    Object.entries(link.dados).filter(([chave]) => chave !== 'receitaKitConferida'),
  );
  const nova = link.acao === 'add';
  const dados: Record<string, unknown> = {
    ...semCarimbo,
    // The id is known now (it is derived), so the plan states the ref instead
    // of leaving it to the writer's stamp — the writer stamps the same path.
    produtoShopeeOuterRef: toOuterRef(caminhoDoVinculo),
    ...(carimbo !== null ? { receitaKitConferida: carimbo } : {}),
    ...(carimbo === null && (nova || limpar) ? { receitaKitConferida: null } : {}),
  };
  if (nova) return { acao: 'merge', docId: idDaVariacaoDeKit(linkDocId, modelId), dados };
  return { ...link, dados };
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
 * merged one would be a fourth answer nobody wrote. ⚠️ When the one child's
 * recipe is KEPT (R-t (ii)), the parent's recipe is left UNWRITTEN too: a
 * mirror of Shopee's recipe on the parent would reach the kept member through
 * the produto trigger's sole-member mirror and revert the very edit kept here.
 *
 * ⚠️ Step 19 (#1527) rewrites the link escritas, never the planner (R-u,
 * S3F-02): a NEW listing link (the cascade's rung 1 missed) is a merge at
 * `idDoVinculoDeKit(integracaoId, item_id)` instead of an `add`, and every NEW
 * kit-model row is a merge at `idDaVariacaoDeKit(linkDocId, model_id)` — the
 * existing merge-at-docId applier, an upsert at a deterministic id (tier 0), so
 * the create and the import land on ONE link and ONE row per (link, model).
 * Every kit-model row carries the decided `receitaKitConferida` (R-4); only an
 * EXISTING row whose recipe is `igual` is also listed in `preCarimbos`.
 */
export function comCamposDeKit(
  plano: PlanoImportacaoShopee,
  componentes: readonly ComponenteDoKitShopee[],
  nowMs: number,
  integracaoId: string,
  armazenados: ArmazenadosDoKit,
): PlanoKitShopee {
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

  const linkDocId = idDoVinculoDaListagemDeKit(integracaoId, plano.itemId, plano.linkPai.docId);
  const caminhoDoVinculo = caminhoDoLinkDaListagem(plano.produtoId, linkDocId);
  const ativo = vinculoDaListagemAtivo(plano);

  const preCarimbos: PreCarimboDeLinhaKit[] = [];
  const receitaDivergente: string[] = [];
  const receitas: ReceitaAEscrever[] = [];

  const filhos: PlanoFilhoShopee[] = plano.filhos.map((filho, i) => {
    // ⚠️ The id the WRITER will use — index-aligned with `filhos` by
    // construction — never `filho.produto?.produtoId`, which is absent on a
    // byte-identical re-import.
    const filhoId =
      plano.filhoUnico.idsPlanejados[i] ?? filho.produto?.produtoId ?? plano.produtoId;
    const composicao = porModelo.get(filho.modelId) ?? null;

    let receita: ReceitaAEscrever = composicao;
    let carimbo: string | null = null;
    let limparCarimbo = false;
    let preCarimbar = false;
    if (!ativo) {
      receita = 'manter';
    } else if (composicao !== null) {
      const decisao = decidirReceitaDoFilho({
        chaveShopee: chaveReceitaKitErp(composicao.mapa),
        chaveAtual: chaveReceitaKitErp(
          mapaDeComponentesArmazenado(armazenados.filhos[i] ?? null) as Parameters<
            typeof chaveReceitaKitErp
          >[0],
        ),
        carimbosContados: armazenados.carimbosContados[i] ?? [],
        // R1-RT7-01: a família de um's wrapper may hold an edit its member has
        // not received yet (the mirror is a later, unretried trigger).
        chaveDoPai: chaveDoPaiDaFamiliaDeUm(armazenados.pai, filhoId, plano.filhos.length),
      });
      if (decisao === 'mantida') {
        receita = 'manter';
        receitaDivergente.push(filhoId);
      } else if (receitaFielAosEnderecos(componentes.filter((c) => c.modelId === filho.modelId))) {
        // The written map IS the read-back, so this stamp is fold-equal by
        // construction (R-4) — at the PRODUTO level, which is the address level
        // only because the recipe is address-faithful (R2-F2).
        carimbo = chaveReceitaKitErp(composicao.mapa);
        // ⚠️ Only an `igual` stamp may land AHEAD of the produto write: it
        // already describes the recipe the ERP holds. A `shopee` stamp describes
        // the recipe this import is ABOUT to write, so it rides the row's own
        // merge, after the child — see `preCarimbarLinhasDoKit`.
        preCarimbar = decisao === 'igual';
      } else {
        // R2-F2: two Shopee addresses fold onto one produto, so THE recipe fold
        // calls this kit DISTINCT from anything the ERP can project. The map
        // is still written (it is the produto-level truth), but the stamp is
        // CLEARED — never left at a value an earlier pass wrote — so the aviso
        // opens and stays open until the kit is recreated.
        limparCarimbo = true;
      }
    }
    receitas.push(receita);

    const link = linhaDoKit(
      filho.link,
      filho.modelId,
      linkDocId,
      caminhoDoVinculo,
      carimbo,
      limparCarimbo,
    );
    if (
      preCarimbar &&
      carimbo !== null &&
      filho.link?.acao === 'merge' &&
      filho.link.docId !== null
    ) {
      preCarimbos.push({
        produtoId: filhoId,
        docId: filho.link.docId,
        receitaKitConferida: carimbo,
      });
    }

    return {
      ...filho,
      produto: comCamposDeKitNoProduto(
        filho.produto,
        filhoId,
        receita,
        nowMs,
        armazenados.filhos[i] ?? null,
      ),
      // A kit child is assembled, never stocked. Structural, not incidental.
      estoque: null,
      link,
    };
  });

  const espelho: ReceitaAEscrever = !ativo
    ? 'manter'
    : plano.filhos.length === 1
      ? (receitas[0] ?? null)
      : null;

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
    linkPai:
      plano.linkPai.acao === 'add'
        ? { acao: 'merge', docId: linkDocId, dados: plano.linkPai.dados }
        : plano.linkPai,
    linkPaiRefPendente: false,
    filhos,
    preCarimbos,
    receitaDivergente: [...receitaDivergente].sort(compararTexto),
  };
}

/** UTF-16 code-unit order — a stable, locale-free sort for doc ids. */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/*  5. The write-free half                                                     */
/* -------------------------------------------------------------------------- */

/**
 * R-u: a ONE-model kit imported onto a kit produto that is a família de um
 * binds its model to the parent's `filhoUnicoId` — never a freshly minted
 * child.
 *
 * ⚠️ Why the cascade alone is not enough: a kit created from the sole member
 * names the member's sku as `model_sku`, but a kit authored in Seller Centre may
 * carry none, and the single-model tier is planned as NO tier
 * ({@link ehTierDeKitUnico}), so neither the sku rung nor the combination rung
 * can find the member and rung 4 would MINT a second child — a família de um
 * that silently stops being one (`filhoUnicoId` re-derives to `null`). The
 * member is read by id and bound only when it still names THIS parent: a stale
 * pointer never binds another family's produto. Rung 1's own answer, and a
 * `variashopee` of another family, always win.
 */
async function comMembroDaFamiliaDeUm(
  db: Firestore,
  pai: DocumentoLido | null,
  resolucoes: readonly ResolucaoFilhoShopee[],
): Promise<readonly ResolucaoFilhoShopee[]> {
  if (pai === null || resolucoes.length !== 1) return resolucoes;
  const unica = resolucoes[0];
  if (unica === undefined || unica.existente !== null || unica.vinculoDeOutraFamilia) {
    return resolucoes;
  }
  const membroId = pai.raw.filhoUnicoId;
  if (typeof membroId !== 'string' || membroId === '') return resolucoes;
  const snap = await produtoCollection.docRef(db, {}, membroId).get();
  if (!snap.exists) return resolucoes;
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  if (raw.paiId !== pai.id) return resolucoes;
  return [{ ...unica, existente: { id: membroId, raw, updateTime: snap.updateTime } }];
}

/**
 * R-t's counted stamps (step 19, #1527) — index-aligned with `plano.filhos`.
 *
 * For each EXISTING child: the `receitaKitConferida` of its `variashopee` rows
 * of this conta that sit on an ACTIVE native-kit link of the kit produto
 * (`ehKitNativoAtivo`) — the imported listing's own (judged as it will read
 * after this import's merge) AND any other live kit's. The other kit matters: a
 * Seller-Centre duplicate, or the new kit of an interrupted recriar, has no rows
 * yet while the edit the aviso tracks sits on the OTHER kit's rows.
 *
 * Both stored ref encodings bind (the conta through `toOuterRefOrNull`, the
 * link through `idDoRef`), the same reach the aviso decision has, so the two
 * never disagree about which rows count.
 *
 * ⚠️ Reads NOTHING when the listing will not be active: such a listing writes no
 * recipe, so there is nothing to decide. Otherwise one read of the kit's
 * `prodshopee` and one per existing child (≤ 9) — no query, no index.
 */
export async function lerCarimbosContados(
  db: Firestore,
  integracaoId: string,
  kitProdutoId: string | null,
  plano: PlanoImportacaoShopee,
  filhosExistentes: readonly (DocumentoLido | null)[],
): Promise<(string | null)[][]> {
  const saida: (string | null)[][] = plano.filhos.map(() => []);
  if (!vinculoDaListagemAtivo(plano)) return saida;

  const conta = toOuterRef(`integracao/${integracaoId}`);
  const proprio = idDoVinculoDaListagemDeKit(integracaoId, plano.itemId, plano.linkPai.docId);
  const ativos = new Set<string>([proprio]);
  if (kitProdutoId !== null) {
    const links = await produtoShopeeLinkCollection.ref(db, { produtoId: kitProdutoId }).get();
    for (const doc of links.docs) {
      // The imported listing is judged by its PLANNED data, above — never by
      // the stored doc, which may predate the `kitNativo` stamp.
      if (doc.id === proprio) continue;
      const raw = (doc.data() ?? {}) as Record<string, unknown>;
      if (toOuterRefOrNull(raw.contaProdutoShopeeOuterRef) !== conta) continue;
      if (ehKitNativoAtivo(raw)) ativos.add(doc.id);
    }
  }

  for (const [i, existente] of filhosExistentes.entries()) {
    if (existente === null || i >= saida.length) continue;
    const linhas = await variacaoShopeeLinkCollection.ref(db, { produtoId: existente.id }).get();
    for (const doc of linhas.docs) {
      const raw = (doc.data() ?? {}) as Record<string, unknown>;
      if (toOuterRefOrNull(raw.contaVariacaoShopeeOuterRef) !== conta) continue;
      const linkId = idDoRef(raw.produtoShopeeOuterRef);
      if (linkId === null || !ativos.has(linkId)) continue;
      const carimbo = raw.receitaKitConferida;
      saida[i]?.push(typeof carimbo === 'string' ? carimbo : null);
    }
  }
  return saida;
}

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

  // R-u (S2C-01): the child claim check and link reuse see only THIS listing's
  // rows — a kit's children routinely carry another listing's rows (the old kit
  // of a recriar, the ordinary listing a converter superseded, a removed one).
  const resolucoes = await comMembroDaFamiliaDeUm(
    db,
    pai.existente,
    await resolverFilhosDaListagem(
      db,
      deps.integracaoId,
      paiId,
      pai.existente !== null,
      modelos,
      combos.map((c) => ({ variacoesUid: c.variacoesUid })),
      idDoVinculoDaListagemDeKit(deps.integracaoId, anuncio.itemId, pai.link?.id ?? null),
    ),
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
  const componentes = await resolverComponentesDoKit(
    deps.db,
    deps.integracaoId,
    kit,
    // Absent ⇒ every component unknown ⇒ the wire ids verbatim (today's path).
    entrada.temModelosDosComponentes ?? new Map<number, boolean>(),
  );
  exigirComponentesVinculados(componentes, entrada.itemId);

  const anuncio = anuncioDerivadoDoKit(entrada, kit);
  const lido = await lerPreparoDoKit(deps, anuncio);
  const planoDaListagem = planejarImportacaoShopee(lido);
  const filhosExistentes = lido.filhos.map((filho) => filho.existente);
  const carimbosContados = await lerCarimbosContados(
    deps.db,
    deps.integracaoId,
    lido.pai.existente?.id ?? null,
    planoDaListagem,
    filhosExistentes,
  );
  const plano = comCamposDeKit(planoDaListagem, componentes, deps.nowMs, deps.integracaoId, {
    pai: lido.pai.existente?.raw ?? null,
    filhos: filhosExistentes.map((existente) => existente?.raw ?? null),
    carimbosContados,
  });

  return { plano, componentes, anuncio, produtosComponentes: produtosDosComponentes(componentes) };
}

/**
 * The PRE-STAMP (step 19, R-4): every kit-model row the import is about to merge
 * onto whose recipe decision is `igual` gets its `receitaKitConferida` FIRST —
 * before the child produto is written, and before the PARENT, which reaches a
 * família de um's member first through the produto trigger's sole-member mirror.
 *
 * ⚠️ Why first: the produto write fires the recipe trigger, which re-decides
 * the aviso from the rows as they are THEN. A row stamped after the produto
 * would lose that race and open an aviso for a recipe this very import just
 * verified. Stamped first, the trigger already reads the new stamp.
 *
 * ⚠️ Why ONLY `igual`: a stamp is never written AHEAD of the produto it
 * describes. An `igual` stamp already agrees with the recipe the ERP stores —
 * the child's, or, for a família de um whose mirror is pending, the wrapper's,
 * the one {@link decidirReceitaDoFilho} compares — so an import that dies right
 * after it leaves a state the next import decides `igual` again. A `shopee`
 * stamp describes the recipe this import is about to WRITE: had it landed first
 * and `aplicarImportacaoShopee` thrown before the child (taxonomia, categorias,
 * a guarded price patch, the parent merge, extraData, the parent link), the
 * rows would hold Shopee's S while the child still held R — exactly an ERP edit
 * S → R the aviso is tracking — and every later import would answer `mantida`,
 * report `receita-divergente`, and leave the aviso asking the operator to
 * recreate the kit, which pushes R back over the Seller Centre change (PR #1865
 * review). So a `shopee` row's stamp rides the plan's own row merge, AFTER its
 * child's produto write. The trigger that write fires may still read the old
 * stamp and open the aviso for a moment; the closing
 * `reavaliarAvisoDeReceitaKit` reads the merged row, so its clock is strictly
 * newer than any snapshot that saw the old stamp, and it resolves `importado`.
 * An import that dies between the child write and the row merge leaves child S
 * and rows R, which the next import decides `igual` and pre-stamps — at worst a
 * false OPEN until then, the safe direction. `mantida` and an address-unfaithful
 * recipe (R2-F2) pre-stamp nothing either: the first stamps nothing, the second
 * clears through the same row merge.
 *
 * ⚠️ A flat `mergeIfExists`, never `merge` and never `set`: a `set` would erase
 * step 13's `preco*` and the sync's `modeloAusenteEm`/`model_status`, and an
 * upserting `merge` would RESURRECT a row deleted since the preparo as a ghost
 * carrying only the stamp, with no `model_id`. A row that is gone is skipped;
 * the plan's own merge writes it whole afterwards.
 *
 * Nothing guards two concurrent imports of one kit beyond "the same value": both
 * stamp the fingerprint of the recipe they read from Shopee, which a kit cannot
 * change (P2-c).
 */
export async function preCarimbarLinhasDoKit(
  db: Firestore,
  preCarimbos: readonly PreCarimboDeLinhaKit[],
): Promise<void> {
  for (const linha of preCarimbos) {
    await variacaoShopeeLinkCollection.mergeIfExists(
      db,
      { produtoId: linha.produtoId },
      linha.docId,
      {
        receitaKitConferida: linha.receitaKitConferida,
      },
    );
  }
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
 *
 * Step 19 (#1527) brackets the writer with the recipe aviso's two halves: the
 * PRE-STAMP of the `igual` rows before it ({@link preCarimbarLinhasDoKit}), and ONE
 * `reavaliarAvisoDeReceitaKit` for (conta, kit) after it, motivo `importado` —
 * the shared decision that re-reads the current recipes in one snapshot, never
 * a blind resolve. Its µs clock comes from `avisos/autorizacao.ts`'s
 * `agoraUsDe`, so `produtos/` still converts nothing itself.
 */
export const importarKitShopee = (async (
  deps: ImportarKitShopeeDeps,
  entrada: ItemLido,
): Promise<ResultadoImportacaoKitShopee> => {
  const preparo = await prepararImportacaoKitShopee(deps, entrada);
  await preCarimbarLinhasDoKit(deps.db, preparo.plano.preCarimbos);
  const resultado = await aplicarImportacaoShopee(deps, preparo.plano);
  await reavaliarAvisoDeReceitaKit(
    deps.db,
    { integracaoId: deps.integracaoId, kitProdutoId: resultado.produtoId },
    MOTIVO_RESOLUCAO_RECEITA_KIT.importado,
    { agoraUs: agoraUsDe({ nowMs: deps.nowMs }), increment: deps.increment },
  );
  return {
    ...resultado,
    kit: {
      componentes: preparo.produtosComponentes.length,
      // The kit produto IS the parent, so the two cannot disagree — a separate
      // boolean here would only ever be a second way to say the same thing.
      criado: resultado.criado,
      avisos: preparo.plano.receitaDivergente.map((filhoId) => ({
        codigo: 'receita-divergente' as const,
        produtoId: filhoId,
        mensagem:
          `a composição da variação ${filhoId} mudou no ERP e o kit ${String(entrada.itemId)} ` +
          // ⚠️ No claim about the aviso's state: for a família de um whose
          // member has not received K's edit yet (R1-RT7-01) the aviso opens
          // only when the mirror lands — and never, if that mirror was lost.
          'na Shopee ainda tem a anterior; a importação manteve a do ERP (recrie o kit para ' +
          'aplicá-la na Shopee)',
      })),
    },
  };
}) satisfies ImportarKitShopeeFn;

/**
 * One warning of a kit import — declared on the seam (`itemLido.ts`) since
 * OP-1, so the route, the CLI and the job read it off
 * `ResultadoImportacaoShopee`; re-exported here for the importer's callers.
 */
export type { AvisoImportacaoKit } from './itemLido';

/**
 * What {@link importarKitShopee} answers: the listing result plus the kit block,
 * whose `avisos` is REQUIRED here: the kit arm always reports it, `[]` included.
 * The seam's is optional (absent reads as `[]`) — see `ResultadoImportacaoShopee`.
 */
export interface ResultadoImportacaoKitShopee extends ResultadoImportacaoShopee {
  readonly kit: {
    readonly componentes: number;
    readonly criado: boolean;
    readonly avisos: readonly AvisoImportacaoKit[];
  };
}
