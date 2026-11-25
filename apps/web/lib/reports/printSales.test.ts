import { describe, expect, it } from 'vitest';
import { aggregatePrintSales, defaultPrintSalesDates, printSalesDateRange } from './printSales';

const sale = (produtoId: string | null, quantidade: number, invalidLines = 0) => ({
  produtoId,
  quantidade,
  receitaBruta: 20 * quantidade,
  desconto: 2 * quantidade,
  custo: 6 * quantidade,
  invalidLines,
});

describe('print sales report', () => {
  it('reports inclusive São Paulo dates and defaults to 30 completed days', () => {
    expect(defaultPrintSalesDates(Date.parse('2026-11-24T02:30:00Z'))).toEqual({
      start: '2026-10-24',
      end: '2026-11-22',
    });
    expect(printSalesDateRange('2026-11-23', '2026-11-23')).toEqual({
      startUs: Date.parse('2026-11-23T03:00:00Z') * 1000,
      endExclusiveUs: Date.parse('2026-11-24T03:00:00Z') * 1000,
    });
    expect(printSalesDateRange('2026-02-30', '2026-03-05')).toBeNull();
    expect(printSalesDateRange('2026-03-05', '2026-03-04')).toBeNull();
  });

  it('counts direct and kit sales once, uses the variation recipe, and keeps unknown sales out of both groups', () => {
    const catalog = new Map<string, Record<string, unknown>>([
      ['print', { nome: 'Print family' }],
      ['print-small', { paiId: 'print', nome: 'Small print', sku: 'SMALL' }],
      ['second', {}],
      ['plain', {}],
      ['kit', { ehKit: true, componentesKit: { 'print-small': { quantidade: 3 }, second: {} } }],
      ['inherited', { paiId: 'kit', ehKit: true, componentesKit: null }],
      ['override', { paiId: 'kit', ehKit: true, componentesKit: { plain: {} } }],
      ['legacy', { componentesKitKeys: ['second'] }],
      ['broken', { componentesKitKeys: ['missing-component'] }],
      ['stale', { ehKit: false, componentesKitKeys: ['second'] }],
      ['missing-parent', { paiId: 'deleted-parent', ehKit: true, componentesKit: null }],
    ]);
    const report = aggregatePrintSales(
      [
        sale('print-small', 1.5),
        sale('kit', 2),
        sale('inherited', 3),
        sale('override', 4),
        sale('legacy', 1),
        sale('broken', 1),
        sale('stale', 2),
        sale('deleted', 5),
        sale('missing-parent', 1),
        sale(null, 1),
        sale('plain', 0, 2),
      ],
      catalog,
      ['print', 'second'],
    );
    expect(report.comEstampa).toEqual({
      quantidade: 7.5,
      receitaBruta: 150,
      desconto: 15,
      custo: 45,
    });
    expect(report.semEstampa).toMatchObject({ quantidade: 6, receitaBruta: 120 });
    expect(report.semClassificacao).toBe(8);
    expect(report.invalidLines).toBe(2);
    expect(report.rows.map(({ id }) => id)).toEqual(['inherited', 'kit', 'print-small', 'legacy']);
    expect(report.rows[1]).toMatchObject({
      printIds: ['print', 'second'],
      quantidade: 2,
      receitaLiquida: 36,
    });
    expect(report.rows[2]).toMatchObject({ nome: 'Small print', sku: 'SMALL' });
  });

  it('matches an exact selected variation without matching its siblings', () => {
    const catalog = new Map<string, Record<string, unknown>>([
      ['family', {}],
      ['small', { paiId: 'family' }],
      ['large', { paiId: 'family' }],
    ]);
    const report = aggregatePrintSales([sale('small', 2), sale('large', 1)], catalog, ['small']);
    expect(report.rows.map(({ id }) => id)).toEqual(['small']);
    expect(report.semEstampa.quantidade).toBe(1);
  });
});
