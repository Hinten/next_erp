/**
 * The batch evaluator (step 12, PR 12-f) against the counting fake Firestore:
 * the REAL context, the REAL order-import resolver pieces, link verdict, family
 * read, quantity core and listing gate, and the REAL listings wrapper over a
 * scripted `fetch` that models Amazon (a catalogue of listings, a search that
 * may omit or truncate, a single read whose own 404 is "not listed") and
 * REFUSES anything unscripted. The pacing runs on a fake clock: the evaluator's
 * sleep advances it, so every gap between two calls is measured exactly.
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
  AmazonHttpError,
  AmazonThrottleError,
  CAMINHO_LISTINGS,
  MARKETPLACE_ID_BR,
} from '@delfrance/integrations-amazon-sp-api';
import { INTEGRACAO_TIPO, makeEstoqueUid } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { loadAmazonContext } from '../core/contexto';
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
import {
  type AvaliacaoLoteEstoqueAmazon,
  type AvaliacaoSkuEstoqueAmazon,
  CAMPOS_LEITURA_DONOS_AVALIACAO_ESTOQUE_AMAZON,
  CAMPOS_LEITURA_UNIDADES_AVALIACAO_ESTOQUE_AMAZON,
  DESFECHO_AVALIACAO_ESTOQUE_AMAZON,
  ETAPA_AVALIACAO_ESTOQUE_AMAZON,
  INTERVALO_BUSCAS_ESTOQUE_AMAZON_MS,
  INTERVALO_GETS_ESTOQUE_AMAZON_MS,
  MAX_GETS_LOTE_JANELA,
  type OpcoesAvaliacaoEstoqueAmazon,
  avaliarSkusEstoqueAmazon,
  lerVinculosDosSkusEstoqueAmazon,
} from './avaliacaoLoteEstoque';
import { CAMPOS_LINHA_ESTOQUE_AMAZON } from './familiaEstoque';
import { DADOS_LEITURA_ESTOQUE_AMAZON } from './gateListing';
import { MOTIVO_ESTOQUE_AMAZON, RECUSAS_HUMANAS_ESTOQUE_AMAZON } from './motivosEstoque';
import { CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON, lerVinculoEstoqueAmazon } from './resolverEstoque';
import { avaliarVinculoEstoqueAmazon } from './vinculoEstoque';

const CONTA = 'conta-amz-avaliacao';
const REF_CONTA = `documents/integracao/${CONTA}`;
const DEP = 'dep-avaliacao-1';
const REF_DEP = `documents/depositos/${DEP}`;
const CAMINHO_BUSCA = `${CAMINHO_LISTINGS}/${SPID_A}`;
const PRAZO_LONGE = AGORA_MS + 3_600_000;

/* -------------------------------------------------------------------------- */
/*                                 the scenario                               */
/* -------------------------------------------------------------------------- */

/** One call that reached the scripted Amazon, and when (the fake clock). */
interface ChamadaAmazon {
  readonly tipo: 'busca' | 'get';
  readonly skus: readonly string[];
  readonly emMs: number;
  readonly incluidos: string | null;
}

/** What one search answers for the SKUs it asked: overridable per test. */
type RespostaBusca = (skus: readonly string[]) => {
  readonly items: readonly unknown[];
  readonly numberOfResults?: number;
  readonly nextToken?: string;
};

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  /** Amazon's catalogue: SKU → its listing body. A SKU absent here GETs a 404. */
  readonly amazon: Map<string, Record<string, unknown>>;
  /** SKUs the search page leaves out although Amazon lists them. */
  readonly omitidos: Set<string>;
  /** A search answer, when a test scripts it whole. */
  busca: RespostaBusca | null;
  /** A failure status per GET SKU, or for every search (`*`). */
  readonly falhas: Map<string, number>;
  /** The header `x-amzn-RateLimit-Limit` every answer carries. */
  limiteTaxa: string | null;
  readonly chamadas: ChamadaAmazon[];
  readonly lwa: string[];
  /** The fake clock, ms. */
  relogio: number;
  /** Every sleep the evaluator asked for, ms. */
  readonly esperas: number[];
  avaliar(
    skus: readonly string[],
    opcoes?: Partial<OpcoesAvaliacaoEstoqueAmazon>,
  ): Promise<AvaliacaoLoteEstoqueAmazon>;
}

const cenarios: Cenario[] = [];
const rede: string[] = [];

/** A listing as the model shapes it: BR summary, MFN availability at `quantidade`. */
function listing(
  sku: string,
  quantidade: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sku,
    summaries: [
      {
        marketplaceId: MARKETPLACE_ID_BR,
        asin: asinDe(sku),
        productType: 'PRODUCT',
        status: ['BUYABLE'],
      },
    ],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: quantidade }],
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
    ...extra,
  };
}

/** A deterministic ASIN-shaped placeholder per SKU, from a hash of the WHOLE SKU (letters only). */
function asinDe(sku: string): string {
  let h = 2166136261;
  for (const ch of sku) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  let letras = '';
  for (let i = 0; i < 8; i += 1) {
    letras += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + i * 7919;
  }
  return `B0${letras}`;
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
    nome: 'Conta avaliação',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    depositoOuterRef: REF_DEP,
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
    avaliar: async (skus, opcoes = {}) => {
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
        gerarCorrelationId: () => 'corr-avaliacao-teste',
      });
      return avaliarSkusEstoqueAmazon(
        {
          contexto,
          db: asDb(fake),
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
        { depositoId: DEP, prazoMs: PRAZO_LONGE, maxGets: null, ...opcoes },
      );
    },
  };
  cenarios.push(c);
  return c;
}

/* ------------------------------- the seeds -------------------------------- */

function produto(c: Cenario, id: string, dados: Record<string, unknown> = {}): void {
  c.fake.seed(`produtos/${id}`, { nome: `Produto ${id}`, precos: { varejo: 10 }, ...dados });
}

function vinculo(
  c: Cenario,
  produtoId: string,
  linkId: string,
  sku: string,
  extra: Record<string, unknown> = {},
): void {
  c.fake.seed(`produtos/${produtoId}/prodAmazon/${linkId}`, {
    contaAmazonOuterRef: REF_CONTA,
    sku,
    asin: asinDe(sku),
    productDataJson: { pesado: 'x'.repeat(64) },
    ...extra,
  });
}

function estoque(c: Cenario, produtoId: string, quantidade: number, reservada = 0): void {
  c.fake.seed(`produtos/${produtoId}/estoques/${makeEstoqueUid(produtoId, DEP)}`, {
    depositoOuterRef: REF_DEP,
    parentId: produtoId,
    quantidade,
    quantidadeReservada: reservada,
  });
}

/** A simple produto `p-<sku>` linked to `sku`, ERP `erp`, listed on Amazon at `amazon` (or not listed). */
function simples(c: Cenario, sku: string, erp: number, amazon: number | null = erp): void {
  const id = `p-${sku.replace(/[^A-Za-z0-9-]/g, '_')}`;
  produto(c, id);
  vinculo(c, id, 'l1', sku);
  estoque(c, id, erp);
  if (amazon !== null) c.amazon.set(sku, listing(sku, amazon));
}

/** `n` SKUs `SKU-AV-001`…, each a simple produto, ERP 5, Amazon 5. */
function varios(c: Cenario, n: number, prefixo = 'SKU-AV-'): string[] {
  const skus = Array.from({ length: n }, (_v, i) => `${prefixo}${String(i + 1).padStart(3, '0')}`);
  for (const sku of skus) simples(c, sku, 5);
  return skus;
}

/* ------------------------------- the readers ------------------------------ */

function completa(r: AvaliacaoLoteEstoqueAmazon) {
  if (r.tipo !== DESFECHO_AVALIACAO_ESTOQUE_AMAZON.completa) {
    throw new Error(`esperava completa, veio ${r.tipo}`);
  }
  return r;
}

function doSku(r: AvaliacaoLoteEstoqueAmazon, sku: string): AvaliacaoSkuEstoqueAmazon {
  const achado = completa(r).skus.find((s) => s.sku === sku);
  if (achado === undefined) throw new Error(`sem avaliação de ${sku}`);
  return achado;
}

const buscas = (c: Cenario) => c.chamadas.filter((ch) => ch.tipo === 'busca');
const gets = (c: Cenario) => c.chamadas.filter((ch) => ch.tipo === 'get');
const linhasDeBusca = (c: Cenario) =>
  c.log.linhas.filter((l) => l.meta?.evento === 'estoque' && l.meta.fase === 'busca');
/** The gaps, ms, between consecutive calls of `lista`. */
const intervalos = (lista: readonly ChamadaAmazon[]) =>
  lista.slice(1).map((ch, i) => ch.emMs - (lista[i]?.emMs ?? 0));

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

describe('★ the search: 20 SKUs a call, the calls paced', () => {
  it('21 SKUs ⇒ TWO searches, the first 20 sorted then the 21st, ≥ 220 ms apart; every SKU enviável', async () => {
    const c = cenario();
    const skus = varios(c, 21);
    const r = completa(await c.avaliar([...skus].reverse()));
    expect(buscas(c).map((b) => b.skus)).toEqual([skus.slice(0, 20), skus.slice(20)]);
    expect(gets(c)).toEqual([]);
    expect(intervalos(buscas(c))).toEqual([INTERVALO_BUSCAS_ESTOQUE_AMAZON_MS]);
    expect(INTERVALO_BUSCAS_ESTOQUE_AMAZON_MS).toBe(220);
    expect(r.skus.map((s) => s.sku)).toEqual(skus);
    expect(r.skus.every((s) => s.enviavel)).toBe(true);
    expect(r.contagem).toMatchObject({ skus: 21, enviaveis: 21 });
    expect(r.contagem.leituras).toMatchObject({ buscas: 2, rebuscas: 0, gets: 0, consultas: 21 });
    // The datasets the gate reads, on every call.
    expect(new Set(buscas(c).map((b) => b.incluidos))).toEqual(
      new Set([DADOS_LEITURA_ESTOQUE_AMAZON.join(',')]),
    );
  });

  it('NEAR-MISS: exactly 20 SKUs ⇒ ONE search, and no wait at all', async () => {
    const c = cenario();
    const skus = varios(c, 20);
    completa(await c.avaliar(skus));
    expect(buscas(c)).toHaveLength(1);
    expect(buscas(c)[0]?.skus).toEqual(skus);
    expect(c.esperas).toEqual([]);
  });

  it('a search that already took longer than the floor waits for nothing more', async () => {
    const c = cenario();
    const skus = varios(c, 41);
    // Each answer takes 300 ms of the clock: past the 220-ms floor already.
    c.busca = (pedidos) => {
      c.relogio += 300;
      const items = pedidos.map((s) => c.amazon.get(s));
      return { items, numberOfResults: items.length };
    };
    completa(await c.avaliar(skus));
    expect(buscas(c)).toHaveLength(3);
    expect(c.esperas).toEqual([]);
    for (const gap of intervalos(buscas(c))) expect(gap).toBeGreaterThanOrEqual(220);
  });

  it('a 21st SKU arriving 100 ms into the floor waits exactly the 120 ms left', async () => {
    const c = cenario();
    const skus = varios(c, 21);
    c.busca = (pedidos) => {
      c.relogio += 100;
      const items = pedidos.map((s) => c.amazon.get(s));
      return { items, numberOfResults: items.length };
    };
    completa(await c.avaliar(skus));
    expect(c.esperas).toEqual([120]);
    expect(intervalos(buscas(c))).toEqual([220]);
  });

  it('every search writes ONE line: counts, flags and the rate Amazon applied — never a SKU', async () => {
    const c = cenario();
    const skus = varios(c, 21);
    c.limiteTaxa = '5.0';
    c.omitidos.add(skus[20] ?? '');
    completa(await c.avaliar(skus));
    const linhas = linhasDeBusca(c);
    expect(linhas.map((l) => l.meta)).toEqual([
      expect.objectContaining({
        evento: 'estoque',
        conta: CONTA,
        fluxo: 'estoque',
        fase: 'busca',
        rebusca: false,
        skus: 20,
        itens: 20,
        encontrados: 20,
        truncada: false,
        limiteTaxa: 5,
      }),
      expect.objectContaining({ skus: 1, itens: 0, encontrados: 0, truncada: false }),
    ]);
    const texto = JSON.stringify(linhas);
    for (const sku of skus) expect(texto).not.toContain(sku);
    expect(linhas.every((l) => l.nivel === 'info')).toBe(true);
  });

  it('an answer item is matched by its EXACT SKU: a case-folded twin is not the requested one', async () => {
    const c = cenario();
    simples(c, 'SKU-Exato', 4);
    c.busca = () => ({ items: [listing('sku-exato', 4)], numberOfResults: 1 });
    const r = await c.avaliar(['SKU-Exato']);
    // Not in the answer ⇒ confirmed by its own GET.
    expect(gets(c).map((g) => g.skus)).toEqual([['SKU-Exato']]);
    expect(doSku(r, 'SKU-Exato')).toMatchObject({ enviavel: true, quantidadeAmazon: 4 });
  });
});

describe('★ a miss is confirmed by ONE GET; only that read’s own 404 is nao-listado', () => {
  it('a requested SKU missing from an untruncated answer ⇒ ONE GET of exactly it, after the search', async () => {
    const c = cenario();
    const skus = varios(c, 3);
    const [, faltando] = skus;
    c.omitidos.add(faltando ?? '');
    const r = await c.avaliar(skus);
    expect(c.chamadas.map((ch) => [ch.tipo, ch.skus])).toEqual([
      ['busca', skus],
      ['get', [faltando]],
    ]);
    expect(gets(c)[0]?.incluidos).toBe(DADOS_LEITURA_ESTOQUE_AMAZON.join(','));
    expect(doSku(r, faltando ?? '')).toMatchObject({
      enviavel: true,
      quantidadeAmazon: 5,
      contagens: ['confirmadoPorGet'],
    });
    expect(completa(r).contagem.porChave).toEqual({ confirmadoPorGet: 1 });
    expect(completa(r).contagem.leituras).toMatchObject({ buscas: 1, gets: 1 });
  });

  it('NEAR-MISS: the miss Amazon does NOT list ⇒ its GET 404s ⇒ nao-listado, not confirmadoPorGet', async () => {
    const c = cenario();
    simples(c, 'SKU-NL', 5, null);
    const r = await c.avaliar(['SKU-NL']);
    expect(gets(c).map((g) => g.skus)).toEqual([['SKU-NL']]);
    expect(doSku(r, 'SKU-NL')).toEqual({
      sku: 'SKU-NL',
      enviavel: false,
      motivo: MOTIVO_ESTOQUE_AMAZON.naoListado,
      vinculo: expect.objectContaining({ apto: true }),
      quantidadeErp: 5,
    });
    expect(completa(r).contagem.porChave).toEqual({ 'nao-listado': 1 });
  });

  it.each<[string, number, (e: unknown) => boolean]>([
    ['a 500', 500, (e) => e instanceof AmazonHttpError && e.status === 500],
    ['a 429', 429, (e) => e instanceof AmazonThrottleError],
    ['a 400', 400, (e) => e instanceof AmazonHttpError && e.status === 400],
  ])(
    '★ NEAR-MISS: %s on the confirmation is no reading — thrown untouched',
    async (_n, status, eh) => {
      const c = cenario();
      simples(c, 'SKU-F', 5);
      c.omitidos.add('SKU-F');
      c.falhas.set('SKU-F', status);
      await expect(c.avaliar(['SKU-F'])).rejects.toSatisfy(eh);
    },
  );

  it('a failing SEARCH is thrown untouched too (a walk page or a feed build decides)', async () => {
    const c = cenario();
    varios(c, 2);
    c.falhas.set('*', 429);
    await expect(c.avaliar(['SKU-AV-001', 'SKU-AV-002'])).rejects.toBeInstanceOf(
      AmazonThrottleError,
    );
    expect(gets(c)).toEqual([]);
  });

  it('★ the GETs are ≥ 334 ms apart (the stock queue reads the same per-seller budget)', async () => {
    const c = cenario();
    const skus = varios(c, 4);
    for (const sku of skus) c.omitidos.add(sku);
    completa(await c.avaliar(skus));
    expect(gets(c).map((g) => g.skus[0])).toEqual(skus);
    expect(intervalos(gets(c))).toEqual([334, 334, 334]);
    expect(INTERVALO_GETS_ESTOQUE_AMAZON_MS).toBe(334);
  });
});

describe('★ a truncated answer: re-searched alone first, a GET only for what is still unseen', () => {
  it.each<[string, (n: number) => { numberOfResults?: number; nextToken?: string }]>([
    ['a nextToken', (n) => ({ numberOfResults: n, nextToken: 'tok-pagina-2' })],
    ['numberOfResults above its item count', (n) => ({ numberOfResults: n + 5 })],
  ])('flagged by %s', async (_nome, sinal) => {
    const c = cenario();
    const skus = varios(c, 5);
    const [a, b, presente, d, e] = skus as [string, string, string, string, string];
    // The first page omits a, b, d and e; a and b come back alone, d does not;
    // e is not listed at all.
    c.amazon.delete(e);
    let primeira = true;
    c.busca = (pedidos) => {
      if (primeira) {
        primeira = false;
        const items = [c.amazon.get(presente)];
        return { items, ...sinal(items.length) };
      }
      const items = pedidos.filter((s) => s !== d && c.amazon.has(s)).map((s) => c.amazon.get(s));
      return { items, numberOfResults: items.length };
    };
    const r = completa(await c.avaliar(skus));
    expect(c.chamadas.map((ch) => [ch.tipo, ch.skus])).toEqual([
      ['busca', skus],
      // Each missing SKU searched again, ALONE, before any GET.
      ['busca', [a]],
      ['busca', [b]],
      ['busca', [d]],
      ['busca', [e]],
      // Only what is still unseen is read by GET.
      ['get', [d]],
      ['get', [e]],
    ]);
    // NEAR-MISS: the SKU the truncated page carried is neither re-searched nor read.
    expect(c.chamadas.filter((ch) => ch.skus.includes(presente))).toHaveLength(1);
    expect(doSku(r, presente)).toMatchObject({ enviavel: true, contagens: [] });
    expect(doSku(r, a)).toMatchObject({ enviavel: true, contagens: [] });
    expect(doSku(r, d)).toMatchObject({ enviavel: true, contagens: ['confirmadoPorGet'] });
    expect(doSku(r, e)).toMatchObject({ enviavel: false, motivo: 'nao-listado' });
    expect(r.contagem.leituras).toMatchObject({ buscas: 5, rebuscas: 4, gets: 2 });
    expect(linhasDeBusca(c).map((l) => [l.meta?.rebusca, l.meta?.truncada])).toEqual([
      [false, true],
      [true, false],
      [true, false],
      [true, false],
      [true, false],
    ]);
  });

  it('NEAR-MISS: an UNTRUNCATED answer’s misses go straight to their GETs, never a re-search', async () => {
    const c = cenario();
    const skus = varios(c, 3);
    c.omitidos.add(skus[0] ?? '');
    c.omitidos.add(skus[2] ?? '');
    completa(await c.avaliar(skus));
    expect(c.chamadas.map((ch) => [ch.tipo, ch.skus])).toEqual([
      ['busca', skus],
      ['get', [skus[0]]],
      ['get', [skus[2]]],
    ]);
  });

  it('a re-search is paced like any search', async () => {
    const c = cenario();
    const skus = varios(c, 2);
    let primeira = true;
    c.busca = (pedidos) => {
      if (primeira) {
        primeira = false;
        return { items: [], nextToken: 'tok' };
      }
      return { items: pedidos.map((s) => c.amazon.get(s)), numberOfResults: 1 };
    };
    completa(await c.avaliar(skus));
    expect(buscas(c)).toHaveLength(3);
    expect(intervalos(buscas(c))).toEqual([220, 220]);
  });
});

describe('★ the GET cap: the confirmations and the single reads share maxGets', () => {
  it('61 misses under the window cap ⇒ 60 GETs, the 61st (by SKU) nao-confirmado and NOT enviável', async () => {
    const c = cenario();
    const skus = varios(c, 61);
    for (const sku of skus) c.omitidos.add(sku);
    const r = completa(await c.avaliar(skus, { maxGets: MAX_GETS_LOTE_JANELA }));
    expect(MAX_GETS_LOTE_JANELA).toBe(60);
    expect(gets(c).map((g) => g.skus[0])).toEqual(skus.slice(0, 60));
    expect(doSku(r, skus[60] ?? '')).toEqual({
      sku: skus[60],
      enviavel: false,
      motivo: MOTIVO_ESTOQUE_AMAZON.naoConfirmado,
      vinculo: expect.objectContaining({ apto: true }),
      quantidadeErp: 5,
    });
    expect(r.contagem).toMatchObject({
      enviaveis: 60,
      porChave: { confirmadoPorGet: 60, 'nao-confirmado': 1 },
    });
  });

  it('★ NEAR-MISS: unbounded (a reconcile page) ⇒ all 61 confirmed', async () => {
    const c = cenario();
    const skus = varios(c, 61);
    for (const sku of skus) c.omitidos.add(sku);
    const r = completa(await c.avaliar(skus, { maxGets: null }));
    expect(gets(c)).toHaveLength(61);
    expect(r.contagem).toMatchObject({ enviaveis: 61, porChave: { confirmadoPorGet: 61 } });
  });

  it('a single read of a SKU the search cannot carry spends the SAME cap', async () => {
    const c = cenario();
    simples(c, 'SKU A', 2); // a space: never in a search list, read alone
    simples(c, 'SKU-B', 3);
    c.omitidos.add('SKU-B');
    const r = completa(await c.avaliar(['SKU-B', 'SKU A'], { maxGets: 1 }));
    expect(buscas(c).map((b) => b.skus)).toEqual([['SKU-B']]);
    // Sorted by SKU: the single read of `SKU A` first, then the cap is spent.
    expect(gets(c).map((g) => g.skus)).toEqual([['SKU A']]);
    expect(doSku(r, 'SKU A')).toMatchObject({ enviavel: true, quantidadeAmazon: 2, contagens: [] });
    expect(doSku(r, 'SKU-B')).toMatchObject({ enviavel: false, motivo: 'nao-confirmado' });
  });

  it('a cap of 0 reads by GET nothing at all', async () => {
    const c = cenario();
    simples(c, 'SKU-C0', 3);
    c.omitidos.add('SKU-C0');
    const r = completa(await c.avaliar(['SKU-C0'], { maxGets: 0 }));
    expect(gets(c)).toEqual([]);
    expect(doSku(r, 'SKU-C0')).toMatchObject({ enviavel: false, motivo: 'nao-confirmado' });
  });
});

describe('the SKUs a search cannot carry', () => {
  it('a SKU with a space is read ALONE by GET, never searched; one holding a comma and a slash ends sem-caminho, unread', async () => {
    const c = cenario();
    simples(c, 'SKU 1', 2);
    simples(c, 'a/b,c', 4);
    simples(c, 'SKU-OK', 1);
    const r = completa(await c.avaliar(['SKU 1', 'a/b,c', 'SKU-OK']));
    expect(buscas(c).map((b) => b.skus)).toEqual([['SKU-OK']]);
    expect(gets(c).map((g) => g.skus)).toEqual([['SKU 1']]);
    expect(doSku(r, 'SKU 1')).toMatchObject({ enviavel: true, quantidadeAmazon: 2 });
    expect(doSku(r, 'a/b,c')).toEqual({
      sku: 'a/b,c',
      enviavel: false,
      motivo: MOTIVO_ESTOQUE_AMAZON.semCaminho,
      vinculo: expect.objectContaining({ apto: true }),
      quantidadeErp: 4,
    });
  });

  it('a SKU no PATH can carry but the search can ⇒ read by the search and enviável (a feed carries it)', async () => {
    const c = cenario();
    simples(c, 'SKU/1', 6, 2);
    const r = completa(await c.avaliar(['SKU/1']));
    expect(buscas(c).map((b) => b.skus)).toEqual([['SKU/1']]);
    expect(doSku(r, 'SKU/1')).toMatchObject({
      enviavel: true,
      quantidadeErp: 6,
      quantidadeAmazon: 2,
    });
  });

  it('NEAR-MISS: the same SKU missing from the answer cannot be confirmed (no path for the GET) ⇒ nao-confirmado, no GET, the cap untouched', async () => {
    const c = cenario();
    simples(c, 'SKU/1', 6, 2);
    simples(c, 'SKU-2', 6, 2);
    c.omitidos.add('SKU/1');
    c.omitidos.add('SKU-2');
    const r = completa(await c.avaliar(['SKU/1', 'SKU-2'], { maxGets: 1 }));
    expect(gets(c).map((g) => g.skus)).toEqual([['SKU-2']]);
    expect(doSku(r, 'SKU/1')).toMatchObject({ enviavel: false, motivo: 'nao-confirmado' });
    expect(doSku(r, 'SKU-2')).toMatchObject({ enviavel: true });
  });
});

describe('the verdict, the quantity and the gate', () => {
  it('a refused link, a gone unit and a gate refusal: only what passed every earlier step reaches Amazon', async () => {
    const c = cenario();
    // Ambiguous: two live donos.
    produto(c, 'A1');
    produto(c, 'A2');
    vinculo(c, 'A1', 'l1', 'SKU-AMB');
    vinculo(c, 'A2', 'l1', 'SKU-AMB');
    // A wrapper whose member is gone.
    produto(c, 'W', { paiId: null, filhoUnicoId: 'M-SUMIDO' });
    vinculo(c, 'W', 'l1', 'SKU-SUMIDO');
    // AFN and a variation parent on Amazon.
    simples(c, 'SKU-AFN', 3);
    c.amazon.set(
      'SKU-AFN',
      listing('SKU-AFN', 3, {
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_NA', quantity: 3 }],
      }),
    );
    simples(c, 'SKU-PAI', 3);
    c.amazon.set(
      'SKU-PAI',
      listing('SKU-PAI', 3, {
        relationships: [
          {
            marketplaceId: MARKETPLACE_ID_BR,
            relationships: [{ type: 'VARIATION', childSkus: ['SKU-PAI-1'] }],
          },
        ],
      }),
    );
    simples(c, 'SKU-OK', 3);
    const r = completa(await c.avaliar(['SKU-AMB', 'SKU-SUMIDO', 'SKU-AFN', 'SKU-PAI', 'SKU-OK']));
    expect(buscas(c).map((b) => b.skus)).toEqual([['SKU-AFN', 'SKU-OK', 'SKU-PAI']]);
    expect(gets(c)).toEqual([]);
    expect(doSku(r, 'SKU-AMB')).toEqual({
      sku: 'SKU-AMB',
      enviavel: false,
      motivo: 'vinculo-ambiguo',
      vinculo: null,
      quantidadeErp: null,
    });
    expect(doSku(r, 'SKU-SUMIDO')).toMatchObject({
      enviavel: false,
      motivo: 'unidade-ausente',
      vinculo: { apto: true, unidadeId: 'M-SUMIDO' },
      quantidadeErp: null,
    });
    expect(doSku(r, 'SKU-AFN')).toMatchObject({ enviavel: false, motivo: 'afn', quantidadeErp: 3 });
    expect(doSku(r, 'SKU-PAI')).toMatchObject({ enviavel: false, motivo: 'pai' });
    expect(doSku(r, 'SKU-OK')).toMatchObject({ enviavel: true });
    expect(r.contagem).toMatchObject({
      skus: 5,
      enviaveis: 1,
      recusasHumanas: 1,
      porChave: { 'vinculo-ambiguo': 1, 'unidade-ausente': 1, afn: 1, pai: 1 },
    });
    expect(RECUSAS_HUMANAS_ESTOQUE_AMAZON.has('vinculo-ambiguo')).toBe(true);
  });

  it('the ERP quantity is the shared core’s: a kit’s component-min, a reservation subtracted', async () => {
    const c = cenario();
    produto(c, 'K', {
      ehKit: true,
      componentesKit: { CA: { quantidade: 2 }, CB: { quantidade: 1 } },
    });
    vinculo(c, 'K', 'l1', 'SKU-KIT');
    estoque(c, 'K', 1);
    estoque(c, 'CA', 9);
    estoque(c, 'CB', 5);
    c.amazon.set('SKU-KIT', listing('SKU-KIT', 0));
    simples(c, 'SKU-RES', 10);
    estoque(c, 'p-SKU-RES', 10, 3);
    const r = completa(await c.avaliar(['SKU-KIT', 'SKU-RES']));
    expect(doSku(r, 'SKU-KIT')).toMatchObject({
      enviavel: true,
      quantidadeErp: 4,
      quantidadeAmazon: 0,
      semLinha: false,
    });
    expect(doSku(r, 'SKU-RES')).toMatchObject({ enviavel: true, quantidadeErp: 7 });
  });

  it('★ zeroSemLinha: an enviável SKU whose 0 comes from NO row at the depósito', async () => {
    const c = cenario();
    produto(c, 'SEM');
    vinculo(c, 'SEM', 'l1', 'SKU-SEM');
    c.amazon.set('SKU-SEM', listing('SKU-SEM', 4));
    // NEAR-MISS: a row holding 0 is a 0, but not "no row".
    simples(c, 'SKU-ZERO', 0, 4);
    const r = completa(await c.avaliar(['SKU-SEM', 'SKU-ZERO']));
    expect(doSku(r, 'SKU-SEM')).toMatchObject({
      enviavel: true,
      quantidadeErp: 0,
      semLinha: true,
      contagens: ['zeroSemLinha'],
    });
    expect(doSku(r, 'SKU-ZERO')).toMatchObject({
      enviavel: true,
      quantidadeErp: 0,
      semLinha: false,
      contagens: [],
    });
    expect(r.contagem).toMatchObject({ zeroSemLinha: 1, porChave: { zeroSemLinha: 1 } });
  });

  it('NEAR-MISS: a refused SKU with no row is never counted zeroSemLinha', async () => {
    const c = cenario();
    produto(c, 'SEM');
    vinculo(c, 'SEM', 'l1', 'SKU-SEM');
    c.amazon.set(
      'SKU-SEM',
      listing('SKU-SEM', 4, {
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_NA', quantity: 4 }],
      }),
    );
    const r = completa(await c.avaliar(['SKU-SEM']));
    expect(r.contagem).toMatchObject({ zeroSemLinha: 0, porChave: { afn: 1 } });
  });

  it('the shapes the verdict and the gate count are carried per SKU and summed', async () => {
    const c = cenario();
    simples(c, 'SKU-SA', 2);
    c.fake.seed('produtos/p-SKU-SA/prodAmazon/l1', {
      contaAmazonOuterRef: REF_CONTA,
      sku: 'SKU-SA',
      asin: null,
    });
    c.amazon.set('SKU-SA', listing('SKU-SA', 2, { relationships: [] }));
    const r = completa(await c.avaliar(['SKU-SA']));
    expect(doSku(r, 'SKU-SA')).toMatchObject({
      enviavel: true,
      contagens: ['semAsinNoVinculo', 'semRelacoes'],
    });
    expect(r.contagem.porChave).toEqual({ semAsinNoVinculo: 1, semRelacoes: 1 });
  });

  it('a unit id that is not a document id (a corrupt filhoUnicoId) is never read: unidade-ausente, the batch goes on', async () => {
    const c = cenario();
    produto(c, 'W', { paiId: null, filhoUnicoId: 'x/y' });
    vinculo(c, 'W', 'l1', 'SKU-CORROMPIDO');
    simples(c, 'SKU-OK', 3);
    const r = completa(await c.avaliar(['SKU-CORROMPIDO', 'SKU-OK']));
    expect(doSku(r, 'SKU-CORROMPIDO')).toMatchObject({
      enviavel: false,
      motivo: 'unidade-ausente',
    });
    expect(doSku(r, 'SKU-OK')).toMatchObject({ enviavel: true });
    expect(c.fake.leituras.some((p) => p.includes('x/y'))).toBe(false);
    expect(c.fake.consultas.some((q) => q.filtros.some(([, v]) => v === 'x/y'))).toBe(false);
  });
});

describe('★ parity: every SKU gets the patch task’s own link verdict', () => {
  it('a batch of every resolver shape ⇒ per SKU, the verdict lerVinculoEstoqueAmazon + avaliarVinculoEstoqueAmazon give alone', async () => {
    const c = cenario();
    // Simple.
    simples(c, 'S-SIMPLES', 2);
    // Family-of-one wrapper → its member.
    produto(c, 'W', { paiId: null, filhoUnicoId: 'M' });
    produto(c, 'M', { paiId: 'W' });
    vinculo(c, 'W', 'l1', 'S-WRAPPER');
    estoque(c, 'M', 3);
    c.amazon.set('S-WRAPPER', listing('S-WRAPPER', 3));
    // A kit root with its one mirror child ⇒ apt.
    produto(c, 'K', { ehKit: true, paiId: null, filhoUnicoId: 'KM', componentesKit: {} });
    produto(c, 'KM', { paiId: 'K' });
    vinculo(c, 'K', 'l1', 'S-KIT');
    c.amazon.set('S-KIT', listing('S-KIT', 0));
    // A unit with two children ⇒ unidade-com-variacoes.
    produto(c, 'U2');
    produto(c, 'U2a', { paiId: 'U2', nome: 'a' });
    produto(c, 'U2b', { paiId: 'U2', nome: 'b' });
    vinculo(c, 'U2', 'l1', 'S-VARIACOES');
    // A child link carrying its parent's ASIN ⇒ filho-com-sku-do-pai (a parent
    // link of the SAME SKU would be a second dono, read as ambiguous first).
    produto(c, 'PAI');
    vinculo(c, 'PAI', 'lp', 'S-PAI-DO-FILHO', { asin: asinDe('S-FILHO') });
    produto(c, 'F');
    vinculo(c, 'F', 'l1', 'S-FILHO', {
      produtoAmazonPaiOuterRef: 'documents/produtos/PAI/prodAmazon/lp',
    });
    // An unreadable pointer, and a dangling one.
    produto(c, 'IL');
    vinculo(c, 'IL', 'l1', 'S-ILEGIVEL', { produtoAmazonPaiOuterRef: 'produtos/PAI' });
    produto(c, 'DG');
    vinculo(c, 'DG', 'l1', 'S-PENDENTE', {
      produtoAmazonPaiOuterRef: 'produtos/NINGUEM/prodAmazon/lx',
    });
    // A healthy child with a parent of another SKU and ASIN.
    produto(c, 'PAI2');
    vinculo(c, 'PAI2', 'lp', 'S-PAI2');
    produto(c, 'F2');
    vinculo(c, 'F2', 'l1', 'S-FILHO2', {
      produtoAmazonPaiOuterRef: 'produtos/PAI2/prodAmazon/lp',
    });
    estoque(c, 'F2', 1);
    c.amazon.set('S-FILHO2', listing('S-FILHO2', 1));
    // Ambiguous, a gone dono beside a live one, and no link at all.
    produto(c, 'A1');
    produto(c, 'A2');
    vinculo(c, 'A1', 'l1', 'S-AMBIGUO');
    vinculo(c, 'A2', 'l1', 'S-AMBIGUO');
    produto(c, 'VIVO');
    vinculo(c, 'VIVO', 'l1', 'S-UM-SUMIDO');
    vinculo(c, 'NAO-EXISTE', 'l1', 'S-UM-SUMIDO');
    estoque(c, 'VIVO', 2);
    c.amazon.set('S-UM-SUMIDO', listing('S-UM-SUMIDO', 2));
    // The opt-out, under this conta's key.
    produto(c, 'OPT', {
      statusProdutosMarketplace: { [`${CONTA}_${asinDe('S-OPTOUT')}`]: { enviarEstoque: false } },
    });
    vinculo(c, 'OPT', 'l1', 'S-OPTOUT');
    // The detector's limit: ten link docs.
    for (let i = 0; i < 10; i += 1) {
      produto(c, `LIM${i}`);
      vinculo(c, `LIM${i}`, 'l1', 'S-LIMITE');
    }
    const skus = [
      'S-SIMPLES',
      'S-WRAPPER',
      'S-KIT',
      'S-VARIACOES',
      'S-FILHO',
      'S-ILEGIVEL',
      'S-PENDENTE',
      'S-FILHO2',
      'S-AMBIGUO',
      'S-UM-SUMIDO',
      'S-OPTOUT',
      'S-LIMITE',
      'S-NENHUM',
    ];
    const r = completa(await c.avaliar(skus));
    const esperados: Record<string, string> = {};
    for (const sku of skus) {
      const sozinho = avaliarVinculoEstoqueAmazon(
        await lerVinculoEstoqueAmazon(asDb(c.fake), CONTA, sku),
      );
      const lote = doSku(r, sku);
      if (!sozinho.apto) {
        expect(lote, sku).toMatchObject({ enviavel: false, motivo: sozinho.motivo, vinculo: null });
        esperados[sku] = sozinho.motivo;
      } else {
        expect(lote.vinculo, sku).toEqual(sozinho);
        esperados[sku] = 'apto';
      }
    }
    // Anti-vacuity: the fixtures DO reach every verdict.
    expect(esperados).toEqual({
      'S-SIMPLES': 'apto',
      'S-WRAPPER': 'apto',
      'S-KIT': 'apto',
      'S-VARIACOES': 'unidade-com-variacoes',
      'S-FILHO': 'filho-com-sku-do-pai',
      'S-ILEGIVEL': 'pai-do-vinculo-ilegivel',
      'S-PENDENTE': 'pai-do-vinculo-ilegivel',
      'S-FILHO2': 'apto',
      'S-AMBIGUO': 'vinculo-ambiguo',
      'S-UM-SUMIDO': 'apto',
      'S-OPTOUT': 'envio-desligado',
      'S-LIMITE': 'vinculo-ambiguo',
      'S-NENHUM': 'produto-ausente',
    });
    expect(doSku(r, 'S-WRAPPER')).toMatchObject({ enviavel: true, quantidadeErp: 3 });
    expect(doSku(r, 'S-KIT')).toMatchObject({ enviavel: true });
  });
});

describe('★ the masks and the dedup, on the counting fake db', () => {
  it('every read is masked: the link query projected, the donos and the other units masked, the estoque rows masked', async () => {
    const c = cenario();
    c.fake.exigirMascaraEm('prodAmazon');
    c.fake.exigirMascaraEm('produtos');
    c.fake.exigirMascaraEm('estoques');
    produto(c, 'W', { paiId: null, filhoUnicoId: 'M', componentesKit: null });
    produto(c, 'M', { paiId: 'W' });
    vinculo(c, 'W', 'l1', 'SKU-W');
    estoque(c, 'M', 3);
    c.amazon.set('SKU-W', listing('SKU-W', 3));
    completa(await c.avaliar(['SKU-W']));
    expect(c.fake.consultas[0]).toMatchObject({
      colecao: 'prodAmazon',
      grupo: true,
      selecao: [...CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON],
    });
    const leitura = (caminho: string) =>
      c.fake.leiturasDetalhadas.filter((l) => l.caminho === caminho);
    expect(leitura('produtos/W')).toEqual([
      expect.objectContaining({
        via: 'getAll',
        mascara: [...CAMPOS_LEITURA_DONOS_AVALIACAO_ESTOQUE_AMAZON],
      }),
    ]);
    expect(leitura('produtos/M')).toEqual([
      expect.objectContaining({
        via: 'getAll',
        mascara: [...CAMPOS_LEITURA_UNIDADES_AVALIACAO_ESTOQUE_AMAZON],
      }),
    ]);
    expect(leitura(`produtos/M/estoques/${makeEstoqueUid('M', DEP)}`)).toEqual([
      expect.objectContaining({ via: 'getAll', mascara: [...CAMPOS_LINHA_ESTOQUE_AMAZON] }),
    ]);
    // Both masks carry the family read's fields: the unit is read once.
    expect(CAMPOS_LEITURA_DONOS_AVALIACAO_ESTOQUE_AMAZON).toEqual([
      'ehKit',
      'paiId',
      'filhoUnicoId',
      'statusProdutosMarketplace',
      'ehKitVirtual',
      'publicado',
      'componentesKit',
      'timestamp',
    ]);
    expect(CAMPOS_LEITURA_UNIDADES_AVALIACAO_ESTOQUE_AMAZON).toEqual([
      'ehKit',
      'paiId',
      'filhoUnicoId',
      'ehKitVirtual',
      'publicado',
      'componentesKit',
      'timestamp',
    ]);
  });

  it('★ the donos, the units and the children deduplicated ACROSS the SKUs: each produto read once', async () => {
    const c = cenario();
    // Two SKUs under one wrapper W (unit M), a third SKU under M itself, a
    // fourth under a simple produto P.
    produto(c, 'W', { paiId: null, filhoUnicoId: 'M' });
    produto(c, 'M', { paiId: 'W' });
    vinculo(c, 'W', 'l1', 'SKU-1');
    vinculo(c, 'W', 'l2', 'SKU-2');
    vinculo(c, 'M', 'l1', 'SKU-3');
    estoque(c, 'M', 3);
    simples(c, 'SKU-4', 5);
    for (const sku of ['SKU-1', 'SKU-2', 'SKU-3']) c.amazon.set(sku, listing(sku, 3));
    const r = completa(await c.avaliar(['SKU-1', 'SKU-2', 'SKU-3', 'SKU-4']));
    expect(r.skus.map((s) => [s.sku, s.enviavel, s.enviavel ? s.quantidadeErp : null])).toEqual([
      ['SKU-1', true, 3],
      ['SKU-2', true, 3],
      ['SKU-3', true, 3],
      ['SKU-4', true, 5],
    ]);
    const produtosLidos = c.fake.leiturasDetalhadas.filter((l) =>
      /^produtos\/[^/]+$/.test(l.caminho),
    );
    // M is a dono (of SKU-3) AND the unit of SKU-1/2: read ONCE, with the donos.
    expect(produtosLidos.map((l) => l.caminho).sort()).toEqual([
      'produtos/M',
      'produtos/W',
      'produtos/p-SKU-4',
    ]);
    expect(new Set(produtosLidos.map((l) => l.chamada)).size).toBe(1);
    // One children seek per DISTINCT unit (M and p-SKU-4), never per SKU.
    const seeks = c.fake.consultas.filter((q) => q.colecao === 'produtos');
    expect(seeks.map((q) => q.filtros)).toEqual([[['paiId', 'M']], [['paiId', 'p-SKU-4']]]);
    // Each unit's estoque row once.
    const estoques = c.fake.leiturasDetalhadas.filter((l) => l.caminho.includes('/estoques/'));
    expect(estoques.map((l) => l.caminho).sort()).toEqual([
      `produtos/M/estoques/${makeEstoqueUid('M', DEP)}`,
      `produtos/p-SKU-4/estoques/${makeEstoqueUid('p-SKU-4', DEP)}`,
    ]);
    expect(r.contagem.leituras).toMatchObject({ consultas: 4, produtos: 3, filhos: 2 });
  });

  it('★ a parent pointer shared by 20 children is read ONCE', async () => {
    const c = cenario();
    produto(c, 'PAI');
    vinculo(c, 'PAI', 'lp', 'SKU-PAI-X');
    const skus: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const sku = `SKU-FILHO-${String(i).padStart(2, '0')}`;
      skus.push(sku);
      simples(c, sku, 1);
      c.fake.seed(`produtos/p-${sku}/prodAmazon/l1`, {
        contaAmazonOuterRef: REF_CONTA,
        sku,
        asin: asinDe(sku),
        produtoAmazonPaiOuterRef:
          i % 2 === 0 ? 'documents/produtos/PAI/prodAmazon/lp' : 'produtos/PAI/prodAmazon/lp',
      });
    }
    const r = completa(await c.avaliar(skus));
    expect(r.contagem.enviaveis).toBe(20);
    expect(
      c.fake.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/PAI/prodAmazon/lp'),
    ).toEqual([expect.objectContaining({ via: 'getAll', mascara: ['sku', 'asin'] })]);
    expect(r.contagem.leituras.ponteiros).toBe(1);
  });

  it('only the BOUND dono’s links’ pointers are read, never a gone dono’s', async () => {
    const c = cenario();
    produto(c, 'PAI');
    vinculo(c, 'PAI', 'lp', 'SKU-OUTRO');
    simples(c, 'SKU-V', 2);
    // A second link doc of the SKU, under a produto that is gone, pointing at PAI.
    vinculo(c, 'SUMIDO', 'l1', 'SKU-V', {
      produtoAmazonPaiOuterRef: 'produtos/PAI/prodAmazon/lp',
    });
    const r = completa(await c.avaliar(['SKU-V']));
    expect(doSku(r, 'SKU-V')).toMatchObject({ enviavel: true });
    expect(c.fake.leituras.some((p) => p.includes('/prodAmazon/'))).toBe(false);
    expect(r.contagem.leituras.ponteiros).toBe(0);
  });

  it('kits sharing a component: the component’s row is read once', async () => {
    const c = cenario();
    produto(c, 'K1', { ehKit: true, componentesKit: { C: { quantidade: 2 } } });
    produto(c, 'K2', { ehKit: true, componentesKit: { C: { quantidade: 3 } } });
    vinculo(c, 'K1', 'l1', 'SKU-K1');
    vinculo(c, 'K2', 'l1', 'SKU-K2');
    estoque(c, 'C', 9);
    c.amazon.set('SKU-K1', listing('SKU-K1', 4));
    c.amazon.set('SKU-K2', listing('SKU-K2', 3));
    const r = completa(await c.avaliar(['SKU-K1', 'SKU-K2']));
    // No row of their own, but a component's: the quantity stands on a row.
    expect(doSku(r, 'SKU-K1')).toMatchObject({ quantidadeErp: 4, semLinha: false });
    expect(doSku(r, 'SKU-K2')).toMatchObject({ quantidadeErp: 3, semLinha: false });
    expect(
      c.fake.leiturasDetalhadas.filter((l) => l.caminho.startsWith('produtos/C/estoques/')),
    ).toHaveLength(1);
  });

  it('★ the donos, then the other units, are read in getAll slices of at most 300', async () => {
    const c = cenario();
    // 301 family-of-one wrappers: 301 donos, then their 301 members as units.
    const skus: string[] = [];
    for (let i = 0; i < 301; i += 1) {
      const n = String(i).padStart(3, '0');
      const sku = `SKU-W-${n}`;
      skus.push(sku);
      produto(c, `W${n}`, { paiId: null, filhoUnicoId: `M${n}` });
      produto(c, `M${n}`, { paiId: `W${n}` });
      vinculo(c, `W${n}`, 'l1', sku);
      estoque(c, `M${n}`, 2);
      c.amazon.set(sku, listing(sku, 2));
    }
    const r = completa(await c.avaliar(skus));
    expect(r.contagem.enviaveis).toBe(301);
    const porChamada = new Map<number, { donos: number; unidades: number }>();
    for (const l of c.fake.leiturasDetalhadas) {
      const m = /^produtos\/([WM])\d+$/.exec(l.caminho);
      if (m === null || l.chamada === undefined) continue;
      const atual = porChamada.get(l.chamada) ?? { donos: 0, unidades: 0 };
      if (m[1] === 'W') atual.donos += 1;
      else atual.unidades += 1;
      porChamada.set(l.chamada, atual);
    }
    expect([...porChamada.values()]).toEqual([
      { donos: 300, unidades: 0 },
      { donos: 1, unidades: 0 },
      { donos: 0, unidades: 300 },
      { donos: 0, unidades: 1 },
    ]);
    expect(r.contagem.leituras.produtos).toBe(602);
  });

  it('★ the parent pointers are read in calls of at most 300 distinct refs', async () => {
    const c = cenario();
    const skus: string[] = [];
    for (let i = 0; i < 301; i += 1) {
      const n = String(i).padStart(3, '0');
      const sku = `SKU-F-${n}`;
      skus.push(sku);
      produto(c, `PAI${n}`);
      vinculo(c, `PAI${n}`, 'lp', `SKU-P-${n}`);
      simples(c, sku, 1);
      c.fake.seed(`produtos/p-${sku}/prodAmazon/l1`, {
        contaAmazonOuterRef: REF_CONTA,
        sku,
        asin: asinDe(sku),
        produtoAmazonPaiOuterRef: `produtos/PAI${n}/prodAmazon/lp`,
      });
    }
    const r = completa(await c.avaliar(skus));
    expect(r.contagem.enviaveis).toBe(301);
    const porChamada = new Map<number, number>();
    for (const l of c.fake.leiturasDetalhadas) {
      if (!/^produtos\/PAI\d+\/prodAmazon\/lp$/.test(l.caminho) || l.chamada === undefined) {
        continue;
      }
      porChamada.set(l.chamada, (porChamada.get(l.chamada) ?? 0) + 1);
    }
    expect([...porChamada.values()]).toEqual([300, 1]);
    expect(r.contagem.leituras.ponteiros).toBe(301);
  });

  it('a SKU asked twice is evaluated once; nothing asked ⇒ complete, nothing read, nothing called', async () => {
    const c = cenario();
    simples(c, 'SKU-DUP', 2);
    const r = completa(await c.avaliar(['SKU-DUP', 'SKU-DUP']));
    expect(r.skus.map((s) => s.sku)).toEqual(['SKU-DUP']);
    expect(r.contagem.leituras.consultas).toBe(1);
    expect(buscas(c)[0]?.skus).toEqual(['SKU-DUP']);

    const vazio = cenario();
    const nada = completa(await vazio.avaliar([]));
    expect(nada.skus).toEqual([]);
    // Only the context's own conta read.
    expect(vazio.fake.leituras.filter((p) => p.startsWith('produtos/'))).toEqual([]);
    expect(vazio.fake.consultas).toEqual([]);
    expect(vazio.chamadas).toEqual([]);
  });
});

describe('the deadline', () => {
  it('already past ⇒ prazo before the link queries: nothing read, nothing called', async () => {
    const c = cenario();
    varios(c, 2);
    const r = await c.avaliar(['SKU-AV-001', 'SKU-AV-002'], { prazoMs: AGORA_MS });
    expect(r).toMatchObject({ tipo: 'prazo', etapa: ETAPA_AVALIACAO_ESTOQUE_AMAZON.vinculos });
    expect(c.fake.consultas).toEqual([]);
    expect(c.chamadas).toEqual([]);
  });

  it('reached while pacing the searches ⇒ prazo before the next search: nothing more is called', async () => {
    const c = cenario();
    const skus = varios(c, 41);
    // The second search would start at +220 ms: the deadline is +100 ms.
    const r = await c.avaliar(skus, { prazoMs: AGORA_MS + 100 });
    expect(r).toMatchObject({
      tipo: 'prazo',
      etapa: ETAPA_AVALIACAO_ESTOQUE_AMAZON.busca,
      contagem: { leituras: { buscas: 1, gets: 0 } },
    });
    expect(buscas(c)).toHaveLength(1);
  });

  it('NEAR-MISS: a deadline exactly at the second search’s start still stops it; one ms later lets it run', async () => {
    const parado = cenario();
    const skus = varios(parado, 21);
    expect(await parado.avaliar(skus, { prazoMs: AGORA_MS + 220 })).toMatchObject({
      tipo: 'prazo',
    });
    const segue = cenario();
    varios(segue, 21);
    expect(await segue.avaliar(skus, { prazoMs: AGORA_MS + 221 })).toMatchObject({
      tipo: 'completa',
    });
  });

  it('reached between the GETs ⇒ prazo before the next one', async () => {
    const c = cenario();
    const skus = varios(c, 3);
    for (const sku of skus) c.omitidos.add(sku);
    const r = await c.avaliar(skus, { prazoMs: AGORA_MS + 400 });
    expect(r).toMatchObject({ tipo: 'prazo', etapa: ETAPA_AVALIACAO_ESTOQUE_AMAZON.leitura });
    expect(gets(c)).toHaveLength(2);
  });
});

describe('the input, checked before anything is read', () => {
  it.each<[string, Partial<OpcoesAvaliacaoEstoqueAmazon>]>([
    ['a depósito that is not a document id', { depositoId: 'a/b' }],
    ['a deadline that is not a ms instant', { prazoMs: 1.5 }],
    ['a negative deadline', { prazoMs: -1 }],
    ['a fractional GET cap', { maxGets: 1.5 }],
    ['a negative GET cap', { maxGets: -1 }],
  ])('%s ⇒ RangeError, nothing read', async (_n, opcoes) => {
    const c = cenario();
    varios(c, 1);
    await expect(c.avaliar(['SKU-AV-001'], opcoes)).rejects.toBeInstanceOf(RangeError);
    expect(c.fake.leituras.filter((p) => p.startsWith('produtos/'))).toEqual([]);
    expect(c.fake.consultas).toEqual([]);
  });

  it('a conta id outside its grammar ⇒ RangeError, nothing read', async () => {
    const fake = new FakeDb();
    const log = loggerEspiao();
    await expect(
      avaliarSkusEstoqueAmazon(
        {
          contexto: {
            integracaoId: 'conta/invalida',
            cliente: { get: () => Promise.reject(new Error('teste: nenhuma leitura')) },
            obterAcesso: () => Promise.reject(new Error('teste: nenhuma renovação')),
          },
          db: asDb(fake),
          logger: log.logger,
          agora: () => AGORA_MS,
          sellerId: SPID_A,
          esperar: () => Promise.resolve(),
        },
        ['SKU-1'],
        { depositoId: DEP, prazoMs: PRAZO_LONGE, maxGets: null },
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fake.operacoes).toBe(0);
  });
});

describe('(12-f) the link docs a caller ALREADY read (a reconcile page’s dedupe)', () => {
  it('★ a SKU in vinculosLidos is not queried again; the others are; the answer is the one a full run gives', async () => {
    const c = cenario();
    const skus = varios(c, 3, 'SKU-LIDO-');
    const inteira = completa(await c.avaliar(skus));
    const consultasInteiras = c.fake.consultas.length;
    const lidos = await lerVinculosDosSkusEstoqueAmazon(asDb(c.fake), CONTA, skus.slice(0, 2), {
      agora: () => c.relogio,
      prazoMs: PRAZO_LONGE,
    });
    expect(lidos?.size).toBe(2);
    // An entry for a SKU NOT asked is ignored.
    const comExtra = new Map(lidos ?? []);
    comExtra.set('SKU-NAO-PEDIDO', { tipo: 'limite' });
    const antes = c.fake.consultas.length;
    const r = completa(await c.avaliar(skus, { vinculosLidos: comExtra }));
    const resolver = c.fake.consultas
      .slice(antes)
      .filter((q) => q.colecao === 'prodAmazon' && q.filtros.some(([f]) => f === 'sku'));
    expect(resolver.map((q) => q.filtros.find(([f]) => f === 'sku')?.[1])).toEqual([skus[2]]);
    expect(r.contagem.leituras.consultas).toBe(1);
    expect(r.skus).toEqual(inteira.skus);
    expect(consultasInteiras).toBeGreaterThan(0);
  });

  it('the shared reader projects every query exactly as the evaluator does, and answers null past the deadline (nothing read)', async () => {
    const c = cenario();
    const skus = varios(c, 2, 'SKU-LIDO-');
    const antes = c.fake.consultas.length;
    expect(
      await lerVinculosDosSkusEstoqueAmazon(asDb(c.fake), CONTA, skus, {
        agora: () => c.relogio,
        prazoMs: c.relogio,
      }),
    ).toBeNull();
    expect(c.fake.consultas.length).toBe(antes);
    await lerVinculosDosSkusEstoqueAmazon(asDb(c.fake), CONTA, [...skus, skus[0] ?? ''], {
      agora: () => c.relogio,
      prazoMs: PRAZO_LONGE,
    });
    const novas = c.fake.consultas.slice(antes);
    // Deduplicated, and projected to the verdict's fields.
    expect(novas).toHaveLength(2);
    for (const q of novas) expect(q.selecao).toEqual([...CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON]);
  });
});
