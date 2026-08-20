import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { CascadeTruncatedError, cascadeCaroGenerico } from '../lib/cascadeCaroGenerico';

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

/**
 * `chat` (#980) — the budgeted cascade, and the only one of the four whose
 * subtree can outlast an invocation. Same core function, so what is exercised
 * here is the volume half: many leaf `mensagem` documents, and what happens when
 * the walk runs out of budget half-way through them.
 */
describe.skipIf(!EMULATED)('cascadeCaroGenerico — chat/{conversaId}/mensagem (emulator)', () => {
  /**
   * Enough to be a real subcollection without slowing the lane down. Paging
   * (`DEFAULT_PAGE_SIZE` is 300) is covered by `deleteSubtree.test.ts`; what
   * these cases exercise is the budget contract, which is per-document.
   */
  const MENSAGENS = 12;

  async function seedConversa(): Promise<string> {
    const db = getDb();
    const conversaId = `cv${randomUUID().replace(/-/g, '')}`;
    const ref = db.collection('chat').doc(conversaId);
    await ref.set({ nome: 'Conversa de teste', origem: 'site' });

    // `void`: BulkWriter.set is fire-and-forget by design — the per-write
    // promise is not the completion signal, `close()` below is.
    const writer = db.bulkWriter();
    for (let i = 0; i < MENSAGENS; i += 1) {
      void writer.set(ref.collection('mensagem').doc(`m${String(i).padStart(3, '0')}`), {
        texto: `mensagem ${i}`,
      });
    }
    // A subcollection the schemas do not model. The migrated corpus has these,
    // and a registry-derived sweep would orphan it silently — the same assertion
    // `subcolecaoNaoRegistrada` makes above, on the collection where the
    // temptation to hard-code `mensagem` is strongest.
    void writer.set(ref.collection('anexosLegado').doc('a1'), { legado: true });
    await writer.close();

    return conversaId;
  }

  it('reclaims the whole mensagem subcollection', async () => {
    const db = getDb();
    const conversaId = await seedConversa();
    const ref = db.collection('chat').doc(conversaId);

    // The real entry condition: `onDocumentDeleted` fires after the delete.
    await ref.delete();
    await cascadeCaroGenerico(db, 'chat', conversaId, 60_000);

    expect((await ref.collection('mensagem').get()).empty).toBe(true);
    expect((await ref.collection('anexosLegado').get()).empty).toBe(true);
  });

  it('throws CascadeTruncatedError when the budget is spent, keeping what it reached', async () => {
    const db = getDb();
    const conversaId = await seedConversa();
    const ref = db.collection('chat').doc(conversaId);

    // A budget already in the past: the walk queues the root and stops at the
    // first deadline check, before descending. Deterministic, unlike a small
    // positive budget racing the emulator.
    await expect(cascadeCaroGenerico(db, 'chat', conversaId, -1)).rejects.toBeInstanceOf(
      CascadeTruncatedError,
    );

    // Progress is COMMITTED, not rolled back — `deleteDocumentSubtree` closes its
    // BulkWriter before returning, which is what makes redelivery a resume.
    expect((await ref.get()).exists).toBe(false);
    expect((await ref.collection('mensagem').get()).size).toBe(MENSAGENS);
  });

  it('finishes the remainder on the next delivery', async () => {
    const db = getDb();
    const conversaId = await seedConversa();
    const ref = db.collection('chat').doc(conversaId);

    await expect(cascadeCaroGenerico(db, 'chat', conversaId, -1)).rejects.toBeInstanceOf(
      CascadeTruncatedError,
    );
    // What Eventarc redelivery does: the same event, the same walk, a smaller
    // subtree. It must resolve — a cascade that always threw would retry until
    // the delivery window expired and leave the orphans behind anyway.
    await expect(cascadeCaroGenerico(db, 'chat', conversaId, 60_000)).resolves.toBeUndefined();

    expect((await ref.collection('mensagem').get()).empty).toBe(true);
    expect((await ref.collection('anexosLegado').get()).empty).toBe(true);
  });
});
