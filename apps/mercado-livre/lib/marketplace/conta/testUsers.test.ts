/**
 * `criarUsuariosTeste` — the ordering rules, which are the whole point.
 *
 * ML caps an account at ten test users, never lists them, and never reissues a
 * password. Every assertion below is about the same property: no path through
 * this function may consume a slot without durably storing what it bought, and
 * none may destroy the credential that could retry until it has.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MlTestUser, MlUser } from '@delfrance/integrations-mercado-livre';
import {
  USUARIO_TESTE_ROLE,
  type UsuarioTesteMercadoLivre,
  type UsuarioTesteRole,
} from '@delfrance/schemas';

import {
  ROLES_A_CRIAR,
  TestUserGuardError,
  type TestUserStore,
  codigosVerificacaoEmail,
  criarUsuariosTeste,
} from './testUsers';

const NOW = 1_700_000_000_000;
const ME: MlUser = { id: 999, nickname: 'LOJA-REAL', site_id: 'MLB' };

function minted(over: Partial<MlTestUser> = {}): MlTestUser {
  return {
    id: 120506781,
    nickname: 'TEST0548',
    password: 'qatest328',
    site_status: 'active',
    ...over,
  };
}

/**
 * In-memory store that RECORDS the call order against the mints, so a test can
 * assert interleaving and not merely final state. Final state alone cannot tell
 * "persisted after each mint" from "persisted both at the end".
 */
function fakeStore(seed: UsuarioTesteMercadoLivre[] = []) {
  const docs = new Map<string, UsuarioTesteMercadoLivre>(seed.map((r) => [r.role, r]));
  const log: string[] = [];
  const store: TestUserStore & { docs: typeof docs; log: string[] } = {
    docs,
    log,
    async get(role) {
      return docs.get(role) ?? null;
    },
    async put(record) {
      log.push(`put:${record.role}`);
      docs.set(record.role, record);
    },
    async list() {
      return [...docs.values()];
    },
  };
  return store;
}

function deps(over: {
  mint?: () => Promise<MlTestUser>;
  store?: ReturnType<typeof fakeStore>;
  me?: MlUser;
  deleteAll?: () => Promise<number>;
}) {
  const store = over.store ?? fakeStore();
  let n = 0;
  const criarUsuarioTeste = vi.fn(
    over.mint ??
      (async () => {
        n += 1;
        store.log.push(`mint:${String(n)}`);
        return minted({ id: 1000 + n, nickname: `TEST000${String(n)}` });
      }),
  );
  const deleteAll = vi.fn(
    over.deleteAll ??
      (async () => {
        store.log.push('deleteAll');
        return 2;
      }),
  );
  return {
    store,
    criarUsuarioTeste,
    deleteAll,
    deps: {
      api: { criarUsuarioTeste, getMe: async () => over.me ?? ME },
      store,
      tokens: { deleteAll },
      now: () => NOW,
    },
  };
}

describe('criarUsuariosTeste', () => {
  it('mints seller then buyer and stores both', async () => {
    const { deps: d, store } = deps({});

    const result = await criarUsuariosTeste(d);

    expect(result.criados).toEqual([USUARIO_TESTE_ROLE.vendedor, USUARIO_TESTE_ROLE.comprador]);
    expect(result.reaproveitados).toEqual([]);
    expect(result.usuarios.map((u) => u.role)).toEqual(ROLES_A_CRIAR);
    expect(store.docs.size).toBe(2);
    expect(result.conta).toEqual({ id: 999, nickname: 'LOJA-REAL' });
  });

  it('RULE 1: persists each user before minting the next', async () => {
    // ⚠️ The interleaving IS the assertion. Batching both writes to the end
    // would leave the same final state while opening a window where a mint has
    // spent a permanent slot and produced nothing recoverable.
    const { deps: d, store } = deps({});

    await criarUsuariosTeste(d);

    expect(store.log).toEqual(['mint:1', 'put:vendedor', 'mint:2', 'put:comprador', 'deleteAll']);
  });

  it('RULE 1: a failed SECOND mint keeps the first user and the token', async () => {
    const store = fakeStore();
    let calls = 0;
    const { deps: d, deleteAll } = deps({
      store,
      mint: async () => {
        calls += 1;
        if (calls === 2) throw new Error('ML: max test users reached');
        store.log.push('mint:1');
        return minted();
      },
    });

    await expect(criarUsuariosTeste(d)).rejects.toThrow('max test users');

    // The seller survived…
    expect(store.docs.get(USUARIO_TESTE_ROLE.vendedor)?.nickname).toBe('TEST0548');
    // …and, critically, the credential that can retry was NOT revoked.
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('RULE 2: reuses a stored role instead of minting a second one', async () => {
    // A retry after the failure above must cost zero slots.
    const existing: UsuarioTesteMercadoLivre = {
      role: USUARIO_TESTE_ROLE.vendedor,
      id: 555,
      nickname: 'TEST-JA-EXISTE',
      password: 'ja-salva',
      site_id: 'MLB',
      site_status: 'active',
      email: null,
      createdAt: NOW - 1000,
      createdByUserId: 999,
    };
    const { deps: d, criarUsuarioTeste } = deps({ store: fakeStore([existing]) });

    const result = await criarUsuariosTeste(d);

    expect(criarUsuarioTeste).toHaveBeenCalledTimes(1);
    expect(result.reaproveitados).toEqual([USUARIO_TESTE_ROLE.vendedor]);
    expect(result.criados).toEqual([USUARIO_TESTE_ROLE.comprador]);
    expect(result.usuarios[0]).toEqual(existing);
  });

  it('RULE 2: a fully-stored pair mints nothing at all', async () => {
    const both = ROLES_A_CRIAR.map(
      (role: UsuarioTesteRole): UsuarioTesteMercadoLivre => ({
        role,
        id: 1,
        nickname: `T-${role}`,
        password: 'p',
        site_id: 'MLB',
        site_status: null,
        email: null,
        createdAt: NOW,
        createdByUserId: 999,
      }),
    );
    const { deps: d, criarUsuarioTeste } = deps({ store: fakeStore(both) });

    const result = await criarUsuariosTeste(d);

    expect(criarUsuarioTeste).not.toHaveBeenCalled();
    expect(result.criados).toEqual([]);
  });

  it('RULE 3: revokes the credential only AFTER both are stored', async () => {
    const { deps: d, store } = deps({});

    await criarUsuariosTeste(d);

    const wipe = store.log.indexOf('deleteAll');
    expect(wipe).toBeGreaterThan(store.log.indexOf('put:vendedor'));
    expect(wipe).toBeGreaterThan(store.log.indexOf('put:comprador'));
    expect(wipe).toBe(store.log.length - 1);
  });

  it('RULE 3: reports how many credential docs were removed', async () => {
    const { deps: d } = deps({ deleteAll: async () => 3 });
    expect((await criarUsuariosTeste(d)).credenciaisRemovidas).toBe(3);
  });

  it('refuses a conta that is ITSELF a test user, before minting anything', async () => {
    // The next step deletes this conta's credential, so a mis-selected conta is
    // not something the operator can undo by clicking again. `TETE…` is the
    // format ML actually mints (see anuncioTeste.ts) — a /^TEST/ check misses it.
    const {
      deps: d,
      criarUsuarioTeste,
      deleteAll,
    } = deps({
      me: { id: 7, nickname: 'TETE8127263', site_id: 'MLB' },
    });

    const err = await criarUsuariosTeste(d).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TestUserGuardError);
    expect((err as TestUserGuardError).code).toBe('ML_CONTA_JA_E_TESTE');
    expect((err as TestUserGuardError).status).toBe(409);
    expect(criarUsuarioTeste).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('stamps site_id, createdAt and the minting conta onto each record', async () => {
    // `createdByUserId` is the only surviving trace of which conta spent a slot
    // — its credential is gone by the time anyone reads this back.
    const { deps: d } = deps({});

    const [vendedor] = (await criarUsuariosTeste(d)).usuarios;

    expect(vendedor).toMatchObject({
      site_id: 'MLB',
      createdAt: NOW,
      createdByUserId: 999,
      role: USUARIO_TESTE_ROLE.vendedor,
    });
  });

  it('falls back to the requested site when ML omits site_id', async () => {
    const { deps: d } = deps({ mint: async () => minted({ site_id: undefined }) });
    expect((await criarUsuariosTeste(d)).usuarios[0]?.site_id).toBe('MLB');
  });
});

describe('codigosVerificacaoEmail', () => {
  it('derives both lengths from the trailing digits of the user id', () => {
    // «o código de validação de e-mail para usuários de teste será igual aos
    // últimos dígitos do ID do usuário… 4 ou 6 dígitos dependendo do caso».
    // There is no inbox to check, so without this the operator is simply stuck.
    expect(codigosVerificacaoEmail(653764425)).toEqual({ quatro: '4425', seis: '764425' });
  });

  it('does not pad a short id', () => {
    expect(codigosVerificacaoEmail(12345)).toEqual({ quatro: '2345', seis: '12345' });
  });
});
