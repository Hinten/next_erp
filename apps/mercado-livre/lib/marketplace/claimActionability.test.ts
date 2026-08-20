import { describe, expect, it } from 'vitest';
import type { MlClaim } from '@delfrance/integrations-mercado-livre';

import { claimActionability, receiverRoleDaAcao } from './claimActionability';

/**
 * The player shapes are transcribed from ML's "Gerenciar reclamações"
 * reference — the closed-claim example (both players `available_actions: []`)
 * and the search example (respondent holding `send_message_to_mediator`).
 */
function makeClaim(over: Record<string, unknown> = {}): MlClaim {
  return {
    id: 5256749420,
    resource_id: 2000007819609432,
    status: 'opened',
    type: 'mediations',
    stage: 'claim',
    resource: 'order',
    reason_id: 'PDD9549',
    players: [
      { role: 'complainant', type: 'buyer', user_id: 1325224382, available_actions: [] },
      {
        role: 'respondent',
        type: 'seller',
        user_id: 1330467461,
        available_actions: [
          { action: 'send_message_to_complainant', mandatory: true, due_date: null },
        ],
      },
    ],
    resolution: null,
    date_created: '2024-03-14T08:28:44.000-04:00',
    last_updated: null,
    ...over,
  } as unknown as MlClaim;
}

/** A respondent holding exactly `acoes`. */
function comAcoes(acoes: string[], over: Record<string, unknown> = {}): MlClaim {
  return makeClaim({
    players: [
      { role: 'complainant', type: 'buyer', user_id: 1, available_actions: [] },
      {
        role: 'respondent',
        type: 'seller',
        user_id: 2,
        available_actions: acoes.map((action) => ({ action, mandatory: false, due_date: null })),
      },
    ],
    ...over,
  });
}

describe('claimActionability — answerable', () => {
  it('a seller who can message the buyer owns an answerable conversa', () => {
    expect(claimActionability(makeClaim())).toEqual({
      podeResponder: true,
      motivo: null,
      acaoMensagem: 'send_message_to_complainant',
      acoesDisponiveis: ['send_message_to_complainant'],
    });
  });

  it('prefers the MEDIATOR action once a mediation is open', () => {
    // ⚠️ Once ML routes the conversation through a mediator, a message aimed at
    // the complainant is refused. Holding both and picking the wrong one is a
    // 4xx on every reply the operator sends.
    const r = claimActionability(
      comAcoes(['send_message_to_complainant', 'send_message_to_mediator'], { stage: 'dispute' }),
    );
    expect(r.podeResponder).toBe(true);
    expect(r.acaoMensagem).toBe('send_message_to_mediator');
  });

  it('returns EVERY available action, not just the messaging ones', () => {
    // The resolution half of #768 reads this list; re-deriving it there would
    // be a second place to keep in sync with ML's vocabulary.
    const r = claimActionability(
      comAcoes(['send_message_to_complainant', 'refund', 'allow_return']),
    );
    expect(r.acoesDisponiveis).toEqual(['send_message_to_complainant', 'refund', 'allow_return']);
  });
});

describe('claimActionability — not answerable', () => {
  it('a CLOSED claim says so — ML empties available_actions on close', () => {
    const r = claimActionability(comAcoes([], { status: 'closed' }));
    expect(r.podeResponder).toBe(false);
    expect(r.acaoMensagem).toBeNull();
    expect(r.motivo).toBe('Reclamação encerrada no Mercado Livre');
  });

  it('an OPEN claim with only non-message actions points at the incidente', () => {
    // Real work remains (a refund, a return label) — it is just not CHAT work,
    // and a composer is the wrong place to offer it.
    const r = claimActionability(comAcoes(['refund', 'allow_return', 'send_tracking_number']));
    expect(r.podeResponder).toBe(false);
    expect(r.motivo).toContain('incidente');
    expect(r.acoesDisponiveis).toHaveLength(3);
  });

  it('an open claim with NO actions at all says exactly that', () => {
    const r = claimActionability(comAcoes([]));
    expect(r.podeResponder).toBe(false);
    expect(r.motivo).toBe('Sem ações disponíveis para o vendedor nesta reclamação');
  });

  it('refuses when the seller is not a player on this claim', () => {
    const r = claimActionability(
      makeClaim({
        players: [{ role: 'complainant', type: 'buyer', user_id: 1, available_actions: [] }],
      }),
    );
    expect(r.podeResponder).toBe(false);
    expect(r.motivo).toBe('O vendedor não é parte desta reclamação');
  });

  it('refuses a RETURN claim in both of ML’s spellings — that flow has no messages', () => {
    // ⚠️ ML's own reference disagrees with itself: the field table documents
    // `return`, the search example ships `returns`. A conversa for either would
    // be permanently empty ("Neste caso, não há mensagens").
    for (const type of ['return', 'returns', 'RETURNS', ' return ']) {
      const r = claimActionability(comAcoes(['send_message_to_complainant'], { type }));
      expect(r.podeResponder, type).toBe(false);
      expect(r.motivo, type).toContain('Devolução');
    }
  });

  it('treats a missing available_actions array as "no actions"', () => {
    // ML omitting the key must read the same as sending it empty — the schema
    // normalises it, and this is the assertion that keeps that true.
    const claim = makeClaim({
      players: [{ role: 'respondent', type: 'seller', user_id: 2 }],
    });
    expect(claimActionability(claim).podeResponder).toBe(false);
  });

  it('ignores a blank or null action entry rather than counting it', () => {
    const claim = makeClaim({
      players: [
        {
          role: 'respondent',
          type: 'seller',
          user_id: 2,
          available_actions: [
            { action: null, mandatory: false, due_date: null },
            { action: '   ', mandatory: false, due_date: null },
          ],
        },
      ],
    });
    const r = claimActionability(claim);
    expect(r.podeResponder).toBe(false);
    expect(r.acoesDisponiveis).toEqual([]);
  });

  it('does NOT treat the buyer’s own send action as ours', () => {
    // `send_message_to_respondent` is what the COMPLAINANT holds. Reading it as
    // ours would open a composer that posts to nobody.
    const r = claimActionability(comAcoes(['send_message_to_respondent']));
    expect(r.podeResponder).toBe(false);
    expect(r.acaoMensagem).toBeNull();
  });
});

describe('receiverRoleDaAcao', () => {
  it('maps each send action to the receiver_role ML expects on the POST', () => {
    expect(receiverRoleDaAcao('send_message_to_complainant')).toBe('complainant');
    expect(receiverRoleDaAcao('send_message_to_mediator')).toBe('mediator');
  });
});
