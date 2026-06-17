import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc, type Firestore } from 'firebase/firestore';
import { createTestEnv, EMULATED } from './helpers';

// Behavior proof for the rules-side super user (#163 Part B): the dedicated
// `su` claim short-circuits the permission + tenancy checks, but field
// validators still apply. A non-`su` user is unaffected (the rest of the
// matrix in firestore.rules.test.ts pins the per-bit behavior).
describe.skipIf(!EMULATED)('generated firestore.rules — super user (su claim)', () => {
  let env: RulesTestEnvironment;

  function db(claims?: Record<string, unknown>): Firestore {
    const uid = `u${Math.random().toString(36).slice(2)}`;
    const ctx = claims ? env.authenticatedContext(uid, claims) : env.unauthenticatedContext();
    return ctx.firestore() as unknown as Firestore;
  }

  async function seed(path: string, data: Record<string, unknown>): Promise<void> {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore() as unknown as Firestore, path), data);
    });
  }

  beforeAll(async () => {
    env = await createTestEnv();
    await env.clearFirestore();
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('su bypasses the permission check with NO domain claim (read/create/update/delete)', async () => {
    const su = db({ su: true }); // no d_deposito at all
    await assertSucceeds(setDoc(doc(su, 'depositos/su-d'), { nome: 'D' }));
    await assertSucceeds(getDoc(doc(su, 'depositos/su-d')));
    await assertSucceeds(updateDoc(doc(su, 'depositos/su-d'), { ativo: true }));
    await assertSucceeds(deleteDoc(doc(su, 'depositos/su-d')));
  });

  it('su bypasses tenant scoping — reads a grupoEconomico doc it does not own', async () => {
    await seed('grupoEconomico/g-other', { nome: 'Outro Grupo' });
    await assertSucceeds(getDoc(doc(db({ su: true }), 'grupoEconomico/g-other')));
    // A non-su user whose tenant claim doesn't match is still denied.
    await assertFails(getDoc(doc(db({ grupoEconomico: 'mine' }), 'grupoEconomico/g-other')));
  });

  it('su still must satisfy the field validator on a validated collection', async () => {
    const su = db({ su: true });
    // Bypasses the write bit, but the produto validator still rejects bad shapes.
    await assertFails(setDoc(doc(su, 'produtos/su-bad'), { nome: 123 }));
    await assertSucceeds(setDoc(doc(su, 'produtos/su-ok'), { nome: 'Caneca', ehKit: false }));
  });

  it('a signed-in user WITHOUT su and without claims is still denied', async () => {
    await seed('depositos/plain', { nome: 'x' });
    await assertFails(getDoc(doc(db({}), 'depositos/plain')));
    await assertFails(setDoc(doc(db({}), 'depositos/plain2'), { nome: 'y' }));
  });
});
