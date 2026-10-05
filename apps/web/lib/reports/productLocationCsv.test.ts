import { describe, expect, it } from 'vitest';
import {
  PRODUCT_LOCATION_CSV_HEADER,
  buildProductLocationCsv,
  productLocationCsvCell,
  productLocationCsvFilename,
} from './productLocationCsv';
import type { ProductLocationRow } from './productLocation';

function reportRow(overrides: Partial<ProductLocationRow> = {}): ProductLocationRow {
  return {
    key: 'produtos/p1/estoques/e1',
    produtoId: 'p1',
    sku: 'CAM-1',
    produto: 'Camiseta básica',
    localizacao: 'A-10',
    total: 10.5,
    reservado: 2,
    disponivel: 8.5,
    ...overrides,
  };
}

describe('buildProductLocationCsv', () => {
  it('emits a UTF-8, Excel pt-BR report with the six required columns', () => {
    expect(buildProductLocationCsv([reportRow()])).toBe(
      `﻿${PRODUCT_LOCATION_CSV_HEADER.join(';')}\r\n` + 'CAM-1;Camiseta básica;A-10;10,5;2;8,5',
    );
  });

  it('protects every text column from spreadsheet formula injection', () => {
    const csv = buildProductLocationCsv([
      reportRow({ sku: '=1+1', produto: '+SUM(A1)', localizacao: '  @cmd' }),
    ]);
    expect(csv).toContain("'=1+1;'+SUM(A1);'  @cmd");
  });

  it('quotes delimiters and doubles embedded quotes', () => {
    expect(buildProductLocationCsv([reportRow({ produto: 'Kit; "duplo"' })])).toContain(
      '"Kit; ""duplo"""',
    );
  });

  it('keeps negative numbers numeric while protecting negative-looking text', () => {
    expect(productLocationCsvCell(-2)).toBe('-2');
    expect(productLocationCsvCell('-2+cmd')).toBe("'-2+cmd");
  });
});

describe('productLocationCsvFilename', () => {
  it('uses the depósito id and report day', () => {
    expect(
      productLocationCsvFilename('documents/depositos/central', new Date('2026-09-11T12:00:00Z')),
    ).toBe('localizacao-produtos-central-2026-09-11.csv');
  });
});
