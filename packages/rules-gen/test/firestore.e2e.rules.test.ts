import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, type Firestore } from 'firebase/firestore';
import { createE2ETestEnv, EMULATED } from './helpers';

// Behavior proof for the STAGING --e2e variant (#160): the Playwright fixtures
// write an e2e_-prefixed top-level collection. The fixed-path production rules
// default-deny it (see the "no match block → default deny" case in
// firestore.rules.test.ts — an e2e_* top-level collection is exactly such an
// unknown path). The --e2e ruleset adds one namespace block that grants the
// authenticated test user access without over-granting real collections.
describe.skipIf(!EMULATED)('firestore.e2e.rules (staging namespace block)', () => {
  let env: RulesTestEnvironment;

  // The historical shape: the run id lived in the collection NAME.
  const NS = 'e2e_run1_clientes';
  // Today's shape: a FIXED collection, run id in the DOCUMENT key. The block is a
  // regex on the collection name, so it covers both — which is why moving the id
  // needed no ruleset change and no rules deploy.
  const PROBE = 'e2e_probe';

  function authed(): Firestore {
    const uid = `u${Math.random().toString(36).slice(2)}`;
    // No d_* claims at all — the namespace block is gated on auth alone.
    return env.authenticatedContext(uid, {}).firestore() as unknown as Firestore;
  }

  function anon(): Firestore {
    return env.unauthenticatedContext().firestore() as unknown as Firestore;
  }

  async function seed(path: string): Promise<void> {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore() as unknown as Firestore, path), { ok: true });
    });
  }

  beforeAll(async () => {
    env = await createE2ETestEnv();
    await env.clearFirestore();
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('authenticated user reads & writes the e2e_* namespace', async () => {
    await assertSucceeds(setDoc(doc(authed(), `${NS}/c1`), { nome: 'x' }));
    await assertSucceeds(getDoc(doc(authed(), `${NS}/c1`)));
  });

  it('covers the whole subtree of the e2e_* namespace', async () => {
    await assertSucceeds(setDoc(doc(authed(), `${NS}/c1/enderecos/e1`), { rua: 'r' }));
    await assertSucceeds(getDoc(doc(authed(), `${NS}/c1/enderecos/e1`)));
  });

  it('still denies UNauthenticated access to the namespace', async () => {
    await seed(`${NS}/c-anon`);
    await assertFails(getDoc(doc(anon(), `${NS}/c-anon`)));
  });

  it('does NOT over-grant real collections (the block is e2e_-only)', async () => {
    // produtos still requires d_produto — the namespace regex never matches it.
    await seed('produtos/p1');
    await assertFails(getDoc(doc(authed(), 'produtos/p1')));
  });

  // The rules pre-flight guard (`verifyE2ENamespaceAccess`) writes, reads AND
  // deletes `e2e_probe/<runId>` as the ephemeral user. `allow read, write` covers
  // delete, so all three must pass — a regression here would red every e2e lane
  // at globalSetup rather than in a spec.
  it('grants the fixed e2e_probe collection, keyed by run id, for write/read/delete', async () => {
    const path = `${PROBE}/30379616273`;
    await assertSucceeds(setDoc(doc(authed(), path), { ping: true }));
    await assertSucceeds(getDoc(doc(authed(), path)));
    await assertSucceeds(deleteDoc(doc(authed(), path)));
  });
});
