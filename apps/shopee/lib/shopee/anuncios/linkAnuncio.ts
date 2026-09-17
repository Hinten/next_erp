/**
 * **The produto → link readers, and the child-link sync** (#1519, step 11) — the
 * inverse of the direction step 9 built.
 *
 * `produtos/resolveProduto.ts` answers *`item_id` → produto*, because that is
 * what an IMPORT needs. Every lifecycle path here needs the other direction too:
 * the two push handlers arrive holding an `item_id` and need the link document;
 * the three routes arrive holding a `produtoId` and need the same thing.
 *
 * ## ⚠️ Two query shapes, and the difference is an INDEX decision
 *
 * {@link resolverLinkPorItemId} runs the DECLARED `prodshopee`
 * collectionGroup composite — `(item_id, contaProdutoShopeeOuterRef)`, built
 * from `INDICES_COMPOSTOS_SHOPEE` so the query and the expectation cannot drift
 * apart. `item_id` goes to the server as a **NUMBER**: `String(itemId)` matches
 * nothing, silently, which is exactly what the legacy importer did.
 *
 * {@link resolverLinkPorProduto} runs **no `where` at all.** It reads the whole
 * `prodshopee` subcollection under that ONE produto and filters the conta in
 * memory. Root `CLAUDE.md` rule 1 is why: Enterprise auto-creates zero indexes,
 * an unindexed `where` does not throw — it silently full-scans and Enterprise
 * bills data SCANNED. A produto holds a handful of link documents, so reading
 * all of them needs no index at all. That is
 * `integracoesComProduto.ts`'s own argument for `sobrevivemVariacoesDoProduto`,
 * verbatim. **Step 11 declares no new index.**
 *
 * {@link lerLinksDeVariacao} pays the same way: one `produtos (paiId ==)` query
 * (the composite `jaTemFilhos` already rides) plus one unfiltered `variashopee`
 * read per child. For a 50-model listing that is **1 + 1 + 50 = 52 document
 * reads** on one operator action — stated here so nobody discovers it later.
 *
 * ## ⚠️ Duplicates: lexically FIRST, one log line, NEVER a delete
 *
 * Both resolvers reuse `escolherLink` from `produtos/resolveProduto.ts` rather
 * than re-implementing the rule. A second copy with a comment claiming the two
 * agree is the exact shape the root `CLAUDE.md` names — and this rule is one a
 * copy would drift on, because a link document is the only record of a binding
 * an operator may have made by hand.
 *
 * ## ⚠️ {@link sincronizarLinksDeVariacao} is ONE function, shared
 *
 * Both the publisher's model leg and `reverificar-anuncio` refresh
 * `variashopee` from a FRESH `get_model_list` under the same rules. Two copies
 * of "reconcile by `model_id`, never by position; MARK a vanished model, never
 * delete it" is the drift shape, so there is one implementation and both
 * callers import it.
 *
 * Clock-free and Next-free: `nowMs` is a parameter, every Firestore access goes
 * through a `@delfrance/data/admin/collections` handle, and nothing here opens a
 * multi-document atomic write.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ShopeeModel } from '@delfrance/integrations-shopee';
import {
  SHOPEE_MODEL_STATUS,
  estadoAnuncioShopeeSchema,
  toOuterRef,
  type EstadoAnuncioShopee,
  type ShopeeModelStatus,
} from '@delfrance/schemas';
import {
  integracaoCollection,
  produtoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { INDICES_COMPOSTOS_SHOPEE } from '../pedidos/produtoResolve';
import { modelStatusDeLink } from '../produtos/mapeamento';
import { escolherLink, linhasDeGrupo } from '../produtos/resolveProduto';

const [INDICE_VARIACAO, INDICE_LISTAGEM] = INDICES_COMPOSTOS_SHOPEE;

/** One resolved `prodshopee` document, with the two fields every caller reads. */
export interface LinkDeAnuncio {
  /** The OWNING produto — `ref.parent.parent.id` on a group hit. */
  readonly produtoId: string;
  readonly linkDocId: string;
  /** The document body, UNVALIDATED: a migrated Flutter row parses nowhere here. */
  readonly raw: Record<string, unknown>;
  /**
   * `null` ⇒ this produto has never been published through this conta.
   * ⚠️ A non-positive stored value folds to `null` too: `0` is not a listing,
   * and folding it here gives every caller ONE "never published" check.
   */
  readonly itemId: number | null;
  /** `null` ⇒ never folded (a step-9 link), or a stored value nobody recognises. */
  readonly estadoAnuncio: EstadoAnuncioShopee | null;
}

/** One resolved `variashopee` document, under the CHILD produto that owns the stock. */
export interface LinkDeVariacao {
  /** The CHILD produto's id — where this `variashopee` document lives. */
  readonly produtoId: string;
  readonly linkDocId: string;
  readonly raw: Record<string, unknown>;
  /**
   * `null` ⇒ absent, unreadable, or the `0` sentinel. ⚠️ `0` is Shopee's "this
   * item has no variation": a link carrying it binds any line of any listing
   * (`produtoResolve.ts`'s rule), so it is never reconciled against a read.
   */
  readonly modelId: number | null;
  readonly tierIndex: readonly number[];
  readonly modelStatus: ShopeeModelStatus | null;
  /** MILLISECONDS. Set while a `get_model_list` read stopped reporting this model. */
  readonly modeloAusenteEm: number | null;
}

function contaRefDe(integracaoId: string): string {
  return toOuterRef(integracaoCollection.docPath({}, integracaoId));
}

/** A raw link row as `escolherLink` compares them. */
interface LinhaDeLinkLida {
  readonly id: string;
  readonly raw: Record<string, unknown>;
  readonly produtoId: string | null;
}

function itemIdDeLink(raw: Record<string, unknown>): number | null {
  const bruto = raw.item_id;
  return typeof bruto === 'number' && Number.isFinite(bruto) && bruto > 0 ? bruto : null;
}

/**
 * The stored `estadoAnuncio`, or `null`.
 *
 * ⚠️ TOLERANT by construction: a stored value outside the seven members reads as
 * `null` (= never folded) rather than throwing. A link document is read on the
 * push path, where a throw costs a delivery.
 */
function estadoAnuncioDeLink(raw: Record<string, unknown>): EstadoAnuncioShopee | null {
  const lido = estadoAnuncioShopeeSchema.safeParse(raw.estadoAnuncio);
  return lido.success ? lido.data : null;
}

function comoLinkDeAnuncio(linha: LinhaDeLinkLida | null): LinkDeAnuncio | null {
  if (linha === null) return null;
  // A group hit whose owning produto cannot be recovered is unusable: every
  // caller writes back through `{ produtoId }`.
  if (linha.produtoId === null || linha.produtoId === '') return null;
  return {
    produtoId: linha.produtoId,
    linkDocId: linha.id,
    raw: linha.raw,
    itemId: itemIdDeLink(linha.raw),
    estadoAnuncio: estadoAnuncioDeLink(linha.raw),
  };
}

/**
 * `item_id` → the listing link, on the DECLARED collectionGroup composite. For
 * the two push handlers.
 *
 * `limit(2)` is an AMBIGUITY DETECTOR, not a page size: a second row proves the
 * question has more than one answer, {@link escolherLink} takes the lexically
 * first one and says so, and nothing is deleted.
 */
export async function resolverLinkPorItemId(
  db: Firestore,
  integracaoId: string,
  itemId: number,
): Promise<LinkDeAnuncio | null> {
  const conta = contaRefDe(integracaoId);
  const snap = await produtoShopeeLinkCollection
    .groupQuery(db)
    // ⚠️ A NUMBER. `String(itemId)` matches nothing, silently.
    .where(INDICE_LISTAGEM.campos[0], '==', itemId)
    .where(INDICE_LISTAGEM.campos[1], '==', conta)
    .limit(2)
    .get();

  return comoLinkDeAnuncio(
    escolherLink(linhasDeGrupo(snap), { integracaoId, itemId, subcolecao: 'prodshopee' }),
  );
}

/**
 * produto → the listing link for THIS conta, with **no `where`** (see the
 * header). For the three routes and the CLI.
 *
 * `linkDocId` narrows to one document when the caller already knows it. ⚠️ A
 * `linkDocId` naming a document that belongs to ANOTHER conta resolves `null`,
 * not that document — the conta filter runs FIRST, so the id can only ever
 * narrow within what this conta owns. The route answers 404.
 */
export async function resolverLinkPorProduto(
  db: Firestore,
  integracaoId: string,
  produtoId: string,
  linkDocId?: string | null,
): Promise<LinkDeAnuncio | null> {
  const conta = contaRefDe(integracaoId);
  const snap = await produtoShopeeLinkCollection.ref(db, { produtoId }).get();
  const daConta: LinhaDeLinkLida[] = snap.docs
    .map((d) => ({ id: d.id, raw: (d.data() ?? {}) as Record<string, unknown>, produtoId }))
    .filter((l) => l.raw[INDICE_LISTAGEM.campos[1]] === conta);

  const candidatos =
    linkDocId == null || linkDocId === '' ? daConta : daConta.filter((l) => l.id === linkDocId);

  return comoLinkDeAnuncio(
    escolherLink(candidatos, {
      integracaoId,
      produtoId,
      linkDocId: linkDocId ?? null,
      subcolecao: 'prodshopee',
    }),
  );
}

function tierIndexDeLink(raw: Record<string, unknown>): readonly number[] {
  const bruto = raw.tier_index;
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
}

function modelStatusDeRaw(raw: Record<string, unknown>): ShopeeModelStatus | null {
  const bruto = raw.model_status;
  return typeof bruto === 'string' ? modelStatusDeLink(bruto) : null;
}

function inteiroOuNull(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : null;
}

/** `0`, absent and unreadable all read as "no usable model id" — see {@link LinkDeVariacao.modelId}. */
function modelIdUtilizavel(bruto: unknown): number | null {
  const n = inteiroOuNull(bruto);
  return n === null || n === 0 ? null : n;
}

/**
 * Every `variashopee` under the CHILDREN of one parent produto, for this conta.
 *
 * The children come from `produtos (paiId == produtoPaiId)` — the query
 * `jaTemFilhos` already runs, so its index cost is paid — and each child's
 * `variashopee` subcollection is read UNFILTERED with the conta compared in
 * memory, for the header's reason.
 */
export async function lerLinksDeVariacao(
  db: Firestore,
  integracaoId: string,
  produtoPaiId: string,
): Promise<readonly LinkDeVariacao[]> {
  const conta = contaRefDe(integracaoId);
  const filhos = await produtoCollection.ref(db, {}).where('paiId', '==', produtoPaiId).get();

  const saida: LinkDeVariacao[] = [];
  for (const filho of filhos.docs) {
    const snap = await variacaoShopeeLinkCollection.ref(db, { produtoId: filho.id }).get();
    for (const d of snap.docs) {
      const raw = (d.data() ?? {}) as Record<string, unknown>;
      if (raw[INDICE_VARIACAO.campos[1]] !== conta) continue;
      saida.push({
        produtoId: filho.id,
        linkDocId: d.id,
        raw,
        modelId: modelIdUtilizavel(raw.model_id),
        tierIndex: tierIndexDeLink(raw),
        modelStatus: modelStatusDeRaw(raw),
        modeloAusenteEm: inteiroOuNull(raw.modeloAusenteEm),
      });
    }
  }
  return saida;
}

/** A live model this conta holds no child link for. Reported, never created here. */
export interface ModeloSemFilho {
  readonly modelId: number;
  readonly tierIndex: readonly number[];
  readonly modelSku: string | null;
}

/**
 * What one sync did. ⚠️ Both counters count **WRITES**, not populations: a
 * second sync over an unchanged reading answers `{atualizados: 0, marcados: 0}`
 * and issues no write at all.
 */
export interface ResultadoSincronizacaoModelos {
  /** Child links whose stored reading was REFRESHED from the fresh model list. */
  readonly atualizados: number;
  /** Child links newly MARKED `MODEL_UNAVAILABLE` because their model vanished. */
  readonly marcados: number;
  /** Live models with no child link under this parent. NOT created here. */
  readonly modelosSemFilho: readonly ModeloSemFilho[];
}

/**
 * Reconcile the stored child links of ONE parent produto against a FRESH
 * `get_model_list` reading. Called by the publisher's model leg and by
 * `reverificar-anuncio` — ONE implementation, two callers.
 *
 * The three rules, each of which a test pins:
 *
 *  1. **Reconciled BY `model_id`, never by position.** A `get_model_list` that
 *     answers the same models in a different order changes nothing. Position is
 *     what `tier_index` describes, not what identifies a model.
 *  2. **A stored link whose `model_id` is ABSENT from the reading is MARKED**
 *     `model_status: 'MODEL_UNAVAILABLE'` with a `modeloAusenteEm` stamp, and
 *     the document STAYS. `variacoesFantasma.ts`'s argument verbatim: a delete
 *     throws away the member's sku and attributes that a republish would have to
 *     rebuild from nothing, and `produtos/README.md`'s rule is that a link
 *     document is never deleted. ⚠️ The stamp is written ONCE — an
 *     already-marked link is left alone, so the stamp answers *when the model
 *     vanished* rather than *when we last looked*.
 *  3. **A live model with NO child link is REPORTED, never created.** Minting a
 *     child link needs a child produto, which is the publisher's job (through
 *     `aplicarLinkDaVariacao`) or the importer's. Reporting it is what keeps a
 *     model nobody bound from being silently dropped by the next
 *     `update_tier_variation`.
 *
 * An identical reading writes NOTHING: the patch is compared field by field
 * against the stored values and an empty patch is never sent. No shared
 * deep-equality or null-stripping helper is reachable from here — the
 * comparison is a named per-field one (the `pagamentoTx` rule), and
 * {@link mesmaTierIndex} is its one fold.
 *
 * ⚠️ Every write goes through `mergeIfExists` with a **FLAT** patch — scalars
 * and arrays only. `mergeIfExists` is `update()` plus a NOT_FOUND narrow, and it
 * THROWS a `TypeError` on a nested plain object or a dotted key, because
 * `update()` REPLACES a map where set-merge deep-merges it. A link document
 * deleted meanwhile answers `false` and is counted in neither counter.
 *
 * ⚠️ Positional, and `(integracaoId, produtoPaiId)` are two strings in a row:
 * swapping them resolves no child and the sync silently does nothing. The order
 * mirrors {@link lerLinksDeVariacao}, which is the only reader it calls.
 */
export async function sincronizarLinksDeVariacao(
  db: Firestore,
  integracaoId: string,
  produtoPaiId: string,
  modelos: readonly ShopeeModel[],
  nowMs: number,
): Promise<ResultadoSincronizacaoModelos> {
  const links = await lerLinksDeVariacao(db, integracaoId, produtoPaiId);

  const porModelId = new Map<number, ShopeeModel>();
  for (const modelo of modelos) {
    const modelId = modelIdUtilizavel(modelo.model_id);
    if (modelId === null) {
      // The `0` sentinel (or an unreadable id). It is reported in NEITHER
      // counter and NOT in `modelosSemFilho`: nothing may bind it, so calling it
      // "a live model with no child" would invite a caller to mint a link that
      // binds any line of any listing.
      console.warn('[shopee/anuncios] modelo sem model_id utilizável; ignorado na sincronização', {
        integracaoId,
        produtoPaiId,
      });
      continue;
    }
    // FIRST sighting wins, like every other duplicate rule on this path — and
    // it says so, because two rows for one `model_id` is a reading nothing here
    // can arbitrate.
    if (porModelId.has(modelId)) {
      console.warn('[shopee/anuncios] duas linhas de get_model_list com o mesmo model_id', {
        integracaoId,
        produtoPaiId,
        modelId,
      });
      continue;
    }
    porModelId.set(modelId, modelo);
  }

  const vinculados = new Set<number>();
  let atualizados = 0;
  let marcados = 0;

  for (const link of links) {
    if (link.modelId === null) continue;
    const modelo = porModelId.get(link.modelId);

    if (modelo !== undefined) {
      vinculados.add(link.modelId);
      const patch = patchDeAtualizacao(link, modelo);
      if (patch === null) continue;
      if (await escrever(db, link, patch)) atualizados += 1;
      continue;
    }

    const marca = patchDeAusencia(link, nowMs);
    if (marca === null) continue;
    if (await escrever(db, link, marca)) marcados += 1;
  }

  const modelosSemFilho: ModeloSemFilho[] = [];
  for (const [modelId, modelo] of porModelId) {
    if (vinculados.has(modelId)) continue;
    modelosSemFilho.push({
      modelId,
      tierIndex: [...(modelo.tier_index ?? [])],
      modelSku: modelo.model_sku ?? null,
    });
  }

  return { atualizados, marcados, modelosSemFilho };
}

/**
 * `update()` through the handle, with the NOT_FOUND narrow `mergeIfExists`
 * already owns. `false` ⇒ the child link was deleted between the read and the
 * write; that is not a failure and it is counted nowhere.
 */
async function escrever(
  db: Firestore,
  link: LinkDeVariacao,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const escrito = await variacaoShopeeLinkCollection.mergeIfExists(
    db,
    { produtoId: link.produtoId },
    link.linkDocId,
    patch,
  );
  if (!escrito) {
    console.warn('[shopee/anuncios] vínculo de variação desapareceu antes da escrita', {
      produtoId: link.produtoId,
      linkDocId: link.linkDocId,
      modelId: link.modelId,
    });
  }
  return escrito;
}

/**
 * The refresh patch, or `null` when the stored reading already agrees.
 *
 * ⚠️ `modeloAusenteEm: null` is part of it: a model that came BACK clears the
 * mark rather than leaving a link that claims to be unavailable while Shopee
 * reports it.
 */
function patchDeAtualizacao(
  link: LinkDeVariacao,
  modelo: ShopeeModel,
): Record<string, unknown> | null {
  const modelStatus = modelStatusDeLink(modelo.model_status);
  const tierIndex = [...(modelo.tier_index ?? [])];
  const igual =
    link.modelStatus === modelStatus &&
    link.modeloAusenteEm === null &&
    mesmaTierIndex(link.tierIndex, tierIndex);
  if (igual) return null;
  return { model_status: modelStatus, tier_index: tierIndex, modeloAusenteEm: null };
}

/** The MARK patch, or `null` when this link is already marked. */
function patchDeAusencia(link: LinkDeVariacao, nowMs: number): Record<string, unknown> | null {
  const jaMarcado =
    link.modelStatus === SHOPEE_MODEL_STATUS.unavailable && link.modeloAusenteEm !== null;
  if (jaMarcado) return null;
  return { model_status: SHOPEE_MODEL_STATUS.unavailable, modeloAusenteEm: nowMs };
}

/**
 * `tier_index` equality — the ONE fold in this module, and it drives a diff, so
 * it owes a pair AND a near-miss.
 *
 * **PAIR:** `[0, 1]` ≡ `[0, 1]` — nothing to write.
 * **NEAR-MISS:** `[0, 1]` and `[1, 0]` are DISTINCT. `tier_index` is
 * POSITIONAL — it names the option chosen at each tier level, in order — so a
 * set comparison would read a swapped pair as "no change" and leave a link
 * pointing at the wrong variação. `[0]` and `[0, 0]` are distinct too.
 *
 * ⚠️ Hand-rolled on purpose: the repo's shared deep-equality helper is an
 * INVENTORIED fold helper and is banned under this folder (a raw-text grep
 * enforces it), and a length-plus-element-wise comparison is what the property
 * actually is.
 */
function mesmaTierIndex(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((n, i) => n === b[i]);
}
