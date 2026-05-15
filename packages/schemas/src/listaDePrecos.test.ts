import { describe, expect, it } from 'vitest';
import {
  faixaTaxaFixaPesoSchema,
  formulaCalculoPrecoSchema,
  formulasPorCategoriaSchema,
  listaDePrecosMeta,
  listaDePrecosSchema,
} from './listaDePrecos';

describe('listaDePrecosSchema', () => {
  it('accepts a minimal valid lista with defaults applied', () => {
    const out = listaDePrecosSchema.parse({ nome: 'Padrão' });
    expect(out).toMatchObject({
      nome: 'Padrão',
      padrao: false,
      ativo: true,
    });
  });

  it('rejects empty nome', () => {
    expect(listaDePrecosSchema.safeParse({ nome: '' }).success).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    expect(
      listaDePrecosSchema.safeParse({ nome: 'x'.repeat(256) }).success,
    ).toBe(false);
  });

  it('round-trips embedded formulas with peso ranges', () => {
    const out = listaDePrecosSchema.parse({
      nome: 'Marketplace ML',
      padrao: false,
      ativo: true,
      formulasCalculoPreco: [
        {
          limiar: 100,
          formula: '(C + c) * (1 + L + M + I + K) + T + F',
          taxaFixa: 5,
          margemDeLucro: 0.3,
          faixasTaxaFixaPeso: [
            { pesoMinKg: 0, pesoMaxKg: 0.5, taxaFixa: 3 },
            { pesoMinKg: 0.5, pesoMaxKg: 1, taxaFixa: 5 },
          ],
        },
      ],
    });
    expect(out.formulasCalculoPreco?.[0]?.faixasTaxaFixaPeso).toHaveLength(2);
  });

  it('round-trips formulasPorCategoria (Map<String, FormulasPorCategoria>)', () => {
    const out = listaDePrecosSchema.parse({
      nome: 'Por categoria',
      formulasPorCategoria: {
        'cat-1': { name: 'Roupas', formulasCalculoPreco: [] },
        'cat-2': { name: 'Acessórios' },
      },
    });
    expect(Object.keys(out.formulasPorCategoria ?? {})).toEqual([
      'cat-1',
      'cat-2',
    ]);
  });
});

describe('faixaTaxaFixaPesoSchema', () => {
  it('requires pesoMinKg, pesoMaxKg, and taxaFixa', () => {
    expect(faixaTaxaFixaPesoSchema.safeParse({}).success).toBe(false);
    const out = faixaTaxaFixaPesoSchema.parse({
      pesoMinKg: 0,
      pesoMaxKg: 1,
      taxaFixa: 5,
    });
    expect(out.taxaFixa).toBe(5);
  });
});

describe('formulaCalculoPrecoSchema', () => {
  it('applies double defaults of 0 for taxa/custo/margem/etc', () => {
    const out = formulaCalculoPrecoSchema.parse({
      limiar: 10,
      formula: 'C + c',
    });
    expect(out.taxaFixa).toBe(0);
    expect(out.custoFixo).toBe(0);
    expect(out.margemDeLucro).toBe(0);
    expect(out.comissaoMarketplace).toBe(0);
    expect(out.imposto).toBe(0);
    expect(out.frete).toBe(0);
    expect(out.marketing).toBe(0);
  });

  it('rejects empty formula', () => {
    expect(
      formulaCalculoPrecoSchema.safeParse({ limiar: 1, formula: '' }).success,
    ).toBe(false);
  });
});

describe('formulasPorCategoriaSchema', () => {
  it('requires name', () => {
    expect(formulasPorCategoriaSchema.safeParse({}).success).toBe(false);
    expect(formulasPorCategoriaSchema.parse({ name: 'Eletrônicos' }).name).toBe(
      'Eletrônicos',
    );
  });
});

describe('listaDePrecosMeta', () => {
  it('targets the listaDePrecos collection', () => {
    expect(listaDePrecosMeta.collectionPath).toBe('listaDePrecos');
  });

  it('reuses the produto BigInt permission bits', () => {
    expect(listaDePrecosMeta.permissions.read).toBe(1n << 8n);
    expect(listaDePrecosMeta.permissions.write).toBe(1n << 9n);
    expect(listaDePrecosMeta.permissions.delete).toBe(1n << 10n);
  });
});
