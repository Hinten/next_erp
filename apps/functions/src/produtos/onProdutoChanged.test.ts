import { describe, expect, it } from 'vitest';

import { CAMPOS_ROLLUP_KIT } from './kitRollupPayload';
import {
  PRODUTO_HISTORY_IGNORE_FIELDS,
  produtoExtraIgnores,
  sincronizarMembroUnico,
} from './onProdutoChanged';

describe('PRODUTO_HISTORY_IGNORE_FIELDS', () => {
  it('is exactly the noisy/denorm-churn field set (owner list, 2026-07-21; +integracoesComProduto #920, +marketplaceIds #961)', () => {
    expect([...PRODUTO_HISTORY_IGNORE_FIELDS].sort()).toEqual(
      [
        'componentesKitKeys',
        'fotosArquivosIds',
        // #920 moved this array's maintenance into the two ML link triggers, so
        // every publish/import/cancel now writes it from the server. It is
        // denorm churn exactly like its `marketplace` sibling above, and an
        // operator never edits it by hand.
        'integracoesComProduto',
        'marketplace',
        // #961: written by the same five stamps as `marketplace`, but it was
        // missing from this list — so one of the pair produced history rows and
        // the other did not.
        'marketplaceIds',
        'nome_embedding',
        'statusProdutosMarketplace',
        'timestamp',
        'ultimaModificacao',
      ].sort(),
    );
  });
});

describe('produtoExtraIgnores', () => {
  it('is empty for a parent write (paiId null via after)', () => {
    expect(produtoExtraIgnores({}, { paiId: null })).toEqual([]);
  });

  it('is empty for a parent write (paiId absent via after)', () => {
    expect(produtoExtraIgnores({}, {})).toEqual([]);
  });

  it('ignores precos for a variation child write (paiId set via after)', () => {
    expect(produtoExtraIgnores({}, { paiId: 'pai1' })).toEqual(['precos']);
  });

  it('falls back to before.paiId when after is undefined (delete of a variation child)', () => {
    expect(produtoExtraIgnores({ paiId: 'pai1' }, undefined)).toEqual(['precos']);
  });

  it('is empty on a parent delete (before.paiId null, after undefined)', () => {
    expect(produtoExtraIgnores({ paiId: null }, undefined)).toEqual([]);
  });

  it('is empty when both revisions are undefined', () => {
    expect(produtoExtraIgnores(undefined, undefined)).toEqual([]);
  });
});

describe('produtoExtraIgnores — kit rollup fields (#1152)', () => {
  it('ignores the five derived fields on a kit write', () => {
    expect([...produtoExtraIgnores({}, { ehKit: true })].sort()).toEqual(
      ['alturaCm', 'larguraCm', 'pesoBrutoKg', 'pesoLiquidoKg', 'profundidadeCm'].sort(),
    );
  });

  it('does NOT ignore them on an ordinary produto — that is the operator edit worth auditing', () => {
    expect(produtoExtraIgnores({}, { ehKit: false })).toEqual([]);
    expect(produtoExtraIgnores({}, {})).toEqual([]);
  });

  it('stacks with the variation-child precos rule', () => {
    expect([...produtoExtraIgnores({}, { ehKit: true, paiId: 'pai1' })].sort()).toEqual(
      ['alturaCm', 'larguraCm', 'pesoBrutoKg', 'pesoLiquidoKg', 'precos', 'profundidadeCm'].sort(),
    );
  });

  it('falls back to before on a kit delete', () => {
    expect(produtoExtraIgnores({ ehKit: true }, undefined)).toContain('pesoBrutoKg');
  });

  it('covers EVERY field the rollup writes', () => {
    // Derived from the rollup's own field list rather than retyped, so a sixth
    // derived field cannot start generating phantom history rows on kits.
    expect([...produtoExtraIgnores({}, { ehKit: true })].sort()).toEqual(
      [...CAMPOS_ROLLUP_KIT].sort(),
    );
  });
});

/**
 * The sole member's mirror (#1398, PR 7b) — the two error branches.
 *
 * The happy path, the operator-divergence path and the no-op path are driven
 * against a real Firestore in `onProdutoChanged.storage.test.ts`. These two are
 * here because they need a write to land BETWEEN the read and the update, which
 * no emulator test can interleave.
 */
describe('sincronizarMembroUnico — losing the write', () => {
  /** The narrowest `db` this function touches: one doc ref, get + update. */
  function stubDb(update: () => Promise<unknown>, exists = true) {
    const chamadas: Array<Record<string, unknown>> = [];
    // ⚠️ Reads are counted, not just writes. "Costs nothing when nothing moved"
    // is a claim about READS — the member is fetched only after a pure diff says
    // there is something to write — and a write-only assertion cannot see it.
    let leituras = 0;
    const ref = {
      get: async () => {
        leituras += 1;
        return {
          exists,
          updateTime: 'ut-1',
          data: () => ({ nome: 'Bandeja', paiId: 'p1' }),
        };
      },
      update: async (patch: Record<string, unknown>) => {
        chamadas.push(patch);
        return update();
      },
    };
    return {
      db: { collection: () => ({ doc: () => ref }) } as never,
      chamadas,
      leituras: () => leituras,
    };
  }

  const antes = { paiId: null, filhoUnicoId: 'c1', nome: 'Bandeja' };
  const depois = { paiId: null, filhoUnicoId: 'c1', nome: 'Bandeja Decorativa' };

  it('drops a FAILED_PRECONDITION — the concurrent writer holds the newer state', async () => {
    const { db, chamadas } = stubDb(() =>
      Promise.reject(Object.assign(new Error('stale'), { code: 9 })),
    );
    await expect(sincronizarMembroUnico(db, 'p1', antes, depois)).resolves.toBeNull();
    // It DID try — otherwise this test would pass with the whole feature removed.
    expect(chamadas).toEqual([{ nome: 'Bandeja Decorativa' }]);
  });

  // ⚠️ Rule 6: everything that is not the one expected failure rethrows. A
  // swallowed PERMISSION_DENIED would leave the sellable half of every produto
  // silently stale, which is the failure this whole PR exists to end.
  it('rethrows anything else', async () => {
    const { db } = stubDb(() => Promise.reject(Object.assign(new Error('denied'), { code: 7 })));
    await expect(sincronizarMembroUnico(db, 'p1', antes, depois)).rejects.toThrow('denied');
  });

  // ⚠️ The common case, and the one with a cost: most produto saves move nothing
  // the member mirrors. Asserting the READ is the point — the planner would
  // return null either way, so a write-only assertion passes with the gate gone.
  it('reads nothing when the parent moved nothing mirrored', async () => {
    const { db, chamadas, leituras } = stubDb(() => Promise.resolve());
    await expect(
      sincronizarMembroUnico(db, 'p1', antes, { ...antes, custo: 9 }),
    ).resolves.toBeNull();
    expect(chamadas).toEqual([]);
    expect(leituras()).toBe(0);
  });

  it('does not write when the pointer names a document that is gone', async () => {
    const { db, chamadas } = stubDb(() => Promise.resolve(), false);
    await expect(sincronizarMembroUnico(db, 'p1', antes, depois)).resolves.toBeNull();
    expect(chamadas).toEqual([]);
  });

  it('is a no-op on a produto with no sole member', async () => {
    const { db, chamadas, leituras } = stubDb(() => Promise.resolve());
    const semPonteiro = { paiId: null, filhoUnicoId: null, nome: 'x' };
    await expect(sincronizarMembroUnico(db, 'p1', antes, semPonteiro)).resolves.toBeNull();
    expect(chamadas).toEqual([]);
    expect(leituras()).toBe(0);
  });

  // A produto that IS a child never has a sole member of its own, and the mirror
  // write itself lands on one — so without this the trigger the mirror fires
  // would look for a member on the member.
  it('is a no-op on a variation child, whatever its pointer says', async () => {
    const { db, leituras } = stubDb(() => Promise.resolve());
    const filho = { paiId: 'p1', filhoUnicoId: 'c9', nome: 'x' };
    await expect(sincronizarMembroUnico(db, 'c1', antes, filho)).resolves.toBeNull();
    expect(leituras()).toBe(0);
  });
});
