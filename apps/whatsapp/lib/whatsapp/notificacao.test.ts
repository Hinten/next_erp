import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ESTADO_ENVIO, encodeHorarioMs } from '@delfrance/schemas';

// Only media storage is stubbed. The contact resolver, canonical registries,
// pending persistence, conversation lifecycle and status processing run real.
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
const { conversaWhatsappKey, identidadeWhatsappId } = await import('./contatos');
const { confirmarVinculoWhatsapp, confirmarVinculoSchema } = await import('./vinculos');
const { replayVinculoWhatsapp } = await import('./vinculoReplay');
const { processMessagesField } = await import('./processMessages');
const { WhatsappVinculoConflitoError } = await import('./contatos');
const { conversaDocId, mensagemDocId, senderId } = await import('./ids');

/* ----------------------------- fake Firestore ---------------------------- */

type DocData = Record<string, unknown>;
type Clause = { field: string; op: string; value: unknown };

function matches(data: DocData, clauses: Clause[]): boolean {
  return clauses.every((c) => {
    const v = data[c.field];
    if (c.op === '==') return v === c.value;
    if (c.op === 'in') return Array.isArray(c.value) && c.value.includes(v);
    if (c.op === '<') return typeof v === 'number' && v < (c.value as number);
    return false;
  });
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  private autoN = 0;
  beforeDocRead?: (path: string, id: string) => void;
  beforeTransaction?: () => void;

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
    // Imported outbound messages already have the migration's wamid registry.
    if (path === CONV_PATH && typeof data.mid === 'string')
      this.col('whatsappMensagens').set(mensagemDocId(CONTA, data.mid), {
        integracaoId: CONTA,
        conversaId: CONV_ID,
        mensagemId: id,
      });
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
        return {
          size: rows.length,
          empty: rows.length === 0,
          docs: rows.map(([id, d]) => ({
            id,
            data: () => d,
            exists: true,
            ref: {
              update: async (patch: DocData) => {
                if (!col.has(id)) throw new Error('document not found');
                col.set(id, { ...col.get(id), ...patch });
              },
            },
          })),
        };
      },
    });
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        return {
          id: docId,
          get: async () => {
            self.beforeDocRead?.(path, docId);
            return { exists: col.has(docId), id: docId, data: () => col.get(docId) };
          },
          update: async (data: DocData) => {
            if (!col.has(docId)) throw new Error('document not found');
            col.set(docId, { ...col.get(docId), ...data });
          },
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
    this.beforeTransaction?.();
    const writes: Array<() => Promise<void>> = [];
    const txn = {
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: { set: (d: DocData, o?: unknown) => Promise<void> }, d: DocData, o?: unknown) => {
        writes.push(() => ref.set(d, o));
      },
      update: (ref: { set: (d: DocData, o?: unknown) => Promise<void> }, d: DocData) => {
        writes.push(() => ref.set(d, { merge: true }));
      },
      create: (ref: { create: (d: DocData) => Promise<void> }, d: DocData) => {
        writes.push(() => ref.create(d));
      },
    };
    const result = await fn(txn);
    for (const write of writes) await write();
    return result;
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
/** The re-anchored outbound doc id a status callback resolves to. */
const OUT_MSG_ID_FOR_REPLAY = mensagemDocId(CONTA, 'wamid.OUT');

function seedConta(db: FakeDb, over: DocData = {}): void {
  db.seed(INTEG, CONTA, { tipo: 6, wa_id: PNID, nome: 'WA', cor: 5, ...over });
  db.seed('clientes', 'cliente-1', { nome: 'Fulano', telefone: FROM, telefoneGerenciado: true });
  // The migration reserves the historical chat id; new inbound must continue it.
  db.seed('whatsappConversas', conversaWhatsappKey(CONTA, 'cliente-1'), {
    integracaoId: CONTA,
    clienteId: 'cliente-1',
    conversaId: CONV_ID,
  });
}

/**
 * A complete `StatusesReport` with every counter zeroed but the named ones.
 *
 * ⚠️ Still EXACT — `toEqual` against the full object pins all five keys, so a
 * counter that moves when it should not still fails. It only keeps the zeros
 * from being retyped; `toMatchObject` would actually narrow the check.
 */
function statusesReport(counts: Record<string, number>): Record<string, number> {
  return {
    aplicados: 0,
    naoEncontrados: 0,
    staleIgnorados: 0,
    malformados: 0,
    desconhecidos: 0,
    ...counts,
  };
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
  // The `wa_id` lookup and the conta reader are module-scope, and the reader is
  // keyed by the document PATH — so a fresh `FakeDb` per test does NOT isolate
  // either, and `PNID1` / `conta-1` recur throughout this file with deliberately
  // different seeded state (an unlinked account, an ambiguous one, a happy one).
  __resetAllReadCaches();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __resetAllReadCaches();
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

  /**
   * ⚠️ The ASYMMETRY between the two arrays, and why it is not an oversight.
   *
   * A dropped `statuses[]` element is cheap: the next status update for that
   * wamid re-stamps `estadoEnvio` from scratch, so the information is
   * re-derivable and `resolve` is right. A dropped `messages[]` element is a
   * CUSTOMER MESSAGE THAT EXISTS NOWHERE ELSE — WhatsApp has no re-fetch anchor,
   * which is the entire reason this channel (alone in the repo) persists the raw
   * change `value` for the sweep to REPLAY.
   *
   * Resolving such a change would leave that recovery path unused in exactly the
   * case it was built for: the body would be acked and discarded, with only a
   * counter behind it. So a change that could not read a message persists, and
   * a re-drive after `incomingMessageSchema` is widened recovers it.
   */
  it('a change with an UNREADABLE message persists the body for replay, not just a counter', async () => {
    const db = new FakeDb();
    seedConta(db);
    const value = inboundValue({
      messages: [
        { id: 'wamid.BAD' }, // fails `incomingMessageSchema`
        { from: FROM, id: 'wamid.A', timestamp: '1700000000', type: 'text', text: { body: 'oi' } },
      ],
    });
    const r = await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps);

    // The good sibling still landed — persisting is for RECOVERY, not a rollback.
    expect(db.docs(CONV_PATH).get(mensagemDocId(CONTA, 'wamid.A'))?.conteudo).toBe('oi');
    // ...and the raw body survives, keyed for the sweep.
    const doc = db.docs(NOTIF).get('wamid.BAD')!;
    expect(doc.status).toBe('failed');
    expect(doc.value).toBeTruthy();
    expect(r.outcome).toBe('failed');
    // The counter still rides out beside it — the doc says WHAT to replay, the
    // counter says an element was unreadable at all.
    expect(r.mensagens).toEqual({ malformados: 1 });
  });

  it('a change whose statuses[] alone was unreadable RESOLVES — that loss is re-derivable', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed(CONV_PATH, OUT_MSG_ID_FOR_REPLAY, { estadoEnvio: 2, mid: 'wamid.OUT' });
    const value = {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: DISPLAY, phone_number_id: PNID },
      statuses: [
        { id: 'wamid.BADSTATUS' }, // fails `statusUpdateSchema`
        { id: 'wamid.OUT', recipient_id: FROM, status: 'delivered', timestamp: '1700000100' },
      ],
    };
    const r = await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps);

    // ⚠️ The other half of the asymmetry: nothing is persisted, because the next
    // status callback for that wamid re-stamps the state anyway.
    expect(r.outcome).toBe('done');
    expect(db.docs(NOTIF).size).toBe(0);
    expect(r.statuses).toEqual(statusesReport({ aplicados: 1, malformados: 1 }));
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

/* ------------------ what the change actually did (#1087) ----------------- */

/**
 * ⚠️ The regression these guard against is INVISIBLE without them.
 *
 * `processed` is a disposition, not a claim that work happened: a delivered
 * inbound message, an idempotent redelivery of one already stored, and an
 * `errors`-only change that touched nothing at all ALL resolve to it. On Mercado
 * Livre's first live run (#1087) the task handler logged a bare success for
 * every delivery while nothing was being written, and no field could say which
 * had occurred.
 *
 * The property under test is not "detail is present" — it is that runs which DID
 * different things REPORT differently. `createOrUpdateMensagem`'s boolean was
 * discarded at its only call site, so dropping it again (or dropping `detail`
 * from the projection) would restore the blindness while leaving every other
 * assertion in this file green.
 */
describe('handleNotificationTask — reports what it actually did (#1087)', () => {
  /** A `messages` change carrying neither messages nor statuses. */
  function errorsOnlyValue(): DocData {
    return {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: DISPLAY, phone_number_id: PNID },
      errors: [{ code: 131051, title: 'Unsupported message type' }],
    };
  }

  function statusOnlyValue(): DocData {
    return {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: DISPLAY, phone_number_id: PNID },
      statuses: [
        { id: 'wamid.OUT', recipient_id: FROM, status: 'delivered', timestamp: '1700000100' },
      ],
    };
  }

  it('a delivered inbound message reports that a mensagem was written', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(r).toMatchObject({
      outcome: 'done',
      kind: 'processed',
      detail: 'mensagens',
      contaId: CONTA,
    });
    // The inbound mensagem itself — the conversa also carries a `nova conversa`
    // EVENT doc, so a bare collection count would not say a message landed.
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.A'))).toBe(true);
  });

  it('THE #1087 SHAPE: an errors-only change wrote nothing, and now says so', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(asDb(db), messagesPayload(errorsOnlyValue()), 0, deps);
    expect(r).toMatchObject({ outcome: 'done', kind: 'processed', detail: 'vazio' });
    // And it really did nothing — no conversa, no mensagem. That is the whole
    // point: `done` alone was indistinguishable from the happy path above.
    expect(db.docs('chat').size).toBe(0);
    expect(db.docs(CONV_PATH).size).toBe(0);
  });

  it('a REDELIVERY of the same message is not a second write', async () => {
    const db = new FakeDb();
    seedConta(db);
    const first = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    const second = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(first.detail).toBe('mensagens');
    expect(second.detail).toBe('redelivery');
    // Both are `done`; only `detail` separates them.
    expect(second.outcome).toBe('done');
    // The redelivery converged on the same doc rather than forking one.
    const depois = db.docs(CONV_PATH).size;
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs(CONV_PATH).size).toBe(depois);
  });

  it('messages arriving WITH statuses are an outbound echo, not an inbound write', async () => {
    const db = new FakeDb();
    seedConta(db);
    const value = inboundValue({
      statuses: [
        { id: 'wamid.OUT', recipient_id: FROM, status: 'delivered', timestamp: '1700000100' },
      ],
    });
    // The outbound mensagem the echo's status callback is about.
    db.seed(CONV_PATH, mensagemDocId(CONTA, 'wamid.OUT'), {
      estadoEnvio: ESTADO_ENVIO.enviando,
      mid: 'wamid.OUT',
    });
    const r = await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps);
    expect(r).toMatchObject({ outcome: 'done', detail: 'echo' });
    // An echo changes only the located outbound message; it does not resolve a contact.
    expect(db.docs('chat').size).toBe(0);
    expect(db.docs('whatsappIdentidades').size).toBe(0);
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.A'))).toBe(false);
    // ⚠️ `echo` outranks `statuses` in the priority chain, so this arm used to
    // HIDE the status work entirely. The report rides out regardless of which arm
    // won — which is why the chain did not have to be reshuffled to fix it.
    expect(r.statuses).toEqual(statusesReport({ aplicados: 1 }));
  });

  /**
   * ⚠️ These two are a PAIR, and neither alone is the property.
   *
   * `statusOnlyValue()` seeds no mensagem, so its every status is a soft miss —
   * yet before #1478's follow-up this very test asserted `detail: 'statuses'`
   * and nothing else, which is the OVERSTATEMENT encoded as expected behaviour:
   * identical to a batch that advanced every mensagem. `detail` still says
   * `statuses` (a batch ran, which is true); the report beside it is what says
   * whether anything LANDED.
   */
  it('a statuses-only change that landed NOTHING says so', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(asDb(db), messagesPayload(statusOnlyValue()), 0, deps);
    expect(r).toMatchObject({
      outcome: 'done',
      detail: 'statuses',
      statuses: { aplicados: 0, naoEncontrados: 1, staleIgnorados: 0 },
    });
  });

  it('a statuses-only change that DID land reports the same `detail`, a different report', async () => {
    const db = new FakeDb();
    seedConta(db);
    // The outbound mensagem the status callback is about, at the deterministic id.
    db.seed(CONV_PATH, mensagemDocId(CONTA, 'wamid.OUT'), {
      estadoEnvio: ESTADO_ENVIO.enviando,
      mid: 'wamid.OUT',
    });
    const r = await handleNotificationTask(asDb(db), messagesPayload(statusOnlyValue()), 0, deps);
    expect(r).toMatchObject({
      outcome: 'done',
      detail: 'statuses',
      statuses: { aplicados: 1, naoEncontrados: 0, staleIgnorados: 0 },
    });
  });

  it('a change with NO statuses key reports the report as absent, not as zeros', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(r.detail).toBe('mensagens');
    expect(r.statuses).toBeUndefined();
  });

  it('a change WITH messages reports the mensagens report, absent when it has none', async () => {
    const db = new FakeDb();
    seedConta(db);
    const comMensagens = await handleNotificationTask(
      asDb(db),
      messagesPayload(inboundValue()),
      0,
      deps,
    );
    // A clean batch still reports — zero is an answer, and it is what makes a
    // LATER nonzero readable as a change rather than a new key appearing.
    expect(comMensagens.mensagens).toEqual({ malformados: 0 });

    const semMensagens = await handleNotificationTask(
      asDb(db),
      messagesPayload(statusOnlyValue()),
      0,
      deps,
    );
    // Absent, not zeros — "the change carried no messages[]" is a different fact
    // from "it carried some and all of them were fine".
    expect(semMensagens.mensagens).toBeUndefined();
  });

  it('THE PROPERTY: a malformed message is counted, and its good sibling is STILL written', async () => {
    // ⚠️ This is the whole point of element tolerance. Before it, the bad entry
    // failed the array, the array failed the value, the value failed the ENVELOPE,
    // and `parseWebhookBody` returned null — so the receiver acked 200 and this
    // customer message was lost with no task, no failure doc and no log line.
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(
      asDb(db),
      messagesPayload(
        inboundValue({
          messages: [
            { id: 'wamid.BAD' }, // no `from` / `timestamp` / `type`
            {
              from: FROM,
              id: 'wamid.A',
              timestamp: '1700000000',
              type: 'text',
              text: { body: 'oi' },
            },
          ],
        }),
      ),
      0,
      deps,
    );

    // ⚠️ `failed`, not `done`, and that is the design: an unreadable customer
    // message persists the raw body for replay (WhatsApp has no re-fetch
    // anchor). `detail` still reports that real mensagens were written — the
    // disposition is about what is left to recover, not a rollback.
    expect(r).toMatchObject({ outcome: 'failed', detail: 'mensagens' });
    expect(r.mensagens).toEqual({ malformados: 1 });
    // The survivor really landed — not merely "did not throw".
    const msg = db.docs(CONV_PATH).get(mensagemDocId(CONTA, 'wamid.A'));
    expect(msg?.conteudo).toBe('oi');
    // And the entry that failed wrote nothing under its own id.
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.BAD'))).toBe(false);
  });

  it('THE PROPERTY: six different runs, all `done`, six distinct details', async () => {
    const db = new FakeDb();
    seedConta(db);
    const run = async (value: DocData): Promise<string | undefined> =>
      (await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps)).detail;

    const details = [
      await run(inboundValue()), // mensagens
      await run(inboundValue()), // redelivery (same wamid + timestamp)
      await run(
        inboundValue({
          statuses: [
            { id: 'wamid.OUT', recipient_id: FROM, status: 'delivered', timestamp: '1700000100' },
          ],
        }),
      ), // echo
      await run(statusOnlyValue()), // statuses
      await run(errorsOnlyValue()), // vazio
    ];

    // `spam` needs its own db — the guard is a property of the CONVERSA, and
    // seeding it above would change what every run before it reports.
    const spamDb = new FakeDb();
    seedConta(spamDb);
    spamDb.seed('chat', CONV_ID, { estadoConversa: 99, sender_id: SENDER, nome: 'Fulano' });
    details.push(
      (await handleNotificationTask(asDb(spamDb), messagesPayload(inboundValue()), 0, deps)).detail,
    );

    // Six members in `MessagesFieldOutcome`, six distinct reports. This set IS
    // the property — every member is reachable AND none collapses onto another.
    expect(new Set(details).size).toBe(6);
  });

  it('carries the success arm `kind` out to the caller', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(r.kind).toBe('processed');
  });

  it('carries a NON-success arm `kind` out too — a drop is not a processed change', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(
      asDb(db),
      { field: 'message_template_status_update', phoneNumberId: null, messageId: null, value: {} },
      0,
      deps,
    );
    expect(r.kind).toBe('dropped');
  });

  it('the two drop causes are told apart — both were `dropped` alone before', async () => {
    const db = new FakeDb();
    seedConta(db);
    const campo = await handleNotificationTask(
      asDb(db),
      { field: 'message_template_status_update', phoneNumberId: null, messageId: null, value: {} },
      0,
      deps,
    );
    const malformado = await handleNotificationTask(
      asDb(db),
      messagesPayload({ garbage: true }),
      0,
      deps,
    );
    expect(campo.detail).toBe('campo-nao-suportado');
    expect(malformado.detail).toBe('value-malformado');
    expect(campo.detail).not.toBe(malformado.detail);
  });

  it('a failed park reports its `kind` and no `detail`', async () => {
    const db = new FakeDb(); // no conta seeded → resolveConta parks
    const r = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(r).toMatchObject({ outcome: 'failed', kind: 'failed' });
    // `fail` writes a Firestore doc carrying the whole reason as `erro`, so it
    // deliberately gets no coarser second copy in the log.
    expect(r.detail).toBeUndefined();
  });

  it('the shared pipeline schema-parse drop carries NO kind — a coding bug, not ours', async () => {
    const db = new FakeDb();
    const r = await handleNotificationTask(asDb(db), { field: '', value: {} }, 0, deps);
    expect(r.outcome).toBe('dropped');
    expect(r.kind).toBeUndefined();
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
    expect(conv.sender_id).toBeNull();
    // `conta.cor` is a 24-bit RGB int; `cor_etiqueta` is a 32-bit ARGB
    // `Color.value`, so the importer LIFTS it (`corToEtiquetaArgb`) instead of
    // copying. A raw 5 here would paint correctly but never equal any of the
    // seven palette constants the chat etiqueta filter matches with `==`.
    expect(conv.cor_etiqueta).toBe(0xff000005);
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

  it('spam conversa → mensagem NOT created, and the change SAYS it was spam', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, { estadoConversa: 99, sender_id: SENDER, nome: 'Fulano' });
    const r = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs(CONV_PATH).has(mensagemDocId(CONTA, 'wamid.A'))).toBe(false);
    // ⚠️ Asserting the absence of the doc is NOT enough: `spam` and `echo` both
    // write no mensagem, so without this a mis-fold to the neighbouring member
    // ships silently — the exact failure mode the rest of this file guards.
    expect(r.detail).toBe('spam');
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

  it('a redelivery after a CRASHED bump self-heals ultima_modificacao (not gated on the mensagem write)', async () => {
    // Scenario (Copilot review, PR #582): the mensagem landed but the bump
    // threw transiently → the retry arrives as an idempotent redelivery
    // (createOrUpdateMensagem skips). The bump must still run — it is
    // monotonic, so re-running is safe — or the conversa never resurfaces.
    const db = new FakeDb();
    seedConta(db);
    const msgId = mensagemDocId(CONTA, 'wamid.A');
    db.seed('chat', CONV_ID, {
      estadoConversa: 1,
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z',
      ultima_modificacao: 555, // stale — the crashed first attempt never bumped
    });
    // Prior mensagem already at/after the incoming ts → createOrUpdateMensagem skips.
    db.seed(CONV_PATH, msgId, {
      conteudo: 'ORIGINAL',
      mid: 'wamid.A',
      timestamp: new Date(MSG_MS).toISOString(),
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs('chat').get(CONV_ID)!.ultima_modificacao).toBe(MSG_MS); // self-healed
  });

  it('a true redelivery (conversa already bumped) leaves ultima_modificacao untouched', async () => {
    const db = new FakeDb();
    seedConta(db);
    const msgId = mensagemDocId(CONTA, 'wamid.A');
    db.seed('chat', CONV_ID, {
      estadoConversa: 1,
      sender_id: SENDER,
      nome: 'Fulano',
      ultimaModificacaoIntegracao: '2020-01-01T00:00:00.000Z',
      ultima_modificacao: MSG_MS + 100_000, // already >= the incoming ts
    });
    db.seed(CONV_PATH, msgId, {
      conteudo: 'ORIGINAL',
      mid: 'wamid.A',
      timestamp: new Date(MSG_MS).toISOString(),
    });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    // The bump runs but the monotonic guard no-ops.
    expect(db.docs('chat').get(CONV_ID)!.ultima_modificacao).toBe(MSG_MS + 100_000);
  });
});

/* ------------------------- mensagem dedup + media ------------------------ */

describe('mensagem dedup + media population', () => {
  it('mid+timestamp dedup: an existing doc at/after the timestamp is not overwritten', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('chat', CONV_ID, {
      origem: 'whatsapp',
      clienteOuterRef: 'documents/clientes/cliente-1',
      integracaoOuterRef: 'documents/integracao/' + CONTA,
      ultima_modificacao: 1700000000000,
    });
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
    await handleNotificationTask(
      asDb(db),
      messagesPayload(
        inboundValue({
          messages: [
            {
              from: FROM,
              id: 'wamid.A',
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: 'oi' },
            },
          ],
        }),
      ),
      0,
      deps,
    );
    const reply = db
      .docs(CONV_PATH)
      .get(`autoreply_dentro_${dayKey}_${identidadeWhatsappId(CONTA, 'telefone', FROM)}`)!;
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
    await handleNotificationTask(
      asDb(db),
      messagesPayload(
        inboundValue({
          messages: [
            {
              from: FROM,
              id: 'wamid.A',
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: 'oi' },
            },
          ],
        }),
      ),
      0,
      deps,
    );
    expect(
      db
        .docs(CONV_PATH)
        .get(`autoreply_fora_${dayKey}_${identidadeWhatsappId(CONTA, 'telefone', FROM)}`)!.conteudo,
    ).toBe('Fora do horário.');
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
    await handleNotificationTask(
      asDb(db),
      messagesPayload(
        inboundValue({
          messages: [
            {
              from: FROM,
              id: 'wamid.A',
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: 'oi' },
            },
          ],
        }),
      ),
      0,
      deps,
    );
    expect(
      db
        .docs(CONV_PATH)
        .has(`autoreply_dentro_${dayKey}_${identidadeWhatsappId(CONTA, 'telefone', FROM)}`),
    ).toBe(false);
  });

  it('no auto-reply when the account has no horario_funcionamento', async () => {
    const db = new FakeDb();
    seedConta(db); // no horario_funcionamento
    await handleNotificationTask(
      asDb(db),
      messagesPayload(
        inboundValue({
          messages: [
            {
              from: FROM,
              id: 'wamid.A',
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: 'oi' },
            },
          ],
        }),
      ),
      0,
      deps,
    );
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

  it('status for an unknown mensagem is skipped (soft miss), and the report NAMES it', async () => {
    const db = new FakeDb();
    seedConta(db);
    const r = await handleNotificationTask(
      asDb(db),
      messagesPayload(statusValue('read', '1700000100')),
      0,
      deps,
    );
    expect(r.outcome).toBe('done'); // no throw, nothing to update
    // ⚠️ "did not throw" was this test's ENTIRE assertion. A soft miss leaves no
    // Firestore write and only a `console.warn` carrying the mid — so without
    // this the run was indistinguishable from one that advanced a mensagem.
    expect(r.statuses).toEqual(statusesReport({ naoEncontrados: 1 }));
  });

  it('an out-of-order stale skip is reported apart from a soft miss', async () => {
    const db = new FakeDb();
    seedConta(db);
    // enviado(3) already, last update NEWER than the incoming delivered → refused
    // by the forward-only matrix. Working as designed, and structurally common:
    // the queue dispatches up to 3 concurrently, so statuses routinely race.
    db.seed(CONV_PATH, OUT_MSG_ID, {
      estadoEnvio: 3,
      mid: OUT_WAMID,
      lastExternalUpdateDateTime: new Date(1700000200000).toISOString(),
    });
    const r = await handleNotificationTask(
      asDb(db),
      messagesPayload(statusValue('delivered', '1700000100')),
      0,
      deps,
    );
    expect(r.statuses).toEqual(statusesReport({ staleIgnorados: 1 }));
  });

  /**
   * ⚠️ END-TO-END, and the case this whole change exists for. Meta ships a sixth
   * `status` value; the enum used to fail the element → the array → the value →
   * the ENVELOPE, so `parseWebhookBody` returned null, the receiver acked 200,
   * and the delivery vanished without a task, a failure doc or a log line.
   * It now reaches the processor, which has always known what to do with it.
   */
  it('a status value Meta added later is REPORTED without destroying the known state', async () => {
    const db = new FakeDb();
    seedConta(db);
    // `recebido` — the customer demonstrably read this message.
    db.seed(CONV_PATH, OUT_MSG_ID, {
      estadoEnvio: ESTADO_ENVIO.recebido,
      mid: OUT_WAMID,
      lastExternalUpdateDateTime: 1700000000000,
    });
    const r = await handleNotificationTask(
      asDb(db),
      messagesPayload(statusValue('warning', '1700000100')), // NEWER → bypasses the stale guard
      0,
      deps,
    );

    expect(r.outcome).toBe('done');
    // ⚠️ END-TO-END: the read state SURVIVES. Stamping `desconhecido` here would
    // be unrecoverable — nothing backfills `estadoEnvio` — and it fires on the
    // normal path, since a status added later in the lifecycle always carries
    // the newest timestamp.
    expect(db.docs(CONV_PATH).get(OUT_MSG_ID)!.estadoEnvio).toBe(ESTADO_ENVIO.recebido);
    // The watermark still advanced, so the arrival is not invisible to the guard.
    expect(db.docs(CONV_PATH).get(OUT_MSG_ID)!.lastExternalUpdateDateTime).toBe(1700000100000);
    // Patched AND flagged: `desconhecidos` overlays the fate rather than replacing
    // it, so the operator learns the wire drifted without losing what happened.
    expect(r.statuses).toEqual(statusesReport({ aplicados: 1, desconhecidos: 1 }));
  });

  it('a MALFORMED status entry is counted while its sibling still advances', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed(CONV_PATH, OUT_MSG_ID, { estadoEnvio: 2, mid: OUT_WAMID }); // enviando
    const value = statusValue('delivered', '1700000100');
    (value.statuses as unknown[]).unshift({ id: 'wamid.BAD' }); // fails the element
    const r = await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps);

    expect(db.docs(CONV_PATH).get(OUT_MSG_ID)!.estadoEnvio).toBe(ESTADO_ENVIO.enviado);
    expect(r.statuses).toEqual(statusesReport({ aplicados: 1, malformados: 1 }));
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

describe('inbound contacts resolve to clientes', () => {
  it('continues the reserved historical chat and authors the message as cliente without a usuario', async () => {
    const db = new FakeDb();
    seedConta(db);
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(db.docs('chat').get(CONV_ID)).toMatchObject({
      clienteOuterRef: 'documents/clientes/cliente-1',
      usarioOuterRef: null,
      sender_id: null,
    });
    expect(db.docs(CONV_PATH).get(mensagemDocId(CONTA, 'wamid.A'))).toMatchObject({
      clienteMensagemOuterRef: 'documents/clientes/cliente-1',
      usarioMensagemOuterRef: null,
      user_id: null,
    });
    expect(db.docs('usuarios').size).toBe(0);
    expect(db.docs('clientes').size).toBe(1);
    expect(db.docs('chat').size).toBe(1);
  });

  it('retains an unknown contact for manual identification without creating cliente, usuario or chat', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.docs('clientes').clear();
    const result = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(result).toMatchObject({ kind: 'parked', outcome: 'parked' });
    expect(db.docs('whatsappVinculos').size).toBe(1);
    expect(db.docs('chat').size).toBe(0);
    expect(db.docs('usuarios').size).toBe(0);
    expect(db.docs('clientes').size).toBe(0);
  });

  it('parks an ambiguous phone instead of arbitrarily choosing a cliente', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('clientes', 'cliente-2', { nome: 'Outro', telefone: FROM });
    const result = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(result).toMatchObject({ kind: 'parked', outcome: 'parked' });
    expect(db.docs('chat').size).toBe(0);
    expect(db.docs('whatsappIdentidades').size).toBe(0);
  });

  it('accepts a known BSUID with the phone hidden and preserves the same chat', async () => {
    const db = new FakeDb();
    seedConta(db, { portfolioId: 'portfolio-1' });
    const bsuid = 'BR.identity.with.hidden.phone';
    db.seed('whatsappIdentidades', identidadeWhatsappId('portfolio-1', 'bsuid', bsuid), {
      escopo: 'portfolio-1',
      tipo: 'bsuid',
      valor: bsuid,
      clienteId: 'cliente-1',
      ativa: true,
    });
    const value = inboundValue({
      contacts: [{ user_id: bsuid, profile: { name: 'Fulano' } }],
      messages: [
        {
          from_user_id: bsuid,
          id: 'wamid.BSUID',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'oi sem telefone' },
        },
      ],
    });
    expect((await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps)).outcome).toBe(
      'done',
    );
    expect(db.docs('chat').get(CONV_ID)).toMatchObject({
      clienteOuterRef: 'documents/clientes/cliente-1',
      whatsappDestino: { tipo: 'bsuid', valor: bsuid },
    });
    expect(db.docs(CONV_PATH).get(mensagemDocId(CONTA, 'wamid.BSUID'))?.conteudo).toBe(
      'oi sem telefone',
    );
    expect(db.docs('chat').size).toBe(1);
  });
});

describe('pending contact retention', () => {
  it('keeps text and cached media once across retries while awaiting manual identification', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.docs('clientes').clear();
    const body = messagesPayload(
      inboundValue({
        messages: [
          {
            from: FROM,
            id: 'wamid.PENDING.MEDIA',
            timestamp: '1700000000',
            type: 'image',
            image: { id: 'retained-image', caption: 'Comprovante' },
          },
        ],
      }),
    );
    await handleNotificationTask(asDb(db), body, 0, deps);
    await handleNotificationTask(asDb(db), body, 0, deps);
    const [pendingId, pending] = [...db.docs('whatsappVinculos')][0]!;
    expect(pending).toMatchObject({ quantidadeMensagens: 1, estado: 'aguardando', telefone: FROM });
    const messages = db.docs(`whatsappVinculos/${pendingId}/mensagens`);
    expect(messages.size).toBe(1);
    expect([...messages.values()][0]).toMatchObject({
      conteudo: 'Comprovante',
      arquivoId: 'wa_retained-image',
      anexoTipo: 'image',
      processada: false,
    });
    expect(media.getAndUploadMedia).toHaveBeenCalledWith(expect.anything(), 'retained-image');
    expect(db.docs(NOTIF).get('wamid.PENDING.MEDIA')).toMatchObject({ status: 'parked' });
    expect(db.docs('chat').size).toBe(0);
  });

  it('matches a provider international number exactly without adding the Brazilian country code', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('clientes', 'cliente-1', {
      nome: 'Cliente internacional',
      telefone: '14155552671',
      telefoneGerenciado: true,
    });
    db.seed('clientes', 'br-near-miss', { nome: 'Cliente brasileiro', telefone: '5514155552671' });
    const value = inboundValue({
      contacts: [{ wa_id: '14155552671', profile: { name: 'Cliente internacional' } }],
      messages: [
        {
          from: '14155552671',
          id: 'wamid.INTERNATIONAL',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'Hello' },
        },
      ],
    });
    expect((await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps)).outcome).toBe(
      'done',
    );
    expect(db.docs('chat').get(CONV_ID)).toMatchObject({
      clienteOuterRef: 'documents/clientes/cliente-1',
      whatsappDestino: { tipo: 'telefone', valor: '14155552671' },
    });
    expect(db.docs('whatsappVinculos').size).toBe(0);
  });
});

describe('identity transitions and redelivery continuity', () => {
  it('applies a parked number-change event after manual confirmation of its predecessor', async () => {
    const db = new FakeDb();
    seedConta(db, { portfolioId: 'portfolio-1' });
    const newPhone = '5511888888888';
    const newBsuid = 'BR.NEW.IDENTITY';
    const payload = messagesPayload(
      inboundValue({
        contacts: undefined,
        messages: [
          {
            from: FROM,
            id: 'wamid.TRANSITION',
            timestamp: '1700000000',
            type: 'system',
            system: {
              type: 'user_changed_number',
              user_id: newBsuid,
              wa_id: newPhone,
              body: 'Phone number changed',
            },
          },
        ],
      }),
    );
    expect((await handleNotificationTask(asDb(db), payload, 0, deps)).outcome).toBe('parked');
    const pendingId = [...db.docs('whatsappVinculos').keys()][0]!;
    await confirmarVinculoWhatsapp(
      asDb(db),
      pendingId,
      confirmarVinculoSchema.parse({
        requestId: 'confirm-transition',
        revision: 0,
        choice: { kind: 'existing', clienteId: 'cliente-1' },
      }),
      'operator-1',
    );
    expect((await handleNotificationTask(asDb(db), payload, 0, deps)).outcome).toBe('done');
    expect(db.docs('clientes').get('cliente-1')).toMatchObject({
      telefone: newPhone,
      telefonesAdicionais: [FROM],
    });
    expect(
      db.docs('whatsappIdentidades').get(identidadeWhatsappId(CONTA, 'telefone', FROM))?.ativa,
    ).toBe(false);
    expect(
      db.docs('whatsappIdentidades').get(identidadeWhatsappId('portfolio-1', 'bsuid', newBsuid)),
    ).toMatchObject({ clienteId: 'cliente-1', ativa: true });
    expect(db.docs('chat').get(CONV_ID)).toMatchObject({
      whatsappDestino: { tipo: 'bsuid', valor: newBsuid, ultimaMensagemEm: null },
    });
    expect(db.docs('chat').size).toBe(1);
  });

  it('acknowledges a previously stored wamid without parking it again after its phone was retired', async () => {
    const db = new FakeDb();
    seedConta(db);
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    db.docs('clientes').get('cliente-1')!.telefone = '5511888888888';
    db.docs('whatsappIdentidades').get(identidadeWhatsappId(CONTA, 'telefone', FROM))!.ativa =
      false;
    const result = await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    expect(result).toMatchObject({ outcome: 'done', detail: 'redelivery' });
    expect(db.docs('whatsappVinculos').size).toBe(0);
    expect(db.docs('chat').size).toBe(1);
    expect(db.docs('clientes').get('cliente-1')!.telefone).toBe('5511888888888');
  });
});

describe('manual replay of a superseded phone transition', () => {
  const NEW_PRINCIPAL = '5511777777777';
  const OBSOLETE_NEW_PHONE = '5511888888888';
  const SYSTEM_WAMID = 'wamid.OBSOLETE.TRANSITION';
  const SYSTEM_ID = mensagemDocId(CONTA, SYSTEM_WAMID);

  async function pendingTransition() {
    const db = new FakeDb();
    seedConta(db, { portfolioId: 'portfolio-1' });
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    db.docs('clientes').get('cliente-1')!.telefone = NEW_PRINCIPAL;
    db.docs('clientes').get('cliente-1')!.telefonesAdicionais = [FROM];
    const value = inboundValue({
      contacts: undefined,
      messages: [
        {
          from: FROM,
          id: SYSTEM_WAMID,
          timestamp: '1700000001',
          type: 'system',
          system: {
            type: 'user_changed_number',
            wa_id: OBSOLETE_NEW_PHONE,
            body: 'Phone number changed',
          },
        },
      ],
    });
    const payload = messagesPayload(value);
    expect((await handleNotificationTask(asDb(db), payload, 0, deps)).outcome).toBe('parked');
    const pendingId = [...db.docs('whatsappVinculos').keys()][0]!;
    await confirmarVinculoWhatsapp(
      asDb(db),
      pendingId,
      confirmarVinculoSchema.parse({
        requestId: 'accept-history-only',
        revision: 0,
        choice: { kind: 'existing', clienteId: 'cliente-1' },
      }),
      'operator-1',
    );
    const binding = db.docs('whatsappVinculos').get(pendingId)!;
    const manualReplay = { vinculoId: pendingId, revision: Number(binding.revision) };
    return { db, pendingId, value, payload, manualReplay };
  }

  it('recovers history after a human link without applying the obsolete transition', async () => {
    const { db, pendingId, payload } = await pendingTransition();
    const beforeCliente = structuredClone(db.docs('clientes').get('cliente-1'));
    const beforeChat = structuredClone(db.docs('chat').get(CONV_ID));
    const beforeIdentities = structuredClone([...db.docs('whatsappIdentidades')]);
    const redrive = vi.fn(async () => handleNotificationTask(asDb(db), payload, 0, deps));
    const result = await replayVinculoWhatsapp(asDb(db), pendingId, deps, redrive);
    expect(result).toMatchObject({ kind: 'processed', detail: 'mensagens' });
    expect(db.docs(CONV_PATH).get(SYSTEM_ID)).toMatchObject({
      mid: SYSTEM_WAMID,
      tipo: 'e',
      conteudo: 'Phone number changed',
      clienteMensagemOuterRef: 'documents/clientes/cliente-1',
      usarioMensagemOuterRef: null,
    });
    expect(db.docs('whatsappMensagens').get(SYSTEM_ID)).toMatchObject({
      integracaoId: CONTA,
      conversaId: CONV_ID,
      mensagemId: SYSTEM_ID,
    });
    expect(db.docs('whatsappVinculos/' + pendingId + '/mensagens').get(SYSTEM_ID)?.processada).toBe(
      true,
    );
    expect(db.docs('whatsappVinculos').get(pendingId)?.estado).toBe('resolvido');
    expect(db.docs('clientes').get('cliente-1')).toEqual(beforeCliente);
    expect(db.docs('clientes').get('cliente-1')?.telefone).toBe(NEW_PRINCIPAL);
    expect([...db.docs('whatsappIdentidades')]).toEqual(beforeIdentities);
    expect(db.docs('chat').get(CONV_ID)).toEqual(beforeChat);
    expect(redrive).toHaveBeenCalledTimes(1);
    expect((await handleNotificationTask(asDb(db), payload, 0, deps)).outcome).toBe('done');
    expect(db.docs('whatsappVinculos').get(pendingId)?.estado).toBe('resolvido');
    expect([...db.docs(CONV_PATH).values()].filter((row) => row.mid === SYSTEM_WAMID)).toHaveLength(
      1,
    );
  });

  it('does not acknowledge a retained message after the source redrive changes the decision', async () => {
    const { db, pendingId, manualReplay } = await pendingTransition();
    const redrive = async () => {
      Object.assign(db.docs('whatsappVinculos').get(pendingId)!, {
        revision: manualReplay.revision + 1,
        estado: 'aguardando',
      });
    };
    await expect(replayVinculoWhatsapp(asDb(db), pendingId, deps, redrive)).rejects.toBeInstanceOf(
      WhatsappVinculoConflitoError,
    );
    expect(db.docs('whatsappVinculos/' + pendingId + '/mensagens').get(SYSTEM_ID)?.processada).toBe(
      false,
    );
    expect(db.docs('whatsappVinculos').get(pendingId)).toMatchObject({
      revision: manualReplay.revision + 1,
      estado: 'aguardando',
    });
  });

  it('normal webhook processing never obtains the history-only authority from a manual binding', async () => {
    const { db, pendingId, payload } = await pendingTransition();
    expect((await handleNotificationTask(asDb(db), payload, 0, deps)).outcome).toBe('parked');
    expect(db.docs(CONV_PATH).has(SYSTEM_ID)).toBe(false);
    expect(db.docs('whatsappMensagens').has(SYSTEM_ID)).toBe(false);
    expect(db.docs('whatsappVinculos/' + pendingId + '/mensagens').get(SYSTEM_ID)?.processada).toBe(
      false,
    );
    expect(db.docs('clientes').get('cliente-1')?.telefone).toBe(NEW_PRINCIPAL);
  });

  it('rechecks authority after the message transaction starts, preserving a newer decision', async () => {
    const { db, pendingId, value, manualReplay } = await pendingTransition();
    const currentRevision = manualReplay.revision;
    db.beforeDocRead = (path, id) => {
      if (path !== CONV_PATH || id !== SYSTEM_ID) return;
      db.beforeDocRead = undefined;
      db.docs('whatsappVinculos').get(pendingId)!.revision = currentRevision + 1;
    };
    await expect(
      processMessagesField(asDb(db), value, deps, null, manualReplay),
    ).rejects.toBeInstanceOf(WhatsappVinculoConflitoError);
    expect(db.docs(CONV_PATH).has(SYSTEM_ID)).toBe(false);
    expect(db.docs('whatsappMensagens').has(SYSTEM_ID)).toBe(false);
    expect(db.docs('clientes').get('cliente-1')?.telefone).toBe(NEW_PRINCIPAL);
  });

  it.each([
    { revision: 100 },
    { decididoPor: null },
    { decididoPor: '' },
    { estado: 'aguardando' },
    { clienteId: 'different-customer' },
    { conversaId: 'different-chat' },
    { integracaoId: 'different-integration' },
  ])('rejects stale or incomplete manual authority: %j', async (patch) => {
    const { db, pendingId, value, manualReplay } = await pendingTransition();
    Object.assign(db.docs('whatsappVinculos').get(pendingId)!, patch);
    await expect(
      processMessagesField(asDb(db), value, deps, null, manualReplay),
    ).rejects.toBeInstanceOf(WhatsappVinculoConflitoError);
    expect(db.docs(CONV_PATH).has(SYSTEM_ID)).toBe(false);
    expect(db.docs('whatsappMensagens').has(SYSTEM_ID)).toBe(false);
  });

  it('requires the exact retained system message, not merely the same external ID', async () => {
    const { db, pendingId, value, manualReplay } = await pendingTransition();
    const retained = db.docs('whatsappVinculos/' + pendingId + '/mensagens').get(SYSTEM_ID)!;
    retained.value = inboundValue({
      messages: [
        {
          from: FROM,
          id: SYSTEM_WAMID,
          timestamp: '1700000001',
          type: 'system',
          system: { type: 'user_changed_number', wa_id: '5511666666666' },
        },
      ],
    });
    await expect(
      processMessagesField(asDb(db), value, deps, null, manualReplay),
    ).rejects.toBeInstanceOf(WhatsappVinculoConflitoError);
    expect(db.docs(CONV_PATH).has(SYSTEM_ID)).toBe(false);
    expect(db.docs('whatsappMensagens').has(SYSTEM_ID)).toBe(false);
  });
});

describe('manual recovery of retained messages from a retired phone', () => {
  it('recovers old text while keeping the retired alias and current destination unchanged', async () => {
    const db = new FakeDb();
    seedConta(db);
    await handleNotificationTask(asDb(db), messagesPayload(inboundValue()), 0, deps);
    const newPhone = '5511777777777';
    const oldIdentityId = identidadeWhatsappId(CONTA, 'telefone', FROM);
    const newIdentityId = identidadeWhatsappId(CONTA, 'telefone', newPhone);
    Object.assign(db.docs('clientes').get('cliente-1')!, {
      telefone: newPhone,
      telefonesAdicionais: [FROM],
    });
    Object.assign(db.docs('whatsappIdentidades').get(oldIdentityId)!, {
      ativa: false,
      sucessoraId: newIdentityId,
      ultimaTransicaoEm: 1700000002000,
    });
    db.seed('whatsappIdentidades', newIdentityId, {
      escopo: CONTA,
      tipo: 'telefone',
      valor: newPhone,
      clienteId: 'cliente-1',
      ativa: true,
      telefoneClienteNoVinculo: newPhone,
      ultimaTransicaoEm: 1700000002000,
    });
    db.docs('chat').get(CONV_ID)!.whatsappDestino = {
      tipo: 'telefone',
      valor: newPhone,
      identidadeId: newIdentityId,
      revision: 2,
      ultimaMensagemEm: 1700000002000,
      ultimaIdentificacaoEm: 1700000002000,
    };
    const value = inboundValue({
      messages: [
        {
          from: FROM,
          id: 'wamid.RETIRED.TEXT',
          timestamp: '1700000001',
          type: 'text',
          text: { body: 'Mensagem retida antes da troca.' },
        },
      ],
    });
    const payload = messagesPayload(value);
    expect((await handleNotificationTask(asDb(db), payload, 0, deps)).outcome).toBe('parked');
    const pendingId = [...db.docs('whatsappVinculos').keys()][0]!;
    await confirmarVinculoWhatsapp(
      asDb(db),
      pendingId,
      confirmarVinculoSchema.parse({
        requestId: 'recover-retired-history',
        revision: 0,
        choice: { kind: 'existing', clienteId: 'cliente-1' },
      }),
      'operator-1',
    );
    const beforeCliente = structuredClone(db.docs('clientes').get('cliente-1'));
    const beforeChat = structuredClone(db.docs('chat').get(CONV_ID));
    const beforeIdentities = structuredClone([...db.docs('whatsappIdentidades')]);
    const redrive = vi.fn(async () => handleNotificationTask(asDb(db), payload, 0, deps));
    expect((await replayVinculoWhatsapp(asDb(db), pendingId, deps, redrive)).kind).toBe(
      'processed',
    );
    const msgId = mensagemDocId(CONTA, 'wamid.RETIRED.TEXT');
    expect(db.docs(CONV_PATH).get(msgId)).toMatchObject({
      conteudo: 'Mensagem retida antes da troca.',
      tipo: 'c',
      clienteMensagemOuterRef: 'documents/clientes/cliente-1',
    });
    expect(db.docs('whatsappMensagens').get(msgId)).toMatchObject({ historicoManual: true });
    expect(db.docs('whatsappVinculos').get(pendingId)?.estado).toBe('resolvido');
    expect(db.docs('whatsappIdentidades').get(oldIdentityId)?.ativa).toBe(false);
    expect([...db.docs('whatsappIdentidades')]).toEqual(beforeIdentities);
    expect(db.docs('clientes').get('cliente-1')).toEqual(beforeCliente);
    expect(db.docs('chat').get(CONV_ID)).toEqual(beforeChat);
    expect((await handleNotificationTask(asDb(db), payload, 0, deps)).outcome).toBe('done');
    expect(db.docs('chat').get(CONV_ID)).toEqual(beforeChat);
  });
});

describe('resolved replay cannot outlive its manual decision', () => {
  const WAMID = 'wamid.MANUALLY.RESOLVED';
  const MSG_ID = mensagemDocId(CONTA, WAMID);

  async function resolvedPending() {
    const db = new FakeDb();
    seedConta(db);
    db.docs('clientes').get('cliente-1')!.telefone = null;
    const value = inboundValue({
      messages: [
        {
          from: FROM,
          id: WAMID,
          timestamp: '1700000001',
          type: 'text',
          text: { body: 'Mensagem já identificada manualmente.' },
        },
      ],
    });
    expect((await handleNotificationTask(asDb(db), messagesPayload(value), 0, deps)).outcome).toBe(
      'parked',
    );
    const pendingId = [...db.docs('whatsappVinculos').keys()][0]!;
    await confirmarVinculoWhatsapp(
      asDb(db),
      pendingId,
      confirmarVinculoSchema.parse({
        requestId: 'link-known-message',
        revision: 0,
        choice: { kind: 'existing', clienteId: 'cliente-1' },
      }),
      'operator-1',
    );
    const authority = {
      vinculoId: pendingId,
      revision: Number(db.docs('whatsappVinculos').get(pendingId)!.revision),
    };
    return { db, value, pendingId, authority };
  }

  it('valid resolved replay keeps normal message semantics separate from history-only recovery', async () => {
    const { db, value, authority } = await resolvedPending();
    expect((await processMessagesField(asDb(db), value, deps, null, authority)).kind).toBe(
      'processed',
    );
    expect(db.docs(CONV_PATH).get(MSG_ID)).toMatchObject({
      conteudo: 'Mensagem já identificada manualmente.',
      clienteMensagemOuterRef: 'documents/clientes/cliente-1',
    });
    expect(db.docs('whatsappMensagens').get(MSG_ID)?.historicoManual).toBe(false);
  });

  it('rejects an already-stale replay before resolving identity or changing a conversation', async () => {
    const { db, value, pendingId, authority } = await resolvedPending();
    const beforeChat = structuredClone(db.docs('chat').get(CONV_ID));
    const beforeIdentities = structuredClone([...db.docs('whatsappIdentidades')]);
    db.docs('whatsappVinculos').get(pendingId)!.revision = authority.revision + 1;
    await expect(
      processMessagesField(asDb(db), value, deps, null, authority),
    ).rejects.toBeInstanceOf(WhatsappVinculoConflitoError);
    expect(db.docs(CONV_PATH).has(MSG_ID)).toBe(false);
    expect(db.docs('whatsappMensagens').has(MSG_ID)).toBe(false);
    expect(db.docs('chat').get(CONV_ID)).toEqual(beforeChat);
    expect([...db.docs('whatsappIdentidades')]).toEqual(beforeIdentities);
  });

  it.each([
    [2, 'identity resolver'],
    [3, 'conversation update'],
    [4, 'message write'],
  ])('rejects a decision changed before transaction %i (%s)', async (at) => {
    const { db, value, pendingId, authority } = await resolvedPending();
    let transactions = 0;
    db.beforeTransaction = () => {
      transactions += 1;
      if (transactions === at)
        db.docs('whatsappVinculos').get(pendingId)!.revision = authority.revision + 1;
    };
    await expect(
      processMessagesField(asDb(db), value, deps, null, authority),
    ).rejects.toBeInstanceOf(WhatsappVinculoConflitoError);
    expect(transactions).toBe(at);
    expect(db.docs(CONV_PATH).has(MSG_ID)).toBe(false);
    expect(db.docs('whatsappMensagens').has(MSG_ID)).toBe(false);
  });

  it('does not redirect a resolved replay to another client after its first proof', async () => {
    const { db, value, pendingId, authority } = await resolvedPending();
    const beforeChat = structuredClone(db.docs('chat').get(CONV_ID));
    let transactions = 0;
    db.beforeTransaction = () => {
      transactions += 1;
      if (transactions === 2)
        Object.assign(db.docs('whatsappVinculos').get(pendingId)!, {
          revision: authority.revision + 1,
          clienteId: 'cliente-2',
          conversaId: 'chat-2',
        });
    };
    await expect(
      processMessagesField(asDb(db), value, deps, null, authority),
    ).rejects.toBeInstanceOf(WhatsappVinculoConflitoError);
    expect(db.docs(CONV_PATH).has(MSG_ID)).toBe(false);
    expect(db.docs('chat/chat-2/mensagem').size).toBe(0);
    expect(db.docs('chat').get(CONV_ID)).toEqual(beforeChat);
  });

  it('guards the planned destination even if an identity was rebound without changing the pending revision', async () => {
    const { db, value, authority } = await resolvedPending();
    const otherChat = 'chat-2';
    db.seed('clientes', 'cliente-2', { nome: 'Outro cliente', telefone: FROM });
    db.seed('chat', otherChat, {
      origem: 'whatsapp',
      clienteOuterRef: 'documents/clientes/cliente-2',
      integracaoOuterRef: 'documents/integracao/' + CONTA,
    });
    db.seed('whatsappConversas', conversaWhatsappKey(CONTA, 'cliente-2'), {
      integracaoId: CONTA,
      clienteId: 'cliente-2',
      conversaId: otherChat,
    });
    Object.assign(
      db.docs('whatsappIdentidades').get(identidadeWhatsappId(CONTA, 'telefone', FROM))!,
      { clienteId: 'cliente-2', telefoneClienteNoVinculo: FROM },
    );
    const beforeOther = structuredClone(db.docs('chat').get(otherChat));
    await expect(
      processMessagesField(asDb(db), value, deps, null, authority),
    ).rejects.toBeInstanceOf(WhatsappVinculoConflitoError);
    expect(db.docs(CONV_PATH).has(MSG_ID)).toBe(false);
    expect(db.docs('chat/chat-2/mensagem').size).toBe(0);
    expect(db.docs('chat').get(otherChat)).toEqual(beforeOther);
  });
});
