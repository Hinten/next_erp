/**
 * Product-import orchestration (IO layer, ML→ERP): fetches a Mercado Livre item,
 * maps it (plugin `importItem`), resolves/creates the ERP produto, and writes the
 * produto + extraData + estoque + `produtoMercadoLivre` link in the exact Flutter
 * wire shape (dual-run). The inverse of `publish.ts`.
 *
 * Scope: a `family_name` (User-Products) item is rejected — that model needs its
 * own deferred design (#521). The legacy `variations[]` model IS supported
 * (#520): one child produto is created/synced per usable variation, with the
 * shared `grupoDeVariacoes`/`Variante` taxonomy resolved via `importTaxonomia`
 * and the children written by `importVariations.ts` — see `importVariationChildren`
 * below. Existing ERP data is preserved: parent fields fill-nulls, stock never
 * clobbered unless `sobrescreverEstoque` (and never written on the PARENT at all
 * when it has variations — stock lives on the children).
 *
 * Dedup / dual-run convergence: the produto is resolved by the link doc's `id`
 * (== ML item id, a collectionGroup query — the same key the Flutter app matches
 * on), then by `sku`. A FRESH produto's id is always a deterministic per-item
 * `sha256(sellerUserId|itemId)` — NOT the seller_custom_field, which ML does not
 * keep unique across a seller's items (reusing it as the id would collide two
 * distinct listings onto one produto).
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  type MlItemAttribute,
  MercadoLivreError,
  mapMlItemToImport,
  mapMlVariationsToImport,
  skuGuessFromVariations,
} from '@delfrance/integrations-mercado-livre';
import { PRODUTO_EXTRA_DATA_DOC_ID, toOuterRef } from '@delfrance/schemas';
import {
  estoqueCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoMercadoLivreLinkCollection,
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
}

export interface ImportResult {
  produtoId: string;
  estado: string;
  nome: string;
  created: boolean;
  /** Legacy `variations[]` children (#520) — `{ total: 0, created: 0 }` for a simple listing. */
  variations: { total: number; created: number };
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
  if (item.family_name != null) {
    throw new MercadoLivreImportError([
      `anúncio ${itemId} é um anúncio no modelo User-Products (family_name) — a importação desse formato ainda não está disponível (issue #521)`,
    ]);
  }
  if (deps.sellerUserId == null) {
    throw new MercadoLivreImportError(['integração sem user_id — reconecte a conta']);
  }
  if (item.seller_id != null && item.seller_id !== deps.sellerUserId) {
    throw new MercadoLivreImportError([`anúncio ${itemId} pertence a outro vendedor`]);
  }

  // Legacy `variations[]` model (#520) — the parent's own sku falls back to the
  // strip-6 guess when it has none of its own (`gessSkuFromMercadoLivre` parity);
  // the whole precos map + no per-item stock apply to it (produtos.dart:226-290).
  const hasVariations = (item.variations?.length ?? 0) > 0;
  const mappedItem = mapMlItemToImport(item);
  const mapped = {
    ...mappedItem,
    sku: mappedItem.sku ?? (hasVariations ? skuGuessFromVariations(item) : null),
  };
  const mappedVariations = hasVariations ? mapMlVariationsToImport(item) : [];

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

  // Variation taxonomy (#519/#520) — match-first, create-if-absent grupoDeVariacoes
  // + Variante for every combo attribute across ALL variations, so two children
  // sharing a grupo (e.g. both carry SIZE) resolve/create it exactly once.
  const combos: MlItemAttribute[] = hasVariations ? mappedVariations.flatMap((v) => v.combos) : [];
  const taxonomia = hasVariations
    ? await resolveTaxonomia({ db }, { combos, integracaoId, now })
    : [];
  const parentGrupoUids = hasVariations ? uniqueFirstSeen(taxonomia.map((t) => t.grupoUid)) : null;
  const parentVariacoesUid = hasVariations
    ? uniqueFirstSeen(taxonomia.map((t) => t.varianteFake))
    : null;

  // ---- Resolve the ERP produto (link → sku → deterministic id) ----------
  const resolved = await resolveExistingProduto(db, itemId, mapped.sku, integracaoId);
  // A fresh produto id is a per-item hash — NOT the seller_custom_field, which ML
  // does not keep unique across a seller's items (two items sharing a code would
  // otherwise collide onto one produto and clobber it). The link doc id is
  // likewise deterministic, so a concurrent same-item import converges.
  const produtoId = resolved?.produtoId ?? sha256(`${deps.sellerUserId}|${itemId}`);
  const linkDocId = resolved?.linkDocId ?? `ml-${sha256(`${integracaoId}|${itemId}`).slice(0, 40)}`;

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
  // A produto with variations never carries its own stock (it lives on the
  // children) — skip the read, the plan nulls the estoque write regardless.
  const existingStock =
    isCreate || !depositoId || hasVariations ? null : await readEstoque(db, produtoId, depositoId);

  // ---- Assemble + execute ----------------------------------------------
  const plan = assembleImportPlan({
    mapped,
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
    hasVariations,
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
  // write to the same shared arrays isn't dropped.
  await produtoCollection.docRef(db, {}, produtoId).update({
    marketplace: FieldValue.arrayUnion({
      integracaoUid: integracaoId,
      externalId: plan.denormItemId,
    }),
    marketplaceIds: FieldValue.arrayUnion(plan.denormItemId),
    integracoesComProduto: FieldValue.arrayUnion(integracaoId),
  });

  // Variation children (#520) — one produto per usable ML variation, run after
  // the parent's own produto/link exist (children reference the parent link's
  // outer-ref). No-op ({ total: 0, created: 0 }) for a simple listing.
  let variationsResult = { total: 0, created: 0 };
  if (hasVariations) {
    const parentLinkOuterRef = toOuterRef(`produtos/${produtoId}/produtoMercadoLivre/${linkDocId}`);
    variationsResult = await importVariationChildren(
      { db, integracaoId, options, depositoOuterRef: deps.depositoOuterRef, now },
      {
        produtoId,
        precos: resolveParentPrecosForChildren(isCreate, plan, existingProduto),
        linkOuterRef: parentLinkOuterRef,
        mlItemId: itemId,
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
      },
      mappedVariations,
      taxonomia,
    );
  }

  // Photos (#439) — additive, high-quality, best-effort. After the produto exists;
  // skips already-imported pictures; per-picture failures are logged, not fatal.
  // Requires a Storage bucket (omitted in tests that don't exercise photos).
  if (options.importarFotos && deps.bucket && (item.pictures?.length ?? 0) > 0) {
    await importProdutoPhotos(
      { db, bucket: deps.bucket, integracaoId, fetchImpl: deps.fetchImpl },
      produtoId,
      item.pictures ?? [],
    );
  }

  return {
    produtoId,
    estado: mapped.estado,
    nome: mapped.nome,
    created: isCreate,
    variations: variationsResult,
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
