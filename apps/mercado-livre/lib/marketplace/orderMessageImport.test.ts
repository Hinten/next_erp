import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import type { MercadoLivreApi, MlPackMessages } from '@delfrance/integrations-mercado-livre';

import { importOrderMessageMercadoLivre } from './orderMessageImport';
import { PREFIXO_PROVISORIA, makeMensagemProvisoriaId } from './mensagemProvisoria';
import { makeConversaIdOrderMessage } from './orderMessageIds';

type DocData = Record<string, unknown>;

interface FakeRef {
  id: string;
  __col: Map<string, DocData>;
}
interface FakeTx {
  get: (ref: FakeRef) => Promise<{ exists: boolean; id: string; data: () => DocData | undefined }>;
  set: (ref: FakeRef, data: DocData, opts?: { merge?: boolean }) => void;
}

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
      // The doc-id RANGE chain `limparMensagensProvisorias` uses. Strict on
      // purpose: an unexpected field throws instead of quietly matching all,
      // which would let a broken cleanup read as a working one.
      where: function whereRange(campo: unknown, op: string, valor: unknown) {
        if (String(campo) !== '__name__') {
          throw new Error(`unexpected where on ${String(campo)}`);
        }
        const faixa: { min: string | null; max: string | null } = { min: null, max: null };
        const q = {
          where: (c2: unknown, o2: string, v2: unknown) => {
            if (String(c2) !== '__name__') throw new Error('unexpected where');
            if (o2 === '>=') faixa.min = String(v2);
            else if (o2 === '<') faixa.max = String(v2);
            return q;
          },
          get: async () => ({
            docs: [...col.entries()]
              .filter(
                ([id]) =>
                  (faixa.min == null || id >= faixa.min) && (faixa.max == null || id < faixa.max),
              )
              .map(([id, data]) => ({
                id,
                data: () => data,
                ref: {
                  delete: async () => {
                    col.delete(id);
                  },
                },
              })),
          }),
        };
        return q.where(campo, op, valor);
      },
      doc: (id: string) => ({
        id,
        __col: col,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
        },
      }),
    };
  }

  /**
   * Enough of a transaction for the out-of-order guard: reads see current
   * state, writes apply immediately.
   *
   * ⚠️ It does NOT model OCC contention, so it cannot prove two writers
   * serialise — only that the guard READS INSIDE the transaction and drops an
   * older snapshot. That is the half a unit test can own; Firestore's own
   * conflict retry is the other half.
   */
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    this.transacoes += 1;
    return fn({
      get: async (ref: FakeRef) => ({
        exists: ref.__col.has(ref.id),
        id: ref.id,
        data: () => ref.__col.get(ref.id),
      }),
      set: (ref: FakeRef, data: DocData, opts?: { merge?: boolean }) => {
        ref.__col.set(
          ref.id,
          opts?.merge ? { ...(ref.__col.get(ref.id) ?? {}), ...data } : { ...data },
        );
      },
    });
  }

  /** How many transactions ran — pins that the write path uses one at all. */
  transacoes = 0;

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

/**
 * ⚠️ Looser than `Partial<MercadoLivreApi>` on purpose. Every override here is a
 * hand-rolled page fixture carrying only what the code under test reads. Typing
 * them against the real return shape would force each case to spell out a whole
 * ML envelope to vary ONE field, which is how a fixture stops describing the
 * case it exists for.
 */
type ApiStubs = Partial<Record<keyof MercadoLivreApi, unknown>>;

function api(over: ApiStubs = {}): MercadoLivreApi {
  return {
    getMessage: vi.fn(async () => ({ conversation_status: null, messages: [msg()] })),
    getPackMessages: vi.fn(async () => packResponse()),
    ...over,
  } as unknown as MercadoLivreApi;
}

function deps(
  db: FakeDb,
  apiOver: ApiStubs = {},
  over: { notificacaoEnviadaMs?: number | null } = {},
) {
  return {
    db: asDb(db),
    api: api(apiOver),
    integracaoId: CONTA,
    conta: { userId: SELLER, cor: 7 },
    nowMs: NOW_MS,
    // Default OLD (literal, not derived from the window constant), so a 404 in
    // an unrelated test still reads as "gone".
    notificacaoEnviadaMs: NOW_MS - 3_600_000,
    ...over,
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

    // ⚠️ And it asks for a REAL page. ML defaults to 10 (its own reference shows
    // `paging: { limit: 10, … }`), so the bare call silently returned the first
    // ten messages of every thread.
    expect(d.api.getPackMessages).toHaveBeenCalledWith(PACK_ID, String(SELLER), {
      limit: 100,
    });
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

describe('importOrderMessageMercadoLivre — the whole thread, not ML’s first page', () => {
  it('walks paging.total instead of stopping at the default page of 10', async () => {
    // ⚠️ The bug: `paging.total` said 3 while `messages` carried 1, and the
    // importer wrote only what it was handed. Real post-sale threads clear ten
    // messages easily, so this silently truncated most of them.
    const db = new FakeDb();
    seedPedido(db);
    const paginas = [
      { paging: { limit: 2, offset: 0, total: 5 }, ids: ['m1', 'm2'] },
      { paging: { limit: 2, offset: 2, total: 5 }, ids: ['m3', 'm4'] },
      { paging: { limit: 2, offset: 4, total: 5 }, ids: ['m5'] },
    ];
    let chamada = 0;
    const d = deps(db, {
      getPackMessages: vi.fn(async () => {
        const pagina = paginas[Math.min(chamada, paginas.length - 1)]!;
        chamada += 1;
        return {
          ...packResponse(),
          paging: pagina.paging,
          messages: pagina.ids.map((id) => msg({ id })),
        };
      }),
    });

    const r = await importOrderMessageMercadoLivre(d, MSG_ID);

    expect(d.api.getPackMessages).toHaveBeenCalledTimes(3);
    expect(db.docs(`chat/${r.conversaId!}/mensagem`).size).toBe(5);
  });

  it('stops as soon as the page count covers total — one call for a short thread', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db);
    await importOrderMessageMercadoLivre(d, MSG_ID);
    expect(d.api.getPackMessages).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page rather than spinning to the cap', async () => {
    // ML claiming a total it will not serve must not burn the 500 rpm post-sale
    // budget on a loop that gains nothing.
    const db = new FakeDb();
    seedPedido(db);
    let chamada = 0;
    const d = deps(db, {
      getPackMessages: vi.fn(async () => {
        chamada += 1;
        return {
          ...packResponse(),
          paging: { limit: 2, offset: 0, total: 999 },
          messages: chamada === 1 ? [msg({ id: 'm1' })] : [],
        };
      }),
    });

    await importOrderMessageMercadoLivre(d, MSG_ID);

    expect(d.api.getPackMessages).toHaveBeenCalledTimes(2);
  });
});

describe('importOrderMessageMercadoLivre — 404 is usually the race (#532)', () => {
  it('RETHROWS a 404 on a fresh notification instead of acking it', async () => {
    // ⚠️ ML's own reference says so for this endpoint: "Mensagem não encontrada
    // no servidor. Tente novamente em alguns segundos." Acking loses a real
    // customer message with no record anywhere.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(
      db,
      {
        getMessage: vi.fn(async () => {
          throw new MercadoLivreHttpError('ML 404', 404, null, null);
        }),
      },
      { notificacaoEnviadaMs: NOW_MS - 5_000 },
    );

    await expect(importOrderMessageMercadoLivre(d, MSG_ID)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });

  it('acks a 404 once the notification is outside the race window', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(
      db,
      {
        getMessage: vi.fn(async () => {
          throw new MercadoLivreHttpError('ML 404', 404, null, null);
        }),
      },
      { notificacaoEnviadaMs: NOW_MS - 600_001 }, // 10 min + 1 ms
    );

    expect((await importOrderMessageMercadoLivre(d, MSG_ID)).skipped).toBe('message-404');
  });

  it('applies the same policy to the PACK read, not just the by-id read', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(
      db,
      {
        getPackMessages: vi.fn(async () => {
          throw new MercadoLivreHttpError('ML 404', 404, null, null);
        }),
      },
      { notificacaoEnviadaMs: NOW_MS - 5_000 },
    );

    await expect(importOrderMessageMercadoLivre(d, MSG_ID)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });
});

describe('importOrderMessageMercadoLivre — out-of-order provider snapshots (rule 7)', () => {
  it('advances the watermark on status_date, not only on a new message', async () => {
    // ⚠️ The half a message-only watermark misses, and the one that matters most:
    // a thread going BLOCKED usually carries no new message at all. If the
    // watermark only tracked message times, the blocked snapshot would store a
    // stale value and the very next `active` snapshot — even an older one — would
    // beat it and reopen the thread.
    const statusDate = '2027-03-01T00:00:00.000Z';
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db, {
      getPackMessages: vi.fn(async () => ({
        ...packResponse({
          conversation_status: {
            path: `/packs/${PACK_ID}/seller/${SELLER}`,
            // ACTIVE on purpose: a blocked thread with no stored conversa is
            // refused by the actionability gate before any write, which would
            // test the gate instead of the watermark.
            status: 'active',
            substatus: null,
            status_date: statusDate,
            status_update_allowed: false,
            shipping_id: null,
          },
        }),
      })),
    });

    const r = await importOrderMessageMercadoLivre(d, MSG_ID);

    const stored = db.docs('chat').get(r.conversaId!)!;
    expect(stored.ultimaModificacaoIntegracao).toBe(Date.parse(statusDate));
  });

  it('runs the conversa write inside a TRANSACTION', async () => {
    const db = new FakeDb();
    seedPedido(db);
    await importOrderMessageMercadoLivre(deps(db), MSG_ID);
    expect(db.transacoes).toBeGreaterThan(0);
  });

  it('DROPS an older snapshot instead of reopening a closed thread', async () => {
    // ⚠️ The reported failure. Two notifications for one pack are in flight; the
    // older `active` snapshot finishes last and overwrites `respostaBloqueada` /
    // `atendido`, handing the operator a composer that cannot send — #817 again,
    // arrived by a different road.
    const db = new FakeDb();
    seedPedido(db);
    const conversaId = makeConversaIdOrderMessage(CONTA, PACK_ID);
    db.seed('chat', conversaId, {
      origem: 'mlped',
      respostaBloqueada: 'Mediação em andamento',
      atendido: true,
      // A NEWER provider snapshot already landed.
      // ⚠️ Must beat the FIXTURE MESSAGE time, not NOW_MS — the sample message is
      // dated 2026-02 while NOW_MS is 2025-07, so `NOW_MS + 60s` is still older
      // than the incoming snapshot and the guard would (correctly) let it through.
      ultimaModificacaoIntegracao: Date.parse('2030-01-01T00:00:00.000Z'),
    });

    await importOrderMessageMercadoLivre(deps(db), MSG_ID);

    const stored = db.docs('chat').get(conversaId)!;
    expect(stored.respostaBloqueada).toBe('Mediação em andamento');
    expect(stored.atendido).toBe(true);
  });

  it('still writes the mensagens when the conversa patch is dropped', async () => {
    // They are keyed by ML id, so they can only ADD history — never contradict
    // whatever the newer snapshot decided about the thread.
    const db = new FakeDb();
    seedPedido(db);
    const conversaId = makeConversaIdOrderMessage(CONTA, PACK_ID);
    db.seed('chat', conversaId, {
      origem: 'mlped',
      // ⚠️ Must beat the FIXTURE MESSAGE time, not NOW_MS — the sample message is
      // dated 2026-02 while NOW_MS is 2025-07, so `NOW_MS + 60s` is still older
      // than the incoming snapshot and the guard would (correctly) let it through.
      ultimaModificacaoIntegracao: Date.parse('2030-01-01T00:00:00.000Z'),
    });

    await importOrderMessageMercadoLivre(deps(db), MSG_ID);

    expect(db.docs(`chat/${conversaId}/mensagem`).size).toBeGreaterThan(0);
  });

  it('lets an EQUAL or newer snapshot through', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const conversaId = makeConversaIdOrderMessage(CONTA, PACK_ID);
    db.seed('chat', conversaId, {
      origem: 'mlped',
      respostaBloqueada: 'algo antigo',
      ultimaModificacaoIntegracao: 1,
    });

    await importOrderMessageMercadoLivre(deps(db), MSG_ID);

    expect(db.docs('chat').get(conversaId)!.respostaBloqueada).toBeNull();
  });
});

describe('importOrderMessageMercadoLivre — the provisional bubble expires', () => {
  it('deletes the placeholder the operator’s reply left behind', async () => {
    // ⚠️ The importer writes EVERY message in the thread, ours included, at its
    // ML id. The reply the composer had already shown provisionally therefore
    // appeared TWICE — once at `local-<ms>`, once at the ML id — and nothing
    // linked them, so the duplicate was permanent.
    const db = new FakeDb();
    seedPedido(db);
    const conversaId = makeConversaIdOrderMessage(CONTA, PACK_ID);
    db.seed(`chat/${conversaId}/mensagem`, makeMensagemProvisoriaId(1_000), {
      conteudo: 'Enviado hoje!',
      timestamp: 1_000,
    });

    await importOrderMessageMercadoLivre(deps(db), MSG_ID);

    const mensagens = db.docs(`chat/${conversaId}/mensagem`);
    expect([...mensagens.keys()].some((id) => id.startsWith(PREFIXO_PROVISORIA))).toBe(false);
    // ...and the real messages are still there.
    expect(mensagens.size).toBeGreaterThan(0);
  });

  it('KEEPS a placeholder newer than everything ML just returned', async () => {
    // A reply sent after this snapshot has not come back yet. Deleting it would
    // reopen the gap the bubble exists to cover, and an operator who reloads
    // would see no trace of a message the customer already received.
    const db = new FakeDb();
    seedPedido(db);
    const conversaId = makeConversaIdOrderMessage(CONTA, PACK_ID);
    const futuro = makeMensagemProvisoriaId(Date.parse('2099-01-01T00:00:00.000Z'));
    db.seed(`chat/${conversaId}/mensagem`, futuro, {
      conteudo: 'recém-enviada',
      timestamp: Date.parse('2099-01-01T00:00:00.000Z'),
    });

    await importOrderMessageMercadoLivre(deps(db), MSG_ID);

    expect(db.docs(`chat/${conversaId}/mensagem`).get(futuro)).toBeDefined();
  });
});
