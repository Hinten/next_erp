/**
 * The fixed facts of finNFe 5/6: the tipo ↔ cClassTrib bindings (UB14-60/70/80)
 * pinned against the NT's own tables AND the vendored Anexo III (#333), and the
 * item tax groups each tipo carries (B25-80).
 */
import { describe, expect, it } from 'vitest';

import { cClassTribEntry } from './cclasstrib';
import { TP_NF_CREDITO, TP_NF_DEBITO } from '../operacao';
import {
  CCLASSTRIB_DO_TP_NF_CREDITO,
  CCLASSTRIB_DO_TP_NF_DEBITO,
  COMPETENCIA_AAAA_MM,
  GRUPO_AJUSTE_RTC,
  MODO_GRUPOS_IMPOSTO,
  cClassTribCompativelComTipo,
  cClassTribDoTipo,
  cClassTribVinculadoATipoDeNota,
  grupoDeAjusteDoTipo,
  modoGruposImposto,
} from './notaCreditoDebito';

/**
 * UB14-60's table, transcribed from NT 2025.002 v1.40 p.39 ("cClassTrib x
 * tpNFCredito / tpNFDebito"). The module never types it — it derives it from
 * the UB14-70/80 maps — so this is the check that the derivation is the NT's.
 */
const UB14_60: ReadonlyArray<readonly [string, string | null, string | null]> = [
  ['410030', '07', null],
  ['800001', '05', '05'],
  ['800002', '01', null],
  ['810001', null, '02'],
  ['811001', '02', null],
  ['811002', '03', null],
  ['811003', '08', null],
];

describe('the tipo ↔ cClassTrib bindings', () => {
  it('UB14-60 is exactly the inverse of the UB14-70/80 maps', () => {
    const derivado = new Map<string, [string | null, string | null]>();
    for (const [tp, c] of Object.entries(CCLASSTRIB_DO_TP_NF_DEBITO)) {
      derivado.set(c, [tp, derivado.get(c)?.[1] ?? null]);
    }
    for (const [tp, c] of Object.entries(CCLASSTRIB_DO_TP_NF_CREDITO)) {
      derivado.set(c, [derivado.get(c)?.[0] ?? null, tp]);
    }
    expect([...derivado].map(([c, [d, cr]]) => [c, d, cr]).sort()).toEqual(
      UB14_60.map((r) => [...r]),
    );
  });

  it('every bound cClassTrib exists in the vendored Anexo III', () => {
    for (const [c] of UB14_60) {
      expect(cClassTribEntry(c), c).toBeDefined();
    }
  });

  it.each(UB14_60)('%s rides only on its own tipo', (c, debito, credito) => {
    expect(cClassTribVinculadoATipoDeNota(c)).toBe(true);
    if (debito) {
      expect(
        cClassTribCompativelComTipo(c, {
          finNFe: 6,
          tpNFDebito: debito as '01',
          tpNFCredito: null,
        }),
      ).toBe(true);
    }
    if (credito) {
      expect(
        cClassTribCompativelComTipo(c, {
          finNFe: 5,
          tpNFDebito: null,
          tpNFCredito: credito as '01',
        }),
      ).toBe(true);
    }
    // Near-misses: a normal nota, and the "não limitar" débito 04.
    expect(cClassTribCompativelComTipo(c, { finNFe: 1, tpNFDebito: null, tpNFCredito: null })).toBe(
      false,
    );
    expect(
      cClassTribCompativelComTipo(c, {
        finNFe: 6,
        tpNFDebito: TP_NF_DEBITO.multaJuros,
        tpNFCredito: null,
      }),
    ).toBe(false);
  });

  it('an unbound cClassTrib rides on any nota', () => {
    expect(cClassTribVinculadoATipoDeNota('000001')).toBe(false);
    expect(
      cClassTribCompativelComTipo('000001', {
        finNFe: 6,
        tpNFDebito: TP_NF_DEBITO.transferenciaCreditoSucessao,
        tpNFCredito: null,
      }),
    ).toBe(true);
  });

  it('cClassTribDoTipo reads the field of the finalidade, never the other one', () => {
    expect(
      cClassTribDoTipo({ finNFe: 6, tpNFDebito: TP_NF_DEBITO.perdaEstoque, tpNFCredito: null }),
    ).toBe('410030');
    expect(
      cClassTribDoTipo({ finNFe: 6, tpNFDebito: TP_NF_DEBITO.multaJuros, tpNFCredito: null }),
    ).toBeNull();
    // A crédito 05 field on a nota de débito binds nothing (B25.2-10 reports it).
    expect(
      cClassTribDoTipo({
        finNFe: 6,
        tpNFDebito: null,
        tpNFCredito: TP_NF_CREDITO.transferenciaCreditoSucessao,
      }),
    ).toBeNull();
    expect(
      cClassTribDoTipo({ finNFe: 1, tpNFDebito: TP_NF_DEBITO.perdaEstoque, tpNFCredito: null }),
    ).toBeNull();
  });
});

describe('modoGruposImposto — B25-80', () => {
  it.each([
    [1, null, null, MODO_GRUPOS_IMPOSTO.completo],
    [4, null, null, MODO_GRUPOS_IMPOSTO.completo],
    [5, null, '01', MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    [5, null, '02', MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    [5, null, '03', MODO_GRUPOS_IMPOSTO.completo],
    [5, null, '04', MODO_GRUPOS_IMPOSTO.completo],
    [5, null, '05', MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    // PL_010f: crédito 06 (retorno por recusa parcial) joins the B25-80 exceptions.
    [5, null, '06', MODO_GRUPOS_IMPOSTO.completo],
    [6, '01', null, MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    [6, '04', null, MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    [6, '06', null, MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    [6, '07', null, MODO_GRUPOS_IMPOSTO.completo],
    [6, '08', null, MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    // A finalidade without its tipo (B25.1-20 / B25.2-20 refuse it) is still
    // IBS/CBS only — the tipo field never widens it.
    [6, null, null, MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
    [6, null, '03', MODO_GRUPOS_IMPOSTO.somenteIbsCbs],
  ] as const)('finNFe %s débito %s crédito %s → %s', (finNFe, tpNFDebito, tpNFCredito, modo) => {
    expect(modoGruposImposto({ finNFe, tpNFDebito, tpNFCredito })).toBe(modo);
  });
});

describe('grupoDeAjusteDoTipo — derived from the Anexo III indicators', () => {
  const G = GRUPO_AJUSTE_RTC;
  it.each([
    [6, TP_NF_DEBITO.transferenciaCreditoCooperativa, null, G.transfCred],
    [6, TP_NF_DEBITO.anulacaoCreditoSaidaImuneIsenta, null, G.ajusteCompet],
    [6, TP_NF_DEBITO.debitoNotaNaoProcessada, null, G.ajusteCompet],
    [6, TP_NF_DEBITO.multaJuros, null, null],
    [6, TP_NF_DEBITO.transferenciaCreditoSucessao, null, G.transfCred],
    [6, TP_NF_DEBITO.pagamentoAntecipado, null, null],
    [6, TP_NF_DEBITO.perdaEstoque, null, G.estornoCred],
    [6, TP_NF_DEBITO.desenquadramentoSimples, null, G.ajusteCompet],
    [5, null, TP_NF_CREDITO.multaJuros, null],
    [5, null, TP_NF_CREDITO.creditoPresumidoZfm, G.credPresIBSZFM],
    [5, null, TP_NF_CREDITO.retornoRecusaTotal, null],
    [5, null, TP_NF_CREDITO.reducaoValores, null],
    [5, null, TP_NF_CREDITO.transferenciaCreditoSucessao, G.transfCred],
    [5, null, TP_NF_CREDITO.retornoRecusaParcial, null],
    // Near-misses: a tipo on the wrong finalidade, and a normal nota.
    [5, TP_NF_DEBITO.perdaEstoque, null, null],
    [1, null, null, null],
  ] as const)('finNFe %s débito %s crédito %s → %s', (finNFe, tpNFDebito, tpNFCredito, grupo) => {
    expect(grupoDeAjusteDoTipo({ finNFe, tpNFDebito, tpNFCredito })).toBe(grupo);
  });
});

describe('COMPETENCIA_AAAA_MM', () => {
  it('accepts a real month and refuses its near-misses', () => {
    for (const ok of ['2026-01', '2026-09', '2026-12'])
      expect(COMPETENCIA_AAAA_MM.test(ok)).toBe(true);
    for (const bad of [
      '2026-00',
      '2026-13',
      '2026-9',
      '26-09',
      '2026/09',
      ' 2026-09',
      '2026-09-01',
    ]) {
      expect(COMPETENCIA_AAAA_MM.test(bad), bad).toBe(false);
    }
  });
});
