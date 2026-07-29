import { describe, expect, it } from 'vitest';

import { etiquetaMismatch, etiquetaRowState } from './etiquetaActions';
import { ESTADO_FRETE } from '@delfrance/schemas';

describe('etiquetaRowState', () => {
  const base = { tipo: 'melhorEnvios' as const, printLabelId: null, externalOptionId: null };

  it('returns none while the tipo is still resolving', () => {
    expect(etiquetaRowState({ ...base, tipo: null, estado: ESTADO_FRETE.iniciado }).action).toBe(
      'none',
    );
  });

  it('marks non-Melhor-Envio carriers as unsupported (v1)', () => {
    expect(
      etiquetaRowState({ ...base, tipo: 'motoboy', estado: ESTADO_FRETE.iniciado }).action,
    ).toBe('unsupported');
    expect(etiquetaRowState({ ...base, tipo: 'fob', estado: ESTADO_FRETE.iniciado }).action).toBe(
      'unsupported',
    );
  });

  it('offers reprint when a label is already bought', () => {
    expect(
      etiquetaRowState({ ...base, printLabelId: 'ME-1', estado: ESTADO_FRETE.aguardandoPostagem })
        .action,
    ).toBe('imprimir');
  });

  it('offers buy when a quote is selected but no label yet', () => {
    expect(
      etiquetaRowState({ ...base, externalOptionId: '2', estado: ESTADO_FRETE.iniciado }).action,
    ).toBe('comprar');
  });

  it('asks to quote first when there is no quote and no label', () => {
    expect(etiquetaRowState({ ...base, estado: ESTADO_FRETE.iniciado }).action).toBe('quote-first');
  });

  it('flags needsPostedConfirm only for already-posted estados', () => {
    expect(
      etiquetaRowState({ ...base, printLabelId: 'ME-1', estado: ESTADO_FRETE.iniciado })
        .needsPostedConfirm,
    ).toBe(false);
    expect(
      etiquetaRowState({ ...base, printLabelId: 'ME-1', estado: ESTADO_FRETE.postado })
        .needsPostedConfirm,
    ).toBe(true);
    expect(
      etiquetaRowState({ ...base, printLabelId: 'ME-1', estado: ESTADO_FRETE.entregue })
        .needsPostedConfirm,
    ).toBe(true);
  });
});

describe('etiquetaMismatch', () => {
  // Full truth table over (ehReverso, ehSaida) including the nullish wire
  // defaults: ehReverso null/undefined → false, ehSaida null/undefined → true.
  const cases: Array<
    [boolean | null | undefined, boolean | null | undefined, ReturnType<typeof etiquetaMismatch>]
  > = [
    // Agreeing directions → no confirm.
    [false, true, null], // saída, frete normal
    [true, false, null], // entrada, frete reverso
    // Mismatches.
    [true, true, 'saida-reversa'], // saída with a reverse label
    [false, false, 'entrada-nao-reversa'], // entrada with a normal label
    // Nullish ehReverso resolves to false.
    [null, true, null],
    [undefined, true, null],
    [null, false, 'entrada-nao-reversa'],
    [undefined, false, 'entrada-nao-reversa'],
    // Nullish ehSaida resolves to true (saída).
    [false, null, null],
    [false, undefined, null],
    [true, null, 'saida-reversa'],
    [true, undefined, 'saida-reversa'],
    // Both nullish → saída + não reverso → agree.
    [null, null, null],
    [undefined, undefined, null],
  ];

  it.each(cases)('etiquetaMismatch(%s, %s) → %s', (ehReverso, ehSaida, expected) => {
    expect(etiquetaMismatch(ehReverso, ehSaida)).toBe(expected);
  });
});
