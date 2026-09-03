import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  WhatsAppHttpError,
  WhatsAppNetworkError,
} from '@delfrance/integrations-whatsapp-cloud-api';

import { WhatsappContaNotConfiguredError, WhatsappTokenMissingError } from './whatsapp';
import { dispatchOutbound, sweepStaleOutbound, type OutboundDeps } from './outbound';
import { mensagemDocId } from './ids';

/* ----------------------------- fake Firestore ---------------------------- */

type DocData = Record<string, unknown>;
type Clause = { field: string; op: string; value: unknown };

function matches(data: DocData, clauses: Clause[]): boolean {
  return clauses.every((c) => {
    const v = data[c.field];
    if (c.op === '==') return v === c.value;
    if (c.op === '<') {
      // `timestamp` is millisecondsSinceEpoch INT now (#484/#486), so the sweep
      // cutoff is numeric; keep the string branch for any legacy string range.
      if (typeof v === 'number' && typeof c.value === 'number') return v < c.value;
      return typeof v === 'string' && typeof c.value === 'string' && v < c.value;
    }
    return false;
  });
}

/** Order comparator that handles numeric (ms-int) and string fields alike. */
function compareField(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

interface Op {
  type: 'create' | 'set' | 'delete';
  ref: FakeDoc;
  data?: DocData;
  opts?: { merge?: boolean };
}

interface FakeDoc {
  id: string;
  get(): Promise<{ exists: boolean; id: string; data: () => DocData | undefined }>;
  set(data: DocData, opts?: { merge?: boolean }): Promise<void>;
  create(data: DocData): Promise<void>;
  delete(): Promise<void>;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  private autoN = 0;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) {
      c = new Map();
      this.cols.set(path, c);
    }
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  private makeDoc(col: Map<string, DocData>, id: string): FakeDoc {
    return {
      id,
      get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
      set: async (data, opts) => {
        col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
      },
      create: async (data) => {
        if (col.has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
        col.set(id, { ...data });
      },
      delete: async () => {
        col.delete(id);
      },
    };
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    const query = (
      clauses: Clause[],
      order: { field: string; dir: 'asc' | 'desc' } | null,
      lim: number | null,
    ) => ({
      where: (field: string, op: string, value: unknown) =>
        query([...clauses, { field, op, value }], order, lim),
      orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') => query(clauses, { field, dir }, lim),
      limit: (n: number) => query(clauses, order, n),
      get: async () => {
        let rows = [...col.entries()].filter(([, d]) => matches(d, clauses));
        if (order) {
          rows.sort(([, a], [, b]) => {
            const cmp = compareField(a[order.field], b[order.field]);
            return order.dir === 'desc' ? -cmp : cmp;
          });
        }
        if (lim != null) rows = rows.slice(0, lim);
        return { docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })) };
      },
    });
    return {
      doc: (id?: string) => self.makeDoc(col, id ?? `auto-${++self.autoN}`),
      where: (field: string, op: string, value: unknown) =>
        query([{ field, op, value }], null, null),
      orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') => query([], { field, dir }, null),
      limit: (n: number) => query([], null, n),
    };
  }

  collectionGroup(groupId: string) {
    const self = this;
    const suffix = `/${groupId}`;
    const query = (
      clauses: Clause[],
      order: { field: string; dir: 'asc' | 'desc' } | null,
      lim: number | null,
    ) => ({
      where: (field: string, op: string, value: unknown) =>
        query([...clauses, { field, op, value }], order, lim),
      orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') => query(clauses, { field, dir }, lim),
      limit: (n: number) => query(clauses, order, n),
      get: async () => {
        const rows: Array<{ path: string; id: string; data: DocData }> = [];
        for (const [path, col] of self.cols.entries()) {
          if (!path.endsWith(suffix)) continue;
          for (const [id, d] of col.entries()) {
            if (matches(d, clauses)) rows.push({ path, id, data: d });
          }
        }
        if (order) {
          rows.sort((a, b) => {
            const cmp = compareField(a.data[order.field], b.data[order.field]);
            return order.dir === 'desc' ? -cmp : cmp;
          });
        }
        const sliced = lim != null ? rows.slice(0, lim) : rows;
        return {
          docs: sliced.map((r) => ({
            id: r.id,
            data: () => r.data,
            exists: true,
            ref: { parent: { parent: { id: r.path.split('/')[1] ?? '' } } },
          })),
        };
      },
    });
    return query([], null, null);
  }

  async runTransaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
    const ops: Op[] = [];
    const txn = {
      get: (ref: FakeDoc) => ref.get(),
      create: (ref: FakeDoc, data: DocData) => {
        ops.push({ type: 'create', ref, data });
      },
      set: (ref: FakeDoc, data: DocData, opts?: { merge?: boolean }) => {
        ops.push({ type: 'set', ref, data, opts });
      },
      delete: (ref: FakeDoc) => {
        ops.push({ type: 'delete', ref });
      },
    };
    const result = await fn(txn);
    // Commit atomically: verify every create precondition first, then apply.
    for (const op of ops) {
      if (op.type === 'create' && (await op.ref.get()).exists) {
        throw Object.assign(new Error('already exists'), { code: 6 });
      }
    }
    for (const op of ops) {
      if (op.type === 'create') await op.ref.create(op.data!);
      else if (op.type === 'set') await op.ref.set(op.data!, op.opts);
      else await op.ref.delete();
    }
    return result;
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* ------------------------------ fake client ------------------------------ */

function fakeClient(
  overrides: Partial<Record<'sendText' | 'sendMedia' | 'markRead', unknown>> = {},
) {
  return {
    sendText: vi.fn(async () => ({ messageId: 'wamid.SENT' })),
    sendMedia: vi.fn(async () => ({ messageId: 'wamid.SENT' })),
    markRead: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakeDeps(client: ReturnType<typeof fakeClient>, buildClientError?: Error): OutboundDeps {
  return {
    loadContext: vi.fn(async () => ({
      integracaoId: CONTA,
      buildClient: async () => {
        if (buildClientError) throw buildClientError;
        return client as never;
      },
    })) as unknown as OutboundDeps['loadContext'],
  };
}

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'conta-1';
const DISPLAY = '5511000000000';
const FROM = '5511999999999';
const SENDER = `${DISPLAY}_${FROM}`;
const CONV_ID = 'conv-1';
const CHAT = 'chat';
const MSG_COL = `chat/${CONV_ID}/mensagem`;
const ARQ = 'arquivos';

function seedWhatsappConversa(db: FakeDb, conversaId = CONV_ID): void {
  db.seed(CHAT, conversaId, {
    origem: 'whatsapp',
    sender_id: SENDER,
    integracaoOuterRef: `documents/integracao/${CONTA}`,
    nome: 'Fulano',
  });
}

// `timestamp` is millisecondsSinceEpoch INT now (#484/#486).
const TS_NOON = Date.parse('2026-07-15T12:00:00.000Z');

function outboundDoc(extra: DocData = {}): DocData {
  return {
    estadoEnvio: 1, // salva
    tipo: 'c',
    conteudo: 'Olá cliente',
    mid: null,
    timestamp: TS_NOON,
    ...extra,
  };
}

/* ---------------------------------- tests --------------------------------- */

describe('dispatchOutbound — fast-path exits', () => {
  it('skips a non-salva mensagem without reading the conversa', async () => {
    const db = new FakeDb();
    const client = fakeClient();
    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'm1',
      outboundDoc({ estadoEnvio: 7 }),
      fakeDeps(client),
    );
    expect(res.kind).toBe('skipped');
    expect(client.sendText).not.toHaveBeenCalled();
    expect(db.cols.has(CHAT)).toBe(false); // conversa never read
  });

  it("skips an event (tipo 'e')", async () => {
    const db = new FakeDb();
    const client = fakeClient();
    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'm1',
      outboundDoc({ tipo: 'e' }),
      fakeDeps(client),
    );
    expect(res.kind).toBe('skipped');
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it("skips an error message (tipo '!')", async () => {
    const db = new FakeDb();
    const client = fakeClient();
    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'm1',
      outboundDoc({ tipo: '!' }),
      fakeDeps(client),
    );
    expect(res.kind).toBe('skipped');
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('skips an already-anchored message (mid != null)', async () => {
    const db = new FakeDb();
    const client = fakeClient();
    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'm1',
      outboundDoc({ mid: 'wamid.already' }),
      fakeDeps(client),
    );
    expect(res.kind).toBe('skipped');
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('skips when the parent conversa is missing', async () => {
    const db = new FakeDb();
    const client = fakeClient();
    const res = await dispatchOutbound(asDb(db), CONV_ID, 'm1', outboundDoc(), fakeDeps(client));
    expect(res.kind).toBe('skipped');
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('skips when the conversa origem is not whatsapp', async () => {
    const db = new FakeDb();
    db.seed(CHAT, CONV_ID, { origem: 'site', sender_id: SENDER });
    const client = fakeClient();
    const res = await dispatchOutbound(asDb(db), CONV_ID, 'm1', outboundDoc(), fakeDeps(client));
    expect(res.kind).toBe('skipped');
    expect(client.sendText).not.toHaveBeenCalled();
  });
});

describe('dispatchOutbound — happy text send + re-anchor', () => {
  let db: FakeDb;
  let client: ReturnType<typeof fakeClient>;

  beforeEach(() => {
    db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    client = fakeClient();
  });

  it('sends the text, re-anchors to the wamid id, and deletes the original', async () => {
    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'orig-1',
      outboundDoc(),
      fakeDeps(client),
    );

    expect(client.sendText).toHaveBeenCalledWith({ to: FROM, text: 'Olá cliente' });
    expect(res).toMatchObject({ kind: 'sent', wamid: 'wamid.SENT' });

    const msgs = db.docs(MSG_COL);
    expect(msgs.has('orig-1')).toBe(false); // original deleted

    const newId = mensagemDocId(CONTA, 'wamid.SENT');
    const reanchored = msgs.get(newId);
    expect(reanchored).toBeDefined();
    expect(reanchored).toMatchObject({
      estadoEnvio: 2, // enviando
      mid: 'wamid.SENT',
      conteudo: 'Olá cliente',
      lastExternalUpdateDateTime: null,
    });
  });

  it('is idempotent on redelivery (original already re-anchored → skip, no re-send)', async () => {
    await dispatchOutbound(asDb(db), CONV_ID, 'orig-1', outboundDoc(), fakeDeps(client));
    expect(client.sendText).toHaveBeenCalledTimes(1);

    // Redelivery with the SAME stale snapshot — the original doc is gone now.
    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'orig-1',
      outboundDoc(),
      fakeDeps(client),
    );
    expect(res.kind).toBe('skipped');
    expect(client.sendText).toHaveBeenCalledTimes(1); // NOT re-sent
  });
});

describe('dispatchOutbound — transactional claim (concurrent double-send guard)', () => {
  it('a second dispatch on an already-claimed (enviando) doc exits without sending', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    // The DB doc was already CLAIMED by a concurrent winner (salva→enviando), while
    // the delivered snapshot this dispatch carries is still the stale `salva` seed.
    db.seed(MSG_COL, 'orig-1', outboundDoc({ estadoEnvio: 2, mid: null }));
    const client = fakeClient();

    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'orig-1',
      outboundDoc(),
      fakeDeps(client),
    );

    expect(res.kind).toBe('skipped');
    expect(client.sendText).not.toHaveBeenCalled();
    // The claimed doc is untouched — the winner still owns it.
    expect(db.docs(MSG_COL).get('orig-1')).toMatchObject({ estadoEnvio: 2 });
  });

  it('claims salva→enviando before sending, then re-anchors the winner', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    const client = fakeClient();

    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'orig-1',
      outboundDoc(),
      fakeDeps(client),
    );

    expect(res.kind).toBe('sent');
    expect(client.sendText).toHaveBeenCalledTimes(1);
    // Original consumed by the re-anchor; the send landed at the wamid id.
    expect(db.docs(MSG_COL).has('orig-1')).toBe(false);
    expect(db.docs(MSG_COL).get(mensagemDocId(CONTA, 'wamid.SENT'))).toBeDefined();
  });
});

describe('dispatchOutbound — media send', () => {
  it('resolves the anexoStorage Arquivo url and sends media by link', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(ARQ, 'arq-1', {
      filetype: 'image',
      url: 'https://cdn.example/wa_arq-1.jpg',
      filename: 'f',
    });
    const doc = outboundDoc({
      tipo: 'f',
      conteudo: 'legenda',
      anexoStorage: 'documents/arquivos/arq-1',
    });
    db.seed(MSG_COL, 'orig-1', doc);
    const client = fakeClient();

    const res = await dispatchOutbound(asDb(db), CONV_ID, 'orig-1', doc, fakeDeps(client));

    expect(res.kind).toBe('sent');
    expect(client.sendMedia).toHaveBeenCalledWith({
      to: FROM,
      type: 'image',
      link: 'https://cdn.example/wa_arq-1.jpg',
      caption: 'legenda',
    });
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('RETHROWS (transient, not erro) when the anexo Arquivo url is still null (upload pending)', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(ARQ, 'arq-2', { filetype: 'image', url: null, filename: 'f' });
    const doc = outboundDoc({ anexoStorage: 'documents/arquivos/arq-2' });
    db.seed(MSG_COL, 'orig-1', doc);
    const client = fakeClient();

    // A create-first arquivo whose bytes haven't landed → throw so the trigger/sweep
    // re-drive rather than burning the message to `erro`.
    await expect(
      dispatchOutbound(asDb(db), CONV_ID, 'orig-1', doc, fakeDeps(client)),
    ).rejects.toThrow(/sem URL de download/);
    // NOT patched to erro and NOT yet claimed (resolveSendSpec fails before the
    // claim) — the doc stays `salva`/mid null for a clean trigger-retry.
    expect(db.docs(MSG_COL).get('orig-1')).toMatchObject({ estadoEnvio: 1, mid: null });
    expect(client.sendMedia).not.toHaveBeenCalled();
  });
});

describe('dispatchOutbound — failures patch erro on the original', () => {
  it('send failure → estadoEnvio=erro + error text, original NOT re-anchored', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    const client = fakeClient({
      sendText: vi.fn(async () => {
        throw new WhatsAppHttpError('sendText', 400, 'invalid recipient');
      }),
    });

    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'orig-1',
      outboundDoc(),
      fakeDeps(client),
    );
    expect(res.kind).toBe('error');

    const orig = db.docs(MSG_COL).get('orig-1');
    expect(orig).toMatchObject({ estadoEnvio: 4 }); // erro
    expect(String(orig?.error)).toMatch(/400/);
    // No re-anchored doc created.
    expect(db.docs(MSG_COL).size).toBe(1);
  });

  it('a transport failure (WhatsAppNetworkError) RETHROWS for retry — not patched to erro', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    const client = fakeClient({
      sendText: vi.fn(async () => {
        throw new WhatsAppNetworkError('sendText', new Error('conn reset'));
      }),
    });

    await expect(
      dispatchOutbound(asDb(db), CONV_ID, 'orig-1', outboundDoc(), fakeDeps(client)),
    ).rejects.toBeInstanceOf(WhatsAppNetworkError);
    // The claim flipped it to `enviando` (mid still null) → the sweep re-drives it.
    const orig = db.docs(MSG_COL).get('orig-1');
    expect(orig).toMatchObject({ estadoEnvio: 2, mid: null });
  });

  it('missing token → estadoEnvio=erro with the token message, no send attempt', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    const client = fakeClient();
    const deps = fakeDeps(client, new WhatsappTokenMissingError('Conta WhatsApp não conectada.'));

    const res = await dispatchOutbound(asDb(db), CONV_ID, 'orig-1', outboundDoc(), deps);
    expect(res.kind).toBe('error');
    expect(client.sendText).not.toHaveBeenCalled();
    const orig = db.docs(MSG_COL).get('orig-1');
    expect(orig).toMatchObject({ estadoEnvio: 4 });
    expect(String(orig?.error)).toMatch(/não conectada/);
  });

  it('misconfigured conta → estadoEnvio=erro (deterministic, no throw)', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    const deps: OutboundDeps = {
      loadContext: vi.fn(async () => {
        throw new WhatsappContaNotConfiguredError('Integração não é do tipo WhatsApp.');
      }),
    };
    const res = await dispatchOutbound(asDb(db), CONV_ID, 'orig-1', outboundDoc(), deps);
    expect(res.kind).toBe('error');
    expect(db.docs(MSG_COL).get('orig-1')).toMatchObject({ estadoEnvio: 4 });
  });

  it('empty content (no anexo, no conteudo) → estadoEnvio=erro', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    const doc = outboundDoc({ conteudo: '   ' });
    db.seed(MSG_COL, 'orig-1', doc);
    const client = fakeClient();
    const res = await dispatchOutbound(asDb(db), CONV_ID, 'orig-1', doc, fakeDeps(client));
    expect(res.kind).toBe('error');
    expect(client.sendText).not.toHaveBeenCalled();
  });
});

describe('dispatchOutbound — transient errors propagate for retry', () => {
  it('rethrows a non-token/non-conta error from loadContext', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    const deps: OutboundDeps = {
      loadContext: vi.fn(async () => {
        throw Object.assign(new Error('UNAVAILABLE'), { code: 14 });
      }),
    };
    await expect(
      dispatchOutbound(asDb(db), CONV_ID, 'orig-1', outboundDoc(), deps),
    ).rejects.toThrow(/UNAVAILABLE/);
    // Not patched to erro — a retry should re-drive it cleanly.
    expect(db.docs(MSG_COL).get('orig-1')).toMatchObject({ estadoEnvio: 1 });
  });
});

describe('dispatchOutbound — markRead best-effort', () => {
  it('marks the newest inbound message read after a successful send', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    db.seed(MSG_COL, 'in-old', {
      estadoEnvio: 7,
      mid: 'wamid.old',
      timestamp: Date.parse('2026-07-15T11:00:00.000Z'),
    });
    db.seed(MSG_COL, 'in-new', {
      estadoEnvio: 7,
      mid: 'wamid.new',
      timestamp: Date.parse('2026-07-15T11:59:00.000Z'),
    });
    const client = fakeClient();

    await dispatchOutbound(asDb(db), CONV_ID, 'orig-1', outboundDoc(), fakeDeps(client));
    expect(client.markRead).toHaveBeenCalledWith('wamid.new');
    expect(client.markRead).toHaveBeenCalledTimes(1);
    // Legacy parity: the marked inbound doc gets `visualizado` stamped as a
    // millisecondsSinceEpoch INT (#484/#486).
    const inbound = db.docs(MSG_COL).get('in-new');
    expect(typeof inbound?.visualizado).toBe('number');
    expect(inbound?.visualizado).toBeGreaterThan(0);
  });

  it('a Graph markRead failure is non-fatal (send still counts as sent)', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    db.seed(MSG_COL, 'in-new', {
      estadoEnvio: 7,
      mid: 'wamid.new',
      timestamp: Date.parse('2026-07-15T11:59:00.000Z'),
    });
    const client = fakeClient({
      markRead: vi.fn(async () => {
        throw new WhatsAppHttpError('markRead', 500, 'server error');
      }),
    });

    const res = await dispatchOutbound(
      asDb(db),
      CONV_ID,
      'orig-1',
      outboundDoc(),
      fakeDeps(client),
    );
    expect(res.kind).toBe('sent');
    const newId = mensagemDocId(CONTA, 'wamid.SENT');
    expect(db.docs(MSG_COL).get(newId)).toBeDefined(); // re-anchor still happened
    // A swallowed Graph failure means the read receipt is NOT stamped.
    expect(db.docs(MSG_COL).get('in-new')?.visualizado).toBeUndefined();
  });

  it('rethrows a NON-Graph markRead failure (only Graph calls are best-effort)', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db);
    db.seed(MSG_COL, 'orig-1', outboundDoc());
    db.seed(MSG_COL, 'in-new', {
      estadoEnvio: 7,
      mid: 'wamid.new',
      timestamp: Date.parse('2026-07-15T11:59:00.000Z'),
    });
    const client = fakeClient({
      markRead: vi.fn(async () => {
        throw new Error('kaboom'); // e.g. a bug — must NOT be swallowed
      }),
    });

    await expect(
      dispatchOutbound(asDb(db), CONV_ID, 'orig-1', outboundDoc(), fakeDeps(client)),
    ).rejects.toThrow(/kaboom/);
  });
});

describe('sweepStaleOutbound', () => {
  it('re-drives stale whatsapp-origem salva mensagens and skips other origems', async () => {
    const db = new FakeDb();
    // whatsapp conversa with a stale salva message.
    seedWhatsappConversa(db, 'conv-wa');
    db.seed(
      'chat/conv-wa/mensagem',
      'm-wa',
      outboundDoc({ timestamp: Date.parse('2026-07-15T11:40:00.000Z') }),
    );
    // site conversa with a stale salva message → fast-path skip inside dispatch.
    db.seed(CHAT, 'conv-site', { origem: 'site', sender_id: SENDER });
    db.seed(
      'chat/conv-site/mensagem',
      'm-site',
      outboundDoc({ timestamp: Date.parse('2026-07-15T11:40:00.000Z') }),
    );
    // fresh salva message (inside the window) → excluded by the timestamp filter.
    seedWhatsappConversa(db, 'conv-fresh');
    db.seed(
      'chat/conv-fresh/mensagem',
      'm-fresh',
      outboundDoc({ timestamp: Date.parse('2026-07-15T11:59:30.000Z') }),
    );

    // integracaoOuterRef on conv-wa points at CONTA (contaPath derives 'conv-wa'
    // differently, but dispatch uses the conversa's own outer ref, not the id).
    const client = fakeClient();
    const now = Date.parse('2026-07-15T12:00:00.000Z');
    const result = await sweepStaleOutbound(asDb(db), { now }, fakeDeps(client));

    // Only m-wa is sent; m-site is skipped; m-fresh is outside the window.
    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(2); // m-wa (sent) + m-site (skipped) were dispatched
    expect(result.outcomes.sent).toBe(1);
    expect(result.outcomes.skipped).toBe(1);
  });

  it('passes a NUMERIC timestamp cutoff to the group query (a string bound matches zero docs)', async () => {
    // Regression guard for #484/#486: `mensagem.timestamp` is millisecondsSinceEpoch
    // INT now, so the sweep's range bound MUST be a number. A stray ISO-string
    // cutoff would silently match zero docs and kill the sweep.
    const db = new FakeDb();
    seedWhatsappConversa(db, 'conv-wa');
    db.seed(
      'chat/conv-wa/mensagem',
      'm-wa',
      outboundDoc({ timestamp: Date.parse('2026-07-15T11:40:00.000Z') }),
    );

    // Capture the `timestamp <` bound the sweep passes to the group query.
    interface QueryLike {
      where(field: string, op: string, value: unknown): QueryLike;
      orderBy(field: string, dir?: 'asc' | 'desc'): QueryLike;
      limit(n: number): QueryLike;
      get(): Promise<unknown>;
    }
    const cutoffs: unknown[] = [];
    const realGroup = db.collectionGroup.bind(db);
    const wrapQuery = (q: QueryLike): QueryLike => ({
      where: (field, op, value) => {
        if (field === 'timestamp' && op === '<') cutoffs.push(value);
        return wrapQuery(q.where(field, op, value));
      },
      orderBy: (field, dir) => wrapQuery(q.orderBy(field, dir)),
      limit: (n) => wrapQuery(q.limit(n)),
      get: () => q.get(),
    });
    (db as unknown as { collectionGroup: (g: string) => QueryLike }).collectionGroup = (g) =>
      wrapQuery(realGroup(g) as unknown as QueryLike);

    const now = Date.parse('2026-07-15T12:00:00.000Z');
    await sweepStaleOutbound(asDb(db), { now }, fakeDeps(fakeClient()));

    expect(cutoffs.length).toBeGreaterThan(0);
    for (const c of cutoffs) expect(typeof c).toBe('number');
  });

  it('re-drives a crashed claim (stale enviando + mid==null), re-anchoring it', async () => {
    const db = new FakeDb();
    // A claim that crashed between flip and re-anchor: stuck `enviando`, mid still null.
    seedWhatsappConversa(db, 'conv-crash');
    db.seed(
      'chat/conv-crash/mensagem',
      'm-crash',
      outboundDoc({ estadoEnvio: 2, mid: null, timestamp: Date.parse('2026-07-15T11:40:00.000Z') }),
    );
    const client = fakeClient();
    const now = Date.parse('2026-07-15T12:00:00.000Z');

    const result = await sweepStaleOutbound(asDb(db), { now }, fakeDeps(client));

    // The enviando pass re-claimed and re-drove it.
    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(result.outcomes.sent).toBe(1);
    expect(db.docs('chat/conv-crash/mensagem').has('m-crash')).toBe(false); // re-anchored
    expect(
      db.docs('chat/conv-crash/mensagem').get(mensagemDocId(CONTA, 'wamid.SENT')),
    ).toBeDefined();
  });

  it('does NOT re-drive an enviando doc that already carries a mid (normal awaiting-status)', async () => {
    const db = new FakeDb();
    seedWhatsappConversa(db, 'conv-anchored');
    // A successfully re-anchored send awaiting a delivery callback: enviando + mid set.
    db.seed('chat/conv-anchored/mensagem', 'm-anchored', {
      estadoEnvio: 2,
      tipo: 'c',
      conteudo: 'já enviado',
      mid: 'wamid.LIVE',
      timestamp: Date.parse('2026-07-15T11:40:00.000Z'),
    });
    const client = fakeClient();
    const now = Date.parse('2026-07-15T12:00:00.000Z');

    const result = await sweepStaleOutbound(asDb(db), { now }, fakeDeps(client));

    expect(client.sendText).not.toHaveBeenCalled();
    expect(result.outcomes.skipped ?? 0).toBeGreaterThanOrEqual(1);
    // The live re-anchored doc is untouched.
    expect(db.docs('chat/conv-anchored/mensagem').get('m-anchored')).toMatchObject({
      mid: 'wamid.LIVE',
      estadoEnvio: 2,
    });
  });
});
