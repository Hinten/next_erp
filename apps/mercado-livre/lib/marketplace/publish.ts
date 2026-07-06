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
import type { Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreError,
  MercadoLivreHttpError,
  buildItemPayload,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import type { Arquivo, Foto, ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { estoqueDisponivel, idFromRef, parseFakePath } from '@delfrance/schemas';
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
  const linkDocId =
    linkDoc?.docId ?? produtoMercadoLivreLinkCollection.ref(db, { produtoId }).doc().id;

  // ---- Stock (integração's depósito when set; else every depósito) -------
  const depositoId = deps.depositoOuterRef ? idFromRef(deps.depositoOuterRef) : null;
  const availableQuantity = await loadDisponivel(db, produtoId, depositoId);
  const variations: PublishVariationChild[] = [];
  for (const child of children) {
    const childAvailable = await loadDisponivel(db, child.id, depositoId);
    const existingVar = await findVariacaoLink(db, child.id, integracaoId, linkDoc?.docId ?? null);
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
  const pictures = await resolvePictures(deps, produto.fotos ?? []);

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

  const now = Date.now();
  let item;
  try {
    item = input.isUpdate
      ? await api.updateItem(link!.id!, payload)
      : await api.createItem(payload);
  } catch (err) {
    if (err instanceof MercadoLivreError) {
      await produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId).set(
        produtoMercadoLivreLinkCollection.parse({
          contaOuterRef: linkDoc?.data.contaOuterRef ?? `integracao/${integracaoId}`,
          title: produto.nome,
          sku: produto.sku ?? null,
          condition: input.condition,
          category_id: categoryId,
          listing_type_id: input.listingTypeId ?? null,
          estado: 'E',
          id: link?.id ?? null,
          isUserProductModel: input.isUserProductSeller,
          attributes: link?.attributes ?? null,
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
      contaOuterRef: linkDoc?.data.contaOuterRef ?? `integracao/${integracaoId}`,
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
      attributes: link?.attributes ?? null,
      errors: [],
      ultimaModificacao: now,
      dataCadastro: linkDoc?.data.dataCadastro ?? now,
    }),
  );

  // Variation links live under each CHILD produto, keyed back to the parent
  // link doc — matched by seller_custom_field (= the child produto id).
  for (const respVar of item.variations ?? []) {
    const childId = respVar.seller_custom_field;
    if (!childId) continue;
    const child = variations.find((v) => v.produto.id === childId);
    if (!child) continue;
    const existing = await findVariacaoLink(db, childId, integracaoId, linkDocId);
    const varDocId =
      existing?.docId ??
      variacaoMercadoLivreLinkCollection.ref(db, { produtoId: childId }).doc().id;
    await variacaoMercadoLivreLinkCollection.docRef(db, { produtoId: childId }, varDocId).set(
      variacaoMercadoLivreLinkCollection.parse({
        id: typeof respVar.id === 'number' ? respVar.id : null,
        itemId: null,
        produtoVariacaoOuterRef: `produtos/${childId}`,
        produtoMercadoLivreOuterRef: `produtos/${produtoId}/produtoMercadoLivre/${linkDocId}`,
        sku: child.produto.sku ?? null,
        attributes: null,
      }),
    );
  }

  // ---- Description (link's own text wins; else the produto's extraData) ---
  const descricao = linkDoc?.data.descricao ?? extra?.descricao ?? null;
  if (descricao) {
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

/** `contaOuterRef` appears as `integracao/<id>` or `documents/integracao/<id>`. */
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

/** The child's variacaoMercadoLivre link for this integração's parent link. */
async function findVariacaoLink(
  db: Firestore,
  childId: string,
  integracaoId: string,
  parentLinkDocId: string | null,
): Promise<{ docId: string; mlId: number | null } | null> {
  const snap = await variacaoMercadoLivreLinkCollection.ref(db, { produtoId: childId }).get();
  for (const d of snap.docs) {
    const data = d.data() as { id?: number | null; produtoMercadoLivreOuterRef?: string };
    const parentRef = data.produtoMercadoLivreOuterRef ?? '';
    // Match by the parent link doc when known; else by any ML link (single-conta accounts).
    if (parentLinkDocId ? parentRef.endsWith(`/produtoMercadoLivre/${parentLinkDocId}`) : true) {
      return { docId: d.id, mlId: typeof data.id === 'number' ? data.id : null };
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
): Promise<Array<{ id: string }>> {
  const { db, api, integracaoId } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const out: Array<{ id: string }> = [];

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
      out.push({ id: cached.externalId });
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

    await arquivoCollection.merge(db, {}, arquivoId, {
      externalIds: [
        ...(arquivo.externalIds ?? []),
        { externalId: uploaded.id, integracaoPath: `integracao/${integracaoId}` },
      ],
    });
    out.push({ id: uploaded.id });
  }
  return out;
}
