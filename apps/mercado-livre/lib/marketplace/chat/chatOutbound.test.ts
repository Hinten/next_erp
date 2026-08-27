import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import type { MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import {
  ChatOutboundRefusedError,
  acaoPerguntaMercadoLivre,
  responderConversaMercadoLivre,
} from './chatOutbound';
import { ANSWER_MENSAGEM_ID } from './questionIds';

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
}
const asDb = (f: FakeDb) => f as unknown as Firestore;

const NOW_MS = 1_753_180_800_000;
const SELLER = 415458330;
const CHAT = 'chat';
const CONV_PERG = 'conv-perg';
const CONV_PED = 'conv-ped';
const QUESTION_ID = 11751825075;
const PACK_ID = '2000000089077943';
/** ML's MLB messaging Agent — the `from` on a thread ML has MIGRATED. */
const AGENTE_MLB = 3037675074;
/** A real buyer id — the `from` on a thread it has NOT. */
const COMPRADOR = 1234567890;

/** One post-sale message, `minutos` after the fixture epoch. */
function msg(minutos: number, from: number | null, over: DocData = {}): DocData {
  const iso = new Date(Date.parse('2026-02-05T20:01:46.000Z') + minutos * 60_000).toISOString();
  return {
    id: `m${minutos}`,
    site_id: 'MLB',
    from: from == null ? null : { user_id: from },
    to: { user_id: SELLER },
    message_date: { received: iso, available: null, notified: null, created: iso, read: null },
    ...over,
  };
}

/**
 * A pack thread. Defaults to the AGENT flow — `conversation_status.path` carries
 * the `/conversations/` segment and the inbound message comes `from` the agent —
 * because that is what a migrated MLB thread looks like today.
 */
function packThread(over: DocData = {}): DocData {
  return {
    paging: { limit: 100, offset: 0, total: 1 },
    conversation_status: {
      path: `/packs/${PACK_ID}/sellers/${SELLER}/conversations/post_sale`,
      status: 'active',
      substatus: null,
    },
    messages: [msg(0, AGENTE_MLB)],
    seller_max_message_length: 350,
    ...over,
  };
}

/** The same thread on the LEGACY flow: no `/conversations/`, a real buyer `from`. */
function packLegado(over: DocData = {}): DocData {
  return packThread({
    conversation_status: {
      path: `/packs/${PACK_ID}/sellers/${SELLER}`,
      status: 'active',
      substatus: null,
    },
    messages: [msg(0, COMPRADOR)],
    ...over,
  });
}

function seedPergunta(db: FakeDb, over: DocData = {}) {
  db.seed(CHAT, CONV_PERG, {
    origem: 'mlperg',
    id: String(QUESTION_ID),
    sender_id: '56801932',
    integracaoOuterRef: 'documents/integracao/conta1',
    ...over,
  });
}

function seedPedido(db: FakeDb, over: DocData = {}) {
  db.seed(CHAT, CONV_PED, {
    origem: 'mlped',
    id: PACK_ID,
    integracaoOuterRef: 'documents/integracao/conta1',
    ...over,
  });
}

/**
 * ⚠️ Deliberately looser than `Partial<MercadoLivreApi>`. Every override here is
 * a hand-rolled fixture carrying only the fields the code under test reads — a
 * question stub has `status` and `text`, not the dozen nullable identifiers ML
 * declares. Typing them against the real return shape would force each test to
 * spell out a whole ML response to vary ONE field, which is how a fixture stops
 * describing the case it exists for.
 */
type ApiStubs = Partial<Record<keyof MercadoLivreApi, unknown>>;

function api(over: ApiStubs = {}): MercadoLivreApi {
  return {
    getQuestion: vi.fn(async () => ({ id: QUESTION_ID, status: 'UNANSWERED', text: 'x' })),
    answerQuestion: vi.fn(async () => ({ id: 1, status: 'ACTIVE' })),
    deleteQuestion: vi.fn(async () => undefined),
    blockUserFromQuestions: vi.fn(async () => undefined),
    getPackMessages: vi.fn(async () => packThread()),
    sendPackMessage: vi.fn(async () => undefined),
    getClaim: vi.fn(async () => claimComAcoes(['send_message_to_complainant'])),
    sendClaimMessage: vi.fn(async () => undefined),
    ...over,
  } as unknown as MercadoLivreApi;
}

const CONV_CLAIM = 'conv-claim';
const CLAIM_ID = 5204934310;

/** A claim whose seller holds exactly `acoes`. */
function claimComAcoes(acoes: string[], over: Record<string, unknown> = {}) {
  return {
    id: CLAIM_ID,
    resource_id: 2000008026430162,
    status: 'opened',
    type: 'mediations',
    stage: 'claim',
    resource: 'order',
    players: [
      { role: 'complainant', type: 'buyer', user_id: 1, available_actions: [] },
      {
        role: 'respondent',
        type: 'seller',
        user_id: SELLER,
        available_actions: acoes.map((action) => ({ action, mandatory: false, due_date: null })),
      },
    ],
    resolution: null,
    date_created: '2024-04-12T08:26:23.000-04:00',
    last_updated: null,
    ...over,
  };
}

function seedReclamacao(db: FakeDb, over: DocData = {}) {
  db.seed(CHAT, CONV_CLAIM, {
    origem: 'mlclaims',
    id: String(CLAIM_ID),
    integracaoOuterRef: 'documents/integracao/conta1',
    ...over,
  });
}

function deps(db: FakeDb, apiOver: ApiStubs = {}) {
  return { db: asDb(db), api: api(apiOver), conta: { userId: SELLER }, nowMs: NOW_MS };
}

describe('responderConversaMercadoLivre — perguntas', () => {
  it('answers ML first, THEN writes the thread, and closes the conversa', async () => {
    const db = new FakeDb();
    seedPergunta(db);
    const d = deps(db);

    const r = await responderConversaMercadoLivre(d, {
      conversaId: CONV_PERG,
      texto: 'Temos sim!',
    });

    expect(d.api.answerQuestion).toHaveBeenCalledWith(QUESTION_ID, 'Temos sim!');
    expect(db.docs(`chat/${CONV_PERG}/mensagem`).get(ANSWER_MENSAGEM_ID)).toMatchObject({
      conteudo: 'Temos sim!',
      estadoEnvio: 3, // enviado
    });
    // A question accepts exactly one answer, so the composer must go read-only
    // immediately rather than wait for the next notification.
    expect(db.docs(CHAT).get(CONV_PERG)).toMatchObject({
      respostaBloqueada: 'Pergunta já respondida no Mercado Livre',
      atendido: true,
    });
    expect(r.respostaBloqueada).toBeTruthy();
  });

  it('re-reads ML and REFUSES a question answered elsewhere since the import', async () => {
    // The stored `respostaBloqueada` is a UI hint and stale by construction: the
    // seller can answer on ML's own site between the import and this click.
    const db = new FakeDb();
    seedPergunta(db, { respostaBloqueada: null });
    const d = deps(db, {
      getQuestion: vi.fn(async () => ({ id: QUESTION_ID, status: 'ANSWERED', text: 'x' })),
    });

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_PERG, texto: 'oi' }),
    ).rejects.toMatchObject({ codigo: 'ML_NAO_RESPONDIVEL' });

    expect(d.api.answerQuestion).not.toHaveBeenCalled();
    expect(db.docs(`chat/${CONV_PERG}/mensagem`).size).toBe(0);
  });

  it('writes NOTHING when ML rejects the answer', async () => {
    // Send-first is what prevents a phantom reply: a mensagem written before the
    // ML call would sit in the thread claiming a send that never happened.
    const db = new FakeDb();
    seedPergunta(db);
    const d = deps(db, {
      answerQuestion: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 400', 400, null, null);
      }),
    });

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_PERG, texto: 'oi' }),
    ).rejects.toBeInstanceOf(MercadoLivreHttpError);
    expect(db.docs(`chat/${CONV_PERG}/mensagem`).size).toBe(0);
  });

  it('refuses a body over ML’s 2000-character answer cap, before calling ML', async () => {
    const db = new FakeDb();
    seedPergunta(db);
    const d = deps(db);

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_PERG, texto: 'a'.repeat(2001) }),
    ).rejects.toMatchObject({ codigo: 'ML_TEXTO_LONGO' });
    expect(d.api.getQuestion).not.toHaveBeenCalled();
  });
});

describe('responderConversaMercadoLivre — mensagens de pedido', () => {
  it('addresses the AGENT on a thread ML has already migrated', async () => {
    // The agent IS the delivery path there; a message addressed around it is
    // accepted with a 200 and reaches nobody.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db);

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'Enviado hoje!' });

    expect(d.api.sendPackMessage).toHaveBeenCalledWith(PACK_ID, String(SELLER), {
      text: 'Enviado hoje!',
      toUserId: AGENTE_MLB,
    });
  });

  it('addresses the REAL BUYER on a thread ML has NOT migrated', async () => {
    // ⚠️ The regression test. ML's agent rollout is progressive ("começando pela
    // logística Full"), and addressing the agent here is refused outright with
    // `400 to_user_id 3037675074 does not belong to pack /packs/…/sellers/…` —
    // observed live on pack 2000018143664980. Hardcoding the agent WAS that bug.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db, { getPackMessages: vi.fn(async () => packLegado()) });

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'Enviado hoje!' });

    expect(d.api.sendPackMessage).toHaveBeenCalledWith(PACK_ID, String(SELLER), {
      text: 'Enviado hoje!',
      toUserId: COMPRADOR,
    });
    const { toUserId } = (d.api.sendPackMessage as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(toUserId).not.toBe(AGENTE_MLB);
  });

  it('takes the NEWEST counterparty on a thread migrated mid-life', async () => {
    // Older buyer-id messages, newer agent-id ones — and ML's array deliberately
    // out of chronological order, so neither `messages[0]` nor `.at(-1)` passes.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db, {
      getPackMessages: vi.fn(async () =>
        packThread({ messages: [msg(0, COMPRADOR), msg(10, AGENTE_MLB), msg(5, SELLER)] }),
      ),
    });

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' });

    expect(d.api.sendPackMessage).toHaveBeenCalledWith(PACK_ID, String(SELLER), {
      text: 'oi',
      toUserId: AGENTE_MLB,
    });
  });

  it('…and in the other direction — a newer BUYER message beats an older agent one', async () => {
    // Kills "if any message is from a known agent id, prefer the agent", which
    // the previous case alone survives.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db, {
      getPackMessages: vi.fn(async () =>
        packLegado({ messages: [msg(0, AGENTE_MLB), msg(10, COMPRADOR)] }),
      ),
    });

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' });

    expect(d.api.sendPackMessage).toHaveBeenCalledWith(PACK_ID, String(SELLER), {
      text: 'oi',
      toUserId: COMPRADOR,
    });
  });

  it('never addresses the SELLER itself, even when ours is the newest message', async () => {
    // Dropping the isFromSeller filter POSTs `to === from`, which ML refuses with
    // "Sender and received must not be equals".
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db, {
      getPackMessages: vi.fn(async () =>
        packLegado({ messages: [msg(0, COMPRADOR), msg(10, SELLER)] }),
      ),
    });

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' });

    expect(d.api.sendPackMessage).toHaveBeenCalledWith(PACK_ID, String(SELLER), {
      text: 'oi',
      toUserId: COMPRADOR,
    });
  });

  it('falls back to the site AGENT when only the path says the thread is agent-mediated', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db, {
      getPackMessages: vi.fn(async () => packThread({ messages: [msg(0, SELLER)] })),
    });

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' });

    expect(d.api.sendPackMessage).toHaveBeenCalledWith(PACK_ID, String(SELLER), {
      text: 'oi',
      toUserId: AGENTE_MLB,
    });
  });

  it('REFUSES rather than guessing the agent when nothing identifies the recipient', async () => {
    // ⚠️ The anti-silent-default assertion. It goes red the instant anyone
    // reinstates `?? postSaleAgentUserId(siteId)` — and it re-pins send-first /
    // write-second on the new branch: nothing reaches ML, nothing reaches
    // Firestore. Note the PLURAL `sellers` in the path: that is a legacy thread,
    // not an agent-mediated one.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db, {
      getPackMessages: vi.fn(async () => packLegado({ messages: [msg(0, SELLER)] })),
    });

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' }),
    ).rejects.toMatchObject({ codigo: 'ML_DADOS_INSUFICIENTES' });
    expect(d.api.sendPackMessage).not.toHaveBeenCalled();
    expect(db.docs(`chat/${CONV_PED}/mensagem`).size).toBe(0);
  });

  it('asks ML for a FULL page rather than accepting the default ten', async () => {
    // At ML's default of 10 the newest counterparty can be off the page on a long
    // thread, which is exactly the mid-life-migration case above.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db);

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' });

    expect(d.api.getPackMessages).toHaveBeenCalledWith(PACK_ID, String(SELLER), { limit: 100 });
  });

  it('makes exactly ONE thread read — no walk in the operator’s send path', async () => {
    // GETs share a 500 rpm post-sale budget and the operator is waiting with their
    // text on screen, so this must not become `lerThreadCompleta`'s ten round trips.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db);

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' });

    expect(d.api.getPackMessages).toHaveBeenCalledTimes(1);
  });

  it('writes the recipient NOWHERE — sender_id stays untouched', async () => {
    // `sender_id` means "the human counterparty": `acaoPerguntaMercadoLivre` reads
    // it back as a buyer id to call `blockUserFromQuestions`. An agent id there is
    // a blacklist call against a marketplace robot.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db);

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' });

    expect(db.docs(CHAT).get(CONV_PED)).not.toHaveProperty('sender_id');
  });

  it('re-reads the pack and REFUSES a thread blocked since the import', async () => {
    const db = new FakeDb();
    seedPedido(db, { respostaBloqueada: null });
    const d = deps(db, {
      getPackMessages: vi.fn(async () => ({
        conversation_status: { status: 'blocked', substatus: 'blocked_by_mediation' },
        messages: [],
        seller_max_message_length: 350,
      })),
    });

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'oi' }),
    ).rejects.toMatchObject({ codigo: 'ML_NAO_RESPONDIVEL' });
    expect(d.api.sendPackMessage).not.toHaveBeenCalled();
  });

  it('enforces the LIVE per-thread cap ML returned, not a constant', async () => {
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db, {
      getPackMessages: vi.fn(async () => ({
        conversation_status: { status: 'active', substatus: null },
        messages: [{ id: 'm1', site_id: 'MLB' }],
        seller_max_message_length: 100,
      })),
    });

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'a'.repeat(120) }),
    ).rejects.toMatchObject({ codigo: 'ML_TEXTO_LONGO' });
  });
});

describe('responderConversaMercadoLivre — guards', () => {
  it('refuses an origem with no ML sender', async () => {
    const db = new FakeDb();
    db.seed(CHAT, 'conv-wa', { origem: 'whatsapp', id: '1' });
    await expect(
      responderConversaMercadoLivre(deps(db), { conversaId: 'conv-wa', texto: 'oi' }),
    ).rejects.toMatchObject({ codigo: 'ML_ORIGEM_SEM_ENVIO' });
  });

  it('refuses an empty body without touching ML', async () => {
    const db = new FakeDb();
    seedPergunta(db);
    const d = deps(db);
    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_PERG, texto: '   ' }),
    ).rejects.toMatchObject({ codigo: 'ML_TEXTO_VAZIO' });
    expect(d.api.getQuestion).not.toHaveBeenCalled();
  });

  it('refuses a missing conversa', async () => {
    await expect(
      responderConversaMercadoLivre(deps(new FakeDb()), { conversaId: 'nope', texto: 'oi' }),
    ).rejects.toBeInstanceOf(ChatOutboundRefusedError);
  });
});

describe('acaoPerguntaMercadoLivre', () => {
  it('deletes a question and writes NOTHING to the thread', async () => {
    // ML changes the question's status; the importer is the one writer of that
    // state, and the next notification reflects it.
    const db = new FakeDb();
    seedPergunta(db);
    const d = deps(db);

    await acaoPerguntaMercadoLivre(d, { conversaId: CONV_PERG, acao: 'excluir' });

    expect(d.api.deleteQuestion).toHaveBeenCalledWith(QUESTION_ID);
    expect(db.docs(`chat/${CONV_PERG}/mensagem`).size).toBe(0);
  });

  it('blocks the asker using the seller + buyer ids', async () => {
    const db = new FakeDb();
    seedPergunta(db);
    const d = deps(db);

    await acaoPerguntaMercadoLivre(d, { conversaId: CONV_PERG, acao: 'bloquear' });

    expect(d.api.blockUserFromQuestions).toHaveBeenCalledWith(SELLER, 56801932);
  });

  it('refuses on a non-pergunta conversa', async () => {
    const db = new FakeDb();
    seedPedido(db);
    await expect(
      acaoPerguntaMercadoLivre(deps(db), { conversaId: CONV_PED, acao: 'excluir' }),
    ).rejects.toMatchObject({ codigo: 'ML_ORIGEM_SEM_ENVIO' });
  });

  it('refuses to block when the conversa never recorded the buyer', async () => {
    const db = new FakeDb();
    seedPergunta(db, { sender_id: null });
    const d = deps(db);
    await expect(
      acaoPerguntaMercadoLivre(d, { conversaId: CONV_PERG, acao: 'bloquear' }),
    ).rejects.toMatchObject({ codigo: 'ML_DADOS_INSUFICIENTES' });
    expect(d.api.blockUserFromQuestions).not.toHaveBeenCalled();
  });
});

describe('responderConversaMercadoLivre — reclamações (#768)', () => {
  it('sends to the COMPLAINANT in the claim stage', async () => {
    const db = new FakeDb();
    seedReclamacao(db);
    const d = deps(db);

    const r = await responderConversaMercadoLivre(d, {
      conversaId: CONV_CLAIM,
      texto: 'Vou verificar hoje.',
    });

    expect(d.api.sendClaimMessage).toHaveBeenCalledWith(CLAIM_ID, {
      receiverRole: 'complainant',
      message: 'Vou verificar hoje.',
    });
    expect(db.docs(`chat/${CONV_CLAIM}/mensagem`).size).toBe(1);
    // A claim thread stays open — unlike a question, it accepts many replies.
    expect(r.respostaBloqueada).toBeNull();
  });

  it('switches to the MEDIATOR once a mediation is open', async () => {
    // ⚠️ ML refuses a message aimed at the complainant in the dispute stage, so
    // guessing the role turns every reply into a 4xx.
    const db = new FakeDb();
    seedReclamacao(db);
    const d = deps(db, {
      getClaim: vi.fn(async () =>
        claimComAcoes(['send_message_to_mediator'], { stage: 'dispute' }),
      ),
    });

    await responderConversaMercadoLivre(d, { conversaId: CONV_CLAIM, texto: 'oi' });

    expect(d.api.sendClaimMessage).toHaveBeenCalledWith(
      CLAIM_ID,
      expect.objectContaining({ receiverRole: 'mediator' }),
    );
  });

  it('re-reads the claim and REFUSES one that closed since the import', async () => {
    // The stored `respostaBloqueada` is a UI hint and stale by construction.
    const db = new FakeDb();
    seedReclamacao(db, { respostaBloqueada: null });
    const d = deps(db, { getClaim: vi.fn(async () => claimComAcoes([], { status: 'closed' })) });

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_CLAIM, texto: 'oi' }),
    ).rejects.toMatchObject({ codigo: 'ML_NAO_RESPONDIVEL' });
    expect(d.api.sendClaimMessage).not.toHaveBeenCalled();
  });

  it('refuses a claim whose seller holds only NON-message actions', async () => {
    // A refund or a return label is real work, but it is not chat work — the
    // composer is the wrong place to offer it.
    const db = new FakeDb();
    seedReclamacao(db);
    const d = deps(db, { getClaim: vi.fn(async () => claimComAcoes(['refund'])) });

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_CLAIM, texto: 'oi' }),
    ).rejects.toMatchObject({ codigo: 'ML_NAO_RESPONDIVEL' });
  });

  it('writes NOTHING when ML rejects the message', async () => {
    const db = new FakeDb();
    seedReclamacao(db);
    const d = deps(db, {
      sendClaimMessage: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 400', 400, null, null);
      }),
    });

    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_CLAIM, texto: 'oi' }),
    ).rejects.toBeInstanceOf(MercadoLivreHttpError);
    expect(db.docs(`chat/${CONV_CLAIM}/mensagem`).size).toBe(0);
  });

  it('refuses a body over the claim cap, before calling ML', async () => {
    const db = new FakeDb();
    seedReclamacao(db);
    const d = deps(db);
    await expect(
      responderConversaMercadoLivre(d, { conversaId: CONV_CLAIM, texto: 'a'.repeat(301) }),
    ).rejects.toMatchObject({ codigo: 'ML_TEXTO_LONGO' });
    expect(d.api.getClaim).not.toHaveBeenCalled();
  });
});
