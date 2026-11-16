/**
 * The feed core's provider seam table (step 12a, PR 12-c): EMPTY in this PR —
 * no provider exists until stock (step 12) and price (step 13) fill their rows.
 * Each row is typed by its own fluxo, and a price provider with no stock module
 * fits the price row and only that one. Who may import this module is
 * `estrutura.test.ts`'s.
 */
import { MOTIVO_CONTA_AMAZON } from '@delfrance/schemas';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { FLUXOS_COM_LOTE, FLUXO_AMAZON } from '../core/valvulas';
import { DESTINO_LOTE_AMAZON, type DestinoLoteAmazon, provedorDoLoteAmazon } from './destinosLote';
import { MOTIVO_ABORTO_LOTE, type ProvedorLoteAmazon } from './provedorLote';

describe('DESTINO_LOTE_AMAZON — the seam the jobs root reads', () => {
  it('★ is EXACTLY { estoque: null, preco: null } in this PR', () => {
    expect(DESTINO_LOTE_AMAZON).toEqual({ estoque: null, preco: null });
    expect(DESTINO_LOTE_AMAZON.estoque).toBeNull();
    expect(DESTINO_LOTE_AMAZON.preco).toBeNull();
  });

  it('has exactly one row per batch fluxo — every fluxo with a feed, nothing else', () => {
    expect(Object.keys(DESTINO_LOTE_AMAZON).sort()).toEqual([...FLUXOS_COM_LOTE].sort());
    expectTypeOf<keyof DestinoLoteAmazon>().toEqualTypeOf<(typeof FLUXOS_COM_LOTE)[number]>();
  });

  it('provedorDoLoteAmazon reads the table on every call (never a copy taken at load)', () => {
    for (const fluxo of FLUXOS_COM_LOTE) {
      expect(provedorDoLoteAmazon(fluxo)).toBe(DESTINO_LOTE_AMAZON[fluxo]);
      expect(provedorDoLoteAmazon(fluxo)).toBeNull();
    }
  });

  it('a price provider with no stock module fits the PRICE row, and never the stock row', () => {
    const precos: ProvedorLoteAmazon<typeof FLUXO_AMAZON.preco, { readonly n: number }> = {
      fluxo: FLUXO_AMAZON.preco,
      membros: () => Promise.resolve({ skus: ['A'], dados: { n: 1 } }),
      montar: () => Promise.resolve({ abortado: MOTIVO_ABORTO_LOTE.snapshotLento, aviso: null }),
      gravarResultado: () => Promise.resolve(),
      recuperar: () => Promise.resolve({ nada: true }),
      repassarParaPatches: (_ctx, _entrada, skus) => Promise.resolve({ tarefas: skus.length }),
      motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
    };
    expectTypeOf(precos).toMatchTypeOf<NonNullable<DestinoLoteAmazon['preco']>>();
    expectTypeOf(precos).not.toMatchTypeOf<NonNullable<DestinoLoteAmazon['estoque']>>();
    expect(precos.fluxo).toBe(FLUXO_AMAZON.preco);
  });
});
