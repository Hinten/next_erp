/**
 * The product import's two LIST phases (master plan step 9): `listagem`, the store's live product
 * list (`GET /v1/produto/?removido=false`), and `lixeira`, its TRASH list (`removido=true`), read
 * once per job right after the listing. Together they are the job's SNAPSHOT: the family assembly
 * (`familias.ts`) and every later phase read the store's catalogue from these pages, never from
 * the store again.
 *
 * ## Why the trash list too
 *
 * A trashed parent leaves its variations listed as LIVE rows (`removido: false`) that no listed
 * parent claims. The trash list names their parent, so such a variation is known to be in the trash
 * ("na lixeira": never linked, never created) without a detail read per variation; only the rows the
 * trash does not explain are detail-read (`familias.ts`, the `orfaos` phase).
 *
 * ## One unit at a time — state in, state out
 *
 * The dispatch asks {@link unidadeDaListaLi} what the next unit costs, runs it with
 * {@link executarUnidadeDaListaLi} and checkpoints the cursor it returns (the job's `listagem` or
 * `lixeira`, the same shape):
 *
 * | The cursor | The next unit | Cost |
 * | --- | --- | --- |
 * | an offset | one page at that offset, written to `paginas/{tipo}-{offset}` | one call |
 * | `proximoOffset: null` | the closing count below; the phase is done | no call |
 *
 * ## A page
 *
 *  - Asked at `limit` {@link LIMITE_PAGINA_PRODUTOS_LI} (the owner's capture measured 100 answered
 *    in full and 200 refused) through the package's `lerPaginaProdutosLi`, which sends exactly
 *    `limit`, `removido` and `offset` and validates the next offset; nothing here parses
 *    `meta.next`. `meta.limit` is read back (the cursor's `limiteLido`).
 *  - Each row becomes its compact ROW view (`lerProdutoLi`): no description, no price, no stock. A
 *    row with no usable `id` is dropped and counted (`linhasSemId`).
 *  - `removido` is re-checked on EVERY row: a row of the live list that says `removido: true` is
 *    skipped, and so is a row of the trash list that does not say exactly `true` (counted
 *    `foraDoFiltro`, for the dispatch's log line). Requiring an explicit `true` in the trash fails
 *    safe: an unexplained variation only costs a detail read, while a live product read as trashed
 *    would never be imported.
 *  - The page is written WHOLE to `paginas/{tipo}-{offset}` (root rule 7, tier 0: a deterministic
 *    id and a single writer — the job's own dispatches, one at a time — so a retried unit
 *    overwrites its own earlier attempt). A page holds at most 100 compact views, far under
 *    Firestore's 1 MiB document limit (`listagem.test.ts` pins a page of maximal rows).
 *  - The FIRST page's `meta.total_count` is the store's count (`totalLi`).
 *  - An EMPTY page ends the list whatever its `next` says: offset paging past the end can only
 *    yield more empty pages, so following them would never end.
 *
 * ## Never rely on the order — the closing count
 *
 * The list's order is the store's, undocumented (the owner's capture saw it break a descending id
 * order 33 times), and offset paging under concurrent edits can repeat a row (a product created
 * mid-listing) or skip one (a product trashed mid-listing). So nothing here relies on order, and
 * once the list is exhausted ONE unit with no call reads the job's pages back and counts the
 * DISTINCT ids (`linhas`); when the store announced a total and it differs, `divergente` is set,
 * with both numbers kept (`linhas`, `totalLi`) for the card. Which copy of a repeated row wins is
 * the assembly's call (`familias.ts`).
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * The job's own `paginas` subcollection, WHOLE, in document-key order
 * ({@link lerPaginasDoJobLi}): no filter, so no composite is involved, and the read is bounded by
 * one job's pages. If a measurement on the new project ever shows a key-ordered read scanning
 * beyond the collection, the `__name__`-only index is the remedy.
 *
 * ## Errors (root rule 6)
 *
 * Nothing is caught here: the package's and Firestore's errors propagate to the dispatch.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free, `db` and the client are parameters.
 */
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { paginaImportacaoLiCollection } from '@delfrance/data/admin/collections';
import { type LiLeituraClient, lerPaginaProdutosLi } from '@delfrance/integrations-loja-integrada';
import {
  type ImportacaoLojaIntegrada,
  LIMITE_PAGINA_PRODUTOS_LI,
  type PaginaListagemLi,
  type ProdutoLiLido,
  TIPO_PAGINA_IMPORTACAO_LI,
  type TipoPaginaImportacaoLi,
  idPaginaImportacaoLi,
  lerProdutoLi,
  paginaListagemLiSchema,
} from '@delfrance/schemas';

import { UNIDADE_IMPORTACAO_LI, type UnidadeImportacaoLi } from './orcamento';

/** A product list's cursor: the job's `listagem` and `lixeira` share this shape. */
export type CursorListaProdutosLi = ImportacaoLojaIntegrada['listagem'];

export interface ListagemDeps {
  readonly db: Firestore;
  /** The context's client: every call is switched, paced and logged there. */
  readonly cliente: LiLeituraClient;
  readonly jobId: string;
  /** The page's `lidaEmMs` stamp. */
  readonly agoraMs: () => number;
  /** The dispatch's cancellation, handed to the package read. */
  readonly sinal?: AbortSignal;
}

/** What one page held, for the dispatch's log line. */
export interface ContagemDaPaginaLi {
  /** Rows kept (written as views). */
  readonly linhas: number;
  /** Rows with no usable `id`: dropped. */
  readonly semId: number;
  /** Rows whose own `removido` contradicts the list's filter: skipped. */
  readonly foraDoFiltro: number;
}

/** How one unit of a list phase ended. */
export type PassoDaListaLi =
  /** One page read and written; `cursor` names the next one, or `null` at the end. */
  | {
      readonly tipo: 'pagina';
      readonly cursor: CursorListaProdutosLi;
      readonly contagem: ContagemDaPaginaLi;
      readonly correlationId: string;
    }
  /** The closing count: `linhas` and `divergente` are set; the phase is done. */
  | { readonly tipo: 'fechada'; readonly cursor: CursorListaProdutosLi };

/** The cost of a list phase's next unit (module header's table). Pure. */
export function unidadeDaListaLi(cursor: CursorListaProdutosLi): UnidadeImportacaoLi {
  return cursor.proximoOffset === null
    ? UNIDADE_IMPORTACAO_LI.familia
    : UNIDADE_IMPORTACAO_LI.chamada;
}

/**
 * Whether a row belongs to the list it came in (module header, "A page"): the live list keeps
 * anything not explicitly trashed; the trash keeps only an explicit `removido: true`.
 */
export function linhaPertenceALista(tipo: TipoPaginaImportacaoLi, linha: ProdutoLiLido): boolean {
  return tipo === TIPO_PAGINA_IMPORTACAO_LI.lixeira
    ? linha.removido === true
    : linha.removido !== true;
}

/**
 * Run the next unit of list `tipo` from `cursor` (the job's `listagem` or `lixeira` as last
 * checkpointed): one page, or the closing count. Its only write is the page document.
 */
export async function executarUnidadeDaListaLi(
  deps: ListagemDeps,
  tipo: TipoPaginaImportacaoLi,
  cursor: CursorListaProdutosLi,
): Promise<PassoDaListaLi> {
  if (cursor.proximoOffset === null) return fecharLista(deps, tipo, cursor);
  return lerPaginaDaLista(deps, tipo, cursor, cursor.proximoOffset);
}

async function lerPaginaDaLista(
  deps: ListagemDeps,
  tipo: TipoPaginaImportacaoLi,
  cursor: CursorListaProdutosLi,
  offset: number,
): Promise<PassoDaListaLi> {
  const pagina = await lerPaginaProdutosLi(deps.cliente, {
    offset,
    limite: LIMITE_PAGINA_PRODUTOS_LI,
    removido: tipo === TIPO_PAGINA_IMPORTACAO_LI.lixeira,
    sinal: deps.sinal,
  });

  const linhas: ProdutoLiLido[] = [];
  let semId = 0;
  let foraDoFiltro = 0;
  for (const bruta of pagina.linhas) {
    const lida = lerProdutoLi(bruta);
    if (lida === null) semId += 1;
    else if (!linhaPertenceALista(tipo, lida)) foraDoFiltro += 1;
    else linhas.push(lida);
  }

  const totalDaPagina = pagina.meta.total_count ?? null;
  await paginaImportacaoLiCollection.set(
    deps.db,
    { jobId: deps.jobId },
    idPaginaImportacaoLi(tipo, offset),
    {
      tipo,
      offset,
      linhas,
      linhasSemId: semId,
      limiteLido: pagina.meta.limit,
      totalLi: totalDaPagina,
      lidaEmMs: deps.agoraMs(),
    },
  );

  const primeira = cursor.paginas === 0;
  // An empty page ends the list whatever its `next` says (module header).
  const fim = pagina.linhas.length === 0;
  return {
    tipo: 'pagina',
    cursor: {
      ...cursor,
      proximoOffset: fim ? null : pagina.proximoOffset,
      paginas: cursor.paginas + 1,
      limiteLido: primeira ? pagina.meta.limit : cursor.limiteLido,
      totalLi: primeira ? totalDaPagina : cursor.totalLi,
    },
    contagem: { linhas: linhas.length, semId, foraDoFiltro },
    correlationId: pagina.correlationId,
  };
}

/** The closing count (module header): the DISTINCT ids of the list's pages, against its total. */
async function fecharLista(
  deps: ListagemDeps,
  tipo: TipoPaginaImportacaoLi,
  cursor: CursorListaProdutosLi,
): Promise<PassoDaListaLi> {
  const ids = new Set<number>();
  for (const pagina of await lerPaginasDoJobLi(deps.db, deps.jobId)) {
    if (pagina.tipo !== tipo) continue;
    for (const linha of pagina.linhas) ids.add(linha.id);
  }
  return {
    tipo: 'fechada',
    cursor: {
      ...cursor,
      linhas: ids.size,
      divergente: cursor.totalLi !== null && cursor.totalLi !== ids.size,
    },
  };
}

/**
 * Every snapshot page of job `jobId`, both lists, in document-key order — the listing's pages by
 * offset, then the trash list's (module header, "The reads"). Each parsed STRICTLY: the job writes
 * them through their schema, so a page that does not parse is corruption (a `ZodError`).
 */
export async function lerPaginasDoJobLi(db: Firestore, jobId: string): Promise<PaginaListagemLi[]> {
  const snap = await paginaImportacaoLiCollection
    .ref(db, { jobId })
    .orderBy(FieldPath.documentId())
    .get();
  return snap.docs.map((doc) => paginaListagemLiSchema.parse(doc.data()));
}
