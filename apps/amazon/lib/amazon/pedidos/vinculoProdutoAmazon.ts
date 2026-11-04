/**
 * Order line → ERP produto, for the Amazon order import (master plan step 5, PR
 * 5-d): through the conta's LINK DOCS only (`produtos/{produtoId}/prodAmazon`).
 * Reads only — this module writes nothing, and step 5 creates, repairs or binds
 * no link (D18).
 *
 * ## The lookup
 *
 * `prodAmazon` (collection group) `where contaAmazonOuterRef in <both stored
 * forms of the conta ref> and sku == <the line's sellerSku>`, `limit(10)`:
 *
 *  - both field names come from `CAMPOS_INDICE_VINCULO_AMAZON` (`@delfrance/schemas`),
 *    the ONE spelling the declared collection-group index pins
 *    (`vinculoProdutoAmazon.test.ts` reads `firestore.indexes.json` next to this
 *    query; on Enterprise an undeclared composite silently full-scans and bills
 *    the data scanned — root rule 1);
 *  - the conta ref in BOTH stored forms (`contaRefForms`: the canonical
 *    `documents/integracao/<id>` and the bare `integracao/<id>`) — the migrated
 *    corpus may carry either;
 *  - the SKU as EXACT bytes: no trim, no case fold (a seller SKU is the
 *    seller's own identifier, and `'ABC-1'` and `'abc-1'` are two listings);
 *  - memoised per SKU for one import, so a SKU sold on two lines costs one read.
 *
 * ## Ambiguity fails CLOSED (plan §3 decisions 15 and 46)
 *
 *  - the limit is an ambiguity DETECTOR, counted on `docs.length` (never
 *    `size`): reaching it means a truncated read, which cannot prove a single
 *    owner — the corpus may hold duplicate link docs, and the index returns them
 *    in no order this code may rely on;
 *  - owners are the DISTINCT `ref.parent.parent.id`: two link docs under one
 *    produto are one owner;
 *  - each owner is read BY ID (one `getAll`) and a GONE owner is no hit and
 *    counts toward no ambiguity (binding a deleted produto would move stock
 *    nowhere);
 *  - two live owners ⇒ ambiguous ⇒ unbound;
 *  - one owner ⇒ `unidadeVendavelDaRaiz` — the shared kit guard and family hop,
 *    never a copy: a kit stays on itself, a família-de-um parent answers its
 *    sole member (the produto that owns the stock), anything else itself.
 *
 * ## No fallback
 *
 * No link hit, or no `sellerSku` ⇒ UNBOUND (`produtoUid: null` under `'NONE'`,
 * inert for stock) and the importer files an incidente. There is NO SKU
 * fallback (the shared SKU resolver is never called) and no ASIN fallback:
 * binding an unlinked listing by its SKU alone is a link decision, gated by D18.
 * A stored `'NONE'` line is bound by the next import of the order after a link
 * doc appears.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoAmazonLinkCollection, produtoCollection } from '@delfrance/data/admin/collections';
import {
  contaRefForms,
  unidadeVendavelDaRaiz,
  type SkuMissKind,
} from '@delfrance/data/admin/produtos';
import { CAMPOS_INDICE_VINCULO_AMAZON } from '@delfrance/schemas';

/**
 * Link docs read per lookup — and the ambiguity detector: a read that REACHES
 * it is ambiguous (module header).
 */
export const LIMITE_VINCULOS_AMAZON = 10;

/** Why a line was left unbound by the link docs. */
export const FALHA_VINCULO_AMAZON = {
  /** Two live owners, or the read reached {@link LIMITE_VINCULOS_AMAZON}. */
  ambiguo: 'amazon-vinculo-ambiguo',
} as const satisfies Record<string, string>;

/** The incidente `subtipo` of an unbound line: the shared miss kind, or our ambiguity. */
export type FalhaVinculoAmazon =
  | Extract<SkuMissKind, 'unresolved'>
  | (typeof FALHA_VINCULO_AMAZON)[keyof typeof FALHA_VINCULO_AMAZON];

/** What one line's lookup answered. */
export type ResolucaoVinculoAmazon =
  | { readonly produtoId: string; readonly via: 'vinculo-amazon' }
  | { readonly produtoId: null; readonly via: FalhaVinculoAmazon };

/** What the link docs say about one SKU of the conta (owners only, unhopped). */
export type VinculoDoSkuAmazon =
  | { readonly tipo: 'nenhum' }
  | { readonly tipo: 'limite' }
  | { readonly tipo: 'donos'; readonly donoIds: readonly string[] };

/** The link docs of `sku` for this conta: the distinct owners, or the limit reached. */
export async function vinculoDoSkuAmazon(
  db: Firestore,
  contaId: string,
  sku: string,
): Promise<VinculoDoSkuAmazon> {
  const [campoConta, campoSku] = CAMPOS_INDICE_VINCULO_AMAZON;
  const snap = await produtoAmazonLinkCollection
    .groupQuery(db)
    .where(campoConta, 'in', contaRefForms(contaId))
    .where(campoSku, '==', sku)
    .limit(LIMITE_VINCULOS_AMAZON)
    .get();
  // The detector counts the DOCS read — a truncated page proves no single owner.
  if (snap.docs.length >= LIMITE_VINCULOS_AMAZON) return { tipo: 'limite' };
  const donos = [
    ...new Set(
      snap.docs
        .map((d) => d.ref.parent.parent?.id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ].sort();
  return donos.length === 0 ? { tipo: 'nenhum' } : { tipo: 'donos', donoIds: donos };
}

/**
 * The SELLABLE UNIT each owner stands for, read BY ID in one `getAll` and hopped
 * (module header); a gone owner answers `null`.
 */
export async function unidadesDosDonosAmazon(
  db: Firestore,
  donoIds: readonly string[],
): Promise<(string | null)[]> {
  if (donoIds.length === 0) return [];
  const snaps = await db.getAll(...donoIds.map((id) => produtoCollection.docRef(db, {}, id)));
  return snaps.map((snap, i) => {
    const donoId = donoIds[i] ?? '';
    if (!snap.exists) return null;
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    return unidadeVendavelDaRaiz({
      ehKit: raw.ehKit === true,
      produtoId: donoId,
      familia: {
        id: donoId,
        paiId: raw.paiId as string | null | undefined,
        filhoUnicoId: raw.filhoUnicoId as string | null | undefined,
      },
    });
  });
}

/** A resolver for ONE import: every lookup memoised by SKU (module header). */
export interface ResolvedorDeVinculosAmazon {
  resolver(sku: string | null): Promise<ResolucaoVinculoAmazon>;
}

const NAO_RESOLVIDO: ResolucaoVinculoAmazon = { produtoId: null, via: 'unresolved' };
const AMBIGUO: ResolucaoVinculoAmazon = { produtoId: null, via: FALHA_VINCULO_AMAZON.ambiguo };

export function criarResolvedorDeVinculosAmazon(
  db: Firestore,
  contaId: string,
): ResolvedorDeVinculosAmazon {
  const porSku = new Map<string, Promise<ResolucaoVinculoAmazon>>();
  const resolverSku = async (sku: string): Promise<ResolucaoVinculoAmazon> => {
    const vinculo = await vinculoDoSkuAmazon(db, contaId, sku);
    if (vinculo.tipo === 'nenhum') return NAO_RESOLVIDO;
    if (vinculo.tipo === 'limite') return AMBIGUO;
    // A gone owner is dropped BEFORE the owners are counted; two LIVE owners are
    // ambiguous even when both hop to one unit (two produtos claim the listing).
    const vivos = (await unidadesDosDonosAmazon(db, vinculo.donoIds)).filter(
      (u): u is string => u !== null,
    );
    const [unico, outro] = vivos;
    if (unico === undefined) return NAO_RESOLVIDO;
    if (outro !== undefined) return AMBIGUO;
    return { produtoId: unico, via: 'vinculo-amazon' };
  };
  return {
    resolver(sku) {
      if (sku === null) return Promise.resolve(NAO_RESOLVIDO);
      let p = porSku.get(sku);
      if (p === undefined) {
        p = resolverSku(sku);
        porSku.set(sku, p);
      }
      return p;
    },
  };
}
