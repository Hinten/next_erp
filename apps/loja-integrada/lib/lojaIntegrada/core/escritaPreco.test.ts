/**
 * The write engine's price seam (master plan step 13, PR 13-c): the two price
 * kinds through the engine's own requirements, against the shared stateful
 * platform (`testing/plataformaEscritaLi.ts`, which models the store's produto
 * details keyed by their id and the price PUT). The order kinds' own suite is
 * `escrita.test.ts`; the stock kinds' is `escritaEstoque.test.ts`.
 *
 * Every value is INVENTED (`testing/precoLi.ts`: produtos from 1000, repeated-
 * digit prices): no real store data. No Loja Integrada call: the platform is a
 * stub `fetch` handed to the write context; the global `fetch` is stubbed to
 * throw for every test of this file, and the unit config's network kill-switch
 * fails anything that would reach a real host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EntradaPrecoProdutoLi,
  ESTOQUE_FIXO_ESCRITA_LI,
  LiNotFoundError,
  LiSchemaError,
  type ProdutoComPrecoDetalheLi,
  corpoPrecoProdutoLi,
  liEstoqueProdutoDetalheSchema,
} from '@delfrance/integrations-loja-integrada';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  type EnvioPrecoLi,
  FORMA_PROMO_LIMPA_LI,
  type FormaPromoLimpaLi,
  TIPO_PRODUTO_LI,
} from '@delfrance/schemas';

import { FakeDb, type DocData, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  gravadorDeLog,
  seedConta,
  seedCredencial,
  type LinhaGravada,
} from '../testing/fixtures';
import { NUMERO_LI } from '../testing/pedidosLi';
import {
  type PlataformaEscritaLi,
  caminhoPrecoProdutoLi,
  caminhoProdutoDetalheLi,
  criarPlataformaEscritaLi,
  linhaEstoqueLi,
  naProxima,
  respostaJson,
} from '../testing/plataformaEscritaLi';
import { ID_SEM_PRODUTO_PRECO_LI, PARES_DETALHE_PRECO_LI } from '../testing/precoLi';
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
/** The invented produto with a promotion below its full price (55.55 / 22.22, custo 12.34). */
const PRODUTO_ID = 1103;
const ALVO: AlvoLi = { contaId: ID, recurso: PRODUTO_ID };
const CAMINHO = caminhoProdutoDetalheLi(PRODUTO_ID);
const CAMINHO_PUT = caminhoPrecoProdutoLi(PRODUTO_ID);
const ESPERA = `espera ${String(RITMO_ESCRITA_LI_MS)}`;

const PRECO = { tipo: 'preco-produto', alvo: ALVO } as const;
const LOTE = { tipo: 'preco-produto-lote', alvo: ALVO } as const;

/** 33.00 with a promotion of 22.22 (a whole-reais full price, a promotion with centavos). */
const ALVO_PROMO: EnvioPrecoLi = { cheioCentavos: 3300, promo: { centavos: 2222 } };
/** 33.00, the promotion cleared. */
const ALVO_LIMPA: EnvioPrecoLi = { cheioCentavos: 3300, promo: 'limpar' };
/** 44.44 with 22.22: a full price with centavos, for its truncation. */
const ALVO_CENTAVOS: EnvioPrecoLi = { cheioCentavos: 4444, promo: { centavos: 2222 } };

const FORMAS: readonly FormaPromoLimpaLi[] = [
  FORMA_PROMO_LIMPA_LI.nulo,
  FORMA_PROMO_LIMPA_LI.zero,
  FORMA_PROMO_LIMPA_LI.igualCheio,
];

/** The read switch on, ONE flow's valve and canary as given (`null`: unset). */
function ambiente(
  fluxo: 'preco' | 'estoque' | 'rastreio',
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
    throw new Error('escritaPreco.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

/** An invented detail of `testing/precoLi.ts`, by its produto id. */
function detalheInventado(produtoId: number): DocData {
  const par = PARES_DETALHE_PRECO_LI.find((p) => p.produtoId === produtoId);
  if (par === undefined) throw new TypeError(`sem detalhe inventado ${String(produtoId)}`);
  return { ...par.detalhe };
}

/**
 * The store: the three invented details (1101–1103; `over` on 1103) and a stock
 * row for 1103, so one id is served both as a produto and as a stock row.
 */
function plataforma(
  o: {
    over?: DocData;
    gravacaoPreco?: (corpo: DocData, detalhe: DocData) => void;
    ecoPreco?: (detalhe: DocData) => Response;
  } = {},
): PlataformaEscritaLi {
  return criarPlataformaEscritaLi({
    produtos: PARES_DETALHE_PRECO_LI.map((par) =>
      par.produtoId === PRODUTO_ID ? { ...par.detalhe, ...o.over } : par.detalhe,
    ),
    estoque: [linhaEstoqueLi(PRODUTO_ID, { quantidade: 3, quantidade_reservada: 2 })],
    ...(o.gravacaoPreco === undefined ? {} : { gravacaoPreco: o.gravacaoPreco }),
    ...(o.ecoPreco === undefined ? {} : { ecoPreco: o.ecoPreco }),
  });
}

interface Montagem {
  readonly p: PlataformaEscritaLi;
  readonly linhas: LinhaGravada[];
  readonly contexto: ContextoEscritaLojaIntegrada;
  readonly motor: ReturnType<typeof criarMotorEscritaLi>;
  /** Every wait, every request and every engine line, in order. */
  readonly linhaDoTempo: string[];
}

async function montar(
  o: {
    fluxo?: 'preco' | 'estoque' | 'rastreio';
    modo?: string;
    canario?: string | null;
    p?: PlataformaEscritaLi;
  } = {},
): Promise<Montagem> {
  const fluxo = o.fluxo ?? 'preco';
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
  const esperar = (ms: number) => {
    linhaDoTempo.push(`espera ${String(ms)}`);
    return p.esperar(ms);
  };
  const contexto = await loadLojaIntegradaContextoEscrita(asDb(db), ID, {
    ambiente: amb,
    esperar,
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

/** A price write's inputs from THIS deciding read: its own custo and `sob_consulta`. */
function preco(
  base: BaseLidaLi,
  alvo: EnvioPrecoLi,
  forma: FormaPromoLimpaLi = FORMA_PROMO_LIMPA_LI.nulo,
): PayloadEscritaLi {
  if (base.leitura !== 'produto-detalhe') throw new TypeError(`base ${base.leitura}`);
  const sobConsulta = base.produtoDetalhe.preco_sob_consulta;
  if (typeof sobConsulta !== 'boolean') throw new TypeError('sob_consulta não booleano');
  return {
    campo: 'preco',
    valor: { alvo, formaPromoLimpa: forma, custo: base.produtoDetalhe.preco_custo, sobConsulta },
  };
}

/** A price payload's inputs (a narrowing, never a cast). */
function entradaDe(payload: PayloadEscritaLi): EntradaPrecoProdutoLi {
  if (payload.campo !== 'preco') throw new TypeError(`campo ${payload.campo}`);
  return payload.valor;
}

/** A price payload built by hand: custo and `sob_consulta` as given, not from a read. */
function precoAvulso(custo: unknown, sobConsulta: unknown): PayloadEscritaLi {
  return {
    campo: 'preco',
    valor: {
      alvo: ALVO_PROMO,
      formaPromoLimpa: FORMA_PROMO_LIMPA_LI.nulo,
      custo,
      sobConsulta: sobConsulta as boolean,
    },
  };
}

const doEvento = (linhas: readonly LinhaGravada[], evento: string) =>
  linhas.filter((l) => l.campos.evento === evento);

/** The detail 1103 as the store holds it after ALVO_PROMO landed, with `over` applied. */
const detalheDepois = (over: DocData = {}): DocData => ({
  ...detalheInventado(PRODUTO_ID),
  preco_cheio: 33,
  preco_promocional: 22.22,
  ...over,
});

/**
 * One `on` price write of `alvo` under `forma`, then its read-back answered by
 * `volta` (the detail as the store would show it). The verdict, and the run.
 */
async function escreverEConferir(o: {
  alvo: EnvioPrecoLi;
  volta: DocData;
  forma?: FormaPromoLimpaLi;
  p?: PlataformaEscritaLi;
}) {
  const m = await montar(o.p === undefined ? {} : { p: o.p });
  const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
  const payload = preco(base, o.alvo, o.forma);
  expect((await escreverLi(m.motor, PRECO, payload, base)).kind).toBe('enviado');
  m.p.fila.push(naProxima(CAMINHO, 'GET', () => respostaJson(200, o.volta)));
  const leitura = await lerDeVoltaLi(m.motor, ALVO, 'preco-produto');
  if (!leitura.verificado) throw new TypeError(`não verificada: ${leitura.classe}`);
  return { m, payload, resultado: conferirEscritaLi(m.motor, PRECO, payload, leitura) };
}

/* -------------------------------------------------------------------------- */
/*                 The kinds' rows: reader, read-back, field, flow            */
/* -------------------------------------------------------------------------- */

describe('the price kinds in the engine’s tables', () => {
  it('two price rows: one reader (the produto detail), a read-back call for one product and NONE for a lote', () => {
    expect(LEITURA_PREVIA_LI['preco-produto']).toEqual({
      leitura: 'produto-detalhe',
      leituraDeVolta: 'recurso',
      obrigatoria: true,
      ausente: 'dry-run',
    });
    expect(LEITURA_PREVIA_LI['preco-produto-lote']).toEqual({
      leitura: 'produto-detalhe',
      leituraDeVolta: 'lista',
      obrigatoria: true,
      ausente: 'dry-run',
    });
    // ⚠️ NEAR-MISS: the two rows differ in their read-back strategy, and only there.
    expect(LEITURA_PREVIA_LI['preco-produto'].leituraDeVolta).not.toBe(
      LEITURA_PREVIA_LI['preco-produto-lote'].leituraDeVolta,
    );
    expect(CAMPO_DO_TIPO_ESCRITA_LI['preco-produto']).toBe('preco');
    expect(CAMPO_DO_TIPO_ESCRITA_LI['preco-produto-lote']).toBe('preco');
    expect(FLUXO_DO_TIPO_ESCRITA_LI['preco-produto']).toBe(FLUXO_LI.preco);
    expect(FLUXO_DO_TIPO_ESCRITA_LI['preco-produto-lote']).toBe(FLUXO_LI.preco);
    expect(POLITICA_CAMPO_ESCRITA_LI.preco).toBe('valor');
    // No other kind reads the produto detail, and the price kinds read nothing else.
    for (const [tipo, linha] of Object.entries(LEITURA_PREVIA_LI)) {
      expect(linha.leitura === 'produto-detalhe', tipo).toBe(tipo.startsWith('preco-'));
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                    The reader: the produto detail, slash form              */
/* -------------------------------------------------------------------------- */

describe('the produto-detalhe reader: ONE GET of the detail, its restore line, the pin', () => {
  it('two waits, ONE `GET /v1/produto/{id}/`, then the restore line under the catalogue policy; the credential pinned', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect(m.p.eventos).toEqual([ESPERA, ESPERA, `GET ${CAMINHO}`]);
    expect(CAMINHO).toBe('/v1/produto/1103/');
    expect(m.linhaDoTempo).toEqual([ESPERA, ESPERA, `GET ${CAMINHO}`, 'log restauracao']);
    expect(base.leitura).toBe('produto-detalhe');
    expect(base.restauracao).toBe(true);
    expect(m.contexto.credencial.fixada()).not.toBeNull();
    const [linha, ...outras] = doEvento(m.linhas, 'restauracao');
    expect(outras).toEqual([]);
    expect(linha?.severidade).toBe('INFO');
    expect(linha?.campos).toMatchObject({
      recurso: PRODUTO_ID,
      caminho: CAMINHO,
      status: 200,
      politica: 'catalogo',
    });
    // The projection: the nine leaves, in the detail's order, the custo verbatim.
    const d = detalheInventado(PRODUTO_ID);
    expect(linha?.campos.corpo).toBe(
      JSON.stringify({
        id: d.id,
        tipo: d.tipo,
        ativo: d.ativo,
        bloqueado: d.bloqueado,
        removido: d.removido,
        preco_cheio: d.preco_cheio,
        preco_promocional: d.preco_promocional,
        preco_custo: d.preco_custo,
        preco_sob_consulta: d.preco_sob_consulta,
      }),
    );
    expect(JSON.parse(String(linha?.campos.corpo))).toMatchObject({ preco_custo: 12.34 });
  });

  it('⚠️ NEAR-MISS: the no-slash form is not the detail — the store fake answers it 500', async () => {
    const p = plataforma();
    const resposta = await p.fetch(`https://loja.invalid/v1/produto/${String(PRODUTO_ID)}`, {
      method: 'GET',
    });
    expect(resposta.status).toBe(500);
    // Anti-vacuity: the slash form answers the detail.
    const certa = await p.fetch(`https://loja.invalid${CAMINHO}`, { method: 'GET' });
    expect(certa.status).toBe(200);
  });

  it('a 404 is `ausente`: no restore line, no pin, and never a base for a write', async () => {
    const m = await montar();
    const alvo: AlvoLi = { contaId: ID, recurso: ID_SEM_PRODUTO_PRECO_LI };
    const ausente = await lerBaseLi(m.motor, alvo, 'produto-detalhe');
    expect(ausente).toEqual({ kind: 'ausente', alvo });
    expect(m.p.chamadas()).toEqual([`GET ${caminhoProdutoDetalheLi(ID_SEM_PRODUTO_PRECO_LI)}`]);
    expect(doEvento(m.linhas, 'restauracao')).toEqual([]);
    expect(m.contexto.credencial.fixada()).toBeNull();
    const tentativa = escreverLi(
      m.motor,
      { tipo: 'preco-produto', alvo },
      precoAvulso(null, false),
      // @ts-expect-error — an `ausente` base is not a base a write decides on
      ausente,
    );
    await expect(tentativa).rejects.toThrow(TypeError);
    expect(m.p.puts()).toEqual([]);
  });

  it.each([
    'id',
    'tipo',
    'ativo',
    'bloqueado',
    'removido',
    'preco_cheio',
    'preco_promocional',
    'preco_custo',
    'preco_sob_consulta',
  ])(
    '⚠️ NEAR-MISS: a detail missing `%s` is the package’s LiSchemaError — never `ausente`, no restore line, 0 PUTs',
    async (ausente) => {
      const m = await montar();
      const detalhe = detalheInventado(PRODUTO_ID);
      delete detalhe[ausente];
      m.p.fila.push(naProxima(CAMINHO, 'GET', () => respostaJson(200, detalhe)));
      await expect(lerBaseLi(m.motor, ALVO, 'produto-detalhe')).rejects.toThrow(LiSchemaError);
      expect(doEvento(m.linhas, 'restauracao')).toEqual([]);
      expect(m.p.puts()).toEqual([]);
    },
  );

  it('another id, another tipo, a removed or blocked product come back AS READ — judging them is the flow’s', async () => {
    const m = await montar();
    m.p.fila.push(
      naProxima(CAMINHO, 'GET', () =>
        respostaJson(200, {
          ...detalheInventado(PRODUTO_ID),
          id: 1102,
          tipo: TIPO_PRODUTO_LI.normal,
          removido: true,
          bloqueado: true,
        }),
      ),
    );
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    if (base.leitura !== 'produto-detalhe') throw new TypeError(base.leitura);
    expect(base.produtoDetalhe).toMatchObject({
      id: 1102,
      tipo: TIPO_PRODUTO_LI.normal,
      removido: true,
      bloqueado: true,
    });
    expect(base.restauracao).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*            A write decides only on its own reader, under its own flow       */
/* -------------------------------------------------------------------------- */

describe('the reader and the flow: a price write decides only on the produto detail, under the price valve', () => {
  it('a price kind REFUSES a stock base and an order base (`on`): TypeError, no PUT, no diff line', async () => {
    const m = await montar();
    const estoque = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
    expect(estoque.restauracao).toBe(true);
    await expect(escreverLi(m.motor, PRECO, precoAvulso(12.34, false), estoque)).rejects.toThrow(
      /leitura prévia deste tipo/,
    );
    const alvoPedido: AlvoLi = { contaId: ID, recurso: NUMERO_LI };
    const pedido = lida(await lerBaseLi(m.motor, alvoPedido, 'pedido'));
    await expect(
      escreverLi(
        m.motor,
        { tipo: 'preco-produto', alvo: alvoPedido },
        precoAvulso(12.34, false),
        pedido,
      ),
    ).rejects.toThrow(/leitura prévia deste tipo/);
    expect(m.p.puts()).toEqual([]);
    expect(doEvento(m.linhas, 'diff')).toEqual([]);
    expect(doEvento(m.linhas, 'escrita')).toEqual([]);
    // EQUAL pair: the same motor, the same id, its OWN reader's base writes.
    const propria = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect((await escreverLi(m.motor, PRECO, preco(propria, ALVO_PROMO), propria)).kind).toBe(
      'enviado',
    );
  });

  it('a stock kind REFUSES a price base (same id, the stock valve): TypeError, no PUT', async () => {
    const m = await montar({ fluxo: 'estoque' });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect(base.restauracao).toBe(true);
    await expect(
      escreverLi(
        m.motor,
        { tipo: 'estoque-produto', alvo: ALVO },
        { campo: 'estoque', valor: { ...ESTOQUE_FIXO_ESCRITA_LI, quantidade: 7 } },
        base,
      ),
    ).rejects.toThrow(/leitura prévia deste tipo/);
    expect(m.p.puts()).toEqual([]);
  });

  it.each([MODO_LI.on, MODO_LI.dryRun])(
    'valve %s: a price kind under the stock valve is a TypeError — no PUT, no diff line',
    async (modo) => {
      const m = await montar({ fluxo: 'estoque', modo });
      const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
      for (const destino of [PRECO, LOTE]) {
        await expect(escreverLi(m.motor, destino, preco(base, ALVO_PROMO), base)).rejects.toThrow(
          /outro fluxo/,
        );
      }
      expect(m.p.puts()).toEqual([]);
      expect(doEvento(m.linhas, 'diff')).toEqual([]);
    },
  );

  it.each([MODO_LI.on, MODO_LI.dryRun])(
    'valve %s: a stock or order kind under the price valve is a TypeError — no PUT, no diff line',
    async (modo) => {
      const m = await montar({ modo });
      const estoque = lida(await lerBaseLi(m.motor, ALVO, 'produto-estoque'));
      await expect(
        escreverLi(
          m.motor,
          { tipo: 'estoque-produto', alvo: ALVO },
          { campo: 'estoque', valor: { ...ESTOQUE_FIXO_ESCRITA_LI, quantidade: 7 } },
          estoque,
        ),
      ).rejects.toThrow(/outro fluxo/);
      const alvoPedido: AlvoLi = { contaId: ID, recurso: NUMERO_LI };
      const pedido = lida(await lerBaseLi(m.motor, alvoPedido, 'pedido'));
      await expect(
        escreverLi(
          m.motor,
          { tipo: 'situacao-pedido', alvo: alvoPedido },
          { campo: 'codigo', valor: 'pedido_enviado' },
          pedido,
        ),
      ).rejects.toThrow(/outro fluxo/);
      expect(m.p.puts()).toEqual([]);
      expect(doEvento(m.linhas, 'diff')).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*            The inputs: the deciding read's OWN custo and sob_consulta       */
/* -------------------------------------------------------------------------- */

describe('the price inputs: the custo and `sob_consulta` must be THIS deciding read’s own', () => {
  it.each([
    ['a custo of 11.11 against the read’s 12.34', {}, 11.11, false],
    ['a custo of 0 against the read’s null', { preco_custo: null }, 0, false],
    ['a custo of null against the read’s 0', { preco_custo: 0 }, null, false],
    ['a custo as text against the read’s number', {}, '12.34', false],
    ['`sobConsulta: true` against the read’s false', {}, 12.34, true],
    ['`sobConsulta` as text against the read’s false', {}, 12.34, 'false'],
    ['`sobConsulta` missing', {}, 12.34, undefined],
  ] as const)(
    '⚠️ NEAR-MISS: %s ⇒ TypeError, no diff line, no PUT',
    async (_c, over, custo, sob) => {
      for (const modo of [MODO_LI.on, MODO_LI.dryRun]) {
        const m = await montar({ modo, p: plataforma({ over }) });
        const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
        await expect(escreverLi(m.motor, PRECO, precoAvulso(custo, sob), base)).rejects.toThrow(
          /custo e o sob_consulta/,
        );
        expect(m.p.puts()).toEqual([]);
        expect(doEvento(m.linhas, 'diff')).toEqual([]);
      }
    },
  );

  it.each([
    ['a null custo', { preco_custo: null }],
    ['a zero custo', { preco_custo: 0 }],
    ['a custo of 12.34', {}],
  ] as const)('EQUAL pair: %s echoed from the read passes', async (_c, over) => {
    const m = await montar({ p: plataforma({ over }) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect((await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base)).kind).toBe('enviado');
  });

  it.each([
    ['a zero full price', { cheioCentavos: 0, promo: 'limpar' }],
    ['a fractional full price', { cheioCentavos: 3300.5, promo: 'limpar' }],
    ['a zero promotion', { cheioCentavos: 3300, promo: { centavos: 0 } }],
  ] as const)(
    'a target no send may carry (%s) is the builder’s RangeError BEFORE anything is decided — and the same base then writes',
    async (_c, alvo) => {
      for (const modo of [MODO_LI.dryRun, MODO_LI.on]) {
        const m = await montar({ modo });
        const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
        await expect(escreverLi(m.motor, PRECO, preco(base, alvo), base)).rejects.toThrow(
          RangeError,
        );
        expect(m.p.puts()).toEqual([]);
        expect(doEvento(m.linhas, 'diff')).toEqual([]);
        expect(doEvento(m.linhas, 'escrita')).toEqual([]);
        // The run is still open and the base unspent: a valid target in the same run.
        const r = await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base);
        expect(r.kind).toBe(modo === MODO_LI.on ? 'enviado' : 'nao-enviado');
        expect(m.p.puts()).toHaveLength(modo === MODO_LI.on ? 1 : 0);
      }
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                  The write lands — and the restore is what lets it         */
/* -------------------------------------------------------------------------- */

describe('preco-produto under `on`: the deciding GET, the restore line, ONE PUT, ONE eco line', () => {
  it('ends `enviado`, NOT `sem-restauracao`: GET then PUT, the body the package builds, byte for byte', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    const payload = preco(base, ALVO_PROMO);
    const r = await escreverLi(m.motor, PRECO, payload, base);
    // Before the produto detail's restore branch this very run ended `sem-restauracao`, with no PUT.
    expect(r.kind).toBe('enviado');
    expect(base.restauracao).toBe(true);
    expect(m.p.chamadas()).toEqual([`GET ${CAMINHO}`, `PUT ${CAMINHO_PUT}`]);
    expect(m.p.textosDosPuts).toEqual([
      JSON.stringify(corpoPrecoProdutoLi(entradaDe(payload)).corpo),
    ]);
    expect(m.p.textosDosPuts).toEqual([
      '{"cheio":33,"custo":12.34,"promocional":22.22,"sob_consulta":false}',
    ]);
    expect(m.linhaDoTempo).toEqual([
      ESPERA,
      ESPERA,
      `GET ${CAMINHO}`,
      'log restauracao',
      `PUT ${CAMINHO_PUT}`,
      'log escrita',
      'log eco',
    ]);
    expect(doEvento(m.linhas, 'escrita').map((l) => l.campos)).toEqual([
      expect.objectContaining({
        recurso: PRODUTO_ID,
        tipo: 'preco-produto',
        campo: 'preco',
        resultado: 'aplicada',
        status: 200,
      }),
    ]);
    // The fake stored it.
    expect(m.p.estado.produtos.get(PRODUTO_ID)).toMatchObject({
      preco_cheio: 33,
      preco_promocional: 22.22,
      preco_custo: 12.34,
    });
  });

  it('⚠️ NEAR-MISS: a deciding read whose full price is an object has no restore line ⇒ `sem-restauracao`, 0 PUTs', async () => {
    const m = await montar({ p: plataforma({ over: { preco_cheio: {} } }) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect(base.restauracao).toBe(false);
    expect(doEvento(m.linhas, 'restauracao')).toEqual([]);
    expect(await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base)).toEqual({
      kind: 'sem-restauracao',
    });
    expect(m.p.puts()).toEqual([]);
  });

  it.each([
    ['a null custo is OMITTED', { preco_custo: null }, null],
    ['a custo of 12.34 is sent verbatim', {}, '"custo":12.34'],
    ['a custo of 0 is sent verbatim', { preco_custo: 0 }, '"custo":0'],
    ['a custo as decimal TEXT (`"12.3400"`) is omitted', { preco_custo: '12.3400' }, null],
    ['a negative custo is omitted', { preco_custo: -1 }, null],
  ] as const)('the custo: %s', async (_c, over, trecho) => {
    const m = await montar({ p: plataforma({ over }) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect((await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base)).kind).toBe('enviado');
    const [texto] = m.p.textosDosPuts;
    if (trecho === null) expect(texto).not.toContain('"custo"');
    else expect(texto).toContain(trecho);
  });

  it('a custo the restore line cannot carry verbatim (`"abc"`) has no restore line ⇒ `sem-restauracao`, 0 PUTs', async () => {
    const m = await montar({ p: plataforma({ over: { preco_custo: 'abc' } }) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect(base.restauracao).toBe(false);
    expect(await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base)).toEqual({
      kind: 'sem-restauracao',
    });
    expect(m.p.puts()).toEqual([]);
  });

  it.each([
    [FORMA_PROMO_LIMPA_LI.nulo, '"promocional":null'],
    [FORMA_PROMO_LIMPA_LI.zero, '"promocional":0'],
    [FORMA_PROMO_LIMPA_LI.igualCheio, '"promocional":33'],
  ] as const)('the clear under `%s` sends %s', async (forma, trecho) => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    await escreverLi(m.motor, PRECO, preco(base, ALVO_LIMPA, forma), base);
    expect(m.p.textosDosPuts[0]).toContain(trecho);
  });

  it('a second write after one that landed is a TypeError — ONE PUT, of either price kind', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect((await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base)).kind).toBe('enviado');
    const outra = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    await expect(escreverLi(m.motor, PRECO, preco(outra, ALVO_LIMPA), outra)).rejects.toThrow(
      TypeError,
    );
    await expect(escreverLi(m.motor, LOTE, preco(outra, ALVO_LIMPA), outra)).rejects.toThrow(
      TypeError,
    );
    expect(m.p.puts()).toHaveLength(1);
  });

  it('the cost: 3 calls for an event-origin run (GET, PUT, read-back), 2 for a lote run (no read-back call)', async () => {
    const evento = await montar();
    const b1 = lida(await lerBaseLi(evento.motor, ALVO, 'produto-detalhe'));
    await escreverLi(evento.motor, PRECO, preco(b1, ALVO_PROMO), b1);
    await lerDeVoltaLi(evento.motor, ALVO, 'preco-produto');
    expect(evento.p.chamadas()).toEqual([`GET ${CAMINHO}`, `PUT ${CAMINHO_PUT}`, `GET ${CAMINHO}`]);

    const lote = await montar();
    const b2 = lida(await lerBaseLi(lote.motor, ALVO, 'produto-detalhe'));
    expect((await escreverLi(lote.motor, LOTE, preco(b2, ALVO_PROMO), b2)).kind).toBe('enviado');
    // @ts-expect-error — a lote has no read-back call (the nightly by-id read is its read-back)
    await expect(lerDeVoltaLi(lote.motor, ALVO, 'preco-produto-lote')).rejects.toThrow(TypeError);
    expect(lote.p.chamadas()).toEqual([`GET ${CAMINHO}`, `PUT ${CAMINHO_PUT}`]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 The read-back: the price predicate, never deepEqual         */
/* -------------------------------------------------------------------------- */

describe('preco-produto’s read-back: a SEPARATE GET of the detail, compared through the price predicate', () => {
  it('EQUAL pair: the store holding exactly what was written ⇒ `igual`, no deriva line; two waits before the GET', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    const payload = preco(base, ALVO_PROMO);
    await escreverLi(m.motor, PRECO, payload, base);
    const marco = m.p.eventos.length;
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'preco-produto');
    expect(m.p.eventos.slice(marco)).toEqual([ESPERA, ESPERA, `GET ${CAMINHO}`]);
    if (!leitura.verificado) throw new TypeError('não verificada');
    expect(leitura.leitura).toBe('produto-detalhe');
    expect(conferirEscritaLi(m.motor, PRECO, payload, leitura)).toBe('igual');
    expect(doEvento(m.linhas, 'deriva')).toEqual([]);
  });

  it.each([
    ['the full price as two-decimal text', { preco_cheio: '33.00' }],
    ['the full price as four-decimal text', { preco_cheio: '33.0000' }],
    ['the full price as a whole-reais text', { preco_cheio: '33' }],
    ['the promotion as four-decimal text', { preco_promocional: '22.2200' }],
    ['both as four-decimal text', { preco_cheio: '33.0000', preco_promocional: '22.2200' }],
  ])('EQUAL pair: %s ⇒ `igual`, no deriva line', async (_c, over) => {
    const { m, resultado } = await escreverEConferir({
      alvo: ALVO_PROMO,
      volta: detalheDepois(over),
    });
    expect(resultado).toBe('igual');
    expect(doEvento(m.linhas, 'deriva')).toEqual([]);
  });

  it.each([[null], [0], ['0.00'], ['0'], ['0.0000']] as const)(
    'EQUAL pair: after a clear, a promotion read as %j ⇒ `igual` under nulo and zero',
    async (promocional) => {
      for (const forma of [FORMA_PROMO_LIMPA_LI.nulo, FORMA_PROMO_LIMPA_LI.zero]) {
        const { m, resultado } = await escreverEConferir({
          alvo: ALVO_LIMPA,
          forma,
          volta: detalheDepois({ preco_promocional: promocional }),
        });
        expect(resultado, forma).toBe('igual');
        expect(doEvento(m.linhas, 'deriva')).toEqual([]);
      }
    },
  );

  it.each([
    ['`"22"`', '22'],
    ['`22`', 22],
    ['one centavo below (`"22.21"`)', '22.21'],
  ] as const)(
    '⚠️ NEAR-MISS: the promotion read as %s after 22.22 ⇒ `deriva` and ONE WARNING line',
    async (_c, promocional) => {
      const { m, payload, resultado } = await escreverEConferir({
        alvo: ALVO_PROMO,
        volta: detalheDepois({ preco_promocional: promocional }),
      });
      expect(resultado).toBe('deriva');
      const derivas = doEvento(m.linhas, 'deriva');
      expect(derivas).toHaveLength(1);
      expect(derivas[0]?.severidade).toBe('WARNING');
      expect(derivas[0]?.campos).toMatchObject({
        recurso: PRODUTO_ID,
        tipo: 'preco-produto',
        campo: 'preco',
        politica: 'valor',
        escrito: JSON.stringify(corpoPrecoProdutoLi(entradaDe(payload)).corpo),
        lido: JSON.stringify({
          cheio: 33,
          promocional,
          custo: 12.34,
          sob_consulta: false,
        }),
      });
    },
  );

  it('⚠️ NEAR-MISS: the full price truncated (`"44"` after 44.44) ⇒ `deriva`, ONE WARNING', async () => {
    const { m, resultado } = await escreverEConferir({
      alvo: ALVO_CENTAVOS,
      volta: detalheDepois({ preco_cheio: '44', preco_promocional: 22.22 }),
    });
    expect(resultado).toBe('deriva');
    expect(doEvento(m.linhas, 'deriva')).toHaveLength(1);
  });

  it.each([['0.01'], ['0.0100'], [0.01]] as const)(
    '⚠️ NEAR-MISS: after a clear, a promotion of one centavo (%j) ⇒ `deriva` under every forma',
    async (promocional) => {
      for (const forma of FORMAS) {
        const { m, resultado } = await escreverEConferir({
          alvo: ALVO_LIMPA,
          forma,
          volta: detalheDepois({ preco_promocional: promocional }),
        });
        expect(resultado, forma).toBe('deriva');
        expect(doEvento(m.linhas, 'deriva')).toHaveLength(1);
      }
    },
  );

  it('⚠️ NEAR-MISS: after a clear, a promotion equal to the full price ⇒ `deriva` under nulo and zero, `igual` under igual-cheio', async () => {
    for (const forma of FORMAS) {
      const { resultado } = await escreverEConferir({
        alvo: ALVO_LIMPA,
        forma,
        volta: detalheDepois({ preco_promocional: 33 }),
      });
      expect(resultado, forma).toBe(forma === FORMA_PROMO_LIMPA_LI.igualCheio ? 'igual' : 'deriva');
    }
  });

  it.each([
    ['one centavo above', '33.01'],
    ['one centavo below', 32.99],
    ['null', null],
    ['zero', 0],
    ['unreadable text', 'abc'],
    ['a comma decimal', '1,50'],
    ['a negative', -1],
  ] as const)(
    '⚠️ NEAR-MISS: the full price read as %s (%j) ⇒ `deriva`, ONE WARNING',
    async (_c, cheio) => {
      const { m, resultado } = await escreverEConferir({
        alvo: ALVO_PROMO,
        volta: detalheDepois({ preco_cheio: cheio }),
      });
      expect(resultado).toBe('deriva');
      expect(doEvento(m.linhas, 'deriva')).toHaveLength(1);
    },
  );

  it.each([
    ['`true`', true],
    ['the text `"false"`', 'false'],
  ] as const)(
    '⚠️ NEAR-MISS: `sob_consulta` read back as %s after false ⇒ `deriva` — the buyer sees it',
    async (_c, sob) => {
      const { m, resultado } = await escreverEConferir({
        alvo: ALVO_PROMO,
        volta: detalheDepois({ preco_sob_consulta: sob }),
      });
      expect(resultado).toBe('deriva');
      expect(doEvento(m.linhas, 'deriva')).toHaveLength(1);
    },
  );

  it('the custo is NEVER compared: sent 12.34 and read 99.99 ⇒ `igual`; omitted (null) and read 12.34 ⇒ `igual`', async () => {
    const enviado = await escreverEConferir({
      alvo: ALVO_PROMO,
      volta: detalheDepois({ preco_custo: 99.99 }),
    });
    expect(enviado.resultado).toBe('igual');
    expect(enviado.m.p.textosDosPuts[0]).toContain('"custo":12.34');

    const omitido = await escreverEConferir({
      alvo: ALVO_PROMO,
      p: plataforma({ over: { preco_custo: null } }),
      volta: detalheDepois({ preco_custo: 12.34 }),
    });
    expect(omitido.resultado).toBe('igual');
    expect(omitido.m.p.textosDosPuts[0]).not.toContain('"custo"');
    expect(doEvento(omitido.m.linhas, 'deriva')).toEqual([]);
  });

  it('a price deriva line still SHOWS the custo read', async () => {
    const { m } = await escreverEConferir({
      alvo: ALVO_PROMO,
      volta: detalheDepois({ preco_promocional: '22', preco_custo: 99.99 }),
    });
    const lido = JSON.parse(String(doEvento(m.linhas, 'deriva')[0]?.campos.lido)) as DocData;
    expect(lido.custo).toBe(99.99);
  });

  it('a lote has no read-back call: asking is a TypeError before any wait, nothing sent', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    expect((await escreverLi(m.motor, LOTE, preco(base, ALVO_PROMO), base)).kind).toBe('enviado');
    const marco = m.p.eventos.length;
    // @ts-expect-error — a lote has no read-back call
    const volta = lerDeVoltaLi(m.motor, ALVO, 'preco-produto-lote');
    await expect(volta).rejects.toThrow(TypeError);
    expect(m.p.eventos.slice(marco)).toEqual([]);
  });

  it('a read-back answered 404 is contained: `verificado: false`, LiNotFoundError', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base);
    m.p.fila.push(naProxima(CAMINHO, 'GET', () => respostaJson(404, undefined)));
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'preco-produto');
    expect(leitura).toMatchObject({ verificado: false, classe: 'LiNotFoundError' });
    if (leitura.verificado) throw new TypeError('verificada');
    expect(leitura.erro).toBeInstanceOf(LiNotFoundError);
  });

  it('a stock read-back for a price kind is a TypeError; so is a stock read-back CALL after a price write', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    const payload = preco(base, ALVO_PROMO);
    await escreverLi(m.motor, PRECO, payload, base);
    const estoque = {
      verificado: true,
      leitura: 'produto-estoque',
      produtoEstoque: liEstoqueProdutoDetalheSchema.parse(linhaEstoqueLi(PRODUTO_ID)),
      status: 200,
    } as const;
    expect(() => conferirEscritaLi(m.motor, PRECO, payload, estoque)).toThrow(TypeError);
    const marco = m.p.eventos.length;
    await expect(lerDeVoltaLi(m.motor, ALVO, 'estoque-produto')).rejects.toThrow(TypeError);
    expect(m.p.eventos.slice(marco)).toEqual([]);
  });

  it('the order-only reads refuse a price run: the situação history and a confirming read, nothing sent', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base);
    const marco = m.p.eventos.length;
    await expect(lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).rejects.toThrow(TypeError);
    await expect(confirmarCredencialLi(m.motor, ALVO)).rejects.toThrow(TypeError);
    expect(m.p.eventos.slice(marco)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 The PUT echo: ONE `eco` line, at zero calls                 */
/* -------------------------------------------------------------------------- */

describe('the PUT echo: ONE `eco` line after a landed price write, through the same predicate, zero calls', () => {
  /** One `on` write of `alvo` whose PUT answers `eco` (the store is not updated). */
  async function comEco(eco: () => Response, alvo: EnvioPrecoLi = ALVO_PROMO) {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    m.p.fila.push(naProxima(CAMINHO_PUT, 'PUT', eco));
    const payload = preco(base, alvo);
    const r = await escreverLi(m.motor, PRECO, payload, base);
    return { m, r, payload };
  }

  it('EQUAL pair: the default echo (the price row, its amounts as text) ⇒ `igual`, INFO, and no request after the PUT', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    const payload = preco(base, ALVO_PROMO);
    expect((await escreverLi(m.motor, PRECO, payload, base)).kind).toBe('enviado');
    expect(m.p.chamadas()).toEqual([`GET ${CAMINHO}`, `PUT ${CAMINHO_PUT}`]);
    const ecos = doEvento(m.linhas, 'eco');
    expect(ecos).toHaveLength(1);
    expect(ecos[0]?.severidade).toBe('INFO');
    expect(ecos[0]?.campos).toMatchObject({
      evento: 'eco',
      recurso: PRODUTO_ID,
      tipo: 'preco-produto',
      campo: 'preco',
      politica: 'valor',
      resultado: 'igual',
      leituraEco: 'ok',
      escrito: JSON.stringify(corpoPrecoProdutoLi(entradaDe(payload)).corpo),
      lido: JSON.stringify({
        cheio: '33',
        promocional: '22.22',
        custo: '12.34',
        sob_consulta: false,
      }),
    });
  });

  it.each([
    ['two-decimal text', { cheio: '33.00', promocional: '22.22' }, ALVO_PROMO],
    ['four-decimal text', { cheio: '33.0000', promocional: '22.2200' }, ALVO_PROMO],
    ['a clear echoed as null', { cheio: '33.00', promocional: null }, ALVO_LIMPA],
    ['a clear echoed as `"0.00"`', { cheio: '33.00', promocional: '0.00' }, ALVO_LIMPA],
    ['a clear echoed as `"0.0000"`', { cheio: '33.0000', promocional: '0.0000' }, ALVO_LIMPA],
  ] as const)('EQUAL pair: an echo in %s ⇒ `igual`', async (_c, corpo, alvo) => {
    const { m, r } = await comEco(() => respostaJson(200, { ...corpo, sob_consulta: false }), alvo);
    expect(r.kind).toBe('enviado');
    expect(doEvento(m.linhas, 'eco').map((l) => l.campos.resultado)).toEqual(['igual']);
  });

  it('⚠️ NEAR-MISS: an echo of `"22"` for 22.22 ⇒ `deriva`, WARNING — still `enviado`, no extra call', async () => {
    const { m, r } = await comEco(() =>
      respostaJson(200, { cheio: '33.00', promocional: '22', sob_consulta: false }),
    );
    expect(r.kind).toBe('enviado');
    const ecos = doEvento(m.linhas, 'eco');
    expect(ecos).toHaveLength(1);
    expect(ecos[0]?.severidade).toBe('WARNING');
    expect(ecos[0]?.campos.resultado).toBe('deriva');
    expect(ecos[0]?.campos.lido).toBe(
      JSON.stringify({ cheio: '33.00', promocional: '22', sob_consulta: false }),
    );
    expect(m.p.chamadas()).toEqual([`GET ${CAMINHO}`, `PUT ${CAMINHO_PUT}`]);
    expect(doEvento(m.linhas, 'deriva')).toEqual([]);
  });

  it.each([
    ['an empty 200', () => respostaJson(200, undefined)],
    [
      'a non-JSON 200',
      () =>
        new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
    ['a 202 with no body', () => new Response(null, { status: 202 })],
    ['a JSON array', () => respostaJson(200, [{ cheio: '33.00', promocional: '22.22' }])],
    ['an echo with no `cheio`', () => respostaJson(200, { promocional: '22.22' })],
    ['an echo with no `promocional`', () => respostaJson(200, { cheio: '33.00' })],
    ['an echo of another row entirely', () => respostaJson(200, { id: 9103 })],
  ])('⚠️ NEAR-MISS: %s ⇒ `sem-eco`, INFO — never a `deriva`, still `enviado`', async (_c, eco) => {
    const { m, r } = await comEco(eco);
    expect(r.kind).toBe('enviado');
    const ecos = doEvento(m.linhas, 'eco');
    expect(ecos).toHaveLength(1);
    expect(ecos[0]?.severidade).toBe('INFO');
    expect(ecos[0]?.campos.resultado).toBe('sem-eco');
    expect(m.p.chamadas()).toHaveLength(2);
  });

  it('`sob_consulta`: echoed `true` after false ⇒ `deriva`; ABSENT from the echo ⇒ not compared, `igual`', async () => {
    const verdadeiro = await comEco(() =>
      respostaJson(200, { cheio: '33.00', promocional: '22.22', sob_consulta: true }),
    );
    expect(doEvento(verdadeiro.m.linhas, 'eco')[0]?.campos.resultado).toBe('deriva');
    const ausente = await comEco(() => respostaJson(200, { cheio: '33.00', promocional: '22.22' }));
    expect(doEvento(ausente.m.linhas, 'eco')[0]?.campos.resultado).toBe('igual');
  });

  it('the echo is never asked of the custo: an echoed custo of 99.99 ⇒ `igual`', async () => {
    const { m } = await comEco(() =>
      respostaJson(200, {
        cheio: '33.00',
        promocional: '22.22',
        custo: '99.99',
        sob_consulta: false,
      }),
    );
    expect(doEvento(m.linhas, 'eco')[0]?.campos.resultado).toBe('igual');
  });

  it('a stock write logs NO eco line; a price lote logs exactly ONE', async () => {
    const estoque = await montar({ fluxo: 'estoque' });
    const be = lida(await lerBaseLi(estoque.motor, ALVO, 'produto-estoque'));
    await escreverLi(
      estoque.motor,
      { tipo: 'estoque-produto', alvo: ALVO },
      { campo: 'estoque', valor: { ...ESTOQUE_FIXO_ESCRITA_LI, quantidade: 7 } },
      be,
    );
    expect(doEvento(estoque.linhas, 'escrita')).toHaveLength(1);
    expect(doEvento(estoque.linhas, 'eco')).toEqual([]);

    const lote = await montar();
    const bl = lida(await lerBaseLi(lote.motor, ALVO, 'produto-detalhe'));
    await escreverLi(lote.motor, LOTE, preco(bl, ALVO_PROMO), bl);
    const ecos = doEvento(lote.linhas, 'eco');
    expect(ecos).toHaveLength(1);
    expect(ecos[0]?.campos).toMatchObject({ tipo: 'preco-produto-lote', resultado: 'igual' });
  });
});

/* -------------------------------------------------------------------------- */
/*                     A run that may not write: ONE diff line                */
/* -------------------------------------------------------------------------- */

describe('preco-produto not `on`: the deciding read, its restore line, ONE diff line, no PUT', () => {
  it.each([
    ['the valve at dry-run', MODO_LI.dryRun, '*', 'valvula'],
    ['`on` outside the canary', MODO_LI.on, 'outra-conta:1', 'fora-do-canario'],
  ])('%s ⇒ `nao-enviado`, nothing sent, no eco line', async (_c, modo, canario, motivo) => {
    const m = await montar({ modo, canario });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    const payload = preco(base, ALVO_PROMO);
    expect(await escreverLi(m.motor, PRECO, payload, base)).toEqual({
      kind: 'nao-enviado',
      motivo,
    });
    expect(m.p.chamadas()).toEqual([`GET ${CAMINHO}`]);
    expect(m.p.puts()).toEqual([]);
    expect(doEvento(m.linhas, 'restauracao')).toHaveLength(1);
    expect(doEvento(m.linhas, 'escrita')).toEqual([]);
    expect(doEvento(m.linhas, 'eco')).toEqual([]);
    expect(doEvento(m.linhas, 'diff').map((l) => l.campos)).toEqual([
      expect.objectContaining({
        recurso: PRODUTO_ID,
        tipo: 'preco-produto',
        campo: 'preco',
        politica: 'valor',
        antes: JSON.stringify({
          cheio: 55.55,
          promocional: 22.22,
          custo: 12.34,
          sob_consulta: false,
        }),
        depois: JSON.stringify(corpoPrecoProdutoLi(entradaDe(payload)).corpo),
        mudou: true,
        motivo,
      }),
    ]);
  });

  it.each([
    ['the target exactly, as numbers', { preco_cheio: 33, preco_promocional: 22.22 }],
    ['the target as four-decimal text', { preco_cheio: '33.0000', preco_promocional: '22.2200' }],
    ['the target as two-decimal text', { preco_cheio: '33.00', preco_promocional: '22.22' }],
  ])('EQUAL pair: a detail already holding %s ⇒ `mudou: false`', async (_c, over) => {
    const m = await montar({ modo: MODO_LI.dryRun, p: plataforma({ over }) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    await escreverLi(m.motor, PRECO, preco(base, ALVO_PROMO), base);
    expect(doEvento(m.linhas, 'diff')[0]?.campos.mudou).toBe(false);
  });

  it.each([
    [
      'a full price one centavo above',
      { preco_cheio: 33.01, preco_promocional: 22.22 },
      ALVO_PROMO,
    ],
    ['the promotion truncated (`"22"`)', { preco_cheio: 33, preco_promocional: '22' }, ALVO_PROMO],
    [
      'a promotion where the target clears',
      { preco_cheio: 33, preco_promocional: 22.22 },
      ALVO_LIMPA,
    ],
  ] as const)('⚠️ NEAR-MISS: a detail holding %s ⇒ `mudou: true`', async (_c, over, alvo) => {
    const m = await montar({ modo: MODO_LI.dryRun, p: plataforma({ over }) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'produto-detalhe'));
    await escreverLi(m.motor, PRECO, preco(base, alvo), base);
    expect(doEvento(m.linhas, 'diff')[0]?.campos.mudou).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                    A property sweep of the price read-back                  */
/* -------------------------------------------------------------------------- */

/** mulberry32: a deterministic generator in [0, 1). */
function gerador(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** One spelling of `centavos` as the store may hand it back, built with string arithmetic only. */
function grafia(centavos: number, qual: number): unknown {
  const resto = centavos % 100;
  const inteiros = String((centavos - resto) / 100);
  const fracao = String(resto).padStart(2, '0');
  switch (qual % 3) {
    case 0:
      return centavos / 100;
    case 1:
      return `${inteiros}.${fracao}`;
    default:
      return `${inteiros}.${fracao}00`;
  }
}

describe('conferirEscritaLi — a property sweep over drawn price writes', () => {
  // CI runners are about 5× slower under load: the sweep gets an explicit bound.
  it(
    '1,000 drawn cases: every spelling and any custo ⇒ `igual`; one centavo or a `sob_consulta` flip ⇒ ONE deriva',
    { timeout: 60_000 },
    async () => {
      const m = await montar();
      const r = gerador(0x13c0);
      const custos: readonly unknown[] = [null, 0, 12.34, '12.3400', 'abc', 99.99];
      const sorteio = <T>(lista: readonly T[]): T => lista[Math.floor(r() * lista.length)] as T;
      for (let n = 0; n < 1_000; n++) {
        const cheio = Math.max(2, Math.floor(Math.exp(r() * Math.log(1e9))));
        const promo = r() < 0.5 ? null : Math.max(2, Math.floor(Math.exp(r() * Math.log(1e9))));
        const forma = sorteio(FORMAS);
        const sobConsulta = r() < 0.5;
        const alvo: EnvioPrecoLi = {
          cheioCentavos: cheio,
          promo: promo === null ? 'limpar' : { centavos: promo },
        };
        const payload: PayloadEscritaLi = {
          campo: 'preco',
          valor: { alvo, formaPromoLimpa: forma, custo: sorteio(custos), sobConsulta },
        };
        const volta = (over: Partial<ProdutoComPrecoDetalheLi>) =>
          ({
            verificado: true,
            leitura: 'produto-detalhe',
            produtoDetalhe: {
              id: PRODUTO_ID,
              tipo: TIPO_PRODUTO_LI.atributoOpcao,
              ativo: true,
              bloqueado: false,
              removido: false,
              preco_cheio: grafia(cheio, Math.floor(r() * 3)),
              preco_promocional: promo === null ? null : grafia(promo, Math.floor(r() * 3)),
              preco_custo: sorteio(custos),
              preco_sob_consulta: sobConsulta,
              ...over,
            },
            status: 200,
          }) as const;
        const antes = doEvento(m.linhas, 'deriva').length;
        expect(conferirEscritaLi(m.motor, PRECO, payload, volta({})), `igual #${String(n)}`).toBe(
          'igual',
        );
        expect(doEvento(m.linhas, 'deriva')).toHaveLength(antes);
        const quaseCheio = volta({ preco_cheio: grafia(cheio + (r() < 0.5 ? -1 : 1), n) });
        expect(conferirEscritaLi(m.motor, PRECO, payload, quaseCheio), `cheio #${String(n)}`).toBe(
          'deriva',
        );
        expect(doEvento(m.linhas, 'deriva')).toHaveLength(antes + 1);
        expect(doEvento(m.linhas, 'deriva')[antes]?.severidade).toBe('WARNING');
        const quaseSob = volta({ preco_sob_consulta: !sobConsulta });
        expect(conferirEscritaLi(m.motor, PRECO, payload, quaseSob), `sob #${String(n)}`).toBe(
          'deriva',
        );
        expect(doEvento(m.linhas, 'deriva')).toHaveLength(antes + 2);
      }
      // Nothing was sent: the sweep compares constructed read-backs only.
      expect(m.p.requisicoes).toEqual([]);
    },
  );
});
