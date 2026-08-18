import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import type { MercadoLivreApi, MlPackMessages } from '@delfrance/integrations-mercado-livre';

import { importOrderMessageMercadoLivre } from './orderMessageImport';
import { makeConversaIdOrderMessage } from './orderMessageIds';

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  collection(path: string) {
    const col = this.col(path);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
        },
      }),
    };
  }

  collectionGroup(groupId: string) {
    const entries: Array<[string, DocData, string]> = [];
    for (const [path, col] of this.cols) {
      if (path.split('/').pop() === groupId) for (const [id, d] of col) entries.push([id, d, path]);
    }
    const clauses: Array<{ field: string; value: unknown }> = [];
    const q = {
      where: (field: string, _op: string, value: unknown) => {
        clauses.push({ field, value });
        return q;
      },
      limit: () => q,
      get: async () => ({
        docs: entries
          .filter(([, d]) => clauses.every((c) => d[c.field] === c.value))
          .map(([id, d, colPath]) => {
            const segs = colPath.split('/').filter(Boolean);
            return {
              id,
              data: () => d,
              exists: true,
              ref: { parent: { parent: { id: segs[segs.length - 2] ?? '' } } },
            };
          }),
      }),
    };
    return q;
  }
}

const asDb = (f: FakeDb) => f as unknown as Firestore;

const CONTA = 'conta1';
const NOW_MS = 1_753_180_800_000;
const SELLER = 415458330;
const AGENTE_MLB = 3037675074;
const MSG_ID = 'fd1d2e37ad004ede9e0bf25d1215002d';
const PACK_ID = '2000000089077943';
const CHAT = 'chat';
const MENSAGENS = (conversaId: string) => `chat/${conversaId}/mensagem`;

function msg(over: Record<string, unknown> = {}) {
  return {
    id: MSG_ID,
    from: { user_id: AGENTE_MLB },
    to: { user_id: SELLER },
    status: 'available',
    text: 'Bom dia, quando envia?',
    message_date: { created: '2026-02-05T20:01:46.000Z', received: null, read: null },
    message_attachments: [],
    message_resources: [
      { id: PACK_ID, name: 'packs' },
      { id: String(SELLER), name: 'sellers' },
    ],
    ...over,
  };
}

function packResponse(over: Record<string, unknown> = {}): MlPackMessages {
  return {
    conversation_status: {
      path: `/packs/${PACK_ID}/seller/${SELLER}`,
      status: 'active',
      substatus: null,
      status_date: null,
      status_update_allowed: false,
      shipping_id: null,
    },
    messages: [msg()],
    seller_max_message_length: 350,
    buyer_max_message_length: 3500,
    ...over,
  } as unknown as MlPackMessages;
}

function api(over: Partial<MercadoLivreApi> = {}): MercadoLivreApi {
  return {
    getMessage: vi.fn(async () => ({ conversation_status: null, messages: [msg()] })),
    getPackMessages: vi.fn(async () => packResponse()),
    ...over,
  } as unknown as MercadoLivreApi;
}

function deps(db: FakeDb, apiOver: Partial<MercadoLivreApi> = {}) {
  return {
    db: asDb(db),
    api: api(apiOver),
    integracaoId: CONTA,
    conta: { userId: SELLER, cor: 7 },
    nowMs: NOW_MS,
  };
}

/** A pedido reachable through the orderML chain on `pack_id`. */
function seedPedido(db: FakeDb) {
  db.seed('pedidos/ped1/orderML', 'o1', { pack_id: Number(PACK_ID), id: 111 });
  db.seed('pedidos', 'ped1', {
    numero: '1234',
    clientePedidoOuterRef: 'documents/clientes/cli1',
  });
}

describe('importOrderMessageMercadoLivre — the actionability gate', () => {
  it('imports an ACTIVE thread: conversa + every message', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const res = await importOrderMessageMercadoLivre(deps(db), MSG_ID);

    const conversaId = makeConversaIdOrderMessage(CONTA, PACK_ID);
    expect(res).toMatchObject({ conversaId, pedidoId: 'ped1', skipped: null });
    expect(db.docs(CHAT).get(conversaId)).toMatchObject({
      origem: 'mlped',
      clienteOuterRef: 'documents/clientes/cli1',
      pedidoOuterRef: 'documents/pedidos/ped1',
      respostaBloqueada: null,
      atendido: false,
    });
    expect(db.docs(MENSAGENS(conversaId)).get(MSG_ID)).toMatchObject({
      estadoEnvio: 7, // recebido — the buyer's side
    });
  });

  it('writes NOTHING for a blocked thread with no existing conversa', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const res = await importOrderMessageMercadoLivre(
      deps(db, {
        getPackMessages: vi.fn(async () =>
          packResponse({
            conversation_status: { status: 'blocked', substatus: 'blocked_by_time' },
          }),
        ),
      }),
      MSG_ID,
    );

    expect(res.skipped).toBe('nao-respondivel');
    expect(db.docs(CHAT).size).toBe(0);
  });

  it('STILL closes an existing thread when it becomes blocked', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const conversaId = makeConversaIdOrderMessage(CONTA, PACK_ID);
    db.seed(CHAT, conversaId, { origem: 'mlped', estadoConversa: 1, respostaBloqueada: null });

    const res = await importOrderMessageMercadoLivre(
      deps(db, {
        getPackMessages: vi.fn(async () =>
          packResponse({
            conversation_status: { status: 'blocked', substatus: 'blocked_by_mediation' },
          }),
        ),
      }),
      MSG_ID,
    );

    expect(res.skipped).toBeNull();
    expect(db.docs(CHAT).get(conversaId)).toMatchObject({
      respostaBloqueada: 'Mediação em andamento',
      atendido: true,
      // Operator triage state survives untouched.
      estadoConversa: 1,
    });
  });
});

describe('importOrderMessageMercadoLivre — resolution and skips', () => {
  it('reads the thread WITHOUT marking it read', async () => {
    // The plain GET marks a thread read as a side effect; an importer must not
    // clear the seller's unread state.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db);
    await importOrderMessageMercadoLivre(d, MSG_ID);

    expect(d.api.getPackMessages).toHaveBeenCalledWith(PACK_ID, String(SELLER));
  });

  it('keys the conversa on the PACK, not the order', async () => {
    // A cart of several orders shares one pack; keying on the order would split
    // one buyer conversation into several threads.
    const db = new FakeDb();
    seedPedido(db);
    await importOrderMessageMercadoLivre(deps(db), MSG_ID);
    expect([...db.docs(CHAT).keys()]).toEqual([makeConversaIdOrderMessage(CONTA, PACK_ID)]);
  });

  it('skips when the message names neither a pack nor an order', async () => {
    const db = new FakeDb();
    const res = await importOrderMessageMercadoLivre(
      deps(db, {
        getMessage: vi.fn(
          async () =>
            ({
              conversation_status: null,
              messages: [msg({ message_resources: [{ id: '1', name: 'sellers' }] })],
            }) as unknown as MlPackMessages,
        ),
      }),
      MSG_ID,
    );
    expect(res.skipped).toBe('sem-pack');
  });

  it('acks a 404 instead of poison-retrying', async () => {
    const db = new FakeDb();
    const res = await importOrderMessageMercadoLivre(
      deps(db, {
        getMessage: vi.fn(async () => {
          throw new MercadoLivreHttpError('ML 404', 404, null, null);
        }),
      }),
      MSG_ID,
    );
    expect(res.skipped).toBe('message-404');
  });

  it('rethrows a non-404 so the queue retries', async () => {
    const db = new FakeDb();
    await expect(
      importOrderMessageMercadoLivre(
        deps(db, {
          getMessage: vi.fn(async () => {
            throw new MercadoLivreHttpError('ML 500', 500, null, null);
          }),
        }),
        MSG_ID,
      ),
    ).rejects.toBeInstanceOf(MercadoLivreHttpError);
  });

  it('still imports when no pedido matches, with a null cliente', async () => {
    // The thread is real and repliable even if the order import has not landed.
    const db = new FakeDb();
    const res = await importOrderMessageMercadoLivre(deps(db), MSG_ID);
    expect(res.skipped).toBeNull();
    expect(res.pedidoId).toBeNull();
    expect(db.docs(CHAT).get(res.conversaId!)).toMatchObject({ clienteOuterRef: null });
  });

  it('is idempotent — a redelivery updates in place', async () => {
    const db = new FakeDb();
    seedPedido(db);
    await importOrderMessageMercadoLivre(deps(db), MSG_ID);
    await importOrderMessageMercadoLivre(deps(db), MSG_ID);

    const conversaId = makeConversaIdOrderMessage(CONTA, PACK_ID);
    expect(db.docs(CHAT).size).toBe(1);
    expect(db.docs(MENSAGENS(conversaId)).size).toBe(1);
  });
});
