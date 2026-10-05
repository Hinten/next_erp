import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// Authentication and the shared sender are seams. Validation, the recipient
// comparison and outbox transaction run here; outbound.test exercises the claim.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  dispatch: vi.fn(),
  messageRef: vi.fn(),
}));
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({
    runTransaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ get: h.get, create: h.create }),
  }),
}));
vi.mock('@delfrance/data/admin/collections', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data/admin/collections')>();
  return {
    ...actual,
    conversaCollection: { ...actual.conversaCollection, docRef: () => ({ id: 'c1' }) },
    mensagemCollection: { ...actual.mensagemCollection, docRef: h.messageRef },
  };
});
vi.mock('@/lib/auth/verifyCaller', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/auth/verifyCaller')>()),
  verifyCaller: h.verifyCaller,
}));
vi.mock('@/lib/whatsapp/outbound', () => ({ dispatchOutbound: h.dispatch }));
const { POST } = await import('./route');

const DESTINO = {
  tipo: 'bsuid',
  valor: 'BR.customer.identity',
  identidadeId: 'identity-1',
  revision: 3,
  ultimaMensagemEm: 1700000000000,
};
const BODY = { conversaId: 'c1', whatsappIntegracaoId: 'conta1', whatsappDestino: DESTINO };
const CONVERSA = {
  origem: 'whatsapp',
  integracaoOuterRef: 'documents/integracao/conta1',
  clienteOuterRef: 'documents/clientes/cliente-1',
  whatsappDestino: DESTINO,
};
function postReq(body: unknown = BODY): Request {
  return new Request('http://localhost:3008/api/whatsapp/template-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.get.mockResolvedValue({ exists: true, data: () => CONVERSA });
  h.messageRef.mockReturnValue({ id: 'outbox-doc' });
  h.create.mockReturnValue(undefined);
  h.dispatch.mockResolvedValue({ kind: 'sent', wamid: 'wamid.TEMPLATE' });
});

describe('POST /api/whatsapp/template-message', () => {
  it('persists the accepted BSUID and operator in the outbox before dispatching the shared sender', async () => {
    h.dispatch.mockImplementation(async () => {
      expect(h.create).toHaveBeenCalledTimes(1);
      return { kind: 'sent', wamid: 'wamid.TEMPLATE' };
    });
    const res = await POST(postReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: 'wamid.TEMPLATE' });
    const messageId = h.messageRef.mock.calls[0]![2];
    expect(h.create).toHaveBeenCalledWith(
      { id: 'outbox-doc' },
      expect.objectContaining({
        estadoEnvio: 1,
        mid: null,
        tipo: 'c',
        whatsappTemplate: 'reabertura_conversa',
        whatsappDestino: DESTINO,
        whatsappIntegracaoId: 'conta1',
        user_id: 'u1',
        usarioMensagemOuterRef: 'documents/usuarios/u1',
        clienteMensagemOuterRef: null,
      }),
    );
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      messageId,
      expect.objectContaining({ whatsappDestino: DESTINO }),
    );
  });

  it.each([
    {},
    { conversaId: 'c1' },
    { ...BODY, whatsappDestino: null },
    { ...BODY, conversaId: 'chat/c1' },
  ])('rejects incomplete or invalid recipient snapshots: %j', async (body) => {
    expect((await POST(postReq(body))).status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { exists: false, data: () => undefined },
    { exists: true, data: () => ({ ...CONVERSA, origem: 'site' }) },
    { exists: true, data: () => ({ ...CONVERSA, whatsappDestino: { ...DESTINO, revision: 4 } }) },
    {
      exists: true,
      data: () => ({ ...CONVERSA, integracaoOuterRef: 'documents/integracao/another' }),
    },
  ])('refuses a missing or changed conversation before creating the outbox', async (snapshot) => {
    h.get.mockResolvedValue(snapshot);
    const res = await POST(postReq());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WA_DESTINO_CONFLITO');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('propagates authorization denial without reading or writing conversation data', async () => {
    h.verifyCaller.mockResolvedValue({ error: new NextResponse(null, { status: 403 }) });
    expect((await POST(postReq())).status).toBe(403);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('never sends if persisting the outbox fails', async () => {
    h.create.mockImplementation(() => {
      throw new Error('firestore unavailable');
    });
    await expect(POST(postReq())).rejects.toThrow('firestore unavailable');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('returns the send failure while preserving the already accepted outbox', async () => {
    h.dispatch.mockResolvedValue({ kind: 'error', reason: 'Token ausente' });
    const res = await POST(postReq());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Token ausente', code: 'WA_TEMPLATE_SEND_FAILED' });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('returns the outbox id when another dispatcher already claimed the message', async () => {
    h.dispatch.mockResolvedValue({ kind: 'skipped', reason: 'claimed' });
    const res = await POST(postReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: h.messageRef.mock.calls[0]![2] });
  });
});
