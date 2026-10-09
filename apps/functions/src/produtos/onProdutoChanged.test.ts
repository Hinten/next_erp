import { FieldValue } from 'firebase-admin/firestore';
import { linhaVariacaoDeKit, toOuterRef } from '@delfrance/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CAMPOS_ROLLUP_KIT } from './kitRollupPayload';
import {
  PRODUTO_HISTORY_IGNORE_FIELDS,
  produtoExtraIgnores,
  reapontarKitsQueReferenciam,
  recordProdutoModificationAndPropagate,
  sincronizarMembroUnico,
} from './onProdutoChanged';

/**
 * The Shopee native-kit recipe aviso's shared decision (step 19, #1527) is a
 * RECORDER in this file: what is pinned here is the trigger's WIRING — where the
 * call sits, what it is handed, and what it costs. The decision over a real
 * Firestore is `onProdutoChanged.storage.test.ts`.
 */
const avisos = vi.hoisted(() => ({ reavaliar: vi.fn() }));
vi.mock('@delfrance/data/admin/avisos', async (original) => ({
  ...(await original<typeof import('@delfrance/data/admin/avisos')>()),
  reavaliarAvisoDeReceitaKit: avisos.reavaliar,
}));

describe('PRODUTO_HISTORY_IGNORE_FIELDS', () => {
  it('is exactly the noisy/denorm-churn field set', () => {
    expect([...PRODUTO_HISTORY_IGNORE_FIELDS].sort()).toEqual(
      [
        'componentesKitKeys',
        'fotosArquivosIds',
        // #920 moved this array's maintenance into the two ML link triggers, so
        // every publish/import/cancel now writes it from the server. It is
        // denorm churn, and an operator never edits it by hand.
        'integracoesComProduto',
        // Kept even though `produtoSchema` no longer declares the field: the
        // sweep that deletes the stored key fires this trigger per produto, and
        // a disappearing key is a CHANGE to `diffDocumentFields`. Without this
        // entry that sweep writes one history row per produto.
        'nome_embedding',
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

  it('ignores precos for an Admin-SDK variation child write (paiId set via after)', () => {
    expect(produtoExtraIgnores({}, { paiId: 'pai1' })).toEqual(['precos']);
  });

  it('audits precos for an authenticated variation child write', () => {
    expect(produtoExtraIgnores({}, { paiId: 'pai1' }, 'documents/usuarios/u1')).toEqual([]);
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
  /**
   * The narrowest `db` this function touches — but keyed BY DOC ID, because it
   * reads two different documents now: the member, and the PARENT AS IT IS NOW.
   *
   * ⚠️ A stub returning one document for every id hid that entirely. It made the
   * fresh-parent read answer with the member's own data, so the tests reported a
   * mirror that had stopped working.
   */
  function stubDb(
    update: () => Promise<unknown>,
    opts: { exists?: boolean; pai?: Record<string, unknown> } = {},
  ) {
    const chamadas: Array<Record<string, unknown>> = [];
    // ⚠️ Reads are counted, not just writes. "Costs nothing when nothing moved"
    // is a claim about READS — the member is fetched only after a pure diff says
    // there is something to write — and a write-only assertion cannot see it.
    let leituras = 0;
    const docs: Record<string, Record<string, unknown>> = {
      p1: opts.pai ?? { paiId: null, filhoUnicoId: 'c1', nome: 'Bandeja Decorativa' },
      c1: { nome: 'Bandeja', paiId: 'p1' },
    };
    const refDe = (id: string) => ({
      get: async () => {
        // Only the MEMBER read is counted: the parent read is behind the same
        // pure gate and paid on the same occasions, so counting both would make
        // "reads nothing when nothing moved" pass for the wrong reason.
        if (id !== 'p1') leituras += 1;
        return {
          exists: id === 'p1' ? true : (opts.exists ?? true),
          updateTime: 'ut-1',
          data: () => docs[id],
        };
      },
      update: async (patch: Record<string, unknown>) => {
        chamadas.push(patch);
        return update();
      },
    });
    return {
      db: { collection: () => ({ doc: (id: string) => refDe(id) }) } as never,
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
    const { db, chamadas } = stubDb(() => Promise.resolve(), { exists: false });
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

/**
 * ⛔ The ordering guard, found overstated by adversarial review.
 *
 * The three-way merge decides staleness by VALUE equality, which cannot tell "the
 * member still holds MY before" from "the member holds a NEWER value that happens
 * to equal my before". For the four mirrored booleans the value space is two, so
 * an A→B→A sequence of parent saves delivered out of order used to land the older
 * run's value on the member and FREEZE it there — every later toggle then found
 * the member diverged and declined.
 *
 * What makes it converge is deriving the patch from the parent AS IT IS NOW.
 */
describe('sincronizarMembroUnico — an out-of-order delivery converges', () => {
  function stubComPai(pai: Record<string, unknown>, membro: Record<string, unknown>) {
    const chamadas: Array<Record<string, unknown>> = [];
    const docs: Record<string, Record<string, unknown>> = { p1: pai, c1: membro };
    const refDe = (id: string) => ({
      get: async () => ({ exists: true, updateTime: 'ut-1', data: () => docs[id] }),
      update: async (patch: Record<string, unknown>) => {
        chamadas.push(patch);
        return Promise.resolve();
      },
    });
    return {
      db: { collection: () => ({ doc: (id: string) => refDe(id) }) } as never,
      chamadas,
    };
  }

  const PAI_FINAL = { paiId: null, filhoUnicoId: 'c1', publicado: false };

  // The operator ticked Publicado and immediately unticked it. The parent's final
  // state is `false`; the LATE delivery is the one that saw false→true.
  it('does not resurrect a value the parent no longer holds', async () => {
    const { db, chamadas } = stubComPai(PAI_FINAL, { paiId: 'p1', publicado: false });

    await expect(
      sincronizarMembroUnico(
        db,
        'p1',
        { paiId: null, filhoUnicoId: 'c1', publicado: false },
        // ⚠️ `after` says TRUE — this delivery's snapshot, already superseded.
        { paiId: null, filhoUnicoId: 'c1', publicado: true },
      ),
    ).resolves.toBeNull();

    expect(chamadas).toEqual([]);
  });

  // ...and the near-miss: a delivery whose `after` agrees with the current parent
  // must still write, or the fix has simply disabled the mirror.
  it('still mirrors when the parent really did move', async () => {
    const pai = { paiId: null, filhoUnicoId: 'c1', publicado: true };
    const { db, chamadas } = stubComPai(pai, { paiId: 'p1', publicado: false });

    await expect(
      sincronizarMembroUnico(
        db,
        'p1',
        { paiId: null, filhoUnicoId: 'c1', publicado: false },
        { paiId: null, filhoUnicoId: 'c1', publicado: true },
      ),
    ).resolves.toBe('c1');

    expect(chamadas).toEqual([{ publicado: true }]);
  });
});

/**
 * `reapontarKitsQueReferenciam` — the arm that keeps a kit correct when a produto
 * becomes a family of one AFTER the #1402 migration has run.
 *
 * The migration deliberately skips produtos that sell on Mercado Livre; publish's
 * `'adotar'` arm converts one whenever a seller publishes it, moving its available
 * stock onto a new sole member. Without this sweep a kit naming that produto is
 * correct the day the migration runs and broken the day the listing goes up, with
 * no migration left to catch it — `kitEstoqueDisponivel` scores the parent 0 and
 * the stock sweep pushes that 0 to ML.
 */
describe('reapontarKitsQueReferenciam', () => {
  const kitDoc = (chaves: string[], mapa: Record<string, unknown>) => ({
    componentesKitKeys: chaves,
    componentesKit: mapa,
  });
  const comp = (quantidade = 1, limitarEstoque = true) => ({
    quantidade,
    limitarEstoque,
    timestamp: null,
  });

  function stub(
    kits: Record<string, Record<string, unknown>>,
    opts: { update?: () => Promise<unknown>; semUpdateTime?: boolean } = {},
  ) {
    const escritas: Array<{ id: string; patch: Record<string, unknown>; pre?: unknown }> = [];
    const consultas: unknown[] = [];
    const refDe = (id: string) => ({
      // ⚠️ The precondition is CAPTURED, not ignored. A stub that drops the second
      // argument makes a blind `update()` indistinguishable from a guarded one —
      // and a mutation test proved that: dropping tier 1 left every test green.
      update: async (patch: Record<string, unknown>, pre?: unknown) => {
        escritas.push({ id, patch, pre });
        return (opts.update ?? (() => Promise.resolve()))();
      },
    });
    const colecao = {
      where: (_campo: string, _op: string, valor: unknown) => {
        consultas.push(valor);
        const achados = Object.entries(kits)
          .filter(([, d]) => ((d.componentesKitKeys as string[]) ?? []).includes(String(valor)))
          .map(([id, d]) => ({
            id,
            ref: refDe(id),
            data: () => d,
            updateTime: opts.semUpdateTime ? undefined : 'ut-1',
          }));
        // ⚠️ The double models the REAL query: `.limit()` truncates server-side,
        // which is what makes the cap bound the SCAN. A stub that ignored it would
        // let an unbounded read pass as bounded.
        const q = (limite: number | null): Record<string, unknown> => ({
          select: () => q(limite),
          limit: (n: number) => q(n),
          get: async () => ({ docs: limite === null ? achados : achados.slice(0, limite) }),
        });
        return q(null);
      },
    };
    return { db: { collection: () => colecao } as never, escritas, consultas };
  }

  it('repoints a kit naming the parent when the pointer appears', async () => {
    const { db, escritas } = stub({ k1: kitDoc(['pai'], { pai: comp(3) }) });

    const r = await reapontarKitsQueReferenciam(
      db,
      'pai',
      { paiId: null, filhoUnicoId: null },
      { paiId: null, filhoUnicoId: 'novo' },
    );

    expect(r).toEqual({ reapontados: 1, conflitos: 0 });
    expect(escritas).toEqual([
      {
        id: 'k1',
        patch: { componentesKit: { novo: comp(3) }, componentesKitKeys: ['novo'] },
        // ⚠️ Tier 1. The patch rewrites the WHOLE map from a document just read,
        // and the Kit tab is a live editor surface — a blind write would silently
        // drop an operator's component list.
        pre: { lastUpdateTime: 'ut-1' },
      },
    ]);
  });

  // ...and the near-miss: with no `updateTime` to guard on there is nothing to
  // compare, so the write goes unguarded rather than being skipped. Losing an
  // edit is bad; refusing to repoint a kit at all leaves it reading 0 on ML.
  it('writes unguarded when the snapshot carries no version', async () => {
    const { db, escritas } = stub(
      { k1: kitDoc(['pai'], { pai: comp() }) },
      { semUpdateTime: true },
    );

    await reapontarKitsQueReferenciam(
      db,
      'pai',
      { paiId: null, filhoUnicoId: null },
      { paiId: null, filhoUnicoId: 'novo' },
    );

    expect(escritas[0]!.pre).toBeUndefined();
  });

  /**
   * ⛔ The pointer MOVE, and why `before == null` is not the gate.
   *
   * `VariationManager` re-derives `filhoUnicoId` from the surviving child set on
   * every save, so adding a row and delete-marking the old sole member in ONE
   * save moves the pointer A → B. Miss it and `onProdutoDeleted`'s cascade runs
   * for A instead — and its empty-kit rule forces `ehKit: false` on any kit whose
   * only component was A. A kit silently stops being a kit.
   */
  it('sweeps the OUTGOING member too, not just the parent', async () => {
    const { db, escritas, consultas } = stub({
      k1: kitDoc(['antigo'], { antigo: comp(2) }),
    });

    const r = await reapontarKitsQueReferenciam(
      db,
      'pai',
      { paiId: null, filhoUnicoId: 'antigo' },
      { paiId: null, filhoUnicoId: 'novo' },
    );

    expect(consultas).toEqual(['pai', 'antigo']);
    expect(r).toEqual({ reapontados: 1, conflitos: 0 });
    expect(escritas[0]!.patch.componentesKit).toEqual({ novo: comp(2) });
  });

  it('reads a kit referencing BOTH ids once and writes it once', async () => {
    const { db, escritas } = stub({
      k1: kitDoc(['pai', 'antigo'], { pai: comp(1), antigo: comp(2) }),
    });

    await reapontarKitsQueReferenciam(
      db,
      'pai',
      { paiId: null, filhoUnicoId: 'antigo' },
      { paiId: null, filhoUnicoId: 'novo' },
    );

    expect(escritas).toHaveLength(1);
    // Both entries fold onto the new member, so the quantities SUM.
    expect(escritas[0]!.patch.componentesKit).toEqual({ novo: comp(3) });
  });

  // ⚠️ Idempotent, which is what makes an at-least-once redelivery free and a
  // lost precondition recoverable: `unidadeVendavel` is a fixpoint.
  it('writes nothing when the kit already names the member', async () => {
    const { db, escritas } = stub({ k1: kitDoc(['novo'], { novo: comp() }) });

    const r = await reapontarKitsQueReferenciam(
      db,
      'pai',
      { paiId: null, filhoUnicoId: null },
      { paiId: null, filhoUnicoId: 'novo' },
    );

    expect(r).toEqual({ reapontados: 0, conflitos: 0 });
    expect(escritas).toEqual([]);
  });

  it('does nothing when the pointer did not move', async () => {
    const { db, consultas } = stub({ k1: kitDoc(['pai'], { pai: comp() }) });
    const mesmo = { paiId: null, filhoUnicoId: 'novo' };
    await expect(reapontarKitsQueReferenciam(db, 'pai', mesmo, mesmo)).resolves.toBeNull();
    expect(consultas).toEqual([]);
  });

  it('does nothing when the pointer was CLEARED', async () => {
    const { db, consultas } = stub({ k1: kitDoc(['pai'], { pai: comp() }) });
    await expect(
      reapontarKitsQueReferenciam(
        db,
        'pai',
        { paiId: null, filhoUnicoId: 'antigo' },
        { paiId: null, filhoUnicoId: null },
      ),
    ).resolves.toBeNull();
    expect(consultas).toEqual([]);
  });

  // A child never has a sole member of its own, whatever it stores — and the
  // mirror write lands on a child, so without this the trigger it fires would
  // sweep for a member of the member.
  it('does nothing on a variation child', async () => {
    const { db, consultas } = stub({ k1: kitDoc(['c1'], { c1: comp() }) });
    await expect(
      reapontarKitsQueReferenciam(
        db,
        'c1',
        { paiId: 'pai', filhoUnicoId: null },
        { paiId: 'pai', filhoUnicoId: 'x' },
      ),
    ).resolves.toBeNull();
    expect(consultas).toEqual([]);
  });

  /**
   * ⚠️ Tier 1, and the loss is REPORTED. The Kit tab is a live editor surface and
   * this patch rewrites the whole map from a document it just read — a blind write
   * would silently drop an operator's component list. Losing is safe because the
   * rewrite is idempotent and `--target kits` reconciles, but nothing else would
   * ever mention that this kit still names the parent.
   */
  it('counts a lost precondition instead of clobbering or throwing', async () => {
    const { db } = stub(
      { k1: kitDoc(['pai'], { pai: comp() }) },
      { update: () => Promise.reject(Object.assign(new Error('stale'), { code: 9 })) },
    );

    const r = await reapontarKitsQueReferenciam(
      db,
      'pai',
      { paiId: null, filhoUnicoId: null },
      { paiId: null, filhoUnicoId: 'novo' },
    );

    expect(r).toEqual({ reapontados: 0, conflitos: 1 });
  });

  // ⚠️ Rule 6: everything that is not the one expected failure rethrows.
  it('rethrows anything that is not a failed precondition', async () => {
    const { db } = stub(
      { k1: kitDoc(['pai'], { pai: comp() }) },
      { update: () => Promise.reject(Object.assign(new Error('denied'), { code: 7 })) },
    );

    await expect(
      reapontarKitsQueReferenciam(
        db,
        'pai',
        { paiId: null, filhoUnicoId: null },
        { paiId: null, filhoUnicoId: 'novo' },
      ),
    ).rejects.toThrow('denied');
  });

  /**
   * ⛔ The bound. ADR 0014 measured ~2 000 kits sharing one component, and this
   * sweep is one RPC per document — so past the cap it writes NOTHING and defers
   * to the migration's re-runnable phase, rather than half-finishing inside a
   * handler with a 60s timeout and no retry.
   */
  it('refuses the whole sweep past the inline cap', async () => {
    const muitos: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 300; i += 1) muitos[`k${i}`] = kitDoc(['pai'], { pai: comp() });
    const { db, escritas } = stub(muitos);

    const r = await reapontarKitsQueReferenciam(
      db,
      'pai',
      { paiId: null, filhoUnicoId: null },
      { paiId: null, filhoUnicoId: 'novo' },
    );

    expect(escritas).toEqual([]);
    // ⚠️ 201, not 300: the query stops at the cap + 1, so the count is a FLOOR and
    // the scan is bounded rather than the writes alone.
    expect(r).toEqual({ reapontados: 0, conflitos: 201 });
  });

  // ⛔ A mixed `limitarEstoque` collision has no correct sum, so the fold refuses
  // it and both entries stay — which means the kit still names the parent and a
  // human has to choose. `mudou` is false, so nothing is written.
  it('leaves a kit whose collision cannot be merged', async () => {
    const { db, escritas } = stub({
      k1: kitDoc(['pai', 'novo'], { pai: comp(5, false), novo: comp(2, true) }),
    });

    const r = await reapontarKitsQueReferenciam(
      db,
      'pai',
      { paiId: null, filhoUnicoId: null },
      { paiId: null, filhoUnicoId: 'novo' },
    );

    expect(escritas).toEqual([]);
    expect(r).toEqual({ reapontados: 0, conflitos: 0 });
  });
});

/**
 * The Shopee native-kit recipe aviso (step 19, #1527, L4(2)) — the WIRING.
 *
 * Three properties, each with the mutant it kills:
 *  - it runs LAST, below the mirror and the repoint, because it rethrows: a
 *    transient error from its reads must not cost the member mirror, which this
 *    handler never retries;
 *  - it is handed the event clock as `agoraUs` and the real increment sentinel;
 *  - an import-shaped write of a família-de-um KIT that leaves the recipe as
 *    stored moves neither the in-sync member nor the aviso (M158).
 */
describe('recordProdutoModificationAndPropagate — the Shopee kit recipe aviso, wired last', () => {
  const EVENT_US = Date.parse('2026-10-07T12:00:00.000Z') * 1000;
  const K = 'kit-k';
  const M = 'membro-m';
  const comp = (quantidade: number, timestamp = 1) => ({
    quantidade,
    limitarEstoque: true,
    timestamp,
  });
  const RECEITA_A = { 'comp-a': comp(2), 'comp-b': comp(1) };
  const RECEITA_B = { 'comp-a': comp(3), 'comp-b': comp(1) };
  const linhaDoKit = () =>
    linhaVariacaoDeKit({
      contaRef: toOuterRef('integracao/int-1'),
      linkPath: toOuterRef(`produtos/${K}/prodshopee/link-kit`),
      modelId: 2000458820,
      tierIndex: [0],
      modelStatus: 'NORMAL',
      receitaKitConferida: null,
    });

  /**
   * A `db` that logs EVERY access, in order, on one timeline the decision recorder
   * also writes to — ordering is the property under test. Any query throws: none
   * of these paths may run one (no precos change, no pointer move).
   */
  function stubFluxo(
    produtos: Record<string, Record<string, unknown>>,
    variashopee: Record<string, Record<string, Record<string, unknown>>> = {},
  ) {
    const linhaDoTempo: string[] = [];
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const colecao = (path: string) => ({
      doc: (id: string) => ({
        get: async () => {
          linhaDoTempo.push(`get ${path}/${id}`);
          const dados = path === 'produtos' ? produtos[id] : undefined;
          return { id, exists: dados !== undefined, updateTime: 'ut-1', data: () => dados };
        },
        update: async (patch: Record<string, unknown>) => {
          linhaDoTempo.push(`update ${path}/${id}`);
          patches.push({ id, patch });
        },
        set: async () => {
          linhaDoTempo.push(`set ${path}/${id}`);
        },
      }),
      get: async () => {
        linhaDoTempo.push(`get ${path}`);
        const dono = /^produtos\/([^/]+)\/variashopee$/.exec(path)?.[1];
        const linhas = dono === undefined ? {} : (variashopee[dono] ?? {});
        return { docs: Object.entries(linhas).map(([id, data]) => ({ id, data: () => data })) };
      },
      where: () => {
        throw new Error(`consulta não esperada em ${path}`);
      },
    });
    avisos.reavaliar.mockImplementation(
      async (_db: unknown, par: { integracaoId: string; kitProdutoId: string }) => {
        linhaDoTempo.push(`reavaliar ${par.integracaoId}/${par.kitProdutoId}`);
        return 'aberto';
      },
    );
    return { db: { collection: colecao } as never, linhaDoTempo, patches };
  }

  const agendador = { enqueue: vi.fn(async () => undefined) };
  const correr = (
    db: never,
    id: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ) =>
    recordProdutoModificationAndPropagate(
      db,
      id,
      before,
      after,
      'evt-1',
      EVENT_US,
      null,
      agendador,
    );

  beforeEach(() => {
    avisos.reavaliar.mockReset();
    agendador.enqueue.mockClear();
  });

  // A família de um: K holds the recipe the operator edits, M (the sole member,
  // the sellable unit) mirrors it and holds the kit-model rows.
  const kitAntes = {
    paiId: null,
    filhoUnicoId: M,
    ehKit: true,
    componentesKit: RECEITA_A,
    integracoesComProduto: [],
  };
  const membroEmDia = { paiId: K, ehKit: true, componentesKit: RECEITA_A };

  /**
   * ⛔ M158. Step 9's re-import of a kit leaves K's `componentesKit` as stored (R-t:
   * a família de um's kept child never has its recipe written through K), and
   * writes other fields. Nothing moved the recipe, so the in-sync member gets no
   * patch and the aviso — open on a pending edit — is not touched: no read of the
   * member, of any row, and no decision.
   */
  it('an import-shaped write of a família-de-um KIT that leaves the recipe as stored moves neither the member nor the aviso (M158)', async () => {
    const kitDepois = { ...kitAntes, integracoesComProduto: ['shopee'] };
    const { db, linhaDoTempo, patches } = stubFluxo(
      { [K]: kitDepois, [M]: membroEmDia },
      { [M]: { r1: linhaDoKit() } },
    );

    await correr(db, K, kitAntes, kitDepois);

    expect(patches).toEqual([]);
    expect(linhaDoTempo).toEqual([]);
    expect(avisos.reavaliar).not.toHaveBeenCalled();
  });

  // The same, with the recipe RE-WRITTEN rather than left alone: fresh entry stamps
  // and the map re-ordered. Same components, same quantities — still not a recipe
  // change for the aviso (only the history records the write).
  it('re-stamping the same recipe on the kit still decides nothing', async () => {
    const reescrita = { 'comp-b': comp(1, 77), 'comp-a': comp(2, 77) };
    const kitDepois = { ...kitAntes, componentesKit: reescrita };
    const { db, linhaDoTempo } = stubFluxo({ [K]: kitDepois, [M]: membroEmDia });

    await correr(db, K, kitAntes, kitDepois);

    expect(linhaDoTempo.filter((l) => !l.startsWith(`set produtos/${K}/historico`))).toEqual([]);
    expect(avisos.reavaliar).not.toHaveBeenCalled();
  });

  /**
   * ...and the near-miss: a REAL recipe edit on K. The mirror carries it to the
   * member FIRST; then the gate opens for K, which holds no row of its own (the
   * rows sit on the member), so nothing is decided on THIS delivery — the
   * member's own delivery, fired by the mirror write, is the one that decides.
   */
  it('a real recipe edit on the kit mirrors the member first, then gates open on the kit itself', async () => {
    const kitDepois = { ...kitAntes, componentesKit: RECEITA_B };
    const { db, linhaDoTempo, patches } = stubFluxo(
      { [K]: kitDepois, [M]: membroEmDia },
      { [M]: { r1: linhaDoKit() } },
    );

    await correr(db, K, kitAntes, kitDepois);

    expect(patches.map((p) => p.id)).toEqual([M]);
    expect(patches[0]!.patch.componentesKit).toEqual(RECEITA_B);
    const membro = linhaDoTempo.indexOf(`update produtos/${M}`);
    const releitura = linhaDoTempo.lastIndexOf(`get produtos/${K}`);
    expect(membro).toBeGreaterThan(-1);
    expect(releitura).toBeGreaterThan(membro);
    expect(linhaDoTempo.at(-1)).toBe(`get produtos/${K}/variashopee`);
    expect(avisos.reavaliar).not.toHaveBeenCalled();

    // The member's own delivery — the write the mirror just made.
    const membroDepois = { ...membroEmDia, componentesKit: RECEITA_B };
    const segundo = stubFluxo({ [K]: kitDepois, [M]: membroDepois }, { [M]: { r1: linhaDoKit() } });
    await correr(segundo.db, M, membroEmDia, membroDepois);
    expect(segundo.linhaDoTempo.at(-1)).toBe(`reavaliar int-1/${K}`);
  });

  // ⛔ LAST. The decision rethrows (rule 6); placed above the mirror, its failure
  // would cost the member the edit — and this handler never retries.
  it('runs after the mirror, so its failure rethrows without costing the member edit', async () => {
    const kitDepois = { ...kitAntes, componentesKit: RECEITA_B };
    const { db, linhaDoTempo } = stubFluxo(
      { [K]: kitDepois, [M]: membroEmDia },
      // A row under K itself, so the kit's own delivery reaches the decision.
      { [K]: { r1: linhaDoKit() } },
    );
    const falha = Object.assign(new Error('unavailable'), { code: 14 });
    avisos.reavaliar.mockImplementation(async () => {
      linhaDoTempo.push('reavaliar');
      throw falha;
    });

    await expect(correr(db, K, kitAntes, kitDepois)).rejects.toBe(falha);

    const membro = linhaDoTempo.indexOf(`update produtos/${M}`);
    const historico = linhaDoTempo.findIndex((l) => l.startsWith(`set produtos/${K}/historico`));
    expect(historico).toBeGreaterThan(-1);
    expect(membro).toBeGreaterThan(historico);
    expect(linhaDoTempo.indexOf('reavaliar')).toBeGreaterThan(membro);
  });

  it('is handed the EVENT clock as agoraUs and the real increment sentinel', async () => {
    const filho = { paiId: K, ehKit: true, componentesKit: RECEITA_A };
    const filhoDepois = { ...filho, componentesKit: RECEITA_B };
    const { db } = stubFluxo({ c1: filhoDepois }, { c1: { r1: linhaDoKit() } });

    await correr(db, 'c1', filho, filhoDepois);

    expect(avisos.reavaliar).toHaveBeenCalledTimes(1);
    const [, par, motivo, deps] = avisos.reavaliar.mock.calls[0]! as [
      unknown,
      unknown,
      unknown,
      { agoraUs: number; increment: (n: number) => unknown },
    ];
    expect(par).toEqual({ integracaoId: 'int-1', kitProdutoId: K });
    expect(motivo).toBe('receita-igual-a-shopee');
    expect(deps.agoraUs).toBe(EVENT_US);
    expect((deps.increment(3) as FieldValue).isEqual(FieldValue.increment(3))).toBe(true);
    expect((deps.increment(3) as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
  });

  // A produto delete is not a recipe change, and the core returns before anything.
  it('a delete decides nothing', async () => {
    const { db, linhaDoTempo } = stubFluxo({});
    await recordProdutoModificationAndPropagate(
      db,
      'c1',
      { paiId: K, componentesKit: RECEITA_A },
      undefined,
      'evt-1',
      EVENT_US,
      null,
      agendador,
    );
    expect(linhaDoTempo).toEqual([]);
    expect(avisos.reavaliar).not.toHaveBeenCalled();
  });
});
