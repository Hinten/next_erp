/**
 * The by-id PRICE read of master-plan step 13, over the GET-only client:
 *
 *  - {@link lerPrecosPorIdLi} — `GET /v1/produto_preco/set/{id;id;…}`, the
 *    prices of up to {@link MAX_IDS_SET_PRECO_LI} products in ONE call, each
 *    answer matched to the id asked for and classified;
 *  - {@link classificarSetPrecoLi} — that classification, pure;
 *  - {@link produtoIdDoPrecoLi} — the produto id a price row's `produto` URI
 *    names, or `null`. Pure;
 *  - {@link idsSetPrecoLi} and {@link caminhoSetPrecoLi} — the ids and the
 *    path, checked before anything is read or sent.
 *
 * The price WRITE is `precoEscrita.ts`, over the write client. The produto
 * detail a price write decides on is read through the write client's deciding
 * read with `liProdutoComPrecoDetalheSchema` (`types.ts`), never here.
 *
 * It only reads, parses and classifies: no retry, no halving, no decision.
 * Which ids a call names, what a failed call means and what a price row means
 * (already reflected, a candidate, held) are the caller's (`apps/loja-integrada`).
 *
 * ## What the store answers (measured)
 *
 * The owner's read-only price capture (2026-11-24, both stores) settled the
 * by-id read:
 *
 *  - asked with 10, 20, 50 and 100 ids, it answered EVERY id asked, in the
 *    order asked, with no repeat and no extra row. Above 100 ids was not asked,
 *    so 100 is the bound ({@link MAX_IDS_SET_PRECO_LI});
 *  - `objects` is the only root key: there is no `meta`;
 *  - `not_found` is ABSENT when every id came back; otherwise it is a JSON list
 *    of id STRINGS naming exactly the ids the store could not find (in the
 *    capture, an id that is no product, and a price row's own id);
 *  - a request mixing found and unknown ids is never refused whole;
 *  - parents and products in the trash are returned like any other;
 *  - 100 ids answer about 19 KB;
 *  - the path with and without a trailing slash answered the same bytes. The
 *    no-slash form is the one sent, as the public document keys it; the client
 *    never follows a redirect, so a form that stopped working would fail
 *    VISIBLY, a 3xx `LiHttpError`.
 *
 * ## Matched by the produto, never by place or row id
 *
 * Each row is matched to an asked id by the produto its `produto` URI names
 * ({@link produtoIdDoPrecoLi}). Never by the row's own `id` (it differed from
 * the produto id in every row captured) and never by its position (the rows
 * came back in request order, but nothing here relies on it).
 *
 * ## Never read as "no row"
 *
 * Only an id the answer lists in `not_found` is `nao-encontrado`. Each of the
 * following is reported apart, and none is ever read as "the store has no price
 * for it":
 *
 *  - an asked id the answer neither returns nor lists (`sem-resposta`);
 *  - a row the wire cannot read (`ilegivel`, with its field paths, never a
 *    value; `liPrecoProdutoLinhaSchema` judges each price leaf with the shared
 *    price fold);
 *  - an id answered twice: two rows, a row and a `not_found` entry, or two
 *    entries (`repetido`);
 *  - for the answer as a whole: a row or a `not_found` entry naming an id not
 *    asked (`naoPedidos`), a row naming no produto (`semProduto`) and a
 *    `not_found` element that is no id (`naoEncontradosIlegiveis`).
 *
 * One odd row or element costs only itself. But an answer that accounts for
 * NONE of the asked ids is no answer to this request (a rewritten path, another
 * endpoint): {@link lerPrecosPorIdLi} throws `LiSchemaError` (`formato`,
 * `campos: ['objects', 'not_found']`) for it, as the pager does for a `next`
 * that does not advance. A partial answer never throws.
 *
 * ## Failures, for the caller's halving rule
 *
 * Nothing here decides what a failure means; each is rethrown as the client
 * classifies it:
 *
 * | Outcome                                                    | Thrown                                     |
 * | ---------------------------------------------------------- | ------------------------------------------ |
 * | no id, more than the bound, one id twice                   | `LiConfigError('ids')`, nothing sent       |
 * | an id that is not a positive safe integer                  | `LiConfigError('caminho')`, nothing sent   |
 * | a 404                                                      | `LiNotFoundError`                          |
 * | a 3xx (never followed), a 400 or another 4xx               | `LiHttpError`, `transitorio: false`        |
 * | a 401 or a 403                                             | `LiAuthError`                              |
 * | a 429                                                      | `LiThrottleError`                          |
 * | a 5xx                                                      | `LiHttpError`, `transitorio: true`         |
 * | the deadline, a dropped connection                         | `LiTimeoutError`, `LiNetworkError`         |
 * | a malformed envelope, or an answer that accounts for none  | `LiSchemaError`                            |
 *
 * ## No list reader, no single-resource reader
 *
 *  - The price LIST (`GET /v1/produto_preco?limit&offset`) is never read. The
 *    owner's read-only price capture walked it to the end on both stores with
 *    every envelope check clean (the rows read equal to `total_count`), and
 *    still some rows came back on two pages while exactly as many never came
 *    back: an offset list ordered by a non-unique key, which a slower or
 *    repeated walk does not fix. This module imports neither pager.
 *  - The single resource (`GET /v1/produto_preco/{id}`) has no reader: a price
 *    write decides on the produto detail, whose prices the same capture found
 *    equal to the resource's on every leaf in every pair it read, and the
 *    nightly reads by id here. Nothing would consume one.
 *
 * ## Ids are checked before anything is built
 *
 * Every id goes through `idsDeCaminho.ts`, as every other path id does: a
 * positive safe integer, a number or its plain decimal text. They are sent in
 * the order given, never sorted, joined by `;` (the public document's
 * separator), and `id_externo` is never sent: it would make every id the
 * store's EXTERNAL id.
 */
import { camposInvalidos } from '@delfrance/core/wire';
import {
  idDoRecursoLi,
  inteiroPositivoCanonicoLi,
  MAX_IDS_SET_PRECO_LI,
  RECURSO_URI_LI,
} from '@delfrance/schemas';
import type { z } from 'zod';

import type { LiLeituraClient, RespostaLi } from './client';
import { LiConfigError, LiSchemaError } from './errors';
import { idOuRecusa } from './idsDeCaminho';
import type { OpcoesLeituraLi } from './pedidos';
import { liPrecoProdutoLinhaSchema, liSetPrecoSchema, type PrecoProdutoLinhaLi } from './types';

/**
 * The price resource: the by-id read is `${CAMINHO_PRECO_LI}/set/<id;id;…>`
 * and the price write `${CAMINHO_PRECO_LI}/<produto id>`. No trailing slash
 * (module header).
 */
export const CAMINHO_PRECO_LI = '/v1/produto_preco';

/**
 * The most ids one by-id read names, as measured (module header). It is
 * `@delfrance/schemas`' `MAX_IDS_SET_PRECO_LI`, re-exported here as the same
 * binding, never a copy: the nightly cursor's `lote` is held to it, so a batch
 * size a run stored is never one this reader refuses.
 */
export { MAX_IDS_SET_PRECO_LI };

/** The by-id read's operation, which names it in messages and events. */
const OPERACAO_SET_PRECO = 'lerPrecosPorId';

/**
 * The canonical decimal of each id, in the ORDER GIVEN (never sorted), or a
 * refusal naming `operacao`, before anything is read or sent:
 *
 *  - no id, or more than {@link MAX_IDS_SET_PRECO_LI} — `LiConfigError('ids')`;
 *  - an id that is not a positive safe integer (`'01'`, `'1.5'`, `0`, `2 ** 53`)
 *    — `LiConfigError('caminho')`, through the shared path-id reader;
 *  - one id twice, in any spelling (`1001` and `'1001'`) — `LiConfigError('ids')`.
 */
export function idsSetPrecoLi(
  ids: readonly (number | string)[],
  operacao: string = OPERACAO_SET_PRECO,
): readonly string[] {
  if (ids.length < 1 || ids.length > MAX_IDS_SET_PRECO_LI) {
    throw new LiConfigError('ids', { operacao, refCredencial: null });
  }
  const canonicos = ids.map((id) => idOuRecusa(id, operacao));
  if (new Set(canonicos).size !== canonicos.length) {
    throw new LiConfigError('ids', { operacao, refCredencial: null });
  }
  return canonicos;
}

/** The path of ids already checked: `;`-joined, no trailing slash, no query. */
function caminhoDosIds(canonicos: readonly string[]): string {
  return `${CAMINHO_PRECO_LI}/set/${canonicos.join(';')}`;
}

/**
 * `/v1/produto_preco/set/<id;id;…>` for `ids` ({@link idsSetPrecoLi}: checked,
 * canonical, in the order given), with no trailing slash and no query.
 */
export function caminhoSetPrecoLi(
  ids: readonly (number | string)[],
  operacao: string = OPERACAO_SET_PRECO,
): string {
  return caminhoDosIds(idsSetPrecoLi(ids, operacao));
}

/**
 * The produto id a price row's `produto` names, or `null` when it names none:
 * the shared resource-URI reader (`idDoRecursoLi`, `@delfrance/schemas`) bound
 * to `produto`, verbatim, as the stock rows are read.
 *
 * Equal (⇒ `1001`): `/api/v1/produto/1001` ≡ `/api/v1/produto/1001/` ≡
 * `/v1/produto/1001`. Distinct (⇒ `null`): a query (`?id_externo=1`, the
 * public document's own example, which makes the id the store's EXTERNAL id),
 * the row's own `resource_uri` (`/api/v1/produto_preco/1001`), a leading zero,
 * `''`, and anything that is not a string (the number `1001` included).
 */
export function produtoIdDoPrecoLi(produto: unknown): number | null {
  return idDoRecursoLi(produto, RECURSO_URI_LI.produto);
}

/** What the answer says about ONE asked id (module header, "Never read as no row"). */
export type ResultadoIdPrecoLi =
  /** Exactly one row named it, and the row read. */
  | { readonly tipo: 'linha'; readonly linha: PrecoProdutoLinhaLi }
  /** Exactly one `not_found` entry named it, and no row did. */
  | { readonly tipo: 'nao-encontrado' }
  /** Exactly one row named it, and the row schema refused it: field paths only. */
  | { readonly tipo: 'ilegivel'; readonly campos: readonly string[] }
  /** It was named more than once: how many rows (readable or not) and `not_found` entries. */
  | { readonly tipo: 'repetido'; readonly linhas: number; readonly naoEncontrado: number }
  /** Nothing in the answer named it. */
  | { readonly tipo: 'sem-resposta' };

/** One by-id answer, classified ({@link classificarSetPrecoLi}). */
export interface LeituraSetPrecoLi {
  /** Every asked id exactly once, in the order asked. */
  readonly resultados: readonly { readonly id: string; readonly resultado: ResultadoIdPrecoLi }[];
  /** How many asked ids the answer named at all: every result but `sem-resposta`. */
  readonly contabilizados: number;
  /** A row (`linha`) or a `not_found` entry naming an id that was not asked, by position. */
  readonly naoPedidos: readonly {
    readonly origem: 'linha' | 'nao-encontrado';
    readonly indice: number;
    readonly id: string;
  }[];
  /** A row that names no produto: its position in `objects` and why, as field paths. */
  readonly semProduto: readonly { readonly indice: number; readonly campos: readonly string[] }[];
  /** The positions in `not_found` of the elements that are no positive safe integer. */
  readonly naoEncontradosIlegiveis: readonly number[];
}

/** One mention of an asked id in the answer. */
type MencaoLi =
  | { readonly tipo: 'linha'; readonly linha: PrecoProdutoLinhaLi }
  | { readonly tipo: 'ilegivel'; readonly campos: readonly string[] }
  | { readonly tipo: 'nao-encontrado' };

/** The raw `produto` leaf of a row, or `undefined` when it has none. */
function produtoDaLinhaBruta(bruta: unknown): unknown {
  return typeof bruta === 'object' && bruta !== null && 'produto' in bruta
    ? bruta.produto
    : undefined;
}

/**
 * Why a row names no produto, as field paths: `produto` first for a row that
 * is an object (its leaf is absent, of another type, or names no produto),
 * then whatever else the row schema refused; `(raiz)` for a row that is not an
 * object at all.
 */
function camposSemProduto(
  bruta: unknown,
  lida: z.ZodSafeParseResult<PrecoProdutoLinhaLi>,
): readonly string[] {
  if (lida.success) return ['produto'];
  const campos = camposInvalidos(lida.error.issues);
  const ehObjeto = typeof bruta === 'object' && bruta !== null && !Array.isArray(bruta);
  return ehObjeto && !campos.includes('produto') ? ['produto', ...campos] : campos;
}

/** One asked id's result, from every mention of it. */
function resultadoDasMencoes(mencoes: readonly MencaoLi[]): ResultadoIdPrecoLi {
  const [unica] = mencoes;
  if (unica === undefined) return { tipo: 'sem-resposta' };
  if (mencoes.length > 1) {
    const naoEncontrado = mencoes.filter((m) => m.tipo === 'nao-encontrado').length;
    return { tipo: 'repetido', linhas: mencoes.length - naoEncontrado, naoEncontrado };
  }
  return unica;
}

/**
 * Classify one by-id answer against the ids asked (module header). PURE.
 *
 * `pedidos` are the ids the call named, as {@link idsSetPrecoLi} returned them
 * (canonical, each once); `corpo` is the envelope `liSetPrecoSchema` read. Each
 * row is read on its own through `liPrecoProdutoLinhaSchema` and matched by the
 * produto it names; each `not_found` element is read by the shared positive-id
 * reader (`inteiroPositivoCanonicoLi`, so `1001` ≡ `'1001'`, while `'01001'` and
 * `1.5` are no id). Then every asked id gets exactly one result, in the order
 * asked: none named it ⇒ `sem-resposta`; more than one mention ⇒ `repetido`;
 * one `not_found` entry ⇒ `nao-encontrado`; one row ⇒ `linha` when it read,
 * else `ilegivel`.
 *
 * Throws `RangeError` when `pedidos` is not a list of distinct canonical ids (a
 * bug: the reader builds it with {@link idsSetPrecoLi}).
 */
export function classificarSetPrecoLi(
  pedidos: readonly string[],
  corpo: { readonly objects: readonly unknown[]; readonly not_found: readonly unknown[] },
): LeituraSetPrecoLi {
  const mencoes = new Map<string, MencaoLi[]>();
  for (const id of pedidos) {
    if (inteiroPositivoCanonicoLi(id) !== id || mencoes.has(id)) {
      throw new RangeError('classificarSetPrecoLi: ids pedidos fora da forma (canônicos e únicos)');
    }
    mencoes.set(id, []);
  }
  const naoPedidos: LeituraSetPrecoLi['naoPedidos'][number][] = [];
  const semProduto: LeituraSetPrecoLi['semProduto'][number][] = [];
  const naoEncontradosIlegiveis: number[] = [];

  for (const [indice, bruta] of corpo.objects.entries()) {
    const lida = liPrecoProdutoLinhaSchema.safeParse(bruta);
    const produtoId = produtoIdDoPrecoLi(produtoDaLinhaBruta(bruta));
    if (produtoId === null) {
      semProduto.push({ indice, campos: camposSemProduto(bruta, lida) });
      continue;
    }
    const id = String(produtoId);
    const doId = mencoes.get(id);
    if (doId === undefined) {
      naoPedidos.push({ origem: 'linha', indice, id });
      continue;
    }
    doId.push(
      lida.success
        ? { tipo: 'linha', linha: lida.data }
        : { tipo: 'ilegivel', campos: camposInvalidos(lida.error.issues) },
    );
  }

  for (const [indice, bruto] of corpo.not_found.entries()) {
    const id = inteiroPositivoCanonicoLi(bruto);
    if (id === null) {
      naoEncontradosIlegiveis.push(indice);
      continue;
    }
    const doId = mencoes.get(id);
    if (doId === undefined) {
      naoPedidos.push({ origem: 'nao-encontrado', indice, id });
      continue;
    }
    doId.push({ tipo: 'nao-encontrado' });
  }

  const resultados = pedidos.map((id) => ({
    id,
    resultado: resultadoDasMencoes(mencoes.get(id) ?? []),
  }));
  return {
    resultados,
    contabilizados: resultados.filter((r) => r.resultado.tipo !== 'sem-resposta').length,
    naoPedidos,
    semProduto,
    naoEncontradosIlegiveis,
  };
}

/**
 * `GET /v1/produto_preco/set/<id;id;…>` for `ids`, with no query, parsed by
 * `liSetPrecoSchema` and classified by {@link classificarSetPrecoLi}: every
 * asked id gets exactly one result, in the order given.
 *
 * Refused before anything is read or sent: the ids ({@link idsSetPrecoLi}), an
 * already-aborted `sinal` (its reason). After the answer: an answer that
 * accounts for none of the asked ids throws `LiSchemaError` (`formato`,
 * `campos: ['objects', 'not_found']`); every other failure is the client's,
 * rethrown as-is (module header, the failure table).
 *
 * `async` on purpose: a refused id list rejects the promise like every other
 * failure, rather than throwing before the caller holds one.
 */
export async function lerPrecosPorIdLi(
  cliente: LiLeituraClient,
  ids: readonly (number | string)[],
  opts: OpcoesLeituraLi = {},
): Promise<RespostaLi<LeituraSetPrecoLi>> {
  const operacao = OPERACAO_SET_PRECO;
  const pedidos = idsSetPrecoLi(ids, operacao);
  opts.sinal?.throwIfAborted();
  const caminho = caminhoDosIds(pedidos);
  const resposta = await cliente.get({
    operacao,
    caminho,
    schema: liSetPrecoSchema,
    sinal: opts.sinal,
  });
  const dados = classificarSetPrecoLi(pedidos, resposta.dados);
  if (dados.contabilizados === 0) {
    throw new LiSchemaError({
      operacao,
      caminho,
      correlationId: resposta.correlationId,
      refCredencial: resposta.refCredencial,
      metodo: 'GET',
      status: resposta.status,
      motivo: 'formato',
      campos: ['objects', 'not_found'],
    });
  }
  return {
    dados,
    status: resposta.status,
    correlationId: resposta.correlationId,
    refCredencial: resposta.refCredencial,
  };
}
