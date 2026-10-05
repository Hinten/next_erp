import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  INTEGRACAO_TIPO,
  ORIGEM_CONVERSA,
  TIPO_CLIENTE,
  whatsappVinculoPrevisaoSchema,
} from '@delfrance/schemas';
import { conversaWhatsappKey, identidadeWhatsappId } from './contatos';

const h = vi.hoisted(() => ({ db: null as unknown, verifyToken: vi.fn(), replay: vi.fn() }));
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => h.db,
  getAdminAuth: () => ({ verifyIdToken: h.verifyToken }),
}));
// Only the Cloud Tasks dispatch is stubbed. The HTTP permission checks, schema,
// projections, binding transaction and canonical conversation reservation run real.
vi.mock('@/lib/whatsapp/notificacao', () => ({ solicitarReplayVinculo: h.replay }));
const { GET: list } = await import('@/app/api/whatsapp/vinculos/route');
const { GET: detail, POST: confirm } = await import('@/app/api/whatsapp/vinculos/[id]/route');
const { GET: preview } = await import('@/app/api/whatsapp/vinculos/[id]/previsao/route');
const { GET: alias } = await import('@/app/api/whatsapp/conversas/[id]/alias/route');

type Data = Record<string, unknown>;
type Snapshot = { id: string; exists: boolean; data: () => Data | undefined };
class FakeDb {
  readonly cols = new Map<string, Map<string, Data>>();
  reads = 0;
  collection(path: string) {
    const col = this.docs(path);
    const snap = (id: string): Snapshot => ({ id, exists: col.has(id), data: () => col.get(id) });
    const doc = (id: string) => ({
      id,
      path: path + '/' + id,
      get: async () => {
        this.reads++;
        return snap(id);
      },
      set: (data: Data, merge = false) =>
        col.set(id, merge ? { ...col.get(id), ...data } : { ...data }),
      exists: () => col.has(id),
    });
    const query = (
      filters: Array<[string, string, unknown]> = [],
      orders: Array<[string, string]> = [],
      limit = Infinity,
      cursor: Snapshot | null = null,
    ) => ({
      where: (field: string, op: string, value: unknown) =>
        query([...filters, [field, op, value]], orders, limit, cursor),
      orderBy: (field: string, dir = 'asc') =>
        query(filters, [...orders, [field, dir]], limit, cursor),
      limit: (n: number) => query(filters, orders, n, cursor),
      startAfter: (last: Snapshot) => query(filters, orders, limit, last),
      get: async () => {
        this.reads++;
        let rows = [...col].filter(([, data]) =>
          filters.every(([field, op, value]) =>
            op === 'in'
              ? Array.isArray(value) && value.includes(data[field])
              : op === '==' && data[field] === value,
          ),
        );
        rows.sort(([idA, a], [idB, b]) => {
          for (const [field, dir] of orders) {
            const left = field === '__name__' ? idA : a[field];
            const right = field === '__name__' ? idB : b[field];
            const cmp =
              typeof left === 'number' && typeof right === 'number'
                ? left - right
                : String(left).localeCompare(String(right));
            if (cmp) return dir === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
        if (cursor) rows = rows.slice(rows.findIndex(([id]) => id === cursor.id) + 1);
        const docs = rows.slice(0, limit).map(([id]) => snap(id));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    });
    return { ...query(), doc };
  }
  docs(path: string): Map<string, Data> {
    let col = this.cols.get(path);
    if (!col) {
      col = new Map();
      this.cols.set(path, col);
    }
    return col;
  }
  seed(path: string, id: string, data: Data) {
    this.docs(path).set(id, data);
  }
  async runTransaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
    type Ref = ReturnType<ReturnType<FakeDb['collection']>['doc']>;
    const writes: Array<{ ref: Ref; data: Data; create: boolean; merge: boolean }> = [];
    const result = await callback({
      get: (ref: { get: () => Promise<unknown> }) => {
        if (writes.length)
          throw new Error('Firestore transactions require all reads before writes');
        return ref.get();
      },
      create: (ref: Ref, data: Data) => writes.push({ ref, data, create: true, merge: false }),
      set: (ref: Ref, data: Data, options?: { merge?: boolean }) =>
        writes.push({ ref, data, create: false, merge: options?.merge ?? false }),
      update: (ref: Ref, data: Data) => writes.push({ ref, data, create: false, merge: true }),
    });
    for (const write of writes)
      if (write.create && write.ref.exists()) throw new Error('create precondition failed');
    for (const write of writes) write.ref.set(write.data, write.merge);
    return result;
  }
}
const ALL = PERM.chat.read | PERM.chat.write | PERM.cliente.read | PERM.cliente.write;
const BIND = {
  requestId: 'request-1',
  revision: 0,
  choice: { kind: 'existing', clienteId: 'cliente-1' },
};
const CREATE = {
  requestId: 'request-create',
  revision: 0,
  choice: {
    kind: 'create',
    cliente: {
      nome: 'Cliente confirmado',
      tipo: TIPO_CLIENTE.estrangeiro,
      idEstrangeiro: 'FOREIGN-1',
      telefone: '14155552671',
    },
  },
};
const PHONE = '5511999999999';
const context = (id = 'pending-1') => ({ params: Promise.resolve({ id }) });
const request = (suffix = '', body?: unknown, authenticated = true) =>
  new Request('http://localhost/api/whatsapp/vinculos' + suffix, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(authenticated ? { authorization: 'Bearer test-token' } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
let db: FakeDb;
function seedPending(id = 'pending-1', extra: Data = {}) {
  db.seed('whatsappVinculos', id, {
    id,
    revision: 0,
    integracaoId: 'conta-1',
    integracaoNome: 'WhatsApp',
    nome: 'Contato',
    telefone: PHONE,
    bsuid: null,
    portfolioId: null,
    motivo: 'Confirme o cliente',
    ultimaMensagemEm: 1700000000000,
    quantidadeMensagens: 1,
    estado: 'aguardando',
    clienteId: null,
    conversaId: null,
    requestId: null,
    ...extra,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db = db;
  h.verifyToken.mockResolvedValue({ uid: 'operator-1', permissions: ALL.toString() });
  h.replay.mockResolvedValue(undefined);
  db.seed('integracao', 'conta-1', { tipo: 6, wa_id: 'phone-id', nome: 'WhatsApp' });
  db.seed('clientes', 'cliente-1', {
    nome: 'Cliente existente',
    telefone: PHONE,
    cpf_cnpj: null,
    email: 'cliente@example.com',
  });
  seedPending();
});

describe('WhatsApp identity endpoints — server permissions', () => {
  const endpoints = [
    ['list', PERM.chat.read | PERM.cliente.read, () => list(request())],
    ['detail', PERM.chat.read | PERM.cliente.read, () => detail(request('/pending-1'), context())],
    [
      'confirm',
      PERM.chat.read | PERM.chat.write | PERM.cliente.read,
      () => confirm(request('/pending-1', BIND), context()),
    ],
    [
      'preview',
      PERM.chat.read | PERM.cliente.read,
      () => preview(request('/pending-1/previsao?clienteId=cliente-1'), context()),
    ],
    ['alias', PERM.chat.read, () => alias(request('/old/alias'), context('old'))],
  ] as const;
  it.each(endpoints)(
    '%s denies a token missing a required permission before reading data',
    async (_name, required, run) => {
      for (const bit of [PERM.chat.read, PERM.chat.write, PERM.cliente.read]) {
        if ((required & bit) === 0n) continue;
        h.verifyToken.mockResolvedValue({
          uid: 'operator-1',
          permissions: (ALL & ~bit).toString(),
        });
        expect((await run()).status).toBe(403);
        expect(db.reads).toBe(0);
        expect(h.replay).not.toHaveBeenCalled();
      }
    },
  );
  it('denies an unauthenticated reader', async () => {
    expect((await list(request('', undefined, false))).status).toBe(401);
    expect(h.verifyToken).not.toHaveBeenCalled();
    expect(db.reads).toBe(0);
  });
  it('requires cliente.write when confirming a new cliente', async () => {
    h.verifyToken.mockResolvedValue({
      uid: 'operator-1',
      permissions: (ALL & ~PERM.cliente.write).toString(),
    });
    expect((await confirm(request('/pending-1', CREATE), context())).status).toBe(403);
    expect(db.docs('clientes').size).toBe(1);
    expect(db.docs('chat').size).toBe(0);
    expect(h.replay).not.toHaveBeenCalled();
  });
  it('allows linking an existing cliente without cliente.write', async () => {
    h.verifyToken.mockResolvedValue({
      uid: 'operator-1',
      permissions: (ALL & ~PERM.cliente.write).toString(),
    });
    expect((await confirm(request('/pending-1', BIND), context())).status).toBe(200);
    expect(db.docs('clientes').size).toBe(1);
    expect(h.replay).toHaveBeenCalledTimes(1);
  });
});

describe('GET pending contacts', () => {
  it.each(['0', '101', '1.5', 'abc'])('rejects invalid limit %s', async (limit) => {
    expect((await list(request('?limit=' + limit))).status).toBe(400);
    expect(db.reads).toBe(0);
  });
  it('filters active pendencies and pages stable ties without exposing private retained fields', async () => {
    seedPending('pending-2', { requestId: 'private-request', portfolioId: 'private-portfolio' });
    seedPending('resolved', { estado: 'resolvido' });
    seedPending('other-integration', { integracaoId: 'conta-2' });
    const first = await (await list(request('?integracaoId=conta-1&limit=1'))).json();
    expect(first.items.map((item: { id: string }) => item.id)).toEqual(['pending-1']);
    expect(first.nextCursor).toBe('pending-1');
    const second = await (
      await list(request('?integracaoId=conta-1&limit=1&cursor=' + first.nextCursor))
    ).json();
    expect(second.items.map((item: { id: string }) => item.id)).toEqual(['pending-2']);
    expect(second.nextCursor).toBeNull();
    expect(second.items[0]).not.toHaveProperty('requestId');
    expect(second.items[0]).not.toHaveProperty('portfolioId');
  });
  it('returns message projections and current-phone candidates with private provider payload omitted', async () => {
    db.seed('whatsappVinculos/pending-1/mensagens', 'message-1', {
      timestamp: 1700000000000,
      conteudo: 'Comprovante',
      arquivoId: 'file-1',
      anexoTipo: 'image',
      value: { privateProviderData: 'hidden' },
      sourceNotificationId: 'private-notification',
    });
    db.seed('arquivos', 'file-1', { url: 'https://example.com/image.png' });
    db.seed('clientes', 'historical-only', {
      nome: 'Histórico',
      telefone: '5511888888888',
      telefonesAdicionais: [PHONE],
    });
    const res = await detail(request('/pending-1'), context());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toEqual([
      {
        id: 'message-1',
        timestamp: 1700000000000,
        conteudo: 'Comprovante',
        anexoTipo: 'image',
        anexoUrl: 'https://example.com/image.png',
      },
    ]);
    expect(data.candidates.map((cliente: { id: string }) => cliente.id)).toEqual(['cliente-1']);
    expect(data.pendencia).not.toHaveProperty('requestId');
  });
  it('paginates retained messages at 50 and keeps a missing contact as 404', async () => {
    for (let i = 0; i < 51; i++)
      db.seed('whatsappVinculos/pending-1/mensagens', 'message-' + String(i).padStart(2, '0'), {
        timestamp: i,
        conteudo: String(i),
      });
    const first = await (await detail(request('/pending-1'), context())).json();
    expect(first.messages).toHaveLength(50);
    expect(first.nextCursor).toBe('message-49');
    const second = await (await detail(request('/pending-1?cursor=message-49'), context())).json();
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].id).toBe('message-50');
    expect(second.nextCursor).toBeNull();
    expect((await detail(request('/missing'), context('missing'))).status).toBe(404);
  });
});

describe('POST confirm identity binding', () => {
  it('binds identities to the existing cliente and preserves the migration-reserved chat id', async () => {
    db.seed('whatsappConversas', conversaWhatsappKey('conta-1', 'cliente-1'), {
      integracaoId: 'conta-1',
      clienteId: 'cliente-1',
      conversaId: 'historical-chat',
    });
    const res = await confirm(request('/pending-1', BIND), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clienteId: 'cliente-1',
      conversaId: 'historical-chat',
      replayPending: true,
    });
    expect(
      db.docs('whatsappIdentidades').get(identidadeWhatsappId('conta-1', 'telefone', PHONE)),
    ).toMatchObject({ clienteId: 'cliente-1', ativa: true });
    expect(db.docs('whatsappVinculos').get('pending-1')).toMatchObject({
      revision: 1,
      estado: 'recuperando',
      decididoPor: 'operator-1',
    });
    expect(db.docs('usuarios').size).toBe(0);
    expect(db.docs('chat').size).toBe(1);
  });
  it('retains the committed binding on dispatch failure, then retries replay without creating a second cliente or chat', async () => {
    h.replay.mockRejectedValueOnce(new Error('tasks unavailable'));
    await expect(confirm(request('/pending-1', CREATE), context())).rejects.toThrow(
      'tasks unavailable',
    );
    const winner = { ...db.docs('whatsappVinculos').get('pending-1')! };
    expect(winner.estado).toBe('recuperando');
    expect(db.docs('clientes').size).toBe(2);
    expect(db.docs('chat').size).toBe(1);
    const res = await confirm(request('/pending-1', CREATE), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clienteId: winner.clienteId,
      conversaId: winner.conversaId,
      replayPending: true,
    });
    expect(db.docs('clientes').size).toBe(2);
    expect(db.docs('chat').size).toBe(1);
    expect(db.docs('whatsappVinculos').get('pending-1')!.revision).toBe(1);
    expect(h.replay).toHaveBeenCalledTimes(2);
  });
  it('returns the completed decision without scheduling a completed replay again', async () => {
    await confirm(request('/pending-1', BIND), context());
    db.docs('whatsappVinculos').get('pending-1')!.estado = 'resolvido';
    h.replay.mockClear();
    const res = await confirm(request('/pending-1', BIND), context());
    expect((await res.json()).replayPending).toBe(false);
    expect(h.replay).not.toHaveBeenCalled();
  });
  it('returns the winner to a competing operator choosing a different cliente', async () => {
    await confirm(request('/pending-1', BIND), context());
    h.replay.mockClear();
    const res = await confirm(
      request('/pending-1', {
        ...BIND,
        requestId: 'request-2',
        choice: { kind: 'existing', clienteId: 'cliente-2' },
      }),
      context(),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'WA_VINCULO_CONFLITO',
      clienteId: 'cliente-1',
      conversaId: expect.any(String),
    });
    expect(db.docs('chat').size).toBe(1);
    expect(h.replay).not.toHaveBeenCalled();
  });
  it('rejects reuse of the same requestId with a different choice instead of reporting the old success', async () => {
    await confirm(request('/pending-1', BIND), context());
    h.replay.mockClear();
    const res = await confirm(
      request('/pending-1', { ...BIND, choice: { kind: 'existing', clienteId: 'cliente-2' } }),
      context(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WA_VINCULO_CONFLITO');
    expect(db.docs('chat').size).toBe(1);
    expect(h.replay).not.toHaveBeenCalled();
  });
  it('rejects a stale pending revision before claiming any identity', async () => {
    db.docs('whatsappVinculos').get('pending-1')!.revision = 1;
    const res = await confirm(request('/pending-1', BIND), context());
    expect(res.status).toBe(409);
    expect(db.docs('whatsappIdentidades').size).toBe(0);
    expect(db.docs('chat').size).toBe(0);
  });
  it('rejects an identity actively owned by a different cliente', async () => {
    db.seed('whatsappIdentidades', identidadeWhatsappId('conta-1', 'telefone', PHONE), {
      clienteId: 'other-client',
      ativa: true,
    });
    expect((await confirm(request('/pending-1', BIND), context())).status).toBe(409);
    expect(db.docs('chat').size).toBe(0);
    expect(db.docs('whatsappVinculos').get('pending-1')!.clienteId).toBeNull();
  });
  it('rejects create-new when its document already belongs to a cliente', async () => {
    db.seed('clientes', 'foreign-existing', { nome: 'Already exists', idEstrangeiro: 'FOREIGN-1' });
    const res = await confirm(request('/pending-1', CREATE), context());
    expect(res.status).toBe(409);
    expect((await res.json()).clienteId).toBe('foreign-existing');
    expect(db.docs('clientes').size).toBe(2);
    expect(db.docs('chat').size).toBe(0);
  });
  it.each([
    {},
    { ...BIND, revision: -1 },
    { ...BIND, choice: { kind: 'existing', clienteId: 'clientes/invalid' } },
  ])('rejects an invalid decision %j', async (body) => {
    expect((await confirm(request('/pending-1', body), context())).status).toBe(400);
    expect(db.docs('chat').size).toBe(0);
    expect(h.replay).not.toHaveBeenCalled();
  });
});

describe('GET historical conversation/message aliases', () => {
  it('resolves both conversation and message ids while preserving read-only access', async () => {
    h.verifyToken.mockResolvedValue({ uid: 'reader', permissions: PERM.chat.read.toString() });
    db.seed('whatsappConversaAliases', 'old', { conversaId: 'canonical' });
    db.seed('whatsappConversaAliases/old/mensagens', 'old-message', {
      conversaId: 'canonical',
      mensagemId: 'canonical-message',
    });
    expect(
      await (await alias(request('/old/alias?mensagemId=old-message'), context('old'))).json(),
    ).toEqual({ conversaId: 'canonical', mensagemId: 'canonical-message' });
  });
  it('resolves a message-only alias and returns null for an unredirected URL', async () => {
    db.seed('whatsappConversaAliases/old/mensagens', 'old-message', {
      conversaId: 'canonical',
      mensagemId: 'canonical-message',
    });
    expect(
      await (await alias(request('/old/alias?mensagemId=old-message'), context('old'))).json(),
    ).toEqual({ conversaId: 'canonical', mensagemId: 'canonical-message' });
    expect(await (await alias(request('/untouched/alias'), context('untouched'))).json()).toEqual({
      conversaId: null,
      mensagemId: null,
    });
  });
});

describe('WhatsApp link preview', () => {
  const run = (clienteId = 'cliente-1', id = 'pending-1') =>
    preview(
      request('/' + id + '/previsao?clienteId=' + encodeURIComponent(clienteId)),
      context(id),
    );
  const claim = (patch: Data = {}) => {
    db.seed('whatsappConversas', conversaWhatsappKey('conta-1', 'cliente-1'), {
      integracaoId: 'conta-1',
      clienteId: 'cliente-1',
      conversaId: 'legacy-chat',
      ...patch,
    });
  };
  const chat = (patch: Data = {}) => {
    db.seed('chat', 'legacy-chat', {
      origem: ORIGEM_CONVERSA.whatsapp,
      clienteOuterRef: 'documents/clientes/cliente-1',
      integracaoOuterRef: 'documents/integracao/conta-1',
      ...patch,
    });
  };
  const storedDocuments = () =>
    [...db.cols].flatMap(([path, docs]) =>
      [...docs].map(([id, data]) => [path + '/' + id, structuredClone(data)]),
    );

  it('returns the selected customer and a null conversation without writing anything', async () => {
    const before = storedDocuments();
    const response = await run();
    expect(response.status).toBe(200);
    const result: unknown = await response.json();
    expect(whatsappVinculoPrevisaoSchema.parse(result)).toEqual({
      avisoIdentidade: null,
      cliente: {
        id: 'cliente-1',
        nome: 'Cliente existente',
        cpf_cnpj: null,
        telefone: PHONE,
      },
      conversaId: null,
    });
    expect(result).toEqual(whatsappVinculoPrevisaoSchema.parse(result));
    expect(storedDocuments()).toEqual(before);
    expect(h.replay).not.toHaveBeenCalled();
  });

  it('previews the existing canonical chat, preserving its imported ID', async () => {
    claim();
    chat();
    const before = storedDocuments();
    const response = await run();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ conversaId: 'legacy-chat' });
    expect(storedDocuments()).toEqual(before);
  });

  it('accepts bare references to the same customer and integration', async () => {
    claim();
    chat({ clienteOuterRef: 'clientes/cliente-1', integracaoOuterRef: 'integracao/conta-1' });
    expect((await run()).status).toBe(200);
  });

  it('requires authentication', async () => {
    const response = await preview(
      request('/pending-1/previsao?clienteId=cliente-1', undefined, false),
      context(),
    );
    expect(response.status).toBe(401);
    expect(db.reads).toBe(0);
  });

  it.each(['', 'clientes/cliente-1', 'a'.repeat(201)])(
    'rejects an invalid customer ID before reading data: %s',
    async (id) => {
      expect((await run(id)).status).toBe(400);
      expect(db.reads).toBe(0);
    },
  );

  it('requires the customer query parameter', async () => {
    expect((await preview(request('/pending-1/previsao'), context())).status).toBe(400);
    expect(db.reads).toBe(0);
  });

  it('rejects an invalid pending ID before reading data', async () => {
    expect((await run('cliente-1', 'parent/child')).status).toBe(400);
    expect(db.reads).toBe(0);
  });

  it.each([
    ['whatsappVinculos', 'pending-1'],
    ['integracao', 'conta-1'],
    ['clientes', 'cliente-1'],
  ])('404s when %s/%s is absent', async (collection, id) => {
    db.docs(collection).delete(id);
    expect((await run()).status).toBe(404);
  });

  it('404s when the account is no longer a WhatsApp integration', async () => {
    db.seed('integracao', 'conta-1', { tipo: INTEGRACAO_TIPO.mercadoLivre });
    expect((await run()).status).toBe(404);
  });

  it.each([
    { clienteId: 'other-client' },
    { integracaoId: 'other-account' },
    { conversaId: '' },
    { conversaId: 'parent/child' },
  ])('rejects an inconsistent canonical reservation: %j', async (patch) => {
    claim(patch);
    chat();
    const response = await run();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'WA_VINCULO_CONFLITO' });
  });

  it('rejects a reservation whose chat no longer exists', async () => {
    claim();
    const response = await run();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'WA_VINCULO_CONFLITO' });
  });

  it.each([
    { clienteOuterRef: 'documents/clientes/other-client' },
    { integracaoOuterRef: 'documents/integracao/other-account' },
    { clienteOuterRef: 'documents/usuarios/cliente-1' },
    { origem: ORIGEM_CONVERSA.site },
  ])('rejects a reserved chat belonging to another context: %j', async (patch) => {
    claim();
    chat(patch);
    expect((await run()).status).toBe(409);
  });

  it('does not advertise creating a conversation when its deterministic doc is orphaned', async () => {
    const { sha256Hex } = await import('./ids');
    const id = sha256Hex(JSON.stringify(['whatsapp', 'conta-1', 'cliente-1']));
    db.seed('chat', id, { origem: ORIGEM_CONVERSA.whatsapp });
    expect((await run()).status).toBe(409);
  });
});

describe('Manual link review remains bound to the displayed identity', () => {
  const T = 1700000000000;
  async function retain(mid: string, phone: string, timestamp: number) {
    const { guardarContatoPendente } = await import('./vinculos');
    const { valuePayloadSchema } = await import('@delfrance/integrations-whatsapp-cloud-api');
    const { getAdminFirestore } = await import('@/lib/firebase/admin');
    const value = valuePayloadSchema.parse({
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-id', display_phone_number: '5511888887777' },
      messages: [
        {
          id: mid,
          from: phone,
          from_user_id: 'known-bsuid',
          type: 'text',
          timestamp: String(timestamp / 1000),
          text: { body: 'Retained message' },
        },
      ],
    });
    db.seed('integracao', 'conta-1', { tipo: 6, portfolioId: 'portfolio', wa_id: 'phone-id' });
    return guardarContatoPendente(
      getAdminFirestore(),
      {
        integracaoId: 'conta-1',
        portfolioId: 'portfolio',
        bsuid: 'known-bsuid',
        telefone: phone,
        nome: 'Contato',
        timestamp,
      },
      'Escolha manual',
      value,
      value.messages![0]!,
      async () => {
        throw new Error('Text must not request media');
      },
      null,
    );
  }
  it('rejects confirmation with an old revision after the visible phone changes', async () => {
    const id = await retain('first', PHONE, T);
    await retain('changed', '14155552671', T + 1000);
    expect(db.docs('whatsappVinculos').get(id)).toMatchObject({
      revision: 1,
      telefone: '14155552671',
    });
    const result = await confirm(request('/' + id, BIND), context(id));
    expect(result.status).toBe(409);
    expect(db.docs('whatsappIdentidades').size).toBe(0);
    expect(db.docs('chat').size).toBe(0);
  });
  it('does not let delayed messages replace the identity last shown for review', async () => {
    const id = await retain('new', '14155552671', T);
    await retain('old', PHONE, T - 1000);
    expect(db.docs('whatsappVinculos').get(id)).toMatchObject({
      revision: 0,
      telefone: '14155552671',
      quantidadeMensagens: 2,
    });
  });
  it('requires a new decision if sender evidence changes while recovery is running', async () => {
    const id = await retain('first', PHONE, T);
    expect((await confirm(request('/' + id, BIND), context(id))).status).toBe(200);
    await retain('different', '14155552671', T + 1000);
    expect(db.docs('whatsappVinculos').get(id)).toMatchObject({
      revision: 2,
      estado: 'aguardando',
      clienteId: null,
      conversaId: null,
      requestId: null,
      requestFingerprint: null,
      decididoPor: null,
    });
  });
  it('previews the explicit BSUID decision without transferring a contradictory phone', async () => {
    seedPending('pending-1', { bsuid: 'bsuid-a', portfolioId: 'portfolio' });
    db.seed('integracao', 'conta-1', { tipo: 6, portfolioId: 'portfolio' });
    db.seed('whatsappIdentidades', identidadeWhatsappId('portfolio', 'bsuid', 'bsuid-a'), {
      escopo: 'portfolio',
      tipo: 'bsuid',
      valor: 'bsuid-a',
      clienteId: 'cliente-1',
      ativa: true,
    });
    const phoneId = identidadeWhatsappId('conta-1', 'telefone', PHONE);
    const phone = {
      escopo: 'conta-1',
      tipo: 'telefone',
      valor: PHONE,
      clienteId: 'cliente-2',
      ativa: true,
    };
    db.seed('whatsappIdentidades', phoneId, phone);
    const result = await preview(request('/pending-1/previsao?clienteId=cliente-1'), context());
    expect(result.status).toBe(200);
    expect(whatsappVinculoPrevisaoSchema.parse(await result.json()).avisoIdentidade).toContain(
      'outro cliente',
    );
    expect((await confirm(request('/pending-1', BIND), context())).status).toBe(200);
    expect(db.docs('whatsappIdentidades').get(phoneId)).toEqual(phone);
    expect(
      db.docs('whatsappIdentidades').get(identidadeWhatsappId('portfolio', 'bsuid', 'bsuid-a')),
    ).toMatchObject({
      clienteId: 'cliente-1',
      aliasesTelefoneIgnorados: [phoneId],
      confirmadaManualmente: true,
    });
  });
  it.each([false, true])(
    'recovering a retired BSUID does not activate its secondary telephone (existing: %s)',
    async (existingPhone) => {
      const bsuidId = identidadeWhatsappId('portfolio', 'bsuid', 'retired-bsuid');
      const currentId = identidadeWhatsappId('portfolio', 'bsuid', 'current-bsuid');
      const phoneId = identidadeWhatsappId('conta-1', 'telefone', PHONE);
      seedPending('pending-1', { bsuid: 'retired-bsuid', portfolioId: 'portfolio' });
      db.seed('integracao', 'conta-1', { tipo: 6, portfolioId: 'portfolio' });
      const oldIdentity = {
        escopo: 'portfolio',
        tipo: 'bsuid',
        valor: 'retired-bsuid',
        clienteId: 'cliente-1',
        ativa: false,
        sucessoraId: currentId,
        ultimaTransicaoEm: T + 1000,
      };
      db.seed('whatsappIdentidades', bsuidId, oldIdentity);
      const phoneIdentity = {
        escopo: 'conta-1',
        tipo: 'telefone',
        valor: PHONE,
        clienteId: 'cliente-1',
        ativa: false,
        sucessoraId: currentId,
        ultimaTransicaoEm: T - 1000,
      };
      if (existingPhone) db.seed('whatsappIdentidades', phoneId, phoneIdentity);
      db.seed('whatsappConversas', conversaWhatsappKey('conta-1', 'cliente-1'), {
        integracaoId: 'conta-1',
        clienteId: 'cliente-1',
        conversaId: 'continued-chat',
      });
      const currentDestination = {
        tipo: 'bsuid',
        valor: 'current-bsuid',
        identidadeId: currentId,
        revision: 2,
        ultimaMensagemEm: T + 2000,
        ultimaIdentificacaoEm: T + 2000,
      };
      db.seed('chat', 'continued-chat', {
        nome: 'Cliente existente',
        origem: ORIGEM_CONVERSA.whatsapp,
        clienteOuterRef: 'documents/clientes/cliente-1',
        integracaoOuterRef: 'documents/integracao/conta-1',
        whatsappDestino: currentDestination,
      });

      const response = await confirm(request('/pending-1', BIND), context());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        clienteId: 'cliente-1',
        conversaId: 'continued-chat',
      });
      expect(db.docs('whatsappIdentidades').get(bsuidId)).toEqual(oldIdentity);
      expect(db.docs('whatsappIdentidades').get(phoneId)).toEqual(
        existingPhone ? phoneIdentity : undefined,
      );
      expect(db.docs('chat').get('continued-chat')!.whatsappDestino).toEqual(currentDestination);
    },
  );
});
