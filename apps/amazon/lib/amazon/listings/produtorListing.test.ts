/**
 * The listings flows' shared producer core, offline, through a binding of its
 * own (a test payload): the whole-second delays and their bound, the
 * transport's options, the ONE enqueue (the binding's valve class, the named
 * enqueue's held id read as durable, the unnamed one's 409 a transient), and
 * the batch (≤ 16 in flight, list order, the deadline hook, the earliest
 * rejection, nothing left running). The Admin SDK's REAL error classes drive
 * the transport (`testing/falhaDeEnfileiramento.ts`). Nothing reaches a
 * network.
 */
import { describe, expect, it, vi } from 'vitest';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import {
  AmazonEstoqueTarefasDesligadasError,
  type FilaEstoqueAmazon,
  LARGURA_LOTE_ESTOQUE_AMAZON,
  criarProdutorEstoqueAmazon,
} from '../estoque/produtorEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  tarefaEstoqueAmazonSchema,
} from '../estoque/tarefaEstoque';
import { AmazonLotesTarefasDesligadasError } from '../feeds/agendadorLotes';
import {
  falhaDeConflitoDoTasks,
  falhaDeTarefaJaExistente,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import {
  type FilaListingAmazon,
  LARGURA_LOTE_LISTING_AMAZON,
  type LimiteDeAtrasoListingAmazon,
  type ResultadoEnfileiramentoListingAmazon,
  type VinculoFilaListingAmazon,
  atrasoDaFilaListingAmazon,
  enfileirarLoteListingAmazon,
  enfileirarNaFilaListingAmazon,
  opcoesDaTarefaListingAmazon,
} from './produtorListing';

/** A test payload: any binding's payload is opaque to the core. */
interface TarefaDeTeste {
  readonly n: number;
}

const LIMITE: LimiteDeAtrasoListingAmazon = {
  rotulo: 'produtorDeTeste.ts',
  maximoS: 600,
  descricao: 'dez minutos',
};

/** A queue that records every enqueue and, like Cloud Tasks, refuses a held id (a tombstone). */
function filaGravadora(falha?: (t: TarefaDeTeste) => unknown) {
  const ids = new Set<string>();
  const enqueue = vi.fn((...args: unknown[]): Promise<void> => {
    const erro = falha?.(args[0] as TarefaDeTeste);
    if (erro !== undefined) return Promise.reject(erro);
    const id = (args[1] as { id?: string } | undefined)?.id;
    if (id !== undefined) {
      if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
      ids.add(id);
    }
    return Promise.resolve();
  });
  const fila: FilaListingAmazon<TarefaDeTeste> = {
    enqueue: (...args: Parameters<FilaListingAmazon<TarefaDeTeste>['enqueue']>) => enqueue(...args),
  };
  const resolver = vi.fn(() => fila);
  return { enqueue, resolver };
}

function vinculoDe(
  f: ReturnType<typeof filaGravadora>,
  desligado = false,
): VinculoFilaListingAmazon<TarefaDeTeste> {
  return {
    fila: f.resolver,
    desligado,
    desligada: () => new AmazonLotesTarefasDesligadasError(),
  };
}

describe('★ delays: WHOLE seconds up to the binding’s bound', () => {
  it.each<[number | undefined, number | undefined]>([
    [undefined, undefined],
    [0, undefined],
    [1, 1],
    [600, 600],
  ])('%s s ⇒ %s', (atraso, esperado) => {
    expect(atrasoDaFilaListingAmazon(atraso, LIMITE)).toBe(esperado);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    '%s is a RangeError naming the binding',
    (atraso) => {
      expect(() => atrasoDaFilaListingAmazon(atraso, LIMITE)).toThrow(
        new RangeError('produtorDeTeste.ts: atraso fora de segundos inteiros não negativos'),
      );
    },
  );

  it('★ NEAR-MISS: one second past the bound is a RangeError naming the bound in words (a value in ms)', () => {
    expect(() => atrasoDaFilaListingAmazon(601, LIMITE)).toThrow(
      new RangeError(
        'produtorDeTeste.ts: atraso acima de dez minutos (milissegundos no lugar de segundos?)',
      ),
    );
    expect(() => atrasoDaFilaListingAmazon(600_000, LIMITE)).toThrow(RangeError);
  });

  it('the transport’s options: the id when named, the delay when positive, none at all otherwise', () => {
    expect(opcoesDaTarefaListingAmazon(null, undefined)).toBeUndefined();
    expect(opcoesDaTarefaListingAmazon('id-1', undefined)).toEqual({ id: 'id-1' });
    expect(opcoesDaTarefaListingAmazon(null, 5)).toEqual({ scheduleDelaySeconds: 5 });
    expect(opcoesDaTarefaListingAmazon('id-1', 5)).toEqual({ id: 'id-1', scheduleDelaySeconds: 5 });
  });
});

describe('★ one enqueue through the binding', () => {
  it('closed valve ⇒ the BINDING’s own class, the queue never resolved', async () => {
    const f = filaGravadora();
    await expect(
      enfileirarNaFilaListingAmazon(vinculoDe(f, true), { n: 1 }, 'id-1', { id: 'id-1' }),
    ).rejects.toBeInstanceOf(AmazonLotesTarefasDesligadasError);
    expect(f.resolver).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('★ a NAMED enqueue whose id the queue holds ⇒ ja-enfileirada (already durable), never an error', async () => {
    const f = filaGravadora();
    const v = vinculoDe(f);
    await expect(enfileirarNaFilaListingAmazon(v, { n: 1 }, 'id-1', { id: 'id-1' })).resolves.toBe(
      'enfileirada',
    );
    await expect(enfileirarNaFilaListingAmazon(v, { n: 1 }, 'id-1', { id: 'id-1' })).resolves.toBe(
      'ja-enfileirada',
    );
    expect(f.enqueue.mock.calls).toEqual([
      [{ n: 1 }, { id: 'id-1' }],
      [{ n: 1 }, { id: 'id-1' }],
    ]);
  });

  it('★ NEAR-MISS: an UNNAMED enqueue meeting a 409 is a transient, never “already there”', async () => {
    const f = filaGravadora(() => falhaDeConflitoDoTasks());
    await expect(
      enfileirarNaFilaListingAmazon(vinculoDe(f), { n: 1 }, null, undefined),
    ).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('★ NEAR-MISS: an UNNAMED enqueue is never “already there”, whatever its 409 body says (only a name can be held)', async () => {
    const f = filaGravadora(() => falhaDeTarefaJaExistente('x'));
    await expect(
      enfileirarNaFilaListingAmazon(vinculoDe(f), { n: 1 }, null, undefined),
    ).rejects.toBeDefined();
    const g = filaGravadora(() => falhaDeTarefaJaExistente('x'));
    await expect(
      enfileirarNaFilaListingAmazon(vinculoDe(g), { n: 1 }, 'x', { id: 'x' }),
    ).resolves.toBe('ja-enfileirada');
  });

  it('an unnamed, undelayed enqueue sends the payload ALONE (no options object); a transient SDK failure is named', async () => {
    const f = filaGravadora();
    await enfileirarNaFilaListingAmazon(vinculoDe(f), { n: 2 }, null, undefined);
    expect(f.enqueue.mock.calls[0]).toEqual([{ n: 2 }]);
    const g = filaGravadora(() => falhaDoFunctions('unavailable'));
    await expect(
      enfileirarNaFilaListingAmazon(vinculoDe(g), { n: 1 }, 'id-x', { id: 'id-x' }),
    ).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('a failure the transient naming does not name is rethrown untouched', async () => {
    const bug = new TypeError('quebrado');
    const f = filaGravadora(() => bug);
    await expect(
      enfileirarNaFilaListingAmazon(vinculoDe(f), { n: 1 }, 'id-1', { id: 'id-1' }),
    ).rejects.toBe(bug);
  });
});

describe('★ the batch', () => {
  /** A one-enqueue that answers when told, counting what is in flight. */
  function enviarControlado() {
    let emVoo = 0;
    let pico = 0;
    const pendentes: (() => void)[] = [];
    const iniciados: number[] = [];
    const enviar = (t: TarefaDeTeste): Promise<ResultadoEnfileiramentoListingAmazon> => {
      iniciados.push(t.n);
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      return new Promise((resolve) => {
        pendentes.push(() => {
          emVoo -= 1;
          resolve(t.n % 2 === 0 ? 'ja-enfileirada' : 'enfileirada');
        });
      });
    };
    const soltarTudo = async () => {
      while (pendentes.length > 0) {
        pendentes.shift()?.();
        await Promise.resolve();
        await Promise.resolve();
      }
    };
    return { enviar, soltarTudo, iniciados, pico: () => pico };
  }

  it(`★ keeps at most ${String(LARGURA_LOTE_LISTING_AMAZON)} in flight, starts in list order, counts both answers`, async () => {
    const c = enviarControlado();
    const itens = Array.from({ length: 40 }, (_v, i) => ({ n: i }));
    const lote = enfileirarLoteListingAmazon(itens, c.enviar);
    await Promise.resolve();
    expect(c.iniciados).toHaveLength(16);
    await c.soltarTudo();
    await expect(lote).resolves.toEqual({ enfileiradas: 20, jaEnfileiradas: 20, naoTentadas: 0 });
    expect(c.pico()).toBe(16);
    expect(c.iniciados).toEqual(itens.map((i) => i.n));
    expect(LARGURA_LOTE_LISTING_AMAZON).toBe(16);
    expect(LARGURA_LOTE_ESTOQUE_AMAZON).toBe(LARGURA_LOTE_LISTING_AMAZON);
  });

  it('★ the deadline hook, asked before STARTING each item: false ⇒ nothing more starts, the rest counted (NEAR-MISS: always true ⇒ none left)', async () => {
    let perguntas = 0;
    const enviar = vi.fn(() => Promise.resolve('enfileirada' as const));
    const itens = Array.from({ length: 5 }, (_v, i) => ({ n: i }));
    const r = await enfileirarLoteListingAmazon(itens, enviar, () => {
      perguntas += 1;
      return perguntas <= 2;
    });
    expect(r).toEqual({ enfileiradas: 2, jaEnfileiradas: 0, naoTentadas: 3 });
    expect(enviar).toHaveBeenCalledTimes(2);
    const todos = await enfileirarLoteListingAmazon(itens, enviar, () => true);
    expect(todos.naoTentadas).toBe(0);
  });

  it('★ the EARLIEST rejection in list order is rethrown unchanged, after every item in flight settled; no item starts after it', async () => {
    const tarde = new RangeError('item 7');
    const cedo = new TypeError('item 3');
    const iniciados: number[] = [];
    let emVoo = 0;
    // Each enqueue answers only when the test says so, so the order in time is the test's,
    // never a timer's: timers raced under a loaded runner and let items start late.
    const respostas = new Map<number, { aceitar: () => void; falhar: (e: Error) => void }>();
    const enviar = (t: TarefaDeTeste): Promise<ResultadoEnfileiramentoListingAmazon> => {
      iniciados.push(t.n);
      emVoo += 1;
      return new Promise((resolve, reject) => {
        respostas.set(t.n, {
          aceitar: () => {
            emVoo -= 1;
            resolve('enfileirada');
          },
          falhar: (e) => {
            emVoo -= 1;
            reject(e);
          },
        });
      });
    };
    // A macrotask: every continuation the last answer queued has run.
    const drenar = () => new Promise((r) => setTimeout(r, 0));
    const primeiros16 = Array.from({ length: 16 }, (_v, i) => i);
    const itens = Array.from({ length: 40 }, (_v, i) => ({ n: i }));
    let desfecho: unknown = 'pendente';
    const lote = enfileirarLoteListingAmazon(itens, enviar).then(
      () => {
        desfecho = 'resolvido';
      },
      (e: unknown) => {
        desfecho = e;
      },
    );
    await drenar();
    expect(iniciados).toEqual(primeiros16);
    // Item 7 fails FIRST in time; then every other item in flight answers, which frees its
    // slot; item 3, earlier in the list, fails LAST.
    respostas.get(7)?.falhar(tarde);
    await drenar();
    for (const n of primeiros16) if (n !== 3 && n !== 7) respostas.get(n)?.aceitar();
    await drenar();
    // Nothing started after item 7 failed, and the batch still waits for item 3.
    expect(iniciados).toEqual(primeiros16);
    expect(emVoo).toBe(1);
    expect(desfecho).toBe('pendente');
    respostas.get(3)?.falhar(cedo);
    await lote;
    expect(desfecho).toBe(cedo);
    expect(emVoo).toBe(0);
    expect(iniciados).toEqual(primeiros16);
  });

  it('an empty batch enqueues nothing and answers zeros', async () => {
    const enviar = vi.fn();
    await expect(enfileirarLoteListingAmazon([], enviar)).resolves.toEqual({
      enfileiradas: 0,
      jaEnfileiradas: 0,
      naoTentadas: 0,
    });
    expect(enviar).not.toHaveBeenCalled();
  });

  it('runs over ANY one-enqueue: a named batch re-run through the binding enqueues only what is missing', async () => {
    const f = filaGravadora();
    const v = vinculoDe(f);
    const enviar = (t: TarefaDeTeste) =>
      enfileirarNaFilaListingAmazon(v, t, `id-${String(t.n)}`, { id: `id-${String(t.n)}` });
    const itens = [{ n: 1 }, { n: 2 }, { n: 3 }];
    await enfileirarLoteListingAmazon(itens.slice(0, 2), enviar);
    await expect(enfileirarLoteListingAmazon(itens, enviar)).resolves.toEqual({
      enfileiradas: 1,
      jaEnfileiradas: 2,
      naoTentadas: 0,
    });
  });
});

describe('the stock producer itself, through its binding of the core', () => {
  /** A valid stock payload (identities only). */
  const tarefa = (sku: string): TarefaEstoqueAmazon =>
    tarefaEstoqueAmazonSchema.parse({
      v: 1,
      contaId: 'conta-produtor',
      sku,
      origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
      referencia: '1800000000.000000005',
      depositoId: null,
    });

  /** A stock queue that records every enqueue. */
  function filaDoEstoque() {
    const enqueue = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
    const fila: FilaEstoqueAmazon = {
      enqueue: (...args: Parameters<FilaEstoqueAmazon['enqueue']>) => enqueue(...args),
    };
    return { enqueue, resolver: vi.fn(() => fila) };
  }

  it('★ its delay refusals name its OWN module and its one-hour bound (NEAR-MISS: one hour is still taken)', async () => {
    const f = filaDoEstoque();
    const produtor = criarProdutorEstoqueAmazon({ fila: f.resolver, desligado: false });
    await expect(produtor.enfileirar(tarefa('SKU-1'), 3_601)).rejects.toThrow(
      new RangeError(
        'produtorEstoque.ts: atraso acima de uma hora (milissegundos no lugar de segundos?)',
      ),
    );
    await expect(produtor.enfileirar(tarefa('SKU-1'), 1.5)).rejects.toThrow(
      new RangeError('produtorEstoque.ts: atraso fora de segundos inteiros não negativos'),
    );
    expect(f.enqueue).not.toHaveBeenCalled();
    await expect(produtor.enfileirar(tarefa('SKU-1'), 3_600)).resolves.toBe('enfileirada');
  });

  it('★ its closed valve answers the STOCK class, the queue never resolved', async () => {
    const f = filaDoEstoque();
    const produtor = criarProdutorEstoqueAmazon({ fila: f.resolver, desligado: true });
    await expect(produtor.enfileirar(tarefa('SKU-1'))).rejects.toBeInstanceOf(
      AmazonEstoqueTarefasDesligadasError,
    );
    await expect(produtor.enfileirarPausa(tarefa('SKU-1'))).rejects.toBeInstanceOf(
      AmazonEstoqueTarefasDesligadasError,
    );
    expect(f.resolver).not.toHaveBeenCalled();
  });

  it('★ the valve is read at EVERY enqueue, never copied when the producer is built', async () => {
    const f = filaDoEstoque();
    const opcoes = { fila: f.resolver, desligado: false };
    const produtor = criarProdutorEstoqueAmazon(opcoes);
    await expect(produtor.enfileirar(tarefa('SKU-1'))).resolves.toBe('enfileirada');
    opcoes.desligado = true;
    await expect(produtor.enfileirar(tarefa('SKU-2'))).rejects.toBeInstanceOf(
      AmazonEstoqueTarefasDesligadasError,
    );
    opcoes.desligado = false;
    await expect(produtor.enfileirar(tarefa('SKU-3'))).resolves.toBe('enfileirada');
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });

  it('★ NEAR-MISS: the queue too is read off its options at EVERY enqueue, never copied when the producer is built', async () => {
    const antiga = filaDoEstoque();
    const nova = filaDoEstoque();
    const opcoes = { fila: antiga.resolver, desligado: false };
    const produtor = criarProdutorEstoqueAmazon(opcoes);
    await expect(produtor.enfileirar(tarefa('SKU-1'))).resolves.toBe('enfileirada');
    opcoes.fila = nova.resolver;
    await expect(produtor.enfileirar(tarefa('SKU-2'))).resolves.toBe('enfileirada');
    expect(antiga.enqueue).toHaveBeenCalledTimes(1);
    expect(nova.enqueue).toHaveBeenCalledTimes(1);
  });
});
