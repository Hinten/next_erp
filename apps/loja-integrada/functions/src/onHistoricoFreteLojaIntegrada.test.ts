import { createHash } from 'node:crypto';

import { logger } from 'firebase-functions/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { historicoFreteInicialCollection } from '@delfrance/data/admin/collections';
import {
  ESTADO_FRETE,
  ESTADO_RASTREIO_LI,
  NOTIFICACAO_RESILIENCIA_STATUS,
  TIPO_TAREFA_ESCRITA_LI,
} from '@delfrance/schemas';

import type { AmbienteLi } from '../../lib/lojaIntegrada/core/valvulas';
import { idPedidoLi } from '../../lib/lojaIntegrada/pedidos/orderIdsLi';
import {
  type AgendadorEscritaLi,
  type FilaEscritaLi,
  type TarefaFilaEscritaLi,
  criarAgendadorEscritaLi,
} from '../../lib/lojaIntegrada/rastreio/agendadorEscrita';
import { FakeDb, asDb } from '../../lib/lojaIntegrada/testing/fakeDb';
import {
  falhaDoApp,
  falhaDoFunctions,
} from '../../lib/lojaIntegrada/testing/falhaDeEnfileiramento';
import { espiarStdout } from '../../lib/lojaIntegrada/testing/fixtures';
import { NUMERO_LI } from '../../lib/lojaIntegrada/testing/pedidosLi';
import { seedPedidoLi } from '../../lib/lojaIntegrada/testing/plataformaEscritaLi';

/**
 * The write-back TRIGGER (master plan step 7, PR 7-e): the ladder that turns a
 * freight history row into ONE named task on the writes queue — or into
 * nothing, as cheaply as possible.
 *
 * The trigger fires for EVERY channel's history rows (every `pedidos/*` freight
 * transition in the project), so the absences are the contract and they are
 * pinned HERE, by counting: the reads the fake Firestore served, the enqueue
 * calls the producer received, and every log line (the functions logger and the
 * app logger's stdout). An emulator cannot prove that a function did nothing.
 *
 * The producer is the REAL pure one (`criarAgendadorEscritaLi`) over a
 * recording transport, so already-exists, the valve and the transient naming
 * are the shipped classification, not a double's. D17: no network is reachable.
 */
const h = vi.hoisted(() => ({ db: null as unknown, agendador: null as unknown }));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));
vi.mock('./agendadorEscrita', () => ({
  criarAgendadorEscritaLiDoAmbiente: () => h.agendador,
}));

const { onHistoricoFreteLojaIntegrada, tratarHistoricoFreteLi } =
  await import('./onHistoricoFreteLojaIntegrada');

const CONTA = 'conta-li-1';
const PEDIDO_ID = idPedidoLi(CONTA, NUMERO_LI);
const HISTORICO_ID = 'evento-cloud-1';
const DATA_MS = 1_789_000_000_123;
const HORA_DO_EVENTO = '2026-10-26T12:00:00.000Z';
const COLECAO = 'notificacoesEscritaLojaIntegrada';

/** The expected event id, spelled out — never derived from the code under test. */
const EVENTO = createHash('sha256')
  .update(`historico:${PEDIDO_ID}/${HISTORICO_ID}`, 'utf8')
  .digest('hex');

let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let dbsPedidos: number;
let agendadoresCriados: number;
const chamadasDeRede: string[] = [];

interface Fila {
  readonly f: FilaEscritaLi;
  readonly chamadas: { payload: TarefaFilaEscritaLi; opcoes: { id: string } }[];
}

function fila(falha: Error | null = null): Fila {
  const chamadas: Fila['chamadas'] = [];
  return {
    chamadas,
    f: {
      enqueue: (payload, opcoes) => {
        chamadas.push({ payload, opcoes });
        return falha === null ? Promise.resolve() : Promise.reject(falha);
      },
    },
  };
}

function deps(
  ambiente: AmbienteLi,
  o: { fila?: Fila; desligado?: boolean } = {},
): Parameters<typeof tratarHistoricoFreteLi>[0] {
  const transporte = o.fila ?? fila();
  return {
    ambiente,
    db: () => {
      dbsPedidos += 1;
      return asDb(fake);
    },
    agendador: (): AgendadorEscritaLi => {
      agendadoresCriados += 1;
      return criarAgendadorEscritaLi({ fila: () => transporte.f, desligado: o.desligado ?? false });
    },
    logger,
  };
}

const LIGADO: AmbienteLi = { LOJA_INTEGRADA_MODO_RASTREIO: 'dry-run' };

function historico(over: Record<string, unknown> = {}) {
  return {
    pedidoId: PEDIDO_ID,
    historicoId: HISTORICO_ID,
    dados: { estado: ESTADO_FRETE.postado, data: DATA_MS, obs: null, ...over },
    horaDoEvento: HORA_DO_EVENTO,
  };
}

function seedPedido(over: Record<string, unknown> = {}): void {
  seedPedidoLi(fake, PEDIDO_ID, CONTA, { estado: ESTADO_FRETE.postado }, over);
}

/** Every line the app logger wrote to stdout, parsed. */
function linhasDoApp(): Record<string, unknown>[] {
  return stdout.escritas().map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Nothing at all was logged, by either sink. */
function nadaRegistrado(): void {
  expect(info).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(stdout.escritas()).toEqual([]);
}

beforeEach(() => {
  fake = new FakeDb();
  dbsPedidos = 0;
  agendadoresCriados = 0;
  stdout = espiarStdout();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  stdout.restaurar();
  info.mockRestore();
  warn.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

describe('T1 — the estado, from the created row: zero reads, no line', () => {
  it.each([
    ['aguardandoPostagem', ESTADO_FRETE.aguardandoPostagem],
    ['cancelado', ESTADO_FRETE.cancelado],
    ['aCaminho', ESTADO_FRETE.aCaminho],
    ['absent', undefined],
    ['another case', 'Postado'],
    ['a trailing space', 'postado '],
  ])('a row whose estado is %s ⇒ nothing read, nothing enqueued, nothing logged', async (_c, e) => {
    seedPedido();
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico({ estado: e }));

    expect(dbsPedidos).toBe(0);
    expect(fake.leituras).toEqual([]);
    expect(agendadoresCriados).toBe(0);
    expect(t.chamadas).toEqual([]);
    nadaRegistrado();
  });

  it('even with the valve UNRECOGNISED, a non-target estado logs nothing — the estado is the first rung', async () => {
    await tratarHistoricoFreteLi(
      deps({ LOJA_INTEGRADA_MODO_RASTREIO: 'ON' }),
      historico({ estado: ESTADO_FRETE.cancelado }),
    );
    expect(fake.leituras).toEqual([]);
    nadaRegistrado();
  });
});

describe('T2 — the valve: off reads nothing', () => {
  it.each([
    ['unset', {}],
    ['blank', { LOJA_INTEGRADA_MODO_RASTREIO: '' }],
    ['off', { LOJA_INTEGRADA_MODO_RASTREIO: 'off' }],
  ])('the valve %s ⇒ zero reads, zero enqueues, no line', async (_c, ambiente) => {
    seedPedido();
    const t = fila();

    await tratarHistoricoFreteLi(deps(ambiente, { fila: t }), historico());

    expect(dbsPedidos).toBe(0);
    expect(fake.leituras).toEqual([]);
    expect(t.chamadas).toEqual([]);
    nadaRegistrado();
  });

  it.each([['ON'], ['dry_run'], [' on'], ['true']])(
    'an UNRECOGNISED valve %j ⇒ ONE WARNING (valve fields only), zero reads, zero enqueues',
    async (valor) => {
      seedPedido();
      const t = fila();

      await tratarHistoricoFreteLi(
        deps({ LOJA_INTEGRADA_MODO_RASTREIO: valor }, { fila: t }),
        historico(),
      );

      expect(fake.leituras).toEqual([]);
      expect(t.chamadas).toEqual([]);
      const linhas = linhasDoApp();
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({
        severity: 'WARNING',
        evento: 'valvula',
        fluxo: 'rastreio',
        modo: 'off',
        modoReconhecido: false,
      });
      // Valve fields only: no conta, no order, never the variable's value.
      expect(Object.values(linhas[0] ?? {})).not.toContain(valor);
      expect(linhas[0]?.conta).toBeNull();
      expect(JSON.stringify(linhas[0])).not.toContain(PEDIDO_ID);
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

describe('T3/T4 — ONE pedido read, then the identity proof', () => {
  it('an absent pedido ⇒ exactly one read, zero enqueues, no line', async () => {
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico());

    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
    expect(t.chamadas).toEqual([]);
    expect(agendadoresCriados).toBe(0);
    nadaRegistrado();
  });

  it('a pedido that is NOT an imported Loja Integrada order ⇒ exactly one read, zero enqueues, no line', async () => {
    // Another channel's pedido: no Loja Integrada conta reference.
    seedPedido({ integracaoPedidoOuterRef: 'integracao/conta-ml-1' });
    fake.seed('integracao/conta-ml-1', { tipo: 'mercadoLivre' });
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico());

    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
    expect(t.chamadas).toEqual([]);
    nadaRegistrado();
  });

  it('⚠️ NEAR-MISS: a duplicate carrying the same conta and numero under ANOTHER id is not the order ⇒ nothing', async () => {
    const outroId = 'f'.repeat(64);
    seedPedidoLi(fake, outroId, CONTA, { estado: ESTADO_FRETE.postado });
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), {
      ...historico(),
      pedidoId: outroId,
    });

    expect(fake.leituras).toEqual([`pedidos/${outroId}`]);
    expect(t.chamadas).toEqual([]);
    nadaRegistrado();
  });
});

describe('T5 — the enqueue', () => {
  it('an imported LI order ⇒ ONE task, named `rastreio-<evento>`, ids and one enum only — and ONE INFO line', async () => {
    seedPedido();
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico());

    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
    expect(t.chamadas).toEqual([
      {
        payload: {
          tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
          contaId: CONTA,
          numero: String(NUMERO_LI),
          pedidoId: PEDIDO_ID,
          evento: EVENTO,
          estado: ESTADO_RASTREIO_LI.postado,
          eventoEmMs: DATA_MS,
        },
        opcoes: { id: `rastreio-${EVENTO}` },
      },
    ]);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[loja-integrada] onHistoricoFreteLojaIntegrada enfileirado',
      {
        pedidoId: PEDIDO_ID,
        contaId: CONTA,
        numero: String(NUMERO_LI),
        evento: EVENTO,
        estado: ESTADO_RASTREIO_LI.postado,
      },
    );
    expect(warn).not.toHaveBeenCalled();
    // No Firestore write on the happy path: the enqueue is a Cloud Tasks call.
    expect(fake.escritas).toEqual([]);
  });

  it.each([
    ['entregue', ESTADO_FRETE.entregue],
    ['aguardandoRetirada', ESTADO_FRETE.aguardandoRetirada],
  ])(
    'the %s estado enqueues too, whatever the pedido now says (the run judges freshness)',
    async (_c, e) => {
      seedPedido();
      const t = fila();

      await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico({ estado: e }));

      expect(t.chamadas.map((c) => (c.payload as { estado: string }).estado)).toEqual([e]);
    },
  );

  it('`on` enqueues exactly as `dry-run` does: the trigger never consults the canary', async () => {
    seedPedido();
    const t = fila();

    await tratarHistoricoFreteLi(
      deps({ LOJA_INTEGRADA_MODO_RASTREIO: 'on' }, { fila: t }),
      historico(),
    );

    expect(t.chamadas).toHaveLength(1);
  });

  it('the event clock is the row’s own `data` (ms); without one, the CloudEvent’s own time — never the wall clock', async () => {
    seedPedido();
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico({ data: null }));

    // HORA_DO_EVENTO, spelled out.
    expect((t.chamadas[0]?.payload as { eventoEmMs: number }).eventoEmMs).toBe(
      Date.UTC(2026, 9, 26, 12, 0, 0),
    );
  });

  it('a row whose `data` and event time both fail to read ⇒ ONE WARNING naming the field, nothing enqueued', async () => {
    seedPedido();
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), {
      ...historico({ data: 'ontem' }),
      horaDoEvento: 'não é uma data',
    });

    expect(t.chamadas).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ campos: ['eventoEmMs'] });
  });

  it('EQUAL pair: a redelivery of the same row names the SAME task; another row another', async () => {
    seedPedido();
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico());
    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico());
    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), {
      ...historico(),
      historicoId: 'evento-cloud-2',
    });

    const ids = t.chamadas.map((c) => c.opcoes.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('an answered `task-already-exists` is SUCCESS: nothing persisted, nothing thrown', async () => {
    seedPedido();
    const t = fila(falhaDoFunctions('task-already-exists', 409));

    await expect(
      tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), historico()),
    ).resolves.toBeUndefined();

    expect(t.chamadas).toHaveLength(1);
    expect(fake.ler(`${COLECAO}/${EVENTO}`)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, () => { fila?: Fila; desligado?: boolean }]>([
    ['the sweep-only valve closed', () => ({ desligado: true })],
    ['a Cloud Tasks 503', () => ({ fila: fila(falhaDoFunctions('unknown-error', 503)) })],
    ['a socket failure', () => ({ fila: fila(falhaDoApp('network-error')) })],
  ])(
    '%s ⇒ the event is persisted `failed` at its own id, ONE WARNING, nothing thrown',
    async (_c, o) => {
      seedPedido();

      await expect(tratarHistoricoFreteLi(deps(LIGADO, o()), historico())).resolves.toBeUndefined();

      expect(fake.ler(`${COLECAO}/${EVENTO}`)).toMatchObject({
        tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
        contaId: CONTA,
        numero: String(NUMERO_LI),
        pedidoId: PEDIDO_ID,
        evento: EVENTO,
        estado: ESTADO_RASTREIO_LI.postado,
        eventoEmMs: DATA_MS,
        status: NOTIFICACAO_RESILIENCIA_STATUS.failed,
      });
      expect(warn).toHaveBeenCalledOnce();
      expect(info).not.toHaveBeenCalled();
    },
  );

  it.each<[string, () => Error]>([
    ['permission denied (a broken deploy)', () => falhaDoFunctions('permission-denied', 403)],
    ['a coding bug', () => new TypeError('bug')],
  ])('%s ⇒ RETHROWN (Eventarc retries), nothing persisted', async (_c, falha) => {
    seedPedido();
    const err = falha();

    await expect(
      tratarHistoricoFreteLi(deps(LIGADO, { fila: fila(err) }), historico()),
    ).rejects.toBe(err);

    expect(fake.ler(`${COLECAO}/${EVENTO}`)).toBeUndefined();
  });

  it('a payload the task schema refuses (a conta id outside its grammar) ⇒ ONE WARNING, nothing enqueued or persisted', async () => {
    const conta = 'conta.li';
    const id = idPedidoLi(conta, NUMERO_LI);
    seedPedidoLi(fake, id, conta, { estado: ESTADO_FRETE.postado });
    const t = fila();

    await tratarHistoricoFreteLi(deps(LIGADO, { fila: t }), { ...historico(), pedidoId: id });

    expect(t.chamadas).toEqual([]);
    expect(fake.escritas).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    // The line names the refused FIELD, never its value.
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ pedidoId: id, campos: ['contaId'] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(conta);
  });
});

/* -------------------------------------------------------------------------- */
/*                          The deployed function                             */
/* -------------------------------------------------------------------------- */

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

describe('onHistoricoFreteLojaIntegrada — the declared options', () => {
  const gatilho = endpointOf(onHistoricoFreteLojaIntegrada).eventTrigger as {
    eventType?: string;
    eventFilters?: { database?: string };
    eventFilterPathPatterns?: { document?: string };
    retry?: boolean;
  };

  it('fires on CREATE of a freight history row, on the named `default` database, with retry', () => {
    expect(gatilho.eventType).toBe('google.cloud.firestore.document.v1.created');
    expect(gatilho.eventFilterPathPatterns?.document).toBe(
      `${historicoFreteInicialCollection.resolvePath({ pedidoId: '{pedidoId}' })}/{historicoId}`,
    );
    expect(gatilho.eventFilterPathPatterns?.document).toBe(
      'pedidos/{pedidoId}/historicoFtIni/{historicoId}',
    );
    expect(gatilho.eventFilters?.database).toBe('default');
    expect(gatilho.retry).toBe(true);
  });

  it('declares no secret and no region of its own', () => {
    expect(endpointOf(onHistoricoFreteLojaIntegrada).secretEnvironmentVariables ?? []).toEqual([]);
  });
});

describe('onHistoricoFreteLojaIntegrada — what the run binds', () => {
  function disparar(dados: Record<string, unknown>): Promise<unknown> {
    return (onHistoricoFreteLojaIntegrada as unknown as { run(e: unknown): Promise<unknown> }).run({
      data: { exists: true, data: () => dados },
      params: { pedidoId: PEDIDO_ID, historicoId: HISTORICO_ID },
      time: HORA_DO_EVENTO,
    });
  }

  it('the environment, the codebase db and the producer root: a row enqueues through them', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_RASTREIO', 'dry-run');
    h.db = asDb(fake);
    seedPedido();
    const t = fila();
    h.agendador = criarAgendadorEscritaLi({ fila: () => t.f, desligado: false });

    await disparar({ estado: ESTADO_FRETE.postado, data: DATA_MS });

    expect(t.chamadas.map((c) => c.opcoes.id)).toEqual([`rastreio-${EVENTO}`]);
  });

  it('the valve is read from the LIVE environment: unset ⇒ nothing', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_RASTREIO', undefined);
    h.db = asDb(fake);
    seedPedido();
    const t = fila();
    h.agendador = criarAgendadorEscritaLi({ fila: () => t.f, desligado: false });

    await disparar({ estado: ESTADO_FRETE.postado, data: DATA_MS });

    expect(t.chamadas).toEqual([]);
    expect(fake.leituras).toEqual([]);
  });
});
