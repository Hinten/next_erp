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
import { ROLES_A_CRIAR, criarUsuariosTeste } from './testUsers';

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
    expect((await store.get(USUARIO_TESTE_ROLE.vendedor))?.nickname).toBe('TEST-novo');
  });

  it('B3: get round-trips the whole record, password included', async () => {
    // The password is the reason this collection exists — a store that silently
    // dropped it would look healthy in every other assertion.
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);
    const written = rec(USUARIO_TESTE_ROLE.comprador, { password: 'sup3r-s3cr3t', email: null });

    await store.put(written);

    expect(await store.get(USUARIO_TESTE_ROLE.comprador)).toEqual(written);
  });

  it('B4: get returns null for a role with no record', async () => {
    const integracaoId = newIntegracaoId();
    const store = createTestUserStore(getAdminFirestore(), integracaoId);

    await store.put(rec(USUARIO_TESTE_ROLE.vendedor));

    // Positive first, so this cannot pass against an empty wrong database.
    expect(await store.get(USUARIO_TESTE_ROLE.vendedor)).not.toBeNull();
    expect(await store.get(USUARIO_TESTE_ROLE.comprador)).toBeNull();
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
