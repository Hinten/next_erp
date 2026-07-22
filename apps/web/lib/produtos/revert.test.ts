import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { TRUNCATED_VALUE_KEY } from '@delfrance/core';

// Hoisted mocks (vi.mock factories can't close over normal consts).
const h = vi.hoisted(() => ({
  getDocFromServer: vi.fn(),
  produtoDocRef: vi.fn((_db: unknown, _ctx: unknown, id: string) => ({ __ref: 'produto', id })),
  produtoMerge: vi.fn(async () => {}),
  extraDataDocRef: vi.fn((_db: unknown, ctx: unknown, id: string) => ({
    __ref: 'extraData',
    ctx,
    id,
  })),
  extraDataMerge: vi.fn(async () => {}),
  impostoDocRef: vi.fn((_db: unknown, ctx: unknown, id: string) => ({
    __ref: 'imposto',
    ctx,
    id,
  })),
  impostoMerge: vi.fn(async () => {}),
}));

vi.mock('firebase/firestore', () => ({ getDocFromServer: h.getDocFromServer }));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { docRef: h.produtoDocRef, merge: h.produtoMerge },
}));
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: { docRef: h.extraDataDocRef, merge: h.extraDataMerge },
}));
vi.mock('@/lib/data/impostoProdutoCollection', () => ({
  impostoProdutoCollection: { docRef: h.impostoDocRef, merge: h.impostoMerge },
}));

import {
  REVERTIBLE_EXTRA_DATA_FIELDS,
  REVERTIBLE_PRODUTO_FIELDS,
  applyRevert,
  checkRevert,
  isRevertible,
  type RevertTarget,
} from './revert';

const db = {} as unknown as Firestore;

function target(overrides: Partial<RevertTarget> = {}): RevertTarget {
  return {
    produtoId: 'prod1',
    subcolecao: null,
    docId: 'prod1',
    field: 'nome',
    oldValue: 'Antigo',
    newValue: 'Novo',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('whitelist membership', () => {
  it('produto scope carries the documented safe fields', () => {
    for (const f of [
      'nome',
      'sku',
      'gtin',
      'codPai',
      'codFornecedor',
      'ordem',
      'custo',
      'precos',
      'pesoLiquidoKg',
      'pesoBrutoKg',
      'alturaCm',
      'larguraCm',
      'profundidadeCm',
      'publicado',
      'ofereceFreteGratis',
      'permiteVendaSemEstoque',
      'ehUsado',
      'crossdocking',
      'categoriaProdutoOuterRef',
      'tabelaDeMedidasModaUid',
      'propagatePriceToChildren',
    ]) {
      expect(REVERTIBLE_PRODUTO_FIELDS.has(f)).toBe(true);
    }
    // Server-owned/denorm/identity fields never make the cut.
    for (const f of ['paiId', 'componentesKitKeys', 'fotosArquivosIds', 'variacoesUid']) {
      expect(REVERTIBLE_PRODUTO_FIELDS.has(f)).toBe(false);
    }
  });

  it('extraData scope carries the documented safe fields', () => {
    for (const f of [
      'descricao',
      'marca',
      'metaDescricao',
      'keyWords',
      'youtube',
      'condicao',
      'coteudoAdulto',
      'itensNoKit',
      'googleMerchantData',
    ]) {
      expect(REVERTIBLE_EXTRA_DATA_FIELDS.has(f)).toBe(true);
    }
  });

  it('imposto scope allows every field except id/timestamp', () => {
    expect(isRevertible('imposto', 'origem', { old: '0', new: '1' }).ok).toBe(true);
    expect(isRevertible('imposto', 'configuracaoICMS', { old: {}, new: {} }).ok).toBe(true);
    expect(isRevertible('imposto', 'id', { old: 'a', new: 'b' }).ok).toBe(false);
    expect(isRevertible('imposto', 'timestamp', { old: 1, new: 2 }).ok).toBe(false);
  });
});

describe('isRevertible', () => {
  it('rejects a non-whitelisted produto field with a pt-BR reason', () => {
    const result = isRevertible(null, 'paiId', { old: null, new: 'x' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(typeof result.reason).toBe('string');
  });

  it('rejects an unknown subcolecao entirely', () => {
    expect(isRevertible('estoques', 'quantidade', { old: 0, new: 1 }).ok).toBe(false);
  });

  it('rejects when the OLD side is the truncation sentinel', () => {
    const result = isRevertible(null, 'precos', {
      old: { [TRUNCATED_VALUE_KEY]: true, _bytes: 999 },
      new: { l1: { valor: 10 } },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('rejects when the NEW side is the truncation sentinel', () => {
    const result = isRevertible(null, 'precos', {
      old: { l1: { valor: 10 } },
      new: { [TRUNCATED_VALUE_KEY]: true, _bytes: 999 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('accepts a whitelisted, non-truncated produto field', () => {
    expect(isRevertible(null, 'nome', { old: 'A', new: 'B' })).toEqual({ ok: true, reason: null });
  });

  it('accepts a whitelisted extraData field', () => {
    expect(isRevertible('extraData', 'descricao', { old: 'A', new: 'B' }).ok).toBe(true);
  });
});

describe('checkRevert', () => {
  it('reports no conflict when the current value matches the recorded "new" side', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => ({ nome: 'Novo' }) });
    const result = await checkRevert(db, target());
    expect(result).toEqual({ conflict: false, currentValue: 'Novo' });
    expect(h.produtoDocRef).toHaveBeenCalledWith(db, {}, 'prod1');
  });

  it('reports a conflict when the field moved again since the entry was recorded', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => ({ nome: 'Mais Novo Ainda' }) });
    const result = await checkRevert(db, target());
    expect(result).toEqual({ conflict: true, currentValue: 'Mais Novo Ainda' });
  });

  it('treats a missing doc as a null current value', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => undefined });
    const result = await checkRevert(db, target({ newValue: null }));
    expect(result).toEqual({ conflict: false, currentValue: null });
  });

  it('reads through the extraData handle with the produtoId context', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => ({ descricao: 'x' }) });
    await checkRevert(
      db,
      target({ subcolecao: 'extraData', docId: 'singleton', field: 'descricao', newValue: 'x' }),
    );
    expect(h.extraDataDocRef).toHaveBeenCalledWith(db, { produtoId: 'prod1' }, 'singleton');
  });

  it('reads through the imposto handle with the produtoId context', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => ({ origem: '1' }) });
    await checkRevert(
      db,
      target({ subcolecao: 'imposto', docId: 'op1', field: 'origem', newValue: '1' }),
    );
    expect(h.impostoDocRef).toHaveBeenCalledWith(db, { produtoId: 'prod1' }, 'op1');
  });
});

describe('applyRevert', () => {
  it('merges the old value back onto the produto doc', async () => {
    await applyRevert(db, target({ oldValue: 'Antigo', field: 'nome' }));
    expect(h.produtoMerge).toHaveBeenCalledWith(db, {}, 'prod1', { nome: 'Antigo' });
    expect(h.extraDataMerge).not.toHaveBeenCalled();
    expect(h.impostoMerge).not.toHaveBeenCalled();
  });

  it('coalesces an absent old value to null (never undefined)', async () => {
    await applyRevert(db, target({ oldValue: undefined, field: 'sku' }));
    expect(h.produtoMerge).toHaveBeenCalledWith(db, {}, 'prod1', { sku: null });
  });

  it('routes to the extraData handle for subcolecao "extraData"', async () => {
    await applyRevert(
      db,
      target({
        subcolecao: 'extraData',
        docId: 'singleton',
        field: 'marca',
        oldValue: 'Marca X',
      }),
    );
    expect(h.extraDataMerge).toHaveBeenCalledWith(db, { produtoId: 'prod1' }, 'singleton', {
      marca: 'Marca X',
    });
    expect(h.produtoMerge).not.toHaveBeenCalled();
  });

  it('routes to the imposto handle for subcolecao "imposto"', async () => {
    await applyRevert(
      db,
      target({ subcolecao: 'imposto', docId: 'op1', field: 'origem', oldValue: '0' }),
    );
    expect(h.impostoMerge).toHaveBeenCalledWith(db, { produtoId: 'prod1' }, 'op1', { origem: '0' });
  });

  it('throws on an unsupported subcolecao instead of silently no-op-ing', async () => {
    await expect(applyRevert(db, target({ subcolecao: 'estoques' }))).rejects.toThrow();
    expect(h.produtoMerge).not.toHaveBeenCalled();
  });

  it('enforces the whitelist itself — a non-whitelisted field never reaches merge()', async () => {
    // The UI gates via isRevertible before offering Restaurar, but the data
    // layer must not trust the caller: rules do not re-encode the whitelist.
    await expect(applyRevert(db, target({ field: 'fotos', oldValue: [] }))).rejects.toThrow(
      /não é restaurável/,
    );
    expect(h.produtoMerge).not.toHaveBeenCalled();
  });
});
