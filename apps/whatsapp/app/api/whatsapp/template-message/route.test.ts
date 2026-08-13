import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppHttpError } from '@delfrance/integrations-whatsapp-cloud-api';
import { mensagemDocId } from '@/lib/whatsapp/ids';
import { WhatsappTokenMissingError } from '@/lib/whatsapp/whatsapp';

// verifyCaller, the context loader, and the conversa/mensagem admin collections
// are mocked; the route's own logic (validation, origem gate, send-then-write
// pre-anchor, error mapping) runs real. The id derivations (mensagemDocId /
// fromNumberFromSenderId / idFromRef) run real so the pre-anchor id is exact.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  buildClient: vi.fn(),
  sendTemplate: vi.fn(),
  convGet: vi.fn(),
  convParseRead: vi.fn(),
  convMerge: vi.fn(async () => undefined),
  msgDocRef: vi.fn(),
  msgCreate: vi.fn(async () => undefined),
  msgParse: vi.fn((d: unknown) => d),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@delfrance/data/admin/collections', () => ({
  conversaCollection: {
    docRef: () => ({ get: h.convGet }),
    docPath: (_ctx: unknown, id: string) => `chat/${id}`,
    parseRead: h.convParseRead,
    merge: h.convMerge,
  },
  mensagemCollection: {
    docRef: h.msgDocRef,
    parse: h.msgParse,
  },
  // `lib/whatsapp/contaCache` builds its module-scope reader at import time and
  // this suite reaches it transitively. Never exercised here (the route's
  // context loader is mocked), and the reader touches the handle lazily.
  integracaoCollection: {},
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/whatsapp/whatsapp', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/whatsapp/whatsapp')>();
  return { ...actual, loadWhatsappContext: h.loadCtx };
});

const { POST } = await import('./route');

function postReq(body?: unknown): Request {
  return new Request('http://localhost:3008/api/whatsapp/template-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const WHATSAPP_CONVERSA = {
  origem: 'whatsapp',
  sender_id: '551133330000_5511999998888',
  integracaoOuterRef: 'documents/integracao/conta1',
  nome: 'Cliente',
};

const CONTA_ID = 'conta1';
const WAMID = 'wamid.tpl123';
const EXPECTED_MSG_ID = mensagemDocId(CONTA_ID, WAMID);

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.sendTemplate.mockResolvedValue({ messageId: WAMID });
  h.buildClient.mockResolvedValue({ sendTemplate: h.sendTemplate });
  h.loadCtx.mockResolvedValue({ integracaoId: CONTA_ID, buildClient: h.buildClient });
  h.convGet.mockResolvedValue({ exists: true, data: () => WHATSAPP_CONVERSA });
  h.convParseRead.mockImplementation((d: unknown) => d);
  h.msgDocRef.mockReturnValue({ create: h.msgCreate });
  h.msgCreate.mockResolvedValue(undefined);
});

describe('POST /api/whatsapp/template-message', () => {
  it('sends the template then pre-anchors the mensagem at mensagemDocId(contaId, wamid)', async () => {
    const res = await POST(postReq({ conversaId: 'c1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: WAMID });

    // Template sent to the recipient number derived from sender_id.
    expect(h.sendTemplate).toHaveBeenCalledWith({
      to: '5511999998888',
      templateName: 'reabertura_conversa',
    });

    // Pre-anchor: the doc id is the deterministic mensagemDocId(contaId, wamid).
    expect(h.msgDocRef).toHaveBeenCalledWith(
      expect.anything(),
      { conversaId: 'c1' },
      EXPECTED_MSG_ID,
    );
    // ...and the written doc carries mid = wamid + estadoEnvio = enviando (2).
    const written = h.msgParse.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.mid).toBe(WAMID);
    expect(written.estadoEnvio).toBe(2);
    expect(written.tipo).toBe('c');
    expect(written.conteudo).toBe('Olá, podemos dar continuidade no seu atendimento?');
    expect(written.user_id).toBe('u1');
    expect(written.usarioMensagemOuterRef).toBe('documents/usuarios/u1');
    expect(h.msgCreate).toHaveBeenCalledTimes(1);

    // Converter-stripped conversa bump.
    expect(h.convMerge).toHaveBeenCalledWith(
      expect.anything(),
      {},
      'c1',
      expect.objectContaining({ ultima_modificacao: expect.any(Number) }),
    );
  });

  it('400s without conversaId', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it('404s when the conversa does not exist', async () => {
    h.convGet.mockResolvedValue({ exists: false, data: () => undefined });
    const res = await POST(postReq({ conversaId: 'missing' }));
    expect(res.status).toBe(404);
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it('400s (WA_NOT_WHATSAPP) for a non-whatsapp conversa, without sending', async () => {
    h.convGet.mockResolvedValue({
      exists: true,
      data: () => ({ ...WHATSAPP_CONVERSA, origem: 'site' }),
    });
    const res = await POST(postReq({ conversaId: 'c1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('WA_NOT_WHATSAPP');
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it('403s by propagating the verifyCaller failure', async () => {
    h.verifyCaller.mockResolvedValue({
      error: new (await import('next/server')).NextResponse(null, { status: 403 }),
    });
    const res = await POST(postReq({ conversaId: 'c1' }));
    expect(res.status).toBe(403);
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it('maps a missing token to 409 (reauth) without writing a mensagem', async () => {
    h.buildClient.mockRejectedValue(new WhatsappTokenMissingError('sem token'));
    const res = await POST(postReq({ conversaId: 'c1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WA_REAUTH_REQUIRED');
    expect(h.msgCreate).not.toHaveBeenCalled();
  });

  it('returns 502 (WA_TEMPLATE_WRITE_FAILED) when the write fails after a successful send', async () => {
    h.msgCreate.mockRejectedValue(new Error('firestore unavailable'));
    const res = await POST(postReq({ conversaId: 'c1' }));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('WA_TEMPLATE_WRITE_FAILED');
    // The template WAS sent — that's the whole point of the loud 502.
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-Error create rejection (surfaces as 500, not WA_TEMPLATE_WRITE_FAILED)', async () => {
    // A non-Error throwable can't be a gRPC status, so it must propagate instead
    // of being masked as a 502 write failure.
    h.msgCreate.mockRejectedValue('firestore blew up');
    await expect(POST(postReq({ conversaId: 'c1' }))).rejects.toBe('firestore blew up');
    // The template WAS sent before the failed persist.
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('treats ALREADY_EXISTS (grpc 6) on the create as a redelivery and returns ok', async () => {
    h.msgCreate.mockRejectedValue(Object.assign(new Error('already exists'), { code: 6 }));
    const res = await POST(postReq({ conversaId: 'c1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: WAMID });
    // Idempotent: the conversa bump still runs.
    expect(h.convMerge).toHaveBeenCalledTimes(1);
  });
});
