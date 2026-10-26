import { describe, expect, it } from 'vitest';
import { BANDEIRA } from './bandeiraCartao';
import {
  FORMAS_COM_CARTAO_MARKETPLACE,
  cartaoMarketplace,
  cnpjInstituicaoUtilizavel,
} from './cartaoMarketplace';
import { FORMA_PAGAMENTO, cartaoSchema } from './pedido/collection/pagamento';

const CNPJ_VALIDO = '11222333000181';
const CNPJ_PONTUADO = '11.222.333/0001-81';
const CNPJ_ALFANUMERICO = '12ABC34501DE35';

const SEM_ENTRADAS = { marcaBruta: undefined, cnpjBruto: undefined, cAut: null } as const;

/** The skeleton every card-bearing forma gets, whatever arrived. */
const ESQUELETO = {
  tpIntegra: '2',
  bandeira: null,
  numeroCartao: null,
  cAut: null,
  cnpj_instituicao: null,
  tarifa: null,
  tarifaFixa: null,
  prazoRecebimento: null,
};

describe('FORMAS_COM_CARTAO_MARKETPLACE', () => {
  it('is exactly credit card, debit card and Pix (3, 4, 17)', () => {
    expect([...FORMAS_COM_CARTAO_MARKETPLACE].sort((a, b) => a - b)).toEqual([3, 4, 17]);
  });
});

describe('cnpjInstituicaoUtilizavel', () => {
  it('★ a punctuated valid CNPJ ⇒ its 14 characters (EQUAL to the bare one)', () => {
    expect(cnpjInstituicaoUtilizavel(CNPJ_PONTUADO)).toBe(CNPJ_VALIDO);
    expect(cnpjInstituicaoUtilizavel(CNPJ_VALIDO)).toBe(CNPJ_VALIDO);
  });

  it('★ an alphanumeric CNPJ is kept', () => {
    expect(cnpjInstituicaoUtilizavel(CNPJ_ALFANUMERICO)).toBe(CNPJ_ALFANUMERICO);
    expect(cnpjInstituicaoUtilizavel('12.ABC.345/01DE-35')).toBe(CNPJ_ALFANUMERICO);
  });

  it.each([
    ['a valid CPF (11 characters — a person, not an institution)', '529.982.247-25'],
    ['an 8-digit root', '11222333'],
    ['one wrong check digit', '11.222.333/0001-82'],
    ['a masked value', '11.222.***/0001-81'],
    ['a placeholder', 'N/A'],
    ['a dash', '-'],
  ])('★ NEAR-MISS: %s ⇒ null', (_rotulo, raw) => {
    expect(cnpjInstituicaoUtilizavel(raw)).toBeNull();
  });

  it.each([[''], ['   '], [null], [undefined], [11222333000181]])('absent (%j) ⇒ null', (raw) => {
    expect(cnpjInstituicaoUtilizavel(raw)).toBeNull();
  });
});

describe('cartaoMarketplace', () => {
  it.each([
    [FORMA_PAGAMENTO.cartao_credito],
    [FORMA_PAGAMENTO.cartao_debito],
    [FORMA_PAGAMENTO.pix],
  ])('★ forma %i carries the `tpIntegra 2` block even with every input absent', (forma) => {
    const r = cartaoMarketplace({ forma, ...SEM_ENTRADAS });
    expect(r).toEqual({ cartao: ESQUELETO, bandeiraDesconhecida: false, cnpjRecusado: false });
  });

  it.each([
    [FORMA_PAGAMENTO.boleto_bancario],
    [FORMA_PAGAMENTO.outros],
    [FORMA_PAGAMENTO.dinheiro],
    [FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria],
  ])('★ forma %i carries NO block, whatever arrived', (forma) => {
    const r = cartaoMarketplace({
      forma,
      marcaBruta: 'Visa',
      cnpjBruto: '529.982.247-25',
      cAut: 'AUT-1',
    });
    expect(r).toEqual({ cartao: undefined, bandeiraDesconhecida: false, cnpjRecusado: false });
  });

  it('a card block: the brand through the fold, the CNPJ normalised, cAut verbatim', () => {
    const r = cartaoMarketplace({
      forma: FORMA_PAGAMENTO.cartao_credito,
      marcaBruta: ' MasterCard ',
      cnpjBruto: CNPJ_PONTUADO,
      cAut: 'AUT-1',
    });
    expect(r).toEqual({
      cartao: {
        ...ESQUELETO,
        bandeira: BANDEIRA.mastercard,
        cAut: 'AUT-1',
        cnpj_instituicao: CNPJ_VALIDO,
      },
      bandeiraDesconhecida: false,
      cnpjRecusado: false,
    });
    // The block is what the pagamento stores: it parses unchanged.
    expect(cartaoSchema.parse(r.cartao)).toEqual(r.cartao);
  });

  it('★ Pix with a brand ⇒ `bandeira: null`, never the brand (and never an unknown flag)', () => {
    for (const marcaBruta of ['Visa', 'uma-marca-qualquer']) {
      const r = cartaoMarketplace({
        forma: FORMA_PAGAMENTO.pix,
        marcaBruta,
        cnpjBruto: CNPJ_VALIDO,
        cAut: null,
      });
      expect(r.cartao?.bandeira, marcaBruta).toBeNull();
      expect(r.bandeiraDesconhecida, marcaBruta).toBe(false);
      expect(r.cartao?.cnpj_instituicao).toBe(CNPJ_VALIDO);
    }
  });

  it('an unknown brand on a card forma ⇒ 99 + bandeiraDesconhecida; an explicit `outros` ⇒ 99 without it', () => {
    const desconhecida = cartaoMarketplace({
      forma: FORMA_PAGAMENTO.cartao_debito,
      marcaBruta: 'Visa Electron',
      cnpjBruto: undefined,
      cAut: null,
    });
    expect(desconhecida.cartao?.bandeira).toBe(BANDEIRA.outros);
    expect(desconhecida.bandeiraDesconhecida).toBe(true);
    const explicita = cartaoMarketplace({
      forma: FORMA_PAGAMENTO.cartao_debito,
      marcaBruta: 'outros',
      cnpjBruto: undefined,
      cAut: null,
    });
    expect(explicita.cartao?.bandeira).toBe(BANDEIRA.outros);
    expect(explicita.bandeiraDesconhecida).toBe(false);
  });

  it.each([
    ['an 8-digit root', '11222333'],
    ['a CPF', '529.982.247-25'],
    ['one wrong check digit', '11.222.333/0001-82'],
    ['a masked value', '11.222.***/0001-81'],
  ])('★ %s that ARRIVED ⇒ `cnpj_instituicao: null` + cnpjRecusado', (_rotulo, cnpjBruto) => {
    const r = cartaoMarketplace({
      forma: FORMA_PAGAMENTO.cartao_credito,
      marcaBruta: 'Visa',
      cnpjBruto,
      cAut: null,
    });
    expect(r.cartao?.cnpj_instituicao).toBeNull();
    expect(r.cnpjRecusado).toBe(true);
  });

  it.each([[undefined], [null], [''], ['   ']])(
    '★ NEAR-MISS: an ABSENT institution document (%j) ⇒ null WITHOUT cnpjRecusado (refused ≠ absent)',
    (cnpjBruto) => {
      const r = cartaoMarketplace({
        forma: FORMA_PAGAMENTO.cartao_credito,
        marcaBruta: 'Visa',
        cnpjBruto,
        cAut: null,
      });
      expect(r.cartao?.cnpj_instituicao).toBeNull();
      expect(r.cnpjRecusado).toBe(false);
    },
  );

  it('★ an alphanumeric CNPJ is kept, unflagged', () => {
    const r = cartaoMarketplace({
      forma: FORMA_PAGAMENTO.pix,
      marcaBruta: undefined,
      cnpjBruto: CNPJ_ALFANUMERICO,
      cAut: 'E2E-1',
    });
    expect(r.cartao?.cnpj_instituicao).toBe(CNPJ_ALFANUMERICO);
    expect(r.cartao?.cAut).toBe('E2E-1');
    expect(r.cnpjRecusado).toBe(false);
  });

  it('answers the same skeleton keys for every card-bearing forma (no partial block)', () => {
    const chaves = Object.keys(ESQUELETO).sort();
    for (const forma of FORMAS_COM_CARTAO_MARKETPLACE) {
      const r = cartaoMarketplace({ forma, ...SEM_ENTRADAS });
      expect(Object.keys(r.cartao ?? {}).sort(), String(forma)).toEqual(chaves);
    }
  });
});
