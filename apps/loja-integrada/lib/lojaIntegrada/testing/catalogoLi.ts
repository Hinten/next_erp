/**
 * Synthetic Loja Integrada CATALOGUE pages and a scripted platform, **for tests only** (the
 * `fakeDb.ts` rule: nothing outside a `*.test.ts` imports this) — shared by the catalogue core's
 * suite (`catalogo/catalogo.test.ts`) and the four catalogue route suites.
 *
 * Every value is invented, in the shape the sanitized captures show (`/v1/categoria/<id>` parents,
 * `/api/v1/grades/<g>` option grades). Nothing here comes from a capture, and nothing reaches the
 * network: the platform is a `fetch` the test hands the context's client or stubs globally (D17).
 */
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';

import type { DocData } from './fakeDb';

/** What the scripted platform answers for one request: a status and a JSON body. */
export interface RespostaCatalogoLi {
  readonly status: number;
  readonly corpo: unknown;
}

/** One request the scripted platform received. */
export interface ChamadaCatalogoLi {
  /** The path under the base, as sent (the trailing slash kept). */
  readonly caminho: string;
  /** The query, as sent, in order. */
  readonly query: readonly (readonly [string, string])[];
}

/**
 * A scripted Loja Integrada answering `responder(chamada)` for every request on the base URL, and
 * 500 for any other origin. Every request is recorded; the responder may be async (a test can
 * hold a request open, or change the stored credential while it is in flight).
 */
export function plataformaCatalogoLi(
  responder: (chamada: ChamadaCatalogoLi) => RespostaCatalogoLi | Promise<RespostaCatalogoLi>,
): { readonly fetch: typeof globalThis.fetch; readonly chamadas: ChamadaCatalogoLi[] } {
  const chamadas: ChamadaCatalogoLi[] = [];
  const base = new URL(URL_BASE_LI);
  const fetch: typeof globalThis.fetch = async (input) => {
    const texto = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(texto);
    if (url.origin !== base.origin) return json({ status: 500, corpo: { erro: 'origem' } });
    const chamada: ChamadaCatalogoLi = { caminho: url.pathname, query: [...url.searchParams] };
    chamadas.push(chamada);
    return json(await responder(chamada));
  };
  return { fetch, chamadas };
}

/** A JSON `Response`. */
export function json(r: RespostaCatalogoLi): Response {
  return new Response(JSON.stringify(r.corpo), {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A 200 answer. */
export function ok(corpo: unknown): RespostaCatalogoLi {
  return { status: 200, corpo };
}

/**
 * One Tastypie page of `objetos` at `offset`, of a list holding `total` rows: `next` names the
 * following offset (in the captured relative `/api/v1/…` form) while rows remain.
 */
export function paginaCatalogoLi(
  recurso: string,
  objetos: readonly DocData[],
  opts: { readonly offset?: number; readonly limite?: number; readonly total?: number } = {},
): RespostaCatalogoLi {
  const offset = opts.offset ?? 0;
  const limite = opts.limite ?? 50;
  const total = opts.total ?? offset + objetos.length;
  const proximo = offset + limite;
  return ok({
    meta: {
      limit: limite,
      offset,
      total_count: total,
      previous: offset === 0 ? null : `/api/v1/${recurso}?limit=${String(limite)}&offset=0`,
      next:
        proximo < total
          ? `/api/v1/${recurso}?limit=${String(limite)}&offset=${String(proximo)}`
          : null,
    },
    objects: objetos,
  });
}

/** The offset a request asked for (0 when it named none). */
export function offsetDe(chamada: ChamadaCatalogoLi): number {
  const bruto = chamada.query.find(([k]) => k === 'offset')?.[1];
  return bruto === undefined ? 0 : Number(bruto);
}

/** A category row; `pai` is the raw `categoria_pai`. */
export function categoriaLi(id: number, pai: unknown = null): DocData {
  return {
    id,
    id_externo: null,
    categoria_pai: pai,
    nome: `Categoria ${String(id)}`,
    resource_uri: `/v1/categoria/${String(id)}`,
  };
}

/** A brand row. */
export function marcaLi(id: number, ativo: unknown = true): DocData {
  return {
    id,
    ativo,
    nome: `Marca ${String(id)}`,
    resource_uri: `/api/v1/marca/${String(id)}`,
  };
}

/** A grade row of the list. */
export function gradeLi(id: number, nomeVisivel: unknown = ''): DocData {
  return {
    id,
    nome: `Grade ${String(id)}`,
    nome_visivel: nomeVisivel,
    resource_uri: `/api/v1/grades/${String(id)}`,
  };
}

/** A grade detail with one option per id in `opcoes`, each naming `gradeDasOpcoes` (default: itself). */
export function detalheGradeLi(
  id: number,
  opcoes: readonly number[],
  gradeDasOpcoes: unknown = `/api/v1/grades/${String(id)}`,
): DocData {
  return {
    ...gradeLi(id),
    variacoes: opcoes.map((o) => ({
      id: o,
      nome: `Opção ${String(o)}`,
      grade: gradeDasOpcoes,
      resource_uri: `/api/v1/grade/${String(id)}/variacao/${String(o)}`,
    })),
  };
}
