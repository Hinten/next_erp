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
    getPackMessages: vi.fn(async () => ({
      conversation_status: { status: 'active', substatus: null },
      messages: [{ id: 'm1', site_id: 'MLB' }],
      seller_max_message_length: 350,
    })),
    sendPackMessage: vi.fn(async () => undefined),
    ...over,
  } as unknown as MercadoLivreApi;
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
  it('addresses the AGENT, not the buyer (ML, 02/02/2026)', async () => {
    // The agent is the delivery path; a message addressed around it does not
    // reach the buyer at all.
    const db = new FakeDb();
    seedPedido(db);
    const d = deps(db);

    await responderConversaMercadoLivre(d, { conversaId: CONV_PED, texto: 'Enviado hoje!' });

    expect(d.api.sendPackMessage).toHaveBeenCalledWith(PACK_ID, String(SELLER), {
      text: 'Enviado hoje!',
      toUserId: 3037675074, // MLB agent
    });
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
