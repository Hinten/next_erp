import { describe, expect, it } from 'vitest';

import { APURACAO_ESTADO } from '@delfrance/schemas';

import {
  aliquotaParaCampo,
  campoParaAliquota,
  descreverEstado,
  formatAliquota,
} from './SimplesNacionalPanel';

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

describe('aliquotaParaCampo / campoParaAliquota', () => {
  it('shows a stored fraction as the percentage the accountant says', () => {
    expect(aliquotaParaCampo(0.06728)).toBe(6.728);
    expect(campoParaAliquota(6.728)).toBe(0.06728);
  });

  it('keeps null as "not informed" in both directions — never 0%', () => {
    expect(aliquotaParaCampo(null)).toBeNull();
    expect(campoParaAliquota(null)).toBeNull();
  });

  it('spans the whole schema range: 0 and the 100% ceiling `.max(1)` allows', () => {
    expect(aliquotaParaCampo(0)).toBe(0);
    expect(aliquotaParaCampo(1)).toBe(100);
    expect(campoParaAliquota(100)).toBe(1);
  });

  it('⚠️ round-trips EXACTLY, which a bare × 100 does not', () => {
    // The defect this pair exists to prevent, stated as the arithmetic itself:
    // both raw operations are off by an ulp, and neither is visible at any
    // scale the field renders — so an untouched form would look identical and
    // still re-save a different number every time it was opened.
    expect(0.06728 * 100).not.toBe(6.728);
    expect(6.728 / 100).not.toBe(0.06728);

    // Every value the input can express: `decimalScale={4}` on a percentage is
    // six decimals of a fraction. Sampled across the whole 0–1 domain.
    for (let i = 0; i <= 1_000_000; i += 7) {
      const fracao = i / 1e6;
      expect(campoParaAliquota(aliquotaParaCampo(fracao))).toBe(fracao);
    }
  });

  it('⚠️ NEAR-MISS: two rates one ten-thousandth of a percent apart stay distinct', () => {
    // The fold must not reach further than the input's own precision. 6,7280%
    // and 6,7281% are different rates, and the `dirty` check that enables the
    // Save button is an equality over exactly these values — a rounding one
    // digit coarser would report a real edit as "nothing changed".
    expect(campoParaAliquota(6.728)).not.toBe(campoParaAliquota(6.7281));
    expect(aliquotaParaCampo(0.06728)).not.toBe(aliquotaParaCampo(0.067281));
  });
});
