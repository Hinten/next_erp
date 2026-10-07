/**
 * Grupo VC — item-level references (`det/DFeReferenciado`), as the pure rule set
 * the pedido editor and the emission pre-flight share (#330). Every rule has a
 * case that trips it AND a near-miss that must not.
 */
import { describe, expect, it } from 'vitest';

import {
  REGRA_DOCUMENTO,
  SEVERIDADE_VIOLACAO,
  bloqueiaEmissao,
  descreverViolacaoDocumento,
  violacoesDaOperacao,
  violacoesDoDocumento,
  type EntradaRegrasDocumento,
  type EntradaRegrasOperacao,
  type RegraDocumento,
} from './regrasDoDocumento';
import { dvChaveAcesso } from '../chaveAcesso';
import { TP_NF_CREDITO, TP_NF_DEBITO, type TpNFDebito } from '../operacao';

/** Emitente CNPJ 14200166000187. */
const CHAVE_A = '35260514200166000187550010000000071000000011';
/** Same emitente, another nota. */
const CHAVE_B = '35200714200166000187550010000000071000000018';
/** Emitente = the CPF 123.456.789-09. */
const CHAVE_CPF = '35260500012345678909550010000000091000000093';

const BASE: EntradaRegrasDocumento = {
  emitRtc: true,
  finNFe: 1,
  tpNF: '1',
  tpNFDebito: null,
  tpNFCredito: null,
  anoEmissao: 2026,
  mesEmissao: 9,
  chNFeReferenciadas: [],
  destinatarioDocumento: '12345678909',
  // The emitente of CHAVE_A / CHAVE_B, in SP.
  emitenteDocumento: '14.200.166/0001-87',
  emitenteCUF: '35',
  chNFePagamentoAntecipado: [],
  emitenteISUF: null,
  // São Paulo — outside the ZFM/ALC.
  emitenteCMun: '3550308',
  itens: [],
};

const ref = (chaveAcesso: string, nItem: number | null = 1) => ({ chaveAcesso, nItem });

function regras(e: Partial<EntradaRegrasDocumento>): RegraDocumento[] {
  return violacoesDoDocumento({ ...BASE, ...e }).map((v) => v.regra);
}

describe('violacoesDoDocumento — item references (Grupo VC)', () => {
  it('a nota without item references has nothing to say, whatever else it carries', () => {
    expect(
      regras({
        emitRtc: false,
        chNFeReferenciadas: [CHAVE_A],
        itens: [{ nItem: 1, dfeReferenciado: null }],
      }),
    ).toEqual([]);
  });

  it('one valid reference with RTC on is clean', () => {
    expect(regras({ itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A, 3) }] })).toEqual([]);
  });

  it('refuses item references with the Reforma Tributária off (policy)', () => {
    const v = violacoesDoDocumento({
      ...BASE,
      emitRtc: false,
      itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A) }],
    });
    expect(v.map((x) => x.regra)).toEqual([REGRA_DOCUMENTO.refItemSemReformaTributaria]);
    expect(bloqueiaEmissao(v)).toBe(true);
  });

  it('1010 — note-level NFref and item references together', () => {
    expect(
      regras({
        chNFeReferenciadas: [CHAVE_B],
        itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A) }],
      }),
    ).toEqual([REGRA_DOCUMENTO.refItemComRefNota]);
  });

  it('flags an invalid chave (shape or check digit) on the item that carries it', () => {
    const v = violacoesDoDocumento({
      ...BASE,
      itens: [
        { nItem: 1, dfeReferenciado: ref(CHAVE_A) },
        { nItem: 2, dfeReferenciado: ref(`${CHAVE_A.slice(0, 43)}2`) },
      ],
    });
    expect(v).toContainEqual(
      expect.objectContaining({ regra: REGRA_DOCUMENTO.refItemChaveInvalida, nItem: 2 }),
    );
  });

  it('1048 — nItem missing; 1–990 accepted, 0 and 991 refused', () => {
    expect(regras({ itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A, null) }] })).toEqual([
      REGRA_DOCUMENTO.refItemSemNItem,
    ]);
    for (const ok of [1, 990]) {
      expect(regras({ itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A, ok) }] })).toEqual([]);
    }
    for (const bad of [0, 991, 1.5]) {
      expect(regras({ itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A, bad) }] })).toEqual([
        REGRA_DOCUMENTO.refItemNItemInvalido,
      ]);
    }
  });

  it('1072 — the same chave + nItem twice; the same chave with another nItem is fine', () => {
    const dup = violacoesDoDocumento({
      ...BASE,
      itens: [
        { nItem: 1, dfeReferenciado: ref(CHAVE_A, 1) },
        { nItem: 2, dfeReferenciado: ref(CHAVE_A, 1) },
      ],
    });
    expect(dup).toEqual([
      expect.objectContaining({ regra: REGRA_DOCUMENTO.refItemDuplicada, nItem: 2, cStat: '1072' }),
    ]);
    expect(
      regras({
        itens: [
          { nItem: 1, dfeReferenciado: ref(CHAVE_A, 1) },
          { nItem: 2, dfeReferenciado: ref(CHAVE_A, 2) },
        ],
      }),
    ).toEqual([]);
  });

  it('1130 — two different notas referenced (not a devolução)', () => {
    expect(
      regras({
        itens: [
          { nItem: 1, dfeReferenciado: ref(CHAVE_A, 1) },
          { nItem: 2, dfeReferenciado: ref(CHAVE_B, 1) },
        ],
      }),
    ).toEqual([REGRA_DOCUMENTO.refItemMaisDeUmaChave]);
  });

  it('1130 does not apply to a devolução (finNFe 4)', () => {
    expect(
      regras({
        finNFe: 4,
        tpNF: '0',
        itens: [
          { nItem: 1, dfeReferenciado: ref(CHAVE_A, 1) },
          { nItem: 2, dfeReferenciado: ref(CHAVE_B, 1) },
        ],
      }),
    ).toEqual([]);
  });

  it('1193 — devolução referencing notas of different emitentes is a WARNING', () => {
    const v = violacoesDoDocumento({
      ...BASE,
      finNFe: 4,
      tpNF: '0',
      itens: [
        { nItem: 1, dfeReferenciado: ref(CHAVE_A, 1) },
        { nItem: 2, dfeReferenciado: ref(CHAVE_CPF, 1) },
      ],
    });
    expect(v.map((x) => x.regra)).toEqual([REGRA_DOCUMENTO.devolucaoEmitentesDiferentes]);
    expect(v[0]!.severidade).toBe(SEVERIDADE_VIOLACAO.aviso);
    expect(bloqueiaEmissao(v)).toBe(false);
  });

  it('1194 — devolução de saída: the referenced emitente must be the destinatário (CPF padded)', () => {
    // Destinatário 123.456.789-09 IS the emitente of CHAVE_CPF — punctuation and
    // the chave's zero padding must fold onto the same value.
    expect(
      regras({
        finNFe: 4,
        tpNF: '1',
        destinatarioDocumento: '123.456.789-09',
        itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_CPF, 1) }],
      }),
    ).toEqual([]);
    // Near-miss: another destinatário.
    expect(
      regras({
        finNFe: 4,
        tpNF: '1',
        destinatarioDocumento: '11144477735',
        itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_CPF, 1) }],
      }),
    ).toEqual([REGRA_DOCUMENTO.devolucaoEmitenteNaoEhDestinatario]);
    // A devolução de ENTRADA is not subject to 1194.
    expect(
      regras({
        finNFe: 4,
        tpNF: '0',
        destinatarioDocumento: '11144477735',
        itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_CPF, 1) }],
      }),
    ).toEqual([]);
  });
});

/**
 * VC02-14 (cStat 321) — every one of these verdicts is a SEFAZ-SP homologação
 * answer measured on 2026-10-07 (#1683, run 37629331453), not a reading of the
 * NT: NFref alone → 321 with AND without the RTC; item references without the
 * RTC → 100; one line of two referenced → 321 `[nItem: 2]`.
 */
describe('violacoesDoDocumento — devolução references per item (VC02-14)', () => {
  const DEVOLUCAO = { finNFe: 4, tpNF: '0' as const };

  it.each([true, false])(
    'NFref alone is refused as ONE document-level 321, whatever the RTC (emitRtc=%s)',
    (emitRtc) => {
      const v = violacoesDoDocumento({
        ...BASE,
        ...DEVOLUCAO,
        emitRtc,
        chNFeReferenciadas: [CHAVE_A],
        itens: [
          { nItem: 1, dfeReferenciado: null },
          { nItem: 2, dfeReferenciado: null },
        ],
      });
      expect(v).toEqual([
        {
          regra: REGRA_DOCUMENTO.devolucaoSemReferenciaPorItem,
          cStat: '321',
          severidade: SEVERIDADE_VIOLACAO.bloqueia,
          nItem: null,
        },
      ]);
      expect(bloqueiaEmissao(v)).toBe(true);
    },
  );

  it('a devolução with no reference at all is refused the same way', () => {
    expect(regras({ ...DEVOLUCAO, itens: [{ nItem: 1, dfeReferenciado: null }] })).toEqual([
      REGRA_DOCUMENTO.devolucaoSemReferenciaPorItem,
    ]);
  });

  it('every item referenced is clean — and WITHOUT the Reforma Tributária too (SEFAZ answered 100)', () => {
    for (const emitRtc of [true, false]) {
      expect(
        regras({
          ...DEVOLUCAO,
          emitRtc,
          itens: [
            { nItem: 1, dfeReferenciado: ref(CHAVE_A, 2) },
            { nItem: 2, dfeReferenciado: ref(CHAVE_A, 1) },
          ],
        }),
      ).toEqual([]);
    }
  });

  it('NEAR-MISS: the RTC exemption is the devolução’s alone — a finNFe 1 nota with item references and RTC off is still refused', () => {
    expect(
      regras({ finNFe: 1, emitRtc: false, itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A) }] }),
    ).toEqual([REGRA_DOCUMENTO.refItemSemReformaTributaria]);
  });

  it('judged PER ITEM: the unreferenced line of a partly referenced devolução blocks, by its nItem', () => {
    const v = violacoesDoDocumento({
      ...BASE,
      ...DEVOLUCAO,
      itens: [
        { nItem: 1, dfeReferenciado: ref(CHAVE_A, 1) },
        { nItem: 2, dfeReferenciado: null },
      ],
    });
    expect(v.map((x) => [x.regra, x.nItem, x.severidade])).toEqual([
      [REGRA_DOCUMENTO.devolucaoItemSemReferencia, 2, SEVERIDADE_VIOLACAO.bloqueia],
    ]);
    expect(descreverViolacaoDocumento(v[0]!)).toBe(
      'Item 2: Este item da devolução está sem a referência ao item da nota de origem. (SEFAZ 321)',
    );
  });

  it('every item referenced AND an NFref beside them is 1010’s to refuse, not 321', () => {
    expect(
      regras({
        ...DEVOLUCAO,
        chNFeReferenciadas: [CHAVE_A],
        itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A, 1) }],
      }),
    ).toEqual([REGRA_DOCUMENTO.refItemComRefNota]);
  });

  it('NEAR-MISS: a nota that is not a devolução is never asked for item references', () => {
    for (const finNFe of [1, 2, 3]) {
      expect(regras({ finNFe, itens: [{ nItem: 1, dfeReferenciado: null }] })).toEqual([]);
    }
  });
});

describe('descreverViolacaoDocumento', () => {
  it('names the item and the SEFAZ code when there is one', () => {
    const [v] = violacoesDoDocumento({
      ...BASE,
      itens: [{ nItem: 3, dfeReferenciado: ref(CHAVE_A, null) }],
    });
    expect(descreverViolacaoDocumento(v!)).toBe(
      'Item 3: Informe o número do item da nota referenciada (nItem). (SEFAZ 1048)',
    );
  });

  it('a policy rule carries no SEFAZ code', () => {
    const [v] = violacoesDoDocumento({
      ...BASE,
      emitRtc: false,
      itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A) }],
    });
    expect(descreverViolacaoDocumento(v!)).not.toMatch(/SEFAZ/);
  });
});

// ── Nota de crédito / débito (finNFe 5/6) ─────────────────────────────────

/** Same 43 leading characters, recomputed check digit. */
const comDv = (c43: string) => `${c43}${dvChaveAcesso(c43)}`;
/** CHAVE_A's emitente, but a nota from RJ (cUF 33). */
const CHAVE_OUTRA_UF = comDv(`33${CHAVE_A.slice(2, 43)}`);
/** CHAVE_A as an NFC-e (modelo 65). */
const CHAVE_NFCE = comDv(`${CHAVE_A.slice(0, 20)}65${CHAVE_A.slice(22, 43)}`);
/** CHAVE_A as a CT-e (modelo 57). */
const CHAVE_CTE = comDv(`${CHAVE_A.slice(0, 20)}57${CHAVE_A.slice(22, 43)}`);

const DEBITO = { finNFe: 6, tpNF: '1' } as const;
const CREDITO = { finNFe: 5, tpNF: '0' } as const;
/** An item carrying the ordinary IBS/CBS classification. */
const ITEM_IBSCBS = { nItem: 1, dfeReferenciado: null, cClassTrib: '000001' };

describe('violacoesDaOperacao — finalidade and tipo (B25, B25.1, B25.2)', () => {
  const op = (e: Partial<EntradaRegrasOperacao>) =>
    violacoesDaOperacao({
      finNFe: 1,
      tpNF: '1',
      tpNFDebito: null,
      tpNFCredito: null,
      anoEmissao: null,
      ...e,
    }).map((v) => v.regra);

  it('a well-formed débito and crédito are clean', () => {
    expect(op({ ...DEBITO, tpNFDebito: TP_NF_DEBITO.multaJuros })).toEqual([]);
    expect(op({ ...CREDITO, tpNFCredito: TP_NF_CREDITO.multaJuros })).toEqual([]);
  });

  it('1161 / 1162 — crédito is an entrada, débito a saída', () => {
    expect(op({ finNFe: 5, tpNF: '1', tpNFCredito: TP_NF_CREDITO.multaJuros })).toEqual([
      REGRA_DOCUMENTO.creditoNaoEhEntrada,
    ]);
    expect(op({ finNFe: 6, tpNF: '0', tpNFDebito: TP_NF_DEBITO.multaJuros })).toEqual([
      REGRA_DOCUMENTO.debitoNaoEhSaida,
    ]);
  });

  it('1139 / 1009 — tpNFDebito belongs to finNFe 6, and finNFe 6 needs one', () => {
    expect(op({ tpNFDebito: TP_NF_DEBITO.multaJuros })).toEqual([
      REGRA_DOCUMENTO.tpNFDebitoIndevido,
    ]);
    expect(op({ ...DEBITO })).toEqual([REGRA_DOCUMENTO.tpNFDebitoAusente]);
    // Near-miss: the other direction's field does not satisfy it.
    expect(op({ ...DEBITO, tpNFCredito: TP_NF_CREDITO.multaJuros })).toEqual([
      REGRA_DOCUMENTO.tpNFDebitoAusente,
      REGRA_DOCUMENTO.tpNFCreditoIndevido,
    ]);
  });

  it('1163 / 1164 — tpNFCredito belongs to finNFe 5, and finNFe 5 needs one', () => {
    expect(op({ tpNF: '0', tpNFCredito: TP_NF_CREDITO.reducaoValores })).toEqual([
      REGRA_DOCUMENTO.tpNFCreditoIndevido,
    ]);
    expect(op({ ...CREDITO })).toEqual([REGRA_DOCUMENTO.tpNFCreditoAusente]);
  });

  it('1145 — crédito 02 only from 2029; an unknown year says nothing', () => {
    expect(
      op({ ...CREDITO, tpNFCredito: TP_NF_CREDITO.creditoPresumidoZfm, anoEmissao: 2028 }),
    ).toEqual([REGRA_DOCUMENTO.creditoZfmAntesDe2029]);
    expect(
      op({ ...CREDITO, tpNFCredito: TP_NF_CREDITO.creditoPresumidoZfm, anoEmissao: 2029 }),
    ).toEqual([]);
    expect(
      op({ ...CREDITO, tpNFCredito: TP_NF_CREDITO.creditoPresumidoZfm, anoEmissao: null }),
    ).toEqual([]);
    // Near-miss: another tipo in 2028.
    expect(op({ ...CREDITO, tpNFCredito: TP_NF_CREDITO.multaJuros, anoEmissao: 2028 })).toEqual([]);
  });

  it('1152 — crédito 03 (retorno) must be an entrada, beside 1161', () => {
    expect(op({ finNFe: 5, tpNF: '1', tpNFCredito: TP_NF_CREDITO.retornoRecusaTotal })).toEqual([
      REGRA_DOCUMENTO.creditoNaoEhEntrada,
      REGRA_DOCUMENTO.creditoRetornoNaoEhEntrada,
    ]);
    expect(op({ ...CREDITO, tpNFCredito: TP_NF_CREDITO.retornoRecusaTotal })).not.toContain(
      REGRA_DOCUMENTO.creditoRetornoNaoEhEntrada,
    );
  });

  it('violacoesDoDocumento runs the operação rules too', () => {
    expect(regras({ ...DEBITO })).toContain(REGRA_DOCUMENTO.tpNFDebitoAusente);
  });
});

describe('violacoesDoDocumento — nota de crédito/débito policy', () => {
  it('refuses a nota de crédito/débito with the Reforma Tributária off', () => {
    expect(
      regras({
        ...DEBITO,
        tpNFDebito: TP_NF_DEBITO.pagamentoAntecipado,
        emitRtc: false,
        itens: [ITEM_IBSCBS],
      }),
    ).toEqual([REGRA_DOCUMENTO.notaAjusteSemReformaTributaria]);
    // Near-miss: a normal nota with the RTC off is none of its business.
    expect(regras({ emitRtc: false, itens: [ITEM_IBSCBS] })).toEqual([]);
  });

  it('refuses exactly crédito 02 (ZFM) and 05 (sucessão) — every other tipo is emitted', () => {
    const naoSuportado = (e: Partial<EntradaRegrasDocumento>) =>
      regras({ ...e, anoEmissao: 2030, itens: [ITEM_IBSCBS] }).includes(
        REGRA_DOCUMENTO.notaAjusteTipoNaoSuportado,
      );
    const debitos = (['01', '02', '03', '04', '05', '06', '07', '08'] as const).filter((tp) =>
      naoSuportado({ ...DEBITO, tpNFDebito: tp }),
    );
    const creditos = (['01', '02', '03', '04', '05'] as const).filter((tp) =>
      naoSuportado({ ...CREDITO, tpNFCredito: tp }),
    );
    expect(debitos).toEqual([]);
    expect(creditos).toEqual(['02', '05']);
  });

  it('every item carries IBS/CBS — a known absence refuses, an unknown one says nothing', () => {
    const v = violacoesDoDocumento({
      ...BASE,
      ...DEBITO,
      tpNFDebito: TP_NF_DEBITO.pagamentoAntecipado,
      itens: [ITEM_IBSCBS, { nItem: 2, dfeReferenciado: null, cClassTrib: null }],
    });
    expect(v).toEqual([
      expect.objectContaining({ regra: REGRA_DOCUMENTO.notaAjusteItemSemIbsCbs, nItem: 2 }),
    ]);
    expect(
      regras({
        ...DEBITO,
        tpNFDebito: TP_NF_DEBITO.pagamentoAntecipado,
        itens: [{ nItem: 1, dfeReferenciado: null }],
      }),
    ).toEqual([]);
    // Near-miss: a normal nota may carry an item without IBS/CBS.
    expect(regras({ itens: [{ nItem: 1, dfeReferenciado: null, cClassTrib: null }] })).toEqual([]);
  });
});

describe('violacoesDoDocumento — the cClassTrib a tipo binds (UB14-60/70/80)', () => {
  const item = (cClassTrib: string) => [{ nItem: 1, dfeReferenciado: null, cClassTrib }];

  it('1202 — a cClassTrib bound to a tipo of nota refuses any other nota', () => {
    expect(regras({ itens: item('800001') })).toEqual([
      REGRA_DOCUMENTO.cClassTribIncompativelComTipoNota,
    ]);
    expect(
      regras({ ...DEBITO, tpNFDebito: TP_NF_DEBITO.pagamentoAntecipado, itens: item('410030') }),
    ).toEqual([REGRA_DOCUMENTO.cClassTribIncompativelComTipoNota]);
    // Near-misses: an unbound code, and the RTC off (no IBS/CBS on the wire).
    expect(regras({ itens: item('000001') })).toEqual([]);
    expect(regras({ emitRtc: false, itens: item('800001') })).toEqual([]);
  });

  it('1200 — the tipo de débito binds its cClassTrib; "não limitar" binds none', () => {
    expect(
      regras({
        ...DEBITO,
        tpNFDebito: TP_NF_DEBITO.transferenciaCreditoSucessao,
        itens: item('000001'),
      }),
    ).toEqual([REGRA_DOCUMENTO.cClassTribIncompativelComDebito]);
    expect(
      regras({
        ...DEBITO,
        tpNFDebito: TP_NF_DEBITO.transferenciaCreditoSucessao,
        itens: item('800001'),
      }),
    ).toEqual([]);
    expect(
      regras({ ...DEBITO, tpNFDebito: TP_NF_DEBITO.multaJuros, itens: item('000001') }),
    ).not.toContain(REGRA_DOCUMENTO.cClassTribIncompativelComDebito);
  });

  it('1201 — the tipo de crédito binds its cClassTrib; 800001 is shared with débito 05', () => {
    const cred = { ...CREDITO, anoEmissao: 2030 };
    expect(
      regras({
        ...cred,
        tpNFCredito: TP_NF_CREDITO.transferenciaCreditoSucessao,
        itens: item('800001'),
      }),
    ).toEqual([REGRA_DOCUMENTO.notaAjusteTipoNaoSuportado]);
    expect(
      regras({ ...cred, tpNFCredito: TP_NF_CREDITO.creditoPresumidoZfm, itens: item('800001') }),
    ).toEqual([
      REGRA_DOCUMENTO.notaAjusteTipoNaoSuportado,
      REGRA_DOCUMENTO.cClassTribIncompativelComTipoNota,
      REGRA_DOCUMENTO.cClassTribIncompativelComCredito,
    ]);
  });
});

describe('violacoesDoDocumento — the NFref of a nota de crédito (B25-30…65, B25-100)', () => {
  const credito = (tp: '01' | '02' | '03' | '04', chNFeReferenciadas: string[]) =>
    regras({
      ...CREDITO,
      tpNFCredito: tp,
      anoEmissao: 2030,
      chNFeReferenciadas,
      itens: [ITEM_IBSCBS],
    });

  it('254 / 255 — crédito 01/03/04 references exactly one nota', () => {
    for (const tp of ['01', '03', '04'] as const) {
      expect(credito(tp, [])).toEqual([REGRA_DOCUMENTO.creditoSemNFref]);
      expect(credito(tp, [CHAVE_A, CHAVE_B])).toEqual([REGRA_DOCUMENTO.creditoMaisDeUmaNFref]);
      expect(credito(tp, [CHAVE_A])).toEqual([]);
    }
  });

  it('1027 — crédito 02 references nothing', () => {
    expect(credito('02', [CHAVE_A])).toContain(REGRA_DOCUMENTO.creditoNFrefIndevida);
    expect(credito('02', [])).not.toContain(REGRA_DOCUMENTO.creditoNFrefIndevida);
  });

  it('269 — crédito 03/04 references a nota of this emitente (not crédito 01)', () => {
    expect(credito('04', [CHAVE_CPF])).toEqual([REGRA_DOCUMENTO.creditoNFrefOutroEmitente]);
    expect(credito('03', [CHAVE_CPF])).toEqual([REGRA_DOCUMENTO.creditoNFrefOutroEmitente]);
    // Near-miss: multa e juros may reference the other party's nota.
    expect(credito('01', [CHAVE_CPF])).toEqual([]);
    // An unknown emitente says nothing.
    expect(
      regras({
        ...CREDITO,
        tpNFCredito: TP_NF_CREDITO.reducaoValores,
        emitenteDocumento: null,
        chNFeReferenciadas: [CHAVE_CPF],
        itens: [ITEM_IBSCBS],
      }),
    ).toEqual([]);
  });

  it('678 — crédito 03/04 references a nota of the emitente UF', () => {
    expect(credito('04', [CHAVE_OUTRA_UF])).toEqual([REGRA_DOCUMENTO.creditoNFrefOutraUF]);
    expect(credito('01', [CHAVE_OUTRA_UF])).toEqual([]);
  });

  it('1003 — modelo 55 only; crédito 03 also accepts an NFC-e', () => {
    expect(credito('04', [CHAVE_NFCE])).toEqual([REGRA_DOCUMENTO.creditoNFrefModeloInvalido]);
    expect(credito('03', [CHAVE_NFCE])).toEqual([]);
    expect(credito('03', [CHAVE_CTE])).toEqual([REGRA_DOCUMENTO.creditoNFrefModeloInvalido]);
  });

  it('a chave with a bad check digit is not decomposed into more violations', () => {
    const dvErrado = `${CHAVE_CPF.slice(0, 43)}${(Number(CHAVE_CPF[43]) + 1) % 10}`;
    expect(credito('04', [dvErrado])).toEqual([]);
  });
});

describe('violacoesDoDocumento — item references on a nota de crédito/débito (VC)', () => {
  it('1042 — a nota de crédito never references by item', () => {
    expect(
      regras({
        ...CREDITO,
        tpNFCredito: TP_NF_CREDITO.multaJuros,
        itens: [{ ...ITEM_IBSCBS, dfeReferenciado: ref(CHAVE_A, 1) }],
      }),
    ).toEqual([REGRA_DOCUMENTO.creditoSemNFref, REGRA_DOCUMENTO.refItemEmNotaDeCredito]);
  });

  it('1038 — débito 04 needs item references: none refuses, one missing warns', () => {
    const debito04 = { ...BASE, ...DEBITO, tpNFDebito: '04' as const };
    expect(violacoesDoDocumento({ ...debito04, itens: [ITEM_IBSCBS] }).map((v) => v.regra)).toEqual(
      [REGRA_DOCUMENTO.refItemAusente],
    );
    const parcial = violacoesDoDocumento({
      ...debito04,
      itens: [
        { ...ITEM_IBSCBS, dfeReferenciado: ref(CHAVE_A, 1) },
        { ...ITEM_IBSCBS, nItem: 2 },
      ],
    });
    expect(parcial).toEqual([
      expect.objectContaining({ regra: REGRA_DOCUMENTO.refItemAusenteNoItem, nItem: 2 }),
    ]);
    expect(bloqueiaEmissao(parcial)).toBe(false);
    // Near-miss: débito 06 needs none.
    expect(
      regras({ ...DEBITO, tpNFDebito: TP_NF_DEBITO.pagamentoAntecipado, itens: [ITEM_IBSCBS] }),
    ).toEqual([]);
  });

  it('crédito 06 (PL_010f) references the returned items: no 1042, and 1038 without them', () => {
    const credito06 = { ...CREDITO, tpNFCredito: TP_NF_CREDITO.retornoRecusaParcial };
    expect(
      regras({ ...credito06, itens: [{ ...ITEM_IBSCBS, dfeReferenciado: ref(CHAVE_A, 2) }] }),
    ).toEqual([]);
    expect(regras({ ...credito06, itens: [ITEM_IBSCBS] })).toEqual([
      REGRA_DOCUMENTO.refItemAusente,
    ]);
    // Near-miss: crédito 01 still may not reference by item.
    expect(
      regras({
        ...CREDITO,
        tpNFCredito: TP_NF_CREDITO.multaJuros,
        chNFeReferenciadas: [CHAVE_B],
        itens: [{ ...ITEM_IBSCBS, dfeReferenciado: ref(CHAVE_A, 2) }],
      }),
    ).toContain(REGRA_DOCUMENTO.refItemEmNotaDeCredito);
  });

  it('VC02-30 (v1.51): débito 07 may reference several notas; débito 04 may not', () => {
    const itens = [
      { ...ITEM_IBSCBS, dfeReferenciado: ref(CHAVE_A, 1) },
      { ...ITEM_IBSCBS, nItem: 2, dfeReferenciado: ref(CHAVE_B, 1) },
    ];
    expect(regras({ ...DEBITO, tpNFDebito: TP_NF_DEBITO.perdaEstoque, itens })).not.toContain(
      REGRA_DOCUMENTO.refItemMaisDeUmaChave,
    );
    expect(regras({ ...DEBITO, tpNFDebito: TP_NF_DEBITO.multaJuros, itens })).toContain(
      REGRA_DOCUMENTO.refItemMaisDeUmaChave,
    );
  });

  it('débito 03 references whole notas: 1039 on nItem, and no 1048 / 1130', () => {
    const debito03 = { ...DEBITO, tpNFDebito: '03' as const };
    expect(
      regras({
        ...debito03,
        itens: [
          { nItem: 1, dfeReferenciado: ref(CHAVE_A, null), cClassTrib: '811002' },
          { nItem: 2, dfeReferenciado: ref(CHAVE_B, null), cClassTrib: '811002' },
        ],
      }),
    ).toEqual([]);
    expect(
      regras({
        ...debito03,
        itens: [{ nItem: 1, dfeReferenciado: ref(CHAVE_A, 1), cClassTrib: '811002' }],
      }),
    ).toEqual([REGRA_DOCUMENTO.refItemNItemIndevido]);
  });
});

describe('violacoesDoDocumento — the adjustment amounts (gTransfCred / gAjusteCompet / gEstornoCred)', () => {
  const ajuste = (vIBS: number, vCBS: number, competApur: string | null = null) => ({
    vIBS,
    vCBS,
    competApur,
  });
  const item = (ajusteRtc: ReturnType<typeof ajuste> | null | undefined, nItem = 1) => ({
    nItem,
    dfeReferenciado: null,
    ...(ajusteRtc === undefined ? {} : { ajusteRtc }),
  });
  const debito = (tp: TpNFDebito) => ({ ...DEBITO, tpNFDebito: tp });

  it('refuses an adjustment item without its amounts; an unknown one says nothing', () => {
    const v = violacoesDoDocumento({
      ...BASE,
      ...debito(TP_NF_DEBITO.transferenciaCreditoCooperativa),
      itens: [item(ajuste(1, 9)), item(null, 2), item(undefined, 3)],
    });
    expect(v).toEqual([
      expect.objectContaining({ regra: REGRA_DOCUMENTO.ajusteAusente, nItem: 2 }),
    ]);
  });

  it('an adjustment tipo does not ask for the item’s own IBS/CBS config — the tipo supplies it', () => {
    expect(
      regras({
        ...debito(TP_NF_DEBITO.transferenciaCreditoSucessao),
        itens: [{ ...item(ajuste(0, 5)), cClassTrib: null }],
      }),
    ).toEqual([]);
  });

  it('1129 — gTransfCred needs IBS or CBS above zero (débito 01 and 05)', () => {
    for (const tp of [
      TP_NF_DEBITO.transferenciaCreditoCooperativa,
      TP_NF_DEBITO.transferenciaCreditoSucessao,
    ]) {
      expect(regras({ ...debito(tp), itens: [item(ajuste(0, 0))] })).toEqual([
        REGRA_DOCUMENTO.ajusteTransfCredZerado,
      ]);
      // Near-miss: one of the two is enough.
      expect(regras({ ...debito(tp), itens: [item(ajuste(0, 0.01))] })).toEqual([]);
    }
  });

  it('1171 + competApur — gAjusteCompet (débito 02, 03 and 08)', () => {
    for (const tp of [
      TP_NF_DEBITO.anulacaoCreditoSaidaImuneIsenta,
      TP_NF_DEBITO.debitoNotaNaoProcessada,
      TP_NF_DEBITO.desenquadramentoSimples,
    ]) {
      const base = {
        ...debito(tp),
        // débito 03 references whole notas (1038) — give it one.
        itens: [],
      };
      const com = (a: ReturnType<typeof ajuste>) =>
        regras({
          ...base,
          itens: [{ ...item(a), dfeReferenciado: ref(CHAVE_A, null) }],
        }).filter((r) => r !== REGRA_DOCUMENTO.refItemSemNItem);
      expect(com(ajuste(1, 9, '2026-09'))).toEqual([]);
      expect(com(ajuste(0, 0, '2026-09'))).toEqual([REGRA_DOCUMENTO.ajusteCompetZerado]);
      expect(com(ajuste(1, 9, null))).toEqual([REGRA_DOCUMENTO.ajusteCompetenciaInvalida]);
      expect(com(ajuste(1, 9, '2026-13'))).toEqual([REGRA_DOCUMENTO.ajusteCompetenciaInvalida]);
      expect(com(ajuste(1, 9, '2026-9'))).toEqual([REGRA_DOCUMENTO.ajusteCompetenciaInvalida]);
    }
  });

  it('competApur is the emission month or an earlier one (BASE emits in 2026-09)', () => {
    const com = (competApur: string, e: Partial<EntradaRegrasDocumento> = {}) =>
      regras({
        ...debito(TP_NF_DEBITO.anulacaoCreditoSaidaImuneIsenta),
        ...e,
        itens: [item(ajuste(1, 9, competApur))],
      });
    expect(com('2026-09')).toEqual([]);
    expect(com('2025-12')).toEqual([]);
    expect(com('2026-10')).toEqual([REGRA_DOCUMENTO.ajusteCompetenciaFutura]);
    expect(com('2027-01')).toEqual([REGRA_DOCUMENTO.ajusteCompetenciaFutura]);
    // Unknown emission month (the editor): not judged.
    expect(com('2027-01', { mesEmissao: null })).toEqual([]);
  });

  it('gEstornoCred (débito 07) accepts zero amounts — UB116-30 exempts that tipo', () => {
    expect(regras({ ...debito(TP_NF_DEBITO.perdaEstoque), itens: [item(ajuste(0, 0))] })).toEqual(
      [],
    );
  });

  it('refuses a negative or non-finite amount before any group rule', () => {
    for (const bad of [ajuste(-1, 5), ajuste(Number.NaN, 5), ajuste(1, Number.POSITIVE_INFINITY)]) {
      expect(regras({ ...debito(TP_NF_DEBITO.perdaEstoque), itens: [item(bad)] })).toEqual([
        REGRA_DOCUMENTO.ajusteValorInvalido,
      ]);
    }
  });

  it('amounts on a nota whose tipo has no group are a WARNING, never a block', () => {
    for (const e of [{}, debito(TP_NF_DEBITO.pagamentoAntecipado)]) {
      const v = violacoesDoDocumento({
        ...BASE,
        ...e,
        itens: [{ ...ITEM_IBSCBS, ajusteRtc: ajuste(1, 9) }],
      });
      expect(v.map((x) => x.regra)).toEqual([REGRA_DOCUMENTO.ajusteIndevido]);
      expect(bloqueiaEmissao(v)).toBe(false);
    }
  });
});

describe('violacoesDoDocumento — pagamento antecipado and ISUFEmit (#331)', () => {
  it('a valid NF-e 55 reference with the RTC on is clean; off, it is refused (policy)', () => {
    expect(regras({ chNFePagamentoAntecipado: [CHAVE_A] })).toEqual([]);
    expect(regras({ emitRtc: false, chNFePagamentoAntecipado: [CHAVE_A] })).toEqual([
      REGRA_DOCUMENTO.pagAntecipadoSemReformaTributaria,
    ]);
  });

  it('BC02 — only an NF-e modelo 55 with a valid check digit; an NFC-e is refused', () => {
    expect(regras({ chNFePagamentoAntecipado: [CHAVE_NFCE] })).toEqual([
      REGRA_DOCUMENTO.pagAntecipadoChaveInvalida,
    ]);
    const dvErrado = `${CHAVE_A.slice(0, 43)}${(Number(CHAVE_A[43]) + 1) % 10}`;
    expect(regras({ chNFePagamentoAntecipado: [dvErrado] })).toEqual([
      REGRA_DOCUMENTO.pagAntecipadoChaveInvalida,
    ]);
  });

  it('BC01 — at most 99 references', () => {
    expect(regras({ chNFePagamentoAntecipado: Array(99).fill(CHAVE_A) })).toEqual([]);
    expect(regras({ chNFePagamentoAntecipado: Array(100).fill(CHAVE_A) })).toEqual([
      REGRA_DOCUMENTO.pagAntecipadoExcesso,
    ]);
  });

  it('1185 — ISUFEmit only from a ZFM/ALC municipality, and only with the RTC on', () => {
    expect(regras({ emitenteISUF: '200123456' })).toEqual([
      REGRA_DOCUMENTO.isufEmitForaDaAreaIncentivada,
    ]);
    expect(regras({ emitenteISUF: '200123456', emitenteCMun: '1302603' })).toEqual([]);
    // Near-misses: no inscription, the RTC off (not on the wire), an unknown municipality.
    expect(regras({ emitenteISUF: null })).toEqual([]);
    expect(regras({ emitenteISUF: '200123456', emitRtc: false })).toEqual([]);
    expect(regras({ emitenteISUF: '200123456', emitenteCMun: null })).toEqual([]);
  });
});
