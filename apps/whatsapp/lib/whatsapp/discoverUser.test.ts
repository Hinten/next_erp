import { beforeEach, describe, expect, it, vi } from 'vitest';
import { externalId } from './ids';

/**
 * In-memory Firestore fakes for the two collections `discoverUser` drives. Each
 * `.ref().where(...).limit().get()` chain evaluates real `==`/`in` filters over a
 * mutable backing array, and `docRef().create()` throws a gRPC-style
 * ALREADY_EXISTS (code 6) on a duplicate id — so idempotency + the race retry
 * exercise the real code paths. `parse`/`parseRead` are thin (default-fill for
 * `parse`, identity for `parseRead`) so we assert on the exact stored shapes.
 */
interface Doc {
  id: string;
  data: Record<string, unknown>;
}

function makeQuery(docs: Doc[]) {
  const filters: Array<{ field: string; op: string; val: unknown }> = [];
  const q = {
    where(field: string, op: string, val: unknown) {
      filters.push({ field, op, val });
      return q;
    },
    limit() {
      return q;
    },
    async get() {
      let res = docs.slice();
      for (const f of filters) {
        res = res.filter((d) => {
          const v = d.data[f.field];
          if (f.op === '==') return v === f.val;
          if (f.op === 'in') return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
          return true;
        });
      }
      return {
        empty: res.length === 0,
        docs: res.map((d) => ({ id: d.id, data: () => d.data })),
      };
    },
  };
  return q;
}

function fakeCollection(prefix: string, defaults: Record<string, unknown>) {
  const docs: Doc[] = [];
  let autoSeq = 0;
  return {
    _docs: docs,
    docPath: (_ctx: unknown, id: string) => `${prefix}/${id}`,
    parseRead: (data: unknown) => data,
    parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
    ref: () => makeQuery(docs),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({
      async get() {
        const found = docs.find((d) => d.id === id);
        return { exists: Boolean(found), data: () => found?.data };
      },
      async create(data: Record<string, unknown>) {
        if (docs.find((d) => d.id === id)) {
          const e = new Error('ALREADY_EXISTS') as Error & { code?: number };
          e.code = 6;
          throw e;
        }
        docs.push({ id, data });
      },
    }),
    merge: vi.fn(
      async (_db: unknown, _ctx: unknown, id: string, patch: Record<string, unknown>) => {
        const found = docs.find((d) => d.id === id);
        if (found) Object.assign(found.data, patch);
      },
    ),
    add: vi.fn(async (_db: unknown, _ctx: unknown, data: Record<string, unknown>) => {
      const id = `auto_${autoSeq++}`;
      docs.push({ id, data });
      return { id };
    }),
  };
}

const h = vi.hoisted(() => ({
  usuario: null as unknown as ReturnType<typeof makeUsuario>,
  cliente: null as unknown as ReturnType<typeof makeCliente>,
  conversa: null as unknown as { merge: ReturnType<typeof vi.fn> },
}));

// Local factory refs (typed) so hoisted `h` gets concrete shapes.
function makeUsuario() {
  return fakeCollection('usuarios', { nome: 'Anônimo', email: null, externalId: null });
}
function makeCliente() {
  return fakeCollection('clientes', { nome: null, telefone: null, userCliente: null });
}

vi.mock('@delfrance/data/admin/collections', () => ({
  get usuarioCollection() {
    return h.usuario;
  },
  get clienteCollection() {
    return h.cliente;
  },
  get conversaCollection() {
    return h.conversa;
  },
}));

const { discoverUserByPhoneNumber, fixConversaAnonima, usuarioOuterRef } =
  await import('./discoverUser');

const FROM = '5511999998888';
const DB = {} as never;

beforeEach(() => {
  h.usuario = makeUsuario();
  h.cliente = makeCliente();
  h.conversa = { merge: vi.fn(async () => undefined) };
});

describe('discoverUserByPhoneNumber — (a) externalId hit', () => {
  it('renames a placeholder nome to the profile name and returns the fresh name', async () => {
    const extId = externalId('whatsapp', FROM);
    h.usuario._docs.push({ id: 'u1', data: { nome: 'Anônimo', externalId: extId } });

    const res = await discoverUserByPhoneNumber(DB, FROM, 'Maria Silva');

    expect(res.id).toBe('u1');
    expect(res.usuario.nome).toBe('Maria Silva');
    expect(h.usuario.merge).toHaveBeenCalledWith(DB, {}, 'u1', { nome: 'Maria Silva' });
    // no cliente created on the hit path
    expect(h.cliente.add).not.toHaveBeenCalled();
  });

  it('does NOT rename when the stored nome is already a real name', async () => {
    const extId = externalId('whatsapp', FROM);
    h.usuario._docs.push({ id: 'u1', data: { nome: 'João', externalId: extId } });

    const res = await discoverUserByPhoneNumber(DB, FROM, 'Other Name');

    expect(res.usuario.nome).toBe('João');
    expect(h.usuario.merge).not.toHaveBeenCalled();
  });

  it('does not rename when no profile name is supplied', async () => {
    const extId = externalId('whatsapp', FROM);
    h.usuario._docs.push({ id: 'u1', data: { nome: 'Anônimo', externalId: extId } });

    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(res.usuario.nome).toBe('Anônimo');
    expect(h.usuario.merge).not.toHaveBeenCalled();
  });
});

describe('discoverUserByPhoneNumber — (b/d) cliente phone match', () => {
  it('matches a cliente stored under the normalized shape and returns its linked user', async () => {
    // Stored under the raw 11-digit BR shape the Flutter app writes.
    h.cliente._docs.push({
      id: 'c1',
      data: { nome: 'Cliente Um', telefone: '11999998888', userCliente: 'documents/usuarios/uX' },
    });
    h.usuario._docs.push({ id: 'uX', data: { nome: 'Cliente Um', externalId: 'e' } });

    const res = await discoverUserByPhoneNumber(DB, FROM, 'Maria');

    expect(res.id).toBe('uX');
    expect(res.usuario.nome).toBe('Cliente Um');
    // returned an existing linked user — created nothing
    expect(h.cliente.add).not.toHaveBeenCalled();
    expect(h.cliente.merge).not.toHaveBeenCalled();
  });

  it('matches via the exact wa_id shape too', async () => {
    h.cliente._docs.push({
      id: 'c1',
      data: { nome: 'X', telefone: FROM, userCliente: 'documents/usuarios/uX' },
    });
    h.usuario._docs.push({ id: 'uX', data: { nome: 'X', externalId: 'e' } });

    const res = await discoverUserByPhoneNumber(DB, FROM);
    expect(res.id).toBe('uX');
  });

  it('tie-breaks multiple clientes by doc id asc, returning the first with a userCliente', async () => {
    h.cliente._docs.push({
      id: 'c2',
      data: { nome: 'Segundo', telefone: FROM, userCliente: 'documents/usuarios/u2' },
    });
    h.cliente._docs.push({
      id: 'c1',
      data: { nome: 'Primeiro', telefone: FROM, userCliente: 'documents/usuarios/u1' },
    });
    h.usuario._docs.push({ id: 'u1', data: { nome: 'Primeiro', externalId: 'e1' } });
    h.usuario._docs.push({ id: 'u2', data: { nome: 'Segundo', externalId: 'e2' } });

    const res = await discoverUserByPhoneNumber(DB, FROM);
    // c1 sorts before c2 → its userCliente u1 wins
    expect(res.id).toBe('u1');
  });

  it('when no cliente has a userCliente, mints a sem-auth user and links the first', async () => {
    h.cliente._docs.push({ id: 'c2', data: { nome: 'B', telefone: FROM, userCliente: null } });
    h.cliente._docs.push({ id: 'c1', data: { nome: 'A', telefone: FROM, userCliente: null } });

    const res = await discoverUserByPhoneNumber(DB, FROM);

    const extId = externalId('whatsapp', FROM);
    expect(res.id).toBe(extId);
    // used the first cliente's (c1) nome for the new user
    expect(res.usuario.nome).toBe('A');
    // linked onto c1 (lowest id), not c2
    expect(h.cliente.merge).toHaveBeenCalledWith(DB, {}, 'c1', {
      userCliente: usuarioOuterRef(extId),
    });
  });
});

describe('discoverUserByPhoneNumber — (c) create path', () => {
  it('creates a sem-auth usuario at the deterministic id + a paired cliente', async () => {
    const res = await discoverUserByPhoneNumber(DB, FROM, 'Nova Cliente');

    const extId = externalId('whatsapp', FROM);
    expect(res.id).toBe(extId);
    expect(res.usuario).toMatchObject({ nome: 'Nova Cliente', email: null, externalId: extId });
    // usuario persisted at the deterministic doc id
    expect(h.usuario._docs.find((d) => d.id === extId)).toBeTruthy();
    // paired cliente carries the name, phone, and the usuario outer ref
    expect(h.cliente.add).toHaveBeenCalledWith(
      DB,
      {},
      {
        nome: 'Nova Cliente',
        telefone: FROM,
        userCliente: usuarioOuterRef(extId),
      },
    );
  });

  it('falls back to Anônimo and a null cliente nome when no profile name is given', async () => {
    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(res.usuario.nome).toBe('Anônimo');
    expect(h.cliente.add).toHaveBeenCalledWith(
      DB,
      {},
      {
        nome: null,
        telefone: FROM,
        userCliente: usuarioOuterRef(externalId('whatsapp', FROM)),
      },
    );
  });

  it('is idempotent across a re-run: the second call hits (a), creating no second cliente', async () => {
    await discoverUserByPhoneNumber(DB, FROM, 'Repetida');
    expect(h.cliente.add).toHaveBeenCalledTimes(1);
    expect(h.usuario._docs).toHaveLength(1);

    const res2 = await discoverUserByPhoneNumber(DB, FROM, 'Repetida');

    // still exactly one usuario + one cliente
    expect(h.usuario._docs).toHaveLength(1);
    expect(h.cliente.add).toHaveBeenCalledTimes(1);
    expect(res2.id).toBe(externalId('whatsapp', FROM));
  });
});

describe('fixConversaAnonima', () => {
  it('renames an anonymous conversa and its paired cliente to the user name', async () => {
    const extId = externalId('whatsapp', FROM);
    h.cliente._docs.push({
      id: 'c1',
      data: { nome: 'anônimo', telefone: FROM, userCliente: usuarioOuterRef(extId) },
    });

    await fixConversaAnonima(
      DB,
      'conv1',
      { nome: 'Anônimo' },
      { id: extId, usuario: { nome: 'Ana' } as never },
    );

    expect(h.conversa.merge).toHaveBeenCalledWith(DB, {}, 'conv1', { nome: 'Ana' });
    expect(h.cliente.merge).toHaveBeenCalledWith(DB, {}, 'c1', { nome: 'Ana' });
  });

  it('is a no-op when the conversa already has a real name', async () => {
    await fixConversaAnonima(
      DB,
      'conv1',
      { nome: 'Já tem nome' },
      { id: 'u1', usuario: { nome: 'Ana' } as never },
    );
    expect(h.conversa.merge).not.toHaveBeenCalled();
    expect(h.cliente.merge).not.toHaveBeenCalled();
  });

  it('renames the conversa but leaves a cliente that already has a real name', async () => {
    const extId = externalId('whatsapp', FROM);
    h.cliente._docs.push({
      id: 'c1',
      data: { nome: 'Nome Real', telefone: FROM, userCliente: usuarioOuterRef(extId) },
    });

    await fixConversaAnonima(
      DB,
      'conv1',
      { nome: '' },
      { id: extId, usuario: { nome: 'Ana' } as never },
    );

    expect(h.conversa.merge).toHaveBeenCalledWith(DB, {}, 'conv1', { nome: 'Ana' });
    expect(h.cliente.merge).not.toHaveBeenCalled();
  });
});

describe('discoverUserByPhoneNumber — the resolved clienteId (#1159)', () => {
  // The cliente was always resolved in here; it just was not returned, which is
  // why a WhatsApp conversa carried no `clienteOuterRef` and the inbox Cliente
  // filter could not match it. One case per branch, so a branch that quietly
  // stops resolving cannot pass.

  it('(a) externalId hit — reverse-looks-up the cliente that claims the usuario', async () => {
    const extId = externalId('whatsapp', FROM);
    h.usuario._docs.push({ id: 'u1', data: { nome: 'João', externalId: extId } });
    h.cliente._docs.push({
      id: 'c9',
      data: { nome: 'João', telefone: FROM, userCliente: 'documents/usuarios/u1' },
    });

    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(res.id).toBe('u1');
    expect(res.clienteId).toBe('c9');
  });

  it('(a) finds the cliente stored under the BARE `usuarios/<id>` shape too', async () => {
    // ⚠️ The single case that fails if the lookup stops querying both shapes.
    // `usuarioOuterRef()` writes `documents/usuarios/<id>`, but the migrated
    // corpus carries the bare form and Firestore cannot normalize a stored
    // value inside a `where` — so one shape silently misses half the rows.
    const extId = externalId('whatsapp', FROM);
    h.usuario._docs.push({ id: 'u1', data: { nome: 'João', externalId: extId } });
    h.cliente._docs.push({
      id: 'c-legado',
      data: { nome: 'João', telefone: FROM, userCliente: 'usuarios/u1' },
    });

    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(res.clienteId).toBe('c-legado');
  });

  it('(a) REFUSES to pick when two clientes claim the same usuario', async () => {
    // Two strong owners of one identity is a data defect. Picking the arbitrary
    // first would hide it and point the conversa at a coin flip, so this
    // resolves to unknown and warns — the same refusal `claimCliente` makes for
    // a duplicated ML id (#1067).
    const extId = externalId('whatsapp', FROM);
    h.usuario._docs.push({ id: 'u1', data: { nome: 'João', externalId: extId } });
    h.cliente._docs.push({
      id: 'c1',
      data: { nome: 'A', telefone: FROM, userCliente: 'documents/usuarios/u1' },
    });
    h.cliente._docs.push({
      id: 'c2',
      data: { nome: 'B', telefone: FROM, userCliente: 'usuarios/u1' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(res.id).toBe('u1');
    expect(res.clienteId).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('(a) resolves null — not a guess — when nothing points at the usuario', async () => {
    const extId = externalId('whatsapp', FROM);
    h.usuario._docs.push({ id: 'u1', data: { nome: 'João', externalId: extId } });
    h.cliente._docs.push({ id: 'c-outro', data: { nome: 'Outro', userCliente: null } });

    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(res.clienteId).toBeNull();
  });

  it('(c) create path — returns the cliente it just minted', async () => {
    const res = await discoverUserByPhoneNumber(DB, FROM, 'Nova Cliente');

    expect(h.cliente.add).toHaveBeenCalledTimes(1);
    expect(res.clienteId).not.toBeNull();
    expect(h.cliente._docs.find((d) => d.id === res.clienteId)).toBeDefined();
  });

  it('(c) the LOSER of a concurrent first call reads the winner\u2019s cliente', async () => {
    // The loser did not mint the cliente, so it must not conclude there is
    // none — that would write a conversa with no cliente link for a contact
    // that has one.
    const extId = externalId('whatsapp', FROM);
    // Simulate the winner having already landed both docs.
    h.usuario._docs.push({ id: extId, data: { nome: 'Vencedora', externalId: extId } });
    h.cliente._docs.push({
      id: 'c-vencedora',
      data: { nome: 'Vencedora', telefone: '999', userCliente: `documents/usuarios/${extId}` },
    });

    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(h.cliente.add).not.toHaveBeenCalled();
    expect(res.clienteId).toBe('c-vencedora');
  });

  it('(d) linked cliente — returns it without a second lookup', async () => {
    h.cliente._docs.push({
      id: 'c1',
      data: { nome: 'Cliente Um', telefone: FROM, userCliente: 'documents/usuarios/uX' },
    });
    h.usuario._docs.push({ id: 'uX', data: { nome: 'Cliente Um', externalId: 'e' } });

    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(res.id).toBe('uX');
    expect(res.clienteId).toBe('c1');
  });

  it('(d) create+link fallback — returns the cliente it linked onto', async () => {
    // A cliente matched by phone but carries no live userCliente, so a sem-auth
    // usuario is minted and linked onto it. The cliente is that one, not a new.
    h.cliente._docs.push({
      id: 'c-sem-user',
      data: { nome: 'Sem User', telefone: FROM, userCliente: null },
    });

    const res = await discoverUserByPhoneNumber(DB, FROM);

    expect(h.cliente.add).not.toHaveBeenCalled();
    expect(res.clienteId).toBe('c-sem-user');
  });
});
