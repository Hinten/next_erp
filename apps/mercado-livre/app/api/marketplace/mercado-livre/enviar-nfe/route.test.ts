import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { ESTADO_NFE, INTEGRACAO_FRETE } from '@delfrance/schemas';

import { MlTasksDisabledError } from '@/lib/marketplace/notificacoes/mlTasks';

// Auth, Firestore transport and the scheduler are mocked. The handler runs
// eligibility and pedido checks against snapshots from the fake Firestore.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  get: vi.fn(),
  docPaths: [] as string[],
  schedEnqueue: vi.fn(async (_payload: unknown) => {}),
}));

// Fake Firestore exposing only the collection().doc().get() chain the route
// exercises — the real nfev4Collection handle resolves the path against it, so
// the `pedidos/{pedidoId}/nfev4` context wiring is covered too.
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({
    collection: (path: string) => ({
      doc: (id: string) => ({
        get: () => {
          const docPath = `${path}/${id}`;
          h.docPaths.push(docPath);
          return h.get(docPath);
        },
      }),
    }),
  }),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/nfe/mlNfeUploadTasks', () => ({
  createMlNfeUploadScheduler: () => ({ enqueue: h.schedEnqueue }),
}));

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/enviar-nfe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const NFE_PATH = 'pedidos/ped-1/nfev4/s1';
const PEDIDO_PATH = 'pedidos/ped-1';
const XML_VENDA = '<nfeProc><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide></nfeProc>';
const DOC = { estado: ESTADO_NFE.aprovada, xml_nfe_proc: XML_VENDA };
const PEDIDO = { freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre } };

beforeEach(() => {
  vi.clearAllMocks();
  h.docPaths.length = 0;
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.get.mockReset().mockImplementation(async (path: string) => {
    const doc = path === NFE_PATH ? DOC : path === PEDIDO_PATH ? PEDIDO : undefined;
    return { exists: doc !== undefined, data: () => doc };
  });
  h.schedEnqueue.mockResolvedValue(undefined);
});

describe('POST /api/marketplace/mercado-livre/enviar-nfe', () => {
  it('requires pedido-write, reads the nfev4 doc, gates doc + pedido, enqueues and 202s', async () => {
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: true });

    // Pedido-write scoping (expedição staff), not the integração admin perm.
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.pedido.write);
    expect(h.docPaths).toEqual([NFE_PATH, PEDIDO_PATH]);
    expect(h.schedEnqueue).toHaveBeenCalledWith({ pedidoId: 'ped-1', nfeId: 's1' });
  });

  it('202s on EVERY eligible call — repeat sends are idempotent via the task shipment gate', async () => {
    // No em-andamento / ja-resolvida state exists (zero-write model): the same
    // request enqueues again every time; a duplicate task no-ops at the
    // shipment-status gate. This route IS Step 13's manual retry channel.
    const first = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    const second = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ enqueued: true });
    expect(h.docPaths).toEqual([NFE_PATH, PEDIDO_PATH, NFE_PATH, PEDIDO_PATH]);
    expect(h.schedEnqueue).toHaveBeenCalledTimes(2);
  });

  it('400s on missing fields, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({ nfeId: 's1' }))).status).toBe(400);
    expect((await POST(req({ pedidoId: 'ped-1' }))).status).toBe(400);
    expect((await POST(req({ pedidoId: '', nfeId: 's1' }))).status).toBe(400);
    expect((await POST(req({ pedidoId: 'ped-1', nfeId: 42 }))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('404s NFE_NAO_ENCONTRADA when the NF-e doc does not exist', async () => {
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 'missing' }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NFE_NAO_ENCONTRADA');
    expect(h.docPaths).toEqual(['pedidos/ped-1/nfev4/missing']);
    expect(h.schedEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['nao-aprovada', { ...DOC, estado: ESTADO_NFE.cancelada }],
    ['tpamb-homologacao', { ...DOC, xml_nfe_proc: XML_VENDA.replace('tpAmb>1', 'tpAmb>2') }],
    ['nfe-nao-e-de-venda', { ...DOC, xml_nfe_proc: XML_VENDA.replace('finNFe>1', 'finNFe>4') }],
    ['xml-invalido', { ...DOC, xml_nfe_proc: XML_VENDA.replace('<finNFe>1</finNFe>', '') }],
  ])('returns 409 for %s after reading only the NF-e', async (reason, doc) => {
    h.get.mockResolvedValueOnce({ exists: true, data: () => doc });
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NFE_NAO_ELEGIVEL');
    expect(body.reason).toBe(reason);
    expect(h.docPaths).toEqual([NFE_PATH]);
    expect(h.schedEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['pedido-nao-encontrado', undefined],
    [
      'nao-mercado-livre',
      { freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios } },
    ],
    ['sem-integracao', { freteInicial: null, integracaoPedidoOuterRef: null }],
  ])('returns 409 for an ineligible pedido (%s)', async (reason, pedido) => {
    h.get.mockResolvedValueOnce({ exists: true, data: () => DOC });
    h.get.mockResolvedValueOnce({ exists: pedido !== undefined, data: () => pedido });
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NFE_NAO_ELEGIVEL');
    expect(body.reason).toBe(reason);
    expect(typeof body.error).toBe('string');
    expect(h.docPaths).toEqual([NFE_PATH, PEDIDO_PATH]);
    expect(h.schedEnqueue).not.toHaveBeenCalled();
  });

  it('503s ML_NFE_UPLOAD_ENQUEUE_FAILED when the tasks valve is shut (MlTasksDisabledError)', async () => {
    h.schedEnqueue.mockRejectedValue(new MlTasksDisabledError());
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('ML_NFE_UPLOAD_ENQUEUE_FAILED');
  });

  it('rethrows an unexpected enqueue failure instead of masking it as a 503', async () => {
    h.schedEnqueue.mockRejectedValue(new Error('cloudtasks down'));
    await expect(POST(req({ pedidoId: 'ped-1', nfeId: 's1' }))).rejects.toThrow('cloudtasks down');
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(403);
    expect(h.get).not.toHaveBeenCalled();
  });
});
