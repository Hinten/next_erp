import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
import { createE2ETestEnv, createTestEnv, EMULATED } from './helpers';

const NFE_PATH = 'pedidos/p1/nfev4';
const FISCAL_COLLECTIONS = [
  { path: NFE_PATH, claim: 'd_nfe' },
  { path: 'filiais/f1/enviNfe', claim: 'd_fiscal' },
  { path: 'filiais/f1/inutilizacao', claim: 'd_fiscal' },
  { path: `${NFE_PATH}/existing/cartacorrecao`, claim: 'd_fiscal' },
];

describe.skipIf(!EMULATED)('server-owned fiscal records (#503)', () => {
  describe.each([
    { ruleset: 'production', createEnv: createTestEnv },
    { ruleset: 'staging', createEnv: createE2ETestEnv },
  ])('$ruleset rules', ({ createEnv }) => {
    let env: RulesTestEnvironment;

    function db(uid: string, claims: Record<string, unknown>): Firestore {
      return env.authenticatedContext(uid, claims).firestore() as unknown as Firestore;
    }

    beforeAll(async () => {
      env = await createEnv();
      await env.clearFirestore();
      await env.withSecurityRulesDisabled(async (ctx) => {
        const admin = ctx.firestore() as unknown as Firestore;
        for (const { path } of FISCAL_COLLECTIONS) {
          await setDoc(doc(admin, `${path}/existing`), { marker: 'original' });
        }
      });
    });

    afterAll(async () => {
      await env?.cleanup();
    });

    it.each(FISCAL_COLLECTIONS)('$path requires the read bit or su', async ({ path, claim }) => {
      const savedPath = `${path}/existing`;
      await assertSucceeds(getDoc(doc(db('reader', { [claim]: 1 }), savedPath)));
      await assertSucceeds(getDoc(doc(db('superuser', { su: true }), savedPath)));
      await assertFails(getDoc(doc(db('writer', { [claim]: 6 }), savedPath)));
    });

    it.each(FISCAL_COLLECTIONS)(
      '$path denies create, update and delete to privileged clients',
      async ({ path, claim }) => {
        const writer = db('writer', { [claim]: 6 }); // write + delete bits
        const superuser = db('superuser', { su: true });
        for (const [id, client] of [
          ['writer', writer],
          ['superuser', superuser],
        ] as const) {
          await assertFails(setDoc(doc(client, `${path}/new-${id}`), { marker: 'create' }));
          const existing = doc(client, `${path}/existing`);
          await assertFails(updateDoc(existing, { marker: 'update' }));
          await assertFails(deleteDoc(existing));
        }
      },
    );

    it('allows nfev4 collection-group queries with the NF-e read bit', async () => {
      const reader = db('nfe-reader', { d_nfe: 1 });
      const result = await assertSucceeds(getDocs(collectionGroup(reader, 'nfev4')));
      expect(result.docs.map((entry) => entry.ref.path)).toContain(`${NFE_PATH}/existing`);

      const fiscalReader = db('fiscal-reader', { d_fiscal: 1 });
      await assertFails(getDocs(collectionGroup(fiscalReader, 'nfev4')));
    });
  });
});
