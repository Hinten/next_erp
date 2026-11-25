/**
 * INVENTED Loja Integrada PRICE answers and a scripted store, **for tests only** (the `fakeDb.ts`
 * rule: nothing outside a `*.test.ts` imports this) — master plan step 13.
 *
 * ⚠️ Every value here is invented, and no real store data is used, by the owner's decision: the
 * owner's read-only price captures are not committed, and nothing here was copied or derived from one —
 * no id, price, count, size, date or ratio. The answers keep only the SHAPE those captures showed,
 * as the wire package's own docs state it: a `set/` answer is `objects` (no `meta`), plus a root
 * `not_found` list of id STRINGS only when an asked id came back with no row; a price row has
 * exactly seven keys, its amounts four-decimal text or `null`, and its own `id` is never the
 * produto id its `produto` and `resource_uri` name; the produto detail carries the same prices as
 * JSON numbers; a 404 has no body at all.
 *
 * Ids are small and obviously synthetic: produtos from 1000 (1000 is a parent), a price row's own
 * id is its produto id + 8000 (9001 for produto 1001), and 9999 is no product. Prices are
 * repeated-digit amounts ('11.1100'), plus a sequential-digit custo ('12.3400') and a one-centavo
 * promotion ('0.0100'), all plainly invented. Nothing reaches the network:
 * the store is a `fetch` the test hands a client.
 */
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import { TIPO_PRODUTO_LI } from '@delfrance/schemas';

/* -------------------------------------------------------------------------- */
/*                                   Ids                                      */
/* -------------------------------------------------------------------------- */

/** The invented parent every invented variation names in its `pai`. */
export const ID_PAI_PRECO_LI = 1000;

/** An id that is no product of the invented store (and no price row's own id either). */
export const ID_SEM_PRODUTO_PRECO_LI = 9999;

/** A price row's OWN id: never the produto id it names (9001 for produto 1001). */
export const idDaLinhaDePrecoLi = (produtoId: number): number => produtoId + 8000;

/** A produto's resource URI, as a price row's `produto` and a detail's `pai` carry it. */
export const uriProdutoPrecoLi = (id: number): string => `/api/v1/produto/${String(id)}`;

/** A price row's `resource_uri`: it names the PRODUTO id, never the row's own. */
export const uriLinhaPrecoLi = (produtoId: number): string =>
  `/api/v1/produto_preco/${String(produtoId)}`;

/* -------------------------------------------------------------------------- */
/*                                 Price rows                                  */
/* -------------------------------------------------------------------------- */

/** An invented price row, exactly the seven keys of the captured shape. */
export interface LinhaPrecoInventadaLi {
  readonly cheio: string | null;
  readonly custo: string | null;
  readonly id: number;
  readonly produto: string;
  readonly promocional: string | null;
  readonly resource_uri: string;
  readonly sob_consulta: boolean;
}

/** The price row of `produtoId`, with `over` replacing any of its leaves. */
export function linhaPrecoLi(
  produtoId: number,
  over: Partial<LinhaPrecoInventadaLi> = {},
): LinhaPrecoInventadaLi {
  return {
    cheio: '11.1100',
    custo: null,
    id: idDaLinhaDePrecoLi(produtoId),
    produto: uriProdutoPrecoLi(produtoId),
    promocional: null,
    resource_uri: uriLinhaPrecoLi(produtoId),
    sob_consulta: false,
    ...over,
  };
}

/** A `set/` answer: `objects`, and a root `not_found` only when one is given. */
export interface RespostaSetPrecoInventadaLi {
  readonly objects: readonly unknown[];
  readonly not_found?: readonly string[];
}

/** A `set/` answer holding `objects`, plus `not_found` when `notFound` is given. */
export function respostaSetPrecoLi(
  objects: readonly unknown[],
  notFound?: readonly string[],
): RespostaSetPrecoInventadaLi {
  return notFound === undefined ? { objects } : { objects, not_found: notFound };
}

/** The 100 ids of a complete answer (the by-id read's public bound): 1001 … 1100, in order. */
export const IDS_SET_COMPLETO_PRECO_LI: readonly number[] = Array.from(
  { length: 100 },
  (_, i) => 1001 + i,
);

/**
 * A complete answer to {@link IDS_SET_COMPLETO_PRECO_LI}: one row per id in request order, no
 * `not_found`. Row `i` cycles plainly — `cheio` `'11.1100'`/`'22.2200'`, `promocional` `null`/
 * `'0.0000'`/`'5.5500'`, `custo` `null`/`'4.4400'` — deliberately with no measured share.
 */
export function respostaSetCompletaPrecoLi(): RespostaSetPrecoInventadaLi {
  const promocionais = [null, '0.0000', '5.5500'] as const;
  return respostaSetPrecoLi(
    IDS_SET_COMPLETO_PRECO_LI.map((id, i) =>
      linhaPrecoLi(id, {
        cheio: i % 2 === 0 ? '11.1100' : '22.2200',
        promocional: promocionais[i % 3] ?? null,
        custo: i % 2 === 0 ? null : '4.4400',
      }),
    ),
  );
}

/**
 * The mixed set, in request order: a variation (1001), the parent, produto 1001's price row's OWN
 * id (9001), another variation (1002), a product in the trash (1050) and no product (9999).
 */
export const IDS_SET_MISTO_PRECO_LI: readonly number[] = [
  1001,
  ID_PAI_PRECO_LI,
  idDaLinhaDePrecoLi(1001),
  1002,
  1050,
  ID_SEM_PRODUTO_PRECO_LI,
];

/**
 * The answer to {@link IDS_SET_MISTO_PRECO_LI}: the rows of 1001, 1000, 1002 and 1050 in request
 * order (1050's promotion the zero spelling), and the two ids with no row in `not_found`, as
 * STRINGS, in request order. Never refused whole: the parent and the trashed product come back
 * like any other.
 */
export function respostaSetMistaPrecoLi(): RespostaSetPrecoInventadaLi {
  return respostaSetPrecoLi(
    [
      linhaPrecoLi(1001),
      linhaPrecoLi(ID_PAI_PRECO_LI),
      linhaPrecoLi(1002),
      linhaPrecoLi(1050, { promocional: '0.0000' }),
    ],
    [String(idDaLinhaDePrecoLi(1001)), String(ID_SEM_PRODUTO_PRECO_LI)],
  );
}

/* -------------------------------------------------------------------------- */
/*                      The produto detail, and its pairs                      */
/* -------------------------------------------------------------------------- */

/** The detail's three price amounts, as JSON numbers or `null`. */
export interface PrecosDetalheInventadoLi {
  readonly preco_cheio: number | null;
  readonly preco_promocional: number | null;
  readonly preco_custo: number | null;
}

/**
 * An invented produto detail (`GET /v1/produto/<id>/`) as a price write decides on it: a live,
 * unblocked variation of {@link ID_PAI_PRECO_LI}, its prices JSON numbers.
 */
export function detalhePrecoLi(produtoId: number, precos: PrecosDetalheInventadoLi) {
  return {
    id: produtoId,
    tipo: TIPO_PRODUTO_LI.atributoOpcao,
    ativo: true,
    bloqueado: false,
    removido: false,
    preco_cheio: precos.preco_cheio,
    preco_promocional: precos.preco_promocional,
    preco_custo: precos.preco_custo,
    preco_sob_consulta: false,
    pai: uriProdutoPrecoLi(ID_PAI_PRECO_LI),
    resource_uri: uriProdutoPrecoLi(produtoId),
    sku: `SKU-INVENTADO-${String(produtoId)}`,
  };
}

/** The promotion classes a detail and its price row are paired under. */
export type ClassePrecoInventadaLi = 'sem-promocao' | 'promocao-zero' | 'promocao-abaixo';

/** One invented produto, as its detail and as its price row: the same prices in both spellings. */
export interface ParDetalhePrecoLi {
  readonly classe: ClassePrecoInventadaLi;
  readonly produtoId: number;
  readonly detalhe: ReturnType<typeof detalhePrecoLi>;
  readonly linha: LinhaPrecoInventadaLi;
}

/**
 * One invented pair per promotion class: no promotion (`null` on both sides), the zero promotion
 * (JSON `0` in the detail, `'0.0000'` in the row) and a promotion below the full price.
 */
export const PARES_DETALHE_PRECO_LI: readonly ParDetalhePrecoLi[] = [
  {
    classe: 'sem-promocao',
    produtoId: 1101,
    detalhe: detalhePrecoLi(1101, {
      preco_cheio: 33.33,
      preco_promocional: null,
      preco_custo: null,
    }),
    linha: linhaPrecoLi(1101, { cheio: '33.3300', promocional: null, custo: null }),
  },
  {
    classe: 'promocao-zero',
    produtoId: 1102,
    detalhe: detalhePrecoLi(1102, { preco_cheio: 44.44, preco_promocional: 0, preco_custo: 11.11 }),
    linha: linhaPrecoLi(1102, { cheio: '44.4400', promocional: '0.0000', custo: '11.1100' }),
  },
  {
    classe: 'promocao-abaixo',
    produtoId: 1103,
    detalhe: detalhePrecoLi(1103, {
      preco_cheio: 55.55,
      preco_promocional: 22.22,
      preco_custo: 12.34,
    }),
    linha: linhaPrecoLi(1103, { cheio: '55.5500', promocional: '22.2200', custo: '12.3400' }),
  },
];

/**
 * Three spellings of a promotion beside the same full price: none (`null`), the zero text the
 * store uses, and one centavo — which is a price, not a clear.
 */
export const LINHAS_LIMPEZA_PRECO_LI: readonly LinhaPrecoInventadaLi[] = [
  linhaPrecoLi(1201, { cheio: '66.6600', promocional: null }),
  linhaPrecoLi(1202, { cheio: '66.6600', promocional: '0.0000' }),
  linhaPrecoLi(1203, { cheio: '66.6600', promocional: '0.0100' }),
];

/* -------------------------------------------------------------------------- */
/*                              The scripted store                             */
/* -------------------------------------------------------------------------- */

/** One scripted answer: a status and a JSON body, or a status with NO body at all. */
export type RespostaPrecoLi =
  | { readonly status: number; readonly corpo: unknown }
  | { readonly status: number; readonly semCorpo: true };

/** One request the scripted store received, matched or not. */
export interface ChamadaPrecoLi {
  readonly metodo: string | undefined;
  /** The path under the origin, exactly as sent (a trailing slash kept). */
  readonly caminho: string;
  /** The raw query (`''` when none, else with its `?`). */
  readonly consulta: string;
  readonly comCorpo: boolean;
}

/** The scripted store: the `fetch` a test hands a client, and what it saw. */
export interface PlataformaPrecoLi {
  readonly fetch: typeof globalThis.fetch;
  readonly chamadas: ChamadaPrecoLi[];
  /** How many times each scripted path was answered. */
  readonly consumidas: Map<string, number>;
  /** How many requests matched no scripted answer (each got a 500). */
  readonly semResposta: () => number;
}

function respostaDe(r: RespostaPrecoLi): Response {
  if ('semCorpo' in r) return new Response(null, { status: r.status });
  return new Response(JSON.stringify(r.corpo), {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A scripted store that answers ONLY the exact requests it was given: the origin of
 * `URL_BASE_LI`, an explicit `GET`, no body, no query, and a path that is exactly a key of
 * `respostas` — no slash folded, no `;` decoded. Anything else is recorded and answered 500 with
 * `'{}'`, so a request the package should not build fails loudly instead of being served.
 */
export function plataformaPrecoLi(
  respostas: Readonly<Record<string, RespostaPrecoLi>>,
): PlataformaPrecoLi {
  const porCaminho = new Map(Object.entries(respostas));
  const base = new URL(URL_BASE_LI);
  const chamadas: ChamadaPrecoLi[] = [];
  const consumidas = new Map<string, number>();
  let semResposta = 0;
  const responder: typeof globalThis.fetch = (entrada, init) => {
    const texto =
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const url = new URL(texto);
    const chamada: ChamadaPrecoLi = {
      metodo: init?.method,
      caminho: url.pathname,
      consulta: url.search,
      comCorpo: init?.body !== undefined,
    };
    chamadas.push(chamada);
    const resposta = porCaminho.get(url.pathname);
    const exata =
      url.origin === base.origin &&
      chamada.metodo === 'GET' &&
      !chamada.comCorpo &&
      chamada.consulta === '';
    if (!exata || resposta === undefined) {
      semResposta += 1;
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    consumidas.set(url.pathname, (consumidas.get(url.pathname) ?? 0) + 1);
    return Promise.resolve(respostaDe(resposta));
  };
  return { fetch: responder, chamadas, consumidas, semResposta: () => semResposta };
}
