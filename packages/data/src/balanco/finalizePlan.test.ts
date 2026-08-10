import { describe, expect, it } from 'vitest';
import {
  MovimentoBalancoIndefinidoError,
  montarListaTrabalho,
  montarShardsRelatorio,
  motivoBalanco,
  planejarItemBalanco,
} from './finalizePlan';

const AGORA = 1_700_000_000_000;

function planejar(over: Partial<Parameters<typeof planejarItemBalanco>[0]> = {}) {
  return planejarItemBalanco({
    produtoId: 'p1',
    contado: 5,
    atual: { quantidade: 8, quantidadeReservada: 0 },
    jaAplicado: false,
    motivo: motivoBalanco('Contagem'),
    agoraMs: AGORA,
    ...over,
  });
}

describe('planejarItemBalanco', () => {
  it('records a SIGNED DELTA, never the counted absolute (ADR 0014)', () => {
    // This is the v1 bug the ledger rewrite existed to kill: a balanço that
    // stored `5` here would poison every `sum(movimento)` the ML sweep runs.
    const acao = planejar({ contado: 5, atual: { quantidade: 8, quantidadeReservada: 0 } });
    expect(acao.tipo).toBe('aplicar');
    if (acao.tipo !== 'aplicar') return;
    expect(acao.plan.historico.movimento).toBe(-3);
    expect(acao.plan.historico.saldo).toBe(5);
    // ...while the estoque doc still receives the ABSOLUTE counted value.
    expect(acao.plan.quantidade).toBe(5);
    expect(acao.estoqueAntes).toBe(8);
  });

  it('counts up as a positive delta', () => {
    const acao = planejar({ contado: 12, atual: { quantidade: 8, quantidadeReservada: 0 } });
    if (acao.tipo !== 'aplicar') throw new Error('esperava aplicar');
    expect(acao.plan.historico.movimento).toBe(4);
  });

  it('preserves quantidadeReservada and records no reservation movement', () => {
    const acao = planejar({ contado: 5, atual: { quantidade: 8, quantidadeReservada: 3 } });
    if (acao.tipo !== 'aplicar') throw new Error('esperava aplicar');
    expect(acao.plan.quantidadeReservada).toBe(3);
    expect(acao.plan.historico.movimentoReservada).toBe(0);
    expect(acao.plan.historico.saldoReservada).toBe(3);
  });

  it('creates the estoque doc when the produto has none and units were counted', () => {
    const acao = planejar({ contado: 4, atual: null });
    if (acao.tipo !== 'aplicar') throw new Error('esperava aplicar');
    expect(acao.estoqueAntes).toBe(0);
    expect(acao.plan.historico.movimento).toBe(4);
    expect(acao.plan.quantidadeReservada).toBe(0);
  });

  it('writes NOTHING when the count confirms what is already stored', () => {
    // No estoque write and no ledger row: a zero-delta row is not a movement,
    // and on a full-catalogue count most produtos match. The report shard still
    // records `estoque` and `contado`, so it stays fully auditable.
    const acao = planejar({ contado: 8, atual: { quantidade: 8, quantidadeReservada: 2 } });
    expect(acao).toEqual({ tipo: 'inalterado', estoqueAntes: 8 });
  });

  it('writes nothing for a produto with no estoque doc counted at zero', () => {
    // No doc means no stock in this depósito — creating an empty one records
    // nothing. Legacy created it, and on the `zerar` path created one for every
    // product in the catalogue.
    expect(planejar({ contado: 0, atual: null })).toEqual({ tipo: 'inalterado', estoqueAntes: 0 });
  });

  it('still writes when the stored counters are junk, so the doc self-heals', () => {
    for (const quantidade of [undefined, null, 'oito', Number.NaN]) {
      const acao = planejar({ contado: 0, atual: { quantidade, quantidadeReservada: 0 } });
      expect(acao.tipo, `quantidade=${String(quantidade)}`).toBe('aplicar');
    }
  });

  it('still writes when the stored reservation is negative', () => {
    // A negative reservation invents availability (`8 − (−2) = 10`), so a
    // balanço that meets one must clamp it rather than call the doc unchanged.
    const acao = planejar({ contado: 8, atual: { quantidade: 8, quantidadeReservada: -2 } });
    if (acao.tipo !== 'aplicar') throw new Error('esperava aplicar');
    expect(acao.plan.quantidadeReservada).toBe(0);
    expect(acao.plan.historico.movimentoReservada).toBe(2);
  });

  it('skips an already-applied produto WITHOUT recomputing the delta', () => {
    // The resume guard. Re-deriving `contado − atual` here would compare the
    // count against a value this same job already moved and record a second,
    // wrong delta (usually 0) on a ledger that must stay summable.
    const acao = planejar({
      jaAplicado: true,
      contado: 5,
      atual: { quantidade: 5, quantidadeReservada: 0 },
    });
    expect(acao).toEqual({ tipo: 'ja-aplicado' });
  });

  it('never emits a null movimento — it throws instead', () => {
    // A null passes the sweep's `exists('movimento')` fail-open probe while
    // `sum` skips it, so the window silently looks unmoved. Dying is better.
    expect(() => planejar({ contado: Number.NaN, atual: null })).toThrow(
      MovimentoBalancoIndefinidoError,
    );
  });
});

describe('motivoBalanco', () => {
  it('stamps the balanço name, server-side', () => {
    expect(motivoBalanco('Contagem Janeiro')).toBe('Balanço Contagem Janeiro');
  });
});

describe('montarListaTrabalho', () => {
  const detalhes = new Map([
    ['p1', { sku: 'A1', nome: 'Camiseta' }],
    ['p2', { sku: 'A2', nome: 'Caneca' }],
    ['kit', { sku: 'K', nome: 'Kit' }],
  ]);

  it('with zerar off, touches only the produtos that were counted', () => {
    const itens = montarListaTrabalho({
      contagem: new Map([['p1', 5]]),
      comEstoque: new Set(['p1', 'p2']),
      kits: new Set(),
      extrasPorProduto: new Map(),
      detalhes,
      zerarNaoContados: false,
    });
    expect(itens).toEqual([
      { produtoId: 'p1', sku: 'A1', nome: 'Camiseta', contado: 5, estoquesExtras: null },
    ]);
  });

  it('with zerar on, adds the uncounted produtos that hold stock here', () => {
    const itens = montarListaTrabalho({
      contagem: new Map([['p1', 5]]),
      comEstoque: new Set(['p1', 'p2']),
      kits: new Set(),
      extrasPorProduto: new Map(),
      detalhes,
      zerarNaoContados: true,
    });
    // `contado: null` — never counted, as distinct from counted-and-empty. It
    // applies as 0 either way; the report keeps the difference.
    expect(itens).toContainEqual({
      produtoId: 'p2',
      sku: 'A2',
      nome: 'Caneca',
      contado: null,
      estoquesExtras: null,
    });
    expect(itens).toHaveLength(2);
  });

  it('never zeroes a kit', () => {
    // A kit holds no stock of its own (ADR 0014) and its quantity ADDS to the
    // component-derived availability, so touching one invents stock.
    const itens = montarListaTrabalho({
      contagem: new Map(),
      comEstoque: new Set(['kit']),
      kits: new Set(['kit']),
      extrasPorProduto: new Map(),
      detalhes,
      zerarNaoContados: true,
    });
    expect(itens).toEqual([]);
  });

  it('carries the duplicate-estoque count through to the report', () => {
    const itens = montarListaTrabalho({
      contagem: new Map([['p1', 5]]),
      comEstoque: new Set(['p1']),
      kits: new Set(),
      extrasPorProduto: new Map([['p1', 2]]),
      detalhes,
      zerarNaoContados: true,
    });
    expect(itens[0]?.estoquesExtras).toBe(2);
  });
});

describe('montarShardsRelatorio', () => {
  const item = (produtoId: string) => ({
    produtoId,
    sku: produtoId.toUpperCase(),
    nome: produtoId,
    contado: 1,
    estoquesExtras: null,
  });

  it('splits in produto-id order so a retry rebuilds the same shards', () => {
    const shards = montarShardsRelatorio([item('c'), item('a'), item('b')], 2);
    expect(shards).toHaveLength(2);
    expect(Object.keys(shards[0]!)).toEqual(['a', 'b']);
    expect(Object.keys(shards[1]!)).toEqual(['c']);
  });

  it('leaves `estoque` null — phase B fills it from inside the transaction', () => {
    // The "before" value has to be the one the applying transaction saw, not
    // whatever phase A happened to read minutes earlier.
    const [shard] = montarShardsRelatorio([item('a')], 500);
    expect(shard!.a).toMatchObject({ sku: 'A', nome: 'a', contado: 1, estoque: null });
  });

  it('returns no shards for an empty work list', () => {
    expect(montarShardsRelatorio([], 500)).toEqual([]);
  });
});
