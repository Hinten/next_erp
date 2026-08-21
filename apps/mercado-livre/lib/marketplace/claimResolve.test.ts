import { describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  type MercadoLivreApi,
  type MlClaim,
} from '@delfrance/integrations-mercado-livre';

import { lerReclamacaoMercadoLivre, tipoDeReclamacao } from './claimResolve';

function claim(over: Partial<MlClaim> = {}, acoes: string[] = []): MlClaim {
  return {
    id: 5204934310,
    type: 'mediations',
    stage: 'claim',
    status: 'opened',
    parent_id: null,
    client_id: null,
    resource_id: 2000008026430162,
    resource: 'order',
    reason_id: 'PDD9551',
    fulfilled: true,
    players: [
      { role: 'complainant', type: 'buyer', user_id: 1, available_actions: [] },
      {
        role: 'respondent',
        type: 'seller',
        user_id: 2,
        available_actions: acoes.map((action) => ({
          action,
          mandatory: false,
          due_date: null,
        })),
      },
    ],
    resolution: null,
    date_created: null,
    last_updated: null,
    ...over,
  } as MlClaim;
}

function api(over: Partial<MercadoLivreApi> = {}): MercadoLivreApi {
  return {
    getClaim: vi.fn(async () => claim({}, ['refund'])),
    getClaimExpectedResolutions: vi.fn(async () => []),
    getClaimPartialRefundOffers: vi.fn(async () => ({
      currency_id: 'BRL',
      available_offers: [{ amount: 149, percentage: 50 }],
      recommendations: [],
      restrictions: [],
    })),
    ...over,
  } as unknown as MercadoLivreApi;
}

describe('tipoDeReclamacao — caption copy, never a gate', () => {
  it('reads PNR and PDD off the reason_id prefix', () => {
    expect(tipoDeReclamacao(claim({ reason_id: 'PNR3430' }))).toBe('PNR');
    expect(tipoDeReclamacao(claim({ reason_id: 'PDD9549' }))).toBe('PDD');
  });

  it('returns null for an unknown or absent prefix rather than guessing', () => {
    // ⚠️ The safe direction. This value only captions the panel; if a NEW ML
    // prefix could make it wrong, the damage must be a missing sentence, never a
    // hidden button — availability comes from `available_actions`, live.
    expect(tipoDeReclamacao(claim({ reason_id: 'XYZ1' }))).toBeNull();
    expect(tipoDeReclamacao(claim({ reason_id: null }))).toBeNull();
  });
});

describe('lerReclamacaoMercadoLivre', () => {
  it('reports the seller verbs verbatim, with their deadlines', async () => {
    const a = api({
      getClaim: vi.fn(async () => claim({}, []) as MlClaim),
    });
    (a.getClaim as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...claim(),
      players: [
        { role: 'complainant', type: 'buyer', user_id: 1, available_actions: [] },
        {
          role: 'respondent',
          type: 'seller',
          user_id: 2,
          available_actions: [
            {
              action: 'send_message_to_complainant',
              mandatory: true,
              due_date: '2026-09-01T00:00:00.000-03:00',
            },
            { action: 'refund', mandatory: false, due_date: null },
          ],
        },
      ],
    });

    const estado = await lerReclamacaoMercadoLivre({ api: a }, { claimId: 5204934310 });

    expect(estado.acoesDisponiveis).toEqual(['send_message_to_complainant', 'refund']);
    expect(estado.prazos).toEqual([
      {
        acao: 'send_message_to_complainant',
        obrigatoria: true,
        prazo: '2026-09-01T00:00:00.000-03:00',
      },
      { acao: 'refund', obrigatoria: false, prazo: null },
    ]);
  });

  it('DEGRADES when expected-resolutions fails — the panel survives', async () => {
    // ⚠️ A side read. Losing the buyer's stated expectation is a worse panel;
    // losing the whole panel over it is a worse outage. `expectativas: null`
    // plus the flag lets the UI say "could not read" instead of rendering a
    // blank that reads as "the buyer wants nothing".
    const a = api({
      getClaimExpectedResolutions: vi.fn(async () => {
        throw new MercadoLivreHttpError('nope', 500, null);
      }),
    });

    const estado = await lerReclamacaoMercadoLivre({ api: a }, { claimId: 5204934310 });

    expect(estado.expectativas).toBeNull();
    expect(estado.expectativasIndisponiveis).toBe(true);
    expect(estado.acoesDisponiveis).toEqual(['refund']); // the rest still arrived
  });

  it('does NOT degrade a dead grant — re-auth still surfaces', async () => {
    // ⚠️ The exclusion that matters. `api.ts` maps a 401 onto the re-auth error,
    // so a dead credential arrives looking like an ordinary failure of whichever
    // call ran first. Swallowing it here would replace "reconnect the account"
    // with a panel that merely got quietly worse.
    const a = api({
      getClaimExpectedResolutions: vi.fn(async () => {
        throw new MercadoLivreReauthRequiredError('token morto');
      }),
    });

    await expect(
      lerReclamacaoMercadoLivre({ api: a }, { claimId: 5204934310 }),
    ).rejects.toBeInstanceOf(MercadoLivreReauthRequiredError);
  });

  it('reads the partial-refund offers ONLY when ML offers that action', async () => {
    // One ML call per panel open that would never render a picker, and ML
    // answers 422 for an ineligible claim anyway.
    const semParcial = api();
    await lerReclamacaoMercadoLivre({ api: semParcial }, { claimId: 5204934310 });
    expect(semParcial.getClaimPartialRefundOffers).not.toHaveBeenCalled();

    const comParcial = api({
      getClaim: vi.fn(async () => claim({}, ['refund', 'allow_partial_refund'])),
    });
    const estado = await lerReclamacaoMercadoLivre({ api: comParcial }, { claimId: 5204934310 });
    expect(comParcial.getClaimPartialRefundOffers).toHaveBeenCalledWith(5204934310);
    expect(estado.ofertasParciais?.available_offers).toHaveLength(1);
  });

  it('degrades the offers read too, leaving the rest of the panel intact', async () => {
    const a = api({
      getClaim: vi.fn(async () => claim({}, ['allow_partial_refund'])),
      getClaimPartialRefundOffers: vi.fn(async () => {
        throw new MercadoLivreHttpError('not eligible', 422, null);
      }),
    });

    const estado = await lerReclamacaoMercadoLivre({ api: a }, { claimId: 5204934310 });

    expect(estado.ofertasParciais).toBeNull();
    expect(estado.acoesDisponiveis).toEqual(['allow_partial_refund']);
  });
});
