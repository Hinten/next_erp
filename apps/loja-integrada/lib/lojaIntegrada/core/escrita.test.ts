/**
 * The write engine (master plan step 7, PR 7-b), requirement by requirement
 * (PLAN step 7, "The write engine (7-b)", items 1–10).
 * Requirement 8 (`deepEqual`) has its own suite (`igualdadeJsonLi.test.ts`);
 * requirement 9 (the chokepoint) is `estrutura.test.ts`'s; requirement 10 (bulk
 * mode) is not built here — it ships with its first consumer.
 *
 * D17: the platform is a stub `fetch` handed to the write context; the global
 * `fetch` is stubbed to throw for every test of this file, and the unit
 * config's network kill-switch fails anything that would reach a real host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
} from '@delfrance/integrations-loja-integrada';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { FakeDb, type DocData, asDb, grpc } from '../testing/fakeDb';
import {
  AGORA_MS,
  TOKEN_B,
  caminhoCredencial,
  gravadorDeLog,
  seedConta,
  seedCredencial,
  type LinhaGravada,
} from '../testing/fixtures';
import { ID_ENVIO_LI, NUMERO_LI, linhaHistoricoLi, pedidoLiBruto } from '../testing/pedidosLi';
import { __setRelogioDoCacheParaTestes } from './contaCache';
import {
  type ContextoEscritaLojaIntegrada,
  loadLojaIntegradaContextoEscrita,
} from './contextoEscrita';
import { removerCredencial } from './credentialStore';
import {
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiCredencialTrocadaError,
} from './erros';
import {
  type BaseLidaLi,
  CAMPO_DO_TIPO_ESCRITA_LI,
  CLASSES_CONTIDAS_LI,
  type ClasseContidaLi,
  type InicioEscritaLi,
  LEITURA_PREVIA_LI,
  MAX_PAGINAS_HISTORICO_CONFERENCIA_LI,
  POLITICA_CAMPO_ESCRITA_LI,
  PRAZO_ULTIMA_ESCRITA_MS,
  PrazoDeEscritaEsgotadoLiError,
  type TipoEscritaLi,
  conferirEscritaLi,
  confirmarCredencialLi,
  criarMotorEscritaLi,
  escreverLi,
  iniciarEscritaLi,
  lerBaseLi,
  lerDeVoltaLi,
  lerHistoricoSituacaoParaConferenciaLi,
} from './escrita';
import { MAX_LINHA_RESTAURACAO_BYTES, linhaSerializadaLi } from './log';
import { bytesUtf8 } from './redacao';
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
const ALVO: AlvoLi = { contaId: ID, recurso: NUMERO_LI };
const CODIGO = 'PJ258408772BR';
const CAMINHO_PEDIDO = `/v1/pedido/${String(NUMERO_LI)}/`;
const CAMINHO_SITUACAO = `/v1/situacao/pedido/${String(NUMERO_LI)}`;
const CAMINHO_ENVIO = `/v1/pedido_envio/${String(ID_ENVIO_LI)}`;

/** The read switch on, the rastreio valve and canary as given (`null`: unset). */
function ambiente(modo: string | null, canario: string | null = '*'): AmbienteLi {
  return {
    [CHAMADAS_ENV_LI]: MODO_LI.on,
    ...(modo === null ? {} : { [VALVULA_ENV_LI.rastreio]: modo }),
    ...(canario === null ? {} : { [CANARIO_ENV_LI.rastreio]: canario }),
  };
}

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  // D17, per file: nothing here may reach the global `fetch` — every client gets the stub platform.
  vi.stubGlobal('fetch', () => {
    throw new Error('escrita.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                              The stub platform                             */
/* -------------------------------------------------------------------------- */

interface Requisicao {
  readonly metodo: string;
  readonly caminho: string;
  readonly corpo: unknown;
  readonly autorizacao: string | undefined;
}

/** A one-shot answer for the first request it claims (a non-null result). */
type Sobrescrita = (
  r: Requisicao,
  init: RequestInit | undefined,
) => Response | Error | Promise<Response> | null;

function json(status: number, corpo: unknown, tipo = 'application/json'): Response {
  return new Response(corpo === undefined ? '' : JSON.stringify(corpo), {
    status,
    headers: { 'content-type': tipo },
  });
}

/** A 2xx whose body read is cut after the headers arrived, by `erro`. */
function cortada(status: number, erro: Error): Response {
  const corpo = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"id":'));
      c.error(erro);
    },
  });
  return new Response(corpo, { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A stateful Loja Integrada: one order, its history, the two write routes. A
 * code PUT moves the order to `pedido_enviado` (as the painel does) unless told
 * not to. Every request and every pacer wait goes on ONE timeline (`eventos`);
 * every request and every engine log line on another (`linhaDoTempo`).
 */
function criarPlataforma(o: { moverAoEscreverObjeto?: boolean } = {}) {
  const estado: { pedido: DocData; historico: DocData[] } = {
    pedido: pedidoLiBruto(),
    historico: [],
  };
  const requisicoes: Requisicao[] = [];
  const eventos: string[] = [];
  const linhaDoTempo: string[] = [];
  const fila: Sobrescrita[] = [];

  const envios = () => estado.pedido.envios as DocData[];

  function padrao(r: Requisicao): Response {
    if (r.metodo === 'GET' && r.caminho === CAMINHO_PEDIDO) return json(200, estado.pedido);
    if (r.metodo === 'GET' && /^\/v1\/pedido\/\d+\/$/.test(r.caminho)) return json(404, {});
    if (r.metodo === 'GET' && r.caminho === '/v1/situacao_historico/search/') {
      return json(200, {
        meta: {
          limit: 50,
          offset: 0,
          next: null,
          previous: null,
          total_count: estado.historico.length,
        },
        objects: estado.historico,
      });
    }
    if (r.metodo === 'PUT' && r.caminho.startsWith('/v1/pedido_envio/')) {
      const id = Number(r.caminho.slice('/v1/pedido_envio/'.length));
      const envio = envios().find((e) => e.id === id);
      if (envio === undefined) return json(404, {});
      envio.objeto = (r.corpo as { objeto: string }).objeto;
      if (o.moverAoEscreverObjeto !== false) {
        estado.pedido.situacao = { codigo: 'pedido_enviado', id: 11 };
      }
      return json(200, envio);
    }
    if (r.metodo === 'PUT' && r.caminho === CAMINHO_SITUACAO) {
      estado.pedido.situacao = { codigo: (r.corpo as { codigo: string }).codigo };
      return json(200, estado.pedido.situacao);
    }
    return json(500, { erro: 'rota nao roteirizada' });
  }

  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    const r: Requisicao = {
      metodo,
      caminho: url.pathname,
      corpo: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      autorizacao: (init?.headers as Record<string, string> | undefined)?.Authorization,
    };
    requisicoes.push(r);
    eventos.push(`${metodo} ${url.pathname}`);
    linhaDoTempo.push(`${metodo} ${url.pathname}`);
    const primeira = fila[0];
    const sobrescrita = primeira === undefined ? null : primeira(r, init);
    if (sobrescrita !== null) {
      fila.shift();
      if (sobrescrita instanceof Error) return Promise.reject(sobrescrita);
      return Promise.resolve(sobrescrita);
    }
    return Promise.resolve(padrao(r));
  };

  const esperas: number[] = [];
  const esperar = (ms: number) => {
    esperas.push(ms);
    eventos.push(`espera ${String(ms)}`);
    return Promise.resolve();
  };
  const puts = () => requisicoes.filter((r) => r.metodo === 'PUT');
  return { estado, requisicoes, eventos, linhaDoTempo, fila, fetch, esperar, esperas, puts };
}

type Plataforma = ReturnType<typeof criarPlataforma>;

interface Montagem {
  readonly db: FakeDb;
  readonly p: Plataforma;
  readonly linhas: LinhaGravada[];
  readonly contexto: ContextoEscritaLojaIntegrada;
  readonly inicio: InicioEscritaLi & { readonly kind: 'ativo' };
  readonly motor: ReturnType<typeof criarMotorEscritaLi>;
}

async function montar(
  o: {
    ambiente?: AmbienteLi;
    p?: Plataforma;
    agora?: () => number;
    inicioDaTarefaMs?: number;
    /** Runs before each CALL line the context's observers write; it may throw. */
    antesDaLinhaDeChamada?: (campos: Readonly<Record<string, unknown>>) => void;
  } = {},
): Promise<Montagem> {
  const db = new FakeDb();
  seedConta(db, ID);
  seedCredencial(db, ID);
  const p = o.p ?? criarPlataforma();
  const gravador = gravadorDeLog();
  const amb = o.ambiente ?? ambiente(MODO_LI.on);
  const inicio = iniciarEscritaLi(FLUXO_LI.rastreio, amb, {
    conta: ID,
    escrever: gravador.escrever,
  });
  if (inicio.kind !== 'ativo') throw new TypeError('montar: a válvula está desligada');
  const contexto = await loadLojaIntegradaContextoEscrita(asDb(db), ID, {
    ambiente: amb,
    esperar: p.esperar,
    fetch: p.fetch,
    registro: {
      escrever: (severidade, mensagem, campos) => {
        if (campos.evento === 'chamada') o.antesDaLinhaDeChamada?.(campos);
        gravador.escrever(severidade, mensagem, campos);
      },
      fluxo: FLUXO_LI.rastreio,
    },
  });
  const motor = criarMotorEscritaLi({
    inicio,
    contexto,
    agora: o.agora ?? (() => AGORA_MS),
    inicioDaTarefaMs: o.inicioDaTarefaMs ?? AGORA_MS,
    registro: {
      escrever: (severidade, mensagem, campos) => {
        gravador.escrever(severidade, mensagem, campos);
        p.linhaDoTempo.push(`log ${String(campos.evento)}`);
      },
      tentativa: 1,
      idTarefa: 't-1',
    },
  });
  return { db, p, linhas: gravador.linhas, contexto, inicio, motor };
}

function lida(base: Awaited<ReturnType<typeof lerBaseLi>>): BaseLidaLi {
  if (base.kind !== 'lida') throw new TypeError(`base ${base.kind}`);
  return base;
}

const doEvento = (linhas: readonly LinhaGravada[], evento: string) =>
  linhas.filter((l) => l.campos.evento === evento);

const SITUACAO = { tipo: 'situacao-pedido', alvo: ALVO } as const;
const OBJETO = { tipo: 'objeto-envio', alvo: ALVO, envioId: ID_ENVIO_LI } as const;
const ENVIADO = { campo: 'codigo', valor: 'pedido_enviado' } as const;
const COM_CODIGO = { campo: 'objeto', valor: CODIGO } as const;

/* -------------------------------------------------------------------------- */
/*                  Requirement 1: the valve first, off = nothing             */
/* -------------------------------------------------------------------------- */

describe('requirement 1 — the valve is read first; off reaches nothing; a dry-run cannot write', () => {
  it.each([
    ['unset', null],
    ['off', 'off'],
    ['a typo (ON)', 'ON'],
    ['dry_run', 'dry_run'],
  ])('%s ⇒ desligado, ONE run-start line, and no motor can be built from it', (_caso, modo) => {
    const gravador = gravadorDeLog();
    const inicio = iniciarEscritaLi(FLUXO_LI.rastreio, ambiente(modo), {
      conta: ID,
      escrever: gravador.escrever,
    });
    expect(inicio.kind).toBe('desligado');
    expect(gravador.linhas).toHaveLength(1);
    expect(gravador.linhas[0]?.campos).toMatchObject({
      evento: 'valvula',
      fluxo: 'rastreio',
      modo: 'off',
    });
    expect(gravador.linhas[0]?.severidade).toBe(
      modo === 'ON' || modo === 'dry_run' ? 'WARNING' : 'INFO',
    );
    expect(() =>
      criarMotorEscritaLi({
        // @ts-expect-error — a switched-off start never builds a motor
        inicio,
        contexto: {} as never,
        agora: () => AGORA_MS,
        inicioDaTarefaMs: AGORA_MS,
      }),
    ).toThrow(TypeError);
  });

  it('with `off`, no engine call can run: each refuses a motor criarMotorEscritaLi did not build — the fake db and the fetch stub see ZERO calls', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID);
    const p = criarPlataforma();
    const inicio = iniciarEscritaLi(FLUXO_LI.rastreio, ambiente('off'), {
      conta: ID,
      escrever: () => undefined,
    });
    expect(inicio.kind).toBe('desligado');
    // A motor-shaped object built from the switched-off start: the engine refuses it, by name.
    const forjado = { integracaoId: ID, valvula: inicio.valvula };
    const naoCriado = /criarMotorEscritaLi/;
    await expect(lerBaseLi(forjado, ALVO, 'pedido')).rejects.toThrow(naoCriado);
    await expect(lerDeVoltaLi(forjado, ALVO, 'situacao-pedido')).rejects.toThrow(naoCriado);
    await expect(lerHistoricoSituacaoParaConferenciaLi(forjado, ALVO)).rejects.toThrow(naoCriado);
    await expect(confirmarCredencialLi(forjado, ALVO)).rejects.toThrow(naoCriado);
    expect(db.leituras).toEqual([]);
    expect(p.requisicoes).toEqual([]);
    expect(p.esperas).toEqual([]);
  });

  it('⚠️ a start opens ONE motor: a second criarMotorEscritaLi from the same start is a TypeError', async () => {
    const m = await montar();
    expect(() =>
      criarMotorEscritaLi({
        inicio: m.inicio,
        contexto: m.contexto,
        agora: () => AGORA_MS,
        inicioDaTarefaMs: AGORA_MS,
      }),
    ).toThrow(TypeError);
    // The run that holds the motor still writes once, and only once.
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, base)).kind).toBe('enviado');
    expect(m.p.puts()).toHaveLength(1);
  });

  it('EQUAL pair: a fresh iniciarEscritaLi — a new run-start line — opens a new motor', async () => {
    const m = await montar();
    const gravador = gravadorDeLog();
    const nova = iniciarEscritaLi(FLUXO_LI.rastreio, ambiente(MODO_LI.on), {
      conta: ID,
      escrever: gravador.escrever,
    });
    if (nova.kind !== 'ativo') throw new TypeError(nova.kind);
    expect(gravador.linhas.map((l) => l.campos.evento)).toEqual(['valvula']);
    const outro = criarMotorEscritaLi({
      inicio: nova,
      contexto: m.contexto,
      agora: () => AGORA_MS,
      inicioDaTarefaMs: AGORA_MS,
    });
    expect(outro).not.toBe(m.motor);
  });

  it('⚠️ a hand-built "ativo" start is refused: the only motor is one iniciarEscritaLi opened', async () => {
    const m = await montar();
    const falsificado = {
      kind: 'ativo',
      valvula: { fluxo: 'rastreio', modo: 'on', modoReconhecido: true, canario: { tipo: 'todos' } },
    } as const;
    expect(() =>
      criarMotorEscritaLi({
        inicio: falsificado,
        contexto: {} as never,
        agora: () => AGORA_MS,
        inicioDaTarefaMs: AGORA_MS,
      }),
    ).toThrow(TypeError);
    expect(m.p.requisicoes).toEqual([]);
  });

  it('dry-run: the deciding read and one diff line per field — ZERO PUTs, no write result, nothing stamped', async () => {
    const m = await montar({ ambiente: ambiente(MODO_LI.dryRun) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    const r1 = await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    const r2 = await escreverLi(m.motor, SITUACAO, ENVIADO, base);
    expect(r1).toEqual({ kind: 'nao-enviado', motivo: 'valvula' });
    expect(r2).toEqual({ kind: 'nao-enviado', motivo: 'valvula' });
    expect('resposta' in r1).toBe(false);
    expect(m.p.puts()).toEqual([]);
    expect(doEvento(m.linhas, 'diff').map((l) => l.campos)).toEqual([
      expect.objectContaining({
        evento: 'diff',
        conta: ID,
        fluxo: 'rastreio',
        recurso: NUMERO_LI,
        tipo: 'objeto-envio',
        campo: 'objeto',
        politica: 'valor',
        antes: 'null',
        depois: JSON.stringify(CODIGO),
        mudou: true,
        motivo: 'valvula',
      }),
      expect.objectContaining({
        tipo: 'situacao-pedido',
        campo: 'codigo',
        antes: '"pedido_pago"',
        depois: '"pedido_enviado"',
        motivo: 'valvula',
      }),
    ]);
    // Nothing was "sent": there is no write to read back.
    await expect(lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido')).rejects.toThrow(TypeError);
    expect(doEvento(m.linhas, 'escrita')).toEqual([]);
  });

  it.each([
    ['unset: no target', null, 'sem-canario'],
    ['blank: no target', '', 'sem-canario'],
    ['another target listed', `${ID}:90010`, 'fora-do-canario'],
  ])('on with the canary %s ⇒ dry-run (%s): a diff, zero PUTs', async (_caso, canario, motivo) => {
    const m = await montar({ ambiente: ambiente(MODO_LI.on, canario) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect(await escreverLi(m.motor, SITUACAO, ENVIADO, base)).toEqual({
      kind: 'nao-enviado',
      motivo,
    });
    expect(m.p.puts()).toEqual([]);
    expect(doEvento(m.linhas, 'diff')).toHaveLength(1);
  });

  it('EQUAL pair: the diff of a value LI already holds says `mudou: false`', async () => {
    const m = await montar({ ambiente: ambiente(MODO_LI.dryRun) });
    m.p.estado.pedido = pedidoLiBruto({ envios: [{ id: ID_ENVIO_LI, objeto: CODIGO }] });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    expect(doEvento(m.linhas, 'diff')[0]?.campos).toMatchObject({
      antes: JSON.stringify(CODIGO),
      depois: JSON.stringify(CODIGO),
      mudou: false,
    });
  });

  it.each([
    ['the same code with a trailing space', `${CODIGO} `],
    ['the same code in another case', CODIGO.toLowerCase()],
    ['an empty string', ''],
  ])('⚠️ NEAR-MISS: a diff against %s says `mudou: true`', async (_caso, lido) => {
    const m = await montar({ ambiente: ambiente(MODO_LI.dryRun) });
    m.p.estado.pedido = pedidoLiBruto({ envios: [{ id: ID_ENVIO_LI, objeto: lido }] });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    expect(doEvento(m.linhas, 'diff')[0]?.campos.mudou).toBe(true);
  });

  it('⚠️ NEAR-MISS: under dry-run the canary is NOT consulted — a list naming this target still writes nothing', async () => {
    const m = await montar({ ambiente: ambiente(MODO_LI.dryRun, `${ID}:${String(NUMERO_LI)}`) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect(await escreverLi(m.motor, SITUACAO, ENVIADO, base)).toEqual({
      kind: 'nao-enviado',
      motivo: 'valvula',
    });
    expect(m.p.puts()).toEqual([]);
  });

  it('EQUAL pair: on with the target listed, or with `*`, sends the PUT', async () => {
    for (const canario of [`${ID}:${String(NUMERO_LI)}`, '*']) {
      __resetAllReadCaches();
      const m = await montar({ ambiente: ambiente(MODO_LI.on, canario) });
      const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      const r = await escreverLi(m.motor, SITUACAO, ENVIADO, base);
      expect(r.kind, canario).toBe('enviado');
      expect(m.p.puts().map((x) => [x.caminho, x.corpo])).toEqual([
        [CAMINHO_SITUACAO, { codigo: 'pedido_enviado' }],
      ]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*              Requirement 2: one pre-write read per write kind              */
/* -------------------------------------------------------------------------- */

describe('requirement 2 — one pre-write read per write kind, in a table keyed by the kind', () => {
  it('the table is total over the kinds and names the reader AND the read-back strategy', () => {
    expect(Object.keys(LEITURA_PREVIA_LI).sort()).toEqual(['objeto-envio', 'situacao-pedido']);
    for (const tipo of Object.keys(LEITURA_PREVIA_LI) as TipoEscritaLi[]) {
      expect(LEITURA_PREVIA_LI[tipo]).toEqual({
        leitura: 'pedido',
        leituraDeVolta: 'recurso',
        obrigatoria: true,
        ausente: 'dry-run',
      });
    }
    expect(CAMPO_DO_TIPO_ESCRITA_LI).toEqual({
      'objeto-envio': 'objeto',
      'situacao-pedido': 'codigo',
    });
    // A kind without a row does not compile.
    // @ts-expect-error — `catalogo` is not a write kind yet
    expect(LEITURA_PREVIA_LI.catalogo).toBeUndefined();
  });

  it('both kinds share ONE GET of the order detail, in the slash form', async () => {
    const m = await montar();
    await lerBaseLi(m.motor, ALVO, 'pedido');
    expect(m.p.requisicoes.map((r) => `${r.metodo} ${r.caminho}`)).toEqual([
      `GET ${CAMINHO_PEDIDO}`,
    ]);
  });

  it('the reader is the table’s: a base records which reader read it, and only a reader the table names compiles', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, LEITURA_PREVIA_LI['situacao-pedido'].leitura));
    expect(base.leitura).toBe('pedido');
    for (const tipo of Object.keys(LEITURA_PREVIA_LI) as TipoEscritaLi[]) {
      expect(LEITURA_PREVIA_LI[tipo].leitura, tipo).toBe(base.leitura);
    }
    // @ts-expect-error — a reader no row names does not exist yet
    await expect(lerBaseLi(m.motor, ALVO, 'pagina')).rejects.toThrow(TypeError);
    expect(m.p.requisicoes).toHaveLength(1);
  });

  it('a 404 base ⇒ `ausente`: no restore line, no pin, and it is never a base for a write', async () => {
    const m = await montar();
    const outro: AlvoLi = { contaId: ID, recurso: 404 };
    const base = await lerBaseLi(m.motor, outro, 'pedido');
    expect(base).toEqual({ kind: 'ausente', alvo: outro });
    expect(doEvento(m.linhas, 'restauracao')).toEqual([]);
    expect(m.contexto.credencial.fixada()).toBeNull();
    await expect(
      // @ts-expect-error — an absent base cannot decide a write
      escreverLi(m.motor, { tipo: 'situacao-pedido', alvo: outro }, ENVIADO, base),
    ).rejects.toThrow(TypeError);
    expect(m.p.puts()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*            Requirement 3: the target, the conta and the credential         */
/* -------------------------------------------------------------------------- */

describe('requirement 3 — the writer receives the target; the conta and the credential are the deciding read’s', () => {
  it('another conta’s target is refused before any request, by the read and by the write', async () => {
    const m = await montar();
    const alheio: AlvoLi = { contaId: 'outra-conta', recurso: NUMERO_LI };
    await expect(lerBaseLi(m.motor, alheio, 'pedido')).rejects.toThrow(TypeError);
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(
      escreverLi(m.motor, { tipo: 'situacao-pedido', alvo: alheio }, ENVIADO, base),
    ).rejects.toThrow(TypeError);
    expect(m.p.puts()).toEqual([]);
  });

  it('an envio id absent from the target’s base throws, with zero PUTs', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(
      escreverLi(m.motor, { tipo: 'objeto-envio', alvo: ALVO, envioId: 802 }, COM_CODIGO, base),
    ).rejects.toThrow(TypeError);
    expect(m.p.puts()).toEqual([]);
  });

  it('a base read for another order of the same conta is refused', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    const outro: AlvoLi = { contaId: ID, recurso: NUMERO_LI + 1 };
    await expect(
      escreverLi(m.motor, { tipo: 'situacao-pedido', alvo: outro }, ENVIADO, base),
    ).rejects.toThrow(TypeError);
    expect(m.p.puts()).toEqual([]);
  });

  it('a payload for the other kind is refused (the codigo on the envio route)', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, OBJETO, ENVIADO, base)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toEqual([]);
  });

  it('the situação URL’s numero IS the canary key’s numero', async () => {
    const m = await montar({ ambiente: ambiente(MODO_LI.on, `${ID}:${String(NUMERO_LI)}`) });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, SITUACAO, ENVIADO, base);
    expect(m.p.puts()[0]?.caminho).toBe(`/v1/situacao/pedido/${String(ALVO.recurso)}`);
  });

  it('⚠️ a token re-saved between the deciding GET and the PUT ⇒ zero PUTs, LiCredencialTrocadaError', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    seedCredencial(m.db, ID, { personalToken: TOKEN_B, tokenAtualizadoEmMs: AGORA_MS });
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, base)).rejects.toBeInstanceOf(
      LiCredencialTrocadaError,
    );
    expect(m.p.puts()).toEqual([]);
  });

  it('⚠️ re-saved between the PUT and the confirming GET ⇒ the confirm is not sent', async () => {
    const m = await montar();
    m.p.fila.push((r) => (r.metodo === 'PUT' ? json(403, { error: 'forbidden' }) : null));
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, base)).rejects.toMatchObject({
      name: 'LiAuthError',
    });
    seedCredencial(m.db, ID, { personalToken: TOKEN_B, tokenAtualizadoEmMs: AGORA_MS });
    const antes = m.p.requisicoes.length;
    await expect(confirmarCredencialLi(m.motor, ALVO)).rejects.toBeInstanceOf(
      LiCredencialTrocadaError,
    );
    expect(m.p.requisicoes).toHaveLength(antes);
  });

  it('the confirming GET is paced ONE interval, goes to the order detail, and uses the pinned credential', async () => {
    const m = await montar();
    m.p.fila.push((r) => (r.metodo === 'PUT' ? json(403, {}) : null));
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    const err = (await escreverLi(m.motor, SITUACAO, ENVIADO, base).catch(
      (e: unknown) => e,
    )) as LiAuthError;
    expect(err.name).toBe('LiAuthError');
    const marco = m.p.eventos.length;
    await confirmarCredencialLi(m.motor, ALVO);
    expect(m.p.eventos.slice(marco)).toEqual([
      `espera ${String(RITMO_ESCRITA_LI_MS)}`,
      `GET ${CAMINHO_PEDIDO}`,
    ]);
    expect(new Set(m.p.requisicoes.map((r) => r.autorizacao)).size).toBe(1);
  });

  it('⚠️ a confirming GET before any deciding read has no pin to confirm: TypeError, zero requests', async () => {
    const m = await montar();
    await expect(confirmarCredencialLi(m.motor, ALVO)).rejects.toThrow(TypeError);
    expect(m.p.requisicoes).toEqual([]);
    expect(m.p.esperas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 Requirement 4: the restore snapshot, each write            */
/* -------------------------------------------------------------------------- */

describe('requirement 4 — a restore line before EACH write, from its own deciding read', () => {
  it('the line precedes the PUT; the buyer is redacted, the tracking code and the envio id survive', async () => {
    const m = await montar();
    m.p.estado.pedido = pedidoLiBruto({
      envios: [{ id: ID_ENVIO_LI, objeto: 'AA123456789BR', prazo: 5 }],
    });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect(base.restauracao).toBe(true);
    await escreverLi(m.motor, SITUACAO, ENVIADO, base);
    // On one timeline of requests and engine lines: the read, ITS restore line,
    // then the write, then the write's own line — never a snapshot after the PUT.
    expect(m.p.linhaDoTempo).toEqual([
      `GET ${CAMINHO_PEDIDO}`,
      'log restauracao',
      `PUT ${CAMINHO_SITUACAO}`,
      'log escrita',
    ]);
    const [linha] = doEvento(m.linhas, 'restauracao');
    expect(linha?.severidade).toBe('INFO');
    const corpo = JSON.parse(String(linha?.campos.corpo)) as DocData;
    expect(corpo).toMatchObject({
      numero: NUMERO_LI,
      situacao: { codigo: 'pedido_pago' },
      envios: [{ id: ID_ENVIO_LI, objeto: 'AA123456789BR' }],
      cliente: { nome: '<redacted>', email: '<redacted>' },
    });
    expect(String(linha?.campos.corpo)).not.toContain('Comprador');
  });

  /** The restore line's byte length for an order padded with a key of `n` letters. */
  async function bytesComChave(
    n: number,
  ): Promise<{ bytes: number; m: Montagem; base: BaseLidaLi }> {
    const m = await montar();
    m.p.estado.pedido = { ...pedidoLiBruto(), ['a'.repeat(n)]: null };
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    const [l] = doEvento(m.linhas, 'restauracao');
    const bytes =
      l === undefined
        ? Number.NaN
        : bytesUtf8(linhaSerializadaLi(l.severidade, l.mensagem, l.campos));
    return { bytes, m, base };
  }

  it('EQUAL pair: a restore line of exactly 200 KB is written, and the PUT goes', async () => {
    const { bytes: base1 } = await bytesComChave(1);
    const n = MAX_LINHA_RESTAURACAO_BYTES - base1 + 1;
    __resetAllReadCaches();
    const { bytes, m, base } = await bytesComChave(n);
    expect(bytes).toBe(MAX_LINHA_RESTAURACAO_BYTES);
    expect(base.restauracao).toBe(true);
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, base)).kind).toBe('enviado');
  });

  it('⚠️ NEAR-MISS: one byte more ⇒ NO line and NO write (`sem-restauracao`) — never a truncated snapshot', async () => {
    const { bytes: base1 } = await bytesComChave(1);
    const n = MAX_LINHA_RESTAURACAO_BYTES - base1 + 2;
    __resetAllReadCaches();
    const { m, base } = await bytesComChave(n);
    expect(base.restauracao).toBe(false);
    expect(doEvento(m.linhas, 'restauracao')).toEqual([]);
    expect(await escreverLi(m.motor, SITUACAO, ENVIADO, base)).toEqual({ kind: 'sem-restauracao' });
    expect(m.p.puts()).toEqual([]);
  });

  it('⚠️ NEAR-MISS: nesting deeper than 256 ⇒ no restore line, no write', async () => {
    const m = await montar();
    let fundo: unknown = 1;
    for (let i = 0; i < 257; i++) fundo = [fundo];
    m.p.estado.pedido = { ...pedidoLiBruto(), x: fundo };
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect(base.restauracao).toBe(false);
    expect(await escreverLi(m.motor, SITUACAO, ENVIADO, base)).toEqual({ kind: 'sem-restauracao' });
    expect(m.p.puts()).toEqual([]);
  });

  it('⚠️ after a REFUSED code PUT, the next PUT needs a SECOND deciding read with its own restore line — reusing the first base throws', async () => {
    const m = await montar();
    m.p.fila.push((r) => (r.metodo === 'PUT' ? json(400, {}) : null));
    const primeira = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, OBJETO, COM_CODIGO, primeira)).rejects.toMatchObject({
      name: 'LiHttpError',
    });
    // The mutation "decide the situação from the first read" is refused, with nothing sent.
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, primeira)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toHaveLength(1);
    const segunda = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, segunda)).kind).toBe('enviado');
    expect(doEvento(m.linhas, 'restauracao')).toHaveLength(2);
    expect(m.p.linhaDoTempo).toEqual([
      `GET ${CAMINHO_PEDIDO}`,
      'log restauracao',
      `PUT ${CAMINHO_ENVIO}`,
      `GET ${CAMINHO_PEDIDO}`,
      'log restauracao',
      `PUT ${CAMINHO_SITUACAO}`,
      'log escrita',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*               Requirement 5: the diff, the read-back, the policy           */
/* -------------------------------------------------------------------------- */

describe('requirement 5 — dry-run diffs, a separate read-back with its deriva, a policy per field', () => {
  it('every field declares its policy, and both write-back fields log their value', () => {
    expect(POLITICA_CAMPO_ESCRITA_LI).toEqual({ objeto: 'valor', codigo: 'valor' });
  });

  it('the write sends ONE request — the read-back is a separate call, two intervals after it', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    const marco = m.p.eventos.length;
    await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    expect(m.p.eventos.slice(marco)).toEqual([`PUT ${CAMINHO_ENVIO}`]);
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'objeto-envio');
    expect(m.p.eventos.slice(marco + 1)).toEqual([
      `espera ${String(RITMO_ESCRITA_LI_MS)}`,
      `espera ${String(RITMO_ESCRITA_LI_MS)}`,
      `GET ${CAMINHO_PEDIDO}`,
    ]);
    expect(leitura.verificado).toBe(true);
  });

  it('EQUAL pair: the read-back holding what was written ⇒ `igual`, no deriva line', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'objeto-envio');
    if (!leitura.verificado) throw new TypeError('não verificada');
    expect(conferirEscritaLi(m.motor, OBJETO, COM_CODIGO, leitura)).toBe('igual');
    expect(doEvento(m.linhas, 'deriva')).toEqual([]);
  });

  it.each([
    ['another code', 'OUTRO12345BR'],
    ['the same code in another case', CODIGO.toLowerCase()],
    ['the same code with a trailing space', `${CODIGO} `],
    ['null', null],
  ])(
    '⚠️ NEAR-MISS: a read-back holding %s ⇒ `deriva` and ONE WARNING line',
    async (_caso, lido) => {
      const m = await montar();
      const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
      m.p.fila.push((r) =>
        r.metodo === 'GET'
          ? json(200, pedidoLiBruto({ envios: [{ id: ID_ENVIO_LI, objeto: lido }] }))
          : null,
      );
      const leitura = await lerDeVoltaLi(m.motor, ALVO, 'objeto-envio');
      if (!leitura.verificado) throw new TypeError('não verificada');
      expect(conferirEscritaLi(m.motor, OBJETO, COM_CODIGO, leitura)).toBe('deriva');
      const derivas = doEvento(m.linhas, 'deriva');
      expect(derivas).toHaveLength(1);
      expect(derivas[0]?.severidade).toBe('WARNING');
      expect(derivas[0]?.campos).toMatchObject({
        campo: 'objeto',
        escrito: JSON.stringify(CODIGO),
        lido: JSON.stringify(lido),
      });
    },
  );

  it('⚠️ NEAR-MISS: the envio missing from the read-back is a deriva, its value `<ausente>`', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    m.p.fila.push((r) => (r.metodo === 'GET' ? json(200, pedidoLiBruto({ envios: [] })) : null));
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'objeto-envio');
    if (!leitura.verificado) throw new TypeError('não verificada');
    expect(conferirEscritaLi(m.motor, OBJETO, COM_CODIGO, leitura)).toBe('deriva');
    expect(doEvento(m.linhas, 'deriva')[0]?.campos.lido).toBe('<ausente>');
  });

  it('the situação read-back compares the codigo EXACTLY', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, SITUACAO, ENVIADO, base);
    m.p.fila.push((r) =>
      r.metodo === 'GET'
        ? json(200, pedidoLiBruto({ situacao: { codigo: 'Pedido_Enviado' } }))
        : null,
    );
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido');
    if (!leitura.verificado) throw new TypeError('não verificada');
    expect(conferirEscritaLi(m.motor, SITUACAO, ENVIADO, leitura)).toBe('deriva');
  });
});

/* -------------------------------------------------------------------------- */
/*            Requirement 6: nothing after a landed write may throw           */
/* -------------------------------------------------------------------------- */

describe('requirement 6 — any 2xx resolves, and no PUT follows a landed one', () => {
  it.each([
    ['a 200 echo', () => json(200, { id: ID_ENVIO_LI, objeto: CODIGO }), 'sim', 'ok'],
    ['a 204 with an empty body', () => new Response(null, { status: 204 }), 'sim', 'vazio'],
    ['a text/html 202', () => json(202, undefined, 'text/html'), 'pendente', 'vazio'],
    ['an HTML 200', () => new Response('<html>ok</html>', { status: 200 }), 'sim', 'nao-json'],
    ['a malformed echo', () => new Response('{"id": 8', { status: 200 }), 'sim', 'nao-json'],
    ['a 2xx cut mid-body', () => cortada(200, new TypeError('terminated')), 'sim', 'falhou'],
  ] as const)(
    '%s resolves `enviado`, and the escrita line names it',
    async (_caso, resposta, aplicada, leituraEco) => {
      const m = await montar();
      m.p.fila.push((r) => (r.metodo === 'PUT' ? resposta() : null));
      const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      const r = await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
      if (r.kind !== 'enviado') throw new TypeError(r.kind);
      expect(r.resposta).toMatchObject({ aplicada, leituraEco });
      expect(doEvento(m.linhas, 'escrita').map((l) => l.campos)).toEqual([
        expect.objectContaining({
          recurso: NUMERO_LI,
          tipo: 'objeto-envio',
          campo: 'objeto',
          resultado: aplicada === 'sim' ? 'aplicada' : 'pendente',
          aplicada,
          leituraEco,
        }),
      ]);
    },
  );

  it('⚠️ a second PUT in the run after a 2xx PUT is a TypeError — even from a fresh deciding read', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, nova)).rejects.toThrow(TypeError);
    // Even a dry-run diff: the run is over once a write landed.
    expect(m.p.puts()).toHaveLength(1);
  });

  it('a 202 counts as landed too: no second PUT', async () => {
    const m = await montar();
    m.p.fila.push((r) => (r.metodo === 'PUT' ? new Response(null, { status: 202 }) : null));
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, nova)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toHaveLength(1);
  });

  it('a REFUSED PUT is not landed: the next PUT is allowed from a fresh read', async () => {
    const m = await montar();
    m.p.fila.push((r) => (r.metodo === 'PUT' ? json(409, {}) : null));
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, OBJETO, COM_CODIGO, base)).rejects.toMatchObject({
      name: 'LiHttpError',
    });
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, nova)).kind).toBe('enviado');
  });

  it('(b) the read-back’s credential re-read failing in Firestore is rethrown — and the run still cannot PUT again', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, SITUACAO, ENVIADO, base);
    const falha = grpc(14, 'UNAVAILABLE');
    m.db.falharLeitura(caminhoCredencial(ID), falha);
    await expect(lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido')).rejects.toBe(falha);
    m.db.falharLeitura(caminhoCredencial(ID), null);
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, nova)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toHaveLength(1);
  });

  it('(h) the package’s third post-write throw: a 2xx body read failing with an unclassified error is rethrown as itself', async () => {
    const m = await montar();
    const estranho = new RangeError('falha de leitura não classificada');
    m.p.fila.push((r) => (r.metodo === 'PUT' ? cortada(200, estranho) : null));
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, base)).rejects.toBe(estranho);
    // The deciding read was spent on that attempt.
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, base)).rejects.toThrow(TypeError);
    // And the 2xx DID arrive: even a FRESH deciding read cannot send another write in this run.
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, OBJETO, COM_CODIGO, nova)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toHaveLength(1);
  });

  it('(g) an observer that throws on the 2xx’s call line: rethrown as itself — and the run is closed', async () => {
    const quebrado = new RangeError('observador quebrado');
    const m = await montar({
      antesDaLinhaDeChamada: (campos) => {
        if (campos.metodo === 'PUT') throw quebrado;
      },
    });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, base)).rejects.toBe(quebrado);
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, OBJETO, COM_CODIGO, nova)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toHaveLength(1);
  });

  it.each([
    ['a 500', () => json(500, {}), 'LiHttpError'],
    ['a 503', () => json(503, {}), 'LiHttpError'],
    ['a 429', () => json(429, {}), 'LiThrottleError'],
    ['a dropped connection', () => new TypeError('fetch failed'), 'LiNetworkError'],
  ] as const)(
    '⚠️ a write that MAY have landed (%s) closes the run: a fresh deciding read still cannot send another',
    async (_caso, resposta, nome) => {
      const m = await montar();
      m.p.fila.push((r) => (r.metodo === 'PUT' ? resposta() : null));
      const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      await expect(escreverLi(m.motor, OBJETO, COM_CODIGO, base)).rejects.toMatchObject({
        name: nome,
      });
      const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      await expect(escreverLi(m.motor, SITUACAO, ENVIADO, nova)).rejects.toThrow(TypeError);
      expect(m.p.puts()).toHaveLength(1);
      // Nothing is known to have landed: there is nothing to read back.
      await expect(lerDeVoltaLi(m.motor, ALVO, 'objeto-envio')).rejects.toThrow(TypeError);
    },
  );

  it('⚠️ a write cut by its deadline MAY HAVE LANDED: LiTimeoutError, and the run is closed', async () => {
    const m = await montar();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    m.p.fila.push((r, init) =>
      r.metodo === 'PUT'
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason);
            });
          })
        : null,
    );
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    let erro: unknown = null;
    const promessa = escreverLi(m.motor, OBJETO, COM_CODIGO, base).catch((e: unknown) => {
      erro = e;
    });
    for (let i = 0; i < 60 && erro === null; i++) await vi.advanceTimersByTimeAsync(1_000);
    await promessa;
    expect(erro).toBeInstanceOf(LiTimeoutError);
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(escreverLi(m.motor, SITUACAO, ENVIADO, nova)).rejects.toThrow(TypeError);
    expect(m.p.puts()).toHaveLength(1);
  });

  it('⚠️ two writes started together: exactly ONE is sent, the other is a TypeError', async () => {
    const m = await montar();
    const b1 = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    const b2 = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    const [r1, r2] = await Promise.allSettled([
      escreverLi(m.motor, OBJETO, COM_CODIGO, b1),
      escreverLi(m.motor, SITUACAO, ENVIADO, b2),
    ]);
    expect(r1).toMatchObject({ status: 'fulfilled', value: { kind: 'enviado' } });
    expect(r2.status).toBe('rejected');
    expect(r2.status === 'rejected' ? r2.reason : null).toBeInstanceOf(TypeError);
    expect(m.p.puts()).toHaveLength(1);
  });

  it.each([
    ['a 400', () => json(400, {}), 'LiHttpError'],
    ['a 403', () => json(403, {}), 'LiAuthError'],
    ['a 404', () => json(404, {}), 'LiNotFoundError'],
    [
      'a 302',
      () => new Response(null, { status: 302, headers: { location: '/x' } }),
      'LiHttpError',
    ],
  ] as const)(
    'EQUAL pair: a write REFUSED with %s proves nothing landed — the next write, from a fresh read, is sent',
    async (_caso, resposta, nome) => {
      const m = await montar();
      m.p.fila.push((r) => (r.metodo === 'PUT' ? resposta() : null));
      const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      await expect(escreverLi(m.motor, OBJETO, COM_CODIGO, base)).rejects.toMatchObject({
        name: nome,
      });
      const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      expect((await escreverLi(m.motor, SITUACAO, ENVIADO, nova)).kind).toBe('enviado');
      expect(m.p.puts()).toHaveLength(2);
    },
  );

  it('EQUAL pair: a write the package refuses BEFORE sending (an invalid tracking code) leaves the run open', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(
      escreverLi(m.motor, OBJETO, { campo: 'objeto', valor: 'PJ 258' }, base),
    ).rejects.toBeInstanceOf(LiConfigError);
    expect(m.p.puts()).toEqual([]);
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, nova)).kind).toBe('enviado');
  });

  it.each([
    ['the credential removed', 'ausente', LiCredencialAusenteError],
    ['the credential unreadable', 'corrompida', LiCredencialInvalidaError],
    ['the conta parked', 'parada', LiContaParadaError],
    ['another token saved (the pin)', 'trocada', LiCredencialTrocadaError],
  ] as const)(
    'EQUAL pair: a write the credential re-read refuses (%s) sends nothing and leaves the run open',
    async (_caso, estado, classe) => {
      const m = await montar();
      const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      await mudarCredencial(m.db, estado);
      await expect(escreverLi(m.motor, SITUACAO, ENVIADO, base)).rejects.toBeInstanceOf(classe);
      expect(m.p.puts()).toEqual([]);
      // The original credential back — the same token and stamp, so the same ref: the pin matches.
      seedCredencial(m.db, ID);
      const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
      expect((await escreverLi(m.motor, SITUACAO, ENVIADO, nova)).kind).toBe('enviado');
      expect(m.p.puts()).toHaveLength(1);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*       Requirement 7: read-back failures, contained only for known classes   */
/* -------------------------------------------------------------------------- */

describe('requirement 7 — the read-back and the history read contain ONLY the listed classes', () => {
  async function aposEscrita(): Promise<Montagem> {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, SITUACAO, ENVIADO, base);
    return m;
  }

  it.each([
    ['401', () => json(401, {}), 'LiAuthError'],
    ['403', () => json(403, {}), 'LiAuthError'],
    ['404', () => json(404, {}), 'LiNotFoundError'],
    ['429', () => json(429, {}), 'LiThrottleError'],
    ['500', () => json(500, {}), 'LiHttpError'],
    ['302', () => new Response(null, { status: 302, headers: { location: '/x' } }), 'LiHttpError'],
    ['a body off the schema', () => json(200, { numero: 'x' }), 'LiSchemaError'],
    ['a dropped connection', () => new TypeError('fetch failed'), 'LiNetworkError'],
  ] as const)(
    'read-back: %s ⇒ contained as %s, never rethrown',
    async (_caso, resposta, classe) => {
      const m = await aposEscrita();
      m.p.fila.push((r) => (r.metodo === 'GET' ? resposta() : null));
      const leitura = await lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido');
      expect(leitura).toMatchObject({ verificado: false, classe });
    },
  );

  it('read-back: the deadline ⇒ contained as LiTimeoutError', async () => {
    const m = await aposEscrita();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The next GET hangs until the package's own deadline aborts it.
    m.p.fila.push((r, init) =>
      r.metodo === 'GET'
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason);
            });
          })
        : null,
    );
    let leitura: Awaited<ReturnType<typeof lerDeVoltaLi>> | null = null;
    const promessa = lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido').then((l) => {
      leitura = l;
    });
    for (let i = 0; i < 60 && leitura === null; i++) await vi.advanceTimersByTimeAsync(1_000);
    await promessa;
    expect(leitura).toMatchObject({ verificado: false, classe: 'LiTimeoutError' });
  });

  it.each([
    ['the credential removed', 'ausente', 'LiCredencialAusenteError'],
    ['the credential corrupt', 'corrompida', 'LiCredencialInvalidaError'],
    ['the conta parked', 'parada', 'LiContaParadaError'],
    ['another token saved (the pin)', 'trocada', 'LiCredencialTrocadaError'],
  ] as const)('read-back: %s ⇒ contained as %s, zero requests', async (_caso, estado, classe) => {
    const m = await aposEscrita();
    await mudarCredencial(m.db, estado);
    const antes = m.p.requisicoes.length;
    expect(await lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido')).toMatchObject({
      verificado: false,
      classe,
    });
    expect(m.p.requisicoes).toHaveLength(antes);
  });

  it('⚠️ NEAR-MISS: LiConfigError and a gRPC error are rethrown, never contained', async () => {
    const m = await aposEscrita();
    const err = grpc(14, 'UNAVAILABLE');
    m.db.falharLeitura(caminhoCredencial(ID), err);
    await expect(lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido')).rejects.toBe(err);
    await expect(lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).rejects.toBe(err);
    m.db.falharLeitura(caminhoCredencial(ID), null);
    // Our own misconfiguration (the package's `LiConfigError`, a subclass of the
    // `LiError` base) is loud in both reads.
    const config = new LiConfigError('caminho', { operacao: 'teste', refCredencial: null });
    m.p.fila.push((r) => (r.metodo === 'GET' ? config : null));
    await expect(lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido')).rejects.toBe(config);
    m.p.fila.push((r) => (r.metodo === 'GET' ? config : null));
    await expect(lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).rejects.toBe(config);
  });

  it('every class CLASSES_CONTIDAS_LI lists is contained AS that class, by the read-back and by the history read', async () => {
    const ctx = {
      operacao: 'teste',
      caminho: CAMINHO_PEDIDO,
      correlationId: 'c-1',
      refCredencial: 'r.1',
      metodo: 'GET',
    } as const;
    const instancias = {
      LiAuthError: () => new LiAuthError({ ...ctx, status: 403 }),
      LiNotFoundError: () => new LiNotFoundError({ ...ctx, status: 404 }),
      LiThrottleError: () =>
        new LiThrottleError({
          ...ctx,
          status: 429,
          escopo: 'loja',
          codigosEncontrados: [],
          retryAfterS: null,
        }),
      LiHttpError: () => new LiHttpError({ ...ctx, status: 500 }),
      LiSchemaError: () =>
        new LiSchemaError({ ...ctx, status: 200, motivo: 'formato', campos: ['numero'] }),
      LiTimeoutError: () => new LiTimeoutError({ ...ctx, prazoMs: 20_000 }, null),
      LiNetworkError: () => new LiNetworkError(ctx, null),
      LiPaginacaoError: () =>
        new LiPaginacaoError({ ...ctx, motivo: 'limite-de-paginas', paginas: 1 }),
      LiCredencialAusenteError: () => new LiCredencialAusenteError(ID),
      LiCredencialInvalidaError: () => new LiCredencialInvalidaError(ID, ['personalToken']),
      LiContaParadaError: () => new LiContaParadaError(ID, 401, AGORA_MS),
      LiCredencialTrocadaError: () => new LiCredencialTrocadaError(ID),
    } satisfies Record<ClasseContidaLi, () => Error>;
    expect(Object.keys(instancias).sort()).toEqual([...CLASSES_CONTIDAS_LI].sort());
    for (const classe of CLASSES_CONTIDAS_LI) {
      const m = await aposEscrita();
      const erro = instancias[classe]();
      // Thrown by the transport as-is, so only the engine's own narrowing names it.
      m.p.fila.push((r) => (r.metodo === 'GET' ? erro : null));
      expect(await lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido'), classe).toEqual({
        verificado: false,
        classe,
        erro,
      });
      m.p.fila.push((r) => (r.metodo === 'GET' ? erro : null));
      expect(await lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO), classe).toEqual({
        lida: false,
        classe,
        erro,
      });
    }
  });

  it('⚠️ the history read reads ONE page: a page that names a next one is LiPaginacaoError, contained, after exactly one GET', async () => {
    expect(MAX_PAGINAS_HISTORICO_CONFERENCIA_LI).toBe(1);
    const m = await aposEscrita();
    m.p.fila.push((r) =>
      r.metodo === 'GET'
        ? json(200, {
            meta: {
              limit: 50,
              offset: 0,
              next: `/api/v1/situacao_historico/search/?limit=50&numero=${String(NUMERO_LI)}&offset=50`,
              previous: null,
              total_count: 51,
            },
            objects: [
              linhaHistoricoLi(1, '2027-01-10T10:00:00.000000', 'pedido_enviado', 'pedido_pago'),
            ],
          })
        : null,
    );
    const marco = m.p.requisicoes.length;
    expect(await lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).toMatchObject({
      lida: false,
      classe: 'LiPaginacaoError',
    });
    expect(m.p.requisicoes.slice(marco).map((r) => `${r.metodo} ${r.caminho}`)).toEqual([
      'GET /v1/situacao_historico/search/',
    ]);
  });

  it('⚠️ the post-write reads are tied to the write that LANDED: another target or kind is a TypeError, with zero requests', async () => {
    const m = await aposEscrita();
    const marco = m.p.requisicoes.length;
    const outro: AlvoLi = { contaId: ID, recurso: NUMERO_LI + 1 };
    await expect(lerDeVoltaLi(m.motor, outro, 'situacao-pedido')).rejects.toThrow(TypeError);
    await expect(lerDeVoltaLi(m.motor, ALVO, 'objeto-envio')).rejects.toThrow(TypeError);
    await expect(lerHistoricoSituacaoParaConferenciaLi(m.motor, outro)).rejects.toThrow(TypeError);
    expect(m.p.requisicoes).toHaveLength(marco);
    expect(m.p.esperas).toHaveLength(2);
    // EQUAL pair: the landed write's own target and kind are read.
    expect((await lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido')).verificado).toBe(true);
    expect((await lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).lida).toBe(true);
  });

  it('⚠️ the history read before any write landed is a TypeError, with zero requests — never an unpinned read', async () => {
    const m = await montar();
    await expect(lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).rejects.toThrow(TypeError);
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect(base.status).toBe(200);
    await expect(lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).rejects.toThrow(TypeError);
    expect(m.p.requisicoes.map((r) => r.metodo)).toEqual(['GET']);
  });

  it('the history read: a 429 is contained; the rows come back as received', async () => {
    const m = await aposEscrita();
    m.p.estado.historico = [
      linhaHistoricoLi(1, '2027-01-10T10:00:00.000000', 'pedido_enviado', 'pedido_pago'),
    ];
    const lido = await lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO);
    expect(lido).toMatchObject({
      lida: true,
      linhas: [{ id: 1, situacao: { codigo: 'pedido_enviado' } }],
    });
    m.p.fila.push((r) => (r.metodo === 'GET' ? json(429, {}) : null));
    expect(await lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).toMatchObject({
      lida: false,
      classe: 'LiThrottleError',
    });
    m.p.fila.push((r) => (r.metodo === 'GET' ? new TypeError('fetch failed') : null));
    expect(await lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO)).toMatchObject({
      lida: false,
      classe: 'LiNetworkError',
    });
  });

  it('the history read is paced by its read client (one interval per page), never by the engine twice', async () => {
    const m = await aposEscrita();
    const marco = m.p.eventos.length;
    await lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO);
    expect(m.p.eventos.slice(marco)).toEqual([
      `espera ${String(RITMO_ESCRITA_LI_MS)}`,
      'GET /v1/situacao_historico/search/',
    ]);
  });

  it('a contained error keeps its class instance, for the run to act on (a 401 reaches the park)', async () => {
    const m = await aposEscrita();
    m.p.fila.push((r) => (r.metodo === 'GET' ? json(401, {}) : null));
    const leitura = await lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido');
    if (leitura.verificado) throw new TypeError('verificada');
    expect(leitura.erro).toMatchObject({ name: 'LiAuthError', status: 401 });
    expect(leitura.erro).not.toBeInstanceOf(LiNetworkError);
  });
});

async function mudarCredencial(
  db: FakeDb,
  estado: 'ausente' | 'corrompida' | 'parada' | 'trocada',
): Promise<void> {
  switch (estado) {
    case 'ausente':
      await removerCredencial(asDb(db), ID);
      return;
    case 'corrompida':
      seedCredencial(db, ID, {
        reconexaoPendente: { desdeMs: 1, status: 500, refCredencial: 'a' },
      });
      return;
    case 'parada':
      seedCredencial(db, ID, {
        reconexaoPendente: { desdeMs: AGORA_MS - 1, status: 401, refCredencial: 'a.1' },
      });
      return;
    case 'trocada':
      seedCredencial(db, ID, { personalToken: TOKEN_B, tokenAtualizadoEmMs: AGORA_MS });
      return;
  }
}

/* -------------------------------------------------------------------------- */
/*                        The pacer and the task deadline                     */
/* -------------------------------------------------------------------------- */

describe('the write pacer', () => {
  it('two intervals before the deciding GET, NONE between it and its PUT, two before the read-back', async () => {
    const m = await montar();
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await escreverLi(m.motor, OBJETO, COM_CODIGO, base);
    await lerDeVoltaLi(m.motor, ALVO, 'objeto-envio');
    await lerHistoricoSituacaoParaConferenciaLi(m.motor, ALVO);
    const e = `espera ${String(RITMO_ESCRITA_LI_MS)}`;
    expect(m.p.eventos).toEqual([
      e,
      e,
      `GET ${CAMINHO_PEDIDO}`,
      `PUT ${CAMINHO_ENVIO}`,
      e,
      e,
      `GET ${CAMINHO_PEDIDO}`,
      e,
      'GET /v1/situacao_historico/search/',
    ]);
    // N calls wait at least N × the interval in total: 30 a minute at most.
    const chamadas = m.p.requisicoes.length;
    const total = m.p.esperas.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(chamadas * RITMO_ESCRITA_LI_MS);
  });
});

describe('the task’s write deadline (no PUT starts later than 260 s after the dispatch began)', () => {
  it('EQUAL pair: at exactly the deadline the PUT is sent', async () => {
    const m = await montar({
      inicioDaTarefaMs: AGORA_MS - PRAZO_ULTIMA_ESCRITA_MS,
      agora: () => AGORA_MS,
    });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, base)).kind).toBe('enviado');
  });

  it('⚠️ NEAR-MISS: one millisecond past it ⇒ PrazoDeEscritaEsgotadoLiError, nothing sent, the base not spent', async () => {
    expect(PRAZO_ULTIMA_ESCRITA_MS).toBe(260_000);
    let agora = AGORA_MS;
    const m = await montar({ inicioDaTarefaMs: AGORA_MS, agora: () => agora });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    agora = AGORA_MS + PRAZO_ULTIMA_ESCRITA_MS + 1;
    const err: unknown = await escreverLi(m.motor, SITUACAO, ENVIADO, base).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PrazoDeEscritaEsgotadoLiError);
    expect(err).not.toBeInstanceOf(LiNetworkError);
    expect(m.p.puts()).toEqual([]);
    // The base was NOT spent, and the run is still open: back inside the deadline, it writes.
    agora = AGORA_MS;
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, base)).kind).toBe('enviado');
    expect(m.p.puts()).toHaveLength(1);
  });

  /** The credential reads the fake db has served so far. */
  const leiturasDaCredencial = (db: FakeDb) =>
    db.leituras.filter((c) => c === caminhoCredencial(ID)).length;

  it('⚠️ the deadline is checked AGAIN after the write’s credential re-read: a slow re-read past it ⇒ zero PUTs, and the run stays open', async () => {
    let db: FakeDb | null = null;
    let marco = Number.POSITIVE_INFINITY;
    // The clock reads past the deadline exactly while the write's own credential
    // re-read is the latest one served (a slow re-read), and is back after it.
    const agora = () =>
      AGORA_MS +
      (db !== null && leiturasDaCredencial(db) === marco + 1 ? PRAZO_ULTIMA_ESCRITA_MS + 1 : 0);
    const m = await montar({ inicioDaTarefaMs: AGORA_MS, agora });
    db = m.db;
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    marco = leiturasDaCredencial(m.db);
    const err: unknown = await escreverLi(m.motor, SITUACAO, ENVIADO, base).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PrazoDeEscritaEsgotadoLiError);
    expect(leiturasDaCredencial(m.db)).toBe(marco + 1);
    expect(m.p.puts()).toEqual([]);
    expect(doEvento(m.linhas, 'chamada').filter((l) => l.campos.metodo === 'PUT')).toEqual([]);
    // Nothing was sent, so nothing can have landed: a fresh deciding read still writes.
    const nova = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, nova)).kind).toBe('enviado');
    expect(m.p.puts()).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: the re-check is the WRITE’s only — a deciding read and a read-back past the deadline still go', async () => {
    let agora = AGORA_MS;
    const m = await montar({ inicioDaTarefaMs: AGORA_MS, agora: () => agora });
    // A write the package refuses before its credential re-read leaves no check armed behind it.
    const b0 = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    await expect(
      escreverLi(m.motor, OBJETO, { campo: 'objeto', valor: 'PJ 258' }, b0),
    ).rejects.toBeInstanceOf(LiConfigError);
    agora = AGORA_MS + PRAZO_ULTIMA_ESCRITA_MS + 1;
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    agora = AGORA_MS;
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, base)).kind).toBe('enviado');
    agora = AGORA_MS + PRAZO_ULTIMA_ESCRITA_MS + 1;
    expect((await lerDeVoltaLi(m.motor, ALVO, 'situacao-pedido')).verificado).toBe(true);
    expect(m.p.requisicoes.map((r) => r.metodo)).toEqual(['GET', 'GET', 'PUT', 'GET']);
  });

  it('a dry-run is not held to it (it sends nothing)', async () => {
    const m = await montar({
      ambiente: ambiente(MODO_LI.dryRun),
      inicioDaTarefaMs: AGORA_MS - 10 * PRAZO_ULTIMA_ESCRITA_MS,
    });
    const base = lida(await lerBaseLi(m.motor, ALVO, 'pedido'));
    expect((await escreverLi(m.motor, SITUACAO, ENVIADO, base)).kind).toBe('nao-enviado');
  });
});
