import { describe, expect, it } from 'vitest';

import { APURACAO_ESTADO } from '@delfrance/schemas';

import { descreverEstado, formatAliquota } from './SimplesNacionalPanel';

describe('formatAliquota', () => {
  it('renders a fraction as a pt-BR percentage', () => {
    // Stored as 0.06728; the accountant says "6,728%".
    expect(formatAliquota(0.06728)).toBe('6,728%');
  });

  it('keeps three decimals — the rate is not money and 6,73% is a different tax', () => {
    expect(formatAliquota(0.04)).toBe('4,000%');
  });

  it('shows a dash for "not apurada yet" rather than 0%', () => {
    // 0% is a claim; "—" is the truth before the first apuração.
    expect(formatAliquota(null)).toBe('—');
    expect(formatAliquota(null)).not.toBe('0,000%');
  });
});

describe('descreverEstado', () => {
  it('vigente reads as published', () => {
    const d = descreverEstado(APURACAO_ESTADO.vigente, 0);
    expect(d?.cor).toBe('green');
  });

  // ⚠️ The load-bearing one. `incompleta` must not read as a neutral badge:
  // the number on screen is known to be untrustworthy and the OLD rate is
  // still the one being applied.
  describe('incompleta — a warning, not information', () => {
    it('is red, not a neutral colour', () => {
      expect(descreverEstado(APURACAO_ESTADO.incompleta, 3)?.cor).toBe('red');
    });

    it('says plainly that the rate was NOT updated', () => {
      const d = descreverEstado(APURACAO_ESTADO.incompleta, 3);
      expect(d?.titulo).toMatch(/NÃO foi atualizada/);
    });

    it('names how many notes could not be read', () => {
      expect(descreverEstado(APURACAO_ESTADO.incompleta, 3)?.detalhe).toContain('3 nota');
    });

    it('explains the DIRECTION of the error — a smaller revenue means a smaller faixa', () => {
      // Without this the operator cannot tell whether an incomplete window is
      // harmless. It is not: it under-declares.
      expect(descreverEstado(APURACAO_ESTADO.incompleta, 1)?.detalhe).toMatch(
        /receita menor daria uma faixa menor/,
      );
    });

    it('says the previous rate still applies', () => {
      expect(descreverEstado(APURACAO_ESTADO.incompleta, 1)?.detalhe).toMatch(
        /anterior continua valendo/,
      );
    });

    it('handles a null counter without printing "null notes"', () => {
      expect(descreverEstado(APURACAO_ESTADO.incompleta, null)?.detalhe).toContain('0 nota');
    });
  });

  it('aguardandoAutorizacao points at the switch that unblocks it', () => {
    const d = descreverEstado(APURACAO_ESTADO.aguardandoAutorizacao, 0);
    expect(d?.cor).toBe('yellow');
    expect(d?.detalhe).toMatch(/recálculo automático/);
  });

  it('foraDoRegime names the ceiling rather than showing a wrong rate', () => {
    expect(descreverEstado(APURACAO_ESTADO.foraDoRegime, 0)?.detalhe).toContain('4.800.000');
  });

  it('renders nothing before the first apuração', () => {
    // A filial just configured has no state; an invented badge would imply a
    // run that never happened.
    expect(descreverEstado(null, null)).toBeNull();
  });

  it('every state is distinguishable by colour AND wording', () => {
    const estados = [
      APURACAO_ESTADO.vigente,
      APURACAO_ESTADO.incompleta,
      APURACAO_ESTADO.aguardandoAutorizacao,
      APURACAO_ESTADO.foraDoRegime,
    ] as const;
    const cores = estados.map((e) => descreverEstado(e, 0)?.cor);
    const titulos = estados.map((e) => descreverEstado(e, 0)?.titulo);
    expect(new Set(cores).size).toBe(estados.length);
    expect(new Set(titulos).size).toBe(estados.length);
  });
});
