import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { encodeHorarioMs } from '@delfrance/schemas';

// Isolate the messages pipeline from contact resolution + media storage (both
// have their own suites). The conta lookup, conversa/mensagem writes, status
// matrix, auto-reply dedupe and the sweep all run REAL against the fake db.
vi.mock('./discoverUser', () => ({
  discoverUserByPhoneNumber: vi.fn(async () => ({ id: 'user-1', usuario: { nome: 'Fulano' } })),
  fixConversaAnonima: vi.fn(async () => {}),
  usuarioOuterRef: (id: string) => `documents/usuarios/${id}`,
}));

const media = vi.hoisted(() => ({
  getAndUploadMedia: vi.fn(
    async (_ctx: unknown, mediaId: string) => `documents/arquivos/wa_${mediaId}`,
  ),
}));
vi.mock('./media', () => ({ getAndUploadMedia: media.getAndUploadMedia }));

const {
  MAX_TENTATIVAS,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
  parseWebhookBody,
  reprocessNotifications,
} = await import('./notificacao');
const { conversaDocId, mensagemDocId, senderId } = await import('./ids');

/* ----------------------------- fake Firestore ---------------------------- */

type DocData = Record<string, unknown>;
type Clause = { field: string; op: string; value: unknown };

function matches(data: DocData, clauses: Clause[]): boolean {
  return clauses.every((c) => {
    const v = data[c.field];
    if (c.op === '==') return v === c.value;
    if (c.op === '<') return typeof v === 'number' && v < (c.value as number);
    return false;
  });
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

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    const query = (clauses: Clause[], orderField: string | null, lim: number | null) => ({
      where: (field: string, op: string, value: unknown) =>
        query([...clauses, { field, op, value }], orderField, lim),
      orderBy: (field: string) => query(clauses, field, lim),
      limit: (n: number) => query(clauses, orderField, n),
      get: async () => {
        let rows = [...col.entries()].filter(([, d]) => matches(d, clauses));
        if (orderField) {
          rows.sort(
            (a, b) => ((a[1][orderField] as number) ?? 0) - ((b[1][orderField] as number) ?? 0),
          );
        }
        if (lim != null) rows = rows.slice(0, lim);
        return { docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })) };
      },
    });
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        return {
          id: docId,
          get: async () => ({ exists: col.has(docId), id: docId, data: () => col.get(docId) }),
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
          },
          create: async (data: DocData) => {
            if (col.has(docId)) throw Object.assign(new Error('already exists'), { code: 6 });
            col.set(docId, { ...data });
          },
          delete: async () => {
            col.delete(docId);
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        query([{ field, op, value }], null, null),
      orderBy: (field: string) => query([], field, null),
      limit: (n: number) => query([], null, n),
      get: async () => ({
        docs: [...col.entries()].map(([id, d]) => ({ id, data: () => d, exists: true })),
      }),
    };
  }

  async runTransaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
    const txn = {
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: { set: (d: DocData, o?: unknown) => Promise<void> }, d: DocData, o?: unknown) => {
        void ref.set(d, o);
      },
    };
    return fn(txn);
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;
const INTEG = 'integracao';
const NOTIF = 'notificacoesWhatsapp';
const PNID = 'PNID1';
const DISPLAY = '5511000000000';
const FROM = '5511999999999';
const CONTA = 'conta-1';

const SENDER = senderId(DISPLAY, FROM);
const CONV_ID = conversaDocId(CONTA, SENDER);
const CONV_PATH = `chat/${CONV_ID}/mensagem`;

function seedConta(db: FakeDb, over: DocData = {}): void {
  db.seed(INTEG, CONTA, { tipo: 6, wa_id: PNID, nome: 'WA', cor: 5, ...over });
}

function inboundValue(over: DocData = {}): DocData {
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: DISPLAY, phone_number_id: PNID },
    contacts: [{ profile: { name: 'Fulano' }, wa_id: FROM }],
    messages: [
      { from: FROM, id: 'wamid.A', timestamp: '1700000000', type: 'text', text: { body: 'oi' } },
    ],
    ...over,
  };
}

function messagesPayload(value: DocData): DocData {
  const v = value as {
    metadata?: { phone_number_id?: string };
    messages?: Array<{ id: string }>;
    statuses?: Array<{ id: string }>;
  };
  return {
    field: 'messages',
    phoneNumberId: v.metadata?.phone_number_id ?? null,
    messageId: v.messages?.[0]?.id ?? v.statuses?.[0]?.id ?? null,
    value,
  };
}

const deps = { mediaContext: vi.fn(async () => ({}) as never) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/* ------------------------------- parse ----------------------------------- */

describe('parseWebhookBody', () => {
  it('returns one payload per change for a valid envelope', () => {
    const out = parseWebhookBody({
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [{ field: 'messages', value: inboundValue() }] }],
    });
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ field: 'messages', phoneNumberId: PNID, messageId: 'wamid.A' });
  });

  it('returns null for a non-envelope body', () => {
    expect(parseWebhookBody({ hello: 'world' })).toBeNull();
    expect(parseWebhookBody(null)).toBeNull();
  });
});

/* -------------------------- disposition + conta -------------------------- */

describe('handleNotificationTask — dispatch & disposition', () => {
  it('unsupported field → dropped, no persist', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(
      asDb(db),
      { field: 'message_template_status_update', phoneNumberId: null, messageId: null, value: {} },
      0,
      deps,
    );
    expect(r.outcome).toBe('dropped');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('malformed value payload → dropped, no persist', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(asDb(db), messagesPayload({ garbage: true }), 0, deps);
    expect(r.outcome).toBe('dropped');
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('malformed TASK payload (empty field) → dropped', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(asDb(db), { field: '', value: {} }, 0, deps);
    expect(r.outcome).toBe('dropped');
  });

  it('conta not found (0 matches) → failed park, persisted with the replay value', async () => {
    const db = new FakeDb();
    const value = inboundValue();
    const r = await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps);
    expect(r.outcome).toBe('failed');
    const doc = db.docs(NOTIF).get('wamid.A')!;
    expect(doc.status).toBe('failed');
    expect(doc.messageId).toBe('wamid.A');
    expect(doc.value).toBeTruthy(); // value carried for replay (WA can't refetch)
  });

  it('ambiguous conta (2 matches) → failed park', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed(INTEG, 'conta-2', { tipo: 6, wa_id: PNID, nome: 'WA2' });
    const r = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(r.outcome).toBe('failed');
  });

  it('happy path → done, persists NOTHING (the cost win)', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(r).toMatchObject({ outcome: 'done', contaId: CONTA });
    expect(db.docs(NOTIF).size).toBe(0);
  });

  it('transient Firestore error re-throws under the cap; persists on the final attempt', async () => {
    const db = new FakeDb();
    seedConta(db);
    // Break the conversa transaction read to model a transient Firestore failure.
    const boom = () => {
      throw new Error('firestore unavailable');
    };
    const brokenDb = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'runTransaction') return boom;
        return Reflect.get(target, prop, recv);
      },
    });
    await expect(
      handleNotificationTask(asDb(brokenDb as FakeDb), messagesPayload(inboundValue()), 0, deps),
    ).rejects.toThrow('firestore unavailable');
    expect(db.docs(NOTIF).size).toBe(0);

    const r = await handleNotificationTask(
      asDb(brokenDb as FakeDb),
      messagesPayload(inboundValue()),
      TASK_MAX_ATTEMPTS - 1,
      deps,
    );
    expect(r.outcome).toBe('failed');
    expect(db.docs(NOTIF).get('wamid.A')!.status).toBe('failed');
  });
});

/* --------------------- conversa create / reopen / spam ------------------- */

describe('conversa create / reopen / spam', () => {
  it('new conversa → created with a Nova conversa event + inbound mensagem', async () => {
    const db = new FakeDb();
    seedConta(db);
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);

    const conv = db.docs('chat').get(CONV_ID)!;
    expect(conv.origem).toBe('whatsapp');
    expect(conv.estadoConversa).toBe(0);
    expect(conv.sender_id).toBe(SENDER);
    expect(conv.cor_etiqueta).toBe(5);
    expect(conv.externalLink).toBe(`https://api.whatsapp.com/send?phone=${FROM}`);

    const evento = db.docs(CONV_PATH).get('evento_nova')!;
    expect(evento.tipo).toBe('e');
    expect(String(evento.conteudo)).toContain('Nova conversa iniciada por Fulano');

    const msg = db.docs(CONV_PATH).get(mensagemDocId(CONTA, 'wamid.A'))!;
    expect(msg.estadoEnvio).toBe(7); // recebido
    expect(msg.conteudo).toBe('oi');
    expect(msg.mid).toBe('wamid.A');
  });

  it('reopenable conversa → naoRespondido + fresh prazo + reaberto event', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, {
      estadoConversa: 2, // atendimentoFinalizado (reopenable)
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z',
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs('chat').get(CONV_ID)!.estadoConversa).toBe(0);
    expect(db.docs(CONV_PATH).has('evento_reaberto_wamid.A')).toBe(true);
  });

  it('spam conversa → mensagem NOT created', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, { estadoConversa: 99, sender_id: SENDER, nome: 'Fulano' });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.A'))).toBe(false);
  });

  it('out-of-order message → conversa untouched, but mensagem still written', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, {
      estadoConversa: 1, // emResposta (not reopenable)
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2030-01-01T00:00:00.000Z', // newer than the message
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    // conversa's ultimaModificacaoIntegracao unchanged
    expect(db.docs('chat').get(CONV_ID)!.ultimaModificacaoIntegracao).toBe(
      '2030-01-01T00:00:00.000Z',
    );
    // mensagem still created
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.A'))).toBe(true);
  });

  it('in-order message on a NON-reopenable conversa → guard frozen (legacy no-save parity)', async () => {
    // Legacy assigns ultimaModificacaoIntegracao in memory but never persists
    // it on this branch (messages.dart:133-135) — the stored guard freezes
    // until the next create/reopen. Advancing it here would silently stop a
    // late out-of-order customer message from reopening a since-finalized
    // ticket (see the parity note in processMessages.ts).
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, {
      estadoConversa: 1, // emResposta (not reopenable)
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z', // older than the message
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    const conv = db.docs('chat').get(CONV_ID)!;
    // Guard NOT advanced, estado untouched…
    expect(conv.ultimaModificacaoIntegracao).toBe('2020-01-01T00:00:00.000Z');
    expect(conv.estadoConversa).toBe(1);
    // …the recency field IS bumped (the separate guarded merge — orthogonal to
    // the ultimaModificacaoIntegracao freeze; a new message resurfaces the ticket)…
    expect(conv.ultima_modificacao).toBe(1700000000000);
    // …and the mensagem is written normally.
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.A'))).toBe(true);
  });
});

/* -------------------------- ultima_modificacao bump ---------------------- */

describe('ultima_modificacao recency bump', () => {
  const MSG_MS = 1700000000000; // the inbound message ts ('1700000000' s × 1000)

  it('create carries ultima_modificacao = the message timestamp', async () => {
    const db = new FakeDb();
    seedConta(db);
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs('chat').get(CONV_ID)!.ultima_modificacao).toBe(MSG_MS);
  });

  it('reopen bumps ultima_modificacao alongside the reopen', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, {
      estadoConversa: 2, // atendimentoFinalizado (reopenable)
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z',
      ultima_modificacao: 1000, // stale recency
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs('chat').get(CONV_ID)!.ultima_modificacao).toBe(MSG_MS);
  });

  it('resurfaces an in-progress (emResposta) conversa on a new inbound message', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, {
      estadoConversa: 1, // emResposta — in-order, not reopenable (the no-save quirk branch)
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z', // older than the message
      ultima_modificacao: 1000, // stale recency
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    // The separate guarded merge bumps the recency field forward…
    expect(db.docs('chat').get(CONV_ID)!.ultima_modificacao).toBe(MSG_MS);
    // …while the ultimaModificacaoIntegracao freeze (quirk) stays untouched.
    expect(db.docs('chat').get(CONV_ID)!.ultimaModificacaoIntegracao).toBe(
      '2020-01-01T00:00:00.000Z',
    );
  });

  it('out-of-order redelivery does NOT move ultima_modificacao backwards', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, {
      estadoConversa: 1, // emResposta → mensagem written, the guarded merge is attempted
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z',
      ultima_modificacao: MSG_MS + 100_000, // already NEWER than the incoming message
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    // Monotonic guard: the older message never moves it back.
    expect(db.docs('chat').get(CONV_ID)!.ultima_modificacao).toBe(MSG_MS + 100_000);
    // The mensagem is still written (out-of-order path parity).
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.A'))).toBe(true);
  });

  it('a redelivery (no mensagem write) does not touch ultima_modificacao', async () => {
    const db = new FakeDb();
    seedConta(db);
    const msgId = mensagemDocId(CONTA, 'wamid.A');
    db.seed('chat', CONV_ID, {
      estadoConversa: 1,
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z',
      ultima_modificacao: 555, // a sentinel the redelivery must not overwrite
    });
    // Prior mensagem already at/after the incoming ts → createOrUpdateMensagem skips.
    db.seed(CONV_PATH, msgId, {
      conteudo: 'ORIGINAL',
      mid: 'wamid.A',
      timestamp: new Date(MSG_MS).toISOString(),
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs('chat').get(CONV_ID)!.ultima_modificacao).toBe(555); // untouched
  });
});

/* ------------------------- mensagem dedup + media ------------------------ */

describe('mensagem dedup + media population', () => {
  it('mid+timestamp dedup: an existing doc at/after the timestamp is not overwritten', async () => {
    const db = new FakeDb();
    seedConta(db);
    const msgId = mensagemDocId(CONTA, 'wamid.A');
    // Seed an existing doc whose ISO timestamp equals the incoming message ts
    // (1700000000 s) — a redelivery → the dedup skips the overwrite.
    db.seed(CONV_PATH, msgId, {
      conteudo: 'ORIGINAL',
      mid: 'wamid.A',
      timestamp: new Date(1700000000000).toISOString(),
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs(CONV_PATH).get(msgId)!.conteudo).toBe('ORIGINAL'); // untouched
  });

  it('downloads + populates media sub-objects', async () => {
    const db = new FakeDb();
    seedConta(db);
    const value = inboundValue({
      messages: [
        {
          from: FROM,
          id: 'wamid.IMG',
          timestamp: '1700000000',
          type: 'image',
          image: { id: 'MED1', caption: 'foto' },
        },
      ],
    });
    await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps);
    expect(media.getAndUploadMedia).toHaveBeenCalledWith(expect.anything(), 'MED1');
    const msg = db.docs(CONV_PATH).get(mensagemDocId(CONTA, 'wamid.IMG'))!;
    expect(msg.tipo).toBe('f');
    expect(msg.image).toEqual({ image: 'documents/arquivos/wa_MED1', caption: 'foto' });
  });
});

/* ------------------------------- auto-reply ------------------------------ */

describe('auto-reply in/out of hours + daily dedupe', () => {
  const NOW = new Date('2026-07-15T12:00:00Z');
  const WEEKDAY_KEYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const dayKey = NOW.toISOString().slice(0, 10);

  function horarioConta(over: DocData = {}): DocData {
    const key = WEEKDAY_KEYS[NOW.getUTCDay()]!;
    return {
      tipo: 6,
      wa_id: PNID,
      nome: 'WA',
      cor: 0,
      horario_funcionamento: [
        { [key]: { abertura: encodeHorarioMs(8, 0), fechamento: encodeHorarioMs(18, 0) } },
      ],
      mensagem_automatica: 'Olá! (dentro)',
      mensagem_inatividade: 'Fora do horário.',
      ...over,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('in-hours → writes an outbound (salva, tipo c) mensagem_automatica + stamps the conversa', async () => {
    const db = new FakeDb();
    seedConta(db, horarioConta());
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    const reply = db.docs(CONV_PATH).get(`autoreply_dentro_${dayKey}`)!;
    expect(reply.conteudo).toBe('Olá! (dentro)');
    expect(reply.estadoEnvio).toBe(1); // salva → PR-3 sends it (tipo 'c' ≠ 'e')
    expect(reply.tipo).toBe('c');
    // Written as millisecondsSinceEpoch INT (#484/#486).
    expect(db.docs('chat').get(CONV_ID)!.recebido_durante_atendimento).toBe(NOW.getTime());
    // The auto-reply is fresh activity → recency bumped to its own (now) timestamp.
    expect(db.docs('chat').get(CONV_ID)!.ultima_modificacao).toBe(NOW.getTime());
  });

  it('out-of-hours (20:00Z) → writes mensagem_inatividade', async () => {
    vi.setSystemTime(new Date('2026-07-15T20:00:00Z'));
    const db = new FakeDb();
    seedConta(db, horarioConta());
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs(CONV_PATH).get(`autoreply_fora_${dayKey}`)!.conteudo).toBe('Fora do horário.');
  });

  it('daily dedupe: no reply when the conversa already got one today', async () => {
    const db = new FakeDb();
    seedConta(db, horarioConta());
    db.seed('chat', CONV_ID, {
      estadoConversa: 2, // reopenable so the message is processed
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z',
      recebido_durante_atendimento: NOW.toISOString(), // already replied today
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs(CONV_PATH).has(`autoreply_dentro_${dayKey}`)).toBe(false);
  });

  it('no auto-reply when the account has no horario_funcionamento', async () => {
    const db = new FakeDb();
    seedConta(db); // no horario_funcionamento
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect([...db.docs(CONV_PATH).keys()].some((k) => k.startsWith('autoreply_'))).toBe(false);
  });
});

/* ---------------------------- status transitions ------------------------- */

describe('status transition matrix', () => {
  const OUT_WAMID = 'wamid.OUT';
  const OUT_MSG_ID = mensagemDocId(CONTA, OUT_WAMID);

  function statusValue(status: string, timestamp: string): DocData {
    return {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: DISPLAY, phone_number_id: PNID },
      statuses: [{ id: OUT_WAMID, recipient_id: FROM, status, timestamp }],
    };
  }

  it('delivered advances enviando → enviado and stamps lastExternalUpdateDateTime', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed(CONV_PATH, OUT_MSG_ID, { estadoEnvio: 2, mid: OUT_WAMID }); // enviando
    await handleNotificationTask(
      asDb(db),
      messagesPayload(statusValue('delivered', '1700000100')),
      0,
      deps,
    );
    const msg = db.docs(CONV_PATH).get(OUT_MSG_ID)!;
    expect(msg.estadoEnvio).toBe(3); // enviado
    // millisecondsSinceEpoch INT (#484/#486): the WA unix-second ts × 1000.
    expect(msg.lastExternalUpdateDateTime).toBe(1700000100000);
  });

  it('read sets recebido + visualizado', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed(CONV_PATH, OUT_MSG_ID, { estadoEnvio: 3, mid: OUT_WAMID });
    await handleNotificationTask(
      asDb(db),
      messagesPayload(statusValue('read', '1700000200')),
      0,
      deps,
    );
    const msg = db.docs(CONV_PATH).get(OUT_MSG_ID)!;
    expect(msg.estadoEnvio).toBe(7); // recebido
    // millisecondsSinceEpoch INT (#484/#486).
    expect(msg.visualizado).toBe(1700000200000);
  });

  it('failed appends an error entry and sets erro', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed(CONV_PATH, OUT_MSG_ID, { estadoEnvio: 2, mid: OUT_WAMID });
    const value = statusValue('failed', '1700000100');
    (value.statuses as Array<Record<string, unknown>>)[0]!.errors = [
      { code: 131026, title: 'Undeliverable', message: 'not on WhatsApp' },
    ];
    await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps);
    const msg = db.docs(CONV_PATH).get(OUT_MSG_ID)!;
    expect(msg.estadoEnvio).toBe(4); // erro
    expect((msg.errors as Array<{ code: number }>)[0]!.code).toBe(131026);
  });

  it('out-of-order stale status is skipped by the forward-only matrix', async () => {
    const db = new FakeDb();
    seedConta(db);
    // enviado(3) already, last update NEWER than the incoming delivered → skip.
    db.seed(CONV_PATH, OUT_MSG_ID, {
      estadoEnvio: 3,
      mid: OUT_WAMID,
      lastExternalUpdateDateTime: new Date(1700000200000).toISOString(),
    });
    await handleNotificationTask(
      asDb(db),
      messagesPayload(statusValue('delivered', '1700000100')),
      0,
      deps,
    );
    expect(db.docs(CONV_PATH).get(OUT_MSG_ID)!.estadoEnvio).toBe(3); // unchanged
  });

  it('stale but forward-eligible status IS applied (enviando ← delivered stale)', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed(CONV_PATH, OUT_MSG_ID, {
      estadoEnvio: 2, // enviando — delivered still advances it even when stale
      mid: OUT_WAMID,
      lastExternalUpdateDateTime: new Date(1700000200000).toISOString(),
    });
    await handleNotificationTask(
      asDb(db),
      messagesPayload(statusValue('delivered', '1700000100')),
      0,
      deps,
    );
    expect(db.docs(CONV_PATH).get(OUT_MSG_ID)!.estadoEnvio).toBe(3);
  });

  it('status for an unknown mensagem is skipped (soft miss)', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(
      asDb(db),
      messagesPayload(statusValue('read', '1700000100')),
      0,
      deps,
    );
    expect(r.outcome).toBe('done'); // no throw, nothing to update
  });
});

/* ------------------------------ reprocess sweep -------------------------- */

describe('reprocessNotifications', () => {
  function seedFailed(db: FakeDb, id: string, over: DocData = {}): void {
    db.seed(NOTIF, id, {
      field: 'messages',
      phoneNumberId: PNID,
      messageId: id,
      status: 'failed',
      tentativas: 0,
      erro: 'conta not linked',
      processedAt: 1_000,
      value: inboundValue({
        messages: [{ from: FROM, id, timestamp: '1700000000', type: 'text', text: { body: 'oi' } }],
      }),
      ...over,
    });
  }

  it('re-drives a failed doc: still-unlinked → tentativas++ (failed), parks at the cap', async () => {
    const db = new FakeDb(); // no conta → still fails
    seedFailed(db, 'wamid.A', { tentativas: 0 });
    seedFailed(db, 'wamid.B', { tentativas: MAX_TENTATIVAS - 1 });
    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 }, deps);
    expect(res.outcomes.failed).toBe(1);
    expect(res.outcomes.parked).toBe(1);
    expect(db.docs(NOTIF).get('wamid.A')!.tentativas).toBe(1);
    expect(db.docs(NOTIF).get('wamid.B')!.status).toBe('parked');
  });

  it('deletes the doc once the account links and it processes', async () => {
    const db = new FakeDb();
    seedConta(db); // account now connected
    seedFailed(db, 'wamid.A');
    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 }, deps);
    expect(res.outcomes.processed).toBe(1);
    expect(db.docs(NOTIF).has('wamid.A')).toBe(false);
    // and the replayed message actually landed
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.A'))).toBe(true);
  });

  it('dedups by messageId and skips docs newer than the window', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedFailed(db, 'wamid.A', { messageId: 'dup' });
    seedFailed(db, 'wamid.A2', { messageId: 'dup' }); // same messageId → deduped
    seedFailed(db, 'wamid.C', { messageId: 'wamid.C', processedAt: 9_999_999_999 }); // too new
    const res = await reprocessNotifications(asDb(db), { now: 10_000, olderThanMs: 100 }, deps);
    expect(res.processed).toBe(1); // only the first 'dup'
  });
});
