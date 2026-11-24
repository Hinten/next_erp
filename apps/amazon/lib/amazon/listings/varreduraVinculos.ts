/**
 * The WALK over every link doc of a conta, one page at a time, for the Amazon
 * listings flows' runs (step 13, PR 13-b): the page read and the page core —
 * which SKUs a page holds and which of them THIS page evaluates. ONE walk for
 * every flow; the stock flow's daily reconcile (`estoque/reconciliacaoEstoque.ts`)
 * walks through it, and so does any later flow's run.
 *
 * ## The page ({@link lerPaginaVarreduraVinculosAmazon})
 *
 * Per conta ref form, in sequence (canonical, then bare), ONE `==` query on the
 * `prodAmazon` collection group (`contaAmazonOuterRef == forma`, ordered by
 * `__name__`, after the form's stored cursor, projected to
 * {@link CAMPOS_VARREDURA_VINCULOS_AMAZON}), up to
 * {@link PAGINA_VARREDURA_VINCULOS_AMAZON} link docs a page over both forms,
 * on the declared collection-group index `prodAmazon (contaAmazonOuterRef,
 * __name__)` (`CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON`). A form whose query
 * answers fewer docs than it asked for is done. A full page whose LAST doc is
 * not under a produto cannot store its cursor: the page answers
 * `cursor-ilegivel`. The caller's deadline is read before every query
 * (`prazo`).
 *
 * ## The page core ({@link paginaVarreduraVinculosAmazon})
 *
 *  1. The walk page, above.
 *  2. The GROUPING ({@link agruparPaginaVarreduraVinculosAmazon}, pure): each
 *     doc under a produto with a non-empty string `sku`, by SKU (its paths in
 *     page order); a doc outside `produtos/<id>/prodAmazon/<id>` is counted
 *     `fora-de-produto`, one without a SKU `sem-sku`.
 *  3. The DEDUPE, stateless: each distinct SKU's link docs, read through the
 *     batch reader's own query at the flow's projection
 *     (`lerVinculosDosSkusListingAmazon`); the SKU is evaluated only on the page
 *     holding the SMALLEST path among its docs, in the server's key order
 *     ({@link compararCaminhosVinculosAmazon}), and counted `ja-visto` on every
 *     other page. So a SKU whose docs straddle two pages is evaluated once,
 *     with no state carried between pages. (A SKU whose docs reach the order
 *     import's limit is ambiguous: no full doc list exists, so it is evaluated
 *     on every page holding one of its docs, where the verdict refuses it — a
 *     count, never a send.) The docs read here are handed back
 *     (`vinculosLidos`) so the batch reader does not query them again.
 *
 * The counter keys are {@link CONTADOR_VARREDURA_VINCULOS_AMAZON}, summed in
 * the order they were met (grouping, then dedupe).
 *
 * Reads only: no write, no clock but the caller's, no network.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { produtoAmazonLinkCollection } from '@delfrance/data/admin/collections';
import { contaRefForms } from '@delfrance/data/admin/produtos';
import {
  CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX,
  CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON,
  type CursorVarreduraEstoqueAmazon,
  type CursoresVarreduraEstoqueAmazon,
} from '@delfrance/schemas';

import type { LeituraVinculosDoSkuAmazon } from '../pedidos/vinculoProdutoAmazon';
import { type PrazoVinculosAmazon, lerVinculosDosSkusListingAmazon } from './avaliacaoLoteVinculos';
import type { CamposVinculoListingAmazon } from './resolverVinculo';

/** The link docs one page reads, over both ref forms. */
export const PAGINA_VARREDURA_VINCULOS_AMAZON = 300;

/** The walk's projection (module header): the SKU is all the walk reads off a doc. */
export const CAMPOS_VARREDURA_VINCULOS_AMAZON = ['sku'] as const;

/** Why a page could not be walked: the deadline, or a cursor its last doc cannot be. */
export const MOTIVO_TRUNCAMENTO_VARREDURA_VINCULOS_AMAZON = {
  prazo: 'prazo',
  cursorIlegivel: 'cursor-ilegivel',
} as const;

export type MotivoTruncamentoVarreduraVinculosAmazon =
  (typeof MOTIVO_TRUNCAMENTO_VARREDURA_VINCULOS_AMAZON)[keyof typeof MOTIVO_TRUNCAMENTO_VARREDURA_VINCULOS_AMAZON];

/** The page core's counter keys (module header). */
export const CONTADOR_VARREDURA_VINCULOS_AMAZON = {
  /** A link doc whose `sku` is not a non-empty string: nothing to evaluate. */
  semSku: 'sem-sku',
  /** A link doc that is not `produtos/<id>/prodAmazon/<id>`: no produto owns it. */
  foraDeProduto: 'fora-de-produto',
  /** A SKU this page skips: it is evaluated on the page of its smallest link-doc path. */
  jaVisto: 'ja-visto',
} as const;

/** The two cursors of a walk, one per conta ref form. */
export type CursoresVarreduraVinculosAmazon = CursoresVarreduraEstoqueAmazon;

/** One link doc as the walk read it. */
export interface DocDaVarreduraVinculosAmazon {
  /** Its full path: `produtos/<id>/prodAmazon/<id>` for every doc a produto owns. */
  readonly caminho: string;
  /** Its SKU, or `null` when it holds none. */
  readonly sku: string | null;
}

/** A walked page: its docs, and the cursors after them. */
export interface PaginaLidaVarreduraVinculosAmazon {
  readonly docs: readonly DocDaVarreduraVinculosAmazon[];
  readonly cursores: CursoresVarreduraVinculosAmazon;
}

/** Two document keys in the server's order: segment by segment, a shorter path first. */
export function compararCaminhosVinculosAmazon(a: string, b: string): number {
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
    const x = sa[i] ?? '';
    const y = sb[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return sa.length - sb.length;
}

/** The walk's conta ref forms, in walk order, each with its cursor key. */
function formasDaVarredura(
  contaId: string,
): readonly (readonly [keyof CursoresVarreduraVinculosAmazon, string])[] {
  const [canonica, nua] = contaRefForms(contaId);
  return [
    ['canonica', canonica],
    ['nua', nua],
  ];
}

/** A stored cursor path as the handle's document reference (the walk's `startAfter`). */
function refDoCursor(db: Firestore, caminho: string): DocumentReference {
  const [, produtoId = '', , linkId = ''] = caminho.split('/');
  return produtoAmazonLinkCollection.docRef(db, { produtoId }, linkId);
}

/** A done form's stored cursor: its last doc when that can be one, else the previous. */
function ultimoValido(ultimo: string | null, anterior: string | null): string | null {
  return ultimo !== null && CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX.test(ultimo) ? ultimo : anterior;
}

/** Whether both forms are done: the walk is over. */
export function varreduraVinculosConcluida(c: CursoresVarreduraVinculosAmazon): boolean {
  return c.canonica.concluida && c.nua.concluida;
}

/**
 * The walk page (module header): up to one page of link docs over the forms
 * not yet done, and the cursors after them; or why the walk cannot go on: the
 * deadline passed before a query (`prazo`), or a full page ends on a doc whose
 * path cannot be a cursor (`cursor-ilegivel`). A form that ends short leaves
 * the rest of the page to the next form, so a page never holds more than
 * {@link PAGINA_VARREDURA_VINCULOS_AMAZON} docs.
 */
export async function lerPaginaVarreduraVinculosAmazon(
  db: Firestore,
  contaId: string,
  cursores: CursoresVarreduraVinculosAmazon,
  prazo: PrazoVinculosAmazon,
): Promise<PaginaLidaVarreduraVinculosAmazon | MotivoTruncamentoVarreduraVinculosAmazon> {
  const [campoConta] = CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON;
  const docs: DocDaVarreduraVinculosAmazon[] = [];
  const novos: Record<keyof CursoresVarreduraVinculosAmazon, CursorVarreduraEstoqueAmazon> = {
    canonica: cursores.canonica,
    nua: cursores.nua,
  };
  for (const [chave, forma] of formasDaVarredura(contaId)) {
    const cursor = novos[chave];
    if (cursor.concluida) continue;
    const restantes = PAGINA_VARREDURA_VINCULOS_AMAZON - docs.length;
    if (prazo.agora() >= prazo.prazoMs) return MOTIVO_TRUNCAMENTO_VARREDURA_VINCULOS_AMAZON.prazo;
    const base = produtoAmazonLinkCollection
      .groupQuery(db)
      .where(campoConta, '==', forma)
      .orderBy('__name__');
    const aposCursor =
      cursor.ultimoCaminho === null ? base : base.startAfter(refDoCursor(db, cursor.ultimoCaminho));
    const snap = await aposCursor
      .select(...CAMPOS_VARREDURA_VINCULOS_AMAZON)
      .limit(restantes)
      .get();
    for (const d of snap.docs) {
      const sku: unknown = d.data().sku;
      docs.push({ caminho: d.ref.path, sku: typeof sku === 'string' && sku !== '' ? sku : null });
    }
    const ultimo = snap.docs.at(-1)?.ref.path ?? null;
    if (snap.docs.length < restantes) {
      novos[chave] = { ultimoCaminho: ultimoValido(ultimo, cursor.ultimoCaminho), concluida: true };
      continue;
    }
    // A full page: its LAST doc is where the next page starts.
    if (ultimo === null || !CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX.test(ultimo)) {
      return MOTIVO_TRUNCAMENTO_VARREDURA_VINCULOS_AMAZON.cursorIlegivel;
    }
    novos[chave] = { ultimoCaminho: ultimo, concluida: false };
    break;
  }
  return { docs, cursores: novos };
}

/** A page's docs by SKU (module header, step 2). */
export interface AgrupamentoVarreduraVinculosAmazon {
  /** The distinct SKUs, in the order the page first met each. */
  readonly skus: readonly string[];
  /** Each SKU's paths on this page, in page order. */
  readonly caminhosDoSku: ReadonlyMap<string, readonly string[]>;
  /** `fora-de-produto` and `sem-sku`, as met. */
  readonly porChave: Readonly<Record<string, number>>;
}

/** Step 2 of the module header: the page's docs grouped by SKU, pure. */
export function agruparPaginaVarreduraVinculosAmazon(
  docs: readonly DocDaVarreduraVinculosAmazon[],
): AgrupamentoVarreduraVinculosAmazon {
  const porChave: Record<string, number> = {};
  const somar = (chave: string) => {
    porChave[chave] = (porChave[chave] ?? 0) + 1;
  };
  const daPagina = new Map<string, string[]>();
  for (const doc of docs) {
    if (!CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX.test(doc.caminho)) {
      somar(CONTADOR_VARREDURA_VINCULOS_AMAZON.foraDeProduto);
      continue;
    }
    if (doc.sku === null) {
      somar(CONTADOR_VARREDURA_VINCULOS_AMAZON.semSku);
      continue;
    }
    daPagina.set(doc.sku, [...(daPagina.get(doc.sku) ?? []), doc.caminho]);
  }
  return { skus: [...daPagina.keys()], caminhosDoSku: daPagina, porChave };
}

/**
 * Whether THIS page evaluates a SKU (module header, step 3): its smallest
 * path, among the docs its own query read and the docs this page holds, is
 * one of this page's. A query that reached the limit read no docs, so only
 * this page's paths count.
 */
export function paginaAvaliaSkuVinculosAmazon(
  proprios: readonly string[],
  leitura: LeituraVinculosDoSkuAmazon | undefined,
): boolean {
  const todos =
    leitura?.tipo === 'docs'
      ? leitura.docs.map((d) => `produtos/${d.donoId}/prodAmazon/${d.linkId}`)
      : [];
  const menor = [...todos, ...proprios].sort(compararCaminhosVinculosAmazon)[0];
  return menor !== undefined && proprios.includes(menor);
}

/** A page the core walked, grouped and deduplicated (module header). */
export interface PaginaVarreduraVinculosAmazon {
  readonly tipo: 'pagina';
  /** How many link docs the walk read on this page. */
  readonly vinculos: number;
  readonly cursores: CursoresVarreduraVinculosAmazon;
  /** The page's distinct SKUs, in the order it first met each. */
  readonly skus: readonly string[];
  /** The SKUs THIS page evaluates, in the same order. */
  readonly aAvaliar: readonly string[];
  /** Every page SKU's link docs as the dedupe read them (the batch reader's `vinculosLidos`). */
  readonly vinculosLidos: ReadonlyMap<string, LeituraVinculosDoSkuAmazon>;
  /** The counters, grouping first, then `ja-visto`. */
  readonly porChave: Readonly<Record<string, number>>;
}

/**
 * The page core (module header, steps 1–3) of `contaId`'s walk after
 * `cursores`: `campos` is the flow's masks, the batch reader's own, and the
 * dedupe reads the links at its `vinculo` projection, so the docs it hands
 * on are the ones that reader would read. A walk that cannot go on, or a
 * deadline before a dedupe read, answers `truncada` with its motivo.
 */
export async function paginaVarreduraVinculosAmazon(
  db: Firestore,
  contaId: string,
  cursores: CursoresVarreduraVinculosAmazon,
  opcoes: { readonly campos: CamposVinculoListingAmazon; readonly prazo: PrazoVinculosAmazon },
): Promise<
  | PaginaVarreduraVinculosAmazon
  | { readonly tipo: 'truncada'; readonly motivo: MotivoTruncamentoVarreduraVinculosAmazon }
> {
  // 1. The walk page.
  const pagina = await lerPaginaVarreduraVinculosAmazon(db, contaId, cursores, opcoes.prazo);
  if (typeof pagina === 'string') return { tipo: 'truncada', motivo: pagina };

  // 2. The grouping.
  const grupos = agruparPaginaVarreduraVinculosAmazon(pagina.docs);
  const porChave: Record<string, number> = { ...grupos.porChave };

  // 3. The dedupe, over each SKU's own link docs.
  const leituras = await lerVinculosDosSkusListingAmazon(
    db,
    contaId,
    grupos.skus,
    opcoes.campos.vinculo,
    opcoes.prazo,
  );
  if (leituras === null) {
    return { tipo: 'truncada', motivo: MOTIVO_TRUNCAMENTO_VARREDURA_VINCULOS_AMAZON.prazo };
  }
  const aAvaliar: string[] = [];
  for (const sku of grupos.skus) {
    if (paginaAvaliaSkuVinculosAmazon(grupos.caminhosDoSku.get(sku) ?? [], leituras.get(sku))) {
      aAvaliar.push(sku);
    } else {
      porChave[CONTADOR_VARREDURA_VINCULOS_AMAZON.jaVisto] =
        (porChave[CONTADOR_VARREDURA_VINCULOS_AMAZON.jaVisto] ?? 0) + 1;
    }
  }
  return {
    tipo: 'pagina',
    vinculos: pagina.docs.length,
    cursores: pagina.cursores,
    skus: grupos.skus,
    aAvaliar,
    vinculosLidos: leituras,
    porChave,
  };
}
