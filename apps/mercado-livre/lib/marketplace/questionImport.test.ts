import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import type { MercadoLivreApi, MlQuestion } from '@delfrance/integrations-mercado-livre';

const { findOrCreateClienteMock } = vi.hoisted(() => ({ findOrCreateClienteMock: vi.fn() }));
vi.mock('@delfrance/data/admin/clientes', () => ({
  findOrCreateCliente: findOrCreateClienteMock,
}));

import { importQuestionMercadoLivre } from './questionImport';
import { ANSWER_MENSAGEM_ID, makeConversaIdQuestion } from './questionIds';

/* ------------------------------ fake Firestore ---------------------------- */
// Own copy, per the in-repo convention that FakeDbs are not shared across test
// files. Needs `doc().get/set` plus a `collectionGroup` with `ref.parent.parent`
// (the produto link probe).

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
const QUESTION_ID = 11751825075;
const CHAT = 'chat';
const MENSAGENS = (conversaId: string) => `chat/${conversaId}/mensagem`;

function question(over: Partial<MlQuestion> = {}): MlQuestion {
  return {
    id: QUESTION_ID,
    seller_id: 179571326,
    buyer_id: 56801932,
    item_id: 'MLB739200576',
    status: 'UNANSWERED',
    text: 'Tem em azul?',
    date_created: '2026-02-08T17:51:21.000Z',
    last_updated: '2026-02-08T17:51:29.000Z',
    hold: false,
    deleted_from_listing: false,
    suspected_spam: false,
    answer: null,
    from: { id: 56801932, nickname: 'COMPRADOR_ML' },
    ...over,
  } as MlQuestion;
}

function api(over: Partial<MercadoLivreApi> = {}): MercadoLivreApi {
  return {
    getQuestion: vi.fn(async () => question()),
    getItem: vi.fn(async () => ({ title: 'Camiseta Azul' })),
    ...over,
  } as unknown as MercadoLivreApi;
}

function deps(db: FakeDb, apiOver: Partial<MercadoLivreApi> = {}) {
  return {
    db: asDb(db),
    api: api(apiOver),
    integracaoId: CONTA,
    conta: { userId: 179571326, cor: 7 },
    nowMs: NOW_MS,
  };
}

function resetCliente(id = 'cli1') {
  findOrCreateClienteMock.mockReset();
  findOrCreateClienteMock.mockResolvedValue({
    clienteId: id,
    created: true,
    matchedBy: null,
    rejected: [],
    dropped: [],
  });
}

describe('importQuestionMercadoLivre — the actionability gate', () => {
  it('imports an UNANSWERED question: conversa + the question mensagem', async () => {
    resetCliente();
    const db = new FakeDb();
    const res = await importQuestionMercadoLivre(deps(db), QUESTION_ID);

    const conversaId = makeConversaIdQuestion(CONTA, QUESTION_ID);
    expect(res).toMatchObject({ conversaId, clienteId: 'cli1', skipped: null });
    expect(db.docs(CHAT).get(conversaId)).toMatchObject({
      origem: 'mlperg',
      clienteOuterRef: 'documents/clientes/cli1',
      respostaBloqueada: null,
      atendido: false,
    });
    expect(db.docs(MENSAGENS(conversaId)).get(String(QUESTION_ID))).toMatchObject({
      conteudo: 'Tem em azul?',
      estadoEnvio: 7, // recebido — the customer side of the thread
    });
  });

  it('writes NOTHING for an unanswerable question with no existing thread', async () => {
    // The directive. Before it, the inbox filled with threads whose composer
    // could never send.
    resetCliente();
    const db = new FakeDb();
    const res = await importQuestionMercadoLivre(
      deps(db, { getQuestion: vi.fn(async () => question({ status: 'CLOSED_UNANSWERED' })) }),
      QUESTION_ID,
    );

    expect(res.skipped).toBe('nao-respondivel');
    expect(db.docs(CHAT).size).toBe(0);
    // Not even a cliente: a thread we will never show has no contact to record.
    expect(findOrCreateClienteMock).not.toHaveBeenCalled();
  });

  it('STILL processes an unanswerable question when the thread already exists', async () => {
    // The asymmetry that matters: the `questions` topic fires on ANSWERED too,
    // and that delivery is the only thing that can close the thread we opened
    // while it was unanswered. Skipping it leaves the conversa in Pendentes
    // forever.
    resetCliente();
    const db = new FakeDb();
    const conversaId = makeConversaIdQuestion(CONTA, QUESTION_ID);
    db.seed(CHAT, conversaId, { origem: 'mlperg', respostaBloqueada: null, atendido: false });

    const res = await importQuestionMercadoLivre(
      deps(db, {
        getQuestion: vi.fn(async () =>
          question({
            status: 'ANSWERED',
            answer: { text: 'Temos sim!', status: 'ACTIVE', date_created: null },
          }),
        ),
      }),
      QUESTION_ID,
    );

    expect(res.skipped).toBeNull();
    expect(db.docs(CHAT).get(conversaId)).toMatchObject({
      respostaBloqueada: 'Pergunta já respondida no Mercado Livre',
      atendido: true,
    });
    expect(db.docs(MENSAGENS(conversaId)).get(ANSWER_MENSAGEM_ID)).toMatchObject({
      conteudo: 'Temos sim!',
      estadoEnvio: 3, // enviado — the seller's side
    });
  });

  it('never writes estadoConversa, even when closing the thread', async () => {
    resetCliente();
    const db = new FakeDb();
    const conversaId = makeConversaIdQuestion(CONTA, QUESTION_ID);
    db.seed(CHAT, conversaId, { origem: 'mlperg', estadoConversa: 1 });

    await importQuestionMercadoLivre(
      deps(db, { getQuestion: vi.fn(async () => question({ status: 'ANSWERED' })) }),
      QUESTION_ID,
    );

    // The operator's triage state survives untouched.
    expect(db.docs(CHAT).get(conversaId)!.estadoConversa).toBe(1);
  });

  it('does not overwrite stored content with a BANNED answer, whose text ML strips', async () => {
    resetCliente();
    const db = new FakeDb();
    const conversaId = makeConversaIdQuestion(CONTA, QUESTION_ID);
    db.seed(CHAT, conversaId, { origem: 'mlperg' });
    db.seed(MENSAGENS(conversaId), ANSWER_MENSAGEM_ID, { conteudo: 'resposta original' });

    await importQuestionMercadoLivre(
      deps(db, {
        getQuestion: vi.fn(async () =>
          question({
            status: 'ANSWERED',
            answer: { text: '', status: 'BANNED', date_created: null },
          }),
        ),
      }),
      QUESTION_ID,
    );

    expect(db.docs(MENSAGENS(conversaId)).get(ANSWER_MENSAGEM_ID)!.conteudo).toBe(
      'resposta original',
    );
  });
});

describe('importQuestionMercadoLivre — identity and skips', () => {
  it('resolves the contact by ML buyer id and creates NO usuario', async () => {
    resetCliente();
    const db = new FakeDb();
    await importQuestionMercadoLivre(deps(db), QUESTION_ID);

    expect(findOrCreateClienteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fields: expect.objectContaining({
          idMercadoLivre: '56801932',
          nome: 'COMPRADOR_ML',
          // A pre-sale asker genuinely has none of these.
          cpf_cnpj: null,
          telefone: null,
          email: null,
        }),
      }),
    );
    expect(db.docs('usuarios').size).toBe(0);
  });

  it('skips a question on ANOTHER seller account', async () => {
    // ML delivers to the application, not to one seller.
    resetCliente();
    const db = new FakeDb();
    const res = await importQuestionMercadoLivre(
      deps(db, { getQuestion: vi.fn(async () => question({ seller_id: 999 })) }),
      QUESTION_ID,
    );
    expect(res.skipped).toBe('outra-conta');
    expect(db.docs(CHAT).size).toBe(0);
  });

  it('acks a 404 instead of poison-retrying it', async () => {
    resetCliente();
    const db = new FakeDb();
    const res = await importQuestionMercadoLivre(
      deps(db, {
        getQuestion: vi.fn(async () => {
          throw new MercadoLivreHttpError('ML 404: not found', 404, null, null);
        }),
      }),
      QUESTION_ID,
    );
    expect(res.skipped).toBe('question-404');
  });

  it('rethrows a non-404 ML failure so the queue retries', async () => {
    resetCliente();
    const db = new FakeDb();
    await expect(
      importQuestionMercadoLivre(
        deps(db, {
          getQuestion: vi.fn(async () => {
            throw new MercadoLivreHttpError('ML 500', 500, null, null);
          }),
        }),
        QUESTION_ID,
      ),
    ).rejects.toBeInstanceOf(MercadoLivreHttpError);
  });

  it('degrades to the item id when the title fetch fails', async () => {
    resetCliente();
    const db = new FakeDb();
    await importQuestionMercadoLivre(
      deps(db, {
        getItem: vi.fn(async () => {
          throw new MercadoLivreHttpError('ML 404', 404, null, null);
        }),
      }),
      QUESTION_ID,
    );
    const conversaId = makeConversaIdQuestion(CONTA, QUESTION_ID);
    expect(db.docs(CHAT).get(conversaId)!.nome).toBe('MLB739200576');
  });

  it('links the produto when the anúncio is one of ours', async () => {
    resetCliente();
    const db = new FakeDb();
    db.seed('produtos/prod1/produtoMercadoLivre', 'link1', {
      id: 'MLB739200576',
      contaOuterRef: `documents/integracao/${CONTA}`,
    });

    await importQuestionMercadoLivre(deps(db), QUESTION_ID);
    const conversaId = makeConversaIdQuestion(CONTA, QUESTION_ID);
    expect(db.docs(CHAT).get(conversaId)!.produtoOuterRef).toBe('documents/produtos/prod1');
  });

  it('is idempotent — a redelivery updates in place, never duplicating', async () => {
    // At-least-once is the contract from both ML and Cloud Tasks.
    resetCliente();
    const db = new FakeDb();
    await importQuestionMercadoLivre(deps(db), QUESTION_ID);
    await importQuestionMercadoLivre(deps(db), QUESTION_ID);

    const conversaId = makeConversaIdQuestion(CONTA, QUESTION_ID);
    expect(db.docs(CHAT).size).toBe(1);
    expect(db.docs(MENSAGENS(conversaId)).size).toBe(1);
  });
});
