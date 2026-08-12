import { describe, expect, it } from 'vitest';

import { APLICAR_MODE_LABELS, APLICAR_MODES, deveAplicar } from './aplicarModes';

describe('APLICAR_MODE_LABELS', () => {
  it('has a Portuguese label for every mode', () => {
    for (const mode of APLICAR_MODES) {
      expect(typeof APLICAR_MODE_LABELS[mode]).toBe('string');
    }
    expect(APLICAR_MODE_LABELS.aumentar).toBe('Aumentar preços');
    expect(APLICAR_MODE_LABELS.diminuir).toBe('Diminuir preços');
    expect(APLICAR_MODE_LABELS.aplicarTudo).toBe('Aplicar tudo');
  });
});

describe('deveAplicar', () => {
  // [mode, precoAtual, precoNovo, expected]
  const table: Array<[Parameters<typeof deveAplicar>[0], number | null, number, boolean]> = [
    // aumentar: apply when there's no current price, or the new price is higher.
    ['aumentar', null, 10, true],
    ['aumentar', 5, 10, true],
    ['aumentar', 10, 10, false],
    ['aumentar', 15, 10, false],
    // diminuir: apply when there's no current price, or the new price is lower.
    ['diminuir', null, 10, true],
    ['diminuir', 15, 10, true],
    ['diminuir', 10, 10, false],
    ['diminuir', 5, 10, false],
    // aplicarTudo: apply when there's no current price, or the price actually changed.
    ['aplicarTudo', null, 10, true],
    ['aplicarTudo', 5, 10, true],
    ['aplicarTudo', 15, 10, true],
    ['aplicarTudo', 10, 10, false],
  ];

  it.each(table)('%s: atual=%s novo=%s → %s', (mode, atual, novo, expected) => {
    expect(deveAplicar(mode, atual, novo)).toBe(expected);
  });
});
