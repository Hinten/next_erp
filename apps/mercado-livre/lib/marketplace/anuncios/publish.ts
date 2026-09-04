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
 *
 * ⚠️ Which of ML's two publishing models applies is decided here, not by the
 * link doc alone — see `resolveListingModel` in `publishCore.ts`. A first
 * publish costs one `GET /users/me` to read the `user_product_seller` tag; a
 * re-publish costs none.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreError,
  MercadoLivreHttpError,
  type MlAttribute,
  type MlItem,
  type MlShippingMode,
  type MlUser,
  buildItemPayload,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import type {
  Arquivo,
  ComponentesKit,
  Foto,
  ProdutoMercadoLivreLink,
  Variante,
} from '@delfrance/schemas';
import {
  INTEGRACAO_TIPO,
  componentesKitEntries,
  estoqueDisponivel,
  fotosForVariacao,
  idFromRef,
  mlSizeChartsForConta,
  parseFakePath,
  precisaConsultarModeracao,
  toOuterRef,
} from '@delfrance/schemas';
import {
  type PublishUserProductResult,
  type UserProductMember,
  publishUserProductMembers,
  sweepRemovedMembers,
} from './publishUserProduct';
import { type EscopoFalha, falhaPatch } from '../core/publishFalhas';
import {
  arquivoCollection,
  estoqueCollection,
  grupoDeVariacoesCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoMercadoLivreLinkCollection,
  tabelaDeMedidasCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin';

import {
  MercadoLivrePublishError,
  type PublishGrupoVariacao,
  type PublishLink,
  type PublishProduto,
  type PublishVariationChild,
  type TabelaBindingMotivo,
  assemblePublishInput,
  classificarMembroUnico,
  linkAttributesAfterPublish,
  publishModeIssues,
  resolveCondition,
  resolveListingModel,
  resolveSkuPaiAtributo,
} from './publishCore';
import { garantirMembroUnico } from './upSoleMemberWrite';
import { quantidadeParaEnvio } from '../estoque/bulkEstoquePlan';
import { readListaDePrecos } from './listaDePrecosCache';
import {
  type ResolvedSizeChart,
  type SizeChartMiss,
  type SizeChartRowBinding,
  findChartRow,
  resolveSizeChart,
} from '../size-charts/sizeChart';
import { categoriaUsaGuiaDeTamanhos } from '../categorias/categoriaAtributos';
import { getCategoriaAtributosCached, getCategoriaCached } from '../categorias/mlMetadataCache';

/** ML caps listings at 10 pictures (the old app enforced the same). */
const MAX_PICTURES = 10;

/**
 * Per-publish memo of `arquivo` doc id → its resolved ML picture (`null` = the
 * doc is missing or has no downloadable url, so it is skipped). See
 * {@link resolveOnePicture}.
 */
type PictureMemo = Map<string, { id: string; arquivoId: string } | null>;

/** Compare-and-set retries for the child denorm stamp (see stampChildMarketplace). */
const MAX_STAMP_ATTEMPTS = 3;

export interface PublishDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  /** From the integração doc (parsed upstream by loadMercadoLivreContext). */
  tabelaNormalOuterRef: string | null;
  depositoOuterRef: string | null;
  /**
   * The conta's `shipping.mode` (`integracao.modoEnvioMercadoLivre`), same
   * source as the two refs above. Null/absent sends no `shipping` node at all,
   * which is what every publish did before this existed — so an unconfigured
   * conta is unaffected. Rides on republishes too, so an existing "a combinar"
   * listing self-heals the next time it is published.
   */
  shippingMode?: MlShippingMode | null;
  /**
   * The conta's ML `user_id` — the seller whose items the removed-variation
   * sweep searches. Null disables the sweep (it cannot enumerate a family
   * without it), never anything else.
   */
  sellerUserId?: number | null;
  /** Listing type for FIRST publishes (link doc value wins on re-publish). */
  listingTypeId?: string | null;
  /**
   * Publish THIS link doc instead of whichever one comes first.
   *
   * A conta can hold several anúncios on one produto — storage has always
   * allowed it, and the stock and price sweeps already loop every one — but the
   * selection below could only ever name the first, which is what made a second
   * anúncio unpublishable. Null or absent keeps that historical behaviour
   * exactly: first match, else a freshly minted id for a first publish.
   */
  linkDocId?: string | null;
  /** Injectable for tests — downloads image bytes from `arquivo.url`. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * The User-Products capability probe seam — defaults to `api.getMe()`
   * (`GET /users/me`), the same shape the stock sweep's multiorigin guard uses.
   * Called at most ONCE per publish, and only on a FIRST publish (see
   * {@link resolveListingModel}).
   */
  getMe?: (api: MercadoLivreApi) => Promise<MlUser>;
}

export interface PublishResult {
  /** The parent link's external id — a FAMILY id under User Products. */
  itemId: string;
  estado: string;
  permalink: string | null;
  /**
   * Every ML item this publish wrote: one entry normally, one PER VARIATION for
   * a User-Products family.
   */
  itemIds: string[];
  /** Items closed because their ERP variation no longer exists (UP only). */
  orfaosEncerrados: string[];
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
  const contaLinks = linkSnap.docs
    .map((d) => ({ docId: d.id, data: d.data() as Partial<ProdutoMercadoLivreLink> }))
    .filter((d) => refMatchesIntegracao(d.data.contaOuterRef, integracaoId));
  /**
   * WHICH of the conta's anúncios this publish is for.
   *
   * Without `deps.linkDocId` this is the historical behaviour verbatim — the
   * first link matching the conta, or a fresh doc id when there is none. That
   * first-match is exactly what makes a second anúncio unpublishable, so the
   * caller that means a specific one says so.
   *
   * ⚠️ Ownership is re-derived from `contaLinks`, never taken on trust: the id
   * arrives in a request body, and resolving it against the whole subcollection
   * would let a caller publish one produto's listing under another conta. The
   * route 404s both cases before we get here (`publicar/route.ts`); this is the
   * backstop, and it is free because the snapshot is already in hand.
   */
  // Empty string counts as ABSENT.
  //
  // ⚠️ NOT for the reason `link.id !== ''` exists elsewhere in this module. That
  // one is about the **ML item id**, a schema field (`z.string().nullable()`,
  // no `.min(1)`) whose blank value really is in the migrated corpus. This is a
  // **Firestore document id**, and one can never be `''` — `.doc('')` throws
  // "Path must be a non-empty string". So `''` here cannot name a real doc, and
  // treating it as absent beats treating it as a guaranteed refusal.
  //
  // ⚠️ The route ahead of this one 400s a PRESENT `''` rather than ignoring it,
  // and the divergence is deliberate: a route can reject a body the caller
  // plainly got wrong, while a library entry point should degrade to its default
  // instead of failing a caller who passed a falsy variable through. Do not
  // "unify" them without deciding which of the two you are.
  const alvoLinkDocId = deps.linkDocId != null && deps.linkDocId !== '' ? deps.linkDocId : null;
  const linkDoc =
    alvoLinkDocId != null ? contaLinks.find((d) => d.docId === alvoLinkDocId) : contaLinks[0];
  if (alvoLinkDocId != null && linkDoc == null) {
    throw new MercadoLivrePublishError([
      'anúncio não encontrado nesta conta — recarregue a página e tente de novo',
    ]);
  }
  const link: PublishLink | null = linkDoc
    ? {
        docId: linkDoc.docId,
        id: linkDoc.data.id ?? null,
        title: linkDoc.data.title ?? null,
        condition: linkDoc.data.condition ?? null,
        listing_type_id: linkDoc.data.listing_type_id ?? null,
        category_id: linkDoc.data.category_id ?? null,
        isUserProductModel: linkDoc.data.isUserProductModel ?? false,
        attributes: linkDoc.data.attributes ?? null,
        video_id: linkDoc.data.video_id ?? null,
        estado: linkDoc.data.estado ?? null,
      }
    : null;
  const linkDocId = linkDoc?.docId ?? produtoMercadoLivreLinkCollection.newDocId(db, { produtoId });

  // ---- Category -----------------------------------------------------------
  // The link doc is the ONLY source. Publish used to fall back to
  // `suggestCategories(produto.nome, 1)[0]` with no human in the loop — and a
  // wrong first hit is only discoverable once the listing exists, in the wrong
  // category, on a live marketplace. #799: the suggestion is OFFERED by the
  // listing editor (GET /categorias/sugestoes) and applied by a person. A
  // missing category_id is the 422 `assemblePublishInput` already raises.
  const categoryId = link?.category_id ?? null;

  const pubProduto = toPublishProduto(produtoId, produto);
  const condicao = typeof extra?.condicao === 'number' ? extra.condicao : null;
  // Same singleton, same read — `buildParentAttributes` turns this into the
  // listing's `BRAND`, falling back to whatever the link doc already stores.
  const marca = typeof extra?.marca === 'string' ? extra.marca : null;

  /**
   * Write the fields publish OWNS onto the link doc, and nothing else.
   *
   * This used to be `set(parse({ ...linkDoc.data, ...patch }))` — a
   * read-modify-write re-applying a snapshot captured many awaits earlier
   * (the doc is read at the top of this function; the ML round trip, the chart
   * binding and every picture upload happen in between). Root `CLAUDE.md` rule
   * 7 names that shape exactly, and these documents have several live concurrent
   * writers — the items webhook, the price sync, the stock sender and the
   * operator in the editor. An operator's `descricao` edit landing
   * during a publish was silently reverted to whatever we read at the start.
   *
   * Patching only publish-owned fields makes the race impossible rather than
   * unlikely (tier 0): everything we don't write — descricao, channels,
   * crossdocking, tarifaFrete, comissao and the unknown legacy keys the
   * `.passthrough()` schema carries — is now simply never touched, so it
   * cannot be clobbered.
   *
   * `mergeIfExists` rather than `merge`: between our read and this write the
   * doc may have been deleted, and `merge` is an UPSERT that would resurrect a
   * GHOST carrying only the patch keys (`parseMerge` fills no defaults, so
   * `contaOuterRef` and `title` would be missing and every later soft-read
   * would warn). On `false` — or on a genuine first publish — we fall through
   * to a full, schema-valid `set`.
   */
  const writeLinkDoc = async (patch: Record<string, unknown>): Promise<void> => {
    if (linkDoc) {
      const merged = await produtoMercadoLivreLinkCollection.mergeIfExists(
        db,
        { produtoId },
        linkDocId,
        patch,
      );
      if (merged) return;
    }
    await produtoMercadoLivreLinkCollection.set(db, { produtoId }, linkDocId, {
      contaOuterRef: linkDoc?.data.contaOuterRef ?? toOuterRef(`integracao/${integracaoId}`),
      // Never overwrite an operator-authored title (#799 bug 4a) — only seed
      // one here, where the schema requires a non-empty value.
      title: trimToNull(linkDoc?.data.title) ?? produto.nome,
      dataCadastro: linkDoc?.data.dataCadastro ?? Date.now(),
      ...patch,
    });
  };

  // Every ML API failure from here on stamps `estado: 'E'` + `errors` on the
  // link doc (the module's header contract; legacy's `on MLError` catch
  // covered the category-detail call of the chart binding too).
  //
  // It takes the ERROR, not a message: ML explains a rejected write in the
  // body's `cause[]`, and `api.ts` collapses that to `ML 400: Validation error`
  // on `err.message`. Persisting the message alone left the operator a screen
  // saying only that something was invalid, with no way to learn what — so
  // `causas` carries the parsed causes (already resolved to form controls) and
  // `errors` carries one readable line each, for the listing editor's error
  // strip and for anyone reading the raw doc.
  //
  // `attributesSent` is what makes a POSITIONAL `item.attributes[3]` resolvable
  // — it counts the array we sent, including the derived attributes the editor
  // never shows. Null at the sites that have no payload yet; the message scan
  // still covers ML's bracketed-id messages there.
  const stampErrorLinkDoc = async (
    err: unknown,
    fallbackMessage: string,
    escopo: EscopoFalha,
    attributesSent: readonly MlAttribute[] | null = null,
  ): Promise<void> => {
    const { errors, causas } = falhaPatch(err, fallbackMessage, escopo, attributesSent);
    await writeLinkDoc({
      sku: produto.sku ?? null,
      condition: resolveCondition(link, pubProduto, condicao),
      category_id: linkDoc?.data.category_id ?? categoryId,
      listing_type_id: linkDoc?.data.listing_type_id ?? deps.listingTypeId ?? null,
      estado: 'E',
      isUserProductModel: link?.isUserProductModel ?? false,
      errors,
      causas,
      ultimaModificacao: Date.now(),
    });
  };

  // ---- Publishing model + pre-flight blocks (#798) ------------------------
  // Both happen HERE, before the stock reads, the grupo reads and above all
  // before a single picture is uploaded to ML — a refusal must not cost a
  // round trip per photo. `assemblePublishInput`'s issues run much later.
  //
  // The account probe is skipped entirely on a re-publish: there the persisted
  // `isUserProductModel` is authoritative, so `GET /users/me` would be a wasted
  // call whose only possible effect is to break a publish that would work.
  //
  // ⚠️ It is an ML call, so it is bound by the module's header contract exactly
  // like the chart binding's `getCategory` below: a dead credential or a
  // transient 5xx must leave its reason ON THE DOC, not only in the HTTP
  // response. Without this the ML tab would show a listing still sitting at
  // `estado: 'r'` with no `errors`, i.e. no trace of why the last attempt
  // failed. (This is what the stamping closures above are hoisted for.)
  let sellerIsUserProduct = false;
  if (link?.id == null) {
    try {
      const user = await (deps.getMe ?? defaultGetMe)(api);
      sellerIsUserProduct = (user.tags ?? []).includes('user_product_seller');
    } catch (err) {
      // `GET /users/me` — not an item call, so its body stays off the doc.
      if (err instanceof MercadoLivreError) await stampErrorLinkDoc(err, err.message, 'nao-item');
      throw err;
    }
  }
  const listingModel = resolveListingModel(link, sellerIsUserProduct);
  const modeIssues = publishModeIssues({
    estado: link?.estado ?? null,
    model: listingModel,
    linkId: link?.id ?? null,
    childrenCount: children.length,
  });
  if (modeIssues.length > 0) throw new MercadoLivrePublishError(modeIssues);

  // ---- The User-Products SOLE MEMBER (#1087) -------------------------------
  // ML auto-generates a family for EVERY user product, so a childless UP produto
  // is a family of one that has no member yet. The importer already writes that
  // shape (parent + one child, stock on the child); publish used to write a root
  // produto instead, which is why a produto did not survive delete -> re-import.
  //
  // ⚠️ Strictly AFTER `publishModeIssues`, which must see the ORIGINAL
  // `children.length`. Materialise first and its `childrenCount === 0` arm stops
  // firing — and that arm is the one childless state publish must REFUSE rather
  // than repair (a family id on the link means live ML members we would orphan).
  const acaoMembroUnico = classificarMembroUnico({
    model: listingModel,
    linkId: link?.id ?? null,
    childrenCount: children.length,
  });
  // Enumerated rather than `!== 'nenhum'`: both refusals already threw through
  // `publishModeIssues` above, and naming the ONE repairable case explicitly is
  // what keeps that true if the guard above is ever moved or relaxed.
  //
  // ⚠️ #1398 narrowed this to `adotar`. Publish no longer invents a member for a
  // produto that was never published — that repair sat above every later throw
  // site, so a FAILED publish still reshaped the produto and moved its stock.
  // `adotar` stays because there is a live listing behind it whose item id must
  // reach the member link, or the fan-out POSTs a duplicate and the sweep closes
  // the original.
  if (acaoMembroUnico === 'adotar') {
    children.push(
      await garantirMembroUnico(
        { db, integracaoId },
        {
          acao: acaoMembroUnico,
          produtoId,
          produto,
          parentLinkDocId: linkDocId,
          link: {
            id: link?.id ?? null,
            status: linkDoc?.data.status ?? null,
            sub_status: linkDoc?.data.sub_status ?? null,
            userProductId: linkDoc?.data.userProductId ?? null,
            moderacoes: linkDoc?.data.moderacoes ?? null,
          },
          now: Date.now(),
        },
      ),
    );
  }

  /** A User-Products family: N ML items sharing a `family_name`, not one item. */
  // Reads `children` AFTER the sole member above, so a UP produto is always a
  // family here — which is the whole point of #1087.
  const isUserProductFamily = listingModel === 'user-products' && children.length > 0;

  // ---- Stock (integração's depósito when set; else every depósito) -------
  // Kit-aware (#797 E5): a kit publishes what its components can assemble, not
  // its own — usually zero — stock.
  //
  // ⚠️ No `permiteVendaSemEstoque` floor: the legacy lifted a backorder produto
  // at zero to 1 (models.dart:1487-1497), but that field is being retired — see
  // the note on `produtoSchema`.
  const depositoId = deps.depositoOuterRef ? idFromRef(deps.depositoOuterRef) : null;
  const componentDisponivel = await loadComponentDisponivel(
    db,
    [produto, ...children.map((c) => c.data)],
    depositoId,
  );
  const availableQuantity = quantidadeParaPublicar(
    produto,
    await loadDisponivel(db, produtoId, depositoId),
    componentDisponivel,
  );
  const variations: PublishVariationChild[] = [];
  /** Each child's existing ML state, for the User-Products fan-out. */
  const upMembers: UserProductMember[] = [];
  for (const child of children) {
    const childAvailable = quantidadeParaPublicar(
      child.data,
      await loadDisponivel(db, child.id, depositoId),
      componentDisponivel,
    );
    // No parent link for THIS integração yet ⇒ the child cannot have a
    // legitimate existing variation on this listing (any variacao docs it
    // holds belong to other accounts).
    const existingVar = linkDoc ? await findVariacaoLink(db, child.id, linkDoc.docId) : null;
    upMembers.push({
      produtoId: child.id,
      varLinkDocId: existingVar?.docId ?? null,
      // ⚠️ The member's OWN item id decides create vs update — the parent link's
      // `id` is the family id for a UP family and would PUT into a 4xx.
      itemId: typeof existingVar?.raw.itemId === 'string' ? existingVar.raw.itemId : null,
      raw: existingVar?.raw ?? {},
      sku: typeof existingVar?.raw.sku === 'string' ? existingVar.raw.sku : null,
      // #1400 — does THIS member's ML item already carry the parent-sku
      // characteristic? The família-wide answer is the OR of these, and asking
      // the members is what survives a fan-out that died half-way.
      skuPaiAtributo: existingVar?.raw.skuPaiAtributo === true,
    });
    variations.push({
      produto: toPublishProduto(child.id, child.data),
      variacoesUid: child.data.variacoesUid ?? [],
      availableQuantity: childAvailable,
      mlVariationId: existingVar?.mlId ?? null,
      storedCombinations: storedCombinationsOf(existingVar?.raw),
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
      variacoes: (g.variacoes ?? []).map((v) => ({
        id: v.id,
        nome: v.nome,
        mlValueId: resolveMlValueId(v, integracaoId),
      })),
    });
  }

  // ---- Size chart (tabela de medidas) binding -----------------------------
  let tabela: TabelaBinding;
  try {
    tabela = await loadTabelaBinding(deps, produto, link, categoryId, variations);
  } catch (err) {
    // The binding's category-detail call is an ML API call — a failure (stale
    // category_id → 404, transient 5xx) must land on the doc like any other.
    // `/categories/{id}`, not an item call — headline only.
    if (err instanceof MercadoLivreError) await stampErrorLinkDoc(err, err.message, 'nao-item');
    throw err;
  }

  // ---- Pictures (upload once per integração; cached on the Arquivo) ------
  // The tabela's chart photo rides as one EXTRA listing picture appended
  // after the produto fotos (legacy `getTabelaDeMedidasPicture`).
  const pictureMemo: PictureMemo = new Map();
  const { pictures, pictureSources } = await resolvePictures(
    deps,
    produto.fotos ?? [],
    tabela.foto,
    pictureMemo,
  );

  // ---- Per-variation pictures (#797 E7) ----------------------------------
  // `pictureIds` was declared and forwarded but never POPULATED, so every
  // variation fell through to the parent set — and a republish of a
  // Flutter-published listing overwrote the correct per-variation `picture_ids`
  // ML already held. `fotosForVariacao` is the legacy three-rung resolution
  // (own fotos → parent photos tagged for this variante → all parent photos);
  // the last rung is why an untagged catalogue still publishes something, which
  // ML requires ("todas as variações devem ter uma imagem associada").
  //
  // ⚠️ The resolved ids are deliberately NOT unioned into the item-level
  // `pictures`. ML's "Modificar imagens" section says to send a picture in both
  // lists, but that instruction is about introducing a NEW image — these are
  // already uploaded ML resources referenced by id, the legacy shipped exactly
  // this shape for years, and unioning would push a 6-colour produto past the
  // ~12-picture gallery cap and turn working listings into rejections.
  for (let i = 0; i < variations.length; i++) {
    const child = children[i]!;
    const fotos = fotosForVariacao(child.data.fotos, produto.fotos, child.data.variacoesUid);
    const resolved = await resolvePictures(deps, fotos, null, pictureMemo);
    if (resolved.pictures.length === 0) continue; // mapper inherits the parent set
    const ids = resolved.pictures.map((p) => p.id);
    // ⚠️ #1087: under User Products the MEMBER is the listing — the parent set
    // is not one — so the chart photo has to ride here too. It rode only the
    // parent set, and `member.pictureIds ?? parentPictureIds` means any produto
    // whose photos are TAGGED PER VARIANTE gives every member a non-empty own
    // set and loses the chart image entirely. Measured: a member published with
    // 3 pictures and no chart, the photo uploaded and cached either way.
    //
    // ⚠️ Added HERE rather than by handing `tabela.foto` to the member's own
    // `resolvePictures` call, and the reason is the CAP: that parameter carries
    // the PARENT rule, which appends the chart photo past `MAX_PICTURES` (an
    // 11th). A member needs the legacy VARIATION rule instead. Mutation-proven
    // — routing it through that parameter publishes an 11-picture member.
    //
    // The `continue` above is left untouched: a member that resolved nothing
    // inherits `parentPictureIds`, which already carries the chart photo. (Both
    // placements happen to agree there today — a member resolves zero pictures
    // only when the produto has no resolvable fotos at all, and then the parent
    // set IS the chart photo alone — so that is a property of the current
    // `fotosForVariacao`, not a guarantee to lean on.)
    if (listingModel === 'user-products' && tabela.foto) {
      const chart = await resolveOnePicture(deps, tabela.foto, pictureMemo);
      if (chart && !ids.includes(chart.id)) {
        // ⚠️ At the cap the LAST slot is REPLACED, never appended — the legacy
        // VARIATION rule. Dropping the chart photo or overflowing are both worse
        // than losing the tenth product photo.
        //
        // ⚠️ That bounds THIS list at MAX_PICTURES; it is not a claim about
        // every member. A member that resolved nothing took the `continue`
        // above and inherits `parentPictureIds`, which is built by the PARENT
        // rule and legitimately reaches 11 (ML accepts 12) — so an inheriting
        // member publishes 11 pictures. Harmless, but the invariant stops here.
        if (ids.length >= MAX_PICTURES) ids[MAX_PICTURES - 1] = chart.id;
        else ids.push(chart.id);
        resolved.pictureSources.set(chart.id, chart.arquivoId);
      }
    }
    variations[i]!.pictureIds = ids;
    // Feed the dead-picture self-heal: a purged child picture id must be
    // strippable from its Arquivo cache too, or every retry fails identically.
    for (const [mlId, arquivoId] of resolved.pictureSources) pictureSources.set(mlId, arquivoId);
  }

  // ---- Assemble + call ML -------------------------------------------------
  // The price-list NAME is read only to enrich resolvePrice's blocked-publish
  // message with a human-readable label alongside the raw id — the price
  // VALUE that gates the publish still comes from produto.precos, uncached,
  // below. Cached (listaDePrecosCache.ts): tabelaNormalOuterRef is a property
  // of the INTEGRAÇÃO, so this id is identical for every produto published
  // under this conta.
  // #1400 — the família parent's sku as a custom characteristic. Decided ONCE,
  // here, because it is a fact about ML's família (see `resolveSkuPaiAtributo`)
  // and every member of this publish must agree on it.
  const skuPaiDecisao = resolveSkuPaiAtributo({
    isUserProductSeller: listingModel === 'user-products',
    linkId: link?.id ?? null,
    membros: upMembers,
    produtoSku: produto.sku ?? null,
  });

  const priceListId = deps.tabelaNormalOuterRef ? idFromRef(deps.tabelaNormalOuterRef) : null;
  const priceListNome = priceListId
    ? ((await readListaDePrecos(db, priceListId))?.nome ?? null)
    : null;

  const input = assemblePublishInput({
    produto: pubProduto,
    condicao,
    marca,
    priceListId,
    priceListNome,
    availableQuantity,
    pictures,
    variations,
    grupos,
    link,
    linkDocId,
    categoryId,
    listingTypeId: link?.listing_type_id ?? deps.listingTypeId ?? null,
    isUserProductSeller: listingModel === 'user-products',
    skuPai: skuPaiDecisao.skuPai,
    sizeChart: tabela.resolved,
    sizeChartMotivo: tabela.motivo,
    categoriaUsaGuia: tabela.categoriaUsaGuia,
    shippingMode: deps.shippingMode ?? null,
  });

  const now = Date.now();
  let item: MlItem;
  /** Non-null exactly when this publish went out as a User-Products family. */
  let family: PublishUserProductResult | null = null;
  /**
   * The attribute array as ML received it — hoisted out of the try purely so the
   * catch can resolve a positional `item.attributes[N]` reference against it.
   * `buildItemPayload` prunes the combination ids from `input.attributes`, so
   * the two arrays are NOT interchangeable and the indices differ.
   */
  let attributesSent: readonly MlAttribute[] | null = null;
  try {
    if (isUserProductFamily) {
      family = await publishUserProductMembers(
        { db, api, integracaoId, produtoId, parentLinkDocId: linkDocId },
        input,
        upMembers,
      );
      // The first member stands for the family on the parent link — the same
      // "primary member" convention the importer uses. There is no family-level
      // status in ML to read instead, and legacy simply hardcoded `publicado`.
      item = family.items[0]!;
    } else {
      const payload = buildItemPayload(input);
      attributesSent = (payload.attributes as MlAttribute[] | undefined) ?? null;
      item = input.isUpdate
        ? await api.updateItem(link!.id!, payload)
        : await api.createItem(payload);
    }
  } catch (err) {
    if (err instanceof MercadoLivreError) {
      // Old-app parity: a purged ML picture id in the cache would otherwise
      // fail every retry identically — strip it so the next publish re-uploads.
      await pruneDeadPictures(db, err, pictureSources);
      // ⚠️ `attributesSent` stays NULL on the User-Products path, and must.
      // `buildUserProductItemPayload` sends
      // `attributesWithValue(input.attributes).filter(not a member override)`
      // plus the member's own attributes, so every valueless or overridden entry
      // SHIFTS the indices: resolving `item.attributes[0]` against
      // `input.attributes` pins the error to a healthy row and leaves the guilty
      // one clean. Null means only the bracketed-id message scan resolves, which
      // is positional-independent — and an unmapped cause renders above the form,
      // which the `campos` docblock names as the safe outcome.
      await stampErrorLinkDoc(err, err.message, 'item', attributesSent);
    }
    throw err;
  }

  /** What the parent link's `id` carries: a FAMILY id under UP, else the item. */
  const parentExternalId = family ? (family.familyId ?? family.itemIds[0]!) : item.id;

  // ---- Persist the link docs from the response ---------------------------
  const estado = estadoFromMlStatus(item.status, item.sub_status ?? null);
  await writeLinkDoc({
    sku: produto.sku ?? null,
    condition: input.condition,
    category_id: item.category_id ?? categoryId,
    listing_type_id: item.listing_type_id ?? input.listingTypeId ?? null,
    estado,
    // #799 bug 6: publish never wrote these, so a freshly published listing
    // looked like a #780 legacy-authored doc to the stock planner
    // (bulkEstoquePlan.ts:1206) and bypassed the podeEnviarEstoque whitelist for
    // a cycle. They are the same two fields applyItemStatusToLink maintains.
    status: item.status ?? null,
    sub_status: item.sub_status ?? null,
    // ⚠️ A FAMILY id under User Products, an item id otherwise — the convention
    // the importer already writes (`import.ts:193`) and the reason nothing may
    // `PUT /items/{link.id}` for a UP family. Members carry their own item ids
    // on `variacaoMercadoLivre.itemId`.
    id: parentExternalId,
    // #706 multiorigem: the UP that backs THIS stock unit.
    //
    // ⚠️ The gate is `children.length`, NOT `family`. `family` is non-null only
    // on the User-Products branch, so gating on it would leave the LEGACY
    // `variations[]` half unguarded — and that half publishes one item whose
    // response carries a `user_product_id` (ML issues one for every item, 1:1
    // with the item id before a seller is a `user_product_seller`). Stamping it
    // would put an ITEM-level id on a listing whose stock units are its
    // variations, and the send path would then write ONE quantity for the whole
    // family. Reachable in exactly the #706 scenario: a conta that becomes
    // `warehouse_management` keeps republishing its pre-existing legacy
    // listings through this branch.
    //
    // `children.length > 0` is the question that actually matters — "does the
    // ERP keep this family's stock on child produtos" — and it is the same
    // question `importCore` asks through `args.hasVariations` and the sweep asks
    // through `row.children.length`. A UP SINGLE item (no ERP variations)
    // therefore does get stamped, correctly: there it is the stock unit.
    userProductId: children.length > 0 ? null : (item.user_product_id ?? null),
    // Members are priced independently under UP (`propagatePriceToChildren`),
    // so a single family-level `precoPublicado` would be whichever member was
    // sent first — `precoSync` skips the same stamp on `variationItem` drafts
    // for exactly this reason.
    precoPublicado: family ? null : (item.price ?? null),
    freteGratis: item.shipping?.free_shipping ?? false,
    isUserProductModel: input.isUserProductSeller,
    // #799 bug 7: the attributes we just sent, minus the ids publish does not
    // own. Without this a produto the legacy app never published keeps
    // `attributes: null` forever and the editor has nothing to load.
    //
    // ⚠️ The derived ids and the herdado ones are excluded for OPPOSITE reasons
    // and the stored `BRAND` is carried back verbatim — see
    // `linkAttributesAfterPublish`, which is where that whole argument lives.
    attributes: linkAttributesAfterPublish(input.attributes, linkDoc?.data.attributes),
    errors: [],
    // Cleared WITH `errors`: a surviving falha paints a red field on a listing
    // that just published successfully, which reads exactly like a rejection.
    causas: [],
    // ⚠️ #1252, and it is NOT the same clear as the two above. `errors`/`causas`
    // record OUR failed write, so this success invalidates them outright. A
    // moderação is ML's verdict and nothing we do lifts it — so the ONLY thing
    // authorising a clear here is ML's own answer, read off the response we
    // already hold: `precisaConsultarModeracao` is pure, so a listing ML now
    // calls healthy is written `[]` with no `/moderations` call at all.
    //
    // The other arm OMITS the key rather than writing `null`. `writeLinkDoc`'s
    // merge is `update()`-backed, so an absent key leaves the stored reason
    // standing — which is right: this path never asked ML why, and inventing
    // `[]` would record "not moderated" we never confirmed. A republish of a
    // still-moderated listing therefore keeps the reason the operator can see.
    //
    // ⚠️ On a UP family `item` is `family.items[0]` — the same "primary member"
    // whose status this patch already publishes as the family's (see above).
    // The clear follows that member deliberately: one listing, one status, one
    // reason. Folding across siblings here would read every member on the
    // publish path and disagree with the `status` sitting beside it.
    ...(precisaConsultarModeracao(item.status, item.sub_status) ? {} : { moderacoes: [] }),
    ultimaModificacao: now,
  });

  // ---- Legacy denorm stamps (DEAD WEIGHT — see the schema note) ---------
  // ⛔ `marketplace` / `marketplaceIds` have NO QUERY CONSUMERS in this repo —
  // nothing filters, projects or orders by them, and the only reads are these
  // fields' own read-modify-write maintenance (`stampChildMarketplace` below is
  // one). They are deleted at the decommission (#961 audited it; the canonical
  // note is on `produtoSchema` in `packages/schemas`). Do not repair them, do
  // not add a reader, do not give them a trigger — an entry is never removed
  // when a link doc is deleted, and that is deliberate.
  //
  // The deployed Flutter backend resolves an incoming ML order item via
  // `marketplace array-contains {integracaoUid, externalId}` (EXACT map match
  // — hence no `relevantData`, the shape its own webhook repair writes), so
  // these two stamps keep running until it is gone.
  //
  // ⚠️ `integracoesComProduto` is NOT stamped here any more (#920). It is not
  // legacy-only — the new app's own sweeps anchor on it
  // (`bulkEstoquePlan.fetchStockFamilies` S1, `precoPlan.fetchPrecoPage`), served
  // by a declared `produtos` composite — and a comment here once claimed the
  // opposite, which would have made #431 a SILENT stock + price outage: the
  // sweeps select zero produtos and log `SEM_LINK` skips rather than erroring.
  // Its sole writers are now `onProdutoMercadoLivreLinkChanged` and
  // `onVariacaoMercadoLivreLinkChanged`, which derive it from the link
  // subcollections — see the sibling `integracoesComProduto.ts`.
  //
  // That leaves TWO locks on the arrays below, not the three #431 opened with:
  //  1. ARCHITECTURE — the stock sweep needs an index-SEEKABLE per-conta term
  //     on `produtos`. MEASURED and settled (spike #890, staging 2026-08-07):
  //     the link post-filter reads ×7.5 the data, so `integracoesComProduto`
  //     stays as the pre-filter permanently. It is no longer a "deprecated
  //     array" at all — it is an app-owned denorm with a server owner.
  //  2. ~~COUPLING~~ — BROKEN by #920. The array used to be removable only by
  //     deriving it from `marketplace`, which is why the three were an
  //     all-or-nothing cluster; the triggers derive it from the links instead.
  //  3. ~~DUAL-RUN~~ — VOID. This assumed the Flutter backend read these stamps
  //     while running alongside us; there is no dual run (root `CLAUDE.md`
  //     rule 8), so nothing outside this repo consumes them and #992 waits on
  //     no decommission. `marketplace` + `marketplaceIds` go with them.
  //
  // The stamps run once the ML item write has SUCCEEDED (the error path above
  // never stamps) — a later failure (e.g. the description step) leaves them in
  // place, same as the old app, which committed this batch before sending the
  // description. Tracked removal: #992.
  await produtoCollection.docRef(db, {}, produtoId).update({
    marketplace: FieldValue.arrayUnion({
      integracaoUid: integracaoId,
      externalId: parentExternalId,
    }),
    marketplaceIds: FieldValue.arrayUnion(parentExternalId),
  });

  // Under User Products the child links are written INSIDE the fan-out, one at
  // a time as ML confirms each member (see `publishUserProduct.ts`). All that
  // is left here is the same dead-weight denorm the legacy variations branch
  // stamps below — with the family id where a legacy child carries the parent
  // ITEM id, and the member's own item id where it carries a variation id
  // (`exportarProdutos.dart:267-286`, the identical shape).
  if (family?.familyId != null) {
    for (const member of family.written) {
      await stampChildMarketplace(
        db,
        integracaoId,
        family.familyId,
        member.produtoId,
        member.itemId,
      );
    }
  }

  // Variation links live under each CHILD produto, keyed back to the parent
  // link doc — matched by seller_custom_field (= the child produto id).
  for (const respVar of family ? [] : (item.variations ?? [])) {
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
        // #920: the conta, denormalized onto the child link the same way the
        // parent link has always carried it. Unconditional (not
        // preserved-or-null like the two refs above) so a re-publish self-heals
        // a row that predates the field — `onVariacaoMercadoLivreLinkChanged`
        // otherwise has to dereference the parent link, which yields nothing
        // once that link is gone.
        contaOuterRef: toOuterRef(`integracao/${integracaoId}`),
        sku: child.produto.sku ?? null,
      }),
    );
    if (respVar.id != null) {
      await stampChildMarketplace(db, integracaoId, item.id, childId, String(respVar.id));
    }
  }

  // ---- Description (link's own text wins; else the produto's extraData) ---
  // The tabela de medidas text is APPENDED after the base description (legacy
  // `getDescription(tabelaDeMedidas?.descricao)` — '\n\n' separator). Legacy
  // trims each part and treats blank as ABSENT: a link doc holding `''` must
  // fall through to extraData (and never swallow the tabela text).
  const baseDescricao = trimToNull(linkDoc?.data.descricao) ?? trimToNull(extra?.descricao);
  const tabelaDescricao = trimToNull(tabela.descricao);
  const descricao =
    baseDescricao && tabelaDescricao
      ? `${baseDescricao}\n\n${tabelaDescricao}`
      : (baseDescricao ?? tabelaDescricao);
  if (descricao) {
    // Under User Products the description is per ITEM, and ML does not replicate
    // it across a user product the way it replicates title/attributes/pictures
    // — so every member gets its own call, POST for the ones this run created
    // and PUT-replace for the rest (`exportarProdutos.dart:413-424`).
    const targets: Array<{ itemId: string; created: boolean }> = family
      ? family.written.map((m) => ({ itemId: m.itemId, created: m.created }))
      : [{ itemId: item.id, created: !input.isUpdate }];
    try {
      for (const target of targets) {
        try {
          await api.setItemDescription(target.itemId, descricao, { replace: !target.created });
        } catch (err) {
          // A fresh item can already carry a description (ML auto-creates one for
          // some categories) — POST then 400s; the PUT replace variant fixes it.
          if (err instanceof MercadoLivreHttpError && err.status === 400 && target.created) {
            await api.setItemDescription(target.itemId, descricao, { replace: true });
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      // The item itself published, but the header contract still holds: any ML
      // failure must leave its reason on the doc (the old app stamped these
      // from the same catch), not just a transient HTTP error to the UI.
      if (err instanceof MercadoLivreError) {
        // Through `writeLinkDoc`, not a bare `merge`: the item IS published by
        // now, so if the link doc was deleted meanwhile an upsert would leave a
        // key-only ghost holding an error and no `id` — a live listing nothing
        // can find. The fallback path recreates a schema-complete doc, so the
        // item id has to ride the patch.
        // `/items/{id}/description` — an item endpoint.
        const { errors, causas } = falhaPatch(err, err.message, 'item', attributesSent);
        await writeLinkDoc({
          id: parentExternalId,
          estado: 'E',
          errors,
          causas,
          ultimaModificacao: Date.now(),
        });
      }
      throw err;
    }
  }

  // ---- Removed-variation sweep (User Products only) -----------------------
  // Runs LAST, and only once every member published: a partial pass would see
  // the members it never reached as "removed" and close live siblings. Fully
  // best-effort — the listing is already correct by this point.
  let orfaosEncerrados: string[] = [];
  if (family) {
    const sweep = await sweepRemovedMembers(
      { api },
      {
        familyId: family.familyId,
        sellerUserId: deps.sellerUserId ?? null,
        keptItemIds: family.itemIds,
      },
    );
    orfaosEncerrados = sweep.closed;
    if (sweep.skipped != null) {
      console.warn('[mercado-livre] publish: varredura de variações removidas não executada', {
        produtoId,
        integracaoId,
        motivo: sweep.skipped,
      });
    }
  }

  return {
    itemId: parentExternalId,
    estado,
    permalink: item.permalink ?? null,
    itemIds: family ? family.itemIds : [item.id],
    orfaosEncerrados,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * The default User-Products capability probe — one `GET /users/me` per FIRST
 * publish (`estoqueSweep`'s `defaultGetMe`, same seam, different tag).
 */
async function defaultGetMe(api: MercadoLivreApi): Promise<MlUser> {
  return api.getMe();
}

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
    propagatePriceToChildren?: boolean | null;
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
    propagatePriceToChildren: p.propagatePriceToChildren ?? null,
  };
}

/** Trimmed string, or null when absent/blank (legacy `trim().isNotEmpty`). */
function trimToNull(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? t : null;
}

/** What the produto's tabela de medidas contributes to this publish. */
export interface TabelaBinding {
  /** Chart + per-child row ids for SIZE_GRID_* injection (null = no chart). */
  resolved: ResolvedSizeChart | null;
  /** Tabela text appended to the listing description. */
  descricao: string | null;
  /** The chart photo, appended as an extra listing picture. */
  foto: Foto | null;
  /** Why {@link resolved} is what it is — the diagnostic publish refuses on. */
  motivo: TabelaBindingMotivo;
  /**
   * Does the category carry a `grid_id` attribute? `null` = never asked, on the
   * exits that make no ML call at all — a third value, distinct from `false`.
   */
  categoriaUsaGuia: boolean | null;
}

/**
 * Load the produto's tabela de medidas and resolve its ML chart binding for
 * this integração (legacy `_findTabelaDeMedidas` + `getTabelaDeMedidasMercadoLivre`):
 * the tabMedi doc's `tabelasDeMedidasMercadoLivre[<integracaoId>].tabelas` are
 * matched against the category's `settings.catalog_domain` and the link doc's
 * attributes; each variation child is bound to a chart row via `varianteUid`.
 * The tabela `descricao` and photo apply even when no chart resolves (legacy
 * appended both regardless of the chart match).
 */
export async function loadTabelaBinding(
  deps: PublishDeps,
  produto: { tabelaDeMedidasModaUid?: string | null },
  link: PublishLink | null,
  categoryId: string | null,
  variations: readonly PublishVariationChild[],
): Promise<TabelaBinding> {
  const { db, api, integracaoId } = deps;

  const ref = produto.tabelaDeMedidasModaUid;
  if (!ref) {
    return {
      resolved: null,
      descricao: null,
      foto: null,
      motivo: { codigo: 'produto-sem-tabela' },
      categoriaUsaGuia: null,
    };
  }
  const tabMediId = idFromRef(ref);
  const snap = await tabelaDeMedidasCollection.docRef(db, {}, tabMediId).get();
  if (!snap.exists) {
    return {
      resolved: null,
      descricao: null,
      foto: null,
      motivo: { codigo: 'tabela-inexistente', tabMediId },
      categoriaUsaGuia: await categoriaUsaGuia(api, categoryId),
    };
  }
  const tabela = tabelaDeMedidasCollection.parseRead(
    snap.data(),
    tabelaDeMedidasCollection.docPath({}, tabMediId),
  );
  const descricao = tabela.descricao ?? null;
  const foto = tabela.fotos?.[0] ?? null;
  const nome = tabela.nome;

  const charts = mlSizeChartsForConta(tabela.tabelasDeMedidasMercadoLivre ?? null, integracaoId);
  // ⚠️ The two conditions keep their original order — `charts.length === 0`
  // before `!categoryId` — so only the REPORTING changes here, never which
  // branch a given produto takes.
  if (charts.length === 0 || !categoryId) {
    return {
      resolved: null,
      descricao,
      foto,
      motivo:
        charts.length === 0
          ? { codigo: 'tabela-sem-guias-nesta-conta', tabMediId, nome }
          : { codigo: 'anuncio-sem-categoria', tabMediId },
      // ⚠️ `charts.length === 0` wins the `||` whatever `categoryId` is, so this
      // exit is reached WITH a category as often as without — and hard-coding
      // `null` here made `tabela-sem-guias-nesta-conta` unable to refuse
      // anything, leaving its message dead code that read as live. "Linked a
      // tabela, never created the guia in this conta" is plausibly the most
      // common form of this mistake.
      categoriaUsaGuia: await categoriaUsaGuia(api, categoryId),
    };
  }

  // The chart's domain_id is the FULL form ('MLB-PANTS') — matched against
  // the category's catalog domain, same source as the legacy flow. Cached: this
  // was the only uncached `getCategory` caller, and the miss paths below now ask
  // for the category's attributes too.
  const category = await getCategoriaCached(api, categoryId);
  const catalogDomain =
    typeof category.settings?.catalog_domain === 'string' ? category.settings.catalog_domain : null;
  const resolucao = resolveSizeChart(charts, catalogDomain, link?.attributes ?? null);

  if (resolucao.motivo === null) {
    const chart = resolucao.chart;
    // Total, not optimistic: `resolveSizeChart` only ever hands back a member of
    // its `candidates`, which is filtered on a non-blank `id`. See SizeChartMiss.
    const chartId = chart.id as string;
    const rowByChildId: Record<string, SizeChartRowBinding> = {};
    for (const v of variations) {
      const row = findChartRow(chart, v.variacoesUid);
      if (row) rowByChildId[v.produto.id] = row;
    }
    return {
      resolved: { chartId, rowByChildId },
      descricao,
      foto,
      motivo: { codigo: 'vinculada', chartId },
      categoriaUsaGuia: null,
    };
  }

  return {
    resolved: null,
    descricao,
    foto,
    motivo: motivoDaResolucao(resolucao, categoryId, nome),
    categoriaUsaGuia: await categoriaUsaGuia(api, categoryId),
  };
}

/**
 * Does this category carry a size-chart attribute? `null` = never asked.
 *
 * ⚠️ Called on the MISS paths only. It gates the refusal, so there is nothing to
 * ask about once a chart has bound — and `produto-sem-tabela`, by far the most
 * common outcome, must not pay an ML round trip to learn something it will not
 * use. Cached (`READ_CACHE_TTL.config`), so on a warm instance every call after
 * the first costs nothing.
 */
async function categoriaUsaGuia(
  api: MercadoLivreApi,
  categoryId: string | null,
): Promise<boolean | null> {
  if (categoryId == null) return null;
  return categoriaUsaGuiaDeTamanhos(await getCategoriaAtributosCached(api, categoryId));
}

/**
 * Lift a {@link SizeChartMiss} into the binding's own vocabulary, adding the
 * two things the resolver has no way to know: which category asked, and what
 * the tabela is called. `categoria-sem-dominio` is the one miss with no domain
 * to name — ML itself did not report one.
 */
function motivoDaResolucao(
  resolucao: SizeChartMiss,
  categoryId: string,
  nome: string,
): TabelaBindingMotivo {
  switch (resolucao.motivo) {
    case 'categoria-sem-dominio':
      return { codigo: 'categoria-sem-dominio', categoryId };
    case 'guias-nao-enviadas':
      return {
        codigo: 'guias-nao-enviadas',
        categoryId,
        dominioDaCategoria: resolucao.dominioDaCategoria,
        nome,
      };
    case 'dominio-divergente':
      return {
        codigo: 'dominio-divergente',
        categoryId,
        nome,
        dominiosDaTabela: resolucao.dominiosDaTabela,
        dominioDaCategoria: resolucao.dominioDaCategoria,
      };
    case 'sem-atributos-correspondentes':
      return {
        codigo: 'sem-atributos-correspondentes',
        categoryId,
        dominioDaCategoria: resolucao.dominioDaCategoria,
        nome,
      };
  }
}

/**
 * Legacy stamp for a VARIATION CHILD's deprecated `marketplace` arrays —
 * legacy read-clean-write semantics (`exportarProdutos.dart` variation loop):
 * drop stale same-conta entries for this listing (a recreated variation gets a
 * new ML id) and parent-shaped entries wrongly sitting on a child, then append
 * the fresh `{integracaoUid, externalParentId, externalId}` entry (no
 * `relevantData` — the legacy order-import probe matches the map EXACTLY and
 * carries none). arrayUnion can't express the cleanup, so this mirrors the old
 * `transform(newValues:)` full-field write.
 *
 * ⚠️ `integracoesComProduto` is deliberately absent from the patch (#920) —
 * `onVariacaoMercadoLivreLinkChanged` owns it now, deriving it from the child's
 * `variacaoMercadoLivre` link. Do not add it back: two writers, one of them a
 * read-clean-write, is exactly how a conta gets silently dropped while a live
 * listing still exists, and that failure is invisible (the sweeps just stop
 * selecting the produto).
 *
 * ⛔ What remains is DEAD WEIGHT: no query consumers, deleted at the
 * decommission (#992; audited in #961). The read-clean-write below is not a
 * counter-example — it reads `marketplace` only to compute the next
 * `marketplace`, which is maintenance, not consumption. The canonical note is on
 * `produtoSchema`. Do not extend this to remove entries when a link doc is
 * deleted — that gap is known and deliberate; the arrays die with the consumer.
 */
async function stampChildMarketplace(
  db: Firestore,
  integracaoId: string,
  itemId: string,
  childId: string,
  variationId: string,
): Promise<void> {
  // A genuine read-clean-write: `arrayUnion` cannot express "drop every stale
  // entry for this conta", so this is the one place publish needs a
  // compare-and-set (root CLAUDE.md rule 7, tier 1). ⚠️ The old reason — a
  // live Flutter writer on the child produto — is VOID (rule 8: there is no
  // dual run). The guard survives because this repo races ITSELF on that same
  // doc: `importVariations.ts` arrayUnions these very arrays,
  // `onVariacaoMercadoLivreLinkChanged` writes `integracoesComProduto` beside
  // them, and a retried Cloud Task or a second operator re-drives this publish.
  // The previous unconditional merge re-applied an array derived from a
  // snapshot that may already have lost. On a precondition failure we re-READ
  // and re-DERIVE — never re-apply the patch computed from the losing snapshot.
  const ref = produtoCollection.docRef(db, {}, childId);
  for (let attempt = 0; ; attempt++) {
    const snap = await ref.get();
    if (!snap.exists) return;
    const raw = (snap.data() ?? {}) as Record<string, unknown>;

    const current = Array.isArray(raw.marketplace)
      ? (raw.marketplace as Array<Record<string, unknown>>)
      : [];
    const cleaned = current.filter((e) => {
      if (e?.integracaoUid !== integracaoId) return true; // other conta — keep
      if (e.externalParentId == null) return false; // parent-shaped on a child
      // Drop EVERY entry for this conta+listing (stale id or already-correct):
      // the fresh push below is the single source of truth, so an up-to-date
      // entry can't be duplicated on re-publish.
      return e.externalParentId !== itemId;
    });
    cleaned.push({
      integracaoUid: integracaoId,
      externalParentId: itemId,
      externalId: variationId,
    });

    const ids = new Set(Array.isArray(raw.marketplaceIds) ? (raw.marketplaceIds as string[]) : []);
    ids.add(variationId);

    const patch = produtoCollection.parseMerge({
      marketplace: cleaned,
      marketplaceIds: [...ids],
    });
    try {
      await ref.update(patch, { lastUpdateTime: snap.updateTime! });
      return;
    } catch (err) {
      // Someone wrote between our read and our update. Retry a bounded number
      // of times; a persistent loser is a real problem, not something to hide.
      if (isFailedPrecondition(err) && attempt < MAX_STAMP_ATTEMPTS - 1) continue;
      if (isNotFound(err)) return; // deleted meanwhile — nothing to stamp
      throw err;
    }
  }
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

/**
 * This variante's Mercado Livre `value_id`, or null.
 *
 * `externalVariacaoLinks[].externalId` holds `value_id ?? value_name`
 * (`taxonomiaCore.ts:246`) — so it is an ID only when ML actually sent one, and
 * in exactly that case the importer also used it as the variante's own doc id
 * (`taxonomiaCore.ts:284`). That equality is the test. Anything else is a value
 * NAME wearing the same field, and shipping it as `value_id` would fabricate a
 * taxonomy reference ML never issued.
 */
function resolveMlValueId(variante: Variante, integracaoId: string): string | null {
  for (const link of variante.externalVariacaoLinks ?? []) {
    if (link.tipo !== INTEGRACAO_TIPO.mercadoLivre) continue;
    if (link.integracaoId !== integracaoId) continue;
    if (link.externalId === variante.id) return link.externalId;
  }
  return null;
}

/**
 * The `attribute_combinations` the importer stored on a variation link doc, for
 * the republish merge (#797 E8). `findVariacaoLink` hands back RAW Firestore
 * data, so this soft-reads: a malformed or valueless entry is skipped, never
 * thrown on, and an id-less one cannot occur (`comboToWireAttribute` drops
 * those on the way in — `importCore.ts:456`).
 */
function storedCombinationsOf(raw: Record<string, unknown> | undefined): MlAttribute[] {
  if (!raw || !Array.isArray(raw.attributes)) return [];
  const out: MlAttribute[] = [];
  for (const entry of raw.attributes) {
    if (typeof entry !== 'object' || entry === null) continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== 'string' || a.id === '') continue;
    const attr: MlAttribute = { id: a.id };
    if (typeof a.name === 'string') attr.name = a.name;
    if (typeof a.value_id === 'string') attr.value_id = a.value_id;
    if (typeof a.value_name === 'string') attr.value_name = a.value_name;
    if (attr.value_id == null && attr.value_name == null) continue;
    out.push(attr);
  }
  return out;
}

/**
 * The `available_quantity` to publish for one produto: the component-min for a
 * kit — virtual or not — falling back to its own stock when nothing constrains
 * it.
 *
 * ⚠️ **The one place publish and the stock sweep MUST agree**, which since
 * #1087 they do structurally rather than by comment: this is `quantidadeParaEnvio`
 * with the escape hatch pinned off, so there is one implementation and the
 * compiler keeps them equal. If they ever diverged again the first sweep after a
 * publish would silently change the advertised number. `publish.test.ts` pins
 * the equality against `quantidadeDoMembro`.
 *
 * ⚠️ `pularKitVirtual: false` is not a preference, it is the only legal value
 * here. `POST /items` REQUIRES `available_quantity` on an item without
 * variations, so a `null` would not make ML derive anything — it would make the
 * produto unpublishable. ML's own Virtual Kits, which really do derive their
 * stock, are a User-Products feature (`POST /items/kits`) this port never
 * creates, which is the same fact that made the sweep's old refusal wrong.
 *
 * Exported for that equality test only — publish is its sole caller.
 */
export function quantidadeParaPublicar(
  produto: { ehKit: boolean; ehKitVirtual: boolean; componentesKit: ComponentesKit | null },
  ownDisponivel: number,
  disponivelByProdutoId: Record<string, number>,
): number {
  return (
    quantidadeParaEnvio({
      ehKit: produto.ehKit,
      ehKitVirtual: produto.ehKitVirtual,
      componentesKit: produto.componentesKit,
      ownDisponivel,
      disponivelByProdutoId,
      pularKitVirtual: false, // see the ⚠️ above — never optional on this path
    }) ?? ownDisponivel
  );
}

/**
 * `disponivel` for every produto named as a kit component by the parent or by
 * one of its variation children, at the same depósito — the map
 * `quantidadeParaPublicar` needs to take a kit's component-min.
 */
async function loadComponentDisponivel(
  db: Firestore,
  produtos: ReadonlyArray<{
    ehKit: boolean;
    ehKitVirtual: boolean;
    componentesKit: ComponentesKit | null;
  }>,
  depositoId: string | null,
): Promise<Record<string, number>> {
  const ids = new Set<string>();
  for (const p of produtos) {
    if (!p.ehKit && !p.ehKitVirtual) continue;
    for (const [componenteId] of componentesKitEntries(p.componentesKit)) ids.add(componenteId);
  }
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = await loadDisponivel(db, id, depositoId);
  return out;
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
 * (the old app's shape), so a re-publish reuses the cached id. When the
 * produto's tabela de medidas carries a chart photo (`tabelaFoto`), it rides
 * as one EXTRA picture APPENDED after the produto fotos — the legacy parent
 * flow appended it even at 10 produto fotos (an 11th picture; ML accepts 12).
 *
 * ⚠️ `tabelaFoto` is the PARENT-set rule only. A User-Products member gets the
 * chart photo from the caller instead, under the legacy VARIATION rule —
 * replace the last slot at the cap rather than reach an 11th. Passing it here
 * for a member would also break the inherit path; see the ⚠️ at the per-member
 * loop in {@link publishProduto} (#1087).
 */
async function resolvePictures(
  deps: PublishDeps,
  fotos: ReadonlyArray<Foto>,
  tabelaFoto: Foto | null = null,
  memo: PictureMemo = new Map(),
): Promise<{ pictures: Array<{ id: string }>; pictureSources: Map<string, string> }> {
  const pictures: Array<{ id: string }> = [];
  /** ML picture id → owning arquivo doc id (feeds the dead-picture self-heal). */
  const pictureSources = new Map<string, string>();

  for (const foto of fotos.slice(0, MAX_PICTURES)) {
    const resolved = await resolveOnePicture(deps, foto, memo);
    if (!resolved) continue;
    pictures.push({ id: resolved.id });
    pictureSources.set(resolved.id, resolved.arquivoId);
  }

  if (tabelaFoto) {
    const chartPic = await resolveOnePicture(deps, tabelaFoto, memo);
    if (chartPic) {
      pictures.push({ id: chartPic.id });
      pictureSources.set(chartPic.id, chartPic.arquivoId);
    }
  }

  return { pictures, pictureSources };
}

/**
 * Resolve ONE foto to its ML picture id, at most once per publish.
 *
 * The memo is not just a saving: every variation child falls back to the
 * parent's gallery when it has no photos of its own (#797 E7), so without it a
 * 6-colour produto re-reads each Arquivo seven times. Worse, the miss path
 * appends to `externalIds` with `arrayUnion` — a later read in the SAME publish
 * would have to see that write land to reuse the id, which is exactly the
 * read-your-own-write the memo makes unnecessary.
 *
 * A thrown download/upload failure is deliberately NOT memoized; it aborts the
 * publish anyway.
 */
async function resolveOnePicture(
  deps: PublishDeps,
  foto: Foto,
  memo: PictureMemo,
): Promise<{ id: string; arquivoId: string } | null> {
  const key = foto.arquivoOuterRef.replace(/^arquivos\//, '');
  if (memo.has(key)) return memo.get(key)!;
  const resolved = await loadOnePicture(deps, foto);
  memo.set(key, resolved);
  return resolved;
}

async function loadOnePicture(
  deps: PublishDeps,
  foto: Foto,
): Promise<{ id: string; arquivoId: string } | null> {
  const { db, api, integracaoId } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;

  const arquivoId = foto.arquivoOuterRef.replace(/^arquivos\//, '');
  const snap = await arquivoCollection.docRef(db, {}, arquivoId).get();
  if (!snap.exists) return null; // a broken foto ref must not block the publish
  const arquivo = arquivoCollection.parseRead(
    snap.data(),
    arquivoCollection.docPath({}, arquivoId),
  ) as Arquivo;

  const cached = (arquivo.externalIds ?? []).find((e) =>
    refMatchesIntegracao(e.integracaoPath, integracaoId),
  );
  if (cached) return { id: cached.externalId, arquivoId };

  if (!arquivo.url) return null;
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
  return { id: uploaded.id, arquivoId };
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
