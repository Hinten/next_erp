/**
 * Tastypie offset paging over the GET-only client: `paginarLi`.
 *
 * Loja Integrada lists answer `{ meta: { limit, offset, next, … }, objects }`,
 * where `next` is a RELATIVE link under `/api/v1/…` (note the `/api` prefix the
 * request path does not have). This module never follows that link.
 *
 * ## How the next request is built
 *
 * Each page is a `cliente.get` against **the caller's own `caminho`**, used
 * verbatim. From `meta.next` only the QUERY STRING is taken, and merged with the
 * caller's original query:
 *
 *  - a key present in `next` keeps `next`'s value (that is how `offset` moves);
 *  - an original key MISSING from `next` is added back, so a filter the provider
 *    forgot to carry (`since_atualizado`, `removido`) is never silently dropped —
 *    EXCEPT `offset`, which comes from `next` alone: the caller's starting offset
 *    must never stand in for one the provider left out;
 *  - the `next` path and any HOST in it are ignored. The token is only ever sent
 *    to `URL_BASE_LI`, whatever a response body says.
 *
 * ## When it stops
 *
 *  - `next === null` — the end; the generator returns.
 *  - `next` empty, unparseable, repeating a key, or without an `offset` of plain
 *    digits within the safe-integer range — `LiSchemaError` (`'formato'`,
 *    `campos: ['meta.next']`), whatever offset the caller's own query carried.
 *  - `next`'s offset not STRICTLY past BOTH the current page's `meta.offset` and
 *    the offset this page was requested at — `LiPaginacaoError('offset-nao-avanca')`,
 *    which would otherwise loop for ever. Both, because a provider answering a
 *    stale `meta.offset` (always 0) while `next` keeps pointing at the same
 *    offset passes a `meta.offset`-only check on every page, re-yielding one page
 *    until `maxPaginas`.
 *  - `maxPaginas` pages read and `next` still non-null —
 *    `LiPaginacaoError('limite-de-paginas')`. It throws and never truncates
 *    silently: a reconcile that read half a catalogue would act on the half.
 *  - the caller's `sinal` aborts — checked before every page and passed to every
 *    request, so the caller gets its own abort back and no further fetch happens.
 *
 * Rows are yielded in the order received, with no sorting or de-duplication.
 * Offset paging under concurrent edits can skip or repeat a row, so consumers
 * stay idempotent. `meta.limit` is exposed on each page as the provider answered
 * it, never assumed equal to the requested limit.
 *
 * ⚠️ `maxPaginas` and the `next` offset are checked with `Number.isSafeInteger`
 * and `/^\d+$/`, not with Zod: `types.ts` is the only file under `src/` that may
 * use Zod for numbers (`integration-response-numbers-tolerant.test.js`).
 */
import type { z } from 'zod';

import type { LiLeituraClient } from './client';
import {
  type ContextoRequisicaoLi,
  LiConfigError,
  LiPaginacaoError,
  LiSchemaError,
} from './errors';
import { liEnvelopeSchema, type MetaLi } from './types';

/** 200 pages = 4,000 rows at `limit` 20. Each consumer may pass its own cap. */
export const MAX_PAGINAS_PADRAO = 200;

/** Only the query string of `meta.next` is read; this base is never contacted. */
const BASE_DESCARTAVEL = 'https://base.invalid';

export interface OpcoesPaginacaoLi<S extends z.ZodType> {
  readonly operacao: string;
  /** A path under `/v1/` — every page requests THIS path. */
  readonly caminho: string;
  /** The first page's query; its keys are re-added to every later page. */
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  /** The schema of ONE row of `objects`. */
  readonly schemaLinha: S;
  /** Defaults to {@link MAX_PAGINAS_PADRAO}; a positive safe integer. */
  readonly maxPaginas?: number;
  readonly sinal?: AbortSignal;
}

export interface PaginaLi<T> {
  readonly objetos: T[];
  readonly meta: MetaLi;
  readonly correlationId: string;
  /** 1-based. */
  readonly numero: number;
}

/** A plain-digits offset within the safe-integer range, else `null`. */
function lerOffset(bruto: string | undefined): number | null {
  if (bruto === undefined || !/^\d+$/.test(bruto)) return null;
  const offset = Number(bruto);
  return Number.isSafeInteger(offset) ? offset : null;
}

/**
 * The next page's query, or a `LiSchemaError` when `meta.next` cannot be
 * followed safely.
 */
function proximaPagina(
  next: string,
  original: ReadonlyMap<string, string>,
  ctx: ContextoRequisicaoLi & { readonly status: number },
): { readonly query: Record<string, string>; readonly offset: number } {
  const malFormado = (): LiSchemaError =>
    new LiSchemaError({ ...ctx, motivo: 'formato', campos: ['meta.next'] });

  if (next === '') throw malFormado();
  let url: URL;
  try {
    url = new URL(next, BASE_DESCARTAVEL);
  } catch (err) {
    if (err instanceof TypeError) throw malFormado();
    throw err;
  }

  const query = new Map<string, string>();
  for (const [k, v] of url.searchParams) {
    // A repeated key is ambiguous (which offset?), and our query shape cannot
    // carry a multi-value filter back. Fail loudly rather than pick one.
    if (query.has(k)) throw malFormado();
    query.set(k, v);
  }

  // ⚠️ Read from `next` ALONE, before the merge below: merged first, the
  // caller's own starting `offset` would fill the gap and a malformed `next`
  // would be followed instead of refused.
  const offset = lerOffset(query.get('offset'));
  if (offset === null) throw malFormado();

  // `offset` is in `query` by now, so the merge can never re-add the caller's.
  for (const [k, v] of original) if (!query.has(k)) query.set(k, v);

  return { query: Object.fromEntries(query), offset };
}

export async function* paginarLi<S extends z.ZodType>(
  cliente: LiLeituraClient,
  opts: OpcoesPaginacaoLi<S>,
): AsyncGenerator<PaginaLi<z.infer<S>>, void, undefined> {
  const { operacao, caminho, schemaLinha, sinal } = opts;
  const maxPaginas = opts.maxPaginas ?? MAX_PAGINAS_PADRAO;
  if (!Number.isSafeInteger(maxPaginas) || maxPaginas <= 0) {
    throw new LiConfigError('maxPaginas', { operacao, refCredencial: null });
  }

  const original: ReadonlyMap<string, string> = new Map(
    Object.entries(opts.query ?? {}).map(([k, v]) => [k, String(v)]),
  );
  const schema = liEnvelopeSchema(schemaLinha);

  let query: Record<string, string> = Object.fromEntries(original);
  // The offset THIS page is requested at: the caller's (0 when absent, Tastypie's
  // default), then each validated `next` offset. `null` when the caller's own
  // value is not plain digits — then only `meta.offset` can be compared.
  let offsetEnviado: number | null = original.has('offset') ? lerOffset(original.get('offset')) : 0;
  for (let numero = 1; ; numero++) {
    sinal?.throwIfAborted();
    const resposta = await cliente.get({ operacao, caminho, query, schema, sinal });
    const { meta } = resposta.dados;
    const objetos: z.infer<S>[] = resposta.dados.objects;
    yield { objetos, meta, correlationId: resposta.correlationId, numero };

    if (meta.next === null) return;

    const ctx = {
      operacao,
      caminho,
      correlationId: resposta.correlationId,
      refCredencial: resposta.refCredencial,
    };
    const proxima = proximaPagina(meta.next, original, { ...ctx, status: resposta.status });
    const naoAvanca =
      proxima.offset <= meta.offset || (offsetEnviado !== null && proxima.offset <= offsetEnviado);
    if (naoAvanca) {
      throw new LiPaginacaoError({ ...ctx, motivo: 'offset-nao-avanca', paginas: numero });
    }
    if (numero >= maxPaginas) {
      throw new LiPaginacaoError({ ...ctx, motivo: 'limite-de-paginas', paginas: numero });
    }
    query = proxima.query;
    offsetEnviado = proxima.offset;
  }
}
