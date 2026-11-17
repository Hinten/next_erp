import { abrirPrazo } from '@delfrance/core/wire';
import { describe, expect, it } from 'vitest';

import { PRAZO_AMAZON_MS } from '../src/prazos';

describe('PRAZO_AMAZON_MS', () => {
  it('pins the budgets — changing one must be a deliberate, reviewed edit', () => {
    expect(PRAZO_AMAZON_MS).toEqual({
      documento: 20_000,
      escrita: 30_000,
      leitura: 20_000,
      lwa: 20_000,
      upload: 30_000,
    });
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

  it('★ the upload of a feed document has its own class, as long as a write', () => {
    expect(PRAZO_AMAZON_MS.upload).toBe(30_000);
    expect(PRAZO_AMAZON_MS.upload).toBe(PRAZO_AMAZON_MS.escrita);
  });

  it('has a budget per class (the table above is not vacuous)', () => {
    expect(Object.keys(PRAZO_AMAZON_MS).sort()).toEqual([
      'documento',
      'escrita',
      'leitura',
      'lwa',
      'upload',
    ]);
  });
});
