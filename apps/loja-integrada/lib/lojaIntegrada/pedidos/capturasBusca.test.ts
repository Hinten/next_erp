/**
 * Capture C1 — the owner's `GET /v1/pedido/search/` captures (step 3) — read
 * through the poller's OWN row schema, stamp reader, window checks and paging.
 *
 * The row schema (`liPedidoBuscaLinhaSchema`) was written from the public
 * document's two example rows. These captures are what confirm it, and this
 * file is what keeps it confirmed:
 *
 *  - every row of every `pedido-search-*` fixture passes the row schema, and its
 *    `data_modificacao` is ALREADY a canonical stamp (six fraction digits, no
 *    zone): `lerDataLi` returns it unchanged;
 *  - `meta` carries what the poller reads: `limit` (the requested one, the
 *    poller's 50 included, read back and not capped), `offset`, `total_count` on
 *    every page, and `next` as a relative `/api/v1/…` link that `paginarLi`
 *    follows on the poller's own path, keeping the filter;
 *  - the filter is applied: no row of the filtered search sits below the bound
 *    the request used (so `filtroIgnoradoLi` never fires), a row CREATED before
 *    the bound is still listed (the filter is on the modification stamp), and
 *    the unfiltered search announces a larger `total_count`;
 *  - the literal-colon and `%3A` forms of `since_atualizado` answer the same
 *    search, and the `%3A` capture is byte for byte the query the poller sends;
 *  - the rows come ordered by `numero`, NOT by `data_modificacao`. The poller
 *    deliberately assumes no order (its cursor is the max stamp over the whole
 *    drain, `proximoCursorLi`), and the last assertion here pins why it must not.
 *
 * ⚠️ Every assertion is a boolean or a count, labelled with the fixture name and
 * a row INDEX, so a failure never prints a body value (the `wireCorpus.test.ts`
 * convention). Fixtures are read only through the corpus loader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  criarClienteLeituraLi,
  liEnvelopeSchema,
  liPedidoBuscaLinhaSchema,
  paginarLi,
  type PaginaLi,
  type PedidoBuscaLinhaLi,
} from '@delfrance/integrations-loja-integrada';
import { CURSOR_POLL_LI_REGEX } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DIRETORIO_WIRE_LI,
  type EnvelopeFixtureLi,
  lerFixtureLi,
  listarArquivosDoCorpusLi,
} from '../fixtures/wireCorpus';
import { canonicaDoCursorLi, lerDataLi } from './dataLi';
import {
  CAMINHO_BUSCA_PEDIDOS_LI,
  LIMITE_PEDIDOS_LI,
  OPERACAO_POLL_PEDIDOS_LI,
  consistenciaDaJanelaLi,
  filtroIgnoradoLi,
  janelaGrandeDemaisLi,
  limiteDeToleranciaLi,
} from './janelaPoll';
import { MAX_PAGINAS_POLL } from './orcamentoPoll';

/** Every search capture in the corpus, sorted as the loader lists them. */
const BUSCAS = [
  'pedido-search-50.json',
  'pedido-search-dois-pontos.json',
  'pedido-search-futuro.json',
  'pedido-search-sem-filtro.json',
] as const;
type Busca = (typeof BUSCAS)[number];

/**
 * The rows across {@link BUSCAS}: the observed count, so a row that disappears
 * fails here instead of silently shrinking what the per-row checks cover (the
 * `MINIMO_DE_FIXTURES` convention).
 */
const MINIMO_DE_LINHAS = 26;

/** The page the poller decodes (`paginarLi` parses every page with it). */
const paginaDaBusca = liEnvelopeSchema(liPedidoBuscaLinhaSchema);

/** The body's rows as they are on disk, before any schema touched them. */
const corpoBruto = z.object({ objects: z.array(z.unknown()) }).passthrough();

/** A credential for the fake platform below; it never leaves this file. */
const CREDENCIAL_DE_TESTE = { token: 'token-de-teste', ref: 'conta-de-teste' } as const;

/** A search capture, through the corpus loader. */
function captura(nome: Busca): EnvelopeFixtureLi {
  if (!listarArquivosDoCorpusLi().includes(nome)) {
    throw new Error(`${nome}: missing from the corpus`);
  }
  const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, nome), 'utf8'));
  // ⚠️ Never print a failed reading: its `nao-json` arm carries the raw text.
  if (!leitura.ok) throw new Error(`${nome}: not a valid fixture envelope`);
  return leitura.data;
}

/** The capture's body as the poller decodes it. */
function pagina(nome: Busca): z.infer<typeof paginaDaBusca> {
  const r = paginaDaBusca.safeParse(captura(nome).resposta.corpo);
  // The Zod error is never printed: it can quote the value it refused.
  if (!r.success) throw new Error(`${nome}: the body fails the poller's page schema`);
  return r.data;
}

/** The capture's raw query value for `chave`, as sent (literal colon or `%3A`). */
function valorBruto(e: EnvelopeFixtureLi, chave: string): string | undefined {
  return e.requisicao.query.find(([k]) => k === chave)?.[1];
}

/** The decoded `since_atualizado` the capture's request used: a cursor. */
function sinceDaCaptura(nome: Busca): string {
  const bruto = valorBruto(captura(nome), 'since_atualizado');
  if (bruto === undefined) throw new Error(`${nome}: no since_atualizado in the request`);
  const since = decodeURIComponent(bruto);
  if (!CURSOR_POLL_LI_REGEX.test(since)) throw new Error(`${nome}: the bound is not a cursor`);
  return since;
}

/** The capture's request query, decoded, as `paginarLi` takes it. */
function queryDaCaptura(nome: Busca): Record<string, string> {
  return Object.fromEntries(
    captura(nome).requisicao.query.map(([k, v]) => [k, decodeURIComponent(v)] as const),
  );
}

/**
 * The poller's paging over the REAL client, against a fake platform answering
 * `paginas` in order. Returns every URL requested and every page yielded.
 */
async function lerPeloPoller(
  paginas: readonly unknown[],
  query: Readonly<Record<string, string | number>>,
): Promise<{ urls: URL[]; lidas: PaginaLi<PedidoBuscaLinhaLi>[] }> {
  const urls: URL[] = [];
  const fetch: typeof globalThis.fetch = (input) => {
    urls.push(new URL(String(input)));
    const corpo = paginas[urls.length - 1];
    if (corpo === undefined) throw new Error('teste: the fake platform has no such page');
    return Promise.resolve(
      new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const cliente = criarClienteLeituraLi({ obterCredencial: () => CREDENCIAL_DE_TESTE, fetch });
  const lidas: PaginaLi<PedidoBuscaLinhaLi>[] = [];
  for await (const p of paginarLi(cliente, {
    operacao: OPERACAO_POLL_PEDIDOS_LI,
    caminho: CAMINHO_BUSCA_PEDIDOS_LI,
    query,
    schemaLinha: liPedidoBuscaLinhaSchema,
    maxPaginas: MAX_PAGINAS_POLL,
  })) {
    lidas.push(p);
  }
  return { urls, lidas };
}

const mesmoConjunto = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** Whether every adjacent pair of `xs` satisfies `ok(anterior, atual)`. */
function paresAdjacentes<T>(xs: readonly T[], ok: (anterior: T, atual: T) => boolean): boolean {
  for (let i = 1; i < xs.length; i++) {
    const anterior = xs[i - 1];
    const atual = xs[i];
    if (anterior === undefined || atual === undefined || !ok(anterior, atual)) return false;
  }
  return true;
}

describe('capture C1: the search captures', () => {
  it('are all in the corpus, and each is the GET the poller makes, answered 200', () => {
    expect(listarArquivosDoCorpusLi().filter((a) => a.startsWith('pedido-search-'))).toEqual([
      ...BUSCAS,
    ]);
    for (const nome of BUSCAS) {
      const e = captura(nome);
      expect(e.requisicao.metodo === 'GET', `${nome} metodo`).toBe(true);
      expect(e.requisicao.caminho === CAMINHO_BUSCA_PEDIDOS_LI, `${nome} caminho`).toBe(true);
      expect(e.resposta.status === 200 && e.resposta.forma === 'json', `${nome} status`).toBe(true);
      expect(e.credencial === 'personal-token', `${nome} credencial`).toBe(true);
    }
  });

  it("every row passes the poller's row schema, and its data_modificacao is a canonical stamp", () => {
    let linhas = 0;
    for (const nome of BUSCAS) {
      expect(paginaDaBusca.safeParse(captura(nome).resposta.corpo).success, nome).toBe(true);
      const brutas = corpoBruto.safeParse(captura(nome).resposta.corpo);
      if (!brutas.success) throw new Error(`${nome}: no objects array`);
      brutas.data.objects.forEach((bruta, i) => {
        const rotulo = `${nome} objects[${String(i)}]`;
        const r = liPedidoBuscaLinhaSchema.safeParse(bruta);
        expect(r.success, `${rotulo} schema`).toBe(true);
        if (!r.success) return;
        const carimbo = lerDataLi(r.data.data_modificacao);
        expect(carimbo !== null && carimbo.length === 26, `${rotulo} canonical`).toBe(true);
        // Already canonical as sent: six fraction digits, no zone, no space.
        expect(carimbo === r.data.data_modificacao, `${rotulo} unchanged`).toBe(true);
        linhas += 1;
      });
    }
    expect(linhas).toBeGreaterThanOrEqual(MINIMO_DE_LINHAS);
  });

  it('meta carries what the poller reads: limit read back, total_count on every page, next null exactly at the end', () => {
    for (const nome of BUSCAS) {
      const { meta, objects } = pagina(nome);
      const pedido = Number(valorBruto(captura(nome), 'limit'));
      expect(Number.isSafeInteger(meta.limit) && meta.limit > 0, `${nome} limit`).toBe(true);
      expect(objects.length <= meta.limit, `${nome} page within limit`).toBe(true);
      // Observed: the requested limit is answered as is (the public document's
      // example answers 15; the poller still reads it back, never assumes it).
      expect(meta.limit === pedido, `${nome} limit not capped`).toBe(true);
      expect(meta.offset === 0 && meta.previous === null, `${nome} first page`).toBe(true);
      const total = meta.total_count;
      // Present on every captured page, so `consistenciaDaJanelaLi` never takes
      // its `sem-total` branch on these.
      expect(typeof total === 'number' && Number.isSafeInteger(total), `${nome} total_count`).toBe(
        true,
      );
      const lidos = meta.offset + objects.length;
      expect(meta.next === null ? total === lidos : (total ?? 0) > lidos, `${nome} next`).toBe(
        true,
      );
    }
  });

  it('pedido-search-50 is the request the poller sends: its page size, %3A encoding and path', async () => {
    const nome = 'pedido-search-50.json';
    const since = sinceDaCaptura(nome);
    expect(valorBruto(captura(nome), 'limit') === String(LIMITE_PEDIDOS_LI), 'limit sent').toBe(
      true,
    );
    expect(pagina(nome).meta.limit === LIMITE_PEDIDOS_LI, 'limit read back').toBe(true);

    // The poller's own first-page query, through the real client.
    const { urls, lidas } = await lerPeloPoller([captura(nome).resposta.corpo], {
      since_atualizado: since,
      limit: LIMITE_PEDIDOS_LI,
    });
    expect(urls.length).toBe(1);
    expect(lidas.length).toBe(1);
    const enviado = new Set((urls[0]?.search ?? '').slice(1).split('&'));
    const capturado = new Set(captura(nome).requisicao.query.map(([k, v]) => `${k}=${v}`));
    expect(mesmoConjunto(enviado, capturado), 'same query pairs, same encoding').toBe(true);
    expect(urls[0]?.pathname === CAMINHO_BUSCA_PEDIDOS_LI, 'same path').toBe(true);
    expect(lidas[0]?.objetos.length === pagina(nome).objects.length, 'every row decoded').toBe(
      true,
    );
  });

  it.each(['pedido-search-dois-pontos.json', 'pedido-search-sem-filtro.json'] as const)(
    '%s: paginarLi follows the captured next on its own path, keeping the query',
    async (nome) => {
      const { meta } = pagina(nome);
      const next = meta.next;
      if (next === null) throw new Error(`${nome}: no next`);
      // A relative Tastypie link under /api/v1/, never a URL with a host.
      expect(next.startsWith('/api/v1/pedido/search'), `${nome} next path`).toBe(true);
      const proximoOffset = meta.offset + meta.limit;
      const fim = {
        meta: { ...meta, offset: proximoOffset, next: null, previous: null },
        objects: [],
      };
      const query = queryDaCaptura(nome);
      const { urls, lidas } = await lerPeloPoller([captura(nome).resposta.corpo, fim], query);
      expect(lidas.length).toBe(2);
      const [primeira, segunda] = urls;
      expect(segunda?.pathname === CAMINHO_BUSCA_PEDIDOS_LI, `${nome} page 2 path`).toBe(true);
      expect(segunda?.searchParams.get('offset') === String(proximoOffset), `${nome} offset`).toBe(
        true,
      );
      for (const chave of Object.keys(query)) {
        const igual = segunda?.searchParams.get(chave) === primeira?.searchParams.get(chave);
        expect(igual, `${nome} page 2 keeps ${chave}`).toBe(true);
      }
    },
  );

  it("pedido-search-50: the poller's filter check passes every row against the request's bound", () => {
    const nome = 'pedido-search-50.json';
    const since = sinceDaCaptura(nome);
    const tolerancia = limiteDeToleranciaLi(since);
    const piso = canonicaDoCursorLi(since);
    const { meta, objects } = pagina(nome);
    objects.forEach((linha, i) => {
      const carimbo = lerDataLi(linha.data_modificacao);
      const rotulo = `${nome} objects[${String(i)}]`;
      expect(carimbo !== null && !filtroIgnoradoLi(carimbo, tolerancia), rotulo).toBe(true);
      // Stronger than the poller needs: none is even below the bound itself.
      expect(carimbo !== null && carimbo >= piso, `${rotulo} at or after the bound`).toBe(true);
    });
    // The filter is on the MODIFICATION stamp: an order created before the
    // bound and changed after it is listed.
    const criadaAntes = objects.some((l) => {
      const criacao = lerDataLi(l.data_criacao);
      return criacao !== null && criacao < piso;
    });
    expect(criadaAntes, 'a row created before the bound').toBe(true);
    // A whole, consistent one-page window the poller could advance over.
    const distintos = new Set(objects.map((l) => l.numero)).size;
    expect(distintos === objects.length, 'distinct numeros').toBe(true);
    expect(janelaGrandeDemaisLi(meta), 'window too large').toBe(false);
    expect(consistenciaDaJanelaLi([meta.total_count], distintos)).toBe('consistente');
    // The filter narrows: the unfiltered search announces more orders.
    const semFiltro = pagina('pedido-search-sem-filtro.json').meta.total_count;
    expect((semFiltro ?? 0) > (meta.total_count ?? 0), 'the filter narrows').toBe(true);
  });

  it('pedido-search-futuro: a bound past the capture date answers an empty, final page', () => {
    const nome = 'pedido-search-futuro.json';
    const { meta, objects } = pagina(nome);
    expect(sinceDaCaptura(nome) > `${captura(nome).capturadoEm}T23:59:59`, 'a future bound').toBe(
      true,
    );
    expect(meta.total_count === 0, 'total_count 0').toBe(true);
    expect(objects.length).toBe(0);
    expect(meta.next === null, 'no next').toBe(true);
  });

  it('the literal-colon and %3A forms of since_atualizado answer the same search', () => {
    const colon = 'pedido-search-dois-pontos.json';
    const codificada = 'pedido-search-50.json';
    const brutoColon = valorBruto(captura(colon), 'since_atualizado') ?? '';
    const brutoCodificado = valorBruto(captura(codificada), 'since_atualizado') ?? '';
    expect(brutoColon.includes(':') && !brutoColon.includes('%'), 'literal colons').toBe(true);
    expect(
      brutoCodificado.includes('%3A') && !brutoCodificado.includes(':'),
      'percent-encoded colons',
    ).toBe(true);
    expect(sinceDaCaptura(colon) === sinceDaCaptura(codificada), 'the same bound').toBe(true);
    expect(captura(colon).capturadoEm === captura(codificada).capturadoEm, 'same day').toBe(true);

    const a = pagina(colon);
    const b = pagina(codificada);
    expect(a.meta.total_count === b.meta.total_count, 'same total_count').toBe(true);
    expect(a.objects.length).toBeGreaterThan(0);
    a.objects.forEach((linha, i) => {
      const par = b.objects.find((l) => l.numero === linha.numero);
      const igual = par !== undefined && JSON.stringify(par) === JSON.stringify(linha);
      expect(igual, `${colon} objects[${String(i)}] equals its %3A row`).toBe(true);
    });
  });

  it('pedido-search-50 lists rows by numero, not by data_modificacao (which the poller never assumes)', () => {
    const { objects } = pagina('pedido-search-50.json');
    const numeros = objects.map((l) => l.numero);
    const carimbos = objects.map((l) => lerDataLi(l.data_modificacao));
    expect(objects.length).toBeGreaterThan(2);
    expect(carimbos.every((c) => c !== null)).toBe(true);
    expect(
      paresAdjacentes(numeros, (a, b) => a < b),
      'by numero, ascending',
    ).toBe(true);
    // So the last row's stamp is not, in general, the window's latest.
    expect(
      paresAdjacentes(carimbos, (a, b) => (a ?? '') <= (b ?? '')),
      'stamps ascending',
    ).toBe(false);
    expect(
      paresAdjacentes(carimbos, (a, b) => (a ?? '') >= (b ?? '')),
      'stamps descending',
    ).toBe(false);
  });
});
