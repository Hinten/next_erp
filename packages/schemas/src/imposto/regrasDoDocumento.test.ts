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
  violacoesDoDocumento,
  type EntradaRegrasDocumento,
  type RegraDocumento,
} from './regrasDoDocumento';

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
  chNFeReferenciadas: [],
  destinatarioDocumento: '12345678909',
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
