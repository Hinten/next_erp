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
 *
 * ## One binding, two readers (step 12, PR 12-e1)
 *
 * The stock sync publishes, for a SKU, the stock of the unit an order line of
 * that SKU consumes, so it reads the SAME binding through the SAME pieces
 * (`estoque/resolverEstoque.ts`), never a copy of them:
 *
 *  - {@link lerVinculosDoSkuAmazon} holds THE query and the ambiguity detector.
 *    Its `campos` option projects the docs with a classic `select` (a link doc
 *    carries a whole product payload, and Enterprise bills the data a read
 *    returns); the order import passes none, so its read is the one above;
 *  - {@link lerDonosAmazon} holds the by-id read of the donos and the
 *    gone-dono rule; its `campos` option masks that read (the hop's own fields,
 *    {@link CAMPOS_UNIDADE_DO_DONO_AMAZON}, are always among them);
 *  - {@link unidadeDoDonoAmazon} is the hop, {@link resolucaoPorUnidadesAmazon}
 *    the dono count ("gone dropped, two live ⇒ ambiguous").
 *
 * The import's own answers ({@link vinculoDoSkuAmazon},
 * {@link unidadesDosDonosAmazon}, {@link criarResolvedorDeVinculosAmazon}) are
 * built from those pieces and unchanged.
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

/** One link doc of a SKU, as {@link lerVinculosDoSkuAmazon} read it. */
export interface DocVinculoAmazon {
  /** The link doc's own id. */
  readonly linkId: string;
  /** The produto the link doc sits under, taken from its PATH. */
  readonly donoId: string;
  /** Its fields: all of them, or only the projected ones (`campos`). */
  readonly dados: Readonly<Record<string, unknown>>;
}

/** The link docs of one SKU: the limit reached, or every doc read that has a dono. */
export type LeituraVinculosDoSkuAmazon =
  | { readonly tipo: 'limite' }
  | { readonly tipo: 'docs'; readonly docs: readonly DocVinculoAmazon[] };

/** How {@link lerVinculosDoSkuAmazon} reads. */
export interface OpcoesLeituraVinculosAmazon {
  /**
   * Project each doc to these fields (a classic `select`; `[]` = the keys
   * alone). Absent = the whole doc: the order import's read.
   */
  readonly campos?: readonly string[];
}

/**
 * THE link-doc query (module header) for `sku` of this conta: the limit
 * reached, or every doc read with its dono from its path. A doc with no dono
 * in its path (a root-level `prodAmazon/<id>`) still counts toward the limit and
 * is left out of `docs`.
 */
export async function lerVinculosDoSkuAmazon(
  db: Firestore,
  contaId: string,
  sku: string,
  opcoes: OpcoesLeituraVinculosAmazon = {},
): Promise<LeituraVinculosDoSkuAmazon> {
  const [campoConta, campoSku] = CAMPOS_INDICE_VINCULO_AMAZON;
  const consulta = produtoAmazonLinkCollection
    .groupQuery(db)
    .where(campoConta, 'in', contaRefForms(contaId))
    .where(campoSku, '==', sku)
    .limit(LIMITE_VINCULOS_AMAZON);
  const snap = await (
    opcoes.campos === undefined ? consulta : consulta.select(...opcoes.campos)
  ).get();
  // The detector counts the DOCS read — a truncated page proves no single owner.
  if (snap.docs.length >= LIMITE_VINCULOS_AMAZON) return { tipo: 'limite' };
  const docs = snap.docs.flatMap((d): DocVinculoAmazon[] => {
    const donoId = d.ref.parent.parent?.id;
    if (typeof donoId !== 'string' || donoId === '') return [];
    return [{ linkId: d.id, donoId, dados: d.data() }];
  });
  return { tipo: 'docs', docs };
}

/** The DISTINCT donos of some link docs, sorted: two docs under one produto are one dono. */
export function donosDosVinculosAmazon(docs: readonly DocVinculoAmazon[]): string[] {
  return [...new Set(docs.map((d) => d.donoId))].sort();
}

/** The link docs of `sku` for this conta: the distinct donos, or the limit reached. */
export async function vinculoDoSkuAmazon(
  db: Firestore,
  contaId: string,
  sku: string,
): Promise<VinculoDoSkuAmazon> {
  const leitura = await lerVinculosDoSkuAmazon(db, contaId, sku);
  if (leitura.tipo === 'limite') return { tipo: 'limite' };
  const donos = donosDosVinculosAmazon(leitura.docs);
  return donos.length === 0 ? { tipo: 'nenhum' } : { tipo: 'donos', donoIds: donos };
}

/** Everything {@link unidadeDoDonoAmazon} reads off a dono: the kit guard and the family fields. */
export const CAMPOS_UNIDADE_DO_DONO_AMAZON = ['ehKit', 'paiId', 'filhoUnicoId'] as const;

/**
 * The SELLABLE UNIT a dono stands for (module header): the shared kit guard
 * and family hop, `unidadeVendavelDaRaiz`, over the dono's id and its raw doc
 * (at least {@link CAMPOS_UNIDADE_DO_DONO_AMAZON}). Pure.
 */
export function unidadeDoDonoAmazon(
  donoId: string,
  raw: Readonly<Record<string, unknown>>,
): string {
  return unidadeVendavelDaRaiz({
    ehKit: raw.ehKit === true,
    produtoId: donoId,
    familia: {
      id: donoId,
      paiId: raw.paiId as string | null | undefined,
      filhoUnicoId: raw.filhoUnicoId as string | null | undefined,
    },
  });
}

/** A live dono, as {@link lerDonosAmazon} read it. */
export interface DonoLidoAmazon {
  readonly id: string;
  /** Its doc: whole, or masked (`campos`). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** The sellable unit it stands for ({@link unidadeDoDonoAmazon}). */
  readonly unidadeId: string;
}

/** How {@link lerDonosAmazon} reads. */
export interface OpcoesLeituraDonosAmazon {
  /**
   * The fields the caller reads BESIDES the hop's own: the read is masked to
   * both ({@link CAMPOS_UNIDADE_DO_DONO_AMAZON} first). Absent = the whole doc:
   * the order import's read.
   */
  readonly campos?: readonly string[];
}

/** The mask {@link lerDonosAmazon} reads with, for the caller's `campos`: the hop's fields first. */
export function mascaraDosDonosAmazon(campos: readonly string[]): string[] {
  return [...new Set<string>([...CAMPOS_UNIDADE_DO_DONO_AMAZON, ...campos])];
}

/**
 * The donos, read BY ID in one `getAll`, each hopped to its unit (module
 * header), in the order asked; a GONE dono answers `null`.
 */
export async function lerDonosAmazon(
  db: Firestore,
  donoIds: readonly string[],
  opcoes: OpcoesLeituraDonosAmazon = {},
): Promise<(DonoLidoAmazon | null)[]> {
  if (donoIds.length === 0) return [];
  const refs = donoIds.map((id) => produtoCollection.docRef(db, {}, id));
  const snaps = await (opcoes.campos === undefined
    ? db.getAll(...refs)
    : db.getAll(...refs, { fieldMask: mascaraDosDonosAmazon(opcoes.campos) }));
  return snaps.map((snap, i) => {
    const id = donoIds[i] ?? '';
    if (!snap.exists) return null;
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    return { id, raw, unidadeId: unidadeDoDonoAmazon(id, raw) };
  });
}

/**
 * The SELLABLE UNIT each dono stands for, read BY ID in one `getAll` and hopped
 * (module header); a gone dono answers `null`.
 */
export async function unidadesDosDonosAmazon(
  db: Firestore,
  donoIds: readonly string[],
): Promise<(string | null)[]> {
  return (await lerDonosAmazon(db, donoIds)).map((dono) => dono?.unidadeId ?? null);
}

/** A resolver for ONE import: every lookup memoised by SKU (module header). */
export interface ResolvedorDeVinculosAmazon {
  resolver(sku: string | null): Promise<ResolucaoVinculoAmazon>;
}

const NAO_RESOLVIDO: ResolucaoVinculoAmazon = { produtoId: null, via: 'unresolved' };
const AMBIGUO: ResolucaoVinculoAmazon = { produtoId: null, via: FALHA_VINCULO_AMAZON.ambiguo };

/**
 * The dono count (module header), over the units of the LIVE donos, one entry
 * per dono (never deduplicated): none ⇒ unresolved; two or more ⇒ ambiguous,
 * even when they hop to ONE unit (two produtos claim the listing); exactly one
 * ⇒ bound to it. A gone dono is dropped BEFORE this count, by the caller. Pure.
 */
export function resolucaoPorUnidadesAmazon(vivos: readonly string[]): ResolucaoVinculoAmazon {
  const [unico, outro] = vivos;
  if (unico === undefined) return NAO_RESOLVIDO;
  if (outro !== undefined) return AMBIGUO;
  return { produtoId: unico, via: 'vinculo-amazon' };
}

/** What the limit reached resolves to: ambiguous (module header). */
export const RESOLUCAO_LIMITE_VINCULOS_AMAZON: ResolucaoVinculoAmazon = AMBIGUO;

export function criarResolvedorDeVinculosAmazon(
  db: Firestore,
  contaId: string,
): ResolvedorDeVinculosAmazon {
  const porSku = new Map<string, Promise<ResolucaoVinculoAmazon>>();
  const resolverSku = async (sku: string): Promise<ResolucaoVinculoAmazon> => {
    const vinculo = await vinculoDoSkuAmazon(db, contaId, sku);
    if (vinculo.tipo === 'nenhum') return NAO_RESOLVIDO;
    if (vinculo.tipo === 'limite') return RESOLUCAO_LIMITE_VINCULOS_AMAZON;
    // A gone dono is dropped BEFORE the donos are counted.
    const vivos = (await unidadesDosDonosAmazon(db, vinculo.donoIds)).filter(
      (u): u is string => u !== null,
    );
    return resolucaoPorUnidadesAmazon(vivos);
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
