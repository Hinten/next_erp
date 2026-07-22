import { describe, expect, it } from 'vitest';
import { computeProdutoHistoryChanges, isParentProdutoWrite } from './onProdutoPrecoCustoChanged';

describe('isParentProdutoWrite', () => {
  it('is false on a delete (after undefined)', () => {
    expect(isParentProdutoWrite(undefined)).toBe(false);
  });

  it('is false for a variation child (paiId set)', () => {
    expect(isParentProdutoWrite({ paiId: 'pai1' })).toBe(false);
  });

  it('is true for a parent (paiId null or absent)', () => {
    expect(isParentProdutoWrite({ paiId: null })).toBe(true);
    expect(isParentProdutoWrite({})).toBe(true);
  });
});

describe('computeProdutoHistoryChanges — precos', () => {
  it('create (before undefined): every precos entry is an "added" change (valorOriginal null)', () => {
    const after = { precos: { l1: { valor: 10 }, l2: { valor: 20 } } };
    const { precoChanges } = computeProdutoHistoryChanges(undefined, after);
    expect(precoChanges).toEqual(
      expect.arrayContaining([
        { listaId: 'l1', valorOriginal: null, valorFinal: 10 },
        { listaId: 'l2', valorOriginal: null, valorFinal: 20 },
      ]),
    );
    expect(precoChanges).toHaveLength(2);
  });

  it('update: only the entries that actually changed are reported', () => {
    const before = { precos: { l1: { valor: 10 }, l2: { valor: 20 } } };
    const after = { precos: { l1: { valor: 15 }, l2: { valor: 20 } } };
    const { precoChanges } = computeProdutoHistoryChanges(before, after);
    expect(precoChanges).toEqual([{ listaId: 'l1', valorOriginal: 10, valorFinal: 15 }]);
  });

  it('no change: empty precoChanges', () => {
    const precos = { l1: { valor: 10 } };
    const { precoChanges } = computeProdutoHistoryChanges({ precos }, { precos });
    expect(precoChanges).toEqual([]);
  });

  it('a removed price entry is reported with valorFinal null', () => {
    const before = { precos: { l1: { valor: 10 } } };
    const after = { precos: {} };
    const { precoChanges } = computeProdutoHistoryChanges(before, after);
    expect(precoChanges).toEqual([{ listaId: 'l1', valorOriginal: 10, valorFinal: null }]);
  });
});

describe('computeProdutoHistoryChanges — custo (novo / editar / remoção-not-recorded matrix)', () => {
  it('create with a numeric custo → recorded ("novo")', () => {
    expect(computeProdutoHistoryChanges(undefined, { custo: 50 }).custoChange).toBe(50);
  });

  it('create with no custo → not recorded', () => {
    expect(computeProdutoHistoryChanges(undefined, { custo: null }).custoChange).toBeNull();
    expect(computeProdutoHistoryChanges(undefined, {}).custoChange).toBeNull();
  });

  it('changed custo → recorded ("editar")', () => {
    expect(computeProdutoHistoryChanges({ custo: 50 }, { custo: 80 }).custoChange).toBe(80);
  });

  it('unchanged custo → not recorded', () => {
    expect(computeProdutoHistoryChanges({ custo: 50 }, { custo: 50 }).custoChange).toBeNull();
  });

  it('custo removed (cleared to null) → NOT recorded — legacy parity', () => {
    expect(computeProdutoHistoryChanges({ custo: 50 }, { custo: null }).custoChange).toBeNull();
  });
});
