import { describe, expect, it } from 'vitest';

import { executarEmPool } from './pool';

/**
 * A call the test settles BY HAND, so "how many are in flight right now" is a
 * number the test reads rather than a timing it hopes for.
 */
interface Controlavel {
  readonly emVoo: () => number;
  readonly maximoEmVoo: () => number;
  readonly iniciados: readonly number[];
  readonly executar: (item: number, indice: number) => Promise<void>;
  /** Settles the oldest pending call; `falha` rejects it instead. */
  readonly liberar: (falha?: Error) => void;
  readonly pendentes: () => number;
}

function controlavel(): Controlavel {
  let emVoo = 0;
  let maximoEmVoo = 0;
  const iniciados: number[] = [];
  const fila: { resolver: () => void; rejeitar: (e: Error) => void }[] = [];
  return {
    emVoo: () => emVoo,
    maximoEmVoo: () => maximoEmVoo,
    iniciados,
    executar: (item) => {
      iniciados.push(item);
      emVoo += 1;
      maximoEmVoo = Math.max(maximoEmVoo, emVoo);
      return new Promise<void>((resolve, reject) => {
        fila.push({
          resolver: () => {
            emVoo -= 1;
            resolve();
          },
          rejeitar: (e) => {
            emVoo -= 1;
            reject(e);
          },
        });
      });
    },
    liberar: (falha) => {
      const proxima = fila.shift();
      if (proxima === undefined) throw new Error('nenhuma chamada pendente');
      if (falha === undefined) proxima.resolver();
      else proxima.rejeitar(falha);
    },
    pendentes: () => fila.length,
  };
}

/** Lets every already-settled continuation run before the test looks again. */
async function drenarMicrotarefas(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Drives a pool to completion, one release at a time, recording the width. */
async function conduzir(ctl: Controlavel, pool: Promise<void>, falhaNo?: number): Promise<void> {
  let liberados = 0;
  for (;;) {
    await drenarMicrotarefas();
    if (ctl.pendentes() === 0) break;
    ctl.liberar(liberados === falhaNo ? new Error(`falha ${String(liberados)}`) : undefined);
    liberados += 1;
  }
  await pool;
}

describe('executarEmPool — a largura', () => {
  it('nunca mais que `largura` chamadas em voo (2 sobre 7 itens)', async () => {
    const ctl = controlavel();
    const itens = [0, 1, 2, 3, 4, 5, 6];

    const pool = executarEmPool(itens, 2, ctl.executar);
    await drenarMicrotarefas();
    // Exactly the width starts, and nothing else until one settles.
    expect(ctl.emVoo()).toBe(2);
    expect(ctl.iniciados).toEqual([0, 1]);

    await conduzir(ctl, pool);
    expect(ctl.maximoEmVoo()).toBe(2);
  });

  it('largura 1 é SERIAL: a segunda chamada só começa quando a primeira termina', async () => {
    const ctl = controlavel();

    const pool = executarEmPool([10, 20, 30], 1, ctl.executar);
    await drenarMicrotarefas();
    expect(ctl.iniciados).toEqual([10]);
    ctl.liberar();
    await drenarMicrotarefas();
    expect(ctl.iniciados).toEqual([10, 20]);

    await conduzir(ctl, pool);
    expect(ctl.maximoEmVoo()).toBe(1);
  });

  it('largura 0 ou negativa é piso 1 — nunca um pool que não começa', async () => {
    for (const largura of [0, -3]) {
      const ctl = controlavel();
      const pool = executarEmPool([1, 2], largura, ctl.executar);
      await conduzir(ctl, pool);
      expect(ctl.iniciados).toEqual([1, 2]);
      expect(ctl.maximoEmVoo()).toBe(1);
    }
  });

  it('largura maior que a lista não cria trabalhadores ociosos que chamam de novo', async () => {
    const ctl = controlavel();

    const pool = executarEmPool([7, 8], 50, ctl.executar);
    await conduzir(ctl, pool);

    expect(ctl.iniciados).toEqual([7, 8]);
    expect(ctl.maximoEmVoo()).toBe(2);
  });

  it('uma lista vazia não chama nada e resolve', async () => {
    const chamadas: number[] = [];
    await executarEmPool<number>([], 3, (item) => {
      chamadas.push(item);
      return Promise.resolve();
    });
    expect(chamadas).toEqual([]);
  });
});

describe('executarEmPool — todo item roda, uma vez, com o seu índice', () => {
  it('cada item é chamado exatamente UMA vez, com o índice da sua posição', async () => {
    const vistos: [string, number][] = [];
    const itens = ['a', 'b', 'c', 'd', 'e'];

    await executarEmPool(itens, 3, (item, indice) => {
      vistos.push([item, indice]);
      return Promise.resolve();
    });

    expect([...vistos].sort((x, y) => x[1] - y[1])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
      ['e', 4],
    ]);
  });
});

describe('executarEmPool — uma rejeição não para os outros', () => {
  it('⚠️ a falha do item 1 não impede 2..6 de rodarem, e o pool ESPERA por todos antes de rejeitar', async () => {
    const ctl = controlavel();
    const itens = [0, 1, 2, 3, 4, 5, 6];
    let assentado = false;

    const pool = executarEmPool(itens, 2, ctl.executar);
    pool.then(
      () => {
        assentado = true;
      },
      () => {
        assentado = true;
      },
    );
    await drenarMicrotarefas();
    ctl.liberar(); // item 0 ok
    await drenarMicrotarefas();
    ctl.liberar(new Error('falha do item 1'));
    await drenarMicrotarefas();

    // `Promise.all` would have settled HERE, with items still to run.
    expect(assentado).toBe(false);

    let rejeicao: unknown = null;
    const conducao = (async () => {
      for (;;) {
        await drenarMicrotarefas();
        if (ctl.pendentes() === 0) break;
        ctl.liberar();
      }
    })();
    await conducao;
    await pool.catch((e: unknown) => {
      rejeicao = e;
    });

    expect(ctl.iniciados).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rejeicao).toBeInstanceOf(Error);
    expect((rejeicao as Error).message).toBe('falha do item 1');
  });

  it('a rejeição é repassada SEM embrulho (a mesma instância)', async () => {
    const erro = new TypeError('fetch failed');

    const resultado = executarEmPool([1, 2, 3], 2, (item) =>
      item === 2 ? Promise.reject(erro) : Promise.resolve(),
    );

    await expect(resultado).rejects.toBe(erro);
  });

  it('duas rejeições: a do PRIMEIRO trabalhador é a repassada', async () => {
    const ctl = controlavel();

    // Worker 0 takes item 0, worker 1 takes item 1; both reject.
    const pool = executarEmPool([0, 1], 2, ctl.executar);
    await drenarMicrotarefas();
    ctl.liberar(new Error('trabalhador 0'));
    ctl.liberar(new Error('trabalhador 1'));

    await expect(pool).rejects.toThrow('trabalhador 0');
  });

  it('largura 1 com uma rejeição: o único trabalhador para, e os itens seguintes NÃO rodam', async () => {
    const ctl = controlavel();

    const pool = executarEmPool([0, 1, 2], 1, ctl.executar);
    await expect(conduzir(ctl, pool, 0)).rejects.toThrow('falha 0');

    // The documented shape: a rejecting worker stops pulling. With one worker
    // there is no sibling left to drain the cursor — the CALLER's abort flag is
    // what the manual pushes rely on, never this.
    expect(ctl.iniciados).toEqual([0]);
  });
});
