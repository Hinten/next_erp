/**
 * The NF-e queue's producer (step 14, PR 14-c), offline: the path, the valve,
 * the ONE named enqueue (the trigger's, after the CloudEvent) and the unnamed
 * rest, driven with the Admin SDK's REAL error classes
 * (`testing/falhaDeEnfileiramento.ts`). No transport is real and no network is
 * reachable: the queue is a recording fake.
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { MissingRegionError } from '@delfrance/core/region';
import { AmazonError } from '@delfrance/integrations-amazon-sp-api';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { ErroAppAmazon } from '../core/erros';
import { AmazonTarefasDesligadasError } from '../notificacoes/agendador';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { falhaDeTarefaJaExistente, falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  AmazonNfeRegiaoDaFilaInvalidaError,
  AmazonNfeTarefasDesligadasError,
  type FilaNfeAmazon,
  caminhoDaFilaNfeAmazon,
  criarAgendadorNfeAmazon,
  idDaTarefaDoGatilhoNfeAmazon,
} from './agendadorNfe';
import {
  FILA_NFE_AMAZON,
  ESCADA_VERIFICACAO_NFE_AMAZON_S,
  aposEnvioNfeAmazon,
  tarefaInicialNfeAmazon,
} from './tarefaNfe';

const PEDIDO_ID = makePedidoIdAmazon('conta-teste', '171-9876543-2109876');
const TAREFA = tarefaInicialNfeAmazon(PEDIDO_ID, 's1');
const EVENTO = 'evento-0001-sintetico';

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
 * Tasks, refuses a task id it already holds (the SDK's own 409).
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
  const fila: FilaNfeAmazon = {
    enqueue: (...args: Parameters<FilaNfeAmazon['enqueue']>) => enqueue(...args),
  };
  const resolver = vi.fn(() => fila);
  return { enqueue, resolver };
}

/** The rejection of one enqueue, or a failed test when it resolved. */
async function rejeicaoDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => expect.unreachable('o enqueue deveria ter rejeitado'),
    (e: unknown) => e,
  );
}

describe('caminhoDaFilaNfeAmazon — the region-qualified queue path', () => {
  it('is locations/<region>/functions/processAmazonNfeUpload', () => {
    expect(caminhoDaFilaNfeAmazon('xx-regiao1')).toBe(
      `locations/xx-regiao1/functions/${FILA_NFE_AMAZON}`,
    );
    expect(FILA_NFE_AMAZON).toBe('processAmazonNfeUpload');
  });

  it.each(['', 'a/b', '../x', 'XX-REGIAO1', ' xx', 'xx\n'])(
    'refuses the region %j: never another path, never a path to nowhere',
    (regiao) => {
      // NAMED (a deploy shape the task's no-throw boundary contains), still a TypeError.
      expect(() => caminhoDaFilaNfeAmazon(regiao)).toThrow(AmazonNfeRegiaoDaFilaInvalidaError);
      expect(() => caminhoDaFilaNfeAmazon(regiao)).toThrow(TypeError);
    },
  );
});

describe('idDaTarefaDoGatilhoNfeAmazon — the task id the CloudEvent names', () => {
  it('★ is the sha256 of the event id, 64 lowercase hex — inside the Cloud Tasks id grammar', () => {
    const esperado = createHash('sha256').update(EVENTO, 'utf8').digest('hex');
    expect(idDaTarefaDoGatilhoNfeAmazon(EVENTO)).toBe(esperado);
    expect(idDaTarefaDoGatilhoNfeAmazon(EVENTO)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the same event always yields the same id; another event, another id', () => {
    expect(idDaTarefaDoGatilhoNfeAmazon(EVENTO)).toBe(idDaTarefaDoGatilhoNfeAmazon(EVENTO));
    expect(idDaTarefaDoGatilhoNfeAmazon(`${EVENTO}x`)).not.toBe(
      idDaTarefaDoGatilhoNfeAmazon(EVENTO),
    );
  });

  it('carries no business value: neither the pedido nor the NF-e id', () => {
    const id = idDaTarefaDoGatilhoNfeAmazon(EVENTO);
    expect(id).not.toContain(PEDIDO_ID);
    expect(id).not.toContain('s1');
  });

  it('refuses an empty event id', () => {
    expect(() => idDaTarefaDoGatilhoNfeAmazon('')).toThrow(RangeError);
  });
});

describe('criarAgendadorNfeAmazon — the valve', () => {
  it('★ closed: BOTH entry points reject with AmazonNfeTarefasDesligadasError and the queue is NEVER resolved', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorNfeAmazon({ fila: resolver, desligado: true });

    await expect(agendador.enfileirarDoGatilho(TAREFA, EVENTO)).rejects.toBeInstanceOf(
      AmazonNfeTarefasDesligadasError,
    );
    await expect(agendador.enfileirar(TAREFA)).rejects.toBeInstanceOf(
      AmazonNfeTarefasDesligadasError,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('the valve error names the variable and the absent sweep, and is its OWN class', () => {
    const err = new AmazonNfeTarefasDesligadasError();
    expect(err.message).toContain('AMAZON_TASKS_DISABLED=1');
    expect(err.message).toContain('não há varredura de NF-e');
    expect(err.name).toBe('AmazonNfeTarefasDesligadasError');
    // The reads queue's class promises a sweep; a catch written for one must never take the other.
    expect(err).not.toBeInstanceOf(AmazonTarefasDesligadasError);
    expect(new AmazonTarefasDesligadasError()).not.toBeInstanceOf(AmazonNfeTarefasDesligadasError);
    expect(err).not.toBeInstanceOf(ErroAppAmazon);
    expect(err).not.toBeInstanceOf(AmazonError);
  });
});

describe('enfileirarDoGatilho — the ONE named enqueue', () => {
  it('★ sends the payload and the event-derived id, nothing else (no delay, no uri)', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorNfeAmazon({ fila: resolver, desligado: false });

    expect(await agendador.enfileirarDoGatilho(TAREFA, EVENTO)).toBe('enfileirada');
    // The WHOLE argument list.
    expect(enqueue.mock.calls).toEqual([[TAREFA, { id: idDaTarefaDoGatilhoNfeAmazon(EVENTO) }]]);
  });

  it('★ a redelivered event (the SAME id) answers ja-enfileirada with no error, and nothing new is enqueued', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorNfeAmazon({ fila: resolver, desligado: false });

    expect(await agendador.enfileirarDoGatilho(TAREFA, EVENTO)).toBe('enfileirada');
    expect(await agendador.enfileirarDoGatilho(TAREFA, EVENTO)).toBe('ja-enfileirada');
    // A DIFFERENT event (a new edge on the same NF-e) is a new task.
    expect(await agendador.enfileirarDoGatilho(TAREFA, `${EVENTO}-2`)).toBe('enfileirada');
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it('NEAR-MISS: a named 409 answered ABORTED is a TRANSIENT, never "already there"', async () => {
    const { resolver } = filaGravadora(() => falhaDeTarefaJaExistente('x', 'ABORTED'));
    const err = await rejeicaoDe(
      criarAgendadorNfeAmazon({ fila: resolver, desligado: false }).enfileirarDoGatilho(
        TAREFA,
        EVENTO,
      ),
    );
    expect(err).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('a 503 comes out named; a deploy failure and a missing region come out untouched', async () => {
    const t = await rejeicaoDe(
      criarAgendadorNfeAmazon({
        fila: filaGravadora(() => falhaDoFunctions('unknown-error')).resolver,
        desligado: false,
      }).enfileirarDoGatilho(TAREFA, EVENTO),
    );
    expect(t).toBeInstanceOf(AmazonTarefasTransitoriasError);

    const sdk = falhaDoFunctions('not-found', 404);
    expect(
      await rejeicaoDe(
        criarAgendadorNfeAmazon({
          fila: filaGravadora(() => sdk).resolver,
          desligado: false,
        }).enfileirarDoGatilho(TAREFA, EVENTO),
      ),
    ).toBe(sdk);

    const semRegiao = new MissingRegionError('sem região', ['AMAZON_TASKS_REGION']);
    expect(
      await rejeicaoDe(
        criarAgendadorNfeAmazon({
          fila: () => {
            throw semRegiao;
          },
          desligado: false,
        }).enfileirarDoGatilho(TAREFA, EVENTO),
      ),
    ).toBe(semRegiao);
  });
});

describe('enfileirar — every other enqueue, UNNAMED', () => {
  it('★ no delay: the payload ALONE — never an id', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorNfeAmazon({ fila: resolver, desligado: false });

    await agendador.enfileirar(TAREFA);
    await agendador.enfileirar(TAREFA, 0);
    expect(enqueue.mock.calls).toEqual([[TAREFA], [TAREFA]]);
  });

  it('★ a delay rides as scheduleDelaySeconds alone — still no id', async () => {
    const { enqueue, resolver } = filaGravadora();
    const verificacao = aposEnvioNfeAmazon(TAREFA, 'sem-nota', false);
    await criarAgendadorNfeAmazon({ fila: resolver, desligado: false }).enfileirar(
      verificacao,
      ESCADA_VERIFICACAO_NFE_AMAZON_S[0],
    );
    expect(enqueue.mock.calls).toEqual([[verificacao, { scheduleDelaySeconds: 60 }]]);
  });

  it('the queue is resolved PER enqueue, so a root reads its region at send time', async () => {
    const { resolver } = filaGravadora();
    const agendador = criarAgendadorNfeAmazon({ fila: resolver, desligado: false });
    await agendador.enfileirar(TAREFA);
    await agendador.enfileirar(TAREFA, 30);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'refuses the delay %s before touching the queue',
    async (atraso) => {
      const { enqueue, resolver } = filaGravadora();
      await expect(
        criarAgendadorNfeAmazon({ fila: resolver, desligado: false }).enfileirar(TAREFA, atraso),
      ).rejects.toBeInstanceOf(RangeError);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('a transient failure comes out named, a deploy one untouched', async () => {
    expect(
      await rejeicaoDe(
        criarAgendadorNfeAmazon({
          fila: filaGravadora(() => falhaDoFunctions('unknown-error', 429)).resolver,
          desligado: false,
        }).enfileirar(TAREFA),
      ),
    ).toBeInstanceOf(AmazonTarefasTransitoriasError);
    const sdk = falhaDoFunctions('permission-denied', 403);
    expect(
      await rejeicaoDe(
        criarAgendadorNfeAmazon({
          fila: filaGravadora(() => sdk).resolver,
          desligado: false,
        }).enfileirar(TAREFA),
      ),
    ).toBe(sdk);
  });
});

describe('the payload is the contract’s', () => {
  it('a payload outside the schema is refused before the queue — on both entry points, valve open or closed', async () => {
    const estranha = { ...TAREFA, contaId: 'conta-teste' } as unknown as typeof TAREFA;
    for (const desligado of [false, true]) {
      const { enqueue, resolver } = filaGravadora();
      const agendador = criarAgendadorNfeAmazon({ fila: resolver, desligado });
      await expect(agendador.enfileirarDoGatilho(estranha, EVENTO)).rejects.toBeInstanceOf(
        ZodError,
      );
      await expect(agendador.enfileirar(estranha)).rejects.toBeInstanceOf(ZodError);
      expect(enqueue).not.toHaveBeenCalled();
    }
  });
});
