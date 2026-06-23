import { describe, expect, it } from 'vitest';

import {
  brNum,
  centsToBr,
  csvCell,
  csvRow,
  formatDateBr,
  reportRowCsv,
  reportTotalsTrailer,
  tipoLabel,
  toCents,
} from './csv';
import { parseNfeReportRow } from './parseNfeReportRow';
import { FIXTURE_SAIDA } from './procnfeFixture';
import type { NfeNote } from './types';

describe('csv helpers', () => {
  it('csvCell quotes only when needed and doubles inner quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });

  it('csvRow joins with semicolons', () => {
    expect(csvRow(['a', 'b', 'c'])).toBe('a;b;c');
  });

  it('brNum / centsToBr produce comma decimals; toCents avoids float drift', () => {
    expect(brNum('1234.56')).toBe('1234,56');
    expect(brNum('')).toBe('');
    expect(centsToBr(10300)).toBe('103,00');
    expect(centsToBr(-550)).toBe('-5,50');
    expect(toCents('103.00')).toBe(10300);
    expect(toCents('')).toBe(0);
    // 0.1 + 0.2 in cents stays exact.
    expect(toCents('0.10') + toCents('0.20')).toBe(30);
  });

  it('tipoLabel + formatDateBr', () => {
    expect(tipoLabel('0')).toBe('Entrada');
    expect(tipoLabel('1')).toBe('Saída');
    expect(tipoLabel('')).toBe('');
    expect(formatDateBr('2026-05-26T18:25:00.000Z')).toMatch(/^\d{2}\/\d{2}\/2026$/);
    expect(formatDateBr(null)).toBe('');
  });

  it('reportRowCsv leaves XML columns blank when there is no procNFe', () => {
    const note: NfeNote = {
      id: 'k',
      chave: 'k',
      numeracao: 9,
      serie: 1,
      estado: 'n',
      dataEmissao: '2026-05-26T18:25:00.000Z',
      xmlNfeProc: null,
    };
    const cells = reportRowCsv(note, null).split(';');
    expect(cells[0]).toBe('1'); // série
    expect(cells[1]).toBe('9'); // número
    expect(cells[2]).toBe('Rejeitada'); // status (ESTADO_NFE_LABELS['n'])
    expect(cells[3]).toBe(''); // tipo — blank without XML
    expect(cells[12]).toBe(''); // total nota — blank without XML
  });

  it('reportRowCsv fills XML columns from a parsed procNFe', () => {
    const note: NfeNote = {
      id: 'k',
      chave: 'k',
      numeracao: 7,
      serie: 1,
      estado: 'a',
      dataEmissao: '2026-05-26T18:25:00.000Z',
      xmlNfeProc: FIXTURE_SAIDA,
    };
    const cells = reportRowCsv(note, parseNfeReportRow(FIXTURE_SAIDA)).split(';');
    expect(cells[2]).toBe('Aprovada');
    expect(cells[3]).toBe('Saída');
    expect(cells[6]).toBe('CLIENTE EXEMPLO');
    expect(cells[7]).toBe('RJ');
    expect(cells[12]).toBe('103,00'); // total nota, comma decimal
  });

  it('reportTotalsTrailer computes faturamento = saídas - entradas and ends with the count marker', () => {
    const lines = reportTotalsTrailer({ entradasCents: 5000, saidasCents: 10300, count: 3 });
    expect(lines).toContain('Total de notas: 3');
    expect(lines.some((l) => l.startsWith('Total Entradas;'))).toBe(true);
    expect(lines.some((l) => l.endsWith(';50,00'))).toBe(true);
    expect(lines.some((l) => l.endsWith(';103,00'))).toBe(true);
    // Faturamento = 10300 - 5000 = 5300 → 53,00
    expect(lines.some((l) => l.startsWith('Faturamento Total') && l.endsWith(';53,00'))).toBe(true);
  });
});
