/**
 * The stock queue's producer (step 12, PR 12-e1), offline: the path, the
 * valve, the payload's OWN name, the read-back named after the submission (and
 * refused for an origem that earns none), the unnamed pause, the delay in
 * WHOLE seconds, the bounded batch, and the shared transient naming, driven
 * with the Admin SDK's REAL error classes (`testing/falhaDeEnfileiramento.ts`).
 * No transport is real and no network is reachable: the queue is a recording
 * fake that, like Cloud Tasks, refuses a name it already holds.
 */
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { AmazonLotesTarefasDesligadasError } from '../feeds/agendadorLotes';
import { AmazonNfeTarefasDesligadasError } from '../nfe/agendadorNfe';
import { AmazonTarefasDesligadasError } from '../notificacoes/agendador';
import {
  falhaDeConflitoDoTasks,
  falhaDeTarefaJaExistente,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import {
  ATRASO_PAUSA_ESTOQUE_S,
  ATRASO_VERIFICACAO_ESTOQUE_S,
  AmazonEstoqueRegiaoDaFilaInvalidaError,
  AmazonEstoqueTarefasDesligadasError,
  FILA_ESTOQUE_AMAZON,
  type FilaEstoqueAmazon,
  LARGURA_LOTE_ESTOQUE_AMAZON,
  MAX_ATRASO_ESTOQUE_S,
  caminhoDaFilaEstoqueAmazon,
  criarProdutorEstoqueAmazon,
} from './produtorEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type OrigemTarefaEstoqueAmazon,
  type TarefaEstoqueAmazon,
  nomeDaTarefaEstoque,
  nomeTarefaEstoque,
  tarefaEstoqueAmazonSchema,
} from './tarefaEstoque';

const CONTA = 'conta-teste';
const SKU = 'SKU-1';
const OBS = '1800000000.000000005';
const SUBMISSAO = 'f1e2d3c4b5a69788';

function tarefa(over: Partial<TarefaEstoqueAmazon> = {}): TarefaEstoqueAmazon {
  return tarefaEstoqueAmazonSchema.parse({
    v: 1,
    contaId: CONTA,
    sku: SKU,
    origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
    referencia: OBS,
    depositoId: null,
    ...over,
  });
}

const DELTA = tarefa();
const RECONCILIACAO = tarefa({
  origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao,
  referencia: 'exec-0001',
  depositoId: 'deposito-1',
});

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
function filaGravadora(falha?: (payload: TarefaEstoqueAmazon) => unknown) {
  const ids = new Set<string>();
  const enqueue = vi.fn((...args: unknown[]): Promise<void> => {
    const erro = falha?.(args[0] as TarefaEstoqueAmazon);
    if (erro !== undefined) return Promise.reject(erro);
    const id = (args[1] as { id?: string } | undefined)?.id;
    if (id !== undefined) {
      if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
      ids.add(id);
    }
    return Promise.resolve();
  });
  const fila: FilaEstoqueAmazon = {
    enqueue: (...args: Parameters<FilaEstoqueAmazon['enqueue']>) => enqueue(...args),
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

describe('caminhoDaFilaEstoqueAmazon — the region-qualified queue path', () => {
  it('is locations/<region>/functions/processAmazonStockPatch', () => {
    expect(FILA_ESTOQUE_AMAZON).toBe('processAmazonStockPatch');
    expect(caminhoDaFilaEstoqueAmazon('xx-regiao1')).toBe(
      'locations/xx-regiao1/functions/processAmazonStockPatch',
    );
  });

  it.each(['', 'a/b', '../x', 'XX-REGIAO1', ' xx', 'xx\n'])(
    'refuses the region %j: never another path, never a path to nowhere',
    (regiao) => {
      expect(() => caminhoDaFilaEstoqueAmazon(regiao)).toThrow(
        AmazonEstoqueRegiaoDaFilaInvalidaError,
      );
      expect(() => caminhoDaFilaEstoqueAmazon(regiao)).toThrow(TypeError);
    },
  );
});

describe('criarProdutorEstoqueAmazon — the valve', () => {
  it('★ closed: every entry rejects with the stock queue’s OWN class and the queue is NEVER resolved', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: true });

    const erros = [
      await rejeicaoDe(produtor.enfileirar(DELTA)),
      await rejeicaoDe(produtor.enfileirarLote([DELTA])),
      await rejeicaoDe(produtor.enfileirarVerificacao(DELTA, SUBMISSAO)),
      await rejeicaoDe(produtor.enfileirarPausa(DELTA)),
    ];
    for (const erro of erros) {
      expect(erro).toBeInstanceOf(AmazonEstoqueTarefasDesligadasError);
      // Never another queue's class: each promises a different remedy.
      expect(erro).not.toBeInstanceOf(AmazonLotesTarefasDesligadasError);
      expect(erro).not.toBeInstanceOf(AmazonTarefasDesligadasError);
      expect(erro).not.toBeInstanceOf(AmazonNfeTarefasDesligadasError);
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('criarProdutorEstoqueAmazon — the name is the payload’s own', () => {
  it('★ the same observation twice is ONE task (ja-enfileirada); a new observation is a new name', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });
    const outra = tarefa({ referencia: '1800000000.000000006' });

    await expect(produtor.enfileirar(DELTA)).resolves.toBe('enfileirada');
    await expect(produtor.enfileirar(DELTA)).resolves.toBe('ja-enfileirada');
    await expect(produtor.enfileirar(outra)).resolves.toBe('enfileirada');
    expect(enqueue.mock.calls).toEqual([
      [DELTA, { id: nomeDaTarefaEstoque(DELTA) }],
      [DELTA, { id: nomeDaTarefaEstoque(DELTA) }],
      [outra, { id: nomeDaTarefaEstoque(outra) }],
    ]);
    expect(nomeDaTarefaEstoque(DELTA)).toBe(
      nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.delta, CONTA, SKU, OBS),
    );
  });

  it('★ NEAR-MISS: the same 409 answered ABORTED on a NAMED enqueue is a transient, never “already there”', async () => {
    const { resolver } = filaGravadora(() =>
      falhaDeTarefaJaExistente(nomeDaTarefaEstoque(DELTA), 'ABORTED'),
    );
    const erro = await rejeicaoDe(
      criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirar(DELTA),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('★ the payload carries identities only: a quantity is a ZodError, nothing enqueued', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });
    const comQuantidade = { ...DELTA, quantidade: 5 } as unknown as TarefaEstoqueAmazon;

    await expect(produtor.enfileirar(comQuantidade)).rejects.toBeInstanceOf(ZodError);
    await expect(produtor.enfileirarLote([DELTA, comQuantidade])).rejects.toBeInstanceOf(ZodError);
    await expect(produtor.enfileirarPausa(comQuantidade)).rejects.toBeInstanceOf(ZodError);
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a reconcile task carries its walk’s depósito, and leaves with its own name', async () => {
    const { enqueue, resolver } = filaGravadora();
    await criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirar(
      RECONCILIACAO,
      1_200,
    );
    expect(enqueue.mock.calls).toEqual([
      [RECONCILIACAO, { id: nomeDaTarefaEstoque(RECONCILIACAO), scheduleDelaySeconds: 1_200 }],
    ]);
  });
});

describe('criarProdutorEstoqueAmazon — the read-back', () => {
  it('★ named after the submission, delayed 360 s, origem verificacao, no depósito', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });

    await expect(produtor.enfileirarVerificacao(DELTA, SUBMISSAO)).resolves.toBe('enfileirada');
    const verificacao = tarefa({
      origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao,
      referencia: SUBMISSAO,
    });
    expect(enqueue.mock.calls).toEqual([
      [
        verificacao,
        {
          id: nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao, CONTA, SKU, SUBMISSAO),
          scheduleDelaySeconds: 360,
        },
      ],
    ]);
    expect(ATRASO_VERIFICACAO_ESTOQUE_S).toBe(360);
    // The same submission's read-back again (a retried patch task) is the same task.
    await expect(produtor.enfileirarVerificacao(DELTA, SUBMISSAO)).resolves.toBe('ja-enfileirada');
  });

  it.each<[string, OrigemTarefaEstoqueAmazon]>([
    ['a read-back (never a chain)', ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao],
    [
      'a reconcile’s patch (the next reconcile reads it back)',
      ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao,
    ],
  ])('★ refused for %s: RangeError, nothing enqueued', async (_c, origem) => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });
    const original =
      origem === ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao
        ? RECONCILIACAO
        : tarefa({ origem, referencia: SUBMISSAO });

    await expect(produtor.enfileirarVerificacao(original, SUBMISSAO)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each<OrigemTarefaEstoqueAmazon>([
    ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
    ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp,
    ORIGEM_TAREFA_ESTOQUE_AMAZON.manual,
  ])('NEAR-MISS: a %s patch earns its one read-back', async (origem) => {
    const { enqueue, resolver } = filaGravadora();
    const original =
      origem === ORIGEM_TAREFA_ESTOQUE_AMAZON.delta
        ? DELTA
        : tarefa({ origem, referencia: 'ref-1' });
    await criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirarVerificacao(
      original,
      SUBMISSAO,
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a submissionId outside the reference grammar (it would shift a name field) is a ZodError, nothing enqueued', async () => {
    const { enqueue, resolver } = filaGravadora();
    await expect(
      criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirarVerificacao(
        DELTA,
        'abc:def',
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('criarProdutorEstoqueAmazon — the pause of a throttled task', () => {
  it('★ UNNAMED (no id), the payload unchanged, delayed 60 s', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });

    await produtor.enfileirarPausa(DELTA);
    // Twice: no tombstone refuses the next pause.
    await produtor.enfileirarPausa(DELTA);
    expect(enqueue.mock.calls).toEqual([
      [DELTA, { scheduleDelaySeconds: 60 }],
      [DELTA, { scheduleDelaySeconds: 60 }],
    ]);
    expect(ATRASO_PAUSA_ESTOQUE_S).toBe(60);
  });

  it('NEAR-MISS: its 409 (an ABORTED: it holds no name) is a transient, never “already there”', async () => {
    const { resolver } = filaGravadora(() => falhaDeConflitoDoTasks());
    const erro = await rejeicaoDe(
      criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirarPausa(DELTA),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('NEAR-MISS: never “already there”, whatever its 409 body says (it holds no name to find)', async () => {
    const { resolver } = filaGravadora(() => falhaDeTarefaJaExistente('undefined'));
    const erro = await rejeicaoDe(
      criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirarPausa(DELTA),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });
});

describe('criarProdutorEstoqueAmazon — the delay, in WHOLE seconds', () => {
  it('★ NEAR-MISS: the read-back’s 6 min and the reconcile’s 20 min handed over in MILLISECONDS are refused', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });

    await expect(produtor.enfileirar(DELTA, 360_000)).rejects.toBeInstanceOf(RangeError);
    await expect(produtor.enfileirar(RECONCILIACAO, 1_200_000)).rejects.toBeInstanceOf(RangeError);
    await expect(produtor.enfileirarLote([DELTA], { atrasoS: 60_000 })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('the bound: exactly one hour passes, one second more is refused', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });

    await produtor.enfileirar(DELTA, MAX_ATRASO_ESTOQUE_S);
    await expect(
      produtor.enfileirar(RECONCILIACAO, MAX_ATRASO_ESTOQUE_S + 1),
    ).rejects.toBeInstanceOf(RangeError);
    expect(enqueue.mock.calls).toEqual([
      [DELTA, { id: nomeDaTarefaEstoque(DELTA), scheduleDelaySeconds: 3_600 }],
    ]);
  });

  it.each([1.5, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '★ a fractional, negative or non-finite delay (%s) is refused, nothing enqueued',
    async (atrasoS) => {
      const { enqueue, resolver } = filaGravadora();
      await expect(
        criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirar(DELTA, atrasoS),
      ).rejects.toBeInstanceOf(RangeError);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('a zero delay is no delay: the named payload keeps only its id', async () => {
    const { enqueue, resolver } = filaGravadora();
    await criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirar(DELTA, 0);
    expect(enqueue.mock.calls).toEqual([[DELTA, { id: nomeDaTarefaEstoque(DELTA) }]]);
  });
});

/** `n` delta payloads for distinct SKUs. */
function deltas(n: number): TarefaEstoqueAmazon[] {
  return Array.from({ length: n }, (_, i) => tarefa({ sku: `SKU-${String(i).padStart(3, '0')}` }));
}

/** A queue whose enqueues stay pending until released, counting how many are in flight. */
function filaRetida() {
  let emVoo = 0;
  let maximo = 0;
  const iniciadas: string[] = [];
  const pendentes: (() => void)[] = [];
  const fila: FilaEstoqueAmazon = {
    enqueue: (payload) => {
      iniciadas.push(payload.sku);
      emVoo += 1;
      maximo = Math.max(maximo, emVoo);
      return new Promise<void>((resolve) => {
        pendentes.push(() => {
          emVoo -= 1;
          resolve();
        });
      });
    },
  };
  /** Release every pending enqueue, round after round, until `p` settles. */
  async function drenar<T>(p: Promise<T>): Promise<T> {
    let pronto = false;
    const marcar = (): void => {
      pronto = true;
    };
    void p.then(marcar, marcar);
    while (!pronto) {
      await new Promise((r) => setTimeout(r, 0));
      for (const soltar of pendentes.splice(0)) soltar();
    }
    return p;
  }
  return { fila, iniciadas, drenar, maximo: () => maximo };
}

describe('criarProdutorEstoqueAmazon — the batch', () => {
  it('★ at most 16 enqueues in flight, started in list order, every payload named and counted', async () => {
    const retida = filaRetida();
    const produtor = criarProdutorEstoqueAmazon({ fila: () => retida.fila, desligado: false });
    const lote = deltas(40);

    const r = await retida.drenar(produtor.enfileirarLote(lote));
    expect(r).toEqual({ enfileiradas: 40, jaEnfileiradas: 0, naoTentadas: 0 });
    expect(LARGURA_LOTE_ESTOQUE_AMAZON).toBe(16);
    expect(retida.maximo()).toBe(16);
    expect(retida.iniciadas).toEqual(lote.map((t) => t.sku));
  });

  it('NEAR-MISS: a batch smaller than the width runs all of it at once', async () => {
    const retida = filaRetida();
    const produtor = criarProdutorEstoqueAmazon({ fila: () => retida.fila, desligado: false });
    await retida.drenar(produtor.enfileirarLote(deltas(5)));
    expect(retida.maximo()).toBe(5);
  });

  it('a re-run of the same batch is ja-enfileirada for every payload already held', async () => {
    const { resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });
    const lote = deltas(20);
    await produtor.enfileirarLote(lote.slice(0, 12));
    await expect(produtor.enfileirarLote(lote)).resolves.toEqual({
      enfileiradas: 8,
      jaEnfileiradas: 12,
      naoTentadas: 0,
    });
  });

  it('★ the deadline: nothing more starts once `continuar` says no, and the rest are counted', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorEstoqueAmazon({ fila: resolver, desligado: false });
    let restantes = 7;
    const r = await produtor.enfileirarLote(deltas(30), {
      continuar: () => {
        restantes -= 1;
        return restantes >= 0;
      },
    });
    expect(r).toEqual({ enfileiradas: 7, jaEnfileiradas: 0, naoTentadas: 23 });
    expect(enqueue).toHaveBeenCalledTimes(7);
  });

  it('★ a failure: no new enqueue starts, the in-flight ones are awaited, the EARLIEST payload’s error is rethrown untouched', async () => {
    const doTerceiro = falhaDoFunctions('permission-denied', 403);
    const doDecimo = falhaDoFunctions('not-found', 404);
    const lote = deltas(40);
    let ativas = 0;
    let terminadas = 0;
    const iniciadas: string[] = [];
    // Each enqueue answers only when the test says so, so the order in time is the test's,
    // never a timer's: timers raced under a loaded runner and let payloads start late.
    const respostas = new Map<string, (falha: Error | null) => void>();
    const fila: FilaEstoqueAmazon = {
      enqueue: (payload) => {
        iniciadas.push(payload.sku);
        ativas += 1;
        return new Promise<void>((resolve, reject) => {
          respostas.set(payload.sku, (falha) => {
            ativas -= 1;
            terminadas += 1;
            if (falha === null) resolve();
            else reject(falha);
          });
        });
      },
    };
    // A macrotask: every continuation the last answer queued has run.
    const drenar = () => new Promise((r) => setTimeout(r, 0));
    const primeiros16 = lote.slice(0, 16).map((t) => t.sku);
    const quarto = lote[3]?.sku ?? '';
    const decimo = lote[9]?.sku ?? '';
    let desfecho: unknown = 'pendente';
    const resposta = rejeicaoDe(
      criarProdutorEstoqueAmazon({ fila: () => fila, desligado: false }).enfileirarLote(lote),
    ).then((e) => {
      desfecho = e;
    });
    await drenar();
    expect(iniciadas).toEqual(primeiros16);
    // The tenth payload fails FIRST in time; then every other one in flight answers, which
    // frees its slot; the fourth fails LAST.
    respostas.get(decimo)?.(doDecimo);
    await drenar();
    for (const sku of primeiros16) if (sku !== quarto && sku !== decimo) respostas.get(sku)?.(null);
    await drenar();
    // Nothing started after the failure, and the answer still waits for the fourth.
    expect(iniciadas).toEqual(primeiros16);
    expect(ativas).toBe(1);
    expect(desfecho).toBe('pendente');
    respostas.get(quarto)?.(doTerceiro);
    await resposta;
    // The earliest in LIST order, never the first in time.
    expect(desfecho).toBe(doTerceiro);
    expect(desfecho).toBeInstanceOf(FirebaseFunctionsError);
    // Nothing still running behind the answer, and nothing started after the failure.
    expect(ativas).toBe(0);
    expect(terminadas).toBe(iniciadas.length);
    expect(iniciadas).toEqual(primeiros16);
  });

  it('a transient in a batch is the shared class', async () => {
    const lote = deltas(3);
    const { resolver } = filaGravadora((p) =>
      p.sku === lote[1]?.sku ? falhaDoFunctions('unknown-error', 503) : undefined,
    );
    const erro = await rejeicaoDe(
      criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirarLote(lote),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('an empty batch enqueues nothing and resolves no queue', async () => {
    const { resolver } = filaGravadora();
    await expect(
      criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirarLote([]),
    ).resolves.toEqual({ enfileiradas: 0, jaEnfileiradas: 0, naoTentadas: 0 });
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('criarProdutorEstoqueAmazon — the failures', () => {
  it('a Cloud Tasks 503 is NAMED as the shared transient', async () => {
    const { resolver } = filaGravadora(() => falhaDoFunctions('unknown-error', 503));
    const erro = await rejeicaoDe(
      criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirar(DELTA),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('NEAR-MISS: a deploy-shaped 403 is rethrown EXACTLY as thrown', async () => {
    const original = falhaDoFunctions('permission-denied', 403);
    const { resolver } = filaGravadora(() => original);
    const erro = await rejeicaoDe(
      criarProdutorEstoqueAmazon({ fila: resolver, desligado: false }).enfileirar(DELTA),
    );
    expect(erro).toBe(original);
  });

  it('a region error from the root rejects THAT enqueue, rethrown untouched', async () => {
    const produtor = criarProdutorEstoqueAmazon({
      fila: () => {
        throw new AmazonEstoqueRegiaoDaFilaInvalidaError();
      },
      desligado: false,
    });
    await expect(produtor.enfileirar(DELTA)).rejects.toBeInstanceOf(
      AmazonEstoqueRegiaoDaFilaInvalidaError,
    );
  });
});
