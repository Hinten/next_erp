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
  USUARIO_TESTE_LIMITE_POR_CONTA,
  USUARIO_TESTE_ROLE,
  type UsuarioTesteMercadoLivre,
  type UsuarioTesteRole,
} from '@delfrance/schemas';

import {
  ROLES_A_CRIAR,
  TestUserGuardError,
  type CriarUsuariosTesteDeps,
  type TestUserStore,
  type UsuarioTesteRegistrado,
  codigosVerificacaoEmail,
  criarUsuariosTeste,
  docIdAdicional,
  reutilizavel,
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
    async put(record) {
      log.push(`put:${record.role}`);
      docs.set(record.role, record);
    },
    async create(docId, record) {
      // Mirrors Firestore's `create`: refuses rather than replaces. The real
      // store maps ALREADY_EXISTS onto a TestUserGuardError; the fake throws so
      // a test can prove the stored password survived the collision.
      log.push(`create:${docId}`);
      if (docs.has(docId)) throw new Error(`ALREADY_EXISTS ${docId}`);
      docs.set(docId, record);
    },
    async list() {
      // Mirrors the real store: the map KEY is the doc id, and it rides out on
      // every record. Returning bare records here would let a production change
      // that drops `docId` pass every test in this file.
      return [...docs.entries()].map(([docId, record]) => ({ ...record, docId }));
    },
  };
  return store;
}

function deps(over: {
  mint?: () => Promise<MlTestUser>;
  store?: ReturnType<typeof fakeStore>;
  me?: MlUser;
  deleteAll?: () => Promise<number>;
  roles?: readonly UsuarioTesteRole[];
  modo?: CriarUsuariosTesteDeps['modo'];
  revogarCredencial?: boolean;
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
      // Spread only when supplied, so the DEFAULTS are what the untouched
      // assertions below exercise — an explicit `undefined` would still be a
      // value the function has to interpret.
      ...(over.roles === undefined ? {} : { roles: over.roles }),
      ...(over.modo === undefined ? {} : { modo: over.modo }),
      ...(over.revogarCredencial === undefined
        ? {}
        : { revogarCredencial: over.revogarCredencial }),
    } satisfies CriarUsuariosTesteDeps,
  };
}

/** A stored record, so a test can prove an additional mint left it alone. */
function registro(over: Partial<UsuarioTesteMercadoLivre> = {}): UsuarioTesteMercadoLivre {
  return {
    role: USUARIO_TESTE_ROLE.comprador,
    id: 555,
    nickname: 'TEST-JA-EXISTE',
    password: 'ja-salva',
    site_id: 'MLB',
    site_status: 'active',
    email: null,
    createdAt: NOW - 1000,
    createdByUserId: 999,
    ...over,
  };
}

/**
 * The same record as it comes BACK from the store — with the doc id holding it.
 *
 * ⚠️ Deliberately a second helper rather than a `docId` on {@link registro}:
 * `registro()` feeds the WRITE side (`put`/`create`), and the stored schema is
 * `.passthrough()`, so a fixture carrying `docId` into a write would persist a
 * document's own id as one of its fields and no assertion here would notice.
 */
function registrado(
  docId: string,
  over: Partial<UsuarioTesteMercadoLivre> = {},
): UsuarioTesteRegistrado {
  return { ...registro(over), docId };
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
    // The stored record, whole — plus the doc id it was read from. Spelled out
    // rather than matched loosely: dropping a field from a reused record is the
    // failure this assertion is here to catch, and `password` is unrecoverable.
    expect(result.usuarios[0]).toEqual({ ...existing, docId: USUARIO_TESTE_ROLE.vendedor });
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

describe('criarUsuariosTeste — additional mint (modo: novo)', () => {
  it('mints ONE fresh buyer beside the stored one, never over it', async () => {
    // #1087: Mercado Pago stopped accepting purchases from the stored buyer, so
    // it has to be replaced — but the seller still works and its slot must not
    // be spent again, and the old buyer's password is unrecoverable.
    const store = fakeStore([registro()]);
    const { deps: d, criarUsuarioTeste } = deps({
      store,
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
    });

    const result = await criarUsuariosTeste(d);

    expect(criarUsuarioTeste).toHaveBeenCalledTimes(1);
    expect(result.criados).toEqual([USUARIO_TESTE_ROLE.comprador]);
    expect(result.reaproveitados).toEqual([]);
    expect(result.usuarios).toHaveLength(1);
    // The stored record is byte-identical — this is the property the whole doc-id
    // scheme exists for.
    expect(store.docs.get(USUARIO_TESTE_ROLE.comprador)).toEqual(registro());
    expect(store.docs.get(docIdAdicional(USUARIO_TESTE_ROLE.comprador, 1001))?.nickname).toBe(
      'TEST0001',
    );
  });

  it('RULE 2 is SUSPENDED — a stored record is not reused', async () => {
    // The pair bootstrap reuses so a retry costs zero slots. "Give me a new
    // buyer" is the opposite request, and answering it with the old one would
    // silently do nothing on the one screen that cannot show you it did nothing.
    const { deps: d, criarUsuarioTeste } = deps({
      store: fakeStore([registro()]),
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
    });

    expect((await criarUsuariosTeste(d)).usuarios[0]?.nickname).not.toBe('TEST-JA-EXISTE');
    expect(criarUsuarioTeste).toHaveBeenCalledTimes(1);
  });

  it('RULES 1 + 3 still hold: create lands before the wipe, and it is last', async () => {
    const { deps: d, store } = deps({
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
    });

    await criarUsuariosTeste(d);

    expect(store.log).toEqual(['mint:1', 'create:comprador-1001', 'deleteAll']);
  });

  it('RULES 1 + 3: a failed mint stores nothing and keeps the credential', async () => {
    const {
      deps: d,
      store,
      deleteAll,
    } = deps({
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
      mint: async () => {
        throw new Error('ML: max test users reached');
      },
    });

    await expect(criarUsuariosTeste(d)).rejects.toThrow('max test users');

    expect(store.docs.size).toBe(0);
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('writes through create, so a colliding id FAILS instead of overwriting', async () => {
    // The doc id comes from ML's response and cannot collide in practice; this
    // pins what happens if it ever did, because "overwrite" would mean losing a
    // password nothing can reissue.
    const store = fakeStore();
    const existente = registro({ id: 1001, nickname: 'NAO-PERCA-ISTO', password: 'preciosa' });
    await store.create(docIdAdicional(USUARIO_TESTE_ROLE.comprador, 1001), existente);
    const { deps: d, deleteAll } = deps({
      store,
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
    });

    await expect(criarUsuariosTeste(d)).rejects.toThrow('ALREADY_EXISTS');

    expect(store.docs.get(docIdAdicional(USUARIO_TESTE_ROLE.comprador, 1001))).toEqual(existente);
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('derives the doc id from the ML user id, never the bare role', () => {
    expect(docIdAdicional(USUARIO_TESTE_ROLE.comprador, 120506781)).toBe('comprador-120506781');
    expect(docIdAdicional(USUARIO_TESTE_ROLE.vendedor, 7)).toBe('vendedor-7');
  });
});

describe('criarUsuariosTeste — reuse spans BOTH doc-id schemes', () => {
  it('⭐ a pair run after a standalone buyer REUSES it instead of minting a second', async () => {
    // The bug this replaced: reuse was `store.get(role)` — the bare role doc id
    // — so an account written by an additional mint at `${role}-${mlUserId}` was
    // invisible and the pair bootstrap spent a permanent slot on a buyer the
    // operator already had. Reachable from the panel: with one buyer and no
    // seller the pair button is (correctly) enabled.
    const store = fakeStore();
    const avulso = deps({ store, roles: [USUARIO_TESTE_ROLE.comprador], modo: 'novo' });
    await criarUsuariosTeste(avulso.deps);

    const par = deps({ store });
    const result = await criarUsuariosTeste(par.deps);

    // ONE mint on the pair run — the seller — and the buyer came off disk.
    expect(par.criarUsuarioTeste).toHaveBeenCalledTimes(1);
    expect(result.criados).toEqual([USUARIO_TESTE_ROLE.vendedor]);
    expect(result.reaproveitados).toEqual([USUARIO_TESTE_ROLE.comprador]);
    expect([...store.docs.keys()].sort()).toEqual(['comprador-1001', 'vendedor']);
  });

  it('reuses the NEWEST record when several share a role', async () => {
    const store = fakeStore();
    await store.create('comprador-1', registro({ id: 1, nickname: 'ANTIGO', createdAt: 100 }));
    await store.create('comprador-2', registro({ id: 2, nickname: 'NOVO', createdAt: 900 }));
    const { deps: d } = deps({ store, roles: [USUARIO_TESTE_ROLE.comprador] });

    expect((await criarUsuariosTeste(d)).usuarios[0]?.nickname).toBe('NOVO');
  });

  it('reutilizavel matches the role FIELD, not the doc id', () => {
    const rec = registrado('comprador-7', { id: 7 });
    expect(reutilizavel([rec], USUARIO_TESTE_ROLE.comprador)).toBe(rec);
    expect(reutilizavel([rec], USUARIO_TESTE_ROLE.vendedor)).toBeNull();
    expect(reutilizavel([], USUARIO_TESTE_ROLE.comprador)).toBeNull();
  });
});

describe('criarUsuariosTeste — the revocation opt-out', () => {
  it('skips the wipe entirely when revogarCredencial is false', async () => {
    const {
      deps: d,
      store,
      deleteAll,
    } = deps({
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
      revogarCredencial: false,
    });

    const result = await criarUsuariosTeste(d);

    expect(deleteAll).not.toHaveBeenCalled();
    expect(result.credencialRevogada).toBe(false);
    expect(result.credenciaisRemovidas).toBe(0);
    // ⚠️ Opting out of rule 3 must not weaken rule 1: the record is still on
    // disk before the function returns.
    expect(store.log).toEqual(['mint:1', 'create:comprador-1001']);
    expect(store.docs.size).toBe(1);
  });

  it('⚠️ an ABSENT revogarCredencial REVOKES — a missing field may not disable it', async () => {
    // #1059's shape: a guard that a value nobody sent can switch off. Here it
    // would leave a real seller account wired to the ERP, silently.
    const { deps: d, deleteAll } = deps({});

    const result = await criarUsuariosTeste(d);

    expect(deleteAll).toHaveBeenCalledTimes(1);
    expect(result.credencialRevogada).toBe(true);
  });

  it('reports credencialRevogada even when there was nothing to delete', async () => {
    // `credenciaisRemovidas === 0` is ambiguous — it is also what an empty
    // subcollection returns — so the flag is what the UI has to read.
    const { deps: d } = deps({ deleteAll: async () => 0 });

    const result = await criarUsuariosTeste(d);

    expect(result.credenciaisRemovidas).toBe(0);
    expect(result.credencialRevogada).toBe(true);
  });
});

describe('criarUsuariosTeste — the ten-slot cap', () => {
  function dezRegistros(): UsuarioTesteMercadoLivre[] {
    return Array.from({ length: USUARIO_TESTE_LIMITE_POR_CONTA }, (_, i) =>
      registro({ id: 2000 + i, nickname: `TEST-${String(i)}` }),
    );
  }

  it('refuses at the limit, before minting anything or touching the credential', async () => {
    const store = fakeStore();
    for (const [i, r] of dezRegistros().entries()) await store.create(`extra-${String(i)}`, r);
    const {
      deps: d,
      criarUsuarioTeste,
      deleteAll,
    } = deps({
      store,
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
    });

    const err = await criarUsuariosTeste(d).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TestUserGuardError);
    expect((err as TestUserGuardError).code).toBe('ML_LIMITE_USUARIOS_TESTE');
    expect((err as TestUserGuardError).status).toBe(409);
    expect((err as TestUserGuardError).extra).toMatchObject({
      registrados: USUARIO_TESTE_LIMITE_POR_CONTA,
      limite: USUARIO_TESTE_LIMITE_POR_CONTA,
    });
    expect(criarUsuarioTeste).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('guards the PAIR bootstrap too, not only the additional mint', async () => {
    const store = fakeStore();
    for (const [i, r] of dezRegistros().entries()) await store.create(`extra-${String(i)}`, r);
    const { deps: d, criarUsuarioTeste } = deps({ store });

    await expect(criarUsuariosTeste(d)).rejects.toBeInstanceOf(TestUserGuardError);
    expect(criarUsuarioTeste).not.toHaveBeenCalled();
  });

  it('⭐ the PAIR path lands on TEN, never eleven, at nine stored records', async () => {
    // The guard used to run once before a loop that mints one per role, so nine
    // stored records passed it and the pair bootstrap minted two — eleven. Two
    // things now stop that: the buyer is REUSED (it is one of the nine), and the
    // bound is re-checked per mint rather than per call.
    const store = fakeStore();
    const nove = dezRegistros().slice(0, USUARIO_TESTE_LIMITE_POR_CONTA - 1);
    for (const [i, r] of nove.entries()) await store.create(`extra-${String(i)}`, r);
    const { deps: d, criarUsuarioTeste } = deps({ store });

    const result = await criarUsuariosTeste(d);

    expect(criarUsuarioTeste).toHaveBeenCalledTimes(1);
    expect(result.criados).toEqual([USUARIO_TESTE_ROLE.vendedor]);
    expect(store.docs.size).toBe(USUARIO_TESTE_LIMITE_POR_CONTA);
  });

  it('⭐ the bound is RE-CHECKED per mint: the 10th is allowed, the 11th refused', async () => {
    // Directly on the in-loop check — a multi-mint run at nine stored records
    // must spend the last slot and then refuse, not sail through on one
    // up-front comparison.
    const store = fakeStore();
    const nove = dezRegistros().slice(0, USUARIO_TESTE_LIMITE_POR_CONTA - 1);
    for (const [i, r] of nove.entries()) await store.create(`extra-${String(i)}`, r);
    const {
      deps: d,
      criarUsuarioTeste,
      deleteAll,
    } = deps({
      store,
      roles: [USUARIO_TESTE_ROLE.comprador, USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
    });

    const err = await criarUsuariosTeste(d).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TestUserGuardError);
    expect((err as TestUserGuardError).code).toBe('ML_LIMITE_USUARIOS_TESTE');
    expect((err as TestUserGuardError).extra).toMatchObject({
      registrados: USUARIO_TESTE_LIMITE_POR_CONTA,
    });
    expect(criarUsuarioTeste).toHaveBeenCalledTimes(1);
    // Rule 1 still held for the one that DID mint; rule 3 kept the credential.
    expect(store.docs.size).toBe(USUARIO_TESTE_LIMITE_POR_CONTA);
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('a run that only REUSES is not refused at the cap — it spends nothing', async () => {
    // The cap exists to stop an eleventh slot being spent, not to block a
    // zero-cost re-run.
    const store = fakeStore();
    for (const [i, r] of dezRegistros().entries()) await store.create(`extra-${String(i)}`, r);
    await store.put(registro({ role: USUARIO_TESTE_ROLE.vendedor, id: 40 }));
    const { deps: d, criarUsuarioTeste } = deps({ store });

    const result = await criarUsuariosTeste(d);

    expect(criarUsuarioTeste).not.toHaveBeenCalled();
    expect(result.criados).toEqual([]);
    expect(result.reaproveitados).toEqual(ROLES_A_CRIAR);
  });

  it('allows the mint one below the limit', async () => {
    const store = fakeStore();
    const noveRegistros = dezRegistros().slice(0, USUARIO_TESTE_LIMITE_POR_CONTA - 1);
    for (const [i, r] of noveRegistros.entries()) await store.create(`extra-${String(i)}`, r);
    const { deps: d, criarUsuarioTeste } = deps({
      store,
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
    });

    await criarUsuariosTeste(d);

    expect(criarUsuarioTeste).toHaveBeenCalledTimes(1);
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

/**
 * The doc id the panel needs — and the one place it must NOT reach.
 *
 * ⭐ Every buyer record carries `role: 'comprador'`, whether it sits at the pair
 * bootstrap's bare `comprador` document or at an additional mint's
 * `comprador-<mlUserId>`. So the records alone cannot distinguish "the new buyer
 * landed beside the old one" from "it landed on top of it" from "it was never
 * created" — which is exactly the question the operator asks after clicking
 * "Novo comprador". The doc id is the only field that answers it, so it travels
 * out with every record.
 */
describe('criarUsuariosTeste — the doc id each account is stored under', () => {
  it('reports the id an additional mint just wrote', async () => {
    const store = fakeStore([registro()]);
    const { deps: d } = deps({
      store,
      roles: [USUARIO_TESTE_ROLE.comprador],
      modo: 'novo',
    });

    const result = await criarUsuariosTeste(d);

    expect(result.usuarios[0]?.docId).toBe('comprador-1001');
    // …beside the pair bootstrap's document, which is untouched.
    expect([...store.docs.keys()].sort()).toEqual(['comprador', 'comprador-1001']);
  });

  it('reports a REUSED record’s real doc id, not one recomputed from the role', async () => {
    // A reused account is whatever `list()` handed back, and it may live at
    // either shape. Deriving the id from `role` would label every additional
    // mint `comprador` — the panel would then show two rows claiming the same
    // document, which is the impossible state it exists to rule out.
    const store = fakeStore();
    await store.create('comprador-77', registro({ id: 77 }));
    const { deps: d } = deps({ store, roles: [USUARIO_TESTE_ROLE.comprador] });

    const result = await criarUsuariosTeste(d);

    expect(result.reaproveitados).toEqual([USUARIO_TESTE_ROLE.comprador]);
    expect(result.usuarios[0]?.docId).toBe('comprador-77');
  });

  it('⚠️ never lets a docId reach a WRITE — the stored schema is passthrough', async () => {
    // `usuarioTesteMercadoLivreSchema` is `.passthrough()`, so a `docId` that
    // reached `put`/`create` would be persisted as a record FIELD and nothing
    // anywhere would complain. This run reuses a LISTED record (which carries
    // one) and mints another, so both paths are exercised in one go.
    const store = fakeStore();
    await store.create('comprador-77', registro({ id: 77 }));
    const { deps: d } = deps({ store });

    await criarUsuariosTeste(d);

    expect([...store.docs.keys()].sort()).toEqual(['comprador-77', 'vendedor']);
    for (const [docId, guardado] of store.docs) {
      expect({ docId, temDocId: 'docId' in guardado }).toEqual({ docId, temDocId: false });
    }
  });
});
