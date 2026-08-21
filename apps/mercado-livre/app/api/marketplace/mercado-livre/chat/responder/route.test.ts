import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PERM } from '@delfrance/auth';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import { ChatOutboundRefusedError } from '@/lib/marketplace/chat/chatOutbound';

// The spine (`chatOutbound.ts`) is mocked — its behaviour is covered by
// `chatOutbound.test.ts`. What runs REAL here is the route's own job: the
// permission bit, body validation, how a refusal becomes a 409 carrying its own
// code, and how an ML error maps through `respond.ts`.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  responder: vi.fn(),
  resolveChannelContext: vi.fn(),
  loadCtx: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({ __db: true }) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

// Spread the ACTUAL module: `respond.ts` imports three error CLASSES from here,
// and a factory that returns only the loader makes every `instanceof` in the
// error mapper throw "No … export is defined on the mock".
vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/chat/chatOutbound', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/chat/chatOutbound')>();
  return { ...actual, responderConversaMercadoLivre: h.responder };
});

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/chat/responder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const OK = { integracaoId: 'int-1', conversaId: 'conv-1', texto: 'Temos sim!' };

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.resolveChannelContext.mockResolvedValue({ accessToken: 'tok' });
  h.loadCtx.mockResolvedValue({
    conta: { user_id: 415458330 },
    resolveChannelContext: h.resolveChannelContext,
  });
  h.responder.mockResolvedValue({
    conversaId: 'conv-1',
    mensagemId: 'msg-1',
    respostaBloqueada: null,
  });
});

describe('POST /api/marketplace/mercado-livre/chat/responder', () => {
  it('requires mensagem-write and hands the spine the conversa, the text and the seller', async () => {
    const res = await POST(req(OK));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conversaId: 'conv-1',
      mensagemId: 'msg-1',
      respostaBloqueada: null,
    });
    // Writing into a thread is a mensagem-level act — NOT the integração-admin
    // bit the rest of this app's routes use. An operator who can answer chat
    // must not need permission to reconnect the account.
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.mensagem.write);
    // The seller id comes off the CONTA, never off the conversa: a post-sale
    // send addresses `/messages/packs/{pack}/sellers/{sellerId}`, and a conversa
    // is not a trustworthy source for whose account is transmitting.
    expect(h.responder).toHaveBeenCalledWith(
      expect.objectContaining({ conta: { userId: 415458330 } }),
      { conversaId: 'conv-1', texto: 'Temos sim!' },
    );
  });

  it('degrades a non-numeric conta user_id to null instead of sending NaN to ML', async () => {
    h.loadCtx.mockResolvedValue({
      conta: { user_id: '415458330' },
      resolveChannelContext: h.resolveChannelContext,
    });
    await POST(req(OK));
    expect(h.responder).toHaveBeenCalledWith(
      expect.objectContaining({ conta: { userId: null } }),
      expect.anything(),
    );
  });

  it('answers 409 with the refusal’s OWN code and text, not a generic error', async () => {
    // The composer renders `error` verbatim: it is the only thing telling the
    // operator what to do next, so the route must not paraphrase it.
    h.responder.mockRejectedValue(
      new ChatOutboundRefusedError('Pergunta já respondida no Mercado Livre', 'ML_NAO_RESPONDIVEL'),
    );

    const res = await POST(req(OK));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Pergunta já respondida no Mercado Livre',
      code: 'ML_NAO_RESPONDIVEL',
    });
  });

  it('maps an ML rejection through respond.ts instead of 500ing', async () => {
    h.responder.mockRejectedValue(new MercadoLivreHttpError('ML 400', 400, null, null));
    const res = await POST(req(OK));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'ML_HTTP_ERROR' });
  });

  it('rethrows anything that is neither a refusal nor an ML error', async () => {
    // Repo rule 6: a generic catch here would turn a real bug into a 409 the
    // operator would keep retrying.
    h.responder.mockRejectedValue(new TypeError('boom'));
    await expect(POST(req(OK))).rejects.toBeInstanceOf(TypeError);
  });

  it('400s on malformed bodies without loading the account', async () => {
    expect((await POST(req({ conversaId: 'c', texto: 'x' }))).status).toBe(400);
    expect((await POST(req({ integracaoId: 'i', texto: 'x' }))).status).toBe(400);
    expect((await POST(req({ integracaoId: '  ', conversaId: 'c', texto: 'x' }))).status).toBe(400);
    expect((await POST(req({ integracaoId: 42, conversaId: 'c', texto: 'x' }))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.responder).not.toHaveBeenCalled();
  });

  it('lets the SPINE judge an empty body, rather than 400ing first', async () => {
    // `texto` is deliberately not a routing concern: the spine owns emptiness
    // AND the live per-thread length cap, so both refusals reach the operator
    // through one 409 shape with one vocabulary.
    h.responder.mockRejectedValue(
      new ChatOutboundRefusedError('A mensagem não pode ficar vazia.', 'ML_TEXTO_VAZIO'),
    );
    const res = await POST(req({ ...OK, texto: '   ' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ML_TEXTO_VAZIO' });
  });

  it('returns the auth refusal untouched, before touching Firestore or ML', async () => {
    h.verifyCaller.mockResolvedValue({
      error: NextResponse.json({ error: 'nope' }, { status: 403 }),
    });
    const res = await POST(req(OK));
    expect(res.status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });
});
