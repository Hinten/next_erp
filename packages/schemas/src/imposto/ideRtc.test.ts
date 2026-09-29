/**
 * `ide/dPrevEntrega` (B10a) and the ISUFEmit municipality list (C22-10), #331.
 * Every window has its boundary AND the first value past it.
 */
import { describe, expect, it } from 'vitest';

import { MODALIDADE_FRETE } from '../shared/frete';
import {
  ISUF_EMIT_REGEX,
  MUNICIPIOS_SUFRAMA_EMITENTE,
  dPrevEntregaParaEmissao,
  somarMeses,
} from './ideRtc';

const base = {
  previsao: '2026-10-15',
  emissao: '2026-09-29',
  finNFe: 1,
  modFrete: MODALIDADE_FRETE.cif,
} as const;

describe('somarMeses', () => {
  it('adds calendar months and clamps the day to the month end', () => {
    expect(somarMeses('2026-09-29', 3)).toBe('2026-12-29');
    expect(somarMeses('2026-11-30', 3)).toBe('2027-02-28');
    expect(somarMeses('2027-11-30', 3)).toBe('2028-02-29'); // leap year
    expect(somarMeses('2026-10-31', 1)).toBe('2026-11-30');
    expect(somarMeses('29/09/2026', 3)).toBeNull();
  });
});

describe('dPrevEntregaParaEmissao — B10a-20…50, omitted rather than refused', () => {
  it('emits a forecast inside every window', () => {
    expect(dPrevEntregaParaEmissao(base)).toBe('2026-10-15');
    // Devolução (finNFe 4) is the other finalidade allowed.
    expect(dPrevEntregaParaEmissao({ ...base, finNFe: 4 })).toBe('2026-10-15');
  });

  it('B10a-30 — the emission day itself is fine, the day before is not', () => {
    expect(dPrevEntregaParaEmissao({ ...base, previsao: '2026-09-29' })).toBe('2026-09-29');
    expect(dPrevEntregaParaEmissao({ ...base, previsao: '2026-09-28' })).toBeNull();
  });

  it('B10a-20 — exactly 3 calendar months is fine, one day more is not', () => {
    expect(dPrevEntregaParaEmissao({ ...base, previsao: '2026-12-29' })).toBe('2026-12-29');
    expect(dPrevEntregaParaEmissao({ ...base, previsao: '2026-12-30' })).toBeNull();
  });

  it('B10a-40 — only finalidade 1 or 4', () => {
    for (const finNFe of [2, 3, 5, 6]) {
      expect(dPrevEntregaParaEmissao({ ...base, finNFe })).toBeNull();
    }
  });

  it('B10a-50 — never with FOB, transporte próprio do destinatário or sem transporte', () => {
    for (const modFrete of [
      MODALIDADE_FRETE.fob,
      MODALIDADE_FRETE.proprioDestinatario,
      MODALIDADE_FRETE.semTransporte,
    ]) {
      expect(dPrevEntregaParaEmissao({ ...base, modFrete })).toBeNull();
    }
    for (const modFrete of [
      MODALIDADE_FRETE.cif,
      MODALIDADE_FRETE.terceiros,
      MODALIDADE_FRETE.proprioRemetente,
    ]) {
      expect(dPrevEntregaParaEmissao({ ...base, modFrete })).toBe('2026-10-15');
    }
  });

  it('no forecast, or a malformed one, is no forecast', () => {
    expect(dPrevEntregaParaEmissao({ ...base, previsao: null })).toBeNull();
    expect(dPrevEntregaParaEmissao({ ...base, previsao: '15/10/2026' })).toBeNull();
  });
});

describe('ISUFEmit', () => {
  it('C22-10 lists the 12 ZFM/ALC municipalities of NT 2025.002 v1.51', () => {
    expect(MUNICIPIOS_SUFRAMA_EMITENTE.size).toBe(12);
    expect(MUNICIPIOS_SUFRAMA_EMITENTE.has('1302603')).toBe(true); // Manaus
    // Near-miss: a neighbouring code.
    expect(MUNICIPIOS_SUFRAMA_EMITENTE.has('1302602')).toBe(false);
  });

  it('is 8 or 9 digits', () => {
    for (const ok of ['20012345', '200123456']) expect(ISUF_EMIT_REGEX.test(ok)).toBe(true);
    for (const bad of ['2001234', '2001234567', '20012345a', '']) {
      expect(ISUF_EMIT_REGEX.test(bad)).toBe(false);
    }
  });
});
