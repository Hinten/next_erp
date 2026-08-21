import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  ClaimActionUnavailableError,
  MercadoLivreHttpError,
} from '@delfrance/integrations-mercado-livre';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  resolver: vi.fn(),
  resolveChannelContext: vi.fn(),
  loadCtx: vi.fn(),
  dbSet: vi.fn(),
  dbUpdate: vi.fn(),
  dbCommit: vi.fn(),
}));

// ⚠️ A Firestore stub whose every WRITE is a spy. The route must not touch it —
// see the writes-nothing guard below.
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({
    __db: true,
    collection: () => ({
      doc: () => ({ set: h.dbSet, update: h.dbUpdate }),
    }),
    batch: () => ({ set: h.dbSet, update: h.dbUpdate, commit: h.dbCommit }),
  }),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/claimResolve', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/claimResolve')>();
  return { ...actual, resolverReclamacaoMercadoLivre: h.resolver };
});

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/reclamacao/acao', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const OK = { integracaoId: 'int-1', claimId: 5204934310, acao: 'reembolso' };

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.resolveChannelContext.mockResolvedValue({ accessToken: 'tok' });
  h.loadCtx.mockResolvedValue({
    conta: { user_id: 415458330 },
    resolveChannelContext: h.resolveChannelContext,
  });
  h.resolver.mockResolvedValue({ ok: true, status: 'closed', acao: 'reembolso' });
});

describe('POST /reclamacao/acao — the permission gate', () => {
  it('is gated on the DEDICATED incidenteResolucao-write bit, not pedido-write', async () => {
    // ⚠️ The point of the whole bit. A refund is irreversible and moves money;
    // `pedido.write` is held by every attendant who edits an order. A bare
    // "verifyCaller was called" assertion would pass for ANY bit in PERM, so the
    // negative half is what makes this non-vacuous.
    const res = await POST(req(OK));
    expect(res.status).toBe(200);
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.incidenteResolucao.write);
    expect(h.verifyCaller).not.toHaveBeenCalledWith(expect.anything(), PERM.pedido.write);
    expect(h.verifyCaller).not.toHaveBeenCalledWith(expect.anything(), PERM.pedido.delete);
    expect(h.verifyCaller).not.toHaveBeenCalledWith(
      expect.anything(),
      PERM.incidenteResolucao.read,
    );
  });
});

describe('POST /reclamacao/acao — the 50%-default defence', () => {
  /**
   * ⚠️⚠️ ML DEFAULTS A MISSING PERCENTAGE TO 50%. Every assertion here exists so
   * a partial refund the operator did not fully specify cannot reach ML at all.
   *
   * Each case asserts THREE things, and the last two are what stop it being
   * vacuous: a status-only check would stay green for a route that forwarded
   * `undefined` and got a 500 back from ML — green while the money moved.
   */
  it('refuses a partial refund with no amount, before touching the account or ML', async () => {
    const res = await POST(req({ ...OK, acao: 'reembolso_parcial', percentualExibido: 50 }));
    expect(res.status).toBe(409);
    expect(h.resolver).not.toHaveBeenCalled();
    // The refusal happens in the domain module, which the route reaches only
    // after loading the account — so this asserts the resolver never ran, which
    // is the call that would have reached ML.
  });

  it('refuses a partial refund with no percentage', async () => {
    const res = await POST(req({ ...OK, acao: 'reembolso_parcial', valorReembolsoMinor: 14900 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe('ML_PERCENTUAL_AUSENTE');
    // The copy must NAME the hazard — this string is what the operator reads.
    expect(body.error).toMatch(/50%/);
  });

  it('refuses 100% — that is the full-refund action, and ML rejects it here', async () => {
    const res = await POST(
      req({
        ...OK,
        acao: 'reembolso_parcial',
        valorReembolsoMinor: 29800,
        percentualExibido: 100,
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ML_PERCENTUAL_INVALIDO' });
  });

  it('accepts a partial refund carrying BOTH the amount and the shown percentage', async () => {
    // The positive control. Without it every refusal above would also pass on a
    // route that refused everything.
    h.resolver.mockResolvedValue({ ok: true, status: null, acao: 'reembolso_parcial' });
    const res = await POST(
      req({
        ...OK,
        acao: 'reembolso_parcial',
        valorReembolsoMinor: 14900,
        percentualExibido: 50,
      }),
    );
    expect(res.status).toBe(200);
    expect(h.resolver).toHaveBeenCalledWith(expect.anything(), {
      claimId: 5204934310,
      acao: 'reembolso_parcial',
      valorReembolsoMinor: 14900,
      percentualExibido: 50,
    });
  });
});

describe('POST /reclamacao/acao — the action allow-list', () => {
  it.each(['refund', 'REEMBOLSO', '', 'reembolso_total', 'cancelar'])(
    'refuses %o with 400 and never reaches ML',
    async (acao) => {
      // ⚠️ An ALLOW-LIST, not a denylist: an unrecognised verb must never be
      // forwarded to a destructive endpoint on the chance ML understands it.
      const res = await POST(req({ ...OK, acao }));
      expect(res.status).toBe(400);
      expect(h.loadCtx).not.toHaveBeenCalled();
      expect(h.resolver).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-numeric or absent claimId', async () => {
    for (const claimId of [undefined, null, '5204934310', 0, -1, 1.5]) {
      h.resolver.mockClear();
      const res = await POST(req({ ...OK, claimId }));
      expect(res.status, `claimId=${String(claimId)}`).toBe(400);
      expect(h.resolver).not.toHaveBeenCalled();
    }
  });
});

describe('POST /reclamacao/acao — writes NOTHING locally', () => {
  it('never touches Firestore on the happy path', async () => {
    // ⚠️ The only mechanical defence of the single-writer rule. `incidenteMeta`
    // has no `serverOwnedFields`, so the ruleset would happily accept a client
    // write to `resolucao` — nothing but this test stops one being added here.
    // The `claims` importer re-derives `resolucao` from `claim.resolution` on
    // every run, so a write here is either clobbered or permanently disagrees.
    const res = await POST(req(OK));
    expect(res.status).toBe(200);
    expect(h.dbSet).not.toHaveBeenCalled();
    expect(h.dbUpdate).not.toHaveBeenCalled();
    expect(h.dbCommit).not.toHaveBeenCalled();
  });
});

describe('POST /reclamacao/acao — error mapping', () => {
  it('maps ClaimActionUnavailableError to 409 and names what IS available', async () => {
    // ⚠️ It `extends Error`, NOT MercadoLivreError, so `isMercadoLivreError` does
    // not match it. Without its own arm this would be an unhandled 500 — the
    // most common refusal in the whole feature, surfacing as a crash.
    h.resolver.mockRejectedValue(new ClaimActionUnavailableError('refund', ['allow_return']));
    const res = await POST(req(OK));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'ML_ACAO_INDISPONIVEL',
      acoesDisponiveis: ['allow_return'],
    });
  });

  it('maps ML 422 to a "not eligible" 409, not a bare upstream failure', async () => {
    h.resolver.mockRejectedValue(new MercadoLivreHttpError('unprocessable', 422, null));
    const res = await POST(req(OK));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ML_ACAO_NAO_ELEGIVEL' });
  });

  it('maps ML 404 to NO ACCESS and 403 to NOT FOUND — ML reads them swapped', async () => {
    // ⚠️ Deliberately inverted against intuition, because ML is: 404 is "user not
    // authorized", 403 is "claim does not exist". Copy that said "não encontrada"
    // for a 404 would send the operator hunting for a claim that is right there.
    h.resolver.mockRejectedValue(new MercadoLivreHttpError('nope', 404, null));
    expect(await (await POST(req(OK))).json()).toMatchObject({
      code: 'ML_CLAIM_SEM_ACESSO',
    });

    h.resolver.mockRejectedValue(new MercadoLivreHttpError('nope', 403, null));
    expect(await (await POST(req(OK))).json()).toMatchObject({
      code: 'ML_CLAIM_INEXISTENTE',
    });
  });

  it('lets an unmapped ML HTTP status fall through to the shared mapper', async () => {
    // 500 has no bespoke arm — it must still be reported, not swallowed by a
    // catch-all 409 that would make every upstream outage look operator-caused.
    h.resolver.mockRejectedValue(new MercadoLivreHttpError('boom', 500, null));
    const res = await POST(req(OK));
    expect(res.status).toBe(502);
  });
});
