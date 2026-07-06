/**
 * Product-publish orchestration (IO layer): loads the produto graph from
 * Firestore, uploads pictures to ML (with the per-integração `externalIds`
 * cache on each Arquivo — the old app's dedupe, so a re-publish never
 * re-uploads), assembles the payload via `publishCore` + the plugin mapper,
 * calls `createItem`/`updateItem`, and persists the `produtoMercadoLivre` /
 * `variacaoMercadoLivre` link docs in the exact old Flutter wire shape.
 *
 * Failure semantics (ported from the old flow): validation problems throw
 * `MercadoLivrePublishError` BEFORE any ML call; an ML API failure after that
 * stamps `estado: 'E'` + `errors: [message]` on the link doc and rethrows, so
 * the UI shows the reason and a later retry overwrites it.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreError,
  MercadoLivreHttpError,
  buildItemPayload,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import type { Arquivo, Foto, ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { estoqueDisponivel, idFromRef, parseFakePath, toOuterRef } from '@delfrance/schemas';
import {
  arquivoCollection,
  estoqueCollection,
  grupoDeVariacoesCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  MercadoLivrePublishError,
  type PublishGrupoVariacao,
  type PublishLink,
  type PublishProduto,
  type PublishVariationChild,
  assemblePublishInput,
} from './publishCore';

/** ML caps listings at 10 pictures (the old app enforced the same). */
const MAX_PICTURES = 10;

export interface PublishDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  /** From the integração doc (parsed upstream by loadMercadoLivreContext). */
  tabelaNormalOuterRef: string | null;
  depositoOuterRef: string | null;
  /** Listing type for FIRST publishes (link doc value wins on re-publish). */
  listingTypeId?: string | null;
  /** Injectable for tests — downloads image bytes from `arquivo.url`. */
  fetchImpl?: typeof globalThis.fetch;
}

export interface PublishResult {
  itemId: string;
  estado: string;
  permalink: string | null;
}

export async function publishProduto(deps: PublishDeps, produtoId: string): Promise<PublishResult> {
  const { db, api, integracaoId } = deps;

  // ---- Load the produto graph -------------------------------------------
  const produtoSnap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!produtoSnap.exists) {
    throw new MercadoLivrePublishError([`produto ${produtoId} não encontrado`]);
  }
  const produto = produtoCollection.parseRead(
    produtoSnap.data(),
    produtoCollection.docPath({}, produtoId),
  );
  if (produto.paiId) {
    throw new MercadoLivrePublishError([
      'este produto é uma variação — publique o produto pai (a variação vai junto)',
    ]);
  }

  const extraSnap = await produtoExtraDataCollection.docRef(db, { produtoId }, 'singleton').get();
  const extra = extraSnap.exists
    ? produtoExtraDataCollection.parseRead(
        extraSnap.data(),
        produtoExtraDataCollection.docPath({ produtoId }, 'singleton'),
      )
    : null;

  const childrenSnap = await produtoCollection.ref(db, {}).where('paiId', '==', produtoId).get();
  const children = childrenSnap.docs.map((d) => ({
    id: d.id,
    data: produtoCollection.parseRead(d.data(), produtoCollection.docPath({}, d.id)),
  }));

  // ---- Existing link docs (this integração) ------------------------------
  const linkSnap = await produtoMercadoLivreLinkCollection.ref(db, { produtoId }).get();
  const linkDoc = linkSnap.docs
    .map((d) => ({ docId: d.id, data: d.data() as Partial<ProdutoMercadoLivreLink> }))
    .find((d) => refMatchesIntegracao(d.data.contaOuterRef, integracaoId));
  const link: PublishLink | null = linkDoc
    ? {
        docId: linkDoc.docId,
        id: linkDoc.data.id ?? null,
        condition: linkDoc.data.condition ?? null,
        listing_type_id: linkDoc.data.listing_type_id ?? null,
        category_id: linkDoc.data.category_id ?? null,
        isUserProductModel: linkDoc.data.isUserProductModel ?? false,
        attributes: linkDoc.data.attributes ?? null,
        video_id: linkDoc.data.video_id ?? null,
      }
    : null;
  const linkDocId = linkDoc?.docId ?? produtoMercadoLivreLinkCollection.newDocId(db, { produtoId });

  // ---- Stock (integração's depósito when set; else every depósito) -------
  const depositoId = deps.depositoOuterRef ? idFromRef(deps.depositoOuterRef) : null;
  const availableQuantity = await loadDisponivel(db, produtoId, depositoId);
  const variations: PublishVariationChild[] = [];
  for (const child of children) {
    const childAvailable = await loadDisponivel(db, child.id, depositoId);
    // No parent link for THIS integração yet ⇒ the child cannot have a
    // legitimate existing variation on this listing (any variacao docs it
    // holds belong to other accounts).
    const existingVar = linkDoc ? await findVariacaoLink(db, child.id, linkDoc.docId) : null;
    variations.push({
      produto: toPublishProduto(child.id, child.data),
      variacoesUid: child.data.variacoesUid ?? [],
      availableQuantity: childAvailable,
      mlVariationId: existingVar?.mlId ?? null,
    });
  }

  // ---- Variation groups ---------------------------------------------------
  const grupoIds = new Set<string>();
  for (const v of variations) {
    for (const uid of v.variacoesUid) {
      const parsed = parseFakePath(uid);
      if (parsed) grupoIds.add(parsed.grupoId);
    }
  }
  const grupos: PublishGrupoVariacao[] = [];
  for (const grupoId of grupoIds) {
    const snap = await grupoDeVariacoesCollection.docRef(db, {}, grupoId).get();
    if (!snap.exists) continue; // reported as a per-variation issue downstream
    const g = grupoDeVariacoesCollection.parseRead(
      snap.data(),
      grupoDeVariacoesCollection.docPath({}, grupoId),
    );
    grupos.push({
      grupoId,
      nome: g.nome,
      tipo: g.tipo ?? null,
      variacoes: (g.variacoes ?? []).map((v) => ({ id: v.id, nome: v.nome })),
    });
  }

  // ---- Pictures (upload once per integração; cached on the Arquivo) ------
  const { pictures, pictureSources } = await resolvePictures(deps, produto.fotos ?? []);

  // ---- Category (existing link wins; else suggest from the title) --------
  let categoryId = link?.category_id ?? null;
  if (!categoryId && link?.id == null) {
    const suggestions = await api.suggestCategories(produto.nome, 1);
    categoryId = suggestions[0]?.category_id ?? null;
  }

  // ---- Assemble + call ML -------------------------------------------------
  const input = assemblePublishInput({
    produto: toPublishProduto(produtoId, produto),
    condicao: typeof extra?.condicao === 'number' ? extra.condicao : null,
    priceListId: deps.tabelaNormalOuterRef ? idFromRef(deps.tabelaNormalOuterRef) : null,
    availableQuantity,
    pictures,
    variations,
    grupos,
    link,
    linkDocId,
    categoryId,
    listingTypeId: link?.listing_type_id ?? deps.listingTypeId ?? null,
    isUserProductSeller: link?.isUserProductModel ?? false,
  });
  const payload = buildItemPayload(input);

  // Both link-doc writes below SPREAD the existing raw doc first — the old
  // app persisted via `copyWith(...).save()`, so a re-publish must preserve
  // every Flutter-authored field it doesn't own (descricao, channels,
  // video_id, crossdocking, tarifaFrete, comissao + unknown legacy keys via
  // `.passthrough()`), never reset them to the schema defaults.
  const now = Date.now();
  let item;
  try {
    item = input.isUpdate
      ? await api.updateItem(link!.id!, payload)
      : await api.createItem(payload);
  } catch (err) {
    if (err instanceof MercadoLivreError) {
      // Old-app parity: a purged ML picture id in the cache would otherwise
      // fail every retry identically — strip it so the next publish re-uploads.
      await pruneDeadPictures(db, err, pictureSources);
      await produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId).set(
        produtoMercadoLivreLinkCollection.parse({
          ...(linkDoc?.data ?? {}),
          contaOuterRef: linkDoc?.data.contaOuterRef ?? toOuterRef(`integracao/${integracaoId}`),
          title: produto.nome,
          sku: produto.sku ?? null,
          condition: input.condition,
          category_id: linkDoc?.data.category_id ?? categoryId,
          listing_type_id: linkDoc?.data.listing_type_id ?? input.listingTypeId ?? null,
          estado: 'E',
          isUserProductModel: input.isUserProductSeller,
          errors: [err.message],
          ultimaModificacao: now,
          dataCadastro: linkDoc?.data.dataCadastro ?? now,
        }),
      );
    }
    throw err;
  }

  // ---- Persist the link docs from the response ---------------------------
  const estado = estadoFromMlStatus(item.status);
  await produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId).set(
    produtoMercadoLivreLinkCollection.parse({
      ...(linkDoc?.data ?? {}),
      contaOuterRef: linkDoc?.data.contaOuterRef ?? toOuterRef(`integracao/${integracaoId}`),
      title: produto.nome,
      sku: produto.sku ?? null,
      condition: input.condition,
      category_id: item.category_id ?? categoryId,
      listing_type_id: item.listing_type_id ?? input.listingTypeId ?? null,
      estado,
      id: item.id,
      precoPublicado: item.price ?? null,
      freteGratis: item.shipping?.free_shipping ?? false,
      isUserProductModel: input.isUserProductSeller,
      errors: [],
      ultimaModificacao: now,
      dataCadastro: linkDoc?.data.dataCadastro ?? now,
    }),
  );

  // ---- Dual-run denorm stamps (DEPRECATED arrays — legacy consumers only) --
  // The deployed Flutter backend resolves an incoming ML order item via
  // `marketplace array-contains {integracaoUid, externalId}` (EXACT map match
  // — hence no `relevantData`, the shape its own webhook repair writes) and
  // gates its stock sender on `integracoesComProduto`. The new app never READS
  // these fields (linkage is Firestore Pipelines); the stamps exist only so
  // listings published here stay visible to the legacy flows during
  // coexistence. Success-only, like the old app. Tracked removal: #431.
  await produtoCollection.docRef(db, {}, produtoId).update({
    marketplace: FieldValue.arrayUnion({ integracaoUid: integracaoId, externalId: item.id }),
    marketplaceIds: FieldValue.arrayUnion(item.id),
    integracoesComProduto: FieldValue.arrayUnion(integracaoId),
  });

  // Variation links live under each CHILD produto, keyed back to the parent
  // link doc — matched by seller_custom_field (= the child produto id).
  for (const respVar of item.variations ?? []) {
    const childId = respVar.seller_custom_field;
    if (!childId) continue;
    const child = variations.find((v) => v.produto.id === childId);
    if (!child) continue;
    const existing = await findVariacaoLink(db, childId, linkDocId);
    const varDocId =
      existing?.docId ?? variacaoMercadoLivreLinkCollection.newDocId(db, { produtoId: childId });
    await variacaoMercadoLivreLinkCollection.docRef(db, { produtoId: childId }, varDocId).set(
      variacaoMercadoLivreLinkCollection.parse({
        // Spread first: Flutter regenerates the NEXT publish's non-SIZE/COLOR
        // attribute_combinations from the stored `attributes` — wiping them
        // (or `itemId`) would corrupt its republish.
        ...(existing?.raw ?? {}),
        id: typeof respVar.id === 'number' ? respVar.id : (existing?.mlId ?? null),
        produtoVariacaoOuterRef:
          (existing?.raw.produtoVariacaoOuterRef as string | undefined) ??
          toOuterRef(`produtos/${childId}`),
        produtoMercadoLivreOuterRef:
          (existing?.raw.produtoMercadoLivreOuterRef as string | undefined) ??
          toOuterRef(`produtos/${produtoId}/produtoMercadoLivre/${linkDocId}`),
        sku: child.produto.sku ?? null,
      }),
    );
    if (respVar.id != null) {
      await stampChildMarketplace(db, integracaoId, item.id, childId, String(respVar.id));
    }
  }

  // ---- Description (link's own text wins; else the produto's extraData) ---
  const descricao = linkDoc?.data.descricao ?? extra?.descricao ?? null;
  if (descricao) {
    try {
      try {
        await api.setItemDescription(item.id, descricao, { replace: input.isUpdate });
      } catch (err) {
        // A fresh item can already carry a description (ML auto-creates one for
        // some categories) — POST then 400s; the PUT replace variant fixes it.
        if (err instanceof MercadoLivreHttpError && err.status === 400 && !input.isUpdate) {
          await api.setItemDescription(item.id, descricao, { replace: true });
        } else {
          throw err;
        }
      }
    } catch (err) {
      // The item itself published, but the header contract still holds: any ML
      // failure must leave its reason on the doc (the old app stamped these
      // from the same catch), not just a transient HTTP error to the UI.
      if (err instanceof MercadoLivreError) {
        await produtoMercadoLivreLinkCollection.merge(db, { produtoId }, linkDocId, {
          estado: 'E',
          errors: [err.message],
          ultimaModificacao: Date.now(),
        });
      }
      throw err;
    }
  }

  return { itemId: item.id, estado, permalink: item.permalink ?? null };
}

/* -------------------------------------------------------------------------- */

function toPublishProduto(
  id: string,
  p: {
    nome: string;
    sku?: string | null;
    ehUsado?: boolean;
    pesoLiquidoKg?: number | null;
    pesoBrutoKg?: number | null;
    alturaCm?: number | null;
    larguraCm?: number | null;
    profundidadeCm?: number | null;
    precos?: Record<string, { valor: number }> | null;
    ordem?: number | null;
  },
): PublishProduto {
  return {
    id,
    nome: p.nome,
    sku: p.sku ?? null,
    ehUsado: p.ehUsado ?? false,
    pesoLiquidoKg: p.pesoLiquidoKg ?? null,
    pesoBrutoKg: p.pesoBrutoKg ?? null,
    alturaCm: p.alturaCm ?? null,
    larguraCm: p.larguraCm ?? null,
    profundidadeCm: p.profundidadeCm ?? null,
    precos: p.precos ?? null,
    ordem: p.ordem ?? null,
  };
}

/**
 * Dual-run stamp for a VARIATION CHILD's deprecated `marketplace` arrays —
 * legacy read-clean-write semantics (`exportarProdutos.dart` variation loop):
 * drop stale same-conta entries for this listing (a recreated variation gets a
 * new ML id) and parent-shaped entries wrongly sitting on a child, then append
 * the fresh `{integracaoUid, externalParentId, externalId}` entry (no
 * `relevantData` — the legacy order-import probe matches the map EXACTLY and
 * carries none). arrayUnion can't express the cleanup, so this mirrors the old
 * `transform(newValues:)` full-field write. Tracked removal: #431.
 */
async function stampChildMarketplace(
  db: Firestore,
  integracaoId: string,
  itemId: string,
  childId: string,
  variationId: string,
): Promise<void> {
  const snap = await produtoCollection.docRef(db, {}, childId).get();
  if (!snap.exists) return;
  const raw = (snap.data() ?? {}) as Record<string, unknown>;

  const current = Array.isArray(raw.marketplace)
    ? (raw.marketplace as Array<Record<string, unknown>>)
    : [];
  const cleaned = current.filter((e) => {
    if (e?.integracaoUid !== integracaoId) return true; // other conta — keep
    if (e.externalParentId == null) return false; // parent-shaped on a child
    return !(e.externalParentId === itemId && e.externalId !== variationId); // stale id
  });
  cleaned.push({ integracaoUid: integracaoId, externalParentId: itemId, externalId: variationId });

  const ids = new Set(Array.isArray(raw.marketplaceIds) ? (raw.marketplaceIds as string[]) : []);
  ids.add(variationId);
  const contas = new Set(
    Array.isArray(raw.integracoesComProduto) ? (raw.integracoesComProduto as string[]) : [],
  );
  contas.add(integracaoId);

  await produtoCollection.merge(db, {}, childId, {
    marketplace: cleaned,
    marketplaceIds: [...ids],
    integracoesComProduto: [...contas],
  });
}

/**
 * The old app always STORES `documents/integracao/<id>` (`pathWithDocuments`,
 * `OuterRefField.toJson`) — that's also what this module writes. The bare
 * `integracao/<id>` form is tolerated on READ only, defensively.
 */
function refMatchesIntegracao(ref: string | undefined, integracaoId: string): boolean {
  if (!ref) return false;
  return ref === `integracao/${integracaoId}` || ref.endsWith(`/integracao/${integracaoId}`);
}

/** Available stock: the integração's depósito when set, else every depósito. */
async function loadDisponivel(
  db: Firestore,
  produtoId: string,
  depositoId: string | null,
): Promise<number> {
  const snap = await estoqueCollection.ref(db, { produtoId }).get();
  let total = 0;
  for (const d of snap.docs) {
    const e = estoqueCollection.parseRead(d.data(), estoqueCollection.docPath({ produtoId }, d.id));
    if (depositoId && idFromRef(e.depositoOuterRef) !== depositoId) continue;
    total += estoqueDisponivel(e);
  }
  return Math.max(0, total);
}

/**
 * The child's variacaoMercadoLivre link belonging to the given parent link doc
 * (matched via `produtoMercadoLivreOuterRef`). Strict on purpose: with
 * multi-conta support a child can hold variation links from OTHER accounts'
 * listings, so "no parent link yet" must mean "no variation link" — never a
 * fallback to whichever doc happens to come first.
 */
async function findVariacaoLink(
  db: Firestore,
  childId: string,
  parentLinkDocId: string,
): Promise<{ docId: string; mlId: number | null; raw: Record<string, unknown> } | null> {
  const snap = await variacaoMercadoLivreLinkCollection.ref(db, { produtoId: childId }).get();
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    const parentRef =
      typeof data.produtoMercadoLivreOuterRef === 'string' ? data.produtoMercadoLivreOuterRef : '';
    if (parentRef.endsWith(`/produtoMercadoLivre/${parentLinkDocId}`)) {
      return { docId: d.id, mlId: typeof data.id === 'number' ? data.id : null, raw: data };
    }
  }
  return null;
}

/**
 * Resolve the produto's fotos to ML picture ids, uploading at most once per
 * integração: each Arquivo caches `externalIds: [{externalId, integracaoPath}]`
 * (the old app's shape), so a re-publish reuses the cached id.
 */
async function resolvePictures(
  deps: PublishDeps,
  fotos: ReadonlyArray<Foto>,
): Promise<{ pictures: Array<{ id: string }>; pictureSources: Map<string, string> }> {
  const { db, api, integracaoId } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const pictures: Array<{ id: string }> = [];
  /** ML picture id → owning arquivo doc id (feeds the dead-picture self-heal). */
  const pictureSources = new Map<string, string>();

  for (const foto of fotos.slice(0, MAX_PICTURES)) {
    const arquivoId = foto.arquivoOuterRef.replace(/^arquivos\//, '');
    const snap = await arquivoCollection.docRef(db, {}, arquivoId).get();
    if (!snap.exists) continue; // a broken foto ref must not block the publish
    const arquivo = arquivoCollection.parseRead(
      snap.data(),
      arquivoCollection.docPath({}, arquivoId),
    ) as Arquivo;

    const cached = (arquivo.externalIds ?? []).find((e) =>
      refMatchesIntegracao(e.integracaoPath, integracaoId),
    );
    if (cached) {
      pictures.push({ id: cached.externalId });
      pictureSources.set(cached.externalId, arquivoId);
      continue;
    }

    if (!arquivo.url) continue;
    const res = await doFetch(arquivo.url);
    if (!res.ok) {
      throw new MercadoLivrePublishError([
        `falha ao baixar a foto ${arquivoId} do Storage (HTTP ${res.status})`,
      ]);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const uploaded = await api.uploadPicture({
      filename: arquivo.filename,
      contentType: arquivo.contentType ?? 'image/jpeg',
      data: bytes,
    });

    // arrayUnion, not a whole-array overwrite: the Flutter app (and a
    // concurrent publish to another conta) appends to the SAME shared array —
    // a read-modify-write here would drop entries written during the upload
    // window (the old app used `appendMissingElements` for exactly this).
    // `integracaoPath` is stored `documents/`-prefixed: Flutter's cache lookup
    // (`getExternalId`) compares against `pathWithDocuments` by EXACT equality.
    await arquivoCollection.docRef(db, {}, arquivoId).update({
      externalIds: FieldValue.arrayUnion({
        externalId: uploaded.id,
        integracaoPath: toOuterRef(`integracao/${integracaoId}`),
      }),
    });
    pictures.push({ id: uploaded.id });
    pictureSources.set(uploaded.id, arquivoId);
  }
  return { pictures, pictureSources };
}

/**
 * Old-app parity self-heal (`exportarProdutos.dart` picture_not_found branch):
 * when ML rejects the publish because a cached picture id no longer exists
 * (ML purges uploads), strip that entry from the owning Arquivo's
 * `externalIds` so the NEXT publish re-uploads instead of failing forever on
 * the same dead id.
 */
async function pruneDeadPictures(
  db: Firestore,
  err: MercadoLivreError,
  pictureSources: ReadonlyMap<string, string>,
): Promise<void> {
  if (!(err instanceof MercadoLivreHttpError)) return;
  const body = JSON.stringify(err.body ?? '');
  if (!body.includes('item.pictures.picture_not_found')) return;

  // ML's cause message: "Picture id <id> does not exist." (the old app parsed
  // the same string). Only ids we actually sent this publish are pruned.
  const deadIds = [...body.matchAll(/Picture id (\S+?) does not exist/g)]
    .map((m) => m[1]!)
    .filter((id) => pictureSources.has(id));

  for (const dead of deadIds) {
    const arquivoId = pictureSources.get(dead)!;
    const snap = await arquivoCollection.docRef(db, {}, arquivoId).get();
    if (!snap.exists) continue;
    const arquivo = arquivoCollection.parseRead(
      snap.data(),
      arquivoCollection.docPath({}, arquivoId),
    ) as Arquivo;
    const kept = (arquivo.externalIds ?? []).filter((e) => e.externalId !== dead);
    if (kept.length === (arquivo.externalIds ?? []).length) continue;
    await arquivoCollection.merge(db, {}, arquivoId, { externalIds: kept });
  }
}
