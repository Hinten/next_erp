/**
 * The product import's DETAIL reads (master plan step 9): one `GET /v1/produto/{id}/` per unit,
 * stored as `detalhes/{liId}` on the job, and the stored details read back by id.
 *
 * Who reads a detail: the `orfaos` phase, for a listed variation no listed parent claims and the
 * trash does not explain (its `pai` attaches it, `familias.ts`); a family whose parent names a
 * variation never seen as a row; and "complete", for a field only the detail carries. Every caller
 * reads through {@link lerDetalheParaOJobLi}, one call per unit (the dispatch budgets it as one
 * call, `orcamento.ts`).
 *
 * ## What is stored: the detail VIEW, never the body
 *
 * The package's read returns an explicit projection (no price, no stock, no SEO, no store URL),
 * and `lerDetalheProdutoLi` turns it into the DETAIL view the job stores: a description longer
 * than the ERP's field is kept as its LENGTH only (`descricaoLonga`, `descricaoTamanho`), never as
 * text — so even a 50 KB store description leaves a small document. One document per product,
 * written WHOLE at its id (root rule 7, tier 0: a deterministic id and a single writer — the job's
 * own dispatches, one at a time — so a retried unit overwrites its own earlier attempt).
 *
 * ## The outcomes
 *
 *  - `lido`: the detail, stored with `estado: lido` — a trashed product included (`removido` is in
 *    the view; what it means is the caller's call).
 *  - `inexistente`: the store answered 404 (`LiNotFoundError`): the product is gone, or never was
 *    this store's. Stored with `estado: inexistente` and no detail, so the decision is kept.
 *  - `divergente`: the store answered a body whose `id` is not the product asked for (or no id a
 *    view can carry). NOTHING is stored — a detail of another product must never stand for this
 *    one — and the caller treats the product as having no usable detail.
 *
 * Everything else propagates unchanged (root rule 6): a 429, a 401, a 5xx, a timeout, a body off
 * the package's schema, Firestore. The dispatch owns what each one means for the job; a body that
 * did not parse is retried like any other failure, never read as "the product is gone".
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * {@link lerDetalhesGravadosLi} reads the job's `detalhes` BY ID only — never a query.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free, `db` and the client are parameters.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { detalheImportacaoLiCollection } from '@delfrance/data/admin/collections';
import {
  type LiLeituraClient,
  LiNotFoundError,
  buscarProdutoLi,
} from '@delfrance/integrations-loja-integrada';
import {
  type DetalheImportacaoLi,
  ESTADO_DETALHE_IMPORTACAO_LI,
  type ProdutoLiDetalhado,
  detalheProdutoLiSchema,
  lerDetalheProdutoLi,
} from '@delfrance/schemas';

export interface DetalhesDeps {
  readonly db: Firestore;
  /** The context's client: every call is switched, paced and logged there. */
  readonly cliente: LiLeituraClient;
  readonly jobId: string;
  /** The detail's `lidoEmMs` stamp. */
  readonly agoraMs: () => number;
  /** The dispatch's cancellation, handed to the package read. */
  readonly sinal?: AbortSignal;
}

/** How one detail read ended (module header, "The outcomes"). */
export type ResultadoDetalheLi =
  | { readonly tipo: 'lido'; readonly detalhe: ProdutoLiDetalhado; readonly correlationId: string }
  | { readonly tipo: 'inexistente' }
  | { readonly tipo: 'divergente'; readonly correlationId: string };

/** The doc id of a product's detail: its store id in decimal. */
function idDoDetalhe(liId: number): string {
  return String(liId);
}

/**
 * Read product `liId`'s detail from the store and store its VIEW as `detalhes/{liId}` (module
 * header). One call; at most one write.
 */
export async function lerDetalheParaOJobLi(
  deps: DetalhesDeps,
  liId: number,
): Promise<ResultadoDetalheLi> {
  const gravar = (dados: Omit<DetalheImportacaoLi, 'lidoEmMs'>): Promise<void> =>
    detalheImportacaoLiCollection.set(deps.db, { jobId: deps.jobId }, idDoDetalhe(liId), {
      ...dados,
      lidoEmMs: deps.agoraMs(),
    });

  let resposta: Awaited<ReturnType<typeof buscarProdutoLi>>;
  try {
    resposta = await buscarProdutoLi(deps.cliente, liId, { sinal: deps.sinal });
  } catch (err) {
    if (!(err instanceof LiNotFoundError)) throw err;
    await gravar({ liId, estado: ESTADO_DETALHE_IMPORTACAO_LI.inexistente, detalhe: null });
    return { tipo: 'inexistente' };
  }

  const detalhe = lerDetalheProdutoLi(resposta.dados);
  // Another product's detail never stands for this one: nothing is stored.
  if (detalhe?.id !== liId) {
    return { tipo: 'divergente', correlationId: resposta.correlationId };
  }
  await gravar({ liId, estado: ESTADO_DETALHE_IMPORTACAO_LI.lido, detalhe });
  return { tipo: 'lido', detalhe, correlationId: resposta.correlationId };
}

/**
 * The stored details of `ids` (each read by id), keyed by store id; an id with no stored detail is
 * absent from the map. Each parsed STRICTLY: the job writes them through their schema, so one that
 * does not parse is corruption (a `ZodError`).
 */
export async function lerDetalhesGravadosLi(
  db: Firestore,
  jobId: string,
  ids: readonly number[],
): Promise<Map<number, DetalheImportacaoLi>> {
  const unicos = [...new Set(ids)];
  const snaps = await Promise.all(
    unicos.map((id) => detalheImportacaoLiCollection.docRef(db, { jobId }, idDoDetalhe(id)).get()),
  );
  const detalhes = new Map<number, DetalheImportacaoLi>();
  snaps.forEach((snap, i) => {
    const id = unicos[i];
    if (id !== undefined && snap.exists) {
      detalhes.set(id, detalheProdutoLiSchema.parse(snap.data()));
    }
  });
  return detalhes;
}

/** The detail VIEW a stored detail carries, when it was read (`lido`), else `null`. Pure. */
export function detalheLidoLi(
  detalhes: ReadonlyMap<number, DetalheImportacaoLi>,
  liId: number,
): ProdutoLiDetalhado | null {
  const gravado = detalhes.get(liId);
  return gravado?.estado === ESTADO_DETALHE_IMPORTACAO_LI.lido ? gravado.detalhe : null;
}
