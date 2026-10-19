import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgendadorDePrazoAmazon,
  type DesfechoComPrazoAmazon,
  agendarPrazoPadraoAmazon,
  correrComPrazoAmazon,
} from './prazo';

/** A promise the test settles by hand. */
function adiada<T>() {
  let resolver!: (v: T) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

/** A deadline the test fires by hand, recording whether it was disarmed. */
function prazoManual() {
  let vencer: () => void = () => undefined;
  let desarmado = false;
  const agendar: AgendadorDePrazoAmazon = (_ms, aoVencer) => {
    vencer = aoVencer;
    return () => {
      desarmado = true;
    };
  };
  return { agendar, vencer: () => vencer(), desarmado: () => desarmado };
}

/** Let every queued microtask and the next macrotask run (real timers only). */
const esvaziar = () => new Promise<void>((r) => setImmediate(r));

describe('correrComPrazoAmazon', () => {
  const rejeicoesNaoTratadas: unknown[] = [];
  const ouvir = (motivo: unknown) => {
    rejeicoesNaoTratadas.push(motivo);
  };
  beforeEach(() => {
    rejeicoesNaoTratadas.length = 0;
    process.on('unhandledRejection', ouvir);
  });
  afterEach(() => {
    process.off('unhandledRejection', ouvir);
  });

  it('an operation that settles first wins, and disarms the deadline', async () => {
    const p = prazoManual();
    const tarde = vi.fn();
    const r = await correrComPrazoAmazon(() => Promise.resolve(7), 100, {
      agendarPrazo: p.agendar,
      aoRejeitarTarde: tarde,
    });
    expect(r).toEqual({ tipo: 'concluida', valor: 7 });
    expect(p.desarmado()).toBe(true);
    p.vencer();
    expect(tarde).not.toHaveBeenCalled();
  });

  it('an EARLY rejection is returned as a value, never consumed', async () => {
    const p = prazoManual();
    const tarde = vi.fn();
    const erro = new TypeError('cedo');
    const r = await correrComPrazoAmazon(() => Promise.reject(erro), 100, {
      agendarPrazo: p.agendar,
      aoRejeitarTarde: tarde,
    });
    expect(r).toEqual({ tipo: 'rejeitada', erro });
    expect(tarde).not.toHaveBeenCalled();
    expect(p.desarmado()).toBe(true);
  });

  it('a synchronous throw counts as an early rejection', async () => {
    const erro = new RangeError('síncrono');
    const r = await correrComPrazoAmazon(
      () => {
        throw erro;
      },
      100,
      { agendarPrazo: prazoManual().agendar, aoRejeitarTarde: vi.fn() },
    );
    expect(r).toEqual({ tipo: 'rejeitada', erro });
  });

  it('the deadline wins over a pending operation, which KEEPS running', async () => {
    const p = prazoManual();
    const op = adiada<number>();
    const desfecho = correrComPrazoAmazon(() => op.promessa, 100, {
      agendarPrazo: p.agendar,
      aoRejeitarTarde: vi.fn(),
    });
    p.vencer();
    expect(await desfecho).toEqual({ tipo: 'prazo' });
  });

  it('a LATE rejection reaches aoRejeitarTarde exactly once, and nothing goes unhandled', async () => {
    const p = prazoManual();
    const op = adiada<number>();
    const tarde = vi.fn();
    const desfecho = correrComPrazoAmazon(() => op.promessa, 100, {
      agendarPrazo: p.agendar,
      aoRejeitarTarde: tarde,
    });
    p.vencer();
    await desfecho;
    const erro = new TypeError('tarde');
    op.rejeitar(erro);
    await esvaziar();
    await esvaziar();
    expect(tarde).toHaveBeenCalledTimes(1);
    expect(tarde).toHaveBeenCalledWith(erro);
    expect(rejeicoesNaoTratadas).toEqual([]);
  });

  it('a LATE success is ignored (the outcome stays the deadline)', async () => {
    const p = prazoManual();
    const op = adiada<number>();
    const tarde = vi.fn();
    const desfecho = correrComPrazoAmazon(() => op.promessa, 100, {
      agendarPrazo: p.agendar,
      aoRejeitarTarde: tarde,
    });
    p.vencer();
    op.resolver(1);
    await esvaziar();
    expect(await desfecho).toEqual({ tipo: 'prazo' });
    expect(tarde).not.toHaveBeenCalled();
  });
});

describe('agendarPrazoPadraoAmazon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('arms an UNREF’d timer and disarms it', () => {
    const espiao = vi.spyOn(globalThis, 'setTimeout');
    const limpar = vi.spyOn(globalThis, 'clearTimeout');
    const desarmar = agendarPrazoPadraoAmazon(60_000, () => undefined);
    const temporizador = espiao.mock.results[0]?.value as NodeJS.Timeout;
    expect(espiao.mock.calls[0]?.[1]).toBe(60_000);
    expect(temporizador.hasRef()).toBe(false);
    desarmar();
    expect(limpar).toHaveBeenCalledWith(temporizador);
  });

  it('fires at the deadline under fake timers, and not one millisecond before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const op = adiada<number>();
    let fim: DesfechoComPrazoAmazon<number> | null = null;
    void correrComPrazoAmazon(() => op.promessa, 2000, {
      agendarPrazo: agendarPrazoPadraoAmazon,
      aoRejeitarTarde: () => undefined,
    }).then((r) => {
      fim = r;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fim).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(fim).toEqual({ tipo: 'prazo' });
  });
});
