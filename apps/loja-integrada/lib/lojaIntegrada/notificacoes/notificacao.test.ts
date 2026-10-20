/**
 * The Loja Integrada notification pipeline, offline, through the REAL shared
 * core (`@delfrance/data/admin/notifications`), the real context loader, the
 * real park and the real `escreverAviso`, against the fake Firestore. The
 * importer is a fake; the network is forbidden (`fetchProibido`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import type { ViaCepClient } from '@delfrance/core/cep';
import { notificacaoLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { MAX_TENTATIVAS, MAX_TENTATIVAS_DEFERRED } from '@delfrance/data/admin/notifications';
import {
  type ContextoRequisicaoLi,
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
import { ORIGEM_NOTIFICACAO_LI, TIPO_AVISO, TIPO_TAREFA_LI } from '@delfrance/schemas';

import { chaveReconexao } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from '../core/contexto';
import { refDaCredencial } from '../core/credencial';
import { lerCredencial, removerCredencial, salvarCredencial } from '../core/credentialStore';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from '../core/erros';
import { chaveDoAvisoDoPedidoLi } from '../pedidos/avisosPedidoLi';
import { LiPedidoEmConflitoError } from '../pedidos/escritaPedido';
import { LiHistoricoIncompletoError } from '../pedidos/importarPedido';
import { LiPedidoPagoSemEnderecoError } from '../pedidos/pedidoPagoSemEndereco';
import { type DocData, FakeDb, arrayUnion, asDb, grpc, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  TOKEN_B,
  caminhoAviso,
  caminhoCredencial,
  gravadorDeLog,
  loggerEspiao,
  ritmoFalso,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import {
  DESTINO_TIPO_LI,
  FILA_LEITURA_LI,
  type DepsImportadorLi,
  type DepsTarefaLi,
  type ImportadorPedidoLi,
  CONCORRENCIA_REDRIVE_LI,
  LIMITE_REDRIVE_LI,
  MOTIVO_ADIAMENTO_LI,
  type PayloadNotificacaoLi,
  type ResultadoNotificacaoLi,
  camposDoRegistroDaTarefaLi,
  classificarFalhaLi,
  dedupKeyLi,
  depsDoImportadorLi,
  docIdNotificacaoLi,
  importadorPedidoLi,
  persistirFalhaNotificacaoLi,
  processarNotificacaoLi,
  redriveAposSalvarTokenLi,
  redrivePedidosAdiadosDaConta,
  reprocessarAdiadasLi,
  reprocessarNotificacoesLi,
  tarefaLeituraLiSchema,
  toDispositionLi,
  tratarTarefaLeituraLi,
} from './notificacao';

const ID = 'conta-li-1';
const OUTRA = 'conta-li-2';
const COLECAO = 'notificacoesLojaIntegrada';
const STAMP = '2026-10-13T08:15:58.123456';

/** The id grammar the plan pins (step-3 plan §4), written out here on purpose. */
const ID_PINADO = /^[A-Za-z0-9_-]{1,128}:[1-9][0-9]{0,15}:(poll|webhook):([0-9]{20}|-)$/;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

function pedido(over: Partial<PayloadNotificacaoLi> = {}): PayloadNotificacaoLi {
  return {
    tipo: TIPO_TAREFA_LI.pedido,
    contaId: ID,
    numero: '1234',
    origem: ORIGEM_NOTIFICACAO_LI.poll,
    dataModificacaoLi: STAMP,
    ...over,
  };
}

function caminhoDe(p: PayloadNotificacaoLi): string {
  return `${COLECAO}/${docIdNotificacaoLi(p)}`;
}

/** Every `fetch` a test makes is a failure: D17, and no test touches the network. */
const chamadasDeRede: string[] = [];
const fetchProibido: typeof globalThis.fetch = (input) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
};
afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** The importer's CEP recovery: no test of the pipeline reaches it, and a call fails it. */
const viaCepProibido: ViaCepClient = {
  buscarCep: (cep) => {
    chamadasDeRede.push(`viacep:${cep}`);
    return Promise.reject(new Error('teste: nenhuma consulta de CEP é permitida'));
  },
};

function depsTarefa(over: Partial<DepsTarefaLi> = {}): DepsTarefaLi {
  return {
    ambiente: AMBIENTE_LIGADO,
    importador: null,
    increment,
    arrayUnion,
    viaCep: viaCepProibido,
    agoraMs: () => AGORA_MS,
    esperar: () => Promise.resolve(),
    logger: loggerEspiao().logger,
    registro: {
      fluxo: 'intake',
      tentativa: 0,
      idTarefa: 't-1',
      escrever: gravadorDeLog().escrever,
    },
    fetch: fetchProibido,
    ...over,
  };
}

const importa: ImportadorPedidoLi = () => Promise.resolve({ kind: 'importado' });
const falhaCom =
  (err: unknown): ImportadorPedidoLi =>
  () =>
    Promise.reject(err);

const REQ: ContextoRequisicaoLi = {
  operacao: 'buscarPedido',
  caminho: '/v1/pedido/1234',
  correlationId: 'c-1',
  refCredencial: 'ref.1',
};
const http = (status: number) => new LiHttpError({ ...REQ, status });
const throttle = () =>
  new LiThrottleError({
    ...REQ,
    status: 429,
    escopo: 'loja',
    codigosEncontrados: [],
    retryAfterS: null,
  });

/** A healthy conta: active, with a valid, unparked credential. */
function contaSaudavel(db: FakeDb, id = ID): void {
  seedConta(db, id);
  seedCredencial(db, id);
}

/** A conta whose credential is parked (a 401 refused it). */
function contaParada(db: FakeDb, id = ID): void {
  seedConta(db, id);
  seedCredencial(db, id, {
    reconexaoPendente: { desdeMs: AGORA_MS - 10, status: 401, refCredencial: 'a.1' },
  });
}

/** A failure document as the shared store leaves it. */
function seedNotificacao(db: FakeDb, p: PayloadNotificacaoLi, over: DocData = {}): string {
  const caminho = caminhoDe(p);
  db.seed(caminho, {
    tipo: p.tipo,
    contaId: p.contaId,
    numero: p.numero,
    origem: p.origem,
    dataModificacaoLi: p.dataModificacaoLi,
    status: 'failed',
    tentativas: 0,
    erro: null,
    processedAt: 0,
    ...over,
  });
  return caminho;
}

/** The stored ref of the conta's credential — what a 401 for the CURRENT token carries. */
async function refAtual(db: FakeDb, id = ID): Promise<string> {
  const lida = await lerCredencial(asDb(db), id);
  if (lida === null) throw new Error('fixture: sem credencial');
  return refDaCredencial(lida.credencial);
}

/* -------------------------------------------------------------------------- */

describe('the queue and the importer seam', () => {
  it('the reads queue is named for its function, and the seam is EMPTY in step 3', () => {
    expect(FILA_LEITURA_LI).toBe('filaLeituraLojaIntegrada');
    expect(DESTINO_TIPO_LI).toEqual({ pedido: null });
    expect(importadorPedidoLi()).toBeNull();
  });
});

describe('the doc id — built from validated parts', () => {
  it('one stamp gives one id, and every id matches the pinned grammar', () => {
    const id = docIdNotificacaoLi(pedido());
    expect(id).toBe(`${ID}:1234:poll:20261013081558123456`);
    expect(docIdNotificacaoLi(pedido())).toBe(id);
    expect(id).toMatch(ID_PINADO);
    for (const p of [
      pedido({ dataModificacaoLi: null }),
      pedido({ origem: ORIGEM_NOTIFICACAO_LI.webhook }),
      pedido({ contaId: 'A'.repeat(128), numero: '9007199254740991' }),
      pedido({ contaId: 'a_b-C9', numero: '1' }),
    ]) {
      expect(docIdNotificacaoLi(p)).toMatch(ID_PINADO);
    }
  });

  it('near-miss: stamps 1 µs apart give two ids; poll and webhook with one stamp give two', () => {
    const a = docIdNotificacaoLi(pedido({ dataModificacaoLi: '2026-10-13T08:15:58.123456' }));
    const b = docIdNotificacaoLi(pedido({ dataModificacaoLi: '2026-10-13T08:15:58.123457' }));
    expect(a).not.toBe(b);
    expect(docIdNotificacaoLi(pedido({ origem: ORIGEM_NOTIFICACAO_LI.webhook }))).not.toBe(
      docIdNotificacaoLi(pedido({ origem: ORIGEM_NOTIFICACAO_LI.poll })),
    );
  });

  it('a null stamp is the `-` segment', () => {
    expect(docIdNotificacaoLi(pedido({ dataModificacaoLi: null }))).toBe(`${ID}:1234:poll:-`);
  });

  it('a payload the task schema refuses is never turned into an id (a nested path)', () => {
    const forjado = { ...pedido(), contaId: 'a/b' };
    expect(() => docIdNotificacaoLi(forjado)).toThrow(TypeError);
    expect(() => docIdNotificacaoLi({ ...pedido(), numero: '01' })).toThrow(TypeError);
  });

  it('the task schema strips unknown keys and refuses a malformed id part', () => {
    const parsed = tarefaLeituraLiSchema.parse({ ...pedido(), extra: { cpf: '000' } });
    expect(Object.keys(parsed).sort()).toEqual(
      ['contaId', 'dataModificacaoLi', 'numero', 'origem', 'tipo'].sort(),
    );
    expect(tarefaLeituraLiSchema.safeParse({ ...pedido(), contaId: '..' }).success).toBe(false);
  });
});

describe('the dedup key — the ORDER, whatever stamp or origin', () => {
  it('equal across stamps and origins', () => {
    expect(dedupKeyLi(pedido({ dataModificacaoLi: null }))).toBe(dedupKeyLi(pedido()));
    expect(dedupKeyLi(pedido({ origem: ORIGEM_NOTIFICACAO_LI.webhook }))).toBe(
      dedupKeyLi(pedido()),
    );
  });

  it('near-miss: c1:123, c1:1234 and c2:123 are three orders', () => {
    const chaves = new Set([
      dedupKeyLi(pedido({ contaId: 'c1', numero: '123' })),
      dedupKeyLi(pedido({ contaId: 'c1', numero: '1234' })),
      dedupKeyLi(pedido({ contaId: 'c2', numero: '123' })),
    ]);
    expect(chaves.size).toBe(3);
  });

  it('near-miss: the conta/numero boundary is kept — c1 + 123 and c11 + 23 are two orders', () => {
    // A conta id may end in a digit and a numero starts with one, so a key
    // that joined the two without a separator would fold these into one order
    // and the sweep would skip the second.
    expect(dedupKeyLi(pedido({ contaId: 'c1', numero: '123' }))).not.toBe(
      dedupKeyLi(pedido({ contaId: 'c11', numero: '23' })),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('toDispositionLi — total, phase-independent', () => {
  const casos: readonly [ResultadoNotificacaoLi, ReturnType<typeof toDispositionLi>][] = [
    [{ kind: 'importado' }, { kind: 'resolve', label: 'importado' }],
    // The step-5 importer's other successes: each resolves, labelled by its kind.
    [{ kind: 'sem-mudanca' }, { kind: 'resolve', label: 'sem-mudanca' }],
    [{ kind: 'obsoleto' }, { kind: 'resolve', label: 'obsoleto' }],
    [{ kind: 'hub' }, { kind: 'resolve', label: 'hub' }],
    [{ kind: 'situacao-desconhecida' }, { kind: 'resolve', label: 'situacao-desconhecida' }],
    [
      { kind: 'conta-inexistente' },
      { kind: 'drop', reason: 'conta-inexistente', label: 'conta-inexistente' },
    ],
    [
      { kind: 'adiado', motivo: MOTIVO_ADIAMENTO_LI.contaParada },
      { kind: 'defer', reason: 'adiado/conta-parada' },
    ],
    [
      { kind: 'adiado', motivo: MOTIVO_ADIAMENTO_LI.chamadasDesligadas },
      { kind: 'defer', reason: 'adiado/chamadas-desligadas' },
    ],
    [{ kind: 'pedido-inexistente' }, { kind: 'park', reason: 'pedido-inexistente' }],
    [
      { kind: 'recusa-deterministica', classe: 'LiHttpError', status: 400 },
      { kind: 'park', reason: 'recusa-deterministica/LiHttpError/400' },
    ],
    [
      { kind: 'recusa-deterministica', classe: 'ZodError', status: null },
      { kind: 'park', reason: 'recusa-deterministica/ZodError' },
    ],
    [{ kind: 'importador-ausente' }, { kind: 'park', reason: 'importador-ausente' }],
  ];

  it.each(casos)('%o → %o', (resultado, esperado) => {
    expect(toDispositionLi(resultado)).toEqual(esperado);
  });

  it('has no `default` arm — a kind step 5 adds must fail to compile until it is mapped', () => {
    // CRLF-safe: a Windows checkout may hold the source with `\r\n`.
    const fonte = readFileSync(
      fileURLToPath(new URL('./notificacao.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const inicio = fonte.indexOf('export function toDispositionLi(');
    const fim = fonte.indexOf('\n}\n', inicio);
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const corpo = fonte.slice(inicio, fim);
    // Anti-vacuity: the slice is the switch over every kind.
    expect(corpo).toContain("case 'importador-ausente':");
    expect(corpo).not.toMatch(/\bdefault\s*:/);
  });

  it('every adiamento motivo DEFERS — a parked conta never drops (#808)', () => {
    for (const motivo of Object.values(MOTIVO_ADIAMENTO_LI)) {
      expect(toDispositionLi({ kind: 'adiado', motivo }).kind, motivo).toBe('defer');
    }
  });
});

describe('the importer’s deps — bound from the run’s own', () => {
  it('the same clock and sentinels, the CEP client, and the attempt off `registro`', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    let recebidos: DepsImportadorLi | null = null;
    const importador: ImportadorPedidoLi = (_db, _ctx, _p, deps) => {
      recebidos = deps;
      return Promise.resolve({ kind: 'sem-mudanca' });
    };
    const base = depsTarefa({ importador });
    const r = await processarNotificacaoLi(asDb(db), pedido(), {
      ...base,
      registro: { ...base.registro, tentativa: 2 },
    });
    expect(r).toEqual({ kind: 'sem-mudanca' });
    expect(recebidos).toEqual({
      agoraMs: base.agoraMs,
      arrayUnion: base.arrayUnion,
      increment: base.increment,
      logger: base.logger,
      viaCep: base.viaCep,
      tentativa: 2,
    });
  });

  it('a sweep run carries no attempt: `tentativa` is null (the history is read degraded)', () => {
    const base = depsTarefa();
    expect(depsDoImportadorLi({ ...base, registro: { fluxo: 'intake' } }).tentativa).toBeNull();
    expect(depsDoImportadorLi({ ...base, registro: { tentativa: 0 } }).tentativa).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('classificarFalhaLi — the table, in order', () => {
  async function contexto(db: FakeDb): Promise<ContextoLojaIntegrada> {
    return loadLojaIntegradaContext(asDb(db), ID, {
      ambiente: AMBIENTE_LIGADO,
      ritmo: ritmoFalso().ritmo,
      fetch: fetchProibido,
      registro: { escrever: gravadorDeLog().escrever },
    });
  }

  async function classificar(err: unknown, db = new FakeDb()) {
    const ctx = db.ler(`integracao/${ID}`) === undefined ? null : await contexto(db);
    return classificarFalhaLi(asDb(db), err, ctx, depsTarefa());
  }

  it('the context refusals map to their outcomes', async () => {
    expect(await classificar(new LiChamadasDesligadasError(ID))).toEqual({
      kind: 'adiado',
      motivo: 'chamadas-desligadas',
    });
    expect(await classificar(new LiContaNaoEncontradaError(ID))).toEqual({
      kind: 'conta-inexistente',
    });
    for (const [err, motivo] of [
      [new LiContaInativaError(ID), 'conta-inativa'],
      [new LiCredencialAusenteError(ID), 'credencial-ausente'],
      [new LiCredencialInvalidaError(ID, ['x']), 'credencial-invalida'],
      [new LiContaParadaError(ID, 401, 1), 'conta-parada'],
    ] as const) {
      expect(await classificar(err), err.name).toEqual({ kind: 'adiado', motivo });
    }
  });

  it('LiAuthError is NEVER a deterministic refusal — 401 and 403 park the conta', async () => {
    for (const status of [401, 403]) {
      __resetAllReadCaches();
      const db = new FakeDb();
      contaSaudavel(db);
      const err = new LiAuthError({ ...REQ, status, refCredencial: await refAtual(db) });
      const r = await classificar(err, db);
      expect(r, String(status)).toEqual({ kind: 'adiado', motivo: 'conta-parada' });
    }
  });

  it('a 404 parks the notification; a 400 is a deterministic refusal (class and status only)', async () => {
    expect(await classificar(new LiNotFoundError({ ...REQ, status: 404 }))).toEqual({
      kind: 'pedido-inexistente',
    });
    expect(await classificar(http(400))).toEqual({
      kind: 'recusa-deterministica',
      classe: 'LiHttpError',
      status: 400,
    });
    expect(
      await classificar(new LiSchemaError({ ...REQ, status: 200, motivo: 'formato', campos: [] })),
    ).toEqual({ kind: 'recusa-deterministica', classe: 'LiSchemaError', status: 200 });
    expect(
      await classificar(new LiPaginacaoError({ ...REQ, motivo: 'limite-de-paginas', paginas: 3 })),
    ).toEqual({ kind: 'recusa-deterministica', classe: 'LiPaginacaoError', status: null });
    expect(await classificar(new ZodError([]))).toEqual({
      kind: 'recusa-deterministica',
      classe: 'ZodError',
      status: null,
    });
  });

  it('503, 429, a timeout and a network failure are transient: null (the caller rethrows)', async () => {
    for (const err of [
      http(503),
      http(520),
      throttle(),
      new LiTimeoutError({ ...REQ, prazoMs: 20_000 }, new Error('abortado')),
      new LiNetworkError(REQ, new TypeError('fetch failed')),
    ]) {
      expect(await classificar(err), err.name).toBeNull();
    }
  });

  it('the importer’s three retry errors — persistent batch contention, a history hole in strict mode, a paid order without an address — are null: the task retries, never parks', async () => {
    for (const err of [
      new LiPedidoEmConflitoError('pedido-x', 3),
      new LiHistoricoIncompletoError(ID, 1, ['codigo-ausente']),
      new LiPedidoPagoSemEnderecoError({
        integracaoId: ID,
        lojaNome: 'Loja',
        pedidoId: 'pedido-x',
        numero: '1234',
        relogioUs: 1,
      }),
    ]) {
      expect(await classificar(err), err.name).toBeNull();
    }
  });

  it('our own misconfiguration, the park contention, gRPC, an unknown Error and a non-Error: null', async () => {
    for (const err of [
      new LiConfigError('caminho', { operacao: 'x', refCredencial: null }),
      new LiEstacionamentoEmConflitoError(ID, 3),
      grpc(14, 'UNAVAILABLE'),
      new Error('desconhecido'),
      'uma string',
      undefined,
    ]) {
      expect(await classificar(err), String(err)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('LiAuthError, three ways — through one run', () => {
  it('estacionado: the conta is PARKED, the reconexão aviso raised, the notification deferred', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    const ref = await refAtual(db);
    const r = await processarNotificacaoLi(
      asDb(db),
      pedido(),
      depsTarefa({
        importador: falhaCom(new LiAuthError({ ...REQ, status: 401, refCredencial: ref })),
      }),
    );
    expect(r).toEqual({ kind: 'adiado', motivo: 'conta-parada' });
    expect(db.ler(caminhoCredencial(ID))?.reconexaoPendente).toMatchObject({
      status: 401,
      refCredencial: ref,
    });
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      tipo: 'lojaIntegradaReconexaoPendente',
      resolvidoEm: null,
    });
  });

  it('credencial-substituida: the 401 was for an OLDER token — rethrown, nothing parked', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    const antiga = new LiAuthError({ ...REQ, status: 401, refCredencial: '0000000000000000.1' });
    const err: unknown = await processarNotificacaoLi(
      asDb(db),
      pedido(),
      depsTarefa({ importador: falhaCom(antiga) }),
    ).catch((e: unknown) => e);
    expect(err).toBe(antiga);
    expect(db.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
  });

  it('sem-credencial: the token was removed meanwhile — deferred as credencial-ausente', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    const ref = await refAtual(db);
    const importador: ImportadorPedidoLi = async () => {
      await removerCredencial(asDb(db), ID);
      throw new LiAuthError({ ...REQ, status: 401, refCredencial: ref });
    };
    const r = await processarNotificacaoLi(asDb(db), pedido(), depsTarefa({ importador }));
    expect(r).toEqual({ kind: 'adiado', motivo: 'credencial-ausente' });
  });

  it('a credential found corrupt while parking defers as credencial-invalida', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    const ref = await refAtual(db);
    const importador: ImportadorPedidoLi = () => {
      db.seed(caminhoCredencial(ID), { personalToken: 'x' });
      return Promise.reject(new LiAuthError({ ...REQ, status: 401, refCredencial: ref }));
    };
    const r = await processarNotificacaoLi(asDb(db), pedido(), depsTarefa({ importador }));
    expect(r).toEqual({ kind: 'adiado', motivo: 'credencial-invalida' });
  });

  it('the getter refuses a conta parked MID-import: deferred, and nothing is sent', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    const esperas: number[] = [];
    const importador: ImportadorPedidoLi = async (_db, ctx) => {
      contaParadaNoMeio(db);
      await ctx.cliente.get({
        operacao: 'buscarPedido',
        caminho: '/v1/pedido/1234',
        schema: z.unknown(),
      });
      return { kind: 'importado' };
    };
    const r = await processarNotificacaoLi(
      asDb(db),
      pedido(),
      depsTarefa({
        importador,
        esperar: (ms) => {
          esperas.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(r).toEqual({ kind: 'adiado', motivo: 'conta-parada' });
    // The pacer ran before the credential re-read refused the call.
    expect(esperas).toEqual([2_000]);
  });
});

function contaParadaNoMeio(db: FakeDb): void {
  db.seed(caminhoCredencial(ID), {
    ...db.ler(caminhoCredencial(ID)),
    reconexaoPendente: { desdeMs: AGORA_MS, status: 403, refCredencial: 'a.1' },
  });
}

/* -------------------------------------------------------------------------- */

describe('the read switch — checked FIRST', () => {
  it("'on' passes: the conta is read (and, with no importer, the run parks)", async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    const r = await processarNotificacaoLi(asDb(db), pedido(), depsTarefa());
    expect(r).toEqual({ kind: 'importador-ausente' });
    expect(db.leituras).toContain(caminhoCredencial(ID));
  });

  it.each([
    ['on␠', 'on '],
    ['ON', 'ON'],
    ['true', 'true'],
    ['blank', ''],
    ['unset', undefined],
  ] as const)('%s → deferred with ZERO Firestore operations', async (_nome, valor) => {
    const db = new FakeDb();
    contaSaudavel(db);
    const r = await processarNotificacaoLi(
      asDb(db),
      pedido(),
      depsTarefa({
        ambiente: valor === undefined ? {} : { LOJA_INTEGRADA_CHAMADAS: valor },
        importador: importa,
      }),
    );
    expect(r).toEqual({ kind: 'adiado', motivo: 'chamadas-desligadas' });
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(db.escritas).toEqual([]);
  });

  it('the task with the switch off writes ONE deferred document and reads nothing', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    const r = await tratarTarefaLeituraLi(asDb(db), pedido(), 0, depsTarefa({ ambiente: {} }));
    expect(r).toEqual({ outcome: 'deferred', kind: 'adiado', detail: null });
    expect(db.leituras).toEqual([]);
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([['create', caminhoDe(pedido())]]);
    expect(db.ler(caminhoDe(pedido()))).toMatchObject({
      status: 'deferred',
      tentativas: 0,
      erro: 'adiado/chamadas-desligadas',
    });
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The full disposition matrix: each outcome, produced by a real world (a conta,
 * a credential, a fake importer), through the task and both sweeps.
 */
interface Cenario {
  readonly nome: string;
  readonly preparar: (db: FakeDb) => Partial<DepsTarefaLi>;
  readonly tarefa: { readonly outcome: string; readonly doc: DocData | null };
  readonly quente: DocData | null;
  readonly adiada: DocData | null;
}

const CENARIOS: readonly Cenario[] = [
  {
    nome: 'importado',
    preparar: (db) => {
      contaSaudavel(db);
      return { importador: importa };
    },
    tarefa: { outcome: 'done', doc: null },
    quente: null,
    adiada: null,
  },
  {
    nome: 'conta-inexistente',
    preparar: () => ({ importador: importa }),
    tarefa: { outcome: 'dropped', doc: null },
    quente: null,
    adiada: null,
  },
  {
    nome: 'adiado (conta parada)',
    preparar: (db) => {
      contaParada(db);
      return { importador: importa };
    },
    tarefa: { outcome: 'deferred', doc: { status: 'deferred', tentativas: 0 } },
    // The hot lane MIGRATES it to the slow one with a fresh horizon.
    quente: { status: 'deferred', tentativas: 0, erro: 'adiado/conta-parada' },
    adiada: { status: 'deferred', tentativas: 3, erro: 'adiado/conta-parada' },
  },
  {
    nome: 'pedido-inexistente',
    preparar: (db) => {
      contaSaudavel(db);
      return { importador: falhaCom(new LiNotFoundError({ ...REQ, status: 404 })) };
    },
    tarefa: { outcome: 'parked', doc: { status: 'parked', erro: 'pedido-inexistente' } },
    quente: { status: 'parked', tentativas: 3, erro: 'pedido-inexistente' },
    adiada: { status: 'parked', tentativas: 3, erro: 'pedido-inexistente' },
  },
  {
    nome: 'recusa-deterministica',
    preparar: (db) => {
      contaSaudavel(db);
      return { importador: falhaCom(http(400)) };
    },
    tarefa: {
      outcome: 'parked',
      doc: { status: 'parked', erro: 'recusa-deterministica/LiHttpError/400' },
    },
    quente: { status: 'parked', tentativas: 3, erro: 'recusa-deterministica/LiHttpError/400' },
    adiada: { status: 'parked', tentativas: 3, erro: 'recusa-deterministica/LiHttpError/400' },
  },
  {
    nome: 'importador-ausente',
    preparar: (db) => {
      contaSaudavel(db);
      return { importador: null };
    },
    tarefa: { outcome: 'parked', doc: { status: 'parked', erro: 'importador-ausente' } },
    quente: { status: 'parked', tentativas: 3, erro: 'importador-ausente' },
    adiada: { status: 'parked', tentativas: 3, erro: 'importador-ausente' },
  },
];

describe('the full disposition matrix', () => {
  describe.each(CENARIOS)('$nome', (c) => {
    it('in the task', async () => {
      const db = new FakeDb();
      const deps = depsTarefa(c.preparar(db));
      const r = await tratarTarefaLeituraLi(asDb(db), pedido(), 0, deps);
      expect(r.outcome).toBe(c.tarefa.outcome);
      const doc = db.ler(caminhoDe(pedido()));
      if (c.tarefa.doc === null) expect(doc).toBeUndefined();
      else expect(doc).toMatchObject(c.tarefa.doc);
    });

    it('in the HOT sweep', async () => {
      const db = new FakeDb();
      const deps = depsTarefa(c.preparar(db));
      const caminho = seedNotificacao(db, pedido(), { status: 'failed', tentativas: 2 });
      const s = await reprocessarNotificacoesLi(asDb(db), {}, deps);
      expect(s.processed).toBe(1);
      expect(s.errors).toEqual([]);
      const doc = db.ler(caminho);
      if (c.quente === null) expect(doc).toBeUndefined();
      else expect(doc).toMatchObject(c.quente);
    });

    it('in the DEFERRED sweep', async () => {
      const db = new FakeDb();
      const deps = depsTarefa(c.preparar(db));
      const caminho = seedNotificacao(db, pedido(), { status: 'deferred', tentativas: 2 });
      const s = await reprocessarAdiadasLi(asDb(db), {}, deps);
      expect(s.processed).toBe(1);
      expect(s.errors).toEqual([]);
      const doc = db.ler(caminho);
      if (c.adiada === null) expect(doc).toBeUndefined();
      else expect(doc).toMatchObject(c.adiada);
    });
  });

  describe('a TRANSIENT failure (429)', () => {
    const deps = () => depsTarefa({ importador: falhaCom(throttle()) });

    it('in the task: rethrown for the queue until the last attempt, then persisted failed', async () => {
      const db = new FakeDb();
      contaSaudavel(db);
      await expect(tratarTarefaLeituraLi(asDb(db), pedido(), 0, deps())).rejects.toBeInstanceOf(
        LiThrottleError,
      );
      expect(db.ler(caminhoDe(pedido()))).toBeUndefined();
      const r = await tratarTarefaLeituraLi(asDb(db), pedido(), 2, deps());
      expect(r).toEqual({ outcome: 'failed', kind: null, detail: null });
      expect(db.ler(caminhoDe(pedido()))).toMatchObject({ status: 'failed', tentativas: 0 });
    });

    it('in the HOT sweep: stays failed with one more attempt, parks at the cap', async () => {
      const db = new FakeDb();
      contaSaudavel(db);
      const caminho = seedNotificacao(db, pedido(), { tentativas: 1 });
      const s = await reprocessarNotificacoesLi(asDb(db), {}, deps());
      expect(s.errors).toHaveLength(1);
      expect(db.ler(caminho)).toMatchObject({ status: 'failed', tentativas: 2 });
      db.seed(caminho, { ...db.ler(caminho), tentativas: MAX_TENTATIVAS - 1, processedAt: 0 });
      await reprocessarNotificacoesLi(asDb(db), {}, deps());
      expect(db.ler(caminho)).toMatchObject({ status: 'parked', tentativas: MAX_TENTATIVAS });
    });
  });

  describe('a PAID order without an address (the importer’s retryable refusal)', () => {
    const PEDIDO = {
      integracaoId: ID,
      lojaNome: 'Loja de Nome Sensível',
      pedidoId: 'pedido-sem-endereco',
      numero: '1234',
      relogioUs: 7_000,
    };
    const caminhoAviso = `avisos/${chaveDoAvisoDoPedidoLi(
      TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
      ID,
      PEDIDO.pedidoId,
    )}`;
    function comErros(erros: unknown[][], err: unknown) {
      return depsTarefa({
        importador: falhaCom(err),
        logger: {
          warn: () => undefined,
          error: (msg, meta) => {
            erros.push([msg, meta]);
          },
        },
      });
    }

    it('in the task: rethrown for the queue, persisted failed on the last attempt — no aviso yet', async () => {
      const db = new FakeDb();
      contaSaudavel(db);
      const erros: unknown[][] = [];
      const err = new LiPedidoPagoSemEnderecoError(PEDIDO);
      await expect(tratarTarefaLeituraLi(asDb(db), pedido(), 0, comErros(erros, err))).rejects.toBe(
        err,
      );
      const r = await tratarTarefaLeituraLi(asDb(db), pedido(), 2, comErros(erros, err));
      expect(r.outcome).toBe('failed');
      expect(db.ler(caminhoDe(pedido()))).toMatchObject({ status: 'failed', tentativas: 0 });
      expect(erros).toEqual([]);
      expect(db.ler(caminhoAviso)).toBeUndefined();
    });

    it('in the HOT sweep: failed below the cap; AT the cap parked, ONE ERROR line with ids only, the open aviso', async () => {
      const db = new FakeDb();
      contaSaudavel(db);
      const erros: unknown[][] = [];
      const err = new LiPedidoPagoSemEnderecoError(PEDIDO);
      const caminho = seedNotificacao(db, pedido(), { tentativas: MAX_TENTATIVAS - 2 });
      await reprocessarNotificacoesLi(asDb(db), {}, comErros(erros, err));
      expect(db.ler(caminho)).toMatchObject({ status: 'failed', tentativas: MAX_TENTATIVAS - 1 });
      expect(erros).toEqual([]);
      expect(db.ler(caminhoAviso)).toBeUndefined();

      db.seed(caminho, { ...db.ler(caminho), processedAt: 0 });
      const s = await reprocessarNotificacoesLi(asDb(db), {}, comErros(erros, err));
      expect(db.ler(caminho)).toMatchObject({ status: 'parked', tentativas: MAX_TENTATIVAS });
      expect(s.errors.map((e) => e.docId)).toEqual([docIdNotificacaoLi(pedido())]);
      expect(erros).toHaveLength(1);
      expect(erros[0]![1]).toEqual({ integracaoId: ID, numero: '1234', pedidoId: PEDIDO.pedidoId });
      expect(JSON.stringify(erros)).not.toContain(PEDIDO.lojaNome);
      expect(db.ler(caminhoAviso)).toMatchObject({
        tipo: TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
        params: { loja: PEDIDO.lojaNome, pedido: '1234' },
        relogioEvento: 7_000,
        resolvidoEm: null,
      });
    });

    it('NEAR-MISS: another transient error parked at the same cap — ONE generic ERROR line (ids and the class only), no aviso', async () => {
      const db = new FakeDb();
      contaSaudavel(db);
      const erros: unknown[][] = [];
      const caminho = seedNotificacao(db, pedido(), { tentativas: MAX_TENTATIVAS - 1 });
      await reprocessarNotificacoesLi(asDb(db), {}, comErros(erros, throttle()));
      expect(db.ler(caminho)).toMatchObject({ status: 'parked' });
      expect(erros).toHaveLength(1);
      expect(String(erros[0]![0])).toContain('estacionada');
      expect(erros[0]![1]).toEqual({
        integracaoId: pedido().contaId,
        numero: pedido().numero,
        origem: pedido().origem,
        classe: 'LiThrottleError',
      });
      expect(db.ler(caminhoAviso)).toBeUndefined();
    });

    it('⚠️ NEAR-MISS: a row that no longer REHYDRATES parks at the same cap with NO ERROR line — only its document id in the sweep’s errors', async () => {
      // The core signals a throw from `process` only; the strict `fromDoc` throws first,
      // so the importer never runs and nothing is handed to `sinalizarEsgotamentoLi`.
      const db = new FakeDb();
      contaSaudavel(db);
      const erros: unknown[][] = [];
      const caminho = seedNotificacao(db, pedido(), {
        tentativas: MAX_TENTATIVAS - 1,
        origem: 'desconhecida',
      });
      const s = await reprocessarNotificacoesLi(asDb(db), {}, comErros(erros, throttle()));
      expect(db.ler(caminho)).toMatchObject({ status: 'parked', tentativas: MAX_TENTATIVAS });
      expect(s.errors.map((e) => e.docId)).toEqual([docIdNotificacaoLi(pedido())]);
      expect(erros).toEqual([]);
      expect(db.ler(caminhoAviso)).toBeUndefined();
    });

    it('NEAR-MISS: below the cap a transient failure stays silent — the generic line is the PARK’s alone', async () => {
      const db = new FakeDb();
      contaSaudavel(db);
      const erros: unknown[][] = [];
      const caminho = seedNotificacao(db, pedido(), { tentativas: MAX_TENTATIVAS - 2 });
      await reprocessarNotificacoesLi(asDb(db), {}, comErros(erros, throttle()));
      expect(db.ler(caminho)).toMatchObject({ status: 'failed' });
      expect(erros).toEqual([]);
    });

    it('a RETURNED park at the cap (a deterministic refusal) is the row’s own record — no generic line', async () => {
      const db = new FakeDb();
      contaSaudavel(db);
      const erros: unknown[][] = [];
      seedNotificacao(db, pedido(), { tentativas: MAX_TENTATIVAS - 1 });
      await reprocessarNotificacoesLi(
        asDb(db),
        {},
        comErros(erros, new LiNotFoundError({ ...REQ, status: 404 })),
      );
      expect(erros).toEqual([]);
    });

    it('the DEFERRED lane graduates it back to the hot lane — fresh budget, nothing signalled', async () => {
      const db = new FakeDb();
      contaSaudavel(db);
      const erros: unknown[][] = [];
      const err = new LiPedidoPagoSemEnderecoError(PEDIDO);
      const caminho = seedNotificacao(db, pedido(), {
        status: 'deferred',
        tentativas: MAX_TENTATIVAS_DEFERRED - 1,
      });
      await reprocessarAdiadasLi(asDb(db), {}, comErros(erros, err));
      expect(db.ler(caminho)).toMatchObject({ status: 'failed', tentativas: 0 });
      expect(erros).toEqual([]);
      expect(db.ler(caminhoAviso)).toBeUndefined();
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('the parked-conta lane (#808)', () => {
  it('the task defers → hot sweeps leave it → a token save re-drives it → the hot sweep imports it → gone', async () => {
    const db = new FakeDb();
    contaParada(db);
    const importados: string[] = [];
    const importador: ImportadorPedidoLi = (_db, _ctx, p) => {
      importados.push(p.numero);
      return Promise.resolve({ kind: 'importado' });
    };
    const deps = depsTarefa({ importador });
    const caminho = caminhoDe(pedido());

    expect((await tratarTarefaLeituraLi(asDb(db), pedido(), 0, deps)).outcome).toBe('deferred');
    expect(db.ler(caminho)).toMatchObject({ status: 'deferred', erro: 'adiado/conta-parada' });

    for (let i = 0; i < 3; i += 1) {
      const s = await reprocessarNotificacoesLi(asDb(db), {}, deps);
      expect(s.processed).toBe(0);
    }
    expect(db.ler(caminho)).toMatchObject({ status: 'deferred' });

    // The operator saves a valid token, and the route re-drives (PR 3-b).
    const lida = await lerCredencial(asDb(db), ID);
    await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_B,
      tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: lida!.updateTime,
    });
    __resetAllReadCaches();
    expect(await redrivePedidosAdiadosDaConta(asDb(db), ID)).toEqual({
      encontradas: 1,
      redirecionadas: 1,
      truncado: false,
    });
    expect(db.ler(caminho)).toMatchObject({ status: 'failed', tentativas: 0, processedAt: 0 });

    const s = await reprocessarNotificacoesLi(asDb(db), {}, deps);
    expect(s.outcomes).toEqual({ importado: 1 });
    expect(db.ler(caminho)).toBeUndefined();
    expect(importados).toEqual(['1234']);
  });

  it(`the cap, by constant: at MAX_TENTATIVAS_DEFERRED - 1 the next deferred sweep parks`, async () => {
    const db = new FakeDb();
    contaParada(db);
    const deps = depsTarefa({ importador: importa });
    const ultima = seedNotificacao(db, pedido(), {
      status: 'deferred',
      tentativas: MAX_TENTATIVAS_DEFERRED - 1,
    });
    const penultima = seedNotificacao(db, pedido({ numero: '99' }), {
      status: 'deferred',
      tentativas: MAX_TENTATIVAS_DEFERRED - 2,
    });
    const s = await reprocessarAdiadasLi(asDb(db), {}, deps);
    expect(s.outcomes).toEqual({ parked: 1, deferred: 1 });
    expect(db.ler(ultima)).toMatchObject({
      status: 'parked',
      tentativas: MAX_TENTATIVAS_DEFERRED,
    });
    // Near-miss: one attempt short of the cap stays in the slow lane.
    expect(db.ler(penultima)).toMatchObject({
      status: 'deferred',
      tentativas: MAX_TENTATIVAS_DEFERRED - 1,
    });
  });

  it('graduation: an UNPARKED conta whose importer throws 429 goes back to the hot lane, fresh', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    const caminho = seedNotificacao(db, pedido(), { status: 'deferred', tentativas: 4 });
    const s = await reprocessarAdiadasLi(
      asDb(db),
      {},
      depsTarefa({ importador: falhaCom(throttle()) }),
    );
    expect(s.outcomes).toEqual({ redriven: 1 });
    expect(s.processed).toBe(1);
    expect(db.ler(caminho)).toMatchObject({ status: 'failed', tentativas: 0, processedAt: 0 });
  });

  it('near-miss: a STILL-parked conta returns adiado and never graduates', async () => {
    const db = new FakeDb();
    contaParada(db);
    const caminho = seedNotificacao(db, pedido(), { status: 'deferred', tentativas: 4 });
    const s = await reprocessarAdiadasLi(asDb(db), {}, depsTarefa({ importador: importa }));
    expect(s.outcomes).toEqual({ deferred: 1 });
    expect(db.ler(caminho)).toMatchObject({ status: 'deferred', tentativas: 5 });
  });
});

/* -------------------------------------------------------------------------- */

describe('redrivePedidosAdiadosDaConta', () => {
  it('moves only THIS conta’s DEFERRED rows; another conta’s, and parked or failed rows, stay', async () => {
    const db = new FakeDb();
    const a = seedNotificacao(db, pedido({ numero: '1' }), { status: 'deferred', tentativas: 3 });
    const b = seedNotificacao(db, pedido({ numero: '2' }), { status: 'deferred', tentativas: 1 });
    const parado = seedNotificacao(db, pedido({ numero: '3' }), { status: 'parked' });
    const falho = seedNotificacao(db, pedido({ numero: '4' }), { status: 'failed', tentativas: 2 });
    const outra = seedNotificacao(db, pedido({ contaId: OUTRA, numero: '1' }), {
      status: 'deferred',
      tentativas: 3,
    });
    const antes = { parado: db.ler(parado), falho: db.ler(falho), outra: db.ler(outra) };

    expect(await redrivePedidosAdiadosDaConta(asDb(db), ID)).toEqual({
      encontradas: 2,
      redirecionadas: 2,
      truncado: false,
    });
    for (const c of [a, b]) {
      expect(db.ler(c)).toMatchObject({ status: 'failed', tentativas: 0, processedAt: 0 });
      expect(String(db.ler(c)?.erro)).toContain(ID);
    }
    expect(db.ler(parado)).toEqual(antes.parado);
    expect(db.ler(falho)).toEqual(antes.falho);
    expect(db.ler(outra)).toEqual(antes.outra);
    expect(db.consultas.at(-1)).toEqual({
      colecao: COLECAO,
      filtros: [
        ['status', '==', 'deferred'],
        ['contaId', '==', ID],
      ],
      ordens: [],
      limite: LIMITE_REDRIVE_LI,
      apos: null,
    });
  });

  it('a row deleted between the query and the write is NOT resurrected', async () => {
    const db = new FakeDb();
    const a = seedNotificacao(db, pedido({ numero: '1' }), { status: 'deferred' });
    const b = seedNotificacao(db, pedido({ numero: '2' }), { status: 'deferred' });
    db.antesDaProximaEscrita(a, async () => {
      // The hot sweep imported it a moment ago.
      await notificacaoLojaIntegradaCollection
        .docRef(asDb(db), {}, a.slice(COLECAO.length + 1))
        .delete();
    });
    expect(await redrivePedidosAdiadosDaConta(asDb(db), ID)).toEqual({
      encontradas: 2,
      redirecionadas: 1,
      truncado: false,
    });
    expect(db.ler(a)).toBeUndefined();
    expect(db.ler(b)).toMatchObject({ status: 'failed' });
  });

  it('writes the rows with BOUNDED concurrency — never one RPC at a time, never unbounded', async () => {
    // The credential routes await this after the Loja Integrada call, inside the
    // request ceiling (`prazos.test.ts`): 500 serial updates would be its slowest step.
    expect(CONCORRENCIA_REDRIVE_LI).toBeGreaterThan(1);
    const db = new FakeDb();
    const total = CONCORRENCIA_REDRIVE_LI * 2 + 3;
    let emVoo = 0;
    let pico = 0;
    for (let i = 1; i <= total; i += 1) {
      const c = seedNotificacao(db, pedido({ numero: String(i) }), { status: 'deferred' });
      db.antesDaProximaEscrita(c, async () => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((r) => setTimeout(r, 1));
        emVoo -= 1;
      });
    }
    expect(await redrivePedidosAdiadosDaConta(asDb(db), ID)).toEqual({
      encontradas: total,
      redirecionadas: total,
      truncado: false,
    });
    expect(pico).toBe(CONCORRENCIA_REDRIVE_LI);
  });

  it('a full page is truncated and LOGGED — the daily sweep drains the rest', async () => {
    const db = new FakeDb();
    for (const numero of ['1', '2', '3']) {
      seedNotificacao(db, pedido({ numero }), { status: 'deferred' });
    }
    const espiao = loggerEspiao();
    const r = await redrivePedidosAdiadosDaConta(asDb(db), ID, 2, espiao.logger);
    expect(r).toEqual({ encontradas: 2, redirecionadas: 2, truncado: true });
    expect(espiao.chamadas).toHaveLength(1);
    expect(espiao.chamadas[0]?.[1]).toEqual({ contaId: ID, limite: 2 });
    // Near-miss: a short page is not truncated and logs nothing.
    const espiao2 = loggerEspiao();
    const r2 = await redrivePedidosAdiadosDaConta(asDb(db), ID, 5, espiao2.logger);
    expect(r2.truncado).toBe(false);
    expect(espiao2.chamadas).toEqual([]);
  });
});

describe('redriveAposSalvarTokenLi — the best-effort wrapper the credential routes call', () => {
  it('returns what the re-drive did, and moves only this conta’s deferred rows', async () => {
    const db = new FakeDb();
    const a = seedNotificacao(db, pedido({ numero: '1' }), { status: 'deferred', tentativas: 3 });
    const parado = seedNotificacao(db, pedido({ numero: '2' }), { status: 'parked' });
    const outra = seedNotificacao(db, pedido({ contaId: OUTRA, numero: '1' }), {
      status: 'deferred',
    });
    const antes = { parado: db.ler(parado), outra: db.ler(outra) };
    expect(await redriveAposSalvarTokenLi(asDb(db), ID)).toEqual({
      encontradas: 1,
      redirecionadas: 1,
      truncado: false,
    });
    expect(db.ler(a)).toMatchObject({ status: 'failed', tentativas: 0 });
    expect(db.ler(parado)).toEqual(antes.parado);
    expect(db.ler(outra)).toEqual(antes.outra);
  });

  it.each([1, 5, 9, 14, 16])(
    'a gRPC status error (%i) is logged by code and swallowed as null',
    async (codigo) => {
      const db = new FakeDb();
      db.falharConsulta(COLECAO, grpc(codigo, 'mensagem que nao deve ser logada'));
      const espiao = loggerEspiao();
      expect(await redriveAposSalvarTokenLi(asDb(db), ID, espiao.logger)).toBeNull();
      expect(espiao.chamadas).toHaveLength(1);
      expect(espiao.chamadas[0]?.[1]).toEqual({ contaId: ID, code: codigo });
      expect(JSON.stringify(espiao.chamadas)).not.toContain('mensagem que nao deve');
    },
  );

  it.each([
    ['a plain Error', new Error('bug')],
    ['a TypeError', new TypeError('bug')],
    [
      'a string `code` (a FirebaseError shape)',
      Object.assign(new Error('x'), { code: 'functions/internal' }),
    ],
    ['code 0 (not an error status)', Object.assign(new Error('x'), { code: 0 })],
    ['code 17 (outside the gRPC space)', Object.assign(new Error('x'), { code: 17 })],
    ['a non-Error throw', 'falhou'],
  ])('near-miss: %s is rethrown, never swallowed (rule 6)', async (_nome, erro) => {
    const db = new FakeDb();
    db.falharConsulta(COLECAO, erro as Error);
    const espiao = loggerEspiao();
    await expect(redriveAposSalvarTokenLi(asDb(db), ID, espiao.logger)).rejects.toBe(erro);
    expect(espiao.chamadas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The token comes back and the route re-drives, right before the run's write of
 * `caminho`. Records what the re-drive moved — `null` until the hook has run.
 */
function salvarERedirecionarAntesDaEscrita(
  db: FakeDb,
  caminho: string,
): { redirecionadas: number | null } {
  const visto: { redirecionadas: number | null } = { redirecionadas: null };
  db.antesDaProximaEscrita(caminho, async () => {
    const lida = await lerCredencial(asDb(db), ID);
    await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_B,
      tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: lida!.updateTime,
    });
    visto.redirecionadas = (await redrivePedidosAdiadosDaConta(asDb(db), ID)).redirecionadas;
  });
  return visto;
}

const HORA_MS = 60 * 60 * 1000;

describe('Q4 (option A, accepted): a re-drive landing between the deferred sweep’s read and its mark', () => {
  it('pass 6: the mark overwrites the re-drive — the row waits ONE more day, then imports', async () => {
    const db = new FakeDb();
    contaParada(db);
    const deps = depsTarefa({ importador: importa });
    const caminho = seedNotificacao(db, pedido(), {
      status: 'deferred',
      tentativas: MAX_TENTATIVAS_DEFERRED - 2,
    });
    const visto = salvarERedirecionarAntesDaEscrita(db, caminho);
    await reprocessarAdiadasLi(asDb(db), {}, deps);
    expect(visto.redirecionadas).toBe(1);
    expect(db.ler(caminho)).toMatchObject({
      status: 'deferred',
      tentativas: MAX_TENTATIVAS_DEFERRED - 1,
    });
    // The next day's deferred pass sees the healthy conta and imports it.
    __resetAllReadCaches();
    const s = await reprocessarAdiadasLi(asDb(db), { now: Date.now() + 2 * DIA_MS }, deps);
    expect(s.outcomes).toEqual({ importado: 1 });
    expect(db.ler(caminho)).toBeUndefined();
  });

  it('pass 7: the mark PARKS over the re-drive — the documented residue', async () => {
    const db = new FakeDb();
    contaParada(db);
    const caminho = seedNotificacao(db, pedido(), {
      status: 'deferred',
      tentativas: MAX_TENTATIVAS_DEFERRED - 1,
    });
    const visto = salvarERedirecionarAntesDaEscrita(db, caminho);
    await reprocessarAdiadasLi(asDb(db), {}, depsTarefa({ importador: importa }));
    expect(visto.redirecionadas).toBe(1);
    expect(db.ler(caminho)).toMatchObject({
      status: 'parked',
      tentativas: MAX_TENTATIVAS_DEFERRED,
    });
  });
});

describe('the same residue, two more windows: the park found BEFORE the re-drive, the row written AFTER it', () => {
  /** Neither lane takes the row back within the day; the next day's deferred pass imports it. */
  async function esperaUmDiaEImporta(db: FakeDb, caminho: string, deps: DepsTarefaLi) {
    __resetAllReadCaches();
    const emDuasHoras = { now: Date.now() + 2 * HORA_MS };
    expect((await reprocessarNotificacoesLi(asDb(db), emDuasHoras, deps)).processed).toBe(0);
    expect((await reprocessarAdiadasLi(asDb(db), emDuasHoras, deps)).processed).toBe(0);
    expect(db.ler(caminho)).toMatchObject({ status: 'deferred', tentativas: 0 });
    const s = await reprocessarAdiadasLi(asDb(db), { now: Date.now() + 2 * DIA_MS }, deps);
    expect(s.outcomes).toEqual({ importado: 1 });
    expect(db.ler(caminho)).toBeUndefined();
  }

  it('the task: its deferred create lands after the re-drive — one more day, never lost', async () => {
    const db = new FakeDb();
    contaParada(db);
    const deps = depsTarefa({ importador: importa });
    const caminho = caminhoDe(pedido());
    const visto = salvarERedirecionarAntesDaEscrita(db, caminho);
    expect((await tratarTarefaLeituraLi(asDb(db), pedido(), 0, deps)).outcome).toBe('deferred');
    // The re-drive's query ran before the create: there was no row to move.
    expect(visto.redirecionadas).toBe(0);
    expect(db.ler(caminho)).toMatchObject({ status: 'deferred', tentativas: 0 });
    await esperaUmDiaEImporta(db, caminho, deps);
  });

  it('the hot sweep: its migration mark lands after the re-drive — one more day, never lost', async () => {
    const db = new FakeDb();
    contaParada(db);
    const deps = depsTarefa({ importador: importa });
    const caminho = seedNotificacao(db, pedido(), { status: 'failed', tentativas: 1 });
    const visto = salvarERedirecionarAntesDaEscrita(db, caminho);
    await reprocessarNotificacoesLi(asDb(db), {}, deps);
    // The re-drive moves `deferred` rows only, and this one was still `failed`.
    expect(visto.redirecionadas).toBe(0);
    expect(db.ler(caminho)).toMatchObject({ status: 'deferred', tentativas: 0 });
    await esperaUmDiaEImporta(db, caminho, deps);
  });
});

describe('the reverse window: a park landing between the re-drive’s query and its write', () => {
  it('is reset to the hot lane — one extra attempt, then parked again; never a loss', async () => {
    const db = new FakeDb();
    contaSaudavel(db);
    // Step 3: the importer seam is empty, so a healthy conta's row PARKS (`importador-ausente`).
    const deps = depsTarefa();
    const caminho = seedNotificacao(db, pedido(), { status: 'deferred', tentativas: 2 });
    db.antesDaProximaEscrita(caminho, async () => {
      // The deferred sweep runs after the re-drive's query and before its write: it parks the row.
      const s = await reprocessarAdiadasLi(asDb(db), {}, deps);
      expect(s.processed).toBe(1);
      expect(db.ler(caminho)).toMatchObject({ status: 'parked' });
    });
    expect(await redrivePedidosAdiadosDaConta(asDb(db), ID)).toEqual({
      encontradas: 1,
      redirecionadas: 1,
      truncado: false,
    });
    // The re-drive's write carries no precondition: the park is undone.
    expect(db.ler(caminho)).toMatchObject({ status: 'failed', tentativas: 0, processedAt: 0 });
    // The next hot sweep spends the one extra attempt and parks it again.
    __resetAllReadCaches();
    await reprocessarNotificacoesLi(asDb(db), {}, deps);
    expect(db.ler(caminho)).toMatchObject({ status: 'parked' });
  });
});

/* -------------------------------------------------------------------------- */

describe('the task’s log-line contract', () => {
  it('detail rides only the arms that persist nothing (done, dropped)', async () => {
    const saudavel = (importador: ImportadorPedidoLi | null) => (db: FakeDb) => {
      contaSaudavel(db);
      return { importador };
    };
    const parada = (db: FakeDb) => {
      contaParada(db);
      return { importador: importa };
    };
    const casos: readonly [string, (db: FakeDb) => Partial<DepsTarefaLi>, unknown, number][] = [
      ['done', saudavel(importa), pedido(), 0],
      ['dropped', () => ({ importador: importa }), pedido(), 0],
      ['dropped (payload inválido)', () => ({}), { ...pedido(), numero: '01' }, 0],
      ['parked', saudavel(null), pedido(), 0],
      ['deferred', parada, pedido(), 0],
      ['failed', saudavel(falhaCom(throttle())), pedido(), 2],
    ];
    const vistos: Record<string, unknown> = {};
    for (const [nome, preparar, dados, tentativa] of casos) {
      __resetAllReadCaches();
      const db = new FakeDb();
      const r = await tratarTarefaLeituraLi(asDb(db), dados, tentativa, depsTarefa(preparar(db)));
      vistos[nome] = { outcome: r.outcome, kind: r.kind, detail: r.detail };
    }
    expect(vistos).toEqual({
      done: { outcome: 'done', kind: 'importado', detail: 'importado' },
      dropped: { outcome: 'dropped', kind: 'conta-inexistente', detail: 'conta-inexistente' },
      'dropped (payload inválido)': { outcome: 'dropped', kind: null, detail: 'payload-invalido' },
      parked: { outcome: 'parked', kind: 'importador-ausente', detail: null },
      deferred: { outcome: 'deferred', kind: 'adiado', detail: null },
      failed: { outcome: 'failed', kind: null, detail: null },
    });
  });

  it('the line names the raw ids one by one — never a spread of the task data', () => {
    const dados = {
      ...pedido(),
      extra: 'nunca',
      cliente: { nome: 'Fulano' },
    };
    const campos = camposDoRegistroDaTarefaLi(
      { outcome: 'done', kind: 'importado', detail: 'importado' },
      dados,
    );
    expect(campos).toEqual({
      outcome: 'done',
      kind: 'importado',
      detail: 'importado',
      tipo: 'pedido',
      contaId: ID,
      numero: '1234',
      origem: 'poll',
    });
  });

  it('a malformed or hostile payload logs null — never an object, never a long string', () => {
    const r = { outcome: 'dropped', kind: null, detail: 'payload-invalido' } as const;
    expect(
      camposDoRegistroDaTarefaLi(r, {
        contaId: { $gt: '' },
        numero: 1234,
        origem: 'x'.repeat(129),
      }),
    ).toMatchObject({ contaId: null, numero: null, origem: null, tipo: null });
    for (const dados of [null, undefined, 'texto', 42, ['a']]) {
      const c = camposDoRegistroDaTarefaLi(r, dados);
      expect([c.tipo, c.contaId, c.numero, c.origem], String(dados)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('persistirFalhaNotificacaoLi — the producer’s enqueue-failure fallback', () => {
  it('persists failed at the deterministic id, and a second persist never forks', async () => {
    const db = new FakeDb();
    await persistirFalhaNotificacaoLi(asDb(db), pedido(), 'fila desligada');
    await persistirFalhaNotificacaoLi(asDb(db), pedido(), 'fila desligada de novo');
    expect(db.idsEm(COLECAO)).toEqual([docIdNotificacaoLi(pedido())]);
    expect(db.ler(caminhoDe(pedido()))).toMatchObject({
      status: 'failed',
      tentativas: 0,
      erro: 'fila desligada',
      contaId: ID,
      numero: '1234',
      dataModificacaoLi: STAMP,
    });
  });

  it('a later change of the same order is a NEW row — the stamp is in the id', async () => {
    const db = new FakeDb();
    await persistirFalhaNotificacaoLi(asDb(db), pedido(), 'x');
    await persistirFalhaNotificacaoLi(
      asDb(db),
      pedido({ dataModificacaoLi: '2026-10-13T09:00:00.000000' }),
      'x',
    );
    expect(db.idsEm(COLECAO)).toHaveLength(2);
  });
});
