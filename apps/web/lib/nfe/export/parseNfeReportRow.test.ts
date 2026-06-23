import { describe, expect, it } from 'vitest';

import { parseNfeReportRow } from './parseNfeReportRow';
import { FIXTURE_ENTRADA, FIXTURE_SAIDA } from './procnfeFixture';

describe('parseNfeReportRow', () => {
  it('extracts header + dest + totais from a saída procNFe, scoped correctly', () => {
    const row = parseNfeReportRow(FIXTURE_SAIDA);
    expect(row).toEqual({
      natOp: 'VENDA DE MERCADORIA',
      tpNF: '1',
      finNFe: '1',
      destNome: 'CLIENTE EXEMPLO',
      destUF: 'RJ',
      // The per-item <prod> also has vProd=10.00 / vDesc=1.00 — the extractor
      // must read the <ICMSTot> totals, not the item values.
      vProd: '100.00',
      vFrete: '5.00',
      vDesc: '2.00',
      vNF: '103.00',
    });
  });

  it('reads tpNF=0 (entrada) and tolerates a missing enderDest/UF', () => {
    const row = parseNfeReportRow(FIXTURE_ENTRADA);
    expect(row.tpNF).toBe('0');
    expect(row.natOp).toBe('DEVOLUCAO');
    expect(row.destNome).toBe('FORNECEDOR XYZ');
    expect(row.destUF).toBe('');
    expect(row.vNF).toBe('50.00');
  });

  it('throws on XML without <infNFe>', () => {
    expect(() => parseNfeReportRow('<foo/>')).toThrow(/infNFe/);
  });
});
