/**
 * The IMPORT-direction resolve cascade (#1517, step 9): *(item_id) → the parent
 * produto* and *(item_id, model_id) → the child produto*, plus the two link
 * documents each one already has.
 *
 * ## ⚠️ Why this is not `resolverProdutoDaLinhaShopee`
 *
 * The ORDER resolver answers a different question and answers it for a different
 * consumer. It hops through `unidadeVendavel`, so a family of one resolves to
 * the SOLE MEMBER — which is right for a sale (the member owns the stock) and
 * wrong here, where the import must bind the PARENT, the document that owns the
 * listing link and the children. Its miss kinds are also order-shaped and
 * PERSISTED. `packages/data/src/admin/produtos/index.ts` states the split
 * outright: the link-first rungs "stay in their apps; only the SKU stage moved".
 *
 * What IS reused is {@link INDICES_COMPOSTOS_SHOPEE} — the `.where()` calls
 * below are BUILT from that constant, so `produtoResolve.test.ts`'s check of it
 * against `firestore.indexes.json` covers these queries too and renaming a link
 * field breaks both sides together.
 *
 * ## ⚠️ `limit(2)` is an AMBIGUITY DETECTOR, not a page size
 *
 * Every rung that could legally answer "exactly one" asks for two. A second row
 * is not a tie-break candidate — it is the signal that the question has no
 * single answer, and the SKU rungs decline rather than bind the wrong produto
 * (#1067). `snap.docs.length`, never `snap.size`.
 *
 * ## ⚠️ Duplicate LINK documents: the first id wins, and nothing is ever deleted
 *
 * The legacy Flutter importer deleted every link but the first whenever it found
 * more than one for a `(conta, item_id)` pair. Step 9 never deletes: a link
 * document is the only record of a binding an operator may have made by hand,
 * and a delete is unrecoverable where a duplicate is merely noisy. The
 * lexically-first document id wins, one log line says so, and the extra rows
 * stay exactly where they are.
 *
 * ## ⚠️ Two link shapes that refuse the item
 *
 * A `prodshopee` found under a produto whose `paiId` is not null, and a
 * `variashopee` whose produto belongs to another family, are both reported as
 * FLAGS on the preparo rather than thrown here. The single refusal site is
 * `planejarImportacaoShopee`, which raises them before it builds anything — so
 * there is exactly one place that decides an item is blocked, one vocabulary and
 * one set of tests, and the CLI's dry run reaches the same verdict a live run
 * would. Nothing is written between this module and that throw.
 *
 * Pure of clocks and Next: every stamp is a parameter, and no module under
 * `produtos/` reads the ambient clock.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ShopeeModel } from '@delfrance/integrations-shopee';
import { sameCombo, toOuterRef } from '@delfrance/schemas';
import {
  integracaoCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { idDoRef } from '../core/vinculosShopee';
import { INDICES_COMPOSTOS_SHOPEE } from '../pedidos/produtoResolve';
import type { ItemLido } from './itemLido';
import type { DocumentoLido } from './planoImportacao';
import { idProdutoFilhoShopee, idProdutoPaiShopee } from './produtoIds';

const [INDICE_VARIACAO, INDICE_LISTAGEM] = INDICES_COMPOSTOS_SHOPEE;

/** The fixed doc id of the `extraData` singleton. */
const EXTRA_DATA_DOC_ID = 'singleton';

/** What the parent cascade settled, minus the stock row (`estoquePrecos.ts` reads that). */
export interface ResolucaoPaiShopee {
  /** `null` ⇒ nothing resolved; the plan mints the deterministic id. */
  readonly existente: DocumentoLido | null;
  readonly extraData: Record<string, unknown> | null;
  /** ⚠️ The `prodshopee` that matched sits under a CHILD produto — the item is refused. */
  readonly linkSobFilho: boolean;
  /** Does the ERP already hold children for this produto? */
  readonly jaTemFilhos: boolean;
  /** The `prodshopee` document to MERGE onto; `null` ⇒ the link is an `add`. */
  readonly link: DocumentoLido | null;
}

/** What one model's cascade settled, minus its stock row. */
export interface ResolucaoFilhoShopee {
  readonly modelo: ShopeeModel;
  readonly existente: DocumentoLido | null;
  /** ⚠️ The `variashopee` that matched points into ANOTHER family — the item is refused. */
  readonly vinculoDeOutraFamilia: boolean;
  readonly link: DocumentoLido | null;
}

/** One model's resolved combination, as the sibling rung compares it. */
export interface ComboDoFilho {
  readonly variacoesUid: readonly string[] | null;
}

function contaRefDe(integracaoId: string): string {
  return toOuterRef(integracaoCollection.docPath({}, integracaoId));
}

/** A query row, reduced to what every rung here reads. */
interface LinhaDeLink {
  readonly id: string;
  readonly raw: Record<string, unknown>;
  /** The OWNING produto's id — `ref.parent.parent.id`. */
  readonly produtoId: string | null;
}

/**
 * Pick ONE link document out of a group-query page, deterministically.
 *
 * ⚠️ `limit(2)` only ever proves "at least two", and that is enough: the rule is
 * "pick the first and say so", never "report how many". The in-memory sort makes
 * the choice independent of what any double returns, which is also what makes it
 * testable — real Firestore already orders an equality-only query by `__name__`,
 * so on the server the page of two already holds the two smallest.
 *
 * ⚠️ It NEVER deletes. The log line carries the count and the chosen id, and no
 * body.
 */
export function escolherLink(
  linhas: readonly LinhaDeLink[],
  contexto: Record<string, unknown>,
): LinhaDeLink | null {
  if (linhas.length === 0) return null;
  const ordenados = [...linhas].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const escolhido = ordenados[0]!;
  if (ordenados.length > 1) {
    console.warn('[shopee/importacao] mais de um vínculo para a mesma chave; usando o primeiro', {
      ...contexto,
      encontrados: ordenados.length,
      escolhido: escolhido.id,
    });
  }
  return escolhido;
}

export function linhasDeGrupo(snap: {
  docs: ReadonlyArray<{
    id: string;
    data: () => unknown;
    ref?: { parent?: { parent?: { id?: string } | null } | null };
  }>;
}): LinhaDeLink[] {
  return snap.docs.map((d) => ({
    id: d.id,
    raw: (d.data() ?? {}) as Record<string, unknown>,
    produtoId: d.ref?.parent?.parent?.id ?? null,
  }));
}

function comoDocumento(linha: LinhaDeLink | null): DocumentoLido | null {
  return linha === null ? null : { id: linha.id, raw: linha.raw };
}

/**
 * A produto as the plan will see it.
 *
 * ⚠️ `updateTime` rides along on EVERY produto this cascade reads — here and on
 * both SKU rungs — because it is what the guarded price patch asserts. A
 * produto read without it would plan a patch the writer refuses to send.
 */
function produtoLido(snap: {
  readonly id: string;
  readonly updateTime?: unknown;
  data: () => unknown;
}): DocumentoLido {
  return {
    id: snap.id,
    raw: (snap.data() ?? {}) as Record<string, unknown>,
    updateTime: snap.updateTime,
  };
}

async function lerProduto(db: Firestore, produtoId: string): Promise<DocumentoLido | null> {
  const snap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!snap.exists) return null;
  return produtoLido({ id: produtoId, updateTime: snap.updateTime, data: () => snap.data() });
}

async function lerExtraData(
  db: Firestore,
  produtoId: string,
): Promise<Record<string, unknown> | null> {
  const snap = await produtoExtraDataCollection.docRef(db, { produtoId }, EXTRA_DATA_DOC_ID).get();
  return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
}

/**
 * Does the ERP hold ANY child of this produto? One `paiId ==` query, `limit(1)`.
 *
 * ⚠️ Served by the existing `produtos (paiId ASC, nome ASC)` composite by
 * PREFIX, like {@link lerIrmaos} — no index of its own. Exported for the
 * importer's CREATE-race arm, which asks the same question of the document its
 * `.create()` collided with: one copy of the query, never two.
 */
export async function produtoJaTemFilhos(db: Firestore, produtoId: string): Promise<boolean> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', produtoId).limit(1).get();
  return snap.docs.length > 0;
}

/**
 * The SKU a Shopee listing is identified by in the ERP: `(item_sku ?? '').trim()`.
 *
 * ⚠️ THE parent-SKU rung's fold, exported so step 19 keys on the SAME string
 * (#1527, R-14): the native-kit create's duplicate scan (`localizarKitsPorSku`)
 * and its `kit-sku-repetido` refusal must ask exactly what this import's rung 2
 * asks, or an unlinked created kit would be re-imported onto a DIFFERENT
 * produto than the one that created it. Equal: leading/trailing whitespace
 * (`' KIT-1 '` ≡ `'KIT-1'`), and `null`/absent ≡ `''` (no SKU — the rung is
 * skipped). Distinct: case (`'kit-1'` ≠ `'KIT-1'` — the rung's `where('sku',
 * '==', …)` is case-sensitive), and inner whitespace (`'KIT 1'` ≠ `'KIT1'`).
 */
export function skuDoItemShopee(base: { readonly item_sku?: string | null }): string {
  return (base.item_sku ?? '').trim();
}

/**
 * The PARENT cascade.
 *
 *  1. `prodshopee (item_id == N, conta == …)` — the listing link. A hit under a
 *     produto whose `paiId` is not null sets {@link ResolucaoPaiShopee.linkSobFilho}
 *     and resolves NOTHING, so even a mis-ordered caller cannot bind that child.
 *  2. `produtos (sku == item_sku, paiId == null)`, `limit(2)`, accepted on
 *     EXACTLY one — `item_sku` folded by {@link skuDoItemShopee}. Two hits are
 *     the ambiguity signal, not a tie to break.
 *  3. create — the caller mints {@link idProdutoPaiShopee}.
 *
 * ⚠️ A produto reached through rung 2 still reuses its existing link for THIS
 * integração when the group query found one: otherwise every re-import would
 * mint a second `prodshopee` document under the same produto.
 */
export async function resolverPaiDaListagem(
  db: Firestore,
  integracaoId: string,
  entrada: ItemLido,
): Promise<ResolucaoPaiShopee> {
  const conta = contaRefDe(integracaoId);

  // ⚠️ `item_id` goes to the server as a NUMBER. `String(itemId)` matches
  // nothing, silently — which is exactly what the legacy importer did.
  const porLink = await produtoShopeeLinkCollection
    .groupQuery(db)
    .where(INDICE_LISTAGEM.campos[0], '==', entrada.itemId)
    .where(INDICE_LISTAGEM.campos[1], '==', conta)
    .limit(2)
    .get();

  const linkEscolhido = escolherLink(linhasDeGrupo(porLink), {
    integracaoId,
    itemId: entrada.itemId,
    subcolecao: 'prodshopee',
  });

  if (linkEscolhido?.produtoId != null && linkEscolhido.produtoId !== '') {
    const produto = await lerProduto(db, linkEscolhido.produtoId);
    const paiId = produto?.raw.paiId ?? null;
    if (paiId != null) {
      return {
        existente: null,
        extraData: null,
        linkSobFilho: true,
        jaTemFilhos: false,
        link: comoDocumento(linkEscolhido),
      };
    }
    if (produto !== null) {
      return {
        existente: produto,
        extraData: await lerExtraData(db, produto.id),
        linkSobFilho: false,
        jaTemFilhos: await produtoJaTemFilhos(db, produto.id),
        link: comoDocumento(linkEscolhido),
      };
    }
    // The link points at a produto that no longer exists. That is not a
    // conflict — it is a stale row — so the cascade simply falls through to the
    // SKU rung, and the link document is re-pointed by the merge below.
  }

  const sku = skuDoItemShopee(entrada.base);
  if (sku.length > 0) {
    const porSku = await produtoCollection
      .ref(db, {})
      .where('sku', '==', sku)
      .where('paiId', '==', null)
      .limit(2)
      .get();
    // ⚠️ EXACTLY one. `length`, never `size`; two hits DECLINE the rung.
    if (porSku.docs.length === 1) {
      const produto = produtoLido(porSku.docs[0]!);
      return {
        existente: produto,
        extraData: await lerExtraData(db, produto.id),
        linkSobFilho: false,
        jaTemFilhos: await produtoJaTemFilhos(db, produto.id),
        link: comoDocumento(linkEscolhido),
      };
    }
  }

  // Rung 3 — nothing resolved. The plan creates at the deterministic id, which
  // is computed here only so the caller never has to know the preimage.
  return {
    existente: null,
    extraData: null,
    linkSobFilho: false,
    jaTemFilhos: false,
    link: comoDocumento(linkEscolhido),
  };
}

/** The deterministic id a brand-new parent is created at. */
export function idDoPaiPlanejado(integracaoId: string, itemId: number): string {
  return idProdutoPaiShopee(integracaoId, itemId);
}

/** A sibling child, projected to what the combination rung compares. */
interface Irmao {
  readonly id: string;
  readonly variacoesUid: string[];
}

/**
 * The parent's existing children, read ONCE and lazily.
 *
 * ⚠️ Rides the existing `produtos (paiId ASC, nome ASC)` composite by PREFIX. Do
 * not add an `orderBy` or a second filter without checking
 * `firestore.indexes.json` first: Enterprise auto-creates nothing and an
 * unindexed query silently full-scans onto the invoice.
 */
async function lerIrmaos(db: Firestore, paiId: string): Promise<Irmao[]> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', paiId).get();
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
 * Does this link document name a model OTHER than `modelId` — i.e. is the
 * sibling already claimed?
 *
 * ⚠️ An absent or unreadable `model_id` answers **FALSE**, deliberately: "names
 * nothing" is not evidence of anyone else's claim, and reading it as one makes a
 * re-import decline the very link it wrote last time and mint a duplicate child
 * on every run. Compared as a STRING because a Flutter-era row may hold a
 * stringified id.
 */
export function vinculoNomeiaOutroModelo(raw: Record<string, unknown>, modelId: number): boolean {
  const chave = raw.model_id;
  if (typeof chave !== 'string' && typeof chave !== 'number') return false;
  return String(chave) !== String(modelId);
}

/** Every `variashopee` under one produto for THIS conta, read in one go. */
async function vinculosDoFilho(
  db: Firestore,
  produtoId: string,
  conta: string,
): Promise<LinhaDeLink[]> {
  const snap = await variacaoShopeeLinkCollection.ref(db, { produtoId }).get();
  return snap.docs
    .map((d) => ({
      id: d.id,
      raw: (d.data() ?? {}) as Record<string, unknown>,
      produtoId,
    }))
    .filter((l) => l.raw[INDICE_VARIACAO.campos[1]] === conta);
}

/**
 * A child's `variashopee` rows of the conta, narrowed to ONE listing when the
 * caller names it (step 19, #1527, S2C-01).
 *
 * `null` ⇒ every row of the conta, unchanged — the ordinary listing import's
 * behaviour. A link id ⇒ only the rows whose `produtoShopeeOuterRef` names that
 * `prodshopee` doc, through `idDoRef` (BOTH stored encodings — canonical
 * `documents/…` and the bare legacy path — never a raw `===` on the path).
 *
 * ⚠️ Why a kit needs it: a native kit's children routinely carry ANOTHER
 * listing's rows of the same conta — the old kit a recriar replaced, the
 * ordinary listing a converter superseded, a removed listing, a double-create
 * twin. Unscoped, each such row "claims" the child for a model this listing
 * does not have, so every child is declined and MINTED again (a duplicate
 * produto per model, and a família de um loses its member); and the link reuse
 * would MERGE this listing's model onto the other listing's row, rewriting its
 * `model_id` and orphaning its orders and its step-12/13 binding.
 */
function daListagem(
  vinculos: readonly LinhaDeLink[],
  linkDocIdDaListagem: string | null,
): LinhaDeLink[] {
  if (linkDocIdDaListagem === null) return [...vinculos];
  return vinculos.filter((v) => idDoRef(v.raw.produtoShopeeOuterRef) === linkDocIdDaListagem);
}

/**
 * The CHILD cascade, per model.
 *
 *  1. `variashopee (model_id == N, conta == …)` — **skipped entirely** when the
 *     model id is `0` or absent, because `0` is Shopee's "no model item"
 *     sentinel and a link written for it binds any line of any listing. A hit
 *     whose produto belongs to another family sets
 *     {@link ResolucaoFilhoShopee.vinculoDeOutraFamilia}.
 *  2. `produtos (sku == model_sku, paiId == pai)`, accepted on EXACTLY one —
 *     and only when that one is neither already claimed by an earlier model of
 *     this same listing nor carrying a `variashopee` for this conta that names a
 *     DIFFERENT model. `model_sku` is not unique on the wire, so without those
 *     two guards two models collapse onto one produto.
 *  3. the variation COMBINATION (`sameCombo`, order-insensitive), over the
 *     parent's existing children — loaded LAZILY, only once, and only when a
 *     model actually has a resolved combination to compare. A sibling whose own
 *     `variashopee` for this conta names a DIFFERENT model is skipped.
 *  4. create — the caller mints {@link idProdutoFilhoShopee}.
 *
 * `linkDocIdDaListagem` (step 19, S2C-01) scopes BOTH the rung-2/3 claim check
 * and their link reuse to ONE listing's rows — see {@link daListagem}. The kit
 * arm passes its listing's link id (the parent rung-1 hit's, else the
 * deterministic new kit link id); the ordinary listing import passes `null`,
 * which is exactly the behaviour before step 19. Rung 1 is not scoped: it asks
 * for THIS listing's own `model_id`. ⚠️ REQUIRED, with no default (OP-2): a
 * caller that forgot it would silently disable the listing-scoped claim check
 * (mutant X1 / S2C-01) and still compile; the type checker now says so.
 */
export async function resolverFilhosDaListagem(
  db: Firestore,
  integracaoId: string,
  paiId: string,
  paiExiste: boolean,
  modelos: readonly ShopeeModel[],
  combos: readonly ComboDoFilho[],
  linkDocIdDaListagem: string | null,
): Promise<ResolucaoFilhoShopee[]> {
  const conta = contaRefDe(integracaoId);
  const saida: ResolucaoFilhoShopee[] = [];

  let irmaos: Irmao[] | null = null;
  const tomados = new Set<string>();
  const lerIrmaosUmaVez = async (): Promise<Irmao[]> => {
    irmaos ??= paiExiste ? await lerIrmaos(db, paiId) : [];
    return irmaos;
  };

  for (const [i, modelo] of modelos.entries()) {
    const modelId = typeof modelo.model_id === 'number' ? modelo.model_id : 0;

    // ---- rung 1 — the variation link ---------------------------------------
    let link: LinhaDeLink | null = null;
    let existente: DocumentoLido | null = null;
    let deOutraFamilia = false;

    if (modelId !== 0) {
      const porLink = await variacaoShopeeLinkCollection
        .groupQuery(db)
        .where(INDICE_VARIACAO.campos[0], '==', modelId)
        .where(INDICE_VARIACAO.campos[1], '==', conta)
        .limit(2)
        .get();
      link = escolherLink(linhasDeGrupo(porLink), {
        integracaoId,
        modelId,
        subcolecao: 'variashopee',
      });
      if (link?.produtoId != null && link.produtoId !== '') {
        const produto = await lerProduto(db, link.produtoId);
        if (produto !== null) {
          if (produto.raw.paiId !== paiId) {
            deOutraFamilia = true;
          } else {
            existente = produto;
            tomados.add(produto.id);
          }
        }
      }
    }

    // ---- rung 2 — sku scoped to the parent ---------------------------------
    const modelSku = (modelo.model_sku ?? '').trim();
    if (existente === null && !deOutraFamilia && modelSku.length > 0) {
      const porSku = await produtoCollection
        .ref(db, {})
        .where('sku', '==', modelSku)
        .where('paiId', '==', paiId)
        .limit(2)
        .get();
      if (porSku.docs.length === 1) {
        const doc = porSku.docs[0]!;
        // ⚠️ The SAME two guards rung 3 applies, for the same reason and at the
        // same cost. `model_sku` carries no uniqueness constraint on the wire,
        // so two models of ONE listing may name the same sku — and a sibling
        // this dispatch already took, or one whose own `variashopee` for this
        // conta names ANOTHER model, would then be bound twice: one produto
        // document for two models, the second model's price and estoque written
        // over the first's, and two `variashopee` rows under it naming two
        // different `model_id`s. That state is permanent, because on every later
        // import BOTH models win rung 1 onto the same child. Mercado Livre's
        // equivalent applies the guard at this rung too.
        const jaTomado = tomados.has(doc.id);
        const vinculos = jaTomado
          ? []
          : daListagem(await vinculosDoFilho(db, doc.id, conta), linkDocIdDaListagem);
        if (!jaTomado && !vinculos.some((v) => vinculoNomeiaOutroModelo(v.raw, modelId))) {
          existente = produtoLido(doc);
          tomados.add(existente.id);
          // Reuse the candidate's own link for this conta, so a re-import merges
          // onto it instead of minting a second `variashopee` under the same
          // produto — through {@link escolherLink}, like every other duplicate
          // in this cascade.
          //
          // ⚠️ Never for `model_id: 0`, exactly as rung 1 never queries for it:
          // `0` is Shopee's "no model item" sentinel and a link carrying it
          // binds any line of any listing, so the child resolves and the link
          // stays `null`.
          if (modelId !== 0) {
            link ??= escolherLink(vinculos, {
              integracaoId,
              modelId,
              produtoId: doc.id,
              subcolecao: 'variashopee',
            });
          }
        }
      }
    }

    // ---- rung 3 — the variation combination --------------------------------
    const combo = combos[i]?.variacoesUid ?? null;
    if (existente === null && !deOutraFamilia && combo !== null && combo.length > 0) {
      for (const irmao of await lerIrmaosUmaVez()) {
        if (tomados.has(irmao.id)) continue;
        if (!sameCombo(irmao.variacoesUid, [...combo])) continue;
        // ⚠️ A sibling already claimed by ANOTHER model of this listing is not a
        // candidate. An absent `model_id` answers false — see
        // {@link vinculoNomeiaOutroModelo}. Scoped to this listing when the
        // caller names one ({@link daListagem}).
        const vinculos = daListagem(
          await vinculosDoFilho(db, irmao.id, conta),
          linkDocIdDaListagem,
        );
        if (vinculos.some((v) => vinculoNomeiaOutroModelo(v.raw, modelId))) continue;
        const produto = await lerProduto(db, irmao.id);
        if (produto === null) continue;
        existente = produto;
        tomados.add(produto.id);
        // Reuse the child's own link for this conta, so a re-import merges onto
        // it instead of minting a second `variashopee` under the same produto.
        // ⚠️ Through {@link escolherLink} like every other duplicate in this
        // cascade: two `variashopee` documents for one conta under ONE child is
        // the same anomaly as two under one key, and picking one silently is
        // how it stays invisible. Same rule — lexically first, one log line,
        // nothing deleted.
        link ??= escolherLink(vinculos, {
          integracaoId,
          modelId,
          produtoId: irmao.id,
          subcolecao: 'variashopee',
        });
        break;
      }
    }

    saida.push({
      modelo,
      existente,
      vinculoDeOutraFamilia: deOutraFamilia,
      link: comoDocumento(link),
    });
  }

  return saida;
}

/** The deterministic id a brand-new child is created at. */
export function idDoFilhoPlanejado(paiId: string, modelId: number): string {
  return idProdutoFilhoShopee(paiId, modelId);
}
