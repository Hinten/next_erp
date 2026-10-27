/**
 * One status write-back run (master plan step 7, PR 7-d), offline: the REAL
 * engine, write context, park and aviso writer, against the fake Firestore and
 * a stateful Loja Integrada (`testing/plataformaEscritaLi.ts`).
 *
 * D17: the global `fetch` is stubbed to throw for every test of this file, the
 * unit config's kill-switch fails any real host, and the platform is the only
 * `fetch` a client gets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  LiConfigError,
  LiHttpError,
  LiSchemaError,
  PRAZO_LI_MS,
} from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_SITUACAO_LI,
  ESTADO_FRETE,
  ESTADO_RASTREIO_LI,
  MOTIVO_RASTREIO_DIVERGENTE_LI,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  type EstadoRastreioLi,
  codigoSituacaoLiSchema,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import {
  EscritaRecusadaLiError,
  LiContaParadaError,
  LiCredencialTrocadaError,
} from '../core/erros';
import { RITMO_ESCRITA_LI_MS } from '../core/ritmo';
import {
  type AmbienteLi,
  CANARIO_ENV_LI,
  CHAMADAS_ENV_LI,
  MODO_LI,
  VALVULA_ENV_LI,
} from '../core/valvulas';
import { idPedidoLi } from '../pedidos/orderIdsLi';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  TOKEN_B,
  caminhoAviso,
  caminhoCredencial,
  gravadorDeLog,
  type LinhaGravada,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { ID_ENVIO_LI, NUMERO_LI } from '../testing/pedidosLi';
import {
  CAMINHO_ENVIO_LI,
  CAMINHO_HISTORICO_LI,
  CAMINHO_PEDIDO_LI,
  CAMINHO_SITUACAO_LI,
  type PlataformaEscritaLi,
  criarPlataformaEscritaLi,
  naProxima,
  respostaJson,
  seedPedidoLi,
} from '../testing/plataformaEscritaLi';
import { eventoDoHistoricoLi } from './agendadorEscrita';
import { chaveDoAvisoRastreioLi } from './avisosRastreio';
import {
  type DepsEscritaLi,
  type EventoRastreioLi,
  type PassagemFinalLi,
  PIOR_EXECUCAO_RASTREIO_LI_MS,
  PIOR_TENTATIVA_RECUSADA_RASTREIO_LI_MS,
  type ResultadoRastreioLi,
  classificarRecusaEscritaLi,
  processarRastreioLi,
} from './processarRastreio';

const ID = 'conta-li-1';
const PEDIDO_ID = idPedidoLi(ID, NUMERO_LI);
const CODIGO = 'PJ258408772BR';
const C = CODIGO_SITUACAO_LI;
const M = MOTIVO_RASTREIO_DIVERGENTE_LI;
const EVENTO_MS = AGORA_MS - 60_000;

const GET_PEDIDO = `GET ${CAMINHO_PEDIDO_LI}`;
const PUT_ENVIO = `PUT ${CAMINHO_ENVIO_LI}`;
const PUT_SITUACAO = `PUT ${CAMINHO_SITUACAO_LI}`;
const GET_HISTORICO = `GET ${CAMINHO_HISTORICO_LI}`;

/** One Loja Integrada call that runs to its whole deadline, read or write. */
const PRAZO_DE_UMA_CHAMADA_MS = Math.max(PRAZO_LI_MS.leitura, PRAZO_LI_MS.escrita);

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  // D17, per file: nothing here may reach the global `fetch`.
  vi.stubGlobal('fetch', () => {
    throw new Error('processarRastreio.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

/** The read switch on, the rastreio valve and canary as given (`null`: unset). */
function ambiente(modo: string | null, canario: string | null = '*', chamadas = true): AmbienteLi {
  return {
    ...(chamadas ? { [CHAMADAS_ENV_LI]: MODO_LI.on } : {}),
    ...(modo === null ? {} : { [VALVULA_ENV_LI.rastreio]: modo }),
    ...(canario === null ? {} : { [CANARIO_ENV_LI.rastreio]: canario }),
  };
}

interface Cenario {
  readonly db: FakeDb;
  readonly p: PlataformaEscritaLi;
  readonly linhas: LinhaGravada[];
  readonly erros: unknown[][];
  readonly avisos: unknown[][];
  /** How long the scenario's clock ran (0 unless it is `cronometrado`). */
  decorridoMs(): number;
  rodar(o?: {
    estado?: EstadoRastreioLi;
    eventoEmMs?: number;
    passagemFinal?: PassagemFinalLi;
    escritaRecentePossivel?: boolean;
    ambiente?: AmbienteLi;
  }): Promise<ResultadoRastreioLi>;
  aviso(): Record<string, unknown> | undefined;
}

function cenario(
  o: {
    codigo?: string;
    objeto?: string | null;
    mover?: boolean;
    freteEstado?: string;
    codRastreio?: string | null;
    externalId?: string | null;
    ambiente?: AmbienteLi;
    semPedido?: boolean;
    /**
     * A clock that every pacer wait advances by its length and every Loja
     * Integrada call by a FULL request deadline — the slowest the run can be.
     */
    cronometrado?: boolean;
  } = {},
): Cenario {
  const db = new FakeDb();
  seedConta(db, ID, { nome: 'Loja X' });
  seedCredencial(db, ID);
  if (o.semPedido !== true) {
    seedPedidoLi(db, PEDIDO_ID, ID, {
      estado: o.freteEstado ?? ESTADO_FRETE.postado,
      codRastreio: o.codRastreio === undefined ? CODIGO : o.codRastreio,
      ...(o.externalId === undefined ? {} : { externalId: o.externalId }),
    });
  }
  const p = criarPlataformaEscritaLi({
    codigo: o.codigo ?? C.pedidoPago,
    objeto: o.objeto ?? null,
    moverAoEscreverObjeto: o.mover,
  });
  const gravador = gravadorDeLog();
  const erros: unknown[][] = [];
  const avisos: unknown[][] = [];
  const amb = o.ambiente ?? ambiente(MODO_LI.on);
  // Still unless the scenario is timed: every other test runs at AGORA_MS.
  const relogio = { ms: AGORA_MS };
  const cronometrado = o.cronometrado === true;
  const esperar = (ms: number): Promise<void> => {
    if (cronometrado) relogio.ms += ms;
    return p.esperar(ms);
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const resposta = p.fetch(input, init);
    if (cronometrado) relogio.ms += PRAZO_DE_UMA_CHAMADA_MS;
    return resposta;
  };
  const deps = (a: AmbienteLi): DepsEscritaLi => ({
    ambiente: a,
    esperar,
    agoraMs: () => relogio.ms,
    inicioDaTarefaMs: AGORA_MS,
    increment,
    logger: {
      warn: (...args: unknown[]) => avisos.push(args),
      error: (...args: unknown[]) => erros.push(args),
    },
    registro: { escrever: gravador.escrever, tentativa: 0, idTarefa: 't-1' },
    fetch,
  });
  return {
    db,
    p,
    linhas: gravador.linhas,
    erros,
    avisos,
    decorridoMs: () => relogio.ms - AGORA_MS,
    rodar: (r = {}) => {
      const estado = r.estado ?? ESTADO_RASTREIO_LI.postado;
      const evento: EventoRastreioLi = {
        contaId: ID,
        numero: String(NUMERO_LI),
        pedidoId: PEDIDO_ID,
        evento: eventoDoHistoricoLi(PEDIDO_ID, `h-${estado}`),
        estado,
        eventoEmMs: r.eventoEmMs ?? EVENTO_MS,
        passagemFinal: r.passagemFinal ?? null,
        // A sweep pass at least an hour after any earlier run, unless a test says otherwise.
        escritaRecentePossivel: r.escritaRecentePossivel ?? false,
      };
      return processarRastreioLi(asDb(db), evento, deps(r.ambiente ?? amb));
    },
    aviso: () => db.ler(caminhoAviso(chaveDoAvisoRastreioLi(ID, PEDIDO_ID))),
  };
}

const doEvento = (linhas: readonly LinhaGravada[], evento: string) =>
  linhas.filter((l) => l.campos.evento === evento);

const escritas = (linhas: readonly LinhaGravada[], resultado: string) =>
  doEvento(linhas, 'escrita').filter((l) => l.campos.resultado === resultado);

/* -------------------------------------------------------------------------- */
/*                         The order of one run, and off                      */
/* -------------------------------------------------------------------------- */

describe('the run order and the valve', () => {
  it('valve → pedido read → freshness → context → guard GET → restore line → the PUT, on ONE timeline', async () => {
    const c = cenario();
    const r = await c.rodar();
    expect(r).toEqual({ kind: 'escrito' });
    const ordem = c.linhas.map((l) => String(l.campos.evento));
    expect(ordem.indexOf('valvula')).toBe(0);
    const iRestauracao = ordem.indexOf('restauracao');
    const iEscrita = ordem.indexOf('escrita');
    expect(iRestauracao).toBeGreaterThan(0);
    expect(iEscrita).toBeGreaterThan(iRestauracao);
    // Two pacer intervals, then the guard GET, then the PUT at once.
    expect(c.p.eventos.slice(0, 4)).toEqual([
      `espera ${String(RITMO_ESCRITA_LI_MS)}`,
      `espera ${String(RITMO_ESCRITA_LI_MS)}`,
      GET_PEDIDO,
      PUT_ENVIO,
    ]);
  });

  it.each([
    ['unset', null],
    ['off', 'off'],
    ['a typo (ON)', 'ON'],
  ])(
    'valve %s ⇒ `desligado` (DEFER), with ZERO reads — not even the pedido',
    async (_caso, modo) => {
      const c = cenario({ ambiente: ambiente(modo) });
      c.db.falharLeitura(
        `pedidos/${PEDIDO_ID}`,
        new Error('o pedido não pode ser lido com a válvula off'),
      );
      expect(await c.rodar()).toEqual({ kind: 'desligado' });
      expect(c.p.requisicoes).toEqual([]);
      expect(doEvento(c.linhas, 'valvula')).toHaveLength(1);
    },
  );

  it('the read switch off ⇒ adiado/chamadas-desligadas, ZERO calls to Loja Integrada', async () => {
    const c = cenario({ ambiente: ambiente(MODO_LI.on, '*', false) });
    expect(await c.rodar()).toEqual({
      kind: 'adiado',
      motivo: 'chamadas-desligadas',
      recusa: null,
    });
    expect(c.p.requisicoes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                      The identity proof and freshness                      */
/* -------------------------------------------------------------------------- */

describe('the identity proof, before any Loja Integrada work', () => {
  it('no pedido ⇒ pedido-inexistente (drop), zero calls', async () => {
    const c = cenario({ semPedido: true });
    expect(await c.rodar()).toEqual({ kind: 'pedido-inexistente' });
    expect(c.p.requisicoes).toEqual([]);
  });

  it.each([
    ['a duplicate (no numero)', { numero: null }],
    ['another conta', { integracaoPedidoOuterRef: 'integracao/conta-li-2' }],
    ['another numero', { numero: String(NUMERO_LI + 1) }],
  ])('⚠️ NEAR-MISS: %s ⇒ pedido-nao-li (drop), zero calls, no aviso', async (_caso, over) => {
    const c = cenario();
    seedPedidoLi(c.db, PEDIDO_ID, ID, { estado: ESTADO_FRETE.postado, codRastreio: CODIGO }, over);
    expect(await c.rodar()).toEqual({ kind: 'pedido-nao-li' });
    expect(c.p.requisicoes).toEqual([]);
    expect(c.aviso()).toBeUndefined();
  });

  it('an outdated event ⇒ superado (resolve) with ONE INFO `superado` line, zero calls', async () => {
    const c = cenario({ freteEstado: ESTADO_FRETE.aguardandoPostagem });
    expect(await c.rodar()).toEqual({ kind: 'superado', motivo: 'evento-desatualizado' });
    expect(c.p.requisicoes).toEqual([]);
    const superado = doEvento(c.linhas, 'superado');
    expect(superado).toHaveLength(1);
    expect(superado[0]).toMatchObject({
      severidade: 'INFO',
      campos: { estadoEvento: 'postado', estadoAtual: 'aguardandoPostagem' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                 Postings: the code ALONE, one write per run           */
/* -------------------------------------------------------------------------- */

describe('a posting with a sendable code', () => {
  it.each([C.pedidoPago, C.faturado, C.emProducao, C.pedidoEmSeparacao])(
    'at %s: exactly GET, PUT code, GET read-back, GET history — ZERO situação PUTs, `efeito-observado`, conferido',
    async (codigo) => {
      const c = cenario({ codigo });
      expect(await c.rodar()).toEqual({ kind: 'escrito' });
      expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
      expect(c.p.puts()).toEqual([
        { metodo: 'PUT', caminho: CAMINHO_ENVIO_LI, corpo: { objeto: CODIGO } },
      ]);
      expect(escritas(c.linhas, 'efeito-observado')).toHaveLength(1);
      expect(doEvento(c.linhas, 'conferencia-historico')[0]?.campos).toMatchObject({
        resultado: 'conferido',
        codigoAntes: codigo,
        codigoEscrito: C.pedidoEnviado,
      });
      // A clean run makes a clocked resolve: a resolved row seeded at the event's clock.
      expect(c.aviso()).toMatchObject({ relogioEvento: EVENTO_MS * 1000 });
      expect(c.aviso()?.resolvidoEm).not.toBeNull();
    },
  );

  it('the read-back shows our code but LI did not move ⇒ parcial/efeito-pendente, ZERO situação PUTs', async () => {
    const c = cenario({ mover: false });
    expect(await c.rodar()).toEqual({ kind: 'parcial', efeito: 'efeito-pendente' });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO]);
    expect(escritas(c.linhas, 'efeito-pendente')).toHaveLength(1);

    // The hot re-run, ≥ 1 h later, from a FRESH guard GET still at 4: exactly one 11 PUT, WARNING.
    const antes = c.p.requisicoes.length;
    expect(await c.rodar()).toEqual({ kind: 'escrito' });
    const desta = c.p.requisicoes.slice(antes).map((r) => `${r.metodo} ${r.caminho}`);
    expect(desta).toEqual([GET_PEDIDO, PUT_SITUACAO, GET_PEDIDO, GET_HISTORICO]);
    const semEfeito = escritas(c.linhas, 'objeto-sem-efeito');
    expect(semEfeito).toHaveLength(1);
    expect(semEfeito[0]?.severidade).toBe('WARNING');

    // A third run sees 11 and our code: nothing to write.
    const antes2 = c.p.requisicoes.length;
    expect(await c.rodar()).toEqual({ kind: 'ja-refletido' });
    expect(c.p.requisicoes.slice(antes2).filter((r) => r.metodo === 'PUT')).toEqual([]);
  });

  it('a re-run that sees LI moved by itself meanwhile ⇒ zero PUTs, resolve', async () => {
    const c = cenario({ mover: false });
    await c.rodar();
    c.p.mover(C.pedidoEnviado);
    const antes = c.p.puts().length;
    expect(await c.rodar()).toEqual({ kind: 'ja-refletido' });
    expect(c.p.puts()).toHaveLength(antes);
  });

  it('⚠️ a run that may come less than an hour after this event’s code landed (a task attempt, a row the deferred lane just sent back) NEVER writes the 11 over our unmoved code', async () => {
    // LI at 4 already holding our code: the move may still be on its way.
    const c = cenario({ objeto: CODIGO });
    expect(await c.rodar({ escritaRecentePossivel: true })).toEqual({
      kind: 'parcial',
      efeito: 'efeito-pendente',
    });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO]);
    expect(escritas(c.linhas, 'efeito-pendente')).toHaveLength(1);
    expect(escritas(c.linhas, 'objeto-sem-efeito')).toEqual([]);
    expect(c.aviso()).toBeUndefined();

    // A pass at least an hour later still sees no move: now, and only now, the 11.
    expect(await c.rodar()).toEqual({ kind: 'escrito' });
    expect(c.p.puts()).toEqual([
      { metodo: 'PUT', caminho: CAMINHO_SITUACAO_LI, corpo: { codigo: C.pedidoEnviado } },
    ]);
    expect(escritas(c.linhas, 'objeto-sem-efeito')).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: such a run still sends the code when LI’s objeto is EMPTY, still writes 11 without a sendable code, and still closes when LI moved', async () => {
    const c = cenario();
    expect(await c.rodar({ escritaRecentePossivel: true })).toEqual({ kind: 'escrito' });
    expect(c.p.puts().map((r) => r.caminho)).toEqual([CAMINHO_ENVIO_LI]);

    const d = cenario({ codRastreio: null });
    expect(await d.rodar({ escritaRecentePossivel: true })).toEqual({ kind: 'escrito' });
    expect(d.p.puts().map((r) => r.corpo)).toEqual([{ codigo: C.pedidoEnviado }]);

    const f = cenario({ codigo: C.pedidoEnviado, objeto: CODIGO });
    expect(await f.rodar({ escritaRecentePossivel: true })).toEqual({ kind: 'ja-refletido' });
    expect(f.p.puts()).toEqual([]);
  });

  it('a code PUT that LANDED but answered 503: the retried attempt sends NOTHING while LI has not moved', async () => {
    const c = cenario({ mover: false });
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => {
        (c.p.estado.pedido.envios as { objeto: string | null }[])[0]!.objeto = CODIGO;
        return respostaJson(503, {});
      }),
    );
    await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
    expect(c.p.puts()).toHaveLength(1);
    // The Cloud Tasks retry, minutes later: one guard GET, no write.
    const antes = c.p.requisicoes.length;
    expect(await c.rodar({ escritaRecentePossivel: true })).toEqual({
      kind: 'parcial',
      efeito: 'efeito-pendente',
    });
    expect(c.p.requisicoes.slice(antes).map((r) => `${r.metodo} ${r.caminho}`)).toEqual([
      GET_PEDIDO,
    ]);
  });

  it('at 11 with an EMPTY LI objeto ⇒ exactly one PUT (the code), NO history read; at 11 with our code ⇒ zero PUTs', async () => {
    const c = cenario({ codigo: C.pedidoEnviado });
    expect(await c.rodar()).toEqual({ kind: 'escrito' });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO]);

    const d = cenario({ codigo: C.pedidoEnviado, objeto: CODIGO });
    expect(await d.rodar()).toEqual({ kind: 'ja-refletido' });
    expect(d.p.chamadas()).toEqual([GET_PEDIDO]);
  });

  it('the code read-back fails (429, a dropped connection) ⇒ parcial, no second PUT', async () => {
    for (const falha of [() => respostaJson(429, {}), () => new TypeError('fetch failed')]) {
      const c = cenario();
      c.p.fila.push(
        naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(200, c.p.estado.pedido)),
        naProxima(CAMINHO_PEDIDO_LI, 'GET', falha),
      );
      expect(await c.rodar()).toEqual({ kind: 'parcial', efeito: 'nao-verificado' });
      expect(c.p.puts()).toHaveLength(1);
      expect(c.aviso()).toBeUndefined();
      // The move the run could not see is still checked against the history.
      expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
      expect(doEvento(c.linhas, 'conferencia-historico')[0]?.campos).toMatchObject({
        resultado: 'conferido',
      });
    }
  });

  it('a 202 ⇒ parcial (accepted, maybe not applied), no read-back, NO deriva aviso — the history read only', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(202, undefined)));
    expect(await c.rodar()).toEqual({ kind: 'parcial', efeito: 'aceito' });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_HISTORICO]);
    // Not applied yet: no row of ours — a WARNING, never an aviso.
    expect(doEvento(c.linhas, 'conferencia-historico')[0]).toMatchObject({
      severidade: 'WARNING',
      campos: { resultado: 'sem-linha' },
    });
    expect(c.aviso()).toBeUndefined();
  });

  it('⚠️ the code read-back fails, and the history shows a cancellation request overwritten in the gap ⇒ situacao-sobrescrita CRITICO, park', async () => {
    const c = cenario();
    let fase = 0;
    c.p.fila.push((r) => {
      if (fase === 0 && r.metodo === 'PUT' && r.caminho === CAMINHO_ENVIO_LI) {
        // The buyer asks to cancel in the instant before our code lands; the
        // default route then stores the code and moves 1019 → 11.
        c.p.mover(C.cancelamentoSolicitado);
        fase = 1;
        return null;
      }
      if (fase === 1 && r.metodo === 'GET' && r.caminho === CAMINHO_PEDIDO_LI) {
        return respostaJson(429, {});
      }
      return null;
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.situacaoSobrescrita });
    expect(c.p.puts()).toHaveLength(1);
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.critico,
      params: { motivo: M.situacaoSobrescrita, situacao: C.cancelamentoSolicitado },
    });
  });

  it('⚠️ a 202 LI applied at once, over a cancellation request in the gap ⇒ situacao-sobrescrita CRITICO', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => {
        c.p.mover(C.cancelamentoSolicitado);
        (c.p.estado.pedido.envios as { objeto: string | null }[])[0]!.objeto = CODIGO;
        c.p.mover(C.pedidoEnviado);
        return respostaJson(202, undefined);
      }),
    );
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.situacaoSobrescrita });
    expect(c.aviso()).toMatchObject({ severidade: SEVERIDADE_AVISO.critico });
  });

  it('⚠️ NEAR-MISS: the code onto an order the deciding read saw at 11 is never history-checked (an accepted residual)', async () => {
    const c = cenario({ codigo: C.pedidoEnviado });
    c.p.fila.push(
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(200, c.p.estado.pedido)),
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(429, {})),
    );
    expect(await c.rodar()).toEqual({ kind: 'parcial', efeito: 'nao-verificado' });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO]);
  });

  it('a read-back holding ANOTHER code ⇒ deriva aviso, park', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(200, c.p.estado.pedido)),
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(200, {})),
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => {
        const pedido = structuredClone(c.p.estado.pedido);
        (pedido.envios as { objeto: string }[])[0]!.objeto = 'OUTRO999BR';
        return respostaJson(200, pedido);
      }),
    );
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.deriva });
    expect(c.p.puts()).toHaveLength(1);
    expect(c.aviso()).toMatchObject({ params: { motivo: M.deriva }, resolvidoEm: null });
  });

  it.each([
    [400, () => respostaJson(400, {})],
    [404, () => respostaJson(404, {})],
    [302, () => new Response('', { status: 302, headers: { location: '/x' } })],
  ])(
    'the code PUT refused (%i) ⇒ aviso escrita-recusada, a SECOND guard GET with its own restore line, then exactly one 11 PUT',
    async (status, resposta) => {
      const c = cenario();
      c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', resposta));
      expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.escritaRecusada });
      expect(c.p.chamadas()).toEqual([
        GET_PEDIDO,
        PUT_ENVIO,
        GET_PEDIDO,
        PUT_SITUACAO,
        GET_PEDIDO,
        GET_HISTORICO,
      ]);
      expect(doEvento(c.linhas, 'restauracao')).toHaveLength(2);
      expect(c.aviso()).toMatchObject({
        params: { motivo: M.escritaRecusada, status },
        resolvidoEm: null,
      });
    },
  );

  it('the code PUT refused and the SECOND guard GET already at 11 ⇒ zero situação PUTs, recusado', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => {
        c.p.mover(C.pedidoEnviado);
        return respostaJson(400, {});
      }),
    );
    expect(await c.rodar()).toEqual({ kind: 'recusado', motivo: M.escritaRecusada, status: 400 });
    expect(c.p.puts().map((r) => r.caminho)).toEqual([CAMINHO_ENVIO_LI]);
  });

  it('⚠️ the situação after a refused code is decided from the SECOND read, never the first — and its refusal is the aviso the operator sees', async () => {
    // LI moved to 1019 between the two reads: the first read said 4.
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => {
        c.p.mover(C.cancelamentoSolicitado);
        return respostaJson(400, {});
      }),
    );
    expect(await c.rodar()).toEqual({
      kind: 'recusado',
      motivo: M.situacaoBloqueada,
      status: null,
    });
    expect(c.p.puts().map((r) => r.caminho)).toEqual([CAMINHO_ENVIO_LI]);
    // The cancellation request outranks the refused code, and it is critico.
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.critico,
      params: { motivo: M.situacaoBloqueada, situacao: C.cancelamentoSolicitado },
    });
  });

  it('⚠️ NEAR-MISS: LI CANCELLED (not a request) between the two reads ⇒ the same refusal at atencao', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => {
        c.p.mover(C.pedidoCancelado);
        return respostaJson(400, {});
      }),
    );
    expect(await c.rodar()).toEqual({
      kind: 'recusado',
      motivo: M.situacaoBloqueada,
      status: null,
    });
    expect(c.p.puts().map((r) => r.caminho)).toEqual([CAMINHO_ENVIO_LI]);
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.atencao,
      params: { motivo: M.situacaoBloqueada, situacao: C.pedidoCancelado },
    });
  });

  it.each([
    ['off its schema', () => respostaJson(200, { numero: 'x' })],
    ['400', () => respostaJson(400, {})],
    ['302', () => new Response('', { status: 302, headers: { location: '/x' } })],
  ])(
    'the code refused (400) and the SECOND read %s ⇒ the escrita-recusada aviso is still raised, park, ONE ERROR line',
    async (_caso, segunda) => {
      const c = cenario();
      c.p.fila.push(
        naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(400, {})),
        naProxima(CAMINHO_PEDIDO_LI, 'GET', segunda),
      );
      expect(await c.rodar()).toEqual({
        kind: 'recusado',
        motivo: M.escritaRecusada,
        status: 400,
      });
      expect(c.p.puts().map((r) => r.caminho)).toEqual([CAMINHO_ENVIO_LI]);
      expect(c.aviso()).toMatchObject({
        params: { motivo: M.escritaRecusada, status: 400 },
        resolvidoEm: null,
      });
      expect(c.erros).toHaveLength(1);
    },
  );

  it('a later `entregue` after such a refusal still writes 14', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(400, {})));
    await c.rodar();
    seedPedidoLi(c.db, PEDIDO_ID, ID, { estado: ESTADO_FRETE.entregue, codRastreio: CODIGO });
    const antes = c.p.puts().length;
    expect(
      await c.rodar({ estado: ESTADO_RASTREIO_LI.entregue, eventoEmMs: EVENTO_MS + 1 }),
    ).toEqual({ kind: 'escrito' });
    expect(c.p.puts().slice(antes)).toEqual([
      { metodo: 'PUT', caminho: CAMINHO_SITUACAO_LI, corpo: { codigo: C.pedidoEntregue } },
    ]);
  });

  it('an INVALID stored code (a trailing space) ⇒ objeto-invalido, zero code PUTs, the situação written', async () => {
    const c = cenario({ codRastreio: `${CODIGO} ` });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.objetoInvalido });
    expect(c.p.puts()).toEqual([
      { metodo: 'PUT', caminho: CAMINHO_SITUACAO_LI, corpo: { codigo: C.pedidoEnviado } },
    ]);
  });

  it('no stored envio ⇒ envio-divergente, the situação still written, no code PUT', async () => {
    const c = cenario({ externalId: null });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.envioDivergente });
    expect(c.p.puts().map((r) => r.caminho)).toEqual([CAMINHO_SITUACAO_LI]);
  });

  it('a stored envio LI does not list ⇒ pedido-divergente, ZERO PUTs (identity failure)', async () => {
    const c = cenario({ externalId: '123' });
    expect(await c.rodar()).toEqual({ kind: 'recusado', motivo: M.pedidoDivergente, status: null });
    expect(c.p.puts()).toEqual([]);
    expect(c.aviso()).toMatchObject({ params: { motivo: M.pedidoDivergente } });
  });

  it('the guard read about another numero, or a 404 ⇒ pedido-ausente, zero PUTs', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () =>
        respostaJson(200, { ...c.p.estado.pedido, numero: NUMERO_LI + 1 }),
      ),
    );
    expect(await c.rodar()).toEqual({ kind: 'recusado', motivo: M.pedidoAusente, status: null });
    const d = cenario();
    d.p.fila.push(naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(404, {})));
    expect(await d.rodar()).toEqual({ kind: 'recusado', motivo: M.pedidoAusente, status: null });
    expect([...c.p.puts(), ...d.p.puts()]).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                      Delivery, pickup, and LI ahead                   */
/* -------------------------------------------------------------------------- */

describe('delivery and pickup', () => {
  it.each([C.pedidoPago, C.pedidoEnviado, C.prontoParaRetirada])(
    '`entregue` at %s with a valid code LI lacks ⇒ exactly one PUT (14), ZERO code PUTs, one INFO `objeto-nao-enviado`',
    async (codigo) => {
      const c = cenario({ codigo, freteEstado: ESTADO_FRETE.entregue });
      expect(await c.rodar({ estado: ESTADO_RASTREIO_LI.entregue })).toEqual({ kind: 'escrito' });
      expect(c.p.puts()).toEqual([
        { metodo: 'PUT', caminho: CAMINHO_SITUACAO_LI, corpo: { codigo: C.pedidoEntregue } },
      ]);
      const nao = escritas(c.linhas, 'objeto-nao-enviado');
      expect(nao).toHaveLength(1);
      expect(nao[0]?.severidade).toBe('INFO');
    },
  );

  it('`aguardandoRetirada` writes 13 only', async () => {
    const c = cenario({ freteEstado: ESTADO_FRETE.aguardandoRetirada, codRastreio: null });
    expect(await c.rodar({ estado: ESTADO_RASTREIO_LI.aguardandoRetirada })).toEqual({
      kind: 'escrito',
    });
    expect(c.p.puts()).toEqual([
      { metodo: 'PUT', caminho: CAMINHO_SITUACAO_LI, corpo: { codigo: C.prontoParaRetirada } },
    ]);
  });

  it('out of order: `entregue` writes 14, then the late `postado` is superseded — never 14 → 11', async () => {
    const c = cenario({ freteEstado: ESTADO_FRETE.entregue });
    expect(await c.rodar({ estado: ESTADO_RASTREIO_LI.entregue })).toEqual({ kind: 'escrito' });
    expect(await c.rodar({ estado: ESTADO_RASTREIO_LI.postado })).toEqual({
      kind: 'superado',
      motivo: 'superado-por-entrega',
    });
    expect(c.p.puts().map((r) => r.corpo)).toEqual([{ codigo: C.pedidoEntregue }]);
  });

  it('LI at 14 with a FRESH `postado` (the ERP shows postado) ⇒ transicao-lateral, ZERO PUTs, never the code', async () => {
    const c = cenario({ codigo: C.pedidoEntregue });
    expect(await c.rodar()).toEqual({ kind: 'recusado', motivo: M.transicaoLateral, status: null });
    expect(c.p.puts()).toEqual([]);
    expect(c.aviso()).toMatchObject({
      params: { motivo: M.transicaoLateral, situacao: C.pedidoEntregue, estado: 'postado' },
    });
    // It closes itself at the ERP's later delivery run (ja-refletido, a newer clock).
    seedPedidoLi(c.db, PEDIDO_ID, ID, { estado: ESTADO_FRETE.entregue, codRastreio: CODIGO });
    expect(
      await c.rodar({ estado: ESTADO_RASTREIO_LI.entregue, eventoEmMs: EVENTO_MS + 1 }),
    ).toEqual({ kind: 'ja-refletido' });
    expect(c.aviso()?.resolvidoEm).not.toBeNull();
  });

  it('window replay: a deferred `postado` and `entregue`, the pedido at `entregue`, LI at 4 ⇒ `postado` superseded, ONE PUT (14)', async () => {
    const c = cenario({ freteEstado: ESTADO_FRETE.entregue });
    expect((await c.rodar({ estado: ESTADO_RASTREIO_LI.postado })).kind).toBe('superado');
    expect(await c.rodar({ estado: ESTADO_RASTREIO_LI.entregue })).toEqual({ kind: 'escrito' });
    expect(c.p.puts().map((r) => r.corpo)).toEqual([{ codigo: C.pedidoEntregue }]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The paid allow-list, under `on`                       */
/* -------------------------------------------------------------------------- */

describe('the paid allow-list under `on`', () => {
  it('LI at cancelamento_solicitado (1019, the buyer asked to cancel) ⇒ ZERO PUTs, aviso situacao-bloqueada at CRITICO', async () => {
    const c = cenario({ codigo: C.cancelamentoSolicitado });
    expect(await c.rodar()).toEqual({
      kind: 'recusado',
      motivo: M.situacaoBloqueada,
      status: null,
    });
    expect(c.p.puts()).toEqual([]);
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.critico,
      params: { motivo: M.situacaoBloqueada, situacao: C.cancelamentoSolicitado },
    });
  });

  it.each([
    C.pagamentoEmDisputa,
    C.pedidoCancelado,
    C.pagamentoDevolvido,
    C.pedidoChargeback,
    C.pagamentoDevolvidoSemRetorno,
  ])(
    '⚠️ NEAR-MISS: LI at %s (another never-write codigo) ⇒ ZERO PUTs, aviso situacao-bloqueada at atencao',
    async (codigo) => {
      const c = cenario({ codigo });
      expect(await c.rodar()).toEqual({
        kind: 'recusado',
        motivo: M.situacaoBloqueada,
        status: null,
      });
      expect(c.p.puts()).toEqual([]);
      expect(c.aviso()).toMatchObject({
        severidade: SEVERIDADE_AVISO.atencao,
        params: { motivo: M.situacaoBloqueada, situacao: codigo },
      });
    },
  );

  it.each([C.pedidoEfetuado, C.aguardandoPagamento, C.pagamentoEmAnalise])(
    '⚠️ NEAR-MISS: LI at %s (unpaid) ⇒ ZERO PUTs, aviso situacao-nao-paga naming the ERP estado, at atencao',
    async (codigo) => {
      const c = cenario({ codigo });
      expect(await c.rodar()).toEqual({
        kind: 'recusado',
        motivo: M.situacaoNaoPaga,
        status: null,
      });
      expect(c.p.puts()).toEqual([]);
      expect(c.aviso()).toMatchObject({
        severidade: SEVERIDADE_AVISO.atencao,
        params: { motivo: M.situacaoNaoPaga, situacao: codigo, estado: 'postado' },
      });
    },
  );

  it.each(['Pedido_Pago', 'pedido_pago ', 'pedido_em_transporte'])(
    '⚠️ NEAR-MISS: LI at the unknown %j ⇒ ZERO PUTs, aviso situacao-desconhecida (fail closed)',
    async (codigo) => {
      const c = cenario({ codigo });
      expect(await c.rodar()).toEqual({
        kind: 'recusado',
        motivo: M.situacaoDesconhecida,
        status: null,
      });
      expect(c.p.puts()).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                      Dry-run and the canary: defer, never act        */
/* -------------------------------------------------------------------------- */

describe('a decision that is not `on` defers every outcome but ja-refletido and superado', () => {
  it.each([
    ['dry-run', ambiente(MODO_LI.dryRun), 'dry-run'],
    ['outside the canary', ambiente(MODO_LI.on, 'outra-conta:1'), 'fora-do-canario'],
    ['on with no list', ambiente(MODO_LI.on, null), 'sem-canario'],
  ])('%s: a would-be write ⇒ one diff line, ZERO PUTs, adiado', async (_caso, amb, motivo) => {
    const c = cenario({ ambiente: amb });
    expect(await c.rodar()).toEqual({ kind: 'adiado', motivo, recusa: null });
    expect(c.p.puts()).toEqual([]);
    expect(doEvento(c.linhas, 'diff')).toHaveLength(1);
    expect(c.aviso()).toBeUndefined();
  });

  it.each([
    [{ codigo: C.cancelamentoSolicitado }, M.situacaoBloqueada],
    [{ codigo: C.aguardandoPagamento }, M.situacaoNaoPaga],
    [{ codigo: 'Pedido_Pago' }, M.situacaoDesconhecida],
    [{ codigo: C.pedidoEntregue }, M.transicaoLateral],
    [{ externalId: '123' }, M.pedidoDivergente],
    [{ codigo: C.pedidoEnviado, objeto: 'OUTRO999BR' }, M.objetoDivergente],
  ])(
    'dry-run: the refusal %j ⇒ defer with the would-be motivo %s in the reason, ZERO avisos; replayed under `on` ⇒ the aviso',
    async (o, motivo) => {
      const c = cenario({ ...o, ambiente: ambiente(MODO_LI.dryRun) });
      expect(await c.rodar()).toEqual({ kind: 'adiado', motivo: 'dry-run', recusa: motivo });
      expect(c.p.puts()).toEqual([]);
      expect(c.aviso()).toBeUndefined();
      const r = await c.rodar({ ambiente: ambiente(MODO_LI.on) });
      expect(r).toMatchObject({ motivo });
      expect(c.aviso()).toMatchObject({ params: { motivo } });
    },
  );

  it('dry-run: the MIXED case (11 + an objeto aviso) ⇒ a diff for the 11 and the would-be motivo in the reason', async () => {
    const c = cenario({ codRastreio: `${CODIGO} `, ambiente: ambiente(MODO_LI.dryRun) });
    expect(await c.rodar()).toEqual({
      kind: 'adiado',
      motivo: 'dry-run',
      recusa: M.objetoInvalido,
    });
    expect(doEvento(c.linhas, 'diff')[0]?.campos).toMatchObject({ campo: 'codigo' });
    expect(c.aviso()).toBeUndefined();
  });

  it('dry-run: LI already holding everything ⇒ ja-refletido (resolve), and NO aviso write at all', async () => {
    const c = cenario({
      codigo: C.pedidoEnviado,
      objeto: CODIGO,
      ambiente: ambiente(MODO_LI.dryRun),
    });
    expect(await c.rodar()).toEqual({ kind: 'ja-refletido' });
    expect(c.aviso()).toBeUndefined();
  });

  it.each([
    ['dry-run', ambiente(MODO_LI.dryRun), 'dry-run'],
    ['outside the canary', ambiente(MODO_LI.on, 'outra-conta:1'), 'fora-do-canario'],
    ['on with no list', ambiente(MODO_LI.on, null), 'sem-canario'],
  ])(
    '⚠️ %s: a deterministic refusal of the deciding read DEFERS (replayed under `on`), never parks',
    async (_caso, amb, motivo) => {
      for (const resposta of [
        () => respostaJson(200, { numero: 'x' }),
        () => respostaJson(400, {}),
        () => new Response('', { status: 302, headers: { location: '/x' } }),
      ]) {
        const c = cenario({ ambiente: amb });
        c.p.fila.push(naProxima(CAMINHO_PEDIDO_LI, 'GET', resposta));
        expect(await c.rodar()).toEqual({ kind: 'adiado', motivo, recusa: null });
        expect(c.p.puts()).toEqual([]);
        expect(c.aviso()).toBeUndefined();
        // One WARNING line names the class; nothing is parked, so no ERROR line.
        expect(c.avisos.filter((a) => String(a[0]).includes('recusa determinística'))).toHaveLength(
          1,
        );
        expect(c.erros).toEqual([]);
        // Under `on` the same refusal parks (with its ERROR line).
        c.p.fila.push(naProxima(CAMINHO_PEDIDO_LI, 'GET', resposta));
        expect((await c.rodar({ ambiente: ambiente(MODO_LI.on) })).kind).toBe(
          'recusa-deterministica',
        );
      }
    },
  );

  it('dry-run: a 404 guard read ⇒ adiado with pedido-ausente, no aviso', async () => {
    const c = cenario({ ambiente: ambiente(MODO_LI.dryRun) });
    c.p.fila.push(naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(404, {})));
    expect(await c.rodar()).toEqual({ kind: 'adiado', motivo: 'dry-run', recusa: M.pedidoAusente });
    expect(c.aviso()).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                           The history check                           */
/* -------------------------------------------------------------------------- */

describe('the history check after a situação we caused', () => {
  it('a row `cancelamento_solicitado → pedido_enviado` after ours ⇒ situacao-sobrescrita, CRITICO — after the code PUT’s own move too', async () => {
    const c = cenario();
    // The buyer asks to cancel in the instant before our code lands; the
    // override falls through (null), so the default route then writes the code.
    c.p.fila.push((r) => {
      if (r.metodo === 'PUT' && r.caminho === CAMINHO_ENVIO_LI) c.p.mover(C.cancelamentoSolicitado);
      return null;
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.situacaoSobrescrita });
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.critico,
      params: { motivo: M.situacaoSobrescrita, situacao: C.cancelamentoSolicitado },
    });
  });

  it('a compatible intermediate (`pedido_em_separacao`) ⇒ INFO only, NO aviso', async () => {
    const c = cenario();
    c.p.fila.push((r) => {
      if (r.metodo === 'PUT' && r.caminho === CAMINHO_ENVIO_LI) c.p.mover(C.pedidoEmSeparacao);
      return null;
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito' });
    expect(doEvento(c.linhas, 'conferencia-historico')[0]).toMatchObject({
      severidade: 'INFO',
      campos: { resultado: 'intermediaria-compativel' },
    });
    expect(c.aviso()?.resolvidoEm).not.toBeNull();
  });

  it('no row yet (sem-linha) or an unreadable history ⇒ a WARNING, NO aviso; the write stays done', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_HISTORICO_LI, 'GET', () =>
        respostaJson(200, {
          meta: { limit: 50, offset: 0, next: null, previous: null, total_count: 0 },
          objects: [],
        }),
      ),
    );
    expect(await c.rodar()).toEqual({ kind: 'escrito' });
    expect(doEvento(c.linhas, 'conferencia-historico')[0]?.severidade).toBe('WARNING');

    const d = cenario();
    d.p.fila.push(naProxima(CAMINHO_HISTORICO_LI, 'GET', () => respostaJson(429, {})));
    expect(await d.rodar()).toEqual({ kind: 'escrito' });
    expect(doEvento(d.linhas, 'conferencia-historico')[0]).toMatchObject({
      severidade: 'WARNING',
      campos: { resultado: 'ilegivel' },
    });
  });
});

/**
 * Scripts one posting run on the platform, in ONE stateful override (the queue
 * only ever consults its head): `noIntervalo` runs as the code PUT arrives,
 * BEFORE the default route stores the code and moves the order to 11;
 * `depoisDoPut` runs as the read-back GET arrives, after that route; `leitura`,
 * when given, answers the read-back from the platform's state (else the
 * default route does); `historico`, when given, answers the history read (else
 * the default route does) — with or without `leitura`.
 *
 * ⚠️ The queue SHIFTS an override the moment it answers non-null, so a
 * `leitura` answer consumes this one: the history answer then goes to a
 * one-shot override queued right behind it (index 1 now, the head once the
 * shift lands). Without that, a `historico` passed with a `leitura` was
 * silently ignored and the run read the REAL history — a test of an unreadable
 * history would pass vacuously.
 */
function roteirizarPostagem(
  c: Cenario,
  o: {
    noIntervalo?: () => void;
    depoisDoPut?: () => void;
    leitura?: (pedido: Record<string, unknown>) => Record<string, unknown>;
    historico?: () => Response;
  },
): void {
  let fase: 'put' | 'leitura' | 'historico' | 'fim' = 'put';
  c.p.fila.push((r) => {
    if (fase === 'put' && r.metodo === 'PUT' && r.caminho === CAMINHO_ENVIO_LI) {
      o.noIntervalo?.();
      fase = 'leitura';
      return null;
    }
    if (fase === 'leitura' && r.metodo === 'GET' && r.caminho === CAMINHO_PEDIDO_LI) {
      o.depoisDoPut?.();
      fase = 'historico';
      if (o.leitura === undefined) return null;
      if (o.historico !== undefined) {
        c.p.fila.splice(1, 0, naProxima(CAMINHO_HISTORICO_LI, 'GET', o.historico));
      }
      return respostaJson(200, o.leitura(structuredClone(c.p.estado.pedido)));
    }
    if (fase === 'historico' && r.metodo === 'GET' && r.caminho === CAMINHO_HISTORICO_LI) {
      fase = 'fim';
      return o.historico === undefined ? null : o.historico();
    }
    return null;
  });
}

/** A history page with no rows at all: no anchor, so `inconclusivo`. */
const historicoVazio = () =>
  respostaJson(200, {
    meta: { limit: 50, offset: 0, next: null, previous: null, total_count: 0 },
    objects: [],
  });

const OUTRO_CODIGO = 'OUTRO999BR';

/** Someone else's code typed into LI's envio after ours landed. */
const outroCodigoNoEnvio = (c: Cenario) => () => {
  (c.p.estado.pedido.envios as { objeto: string | null }[])[0]!.objeto = OUTRO_CODIGO;
};

describe('a landed code whose read-back does not show our move cleanly still checks the history', () => {
  it.each([
    ['at 11', (p: Record<string, unknown>) => p],
    [
      'still at the deciding codigo (a read-back older than the history)',
      (p: Record<string, unknown>) => ({ ...p, situacao: { codigo: C.pedidoPago } }),
    ],
    [
      'at a THIRD codigo outside the never-write set (the order moved on to 14)',
      (p: Record<string, unknown>) => ({ ...p, situacao: { codigo: C.pedidoEntregue } }),
    ],
  ])(
    '⚠️ a read-back holding ANOTHER code (%s), over a cancellation request the code’s own move overwrote ⇒ situacao-sobrescrita CRITICO naming 1019, outranking the deriva',
    async (_caso, leitura) => {
      const c = cenario();
      roteirizarPostagem(c, {
        noIntervalo: () => c.p.mover(C.cancelamentoSolicitado),
        depoisDoPut: outroCodigoNoEnvio(c),
        leitura,
      });
      expect(await c.rodar()).toEqual({
        kind: 'escrito-com-aviso',
        motivo: M.situacaoSobrescrita,
      });
      expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
      expect(c.p.puts()).toEqual([
        { metodo: 'PUT', caminho: CAMINHO_ENVIO_LI, corpo: { objeto: CODIGO } },
      ]);
      // The drift was seen, and logged — the overwritten request is the aviso.
      expect(doEvento(c.linhas, 'deriva')).toHaveLength(1);
      const conferencia = doEvento(c.linhas, 'conferencia-historico');
      expect(conferencia).toHaveLength(1);
      expect(conferencia[0]).toMatchObject({
        severidade: 'WARNING',
        campos: {
          resultado: 'sobrescrito',
          codigoAntes: C.pedidoPago,
          codigoEscrito: C.pedidoEnviado,
          codigoSobrescrito: C.cancelamentoSolicitado,
        },
      });
      expect(c.aviso()).toMatchObject({
        severidade: SEVERIDADE_AVISO.critico,
        params: { motivo: M.situacaoSobrescrita, situacao: C.cancelamentoSolicitado },
        resolvidoEm: null,
      });
    },
  );

  it('⚠️ NEAR-MISS: the same drift over a clean move (`pedido_pago → pedido_enviado`) ⇒ the history read, conferido, and the deriva alone at ATENCAO', async () => {
    const c = cenario();
    roteirizarPostagem(c, { depoisDoPut: outroCodigoNoEnvio(c) });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.deriva });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
    expect(doEvento(c.linhas, 'conferencia-historico')[0]).toMatchObject({
      severidade: 'INFO',
      campos: { resultado: 'conferido', codigoAntes: C.pedidoPago },
    });
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.atencao,
      params: { motivo: M.deriva },
      resolvidoEm: null,
    });
  });

  it('⚠️ NEAR-MISS: the same drift onto an order the deciding read saw ALREADY at 11 ⇒ NO history read, the deriva as before (the accepted residual — even over a request in the gap)', async () => {
    const c = cenario({ codigo: C.pedidoEnviado });
    roteirizarPostagem(c, {
      noIntervalo: () => c.p.mover(C.cancelamentoSolicitado),
      depoisDoPut: outroCodigoNoEnvio(c),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.deriva });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO]);
    expect(doEvento(c.linhas, 'conferencia-historico')).toEqual([]);
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.atencao,
      params: { motivo: M.deriva },
    });
  });

  it('⚠️ NEAR-MISS: the same drift with the history unreadable (429) ⇒ the WARNING `ilegivel` line, the deriva aviso, never a sobrescrita', async () => {
    const c = cenario();
    roteirizarPostagem(c, {
      noIntervalo: () => c.p.mover(C.cancelamentoSolicitado),
      depoisDoPut: outroCodigoNoEnvio(c),
      historico: () => respostaJson(429, {}),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.deriva });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
    expect(doEvento(c.linhas, 'conferencia-historico')).toEqual([
      expect.objectContaining({
        severidade: 'WARNING',
        campos: expect.objectContaining({ resultado: 'ilegivel' }) as unknown,
      }),
    ]);
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.atencao,
      params: { motivo: M.deriva },
    });
    expect(c.p.puts()).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: the same drift read back at the deciding codigo AND the history unreadable (a `leitura` and a `historico` scripted together) ⇒ `ilegivel`, the deriva alone — never the overwrite the real history holds', async () => {
    const c = cenario();
    roteirizarPostagem(c, {
      noIntervalo: () => c.p.mover(C.cancelamentoSolicitado),
      depoisDoPut: outroCodigoNoEnvio(c),
      leitura: (p) => ({ ...p, situacao: { codigo: C.pedidoPago } }),
      historico: () => respostaJson(429, {}),
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.deriva });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
    expect(doEvento(c.linhas, 'conferencia-historico')).toEqual([
      expect.objectContaining({
        severidade: 'WARNING',
        campos: expect.objectContaining({ resultado: 'ilegivel' }) as unknown,
      }),
    ]);
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.atencao,
      params: { motivo: M.deriva },
    });
    expect(c.p.fila).toEqual([]);
  });

  it.each([
    ['inside the never-write set (the request honoured: 11 → cancelled)', C.pedidoCancelado],
    ['OUTSIDE the never-write set (the order delivered: 11 → 14)', C.pedidoEntregue],
  ])(
    '⚠️ our code read back at a THIRD codigo %s, after the code’s own move overwrote a cancellation request ⇒ situacao-sobrescrita CRITICO naming 1019, the move OBSERVED (no efeito-pendente line), park',
    async (_caso, terceiro) => {
      const c = cenario();
      roteirizarPostagem(c, {
        noIntervalo: () => c.p.mover(C.cancelamentoSolicitado),
        depoisDoPut: () => c.p.mover(terceiro),
      });
      expect(await c.rodar()).toEqual({
        kind: 'escrito-com-aviso',
        motivo: M.situacaoSobrescrita,
      });
      expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
      expect(c.p.puts()).toHaveLength(1);
      // The history holds our move: it was seen, never "pending".
      expect(escritas(c.linhas, 'efeito-observado')).toHaveLength(1);
      expect(escritas(c.linhas, 'efeito-pendente')).toEqual([]);
      expect(c.aviso()).toMatchObject({
        severidade: SEVERIDADE_AVISO.critico,
        params: { motivo: M.situacaoSobrescrita, situacao: C.cancelamentoSolicitado },
        resolvidoEm: null,
      });
    },
  );

  it.each<[string, string, (c: Cenario) => Parameters<typeof roteirizarPostagem>[1]]>([
    [
      'a clean move then a request (`pedido_pago → pedido_enviado → cancelamento_solicitado`)',
      'conferido',
      (c) => ({ depoisDoPut: () => c.p.mover(C.cancelamentoSolicitado) }),
    ],
    [
      'a compatible intermediate, then delivered (`pedido_pago → pedido_em_separacao → pedido_enviado → pedido_entregue`)',
      'intermediaria-compativel',
      (c) => ({
        noIntervalo: () => c.p.mover(C.pedidoEmSeparacao),
        depoisDoPut: () => c.p.mover(C.pedidoEntregue),
      }),
    ],
    [
      'a duplicate of our move, then delivered (`… → pedido_enviado → pedido_enviado → pedido_entregue`)',
      'escrita-duplicada',
      (c) => ({
        depoisDoPut: () => {
          c.p.mover(C.pedidoEnviado);
          c.p.mover(C.pedidoEntregue);
        },
      }),
    ],
  ])(
    '⚠️ NEAR-MISS: our code at a third codigo, the history holding our move after %s ⇒ `%s`, the move OBSERVED: `efeito-observado`, `escrito`, a clocked resolve — never parcial/efeito-pendente',
    async (_caso, resultado, roteiro) => {
      const c = cenario();
      roteirizarPostagem(c, roteiro(c));
      expect(await c.rodar()).toEqual({ kind: 'escrito' });
      expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
      expect(c.p.puts()).toHaveLength(1);
      expect(doEvento(c.linhas, 'conferencia-historico')).toEqual([
        expect.objectContaining({
          campos: expect.objectContaining({ resultado, codigoAntes: C.pedidoPago }) as unknown,
        }),
      ]);
      expect(escritas(c.linhas, 'efeito-observado')).toHaveLength(1);
      expect(escritas(c.linhas, 'efeito-pendente')).toEqual([]);
      expect(c.aviso()).toMatchObject({ relogioEvento: EVENTO_MS * 1000 });
      expect(c.aviso()?.resolvidoEm).not.toBeNull();
    },
  );

  it.each<[string, string, (c: Cenario) => Parameters<typeof roteirizarPostagem>[1], boolean]>([
    [
      'NO row of our move yet (`sem-linha`: an operator moved it, LI has not)',
      'sem-linha',
      (c) => ({ noIntervalo: () => c.p.mover(C.emProducao) }),
      false,
    ],
    [
      'an inconclusive history (no anchor)',
      'inconclusivo',
      (c) => ({ depoisDoPut: () => c.p.mover(C.pedidoEntregue), historico: historicoVazio }),
      true,
    ],
    [
      'an unreadable history (429)',
      'ilegivel',
      (c) => ({
        depoisDoPut: () => c.p.mover(C.pedidoEntregue),
        historico: () => respostaJson(429, {}),
      }),
      true,
    ],
  ])(
    '⚠️ NEAR-MISS: our code at a third codigo with %s ⇒ `%s`, the move NOT seen: parcial/efeito-pendente, the efeito-pendente line, NO aviso',
    async (_caso, resultado, roteiro, move) => {
      const c = cenario({ mover: move });
      roteirizarPostagem(c, roteiro(c));
      expect(await c.rodar()).toEqual({ kind: 'parcial', efeito: 'efeito-pendente' });
      expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, GET_HISTORICO]);
      expect(c.p.puts()).toHaveLength(1);
      expect(doEvento(c.linhas, 'conferencia-historico')).toEqual([
        expect.objectContaining({
          severidade: 'WARNING',
          campos: expect.objectContaining({ resultado }) as unknown,
        }),
      ]);
      expect(escritas(c.linhas, 'efeito-pendente')).toHaveLength(1);
      expect(escritas(c.linhas, 'efeito-observado')).toEqual([]);
      expect(c.aviso()).toBeUndefined();
    },
  );

  it('⚠️ NEAR-MISS: our code at a third codigo on an order the deciding read saw ALREADY at 11 ⇒ NO history read, parcial/efeito-pendente (the accepted residual)', async () => {
    const c = cenario({ codigo: C.pedidoEnviado });
    roteirizarPostagem(c, { depoisDoPut: () => c.p.mover(C.cancelamentoSolicitado) });
    expect(await c.rodar()).toEqual({ kind: 'parcial', efeito: 'efeito-pendente' });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO]);
    expect(doEvento(c.linhas, 'conferencia-historico')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                     A write refused with a live token                  */
/* -------------------------------------------------------------------------- */

describe('a 401/403 on a PUT, with the token still reading', () => {
  it('code PUT 403 + confirming GET 200 ⇒ throws EscritaRecusadaLiError, conta NOT parked, zero avisos, no situação PUT', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(EscritaRecusadaLiError);
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO]);
    expect(c.db.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
    expect(c.aviso()).toBeUndefined();
    const retentativa = escritas(c.linhas, 'recusada-retentativa');
    expect(retentativa).toHaveLength(1);
    expect(retentativa[0]).toMatchObject({ severidade: 'WARNING', campos: { status: 403 } });
  });

  it('the retry re-derives from a fresh guard GET and makes exactly ONE PUT per attempt', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(EscritaRecusadaLiError);
    expect(await c.rodar()).toEqual({ kind: 'escrito' });
    expect(c.p.puts().map((r) => r.caminho)).toEqual([CAMINHO_ENVIO_LI, CAMINHO_ENVIO_LI]);
  });

  it('PUT 401 + confirming GET 401 ⇒ the conta is parked, adiado/conta-parada, NO escrita-recusada', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(401, {})),
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(401, {})),
    );
    // The first GET (the guard) is answered by the default: the queue's first claim is the PUT.
    expect(await c.rodar()).toEqual({ kind: 'adiado', motivo: 'conta-parada', recusa: null });
    expect(c.db.ler(caminhoCredencial(ID))?.reconexaoPendente).not.toBeNull();
    expect(c.aviso()).toBeUndefined();
  });

  it('the conta parked between the PUT and the confirm ⇒ the getter refuses: ZERO requests, defer', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => {
        c.db.seed(caminhoCredencial(ID), {
          ...c.db.ler(caminhoCredencial(ID)),
          reconexaoPendente: { status: 401, desdeMs: AGORA_MS, refCredencial: 'x' },
        });
        return respostaJson(403, {});
      }),
    );
    const r = await c.rodar();
    expect(r).toEqual({ kind: 'adiado', motivo: 'conta-parada', recusa: null });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO]);
  });

  it.each([
    ['429', () => respostaJson(429, {})],
    ['503', () => respostaJson(503, {})],
    ['a dropped connection', () => new TypeError('fetch failed')],
  ])('a confirming GET answered %s ⇒ throw, nothing concluded', async (_caso, falha) => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})),
      naProxima(CAMINHO_PEDIDO_LI, 'GET', falha),
    );
    await expect(c.rodar()).rejects.toBeInstanceOf(Error);
    expect(c.aviso()).toBeUndefined();
    expect(c.p.puts()).toHaveLength(1);
  });

  it.each([
    ['404', () => respostaJson(404, {})],
    ['off its schema', () => respostaJson(200, { numero: 'x' })],
    ['400', () => respostaJson(400, {})],
    ['302', () => new Response('', { status: 302, headers: { location: '/x' } })],
  ])(
    '⚠️ a situação 403 whose confirming GET answers %s ⇒ nothing concluded: throws EscritaRecusadaLiError — on the last pass too, never a silent park',
    async (_caso, confirmacao) => {
      for (const passagemFinal of [null, 'quente'] as const) {
        const c = cenario({ codRastreio: null });
        c.p.fila.push(
          naProxima(CAMINHO_SITUACAO_LI, 'PUT', () => respostaJson(403, {})),
          naProxima(CAMINHO_PEDIDO_LI, 'GET', confirmacao),
        );
        await expect(c.rodar({ passagemFinal })).rejects.toBeInstanceOf(EscritaRecusadaLiError);
        expect(c.p.puts()).toHaveLength(1);
        expect(c.aviso()).toBeUndefined();
        expect(c.db.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
      }
    },
  );

  it.each([
    ['404', () => respostaJson(404, {})],
    ['off its schema', () => respostaJson(200, { numero: 'x' })],
    ['400', () => respostaJson(400, {})],
  ])(
    '⚠️ a code 403 whose confirming (second) GET answers %s ⇒ nothing concluded: throws EscritaRecusadaLiError',
    async (_caso, confirmacao) => {
      for (const passagemFinal of [null, 'quente'] as const) {
        const c = cenario();
        c.p.fila.push(
          naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})),
          naProxima(CAMINHO_PEDIDO_LI, 'GET', confirmacao),
        );
        await expect(c.rodar({ passagemFinal })).rejects.toBeInstanceOf(EscritaRecusadaLiError);
        expect(c.p.puts()).toHaveLength(1);
        expect(c.aviso()).toBeUndefined();
      }
    },
  );

  it('the LAST hot pass, code still 403 ⇒ aviso escrita-recusada(403), then the 11 PUT from the second base', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    expect(await c.rodar({ passagemFinal: 'quente' })).toEqual({
      kind: 'escrito-com-aviso',
      motivo: M.escritaRecusada,
    });
    expect(c.p.chamadas()).toEqual([
      GET_PEDIDO,
      PUT_ENVIO,
      GET_PEDIDO,
      PUT_SITUACAO,
      GET_PEDIDO,
      GET_HISTORICO,
    ]);
    expect(c.aviso()).toMatchObject({ params: { motivo: M.escritaRecusada, status: 403 } });
  });

  it('the last pass: a situação 403 after the code 403 parks with NO second confirming GET', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})),
      naProxima(CAMINHO_SITUACAO_LI, 'PUT', () => respostaJson(403, {})),
    );
    expect(await c.rodar({ passagemFinal: 'quente' })).toEqual({
      kind: 'recusado',
      motivo: M.escritaRecusada,
      status: 403,
    });
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO, PUT_SITUACAO]);
  });

  it('⚠️ a DEFERRED row’s last daily pass never concludes: the refusal throws (and graduates)', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    await expect(c.rodar({ passagemFinal: 'adiada' })).rejects.toBeInstanceOf(
      EscritaRecusadaLiError,
    );
    expect(c.aviso()).toBeUndefined();
  });

  it('a situação PUT 403 + confirm 200 on a non-final try ⇒ throws; on the last pass ⇒ aviso, park', async () => {
    const c = cenario({ codRastreio: null });
    c.p.fila.push(naProxima(CAMINHO_SITUACAO_LI, 'PUT', () => respostaJson(403, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(EscritaRecusadaLiError);
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_SITUACAO, GET_PEDIDO]);

    const d = cenario({ codRastreio: null });
    d.p.fila.push(naProxima(CAMINHO_SITUACAO_LI, 'PUT', () => respostaJson(403, {})));
    expect(await d.rodar({ passagemFinal: 'quente' })).toEqual({
      kind: 'recusado',
      motivo: M.escritaRecusada,
      status: 403,
    });
    expect(d.aviso()).toMatchObject({ params: { status: 403 } });
  });

  it('dry-run never reaches the refusal rule: zero PUTs', async () => {
    const c = cenario({ ambiente: ambiente(MODO_LI.dryRun) });
    c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    expect((await c.rodar()).kind).toBe('adiado');
    expect(c.p.puts()).toEqual([]);
  });

  it('a stale-ref 401 on the guard GET (the token was re-saved meanwhile) ⇒ rethrown', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => {
        seedCredencial(c.db, ID, { personalToken: TOKEN_B });
        __resetAllReadCaches();
        return respostaJson(401, {});
      }),
    );
    await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
    expect(c.p.puts()).toEqual([]);
  });

  it('a token re-saved between the guard GET and the PUT ⇒ the pin refuses: ZERO PUTs, throw', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => {
        seedCredencial(c.db, ID, { personalToken: TOKEN_B });
        return respostaJson(200, c.p.estado.pedido);
      }),
    );
    await expect(c.rodar()).rejects.toBeInstanceOf(LiCredencialTrocadaError);
    expect(c.p.puts()).toEqual([]);
  });
});

describe('other refusals of a PUT', () => {
  it.each([
    [302, () => new Response('', { status: 302, headers: { location: '/x' } })],
    [400, () => respostaJson(400, {})],
  ])(
    'a situação PUT %i ⇒ park + escrita-recusada, class and status only',
    async (status, resposta) => {
      const c = cenario({ codRastreio: null });
      c.p.fila.push(naProxima(CAMINHO_SITUACAO_LI, 'PUT', resposta));
      expect(await c.rodar()).toEqual({ kind: 'recusado', motivo: M.escritaRecusada, status });
      expect(c.aviso()).toMatchObject({ params: { motivo: M.escritaRecusada, status } });
    },
  );

  it('⚠️ no stored envio, then the situação PUT refused (400) ⇒ the aviso is escrita-recusada(400), never envio-divergente', async () => {
    const c = cenario({ externalId: null });
    c.p.fila.push(naProxima(CAMINHO_SITUACAO_LI, 'PUT', () => respostaJson(400, {})));
    expect(await c.rodar()).toEqual({ kind: 'recusado', motivo: M.escritaRecusada, status: 400 });
    expect(c.aviso()).toMatchObject({ params: { motivo: M.escritaRecusada, status: 400 } });
  });

  it('⚠️ no stored envio, then the situação PUT 403 on the last hot pass ⇒ escrita-recusada(403)', async () => {
    const c = cenario({ externalId: null });
    c.p.fila.push(naProxima(CAMINHO_SITUACAO_LI, 'PUT', () => respostaJson(403, {})));
    expect(await c.rodar({ passagemFinal: 'quente' })).toEqual({
      kind: 'recusado',
      motivo: M.escritaRecusada,
      status: 403,
    });
    expect(c.aviso()).toMatchObject({ params: { motivo: M.escritaRecusada, status: 403 } });
  });

  it('⚠️ an invalid stored code, then the 11’s read-back shows another situação ⇒ the deriva aviso, never objeto-invalido', async () => {
    const c = cenario({ codRastreio: `${CODIGO} ` });
    c.p.fila.push(
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(200, c.p.estado.pedido)),
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => {
        c.p.mover(C.cancelamentoSolicitado);
        return respostaJson(200, c.p.estado.pedido);
      }),
    );
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.deriva });
    expect(c.aviso()).toMatchObject({ params: { motivo: M.deriva } });
  });

  it('⚠️ a deriva AND a sobrescrita in the same situação write ⇒ the CRITICO sobrescrita, never the deriva', async () => {
    // The buyer asks to cancel just before our 11 lands, and again right after it.
    const c = cenario({ codRastreio: null });
    let fase = 0;
    c.p.fila.push((r) => {
      if (fase === 0 && r.metodo === 'PUT' && r.caminho === CAMINHO_SITUACAO_LI) {
        c.p.mover(C.cancelamentoSolicitado);
        fase = 1;
        return null;
      }
      if (fase === 1 && r.metodo === 'GET' && r.caminho === CAMINHO_PEDIDO_LI) {
        c.p.mover(C.cancelamentoSolicitado);
        fase = 2;
        return respostaJson(200, c.p.estado.pedido);
      }
      return null;
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.situacaoSobrescrita });
    expect(escritas(c.linhas, 'aplicada')).toHaveLength(1);
    expect(doEvento(c.linhas, 'deriva')).toHaveLength(1);
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.critico,
      params: { motivo: M.situacaoSobrescrita, situacao: C.cancelamentoSolicitado },
    });
  });

  it('two refused writes in one run (the code 400, then the 11 302) ⇒ the FIRST refusal’s status: an equal-rank motivo never replaces one already set', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(400, {})),
      naProxima(
        CAMINHO_SITUACAO_LI,
        'PUT',
        () => new Response('', { status: 302, headers: { location: '/x' } }),
      ),
    );
    expect(await c.rodar()).toEqual({ kind: 'recusado', motivo: M.escritaRecusada, status: 400 });
    expect(c.p.puts().map((r) => r.caminho)).toEqual([CAMINHO_ENVIO_LI, CAMINHO_SITUACAO_LI]);
    expect(c.aviso()).toMatchObject({ params: { motivo: M.escritaRecusada, status: 400 } });
  });

  it('an invalid stored code and a sobrescrita in the same run ⇒ the sobrescrita wins', async () => {
    const c = cenario({ codRastreio: `${CODIGO} ` });
    c.p.fila.push((r) => {
      if (r.metodo === 'PUT' && r.caminho === CAMINHO_SITUACAO_LI) c.p.mover(C.pagamentoEmDisputa);
      return null;
    });
    expect(await c.rodar()).toEqual({ kind: 'escrito-com-aviso', motivo: M.situacaoSobrescrita });
    expect(c.aviso()).toMatchObject({
      severidade: SEVERIDADE_AVISO.critico,
      params: { situacao: C.pagamentoEmDisputa },
    });
  });

  it('a 503 or 429 on a PUT ⇒ throw (it may have landed; the retry’s guard GET decides)', async () => {
    for (const status of [503, 429]) {
      const c = cenario();
      c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(status, {})));
      await expect(c.rodar()).rejects.toBeInstanceOf(LiHttpError);
      expect(c.aviso()).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*            One write per run, over the grid, and retries after it          */
/* -------------------------------------------------------------------------- */

describe('PROPERTY: no run sends a PUT after a 2xx PUT', () => {
  const RESPOSTAS: readonly [string, () => Response][] = [
    ['200', () => respostaJson(200, {})],
    ['202', () => respostaJson(202, undefined)],
    ['204', () => new Response(null, { status: 204 })],
    ['400', () => respostaJson(400, {})],
    ['302', () => new Response('', { status: 302, headers: { location: '/x' } })],
    // With the confirming read answering 200: the token still reads.
    ['403', () => respostaJson(403, {})],
  ];
  const RECUSAS = new Set(['400', '302', '403']);

  it('over every codigo × event × the first PUT’s answer × a normal or the last hot pass', async () => {
    // …and, on the same grid, the run's worst case is an UPPER bound measured on
    // the real call and wait sequence (every call at its full deadline): no run
    // is slower than PIOR_EXECUCAO_RASTREIO_LI_MS, no try that throws for a
    // retry is slower than PIOR_TENTATIVA_RECUSADA_RASTREIO_LI_MS, and the grid
    // reaches each bound exactly — so neither constant can drift from the code.
    let maisLenta = 0;
    let maisLentaRecusada = 0;
    for (const codigo of [...codigoSituacaoLiSchema.options, 'Pedido_Pago']) {
      for (const estado of [
        ESTADO_RASTREIO_LI.postado,
        ESTADO_RASTREIO_LI.entregue,
        ESTADO_RASTREIO_LI.aguardandoRetirada,
      ]) {
        for (const passagemFinal of [null, 'quente'] as const) {
          for (const [nome, resposta] of RESPOSTAS) {
            const c = cenario({ codigo, freteEstado: estado, cronometrado: true });
            let primeiro = true;
            c.p.fila.push((r) => {
              if (r.metodo !== 'PUT' || !primeiro) return null;
              primeiro = false;
              return resposta();
            });
            let recusada = false;
            await c.rodar({ estado, passagemFinal }).catch((err: unknown) => {
              if (!(err instanceof EscritaRecusadaLiError)) throw err;
              recusada = true;
            });
            const puts = c.p.requisicoes.filter((r) => r.metodo === 'PUT');
            const rotulo = `${codigo} / ${estado} / ${String(passagemFinal)} / ${nome}`;
            expect(c.decorridoMs(), rotulo).toBeLessThanOrEqual(PIOR_EXECUCAO_RASTREIO_LI_MS);
            maisLenta = Math.max(maisLenta, c.decorridoMs());
            if (recusada) {
              expect(c.decorridoMs(), rotulo).toBeLessThanOrEqual(
                PIOR_TENTATIVA_RECUSADA_RASTREIO_LI_MS,
              );
              maisLentaRecusada = Math.max(maisLentaRecusada, c.decorridoMs());
            }
            // A first PUT that answered 2xx is the run's only one; only a refused
            // tracking code may be followed by ONE situação write.
            if (!RECUSAS.has(nome)) {
              expect(puts.length, rotulo).toBeLessThanOrEqual(1);
            } else if (puts.length === 2) {
              expect(puts[0]?.caminho, rotulo).toBe(CAMINHO_ENVIO_LI);
              expect(puts[1]?.caminho, rotulo).toBe(CAMINHO_SITUACAO_LI);
            } else {
              expect(puts.length, rotulo).toBeLessThanOrEqual(1);
            }
            // A 403 on a try that is not the last hot pass never writes the situação.
            if (nome === '403' && passagemFinal === null) {
              expect(puts.length, rotulo).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
    expect(maisLenta).toBe(PIOR_EXECUCAO_RASTREIO_LI_MS);
    expect(maisLentaRecusada).toBe(PIOR_TENTATIVA_RECUSADA_RASTREIO_LI_MS);
    // A grid of ~1,300 runs: seconds on a fast machine, ~20 s on a CI runner.
  }, 120_000);
});

describe('the worst case of one run, measured (the writes queue sizes its timeout on it)', () => {
  it.each([
    ['refused (400)', () => respostaJson(400, {}), null],
    ['refused 403 on the LAST hot pass', () => respostaJson(403, {}), 'quente'],
  ] as const)(
    'the code %s, then the 11 from the SECOND deciding read, every call at its full deadline ⇒ exactly PIOR_EXECUCAO_RASTREIO_LI_MS',
    async (_caso, resposta, passagemFinal) => {
      const c = cenario({ cronometrado: true });
      c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', resposta));
      expect(await c.rodar({ passagemFinal })).toEqual({
        kind: 'escrito-com-aviso',
        motivo: M.escritaRecusada,
      });
      // The path: 2 + 2 intervals before the two deciding reads, 2 before the
      // read-back of the landed write, 1 before the history read; six calls.
      expect(c.p.eventos).toEqual([
        `espera ${String(RITMO_ESCRITA_LI_MS)}`,
        `espera ${String(RITMO_ESCRITA_LI_MS)}`,
        GET_PEDIDO,
        PUT_ENVIO,
        `espera ${String(RITMO_ESCRITA_LI_MS)}`,
        `espera ${String(RITMO_ESCRITA_LI_MS)}`,
        GET_PEDIDO,
        PUT_SITUACAO,
        `espera ${String(RITMO_ESCRITA_LI_MS)}`,
        `espera ${String(RITMO_ESCRITA_LI_MS)}`,
        GET_PEDIDO,
        `espera ${String(RITMO_ESCRITA_LI_MS)}`,
        GET_HISTORICO,
      ]);
      expect(c.decorridoMs()).toBe(PIOR_EXECUCAO_RASTREIO_LI_MS);
      expect(PIOR_EXECUCAO_RASTREIO_LI_MS).toBe(
        7 * RITMO_ESCRITA_LI_MS + 6 * PRAZO_DE_UMA_CHAMADA_MS,
      );
    },
  );

  it('a try that THROWS for a retry (the code refused 403, the token still reads) ⇒ exactly PIOR_TENTATIVA_RECUSADA_RASTREIO_LI_MS', async () => {
    const c = cenario({ cronometrado: true });
    c.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    await expect(c.rodar()).rejects.toBeInstanceOf(EscritaRecusadaLiError);
    expect(c.p.chamadas()).toEqual([GET_PEDIDO, PUT_ENVIO, GET_PEDIDO]);
    expect(c.decorridoMs()).toBe(PIOR_TENTATIVA_RECUSADA_RASTREIO_LI_MS);
    expect(PIOR_TENTATIVA_RECUSADA_RASTREIO_LI_MS).toBe(
      4 * RITMO_ESCRITA_LI_MS + 3 * PRAZO_DE_UMA_CHAMADA_MS,
    );
    expect(PIOR_TENTATIVA_RECUSADA_RASTREIO_LI_MS).toBeLessThan(PIOR_EXECUCAO_RASTREIO_LI_MS);
  });

  it('a normal posting (the code alone, its read-back, the history read) stays well inside it', async () => {
    const c = cenario({ cronometrado: true });
    expect(await c.rodar()).toEqual({ kind: 'escrito' });
    expect(c.decorridoMs()).toBe(5 * RITMO_ESCRITA_LI_MS + 4 * PRAZO_DE_UMA_CHAMADA_MS);
    expect(c.decorridoMs()).toBeLessThan(PIOR_EXECUCAO_RASTREIO_LI_MS);
  });
});

describe('a retried run after a landed PUT makes ZERO PUTs', () => {
  it('after a code PUT that moved LI to 11', async () => {
    const c = cenario();
    await c.rodar();
    const antes = c.p.puts().length;
    expect(await c.rodar()).toEqual({ kind: 'ja-refletido' });
    expect(c.p.puts()).toHaveLength(antes);
  });

  it('(b) after the read-back’s credential re-read failed in Firestore (gRPC)', async () => {
    const c = cenario();
    c.p.fila.push((r) => {
      if (r.metodo === 'PUT') {
        c.db.falharLeitura(caminhoCredencial(ID), grpc(14, 'unavailable'));
      }
      return null;
    });
    await expect(c.rodar()).rejects.toThrow();
    c.db.falharLeitura(caminhoCredencial(ID), null);
    const antes = c.p.puts().length;
    expect(await c.rodar()).toEqual({ kind: 'ja-refletido' });
    expect(c.p.puts()).toHaveLength(antes);
  });

  it('(c) after the aviso write failed', async () => {
    const c = cenario({ codRastreio: `${CODIGO} ` });
    c.db.falharEscrita(
      caminhoAviso(chaveDoAvisoRastreioLi(ID, PEDIDO_ID)),
      grpc(14, 'unavailable'),
    );
    await expect(c.rodar()).rejects.toThrow();
    expect(c.p.puts()).toHaveLength(1);
    c.db.falharEscrita(caminhoAviso(chaveDoAvisoRastreioLi(ID, PEDIDO_ID)), null);
    expect((await c.rodar()).kind).toBe('recusado');
    expect(c.p.puts()).toHaveLength(1);
  });

  it('(d) after the park of a read-back’s 401 failed', async () => {
    const c = cenario();
    c.p.fila.push(
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(200, c.p.estado.pedido)),
      naProxima(CAMINHO_PEDIDO_LI, 'GET', () => {
        c.db.falharEscrita(caminhoCredencial(ID), grpc(14, 'unavailable'));
        return respostaJson(401, {});
      }),
    );
    await expect(c.rodar()).rejects.toThrow();
    c.db.falharEscrita(caminhoCredencial(ID), null);
    const antes = c.p.puts().length;
    expect(await c.rodar()).toEqual({ kind: 'ja-refletido' });
    expect(c.p.puts()).toHaveLength(antes);
  });
});

/* -------------------------------------------------------------------------- */
/*                 The last pass: tentativas-esgotadas           */
/* -------------------------------------------------------------------------- */

describe('a returned outcome on its parking pass raises tentativas-esgotadas, under `on` only', () => {
  it('`parcial` on the last HOT pass ⇒ the aviso', async () => {
    const c = cenario({ mover: false });
    expect(await c.rodar({ passagemFinal: 'quente' })).toEqual({
      kind: 'parcial',
      efeito: 'efeito-pendente',
    });
    expect(c.aviso()).toMatchObject({ params: { motivo: M.tentativasEsgotadas } });
  });

  it('`parcial` on a non-final pass ⇒ no aviso', async () => {
    const c = cenario({ mover: false });
    await c.rodar();
    expect(c.aviso()).toBeUndefined();
  });

  it('`adiado` on the last DEFERRED pass under `on` ⇒ the aviso; under dry-run ⇒ none', async () => {
    const c = cenario({ ambiente: ambiente(MODO_LI.on, '*', false) });
    expect((await c.rodar({ passagemFinal: 'adiada' })).kind).toBe('adiado');
    expect(c.aviso()).toMatchObject({ params: { motivo: M.tentativasEsgotadas } });

    const d = cenario({ ambiente: ambiente(MODO_LI.dryRun) });
    expect((await d.rodar({ passagemFinal: 'adiada' })).kind).toBe('adiado');
    expect(d.aviso()).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                             The classifier rows                            */
/* -------------------------------------------------------------------------- */

describe('the classifier of a deterministic refusal', () => {
  const ctx = {
    operacao: 'teste',
    caminho: '/v1/pedido/1/',
    refCredencial: 'ref-1',
    correlationId: 'c',
  } as const;

  it.each(['corpo', 'codigo-nao-permitido', 'caminho', 'rota-nao-permitida'] as const)(
    'the package’s own refusal of the input (`LiConfigError` %s) PARKS — it would be refused again',
    (motivo) => {
      expect(
        classificarRecusaEscritaLi(
          new LiConfigError(motivo, { operacao: 'x', refCredencial: null }),
        ),
      ).toEqual({ kind: 'recusa-deterministica', classe: 'LiConfigError', detalhe: motivo });
    },
  );

  it.each(['token', 'ref', 'token-na-url', 'token-no-corpo', 'maxPaginas'] as const)(
    '⚠️ NEAR-MISS: our own misconfiguration (`LiConfigError` %s) stays LOUD ⇒ null (rethrown)',
    (motivo) => {
      expect(
        classificarRecusaEscritaLi(
          new LiConfigError(motivo, { operacao: 'x', refCredencial: null }),
        ),
      ).toBeNull();
    },
  );

  it('a body off its schema and a Zod failure park; a non-transient HTTP refusal parks with its status', () => {
    expect(
      classificarRecusaEscritaLi(
        new LiSchemaError({ ...ctx, status: 200, motivo: 'formato', campos: ['numero'] }),
      ),
    ).toEqual({ kind: 'recusa-deterministica', classe: 'LiSchemaError', detalhe: '200' });
    expect(classificarRecusaEscritaLi(new ZodError([]))).toEqual({
      kind: 'recusa-deterministica',
      classe: 'ZodError',
      detalhe: null,
    });
    expect(classificarRecusaEscritaLi(new LiHttpError({ ...ctx, status: 400 }))).toEqual({
      kind: 'recusa-deterministica',
      classe: 'LiHttpError',
      detalhe: '400',
    });
  });

  it('transient and unknown errors ⇒ null (rethrown)', () => {
    expect(classificarRecusaEscritaLi(new LiHttpError({ ...ctx, status: 503 }))).toBeNull();
    expect(classificarRecusaEscritaLi(grpc(14, 'x'))).toBeNull();
    expect(classificarRecusaEscritaLi(new TypeError('x'))).toBeNull();
    expect(classificarRecusaEscritaLi(new LiContaParadaError(ID, 401, 1))).toBeNull();
  });

  it('a guard read whose body is off the schema ⇒ park with ONE ERROR line (ids and the class)', async () => {
    const c = cenario();
    c.p.fila.push(naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(200, { numero: 'x' })));
    expect(await c.rodar()).toMatchObject({
      kind: 'recusa-deterministica',
      classe: 'LiSchemaError',
    });
    expect(c.erros).toHaveLength(1);
    expect(JSON.stringify(c.erros)).not.toContain('Comprador');
  });

  it('the conta gone ⇒ conta-inexistente (drop); inactive ⇒ adiado', async () => {
    const c = cenario();
    c.db.seed(`integracao/${ID}`, { tipo: 99, nome: 'x', ativo: true });
    __resetAllReadCaches();
    expect(await c.rodar()).toEqual({ kind: 'conta-inexistente' });
    const d = cenario();
    seedConta(d.db, ID, { ativo: false });
    __resetAllReadCaches();
    expect(await d.rodar()).toEqual({ kind: 'adiado', motivo: 'conta-inativa', recusa: null });
  });

  it('the aviso tipo is the write-back’s', async () => {
    const c = cenario({ codigo: C.pedidoCancelado });
    await c.rodar();
    expect(c.aviso()?.tipo).toBe(TIPO_AVISO.lojaIntegradaRastreioDivergente);
    expect(ID_ENVIO_LI).toBeGreaterThan(0);
  });
});
