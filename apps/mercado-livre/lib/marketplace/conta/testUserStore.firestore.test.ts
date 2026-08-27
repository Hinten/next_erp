/**
 * `createTestUserStore` against a REAL Firestore (the emulator lane).
 *
 * `testUsers.test.ts` proves the ORDERING rules against an in-memory store, and
 * that is the right place for them. What it cannot prove is that the store those
 * rules depend on actually behaves as assumed — that a `put` is durable, that a
 * `get` by role finds what a previous run wrote, and that the role doc id really
 * makes a re-run reuse instead of duplicate. Those are Firestore semantics, and
 * mocking them is mocking the thing under test.
 *
 * ⚠️ `db` comes from the PRODUCTION accessor `getAdminFirestore()`, never a local
 * copy — that puts the project/database wiring itself under test. Every `it`
 * carries at least one POSITIVE existence assertion, because in the emulator a
 * mis-targeted database silently auto-creates and a file made only of
 * "empty"/"not found" assertions passes identically against the wrong one.
 */
import { randomUUID } from 'node:crypto';
import { USUARIO_TESTE_ROLE, type UsuarioTesteMercadoLivre } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { createTestUserStore } from './testUserStore';
import {
  ROLES_A_CRIAR,
  TestUserGuardError,
  type UsuarioTesteRegistrado,
  criarUsuariosTeste,
  docIdAdicional,
  reutilizavel,
} from './testUsers';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const NOW = 1_700_000_000_000;

function newIntegracaoId(): string {
  return `int${randomUUID().replace(/-/g, '')}`;
}

function rec(
  role: UsuarioTesteMercadoLivre['role'],
  over: Partial<UsuarioTesteMercadoLivre> = {},
): UsuarioTesteMercadoLivre {
  return {
    role,
    id: 120506781,
    nickname: `TEST-${role}`,
    password: 'qatest328',
    site_id: 'MLB',
    site_status: 'active',
    email: null,
    createdAt: NOW,
    createdByUserId: 999,
    ...over,
  };
}

/**
 * The record a reuse run would pick for `role` — the PRODUCTION lookup, so these
 * assertions exercise the thing the pair bootstrap actually calls.
 */
async function reusavel(
  store: { list: () => Promise<UsuarioTesteRegistrado[]> },
  role: UsuarioTesteMercadoLivre['role'],
): Promise<UsuarioTesteRegistrado | null> {
  return reutilizavel(await store.list(), role);
}

/**
 * One raw doc BY ID. ⚠️ Use this, not `reusavel`, to assert a SPECIFIC document
 * is untouched: once several records share a role the reuse lookup answers
 * "the newest", which is a different question.
 */
async function rawDoc(integracaoId: string, docId: string) {
  return (await rawColl(integracaoId).doc(docId).get()).data();
}

/** The raw subcollection, UNCONVERTED — used to assert doc IDS. */
function rawColl(integracaoId: string) {
  return getAdminFirestore().collection('integracao').doc(integracaoId).collection('usuariosTeste');
}

describe.skipIf(!EMULATED)('createTestUserStore (Firestore emulator)', () => {
  it('B1: keys each record by its ROLE, not an auto-id', async () => {
    // ⚠️ The doc id is what makes rule 2 possible. Auto-ids would leave `get`
    // unable to see an earlier run's record, and every retry would mint a fresh
    // test user — burning ML's ten permanent slots two at a time.
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);

    await store.put(rec(USUARIO_TESTE_ROLE.vendedor));
    await store.put(rec(USUARIO_TESTE_ROLE.comprador));

    const snap = await rawColl(integracaoId).get();
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['comprador', 'vendedor']);
  });

  it('B2: a re-put of the same role overwrites rather than accumulating', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);

    await store.put(rec(USUARIO_TESTE_ROLE.vendedor, { nickname: 'TEST-antigo' }));
    await store.put(rec(USUARIO_TESTE_ROLE.vendedor, { nickname: 'TEST-novo' }));

    expect((await rawColl(integracaoId).get()).size).toBe(1);
    expect((await reusavel(store, USUARIO_TESTE_ROLE.vendedor))?.nickname).toBe('TEST-novo');
  });

  it('B3: a stored record round-trips whole, password included', async () => {
    // The password is the reason this collection exists — a store that silently
    // dropped it would look healthy in every other assertion.
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);
    const written = rec(USUARIO_TESTE_ROLE.comprador, { password: 'sup3r-s3cr3t', email: null });

    await store.put(written);

    // ⚠️ `docId` on the expectation, not a looser matcher: the read side gains
    // exactly one field, and a `toMatchObject` here would stop noticing if a
    // stored field ever went missing — which for `password` is the whole risk.
    expect(await reusavel(store, USUARIO_TESTE_ROLE.comprador)).toEqual({
      ...written,
      docId: USUARIO_TESTE_ROLE.comprador,
    });
  });

  it('B4: the reuse lookup returns null for a role with no record', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);

    await store.put(rec(USUARIO_TESTE_ROLE.vendedor));

    // Positive first, so this cannot pass against an empty wrong database.
    expect(await reusavel(store, USUARIO_TESTE_ROLE.vendedor)).not.toBeNull();
    expect(await reusavel(store, USUARIO_TESTE_ROLE.comprador)).toBeNull();
  });

  it('B5: list returns seller first regardless of Firestore doc-id order', async () => {
    // Doc ids sort 'comprador' < 'vendedor'; the UI must still read seller-first.
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);

    await store.put(rec(USUARIO_TESTE_ROLE.comprador));
    await store.put(rec(USUARIO_TESTE_ROLE.vendedor));

    expect((await store.list()).map((u) => u.role)).toEqual(ROLES_A_CRIAR);
  });

  it('B6: a re-run against the real store reuses BOTH roles and mints nothing', async () => {
    // The end-to-end shape of rule 2, over real persistence: this is what stops
    // a second click from costing two more of the account's ten slots.
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);
    let mints = 0;
    const deps = {
      api: {
        getMe: async () => ({ id: 999, nickname: 'LOJA-REAL' }),
        criarUsuarioTeste: async () => {
          mints += 1;
          return {
            id: 1000 + mints,
            nickname: `TEST000${String(mints)}`,
            password: `senha-${String(mints)}`,
          };
        },
      },
      store,
      tokens: { deleteAll: async () => 0 },
      now: () => NOW,
    };

    const first = await criarUsuariosTeste(deps);
    const second = await criarUsuariosTeste(deps);

    expect(first.criados).toEqual(ROLES_A_CRIAR);
    expect(mints).toBe(2);
    expect(second.criados).toEqual([]);
    expect(second.reaproveitados).toEqual(ROLES_A_CRIAR);
    // …and the second run reports the FIRST run's credentials, not new ones.
    expect(second.usuarios.map((u) => u.password)).toEqual(['senha-1', 'senha-2']);
    expect((await rawColl(integracaoId).get()).size).toBe(2);
  });
});

describe.skipIf(!EMULATED)('createTestUserStore — the additional mint (Firestore emulator)', () => {
  it('B7: create writes a NEW doc and leaves the role doc untouched', async () => {
    // The property the whole `${role}-${mlUserId}` scheme exists for: replacing
    // a buyer must not destroy the previous one's password, which ML will never
    // reissue.
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);
    const antigo = rec(USUARIO_TESTE_ROLE.comprador, { id: 555, password: 'nao-perca-isto' });
    await store.put(antigo);

    await store.create(
      docIdAdicional(USUARIO_TESTE_ROLE.comprador, 777),
      rec(USUARIO_TESTE_ROLE.comprador, { id: 777, nickname: 'TEST-novo', password: 'nova' }),
    );

    const snap = await rawColl(integracaoId).get();
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['comprador', 'comprador-777']);
    // The stored record is byte-identical to what was written before.
    expect(await rawDoc(integracaoId, USUARIO_TESTE_ROLE.comprador)).toEqual(antigo);
  });

  it('B8: create REFUSES an existing doc id, and the stored password survives', async () => {
    // Firestore's `create` is what turns a collision into ALREADY_EXISTS instead
    // of a silent overwrite; the store maps that onto a guard error the route
    // already knows how to shape.
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);
    const docId = docIdAdicional(USUARIO_TESTE_ROLE.comprador, 777);
    const original = rec(USUARIO_TESTE_ROLE.comprador, { id: 777, password: 'a-preciosa' });
    await store.create(docId, original);

    const err = await store
      .create(docId, rec(USUARIO_TESTE_ROLE.comprador, { id: 777, password: 'sobrescrita' }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TestUserGuardError);
    expect((err as TestUserGuardError).code).toBe('ML_USUARIO_TESTE_DUPLICADO');
    expect((err as TestUserGuardError).status).toBe(409);
    const stored = (await rawColl(integracaoId).doc(docId).get()).data();
    expect(stored?.password).toBe('a-preciosa');
  });

  it('B9: list surfaces the additional records after the pair, seller first', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);

    await store.put(rec(USUARIO_TESTE_ROLE.comprador, { nickname: 'TEST-comprador-1' }));
    await store.put(rec(USUARIO_TESTE_ROLE.vendedor));
    await store.create(
      docIdAdicional(USUARIO_TESTE_ROLE.comprador, 777),
      rec(USUARIO_TESTE_ROLE.comprador, { id: 777, nickname: 'TEST-comprador-2' }),
    );

    const nicks = (await store.list()).map((u) => u.nickname);
    expect(nicks).toEqual(['TEST-vendedor', 'TEST-comprador-1', 'TEST-comprador-2']);
  });

  it('B10: an additional run mints ONE, keeps the credential and spares the pair', async () => {
    // The end-to-end #1087 shape over real persistence: the seller is untouched,
    // the old buyer is untouched, and the conta stays connected for a follow-up.
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);
    let mints = 0;
    let wipes = 0;
    const api = {
      getMe: async () => ({ id: 999, nickname: 'LOJA-REAL' }),
      criarUsuarioTeste: async () => {
        mints += 1;
        return {
          id: 1000 + mints,
          nickname: `TEST000${String(mints)}`,
          password: `senha-${String(mints)}`,
        };
      },
    };
    const tokens = {
      deleteAll: async () => {
        wipes += 1;
        return 0;
      },
    };

    await criarUsuariosTeste({ api, store, tokens, now: () => NOW });
    const avulso = await criarUsuariosTeste({
      api,
      store,
      tokens,
      now: () => NOW,
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
      revogarCredencial: false,
    });

    expect(mints).toBe(3);
    expect(wipes).toBe(1);
    expect(avulso.criados).toEqual([USUARIO_TESTE_ROLE.comprador]);
    expect(avulso.credencialRevogada).toBe(false);
    const snap = await rawColl(integracaoId).get();
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['comprador', 'comprador-1003', 'vendedor']);
    // The pair the first run stored is exactly as it was left.
    expect((await rawDoc(integracaoId, USUARIO_TESTE_ROLE.comprador))?.password).toBe('senha-2');
    expect((await rawDoc(integracaoId, USUARIO_TESTE_ROLE.vendedor))?.password).toBe('senha-1');
  });
});

describe.skipIf(!EMULATED)(
  'createTestUserStore — doc ids and the put guard (Firestore emulator)',
  () => {
    it('B11: list reports the doc id holding each record, both shapes at once', async () => {
      // ⭐ The read the panel depends on. The pair bootstrap's bare `comprador`
      // and an additional mint's `comprador-<id>` carry the SAME `role`, so
      // without the doc id a screen showing both cannot say they are two
      // documents rather than one row rendered twice — and a buyer count that
      // failed to grow looks identical to a document that was replaced.
      const integracaoId = newIntegracaoId();
      const store = createTestUserStore(getAdminFirestore(), integracaoId);

      await store.put(rec(USUARIO_TESTE_ROLE.vendedor));
      await store.put(rec(USUARIO_TESTE_ROLE.comprador));
      await store.create(
        docIdAdicional(USUARIO_TESTE_ROLE.comprador, 777),
        rec(USUARIO_TESTE_ROLE.comprador, { id: 777, nickname: 'TEST-comprador-2' }),
      );

      expect((await store.list()).map((u) => u.docId)).toEqual([
        'vendedor',
        'comprador',
        'comprador-777',
      ]);
    });

    it('B12: put REFUSES a different account on the role doc, password intact', async () => {
      // The last path that could still destroy an unrecoverable credential. `put`
      // was a bare `set`, safe only because `reutilizavel` had just read the role
      // as absent — an argument living outside the write, one refactor from being
      // false. The guard now sits IN the write.
      const integracaoId = newIntegracaoId();
      const store = createTestUserStore(getAdminFirestore(), integracaoId);
      const antigo = rec(USUARIO_TESTE_ROLE.comprador, { id: 555, password: 'nao-perca-isto' });
      await store.put(antigo);

      const err = await store
        .put(rec(USUARIO_TESTE_ROLE.comprador, { id: 999, password: 'sobrescrita' }))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TestUserGuardError);
      expect((err as TestUserGuardError).code).toBe('ML_USUARIO_TESTE_DUPLICADO');
      expect(await rawDoc(integracaoId, USUARIO_TESTE_ROLE.comprador)).toEqual(antigo);
    });

    it('B13: put stays idempotent for the SAME account — the partial-re-run case', async () => {
      // The control B12 needs. Rule 2 lets a run that failed halfway be retried,
      // and that retry re-writes identical content at the same doc id; a guard
      // that refused it would turn every recovery into a dead end.
      const integracaoId = newIntegracaoId();
      const store = createTestUserStore(getAdminFirestore(), integracaoId);
      const registro = rec(USUARIO_TESTE_ROLE.vendedor, { id: 555 });

      await store.put(registro);
      await store.put({ ...registro, site_status: 'paused' });

      expect((await rawColl(integracaoId).get()).size).toBe(1);
      expect((await rawDoc(integracaoId, USUARIO_TESTE_ROLE.vendedor))?.site_status).toBe('paused');
    });
  },
);
