import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type DocumentData, type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  buildModificationEntry,
  recordModification,
  type ModificationHistorySource,
} from '../lib/modificationHistory';
import { extraDataHistorySource } from './onProdutoExtraDataChanged';
import { impostoHistorySource } from './onProdutoImpostoChanged';

// Integration test — requires the firestore emulator. `makeModificationHistoryTrigger`
// has no separately-exported I/O core (unlike `onProdutoChanged`'s
// `recordProdutoModificationAndPropagate`), so this drives `buildModificationEntry` +
// `recordModification` composed exactly the way the factory's `onDocumentWritten`
// callback does — same idiom as the `onProdutoChanged` storage suite.
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
 * the trigger passes; a constant so the redelivery assertion can compare
 * content-identical docs (timestamp included).
 */
const EVENT_TIME_MILLIS = Date.parse('2026-07-21T12:00:00.000Z');

/** Composes one write exactly like `makeModificationHistoryTrigger`'s callback body. */
async function driveTrigger(
  db: Firestore,
  source: ModificationHistorySource,
  params: Record<string, string>,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  eventId: string,
  eventTimeMillis: number = EVENT_TIME_MILLIS,
): Promise<boolean> {
  const { produtoId, docId, path } = source.resolve(params);
  const entry = buildModificationEntry({
    before,
    after,
    ignore: [...source.ignoreFields, ...(source.extraIgnores?.(before, after) ?? [])],
    path,
    subcolecao: source.subcolecao,
    docId,
    eventId,
    eventTimeMillis,
  });
  if (entry === null) return false;
  return recordModification(db, produtoId, entry, {
    requireParentExists: source.requireParentExists,
  });
}

function historyCollection(db: Firestore, produtoId: string) {
  return db.collection('produtos').doc(produtoId).collection('historicoDeModificacoes');
}

describe.skipIf(!EMULATED)('onProdutoExtraDataChanged / onProdutoImpostoChanged (emulator)', () => {
  describe('extraData', () => {
    it('records a create entry then an update entry under the owning produto', async () => {
      const db = getDb();
      const produtoId = freshId();
      await db.collection('produtos').doc(produtoId).set({ nome: 'Produto' });

      const createEventId = freshId('evt');
      const created = { descricao: 'Original', timestamp: 1, ultimaModificacao: 1 };
      const wroteCreate = await driveTrigger(
        db,
        extraDataHistorySource,
        { produtoId, docId: 'singleton' },
        undefined,
        created,
        createEventId,
      );
      expect(wroteCreate).toBe(true);

      const createEntry = (await historyCollection(db, produtoId).doc(createEventId).get()).data()!;
      expect(createEntry.kind).toBe('create');
      expect(createEntry.subcolecao).toBe('extraData');
      expect(createEntry.docId).toBe('singleton');
      expect(createEntry.path).toBe(`produtos/${produtoId}/extraData/singleton`);

      const updateEventId = freshId('evt');
      const updated = { descricao: 'Editada', timestamp: 2, ultimaModificacao: 2 };
      const wroteUpdate = await driveTrigger(
        db,
        extraDataHistorySource,
        { produtoId, docId: 'singleton' },
        created,
        updated,
        updateEventId,
      );
      expect(wroteUpdate).toBe(true);

      const updateEntry = (await historyCollection(db, produtoId).doc(updateEventId).get()).data()!;
      expect(updateEntry.kind).toBe('update');
      expect(updateEntry.campos).toEqual(['descricao']);

      const all = await historyCollection(db, produtoId).get();
      expect(all.size).toBe(2);
    });

    it('an identical wholesale re-set (the editor pattern) records NO entry', async () => {
      const db = getDb();
      const produtoId = freshId();
      await db.collection('produtos').doc(produtoId).set({ nome: 'Produto' });

      const data = { descricao: 'Igual', timestamp: 1, ultimaModificacao: 1 };
      await driveTrigger(
        db,
        extraDataHistorySource,
        { produtoId, docId: 'singleton' },
        undefined,
        data,
        freshId('evt'),
      );
      const countAfterCreate = (await historyCollection(db, produtoId).get()).size;
      expect(countAfterCreate).toBe(1);

      // Same descricao, only the stamp fields differ — the editor's wholesale
      // re-set on every save must NOT add a second entry.
      const wroteReSet = await driveTrigger(
        db,
        extraDataHistorySource,
        { produtoId, docId: 'singleton' },
        data,
        { ...data, timestamp: 2, ultimaModificacao: 2 },
        freshId('evt'),
      );
      expect(wroteReSet).toBe(false);

      const countAfterReSet = (await historyCollection(db, produtoId).get()).size;
      expect(countAfterReSet).toBe(countAfterCreate);
    });
  });

  describe('imposto', () => {
    it('records an update entry with only the changed fields', async () => {
      const db = getDb();
      const produtoId = freshId();
      await db.collection('produtos').doc(produtoId).set({ nome: 'Produto' });

      const operacaoId = freshId('op');
      const before = { id: operacaoId, timestamp: 1, NCM: '12345678' };
      const after = { id: operacaoId, timestamp: 2, NCM: '87654321' };
      const eventId = freshId('evt');
      const wrote = await driveTrigger(
        db,
        impostoHistorySource,
        { produtoId, docId: operacaoId },
        before,
        after,
        eventId,
      );
      expect(wrote).toBe(true);

      const entry = (await historyCollection(db, produtoId).doc(eventId).get()).data()!;
      expect(entry.kind).toBe('update');
      expect(entry.subcolecao).toBe('imposto');
      expect(entry.campos).toEqual(['NCM']);
      expect(entry.path).toBe(`produtos/${produtoId}/imposto/${operacaoId}`);
    });

    it('a delete with the parent EXISTING records kind "delete", full snapshot', async () => {
      const db = getDb();
      const produtoId = freshId();
      await db.collection('produtos').doc(produtoId).set({ nome: 'Produto' });

      const operacaoId = freshId('op');
      const before = { id: operacaoId, timestamp: 1, NCM: '12345678', origem: '0' };
      const eventId = freshId('evt');
      const wrote = await driveTrigger(
        db,
        impostoHistorySource,
        { produtoId, docId: operacaoId },
        before,
        undefined,
        eventId,
      );
      expect(wrote).toBe(true);

      const entry = (await historyCollection(db, produtoId).doc(eventId).get()).data()!;
      expect(entry.kind).toBe('delete');
      expect(entry.changes.NCM).toEqual({ old: '12345678', new: null });
      expect(entry.changes.origem).toEqual({ old: '0', new: null });
    });

    it('a delete with the parent produto MISSING records NO entry anywhere', async () => {
      const db = getDb();
      const produtoId = freshId('gone'); // never created — the onProdutoDeleted cascade race

      const operacaoId = freshId('op');
      const before = { id: operacaoId, timestamp: 1, NCM: '12345678' };
      const eventId = freshId('evt');
      const wrote = await driveTrigger(
        db,
        impostoHistorySource,
        { produtoId, docId: operacaoId },
        before,
        undefined,
        eventId,
      );
      expect(wrote).toBe(false);

      const entries = await historyCollection(db, produtoId).get();
      expect(entries.empty).toBe(true);
    });

    it('redelivery (same eventId+time) rewrites a content-identical entry, no dup', async () => {
      const db = getDb();
      const produtoId = freshId();
      await db.collection('produtos').doc(produtoId).set({ nome: 'Produto' });

      const operacaoId = freshId('op');
      const before = { id: operacaoId, timestamp: 1, NCM: '12345678' };
      const after = { id: operacaoId, timestamp: 2, NCM: '87654321' };
      const eventId = freshId('evt');
      const params = { produtoId, docId: operacaoId };

      await driveTrigger(db, impostoHistorySource, params, before, after, eventId);
      const entryRef = historyCollection(db, produtoId).doc(eventId);
      const firstDelivery = (await entryRef.get()).data();

      await driveTrigger(db, impostoHistorySource, params, before, after, eventId);
      const redelivered = (await entryRef.get()).data();
      expect(redelivered).toEqual(firstDelivery);

      const entries = await historyCollection(db, produtoId).get();
      expect(entries.size).toBe(1);
    });
  });
});
