import { describe, expect, it } from 'vitest';
import { ESTADO_ENVIO, ORIGEM_CONVERSA } from '@delfrance/schemas';
import type { MlQuestion } from '@delfrance/integrations-mercado-livre';

import {
  ANSWER_MID,
  buildAnswerMensagem,
  buildConversaFromQuestion,
  buildQuestionMensagem,
  questionActionability,
  questionBuyerId,
  questionExternalLink,
} from './questionMapping';

const NOW_MS = 1_753_180_800_000;

function question(over: Partial<MlQuestion> = {}): MlQuestion {
  return {
    id: 11751825075,
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
    from: null,
    ...over,
  } as MlQuestion;
}

describe('questionActionability — "import only what we can respond to"', () => {
  it('is answerable ONLY for UNANSWERED', () => {
    expect(questionActionability(question())).toEqual({ podeResponder: true, motivo: null });
  });

  it.each([
    ['ANSWERED', 'Pergunta já respondida no Mercado Livre'],
    ['CLOSED_UNANSWERED', 'Anúncio encerrado sem resposta'],
    ['UNDER_REVIEW', 'Anúncio em revisão pelo Mercado Livre'],
    ['BANNED', 'Pergunta bloqueada pelo Mercado Livre'],
    ['DELETED', 'Pergunta excluída no Mercado Livre'],
    ['DISABLED', 'Pergunta excluída no Mercado Livre'],
  ])('refuses %s with an operator-facing reason', (status, motivo) => {
    // `POST /answers` only succeeds on UNANSWERED, so every other status is a
    // thread whose composer would be lying.
    expect(questionActionability(question({ status }))).toEqual({ podeResponder: false, motivo });
  });

  it('reads the status case-insensitively', () => {
    // ML prints these UPPERCASE in its payload samples and lowercase in its
    // prose table, and the legacy Dart enum parsed the lowercase spelling. A
    // strict compare would call a perfectly answerable question unsupported.
    expect(questionActionability(question({ status: 'unanswered' })).podeResponder).toBe(true);
    expect(questionActionability(question({ status: ' Unanswered ' })).podeResponder).toBe(true);
  });

  it.each([
    ['hold', 'Pergunta retida pelo Mercado Livre'],
    ['deleted_from_listing', 'Pergunta removida do anúncio'],
    ['suspected_spam', 'Pergunta marcada como spam pelo Mercado Livre'],
  ] as const)('refuses an UNANSWERED question flagged %s', (flag, motivo) => {
    // Status alone is not enough: all three flags make an unanswered question
    // one we must not act on, and ML documents each.
    expect(questionActionability(question({ [flag]: true }))).toEqual({
      podeResponder: false,
      motivo,
    });
  });

  it('refuses an ML status it has never seen, rather than assuming answerable', () => {
    // A false "you can reply" is the #817 failure mode — a composer that accepts
    // text nothing transmits. A false "you cannot" is visible and recoverable.
    const acao = questionActionability(question({ status: 'ALGO_NOVO' }));
    expect(acao.podeResponder).toBe(false);
    expect(acao.motivo).toContain('ALGO_NOVO');
  });

  it('refuses a question with no status at all', () => {
    expect(questionActionability(question({ status: null })).podeResponder).toBe(false);
  });
});

describe('questionBuyerId', () => {
  it('prefers buyer_id, falls back to from.id', () => {
    expect(questionBuyerId(question())).toBe(56801932);
    expect(questionBuyerId(question({ buyer_id: null, from: { id: 999, nickname: 'x' } }))).toBe(
      999,
    );
    expect(questionBuyerId(question({ buyer_id: null, from: null }))).toBeNull();
  });
});

describe('questionExternalLink', () => {
  it('builds the public anúncio URL without an ML call', () => {
    expect(questionExternalLink('MLB739200576')).toBe(
      'https://produto.mercadolivre.com.br/MLB-739200576',
    );
  });

  it('is null when there is no item', () => {
    expect(questionExternalLink(null)).toBeNull();
    expect(questionExternalLink('  ')).toBeNull();
  });
});

describe('buildConversaFromQuestion', () => {
  const ctx = {
    clienteOuterRef: 'documents/clientes/cli1',
    integracaoOuterRef: 'documents/integracao/conta1',
    produtoOuterRef: 'documents/produtos/prod1',
    tituloAnuncio: 'Camiseta Azul',
    corEtiqueta: 7,
    nowMs: NOW_MS,
    acao: { podeResponder: true, motivo: null },
  };

  it('links the contact as a CLIENTE and writes no usuario ref at all', () => {
    const c = buildConversaFromQuestion(question(), ctx);
    expect(c.clienteOuterRef).toBe('documents/clientes/cli1');
    expect(c.origem).toBe(ORIGEM_CONVERSA.mercadoLivrePerguntas);
    // The whole point of #532's identity change: no synthetic usuario is minted,
    // so the conversa must not claim one.
    expect(c).not.toHaveProperty('usarioOuterRef');
  });

  it('NEVER writes estadoConversa — that is operator triage state', () => {
    // `claimImport` restores it after every merge for exactly this reason. A
    // webhook writing it clobbers whoever is mid-triage.
    expect(buildConversaFromQuestion(question(), ctx)).not.toHaveProperty('estadoConversa');
    expect(
      buildConversaFromQuestion(question({ status: 'ANSWERED' }), {
        ...ctx,
        acao: { podeResponder: false, motivo: 'x' },
      }),
    ).not.toHaveProperty('estadoConversa');
  });

  it('carries the block reason and marks it atendido when unanswerable', () => {
    const c = buildConversaFromQuestion(question({ status: 'ANSWERED' }), {
      ...ctx,
      acao: { podeResponder: false, motivo: 'Pergunta já respondida no Mercado Livre' },
    });
    expect(c.respostaBloqueada).toBe('Pergunta já respondida no Mercado Livre');
    expect(c.atendido).toBe(true);
  });

  it('leaves respostaBloqueada null and atendido false while answerable', () => {
    const c = buildConversaFromQuestion(question(), ctx);
    expect(c.respostaBloqueada).toBeNull();
    expect(c.atendido).toBe(false);
  });

  it('names the thread after the anúncio, falling back to the item id', () => {
    expect(buildConversaFromQuestion(question(), ctx).nome).toBe('Camiseta Azul');
    expect(buildConversaFromQuestion(question(), { ...ctx, tituloAnuncio: null }).nome).toBe(
      'MLB739200576',
    );
  });

  it('converts ML ISO datetimes to epoch MILLIS', () => {
    const c = buildConversaFromQuestion(question(), ctx);
    expect(c.data_cadastro).toBe(Date.parse('2026-02-08T17:51:21.000Z'));
    expect(c.ultimaModificacaoIntegracao).toBe(Date.parse('2026-02-08T17:51:29.000Z'));
  });
});

describe('buildQuestionMensagem', () => {
  it('stamps RECEBIDO, which is what puts the bubble on the customer side', () => {
    // Legacy wrote `enviado` here (models.dart:6672) for the BUYER'S OWN
    // question. `MensagemBubble` reads `estadoEnvio === recebido` to decide the
    // customer side, and this import writes no `user_id` for it to fall back on,
    // so the legacy value would render the buyer's question as outbound. It is
    // also what raises the "aguardando resposta" badge.
    const m = buildQuestionMensagem(question(), {
      clienteOuterRef: 'documents/clientes/c1',
      nowMs: NOW_MS,
    });
    expect(m.estadoEnvio).toBe(ESTADO_ENVIO.recebido);
    expect(m.clienteMensagemOuterRef).toBe('documents/clientes/c1');
    expect(m).not.toHaveProperty('user_id');
  });

  it('keys mid on the ML question id', () => {
    expect(buildQuestionMensagem(question(), { clienteOuterRef: null, nowMs: NOW_MS }).mid).toBe(
      '11751825075',
    );
  });
});

describe('buildAnswerMensagem', () => {
  it('stamps ENVIADO — the seller sent it, here or on ML', () => {
    const m = buildAnswerMensagem(
      question({ answer: { text: 'Temos sim', status: 'ACTIVE', date_created: null } }),
      { nowMs: NOW_MS },
    );
    expect(m.estadoEnvio).toBe(ESTADO_ENVIO.enviado);
    expect(m.conteudo).toBe('Temos sim');
    expect(m.mid).toBe(ANSWER_MID);
  });
});
