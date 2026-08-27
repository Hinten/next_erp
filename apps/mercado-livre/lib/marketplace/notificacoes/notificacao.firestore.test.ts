/**
 * The Mercado Livre notification store against a REAL Firestore.
 *
 * `notificacao.test.ts` (64 KB) and `packages/data`'s `pipeline.test.ts`
 * (41 cases) already own the DISPOSITION matrix and the sweep's control flow,
 * driven through a hand-rolled `FakeDb` that MANUFACTURES gRPC codes —
 * `Object.assign(new Error(...), { code: 6 })` and friends. That is the right
 * shape for logic coverage, and none of it is repeated here.
 *
 * What a fake structurally cannot answer is whether real Firestore raises those
 * codes in the first place, since the whole dedup/idempotency story rests on it:
 *   - `create()` on an existing doc really raises ALREADY_EXISTS (6), and
 *     `isAlreadyExists` swallows exactly that — the dedup mechanism itself;
 *   - `update()` on a missing doc really raises NOT_FOUND (5), so
 *     `mergeIfExists` returns false instead of upserting a ghost;
 *   - what the lane query does with a `null` vs an absent `processedAt`.
 *
 * ⚠️ These queries are COLLECTION-WIDE (`status`/`processedAt`, not doc id), so
 * unlike the token-store suite a fresh random id buys NO isolation:
 * `fileParallelism: false` serializes files, not emulator state. Hence the
 * explicit purge in `beforeEach`, an injected sweep `now`, and assertions on
 * the specific doc seeded rather than on aggregate counts.
 */
import { randomUUID } from 'node:crypto';
import { notificacaoMercadoLivreCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  type MlNotificationPayload,
  persistNotificationFailure,
  redriveDeferredForUserId,
  reprocessNotifications,
} from './notificacao';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const NOTIF = 'notificacoesMercadoLivre';
const ONE_HOUR_MS = 60 * 60 * 1000;

function db() {
  return getAdminFirestore();
}

/**
 * Wipe both collections the suite touches. The sweep reads the WHOLE collection
 * with `limit(50)` ordered by `processedAt` ASC, and `redrive` stamps
 * `processedAt: 0` — older than any cutoff — so a leftover doc from another
 * test can crowd the seeded one out of the page entirely and the assertion
 * would fail for a reason that has nothing to do with the code under test.
 * `integracao` matters just as much: a stray active ML account flips the
 * disposition from `defer` to `done`, which DELETES the doc instead of
 * marking it.
 */
async function purge(): Promise<void> {
  for (const path of [NOTIF, 'integracao']) {
    const refs = await db().collection(path).listDocuments();
    await Promise.all(refs.map((r) => r.delete()));
  }
}

/** A payload whose `resource` is unique per test — `dedupKeyOf` is `resource`, and */
/** a duplicate inside one sweep run is skipped silently, with no error and no counter. */
function payload(over: Partial<MlNotificationPayload> = {}): MlNotificationPayload {
  return {
    id: `N${randomUUID().replace(/-/g, '')}`,
    resource: `/orders/${Math.floor(Math.random() * 1e12)}`,
    topic: 'orders_v2',
    user_id: 4_040_404,
    application_id: 999,
    attempts: 1,
    sent: 1_700_000_000_000,
    received: 1_700_000_000_000,
    actions: null,
    ...over,
  };
}

async function readDoc(id: string) {
  return db().collection(NOTIF).doc(id).get();
}

beforeEach(purge);

describe.skipIf(!EMULATED)('ML notification store (Firestore emulator)', () => {
  it('B1: a redelivered notification collides on ALREADY_EXISTS and keeps the FIRST record', async () => {
    const p = payload();

    await persistNotificationFailure(db(), p, 'primeiro erro');
    await persistNotificationFailure(db(), p, 'segundo erro');

    const snap = await db().collection(NOTIF).get();
    expect(snap.size).toBe(1);

    const doc = await readDoc(p.id!);
    expect(doc.exists).toBe(true);
    // The distinguishing assertion. "It resolved without throwing" would also
    // hold if the second call had silently OVERWRITTEN the first, or if no
    // collision had happened at all — the retry state surviving is what proves
    // the create() really raised code 6 and isAlreadyExists swallowed it.
    expect(doc.data()).toMatchObject({ erro: 'primeiro erro', status: 'failed', tentativas: 0 });
  });

  it('B1b: two id-less notifications for DIFFERENT resources stay separate docs', async () => {
    // `payload()` randomises `resource` per call, so these two derive different
    // doc ids — `docIdOf`'s #807 fallback is `<topic>:<resource>`, and separating
    // them is the point of putting the whole resource in the key.
    await persistNotificationFailure(db(), payload({ id: null }), 'erro A');
    await persistNotificationFailure(db(), payload({ id: null }), 'erro B');

    const snap = await db().collection(NOTIF).get();
    expect(snap.size).toBe(2);
    expect(snap.docs.map((d) => d.data().erro).sort()).toEqual(['erro A', 'erro B']);
  });

  it('B1c: two id-less notifications for the SAME topic+resource converge on one doc (#807)', async () => {
    // The half B1b cannot show. Before #807 `docIdOf` returned null here and the
    // store minted a fresh auto id per persist, so a repeatedly-failing resource
    // accumulated one dead document per attempt. This is the real-Firestore proof
    // that `create()` raises code 6 against a DERIVED id, not just an ML one.
    const p = payload({ id: null, resource: '/orders/424242', topic: 'orders_v2' });

    await persistNotificationFailure(db(), p, 'primeiro erro');
    await persistNotificationFailure(db(), p, 'segundo erro');

    const snap = await db().collection(NOTIF).get();
    expect(snap.size).toBe(1);

    const doc = await readDoc('orders_v2:orders_424242');
    expect(doc.exists).toBe(true);
    // Same distinguishing assertion as B1: the FIRST record surviving is what
    // separates "collided and was ignored" from "silently overwrote".
    expect(doc.data()).toMatchObject({ erro: 'primeiro erro', status: 'failed', tentativas: 0 });
    // The derived value keys the DOCUMENT; the `id` field stays honestly null.
    expect(doc.data()!.id).toBeNull();
  });

  it('B2: mergeIfExists on a deleted doc returns false and does NOT resurrect it', async () => {
    const ghostId = `N${randomUUID().replace(/-/g, '')}`;

    const applied = await notificacaoMercadoLivreCollection.mergeIfExists(db(), {}, ghostId, {
      status: 'failed',
      tentativas: 0,
      erro: 're-drive de um doc que já sumiu',
      processedAt: 0,
    });

    // `mergeIfExists` is `update()` + a NOT_FOUND narrow. Proving the REAL SDK
    // raises gRPC 5 here matters because a `set(..., {merge:true})` stand-in
    // would return happily and leave a ghost doc carrying only the four
    // resilience fields — which the sweep then rehydrates into a payload with
    // no `resource`/`topic`.
    expect(applied).toBe(false);
    expect((await readDoc(ghostId)).exists).toBe(false);

    // Positive counterpart, so this `it` cannot pass against a wrong database:
    // on a doc that DOES exist, the same call applies.
    const p = payload();
    await persistNotificationFailure(db(), p, 'erro inicial');
    const applied2 = await notificacaoMercadoLivreCollection.mergeIfExists(db(), {}, p.id!, {
      status: 'failed',
      tentativas: 0,
      erro: 're-drive',
      processedAt: 0,
    });
    expect(applied2).toBe(true);
    const after = await readDoc(p.id!);
    expect(after.exists).toBe(true);
    expect(after.data()).toMatchObject({ erro: 're-drive', processedAt: 0 });
  });

  it('B3: the lane query excludes a doc whose processedAt is ABSENT', async () => {
    const p = payload();
    await persistNotificationFailure(db(), p, 'erro real');

    // A doc with the right status but no `processedAt` at all. Real Firestore
    // drops documents missing the orderBy field; an in-memory fake that reads
    // `doc.processedAt ?? 0` would include it and sort it FIRST, i.e. exactly
    // the position that consumes the sweep's page budget.
    const orphanId = `N${randomUUID().replace(/-/g, '')}`;
    await db()
      .collection(NOTIF)
      .doc(orphanId)
      .set({ resource: '/orders/1', topic: 'orders_v2', status: 'failed', tentativas: 0 });

    const cutoff = Date.now() + ONE_HOUR_MS;
    const rows = await db()
      .collection(NOTIF)
      .where('status', '==', 'failed')
      .where('processedAt', '<', cutoff)
      .orderBy('processedAt')
      .get();

    expect(rows.docs.map((d) => d.id)).toEqual([p.id]);
  });

  it('B3b: the lane query also excludes `processedAt: null` — range filters skip nulls', async () => {
    // Worth pinning because the two plausible answers differ. `processedAt` is
    // `millisSinceEpoch().nullable().default(null)` and Firestore's cross-type
    // ordering sorts null BEFORE numbers, which suggests `< cutoff` should
    // match it — while the FakeDb's `typeof v === 'number' && v < c` guard says
    // it does not. Measured here: Firestore range filters EXCLUDE null-valued
    // fields (only `== null` matches them), so the fake and production agree,
    // and the existing unit suite is not modelling a fiction. Asserted so a
    // change in either direction surfaces instead of silently altering which
    // documents the sweep can ever reach.
    const nullId = `N${randomUUID().replace(/-/g, '')}`;
    await db().collection(NOTIF).doc(nullId).set({
      resource: '/orders/2',
      topic: 'orders_v2',
      status: 'failed',
      tentativas: 0,
      processedAt: null,
    });

    const rows = await db()
      .collection(NOTIF)
      .where('status', '==', 'failed')
      .where('processedAt', '<', Date.now() + ONE_HOUR_MS)
      .orderBy('processedAt')
      .get();

    expect(rows.docs.map((d) => d.id)).toEqual([]);

    // Positive counterpart, so this `it` cannot pass merely because the query
    // targeted an empty namespace: the SAME query does return a numeric-valued
    // sibling. Without it, "[] equals []" would hold against a wrong database.
    const p = payload();
    await persistNotificationFailure(db(), p, 'erro real');
    const again = await db()
      .collection(NOTIF)
      .where('status', '==', 'failed')
      .where('processedAt', '<', Date.now() + ONE_HOUR_MS)
      .orderBy('processedAt')
      .get();
    expect(again.docs.map((d) => d.id)).toEqual([p.id]);
    expect((await readDoc(nullId)).exists).toBe(true); // still there — just unreachable
  });

  it('B7: #808 end to end — defer, connect, re-drive, then the sweep resolves and DELETES', async () => {
    const userId = 5_000_000 + Math.floor(Math.random() * 1e6);
    const p = payload({ user_id: userId, topic: 'items' });

    // 1. Arrives with no account behind it. Persisted into the DEFERRED lane
    //    rather than failed — the seller simply has not connected yet.
    await notificacaoMercadoLivreCollection.docRef(db(), {}, p.id!).create(
      notificacaoMercadoLivreCollection.parse({
        ...p,
        status: 'deferred',
        tentativas: 0,
        erro: 'nenhuma conta ativa para o user_id',
        processedAt: Date.now(),
      }) as Record<string, unknown>,
    );
    expect((await readDoc(p.id!)).data()).toMatchObject({ status: 'deferred' });

    // 2. The seller connects. `resolveIntegracaoByUserId` runs as a REAL
    //    three-predicate query (tipo/user_id/ativo) against a real document,
    //    not an Object.entries filter over an in-memory map.
    const integracaoId = `int${randomUUID().replace(/-/g, '')}`;
    await db()
      .collection('integracao')
      .doc(integracaoId)
      .set({ nome: 'conta ML', tipo: INTEGRACAO_TIPO.mercadoLivre, user_id: userId, ativo: true });

    // 3. The connect trigger pulls the backlog back into the hot lane.
    const redrive = await redriveDeferredForUserId(db(), userId);
    expect(redrive).toMatchObject({ encontradas: 1, redirecionadas: 1 });

    const hot = await readDoc(p.id!);
    expect(hot.exists).toBe(true);
    // processedAt: 0 is what makes the very next hot tick pick it up regardless
    // of the window — a real stored value, not a fake's bookkeeping.
    expect(hot.data()).toMatchObject({ status: 'failed', tentativas: 0, processedAt: 0 });

    // 4. The hot sweep now resolves it. `items` with an unparseable resource
    //    would park; this one resolves, and a resolved notification is DELETED
    //    (the store is failures-only).
    const res = await reprocessNotifications(db(), { now: Date.now() + 2 * ONE_HOUR_MS });
    expect(res.errors).toEqual([]);
    expect((await readDoc(p.id!)).exists).toBe(false);
  });

  it('B8: an unknown ML field survives the strict write parse and rehydrates', async () => {
    // `toDocFields` spreads the whole payload onto a `.passthrough()` schema, so
    // "a field ML adds without telling us still rides along". Real Firestore
    // also rejects `undefined` outright, which no in-memory object does.
    const p = payload({ campo_novo_do_ml: 'valor inesperado' } as Partial<MlNotificationPayload>);

    await persistNotificationFailure(db(), p, 'erro com campo extra');

    const doc = await readDoc(p.id!);
    expect(doc.exists).toBe(true);
    expect(doc.data()).toMatchObject({
      campo_novo_do_ml: 'valor inesperado',
      resource: p.resource,
      topic: p.topic,
    });
  });
});
