/**
 * Product-import orchestration (IO layer, ML→ERP): fetches a Mercado Livre item,
 * maps it (plugin `importItem`), resolves/creates the ERP produto, and writes the
 * produto + extraData + estoque + `produtoMercadoLivre` link in the exact Flutter
 * wire shape (dual-run). The inverse of `publish.ts`.
 *
 * 7a scope: SIMPLE listings only — a `variations[]` or `family_name` item is
 * rejected with a clear message (variation/User-Products import needs the
 * deferred variation-taxonomy work, #438). Existing ERP data is preserved:
 * parent fields fill-nulls, stock never clobbered unless `sobrescreverEstoque`.
 *
 * Dedup / dual-run convergence: the produto is resolved by the link doc's `id`
 * (== ML item id, a collectionGroup query — the same key the Flutter app matches
 * on), then by `sku`; a fresh produto's id reuses an alphanumeric
 * `seller_custom_field`, else a deterministic `sha256(sellerUserId|itemId)`.
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreError,
  mapMlItemToImport,
} from '@delfrance/integrations-mercado-livre';
import { PRODUTO_EXTRA_DATA_DOC_ID } from '@delfrance/schemas';
import {
  estoqueCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  type ImportOptions,
  DEFAULT_IMPORT_OPTIONS,
  MercadoLivreImportError,
  assembleImportPlan,
} from './importCore';

export interface ImportDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  /** The account's ML seller id (integração `user_id`) — the ownership guard. */
  sellerUserId: number | null;
  tabelaNormalOuterRef: string | null;
  tabelaPromocionalOuterRef: string | null;
  depositoOuterRef: string | null;
  options?: Partial<ImportOptions>;
}

export interface ImportResult {
  produtoId: string;
  estado: string;
  nome: string;
  created: boolean;
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
  if (item.family_name != null || (item.variations?.length ?? 0) > 0) {
    throw new MercadoLivreImportError([
      `anúncio ${itemId} tem variações — a importação de variações/User-Products ainda não está disponível (issue #438)`,
    ]);
  }
  if (deps.sellerUserId == null) {
    throw new MercadoLivreImportError(['integração sem user_id — reconecte a conta']);
  }
  if (item.seller_id != null && item.seller_id !== deps.sellerUserId) {
    throw new MercadoLivreImportError([`anúncio ${itemId} pertence a outro vendedor`]);
  }

  const mapped = mapMlItemToImport(item);

  // Best-effort description (a missing/failed description never blocks import).
  let descricao: string | null = null;
  try {
    const desc = await api.getItemDescription(itemId);
    descricao = desc.plain_text ?? desc.text ?? null;
  } catch (err) {
    if (!(err instanceof MercadoLivreError)) throw err;
  }

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
  const existingStock =
    isCreate || !depositoId ? null : await readEstoque(db, produtoId, depositoId);

  // ---- Assemble + execute ----------------------------------------------
  const now = Date.now();
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
    existingProduto,
    existingLinkRaw,
    existingExtra,
    existingEstoqueQty: existingStock?.quantidade ?? null,
    existingEstoqueReservada: existingStock?.reservada ?? null,
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

  return { produtoId, estado: mapped.estado, nome: mapped.nome, created: isCreate };
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

/** gRPC ALREADY_EXISTS (code 6) from `docRef.create()` on a doc that now exists. */
function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 6;
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

/** Tolerates the stored `documents/integracao/<id>` form + the bare form. */
function refMatchesIntegracao(ref: unknown, integracaoId: string): boolean {
  if (typeof ref !== 'string') return false;
  return ref === `integracao/${integracaoId}` || ref.endsWith(`/integracao/${integracaoId}`);
}

function lastSegment(ref: string): string {
  const parts = ref.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? ref;
}
