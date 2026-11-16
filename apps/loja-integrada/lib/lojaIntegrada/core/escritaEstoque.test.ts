/**
 * The write engine's stock seam (master plan step 12, PR 12-d): the two stock
 * kinds through the engine's own requirements, against the shared stateful
 * platform (`testing/plataformaEscritaLi.ts`, which models the store's stock
 * rows keyed by PRODUCT id). The order kinds' own suite is `escrita.test.ts`.
 *
 * No Loja Integrada call: the platform is a stub `fetch` handed to the write
 * context; the global `fetch` is stubbed to throw for every test of this file,
 * and the unit config's network kill-switch fails anything that would reach a
 * real host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ESTOQUE_FIXO_ESCRITA_LI,
  LiConfigError,
  LiHttpError,
  LiThrottleError,
} from '@delfrance/integrations-loja-integrada';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { FakeDb, type DocData, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  gravadorDeLog,
  seedConta,
  seedCredencial,
  type LinhaGravada,
} from '../testing/fixtures';
import { ID_ENVIO_LI, ID_PRODUTO_LI, NUMERO_LI } from '../testing/pedidosLi';
import {
  CAMINHO_ESTOQUE_PRODUTO_LI,
  CAMINHO_PEDIDO_LI,
  ID_LINHA_ESTOQUE_LI,
  type PlataformaEscritaLi,
  criarPlataformaEscritaLi,
  linhaEstoqueLi,
  naProxima,
  respostaJson,
} from '../testing/plataformaEscritaLi';
import { __setRelogioDoCacheParaTestes } from './contaCache';
import {
  type ContextoEscritaLojaIntegrada,
  loadLojaIntegradaContextoEscrita,
} from './contextoEscrita';
import {
  type BaseEscritaLi,
  type BaseLidaLi,
  CAMPO_DO_TIPO_ESCRITA_LI,
  FLUXO_DO_TIPO_ESCRITA_LI,
  LEITURA_PREVIA_LI,
  POLITICA_CAMPO_ESCRITA_LI,
  type PayloadEscritaLi,
  conferirEscritaLi,
  confirmarCredencialLi,
  criarMotorEscritaLi,
  escreverLi,
  iniciarEscritaLi,
  lerBaseLi,
  lerDeVoltaLi,
  lerHistoricoSituacaoParaConferenciaLi,
} from './escrita';
import { REDIGIDO } from './redacao';
import { RITMO_ESCRITA_LI_MS } from './ritmo';
import {
  type AlvoLi,
  type AmbienteLi,
  CANARIO_ENV_LI,
  CHAMADAS_ENV_LI,
  FLUXO_LI,
  MODO_LI,
  VALVULA_ENV_LI,
} from './valvulas';

const ID = 'conta-li-1';
/** The stock target: the PRODUCT id, never the stock row's own id. */
const ALVO: AlvoLi = { contaId: ID, recurso: ID_PRODUTO_LI };
const CAMINHO = CAMINHO_ESTOQUE_PRODUTO_LI;
const ESPERA = `espera ${String(RITMO_ESCRITA_LI_MS)}`;

const ESTOQUE = { tipo: 'estoque-produto', alvo: ALVO } as const;
const LOTE = { tipo: 'estoque-produto-lote', alvo: ALVO } as const;

/** The stock body a stock write carries: the package's fixed leaves and `quantidade`. */
function corpo(quantidade: number): PayloadEscritaLi {
  return { campo: 'estoque', valor: { ...ESTOQUE_FIXO_ESCRITA_LI, quantidade } };
}

/** The read switch on, ONE flow's valve and canary as given (`null`: unset). */
function ambiente(
  fluxo: 'estoque' | 'rastreio',
  modo: string,
  canario: string | null = '*',
): AmbienteLi {
  return {
    [CHAMADAS_ENV_LI]: MODO_LI.on,
    [VALVULA_ENV_LI[fluxo]]: modo,
    ...(canario === null ? {} : { [CANARIO_ENV_LI[fluxo]]: canario }),
  };
}

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  // Per file: nothing here may reach the global `fetch` — every client gets the stub platform.
  vi.stubGlobal('fetch', () => {
    throw new Error('escritaEstoque.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

/** The store with ONE stock row for `ID_PRODUTO_LI`: 3 in stock, 2 reserved (1 available). */
function plataforma(over: DocData = {}): PlataformaEscritaLi {
  return criarPlataformaEscritaLi({
    estoque: [linhaEstoqueLi(ID_PRODUTO_LI, { quantidade: 3, quantidade_reservada: 2, ...over })],
  });
}

interface Montagem {
  readonly p: PlataformaEscritaLi;
  readonly linhas: LinhaGravada[];
  readonly contexto: ContextoEscritaLojaIntegrada;
  readonly motor: ReturnType<typeof criarMotorEscritaLi>;
  /** Every request and every engine line, in order (`METODO caminho` / `log <evento>`). */
  readonly linhaDoTempo: string[];
}

async function montar(
  o: {
    fluxo?: 'estoque' | 'rastreio';
    modo?: string;
    canario?: string | null;
    p?: PlataformaEscritaLi;
  } = {},
): Promise<Montagem> {
  const fluxo = o.fluxo ?? 'estoque';
  const db = new FakeDb();
  seedConta(db, ID);
  seedCredencial(db, ID);
  const p = o.p ?? plataforma();
  const gravador = gravadorDeLog();
  const linhaDoTempo: string[] = [];
  const amb = ambiente(fluxo, o.modo ?? MODO_LI.on, o.canario === undefined ? '*' : o.canario);
  const inicio = iniciarEscritaLi(FLUXO_LI[fluxo], amb, { conta: ID, escrever: gravador.escrever });
  if (inicio.kind !== 'ativo') throw new TypeError('montar: a válvula está desligada');
  const fetch: typeof globalThis.fetch = (input, init) => {
    linhaDoTempo.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return p.fetch(input, init);
  };
  const contexto = await loadLojaIntegradaContextoEscrita(asDb(db), ID, {
    ambiente: amb,
    esperar: p.esperar,
    fetch,
    registro: { escrever: gravador.escrever, fluxo: FLUXO_LI[fluxo] },
  });
  const motor = criarMotorEscritaLi({
    inicio,
    contexto,
    agora: () => AGORA_MS,
    inicioDaTarefaMs: AGORA_MS,
    registro: {
      escrever: (severidade, mensagem, campos) => {
        gravador.escrever(severidade, mensagem, campos);
        linhaDoTempo.push(`log ${String(campos.evento)}`);
      },
      tentativa: 1,
      idTarefa: 't-1',
    },
  });
  return { p, linhas: gravador.linhas, contexto, motor, linhaDoTempo };
}

function lida(base: BaseEscritaLi): BaseLidaLi {
  if (base.kind !== 'lida') throw new TypeError(`base ${base.kind}`);
  return base;
}

const doEvento = (linhas: readonly LinhaGravada[], evento: string) =>
  linhas.filter((l) => l.campos.evento === evento);

/** The store's row as a GET answers it, with `over` applied (a read-back near-miss). */
const linhaComo = (over: DocData) => () =>
  respostaJson(200, linhaEstoqueLi(ID_PRODUTO_LI, { quantidade_reservada: 2, ...over }));

/* -------------------------------------------------------------------------- */
/*                 The kinds' rows: reader, read-back, field, flow            */
/* -------------------------------------------------------------------------- */

describe('the stock kinds in the engine’s tables', () => {
  it('two stock rows: one reader (the stock detail), a read-back call for one product and NONE for a lote', () => {
    expect(Object.keys(LEITURA_PREVIA_LI).sort()).toEqual([
      'estoque-produto',
      'estoque-produto-lote',
      'objeto-envio',
      'situacao-pedido',
    ]);
    expect(LEITURA_PREVIA_LI['estoque-produto']).toEqual({
      leitura: 'produto-estoque',
      leituraDeVolta: 'recurso',
      obrigatoria: true,
      ausente: 'dry-run',
    });
    expect(LEITURA_PREVIA_LI['estoque-produto-lote']).toEqual({
      leitura: 'produto-estoque',
      leituraDeVolta: 'lista',
      obrigatoria: true,
      ausente: 'dry-run',
    });
    expect(CAMPO_DO_TIPO_ESCRITA_LI).toEqual({
      'objeto-envio': 'objeto',
      'situacao-pedido': 'codigo',
      'estoque-produto': 'estoque',
      'estoque-produto-lote': 'estoque',
    });
    expect(POLITICA_CAMPO_ESCRITA_LI).toEqual({
      objeto: 'valor',
      codigo: 'valor',
      estoque: 'valor',
    });
    expect(FLUXO_DO_TIPO_ESCRITA_LI).toEqual({
      'objeto-envio': FLUXO_LI.rastreio,
      'situacao-pedido': FLUXO_LI.rastreio,
      'estoque-produto': FLUXO_LI.estoque,
      'estoque-produto-lote': FLUXO_LI.estoque,
    });
    // A kind without a row does not compile, and neither does a reader no row names.
    // @ts-expect-error — `catalogo` is not a write kind
    expect(LEITURA_PREVIA_LI.catalogo).toBeUndefined();
  });

  it('a reader no row names does not compile, and is refused with nothing sent', async () => {
    const m = await montar();
    // @ts-expect-error — `pagina` is not a pre-write reader
    await expect(lerBaseLi(m.motor, ALVO, 'pagina')).rejects.toThrow(TypeError);
    expect(m.p.requisicoes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                  The write lands — and the restore is what lets it         */
/* -------------------------------------------------------------------------- */

describe('estoque-produto under `on`: the deciding GET, the restore line, ONE PUT', () => {
  it('ends `enviado`, NOT `sem-restauracao`: GET then PUT on the no-slash path, the four leaves unquoted', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    const r = await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    // Before step 12's restore branch this very run ended `sem-restauracao`, with no PUT.
    expect(r.kind).toBe('enviado');
    expect(base.restauracao).toBe(true);
    expect(m.p.chamadas()).toEqual([`GET ${CAMINHO}`, `PUT ${CAMINHO}`]);
    expect(m.p.puts().map((x) => x.corpo)).toEqual([
      { gerenciado: true, quantidade: 7, situacao_em_estoque: 0, situacao_sem_estoque: -1 },
    ]);
    expect(m.p.textosDosPuts).toEqual([
      '{"gerenciado":true,"quantidade":7,"situacao_em_estoque":0,"situacao_sem_estoque":-1}',
    ]);
    // The store applied it: the quantity, and its own available figure recomputed.
    expect(m.p.estado.estoque.get(ID_PRODUTO_LI)).toMatchObject({
      quantidade: 7,
      quantidade_disponivel: 5,
    });
    expect(m.linhaDoTempo).toEqual([
      `GET ${CAMINHO}`,
      'log restauracao',
      `PUT ${CAMINHO}`,
      'log escrita',
    ]);
    expect(doEvento(m.linhas, 'escrita').map((l) => l.campos)).toEqual([
      expect.objectContaining({
        recurso: ID_PRODUTO_LI,
        tipo: 'estoque-produto',
        campo: 'estoque',
        resultado: 'aplicada',
        status: 200,
      }),
    ]);
  });

  it('the restore line carries the store’s row VERBATIM — its quantity and its reservation — under the catalogue policy', async () => {
    // Pairwise distinct on purpose: a swapped or defaulted leaf cannot read as right.
    const m = await montar({ p: plataforma({ quantidade_disponivel: 1 }) });
    await lerBaseLi(m.motor, ALVO, 'produto-estoque');
    const [linha, ...outras] = doEvento(m.linhas, 'restauracao');
    expect(outras).toEqual([]);
    expect(linha?.severidade).toBe('INFO');
    expect(linha?.campos).toMatchObject({
      recurso: ID_PRODUTO_LI,
      caminho: CAMINHO,
      status: 200,
      politica: 'catalogo',
    });
    const corpoDaLinha = JSON.parse(String(linha?.campos.corpo)) as Record<string, unknown>;
    expect(corpoDaLinha.quantidade).toBe(3);
    expect(corpoDaLinha.quantidade_reservada).toBe(2);
    expect(corpoDaLinha.quantidade_disponivel).toBe(1);
    expect(corpoDaLinha.id).toBe(ID_LINHA_ESTOQUE_LI);
    expect(corpoDaLinha.produto).toBe(`/api/v1/produto/${String(ID_PRODUTO_LI)}`);
    // ⚠️ NEAR-MISS: the line is the row itself, byte for byte — not a near copy.
    expect(linha?.campos.corpo).toBe(JSON.stringify(m.p.estado.estoque.get(ID_PRODUTO_LI)));
    expect(corpoDaLinha.quantidade_reservada).not.toBe(0);
  });

  it('a row with an unknown extra leaf still writes: the restore line keeps its KEY, never its value', async () => {
    const m = await montar({ p: plataforma({ novo_campo: { contato: 'loja@exemplo.invalid' } }) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    const corpoDaLinha = JSON.parse(
      String(doEvento(m.linhas, 'restauracao')[0]?.campos.corpo),
    ) as Record<string, unknown>;
    expect(corpoDaLinha.novo_campo).toEqual({ contato: REDIGIDO });
    expect(corpoDaLinha.quantidade_reservada).toBe(2);
    expect((await escreverLi(m.motor, ESTOQUE, corpo(4), base)).kind).toBe('enviado');
  });

  it('estoque-produto-lote: the same GET and PUT, and NO read-back call — one asked for is a TypeError, nothing sent, no wait', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    expect((await escreverLi(m.motor, LOTE, corpo(7), base)).kind).toBe('enviado');
    expect(m.p.chamadas()).toEqual([`GET ${CAMINHO}`, `PUT ${CAMINHO}`]);
    const marco = m.p.eventos.length;
    // @ts-expect-error — a lote has no read-back call (its row reads the list's next walk)
    const volta = lerDeVoltaLi(m.motor, ALVO, 'estoque-produto-lote');
    await expect(volta).rejects.toThrow(TypeError);
    expect(m.p.eventos.slice(marco)).toEqual([]);
    expect(m.p.chamadas()).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The read-back and its deriva                       */
/* -------------------------------------------------------------------------- */

describe('estoque-produto’s read-back: a SEPARATE GET, compared on the four written leaves', () => {
  it('the PUT is the only request of the write; the read-back is its own GET, two intervals later', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    const marco = m.p.eventos.length;
    await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    expect(m.p.eventos.slice(marco)).toEqual([`PUT ${CAMINHO}`]);
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'estoque-produto');
    expect(m.p.eventos.slice(marco + 1)).toEqual([ESPERA, ESPERA, `GET ${CAMINHO}`]);
    if (!leitura.verificado) throw new TypeError('não verificada');
    expect(leitura.leitura).toBe('produto-estoque');
    expect(conferirEscritaLi(m.motor, ESTOQUE, corpo(7), leitura)).toBe('igual');
    expect(doEvento(m.linhas, 'deriva')).toEqual([]);
  });

  it('the pacer: two intervals before the deciding GET and before the read-back, none between the GET and its PUT', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    await lerDeVoltaLi(m.motor, ALVO, 'estoque-produto');
    expect(m.p.eventos).toEqual([
      ESPERA,
      ESPERA,
      `GET ${CAMINHO}`,
      `PUT ${CAMINHO}`,
      ESPERA,
      ESPERA,
      `GET ${CAMINHO}`,
    ]);
  });

  it('EQUAL pair: a read-back holding exactly the body, its keys in another order ⇒ `igual`, no deriva line', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    m.p.fila.push(
      naProxima(CAMINHO, 'GET', () =>
        respostaJson(200, {
          situacao_sem_estoque: -1,
          situacao_em_estoque: 0,
          resource_uri: `/api/v1/produto_estoque/${String(ID_PRODUTO_LI)}`,
          quantidade_reservada: 2,
          quantidade_disponivel: 5,
          quantidade: 7,
          produto: `/api/v1/produto/${String(ID_PRODUTO_LI)}`,
          id: ID_LINHA_ESTOQUE_LI,
          gerenciado: true,
        }),
      ),
    );
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'estoque-produto');
    if (!leitura.verificado) throw new TypeError('não verificada');
    expect(conferirEscritaLi(m.motor, ESTOQUE, corpo(7), leitura)).toBe('igual');
    expect(doEvento(m.linhas, 'deriva')).toEqual([]);
  });

  it.each([
    ['a quantity one below what was written', { quantidade: 6 }],
    ['the same quantity, the product unmanaged', { quantidade: 7, gerenciado: false }],
    [
      'the same quantity, another out-of-stock situação',
      { quantidade: 7, situacao_sem_estoque: 0 },
    ],
    ['the same quantity, another in-stock situação', { quantidade: 7, situacao_em_estoque: 3 }],
  ])('⚠️ NEAR-MISS: a read-back holding %s ⇒ `deriva` and ONE WARNING line', async (_c, over) => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    m.p.fila.push(naProxima(CAMINHO, 'GET', linhaComo(over)));
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'estoque-produto');
    if (!leitura.verificado) throw new TypeError('não verificada');
    expect(conferirEscritaLi(m.motor, ESTOQUE, corpo(7), leitura)).toBe('deriva');
    const derivas = doEvento(m.linhas, 'deriva');
    expect(derivas).toHaveLength(1);
    expect(derivas[0]?.severidade).toBe('WARNING');
    expect(derivas[0]?.campos).toMatchObject({
      recurso: ID_PRODUTO_LI,
      tipo: 'estoque-produto',
      campo: 'estoque',
      politica: 'valor',
      escrito: JSON.stringify(corpo(7).valor),
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                     A run that may not write: ONE diff line                */
/* -------------------------------------------------------------------------- */

describe('estoque-produto not `on`: the deciding read, its restore line, ONE diff line, no PUT', () => {
  it.each([
    ['the valve at dry-run', MODO_LI.dryRun, '*', 'valvula'],
    ['`on` outside the canary', MODO_LI.on, 'outra-conta:1', 'fora-do-canario'],
  ])('%s ⇒ `nao-enviado`, nothing sent', async (_c, modo, canario, motivo) => {
    const m = await montar({ modo, canario });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    const r = await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    expect(r).toEqual({ kind: 'nao-enviado', motivo });
    expect(m.p.chamadas()).toEqual([`GET ${CAMINHO}`]);
    expect(m.p.puts()).toEqual([]);
    expect(doEvento(m.linhas, 'restauracao')).toHaveLength(1);
    expect(doEvento(m.linhas, 'escrita')).toEqual([]);
    const diffs = doEvento(m.linhas, 'diff');
    expect(diffs.map((l) => l.campos)).toEqual([
      expect.objectContaining({
        recurso: ID_PRODUTO_LI,
        tipo: 'estoque-produto',
        campo: 'estoque',
        politica: 'valor',
        antes: JSON.stringify({
          gerenciado: true,
          quantidade: 3,
          situacao_em_estoque: 0,
          situacao_sem_estoque: -1,
        }),
        depois: JSON.stringify(corpo(7).valor),
        mudou: true,
        motivo,
      }),
    ]);
  });

  it('EQUAL pair: a row already holding the body ⇒ `mudou: false`', async () => {
    const m = await montar({ modo: MODO_LI.dryRun, p: plataforma({ quantidade: 7 }) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    expect(doEvento(m.linhas, 'diff')[0]?.campos.mudou).toBe(false);
  });

  it.each([
    ['the same quantity, the product unmanaged', { quantidade: 7, gerenciado: false }],
    [
      'the same quantity, another out-of-stock situação',
      { quantidade: 7, situacao_sem_estoque: 0 },
    ],
  ])('⚠️ NEAR-MISS: a row holding %s ⇒ `mudou: true`', async (_c, over) => {
    const m = await montar({ modo: MODO_LI.dryRun, p: plataforma(over) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    expect(doEvento(m.linhas, 'diff')[0]?.campos.mudou).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*            A write decides only on its own reader, under its own flow       */
/* -------------------------------------------------------------------------- */

describe('the reader and the flow: a stock write never decides on an order, nor runs under another valve', () => {
  it('a stock write REFUSES an order base (same target, `on`): TypeError, no PUT, no escrita line', async () => {
    const m = await montar();
    const alvo: AlvoLi = { contaId: ID, recurso: NUMERO_LI };
    const base = lida(await lerBaseLi(m.motor, alvo, 'pedido'));
    expect(base.restauracao).toBe(true);
    await expect(
      escreverLi(m.motor, { tipo: 'estoque-produto', alvo }, corpo(7), base),
    ).rejects.toThrow(TypeError);
    expect(m.p.puts()).toEqual([]);
    expect(doEvento(m.linhas, 'escrita')).toEqual([]);
  });

  it('an order write REFUSES a stock base (same target, `on`): TypeError, no PUT', async () => {
    const m = await montar({ fluxo: 'rastreio' });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    expect(base.restauracao).toBe(true);
    await expect(
      escreverLi(
        m.motor,
        { tipo: 'situacao-pedido', alvo: ALVO },
        { campo: 'codigo', valor: 'pedido_enviado' },
        base,
      ),
    ).rejects.toThrow(TypeError);
    expect(m.p.puts()).toEqual([]);
  });

  it.each([MODO_LI.on, MODO_LI.dryRun])(
    'valve %s: a stock kind under the status write-back’s valve is a TypeError — no PUT, no diff line',
    async (modo) => {
      const m = await montar({ fluxo: 'rastreio', modo });
      const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
      await expect(escreverLi(m.motor, ESTOQUE, corpo(7), base)).rejects.toThrow(TypeError);
      expect(m.p.puts()).toEqual([]);
      expect(doEvento(m.linhas, 'diff')).toEqual([]);
    },
  );

  it.each([MODO_LI.on, MODO_LI.dryRun])(
    'valve %s: an order kind under the stock valve is a TypeError — no PUT, no diff line',
    async (modo) => {
      const m = await montar({ modo });
      const alvo: AlvoLi = { contaId: ID, recurso: NUMERO_LI };
      const base = lida(await lerBaseLi(m.motor, alvo, 'pedido'));
      await expect(
        escreverLi(
          m.motor,
          { tipo: 'situacao-pedido', alvo },
          { campo: 'codigo', valor: 'pedido_enviado' },
          base,
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        escreverLi(
          m.motor,
          { tipo: 'objeto-envio', alvo, envioId: ID_ENVIO_LI },
          { campo: 'objeto', valor: 'PJ258408772BR' },
          base,
        ),
      ).rejects.toThrow(TypeError);
      expect(m.p.puts()).toEqual([]);
      expect(doEvento(m.linhas, 'diff')).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                  The body: the package's four leaves, nothing else          */
/* -------------------------------------------------------------------------- */

describe('the stock body: the package’s four leaves, or nothing is sent', () => {
  it.each([
    ['an unmanaged product', { ...ESTOQUE_FIXO_ESCRITA_LI, gerenciado: false, quantidade: 7 }],
    [
      'another out-of-stock situação',
      { ...ESTOQUE_FIXO_ESCRITA_LI, situacao_sem_estoque: 0, quantidade: 7 },
    ],
    ['an extra key', { ...ESTOQUE_FIXO_ESCRITA_LI, quantidade: 7, preco: 10 }],
    ['no quantity', { ...ESTOQUE_FIXO_ESCRITA_LI }],
    ['a fixed leaf missing', { gerenciado: true, situacao_em_estoque: 0, quantidade: 7 }],
  ])('⚠️ NEAR-MISS: %s ⇒ TypeError, no PUT, no diff line', async (_c, valor) => {
    for (const modo of [MODO_LI.on, MODO_LI.dryRun]) {
      const m = await montar({ modo });
      const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
      const payload = { campo: 'estoque', valor } as unknown as PayloadEscritaLi;
      await expect(escreverLi(m.motor, ESTOQUE, payload, base)).rejects.toThrow(TypeError);
      expect(m.p.puts()).toEqual([]);
      expect(doEvento(m.linhas, 'diff')).toEqual([]);
    }
  });

  it('a NEGATIVE quantity is the package’s refusal (`LiConfigError`), nothing fetched — and the run stays open', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await expect(escreverLi(m.motor, ESTOQUE, corpo(-3), base)).rejects.toThrow(LiConfigError);
    expect(m.p.chamadas()).toEqual([`GET ${CAMINHO}`]);
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    expect((await escreverLi(m.motor, ESTOQUE, corpo(0), nova)).kind).toBe('enviado');
    expect(m.p.puts().map((x) => x.corpo)).toEqual([corpo(0).valor]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         One write per run, for stock too                    */
/* -------------------------------------------------------------------------- */

describe('one write per run holds for the stock kinds', () => {
  it('after a landed stock PUT, a FRESH deciding read cannot send another — of either stock kind', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    expect((await escreverLi(m.motor, ESTOQUE, corpo(7), base)).kind).toBe('enviado');
    const outra = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await expect(escreverLi(m.motor, ESTOQUE, corpo(8), outra)).rejects.toThrow(TypeError);
    await expect(escreverLi(m.motor, LOTE, corpo(8), outra)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toHaveLength(1);
  });

  it.each([
    ['a 500', () => respostaJson(500, { erro: 'x' }), LiHttpError],
    ['a 429', () => respostaJson(429, { erro: 'x' }), LiThrottleError],
  ])('%s may have landed: the run stays CLOSED', async (_c, resposta, classe) => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    m.p.fila.push(naProxima(CAMINHO, 'PUT', resposta));
    await expect(escreverLi(m.motor, ESTOQUE, corpo(7), base)).rejects.toThrow(classe);
    const outra = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await expect(escreverLi(m.motor, ESTOQUE, corpo(7), outra)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toHaveLength(1);
  });

  it.each([
    ['a 400', () => respostaJson(400, { erro: 'x' })],
    ['a 404', () => respostaJson(404, undefined)],
  ])(
    '%s proves nothing landed: the run REOPENS for a write from a fresh read',
    async (_c, resposta) => {
      const m = await montar();
      const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
      m.p.fila.push(naProxima(CAMINHO, 'PUT', resposta));
      await expect(escreverLi(m.motor, ESTOQUE, corpo(7), base)).rejects.toThrow(LiHttpError);
      const outra = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
      expect((await escreverLi(m.motor, ESTOQUE, corpo(7), outra)).kind).toBe('enviado');
      expect(m.p.puts()).toHaveLength(2);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*            The target is the PRODUCT id; a 404 is `ausente`                 */
/* -------------------------------------------------------------------------- */

describe('the stock target’s key is the PRODUCT id; a 404 is `ausente`', () => {
  it.each([
    ['a product with no stock row', ID_PRODUTO_LI + 1],
    ['the stock row’s OWN id', ID_LINHA_ESTOQUE_LI],
  ])(
    '%s ⇒ `ausente`: no restore line, no pin, and never a base for a write',
    async (_c, recurso) => {
      const m = await montar();
      const alvo: AlvoLi = { contaId: ID, recurso };
      const ausente = await lerBaseLi(m.motor, alvo, 'produto-estoque');
      expect(ausente).toEqual({ kind: 'ausente', alvo });
      expect(m.p.chamadas()).toEqual([`GET /v1/produto_estoque/${String(recurso)}`]);
      expect(doEvento(m.linhas, 'restauracao')).toEqual([]);
      expect(m.contexto.credencial.fixada()).toBeNull();
      // @ts-expect-error — an `ausente` base is not a base a write decides on
      const tentativa = escreverLi(m.motor, { tipo: 'estoque-produto', alvo }, corpo(1), ausente);
      await expect(tentativa).rejects.toThrow(TypeError);
      expect(m.p.puts()).toEqual([]);
    },
  );

  it('EQUAL pair: the PRODUCT id reads the row — whose own id is another number', async () => {
    const m = await montar();
    const base = await lerBaseLi(m.motor, ALVO, 'produto-estoque');
    if (base.kind !== 'lida') throw new TypeError('ausente');
    expect(base.produtoEstoque.id).toBe(ID_LINHA_ESTOQUE_LI);
    expect(ID_LINHA_ESTOQUE_LI).not.toBe(ID_PRODUTO_LI);
  });
});

/* -------------------------------------------------------------------------- */
/*             The order-only reads after, or around, a stock write            */
/* -------------------------------------------------------------------------- */

describe('the order-only reads refuse a stock run', () => {
  it('the situação history after a landed STOCK write is a TypeError, nothing sent', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    await escreverLi(m.motor, ESTOQUE, corpo(7), base);
    const marco = m.p.eventos.length;
    await expect(lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).rejects.toThrow(TypeError);
    expect(m.p.eventos.slice(marco)).toEqual([]);
  });

  it('a confirming read in a STOCK run is a TypeError, nothing sent — even with a pinned credential', async () => {
    const m = await montar();
    await lerBaseLi(m.motor, ALVO, 'produto-estoque');
    expect(m.contexto.credencial.fixada()).not.toBeNull();
    const marco = m.p.eventos.length;
    await expect(confirmarCredencialLi(m.motor, ALVO)).rejects.toThrow(TypeError);
    expect(m.p.eventos.slice(marco)).toEqual([]);
  });

  it('EQUAL pair: in an ORDER run the confirming read still reads the order detail', async () => {
    const m = await montar({ fluxo: 'rastreio' });
    await lerBaseLi(m.motor, { contaId: ID, recurso: NUMERO_LI }, 'pedido');
    const marco = m.p.eventos.length;
    await confirmarCredencialLi(m.motor, { contaId: ID, recurso: NUMERO_LI });
    expect(m.p.eventos.slice(marco)).toEqual([ESPERA, `GET ${CAMINHO_PEDIDO_LI}`]);
  });
});
