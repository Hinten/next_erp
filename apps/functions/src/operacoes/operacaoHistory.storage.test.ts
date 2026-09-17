import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
  getFirestore,
} from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  buildModificationEntry,
  recordModification,
  type ModificationHistorySource,
} from '../lib/modificationHistory';
import { recordOperacaoModification } from './registrarHistoricoOperacao';
import { regraImpostoHistorySource } from './onRegraImpostoChanged';

/**
 * END-TO-END + core coverage for the operação modification history (#650's
 * rollout of `makeModificationHistoryTrigger`).
 *
 * The end-to-end block proves the REAL triggers fire — a wrong `document`
 * pattern, a missing `database`, or the `withAuthContext` event-type switch are
 * invisible to a unit test, same rationale as `pedidoHistory.storage.test.ts`.
 * The core/source blocks drive `recordOperacaoModification` and
 * `regraImpostoHistorySource` directly (same idiom as
 * `onProdutoChanged.storage.test.ts` / `onProdutoSubdocChanged.storage.test.ts`)
 * to pin the delete-skip and cascade-race guards without racing a real cascade
 * delete.
 */
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function freshId(prefix = 'op') {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

function historyRef(db: Firestore, operacaoId: string) {
  return db.collection('operacao').doc(operacaoId).collection('historicoDeModificacoes');
}

/** Poll until at least `minRows` rows exist, or fail with what was actually seen. */
async function waitForRows(
  db: Firestore,
  operacaoId: string,
  minRows: number,
  timeoutMs = 15_000,
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await historyRef(db, operacaoId).get();
    if (snap.size >= minRows) return snap.docs;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${minRows} historicoDeModificacoes row(s); saw ${snap.size}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A minimal operação the schema will accept on read-back. */
function novaOperacao(extra: DocumentData = {}): DocumentData {
  return {
    nome: 'Venda padrão',
    naturezaDaOperacao: 'Venda de mercadoria',
    tipo: 1,
    ehServico: false,
    ehExterior: false,
    ehConsumidorFinal: true,
    cfop: '5102',
    cfopInterestadual: '6102',
    NCM: null,
    CEST: null,
    unidade: null,
    ...extra,
  };
}

describe.skipIf(!EMULATED)('operação modification history (emulator, end-to-end)', () => {
  it('records the operação document itself, tagged with a null subcolecao', async () => {
    const db = getDb();
    const operacaoId = freshId();

    await db.collection('operacao').doc(operacaoId).set(novaOperacao());
    const rows = await waitForRows(db, operacaoId, 1);

    expect(rows).toHaveLength(1);
    const row = rows[0]!.data();
    expect(row).toMatchObject({
      subcolecao: null,
      docId: operacaoId,
      kind: 'create',
      path: `operacao/${operacaoId}`,
    });
  });

  it('records a regra under the OPERAÇÃO, tagged subcolecao: regras', async () => {
    const db = getDb();
    const operacaoId = freshId();
    await db.collection('operacao').doc(operacaoId).set(novaOperacao());
    await waitForRows(db, operacaoId, 1);

    const regraId = freshId('reg');
    await db
      .collection('operacao')
      .doc(operacaoId)
      .collection('regras')
      .doc(regraId)
      .set({ nome: 'Regra especial', NCM: '61091000' });

    const rows = await waitForRows(db, operacaoId, 2);
    const regraRow = rows.map((d) => d.data()).find((r) => r.subcolecao === 'regras');
    expect(regraRow).toBeDefined();
    expect(regraRow).toMatchObject({ docId: regraId, kind: 'create' });
    expect(regraRow?.campos).toContain('nome');
  });
});

describe.skipIf(!EMULATED)('recordOperacaoModification core (emulator)', () => {
  const EVENT_TIME_MICROS = Date.parse('2026-08-01T12:00:00.000Z') * 1000;

  it('is a no-op for a delete event (after undefined) — swept by onOperacaoDeleted instead', async () => {
    const db = getDb();
    const operacaoId = freshId('gone');
    const before = { nome: 'Venda padrão', cfop: '5102' };

    await recordOperacaoModification(
      db,
      operacaoId,
      before,
      undefined,
      freshId('evt'),
      EVENT_TIME_MICROS,
    );

    expect((await historyRef(db, operacaoId).get()).empty).toBe(true);
  });

  it('records an update entry with only the changed fields', async () => {
    const db = getDb();
    const operacaoId = freshId();
    await db.collection('operacao').doc(operacaoId).set(novaOperacao());
    await waitForRows(db, operacaoId, 1);

    const eventId = freshId('evt');
    const before = novaOperacao();
    const after = novaOperacao({ cfop: '5405' });
    await recordOperacaoModification(db, operacaoId, before, after, eventId, EVENT_TIME_MICROS);

    const entry = (await historyRef(db, operacaoId).doc(eventId).get()).data()!;
    expect(entry.kind).toBe('update');
    expect(entry.campos).toEqual(['cfop']);
  });
});

/** Composes one write exactly like `makeModificationHistoryTrigger`'s callback body. */
async function driveTrigger(
  db: Firestore,
  source: ModificationHistorySource,
  params: Record<string, string>,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  eventId: string,
  eventTimeMicros: number,
): Promise<boolean> {
  const { parentId, docId, path } = source.resolve(params);
  const entry = buildModificationEntry({
    before,
    after,
    ignore: [...source.ignoreFields, ...(source.extraIgnores?.(before, after) ?? [])],
    path,
    subcolecao: source.subcolecao,
    docId,
    eventId,
    eventTimeMicros,
    expand: source.expand,
    usuarioOuterRef: null,
  });
  if (entry === null) return false;
  return recordModification(db, source.root, parentId, entry, {
    requireParentExists: source.requireParentExists,
  });
}

describe.skipIf(!EMULATED)('regraImpostoHistorySource (emulator)', () => {
  const EVENT_TIME_MICROS = Date.parse('2026-08-01T13:00:00.000Z') * 1000;

  it('a delete with the parent operação EXISTING records kind "delete"', async () => {
    const db = getDb();
    const operacaoId = freshId();
    await db.collection('operacao').doc(operacaoId).set(novaOperacao());
    await waitForRows(db, operacaoId, 1);

    const regraId = freshId('reg');
    const before = { id: regraId, NCM: '61091000' };
    const eventId = freshId('evt');
    const wrote = await driveTrigger(
      db,
      regraImpostoHistorySource,
      { operacaoId, docId: regraId },
      before,
      undefined,
      eventId,
      EVENT_TIME_MICROS,
    );
    expect(wrote).toBe(true);

    const entry = (await historyRef(db, operacaoId).doc(eventId).get()).data()!;
    expect(entry.kind).toBe('delete');
    expect(entry.changes.NCM).toEqual({ old: '61091000', new: null });
    // `id` mirrors the doc id and must never show up as a changed field.
    expect(entry.campos).not.toContain('id');
  });

  it('a write racing the onOperacaoDeleted cascade (parent MISSING) records NO entry', async () => {
    const db = getDb();
    const operacaoId = freshId('gone'); // never created — the onOperacaoDeleted cascade race

    const regraId = freshId('reg');
    const before = { id: regraId, NCM: '61091000' };
    const eventId = freshId('evt');
    const wrote = await driveTrigger(
      db,
      regraImpostoHistorySource,
      { operacaoId, docId: regraId },
      before,
      undefined,
      eventId,
      EVENT_TIME_MICROS,
    );
    expect(wrote).toBe(false);

    expect((await historyRef(db, operacaoId).get()).empty).toBe(true);
  });
});
