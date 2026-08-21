import { describe, expect, it } from 'vitest';
import { ORIGEM_CONVERSA, ORIGEM_RULES, type OrigemConversa } from '@delfrance/schemas';
import { TRANSPORTE_ENVIO, enviaPorRota } from './transporteEnvio';

const ORIGENS = Object.keys(ORIGEM_RULES) as OrigemConversa[];

describe('TRANSPORTE_ENVIO — every sendable origem declares its transport', () => {
  /**
   * ⚠️ THE guard, and the reason this module exists.
   *
   * `temEnvio: true` says "this app can reply here"; the table says HOW. When
   * the two disagree the composer silently picks the wrong branch — #768 set
   * `temEnvio: true` on `mlclaims` and left the old `ORIGENS_ROTA` set alone,
   * so replies were written to Firestore and never transmitted.
   *
   * Iterating `ORIGEM_RULES` rather than a list written here is what makes this
   * non-vacuous: a NEW origem is picked up automatically. It cannot even reach
   * this assertion without a value, because `TRANSPORTE_ENVIO` is
   * `satisfies Record<OrigemConversa, …>` — but a value of `null` would compile,
   * and this is what rejects it.
   */
  it.each(ORIGENS)('%s: temEnvio and the transport table agree', (origem) => {
    const temEnvio = ORIGEM_RULES[origem].temEnvio;
    const transporte = TRANSPORTE_ENVIO[origem];

    if (temEnvio) {
      expect(transporte, `${origem} can send but declares no transport`).not.toBeNull();
    } else {
      expect(transporte, `${origem} cannot send but declares a transport`).toBeNull();
    }
  });

  it('classifies every origem — no origem is missing from the table', () => {
    // Anti-vacuity anchor for the `it.each` above: if `ORIGEM_RULES` and
    // `TRANSPORTE_ENVIO` ever drifted apart in KEYS, each row would still pass
    // by reading `undefined` on both sides of a comparison that never runs.
    expect(Object.keys(TRANSPORTE_ENVIO).sort()).toEqual(ORIGENS.slice().sort());
  });

  it('has at least one origem of each transport — the guard is not trivially satisfiable', () => {
    // A table that was all-'rota' or all-null would pass the agreement check
    // while proving nothing about the distinction it encodes.
    const valores = Object.values(TRANSPORTE_ENVIO);
    expect(valores).toContain('rota');
    expect(valores).toContain('trigger');
    expect(valores).toContain(null);
  });
});

describe('enviaPorRota', () => {
  it('is true for all three Mercado Livre surfaces', () => {
    // ⚠️ `mlclaims` is the one #768 forgot. Losing it again means claim replies
    // are written to Firestore and never sent, with nothing failing.
    expect(enviaPorRota(ORIGEM_CONVERSA.mercadoLivrePerguntas)).toBe(true);
    expect(enviaPorRota(ORIGEM_CONVERSA.mercadoLivrePedido)).toBe(true);
    expect(enviaPorRota(ORIGEM_CONVERSA.mercadoLivreReclamacoes)).toBe(true);
  });

  it('is false for WhatsApp, which sends through a trigger', () => {
    // Not "has no sender" — WhatsApp sends. It just does not send through a
    // route, and conflating the two would route it and drop the retries.
    expect(ORIGEM_RULES[ORIGEM_CONVERSA.whatsapp].temEnvio).toBe(true);
    expect(enviaPorRota(ORIGEM_CONVERSA.whatsapp)).toBe(false);
  });

  it('is false for an origem the schemas do not model', () => {
    // The migrated corpus carries origens this app never registered; an unknown
    // one must fall back to the Firestore branch rather than throw.
    expect(enviaPorRota('canal-que-nao-existe')).toBe(false);
  });
});
