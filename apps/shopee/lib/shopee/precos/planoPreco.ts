/**
 * **The PURE price planner** (#1521, step 13) — one discovered family ⇒ the
 * listings a price push will read and send (IDENTITIES only), plus one
 * observable line for every listing it will NOT send; then, separately, the
 * price each planned model should carry.
 *
 * Nothing here reads Firestore, reads the clock or calls Shopee. The discovery
 * (`./descobertaPreco`) owns the reads, the sender owns the wire, and this
 * module owns WHICH listings and models are addressed and WHERE each price
 * comes from. A listing or a model that disappears silently disappears here,
 * which is why the whole thing is a function a test can interrogate with a
 * plain fixture.
 *
 * ## Two halves, on purpose (reconcile C-d)
 *
 * {@link montarItensDePreco} plans IDENTITIES — anchor, `prodshopee`, `item_id`,
 * the models of that listing — and carries no price at all.
 * {@link precificarItem} prices one planned item from a `precos` map handed in
 * by the caller. The manual push calls the two back to back over the family it
 * just read; the account-wide job (the second PR) plans a page, parks it, and
 * prices each item seconds before sending it, so a job held across a daily
 * quota pause never sends a day-old tabela value. A planned item that carried
 * its price would have made that second reading impossible.
 *
 * ## Why the row shapes live HERE
 *
 * `./descobertaPreco` produces {@link FamiliaDePreco} and this module consumes
 * it, so one of the two declares it. It is this one — step 12's
 * `estoque/planoEstoque.ts` rule — because the planner's tests need the shapes
 * and because declaring them on the producing side would make the discovery
 * the module everybody imports for a type.
 *
 * ## The plan-time ladder (reconcile §2.6), per `prodshopee`, in order
 *
 * | # | condition | outcome |
 * |---|---|---|
 * | 0 | the link's conta is not this integração | ignored, in SILENCE (another conta's business) |
 * | 0b | the family has no link of this conta | ONE `sem-link` |
 * | 1 | no `linkDocId` (projection drift, defensive) | `sem-link` for that link |
 * | 2 | `item_id` not a positive integer | `sem-item-id` |
 * | 3 | the link says native Shopee kit (`kitNativo === true`) | `kit-derivado` |
 * | 4 | stored lifecycle says DELETED | `anuncio-removido` |
 * | 5 | a child carries > 1 usable model of THIS listing | `forma-de-modelo-divergente` |
 * | 6 | model links name this listing, none usable | `sem-modelos` |
 * | 7 | more usable models than one `update_price` takes | `modelos-excedem-limite` |
 * | 8 | otherwise | ONE planned item |
 *
 * Rungs 1–4 cost nothing and happen BEFORE the models are folded, so their
 * lines carry no model list; rung 7's line carries every model it refused.
 * Everything that needs a FRESH reading of the listing — banned, in review,
 * gone since the last sync, a changed variation structure — is the sender's,
 * never guessed here from a stored field.
 *
 * ⚠️ **Rung 3 reads the LINK, never the produto.** An ERP kit (`ehKit`, a
 * produto assembled from `componentesKit`) publishes as an ORDINARY Shopee
 * listing and its price is sent like any other; only a listing Shopee itself
 * reported as a native kit is skipped. The family shape carries no produto
 * flag at all, which makes "an ERP kit is skipped" structurally unwritable
 * here. Same slug as the stock sync, same condition, same word.
 *
 * ⚠️ **Rung 4 has TWO stored spellings of one fact, and both refuse.** The
 * frozen rung reads the raw `item_status` (`SELLER_DELETE` / `SHOPEE_DELETE`,
 * which the migrated corpus carries); step 12's stock gate reads the ERP's
 * folded `estadoAnuncio` (`removido`, which this app's own re-reads write). A
 * listing either spelling calls deleted is terminal, and refusing it here only
 * saves it a slot in the sender's batched read — the fresh read would refuse
 * it anyway. No other stored status is judged here.
 *
 * ## ⚠️ What "a model of this listing" means — the three folds are SHARED
 *
 * Which conta owns a `prodshopee`, which listing a `variashopee` belongs to and
 * which `model_id` readings are usable are `../core/vinculosShopee`'s three
 * folds, the SAME functions the stock planner calls — promoted rather than
 * copied, because two planners attributing a model to a listing through two
 * spellings is the drift root `CLAUDE.md` names (#1369). That module's header
 * states what each fold treats as equal and what it keeps distinct.
 *
 * On top of them this planner adds exactly two rules of its own:
 *
 * - **A model with no `varLinkDocId` is not usable here.** The price write-back
 *   stamps the `variashopee` document by that id; a model this ERP could send
 *   but never record is dropped with the other unusable rows. The discovery
 *   always projects the document id, so the arm is defensive.
 * - **A child may carry at most ONE usable model of a listing** (reconcile
 *   C-o). The shared report row is keyed by the CHILD produto, not by the
 *   model, so a child carrying two models of one listing would write two rows
 *   under one key and the second would overwrite the first. Neither the import
 *   nor the publish produces that shape, so it is a drifted listing, and the
 *   whole listing is refused with the slug whose remedy is a re-import. Its
 *   line deliberately carries NO model list, for the same key reason.
 *
 * "Model links name this listing" (rung 6 vs a no-model item) is decided on
 * the RAW attributed rows, before the usable-model fold — the stock planner's
 * reading, kept identical: a listing whose only model link carries
 * `model_id: 0` is a has-model listing with nothing usable (`sem-modelos`), and
 * never a no-model listing that would send the ANCHOR's price at model `0`.
 */
import { SHOPEE_UPDATE_PRICE_MAX_MODELS } from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, SHOPEE_ITEM_STATUS, precoDaTabela } from '@delfrance/schemas';

import { kitNativoDoAnuncio } from '../anuncios/montagemAnuncio';
import {
  type VarLinkShopeeCru,
  idDoRef,
  modelosUtilizaveis,
  varLinksDoAnuncio,
} from '../core/vinculosShopee';
import { SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import { type MotivoPrecoShopee, MOTIVO_PRECO_SHOPEE } from './errosPreco';

/* -------------------------------------------------------------------------- */
/*                               THE ROW SHAPES                               */
/* -------------------------------------------------------------------------- */

/**
 * One `prodshopee` document as the discovery projects it — unvalidated, every
 * field `unknown`, read with `typeof` narrows only.
 */
export interface LinkPrecoCru {
  /** Which conta owns this listing. Either stored ref encoding (fold 1). */
  contaProdutoShopeeOuterRef?: unknown;
  /** Shopee's item id. A NUMBER; a stringified id reads as absent. */
  item_id?: unknown;
  /** Shopee's raw lifecycle status, as last stored. Rung 4 reads the two DELETE values. */
  item_status?: unknown;
  /** The ERP's FOLDED lifecycle state (step 11/12's `estadoAnuncio`). Rung 4 reads `removido`. */
  estadoAnuncio?: unknown;
  /** Shopee's native-kit flag (`tag.kit`), three-valued. Rung 3 reads `=== true`. */
  kitNativo?: unknown;
  /** The `prodshopee` document's own id, projected by the discovery. */
  linkDocId?: unknown;
  [k: string]: unknown;
}

/** A variation child: its OWN `precos` and its own model links. */
export interface FilhoDePreco {
  readonly produtoId: string;
  /** The child's `precos` map, RAW — a model's price is its child's, never the anchor's. */
  readonly precos: unknown;
  readonly varLinks: readonly VarLinkShopeeCru[];
}

/** One discovered family, price-shaped. */
export interface FamiliaDePreco {
  /** The family anchor — the produto that owns the `prodshopee` links. */
  readonly anchorId: string;
  /** The anchor's `precos` map, RAW — a NO-MODEL listing's price. */
  readonly precos: unknown;
  /** Every `prodshopee` of the anchor, EVERY conta — the conta is compared here. */
  readonly links: readonly LinkPrecoCru[];
  readonly children: readonly FilhoDePreco[];
}

/** One model a planned item addresses. */
export interface ModeloPlanejadoPreco {
  /** A positive integer — a no-model item has NO models, never a `0` entry here. */
  readonly modelId: number;
  /** The CHILD produto whose `precos` price this model. */
  readonly produtoId: string;
  /** The `variashopee` document the per-model write-back stamps. */
  readonly varLinkDocId: string;
}

/**
 * One listing the push will read and, if the sender agrees, write — IDENTITIES
 * only. The second PR's job stores exactly this shape in its queue; a type
 * test there pins the two together.
 */
export interface ItemPlanejadoPreco {
  /** The family ANCHOR — the produto that owns the `prodshopee` link. */
  readonly produtoId: string;
  /** The `prodshopee` document id — the write-back target, never re-resolved. */
  readonly linkDocId: string;
  /** ⚠️ A NUMBER. A stringified id matches nothing, silently. */
  readonly itemId: number;
  /** `[]` ⇔ a NO-MODEL listing (one write, the anchor's price). */
  readonly modelos: readonly ModeloPlanejadoPreco[];
}

/** One observable line for a listing (or family) this plan will NOT send. */
export interface PuloDePlano {
  /** The family anchor — every plan line is listing-level. */
  readonly produtoId: string;
  readonly linkDocId: string | null;
  readonly itemId: number | null;
  readonly motivo: MotivoPrecoShopee;
  /**
   * The models this line is about, when the rung that wrote it had folded
   * them — today only `modelos-excedem-limite`. `[]` everywhere else: rungs
   * 1–4 decide before any model is read, `sem-modelos` has none, and
   * `forma-de-modelo-divergente` must NOT list them (a child would repeat, and
   * the report row key is the child).
   */
  readonly modelos: readonly ModeloPlanejadoPreco[];
}

/** The plan for ONE family. */
export interface PlanoDePreco {
  readonly itens: readonly ItemPlanejadoPreco[];
  readonly pulos: readonly PuloDePlano[];
}

/** One model of a priced item, as the sender reads it. */
export interface AlvoDeModelo {
  /**
   * ⚠️ `SHOPEE_PRECO_MODEL_ID_SEM_MODELO` (`0`) on a NO-MODEL item's single
   * alvo, a positive integer otherwise. Never tested for truthiness.
   */
  readonly modelId: number;
  /** The produto whose `precos` priced this alvo — the CHILD, or the anchor at a no-model item. */
  readonly produtoId: string;
  /** `null` exactly on a no-model item's single alvo. */
  readonly varLinkDocId: string | null;
  /** `precoDaTabela`'s answer: rounded to the centavo and positive, or `null` (no price). */
  readonly precoAlvo: number | null;
}

/** One planned item with its prices — the sender's input. */
export interface ItemDePreco {
  readonly produtoId: string;
  readonly linkDocId: string;
  readonly itemId: number;
  /** `true` ⇔ the planned item had no models ⇔ ONE alvo at the no-model id. */
  readonly semModelos: boolean;
  readonly alvos: readonly AlvoDeModelo[];
}

/* -------------------------------------------------------------------------- */
/*                              SMALL TOTAL READERS                           */
/* -------------------------------------------------------------------------- */

/** A non-empty string, or null. */
function textoNaoVazio(bruto: unknown): string | null {
  return typeof bruto === 'string' && bruto !== '' ? bruto : null;
}

/**
 * A positive INTEGER, or null. ⚠️ `typeof === 'number'`, so a STRINGIFIED id
 * reads as absent — the field is a typed number and nothing in this repo
 * writes it as a string; a corpus row that did takes the refusing direction.
 */
function inteiroPositivo(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isInteger(bruto) && bruto > 0 ? bruto : null;
}

/**
 * Rung 4: does the STORED link say the listing is deleted? Exact matches only
 * — a status spelled any other way is not guessed at here, it SENDS and the
 * sender's fresh read decides.
 */
function removidoNoVinculo(link: LinkPrecoCru): boolean {
  return (
    link.item_status === SHOPEE_ITEM_STATUS.sellerDelete ||
    link.item_status === SHOPEE_ITEM_STATUS.shopeeDelete ||
    link.estadoAnuncio === ESTADO_ANUNCIO_SHOPEE.removido
  );
}

/**
 * The models of ONE listing this ERP can both SEND and RECORD: the shared
 * folds, then a document id for the write-back. Discovery order kept.
 */
function modelosPlanejaveis(
  atribuidos: Parameters<typeof modelosUtilizaveis>[0],
): ModeloPlanejadoPreco[] {
  const saida: ModeloPlanejadoPreco[] = [];
  for (const candidato of modelosUtilizaveis(atribuidos)) {
    if (candidato.varLinkDocId === null) continue;
    saida.push({
      modelId: candidato.modelId,
      produtoId: candidato.produtoId,
      varLinkDocId: candidato.varLinkDocId,
    });
  }
  return saida;
}

/** True when some child carries more than one of the given models (reconcile C-o). */
function filhoComDoisModelos(modelos: readonly ModeloPlanejadoPreco[]): boolean {
  const vistos = new Set<string>();
  for (const modelo of modelos) {
    if (vistos.has(modelo.produtoId)) return true;
    vistos.add(modelo.produtoId);
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*                                 THE PLANNER                                */
/* -------------------------------------------------------------------------- */

/**
 * **The planner.** One family ⇒ the listings to send and the lines to record.
 *
 * One item per `prodshopee` of this conta — two listings under one anchor are
 * legal and each gets its OWN item with its OWN models (fold 2). One listing's
 * refusal never touches another's. Pure and zero-call: every outcome here is
 * decided without Shopee, which is what lets the job plan a whole page before
 * spending any quota.
 */
export function montarItensDePreco(f: FamiliaDePreco, integracaoId: string): PlanoDePreco {
  const itens: ItemPlanejadoPreco[] = [];
  const pulos: PuloDePlano[] = [];

  const pular = (
    motivo: MotivoPrecoShopee,
    alvo: {
      readonly linkDocId?: string | null;
      readonly itemId?: number | null;
      readonly modelos?: readonly ModeloPlanejadoPreco[];
    } = {},
  ): void => {
    pulos.push({
      produtoId: f.anchorId,
      linkDocId: alvo.linkDocId ?? null,
      itemId: alvo.itemId ?? null,
      motivo,
      modelos: alvo.modelos ?? [],
    });
  };

  // Rung 0 — another conta's listing is not this push's business, and a line
  // for it would be noise on every run for every multi-conta produto.
  const daConta = f.links.filter(
    (link) => idDoRef(link.contaProdutoShopeeOuterRef) === integracaoId,
  );
  if (daConta.length === 0) {
    pular(MOTIVO_PRECO_SHOPEE.semLink);
    return { itens, pulos };
  }

  for (const link of daConta) {
    // Rung 1 — defensive: the discovery projects the document id, so an absent
    // one is drift in the query rather than in the corpus.
    const linkDocId = textoNaoVazio(link.linkDocId);
    if (linkDocId === null) {
      pular(MOTIVO_PRECO_SHOPEE.semLink);
      continue;
    }

    // Rung 2.
    const itemId = inteiroPositivo(link.item_id);
    if (itemId === null) {
      pular(MOTIVO_PRECO_SHOPEE.semItemId, { linkDocId });
      continue;
    }

    // Rung 3 — the LINK is the authority. The produto argument is the helper's
    // first-publish arm, unreachable here (a link always exists at this rung),
    // so no produto flag is handed over and none can leak into the decision.
    if (kitNativoDoAnuncio(link, {})) {
      pular(MOTIVO_PRECO_SHOPEE.kitDerivado, { linkDocId, itemId });
      continue;
    }

    // Rung 4.
    if (removidoNoVinculo(link)) {
      pular(MOTIVO_PRECO_SHOPEE.anuncioRemovido, { linkDocId, itemId });
      continue;
    }

    // Rungs 5–7 — the models of THIS listing (fold 2), never of the produto.
    const atribuidos = varLinksDoAnuncio(f.children, linkDocId);
    if (atribuidos.length === 0) {
      // Rung 8, no-model: one write carrying the ANCHOR's price.
      itens.push({ produtoId: f.anchorId, linkDocId, itemId, modelos: [] });
      continue;
    }

    const modelos = modelosPlanejaveis(atribuidos);
    if (filhoComDoisModelos(modelos)) {
      pular(MOTIVO_PRECO_SHOPEE.formaDeModeloDivergente, { linkDocId, itemId });
      continue;
    }
    if (modelos.length === 0) {
      pular(MOTIVO_PRECO_SHOPEE.semModelos, { linkDocId, itemId });
      continue;
    }
    if (modelos.length > SHOPEE_UPDATE_PRICE_MAX_MODELS) {
      // ⚠️ Refused, never split: the item is the unit of the ratio check, and
      // two calls would let Shopee judge each half against a sibling the other
      // half is about to move.
      pular(MOTIVO_PRECO_SHOPEE.modelosExcedemLimite, { linkDocId, itemId, modelos });
      continue;
    }

    itens.push({ produtoId: f.anchorId, linkDocId, itemId, modelos });
  }

  return { itens, pulos };
}

/* -------------------------------------------------------------------------- */
/*                                 THE PRICES                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every `precos` map of the family, keyed by the produto that owns it — the
 * anchor AND each child under its OWN id, so {@link precificarItem} can never
 * price a model from the anchor by accident.
 */
export function precosDaFamilia(f: FamiliaDePreco): ReadonlyMap<string, unknown> {
  const mapa = new Map<string, unknown>([[f.anchorId, f.precos]]);
  for (const filho of f.children) mapa.set(filho.produtoId, filho.precos);
  return mapa;
}

/**
 * **One planned item, priced.** Each model's price is its CHILD's own
 * `precos[tabelaId]` — the source step 11 publishes from — and a no-model
 * item's single price is the ANCHOR's. Never the anchor's for a model: a
 * propagated parent price is materialised into each child's map by the
 * produto trigger, and reading the anchor here would make publish and sync
 * disagree on the same listing.
 *
 * Every price goes through `precoDaTabela`, which rounds to the centavo and
 * checks positivity AFTER rounding — a stored `0.004` is "no price", never a
 * zero price. A missing price is NOT decided here: the alvo carries `null`
 * and the sender decides whether the item still sends (its ratio check needs
 * every model in view).
 */
export function precificarItem(
  item: ItemPlanejadoPreco,
  precosPorProduto: ReadonlyMap<string, unknown>,
  tabelaId: string,
): ItemDePreco {
  const precoDe = (produtoId: string): number | null =>
    precoDaTabela(precosPorProduto.get(produtoId), tabelaId);

  if (item.modelos.length === 0) {
    return {
      produtoId: item.produtoId,
      linkDocId: item.linkDocId,
      itemId: item.itemId,
      semModelos: true,
      alvos: [
        {
          modelId: SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
          produtoId: item.produtoId,
          varLinkDocId: null,
          precoAlvo: precoDe(item.produtoId),
        },
      ],
    };
  }

  return {
    produtoId: item.produtoId,
    linkDocId: item.linkDocId,
    itemId: item.itemId,
    semModelos: false,
    alvos: item.modelos.map((modelo) => ({
      modelId: modelo.modelId,
      produtoId: modelo.produtoId,
      varLinkDocId: modelo.varLinkDocId,
      precoAlvo: precoDe(modelo.produtoId),
    })),
  };
}
