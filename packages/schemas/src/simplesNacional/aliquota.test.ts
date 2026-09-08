import { describe, expect, it } from 'vitest';

import type { NFeTotais } from '../nfe';
import {
  SEM_ALIQUOTA,
  aliquotaEfetiva,
  contribuicaoDaNota,
  faixaDoRbt12,
  impostoDaReceita,
  rbt12Proporcional,
  receitaBrutaDeNota,
  sinalDaReceita,
} from './aliquota';
import { ANEXO_I, ANEXO_II, TABELAS_SIMPLES, TETO_SIMPLES_NACIONAL } from './tabelas';

function totais(over: Partial<NFeTotais> = {}): NFeTotais {
  return {
    vProd: 100,
    vDesc: 0,
    vST: 0,
    vIPI: 0,
    vFrete: 0,
    vSeg: 0,
    vOutro: 0,
    vNF: 100,
    tpNF: 1,
    finNFe: 1,
    rtc: null,
    ...over,
  };
}

// ── The faixa boundaries ──────────────────────────────────────────────────
//
// Getting an edge wrong swaps the whole alíquota, and the resulting number is
// perfectly plausible — there is no crash, no NaN, just a different tax. So
// every edge of every anexo is pinned from BOTH sides.
describe('faixaDoRbt12 — every boundary, from both sides', () => {
  for (const [nome, tabela] of Object.entries(TABELAS_SIMPLES)) {
    describe(`Anexo ${nome}`, () => {
      for (const f of tabela) {
        it(`R$ ${f.ate.toLocaleString('pt-BR')} exactly is STILL faixa ${f.faixa} (teto inclusivo)`, () => {
          expect(faixaDoRbt12(nome as 'I' | 'II', f.ate)?.faixa).toBe(f.faixa);
        });

        if (f.faixa < 6) {
          it(`one centavo above it is faixa ${f.faixa + 1}`, () => {
            expect(faixaDoRbt12(nome as 'I' | 'II', f.ate + 0.01)?.faixa).toBe(f.faixa + 1);
          });
        } else {
          it('one centavo above the 6th faixa is outside the table', () => {
            expect(faixaDoRbt12(nome as 'I' | 'II', f.ate + 0.01)).toBeNull();
          });
        }
      }
    });
  }

  it('the smallest possible receita is faixa 1', () => {
    expect(faixaDoRbt12('I', 0.01)?.faixa).toBe(1);
  });
});

// ── The formula ───────────────────────────────────────────────────────────
describe('aliquotaEfetiva', () => {
  it('faixa 1 has no deduction, so effective == nominal', () => {
    const r = aliquotaEfetiva('I', 100_000);
    expect(r.ok && r.aliquotaEfetiva).toBeCloseTo(0.04, 10);
  });

  it('worked example: Anexo I, RBT12 R$ 500.000', () => {
    // (500000 × 0,095 − 13860) / 500000 = 0,06728 → 6,728%
    const r = aliquotaEfetiva('I', 500_000);
    expect(r.ok).toBe(true);
    expect(r.ok && r.faixa.faixa).toBe(3);
    expect(r.ok && r.aliquotaEfetiva).toBeCloseTo(0.06728, 10);
  });

  it('worked example: Anexo II, RBT12 R$ 2.000.000', () => {
    // (2000000 × 0,147 − 85500) / 2000000 = 0,10425 → 10,425%
    const r = aliquotaEfetiva('II', 2_000_000);
    expect(r.ok && r.aliquotaEfetiva).toBeCloseTo(0.10425, 10);
  });

  it('the effective rate is ALWAYS below the nominal one, above faixa 1', () => {
    // That is the whole point of the parcela a deduzir; if a table edit ever
    // inverted it, every note would be overtaxed and nothing else would fail.
    for (const [nome, tabela] of Object.entries(TABELAS_SIMPLES)) {
      for (const f of tabela.filter((x) => x.deduzir > 0)) {
        const r = aliquotaEfetiva(nome as 'I' | 'II', f.ate);
        expect(r.ok && r.aliquotaEfetiva).toBeLessThan(f.nominal);
      }
    }
  });

  it('the rate rises monotonically WITHIN a faixa', () => {
    // Inside one faixa the deduction is fixed, so a larger RBT12 dilutes it
    // less and the effective rate climbs. That is true of every faixa.
    for (const [nome, tabela] of Object.entries(TABELAS_SIMPLES)) {
      for (const f of tabela.filter((x) => x.deduzir > 0)) {
        const baixo = aliquotaEfetiva(nome as 'I' | 'II', f.ate * 0.8);
        const alto = aliquotaEfetiva(nome as 'I' | 'II', f.ate);
        expect(alto.ok && baixo.ok && alto.aliquotaEfetiva).toBeGreaterThan(
          baixo.ok ? baixo.aliquotaEfetiva : Number.NaN,
        );
      }
    }
  });

  // ⚠️ ACROSS the 5th→6th boundary it does NOT rise — it DROPS, and that is
  // the law, not a bug in the table.
  //
  // A parcela a deduzir is normally chosen to make the curve continuous at the
  // boundary. For the 6th faixa it is not: Anexo I would need R$ 256.500 for
  // continuity and the law says R$ 378.000. So a company crossing R$ 3.600.000
  // sees its effective rate fall from 11,875% to 8,50%.
  //
  // ⚠️ The two anexos then behave DIFFERENTLY, which is why both are pinned:
  // Anexo I never regains the 5th faixa's peak (its 6th tops out at 11,125%,
  // still below 11,875%), while Anexo II climbs past its own (12,325% → 15%).
  // Anyone reasoning "the top faixa is always the most expensive" is right for
  // II and wrong for I.
  //
  // This is pinned because it is exactly the kind of "obviously wrong" number
  // a future reader would 'fix'. Editing the deduction to smooth the curve
  // would overtax every company in the top faixa.
  describe('the 5th→6th discontinuity is REAL LAW, not a table error', () => {
    it.each([
      ['I', 0.11875, 0.085, 0.11125],
      ['II', 0.12325, 0.1, 0.15],
    ] as const)(
      'Anexo %s: %s at the top of faixa 5, %s just inside faixa 6',
      (anexo, topoF5, entradaF6, topoF6) => {
        const noTopoDaF5 = aliquotaEfetiva(anexo, 3_600_000);
        const entrandoNaF6 = aliquotaEfetiva(anexo, 3_600_000.01);
        const noTopoDaF6 = aliquotaEfetiva(anexo, 4_800_000);

        expect(noTopoDaF5.ok && noTopoDaF5.aliquotaEfetiva).toBeCloseTo(topoF5, 6);
        expect(entrandoNaF6.ok && entrandoNaF6.aliquotaEfetiva).toBeCloseTo(entradaF6, 6);
        expect(noTopoDaF6.ok && noTopoDaF6.aliquotaEfetiva).toBeCloseTo(topoF6, 6);

        // The drop, stated as an assertion so it cannot be smoothed away.
        expect(entrandoNaF6.ok && entrandoNaF6.aliquotaEfetiva).toBeLessThan(
          noTopoDaF5.ok ? noTopoDaF5.aliquotaEfetiva : 0,
        );
      },
    );
  });

  it('is NOT rounded — the rate is not money', () => {
    const r = aliquotaEfetiva('I', 500_000);
    // 0.06728 would survive a 2-decimal round as 0.07, a 4% error on every note.
    expect(r.ok && r.aliquotaEfetiva).not.toBe(0.07);
  });

  describe('refuses rather than inventing a number', () => {
    it('RBT12 zero — nothing to divide by', () => {
      const r = aliquotaEfetiva('I', 0);
      expect(r).toEqual({ ok: false, motivo: SEM_ALIQUOTA.semReceita });
    });

    it('RBT12 negative — devoluções exceeded sales', () => {
      expect(aliquotaEfetiva('I', -1).ok).toBe(false);
    });

    it('exactly at the teto is still INSIDE the regime', () => {
      expect(aliquotaEfetiva('I', TETO_SIMPLES_NACIONAL).ok).toBe(true);
    });

    it('one centavo above the teto is exclusion, not faixa 6', () => {
      const r = aliquotaEfetiva('I', TETO_SIMPLES_NACIONAL + 0.01);
      expect(r).toEqual({ ok: false, motivo: SEM_ALIQUOTA.acimaDoTeto });
    });
  });
});

describe('impostoDaReceita', () => {
  it('rounds through the canonical money helper', () => {
    expect(impostoDaReceita(1000, 0.06728)).toBe(67.28);
  });
});

// ── RBT12 proporcional (empresa em início de atividade) ───────────────────
describe('rbt12Proporcional', () => {
  it('first month: the month itself × 12', () => {
    expect(rbt12Proporcional({ receitasAnteriores: [], receitaDoMes: 10_000 })).toBe(120_000);
  });

  it('months 2..12: the MEAN of prior months × 12, ignoring the current one', () => {
    // The current month is deliberately excluded — including it is the common
    // mistake, and it would inflate RBT12 and the faixa with it.
    expect(rbt12Proporcional({ receitasAnteriores: [10_000, 20_000], receitaDoMes: 999_999 })).toBe(
      180_000,
    );
  });

  it('a proportional RBT12 can push a young company into a higher faixa', () => {
    // R$ 40k in month one annualises to R$ 480k — faixa 3, not faixa 1.
    const rbt12 = rbt12Proporcional({ receitasAnteriores: [], receitaDoMes: 40_000 });
    expect(faixaDoRbt12('I', rbt12)?.faixa).toBe(3);
  });
});

// ── NF-e → receita bruta ──────────────────────────────────────────────────
describe('receitaBrutaDeNota', () => {
  it('produtos − desconto + frete + seguro + outras', () => {
    expect(
      receitaBrutaDeNota(totais({ vProd: 1000, vDesc: 100, vFrete: 50, vSeg: 10, vOutro: 5 })),
    ).toBe(965);
  });

  it('EXCLUDES ICMS-ST and IPI even though vNF includes them', () => {
    const t = totais({ vProd: 1000, vST: 200, vIPI: 100, vNF: 1300 });
    expect(receitaBrutaDeNota(t)).toBe(1000);
    expect(receitaBrutaDeNota(t)).not.toBe(t.vNF);
  });

  it('EXCLUDES the RTC tributes — they ride por fora', () => {
    const semRtc = totais({ vProd: 1000 });
    const comRtc = totais({
      vProd: 1000,
      rtc: { vBCIBSCBS: 1000, vIBS: 1.5, vCBS: 13.5, vIS: 5, vNFTot: 1020 },
    });
    expect(receitaBrutaDeNota(comRtc)).toBe(receitaBrutaDeNota(semRtc));
  });
});

// ── The sign table ────────────────────────────────────────────────────────
describe('sinalDaReceita — tpNF alone does not decide', () => {
  it.each([
    ['saída normal → soma', 1, 1, 1],
    ['saída complementar → soma', 1, 2, 1],
    ['saída ajuste → neutra', 1, 3, 0],
    ['saída devolução (devolvemos ao fornecedor) → neutra', 1, 4, 0],
    ['entrada devolução (cliente devolveu) → SUBTRAI', 0, 4, -1],
    ['entrada normal (compra) → neutra', 0, 1, 0],
    ['entrada complementar → neutra', 0, 2, 0],
    ['entrada ajuste → neutra', 0, 3, 0],
  ] as const)('%s', (_label, tpNF, finNFe, esperado) => {
    expect(sinalDaReceita(totais({ tpNF, finNFe }))).toBe(esperado);
  });

  it('the two devoluções differ by tpNF alone — the near-miss', () => {
    // Same finNFe=4, opposite meaning. Reading only finNFe would make a
    // purchase return subtract from our revenue.
    expect(sinalDaReceita(totais({ tpNF: 0, finNFe: 4 }))).toBe(-1);
    expect(sinalDaReceita(totais({ tpNF: 1, finNFe: 4 }))).toBe(0);
  });
});

describe('contribuicaoDaNota', () => {
  it('a sale adds its receita bruta', () => {
    expect(contribuicaoDaNota(totais({ vProd: 500, vFrete: 20 }))).toBe(520);
  });

  it('a customer return subtracts it', () => {
    expect(contribuicaoDaNota(totais({ vProd: 500, tpNF: 0, finNFe: 4 }))).toBe(-500);
  });

  it('a neutral note contributes exactly zero, not its value', () => {
    expect(contribuicaoDaNota(totais({ vProd: 500, tpNF: 1, finNFe: 3 }))).toBe(0);
  });
});

// ── The tables themselves ─────────────────────────────────────────────────
describe('tabelas', () => {
  it('both anexos have six faixas ending at the teto', () => {
    for (const t of [ANEXO_I, ANEXO_II]) {
      expect(t).toHaveLength(6);
      expect(t[5]!.ate).toBe(TETO_SIMPLES_NACIONAL);
    }
  });

  it('faixa ceilings are strictly increasing', () => {
    for (const t of [ANEXO_I, ANEXO_II]) {
      for (let i = 1; i < t.length; i += 1) expect(t[i]!.ate).toBeGreaterThan(t[i - 1]!.ate);
    }
  });
});
