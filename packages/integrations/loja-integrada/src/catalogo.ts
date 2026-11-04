/**
 * The four catalogue reads (master-plan step 10), over the GET-only client:
 *
 *  - {@link listarCategoriasLi} — `GET /v1/categoria/`, every page;
 *  - {@link listarMarcasLi} — `GET /v1/marca/`, every page;
 *  - {@link listarGradesLi} — `GET /v1/grades/`, every page (the grades carry
 *    no options);
 *  - {@link buscarGradeLi} — `GET /v1/grades/{id}/`, one grade with its
 *    options.
 *
 * Each one only reads and parses: no retry, no projection, no cache, no
 * decision. Every error is the client's or the pager's, rethrown as-is (a 404
 * is `LiNotFoundError`, a 403 `LiAuthError`, a malformed body `LiSchemaError`,
 * a list longer than its ceiling `LiPaginacaoError`); what each one means for
 * the caller is the app's call.
 *
 * ## Paths
 *
 * The SLASH form, as the validating GET and the order reads use it. The owner's
 * catalogue capture C9 requested all four that way and every one answered 200.
 * The client never follows a redirect, so a wrong form would surface as a
 * visible `LiHttpError`, never as a silent second call. The category list is
 * the validating GET's own path (`CAMINHO_VALIDACAO`).
 *
 * ## Page size and ceiling: the caller's numbers, both required
 *
 * `limite` (sent as `limit`) and `maxPaginas` are REQUIRED options, each a
 * positive safe integer, checked before anything is fetched
 * (`LiConfigError('limite')` / `('maxPaginas')`): the package invents neither
 * number, and never defaults the ceiling. `limit` is not a declared parameter
 * on these three operations in the public document (it is inferred from
 * `meta.next`), so the answer's `meta.limit` is read back on every page and
 * returned, never assumed: paging follows `meta.next` (`paginarLi`), whatever
 * page size the provider applied. A list that still has a `next` after
 * `maxPaginas` pages throws `LiPaginacaoError('limite-de-paginas')`; it is
 * never returned truncated.
 *
 * ## What is never sent
 *
 *  - `id_externo`: on these GETs that flag makes the path id the store's
 *    EXTERNAL id. The grade id sent is Loja Integrada's own `id`, so the flag
 *    is never sent.
 *  - No `/set/{ids}` reads: a consumer reads the whole list once.
 *  - No body, ever: the read client has no way to send one.
 *
 * ⚠️ The grade id is checked before anything is built, like the order reads'
 * ids (`idsDeCaminho.ts`): a positive safe integer, a number or its plain
 * decimal text. Anything else is `LiConfigError('caminho')` and NOTHING is
 * fetched — interpolated, `'1/2'` would name another resource.
 */
import type { z } from 'zod';

import type { LiLeituraClient, RespostaLi } from './client';
import { LiConfigError } from './errors';
import { idOuRecusa } from './idsDeCaminho';
import { paginarLi } from './paginacao';
import type { OpcoesLeituraLi } from './pedidos';
import {
  type CategoriaLi,
  type GradeDetalheLi,
  type GradeLi,
  liCategoriaSchema,
  liGradeDetalheSchema,
  liGradeSchema,
  liMarcaSchema,
  type MarcaLi,
} from './types';

/** The category list; also the validating GET's path. */
export const CAMINHO_CATEGORIAS_LI = '/v1/categoria/';

/** The brand list. */
export const CAMINHO_MARCAS_LI = '/v1/marca/';

/** The grade list; one grade's detail is `${CAMINHO_GRADES_LI}<id>/`. */
export const CAMINHO_GRADES_LI = '/v1/grades/';

export interface OpcoesListaCatalogoLi {
  /**
   * The page size ASKED for, sent as `limit`: a positive safe integer. The
   * provider may apply another; `ListaCatalogoLi.limites` says what it did.
   */
  readonly limite: number;
  /**
   * The most pages the list may take before it throws
   * `LiPaginacaoError('limite-de-paginas')`: a positive safe integer, never
   * defaulted here.
   */
  readonly maxPaginas: number;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

export interface ListaCatalogoLi<T> {
  /** Every row of every page, in the order received — never sorted or de-duplicated. */
  readonly linhas: readonly T[];
  /** One per page read, in order, for the caller's log lines. */
  readonly correlationIds: readonly string[];
  /** `meta.limit` of each page, in order, exactly as the provider answered it. */
  readonly limites: readonly number[];
}

/** A positive safe integer; anything else, `NaN` and non-numbers included, is not. */
function inteiroPositivo(valor: unknown): boolean {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor > 0;
}

/** Every page of one catalogue list, read before returning. */
async function listarCatalogo<S extends z.ZodType>(
  cliente: LiLeituraClient,
  operacao: string,
  caminho: string,
  schemaLinha: S,
  opts: OpcoesListaCatalogoLi,
): Promise<ListaCatalogoLi<z.infer<S>>> {
  // Both checked HERE, before the pager runs: an absent ceiling must be refused,
  // never left for the pager to default.
  if (!inteiroPositivo(opts.limite)) {
    throw new LiConfigError('limite', { operacao, refCredencial: null });
  }
  if (!inteiroPositivo(opts.maxPaginas)) {
    throw new LiConfigError('maxPaginas', { operacao, refCredencial: null });
  }
  const linhas: z.infer<S>[] = [];
  const correlationIds: string[] = [];
  const limites: number[] = [];
  for await (const pagina of paginarLi(cliente, {
    operacao,
    caminho,
    query: { limit: opts.limite },
    schemaLinha,
    maxPaginas: opts.maxPaginas,
    sinal: opts.sinal,
  })) {
    linhas.push(...pagina.objetos);
    correlationIds.push(pagina.correlationId);
    limites.push(pagina.meta.limit);
  }
  return { linhas, correlationIds, limites };
}

/** `GET /v1/categoria/`, every page, each row through `liCategoriaSchema`. */
export function listarCategoriasLi(
  cliente: LiLeituraClient,
  opts: OpcoesListaCatalogoLi,
): Promise<ListaCatalogoLi<CategoriaLi>> {
  return listarCatalogo(
    cliente,
    'listarCategorias',
    CAMINHO_CATEGORIAS_LI,
    liCategoriaSchema,
    opts,
  );
}

/** `GET /v1/marca/`, every page, each row through `liMarcaSchema`; inactive brands included. */
export function listarMarcasLi(
  cliente: LiLeituraClient,
  opts: OpcoesListaCatalogoLi,
): Promise<ListaCatalogoLi<MarcaLi>> {
  return listarCatalogo(cliente, 'listarMarcas', CAMINHO_MARCAS_LI, liMarcaSchema, opts);
}

/** `GET /v1/grades/`, every page, each row through `liGradeSchema` (no options). */
export function listarGradesLi(
  cliente: LiLeituraClient,
  opts: OpcoesListaCatalogoLi,
): Promise<ListaCatalogoLi<GradeLi>> {
  return listarCatalogo(cliente, 'listarGrades', CAMINHO_GRADES_LI, liGradeSchema, opts);
}

/**
 * `GET /v1/grades/{gradeId}/`, parsed by `liGradeDetalheSchema`: one grade and
 * its options, with no query at all.
 *
 * ⚠️ The answer is not checked against `gradeId` here, and neither is each
 * option's `grade`: the caller compares the detail's `id` with the grade it
 * asked for, and decides what an option of another grade means.
 *
 * `async` on purpose: a refused id rejects the promise like every other
 * failure, rather than throwing before the caller holds one.
 */
export async function buscarGradeLi(
  cliente: LiLeituraClient,
  gradeId: number | string,
  opts: OpcoesLeituraLi = {},
): Promise<RespostaLi<GradeDetalheLi>> {
  const operacao = 'buscarGrade';
  const id = idOuRecusa(gradeId, operacao);
  return cliente.get({
    operacao,
    caminho: `${CAMINHO_GRADES_LI}${id}/`,
    schema: liGradeDetalheSchema,
    sinal: opts.sinal,
  });
}
