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

import { impostoProdutoSchema, produtoExtraDataSchema } from '@delfrance/schemas';
import {
  REVERTIBLE_EXTRA_DATA_FIELDS,
  REVERTIBLE_PRODUTO_FIELDS,
  buildDocumentRestorePrefill,
  buildRevertPrefill,
  checkDocumentRestore,
  checkRevert,
  isDocumentRestorable,
  isRevertible,
  RevertPrefillError,
  type DocumentRestoreTarget,
  type RevertPrefillBase,
  type RevertTarget,
} from './revert';

const db = {} as unknown as Firestore;

/** The transient form fields a revert folds into; both null unless a test seeds one. */
function base(overrides: Partial<RevertPrefillBase> = {}): RevertPrefillBase {
  return { extraData: null, impostos: null, ...overrides };
}

/** An imposto form row as `montarLinhasImposto` builds it, scoped to one operação. */
function impostoRow(operacaoId: string, extra: Record<string, unknown> = {}) {
  return {
    id: operacaoId,
    impostoOpercaoOuterRef: `operacao/${operacaoId}`,
    origem: '0',
    ...extra,
  } as unknown as NonNullable<RevertPrefillBase['impostos']>[number];
}

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

/** A `delete`-kind entry's target, as `buildDocumentRestorePrefill` needs it. */
function docTarget(overrides: Partial<DocumentRestoreTarget> = {}): DocumentRestoreTarget {
  return {
    produtoId: 'prod1',
    subcolecao: 'extraData',
    docId: 'singleton',
    changes: { descricao: { old: 'Descrição antiga', new: null } },
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
    // Server-owned/denorm/identity fields never make the cut. `ordem` joins them:
    // it is server ordering, hidden from the form, so a staged revert of it
    // would have nothing on screen to review (see the set's doc comment).
    for (const f of ['paiId', 'componentesKitKeys', 'fotosArquivosIds', 'variacoesUid', 'ordem']) {
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

  it('keys the produto scope on produtoId, ignoring a mismatched docId', async () => {
    // `refFor` is the only place a revert still resolves a document, so this is
    // where the guard lives now that staging replaced the direct write: a
    // malformed target naming another doc must never redirect the read.
    h.getDocFromServer.mockResolvedValue({ data: () => ({ nome: 'Novo' }) });
    await checkRevert(db, target({ docId: 'outro-produto' }));
    expect(h.produtoDocRef).toHaveBeenCalledWith(db, {}, 'prod1');
  });
});

describe('buildRevertPrefill', () => {
  it('maps a produto-doc field to its own form key', () => {
    expect(buildRevertPrefill(target({ field: 'nome', oldValue: 'Antigo' }), base())).toEqual({
      key: 'nome',
      value: 'Antigo',
    });
  });

  it('coalesces an absent old value to null (never undefined)', () => {
    expect(buildRevertPrefill(target({ field: 'sku', oldValue: undefined }), base())).toEqual({
      key: 'sku',
      value: null,
    });
  });

  it('writes nothing to Firestore — the produto handles are never touched', () => {
    buildRevertPrefill(target({ field: 'nome', oldValue: 'Antigo' }), base());
    expect(h.produtoMerge).not.toHaveBeenCalled();
    expect(h.extraDataMerge).not.toHaveBeenCalled();
    expect(h.impostoMerge).not.toHaveBeenCalled();
  });

  it('folds an extraData revert into the WHOLE object, preserving its siblings', () => {
    // `extraData` is ONE form key holding the whole singleton, so the pre-fill
    // has to carry every other field forward. Dropping them here would blank
    // them on save — the failure mode this scope exists to avoid.
    const result = buildRevertPrefill(
      target({ subcolecao: 'extraData', docId: 'singleton', field: 'marca', oldValue: 'Marca X' }),
      base({
        extraData: {
          descricao: 'mantida',
          marca: 'Marca Y',
          youtube: 'https://exemplo',
        } as unknown as NonNullable<RevertPrefillBase['extraData']>,
      }),
    );
    expect(result.key).toBe('extraData');
    expect(result.value).toEqual({
      descricao: 'mantida',
      marca: 'Marca X',
      youtube: 'https://exemplo',
    });
  });

  it('refuses an extraData revert when the singleton has not been loaded', () => {
    expect(() =>
      buildRevertPrefill(
        target({ subcolecao: 'extraData', docId: 'singleton', field: 'marca' }),
        base(),
      ),
    ).toThrow(RevertPrefillError);
  });

  it('patches ONLY the imposto row whose operação the entry names', () => {
    const rows = [impostoRow('op1'), impostoRow('op2'), impostoRow('op3')];
    const result = buildRevertPrefill(
      target({ subcolecao: 'imposto', docId: 'op2', field: 'origem', oldValue: '3' }),
      base({ impostos: rows }),
    );
    expect(result.key).toBe('impostos');
    const next = result.value as typeof rows;
    expect(next[1]).toMatchObject({ id: 'op2', origem: '3' });
    // The untouched rows come through byte-identical, and the input is not mutated.
    expect(next[0]).toEqual(rows[0]);
    expect(next[2]).toEqual(rows[2]);
    expect(rows[1]).toMatchObject({ origem: '0' });
  });

  it('refuses an imposto revert whose operação is no longer among the rows', () => {
    expect(() =>
      buildRevertPrefill(
        target({ subcolecao: 'imposto', docId: 'op-inativa', field: 'origem', oldValue: '3' }),
        base({ impostos: [impostoRow('op1')] }),
      ),
    ).toThrow(RevertPrefillError);
  });

  it('refuses an imposto revert when the tab rows have not been loaded', () => {
    expect(() =>
      buildRevertPrefill(target({ subcolecao: 'imposto', docId: 'op1', field: 'origem' }), base()),
    ).toThrow(RevertPrefillError);
  });

  it('throws on an unsupported subcolecao instead of silently no-op-ing', () => {
    expect(() => buildRevertPrefill(target({ subcolecao: 'estoques' }), base())).toThrow();
  });

  it('enforces the whitelist itself — a non-whitelisted field is never staged', () => {
    // The UI gates via isRevertible before offering Restaurar, but this is the
    // single choke point every revert passes through: it must not trust the
    // caller, exactly as the direct-write path it replaced did not.
    expect(() => buildRevertPrefill(target({ field: 'fotos', oldValue: [] }), base())).toThrow(
      /não é restaurável/,
    );
  });
});

describe('isDocumentRestorable', () => {
  it('rejects the produto document itself — permanently out of scope (#648)', () => {
    const result = isDocumentRestorable(null, { nome: { old: 'A', new: null } });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('rejects an unknown subcolecao', () => {
    expect(isDocumentRestorable('estoques', { quantidade: { old: 1, new: null } }).ok).toBe(false);
  });

  it('accepts extraData with no truncated fields', () => {
    expect(isDocumentRestorable('extraData', { descricao: { old: 'x', new: null } })).toEqual({
      ok: true,
      reason: null,
    });
  });

  it('accepts imposto with no truncated fields', () => {
    expect(isDocumentRestorable('imposto', { origem: { old: '0', new: null } })).toEqual({
      ok: true,
      reason: null,
    });
  });

  it('rejects when ANY field is truncated, even a restorable scope', () => {
    const result = isDocumentRestorable('extraData', {
      descricao: { old: { [TRUNCATED_VALUE_KEY]: true, _bytes: 999 }, new: null },
      marca: { old: 'Marca X', new: null },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('checkDocumentRestore', () => {
  it('reports no conflict when the document is still gone', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => undefined });
    const result = await checkDocumentRestore(db, docTarget());
    expect(result).toEqual({ conflict: false, currentData: null });
  });

  it('reports a conflict when something occupies the document again — even an empty one', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => ({}) });
    const result = await checkDocumentRestore(db, docTarget());
    expect(result).toEqual({ conflict: true, currentData: {} });
  });

  it('surfaces the current document data on conflict', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => ({ descricao: 'Recriado depois' }) });
    const result = await checkDocumentRestore(db, docTarget());
    expect(result).toEqual({ conflict: true, currentData: { descricao: 'Recriado depois' } });
  });

  it('reads through the extraData handle with the produtoId context', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => undefined });
    await checkDocumentRestore(db, docTarget({ subcolecao: 'extraData', docId: 'singleton' }));
    expect(h.extraDataDocRef).toHaveBeenCalledWith(db, { produtoId: 'prod1' }, 'singleton');
  });

  it('reads through the imposto handle with the produtoId context', async () => {
    h.getDocFromServer.mockResolvedValue({ data: () => undefined });
    await checkDocumentRestore(db, docTarget({ subcolecao: 'imposto', docId: 'op1' }));
    expect(h.impostoDocRef).toHaveBeenCalledWith(db, { produtoId: 'prod1' }, 'op1');
  });
});

describe('buildDocumentRestorePrefill', () => {
  it('writes nothing to Firestore — the produto handles are never touched', () => {
    buildDocumentRestorePrefill(docTarget(), base());
    expect(h.produtoMerge).not.toHaveBeenCalled();
    expect(h.extraDataMerge).not.toHaveBeenCalled();
    expect(h.impostoMerge).not.toHaveBeenCalled();
  });

  it('throws on the produto document scope instead of silently no-op-ing', () => {
    expect(() => buildDocumentRestorePrefill(docTarget({ subcolecao: null }), base())).toThrow(
      /não é restaurável/,
    );
  });

  it('refuses when a field is the truncation sentinel', () => {
    expect(() =>
      buildDocumentRestorePrefill(
        docTarget({
          changes: {
            descricao: { old: { [TRUNCATED_VALUE_KEY]: true, _bytes: 999 }, new: null },
          },
        }),
        base(),
      ),
    ).toThrow(/não é restaurável/);
  });

  it('reconstructs the whole extraData singleton, schema-defaulting untouched fields', () => {
    const result = buildDocumentRestorePrefill(
      docTarget({
        subcolecao: 'extraData',
        docId: 'singleton',
        changes: {
          descricao: { old: 'Descrição antiga', new: null },
          marca: { old: 'Marca X', new: null },
        },
      }),
      base(),
    );
    expect(result.key).toBe('extraData');
    expect(result.value).toEqual(
      produtoExtraDataSchema.parse({ descricao: 'Descrição antiga', marca: 'Marca X' }),
    );
  });

  it('reconstructs extraData even when the singleton tab has never been loaded', () => {
    // Unlike the field-level revert, a document restore has nothing of the
    // CURRENT `extraData` to fold into — the deleted entry's `changes` already
    // carries the whole object — so an unloaded tab (`base.extraData: null`)
    // is not a blocker here.
    const result = buildDocumentRestorePrefill(
      docTarget({ subcolecao: 'extraData', docId: 'singleton' }),
      base(),
    );
    expect(result.key).toBe('extraData');
  });

  it('replaces ONLY the imposto row the entry names, dropping id/timestamp', () => {
    const rows = [impostoRow('op1'), impostoRow('op2'), impostoRow('op3')];
    const result = buildDocumentRestorePrefill(
      docTarget({
        subcolecao: 'imposto',
        docId: 'op2',
        changes: {
          id: { old: 'op2', new: null },
          timestamp: { old: 123456, new: null },
          impostoOpercaoOuterRef: { old: 'operacao/op2', new: null },
          origem: { old: '3', new: null },
          cfop: { old: '5102', new: null },
        },
      }),
      base({ impostos: rows }),
    );
    expect(result.key).toBe('impostos');
    const next = result.value as typeof rows;
    expect(next[1]).toEqual(
      impostoProdutoSchema.parse({
        origem: '3',
        cfop: '5102',
        impostoOpercaoOuterRef: 'operacao/op2',
      }),
    );
    // `id`/`timestamp` are server/doc identity — dropped, not carried over from
    // the deleted snapshot; the save path re-derives both.
    expect(next[1]).toMatchObject({ id: null, timestamp: null });
    // The untouched rows come through byte-identical, and the input is not mutated.
    expect(next[0]).toEqual(rows[0]);
    expect(next[2]).toEqual(rows[2]);
    expect(rows[1]).toMatchObject({ origem: '0' });
  });

  it('refuses an imposto restore whose operação is no longer among the rows', () => {
    expect(() =>
      buildDocumentRestorePrefill(
        docTarget({
          subcolecao: 'imposto',
          docId: 'op-inativa',
          changes: { origem: { old: '3', new: null } },
        }),
        base({ impostos: [impostoRow('op1')] }),
      ),
    ).toThrow(RevertPrefillError);
  });

  it('refuses an imposto restore when the tab rows have not been loaded', () => {
    expect(() =>
      buildDocumentRestorePrefill(
        docTarget({
          subcolecao: 'imposto',
          docId: 'op1',
          changes: { origem: { old: '3', new: null } },
        }),
        base(),
      ),
    ).toThrow(RevertPrefillError);
  });
});
