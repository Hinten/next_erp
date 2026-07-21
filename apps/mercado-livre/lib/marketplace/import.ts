/**
 * Product-import orchestration (IO layer, ML→ERP): fetches a Mercado Livre item,
 * maps it (plugin `importItem`), resolves/creates the ERP produto, and writes the
 * produto + extraData + estoque + `produtoMercadoLivre` link in the exact Flutter
 * wire shape (dual-run). The inverse of `publish.ts`.
 *
 * Three ML listing models, all supported:
 *  - simple (no `variations[]`, no `family_name`) — one produto;
 *  - legacy `variations[]` (#520) — one child produto per usable variation,
 *    with the shared `grupoDeVariacoes`/`Variante` taxonomy resolved via
 *    `importTaxonomia` and the children written by `importVariations.ts`
 *    (`importVariationChildren`);
 *  - User-Products / `family_name` (#521) — each variation is its OWN MLB
 *    item; a single import call writes the FAMILY parent (deterministic id
 *    `sha256(integracaoId+familyId)`, sku = familyId) + the called member as a
 *    child (same `importVariationChildren`, in its `up` mode — see that
 *    module's doc), then best-effort fans out to the family's sibling MLB ids
 *    (`importFamily.ts`) and imports each with fan-out disabled (no
 *    recursion) — a per-sibling failure is recorded, not fatal to the request.
 * Existing ERP data is preserved across all three: parent fields fill-null,
 * stock never clobbered unless `sobrescreverEstoque` (and never written on a
 * PARENT that has variations/members at all — stock lives on the children).
 *
 * Dedup / dual-run convergence: the produto is resolved by the link doc's `id`
 * (== ML item id for a simple listing, == family id for User-Products; a
 * collectionGroup query — the same key the Flutter app matches on), then by
 * `sku`. A FRESH produto's id is always a deterministic hash — NOT the
 * seller_custom_field, which ML does not keep unique across a seller's items
 * (reusing it as the id would collide two distinct listings onto one produto).
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type MappedUpMember,
  type MercadoLivreApi,
  type MlItemAttribute,
  MercadoLivreError,
  mapMlItemToImport,
  mapMlVariationsToImport,
  mapUpMemberToImport,
  skuGuessFromVariations,
} from '@delfrance/integrations-mercado-livre';
import { PRODUTO_EXTRA_DATA_DOC_ID, toOuterRef } from '@delfrance/schemas';
import {
  estoqueCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  type ImportOptions,
  type ImportPlan,
  DEFAULT_IMPORT_OPTIONS,
  MercadoLivreImportError,
  assembleImportPlan,
} from './importCore';
import { importCategoriaChain } from './importCategoria';
import { resolveTaxonomia } from './importTaxonomia';
import { importVariationChildren } from './importVariations';
import { resolveFamilySiblingIds } from './importFamily';
import { isAlreadyExists } from './grpcErrors';
import { lastSegment, refMatchesIntegracao } from './linkRefs';
import { type Bucket } from './arquivoUpload';
import { importProdutoPhotos } from './importPhotos';

export interface ImportDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  /** The account's ML seller id (integração `user_id`) — the ownership guard. */
  sellerUserId: number | null;
  tabelaNormalOuterRef: string | null;
  tabelaPromocionalOuterRef: string | null;
  depositoOuterRef: string | null;
  /** Storage bucket for photo import (#439); omit to skip photos (e.g. tests). */
  bucket?: Bucket;
  /** Injectable fetch for the photo download (tests); defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  options?: Partial<ImportOptions>;
  /**
   * User-Products family fan-out switch (#521) — default true (attempt the
   * sibling fan-out). The fan-out itself calls back into `importProduto` with
   * this forced `false` for every sibling, so a family never recurses past one
   * level regardless of how deep a sibling's own family data claims to go.
   */
  familyFanOut?: boolean;
}

export interface ImportResult {
  produtoId: string;
  estado: string;
  nome: string;
  created: boolean;
  /**
   * Child produtos written by THIS call — legacy `variations[]` children
   * (#520) or, for a User-Products member, the single called member's own
   * child (#521). `{ total: 0, created: 0 }` for a simple listing.
   */
  variations: { total: number; created: number };
  /**
   * User-Products family fan-out summary (#521) — set ONLY on the call that
   * ran the fan-out (i.e. `familyFanOut !== false`; never on a sibling call,
   * which always runs with it forced off); `undefined` for a simple or
   * legacy `variations[]` listing.
   */
  family?: {
    /** Sibling MLB ids found for this family (excludes the primary member), after the cap. */
    total: number;
    /** Siblings that imported without error (whether created or re-synced). */
    imported: number;
    /** Of `imported`, how many resulted in a brand-new CHILD produto for that sibling. */
    created: number;
    /** True when the family had more siblings than `importFamily.ts`'s cap allows. */
    capped: boolean;
    failures: Array<{ itemId: string; error: string }>;
  };
}

export async function importProduto(
  deps: ImportDeps,
  itemId: string,
  attempt = 0,
): Promise<ImportResult> {
  const { db, api, integracaoId } = deps;
  const options: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...deps.options };

  const item = await api.getItem(itemId);

  // ---- Guards -----------------------------------------------------------
  if (item.status === 'closed') {
    throw new MercadoLivreImportError([`anúncio ${itemId} está encerrado (status closed)`]);
  }
  if (deps.sellerUserId == null) {
    throw new MercadoLivreImportError(['integração sem user_id — reconecte a conta']);
  }
  if (item.seller_id != null && item.seller_id !== deps.sellerUserId) {
    throw new MercadoLivreImportError([`anúncio ${itemId} pertence a outro vendedor`]);
  }

  // User-Products model (#521) — each variation is its OWN MLB item; this call
  // imports `itemId` as ONE family member (parent + this member as a child),
  // then best-effort fans out to the rest of the family (see the module doc).
  const isUserProduct = item.family_name != null;
  const up: MappedUpMember | null = isUserProduct ? mapUpMemberToImport(item) : null;

  // Legacy `variations[]` model (#520) — the parent's own sku falls back to the
  // strip-6 guess when it has none of its own (`gessSkuFromMercadoLivre` parity);
  // the whole precos map + no per-item stock apply to it (produtos.dart:226-290).
  // Mutually exclusive with User-Products (an ML item never carries both).
  const hasVariations = !isUserProduct && (item.variations?.length ?? 0) > 0;
  const mappedItem = mapMlItemToImport(item);
  const mapped = {
    ...mappedItem,
    sku: mappedItem.sku ?? (hasVariations ? skuGuessFromVariations(item) : null),
  };
  const mappedVariations = hasVariations ? mapMlVariationsToImport(item) : [];
  // A produto that owns children (variations[] OR a User-Products family) never
  // carries its own stock/estoque read below — it lives on the children — and
  // always resolves/creates the shared grupoDeVariacoes/Variante taxonomy.
  const ownsChildren = hasVariations || isUserProduct;
  // The parent-level mapped shape for a User-Products family: `mlItemId`/`sku`
  // are stamped with the FAMILY id (parity — `link.id`/`denormItemId` become the
  // family id, and the parent produto's sku falls back to it), everything else
  // (nome from family_name, dims, price, isUserProductModel, …) is unchanged
  // from the plain item mapping above. Simple/variations[] keep using `mapped`
  // itself — this branch is additive, never touched by those paths.
  const planMapped = isUserProduct
    ? { ...mapped, mlItemId: up!.canonicalId, sku: up!.familyId ?? mapped.sku }
    : mapped;

  // Best-effort description (a missing/failed description never blocks import).
  let descricao: string | null = null;
  try {
    const desc = await api.getItemDescription(itemId);
    descricao = desc.plain_text ?? desc.text ?? null;
  } catch (err) {
    if (!(err instanceof MercadoLivreError)) throw err;
  }

  // One timestamp for the whole run — categoria chain + produto/link writes.
  const now = Date.now();

  // ERP Categoria chain (#442) — best-effort: an ML category-API failure yields
  // null (produto imports without a category); Firestore failures propagate.
  let categoriaOuterRef: string | null = null;
  if (options.importarCategorias && mapped.categoryId) {
    categoriaOuterRef = await importCategoriaChain({ db, api }, mapped.categoryId, now);
  }

  // Variation taxonomy (#519/#520/#521) — match-first, create-if-absent
  // grupoDeVariacoes + Variante for every combo attribute across ALL variations
  // (or, for User-Products, this member's own root `attribute_combinations`),
  // so two children sharing a grupo (e.g. both carry SIZE) resolve/create it
  // exactly once.
  const combos: MlItemAttribute[] = hasVariations
    ? mappedVariations.flatMap((v) => v.combos)
    : isUserProduct
      ? up!.member.combos
      : [];
  const taxonomia = ownsChildren
    ? await resolveTaxonomia({ db }, { combos, integracaoId, now })
    : [];
  const parentGrupoUids = ownsChildren ? uniqueFirstSeen(taxonomia.map((t) => t.grupoUid)) : null;
  const parentVariacoesUid = ownsChildren
    ? uniqueFirstSeen(taxonomia.map((t) => t.varianteFake))
    : null;

  // ---- Resolve the ERP produto (link → sku → deterministic id) ----------
  // User-Products resolves the FAMILY parent via its own 3-step cascade
  // (this member's own link → the family-id link → sku); simple/variations[]
  // keep the existing single-item cascade untouched.
  const resolved = isUserProduct
    ? await resolveExistingUpParent(db, itemId, up!.canonicalId, mapped.sku, integracaoId)
    : await resolveExistingProduto(db, itemId, mapped.sku, integracaoId);
  // A fresh produto id is a deterministic hash — NOT the seller_custom_field,
  // which ML does not keep unique across a seller's items (two items sharing a
  // code would otherwise collide onto one produto and clobber it). The link doc
  // id is likewise deterministic, so a concurrent same-item/family import
  // converges. User-Products uses the FAMILY id (parity — `models.dart:1025-1029`
  // / `1292`), not the per-item scheme simple/variations[] items use.
  const produtoId =
    resolved?.produtoId ??
    (isUserProduct
      ? sha256(`${integracaoId}${up!.canonicalId}`)
      : sha256(`${deps.sellerUserId}|${itemId}`));
  const linkDocId =
    resolved?.linkDocId ??
    (isUserProduct
      ? `100000000000000000${up!.canonicalId}`
      : `ml-${sha256(`${integracaoId}|${itemId}`).slice(0, 40)}`);

  // One read decides create vs update (and closes the collision hole above).
  const existingProduto = await readRaw(produtoCollection.docRef(db, {}, produtoId));
  const isCreate = existingProduto == null;

  const existingExtra = isCreate
    ? null
    : await readRaw(
        produtoExtraDataCollection.docRef(db, { produtoId }, PRODUTO_EXTRA_DATA_DOC_ID),
      );
  const existingLinkRaw = resolved?.linkRaw ?? null;
  const depositoId = deps.depositoOuterRef ? lastSegment(deps.depositoOuterRef) : null;
  // A produto that owns children never carries its own stock (it lives on the
  // children) — skip the read, the plan nulls the estoque write regardless.
  const existingStock =
    isCreate || !depositoId || ownsChildren ? null : await readEstoque(db, produtoId, depositoId);

  // ---- Assemble + execute ----------------------------------------------
  const plan = assembleImportPlan({
    mapped: planMapped,
    options,
    produtoId,
    isCreate,
    linkDocId,
    integracaoId,
    tabelaNormalId: deps.tabelaNormalOuterRef ? lastSegment(deps.tabelaNormalOuterRef) : null,
    tabelaPromoId: deps.tabelaPromocionalOuterRef
      ? lastSegment(deps.tabelaPromocionalOuterRef)
      : null,
    depositoOuterRef: deps.depositoOuterRef,
    descricao,
    categoriaOuterRef,
    existingProduto,
    existingLinkRaw,
    existingExtra,
    existingEstoqueQty: existingStock?.quantidade ?? null,
    existingEstoqueReservada: existingStock?.reservada ?? null,
    hasVariations: ownsChildren,
    parentGrupoUids,
    parentVariacoesUid,
    now,
  });

  // produto (create = create-only; update = merge patch). `.create()` (not `.set()`)
  // so a rare concurrent same-item create can't full-overwrite edits made by the
  // winner between our read and write — on ALREADY_EXISTS we re-run once (the
  // produto now exists → the update path).
  if (plan.produto) {
    const ref = produtoCollection.docRef(db, {}, produtoId);
    if (plan.produto.full) {
      try {
        await ref.create(produtoCollection.parse(plan.produto.data));
      } catch (err) {
        if (isAlreadyExists(err) && attempt < 1) return importProduto(deps, itemId, attempt + 1);
        throw err;
      }
    } else {
      await produtoCollection.merge(db, {}, produtoId, plan.produto.data);
    }
  }

  // Prices: dotted-path update (never re-validates the legacy precos map; clears a
  // promo that ended on ML). On create the prices are already folded into the doc.
  if (plan.precosOps) {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(plan.precosOps.set)) patch[`precos.${k}`] = v;
    for (const k of plan.precosOps.delete) patch[`precos.${k}`] = FieldValue.delete();
    if (Object.keys(patch).length > 0) {
      await produtoCollection.docRef(db, {}, produtoId).update(patch);
    }
  }

  // extraData (condicao / descricao)
  if (plan.extra) {
    await produtoExtraDataCollection.merge(
      db,
      { produtoId },
      PRODUTO_EXTRA_DATA_DOC_ID,
      plan.extra,
    );
  }

  // estoque (create = set; overwrite = merge quantidade — keeps reservada)
  if (plan.estoque) {
    if (existingStock == null) {
      await estoqueCollection
        .docRef(db, { produtoId }, plan.estoque.docId)
        .set(estoqueCollection.parse(plan.estoque.data));
    } else {
      await estoqueCollection.merge(db, { produtoId }, plan.estoque.docId, {
        quantidade: plan.estoque.data.quantidade,
        ultimaModificacao: plan.estoque.data.ultimaModificacao,
      });
    }
  }

  // produtoMercadoLivre link (full set, spread-existing)
  await produtoMercadoLivreLinkCollection
    .docRef(db, { produtoId }, linkDocId)
    .set(produtoMercadoLivreLinkCollection.parse(plan.link));

  // Dual-run denorm (DEPRECATED arrays — legacy consumers only; #431). Runs after
  // the produto exists (create sets it first). arrayUnion so a concurrent Flutter
  // write to the same shared arrays isn't dropped. User-Products stamps
  // `relevantData.isUserProductModel` on the PARENT's own entry too (parity —
  // `ProdMarketplace.relevantData`, `models.dart:2333`); omitted for simple/
  // variations[] so their denorm shape stays byte-identical.
  await produtoCollection.docRef(db, {}, produtoId).update({
    marketplace: FieldValue.arrayUnion({
      integracaoUid: integracaoId,
      externalId: plan.denormItemId,
      ...(isUserProduct ? { relevantData: { isUserProductModel: true } } : {}),
    }),
    marketplaceIds: FieldValue.arrayUnion(plan.denormItemId),
    integracoesComProduto: FieldValue.arrayUnion(integracaoId),
  });

  // Children (#520 legacy variations[] / #521 User-Products member), run after
  // the parent's own produto/link exist (children reference the parent link's
  // outer-ref). No-op ({ total: 0, created: 0 }) for a simple listing.
  let variationsResult = { total: 0, created: 0 };
  if (ownsChildren) {
    const parentLinkOuterRef = toOuterRef(`produtos/${produtoId}/produtoMercadoLivre/${linkDocId}`);
    const parentInfo = {
      produtoId,
      precos: resolveParentPrecosForChildren(isCreate, plan, existingProduto),
      linkOuterRef: parentLinkOuterRef,
      mlItemId: isUserProduct ? up!.canonicalId : itemId,
      ehKit: mapped.ehKit,
      ehUsado: mapped.ehUsado,
      categoriaOuterRef,
      dims: {
        pesoLiquidoKg: mapped.pesoLiquidoKg,
        pesoBrutoKg: mapped.pesoBrutoKg,
        alturaCm: mapped.alturaCm,
        larguraCm: mapped.larguraCm,
        profundidadeCm: mapped.profundidadeCm,
      },
    };
    variationsResult = isUserProduct
      ? await importVariationChildren(
          { db, integracaoId, options, depositoOuterRef: deps.depositoOuterRef, now },
          parentInfo,
          [up!.member],
          taxonomia,
          { parentLinkDocId: linkDocId },
        )
      : await importVariationChildren(
          { db, integracaoId, options, depositoOuterRef: deps.depositoOuterRef, now },
          parentInfo,
          mappedVariations,
          taxonomia,
        );
  }

  // Photos (#439) — additive, high-quality, best-effort. After the produto exists;
  // skips already-imported pictures; per-picture failures are logged, not fatal.
  // Requires a Storage bucket (omitted in tests that don't exercise photos). Runs
  // on the PARENT produtoId for a User-Products family too (member-level
  // `pictures` aren't imported, same as legacy variations[] — only the item-level
  // ones fetched here).
  if (options.importarFotos && deps.bucket && (item.pictures?.length ?? 0) > 0) {
    await importProdutoPhotos(
      { db, bucket: deps.bucket, integracaoId, fetchImpl: deps.fetchImpl },
      produtoId,
      item.pictures ?? [],
    );
  }

  // User-Products family fan-out (#521) — best-effort, AFTER this member (parent
  // + its own child) is fully written, so a fan-out failure never undoes it.
  // Disabled on every sibling call (`familyFanOut: false` below) — one level
  // only, no recursion regardless of how the sibling's own item data reads.
  let familyResult: ImportResult['family'];
  if (isUserProduct && deps.familyFanOut !== false) {
    const sellerUserId = deps.sellerUserId; // non-null — guarded above
    const familyId = up!.familyId;
    if (familyId != null && sellerUserId != null) {
      const siblings = await resolveFamilySiblingIds({ api }, familyId, sellerUserId, itemId);
      const failures: Array<{ itemId: string; error: string }> = [];
      let imported = 0;
      let created = 0;
      for (const siblingId of siblings.ids) {
        try {
          const siblingRes = await importProduto({ ...deps, familyFanOut: false }, siblingId);
          imported += 1;
          // `siblingRes.created` reflects the FAMILY PARENT's own creation — by
          // the time any sibling runs, the parent already exists (this call's own
          // primary-member write lands first), so it's ~always false here and
          // would silently undercount. The sibling's own CHILD creation
          // (`variations.created`, 0 or 1 for a single-member import) is what
          // "a new produto for this sibling" actually means.
          created += siblingRes.variations.created;
        } catch (err) {
          if (err instanceof MercadoLivreImportError || err instanceof MercadoLivreError) {
            failures.push({ itemId: siblingId, error: err.message });
            continue;
          }
          throw err; // Firestore/infra failure — retryable, fails the whole request
        }
      }
      familyResult = {
        total: siblings.ids.length,
        imported,
        created,
        capped: siblings.capped,
        failures,
      };
    } else {
      // No family id to expand (shouldn't happen for a real User-Products item)
      // or no seller id (guarded earlier, unreachable) — primary-only, reported.
      familyResult = { total: 0, imported: 0, created: 0, capped: false, failures: [] };
    }
  }

  return {
    produtoId,
    estado: mapped.estado,
    nome: mapped.nome,
    created: isCreate,
    variations: variationsResult,
    family: familyResult,
  };
}

/**
 * The parent's WHOLE `precos` map as it stands AFTER this run's price write —
 * legacy copies this whole map onto every child (`produtos.dart:284-290`; ML
 * itself forbids per-variation prices). Derived from the plan instead of a
 * re-read: create folds prices straight into `plan.produto.data`; update writes
 * them via the dotted-path `precosOps` (never on the produto patch), so the
 * final map is the existing one with `precosOps` overlaid.
 */
function resolveParentPrecosForChildren(
  isCreate: boolean,
  plan: ImportPlan,
  existingProduto: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (isCreate) {
    const created = plan.produto?.data.precos;
    return (created as Record<string, unknown> | null | undefined) ?? null;
  }
  const merged: Record<string, unknown> = {
    ...((existingProduto?.precos as Record<string, unknown> | undefined) ?? {}),
  };
  if (plan.precosOps) {
    for (const [k, v] of Object.entries(plan.precosOps.set)) merged[k] = v;
    for (const k of plan.precosOps.delete) delete merged[k];
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/** Insertion-order de-dup (`Set` preserves first-seen order). */
function uniqueFirstSeen(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/* -------------------------------------------------------------------------- */

interface ResolvedProduto {
  produtoId: string;
  /** Existing link doc id + raw (when resolved via the link); null via SKU. */
  linkDocId: string | null;
  linkRaw: Record<string, unknown> | null;
}

/**
 * Resolve the ERP produto for an ML item: first by an existing
 * `produtoMercadoLivre` link with `id == itemId` for this integração (the
 * cross-app dedup key, a collectionGroup query), then by `sku` — and when found
 * by SKU, REUSE that produto's existing link for this integração (else a
 * re-import would mint a duplicate link doc). Null → create.
 */
async function resolveExistingProduto(
  db: Firestore,
  itemId: string,
  sku: string | null,
  integracaoId: string,
): Promise<ResolvedProduto | null> {
  const linkSnap = await produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('id', '==', itemId)
    .get();
  for (const d of linkSnap.docs) {
    const raw = d.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(raw.contaOuterRef, integracaoId)) continue;
    const produtoId = d.ref.parent?.parent?.id;
    if (produtoId) return { produtoId, linkDocId: d.id, linkRaw: raw };
  }

  if (sku) {
    const skuSnap = await produtoCollection
      .ref(db, {})
      .where('sku', '==', sku)
      .where('paiId', '==', null)
      .limit(1)
      .get();
    const doc = skuSnap.docs[0];
    if (doc) {
      // Reuse an existing link for THIS integração under the SKU-matched produto,
      // so a re-import updates it rather than creating a second link doc.
      const linkSub = await produtoMercadoLivreLinkCollection.ref(db, { produtoId: doc.id }).get();
      const existingLink = linkSub.docs.find((l) =>
        refMatchesIntegracao((l.data() as Record<string, unknown>).contaOuterRef, integracaoId),
      );
      return {
        produtoId: doc.id,
        linkDocId: existingLink?.id ?? null,
        linkRaw: existingLink ? (existingLink.data() as Record<string, unknown>) : null,
      };
    }
  }
  return null;
}

/**
 * Resolve the ERP FAMILY PARENT produto for a User-Products member (#521),
 * three steps:
 *  1. this member's own `variacaoMercadoLivre` link (`itemId == itemId` — a
 *     previously-imported sibling of THIS SAME item) → its
 *     `produtoMercadoLivreOuterRef` → that `produtoMercadoLivre` doc → verify
 *     the account via `refMatchesIntegracao(contaOuterRef, …)` → the parent is
 *     that doc's own owning produto;
 *  2. the GLOBAL `produtoMercadoLivre` link with `id == canonicalId` (the
 *     family id) for this integração — the same one-parent-per-family
 *     guarantee `resolveExistingProduto` gives a simple item (a collectionGroup
 *     query, same shape);
 *  3. `sku` — same fallback shape as `resolveExistingProduto`'s (root produtos
 *     only, reusing an existing link for this integração when present).
 * Null → create (a fresh family parent + this member as its first child).
 */
async function resolveExistingUpParent(
  db: Firestore,
  itemId: string,
  canonicalId: string,
  sku: string | null,
  integracaoId: string,
): Promise<ResolvedProduto | null> {
  const memberLinkSnap = await variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('itemId', '==', itemId)
    .get();
  for (const d of memberLinkSnap.docs) {
    const raw = d.data() as Record<string, unknown>;
    const pmlOuterRef = raw.produtoMercadoLivreOuterRef;
    if (typeof pmlOuterRef !== 'string') continue;
    const parsed = parsePmlOuterRef(pmlOuterRef);
    if (!parsed) continue;
    const pmlSnap = await produtoMercadoLivreLinkCollection
      .docRef(db, { produtoId: parsed.produtoId }, parsed.linkId)
      .get();
    if (!pmlSnap.exists) continue;
    const pmlRaw = pmlSnap.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(pmlRaw.contaOuterRef, integracaoId)) continue;
    return { produtoId: parsed.produtoId, linkDocId: parsed.linkId, linkRaw: pmlRaw };
  }

  const linkSnap = await produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('id', '==', canonicalId)
    .get();
  for (const d of linkSnap.docs) {
    const raw = d.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(raw.contaOuterRef, integracaoId)) continue;
    const produtoId = d.ref.parent?.parent?.id;
    if (produtoId) return { produtoId, linkDocId: d.id, linkRaw: raw };
  }

  if (sku) {
    const skuSnap = await produtoCollection
      .ref(db, {})
      .where('sku', '==', sku)
      .where('paiId', '==', null)
      .limit(1)
      .get();
    const doc = skuSnap.docs[0];
    if (doc) {
      const linkSub = await produtoMercadoLivreLinkCollection.ref(db, { produtoId: doc.id }).get();
      const existingLink = linkSub.docs.find((l) =>
        refMatchesIntegracao((l.data() as Record<string, unknown>).contaOuterRef, integracaoId),
      );
      return {
        produtoId: doc.id,
        linkDocId: existingLink?.id ?? null,
        linkRaw: existingLink ? (existingLink.data() as Record<string, unknown>) : null,
      };
    }
  }
  return null;
}

/**
 * Parse a canonical `documents/produtos/<produtoId>/produtoMercadoLivre/<linkId>`
 * outer-ref (the exact form `toOuterRef` mints for a `produtoMercadoLivre`
 * link) into its produto + link doc ids; null on anything that doesn't match
 * that shape (a malformed/foreign ref is simply not a usable parent pointer).
 */
function parsePmlOuterRef(ref: string): { produtoId: string; linkId: string } | null {
  const segs = ref.split('/').filter(Boolean);
  const i = segs.indexOf('produtos');
  if (i === -1 || i + 3 >= segs.length) return null;
  if (segs[i + 2] !== 'produtoMercadoLivre') return null;
  return { produtoId: segs[i + 1]!, linkId: segs[i + 3]! };
}

/** Stable hex hash for deterministic produto / link ids (dual-run convergence). */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function readRaw(
  ref: FirebaseFirestore.DocumentReference,
): Promise<Record<string, unknown> | null> {
  const snap = await ref.get();
  return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
}

async function readEstoque(
  db: Firestore,
  produtoId: string,
  depositoId: string,
): Promise<{ quantidade: number; reservada: number } | null> {
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
        quantidade: typeof data.quantidade === 'number' ? data.quantidade : 0,
        reservada: typeof data.quantidadeReservada === 'number' ? data.quantidadeReservada : 0,
      };
    }
  }
  return null;
}
