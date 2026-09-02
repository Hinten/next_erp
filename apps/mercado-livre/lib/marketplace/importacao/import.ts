/**
 * Product-import orchestration (IO layer, ML→ERP): fetches a Mercado Livre item,
 * maps it (plugin `importItem`), resolves/creates the ERP produto, and writes the
 * produto + extraData + estoque + `produtoMercadoLivre` link in the exact Flutter
 * wire shape (legacy parity). The inverse of `publish.ts`.
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
 * Dedup / legacy-id convergence: the produto is resolved by the link doc's `id`
 * (== ML item id for a simple listing, == family id for User-Products; a
 * collectionGroup query — the same key the Flutter app matches on), then by
 * `sku`. A FRESH produto's id is always a deterministic hash — NOT the
 * seller_custom_field, which ML does not keep unique across a seller's items
 * (reusing it as the id would collide two distinct listings onto one produto).
 *
 * ML MODERATIONS (#1087): the import is the THIRD writer of the link doc's
 * `moderacoes`, after the `items` webhook and `reverificarAnuncio`. It reads them
 * through the SAME gate (`precisaConsultarModeracao` — a healthy listing costs no
 * extra call) and writes them in the same patch as the `status` they explain, so
 * a re-import of a listing whose moderation ML lifted clears the old reason
 * instead of carrying it forward on the spread. Two deliberate divergences from
 * the other two writers, both on `lerModeracoesDoItem`: the read sits ABOVE every
 * write, and a transient failure degrades to "never asked" rather than throwing
 * away the whole produto. See that function.
 *
 * `ImportDeps.upParentOverride` (#441): the UP resolution cascade can be
 * bypassed to force the family parent onto a caller-named produto — used by
 * `importMigration.ts` when ML migrates a legacy `variations[]` listing to
 * User-Products, so the new family lands on the OLD legacy parent instead of
 * minting a duplicate. See `resolveUpParentOverride` below; inert when absent.
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type MappedUpMember,
  type MercadoLivreApi,
  type MlItem,
  type MlItemAttribute,
  MercadoLivreError,
  mapMlItemToImport,
  mapMlVariationsToImport,
  mapUpMemberToImport,
  pesoBrutoDeclaradoKg,
  skuGuessFromVariations,
} from '@delfrance/integrations-mercado-livre';
import {
  type MlModeracao,
  PRODUTO_EXTRA_DATA_DOC_ID,
  derivarFilhoUnico,
  precisaConsultarModeracao,
  toOuterRef,
} from '@delfrance/schemas';
import {
  estoqueCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  type FilhoMedidas,
  type ImportOptions,
  type ImportPlan,
  DEFAULT_IMPORT_OPTIONS,
  MercadoLivreImportError,
  assembleImportPlan,
  medidasEfetivas,
  rollupDimensoesDosFilhos,
} from './importCore';
import { importCategoriaChain } from './importCategoria';
import { consultarModeracoes } from '../anuncios/moderacoes';
import { resolveTaxonomia } from './importTaxonomia';
import { type ImportVariationChildrenResult, importVariationChildren } from './importVariations';
import { resolveFamilySiblingIds } from './importFamily';
import { isAlreadyExists, isFailedPrecondition } from '@delfrance/data/admin';
import { lastSegment, refMatchesIntegracao } from '../core/linkRefs';
import { type Bucket } from '../core/arquivoUpload';
import { importProdutoPhotos } from './importPhotos';

export interface ImportDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  /** The account's ML seller id (integração `user_id`) — the ownership guard. */
  sellerUserId: number | null;
  tabelaNormalOuterRef: string | null;
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
  /**
   * #441 migration override: force the UP family parent onto an EXISTING
   * produto (the OLD legacy `variations[]` parent that owned the listing
   * before ML migrated it to User-Products) instead of running the normal
   * `resolveExistingUpParent` cascade. UP branch only (`isUserProduct`);
   * ignored for a simple/legacy-`variations[]` item. The cascade would miss by
   * construction for a migrated member (its own link is numeric-id-keyed under
   * the OLD scheme, the family-id link doesn't exist yet, and a stray sku
   * coincidence isn't guaranteed) and would otherwise mint a duplicate family
   * parent — see `importMigration.ts`. Simple/`variations[]`/normal-UP import
   * behavior is byte-identical when this field is absent.
   */
  upParentOverride?: { produtoId: string };
  /**
   * Whether this import may spend an ML `/moderations` call (#1087) — default
   * TRUE (absent ⇒ read it). Set `false` by the MASS import alone, which drains a
   * whole catalogue and must not pay a per-moderated-listing lookup.
   *
   * ⚠️ It gates the NETWORK read, never the write. A listing whose own
   * `status`/`sub_status` warrant no moderation still lands `moderacoes: []`
   * here, because {@link precisaConsultarModeracao} answers that from the item
   * we already fetched — so even the mass import clears a stale reason off every
   * healthy listing for free. Only "moderated, and we deliberately did not ask"
   * degrades to `null`, and it self-heals through the `items` webhook or the
   * operator's "Reverificar anúncio".
   *
   * A DEPS flag rather than an `ImportOptions` one on purpose: this is a
   * per-path cost decision, not an operator choice, so it must never reach
   * `sanitizeOptions` and become a checkbox. Same shape as `familyFanOut`
   * above — and, like it, the fan-out inherits it through the `...deps` spread.
   */
  lerModeracoes?: boolean;
  /**
   * Whether this import may spend an ML `/shipping_options/free` call to recover
   * a gross weight ML publishes no `SELLER_PACKAGE_WEIGHT` for — default TRUE.
   * Set `false` by the MASS import, exactly like {@link lerModeracoes} above.
   *
   * ⚠️ Unlike a category or a domain, this answer is PER ITEM and cannot be
   * cached across a catalogue, so the mass path would pay one extra ML round trip
   * for every listing with no declared weight — which, on a seller whose listings
   * are all ME2, is every listing. A single import pays it once and gladly.
   *
   * A DEPS flag, not an `ImportOptions` one: a per-path cost decision, never an
   * operator checkbox, so it must not reach `sanitizeOptions`. The family fan-out
   * inherits it through the `...deps` spread.
   */
  lerPesoEnvio?: boolean;
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
    /**
     * Set when the ML sibling-RESOLUTION calls failed (best-effort — the
     * primary member still imported); absent when resolution succeeded, so an
     * empty `total` with no error really means a single-member family.
     */
    resolutionError?: string;
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

  // ---- ML moderations (#1087) -------------------------------------------
  // Read HERE, above every write, and the placement is load-bearing rather than
  // stylistic: `importCategoriaChain` and `resolveTaxonomia` below both WRITE
  // Firestore before `assembleImportPlan` is ever reached, so a read placed after
  // either one could leave orphan `categorias`/`grupoDeVariacoes` docs behind.
  // Same property `reverificarAnuncio` states at its own call site — "before the
  // write, and outside it".
  //
  // Below the guards, equally deliberately: `closed` + `moderation_penalty` is a
  // moderation reading, so a read above them would spend an ML call on a listing
  // the import rejects anyway.
  //
  // `item.status`/`item.sub_status` (the raw item), matching `itemsStatusSync`
  // and `reverificarAnuncio` — `mapped` does not exist yet and carries the same
  // two values regardless.
  const moderacoes = await lerModeracoesDoItem(
    api,
    itemId,
    item,
    deps.lerModeracoes !== false,
    integracaoId,
  );

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
  // ML's own billable weight, for a listing that declares none of its own (#1306
  // follow-up). Read here rather than inside the mapper because the mapper is
  // PURE — the round-trip parity tests depend on that — and above every write for
  // the same reason the moderation read is: a failure must not orphan documents.
  const pesoFaturavelG = await lerPesoFaturavel(
    api,
    itemId,
    item,
    deps.sellerUserId,
    deps.lerPesoEnvio !== false,
    integracaoId,
  );
  const mappedItem = mapMlItemToImport(item, { billableWeightG: pesoFaturavelG });
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
    ? deps.upParentOverride
      ? await resolveUpParentOverride(
          db,
          deps.upParentOverride.produtoId,
          up!.canonicalId,
          integracaoId,
        )
      : await resolveExistingUpParent(db, itemId, up!.canonicalId, mapped.sku, integracaoId)
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
  // Its `updateTime` is kept: the precos write below is derived from THIS read,
  // so it rides back as a `lastUpdateTime` precondition (ADR 0011 tier 1).
  const produtoSnap = await produtoCollection.docRef(db, {}, produtoId).get();
  const existingProduto = produtoSnap.exists
    ? ((produtoSnap.data() ?? {}) as Record<string, unknown>)
    : null;
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
  // ⛔ `ownsChildren` is derived from THIS CALL'S ML payload; whether the produto
  // owns children is a stored fact about the ERP. They part company the moment a
  // seller consolidates a listing on ML — the item comes back with `variations:
  // []`, `ownsChildren` is false, and the import would write the ML quantity onto
  // the PARENT while `filhoUnicoId` still names the surviving child. Every stock
  // reader then resolves to that child's row, last written by the previous
  // import: the badge, the pedido line and the print go stale, and the row the
  // importer just wrote is invisible.
  //
  // ⚠️ It does not self-heal. Every later import takes the same branch, so the
  // divergence is permanent — unlike every other race in this function, which the
  // doc justifies as repaired on the next run.
  //
  // So the ERP's own child set has the last word on where stock may land. The
  // extra read is paid ONLY on the path that was about to write to a parent, and
  // `limit(1)` is all a boolean needs.
  const paiJaTemFilho =
    isCreate || !depositoId || ownsChildren ? false : await temFilhoAgora(db, produtoId);
  const existingStock =
    isCreate || !depositoId || ownsChildren || paiJaTemFilho
      ? null
      : await readEstoque(db, produtoId, depositoId);

  // ---- Assemble + execute ----------------------------------------------
  const plan = assembleImportPlan({
    mapped: planMapped,
    options,
    produtoId,
    isCreate,
    linkDocId,
    integracaoId,
    tabelaNormalId: deps.tabelaNormalOuterRef ? lastSegment(deps.tabelaNormalOuterRef) : null,
    depositoOuterRef: deps.depositoOuterRef,
    descricao,
    categoriaOuterRef,
    existingProduto,
    existingLinkRaw,
    existingExtra,
    existingEstoqueQty: existingStock?.quantidade ?? null,
    existingEstoqueReservada: existingStock?.reservada ?? null,
    // ⚠️ The ERP's child set, not just ML's payload — see `paiJaTemFilho`. A
    // produto that owns children never carries its own stock, and the plan is
    // what nulls the estoque write.
    hasVariations: ownsChildren || paiJaTemFilho,
    parentGrupoUids,
    parentVariacoesUid,
    moderacoes,
    now,
  });

  // produto (create = create-only; update = merge patch). `.create()` (not `.set()`)
  // so a rare concurrent same-item create can't full-overwrite edits made by the
  // winner between our read and write — on ALREADY_EXISTS we re-run once (the
  // produto now exists → the update path).
  // Prices FIRST — before the produto merge below, and that ordering is
  // load-bearing. This is the one GUARDED write: a dotted-path update of the
  // conta's tabela NORMAL key only, so the legacy precos map is never
  // re-validated and a sibling tabela provably cannot be touched. Set-only,
  // since the promotional tabela is the ERP's (#803). Null on create, where the
  // price is already folded into the full produto doc.
  //
  // ADR 0011 **tier 1**: the patch is derived from `produtoSnap`, so it asserts
  // that read's `lastUpdateTime`. A concurrent writer of the same produto — a
  // retrying import task, the `items` webhook, or an operator saving the produto
  // editor — fails this FAILED_PRECONDITION instead of being silently reverted,
  // and we re-read and re-plan once (the `isAlreadyExists` precedent below;
  // re-applying the SAME patch would defeat the guard). The guard stands; only
  // the cast changed — the Flutter app was never one of these writers (rule 8).
  //
  // ⚠️ Ordering: the produto merge below always writes on the update path (it
  // carries `ultimaModificacao`, #800), which BUMPS `updateTime`. Running it
  // first would make this precondition assert a stamp we ourselves had just
  // invalidated — failing every single price-writing import. The guarded write
  // must come first, against the read it was derived from.
  if (plan.precosOps) {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(plan.precosOps.set)) patch[`precos.${k}`] = v;
    if (Object.keys(patch).length > 0) {
      const ref = produtoCollection.docRef(db, {}, produtoId);
      // `updateTime` is always present on an existing doc from the real SDK;
      // the fallback exists only so an in-memory double may omit it.
      const lastUpdateTime = produtoSnap.updateTime;
      try {
        await (lastUpdateTime ? ref.update(patch, { lastUpdateTime }) : ref.update(patch));
      } catch (err) {
        if (isFailedPrecondition(err) && attempt < 1) {
          return importProduto(deps, itemId, attempt + 1);
        }
        throw err;
      }
    }
  }

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

  // Legacy denorm (DEAD WEIGHT; #992, audited in #961 — no query consumers in
  // this repo, deleted at the decommission. Canonical note on `produtoSchema`;
  // do not repair, do not add a reader).
  //
  // Runs after the produto exists (create sets it first). arrayUnion is tier 0
  // — commutative and idempotent — which is what these two arrays need, and NOT
  // because a second app writes them: the Flutter app is not a live writer here
  // (rule 8). The real concurrency is ours. Three in-repo writers touch these
  // same fields on this same produto doc — `itemsStatusSync.ts:469-475`
  // arrayUnions them, the UP takeover in `importMigration.ts:534-550` rewrites
  // them, and a Cloud Tasks retry or the reprocess sweep re-drives THIS import.
  // Secondary: a migrated produto arrives carrying legacy entries for other
  // contas, which arrayUnion likewise leaves alone. The same tier-0 argument is
  // made honestly in `importPhotos.ts:154` and `integracoesComProduto.ts:31`.
  // User-Products stamps
  // `relevantData.isUserProductModel` on the PARENT's own entry too (parity —
  // `ProdMarketplace.relevantData`, `models.dart:2333`); omitted for simple/
  // variations[] so their denorm shape stays byte-identical.
  //
  // ⚠️ `integracoesComProduto` is NOT stamped here (#920) — the link `.set()`
  // above is what puts the produto in it, via
  // `onProdutoMercadoLivreLinkChanged`. That is the point: the array now
  // follows the links, so an import path that forgets to stamp can no longer
  // leave a listing invisible to both sweeps.
  await produtoCollection.docRef(db, {}, produtoId).update({
    marketplace: FieldValue.arrayUnion({
      integracaoUid: integracaoId,
      externalId: plan.denormItemId,
      ...(isUserProduct ? { relevantData: { isUserProductModel: true } } : {}),
    }),
    marketplaceIds: FieldValue.arrayUnion(plan.denormItemId),
  });

  // Children (#520 legacy variations[] / #521 User-Products member), run after
  // the parent's own produto/link exist (children reference the parent link's
  // outer-ref). No-op ({ total: 0, created: 0 }) for a simple listing.
  let variationsResult: ImportVariationChildrenResult = { total: 0, created: 0, medidas: [] };
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
          {
            parentLinkDocId: linkDocId,
            status: mapped.status,
            subStatus: mapped.subStatus,
            // The UP import fetches ONE member item per call, so `mapped` IS
            // this member — its `user_product_id` belongs on the member's own
            // link, never on the family's parent link (#706, #1142).
            userProductId: mapped.userProductId,
            // …and by the same token the moderation just read describes THIS
            // member (#1087). The family parent takes the same value, which is
            // the importer's standing convention for `estado`/`status` and is
            // what keeps the parent internally consistent: one listing, one
            // status, one reason. Deliberately NOT a fold — see `upFamilyStatus`.
            moderacoes,
          },
        )
      : await importVariationChildren(
          { db, integracaoId, options, depositoOuterRef: deps.depositoOuterRef, now },
          parentInfo,
          mappedVariations,
          taxonomia,
        );
  }

  // Dimension rollup, child → parent (#1087). A simple listing re-imports as a
  // parent produto plus one variation, so the measurements can land on the child
  // while the "produto base" the operator opens shows none — and
  // `dimensoesDoPacote` has no parent fallback, so a blank parent publishes no
  // package at all. Repair the blank rather than teach every reader to look down.
  //
  // ⚠️ Rule 7, tier 1 — and the parent's nullness is RE-READ here rather than
  // carried down from `existingProduto`. That read happened before
  // `importVariationChildren`, which is N children × (read produto, read estoque,
  // write produto, write estoque, write link, arrayUnion) — a window measured in
  // seconds. Inside it an operator can save the produto editor with a box they
  // just typed, and a rollup holding the pre-loop blank would merge a child's
  // number straight over it. Rule 7 puts an interactive edit at tier 3
  // ("raises a conflict, never a silent drop"), and silently losing one is
  // exactly what the earlier "both values come from the same listing" reasoning
  // missed: the competing writer is not another import, it is a person.
  //
  // So: one fresh read gives BOTH a current nullness check and a usable
  // `updateTime`. `produtoSnap`'s own stamp is unusable — this call invalidated
  // it itself — which is the same trap the precos write above documents.
  //
  // ⚠️ A lost race here SKIPS the repair rather than failing the import. The
  // rollup is a best-effort repair of a blank, so leaving the blank is the status
  // quo and self-heals on the next import; killing an otherwise complete import
  // over it would be a far worse trade. Bounded at one retry — a second
  // concurrent writer in the same instant is not worth a loop.
  if (ownsChildren && variationsResult.medidas.length > 0) {
    await aplicarRollupDimensoes(db, produtoId, variationsResult.medidas, now);
  }

  // The sole-member pointer (#1398). AFTER the rollup, which also writes the
  // parent: running before it would invalidate the rollup's precondition and
  // cost the dimension repair a retry on every single import.
  //
  // ⚠️ `paiJaTemFilho` is in the condition because `ownsChildren` alone would skip
  // exactly the listing that lost its variations — the one whose pointer most
  // needs re-deriving. It costs no extra read: the flag was already resolved
  // above, on the only path that could set it.
  if (ownsChildren || paiJaTemFilho) {
    await aplicarPonteiroMembroUnico(db, produtoId, now);
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
      // Deliberately SEQUENTIAL: every sibling merges the SAME family parent
      // (produto fill-null, PML link spread-set, denorm arrayUnion, taxonomy
      // tx) — concurrency would only buy tx-contention retries and
      // ALREADY_EXISTS churn on shared docs. The cap (60) bounds the worst
      // case, and a request killed mid-loop recovers by re-importing (every
      // write is idempotent/convergent).
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
        // Key absent (not undefined-valued) when resolution succeeded.
        ...(siblings.resolutionError != null ? { resolutionError: siblings.resolutionError } : {}),
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
    variations: { total: variationsResult.total, created: variationsResult.created },
    family: familyResult,
  };
}

/**
 * The parent's WHOLE `precos` map as it stands AFTER this run's price write —
 * legacy copies this whole map onto every child (`produtos.dart:284-290`; ML
 * itself forbids per-variation prices). Derived from the plan instead of a
 * re-read: create folds the price straight into `plan.produto.data`; update
 * writes it via the dotted-path `precosOps` (never on the produto patch), so
 * the final map is the existing one with `precosOps` overlaid.
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
  // Overlay only — `precosOps` is set-only since #803, so a key the ERP owns
  // (the promotional tabela above all) survives into the children untouched.
  if (plan.precosOps) {
    for (const [k, v] of Object.entries(plan.precosOps.set)) merged[k] = v;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/** Insertion-order de-dup (`Set` preserves first-seen order). */
function uniqueFirstSeen(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * ML's active moderations for the item being imported (#1087), or `null` meaning
 * **"never asked"** — the third value the link doc's `moderacoes` carries, which
 * makes the write omit the key rather than record a `[]` nobody confirmed.
 *
 * The import is the THIRD writer of that field, after the `items` webhook and
 * `reverificarAnuncio`, and it qualifies under the same rule they do: only a
 * writer that just asked ML may touch it. What differs is the failure posture,
 * and the difference is deliberate.
 *
 * ⚠️ **A transient failure does NOT fail the import.** `consultarModeracoes`
 * rethrows everything but a 404, and its two other callers let it — for them the
 * status write IS the whole unit of work, so writing nothing and retrying costs
 * nothing. Here it would throw away a produto, its extraData, its stock, its
 * photos and its children over a diagnostic. The listing is not left blind
 * either way: `estado`/`status`/`sub_status` are recorded from the item we
 * already hold, so the operator still sees THAT the anúncio is moderated — only
 * ML's prose for WHY is missing, and one "Reverificar anúncio" fetches it.
 *
 * ⚠️ Degrading to `null`, never to `[]`. `[]` means "asked, ML reported none"
 * and on disk is byte-identical to a healthy listing — it would record
 * "not moderated" about a listing we failed to ask about, and on a re-import it
 * would erase a real, still-true reason. `null` leaves the stored value alone.
 *
 * ⚠️ The `enabled` flag gates the NETWORK read only. A listing that fails
 * {@link precisaConsultarModeracao} still returns `[]` — that verdict comes from
 * the item already in hand, costs no call, and is what keeps a lifted moderation
 * from outliving the status it explained. So even the mass import, which passes
 * `enabled: false`, still self-heals every healthy listing it touches.
 *
 * ⚠️ The `MercadoLivreError` narrow also swallows `MercadoLivreReauthRequiredError`
 * (it extends that class), and that is accepted rather than overlooked: the grant
 * is proven live by the `api.getItem` this function runs after, so reaching here
 * with a dead one means it died in between — and at that point the item is
 * already in hand and nothing the import still NEEDS is an ML call (the
 * description and the categoria chain are both best-effort, and the one directly
 * below narrows identically). Degrading produces a correct produto from data we
 * already have; rethrowing would discard it to report a token that the next
 * operation will report anyway.
 *
 * Never throws for an ML failure. A non-ML error (a bug, a Firestore fault)
 * still propagates — the catch narrows rather than swallowing.
 */
async function lerModeracoesDoItem(
  api: MercadoLivreApi,
  itemId: string,
  item: MlItem,
  enabled: boolean,
  integracaoId: string,
): Promise<MlModeracao[] | null> {
  // Free, and the half of the invariant worth keeping everywhere: ML's own
  // status says there is nothing to explain, so any stored reason is stale.
  if (!precisaConsultarModeracao(item.status, item.sub_status)) return [];
  if (!enabled) return null;
  try {
    return await consultarModeracoes(api, itemId, item.status, item.sub_status);
  } catch (err) {
    if (!(err instanceof MercadoLivreError)) throw err;
    console.warn('[mercado-livre] import: falha ao consultar moderações — motivo não atualizado', {
      integracaoId,
      itemId,
      status: item.status,
      erro: err.message,
    });
    return null;
  }
}

/**
 * ML's BILLABLE weight for this listing, in grams — or null.
 *
 * Only asked when the listing declares no `SELLER_PACKAGE_WEIGHT` of its own, so
 * a seller who fills their packages properly never pays for this call.
 *
 * ⚠️ **Best-effort by construction.** ML documents `/shipping_options/free` as
 * serving only items live on the marketplace, so a paused listing answering 4xx
 * is the expected case, not an incident — and throwing here would discard a
 * produto, its extraData, its stock, its photos and its children over a weight.
 * Same argument, and the same shape, as {@link lerModeracoesDoItem}.
 */
async function lerPesoFaturavel(
  api: MercadoLivreApi,
  itemId: string,
  item: MlItem,
  sellerUserId: number | null,
  enabled: boolean,
  integracaoId: string,
): Promise<number | null> {
  if (!enabled || sellerUserId == null) return null;
  // Free: the listing already says what it weighs, so there is nothing to ask.
  if (pesoBrutoDeclaradoKg(item) != null) return null;
  // ⚠️ Also free, and it is the case the docblock below PREDICTS: ML serves this
  // endpoint only for items live on the marketplace, so a paused/under-review
  // listing buys a round trip whose 4xx we already expect plus a `console.warn`
  // that reads like an incident. Decided from the item already in hand — the same
  // shape as `precisaConsultarModeracao` gating the moderations read. It is not a
  // loss: `estado` returning to active makes the next import ask.
  if (item.status !== 'active') return null;
  try {
    const resp = await api.getFreeShippingOptions(sellerUserId, {
      itemId,
      freeShipping: item.shipping?.free_shipping === true,
    });
    const g = resp.coverage?.all_country?.billable_weight;
    return typeof g === 'number' && Number.isFinite(g) && g > 0 ? g : null;
  } catch (err) {
    if (!(err instanceof MercadoLivreError)) throw err;
    console.warn('[mercado-livre] import: falha ao consultar peso de envio — peso nao importado', {
      integracaoId,
      itemId,
      erro: err.message,
    });
    return null;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Exported for reuse by the order-import orchestrator (Step 9,
 * `orderImport.ts`): an ML order line's produto is resolved the same way an
 * import resolves the ML item it's importing (link → sku), so the two flows
 * share this one lookup instead of a second copy.
 */
export interface ResolvedProduto {
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
export async function resolveExistingProduto(
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
  // An MLB item id is globally unique on ML, so >1 hit only means the SAME
  // listing imported under multiple integração accounts — a small set. The
  // limit bounds a pathological scan (the link has no conta field to filter
  // server-side — adding one would pollute the legacy VariacoesML wire); the
  // family-id and SKU steps below remain the fallback.
  const memberLinkSnap = await variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('itemId', '==', itemId)
    .limit(10)
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
 * #441 migration override: resolve the UP family parent onto a CALLER-SUPPLIED
 * produto (the OLD legacy parent) instead of `resolveExistingUpParent`'s own
 * cascade. Looks for an existing `produtoMercadoLivre` link under that ONE
 * produto with `id == canonicalId` (the family id) for this integração — so a
 * second migrated member of the same family reuses the SAME link doc rather
 * than a fresh mint colliding on `100000000000000000<canonicalId>` (same doc
 * id, `.set()` is idempotent either way, but reusing lets the caller's
 * spread-existing fill-null logic see the prior write). No link yet → null
 * `linkDocId`/`linkRaw`, and the caller's existing fresh-mint fallback
 * (`100000000000000000${canonicalId}`) applies unchanged. `produtoId` is
 * always the override — this never returns null (the override always names an
 * existing produto to write onto).
 */
async function resolveUpParentOverride(
  db: Firestore,
  produtoId: string,
  canonicalId: string,
  integracaoId: string,
): Promise<ResolvedProduto> {
  // limit(10), not limit(1): the integração filter runs in memory (tolerant
  // ref matching), so the first doc could belong to another conta. Same bound
  // as resolveExistingUpParent's member-link scan.
  const linkSnap = await produtoMercadoLivreLinkCollection
    .ref(db, { produtoId })
    .where('id', '==', canonicalId)
    .limit(10)
    .get();
  for (const d of linkSnap.docs) {
    const raw = d.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(raw.contaOuterRef, integracaoId)) continue;
    return { produtoId, linkDocId: d.id, linkRaw: raw };
  }
  return { produtoId, linkDocId: null, linkRaw: null };
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

/**
 * Apply the child -> parent dimension rollup (#1087), guarded at rule 7 tier 1.
 *
 * Re-reads the parent so the "which fields are blank" decision and the
 * `lastUpdateTime` precondition come from the SAME fresh snapshot. The caller's
 * `existingProduto` is deliberately not reused: it predates
 * `importVariationChildren`, and an operator saving the produto editor inside
 * that window would be clobbered silently.
 *
 * A losing race SKIPS the repair. The rollup fills a blank the produto already
 * had, so not filling it is the status quo and the next import retries it;
 * failing a complete import over a best-effort repair would be the worse trade.
 * `tentativas` bounds it at one retry.
 */
async function aplicarRollupDimensoes(
  db: Firestore,
  produtoId: string,
  medidasDosFilhos: readonly FilhoMedidas[],
  now: number,
  tentativas = 1,
): Promise<void> {
  const ref = produtoCollection.docRef(db, {}, produtoId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const rollup = rollupDimensoesDosFilhos(
    medidasEfetivas((snap.data() ?? {}) as Record<string, unknown>, null),
    medidasDosFilhos,
  );
  if (!rollup) return;

  // `updateTime` is always present on an existing doc from the real SDK; the
  // fallback exists only so an in-memory double may omit it (same contract the
  // precos write above states).
  const lastUpdateTime = snap.updateTime;
  try {
    const patch = { ...rollup, ultimaModificacao: now };
    await (lastUpdateTime ? ref.update(patch, { lastUpdateTime }) : ref.update(patch));
  } catch (err) {
    if (!isFailedPrecondition(err)) throw err;
    if (tentativas > 0) {
      await aplicarRollupDimensoes(db, produtoId, medidasDosFilhos, now, tentativas - 1);
      return;
    }
    // Someone else is writing this produto right now. Their value is newer than
    // ours by construction, so the blank is either already filled or will be
    // repaired by the next import.
    console.warn('[mercado-livre] import: rollup de dimensoes ignorado (produto alterado)', {
      produtoId,
    });
  }
}

/**
 * Does this produto have a child RIGHT NOW?
 *
 * ⚠️ Read from the ERP, never inferred from the ML payload. `limit(1)` because the
 * answer is a boolean, and it rides the existing `produtos(paiId ASC, nome ASC)`
 * index on its prefix.
 */
async function temFilhoAgora(db: Firestore, produtoId: string): Promise<boolean> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', produtoId).limit(1).get();
  return !snap.empty;
}

/**
 * Point the parent at its sole member — or clear the pointer when the family has
 * more than one (#1398).
 *
 * ## Why the importer has to do this at all
 *
 * A **User-Products** produto imported from Mercado Livre is always a family:
 * ML auto-generates one for every user product, so even a single item comes back
 * as a parent plus one child and the stock lands on the CHILD. (A listing that is
 * neither User Products nor variation-bearing is imported flat, with stock on the
 * produto itself — `importVariationChildren` documents that no-op, and this
 * function is gated to match.) With `filhoUnicoId` unset, `unidadeVendavel`
 * resolves such a produto to the parent —
 * which owns no estoque rows — so its badge, its pedido line and its print all
 * read **zero**. That is the original #1398 bug, reached through the importer
 * instead of through publish.
 *
 * ## ⚠️ The child set is QUERIED, never inferred from this call
 *
 * A User-Products import fetches ONE member per call and fans out to the siblings
 * in separate calls, so "the children this call wrote" is 1 for every member of a
 * three-member family. Deriving the pointer from that would name member 1 as the
 * sole member of a family of three — plan risk 1, and it would send every stock
 * reader to one arbitrary variation.
 *
 * `limit(2)` is exactly what the question needs: `derivarFilhoUnico` only has to
 * tell "one" from "more than one", so two documents answer it and Enterprise
 * bills two documents scanned. The query rides the existing
 * `produtos(paiId ASC, nome ASC)` index on its prefix.
 *
 * ## ⚠️ A lost precondition RETRIES — it must not skip (rule 7)
 *
 * The write carries the parent snapshot's `lastUpdateTime` (tier 1), and an
 * earlier version of this comment claimed the read ORDER made that sufficient.
 * It does not, and adversarial review showed why: the value written comes from a
 * separate `where('paiId','==',produtoId)` QUERY, and no precondition covers a
 * query. A sibling's child document appearing between that query and the update
 * changes the correct answer without touching the parent's version — so the
 * precondition provably cannot detect the staleness it was credited with.
 *
 * Worse, the run holding the FRESH view is the one whose precondition fails: two
 * concurrent member imports could leave the parent naming one child while the
 * family has two, which is plan risk 1 — every stock reader then sends the whole
 * produto's stock to one arbitrary variation.
 *
 * So a lost precondition re-runs the whole derivation — re-query, re-read,
 * re-write — exactly as `aplicarRollupDimensoes` above does. The retry sees the
 * sibling that invalidated it and computes `null`, which is the right answer.
 * Bounded at one: a second concurrent writer in the same instant is not worth a
 * loop, and the pointer still self-heals on the next import or produto save.
 *
 * ⚠️ **The retry branch itself is not covered by a test**, and the same is true of
 * `aplicarRollupDimensoes`'s directly above. Forcing a lost precondition needs a
 * write to land BETWEEN this read and this update, which the import suite's
 * Firestore double cannot express — it enforces preconditions faithfully but has
 * no way to interleave. What IS covered is the property the retry restores: the
 * pointer is derived from a live query, so a family that has gained a sibling
 * resolves to `null`.
 */
async function aplicarPonteiroMembroUnico(
  db: Firestore,
  produtoId: string,
  now: number,
  tentativas = 1,
): Promise<void> {
  const ref = produtoCollection.docRef(db, {}, produtoId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const filhos = await produtoCollection.ref(db, {}).where('paiId', '==', produtoId).limit(2).get();
  const filhoUnicoId = derivarFilhoUnico(filhos.docs.map((d) => ({ id: d.id })));
  // Nothing to say: an unchanged pointer must not cost a write, because this runs
  // on every import of every produto that owns children.
  if (((snap.data() ?? {}).filhoUnicoId ?? null) === filhoUnicoId) return;

  const lastUpdateTime = snap.updateTime;
  try {
    const patch = { filhoUnicoId, ultimaModificacao: now };
    await (lastUpdateTime ? ref.update(patch, { lastUpdateTime }) : ref.update(patch));
  } catch (err) {
    if (!isFailedPrecondition(err)) throw err;
    if (tentativas > 0) {
      // ⚠️ Re-runs the DERIVATION, not just the write. The whole point is to see
      // the sibling child that invalidated us — re-writing the same value would
      // land exactly the stale pointer this exists to prevent.
      await aplicarPonteiroMembroUnico(db, produtoId, now, tentativas - 1);
      return;
    }
    console.warn('[mercado-livre] import: ponteiro do membro unico ignorado (produto alterado)', {
      produtoId,
    });
  }
}

/** Stable hex hash for deterministic produto / link ids (legacy-id convergence). */
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
