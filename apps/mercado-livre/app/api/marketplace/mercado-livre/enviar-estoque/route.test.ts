import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// verifyCaller / the context loader / the ML client / the orchestrator are
// mocked; the route's OWN logic (body validation, the selection cap, the pause
// pre-check, guard-error mapping) runs for real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  createApi: vi.fn(),
  syncDocRef: vi.fn(),
  enviarEstoqueManual: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/estoqueManual', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/estoqueManual')>();
  return { ...actual, enviarEstoqueManual: h.enviarEstoqueManual };
});

vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createApi };
});

vi.mock('@delfrance/data/admin/collections', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data/admin/collections')>();
  return {
    ...actual,
    estoqueMercadoLivreSyncCollection: {
      ...actual.estoqueMercadoLivreSyncCollection,
      docRef: h.syncDocRef,
    },
  };
});

const { POST } = await import('./route');
const { ManualPushGuardError, MANUAL_PUSH_MAX_PRODUTOS } =
  await import('@/lib/marketplace/estoqueManual');

const CONTA = 'int-1';

function post(body: unknown): Request {
  return new Request('http://localhost/api/marketplace/mercado-livre/enviar-estoque', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const RESPOSTA_VAZIA = {
  canal: 'mercado-livre',
  integracaoId: CONTA,
  contaNome: 'Loja',
  solicitados: 1,
  familias: 1,
  resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [],
  produtosSemEnvio: [],
  pausadoAte: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: '0xff' } });
  h.loadCtx.mockResolvedValue({
    conta: { depositoOuterRef: 'documents/depositos/D1', nome: 'Loja' },
    resolveChannelContext: vi.fn().mockResolvedValue({ accessToken: 'tok' }),
  });
  h.createApi.mockReturnValue({ getItem: vi.fn(), getMe: vi.fn() });
  h.syncDocRef.mockReturnValue({ get: vi.fn().mockResolvedValue({ data: () => ({}) }) });
  h.enviarEstoqueManual.mockResolvedValue(RESPOSTA_VAZIA);
});

describe('POST enviar-estoque — auth + body validation', () => {
  it('propagates the verifyCaller rejection (PERM.integracao.write)', async () => {
    h.verifyCaller.mockResolvedValue({
      error: NextResponse.json({ error: 'nope' }, { status: 403 }),
    });
    expect((await POST(post({ integracaoId: CONTA, produtoIds: ['p1'] }))).status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it.each([
    ['no integracaoId', { produtoIds: ['p1'] }],
    ['empty selection', { integracaoId: CONTA, produtoIds: [] }],
    ['not an array', { integracaoId: CONTA, produtoIds: 'p1' }],
    // TYPE-checked, not truthiness: a truthy non-string would sail past a
    // `!value` guard and throw deep inside `.doc(id)` — a 500 for a client error.
    ['a numeric id', { integracaoId: CONTA, produtoIds: [1] }],
    ['a non-boolean flag', { integracaoId: CONTA, produtoIds: ['p1'], reenviarComErro: 'sim' }],
  ])('400s on %s', async (_label, body) => {
    expect((await POST(post(body))).status).toBe(400);
    expect(h.enviarEstoqueManual).not.toHaveBeenCalled();
  });

  it('400s on malformed JSON rather than throwing', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', body: '{' });
    expect((await POST(req)).status).toBe(400);
  });

  /**
   * Legacy parity (produtoTableView.dart:1153) — and REJECT, never truncate.
   * Silently dropping the tail of a 200-item selection under a green summary is
   * the silent-under-send failure this whole area is built to avoid.
   */
  it('rejects an oversize selection instead of truncating it', async () => {
    const produtoIds = Array.from(
      { length: MANUAL_PUSH_MAX_PRODUTOS + 1 },
      (_, i) => `p${String(i)}`,
    );
    const res = await POST(post({ integracaoId: CONTA, produtoIds }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'ML_SELECAO_EXCEDE_LIMITE',
      limite: MANUAL_PUSH_MAX_PRODUTOS,
    });
    expect(h.enviarEstoqueManual).not.toHaveBeenCalled();
  });

  it('counts the selection cap AFTER dedup', async () => {
    const produtoIds = Array.from({ length: MANUAL_PUSH_MAX_PRODUTOS + 5 }, () => 'mesmo-id');
    expect((await POST(post({ integracaoId: CONTA, produtoIds }))).status).toBe(200);
  });
});

describe('POST enviar-estoque — conta state', () => {
  it('409s while the conta is rate-limit paused, without touching ML', async () => {
    const futuroUs = (Date.now() + 5 * 60_000) * 1000;
    h.syncDocRef.mockReturnValue({
      get: vi.fn().mockResolvedValue({ data: () => ({ pausedUntilUs: futuroUs }) }),
    });
    const res = await POST(post({ integracaoId: CONTA, produtoIds: ['p1'] }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'ML_CONTA_PAUSADA' });
    // The whole point of the pre-check: it saves up to 50 pointless ML calls.
    expect(h.enviarEstoqueManual).not.toHaveBeenCalled();
  });

  it('an EXPIRED pause does not block the push', async () => {
    h.syncDocRef.mockReturnValue({
      get: vi.fn().mockResolvedValue({ data: () => ({ pausedUntilUs: 1_000 }) }),
    });
    expect((await POST(post({ integracaoId: CONTA, produtoIds: ['p1'] }))).status).toBe(200);
  });

  it('maps a conta guard failure onto its own status + code', async () => {
    h.enviarEstoqueManual.mockRejectedValue(
      new ManualPushGuardError('ML_CONTA_MULTIORIGEM', 409, 'conta multiorigem'),
    );
    const res = await POST(post({ integracaoId: CONTA, produtoIds: ['p1'] }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'ML_CONTA_MULTIORIGEM' });
  });
});

describe('POST enviar-estoque — success', () => {
  it('returns the envelope and passes the opt-in through', async () => {
    const res = await POST(
      post({ integracaoId: CONTA, produtoIds: ['p1', 'p2'], reenviarComErro: true }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ canal: 'mercado-livre' });
    expect(h.enviarEstoqueManual).toHaveBeenCalledWith(
      expect.anything(),
      { integracaoId: CONTA, produtoIds: ['p1', 'p2'], reenviarComErro: true },
      expect.objectContaining({ contaNome: 'Loja' }),
    );
  });

  it('defaults reenviarComErro to false — re-arming is never implicit', async () => {
    await POST(post({ integracaoId: CONTA, produtoIds: ['p1'] }));
    expect(h.enviarEstoqueManual.mock.calls[0]![1]).toMatchObject({ reenviarComErro: false });
  });

  /**
   * Per-listing failure is DATA, not an HTTP error: a valid request answers 200
   * even when every listing failed, which is what makes the envelope usable.
   */
  it('answers 200 even when every listing failed', async () => {
    h.enviarEstoqueManual.mockResolvedValue({
      ...RESPOSTA_VAZIA,
      resumo: { enviados: 0, pulados: 0, falhas: 2, naoTentados: 0 },
    });
    expect((await POST(post({ integracaoId: CONTA, produtoIds: ['p1'] }))).status).toBe(200);
  });
});
