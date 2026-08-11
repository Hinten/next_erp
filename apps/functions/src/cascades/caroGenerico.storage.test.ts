import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { cascadeCaroGenerico } from '../lib/cascadeCaroGenerico';

// Integration test — requires the firestore emulator. Drives the PRODUCTION
// core directly (trigger delivery on a named database is awkward to exercise in
// the emulator), same convention as `onOperacaoDeleted.storage.test.ts`.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

describe.skipIf(!EMULATED)('cascadeCaroGenerico (emulator)', () => {
  let integracaoId: string;

  beforeAll(async () => {
    integracaoId = `int${randomUUID().replace(/-/g, '')}`;
    const db = getDb();
    const ref = db.collection('integracao').doc(integracaoId);
    await ref.set({ nome: 'conta de teste', tipo: 1 });
    await ref.collection('credenciais').doc('c1').set({ token: 'x' });
    await ref.collection('tokenDuravel').doc('t1').set({ refresh_token: 'y' });
    // NOT declared in `integracaoMeta.cascade` and NOT in `ALL_DOMAINS`. This is
    // the assertion that fails the day someone swaps the listCollections() walk
    // for a registry-derived path list — the same trick
    // `onProdutoDeleted.storage.test.ts` plays with `variacoesml`.
    await ref.collection('subcolecaoNaoRegistrada').doc('n1').set({ legado: true });
  });

  it('reclaims every subcollection, including one no schema declares', async () => {
    const db = getDb();
    const ref = db.collection('integracao').doc(integracaoId);

    await cascadeCaroGenerico(db, 'integracao', integracaoId);

    expect((await ref.get()).exists).toBe(false);
    for (const name of ['credenciais', 'tokenDuravel', 'subcolecaoNaoRegistrada']) {
      expect((await ref.collection(name).get()).empty).toBe(true);
    }
  });

  it('is idempotent on a document that is already gone', async () => {
    // The real entry condition: `onDocumentDeleted` fires AFTER the delete, so
    // the parent never exists when the cascade runs. Flutter's own deleteCascade
    // racing this one lands in the same place.
    const db = getDb();
    await expect(cascadeCaroGenerico(db, 'integracao', integracaoId)).resolves.toBeUndefined();
  });

  it('sweeps a metodo_pgto credenciais subtree too', async () => {
    // Second collection through the same factory — the point of the factory is
    // that nothing about it is integracao-shaped.
    const db = getDb();
    const metodoId = `mp${randomUUID().replace(/-/g, '')}`;
    const ref = db.collection('metodo_pgto').doc(metodoId);
    await ref.set({ nome: 'cartão' });
    await ref.collection('credenciais').doc('c1').set({ token: 'z' });

    await cascadeCaroGenerico(db, 'metodo_pgto', metodoId);

    expect((await ref.collection('credenciais').get()).empty).toBe(true);
  });
});
