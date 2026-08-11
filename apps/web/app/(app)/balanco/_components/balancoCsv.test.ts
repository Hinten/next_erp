import { describe, expect, it } from 'vitest';

import { BALANCO_CSV_HEADER, balancoCsvFilename, buildBalancoCsv } from './balancoCsv';
import type { LinhaRevisao } from './balancoTotais';

function linha(over: Partial<LinhaRevisao> = {}): LinhaRevisao {
  return {
    produtoId: 'p1',
    sku: 'ABC-1',
    nome: 'Camiseta',
    estoque: 8,
    contado: 5,
    estoquesExtras: null,
    ...over,
  };
}

describe('buildBalancoCsv', () => {
  it('emits the header and a semicolon-delimited row with the difference', () => {
    const csv = buildBalancoCsv([linha()]);
    const linhas = csv.split('\r\n');
    expect(linhas[0]).toBe(`﻿${BALANCO_CSV_HEADER.join(';')}`);
    expect(linhas[1]).toBe('ABC-1;Camiseta;8;5;-3');
  });

  it('starts with a UTF-8 BOM so Excel pt-BR keeps the accents', () => {
    // Legacy exported UTF-8 with no BOM, so "Camiseta Básica" opened mangled.
    expect(buildBalancoCsv([linha({ nome: 'Camiseta Básica' })]).startsWith('﻿')).toBe(true);
    expect(buildBalancoCsv([linha({ nome: 'Camiseta Básica' })])).toContain('Básica');
  });

  it('uses comma decimals', () => {
    expect(buildBalancoCsv([linha({ estoque: 8.5, contado: 5.25 })])).toContain('8,5;5,25;-3,25');
  });

  it('leaves an uncounted produto blank instead of a sentence in a numeric column', () => {
    // Legacy wrote the literal string "Nada foi lançado" into the quantity
    // column, which makes the whole column non-numeric in a spreadsheet.
    const csv = buildBalancoCsv([linha({ contado: null, estoque: 4 })]);
    expect(csv).toContain('ABC-1;Camiseta;4;;-4');
    expect(csv).not.toContain('Nada foi');
  });

  it('neutralizes a formula-injection lead in a produto name', () => {
    const csv = buildBalancoCsv([linha({ nome: '=1+1' })]);
    expect(csv).toContain("'=1+1");
  });

  it('quotes a name containing the delimiter', () => {
    expect(buildBalancoCsv([linha({ nome: 'Kit; completo' })])).toContain('"Kit; completo"');
  });

  it('handles an empty balanço as a header-only file', () => {
    expect(buildBalancoCsv([])).toBe(`﻿${BALANCO_CSV_HEADER.join(';')}`);
  });
});

describe('balancoCsvFilename', () => {
  it('names the file after the balanço and the day', () => {
    expect(balancoCsvFilename('Contagem Janeiro', new Date('2026-08-10T14:33:07.412Z'))).toBe(
      'Balanço Contagem Janeiro 2026-08-10.csv',
    );
  });

  it('strips characters a filesystem rejects', () => {
    // Legacy embedded a full ISO timestamp, colons included, straight into the
    // download name.
    expect(balancoCsvFilename('Loja A/B: 2026', new Date('2026-08-10T00:00:00Z'))).toBe(
      'Balanço Loja A-B- 2026 2026-08-10.csv',
    );
  });

  it('falls back when the name is blank', () => {
    expect(balancoCsvFilename('   ', new Date('2026-08-10T00:00:00Z'))).toBe(
      'Balanço sem nome 2026-08-10.csv',
    );
  });
});
