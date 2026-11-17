/**
 * The Easy Ship scheduling queue's producer (step 15, PR 15-c), offline: the
 * path, the valve, the ONE named entry enqueue (per OBSERVATION, never per
 * pedido) and the unnamed re-enqueues, driven with the Admin SDK's REAL error
 * classes (`testing/falhaDeEnfileiramento.ts`). No transport is real and no
 * network is reachable: the queue is a recording fake that, like Cloud Tasks,
 * refuses a name it already holds.
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { MissingRegionError } from '@delfrance/core/region';
import { AmazonError } from '@delfrance/integrations-amazon-sp-api';

import { ErroAppAmazon } from '../core/erros';
import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { AmazonNfeTarefasDesligadasError } from '../nfe/agendadorNfe';
import { AmazonTarefasDesligadasError } from '../notificacoes/agendador';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { falhaDeTarefaJaExistente, falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  AmazonAgendamentoRegiaoDaFilaInvalidaError,
  AmazonAgendamentoTarefasDesligadasError,
  type FilaAgendamentoAmazon,
  caminhoDaFilaAgendamentoAmazon,
  criarAgendadorAgendamentoAmazon,
} from './agendadorAgendamento';
import {
  ATRASO_AGENDAMENTO_DO_ACEITE_S,
  FILA_AGENDAMENTO_AMAZON,
  ORIGEM_AGENDAMENTO_AMAZON,
  PAUSAS_AGENDAMENTO_AMAZON_S,
  idDaTarefaDeAgendamentoAmazon,
  pausaAgendamentoAmazon,
  tarefaInicialAgendamentoAmazon,
} from './tarefaAgendamento';

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const ID_TAREFA_NFE = 'tarefa-nfe-sintetica-0001';
const WATERMARK_US = 1_790_000_000_000_000;

const ACEITE = tarefaInicialAgendamentoAmazon(
  PEDIDO_ID,
  CONTA,
  ORDER,
  ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe,
);
const IMPORTACAO = tarefaInicialAgendamentoAmazon(
  PEDIDO_ID,
  CONTA,
  ORDER,
  ORIGEM_AGENDAMENTO_AMAZON.importacao,
);
const OBS_ACEITE = { origem: ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe, idTarefaNfe: ID_TAREFA_NFE };
const OBS_IMPORTACAO = {
  origem: ORIGEM_AGENDAMENTO_AMAZON.importacao,
  pedidoId: PEDIDO_ID,
  watermarkUs: WATERMARK_US,
};

/** Every `fetch` is a failure: the producer must never reach the network itself. */
const chamadasDeRede: string[] = [];
vi.stubGlobal('fetch', (input: unknown) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
});
afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/**
 * A queue that records every enqueue with ALL its arguments and, like Cloud
 * Tasks, refuses a task id it already holds (the SDK's own 409) — a name stays
 * held after its task ran (a tombstone).
 */
function filaGravadora(falha?: () => unknown) {
  const ids = new Set<string>();
  const enqueue = vi.fn((...args: unknown[]): Promise<void> => {
    if (falha !== undefined) return Promise.reject(falha());
    const id = (args[1] as { id?: string } | undefined)?.id;
    if (id !== undefined) {
      if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
      ids.add(id);
    }
    return Promise.resolve();
  });
  const fila: FilaAgendamentoAmazon = {
    enqueue: (...args: Parameters<FilaAgendamentoAmazon['enqueue']>) => enqueue(...args),
  };
  const resolver = vi.fn(() => fila);
  return { enqueue, resolver, ids };
}

/** The rejection of one enqueue, or a failed test when it resolved. */
async function rejeicaoDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => expect.unreachable('o enqueue deveria ter rejeitado'),
    (e: unknown) => e,
  );
}

describe('caminhoDaFilaAgendamentoAmazon — the region-qualified queue path', () => {
  it('is locations/<region>/functions/processAmazonEasyShipSchedule', () => {
    expect(caminhoDaFilaAgendamentoAmazon('xx-regiao1')).toBe(
      `locations/xx-regiao1/functions/${FILA_AGENDAMENTO_AMAZON}`,
    );
    expect(FILA_AGENDAMENTO_AMAZON).toBe('processAmazonEasyShipSchedule');
  });

  it.each(['', 'a/b', '../x', 'XX-REGIAO1', ' xx', 'xx\n'])(
    'refuses the region %j: never another path, never a path to nowhere',
    (regiao) => {
      // NAMED (a deploy shape the entries answer as deterministic), still a TypeError.
      expect(() => caminhoDaFilaAgendamentoAmazon(regiao)).toThrow(
        AmazonAgendamentoRegiaoDaFilaInvalidaError,
      );
      expect(() => caminhoDaFilaAgendamentoAmazon(regiao)).toThrow(TypeError);
    },
  );
});

describe('criarAgendadorAgendamentoAmazon — the valve', () => {
  it('★ closed: BOTH entry points reject with AmazonAgendamentoTarefasDesligadasError and the queue is NEVER resolved', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: true });

    await expect(agendador.enfileirarEntrada(ACEITE, OBS_ACEITE, 60)).rejects.toBeInstanceOf(
      AmazonAgendamentoTarefasDesligadasError,
    );
    await expect(agendador.enfileirar(ACEITE)).rejects.toBeInstanceOf(
      AmazonAgendamentoTarefasDesligadasError,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('the valve error names the variable and the absent sweep, and is its OWN class', () => {
    const err = new AmazonAgendamentoTarefasDesligadasError();
    expect(err.message).toContain('AMAZON_TASKS_DISABLED=1');
    expect(err.message).toContain('não há varredura de agendamento');
    expect(err.name).toBe('AmazonAgendamentoTarefasDesligadasError');
    // Each queue's valve promises its own remedy: a catch written for one never takes another.
    expect(err).not.toBeInstanceOf(AmazonTarefasDesligadasError);
    expect(err).not.toBeInstanceOf(AmazonNfeTarefasDesligadasError);
    expect(new AmazonNfeTarefasDesligadasError()).not.toBeInstanceOf(
      AmazonAgendamentoTarefasDesligadasError,
    );
    expect(err).not.toBeInstanceOf(ErroAppAmazon);
    expect(err).not.toBeInstanceOf(AmazonError);
  });
});

describe('enfileirarEntrada — the ONE named enqueue, per OBSERVATION', () => {
  it('★ E1: the payload, the NF-e dispatch’s name and the 60-s delay — nothing else (no uri)', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });

    expect(
      await agendador.enfileirarEntrada(ACEITE, OBS_ACEITE, ATRASO_AGENDAMENTO_DO_ACEITE_S),
    ).toBe('enfileirada');
    const esperado = createHash('sha256')
      .update(`agendamento:aceite:${ID_TAREFA_NFE}`, 'utf8')
      .digest('hex');
    // The WHOLE argument list.
    expect(enqueue.mock.calls).toEqual([[ACEITE, { id: esperado, scheduleDelaySeconds: 60 }]]);
    expect(idDaTarefaDeAgendamentoAmazon(OBS_ACEITE)).toBe(esperado);
  });

  it('★ E2: the payload and the import read’s name — no delay', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });

    expect(await agendador.enfileirarEntrada(IMPORTACAO, OBS_IMPORTACAO)).toBe('enfileirada');
    expect(await agendador.enfileirarEntrada(IMPORTACAO, OBS_IMPORTACAO, 0)).toBe('ja-enfileirada');
    const esperado = createHash('sha256')
      .update(`agendamento:importacao:${PEDIDO_ID}:${String(WATERMARK_US)}`, 'utf8')
      .digest('hex');
    expect(enqueue.mock.calls).toEqual([
      [IMPORTACAO, { id: esperado }],
      [IMPORTACAO, { id: esperado }],
    ]);
  });

  it('★ the SAME observation again answers ja-enfileirada with no error; a NEW one lands under a new name', async () => {
    const { enqueue, resolver, ids } = filaGravadora();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });

    expect(await agendador.enfileirarEntrada(ACEITE, OBS_ACEITE, 60)).toBe('enfileirada');
    // An NF-e queue retry of the SAME dispatch: the same name, already durable.
    expect(await agendador.enfileirarEntrada(ACEITE, OBS_ACEITE, 60)).toBe('ja-enfileirada');
    // A re-drive's NEW NF-e task: a new observation.
    expect(
      await agendador.enfileirarEntrada(ACEITE, { ...OBS_ACEITE, idTarefaNfe: 'outra' }, 60),
    ).toBe('enfileirada');
    // A newer import read of the same pedido: a new observation too.
    expect(
      await agendador.enfileirarEntrada(IMPORTACAO, {
        ...OBS_IMPORTACAO,
        watermarkUs: WATERMARK_US + 1,
      }),
    ).toBe('enfileirada');
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(ids.size).toBe(3);
  });

  it('★ (mutation 3) THE TOMBSTONE CASE: an E1 name already held does not swallow the E2 of the same pedido', async () => {
    const { resolver, ids } = filaGravadora();
    // The E1 task RAN (whatever it concluded): Cloud Tasks still holds its name.
    ids.add(idDaTarefaDeAgendamentoAmazon(OBS_ACEITE));
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });
    expect(await agendador.enfileirarEntrada(IMPORTACAO, OBS_IMPORTACAO)).toBe('enfileirada');
    expect(ids.size).toBe(2);
  });

  it('an E1 observation with NO NF-e task id enqueues UNNAMED — never a name every such enqueue shares', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });
    const semId = { origem: ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe, idTarefaNfe: null };

    expect(await agendador.enfileirarEntrada(ACEITE, semId, 60)).toBe('enfileirada');
    expect(await agendador.enfileirarEntrada(ACEITE, semId)).toBe('enfileirada');
    expect(enqueue.mock.calls).toEqual([[ACEITE, { scheduleDelaySeconds: 60 }], [ACEITE]]);
  });

  it('NEAR-MISS: an UNNAMED entry enqueue’s 409 is never "already there" — only a NAMED one can meet a held id — it comes out a TRANSIENT', async () => {
    const { resolver } = filaGravadora(() => falhaDeTarefaJaExistente('x'));
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });
    const semId = { origem: ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe, idTarefaNfe: null };
    expect(await rejeicaoDe(agendador.enfileirarEntrada(ACEITE, semId, 60))).toBeInstanceOf(
      AmazonTarefasTransitoriasError,
    );
    // Control: the SAME 409 on a NAMED enqueue is that observation already durable.
    expect(await agendador.enfileirarEntrada(ACEITE, OBS_ACEITE, 60)).toBe('ja-enfileirada');
  });

  it('NEAR-MISS: a named 409 answered ABORTED is a TRANSIENT, never "already there"', async () => {
    const { resolver } = filaGravadora(() => falhaDeTarefaJaExistente('x', 'ABORTED'));
    const err = await rejeicaoDe(
      criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false }).enfileirarEntrada(
        IMPORTACAO,
        OBS_IMPORTACAO,
      ),
    );
    expect(err).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('a 503 comes out named; a deploy failure and a missing region come out untouched', async () => {
    const t = await rejeicaoDe(
      criarAgendadorAgendamentoAmazon({
        fila: filaGravadora(() => falhaDoFunctions('unknown-error')).resolver,
        desligado: false,
      }).enfileirarEntrada(ACEITE, OBS_ACEITE, 60),
    );
    expect(t).toBeInstanceOf(AmazonTarefasTransitoriasError);

    const sdk = falhaDoFunctions('not-found', 404);
    expect(
      await rejeicaoDe(
        criarAgendadorAgendamentoAmazon({
          fila: filaGravadora(() => sdk).resolver,
          desligado: false,
        }).enfileirarEntrada(ACEITE, OBS_ACEITE, 60),
      ),
    ).toBe(sdk);

    const semRegiao = new MissingRegionError('sem região', ['AMAZON_TASKS_REGION']);
    expect(
      await rejeicaoDe(
        criarAgendadorAgendamentoAmazon({
          fila: () => {
            throw semRegiao;
          },
          desligado: false,
        }).enfileirarEntrada(IMPORTACAO, OBS_IMPORTACAO),
      ),
    ).toBe(semRegiao);
  });

  it('an observation that is not the payload’s own is refused before the queue (another origin, another pedido)', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });
    await expect(agendador.enfileirarEntrada(ACEITE, OBS_IMPORTACAO)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(agendador.enfileirarEntrada(IMPORTACAO, OBS_ACEITE)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      agendador.enfileirarEntrada(IMPORTACAO, {
        ...OBS_IMPORTACAO,
        pedidoId: makePedidoIdAmazon(CONTA, '171-0000000-0000000'),
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('enfileirar — the task’s own re-enqueues, UNNAMED', () => {
  it('★ (mutation 4) no delay: the payload ALONE — never an id', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });

    await agendador.enfileirar(ACEITE);
    await agendador.enfileirar(ACEITE, 0);
    expect(enqueue.mock.calls).toEqual([[ACEITE], [ACEITE]]);
  });

  it('★ a delay rides as scheduleDelaySeconds alone — still no id, and the SAME payload twice lands twice', async () => {
    const { enqueue, resolver } = filaGravadora();
    const pausa = pausaAgendamentoAmazon(ACEITE);
    expect(pausa).not.toBeNull();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });
    await agendador.enfileirar(pausa!, PAUSAS_AGENDAMENTO_AMAZON_S[0]);
    await agendador.enfileirar(pausa!, PAUSAS_AGENDAMENTO_AMAZON_S[0]);
    expect(enqueue.mock.calls).toEqual([
      [pausa, { scheduleDelaySeconds: 30 }],
      [pausa, { scheduleDelaySeconds: 30 }],
    ]);
  });

  it('the queue is resolved PER enqueue, so a root reads its region at send time', async () => {
    const { resolver } = filaGravadora();
    const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });
    await agendador.enfileirar(ACEITE);
    await agendador.enfileirarEntrada(ACEITE, OBS_ACEITE, 60);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'refuses the delay %s before touching the queue (both entry points)',
    async (atraso) => {
      const { enqueue, resolver } = filaGravadora();
      const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado: false });
      await expect(agendador.enfileirar(ACEITE, atraso)).rejects.toBeInstanceOf(RangeError);
      await expect(agendador.enfileirarEntrada(ACEITE, OBS_ACEITE, atraso)).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('a transient failure comes out named, a deploy one untouched', async () => {
    expect(
      await rejeicaoDe(
        criarAgendadorAgendamentoAmazon({
          fila: filaGravadora(() => falhaDoFunctions('unknown-error', 429)).resolver,
          desligado: false,
        }).enfileirar(ACEITE),
      ),
    ).toBeInstanceOf(AmazonTarefasTransitoriasError);
    const sdk = falhaDoFunctions('permission-denied', 403);
    expect(
      await rejeicaoDe(
        criarAgendadorAgendamentoAmazon({
          fila: filaGravadora(() => sdk).resolver,
          desligado: false,
        }).enfileirar(ACEITE),
      ),
    ).toBe(sdk);
  });
});

describe('the payload is the contract’s', () => {
  it('a payload outside the schema is refused before the queue — on both entry points, valve open or closed', async () => {
    const estranha = { ...ACEITE, url: 'x' } as unknown as typeof ACEITE;
    for (const desligado of [false, true]) {
      const { enqueue, resolver } = filaGravadora();
      const agendador = criarAgendadorAgendamentoAmazon({ fila: resolver, desligado });
      await expect(agendador.enfileirarEntrada(estranha, OBS_ACEITE, 60)).rejects.toBeInstanceOf(
        ZodError,
      );
      await expect(agendador.enfileirar(estranha)).rejects.toBeInstanceOf(ZodError);
      expect(enqueue).not.toHaveBeenCalled();
    }
  });
});
