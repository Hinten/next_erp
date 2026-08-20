import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PERM } from '@delfrance/auth';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import { ChatOutboundRefusedError } from '@/lib/marketplace/chatOutbound';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  acao: vi.fn(),
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
vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/chatOutbound', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/chatOutbound')>();
  return { ...actual, acaoPerguntaMercadoLivre: h.acao };
});

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/chat/pergunta-acao', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const OK = { integracaoId: 'int-1', conversaId: 'conv-1', acao: 'excluir' };

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.resolveChannelContext.mockResolvedValue({ accessToken: 'tok' });
  h.loadCtx.mockResolvedValue({
    conta: { user_id: 415458330 },
    resolveChannelContext: h.resolveChannelContext,
  });
  h.acao.mockResolvedValue({ conversaId: 'conv-1', acao: 'excluir' });
});

describe('POST /api/marketplace/mercado-livre/chat/pergunta-acao', () => {
  it('is gated on mensagem-DELETE, not mensagem-write', async () => {
    // ⚠️ The one assertion in this file worth reading twice. Both actions are
    // public and irreversible from here — a deleted question leaves the listing
    // for everyone, a blocked buyer cannot ask on any of the seller's items.
    // Sharing the reply bit would hand every attendant a moderation tool.
    const res = await POST(req(OK));
    expect(res.status).toBe(200);
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.mensagem.delete);
    expect(h.verifyCaller).not.toHaveBeenCalledWith(expect.anything(), PERM.mensagem.write);
  });

  it('passes the action through and echoes the spine’s result', async () => {
    h.acao.mockResolvedValue({ conversaId: 'conv-1', acao: 'bloquear' });
    const res = await POST(req({ ...OK, acao: 'bloquear' }));
    expect(await res.json()).toEqual({ conversaId: 'conv-1', acao: 'bloquear' });
    expect(h.acao).toHaveBeenCalledWith(expect.objectContaining({ conta: { userId: 415458330 } }), {
      conversaId: 'conv-1',
      acao: 'bloquear',
    });
  });

  it('400s on an action outside the allow-list, without reaching ML', async () => {
    // An allow-list, not a denylist: an unrecognised verb must never be
    // forwarded to a destructive endpoint on the chance that it means nothing.
    for (const acao of ['responder', 'EXCLUIR', '', 'delete', 42, null]) {
      expect((await POST(req({ ...OK, acao }))).status, String(acao)).toBe(400);
    }
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.acao).not.toHaveBeenCalled();
  });

  it('400s on malformed bodies without loading the account', async () => {
    expect((await POST(req({ conversaId: 'c', acao: 'excluir' }))).status).toBe(400);
    expect((await POST(req({ integracaoId: 'i', acao: 'excluir' }))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('answers 409 with the refusal’s own code', async () => {
    h.acao.mockRejectedValue(
      new ChatOutboundRefusedError(
        'Ação disponível apenas em perguntas do Mercado Livre.',
        'ML_ORIGEM_SEM_ENVIO',
      ),
    );
    const res = await POST(req(OK));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ML_ORIGEM_SEM_ENVIO' });
  });

  it('maps an ML rejection through respond.ts and rethrows the rest', async () => {
    h.acao.mockRejectedValue(new MercadoLivreHttpError('ML 403', 403, null, null));
    expect((await POST(req(OK))).status).toBe(502);

    h.acao.mockRejectedValue(new TypeError('boom'));
    await expect(POST(req(OK))).rejects.toBeInstanceOf(TypeError);
  });

  it('returns the auth refusal untouched, before touching Firestore or ML', async () => {
    h.verifyCaller.mockResolvedValue({
      error: NextResponse.json({ error: 'nope' }, { status: 403 }),
    });
    expect((await POST(req(OK))).status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });
});
