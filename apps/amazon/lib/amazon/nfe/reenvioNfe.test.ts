/**
 * The NF-e re-drive's body (step 14, PR 14-d) against the fake Firestore, the
 * REAL producer over a recording queue, and a global `fetch` that must never
 * run: the strict body, the read switch, the queue valve and the queue's region
 * before any read, the proof, the slot (explicit and chosen), the ONE unnamed
 * enqueue, the failures it names — and, on every arm, zero writes and zero
 * Amazon calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_NFE_AMAZON,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  MARKETPLACE_PEDIDO_TIPO,
  erroEnvioNfeAmazonSchema,
  respostaEnvioNfeAmazonSchema,
} from '@delfrance/schemas';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import type { AmbienteAmazon } from '../env';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { FakeDb, asDb } from '../testing/fakeDb';
import { CORPO_DA_RESPOSTA_DO_TASKS, falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import { espiaoDeFetch, loggerEspiao } from '../testing/fixtures';
import {
  type AgendadorNfeAmazon,
  AmazonNfeRegiaoDaFilaInvalidaError,
  type FilaNfeAmazon,
  caminhoDaFilaNfeAmazon,
  criarAgendadorNfeAmazon,
} from './agendadorNfe';
import { irmaosDaNfeAmazon } from './pedidoNfe';
import {
  AmazonNfeEnfileiramentoFalhouError,
  type DepsReenvioNfeAmazon,
  FRASES_NAO_ELEGIVEL_REENVIO_NFE_AMAZON,
  MAX_CORPO_REENVIO_NFE_BYTES,
  ROTA_REENVIO_NFE_AMAZON,
  reenviarNfeAmazon,
} from './reenvioNfe';
import { tarefaInicialNfeAmazon } from './tarefaNfe';

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/enviar-nfe';

/** The read switch on, the NF-e valve and its canary UNSET — the route must not care. */
const AMBIENTE: AmbienteAmazon = Object.freeze({ AMAZON_CHAMADAS: 'on' });

/** A synthetic proc: `tpNF`/`finNFe` and `tpAmb`; no real party, no access key. */
function proc(tpNF = '1', finNFe = '1', tpAmb = '1'): string {
  return (
    `<nfeProc><NFe><infNFe><ide><tpAmb>${tpAmb}</tpAmb><tpNF>${tpNF}</tpNF>` +
    `<finNFe>${finNFe}</finNFe></ide></infNFe></NFe></nfeProc>`
  );
}

/** A raw `nfev4` document, approved and ready by default. */
function nfe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { estado: ESTADO_NFE.aprovada, xml_nfe_proc: proc(), ...extra };
}

/** A raw pedido the Amazon importer could have written. */
function pedido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: ESTADO_PEDIDO.pago,
    ...extra,
  };
}

/** A POST to the route with `corpo` as its body (a string is sent verbatim). */
function requisicao(corpo: unknown): Request {
  return new Request(URL_ROTA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

let fake: FakeDb;
let espiao: ReturnType<typeof loggerEspiao>;
let lerDb: ReturnType<typeof vi.fn>;
let enqueue: ReturnType<typeof vi.fn<FilaNfeAmazon['enqueue']>>;
let criarAgendador: ReturnType<typeof vi.fn>;
let chamadasFetch: unknown[];

/** The REAL producer over a queue that records every enqueue, whole. */
function produtorReal(
  opcoes: { desligado?: boolean; falha?: () => unknown; fila?: () => FilaNfeAmazon } = {},
): void {
  const fila: FilaNfeAmazon = {
    enqueue: (...args: Parameters<FilaNfeAmazon['enqueue']>) => enqueue(...args),
  };
  if (opcoes.falha !== undefined) {
    const falha = opcoes.falha;
    enqueue.mockImplementation(() => Promise.reject(falha()));
  }
  criarAgendador.mockImplementation(() =>
    criarAgendadorNfeAmazon({
      fila: opcoes.fila ?? (() => fila),
      desligado: opcoes.desligado ?? false,
    }),
  );
}

function deps(over: Partial<DepsReenvioNfeAmazon> = {}): DepsReenvioNfeAmazon {
  return {
    ambiente: AMBIENTE,
    db: lerDb as unknown as DepsReenvioNfeAmazon['db'],
    filaDesligada: false,
    regiao: () => 'xx-tarefas-1',
    agendador: criarAgendador as unknown as DepsReenvioNfeAmazon['agendador'],
    logger: espiao.logger,
    ...over,
  };
}

function reenviar(corpo: unknown, over: Partial<DepsReenvioNfeAmazon> = {}) {
  return reenviarNfeAmazon(requisicao(corpo), deps(over));
}

function semear(p: Record<string, unknown> | null, docs: Record<string, Record<string, unknown>>) {
  if (p !== null) fake.seed(`pedidos/${PEDIDO_ID}`, p);
  for (const [id, raw] of Object.entries(docs)) fake.seed(`pedidos/${PEDIDO_ID}/nfev4/${id}`, raw);
}

/** The enqueues, each as its WHOLE argument list (a second argument = an option). */
function enfileiradas(): unknown[][] {
  return enqueue.mock.calls;
}

/** Every `evento: 'nfe'` line's campos. */
function linhasNfe() {
  return espiao.linhas.filter((l) => l.meta?.evento === 'nfe').map((l) => l.meta ?? {});
}

beforeEach(() => {
  fake = new FakeDb();
  espiao = loggerEspiao();
  lerDb = vi.fn(() => asDb(fake));
  enqueue = vi.fn<FilaNfeAmazon['enqueue']>(() => Promise.resolve());
  criarAgendador = vi.fn();
  produtorReal();
  const fetch = espiaoDeFetch();
  chamadasFetch = fetch.chamadas;
  vi.stubGlobal('fetch', fetch.fetch);
});

afterEach(() => {
  // ★ On EVERY arm: no Amazon call (no fetch at all) and no Firestore write.
  expect(chamadasFetch).toHaveLength(0);
  expect(fake.escritas).toEqual([]);
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                                 the 202                                    */
/* -------------------------------------------------------------------------- */

describe('202 — ONE unnamed enqueue, nothing else', () => {
  it('★ an explicit nfeId ALREADY ready (the edge long consumed) ⇒ enqueued: the LEVEL predicate, never the transition', async () => {
    semear(pedido(), { s1: nfe({ data_autorizacao: 1_000 }) });
    const r = await reenviar({ pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(r.status).toBe(202);
    // ★ The RAW body, EXACTLY these three keys — compared before any parse: the
    // schema is not strict and would strip a leaked key before `toEqual` saw it.
    expect(r.corpo).toEqual({ enfileirado: true, pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(respostaEnvioNfeAmazonSchema.safeParse(r.corpo).success).toBe(true);
    // ★ The payload ALONE: no task id (UNNAMED), no delay, minted by the builder.
    expect(enfileiradas()).toEqual([[tarefaInicialNfeAmazon(PEDIDO_ID, 's1')]]);
    // Exactly two reads, by id: the pedido and the named document.
    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`, `pedidos/${PEDIDO_ID}/nfev4/s1`]);
    expect(fake.consultas).toEqual([]);
  });

  it('★ the route NEVER names a task: only `enfileirar` runs, never the trigger’s named entry', async () => {
    semear(pedido(), { s1: nfe() });
    const dupla = {
      enfileirar: vi.fn(() => Promise.resolve()),
      enfileirarDoGatilho: vi.fn(() => Promise.resolve('enfileirada' as const)),
    };
    const r = await reenviar(
      { pedidoId: PEDIDO_ID },
      { agendador: () => dupla as unknown as AgendadorNfeAmazon },
    );
    expect(r.status).toBe(202);
    expect(dupla.enfileirarDoGatilho).not.toHaveBeenCalled();
    expect(dupla.enfileirar.mock.calls).toEqual([[tarefaInicialNfeAmazon(PEDIDO_ID, 's1')]]);
  });

  it('no nfeId ⇒ ONE unfiltered listing, and the ONE eligible note is chosen over LATER ineligible ones', async () => {
    semear(pedido(), {
      s1: nfe({ data_autorizacao: 1_000 }),
      s7: nfe({ xml_nfe_proc: proc('1', '4'), data_autorizacao: 3_000 }),
      s9: nfe({ xml_nfe_proc: proc('1', '1', '2'), data_autorizacao: 2_000 }),
    });
    const r = await reenviar({ pedidoId: PEDIDO_ID });
    expect(r).toMatchObject({ status: 202, corpo: { nfeId: 's1' } });
    expect(enfileiradas()).toEqual([[tarefaInicialNfeAmazon(PEDIDO_ID, 's1')]]);
    expect(fake.consultas).toEqual([
      expect.objectContaining({
        colecao: `pedidos/${PEDIDO_ID}/nfev4`,
        filtros: [],
        ordens: [],
        limite: null,
      }),
    ]);
  });

  it('`nfeId: null` is the same as absent (the slot rule picks)', async () => {
    semear(pedido(), { s2: nfe() });
    const r = await reenviar({ pedidoId: PEDIDO_ID, nfeId: null });
    expect(r).toMatchObject({ status: 202, corpo: { nfeId: 's2' } });
  });

  it('★ a cancelled slot is NEVER chosen, however recent', async () => {
    semear(pedido(), {
      s1: nfe({ data_autorizacao: 1_000 }),
      s3: nfe({ estado: ESTADO_NFE.cancelada, data_autorizacao: 9_000 }),
    });
    expect(await reenviar({ pedidoId: PEDIDO_ID })).toMatchObject({
      status: 202,
      corpo: { nfeId: 's1' },
    });
  });

  it('★ TWO eligible sale notes ⇒ still 202, naming the slot rule’s pick — NOT an upload: the sibling rule is the TASK’s, which raises nfe-ambigua before any Amazon call (plan §3 decision 4)', async () => {
    const docs = { s1: nfe({ data_autorizacao: 1_000 }), s9: nfe({ data_autorizacao: 2_000 }) };
    semear(pedido(), docs);
    expect(await reenviar({ pedidoId: PEDIDO_ID })).toMatchObject({
      status: 202,
      corpo: { nfeId: 's9' },
    });
    // The very listing the route held makes the task refuse that pick (its P5).
    const listagem = Object.entries(docs).map(([id, raw]) => ({ id, raw }));
    expect(irmaosDaNfeAmazon('s9', listagem).outraElegivel).toBe(true);
    // A tie names the lowest id; the same refusal follows.
    enqueue.mockClear();
    fake = new FakeDb();
    semear(pedido(), {
      s9: nfe({ data_autorizacao: 5_000 }),
      s2: nfe({ data_autorizacao: 5_000 }),
    });
    expect(await reenviar({ pedidoId: PEDIDO_ID })).toMatchObject({
      status: 202,
      corpo: { nfeId: 's2' },
    });
    // The EXPLICIT arm reads the named document alone — never the listing — so
    // an eligible sibling is the task's to find there too.
    enqueue.mockClear();
    fake = new FakeDb();
    semear(pedido(), docs);
    expect(await reenviar({ pedidoId: PEDIDO_ID, nfeId: 's1' })).toMatchObject({
      status: 202,
      corpo: { nfeId: 's1' },
    });
    expect(fake.consultas).toEqual([]);
    expect(enfileiradas()).toEqual([[tarefaInicialNfeAmazon(PEDIDO_ID, 's1')]]);
  });

  it.each([
    ['cancelado', ESTADO_PEDIDO.cancelado],
    ['estornadoIntegralmente', ESTADO_PEDIDO.estornadoIntegralmente],
  ])(
    '★ a stored cancelled SALE (%s) is enqueued ON PURPOSE: the task answers it at P3 with the incidente, zero Amazon calls',
    async (_nome, estado) => {
      semear(pedido({ estado }), { s1: nfe() });
      const r = await reenviar({ pedidoId: PEDIDO_ID });
      expect(r).toMatchObject({ status: 202, corpo: { nfeId: 's1' } });
      expect(enfileiradas()).toEqual([[tarefaInicialNfeAmazon(PEDIDO_ID, 's1')]]);
    },
  );

  it('★ the trigger’s STORED pre-filter is bypassed: stored evidence of NOT Delivery by Amazon still enqueues (the task decides live)', async () => {
    semear(
      pedido({ marketplace: { tipo: MARKETPLACE_PEDIDO_TIPO.amazon, fulfilledBy: 'AMAZON' } }),
      { s1: nfe() },
    );
    expect(await reenviar({ pedidoId: PEDIDO_ID, nfeId: 's1' })).toMatchObject({ status: 202 });
    expect(enfileiradas()).toHaveLength(1);
  });

  it('★ a proc ILLEGIBLE to the sale gate passes on purpose, on both paths (the task avisa and stamps it)', async () => {
    const ilegivel = nfe({
      xml_nfe_proc: '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb></ide></infNFe></NFe></nfeProc>',
    });
    semear(pedido(), { s1: ilegivel });
    expect(await reenviar({ pedidoId: PEDIDO_ID, nfeId: 's1' })).toMatchObject({ status: 202 });
    expect(await reenviar({ pedidoId: PEDIDO_ID })).toMatchObject({
      status: 202,
      corpo: { nfeId: 's1' },
    });
  });

  it('★ reads exactly ONE variable — the read switch — never the NF-e valve or its canary', async () => {
    semear(pedido(), { s1: nfe() });
    const lidas: string[] = [];
    const base: AmbienteAmazon = {
      AMAZON_CHAMADAS: 'on',
      // Both set to what WOULD stop a submit: the route must not look.
      AMAZON_MODO_NFE: 'off',
      AMAZON_CANARIO_NFE: '',
    };
    const ambiente = new Proxy(base, {
      get(alvo, chave, receptor) {
        lidas.push(String(chave));
        return Reflect.get(alvo, chave, receptor) as unknown;
      },
    });
    expect(await reenviar({ pedidoId: PEDIDO_ID }, { ambiente })).toMatchObject({ status: 202 });
    expect([...new Set(lidas)]).toEqual(['AMAZON_CHAMADAS']);
  });

  it('writes ONE INFO `nfe` line naming the pedido and the enqueued document', async () => {
    semear(pedido(), { s1: nfe() });
    await reenviar({ pedidoId: PEDIDO_ID });
    expect(espiao.linhas).toHaveLength(1);
    expect(espiao.linhas[0]?.nivel).toBe('info');
    expect(linhasNfe()).toEqual([
      expect.objectContaining({
        evento: 'nfe',
        fluxo: 'nfe',
        rota: ROTA_REENVIO_NFE_AMAZON,
        resultado: 'enfileirado',
        motivo: null,
        pedidoId: PEDIDO_ID,
        nfeId: 's1',
      }),
    ]);
    // Never the XML or any part of it.
    expect(JSON.stringify(espiao.linhas)).not.toContain('nfeProc');
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the body                                   */
/* -------------------------------------------------------------------------- */

describe('400 AMAZON_CORPO_INVALIDO — STRICT, before anything is read', () => {
  it.each([
    [
      '★ a `fase` (the payload is minted, never copied)',
      { pedidoId: PEDIDO_ID, fase: 'verificacao' },
      ['fase'],
    ],
    ['a counter', { pedidoId: PEDIDO_ID, reenvios: 1 }, ['reenvios']],
    ['any other key', { pedidoId: PEDIDO_ID, nfeId: 's1', extra: true }, ['extra']],
    ['no pedidoId', { nfeId: 's1' }, ['pedidoId']],
    ['a pedidoId outside the 64-hex digest', { pedidoId: 'pedido-1' }, ['pedidoId']],
    ['an UPPER-case digest (never folded)', { pedidoId: PEDIDO_ID.toUpperCase() }, ['pedidoId']],
    ['a padded digest (never trimmed)', { pedidoId: ` ${PEDIDO_ID}` }, ['pedidoId']],
    [
      'a digest with a trailing newline (never trimmed)',
      { pedidoId: `${PEDIDO_ID}\n` },
      ['pedidoId'],
    ],
    ['an nfeId with a "/" (another document)', { pedidoId: PEDIDO_ID, nfeId: 'a/b' }, ['nfeId']],
    ['an nfeId of `..`', { pedidoId: PEDIDO_ID, nfeId: '..' }, ['nfeId']],
    ['a numeric nfeId', { pedidoId: PEDIDO_ID, nfeId: 1 }, ['nfeId']],
    ['an array', [PEDIDO_ID], ['(corpo)']],
    ['null', null, ['(corpo)']],
    ['not JSON', '{pedidoId:', ['(corpo)']],
    ['an empty body', '', ['(corpo)']],
  ])('%s', async (_nome, corpo, issues) => {
    semear(pedido(), { s1: nfe() });
    const r = await reenviar(corpo);
    expect(r.status).toBe(400);
    expect(erroEnvioNfeAmazonSchema.parse(r.corpo)).toMatchObject({
      code: CODIGO_ERRO_NFE_AMAZON.CORPO_INVALIDO,
      issues,
    });
    // ★ The RAW envelope's keys (the schema strips unknown ones before a match).
    expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error', 'issues']);
    expect(lerDb).not.toHaveBeenCalled();
    expect(fake.operacoes).toBe(0);
    expect(enfileiradas()).toEqual([]);
  });

  it('a body over the read bound ⇒ 400, the stream never read past it', async () => {
    const r = await reenviar(
      JSON.stringify({ pedidoId: PEDIDO_ID, nfeId: 'x'.repeat(MAX_CORPO_REENVIO_NFE_BYTES) }),
    );
    expect(r).toMatchObject({ status: 400, corpo: { issues: ['(corpo)'] } });
    expect(lerDb).not.toHaveBeenCalled();
  });

  it('the issues are field PATHS — never a value — and the line carries none of them', async () => {
    const r = await reenviar({ pedidoId: 'SEGREDO-NO-VALOR', fase: 'verificacao' });
    expect(r.corpo).toMatchObject({ issues: ['fase', 'pedidoId'] });
    expect(JSON.stringify(r.corpo)).not.toContain('SEGREDO-NO-VALOR');
    expect(linhasNfe()).toEqual([
      expect.objectContaining({ resultado: CODIGO_ERRO_NFE_AMAZON.CORPO_INVALIDO, pedidoId: null }),
    ]);
    expect(JSON.stringify(espiao.linhas)).not.toContain('SEGREDO-NO-VALOR');
  });

  it('★ the 400 tells the caller WHICH id: the ERP pedido document, never the Amazon order number it can see', async () => {
    const r = await reenviar({ pedidoId: ORDER });
    expect(r).toMatchObject({ status: 400, corpo: { issues: ['pedidoId'] } });
    const { error } = erroEnvioNfeAmazonSchema.parse(r.corpo);
    expect(error).toMatch(/id do documento do pedido no ERP/);
    expect(error).toMatch(/não o número do pedido na Amazon/);
  });

  it('★ the body is judged FIRST: an invalid body with the switch off AND the queue valve closed ⇒ 400, neither 503', async () => {
    const r = await reenviar(
      { pedidoId: PEDIDO_ID, fase: 'verificacao' },
      { ambiente: { AMAZON_CHAMADAS: 'off' }, filaDesligada: true },
    );
    expect(r).toMatchObject({
      status: 400,
      corpo: { code: CODIGO_ERRO_NFE_AMAZON.CORPO_INVALIDO, issues: ['fase'] },
    });
    // The body's own line, never the switch's `chamada-bloqueada` or the valve's.
    expect(espiao.linhas.map((l) => l.meta?.evento)).toEqual(['nfe']);
    expect(linhasNfe()).toEqual([
      expect.objectContaining({ resultado: CODIGO_ERRO_NFE_AMAZON.CORPO_INVALIDO }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          the two valves, before reads                      */
/* -------------------------------------------------------------------------- */

describe('503 — the read switch and the queue valve answer BEFORE any Firestore read', () => {
  it.each([
    ['unset', undefined],
    ['off', 'off'],
    ['ON (never folded)', 'ON'],
    [' on (never trimmed)', ' on'],
  ])(
    '★ AMAZON_CHAMADAS %s ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS (the conta routes’ code), zero reads, one blocked line',
    async (_nome, valor) => {
      semear(pedido(), { s1: nfe() });
      const r = await reenviar({ pedidoId: PEDIDO_ID }, { ambiente: { AMAZON_CHAMADAS: valor } });
      expect(r.status).toBe(503);
      expect(r.corpo).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
      expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error']);
      expect(lerDb).not.toHaveBeenCalled();
      expect(fake.operacoes).toBe(0);
      expect(criarAgendador).not.toHaveBeenCalled();
      expect(espiao.linhas.map((l) => l.meta)).toEqual([
        expect.objectContaining({ evento: 'chamada-bloqueada', rota: ROTA_REENVIO_NFE_AMAZON }),
      ]);
    },
  );

  it('★ the queue valve closed ⇒ 503 AMAZON_TAREFAS_DESLIGADAS, zero reads, the producer never built, one WARNING', async () => {
    semear(pedido(), { s1: nfe() });
    const r = await reenviar({ pedidoId: PEDIDO_ID }, { filaDesligada: true });
    expect(r.status).toBe(503);
    expect(erroEnvioNfeAmazonSchema.parse(r.corpo).code).toBe(
      CODIGO_ERRO_NFE_AMAZON.TAREFAS_DESLIGADAS,
    );
    expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error']);
    expect(lerDb).not.toHaveBeenCalled();
    expect(fake.operacoes).toBe(0);
    expect(criarAgendador).not.toHaveBeenCalled();
    expect(espiao.linhas.map((l) => l.nivel)).toEqual(['warn']);
    // The WARNING names the pedido: the reason the valve is checked AFTER the body.
    expect(linhasNfe()).toEqual([
      expect.objectContaining({
        resultado: CODIGO_ERRO_NFE_AMAZON.TAREFAS_DESLIGADAS,
        pedidoId: PEDIDO_ID,
      }),
    ]);
  });

  it('the switch is checked before the queue valve (both shut ⇒ the switch answers)', async () => {
    const r = await reenviar(
      { pedidoId: PEDIDO_ID },
      { ambiente: { AMAZON_CHAMADAS: 'off' }, filaDesligada: true },
    );
    expect(r.corpo).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
  });

  it('★ the valve closing between the check and the enqueue ⇒ the SAME 503, nothing enqueued', async () => {
    semear(pedido(), { s1: nfe() });
    produtorReal({ desligado: true });
    const r = await reenviar({ pedidoId: PEDIDO_ID });
    expect(r).toMatchObject({
      status: 503,
      corpo: { code: CODIGO_ERRO_NFE_AMAZON.TAREFAS_DESLIGADAS },
    });
    expect(enfileiradas()).toEqual([]);
  });

  it.each([
    [
      'missing',
      (): string => {
        throw new MissingRegionError('região ausente', ['AMAZON_TASKS_REGION', 'FUNCTIONS_REGION']);
      },
      MissingRegionError,
    ],
    ['malformed', (): string => 'regiao/errada', AmazonNfeRegiaoDaFilaInvalidaError],
  ])(
    '★ a %s queue region PROPAGATES before ANY read, whatever the pedido, after ONE ERROR line naming AMAZON_TASKS_REGION',
    async (_nome, regiao, classe) => {
      // No pedido seeded: a broken deploy must not hide behind a 404 (or a 409).
      await expect(reenviar({ pedidoId: PEDIDO_ID }, { regiao })).rejects.toBeInstanceOf(classe);
      expect(lerDb).not.toHaveBeenCalled();
      expect(fake.operacoes).toBe(0);
      expect(criarAgendador).not.toHaveBeenCalled();
      expect(espiao.linhas.map((l) => l.nivel)).toEqual(['error']);
      expect(linhasNfe()).toEqual([
        expect.objectContaining({
          resultado: 'falhou',
          motivo: `AMAZON_TASKS_REGION/${classe.name}`,
          pedidoId: PEDIDO_ID,
          nfeId: null,
        }),
      ]);
    },
  );

  it('the region is checked AFTER the queue valve (both broken ⇒ the valve’s 503, nothing thrown)', async () => {
    const r = await reenviar(
      { pedidoId: PEDIDO_ID },
      { filaDesligada: true, regiao: () => 'regiao/errada' },
    );
    expect(r).toMatchObject({
      status: 503,
      corpo: { code: CODIGO_ERRO_NFE_AMAZON.TAREFAS_DESLIGADAS },
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         the pedido and the slot                            */
/* -------------------------------------------------------------------------- */

describe('404 / 409 — the pedido and the NF-e', () => {
  it('no pedido ⇒ 404 AMAZON_PEDIDO_NAO_ENCONTRADO, after ONE read', async () => {
    const r = await reenviar({ pedidoId: PEDIDO_ID });
    expect(r).toMatchObject({
      status: 404,
      corpo: { code: CODIGO_ERRO_NFE_AMAZON.PEDIDO_NAO_ENCONTRADO },
    });
    expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error']);
    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
    expect(enfileiradas()).toEqual([]);
  });

  it.each([
    [
      'another conta’s ref (the id does not recompute)',
      pedido({ integracaoPedidoOuterRef: 'documents/integracao/outra-conta' }),
    ],
    ['a number that only LOOKS like an Amazon order', pedido({ numero: '171-9876543-2109877' })],
    [
      'a Shopee-shaped pedido',
      { numero: '240101ABCDEFGH', integracaoPedidoOuterRef: `documents/integracao/${CONTA}` },
    ],
    ['no ref', pedido({ integracaoPedidoOuterRef: null })],
  ])('★ not PROVED (%s) ⇒ 409 nao-amazon, no NF-e read', async (_nome, raw) => {
    semear(raw, { s1: nfe() });
    const r = await reenviar({ pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(r).toMatchObject({
      status: 409,
      corpo: { code: CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ELEGIVEL, motivo: 'nao-amazon' },
    });
    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
    expect(enfileiradas()).toEqual([]);
  });

  it.each([
    ['an explicit nfeId', { pedidoId: PEDIDO_ID, nfeId: 's1' }],
    ['no nfeId', { pedidoId: PEDIDO_ID }],
  ])(
    '★ the emission block ⇒ 409 emissao-bloqueada BEFORE any NF-e read (%s) — never a 404 or a slot miss',
    async (_nome, corpo) => {
      // No NF-e at all: a block judged after the slot would answer 404 / sem-nfe-aprovada.
      semear(pedido({ bloquearEmissaoNFe: true }), {});
      const r = await reenviar(corpo);
      expect(r).toMatchObject({
        status: 409,
        corpo: { code: CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ELEGIVEL, motivo: 'emissao-bloqueada' },
      });
      expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
      expect(fake.consultas).toEqual([]);
      expect(enfileiradas()).toEqual([]);
    },
  );

  it('an explicit nfeId with no document ⇒ 404 AMAZON_NFE_NAO_ENCONTRADA, its own sentence', async () => {
    semear(pedido(), { s2: nfe() });
    const r = await reenviar({ pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(r).toMatchObject({
      status: 404,
      corpo: { code: CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ENCONTRADA },
    });
    expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error']);
    expect(erroEnvioNfeAmazonSchema.parse(r.corpo).error).toMatch(/nada foi enfileirado/);
    expect(enfileiradas()).toEqual([]);
  });

  it('NEAR-MISS: a padded nfeId is ANOTHER document id (never trimmed) ⇒ 404, nothing enqueued', async () => {
    semear(pedido(), { s1: nfe() });
    const r = await reenviar({ pedidoId: PEDIDO_ID, nfeId: ' s1' });
    expect(r).toMatchObject({
      status: 404,
      corpo: { code: CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ENCONTRADA },
    });
    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`, `pedidos/${PEDIDO_ID}/nfev4/ s1`]);
    expect(enfileiradas()).toEqual([]);
  });

  it.each([
    ['cancelled', nfe({ estado: ESTADO_NFE.cancelada }), 'nao-aprovada'],
    ['still in flight', nfe({ estado: 'e' }), 'nao-aprovada'],
    ['approved without its proc', nfe({ xml_nfe_proc: null }), 'xml-ausente'],
    ['authorized in homologação', nfe({ xml_nfe_proc: proc('1', '1', '2') }), 'tpamb-homologacao'],
    ['★ a devolução (the sale gate)', nfe({ xml_nfe_proc: proc('1', '4') }), 'nfe-nao-e-de-venda'],
    [
      'an entrada note (the sale gate)',
      nfe({ xml_nfe_proc: proc('0', '1') }),
      'nfe-nao-e-de-venda',
    ],
  ])('an explicit nfeId %s ⇒ 409 with that motivo', async (_nome, doc, motivo) => {
    semear(pedido(), { s1: doc });
    const r = await reenviar({ pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(r).toMatchObject({
      status: 409,
      corpo: { code: CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ELEGIVEL, motivo },
    });
    expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error', 'motivo']);
    expect(enfileiradas()).toEqual([]);
    expect(linhasNfe()).toEqual([expect.objectContaining({ motivo, nfeId: 's1' })]);
  });

  it.each([
    ['no document at all', {}, 'sem-nfe-aprovada'],
    ['only a cancelled one', { s1: nfe({ estado: ESTADO_NFE.cancelada }) }, 'sem-nfe-aprovada'],
    [
      '★ the CLOSEST miss: not approved + homologação ⇒ the homologação one',
      { s1: nfe({ estado: 'e' }), s2: nfe({ xml_nfe_proc: proc('1', '1', '2') }) },
      'tpamb-homologacao',
    ],
    [
      'the closest miss: no proc + a devolução ⇒ the devolução (furthest down the ladder)',
      { s1: nfe({ xml_nfe_proc: null }), s2: nfe({ xml_nfe_proc: proc('1', '4') }) },
      'nfe-nao-e-de-venda',
    ],
    [
      'NEAR-MISS order reversed (the ladder, not the listing order)',
      { s1: nfe({ xml_nfe_proc: proc('1', '4') }), s2: nfe({ xml_nfe_proc: null }) },
      'nfe-nao-e-de-venda',
    ],
  ])('no nfeId, %s ⇒ 409 with the closest miss', async (_nome, docs, motivo) => {
    semear(pedido(), docs);
    const r = await reenviar({ pedidoId: PEDIDO_ID });
    expect(r).toMatchObject({ status: 409, corpo: { motivo } });
    expect(enfileiradas()).toEqual([]);
  });

  it('every 409 sentence comes from the table, by name, and says nothing was enqueued', () => {
    for (const [motivo, frase] of Object.entries(FRASES_NAO_ELEGIVEL_REENVIO_NFE_AMAZON)) {
      expect(frase, motivo).toMatch(/^[A-Z]/);
      expect(frase, motivo).not.toMatch(/\.$/);
      expect(frase, motivo).not.toMatch(/\d{8,}/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                          an enqueue that fails                             */
/* -------------------------------------------------------------------------- */

/** The ONE ERROR line a propagated enqueue failure writes, by its `motivo`. */
function linhaDeFalha(motivo: string) {
  return expect.objectContaining({
    resultado: 'falhou',
    motivo,
    pedidoId: PEDIDO_ID,
    nfeId: 's1',
  });
}

describe('an enqueue that fails for any reason but the valve PROPAGATES (rule 6; the platform answers 500)', () => {
  it('★ a Cloud Tasks transient ⇒ AmazonTarefasTransitoriasError, never a coded answer', async () => {
    semear(pedido(), { s1: nfe() });
    produtorReal({ falha: () => falhaDoFunctions('unavailable', 503) });
    await expect(reenviar({ pedidoId: PEDIDO_ID })).rejects.toBeInstanceOf(
      AmazonTarefasTransitoriasError,
    );
    // ONE ERROR line naming the class — never `enfileirado`: the outcome is unknown.
    expect(espiao.linhas.map((l) => l.nivel)).toEqual(['error']);
    expect(linhasNfe()).toEqual([linhaDeFalha('enfileiramento/AmazonTarefasTransitoriasError')]);
  });

  it('★ a RAW SDK failure (a missing grant: permission-denied 403) ⇒ rethrown SANITIZED — class, code, status; no SDK instance, cause or httpResponse — after ONE ERROR line', async () => {
    semear(pedido(), { s1: nfe() });
    const bruta = falhaDoFunctions('permission-denied', 403);
    produtorReal({ falha: () => bruta });
    const err: unknown = await reenviar({ pedidoId: PEDIDO_ID }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AmazonNfeEnfileiramentoFalhouError);
    expect(err).not.toBe(bruta);
    expect(err).toMatchObject({
      falha: 'FirebaseFunctionsError/functions/permission-denied',
      httpStatus: 403,
    });
    expect(Object.keys(err as object)).not.toContain('httpResponse');
    expect((err as Error).cause).toBeUndefined();
    // Nothing of the answered body, in the error or in the line.
    expect(JSON.stringify(err)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect((err as Error).message).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(espiao.linhas.map((l) => l.nivel)).toEqual(['error']);
    expect(linhasNfe()).toEqual([
      linhaDeFalha('enfileiramento/FirebaseFunctionsError/functions/permission-denied'),
    ]);
    expect(JSON.stringify(espiao.linhas)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  it('a missing region at the producer ⇒ MissingRegionError, untouched, after ONE ERROR line', async () => {
    semear(pedido(), { s1: nfe() });
    const err = new MissingRegionError('região ausente', [
      'AMAZON_TASKS_REGION',
      'FUNCTIONS_REGION',
    ]);
    produtorReal({
      fila: () => {
        throw err;
      },
    });
    await expect(reenviar({ pedidoId: PEDIDO_ID })).rejects.toBe(err);
    expect(linhasNfe()).toEqual([linhaDeFalha('enfileiramento/MissingRegionError')]);
  });

  it('a malformed region ⇒ AmazonNfeRegiaoDaFilaInvalidaError (a broken deploy)', async () => {
    semear(pedido(), { s1: nfe() });
    produtorReal({
      fila: () => {
        caminhoDaFilaNfeAmazon('regiao/errada');
        throw new Error('inalcançável');
      },
    });
    await expect(reenviar({ pedidoId: PEDIDO_ID })).rejects.toBeInstanceOf(
      AmazonNfeRegiaoDaFilaInvalidaError,
    );
  });

  it('a Firestore failure on the pedido read propagates untouched, with no line of its own', async () => {
    semear(pedido(), { s1: nfe() });
    const falha = new Error('leitura falhou');
    fake.falharLeitura(`pedidos/${PEDIDO_ID}`, falha);
    await expect(reenviar({ pedidoId: PEDIDO_ID })).rejects.toBe(falha);
    expect(enfileiradas()).toEqual([]);
    expect(espiao.linhas).toEqual([]);
  });
});
