/**
 * The listings flows' shared batched live read, through the REAL context and
 * the REAL listings wrapper over a scripted `fetch` that models Amazon (a
 * catalogue, a search that may omit or truncate, a single read whose own 404
 * is "not listed") and REFUSES anything unscripted. The pacing runs on a fake
 * clock: the read's sleep advances it, so every gap between two calls is
 * measured exactly. Both flows' datasets are driven: the stock binding's and
 * the price read's `INCLUIR_LEITURA_PRECO`.
 *
 * After EVERY test: no network call left the scripted `fetch`, no LWA exchange
 * ran (the credential is fresh), and nothing was written.
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one is the only network. The
 * read switch is `on` ONLY in the object literal handed to the context.
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  AmazonThrottleError,
  CAMINHO_LISTINGS,
  MARKETPLACE_ID_BR,
} from '@delfrance/integrations-amazon-sp-api';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { loadAmazonContext } from '../core/contexto';
import {
  INTERVALO_BUSCAS_ESTOQUE_AMAZON_MS,
  INTERVALO_GETS_ESTOQUE_AMAZON_MS,
} from '../estoque/avaliacaoLoteEstoque';
import { DADOS_LEITURA_ESTOQUE_AMAZON } from '../estoque/gateListing';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  caminhoConta,
  loggerEspiao,
  respostaJson,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import { FLUXO_LISTING_AMAZON, type FluxoListingAmazon } from './fluxoListing';
import {
  INTERVALO_BUSCAS_LISTINGS_AMAZON_MS,
  INTERVALO_GETS_LISTINGS_AMAZON_MS,
  type LeituraLoteListingsAmazon,
  type LeituraSkuListingsAmazon,
  type OpcoesLeituraLoteListingsAmazon,
  lerListingsEmLoteAmazon,
} from './leituraLoteListings';
import { INCLUIR_LEITURA_PRECO, NAO_LISTADO_AMAZON } from './listingsAmazon';

const CONTA = 'conta-amz-leitura-lote';
const CAMINHO_BUSCA = `${CAMINHO_LISTINGS}/${SPID_A}`;
const PRAZO_LONGE = AGORA_MS + 3_600_000;

/* -------------------------------------------------------------------------- */
/*                                 the scenario                               */
/* -------------------------------------------------------------------------- */

interface ChamadaAmazon {
  readonly tipo: 'busca' | 'get';
  readonly skus: readonly string[];
  readonly emMs: number;
  readonly incluidos: string | null;
}

type RespostaBusca = (skus: readonly string[]) => {
  readonly items: readonly unknown[];
  readonly numberOfResults?: number;
  readonly nextToken?: string;
};

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  /** Amazon's catalogue: SKU → its listing. A SKU absent here GETs a 404. */
  readonly amazon: Map<string, Record<string, unknown>>;
  /** SKUs the search page leaves out although Amazon lists them. */
  readonly omitidos: Set<string>;
  busca: RespostaBusca | null;
  /** A failure status per GET SKU, or for every search (`*`). */
  readonly falhas: Map<string, number>;
  limiteTaxa: string | null;
  readonly chamadas: ChamadaAmazon[];
  readonly lwa: string[];
  relogio: number;
  readonly esperas: number[];
  ler(
    skus: readonly string[],
    opcoes?: Partial<OpcoesLeituraLoteListingsAmazon>,
  ): Promise<LeituraLoteListingsAmazon>;
}

const cenarios: Cenario[] = [];
const rede: string[] = [];

/** A listing as the model shapes it: a BR summary. */
function listing(sku: string): Record<string, unknown> {
  return {
    sku,
    summaries: [
      { marketplaceId: MARKETPLACE_ID_BR, asin: 'B0TESTE0001', productType: 'PRODUCT', status: [] },
    ],
  };
}

function respostaComTaxa(c: Cenario, status: number, corpo: unknown): Response {
  const r = respostaJson(status, corpo);
  if (c.limiteTaxa !== null) r.headers.set('x-amzn-RateLimit-Limit', c.limiteTaxa);
  return r;
}

function cenario(): Cenario {
  const fake = new FakeDb();
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta leitura',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
  });
  seedCredencial(fake, CONTA);
  const log = loggerEspiao();
  const c: Cenario = {
    fake,
    log,
    amazon: new Map(),
    omitidos: new Set(),
    busca: null,
    falhas: new Map(),
    limiteTaxa: null,
    chamadas: [],
    lwa: [],
    relogio: AGORA_MS,
    esperas: [],
    ler: async (skus, opcoes = {}) => {
      const agora = () => c.relogio;
      const fetch: typeof globalThis.fetch = (input, init) => {
        const url = new URL(String(input));
        const metodo = init?.method ?? 'GET';
        if (url.pathname === '/auth/o2/token') {
          c.lwa.push(metodo);
          return Promise.resolve(tokenDeAcesso());
        }
        if (metodo !== 'GET') {
          return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname}`));
        }
        if (url.pathname === CAMINHO_BUSCA) {
          const pedidos = (url.searchParams.get('identifiers') ?? '').split(',');
          c.chamadas.push({
            tipo: 'busca',
            skus: pedidos,
            emMs: c.relogio,
            incluidos: url.searchParams.get('includedData'),
          });
          const falha = c.falhas.get('*');
          if (falha !== undefined) {
            return Promise.resolve(respostaComTaxa(c, falha, { errors: [{ code: 'X' }] }));
          }
          const corpo: ReturnType<RespostaBusca> =
            c.busca !== null
              ? c.busca(pedidos)
              : (() => {
                  const items = pedidos
                    .filter((s) => c.amazon.has(s) && !c.omitidos.has(s))
                    .map((s) => c.amazon.get(s));
                  return { items, numberOfResults: items.length };
                })();
          return Promise.resolve(
            respostaComTaxa(c, 200, {
              numberOfResults: corpo.numberOfResults,
              items: corpo.items,
              ...(corpo.nextToken === undefined
                ? {}
                : { pagination: { nextToken: corpo.nextToken } }),
            }),
          );
        }
        if (url.pathname.startsWith(`${CAMINHO_BUSCA}/`)) {
          const sku = decodeURIComponent(url.pathname.slice(CAMINHO_BUSCA.length + 1));
          c.chamadas.push({
            tipo: 'get',
            skus: [sku],
            emMs: c.relogio,
            incluidos: url.searchParams.get('includedData'),
          });
          const falha = c.falhas.get(sku);
          if (falha !== undefined) {
            return Promise.resolve(respostaComTaxa(c, falha, { errors: [{ code: 'X' }] }));
          }
          const corpo = c.amazon.get(sku);
          return Promise.resolve(
            corpo === undefined
              ? respostaComTaxa(c, 404, { errors: [{ code: 'NOT_FOUND' }] })
              : respostaComTaxa(c, 200, corpo),
          );
        }
        return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`));
      };
      const contexto = await loadAmazonContext(asDb(fake), CONTA, {
        ambiente: AMBIENTE_LIGADO,
        agora,
        logger: log.logger,
        fetch,
        gerarCorrelationId: () => 'corr-leitura-teste',
      });
      return lerListingsEmLoteAmazon(
        {
          contexto,
          logger: log.logger,
          agora,
          sellerId: SPID_A,
          esperar: (ms) => {
            c.esperas.push(ms);
            c.relogio += ms;
            return Promise.resolve();
          },
        },
        skus,
        {
          fluxo: FLUXO_LISTING_AMAZON.estoque,
          incluir: DADOS_LEITURA_ESTOQUE_AMAZON,
          prazoMs: PRAZO_LONGE,
          maxGets: null,
          ...opcoes,
        },
      );
    },
  };
  cenarios.push(c);
  return c;
}

/** `n` SKUs `SKU-LT-001`…, each listed on Amazon. */
function varios(c: Cenario, n: number, prefixo = 'SKU-LT-'): string[] {
  const skus = Array.from({ length: n }, (_v, i) => `${prefixo}${String(i + 1).padStart(3, '0')}`);
  for (const sku of skus) c.amazon.set(sku, listing(sku));
  return skus;
}

const buscas = (c: Cenario) => c.chamadas.filter((ch) => ch.tipo === 'busca');
const gets = (c: Cenario) => c.chamadas.filter((ch) => ch.tipo === 'get');
const intervalos = (lista: readonly ChamadaAmazon[]) =>
  lista.slice(1).map((ch, i) => ch.emMs - (lista[i]?.emMs ?? 0));

function completa(r: LeituraLoteListingsAmazon) {
  if (r.tipo !== 'completa') throw new Error(`esperava completa, veio ${r.tipo}`);
  return r;
}

const doSku = (r: LeituraLoteListingsAmazon, sku: string): LeituraSkuListingsAmazon | undefined =>
  r.porSku.get(sku);

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
  for (const c of cenarios) {
    expect(c.lwa).toEqual([]);
    expect(c.fake.escritas).toEqual([]);
  }
  cenarios.length = 0;
});

/* -------------------------------------------------------------------------- */

describe('★ includedData exactly as asked, a search and a GET alike', () => {
  // The package joins the datasets in its own constant order: the SET is the caller's.
  it.each<[string, OpcoesLeituraLoteListingsAmazon['incluir'], string]>([
    [
      'the stock datasets',
      DADOS_LEITURA_ESTOQUE_AMAZON,
      'summaries,fulfillmentAvailability,relationships',
    ],
    ['the price datasets', INCLUIR_LEITURA_PRECO, 'summaries,attributes,relationships,issues'],
  ])('%s', async (_c, incluir, esperado) => {
    const c = cenario();
    const skus = varios(c, 3);
    // One confirmation GET: listed, but left out of the search page.
    c.omitidos.add(skus[1] as string);
    const r = completa(await c.ler(skus, { incluir }));
    expect(c.chamadas.map((ch) => [ch.tipo, ch.incluidos])).toEqual([
      ['busca', esperado],
      ['get', esperado],
    ]);
    expect([...esperado.split(',')].sort()).toEqual([...incluir].sort());
    expect(doSku(r, skus[1] as string)).toMatchObject({ tipo: 'lido', confirmadoPorGet: true });
  });
});

describe('★ the pacing: searches ≥ 220 ms apart, GETs ≥ 334 ms apart', () => {
  it('the intervals are the stock binding’s own, and hold between calls', async () => {
    expect(INTERVALO_BUSCAS_LISTINGS_AMAZON_MS).toBe(220);
    expect(INTERVALO_GETS_LISTINGS_AMAZON_MS).toBe(334);
    expect(INTERVALO_BUSCAS_ESTOQUE_AMAZON_MS).toBe(INTERVALO_BUSCAS_LISTINGS_AMAZON_MS);
    expect(INTERVALO_GETS_ESTOQUE_AMAZON_MS).toBe(INTERVALO_GETS_LISTINGS_AMAZON_MS);
    const c = cenario();
    const skus = varios(c, 45);
    for (const sku of skus.slice(0, 3)) c.omitidos.add(sku);
    const r = completa(await c.ler(skus));
    expect(buscas(c).map((b) => b.skus.length)).toEqual([20, 20, 5]);
    expect(intervalos(buscas(c))).toEqual([220, 220]);
    expect(gets(c).map((g) => g.skus[0])).toEqual(skus.slice(0, 3));
    expect(intervalos(gets(c))).toEqual([334, 334]);
    expect(r.chamadas).toEqual({ buscas: 3, rebuscas: 0, gets: 3 });
  });

  it('NEAR-MISS: time already spent between two calls is not slept again', async () => {
    const c = cenario();
    const skus = varios(c, 21);
    c.busca = (pedidos) => {
      c.relogio += 300;
      return { items: pedidos.map((s) => c.amazon.get(s)), numberOfResults: pedidos.length };
    };
    await c.ler(skus);
    expect(c.esperas).toEqual([]);
  });
});

describe('★ a truncated page, a miss confirmed by ONE GET, and the GET cap', () => {
  it('a truncated answer’s misses are searched AGAIN alone before any GET; a miss still missing is confirmed by one GET', async () => {
    const c = cenario();
    const skus = varios(c, 4);
    const [a, b] = skus as [string, string];
    c.busca = (pedidos) => {
      if (pedidos.length > 1) {
        return {
          items: pedidos.filter((s) => s !== a && s !== b).map((s) => c.amazon.get(s)),
          numberOfResults: 4,
          nextToken: 'proxima',
        };
      }
      // The re-search finds a; b is still missing.
      return pedidos[0] === a ? { items: [c.amazon.get(a)], numberOfResults: 1 } : { items: [] };
    };
    const r = completa(await c.ler(skus));
    expect(c.chamadas.map((ch) => [ch.tipo, ch.skus])).toEqual([
      ['busca', skus],
      ['busca', [a]],
      ['busca', [b]],
      ['get', [b]],
    ]);
    expect(r.chamadas).toEqual({ buscas: 3, rebuscas: 2, gets: 1 });
    expect(doSku(r, a)).toMatchObject({ tipo: 'lido', confirmadoPorGet: false });
    expect(doSku(r, b)).toMatchObject({ tipo: 'lido', confirmadoPorGet: true });
  });

  it('a miss whose GET answers 404 is lido as nao-listado (still marked confirmed)', async () => {
    const c = cenario();
    const skus = varios(c, 2);
    c.amazon.delete(skus[0] as string);
    const r = completa(await c.ler(skus));
    expect(doSku(r, skus[0] as string)).toEqual({
      tipo: 'lido',
      leitura: NAO_LISTADO_AMAZON,
      confirmadoPorGet: true,
    });
  });

  it('★ maxGets: past the cap a miss ends nao-confirmado, never read (NEAR-MISS: null confirms every miss)', async () => {
    const c = cenario();
    const skus = varios(c, 5);
    for (const sku of skus) c.omitidos.add(sku);
    const r = completa(await c.ler(skus, { maxGets: 2 }));
    expect(gets(c)).toHaveLength(2);
    expect(skus.map((s) => doSku(r, s)?.tipo)).toEqual([
      'lido',
      'lido',
      'nao-confirmado',
      'nao-confirmado',
      'nao-confirmado',
    ]);
    const d = cenario();
    const outros = varios(d, 5);
    for (const sku of outros) d.omitidos.add(sku);
    const tudo = completa(await d.ler(outros, { maxGets: null }));
    expect(gets(d)).toHaveLength(5);
    expect([...tudo.porSku.values()].every((l) => l.tipo === 'lido')).toBe(true);
  });

  it('a SKU the search cannot carry is read alone by GET; one no read can carry ends sem-caminho, never read', async () => {
    const c = cenario();
    const virgula = 'SKU,COM-VIRGULA';
    const semCaminho = 'SKU,COM/BARRA';
    const normal = varios(c, 1);
    c.amazon.set(virgula, listing(virgula));
    const r = completa(await c.ler([...normal, virgula, semCaminho]));
    expect(buscas(c).map((b) => b.skus)).toEqual([normal]);
    expect(gets(c).map((g) => g.skus)).toEqual([[virgula]]);
    expect(doSku(r, virgula)).toMatchObject({ tipo: 'lido', confirmadoPorGet: false });
    expect(doSku(r, semCaminho)).toEqual({ tipo: 'sem-caminho' });
  });

  it('NEAR-MISS: a SEARCHED SKU missing from the page that no path can carry ends nao-confirmado, never GET', async () => {
    const c = cenario();
    const barra = 'SKU/COM/BARRA';
    const normal = varios(c, 1);
    const r = completa(await c.ler([...normal, barra]));
    expect(buscas(c).map((b) => [...b.skus].sort())).toEqual([[...normal, barra].sort()]);
    expect(gets(c)).toEqual([]);
    expect(doSku(r, barra)).toEqual({ tipo: 'nao-confirmado' });
  });

  it('every distinct SKU asked has ONE answer; repeats are read once', async () => {
    const c = cenario();
    const skus = varios(c, 2);
    const r = completa(await c.ler([...skus, ...skus]));
    expect([...r.porSku.keys()].sort()).toEqual([...skus].sort());
    expect(buscas(c)).toHaveLength(1);
  });
});

describe('the search lines, the flow, a 429', () => {
  it.each<[FluxoListingAmazon]>([[FLUXO_LISTING_AMAZON.estoque], [FLUXO_LISTING_AMAZON.preco]])(
    '★ ONE line per search under the %s flow’s own event: counts, flags and the rate, never a SKU',
    async (fluxo) => {
      const c = cenario();
      c.limiteTaxa = '5';
      const skus = varios(c, 3);
      await c.ler(skus, { fluxo });
      const linhas = c.log.linhas.filter((l) => l.meta?.fase === 'busca');
      expect(linhas).toEqual([
        {
          nivel: 'info',
          mensagem: `[amazon/${fluxo}] busca de listings de um lote`,
          meta: expect.objectContaining({
            evento: fluxo,
            fluxo,
            conta: CONTA,
            fase: 'busca',
            rebusca: false,
            skus: 3,
            itens: 3,
            encontrados: 3,
            truncada: false,
            limiteTaxa: 5,
          }),
        },
      ]);
      expect(JSON.stringify(linhas)).not.toContain('SKU-LT-');
    },
  );

  it('★ a 429 on a search is thrown UNTOUCHED, with its class (the caller pauses)', async () => {
    const c = cenario();
    const skus = varios(c, 2);
    c.falhas.set('*', 429);
    await expect(c.ler(skus)).rejects.toBeInstanceOf(AmazonThrottleError);
  });
});

describe('the deadline and the options', () => {
  it('★ passed before the first search ⇒ prazo at busca, nothing called', async () => {
    const c = cenario();
    const skus = varios(c, 2);
    const r = await c.ler(skus, { prazoMs: AGORA_MS });
    expect(r).toMatchObject({ tipo: 'prazo', etapa: 'busca', chamadas: { buscas: 0, gets: 0 } });
    expect(c.chamadas).toEqual([]);
  });

  it('★ reached between two GETs ⇒ prazo at leitura, with what was decided so far (NEAR-MISS: one ms later the next GET goes)', async () => {
    const c = cenario();
    const skus = varios(c, 3);
    for (const sku of skus) c.omitidos.add(sku);
    // The search at AGORA; GET 1 at once (the search floor is not the GET's);
    // GET 2 waits 334 ms. The deadline is the instant GET 2 would start.
    const r = await c.ler(skus, { prazoMs: AGORA_MS + 334 });
    expect(r.tipo).toBe('prazo');
    if (r.tipo !== 'prazo') return;
    expect(r.etapa).toBe('leitura');
    expect(gets(c)).toHaveLength(1);
    expect(r.porSku.get(skus[0] as string)).toMatchObject({ tipo: 'lido' });
    expect(r.chamadas).toEqual({ buscas: 1, rebuscas: 0, gets: 1 });
    const d = cenario();
    const outros = varios(d, 3);
    for (const sku of outros) d.omitidos.add(sku);
    const mais = await d.ler(outros, { prazoMs: AGORA_MS + 335 });
    expect(gets(d).length).toBeGreaterThan(1);
    expect(mais.tipo).toBe('prazo');
  });

  it.each<[string, Partial<OpcoesLeituraLoteListingsAmazon>]>([
    ['a deadline that is not a ms instant', { prazoMs: 1.5 }],
    ['a negative deadline', { prazoMs: -1 }],
    ['a negative GET cap', { maxGets: -1 }],
    ['a fractional GET cap', { maxGets: 0.5 }],
  ])('%s ⇒ RangeError, nothing called', async (_c, opcoes) => {
    const c = cenario();
    const skus = varios(c, 1);
    await expect(c.ler(skus, opcoes)).rejects.toBeInstanceOf(RangeError);
    expect(c.chamadas).toEqual([]);
  });

  it('NEAR-MISS: a GET cap of 0 reads by search only, every miss nao-confirmado', async () => {
    const c = cenario();
    const skus = varios(c, 2);
    c.omitidos.add(skus[0] as string);
    const r = completa(await c.ler(skus, { maxGets: 0 }));
    expect(gets(c)).toEqual([]);
    expect(doSku(r, skus[0] as string)).toEqual({ tipo: 'nao-confirmado' });
    expect(doSku(r, skus[1] as string)).toMatchObject({ tipo: 'lido' });
  });
});

describe('the shared read’s own proofs: the cap both ways, the re-search pacing and deadline, the GET order', () => {
  it('★ a spent cap REFUSES a single read too: a confirmation sorted first spends it, the single read ends nao-confirmado, never read', async () => {
    const c = cenario();
    const confirmacao = 'SKU-A-001';
    const sozinho = 'SKU-B,VIRGULA';
    c.amazon.set(confirmacao, listing(confirmacao));
    c.amazon.set(sozinho, listing(sozinho));
    c.omitidos.add(confirmacao);
    const r = completa(await c.ler([sozinho, confirmacao], { maxGets: 1 }));
    expect(gets(c).map((g) => g.skus)).toEqual([[confirmacao]]);
    expect(doSku(r, confirmacao)).toMatchObject({ tipo: 'lido', confirmadoPorGet: true });
    expect(doSku(r, sozinho)).toEqual({ tipo: 'nao-confirmado' });
    expect(r.chamadas.gets).toBe(1);
  });

  it('★ a SKU no path can carry ends sem-caminho even past the cap (NEAR-MISS: never nao-confirmado)', async () => {
    const c = cenario();
    const semCaminho = 'SKU,COM/BARRA';
    const r = completa(await c.ler([semCaminho], { maxGets: 0 }));
    expect(doSku(r, semCaminho)).toEqual({ tipo: 'sem-caminho' });
    expect(c.chamadas).toEqual([]);
    const d = cenario();
    const confirmacao = 'SKU-A-001';
    const depois = 'SKU-B,COM/BARRA';
    d.amazon.set(confirmacao, listing(confirmacao));
    d.omitidos.add(confirmacao);
    const s = completa(await d.ler([depois, confirmacao], { maxGets: 1 }));
    expect(gets(d).map((g) => g.skus)).toEqual([[confirmacao]]);
    expect(doSku(s, depois)).toEqual({ tipo: 'sem-caminho' });
  });

  /** A truncated first page leaving out two SKUs that each re-search finds. */
  function truncada(c: Cenario): { skus: string[]; a: string; b: string } {
    const skus = varios(c, 4);
    const [a, b] = skus as [string, string];
    c.busca = (pedidos) =>
      pedidos.length > 1
        ? {
            items: pedidos.filter((s) => s !== a && s !== b).map((s) => c.amazon.get(s)),
            numberOfResults: 4,
            nextToken: 'proxima',
          }
        : { items: pedidos.map((s) => c.amazon.get(s)), numberOfResults: 1 };
    return { skus, a, b };
  }

  it('★ the re-searches are paced like any search: 220 ms apart, after the first page', async () => {
    const c = cenario();
    const { skus, a, b } = truncada(c);
    const r = completa(await c.ler(skus));
    expect(buscas(c).map((ch) => ch.skus)).toEqual([skus, [a], [b]]);
    expect(intervalos(buscas(c))).toEqual([220, 220]);
    expect(r.chamadas).toEqual({ buscas: 3, rebuscas: 2, gets: 0 });
  });

  it('★ the deadline reached before a re-search ⇒ prazo at busca, the re-search never sent (NEAR-MISS: one ms later it goes)', async () => {
    const c = cenario();
    const { skus } = truncada(c);
    const r = await c.ler(skus, { prazoMs: AGORA_MS + 220 });
    expect(r).toMatchObject({
      tipo: 'prazo',
      etapa: 'busca',
      chamadas: { buscas: 1, rebuscas: 0, gets: 0 },
    });
    expect(buscas(c)).toHaveLength(1);
    const d = cenario();
    const outra = truncada(d);
    const s = await d.ler(outra.skus, { prazoMs: AGORA_MS + 221 });
    expect(s).toMatchObject({
      tipo: 'prazo',
      etapa: 'busca',
      chamadas: { buscas: 2, rebuscas: 1, gets: 0 },
    });
  });

  it('★ the GETs — the confirmations and the single reads — go in ONE sorted order, 334 ms apart', async () => {
    const c = cenario();
    const confirmacao = 'SKU-B-001';
    const sozinho = 'SKU-A,VIRGULA';
    c.amazon.set(confirmacao, listing(confirmacao));
    c.amazon.set(sozinho, listing(sozinho));
    c.omitidos.add(confirmacao);
    completa(await c.ler([confirmacao, sozinho]));
    expect(gets(c).map((g) => g.skus[0])).toEqual([sozinho, confirmacao]);
    expect(intervalos(gets(c))).toEqual([334]);
  });

  it('a search line counts as found only the SKUs it asked for, however many items the answer carries', async () => {
    const c = cenario();
    const skus = varios(c, 2);
    c.busca = (pedidos) => ({
      items: [...pedidos.map((s) => c.amazon.get(s)), listing('SKU-NAO-PEDIDO')],
      numberOfResults: pedidos.length + 1,
    });
    await c.ler(skus);
    const [linha] = c.log.linhas.filter((l) => l.meta?.fase === 'busca');
    expect(linha?.meta).toMatchObject({ skus: 2, itens: 3, encontrados: 2 });
  });
});
