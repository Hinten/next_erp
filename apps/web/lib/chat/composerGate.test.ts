import { describe, expect, it } from 'vitest';
import { ESTADO_CONVERSA, ORIGEM_CONVERSA, ORIGEM_RULES } from '@delfrance/schemas';
import { SEM_ENVIO_MOTIVO, composerGate } from './composerGate';

/** A conversa on the one channel that can actually transmit today. */
function base(over: Partial<Parameters<typeof composerGate>[0]> = {}) {
  return {
    usuarios: ['op1'],
    estadoConversa: ESTADO_CONVERSA.emResposta,
    uid: 'op1',
    origem: ORIGEM_CONVERSA.whatsapp,
    respostaBloqueada: null,
    ...over,
  };
}

describe('composerGate — participation (unchanged behaviour)', () => {
  it('returns no-uid when there is no authenticated user', () => {
    expect(composerGate(base({ uid: null }))).toEqual({ kind: 'no-uid' });
  });

  it('returns compose when the operator is a participant of an in-progress conversa', () => {
    expect(composerGate(base({ usuarios: ['op1', 'op2'] }))).toEqual({ kind: 'compose' });
  });

  it('returns enter when the operator is not a participant', () => {
    expect(composerGate(base({ usuarios: ['op2'] }))).toEqual({ kind: 'enter' });
  });

  it('returns enter when the conversa is not in the emResposta state', () => {
    expect(composerGate(base({ estadoConversa: ESTADO_CONVERSA.naoRespondido }))).toEqual({
      kind: 'enter',
    });
  });

  it('treats a null/undefined usuarios array as "not a participant"', () => {
    expect(composerGate(base({ usuarios: null }))).toEqual({ kind: 'enter' });
    expect(composerGate(base({ usuarios: undefined }))).toEqual({ kind: 'enter' });
  });
});

describe('composerGate — send capability (#817)', () => {
  it('is read-only on every origem with no outbound sender', () => {
    // The bug as reported was about Mercado Livre, but site/facebook/comentario
    // have no sender either and were dropping replies the same way.
    for (const origem of [
      'mlperg',
      'mlped',
      'mlclaims',
      'site',
      'facebook',
      'comentario',
    ] as const) {
      expect(composerGate(base({ origem })), origem).toEqual({
        kind: 'somente-leitura',
        motivo: SEM_ENVIO_MOTIVO,
      });
    }
  });

  it('leaves WhatsApp completely unaffected', () => {
    expect(composerGate(base())).toEqual({ kind: 'compose' });
  });

  it('is read-only for a per-thread block, and surfaces the channel reason verbatim', () => {
    // The importer writes the operator-facing text; the gate must not paraphrase
    // it, because the specific reason is the whole point of the notice.
    const motivo = 'Pergunta já respondida no Mercado Livre';
    expect(composerGate(base({ respostaBloqueada: motivo }))).toEqual({
      kind: 'somente-leitura',
      motivo,
    });
  });

  it('prefers the per-thread reason over the generic channel one', () => {
    const motivo = 'Prazo de resposta encerrado';
    expect(
      composerGate(base({ origem: ORIGEM_CONVERSA.mercadoLivrePedido, respostaBloqueada: motivo })),
    ).toEqual({
      kind: 'somente-leitura',
      motivo,
    });
  });

  it('treats an empty-string block as "not blocked"', () => {
    // `.nullable().default(null)` is the contract, but a legacy or hand-edited
    // doc can carry '' — which must not read as a reason with no text.
    expect(composerGate(base({ respostaBloqueada: '' }))).toEqual({ kind: 'compose' });
  });

  it('blocks BEFORE participation, so a dead thread cannot be reopened into a live composer', () => {
    // The `enter` button calls `enterConversa`, which flips estadoConversa to
    // emResposta. If capability were checked after participation, an operator
    // could reopen an unanswerable thread and land on a full composer — #817
    // with one extra click.
    expect(
      composerGate(
        base({
          usuarios: ['someone-else'],
          estadoConversa: ESTADO_CONVERSA.atendimentoFinalizado,
          respostaBloqueada: 'Reclamação sem ações disponíveis',
        }),
      ),
    ).toEqual({ kind: 'somente-leitura', motivo: 'Reclamação sem ações disponíveis' });
  });

  it('no-uid still wins over everything — defensive, and cheapest to answer', () => {
    expect(
      composerGate(base({ uid: null, origem: ORIGEM_CONVERSA.mercadoLivrePerguntas })),
    ).toEqual({
      kind: 'no-uid',
    });
  });
});

describe('composerGate — the capability seam', () => {
  it('reads temEnvio, so a channel gaining a sender enables the composer with no change here', () => {
    // The anti-drift assertion: this file must not grow an origem allow-list.
    // Flipping `temEnvio` in ORIGEM_RULES is the ONLY edit a new sender needs.
    const semEnvio = (Object.keys(ORIGEM_RULES) as (keyof typeof ORIGEM_RULES)[]).filter(
      (o) => !ORIGEM_RULES[o].temEnvio,
    );
    for (const origem of semEnvio) {
      expect(composerGate(base({ origem })).kind, origem).toBe('somente-leitura');
    }
    const comEnvio = (Object.keys(ORIGEM_RULES) as (keyof typeof ORIGEM_RULES)[]).filter(
      (o) => ORIGEM_RULES[o].temEnvio,
    );
    for (const origem of comEnvio) {
      expect(composerGate(base({ origem })).kind, origem).toBe('compose');
    }
  });
});
