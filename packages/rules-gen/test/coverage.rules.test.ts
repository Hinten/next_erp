import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc, type Firestore } from 'firebase/firestore';
import { rulesClaimsFromBits } from '@delfrance/auth';
import { ALL_DOMAINS } from '@delfrance/schemas';
import { createTestEnv, EMULATED } from './helpers';

/**
 * CRUD coverage matrix (#160). For EVERY registered domain, a fully-permissioned
 * superuser must be able to create/get/update/delete — i.e. no collection or
 * operation is silently default-denied for lack of a match block. This is the
 * guard that would have caught the produto marketplace subcollections (#160):
 * they were missing from the ruleset, so even a superuser was denied.
 *
 * Per-bit gating (the "denied without the right claim" cases) is covered by
 * firestore.rules.test.ts; this suite only asserts the positive coverage floor.
 * The `grupoEconomico` tenant block is intentionally not here — it's not in
 * ALL_DOMAINS and its read needs a matching `grupoEconomico` claim (tested in
 * firestore.rules.test.ts).
 */
const SUPERUSER = rulesClaimsFromBits((1n << 128n) - 1n);

// Validated collections need a schema-valid create/update payload (one valid
// field is enough — validators are "validate only the touched keys"). Everything
// else accepts any shape.
const VALIDATED_PAYLOAD: Record<string, Record<string, unknown>> = {
  clientes: { tipo: '1' },
  produtos: { ehKit: false },
  pedidos: { ehSaida: true },
  'pedidos/{pedidoId}/pagamentos': { aVista: true },
  metodo_pgto: { tipo: 1 },
};

/** Fill `{placeholder}` segments with a literal id and append a doc id. */
function concretePath(collectionPath: string): string {
  return `${collectionPath.replace(/\{[^}]*\}/g, 'mtx')}/mtxdoc`;
}

describe.skipIf(!EMULATED)('CRUD coverage matrix — every domain is governed (#160)', () => {
  let env: RulesTestEnvironment;

  function su(): Firestore {
    return env.authenticatedContext('u-su', SUPERUSER).firestore() as unknown as Firestore;
  }

  beforeAll(async () => {
    env = await createTestEnv();
    await env.clearFirestore();
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  for (const domain of ALL_DOMAINS) {
    const path = domain.meta.collectionPath;
    it(`${path}: superuser can create, get, update, delete`, async () => {
      const ref = doc(su(), concretePath(path));
      const payload = VALIDATED_PAYLOAD[path] ?? { mtx: 1 };
      await assertSucceeds(setDoc(ref, payload)); // create
      await assertSucceeds(getDoc(ref)); // get
      await assertSucceeds(updateDoc(ref, payload)); // update
      await assertSucceeds(deleteDoc(ref)); // delete
    });
  }

  it('the matrix actually covered the produto subcollections', () => {
    const paths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(paths).toContain('produtos/{produtoId}/produtoMercadoLivre');
    expect(paths).toContain('produtos/{produtoId}/variacaoMercadoLivre');
  });
});
