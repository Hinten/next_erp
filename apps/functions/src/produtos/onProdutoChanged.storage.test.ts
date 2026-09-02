import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { recordProdutoModificationAndPropagate } from './onProdutoChanged';

// Integration test — requires the firestore emulator. Drives the I/O core
// directly (the trigger wrapper needs no emulation: its guards are unit-tested
// and it only forwards to the core). Skipped bare, same idiom as the
// sincronizarEstoquePedido / onProdutoDeleted storage suites.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function freshId(prefix = 'p') {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

/**
 * Fixed event time for every test call — mirrors the CloudEvent `event.time`
 * the wrapper passes; a constant so the redelivery assertions can compare
 * content-identical docs (timestamp included).
 */
const EVENT_TIME_MICROS = Date.parse('2026-07-21T12:00:00.000Z') * 1000;

/**
 * The `historicoDeModificacoes` entries THIS test wrote by calling the core
 * directly — never the whole subcollection.
 *
 * The header above says the trigger wrapper needs no emulation. That was true
 * when this suite ran on firestore alone, but `ci-storage.yml` boots the
 * FUNCTIONS emulator too (`--only firestore,storage,functions`), so the real
 * `onProdutoChanged` is live: every `set()` on a produto here is a produto
 * write, fires it, and appends its own `create` entry. Counting the whole
 * subcollection therefore races that delivery — `toBe(1)` passes only when the
 * trigger has not landed yet, and the `empty` assertions fail once it does.
 *
 * The trigger stamps `timestamp` from the CloudEvent's real time while every
 * direct call here passes the fixed {@link EVENT_TIME_MICROS}, so filtering on
 * it isolates the core's own writes. The assertions stay meaningful: they still
 * fail if the core writes extra entries, or none.
 */
async function coreEntries(db: Firestore, produtoId: string) {
  const snap = await db
    .collection('produtos')
    .doc(produtoId)
    .collection('historicoDeModificacoes')
    .get();
  return snap.docs.filter((d) => d.data().timestamp === EVENT_TIME_MICROS);
}

describe.skipIf(!EMULATED)('onProdutoChanged core (emulator)', () => {
  it('records ONE entry for a parent precos+custo change, no legacy docs', async () => {
    const db = getDb();
    const produtoId = freshId();
    const eventId = freshId('evt');
    await db.collection('produtos').doc(produtoId).set({ nome: 'Produto', paiId: null });

    const before = { nome: 'Produto', paiId: null, precos: { l1: { valor: 10 } }, custo: 5 };
    const after = { nome: 'Produto', paiId: null, precos: { l1: { valor: 20 } }, custo: 10 };
    await recordProdutoModificationAndPropagate(
      db,
      produtoId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const entryRef = db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDeModificacoes')
      .doc(eventId);
    const entrySnap = await entryRef.get();
    expect(entrySnap.exists).toBe(true);
    const entry = entrySnap.data()!;
    expect(entry.kind).toBe('update');
    expect(entry.campos).toEqual(['custo', 'precos']);
    expect(entry.changes.precos).toEqual({
      old: { l1: { valor: 10 } },
      new: { l1: { valor: 20 } },
    });
    expect(entry.changes.custo).toEqual({ old: 5, new: 10 });
    expect(entry.timestamp).toBe(EVENT_TIME_MICROS);

    expect(await coreEntries(db, produtoId)).toHaveLength(1);

    // The legacy per-lista/per-custo subcollections this trigger used to write
    // are GONE — this PR replaces them with the single unified entry above.
    const legacyPrecos = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDePrecos')
      .get();
    expect(legacyPrecos.empty).toBe(true);

    const legacyCusto = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDeCusto')
      .get();
    expect(legacyCusto.empty).toBe(true);
  });

  it('redelivery (same event) rewrites a content-identical entry, never a duplicate', async () => {
    const db = getDb();
    const produtoId = freshId();
    const eventId = freshId('evt');
    await db.collection('produtos').doc(produtoId).set({ nome: 'Produto', paiId: null });

    const before = { nome: 'Produto', paiId: null, precos: { l1: { valor: 10 } } };
    const after = { nome: 'Produto', paiId: null, precos: { l1: { valor: 20 } } };
    await recordProdutoModificationAndPropagate(
      db,
      produtoId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const entryRef = db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDeModificacoes')
      .doc(eventId);
    const firstDelivery = (await entryRef.get()).data();

    await recordProdutoModificationAndPropagate(
      db,
      produtoId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );
    const redelivered = (await entryRef.get()).data();
    expect(redelivered).toEqual(firstDelivery);

    expect(await coreEntries(db, produtoId)).toHaveLength(1);
  });

  it('a create (before undefined) has kind "create" and null "old" sides', async () => {
    const db = getDb();
    const produtoId = freshId();
    const eventId = freshId('evt');

    const after = { nome: 'Novo Produto', paiId: null, precos: { l1: { valor: 20 } }, custo: 10 };
    await recordProdutoModificationAndPropagate(
      db,
      produtoId,
      undefined,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const entry = (
      await db
        .collection('produtos')
        .doc(produtoId)
        .collection('historicoDeModificacoes')
        .doc(eventId)
        .get()
    ).data()!;
    expect(entry.kind).toBe('create');
    expect(entry.changes.nome).toEqual({ old: null, new: 'Novo Produto' });
    expect(entry.changes.precos.old).toBeNull();
    expect(entry.changes.custo).toEqual({ old: null, new: 10 });
  });

  it('propagates precos to a differing child, leaves an identical child untouched', async () => {
    const db = getDb();
    const parentId = freshId('parent');
    const childSame = freshId('childsame');
    const childDiff = freshId('childdiff');
    const eventId = freshId('evt');

    await db.collection('produtos').doc(parentId).set({ nome: 'Pai', paiId: null });
    await db
      .collection('produtos')
      .doc(childSame)
      .set({ nome: 'Igual', paiId: parentId, precos: { l1: { valor: 20 } } });
    await db
      .collection('produtos')
      .doc(childDiff)
      .set({ nome: 'Diferente', paiId: parentId, precos: { l1: { valor: 5 } } });

    const before = { nome: 'Pai', paiId: null, precos: { l1: { valor: 10 } } };
    const after = { nome: 'Pai', paiId: null, precos: { l1: { valor: 20 } } };
    await recordProdutoModificationAndPropagate(
      db,
      parentId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const same = (await db.collection('produtos').doc(childSame).get()).data()!;
    const diff = (await db.collection('produtos').doc(childDiff).get()).data()!;
    expect(same.precos).toEqual({ l1: { valor: 20 } });
    expect(diff.precos).toEqual({ l1: { valor: 20 } });
  });

  it('propagatePriceToChildren=false records the entry but skips propagation', async () => {
    const db = getDb();
    const parentId = freshId('parentnp');
    const childId = freshId('childnp');
    const eventId = freshId('evt');

    await db
      .collection('produtos')
      .doc(parentId)
      .set({ nome: 'Pai sem propagação', paiId: null, propagatePriceToChildren: false });
    await db
      .collection('produtos')
      .doc(childId)
      .set({ nome: 'Filho', paiId: parentId, precos: { l1: { valor: 5 } } });

    const before = { nome: 'Pai sem propagação', paiId: null, precos: null };
    const after = {
      nome: 'Pai sem propagação',
      paiId: null,
      precos: { l1: { valor: 30 } },
      propagatePriceToChildren: false,
    };
    await recordProdutoModificationAndPropagate(
      db,
      parentId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    expect(await coreEntries(db, parentId)).not.toHaveLength(0);

    const child = (await db.collection('produtos').doc(childId).get()).data()!;
    expect(child.precos).toEqual({ l1: { valor: 5 } }); // untouched
  });

  it('a child write changing ONLY precos records no entry (echo suppressed)', async () => {
    const db = getDb();
    const childId = freshId('echo');
    const eventId = freshId('evt');
    await db
      .collection('produtos')
      .doc(childId)
      .set({ nome: 'Variação', paiId: 'algumPai', precos: { l1: { valor: 5 } } });

    const before = { nome: 'Variação', paiId: 'algumPai', precos: { l1: { valor: 5 } } };
    const after = { nome: 'Variação', paiId: 'algumPai', precos: { l1: { valor: 20 } } };
    await recordProdutoModificationAndPropagate(
      db,
      childId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    expect(await coreEntries(db, childId)).toHaveLength(0);
  });

  it('a child write changing nome records an entry without precos in campos', async () => {
    const db = getDb();
    const childId = freshId('rename');
    const eventId = freshId('evt');
    await db
      .collection('produtos')
      .doc(childId)
      .set({ nome: 'Antigo', paiId: 'algumPai', precos: { l1: { valor: 5 } } });

    const before = { nome: 'Antigo', paiId: 'algumPai', precos: { l1: { valor: 5 } } };
    const after = { nome: 'Novo', paiId: 'algumPai', precos: { l1: { valor: 20 } } };
    await recordProdutoModificationAndPropagate(
      db,
      childId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const entries = await coreEntries(db, childId);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!.data();
    expect(entry.campos).toEqual(['nome']);
  });

  it('is a no-op for a delete event (after undefined) — no entry, no propagation', async () => {
    const db = getDb();
    const produtoId = freshId('deleted');
    const eventId = freshId('evt');
    const before = { nome: 'Deletado', paiId: null, precos: { l1: { valor: 5 } } };

    await expect(
      recordProdutoModificationAndPropagate(
        db,
        produtoId,
        before,
        undefined,
        eventId,
        EVENT_TIME_MICROS,
      ),
    ).resolves.toBeUndefined();

    // No `set()` in this test, so no produto doc and no trigger delivery — the
    // subcollection can only hold what the core wrote, which is nothing.
    expect(await coreEntries(db, produtoId)).toHaveLength(0);
  });
});

/**
 * The sole member's mirror (#1398, PR 7b).
 *
 * ⚠️ Against a REAL Firestore, deliberately: the write carries a
 * `lastUpdateTime` precondition, and a stubbed `updateTime` proves nothing about
 * whether the emulator accepts it. These assert the three outcomes that decide
 * data — written, declined, untouched. The two error branches are unit tests
 * (`onProdutoChanged.test.ts`), because a losing precondition needs a write
 * between the read and the update that no emulator test can interleave.
 */
describe.skipIf(!EMULATED)('onProdutoChanged core — the sole member mirror (emulator)', () => {
  /** A parent + its sole member, both already in step. */
  async function familiaDeUm(db: Firestore, membro: Record<string, unknown> = {}) {
    const paiId = freshId();
    const filhoId = freshId('c');
    const pai = { nome: 'Bandeja', sku: 'BAN-1', paiId: null, filhoUnicoId: filhoId };
    await db.collection('produtos').doc(paiId).set(pai);
    await db
      .collection('produtos')
      .doc(filhoId)
      .set({ nome: 'Bandeja', sku: 'BAN-1', paiId, ...membro });
    return { paiId, filhoId, pai };
  }

  /**
   * Drive the core the way a real trigger reaches it.
   *
   * ⚠️ **`after` is PERSISTED first, and that is not a formality.** A Firestore
   * trigger fires *because* the document was written, so by the time the core runs
   * the parent already holds `after`. The mirror derives its patch from the parent
   * as it is NOW — that re-read is what makes two out-of-order deliveries converge
   * instead of the older one reverting the newer — so a test that passes `after`
   * without writing it is describing a delivery that cannot happen, and would
   * report the mirror as broken.
   *
   * The parent write is a plain `set` on the emulator, which fires the REAL
   * `onProdutoChanged` as well; that is already true of every `set` in this file
   * and is why `coreEntries` filters on the fixed event time.
   */
  const correr = async (db: Firestore, id: string, before: unknown, after: unknown) => {
    await db
      .collection('produtos')
      .doc(id)
      .set(after as Record<string, unknown>);
    return recordProdutoModificationAndPropagate(
      db,
      id,
      before as never,
      after as never,
      freshId('evt'),
      EVENT_TIME_MICROS,
    );
  };

  it('carries a renamed parent onto the member that still held the old name', async () => {
    const db = getDb();
    const { paiId, filhoId, pai } = await familiaDeUm(db);

    await correr(db, paiId, pai, { ...pai, nome: 'Bandeja Decorativa' });

    const filho = await db.collection('produtos').doc(filhoId).get();
    expect(filho.data()?.nome).toBe('Bandeja Decorativa');
    // The member is the sellable unit — its `sku` is what the Balanço scan and
    // the ML order resolver match — so an untouched field must stay untouched.
    expect(filho.data()?.sku).toBe('BAN-1');
  });

  // ⚠️ The member shows up as a row in the Variações tab, so this is reachable
  // by an ordinary operator. A straight copy would undo their edit silently.
  it('leaves a member the operator renamed alone', async () => {
    const db = getDb();
    const { paiId, filhoId, pai } = await familiaDeUm(db, { nome: 'nome do operador' });

    await correr(db, paiId, pai, { ...pai, nome: 'Bandeja Decorativa' });

    const filho = await db.collection('produtos').doc(filhoId).get();
    expect(filho.data()?.nome).toBe('nome do operador');
  });

  // ⚠️ Zero extra reads AND zero writes: the mirror is decided by a pure diff
  // before the member is ever fetched. `custo` is not mirrored, and this is the
  // common case — most produto saves move nothing the member copies.
  it('does not touch the member when the parent moved nothing mirrored', async () => {
    const db = getDb();
    const { paiId, filhoId, pai } = await familiaDeUm(db);
    // ⚠️ Read AFTER seeding, and the run below writes the parent, never the
    // member — so this stamp is the one the assertion is entitled to compare.
    const antes = await db.collection('produtos').doc(filhoId).get();

    await correr(db, paiId, { ...pai, custo: 5 }, { ...pai, custo: 9 });

    const depois = await db.collection('produtos').doc(filhoId).get();
    expect(depois.updateTime?.isEqual(antes.updateTime!)).toBe(true);
  });

  // ⚠️ The field that costs money rather than confusion: a kit's availability is
  // `min` over its components, computed from the produto the surface reads — the
  // member. A stale map advertises stock the kit cannot assemble.
  it('carries an edited kit composition, map and keys together', async () => {
    const db = getDb();
    const componente = (quantidade: number) => ({ quantidade, limitarEstoque: true, timestamp: 1 });
    const { paiId, filhoId, pai } = await familiaDeUm(db, {
      ehKit: true,
      componentesKit: { 'comp-1': componente(1) },
      componentesKitKeys: ['comp-1'],
    });
    const antes = { ...pai, ehKit: true, componentesKit: { 'comp-1': componente(1) } };

    await correr(db, paiId, antes, {
      ...antes,
      componentesKit: { 'comp-1': componente(1), 'comp-2': componente(2) },
    });

    const filho = (await db.collection('produtos').doc(filhoId).get()).data()!;
    expect(filho.componentesKit['comp-2'].quantidade).toBe(2);
    // Sorted and rewritten in the same patch — an `array-contains` query reads
    // these keys, so a map that moved without them is a kit nothing can find.
    expect(filho.componentesKitKeys).toEqual(['comp-1', 'comp-2']);
  });

  // ⚠️ `precos` has its own propagation with an operator opt-out. The mirror
  // must not become a second path that ignores it.
  it('honours propagatePriceToChildren, which the mirror must not bypass', async () => {
    const db = getDb();
    const { paiId, filhoId, pai } = await familiaDeUm(db, { precos: { l1: { valor: 10 } } });
    const antes = { ...pai, precos: { l1: { valor: 10 } }, propagatePriceToChildren: false };

    await correr(db, paiId, antes, { ...antes, precos: { l1: { valor: 99 } } });

    const filho = await db.collection('produtos').doc(filhoId).get();
    expect(filho.data()?.precos).toEqual({ l1: { valor: 10 } });
  });
});
