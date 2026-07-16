import { describe, expect, it } from 'vitest';

import { seedFreteInicial } from './seedFreteInicial';

describe('seedFreteInicial', () => {
  it('seeds a reverse frete for an entrada (cliente → loja)', () => {
    expect(seedFreteInicial('1', false).ehReverso).toBe(true);
  });

  it('seeds a non-reverse frete for a saída', () => {
    expect(seedFreteInicial('1', true).ehReverso).toBe(false);
  });

  it('keeps the schema defaults for every other wire key', () => {
    const seeded = seedFreteInicial('2', false);
    expect(seeded.estado).toBe('iniciado');
    expect(seeded.modalidade).toBe('2');
    // Spot-check the Flutter defaults `freteDoPedidoSchema.parse` fills in.
    expect(seeded.prazoExtra).toBe(0);
    expect(seeded.valorCobrado).toBeNull();
    expect(seeded.printLabelId).toBeNull();
    expect(seeded.codRastreio).toBeNull();
  });
});
