/**
 * Anexo IV — `cCredPres` (#333). Hand-transcribed data, so every row is
 * checked, and the lookup is pinned to the XSD's 2-digit shape.
 */
import { describe, expect, it } from 'vitest';

import {
  CCREDPRES_PROVENIENCIA,
  CCREDPRES_TABELA,
  TRIBUTO_CREDITO_PRESUMIDO,
  cCredPresEntry,
} from './ccredpres';

describe('CCREDPRES_TABELA', () => {
  it('holds exactly the codes 01..13, in order, as the XSD 2-digit shape', () => {
    expect(CCREDPRES_TABELA.map((e) => e.cCredPres)).toEqual(
      Array.from({ length: 13 }, (_, i) => String(i + 1).padStart(2, '0')),
    );
    // `TcCredPres` = \d{2} (DFeTiposBasicos_v1.00.xsd).
    for (const e of CCREDPRES_TABELA) expect(e.cCredPres).toMatch(/^\d{2}$/);
    expect(CCREDPRES_TABELA).toHaveLength(CCREDPRES_PROVENIENCIA.linhas);
  });

  it('every row names at least one tax, each once, and a folded description', () => {
    const tributos = new Set<string>(Object.values(TRIBUTO_CREDITO_PRESUMIDO));
    for (const e of CCREDPRES_TABELA) {
      expect(e.tributos.length).toBeGreaterThan(0);
      expect(new Set(e.tributos).size).toBe(e.tributos.length);
      for (const t of e.tributos) expect(tributos.has(t)).toBe(true);
      expect(e.descricao).toBe(e.descricao.trim());
      expect(e.descricao).not.toMatch(/\s{2,}|&#/);
    }
  });

  it('spot-check against the page: 04 deducts from the total, 05 is CBS-only', () => {
    expect(cCredPresEntry('04')).toMatchObject({ deduzValorTotal: true, apropriaDfe: true });
    expect(cCredPresEntry('05')?.tributos).toEqual([TRIBUTO_CREDITO_PRESUMIDO.cbs]);
  });
});

describe('cCredPresEntry — exact 2-digit match', () => {
  it('resolves a known code', () => {
    expect(cCredPresEntry('01')?.descricao).toMatch(/produtor rural/);
  });

  // The page prints `1`; the wire carries `01`. Neither the unpadded nor an
  // over-padded form may resolve, or a lookup would accept what the XSD refuses.
  it.each(['1', '001', '00', '14', ' 01', '01 ', null, undefined, ''])('%j → null', (code) => {
    expect(cCredPresEntry(code)).toBeNull();
  });
});
