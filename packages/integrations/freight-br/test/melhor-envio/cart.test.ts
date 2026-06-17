import { describe, expect, it } from 'vitest';

import { type BuildCartItemParams, buildCartItem } from '../../src/melhor-envio/cart';

const STORE = {
  name: 'Loja Delfrance LTDA',
  phone: '11999990000',
  email: 'loja@delfrance.com.br',
  companyDocument: '04517623000197',
  stateRegister: '563025255115',
  economicActivityCode: '4781400',
  address: 'Rua da Loja',
  number: '100',
  district: 'Centro',
  city: 'São Paulo',
  stateAbbr: 'SP',
  postalCode: '01001000',
} as const;

const RECIPIENT_PJ = {
  name: 'Cliente Empresa LTDA',
  phone: '21999990000',
  email: 'cliente@example.com',
  companyDocument: '89794131000100',
  stateRegister: '123456',
  address: 'Avenida do Cliente',
  number: '200',
  district: 'Bairro',
  city: 'Nova Iguaçu',
  stateAbbr: 'RJ',
  postalCode: '26210000',
} as const;

function params(over: Partial<BuildCartItemParams> = {}): BuildCartItemParams {
  return {
    service: 3,
    from: STORE,
    to: RECIPIENT_PJ,
    products: [{ name: 'Camiseta', quantity: 2, unitaryValue: 49.9 }],
    volumes: [{ width: 11, height: 2, length: 16, weight: 0.3 }],
    ...over,
  };
}

describe('buildCartItem', () => {
  it('maps a forward shipment: store → recipient with products, volumes and options', () => {
    const payload = buildCartItem(params()) as Record<string, any>;

    expect(payload.service).toBe(3);
    expect(payload.from.company_document).toBe(STORE.companyDocument);
    expect(payload.from.economic_activity_code).toBe('4781400');
    expect(payload.to.company_document).toBe(RECIPIENT_PJ.companyDocument);
    expect(payload.to.state_abbr).toBe('RJ');

    expect(payload.products).toEqual([{ name: 'Camiseta', quantity: '2', unitary_value: '49.90' }]);
    expect(payload.volumes).toEqual([{ width: 11, height: 2, length: 16, weight: 0.3 }]);

    expect(payload.options.reverse).toBe(false);
    expect(payload.options.non_commercial).toBe(true); // no NF-e key
    expect(payload.options.insurance_value).toBe(1); // floored
    expect(payload.options.platform).toBe('Delfrance ERP');
    expect(payload.options.invoice).toBeUndefined();
  });

  it('swaps from/to for a reverse shipment', () => {
    const payload = buildCartItem(params({ reverse: true })) as Record<string, any>;
    // Reverse ships back FROM the recipient TO the store.
    expect(payload.from.company_document).toBe(RECIPIENT_PJ.companyDocument);
    expect(payload.to.company_document).toBe(STORE.companyDocument);
    expect(payload.options.reverse).toBe(true);
  });

  it('uses document (not company_document) for a Pessoa Física recipient', () => {
    const payload = buildCartItem(
      params({
        to: {
          name: 'Maria PF',
          document: '73646548010',
          address: 'Rua PF',
          number: '1',
          district: 'B',
          city: 'C',
          stateAbbr: 'SP',
          postalCode: '01001000',
        },
      }),
    ) as Record<string, any>;

    expect(payload.to.document).toBe('73646548010');
    expect(payload.to.company_document).toBeUndefined();
    expect(payload.to.state_register).toBeUndefined();
  });

  it('keeps a real insurance value above the floor and attaches the NF-e invoice', () => {
    const payload = buildCartItem(
      params({ options: { insuranceValue: 150, invoiceKey: '3526'.padEnd(44, '0') } }),
    ) as Record<string, any>;

    expect(payload.options.insurance_value).toBe(150);
    expect(payload.options.non_commercial).toBe(false);
    expect(payload.options.invoice).toEqual({ key: '3526'.padEnd(44, '0') });
  });

  it('caps the address line at 39 chars and the product name at 50', () => {
    const longAddress = 'A'.repeat(60);
    const longName = 'P'.repeat(70);
    const payload = buildCartItem(
      params({
        from: { ...STORE, address: longAddress },
        products: [{ name: longName, quantity: 1, unitaryValue: 1 }],
      }),
    ) as Record<string, any>;

    expect(payload.from.address).toHaveLength(39);
    expect(payload.products[0].name).toHaveLength(50);
  });

  it('falls back to a single default volume and tags the pedido', () => {
    const payload = buildCartItem(
      params({ volumes: [], options: { pedidoNumero: 4242 } }),
    ) as Record<string, any>;

    expect(payload.volumes).toEqual([{ width: 20, height: 20, length: 20, weight: 1 }]);
    expect(payload.options.tags).toEqual([{ tag: 'Pedido 4242' }]);
  });

  it('omits empty optional identity fields (phone/email/complement)', () => {
    const payload = buildCartItem(
      params({
        to: {
          name: 'Sem Contato',
          document: '73646548010',
          address: 'Rua X',
          number: '1',
          district: 'B',
          city: 'C',
          stateAbbr: 'SP',
          postalCode: '01001000',
        },
      }),
    ) as Record<string, any>;

    expect(payload.to).not.toHaveProperty('phone');
    expect(payload.to).not.toHaveProperty('email');
    expect(payload.to).not.toHaveProperty('complement');
    // Required fields stay present.
    expect(payload.to.note).toBe('');
    expect(payload.to.country_id).toBe('BR');
  });
});
