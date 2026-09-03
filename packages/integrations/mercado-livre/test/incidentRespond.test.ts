import { describe, expect, it, vi } from 'vitest';

import {
  ClaimActionUnavailableError,
  ClaimPartialRefundOfferError,
  acoesDoVendedor,
  respondIncidentMl,
} from '../src/incidentRespond';
import { MercadoLivreValidationError } from '../src/errors';
import type { MercadoLivreApi, MlClaim } from '../src';

const CLAIM_ID = 5204934310;

/** A claim whose seller holds exactly `acoes`, shaped like ML's reference. */
function claim(acoes: string[], over: Record<string, unknown> = {}): MlClaim {
  return {
    id: CLAIM_ID,
    resource_id: 2000008026430162,
    status: 'opened',
    type: 'mediations',
    stage: 'claim',
    resource: 'order',
    reason_id: 'PDD9549',
    players: [
      { role: 'complainant', type: 'buyer', user_id: 1277895049, available_actions: [] },
      {
        role: 'respondent',
        type: 'seller',
        user_id: 1582937623,
        available_actions: acoes.map((action) => ({ action, mandatory: false, due_date: null })),
      },
    ],
    resolution: null,
    date_created: '2024-04-12T08:26:23.000-04:00',
    last_updated: null,
    ...over,
  } as unknown as MlClaim;
}

type ApiStubs = Partial<Record<keyof MercadoLivreApi, unknown>>;

function api(acoes: string[], over: ApiStubs = {}): MercadoLivreApi {
  return {
    getClaim: vi.fn(async () => claim(acoes)),
    sendClaimMessage: vi.fn(async () => undefined),
    openClaimDispute: vi.fn(async () => claim([], { stage: 'dispute' })),
    refundClaim: vi.fn(async () => []),
    allowClaimReturn: vi.fn(async () => []),
    partialRefundClaim: vi.fn(async () => []),
    getClaimPartialRefundOffers: vi.fn(async () => ({
      currency_id: 'BRL',
      available_offers: [
        { amount: 268.2, percentage: 90 },
        { amount: 149.0, percentage: 50 },
      ],
    })),
    ...over,
  } as unknown as MercadoLivreApi;
}

describe('acoesDoVendedor', () => {
  it('reads the RESPONDENT, never the complainant', () => {
    // We are always the respondent on a claim against our own sale. Reading the
    // complainant's list would offer the buyer's actions as ours.
    expect(acoesDoVendedor(claim(['refund']))).toEqual(['refund']);
  });

  it('is empty when the seller is not a player at all', () => {
    const semVendedor = claim([], {
      players: [{ role: 'complainant', type: 'buyer', user_id: 1, available_actions: [] }],
    });
    expect(acoesDoVendedor(semVendedor)).toEqual([]);
  });
});

describe('respondIncidentMl — reply_message', () => {
  it('sends to the COMPLAINANT in the claim stage', async () => {
    const a = api(['send_message_to_complainant']);
    const r = await respondIncidentMl(a, String(CLAIM_ID), {
      type: 'reply_message',
      text: 'Vou verificar hoje.',
    });

    expect(r.ok).toBe(true);
    expect(a.sendClaimMessage).toHaveBeenCalledWith(CLAIM_ID, {
      receiverRole: 'complainant',
      message: 'Vou verificar hoje.',
      attachments: undefined,
    });
  });

  it('prefers the MEDIATOR once a mediation is open', async () => {
    // ⚠️ ML: "Quando a mediação é ativada … mensagens diretas ao comprador não
    // podem ser enviadas. É essencial ajustar o receiver_role para mediator."
    // Holding both and picking the wrong one is a refusal on every reply.
    const a = api(['send_message_to_complainant', 'send_message_to_mediator']);
    await respondIncidentMl(a, String(CLAIM_ID), { type: 'reply_message', text: 'oi' });

    expect(a.sendClaimMessage).toHaveBeenCalledWith(
      CLAIM_ID,
      expect.objectContaining({ receiverRole: 'mediator' }),
    );
  });

  it('passes attachments through when there are any', async () => {
    const a = api(['send_message_to_complainant']);
    await respondIncidentMl(a, String(CLAIM_ID), {
      type: 'reply_message',
      text: 'segue nota',
      attachments: ['1330467461_abc.pdf'],
    });
    expect(a.sendClaimMessage).toHaveBeenCalledWith(
      CLAIM_ID,
      expect.objectContaining({ attachments: ['1330467461_abc.pdf'] }),
    );
  });

  it('REFUSES when ML offers no message action, naming what is available', async () => {
    const a = api(['refund', 'allow_return']);
    await expect(
      respondIncidentMl(a, String(CLAIM_ID), { type: 'reply_message', text: 'oi' }),
    ).rejects.toBeInstanceOf(ClaimActionUnavailableError);
    expect(a.sendClaimMessage).not.toHaveBeenCalled();
  });
});

describe('respondIncidentMl — resolutions', () => {
  it('opens a mediation only when open_dispute is offered', async () => {
    const a = api(['open_dispute']);
    const r = await respondIncidentMl(a, String(CLAIM_ID), { type: 'escalate_mediation' });
    expect(a.openClaimDispute).toHaveBeenCalledWith(CLAIM_ID);
    expect(r.status).toBe('opened');

    const b = api(['refund']);
    await expect(
      respondIncidentMl(b, String(CLAIM_ID), { type: 'escalate_mediation' }),
    ).rejects.toBeInstanceOf(ClaimActionUnavailableError);
    expect(b.openClaimDispute).not.toHaveBeenCalled();
  });

  it('accepts a return under EITHER of ML’s two verbs', async () => {
    // ML publishes `allow_return` and `allow_return_label` for the same outcome
    // depending on whether a return label is minted.
    for (const verbo of ['allow_return', 'allow_return_label']) {
      const a = api([verbo]);
      await respondIncidentMl(a, String(CLAIM_ID), { type: 'accept_return' });
      expect(a.allowClaimReturn, verbo).toHaveBeenCalledWith(CLAIM_ID);
    }
  });

  it('refunds in full when partial is not requested', async () => {
    const a = api(['refund']);
    await respondIncidentMl(a, String(CLAIM_ID), {
      type: 'offer_refund',
      refundAmount: 298.0,
    });
    expect(a.refundClaim).toHaveBeenCalledWith(CLAIM_ID);
    expect(a.partialRefundClaim).not.toHaveBeenCalled();
  });

  it('refuses an action ML has no equivalent for, rather than reporting ok:false', async () => {
    const a = api(['refund']);
    await expect(
      respondIncidentMl(a, String(CLAIM_ID), { type: 'ship_replacement' }),
    ).rejects.toBeInstanceOf(ClaimActionUnavailableError);
  });
});

describe('respondIncidentMl — partial refund is a PERCENTAGE, not an amount', () => {
  it('translates the amount into the matching allowed percentage', async () => {
    // ⚠️ `refundAmount` is REAIS since #815 (the model dropped `MinorUnits`,
    // which is what kept this contract unimplementable against the reais floats
    // the price tables store). ML only accepts a percentage off its own
    // allow-list, so 268.20 → 90%.
    const a = api(['allow_partial_refund']);
    await respondIncidentMl(a, String(CLAIM_ID), {
      type: 'offer_refund',
      refundAmount: 268.2,
      partial: true,
    });
    expect(a.partialRefundClaim).toHaveBeenCalledWith(CLAIM_ID, 90);
  });

  it('REFUSES a CENTAVOS amount — the near-miss that proves the unit changed', async () => {
    // ⚠️ Without this the suite is vacuous about #815. The passing case above
    // sends 268.2 and expects 90%; the OLD centavos code reached the same
    // percentage from 26820 by dividing, so a test that only asserts the happy
    // path passes identically before and after the change. What separates the
    // two units is what happens to a value in the WRONG one: under centavos
    // 26820 was correct, under reais it is R$ 26.820,00 — an amount ML does not
    // offer, so it must be refused rather than quietly rounded to something.
    const a = api(['allow_partial_refund']);
    await expect(
      respondIncidentMl(a, String(CLAIM_ID), {
        type: 'offer_refund',
        refundAmount: 26820,
        partial: true,
      }),
    ).rejects.toBeInstanceOf(ClaimPartialRefundOfferError);
    expect(a.partialRefundClaim).not.toHaveBeenCalled();
  });

  it('REFUSES an amount ML does not offer, listing the ones it does', async () => {
    // ⚠️ Not a nicety. ML defaults a MISSING percentage to 50%, so guessing or
    // rounding here refunds a sum the operator never authorised. Exact match or
    // nothing.
    const a = api(['allow_partial_refund']);
    await expect(
      respondIncidentMl(a, String(CLAIM_ID), {
        type: 'offer_refund',
        refundAmount: 200.0, // not on the list
        partial: true,
      }),
    ).rejects.toBeInstanceOf(ClaimPartialRefundOfferError);
    expect(a.partialRefundClaim).not.toHaveBeenCalled();
  });

  it('carries the offer list on the refusal, so the caller can re-render the picker', async () => {
    // ⚠️ Its own class rather than MercadoLivreValidationError, because of how
    // the two are MAPPED: `respond.ts` turns a validation error into a 502
    // "ML returned an unexpected shape — upstream problem", which is the wrong
    // sentence for the most operator-actionable state in the feature. The
    // message already names the real percentages; `ofertas` lets the UI show
    // them in place instead of sending the operator back to the start.
    const a = api(['allow_partial_refund']);
    const erro = await respondIncidentMl(a, String(CLAIM_ID), {
      type: 'offer_refund',
      refundAmount: 200.0,
      partial: true,
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ClaimPartialRefundOfferError);
    const off = (erro as ClaimPartialRefundOfferError).ofertas;
    expect(off.available_offers.length).toBeGreaterThan(0);
    // And the message names them, since that string reaches the operator verbatim.
    expect((erro as Error).message).toMatch(/Dispon[ií]veis:/);
  });

  it('does not attempt a partial refund the seller cannot make', async () => {
    const a = api(['refund']);
    await expect(
      respondIncidentMl(a, String(CLAIM_ID), {
        type: 'offer_refund',
        refundAmount: 268.2,
        partial: true,
      }),
    ).rejects.toBeInstanceOf(ClaimActionUnavailableError);
    expect(a.getClaimPartialRefundOffers).not.toHaveBeenCalled();
  });
});

describe('respondIncidentMl — the claim id', () => {
  it('rejects a non-numeric external id before any call', async () => {
    const a = api(['refund']);
    await expect(
      respondIncidentMl(a, 'nao-numerico', { type: 'accept_return' }),
    ).rejects.toBeInstanceOf(MercadoLivreValidationError);
    expect(a.getClaim).not.toHaveBeenCalled();
  });

  it('re-reads the claim on EVERY call — available_actions is stale on arrival', async () => {
    const a = api(['refund']);
    await respondIncidentMl(a, String(CLAIM_ID), {
      type: 'offer_refund',
      refundAmount: 1,
    });
    expect(a.getClaim).toHaveBeenCalledWith(CLAIM_ID);
  });
});
