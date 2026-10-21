import { abrirPrazo } from '@delfrance/core/wire';
import { describe, expect, it } from 'vitest';

import { PRAZO_AMAZON_MS } from '../src/prazos';

describe('PRAZO_AMAZON_MS', () => {
  it('pins the budgets — changing one must be a deliberate, reviewed edit', () => {
    expect(PRAZO_AMAZON_MS).toEqual({ leitura: 20_000, lwa: 20_000 });
  });

  it.each(Object.entries(PRAZO_AMAZON_MS))(
    '%s: a positive integer of at most 30,000 ms that abrirPrazo accepts',
    (_classe, ms) => {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(30_000);
      const prazo = abrirPrazo(ms);
      expect(prazo.esgotado()).toBe(false);
      prazo.liberar();
    },
  );

  it('has a budget per class (the table above is not vacuous)', () => {
    expect(Object.keys(PRAZO_AMAZON_MS).sort()).toEqual(['leitura', 'lwa']);
  });
});
