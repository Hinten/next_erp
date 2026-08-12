/**
 * Variation-children orchestration (IO layer, ML→ERP) — issue #520, extended
 * for User-Products (#521). Called from `import.ts` once the parent produto +
 * its `produtoMercadoLivre` link exist: writes one child produto per usable
 * entry — its own produto doc, `variacaoMercadoLivre` link, estoque, and the
 * dual-run `marketplace` denorm — using the taxonomy resolved by
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
 * No photo import here (legacy parity): `variations[].picture_ids` /
 * User-Products per-member pictures are never imported — only the
 * parent-level `item.pictures` are (handled by `import.ts` itself, via
 * `importPhotos.ts`, after this module returns).
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { type MappedMlVariation } from '@delfrance/integrations-mercado-livre';
import {
  estoqueCollection,
  produtoCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  type ImportOptions,
  type VariationChildAssembleArgs,
  assembleVariationChildPlan,
} from './importCore';
import { type TaxonomiaResolution } from './taxonomiaCore';
import { isAlreadyExists } from '@delfrance/data/admin';
import { lastSegment } from './linkRefs';

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

  for (const mappedVariation of mappedVariations) {
    const resolved = await resolveExistingChild(
      db,
      mappedVariation.variationId,
      mappedVariation.sku,
      parent.produtoId,
      parent.linkOuterRef,
      up != null,
    );
    const fixedWidthId = up
      ? `XMLB000000000000000${up.parentLinkDocId}vMLB${mappedVariation.variationId}`
      : null;
    const produtoId =
      resolved?.produtoId ??
      fixedWidthId ??
      sha256(`${parent.produtoId}|${mappedVariation.variationId}`);
    const linkDocId =
      resolved?.linkDocId ??
      fixedWidthId ??
      `XMLB000000000000000${parent.mlItemId}vMLB${mappedVariation.variationId}`;

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
      up: up ? { itemId: mappedVariation.variationId } : null,
      now,
    };
    let plan = assembleVariationChildPlan(args);
    let stockForWrite = existingStock;

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

    // estoque (create = set; overwrite = merge quantidade — keeps reservada)
    if (plan.estoque) {
      if (stockForWrite == null) {
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

    // variacaoMercadoLivre link (full set, spread-existing — schema is .passthrough())
    await variacaoMercadoLivreLinkCollection
      .docRef(db, { produtoId }, linkDocId)
      .set(variacaoMercadoLivreLinkCollection.parse(plan.link));

    // Dual-run denorm (DEAD WEIGHT; #431 lock 3 / #961 — no query consumers in
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
  }

  return { total: mappedVariations.length, created };
}

/* -------------------------------------------------------------------------- */

interface ResolvedChild {
  produtoId: string;
  /** Existing link doc id + raw (when resolved via the link); null via SKU. */
  linkDocId: string | null;
  linkRaw: Record<string, unknown> | null;
}

/**
 * Resolve the ERP child produto for one variation/member: first by an existing
 * `variacaoMercadoLivre` link scoped to THIS parent link (a collectionGroup
 * query, filtered by the exact `produtoMercadoLivreOuterRef` string), then by
 * `sku` + `paiId == parentProdutoId` — and when found by SKU, REUSE that
 * child's existing link for this parent if present. Null → create.
 *
 * `matchByItemId` selects the link-lookup field: legacy `variations[]`
 * (false) matches on the numeric `id` field (a variation id is only unique
 * within its own item, hence the parent-link scoping); User-Products (true)
 * matches on the string `itemId` field (the member's own MLB id — globally
 * unique, but still parent-scoped for symmetry/defense-in-depth).
 */
async function resolveExistingChild(
  db: Firestore,
  variationId: string,
  childSku: string | null,
  parentProdutoId: string,
  parentLinkOuterRef: string,
  matchByItemId: boolean,
): Promise<ResolvedChild | null> {
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
      // across the whole DB. Exact string equality is safe here (both apps write the
      // same `documents/...` form) — unlike the parent's tolerant refMatchesIntegracao.
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

  if (childSku) {
    const skuSnap = await produtoCollection
      .ref(db, {})
      .where('sku', '==', childSku)
      .where('paiId', '==', parentProdutoId)
      .limit(1)
      .get();
    const doc = skuSnap.docs[0];
    if (doc) {
      // Reuse an existing link to THIS parent under the SKU-matched child, so a
      // re-import updates it rather than creating a second link doc.
      const linkSub = await variacaoMercadoLivreLinkCollection.ref(db, { produtoId: doc.id }).get();
      const existingLink = linkSub.docs.find(
        (l) =>
          (l.data() as Record<string, unknown>).produtoMercadoLivreOuterRef === parentLinkOuterRef,
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
 * Stable hex hash for deterministic child produto ids (dual-run convergence) —
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
