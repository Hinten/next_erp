/**
 * ONE page of the daily stock reconcile's ERP link walk (master plan step 12, PR 12-g): every
 * Loja Integrada link document of the ERP, in document-KEY order over the whole collection group,
 * one page at a time — the walk that finds what no typed query can (a conta ref with a leading
 * slash or empty segments, a store id stored as decimal text, and two links of one store id on
 * either side of a page boundary), since every link is read and filtered IN CODE by the shared
 * readers (`contaDoLinkLi`, `vinculoLiConta`, `vinculoDaContaLi`).
 *
 * ## The query, against the index (root rule 1)
 *
 * `collectionGroup('produtolojaintegrada').select(<the fields the readers read>)
 * .orderBy(FieldPath.documentId()).startAfter('<full path of the last link read>').limit(300)` —
 * no filter, the key ALONE: exactly the shape the anchor census and the counts audit already run
 * (`tools/migrations`), on the declared COLLECTION_GROUP `produtolojaintegrada (__name__ ASC)`.
 * Firestore Enterprise keeps no implicit key index, so without that entry each page would scan the
 * whole group (#1874). `caminhadaVinculos.indexes.test.ts` pins the pairing from the constants this
 * module builds the query from, and `tools/migrations/src/keyWalks.indexes.test.ts` lists the
 * entry as PERMANENT (this walk is its reader after the cutover). A classic query, never a
 * pipeline: nothing here needs a stage.
 *
 * ## A produto's links are evaluated TOGETHER, exactly once
 *
 * The plan of one (conta, produto) reads ALL the produto's links (`vinculoDaContaLi`: two store ids
 * are ambiguous, a parent beside a child is not), and key order keeps a produto's links contiguous.
 * So the cursor is ALWAYS the page's last link path — the walk always moves — and:
 *
 *  - a FULL page's trailing produto may have more links on the next page: it is completed here
 *    with ONE where-less listing of its own `produtolojaintegrada` (`lerVinculosDoProdutoLi`, its
 *    own partition, no index), and evaluated whole;
 *  - the next page skips every link of the cursor's owner, read off the cursor path: that produto
 *    was evaluated already. A produto with more links than a page is skipped page after page,
 *    while the cursor still advances.
 *
 * ## What is not a produto's link
 *
 * Only a document at exactly `produtos/{produtoId}/produtolojaintegrada/{linkId}` is: a link under
 * any other root (a test collection's, a stray copy) is counted (`ignorados`) and never attributed
 * to a produto of the same id. Its path still moves the cursor.
 *
 * Next-free, `db` a parameter, every access through a `@delfrance/data/admin/collections` handle.
 */
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { produtoLojaIntegradaLinkCollection } from '@delfrance/data/admin/collections';

import { GRUPO_VINCULO_LI } from '../../pedidos/vinculoProdutoLi';
import { lerVinculosDoProdutoLi } from '../leituraEstoqueErp';

/**
 * The link fields the walk projects: what the shared readers read — the conta (`contaDoLinkLi`),
 * the store id and the trash (`vinculoLiConta`), and the parent id and the grades
 * (`vinculoDaContaLi`). The SAME constant the `.select()` is built from.
 */
export const CAMPOS_VINCULO_CAMINHADA_LI = [
  'contaLojaIntegrada',
  'id',
  'removido',
  'paiProdutoIntegradaId',
  'grades',
] as const;

/** The collection-group id the walk reads (the index entry's `collectionGroup`). */
export const GRUPO_CAMINHADA_LI = GRUPO_VINCULO_LI;

/** Links per page: the anchor census's page, one `getAll` of produtos per page. */
export const TAMANHO_PAGINA_CAMINHADA_LI = 300;

const CAMINHO_VINCULO = /^produtos\/([^/]+)\/produtolojaintegrada\/([^/]+)$/;

/** The owner of a link from its path, or `null` when it is not exactly a produto's link. */
export function donoDoVinculoLi(caminho: string): string | null {
  const m = CAMINHO_VINCULO.exec(caminho);
  return m?.[1] ?? null;
}

/** One produto's links, as the page hands them to the evaluation: raw, every conta's. */
export interface GrupoDeVinculosLi {
  readonly produtoId: string;
  readonly links: readonly Readonly<Record<string, unknown>>[];
}

/** One page of the walk. */
export interface PaginaCaminhadaLi {
  /** The page's produtos, in key order, each with ALL its links (module header). */
  readonly grupos: readonly GrupoDeVinculosLi[];
  /** The path the next page starts after; the cursor given when the page was empty. */
  readonly ultimoDocPath: string | null;
  /** The page was the last one (fewer documents than asked for). */
  readonly concluida: boolean;
  /** Link documents the page read. */
  readonly lidos: number;
  /** Documents that are not exactly a produto's link (module header). */
  readonly ignorados: number;
  /** Whether the trailing produto was completed with its own listing. */
  readonly completouUltimo: boolean;
}

/**
 * The page after `cursor` (`null` = the first), `tamanho` links at most (module header). Throws
 * what the reads throw.
 */
export async function lerPaginaCaminhadaLi(
  db: Firestore,
  cursor: string | null,
  tamanho: number = TAMANHO_PAGINA_CAMINHADA_LI,
): Promise<PaginaCaminhadaLi> {
  if (!Number.isSafeInteger(tamanho) || tamanho < 1) {
    throw new RangeError('lerPaginaCaminhadaLi: tamanho de página inválido');
  }
  let consulta = produtoLojaIntegradaLinkCollection
    .groupQuery(db)
    .select(...CAMPOS_VINCULO_CAMINHADA_LI)
    .orderBy(FieldPath.documentId());
  if (cursor !== null) consulta = consulta.startAfter(cursor);
  const snap = await consulta.limit(tamanho).get();

  const donoDoCursor = cursor === null ? null : donoDoVinculoLi(cursor);
  const porDono = new Map<string, Readonly<Record<string, unknown>>[]>();
  let ignorados = 0;
  for (const doc of snap.docs) {
    const dono = donoDoVinculoLi(doc.ref.path);
    if (dono === null) {
      ignorados += 1;
      continue;
    }
    // Evaluated with the previous page, whole (module header).
    if (dono === donoDoCursor) continue;
    const grupo = porDono.get(dono);
    const dados: Readonly<Record<string, unknown>> = doc.data();
    if (grupo === undefined) porDono.set(dono, [dados]);
    else grupo.push(dados);
  }

  const ultimo = snap.docs.at(-1);
  const concluida = snap.docs.length < tamanho;
  let completouUltimo = false;
  if (!concluida && ultimo !== undefined) {
    const dono = donoDoVinculoLi(ultimo.ref.path);
    if (dono !== null && porDono.has(dono)) {
      const todos = await lerVinculosDoProdutoLi(db, dono);
      porDono.set(
        dono,
        todos.filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null),
      );
      completouUltimo = true;
    }
  }

  return {
    grupos: [...porDono].map(([produtoId, links]) => ({ produtoId, links })),
    ultimoDocPath: ultimo?.ref.path ?? cursor,
    concluida,
    lidos: snap.docs.length,
    ignorados,
    completouUltimo,
  };
}
