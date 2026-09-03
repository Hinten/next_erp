/**
 * Variation-children orchestration (IO layer, ML→ERP) — issue #520, extended
 * for User-Products (#521). Called from `import.ts` once the parent produto +
 * its `produtoMercadoLivre` link exist: writes one child produto per usable
 * entry — its own produto doc, `variacaoMercadoLivre` link, estoque, and the
 * legacy `marketplace` denorm — using the taxonomy resolved by
 * `importTaxonomia` (#519) and the pure assembly in
 * `importCore.assembleVariationChildPlan`.
 *
 * Two doc-id schemes, selected by the optional `up` param (mirrors the legacy
 * `generateLocalId` scheme either way, so a re-import from either app
 * converges on the SAME docs):
 *  - legacy `variations[]` (`up` omitted): child produto id reused from an
 *    existing link/SKU match, else `sha256(parentProdutoId|variationId)` (NOT
 *    the ML variation's own `seller_custom_field`, for the same collision
 *    reason as the parent); link doc id reused when resolved, else the legacy
 *    fixed-width form `'XMLB000000000000000' + itemId + 'vMLB' + variationId`
 *    (`models.dart:1585-1587`); the child link resolves by its numeric `id`
 *    field scoped to the parent link;
 *  - User-Products (`up: { parentLinkDocId }`): child produto id AND its link
 *    doc id are the SAME string, `'XMLB000000000000000' + parentLinkDocId +
 *    'vMLB' + memberItemId` (`models.dart:1585-1587` + `produtos.dart:718,764`
 *    — note the first segment is the PARENT'S OWN PML DOC id, not the ML item
 *    id); the child link resolves by its string `itemId` field (the member's
 *    own MLB id) scoped to the parent link, not a numeric `id`.
 *
 * Either scheme only mints an id once `resolveExistingChild` has failed all
 * THREE reuse rules — link, SKU, then variation combination (#801). The third
 * one is what makes an ERP-FIRST catalogue safe: children created in the ERP or
 * the Flutter app, never linked to ML and without a matching `SELLER_SKU`, are
 * invisible to the first two, so before it existed the first import minted a
 * whole SECOND set of children (duplicate stock rows, duplicate denorm entries,
 * a split catalogue to merge by hand).
 *
 * No photo import here (legacy parity): `variations[].picture_ids` /
 * User-Products per-member pictures are never imported — only the
 * parent-level `item.pictures` are (handled by `import.ts` itself, via
 * `importPhotos.ts`, after this module returns).
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { type MappedMlVariation, idLocalMercadoLivre } from '@delfrance/integrations-mercado-livre';
import { type MlModeracao, sameCombo } from '@delfrance/schemas';
import {
  estoqueCollection,
  produtoCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  type FilhoMedidas,
  type ImportOptions,
  type VariationChildAssembleArgs,
  assembleVariationChildPlan,
  medidasEfetivas,
  resolveVariationCombo,
} from './importCore';
import { type TaxonomiaResolution } from './taxonomiaCore';
import { isAlreadyExists } from '@delfrance/data/admin';
import { lastSegment } from '../core/linkRefs';

/** The `parent` block `assembleVariationChildPlan` expects — kept in sync via indexed access. */
type VariationParentInfo = VariationChildAssembleArgs['parent'];

export interface ImportVariationChildrenDeps {
  db: Firestore;
  integracaoId: string;
  options: ImportOptions;
  depositoOuterRef: string | null;
  /** Single timestamp for the whole import run (hoisted by `import.ts`). */
  now: number;
}

export interface ImportVariationChildrenResult {
  total: number;
  created: number;
  /**
   * Each child's dimensions AFTER this call's write, in call order — what
   * `rollupDimensoesDosFilhos` reads to repair a blank parent (#1087).
   *
   * ⚠️ Returned rather than re-read: the loop already holds both halves (the raw
   * child doc and the patch just applied), so folding them here costs ZERO extra
   * Firestore reads. A re-read would also be wrong-ish — it could observe a
   * concurrent writer and make the parent adopt a value this import never wrote.
   *
   * ⚠️ Call order is the caller's stable order (the imported member first), which
   * is what makes the rollup's donor choice deterministic — see its doc.
   */
  medidas: FilhoMedidas[];
}

/**
 * User-Products mode switch: when set, every child in this call resolves +
 * mints ids via the User-Products scheme (see the module doc) instead of the
 * legacy `variations[]` scheme. `parentLinkDocId` is the parent's OWN
 * `produtoMercadoLivre` link doc id (resolved-existing or freshly minted by
 * `import.ts`) — the first segment of the fixed-width child id/link-id string.
 */
export interface ImportVariationChildrenUpOptions {
  parentLinkDocId: string;
  /**
   * The member item's own raw ML status (#1142). Under User Products each member
   * IS its own listing, so this is the item's own `status`/`sub_status` — the
   * durable input the family `estado` fold reads.
   */
  status: string | null;
  subStatus: string[] | null;
  /**
   * The member item's own `user_product_id` (#706) — the stock identity on a
   * multiorigin conta. Carried here rather than re-derived because the caller
   * already mapped the member's ML item; see the field's docblock on
   * `variacaoMercadoLivreLinkSchema`.
   */
  userProductId: string | null;
  /**
   * ML's active moderations on the member item (#1087), read by `import.ts`
   * beside the `status`/`sub_status` above and written in the same patch as them.
   * `null` = "never asked" and leaves the stored value alone; see
   * `ImportAssembleArgs.moderacoes`.
   */
  moderacoes: MlModeracao[] | null;
}

export async function importVariationChildren(
  deps: ImportVariationChildrenDeps,
  parent: VariationParentInfo,
  mappedVariations: readonly MappedMlVariation[],
  taxonomia: readonly TaxonomiaResolution[],
  up?: ImportVariationChildrenUpOptions,
): Promise<ImportVariationChildrenResult> {
  const { db, integracaoId, options, depositoOuterRef, now } = deps;
  const depositoId = depositoOuterRef ? lastSegment(depositoOuterRef) : null;
  let created = 0;
  const medidas: FilhoMedidas[] = [];

  // The parent's existing children, read AT MOST ONCE per call and only when a
  // variation actually reaches the combination rule — a steady-state re-import
  // resolves everything by link and pays zero extra reads. Memoised on the
  // PROMISE, so a future concurrent caller can't double-issue the query.
  let siblingsPromise: Promise<SiblingChild[]> | null = null;
  const loadSiblings = () => (siblingsPromise ??= readSiblingChildren(db, parent.produtoId));

  for (const mappedVariation of mappedVariations) {
    const resolved = await resolveExistingChild({
      db,
      mappedVariation,
      taxonomia,
      parentProdutoId: parent.produtoId,
      parentLinkOuterRef: parent.linkOuterRef,
      matchByItemId: up != null,
      loadSiblings,
    });
    const fixedWidthId = up
      ? idLocalMercadoLivre(up.parentLinkDocId, mappedVariation.variationId)
      : null;
    const produtoId =
      resolved?.produtoId ??
      fixedWidthId ??
      sha256(`${parent.produtoId}|${mappedVariation.variationId}`);
    const linkDocId =
      resolved?.linkDocId ??
      fixedWidthId ??
      idLocalMercadoLivre(parent.mlItemId, mappedVariation.variationId);

    const ref = produtoCollection.docRef(db, {}, produtoId);
    const existingProduto = await readRaw(ref);
    let isCreate = existingProduto == null;

    const existingStock =
      isCreate || !depositoId ? null : await readEstoque(db, produtoId, depositoId);

    const args: VariationChildAssembleArgs = {
      mappedVariation,
      taxonomia,
      parent,
      options,
      produtoId,
      isCreate,
      linkDocId,
      integracaoId,
      depositoOuterRef,
      existingProduto,
      existingLinkRaw: resolved?.linkRaw ?? null,
      existingEstoqueQty: existingStock?.quantidade ?? null,
      existingEstoqueReservada: existingStock?.reservada ?? null,
      up: up
        ? {
            itemId: mappedVariation.variationId,
            status: up.status,
            subStatus: up.subStatus,
            userProductId: up.userProductId,
            moderacoes: up.moderacoes,
          }
        : null,
      now,
    };
    let plan = assembleVariationChildPlan(args);
    let stockForWrite = existingStock;
    // Whichever raw doc the FINAL `plan` was assembled from — it becomes
    // `freshProduto` if the create loses the ALREADY_EXISTS race below. Folding
    // the wrong base would report this child's measurements as the loser's.
    let baseProduto = existingProduto;

    // produto (create-only `.create()`, mirroring the parent's collision guard —
    // but on ALREADY_EXISTS this does a LOCAL re-read + re-assemble on the update
    // path, not a full `importProduto`-style recursion). The retry re-reads
    // EVERYTHING the plan depends on (produto, estoque, link) — not just the
    // produto — so the writes below can't apply the stale create-path plan and
    // clobber the concurrent winner's estoque (reservada/dataCriacao) or link.
    if (plan.produto) {
      if (plan.produto.full) {
        try {
          await ref.create(produtoCollection.parse(plan.produto.data));
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
          isCreate = false;
          const freshProduto = await readRaw(ref);
          baseProduto = freshProduto;
          stockForWrite = depositoId ? await readEstoque(db, produtoId, depositoId) : null;
          const freshLink = await readRaw(
            variacaoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId),
          );
          plan = assembleVariationChildPlan({
            ...args,
            isCreate: false,
            existingProduto: freshProduto,
            existingLinkRaw: freshLink ?? args.existingLinkRaw,
            existingEstoqueQty: stockForWrite?.quantidade ?? null,
            existingEstoqueReservada: stockForWrite?.reservada ?? null,
          });
          if (plan.produto) {
            await produtoCollection.merge(db, {}, produtoId, plan.produto.data);
          }
        }
      } else {
        await produtoCollection.merge(db, {}, produtoId, plan.produto.data);
      }
    }

    // estoque (create = set at the canonical id; overwrite = merge quantidade into
    // the row we actually READ — keeps reservada).
    //
    // ⚠️ The merge targets `stockForWrite.docId`, NOT `plan.estoque.docId`. The plan
    // always names the canonical `makeEstoqueUid(produtoId, depositoId)`, but
    // `readEstoque` matches on `depositoOuterRef` under ANY doc id — and Flutter-era
    // rows sit at auto-ids (`aplicarBalanco.ts` counts them as `extras`). Merging into
    // the canonical id is an UPSERT, so on a non-canonical row it would CREATE a second
    // estoque doc for the same (produto, depósito) carrying neither `parentId` nor
    // `depositoOuterRef` — canonical-id readers would then see the phantom while
    // `readEstoque` kept finding the original, and every re-import would widen the gap.
    // That is the very duplicate-stock harm #801 exists to remove, and rule 3 is what
    // puts Flutter-created children (the ones with non-canonical ids) on this path.
    if (plan.estoque) {
      if (stockForWrite == null) {
        await estoqueCollection
          .docRef(db, { produtoId }, plan.estoque.docId)
          .set(estoqueCollection.parse(plan.estoque.data));
      } else {
        await estoqueCollection.merge(db, { produtoId }, stockForWrite.docId, {
          quantidade: plan.estoque.data.quantidade,
          ultimaModificacao: plan.estoque.data.ultimaModificacao,
        });
      }
    }

    // variacaoMercadoLivre link (full set, spread-existing — schema is .passthrough())
    await variacaoMercadoLivreLinkCollection
      .docRef(db, { produtoId }, linkDocId)
      .set(variacaoMercadoLivreLinkCollection.parse(plan.link));

    // Legacy denorm (DEAD WEIGHT; #992, audited in #961 — no query consumers in
    // this repo, deleted at the decommission. Canonical note on
    // `produtoSchema`; the lock list is at `publish.ts`'s parent stamp).
    // Child entries carry `externalParentId` (the
    // parent's ML item id), unlike the parent's own entry which omits it
    // (models.dart:2325). User-Products children also carry
    // `relevantData.isUserProductModel` (`plan.denorm.relevantData`, set by
    // `assembleVariationChildPlan` only when `up` was passed) — omitted entirely
    // for a legacy variations[] child, so that path's denorm shape stays
    // byte-identical.
    //
    // ⚠️ `integracoesComProduto` is NOT stamped here (#920) — the
    // `variacaoMercadoLivre` link written just above carries `contaOuterRef`,
    // and `onVariacaoMercadoLivreLinkChanged` derives the array from it.
    await produtoCollection.docRef(db, {}, produtoId).update({
      marketplace: FieldValue.arrayUnion({
        integracaoUid: integracaoId,
        externalId: plan.denorm.externalId,
        externalParentId: plan.denorm.externalParentId,
        ...(plan.denorm.relevantData ? { relevantData: plan.denorm.relevantData } : {}),
      }),
      marketplaceIds: FieldValue.arrayUnion(plan.denorm.externalId),
    });

    if (isCreate) created += 1;
    medidas.push({ produtoId, ...medidasEfetivas(baseProduto, plan.produto?.data) });
  }

  return { total: mappedVariations.length, created, medidas };
}

/* -------------------------------------------------------------------------- */

interface ResolvedChild {
  produtoId: string;
  /** Existing link doc id + raw (when resolved via the link); null via SKU/combo. */
  linkDocId: string | null;
  linkRaw: Record<string, unknown> | null;
}

/** One existing child of the parent, in the shape the combination rule needs. */
interface SiblingChild {
  id: string;
  /** Raw `variacoesUid` (non-string entries dropped); `[]` when absent. */
  variacoesUid: string[];
}

interface ResolveExistingChildArgs {
  db: Firestore;
  mappedVariation: MappedMlVariation;
  /** The item-wide taxonomy resolution — filtered down to this variation's own combos. */
  taxonomia: readonly TaxonomiaResolution[];
  parentProdutoId: string;
  parentLinkOuterRef: string;
  matchByItemId: boolean;
  /** Lazy + memoised `paiId == parentProdutoId` read, owned by the caller. */
  loadSiblings: () => Promise<SiblingChild[]>;
}

/**
 * Resolve the ERP child produto for one variation/member. Three rules, tried in
 * order; the first hit wins and `null` means "mint a new child".
 *
 *  1. **Link** — an existing `variacaoMercadoLivre` scoped to THIS parent link (a
 *     collectionGroup query, filtered by the exact `produtoMercadoLivreOuterRef`
 *     string). `matchByItemId` selects the field: legacy `variations[]` (false)
 *     matches the numeric `id` (a variation id is only unique within its own
 *     item, hence the parent-link scoping); User-Products (true) matches the
 *     string `itemId` (the member's own MLB id — globally unique, but still
 *     parent-scoped for symmetry/defense-in-depth).
 *  2. **SKU** — `sku` + `paiId == parentProdutoId`, accepted only when it is
 *     UNAMBIGUOUS (#1067, see below), reusing that child's existing link for this
 *     parent if present (else a re-import mints a second link doc).
 *  3. **Variation combination** (#801) — an existing child of the same parent
 *     whose `variacoesUid` is the same SET as this variation's. This is the
 *     ERP-first rule: rules 1 and 2 can only see a catalogue ML already knows
 *     about, so without it a first import duplicates every child a user built in
 *     the ERP or in Flutter.
 *
 * ## Why rule 2 declines an ambiguous SKU (#1067)
 * Sibling SKUs are legally non-unique here, and that is by construction rather
 * than corruption: a child's SKU is DERIVED as `parentSku + variante.codigo`
 * (`variacoes.ts`), so two variants without a `codigo` yield two siblings sharing
 * one non-empty SKU — which is why `findDuplicateSkus` exists and why the web
 * "Gerar Variações" grid blocks the save. Flutter-era rows add plenty more: that
 * app never validated a typed SKU at all, and its own `balancoEstoque` has a live
 * "SKU duplicado" branch. With `limit(1)` and no `orderBy` this rule bound
 * whichever document the index happened to return first, and a wrong bind is
 * expensive — the child gains a real link at a deterministic id, its `precos` map
 * is replaced wholesale under `sobrescreverPreco`, and `orderProdutoResolve`
 * later routes incoming ML ORDERS through that link. So two guards:
 *  - **`limit(2)`, accept only on exactly one hit** — the second document is not a
 *    candidate, it is the ambiguity signal. On two hits the SKU cannot decide, so
 *    resolution falls through to rule 3, which picks by combination;
 *  - **a candidate whose link to THIS parent names a DIFFERENT variation is
 *    rejected**, exactly as in rule 3 — the write would otherwise repoint that
 *    link in place. Free, since `findParentLink` already ran.
 *
 * ⚠️ Deliberately NOT guarded: a SKU match whose `variacoesUid` contradicts the
 * variation but is the only hit is still accepted. Rejecting it would re-open the
 * duplication #801 closed — under the taxonomy ceiling below the resolver mints a
 * fresh grupo, so the fake paths differ and rule 3 misses too, leaving the SKU as
 * the only rung that still binds that catalogue. Ambiguity, not disagreement, is
 * what this rule refuses to guess about. The residue: two ML variations sharing
 * one `SELLER_SKU` on a FIRST import, where the colliding sibling does not exist
 * yet and carries no link, so neither guard can see it.
 *
 * ## Why rule 3 is re-derived, not transcribed
 * The legacy importer ran `paiId == x` AND `variacoesUid == <array>`
 * (`models.dart:1176-1181`) — Firestore array equality, so order- AND
 * length-sensitive. Its probe array is built in raw ML `attribute_combinations`
 * order and never de-duplicated, while a child written by the produto UI is
 * stored de-duped and re-sorted by group `ordem`; the two rarely coincide, so
 * the legacy query missed most Flutter-created children — exactly the case it
 * was supposed to catch. Legacy's own UI used an order-INSENSITIVE comparison,
 * which is what {@link sameCombo} implements (and what the "Gerar Variações"
 * grid and `reconcileStagedChildren` already use for the ERP-side twin of this
 * problem). Re-deriving also keeps this off a new composite index: `paiId ==`
 * alone rides the existing `produtos(paiId ASC, nome ASC)` entry by prefix,
 * whereas `variacoesUid ==` would need one declared and deployed.
 *
 * Two guards make rule 3 safe:
 *  - an **empty combination never matches** (legacy's `variacoesPath.isNotEmpty`),
 *    otherwise an unmapped variation would claim any combo-less child;
 *  - a candidate already carrying a link to THIS parent for a DIFFERENT variation
 *    is rejected, so two ML variations can never collapse onto one ERP child.
 *    That check is per-candidate rather than a per-call "claimed" set because
 *    User-Products invokes this module once per family member — an in-run set
 *    could not see its siblings. Legacy had no such guard.
 *
 * ⚠️ Reuse is NOT "leave the child alone". It takes the `isCreate === false` path,
 * which preserves the child's own `sku` (`fillNull`) and `variacoesUid`
 * (`fillEmptyArray`) — but under `sobrescreverPreco`, which DEFAULTS TO TRUE
 * (`DEFAULT_IMPORT_OPTIONS`), it also replaces the child's whole `precos` map with
 * the ML parent's (`importCore.ts`, the update branch). That is the documented
 * meaning of the option and matches what the SKU rule has always done — note the
 * deliberate asymmetry with `sobrescreverEstoque`, which defaults to FALSE so a
 * re-import never clobbers ERP stock. Rule 3 makes it reachable on the ERP-first
 * path, where the operator's own price table is the thing being replaced, so an
 * operator enabling the import on such a catalogue is choosing that. Pinned by a
 * test in `import.test.ts`; changing it is an option-semantics decision, not a
 * bug fix.
 *
 * ⚠️ Ceiling, inherited from the taxonomy matcher, not from this rule: when the
 * ERP's grupo matches none of `taxonomiaCore`'s rungs (attribute id, exact
 * `nome`, or `tipo` for SIZE/COLOR) the resolver CREATES a new grupo, the fake
 * paths differ, and the duplicate still happens. Legacy had the same ceiling.
 */
async function resolveExistingChild(args: ResolveExistingChildArgs): Promise<ResolvedChild | null> {
  const { db, mappedVariation, taxonomia, parentProdutoId, parentLinkOuterRef, matchByItemId } =
    args;
  const variationId = mappedVariation.variationId;
  const childSku = mappedVariation.sku;

  if (matchByItemId) {
    const linkSnap = await variacaoMercadoLivreLinkCollection
      .groupQuery(db)
      .where('itemId', '==', variationId)
      .where('produtoMercadoLivreOuterRef', '==', parentLinkOuterRef)
      .limit(1)
      .get();
    const d = linkSnap.docs[0];
    if (d) {
      const produtoId = d.ref.parent?.parent?.id;
      if (produtoId) {
        return { produtoId, linkDocId: d.id, linkRaw: d.data() as Record<string, unknown> };
      }
    }
  } else {
    const numericId = numericVariationId(variationId);
    if (numericId != null) {
      // Both filters server-side: a variation id is only unique within its item, so
      // filtering the parent-link ref in memory would pull every same-id link doc
      // across the whole DB. Exact string equality is safe here (migrated docs
      // carry the same `documents/...` form) — unlike the parent's tolerant refMatchesIntegracao.
      const linkSnap = await variacaoMercadoLivreLinkCollection
        .groupQuery(db)
        .where('id', '==', numericId)
        .where('produtoMercadoLivreOuterRef', '==', parentLinkOuterRef)
        .limit(1)
        .get();
      const d = linkSnap.docs[0];
      if (d) {
        const produtoId = d.ref.parent?.parent?.id;
        if (produtoId) {
          return { produtoId, linkDocId: d.id, linkRaw: d.data() as Record<string, unknown> };
        }
      }
    }
  }

  // Rule 2 — SKU. `limit(2)`, not `limit(1)`: the second document is never a
  // candidate, it is the AMBIGUITY SIGNAL (#1067). Two hits mean the SKU cannot
  // decide, so we decline and let rule 3 pick by combination. Same
  // limit-2-as-a-detector trick `resolveSkuBalanco.ts` uses to tell "duplicado"
  // from "encontrado" — one extra document read buys the distinction.
  if (childSku) {
    const skuSnap = await produtoCollection
      .ref(db, {})
      .where('sku', '==', childSku)
      .where('paiId', '==', parentProdutoId)
      .limit(2)
      .get();
    const doc = skuSnap.docs.length === 1 ? skuSnap.docs[0] : undefined;
    if (doc) {
      // Reuse an existing link to THIS parent under the SKU-matched child, so a
      // re-import updates it rather than creating a second link doc — but only
      // when that link is not already spoken for. `assembleVariationChildPlan`
      // overwrites the naming field unconditionally, so adopting a link that names
      // a DIFFERENT variation would silently repoint it in place and strand that
      // variation. Same guard and same fail-safe direction as rule 3, and free:
      // the link doc is already in hand.
      const existingLink = await findParentLink(db, doc.id, parentLinkOuterRef);
      if (!existingLink || !linkNamesOtherVariation(existingLink.raw, variationId, matchByItemId)) {
        return {
          produtoId: doc.id,
          linkDocId: existingLink?.id ?? null,
          linkRaw: existingLink?.raw ?? null,
        };
      }
    }
  }

  // Rule 3 — variation combination (#801). Skipped entirely when this variation
  // resolved to nothing, which is also what keeps the lazy sibling read unpaid on
  // a listing whose attributes the taxonomy could not map.
  const { varianteFakes } = resolveVariationCombo(mappedVariation.combos, taxonomia);
  if (varianteFakes != null && varianteFakes.length > 0) {
    for (const sibling of await args.loadSiblings()) {
      if (sibling.variacoesUid.length === 0) continue;
      if (!sameCombo(sibling.variacoesUid, varianteFakes)) continue;

      const existingLink = await findParentLink(db, sibling.id, parentLinkOuterRef);
      // A link to this parent naming a DIFFERENT variation means the child is already
      // spoken for — leave it alone and keep looking, rather than merging two ML
      // variations onto one produto. A link naming NOTHING readable is not that: see
      // the ⚠️ on `linkNamesOtherVariation`.
      if (existingLink && linkNamesOtherVariation(existingLink.raw, variationId, matchByItemId)) {
        continue;
      }
      return {
        produtoId: sibling.id,
        linkDocId: existingLink?.id ?? null,
        linkRaw: existingLink?.raw ?? null,
      };
    }
  }

  return null;
}

/**
 * The `variacaoMercadoLivre` link under `produtoId` that points at THIS parent
 * link, if any. A child holds one link per (parent link, integração), so the
 * subcollection is tiny and an in-memory filter beats a second indexed query.
 */
async function findParentLink(
  db: Firestore,
  produtoId: string,
  parentLinkOuterRef: string,
): Promise<{ id: string; raw: Record<string, unknown> } | null> {
  const linkSub = await variacaoMercadoLivreLinkCollection.ref(db, { produtoId }).get();
  for (const l of linkSub.docs) {
    const raw = l.data() as Record<string, unknown>;
    if (raw.produtoMercadoLivreOuterRef === parentLinkOuterRef) return { id: l.id, raw };
  }
  return null;
}

/**
 * Does this link doc name a variation OTHER than `variationId` — i.e. is the child
 * already claimed by one of its siblings? Reads the same field the rule-1 query keys
 * on (`itemId` for User-Products, `id` for legacy `variations[]`), compared as a
 * string because the legacy `id` is an int but Flutter-written rows may hold a
 * stringified one.
 *
 * ⚠️ An absent/unreadable key answers **FALSE**, deliberately: "names nothing" is not
 * evidence of anyone else's claim, and treating it as one is self-inflicted. The
 * naming field is written as `numericVariationId(variationId)`, which is **`null`
 * whenever the ML variation id is non-numeric** — a shape `itemVariationSchema`
 * accepts outright ("ML has sent numeric and (rarely) string ids over time"). So this
 * importer writes null-id links itself; reading one back as "spoken for" made a
 * re-import decline the link it had just written, and mint a duplicate child on every
 * single run. Pinned by the three-import test in `import.test.ts`.
 */
function linkNamesOtherVariation(
  raw: Record<string, unknown>,
  variationId: string,
  matchByItemId: boolean,
): boolean {
  const key = matchByItemId ? raw.itemId : raw.id;
  if (typeof key !== 'string' && typeof key !== 'number') return false;
  return String(key) !== variationId;
}

/**
 * The parent's existing children (`paiId ==`), projected to what rule 3 compares.
 * Raw reads — `produtoCollection.ref` carries no converter, and a full parse here
 * would be both wasted work and a needless failure surface on Flutter-era rows.
 *
 * ⚠️ Rides the existing `produtos(paiId ASC, nome ASC)` composite by prefix — do
 * not add an `orderBy`/second filter without checking `firestore.indexes.json`
 * first; Enterprise auto-creates nothing and an unindexed query silently
 * full-scans onto the invoice.
 */
async function readSiblingChildren(
  db: Firestore,
  parentProdutoId: string,
): Promise<SiblingChild[]> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', parentProdutoId).get();
  return snap.docs.map((d) => {
    const raw = (d.data() ?? {}) as { variacoesUid?: unknown };
    return {
      id: d.id,
      variacoesUid: Array.isArray(raw.variacoesUid)
        ? raw.variacoesUid.filter((u): u is string => typeof u === 'string')
        : [],
    };
  });
}

/**
 * ML variation ids are numeric on the wire (`itemVariationSchema.id`) even
 * though `MappedMlVariation.variationId` is stringified; null when non-numeric.
 * Same plain-integer regex as `importCore.ts`'s `numericVariationId` — the
 * resolve query must key on the SAME numeric value `assembleVariationChildPlan`
 * stamps onto a freshly-created link's `id` field, or a re-import would miss it.
 */
function numericVariationId(variationId: string): number | null {
  return /^-?\d+$/.test(variationId) ? Number(variationId) : null;
}

/**
 * Stable hex hash for deterministic child produto ids (legacy-id convergence) —
 * a local copy of `import.ts`'s helper (same 3-liner) rather than a cross-import,
 * to avoid a module cycle between the parent and children orchestrators.
 */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function readRaw(
  ref: FirebaseFirestore.DocumentReference,
): Promise<Record<string, unknown> | null> {
  const snap = await ref.get();
  return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
}

/**
 * The child's stock row for `depositoId`, matched by `depositoOuterRef` under ANY
 * doc id — Flutter wrote these at auto-ids, so keying on the canonical
 * `makeEstoqueUid` would miss them.
 *
 * Returns `docId` alongside the quantities precisely because of that: the caller
 * must write back to the row it read, not to the canonical id (see the ⚠️ on the
 * estoque write above).
 */
async function readEstoque(
  db: Firestore,
  produtoId: string,
  depositoId: string,
): Promise<{ docId: string; quantidade: number; reservada: number } | null> {
  const snap = await estoqueCollection.ref(db, { produtoId }).get();
  for (const d of snap.docs) {
    const data = d.data() as {
      depositoOuterRef?: unknown;
      quantidade?: unknown;
      quantidadeReservada?: unknown;
    };
    if (
      typeof data.depositoOuterRef === 'string' &&
      lastSegment(data.depositoOuterRef) === depositoId
    ) {
      return {
        docId: d.id,
        quantidade: typeof data.quantidade === 'number' ? data.quantidade : 0,
        reservada: typeof data.quantidadeReservada === 'number' ? data.quantidadeReservada : 0,
      };
    }
  }
  return null;
}
