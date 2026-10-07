import {
  chaveAcessoValida,
  lerItensDoProc,
  mesmoPrecoEmReais,
  naOrdemDoPedido,
  type DfeReferenciadoItem,
  type ItemDoProc,
} from '@delfrance/schemas';
import type { PedidoDevolucaoDataPort } from './port';

/**
 * Which item of the origin NF-e each devolução item returns — the
 * `det/DFeReferenciado` a devolução must carry (NT 2025.002 VC02-14, cStat
 * 321, #1683).
 *
 * The origin's `nItem` is read from its authorized XML (`lerItensDoProc`, see
 * its header for why nothing else can recompute it), and the returned line is
 * found there by its PRODUCT CODE. Both apps write `cProd` the same way modulo
 * one fallback: this app emits `sku ?? gtin`, the legacy Flutter app emitted
 * `(sku ?? gtin ?? produtoUid).substring(0, 60)`.
 *
 * ⚠️ **What this treats as equal, and what it keeps apart** (the fold the
 * equivalence-fold inventory asks every comparison to state):
 *  - a code: EXACT string equality, entity-decoded on the XML side — `'A1'` is
 *    not `'a1'` nor `'A1 '`; truncation to 60 characters is the one fold, and
 *    it only applies to codes longer than 60 (legacy's own cut);
 *  - a price: `mesmoPrecoEmReais(vUnCom, precoDeVenda)` — the same centavo
 *    after `roundReais` is equal, one centavo apart is distinct (49.99 ≠ 50),
 *    and it only ever NARROWS a product's candidate lines, never adds one.
 *
 * When several lines of the origin carry the returned product, the price picks
 * the line; when the price matches none of them (the operator edited it) or
 * several, LINE ORDER decides — the k-th returned line of a product claims the
 * k-th still-unclaimed line of it (Lucas, 2026-10-07). Each origin line is
 * claimed at most once, which is also what keeps VC02-20 (1072: the same chave
 * and `nItem` twice) from ever firing on a seeded devolução.
 *
 * A line that cannot be placed keeps the chave with `nItem: null`, never a
 * guessed number: SEFAZ does not check that a referenced `nItem` exists in the
 * referenced nota, so a wrong one would be authorized silently, while a null
 * one is refused at the emission pre-flight (1048) with the item named.
 */

/** One approved NF-e of an origin pedido, as the matcher reads it. */
export interface NotaDeOrigem {
  readonly chave: string;
  /** Its `<det>` lines, or `null` when its XML is absent or unreadable. */
  readonly itens: readonly ItemDoProc[] | null;
}

/** The slice of a pedido item the matcher reads. */
export interface ItemParaReferenciar {
  readonly sku?: string | null;
  readonly gtin?: string | null;
  readonly produtoUid?: string | null;
  readonly precoDeVenda: number;
  readonly ordem?: unknown;
}

/** The legacy app's cut on `cProd` (`pedido_nfe_base.dart`, the XSD's 60). */
const CPROD_MAX = 60;

/**
 * The approved NF-es of one origin pedido, latest first — the raw `nfev4`
 * docs of `listNFesAprovadas`, with their chave and det lines. A doc whose
 * chave is not a valid chave de acesso contributes nothing.
 *
 * Latest-first by `ultima_modificacao`, because Firestore's result order is
 * undefined (`listNFesAprovadas` carries no orderBy).
 */
export function notasDeOrigemDe(docs: ReadonlyArray<Record<string, unknown>>): NotaDeOrigem[] {
  const modificacaoDe = (doc: Record<string, unknown>): number =>
    typeof doc.ultima_modificacao === 'number' ? doc.ultima_modificacao : Number.NEGATIVE_INFINITY;
  return [...docs]
    .sort((a, b) => modificacaoDe(b) - modificacaoDe(a))
    .filter((doc): doc is Record<string, unknown> & { chave: string } => {
      return typeof doc.chave === 'string' && chaveAcessoValida(doc.chave);
    })
    .map((doc) => ({ chave: doc.chave, itens: lerItensDoProc(doc.xml_nfe_proc) }));
}

/**
 * Per origin pedido id, its approved NF-es ({@link notasDeOrigemDe}). The reads
 * run concurrently; each one is the query the devolução already made for its
 * chaves, so the XML costs nothing extra.
 */
export async function lerNotasDeOrigem(
  port: PedidoDevolucaoDataPort,
  originIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, readonly NotaDeOrigem[]>> {
  const pares = await Promise.all(
    originIds.map(
      async (originId) =>
        [originId, notasDeOrigemDe(await port.listNFesAprovadas(originId))] as const,
    ),
  );
  return new Map(pares);
}

/** The item's candidate `cProd` codes, in priority order, each also cut to 60. */
function codigosDoItem(item: ItemParaReferenciar): string[] {
  const out: string[] = [];
  for (const codigo of [item.sku, item.gtin, item.produtoUid]) {
    if (typeof codigo !== 'string' || codigo === '') continue;
    for (const c of [codigo, codigo.slice(0, CPROD_MAX)]) if (!out.includes(c)) out.push(c);
  }
  return out;
}

const chaveDaLinha = (chave: string, nItem: number): string => `${chave}#${nItem}`;

/**
 * The origin line `item` returns within ONE nota, or `null` when the nota does
 * not carry its product or every line of it is already claimed.
 */
function linhaNaNota(
  item: ItemParaReferenciar,
  itensDaNota: readonly ItemDoProc[],
  chave: string,
  reivindicadas: ReadonlySet<string>,
): number | null {
  // The FIRST code with any line in the nota decides the product — a gtin must
  // not reach another line merely because the sku's lines are all taken.
  for (const codigo of codigosDoItem(item)) {
    const doProduto = itensDaNota.filter((d) => d.cProd === codigo);
    if (doProduto.length === 0) continue;
    const livres = doProduto.filter((d) => !reivindicadas.has(chaveDaLinha(chave, d.nItem)));
    if (livres.length === 0) return null;
    const noPreco = livres.filter((d) => mesmoPrecoEmReais(d.vUnCom, item.precoDeVenda));
    const candidatas = noPreco.length > 0 ? noPreco : livres;
    return Math.min(...candidatas.map((d) => d.nItem));
  }
  return null;
}

/** The reference for one item over an origin's notas (latest first), claiming the line. */
function referenciaNasNotas(
  item: ItemParaReferenciar,
  notas: readonly NotaDeOrigem[],
  reivindicadas: Set<string>,
): DfeReferenciadoItem | null {
  const [maisRecente] = notas;
  if (maisRecente === undefined) return null;
  for (const nota of notas) {
    // An unreadable nota MAY be the one carrying this product: matching an
    // older nota past it would be a guess, so the item stays unplaced.
    if (nota.itens === null) break;
    const nItem = linhaNaNota(item, nota.itens, nota.chave, reivindicadas);
    if (nItem !== null) {
      reivindicadas.add(chaveDaLinha(nota.chave, nItem));
      return { chaveAcesso: nota.chave, nItem };
    }
  }
  return { chaveAcesso: maisRecente.chave, nItem: null };
}

/**
 * The `dfeReferenciado` of each devolução item returned from ONE origin pedido,
 * aligned with `itens` (the input order). Lines are claimed in the pedido's
 * line order (`naOrdemDoPedido`), so "the k-th line" means the k-th by `ordem`.
 * No approved NF-e → every entry is `null`.
 */
export function referenciarItensDaDevolucao(
  itens: readonly ItemParaReferenciar[],
  notas: readonly NotaDeOrigem[],
): Array<DfeReferenciadoItem | null> {
  const out: Array<DfeReferenciadoItem | null> = itens.map(() => null);
  const reivindicadas = new Set<string>();
  const emOrdem = naOrdemDoPedido(
    itens.map((item, indice) => ({ item, indice })),
    ({ item }) => item.ordem,
  );
  for (const { item, indice } of emOrdem)
    out[indice] = referenciaNasNotas(item, notas, reivindicadas);
  return out;
}

/** A reference SEFAZ can take: a chave and the origin's `nItem`. */
export function referenciaCompleta(ref: DfeReferenciadoItem | null | undefined): boolean {
  return ref != null && ref.chaveAcesso !== '' && ref.nItem != null;
}

/** How many items still lack a complete reference — the devolução's emission would be refused. */
export function referenciasPendentes(
  itens: ReadonlyArray<{ readonly dfeReferenciado?: DfeReferenciadoItem | null }>,
): number {
  return itens.filter((item) => !referenciaCompleta(item.dfeReferenciado)).length;
}

/**
 * The Fiscal tab's "Preencher a partir das NF-e de origem": fill the items whose
 * reference is not complete, against the approved NF-es of EVERY origin pedido
 * of the devolução (`saidasRelacionadas`), aligned with `itens`. A complete
 * reference is kept as it is and its origin line counts as claimed.
 *
 * The devolução's items are no longer tied to an origin (they are keyed by
 * produto), so the origin is inferred:
 *  - a partial reference (chave typed, `nItem` missing) looks only at that nota;
 *  - otherwise the origins whose notas carry the item's product; exactly one —
 *    and no OTHER origin with a nota it cannot read, which might be the real
 *    one → match there; none and a single origin with notas → its latest chave
 *    with `nItem: null`; anything else (several origins, an unreadable rival) is
 *    left as it was — the operator decides, never a guess between two notas.
 */
export function preencherReferenciasPendentes(
  itens: ReadonlyArray<
    ItemParaReferenciar & { readonly dfeReferenciado?: DfeReferenciadoItem | null }
  >,
  notasPorOrigem: ReadonlyMap<string, readonly NotaDeOrigem[]>,
): Array<DfeReferenciadoItem | null> {
  const reivindicadas = new Set<string>();
  for (const item of itens) {
    const ref = item.dfeReferenciado;
    if (ref != null && referenciaCompleta(ref))
      reivindicadas.add(chaveDaLinha(ref.chaveAcesso, ref.nItem!));
  }
  const origens = [...notasPorOrigem.values()].filter((notas) => notas.length > 0);
  const out = itens.map((item) => item.dfeReferenciado ?? null);
  const emOrdem = naOrdemDoPedido(
    itens.map((item, indice) => ({ item, indice })),
    ({ item }) => item.ordem,
  );
  for (const { item, indice } of emOrdem) {
    const atual = item.dfeReferenciado ?? null;
    if (referenciaCompleta(atual)) continue;

    if (atual != null && atual.chaveAcesso !== '') {
      const nota = origens.flat().find((n) => n.chave === atual.chaveAcesso);
      if (nota !== undefined) out[indice] = referenciaNasNotas(item, [nota], reivindicadas);
      continue;
    }

    const comProduto = origens.filter((notas) =>
      notas.some(
        (n) => n.itens !== null && linhaNaNota(item, n.itens, n.chave, new Set()) !== null,
      ),
    );
    const [unica] = comProduto;
    // An origin whose nota cannot be read MAY be where this item came from, so
    // a single readable hit elsewhere is not "the one origin" — leave it.
    const outraIlegivel = origens.some(
      (notas) => notas !== unica && notas.some((n) => n.itens === null),
    );
    if (comProduto.length === 1 && unica !== undefined && !outraIlegivel) {
      out[indice] = referenciaNasNotas(item, unica, reivindicadas);
    } else if (comProduto.length === 0 && origens.length === 1) {
      out[indice] = referenciaNasNotas(item, origens[0]!, reivindicadas);
    }
  }
  return out;
}
