/**
 * The writes-queue pipeline (master plan step 7, PR 7-d), offline, through the
 * REAL shared core (`@delfrance/data/admin/notifications`), the real run, the
 * real engine and the real aviso writer, against the fake Firestore and the
 * stateful platform (`testing/plataformaEscritaLi.ts`).
 *
 * D17: the global `fetch` is stubbed to throw; the platform is the only `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  MAX_TENTATIVAS,
  MAX_TENTATIVAS_DEFERRED,
  TASK_MAX_ATTEMPTS,
} from '@delfrance/data/admin/notifications';
import {
  ESTADO_FRETE,
  ESTADO_RASTREIO_LI,
  MOTIVO_RASTREIO_DIVERGENTE_LI,
  TIPO_TAREFA_ESCRITA_LI,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { EscritaRecusadaLiError } from '../core/erros';
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
  caminhoAviso,
  gravadorDeLog,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { NUMERO_LI } from '../testing/pedidosLi';
import {
  CAMINHO_ENVIO_LI,
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
  FILA_ESCRITA_LI,
  type PayloadEscritaRastreioLi,
  type PayloadTarefaEscritaLi,
  camposDoDocumentoEscritaLi,
  criarPipelineEscritaLi,
  dedupKeyEscritaLi,
  docIdEscritaLi,
  passagemFinalDoDocLi,
  persistirFalhaEscritaLi,
  sinalizarEsgotamentoEscritaLi,
  toDispositionEscritaLi,
  tratarTarefaEscritaLi,
  varrerEscritasLi,
} from './notificacaoEscrita';
import type { DepsEscritaLi } from './processarRastreio';

const ID = 'conta-li-1';
const PEDIDO_ID = idPedidoLi(ID, NUMERO_LI);
const CODIGO = 'PJ258408772BR';
const COLECAO = 'notificacoesEscritaLojaIntegrada';
const M = MOTIVO_RASTREIO_DIVERGENTE_LI;
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', () => {
    throw new Error('notificacaoEscrita.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

function ambiente(modo: string | null, canario: string | null = '*'): AmbienteLi {
  return {
    [CHAMADAS_ENV_LI]: MODO_LI.on,
    ...(modo === null ? {} : { [VALVULA_ENV_LI.rastreio]: modo }),
    ...(canario === null ? {} : { [CANARIO_ENV_LI.rastreio]: canario }),
  };
}

function payload(over: Partial<PayloadTarefaEscritaLi> = {}): PayloadTarefaEscritaLi {
  return {
    tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
    contaId: ID,
    numero: String(NUMERO_LI),
    pedidoId: PEDIDO_ID,
    evento: eventoDoHistoricoLi(PEDIDO_ID, 'h-1'),
    estado: ESTADO_RASTREIO_LI.postado,
    eventoEmMs: AGORA_MS - 60_000,
    ...over,
  };
}

interface Montagem {
  readonly db: FakeDb;
  readonly p: PlataformaEscritaLi;
  readonly erros: unknown[][];
  readonly avisos: unknown[][];
  readonly relogio: { ms: number };
  deps(o?: { ambiente?: AmbienteLi }): DepsEscritaLi;
}

function montar(
  o: { codigo?: string; mover?: boolean; codRastreio?: string | null } = {},
): Montagem {
  const db = new FakeDb();
  seedConta(db, ID, { nome: 'Loja X' });
  seedCredencial(db, ID);
  seedPedidoLi(db, PEDIDO_ID, ID, {
    estado: ESTADO_FRETE.postado,
    codRastreio: o.codRastreio === undefined ? CODIGO : o.codRastreio,
  });
  const p = criarPlataformaEscritaLi({ codigo: o.codigo, moverAoEscreverObjeto: o.mover });
  const erros: unknown[][] = [];
  const avisos: unknown[][] = [];
  const relogio = { ms: AGORA_MS };
  return {
    db,
    p,
    erros,
    avisos,
    relogio,
    deps: (d = {}) => ({
      ambiente: d.ambiente ?? ambiente(MODO_LI.on),
      esperar: p.esperar,
      agoraMs: () => relogio.ms,
      inicioDaTarefaMs: relogio.ms,
      increment,
      logger: {
        warn: (...args: unknown[]) => avisos.push(args),
        error: (...args: unknown[]) => erros.push(args),
      },
      registro: { escrever: gravadorDeLog().escrever, tentativa: null, idTarefa: null },
      fetch: p.fetch,
    }),
  };
}

const caminhoDe = (p: PayloadTarefaEscritaLi) => `${COLECAO}/${docIdEscritaLi(p)}`;
const avisoDe = (db: FakeDb) => db.ler(caminhoAviso(chaveDoAvisoRastreioLi(ID, PEDIDO_ID)));

/* -------------------------------------------------------------------------- */
/*                             The binding itself                             */
/* -------------------------------------------------------------------------- */

describe('the binding', () => {
  it('the queue name is the function name, fixed', () => {
    expect(FILA_ESCRITA_LI).toBe('filaEscritaLojaIntegrada');
  });

  it('doc id and dedup key = evento; the document carries the wire fields, named one by one', () => {
    const p = payload();
    expect(docIdEscritaLi(p)).toBe(p.evento);
    expect(dedupKeyEscritaLi(p)).toBe(p.evento);
    const comPassagem: PayloadEscritaRastreioLi = { ...p, passagemFinal: 'quente' };
    expect(camposDoDocumentoEscritaLi(comPassagem)).toEqual({
      tipo: p.tipo,
      contaId: p.contaId,
      numero: p.numero,
      pedidoId: p.pedidoId,
      evento: p.evento,
      estado: p.estado,
      eventoEmMs: p.eventoEmMs,
    });
  });

  it('`passagemFinal` is derived from the row, never persisted: the hot cap, the deferred cap, off by none', () => {
    const base = { ...payload(), erro: 'x', processedAt: 1 };
    expect(
      passagemFinalDoDocLi({ ...base, status: 'failed', tentativas: MAX_TENTATIVAS - 1 }),
    ).toBe('quente');
    expect(
      passagemFinalDoDocLi({ ...base, status: 'failed', tentativas: MAX_TENTATIVAS - 2 }),
    ).toBe(null);
    expect(
      passagemFinalDoDocLi({
        ...base,
        status: 'deferred',
        tentativas: MAX_TENTATIVAS_DEFERRED - 1,
      }),
    ).toBe('adiada');
    expect(
      passagemFinalDoDocLi({
        ...base,
        status: 'deferred',
        tentativas: MAX_TENTATIVAS_DEFERRED - 2,
      }),
    ).toBe(null);
    expect(passagemFinalDoDocLi({ ...base, status: 'parked', tentativas: 99 })).toBe(null);
  });

  it('the disposition table', () => {
    expect(toDispositionEscritaLi({ kind: 'escrito' }).kind).toBe('resolve');
    expect(toDispositionEscritaLi({ kind: 'ja-refletido' }).kind).toBe('resolve');
    expect(toDispositionEscritaLi({ kind: 'escrito-sem-conferencia' }).kind).toBe('resolve');
    expect(toDispositionEscritaLi({ kind: 'superado', motivo: 'evento-desatualizado' }).kind).toBe(
      'resolve',
    );
    for (const kind of ['pedido-inexistente', 'pedido-nao-li', 'conta-inexistente'] as const) {
      expect(toDispositionEscritaLi({ kind }).kind, kind).toBe('drop');
    }
    expect(toDispositionEscritaLi({ kind: 'desligado' })).toEqual({
      kind: 'defer',
      reason: 'desligado',
    });
    expect(
      toDispositionEscritaLi({ kind: 'adiado', motivo: 'dry-run', recusa: M.situacaoBloqueada }),
    ).toEqual({ kind: 'defer', reason: 'adiado/dry-run:situacao-bloqueada' });
    expect(
      toDispositionEscritaLi({ kind: 'adiado', motivo: 'conta-parada', recusa: null }),
    ).toEqual({ kind: 'defer', reason: 'adiado/conta-parada' });
    expect(
      toDispositionEscritaLi({ kind: 'recusado', motivo: M.escritaRecusada, status: 403 }),
    ).toEqual({ kind: 'park', reason: 'recusado/escrita-recusada/403' });
    expect(toDispositionEscritaLi({ kind: 'escrito-com-aviso', motivo: M.deriva })).toEqual({
      kind: 'park',
      reason: 'escrito-com-aviso/deriva',
    });
    expect(toDispositionEscritaLi({ kind: 'parcial', efeito: 'efeito-pendente' })).toEqual({
      kind: 'fail',
      reason: 'parcial/efeito-pendente',
    });
    expect(
      toDispositionEscritaLi({
        kind: 'recusa-deterministica',
        classe: 'LiConfigError',
        detalhe: 'corpo',
      }),
    ).toEqual({ kind: 'park', reason: 'recusa-deterministica/LiConfigError/corpo' });
  });
});

/* -------------------------------------------------------------------------- */
/*                          The task: dispositions                      */
/* -------------------------------------------------------------------------- */

describe('the task', () => {
  it('`off` ⇒ deferred row `desligado`, ZERO calls (kept, never dropped)', async () => {
    const m = montar();
    const r = await tratarTarefaEscritaLi(
      asDb(m.db),
      payload(),
      0,
      m.deps({ ambiente: ambiente(null) }),
    );
    expect(r.outcome).toBe('deferred');
    expect(m.db.ler(caminhoDe(payload()))).toMatchObject({ status: 'deferred', erro: 'desligado' });
    expect(m.p.requisicoes).toEqual([]);
  });

  it('dry-run ⇒ deferred row `adiado/dry-run`, zero PUTs, no aviso', async () => {
    const m = montar();
    const r = await tratarTarefaEscritaLi(
      asDb(m.db),
      payload(),
      0,
      m.deps({ ambiente: ambiente(MODO_LI.dryRun) }),
    );
    expect(r.outcome).toBe('deferred');
    expect(m.db.ler(caminhoDe(payload()))).toMatchObject({
      status: 'deferred',
      erro: 'adiado/dry-run',
    });
    expect(m.p.puts()).toEqual([]);
    expect(avisoDe(m.db)).toBeUndefined();
  });

  it('a written event persists NOTHING; a payload that does not parse is dropped', async () => {
    const m = montar();
    expect((await tratarTarefaEscritaLi(asDb(m.db), payload(), 0, m.deps())).outcome).toBe('done');
    expect(m.db.idsEm(COLECAO)).toEqual([]);
    expect(
      (await tratarTarefaEscritaLi(asDb(m.db), { tipo: 'varredura' }, 0, m.deps())).outcome,
    ).toBe('dropped');
  });

  it('(e) the park persist failing after a landed PUT: the retried attempt makes ZERO PUTs', async () => {
    const m = montar({ codRastreio: `${CODIGO} ` });
    m.db.falharEscrita(caminhoDe(payload()), grpc(14, 'unavailable'));
    await expect(tratarTarefaEscritaLi(asDb(m.db), payload(), 0, m.deps())).rejects.toThrow();
    expect(m.p.puts()).toHaveLength(1);
    m.db.falharEscrita(caminhoDe(payload()), null);
    expect((await tratarTarefaEscritaLi(asDb(m.db), payload(), 1, m.deps())).outcome).toBe(
      'parked',
    );
    expect(m.p.puts()).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                    A refusal retried through the REAL pipeline (the ladder)               */
/* -------------------------------------------------------------------------- */

/** Run the three task attempts, then hot passes until the row is gone or parked. */
async function escada(m: Montagem, passes: number): Promise<{ passeDoAviso: number | null }> {
  for (let tentativa = 0; tentativa < TASK_MAX_ATTEMPTS; tentativa += 1) {
    const r = tratarTarefaEscritaLi(asDb(m.db), payload(), tentativa, m.deps());
    if (tentativa < TASK_MAX_ATTEMPTS - 1) {
      await expect(r).rejects.toBeInstanceOf(EscritaRecusadaLiError);
    } else {
      expect((await r).outcome).toBe('failed');
    }
  }
  let passeDoAviso: number | null = null;
  for (let passe = 1; passe <= passes; passe += 1) {
    m.relogio.ms = AGORA_MS + passe * 2 * HORA_MS;
    await criarPipelineEscritaLi(m.deps()).reprocess(asDb(m.db), { now: m.relogio.ms });
    const aviso = avisoDe(m.db);
    if (passeDoAviso === null && aviso !== undefined && aviso.resolvidoEm === null) {
      passeDoAviso = passe;
    }
    if (m.db.ler(caminhoDe(payload()))?.status !== 'failed') break;
  }
  return { passeDoAviso };
}

describe('a write refused with a live token, retried through the real pipeline', () => {
  it('a permanent 403: 3 task attempts + 5 hot passes; the aviso fires on EXACTLY the 5th hot pass, then the 11 from the second base', async () => {
    const m = montar();
    for (let i = 0; i < 8; i += 1) {
      m.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    }
    const { passeDoAviso } = await escada(m, MAX_TENTATIVAS);
    expect(passeDoAviso).toBe(MAX_TENTATIVAS);
    expect(avisoDe(m.db)).toMatchObject({ params: { motivo: M.escritaRecusada, status: 403 } });
    expect(m.db.ler(caminhoDe(payload()))).toMatchObject({
      status: 'parked',
      erro: 'escrito-com-aviso/escrita-recusada',
    });
    // 8 × (GET, PUT code, GET confirm), then the fallback: one 11 PUT.
    expect(m.p.puts().map((r) => r.caminho)).toEqual([
      ...Array<string>(8).fill(CAMINHO_ENVIO_LI),
      CAMINHO_SITUACAO_LI,
    ]);
    // The conta was never parked: the token reads fine.
    expect(m.erros).toEqual([]);
  });

  it('a refusal that clears on hot pass 3 removes the row and raises NO aviso', async () => {
    const m = montar();
    for (let i = 0; i < 5; i += 1) {
      m.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    }
    const { passeDoAviso } = await escada(m, MAX_TENTATIVAS);
    expect(passeDoAviso).toBeNull();
    expect(m.db.ler(caminhoDe(payload()))).toBeUndefined();
    expect(m.p.puts().map((r) => r.caminho)).toEqual(Array<string>(6).fill(CAMINHO_ENVIO_LI));
  });

  it('a deferred row meeting a write refusal throws and GRADUATES with tentativas 0 — never concludes on the 7th daily pass', async () => {
    const m = montar();
    m.db.seed(caminhoDe(payload()), {
      ...payload(),
      status: 'deferred',
      tentativas: MAX_TENTATIVAS_DEFERRED - 1,
      erro: 'adiado/dry-run',
      processedAt: 1,
    });
    m.p.fila.push(naProxima(CAMINHO_ENVIO_LI, 'PUT', () => respostaJson(403, {})));
    await criarPipelineEscritaLi(m.deps()).reprocessDeferred(asDb(m.db), { now: AGORA_MS });
    expect(m.db.ler(caminhoDe(payload()))).toMatchObject({ status: 'failed', tentativas: 0 });
    expect(avisoDe(m.db)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                 Exhaustion: thrown, and returned on the last pass          */
/* -------------------------------------------------------------------------- */

describe('exhaustion', () => {
  it('a THROWN failure parked at the hot cap ⇒ ONE ERROR line (ids and the class) + aviso tentativas-esgotadas', async () => {
    const m = montar();
    m.db.seed(caminhoDe(payload()), {
      ...payload(),
      status: 'failed',
      tentativas: MAX_TENTATIVAS - 1,
      erro: 'x',
      processedAt: 1,
    });
    m.p.fila.push(naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(503, {})));
    await criarPipelineEscritaLi(m.deps()).reprocess(asDb(m.db), { now: AGORA_MS });
    expect(m.db.ler(caminhoDe(payload()))?.status).toBe('parked');
    expect(m.erros).toHaveLength(1);
    expect(JSON.stringify(m.erros[0])).toContain('LiHttpError');
    expect(avisoDe(m.db)).toMatchObject({ params: { motivo: M.tentativasEsgotadas } });
  });

  it('a returned `parcial` on its parking pass ⇒ the aviso on EXACTLY that pass, under `on`', async () => {
    const m = montar({ mover: false });
    m.db.seed(caminhoDe(payload()), {
      ...payload(),
      status: 'failed',
      tentativas: MAX_TENTATIVAS - 2,
      erro: 'x',
      processedAt: 1,
    });
    // Pass 4: not the last; the code lands, LI does not move ⇒ parcial, no aviso.
    await criarPipelineEscritaLi(m.deps()).reprocess(asDb(m.db), { now: AGORA_MS });
    expect(avisoDe(m.db)).toBeUndefined();
    // Pass 5 parks it: the aviso fires here (an 11 PUT lands first? no — LI holds our code at 4 ⇒ the 11).
    m.relogio.ms = AGORA_MS + 2 * HORA_MS;
    m.p.fila.push(naProxima(CAMINHO_SITUACAO_LI, 'PUT', () => respostaJson(202, undefined)));
    await criarPipelineEscritaLi(m.deps()).reprocess(asDb(m.db), { now: m.relogio.ms });
    expect(m.db.ler(caminhoDe(payload()))?.status).toBe('parked');
    expect(avisoDe(m.db)).toMatchObject({ params: { motivo: M.tentativasEsgotadas } });
  });

  it('a returned `adiado` on its 7th daily pass under dry-run ⇒ parked SILENTLY (no aviso)', async () => {
    const m = montar();
    m.db.seed(caminhoDe(payload()), {
      ...payload(),
      status: 'deferred',
      tentativas: MAX_TENTATIVAS_DEFERRED - 1,
      erro: 'adiado/dry-run',
      processedAt: 1,
    });
    await criarPipelineEscritaLi(m.deps({ ambiente: ambiente(MODO_LI.dryRun) })).reprocessDeferred(
      asDb(m.db),
      { now: AGORA_MS },
    );
    expect(m.db.ler(caminhoDe(payload()))?.status).toBe('parked');
    expect(avisoDe(m.db)).toBeUndefined();
  });

  it('the exhaustion signal outside `on` writes the ERROR line only', async () => {
    const m = montar();
    await sinalizarEsgotamentoEscritaLi(
      asDb(m.db),
      { ...payload(), passagemFinal: 'quente' },
      new TypeError('x'),
      m.deps({ ambiente: ambiente(MODO_LI.dryRun) }),
    );
    expect(m.erros).toHaveLength(1);
    expect(avisoDe(m.db)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                               The varredura                                */
/* -------------------------------------------------------------------------- */

function seedLinha(m: Montagem, n: number, status: 'failed' | 'deferred', processedAt: number) {
  const p = payload({ evento: eventoDoHistoricoLi(PEDIDO_ID, `h-${String(n)}`) });
  m.db.seed(caminhoDe(p), { ...p, status, tentativas: 0, erro: 'x', processedAt });
  return p;
}

describe('the varredura (on the writes queue)', () => {
  it('at `off` it touches NEITHER lane: a deferred row and a `parcial` row stay as they are, zero calls', async () => {
    const m = montar();
    const adiada = seedLinha(m, 1, 'deferred', 1);
    const parcial = seedLinha(m, 2, 'failed', 1);
    const antes = [m.db.ler(caminhoDe(adiada)), m.db.ler(caminhoDe(parcial))];
    const r = await varrerEscritasLi(asDb(m.db), m.deps({ ambiente: ambiente(null) }), 140_000);
    expect(r.desligado).toBe(true);
    expect([m.db.ler(caminhoDe(adiada)), m.db.ler(caminhoDe(parcial))]).toEqual(antes);
    expect(m.p.requisicoes).toEqual([]);
  });

  it('runs the hot lane then the deferred one, oldest first, ONE row per reprocess call', async () => {
    const m = montar();
    const velha = seedLinha(m, 1, 'failed', 1);
    seedLinha(m, 2, 'failed', 2);
    seedLinha(m, 3, 'deferred', 3);
    m.p.fila.push(naProxima(CAMINHO_PEDIDO_LI, 'GET', () => respostaJson(503, {})));
    const r = await varrerEscritasLi(asDb(m.db), m.deps(), 140_000);
    expect(r.desligado).toBe(false);
    // The oldest ran FIRST: it met the 503 and was re-marked; the others resolved.
    expect(m.db.ler(caminhoDe(velha))).toMatchObject({ status: 'failed', tentativas: 1 });
    expect(r.quente.processadas + r.quente.erros).toBe(2);
    expect(r.adiada.processadas).toBe(1);
  });

  it('stops taking rows when the budget runs out', async () => {
    const m = montar();
    seedLinha(m, 1, 'failed', 1);
    seedLinha(m, 2, 'failed', 2);
    seedLinha(m, 3, 'failed', 3);
    let passos = 0;
    const deps = m.deps();
    const r = await varrerEscritasLi(
      asDb(m.db),
      {
        ...deps,
        agoraMs: () => {
          passos += 1;
          return AGORA_MS + passos * 60_000;
        },
      },
      150_000,
    );
    expect(r.quente.parada).toBe('orcamento');
    expect(m.db.idsEm(COLECAO).length).toBeGreaterThan(0);
  });

  it('a row whose remove AND mark both fail makes at most ONE process call, and ends the lane with ONE WARNING', async () => {
    const m = montar();
    const p = seedLinha(m, 1, 'failed', 1);
    m.db.falharEscrita(caminhoDe(p), grpc(14, 'unavailable'));
    const r = await varrerEscritasLi(asDb(m.db), m.deps(), 140_000);
    expect(r.quente.parada).toBe('repetida');
    // ONE process: its guard GET, the code PUT (the write landed; the bookkeeping
    // failed), its read-back and its history read — and nothing of a second run.
    expect(m.p.chamadas()).toEqual([
      `GET ${CAMINHO_PEDIDO_LI}`,
      `PUT ${CAMINHO_ENVIO_LI}`,
      `GET ${CAMINHO_PEDIDO_LI}`,
      'GET /v1/situacao_historico/search/',
    ]);
    expect(m.avisos.filter((a) => String(a[0]).includes('varredura'))).toHaveLength(1);
  });

  it('persistirFalhaEscritaLi records `failed` at the deterministic id; a second record is ignored', async () => {
    const m = montar();
    await persistirFalhaEscritaLi(asDb(m.db), payload(), 'transitoria');
    await persistirFalhaEscritaLi(asDb(m.db), payload(), 'outra');
    expect(m.db.ler(caminhoDe(payload()))).toMatchObject({ status: 'failed', erro: 'transitoria' });
    expect(DIA_MS).toBeGreaterThan(HORA_MS);
  });
});
