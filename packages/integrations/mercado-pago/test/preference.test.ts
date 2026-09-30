import { describe, expect, it } from 'vitest';
import { parseIsoToMillis } from '@delfrance/core/datetime';
import { TIPO_PAGAMENTO_MP } from '@delfrance/schemas';
import { type PreferenceInput, buildPreferenceRequest } from '../src/mapping/preference';
import { mpPreferenceRequestSchema } from '../src/requests';

const LINK_ID = 'aB3dE5gH7jK9mN1pQ3rS';
const PEDIDO_ID = 'Xk29fLq0PzA81mNbVc7T';
const FUSO = 'America/Sao_Paulo';
/** 2026-09-29T23:59:59-03:00 — the last second of the 29th in São Paulo. */
const EXPIRA_MS = Date.UTC(2026, 8, 30, 2, 59, 59, 0);

const BASE: PreferenceInput = {
  pedidoId: PEDIDO_ID,
  numeroPedido: '123',
  linkId: LINK_ID,
  valor: 33.33,
  nomePagador: 'Maria',
  expiraEmMs: EXPIRA_MS,
  fuso: FUSO,
  tiposExcluidos: [],
  parcelasMaximas: null,
  pagador: null,
};

const PAGADOR: NonNullable<PreferenceInput['pagador']> = {
  nome: 'Maria da Silva',
  email: 'maria@example.com',
  cpfCnpj: '12345678901',
  telefone: '5511999998888',
  estrangeiro: false,
};

function build(over: Partial<PreferenceInput> = {}) {
  return buildPreferenceRequest({ ...BASE, ...over });
}

/** The payer of a body built for `over` applied on top of the default customer. */
function payerFor(over: Partial<NonNullable<PreferenceInput['pagador']>>) {
  return build({ pagador: { ...PAGADOR, ...over } }).payer;
}

/** Fields the design deliberately never sends — see `requests.ts`. */
const NEVER_SENT = [
  'notification_url',
  'back_urls',
  'auto_return',
  'binary_mode',
  'purpose',
  'statement_descriptor',
  'sandbox_init_point',
];

describe('buildPreferenceRequest — the shape of the body', () => {
  it('has exactly the six base keys and nothing else', () => {
    expect(Object.keys(build()).sort()).toEqual([
      'date_of_expiration',
      'expiration_date_to',
      'expires',
      'external_reference',
      'items',
      'metadata',
    ]);
  });

  it.each(NEVER_SENT)('never carries %s', (field) => {
    const full = build({
      pagador: PAGADOR,
      tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto],
      parcelasMaximas: 6,
    });
    expect(full).not.toHaveProperty(field);
  });

  it('adds payment_methods and payer only when they are asked for', () => {
    expect(Object.keys(build({ parcelasMaximas: 3 })).sort()).toContain('payment_methods');
    expect(Object.keys(build({ pagador: PAGADOR })).sort()).toContain('payer');
    expect(build({ parcelasMaximas: 3 })).not.toHaveProperty('payer');
    expect(build({ pagador: PAGADOR })).not.toHaveProperty('payment_methods');
  });

  it('sends the pedido id VERBATIM as external_reference (the webhook keys on it)', () => {
    expect(build().external_reference).toBe(PEDIDO_ID);
    // Verbatim means no normalisation, not even a harmless one.
    expect(build({ pedidoId: 'Pedido_Com-Case' }).external_reference).toBe('Pedido_Com-Case');
  });

  it('the item id, metadata.link_id and the link id are one value', () => {
    const body = build();
    expect(body.items[0].id).toBe(LINK_ID);
    expect(body.metadata.link_id).toBe(LINK_ID);
    expect(Object.keys(body.metadata)).toEqual(['link_id']);
  });

  it('is one item of quantity 1 in BRL', () => {
    const body = build();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].quantity).toBe(1);
    expect(body.items[0].currency_id).toBe('BRL');
    expect(body.expires).toBe(true);
  });

  it('a fully loaded input still satisfies the strict request schema', () => {
    const body = build({
      pagador: PAGADOR,
      tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto, TIPO_PAGAMENTO_MP.cartaoDebito],
      parcelasMaximas: 12,
    });
    expect(mpPreferenceRequestSchema.safeParse(body).success).toBe(true);
  });

  it('is NOT a strict gate: a violating input comes back as a plain object, never a ZodError', () => {
    // `api.ts`'s assertRequest is the single strict gate — a raw ZodError thrown
    // from here would reach the route as a bare 500 with no code.
    const body = build({ pedidoId: 'has a space@' });
    expect(body.external_reference).toBe('has a space@');
    expect(mpPreferenceRequestSchema.safeParse(body).success).toBe(false);
  });

  it('does not mutate its input', () => {
    const input: PreferenceInput = {
      ...BASE,
      tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto, TIPO_PAGAMENTO_MP.boleto],
      pagador: { ...PAGADOR },
    };
    const before = structuredClone(input);
    buildPreferenceRequest(input);
    expect(input).toEqual(before);
  });
});

describe('buildPreferenceRequest — the item', () => {
  it.each([
    ['numero and nome', { numeroPedido: '123', nomePagador: 'Maria' }, 'Pedido #123 — Maria'],
    ['a null numero', { numeroPedido: null, nomePagador: 'Maria' }, 'Pedido — Maria'],
    ['a null nome', { numeroPedido: '123', nomePagador: null }, 'Pedido #123'],
    ['neither', { numeroPedido: null, nomePagador: null }, 'Pedido'],
    ['blank strings', { numeroPedido: '  ', nomePagador: ' ' }, 'Pedido'],
    ['a padded numero', { numeroPedido: ' VEN-42 ', nomePagador: 'Ana' }, 'Pedido #VEN-42 — Ana'],
  ])('titles a link with %s', (_label, over, title) => {
    expect(build(over).items[0].title).toBe(title);
  });

  it('never prints the legacy "#null"', () => {
    expect(build({ numeroPedido: null }).items[0].title).not.toContain('null');
  });

  it('caps the title at 256 characters so the strict schema still accepts it', () => {
    const body = build({ numeroPedido: 'x'.repeat(400) });
    expect(body.items[0].title).toHaveLength(256);
    expect(mpPreferenceRequestSchema.safeParse(body).success).toBe(true);
  });

  it('rounds unit_price with roundReais (a float residue never reaches the wire)', () => {
    expect(build({ valor: 33.333 }).items[0].unit_price).toBe(33.33);
    const residue = build({ valor: 0.1 + 0.2 });
    expect(residue.items[0].unit_price).toBe(0.3);
    expect(mpPreferenceRequestSchema.safeParse(residue).success).toBe(true);
  });

  it('keeps an already-exact amount as it is', () => {
    expect(build({ valor: 1234.5 }).items[0].unit_price).toBe(1234.5);
  });
});

describe('buildPreferenceRequest — the deadline', () => {
  it('writes both dates with an explicit -03:00 offset, never Z', () => {
    const body = build();
    expect(body.expiration_date_to).toBe('2026-09-29T23:59:59.000-03:00');
    expect(body.date_of_expiration).toBe(body.expiration_date_to);
    expect(body.expiration_date_to.endsWith('Z')).toBe(false);
  });

  it('names the instant it was given', () => {
    expect(parseIsoToMillis(build().expiration_date_to)).toBe(EXPIRA_MS);
  });

  it('takes the offset from the instant: a Brazilian-DST day is -02:00', () => {
    // Near-miss for a hard-coded "-03:00".
    const dst = build({ expiraEmMs: Date.UTC(2018, 11, 1, 14, 0, 0, 0) });
    expect(dst.expiration_date_to).toBe('2018-12-01T12:00:00.000-02:00');
  });

  it('honours the zone it is given rather than the process zone', () => {
    const utc = build({ fuso: 'UTC' });
    expect(utc.expiration_date_to).toBe('2026-09-30T02:59:59.000+00:00');
    expect(parseIsoToMillis(utc.expiration_date_to)).toBe(EXPIRA_MS);
  });
});

describe('buildPreferenceRequest — payment_methods', () => {
  it('excluded types alone: no installments key', () => {
    const body = build({ tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto] });
    expect(body.payment_methods).toEqual({ excluded_payment_types: [{ id: 'ticket' }] });
  });

  it('installments alone: no excluded_payment_types key (not an empty array)', () => {
    const body = build({ parcelasMaximas: 6 });
    expect(body.payment_methods).toEqual({ installments: 6 });
    expect(body.payment_methods).not.toHaveProperty('excluded_payment_types');
  });

  it('both', () => {
    const body = build({
      tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto, TIPO_PAGAMENTO_MP.pix],
      parcelasMaximas: 1,
    });
    expect(body.payment_methods).toEqual({
      excluded_payment_types: [{ id: 'ticket' }, { id: 'bank_transfer' }],
      installments: 1,
    });
  });

  it('collapses a repeated type instead of letting it eat the cap', () => {
    const body = build({
      tiposExcluidos: [
        TIPO_PAGAMENTO_MP.boleto,
        TIPO_PAGAMENTO_MP.boleto,
        TIPO_PAGAMENTO_MP.boleto,
      ],
    });
    expect(body.payment_methods?.excluded_payment_types).toEqual([{ id: 'ticket' }]);
  });
});

describe('buildPreferenceRequest — the payer prefill', () => {
  it('is absent when pagador is null (kills an always-on prefill)', () => {
    expect(build({ pagador: null })).not.toHaveProperty('payer');
  });

  it('is present for a customer link', () => {
    expect(build({ pagador: PAGADOR }).payer).toEqual({
      name: 'Maria',
      surname: 'da Silva',
      email: 'maria@example.com',
      identification: { type: 'CPF', number: '12345678901' },
      phone: { area_code: '11', number: '999998888' },
    });
  });

  describe('name', () => {
    it('splits the first token from the rest', () => {
      const payer = payerFor({ nome: 'Maria da Silva' });
      expect(payer?.name).toBe('Maria');
      expect(payer?.surname).toBe('da Silva');
    });

    it('a single token has no surname key at all', () => {
      const payer = payerFor({ nome: 'Maria' });
      expect(payer?.name).toBe('Maria');
      expect(payer).not.toHaveProperty('surname');
    });

    it('collapses extra whitespace', () => {
      const payer = payerFor({ nome: '  Maria   da  Silva ' });
      expect(payer?.name).toBe('Maria');
      expect(payer?.surname).toBe('da Silva');
    });

    it('a null or blank name drops the name and keeps the rest', () => {
      for (const nome of [null, '', '   ']) {
        const payer = payerFor({ nome });
        expect(payer).not.toHaveProperty('name');
        expect(payer).not.toHaveProperty('surname');
        expect(payer?.email).toBe('maria@example.com');
      }
    });
  });

  describe('email', () => {
    it('an invalid e-mail drops ONLY the e-mail', () => {
      const payer = payerFor({ email: 'maria@' });
      expect(payer).not.toHaveProperty('email');
      expect(payer?.name).toBe('Maria');
      expect(payer?.identification).toEqual({ type: 'CPF', number: '12345678901' });
      expect(payer?.phone).toEqual({ area_code: '11', number: '999998888' });
    });

    it('trims a padded e-mail', () => {
      expect(payerFor({ email: '  maria@example.com ' })?.email).toBe('maria@example.com');
    });
  });

  describe('identification', () => {
    it.each([
      ['11 digits → CPF', '12345678901', { type: 'CPF', number: '12345678901' }],
      ['a formatted CPF → CPF', '123.456.789-01', { type: 'CPF', number: '12345678901' }],
      ['14 digits → CNPJ', '12345678000195', { type: 'CNPJ', number: '12345678000195' }],
      ['a formatted CNPJ', '12.345.678/0001-95', { type: 'CNPJ', number: '12345678000195' }],
      ['an alphanumeric CNPJ', '12.abc.345/01de-35', { type: 'CNPJ', number: '12ABC34501DE35' }],
    ])('%s', (_label, cpfCnpj, expected) => {
      expect(payerFor({ cpfCnpj })?.identification).toEqual(expected);
    });

    it.each([
      ['12 digits (neither)', '123456789012'],
      ['10 digits', '1234567890'],
      ['an 11-character alphanumeric', '1234567890A'],
      ['empty', ''],
      ['null', null],
    ])('is omitted for %s', (_label, cpfCnpj) => {
      const payer = payerFor({ cpfCnpj });
      expect(payer).not.toHaveProperty('identification');
      expect(payer?.name).toBe('Maria');
    });

    it('is omitted for a foreign customer even when a document is stored', () => {
      const payer = payerFor({ estrangeiro: true, cpfCnpj: '12345678901' });
      expect(payer).not.toHaveProperty('identification');
      expect(payer?.name).toBe('Maria');
    });
  });

  describe('phone', () => {
    it.each([
      ['the normalized 55… shape', '5511999998888', { area_code: '11', number: '999998888' }],
      ['the raw legacy 11-digit shape', '11999998888', { area_code: '11', number: '999998888' }],
      ['a formatted number', '+55 (11) 99999-8888', { area_code: '11', number: '999998888' }],
      ['a 10-digit landline', '1133334444', { area_code: '11', number: '33334444' }],
      ['a normalized landline', '551133334444', { area_code: '11', number: '33334444' }],
    ])('%s → DDD + number', (_label, telefone, expected) => {
      expect(payerFor({ telefone })?.phone).toEqual(expected);
    });

    it('⚠️ never sends the country code as the area_code (the legacy bug)', () => {
      const phone = payerFor({ telefone: '5511999998888' })?.phone;
      expect(phone?.area_code).not.toBe('55');
      expect(phone?.number).toHaveLength(9);
    });

    it.each([
      ['too short', '99998888'],
      ['9 digits', '999998888'],
      ['a DDD starting with 0', '0119999988'],
      ['empty', ''],
      ['null', null],
    ])('is omitted for %s', (_label, telefone) => {
      const payer = payerFor({ telefone });
      expect(payer).not.toHaveProperty('phone');
      expect(payer?.name).toBe('Maria');
    });

    it('is omitted for a foreign customer', () => {
      expect(payerFor({ estrangeiro: true })).not.toHaveProperty('phone');
    });

    it('near-miss: the same digits for a NON-foreign customer are read as a Brazilian number', () => {
      // 11 digits cannot tell a legacy raw BR number from an E.164 NANP one, which is
      // why the foreign flag — not the digits — decides.
      const payer = payerFor({ telefone: '14155550123', estrangeiro: false });
      expect(payer?.phone).toEqual({ area_code: '14', number: '155550123' });
      expect(payerFor({ telefone: '14155550123', estrangeiro: true })).not.toHaveProperty('phone');
    });
  });

  describe('nothing usable', () => {
    it('sends no payer at all when every part is empty', () => {
      const nada = { nome: null, email: null, cpfCnpj: null, telefone: null, estrangeiro: false };
      expect(build({ pagador: nada })).not.toHaveProperty('payer');
    });

    it('sends no payer at all when every part is invalid', () => {
      const lixo = {
        nome: ' ',
        email: 'nope',
        cpfCnpj: '123',
        telefone: '1',
        estrangeiro: false,
      };
      expect(build({ pagador: lixo })).not.toHaveProperty('payer');
    });

    it('a foreign customer keeps only name and e-mail', () => {
      const payer = payerFor({ estrangeiro: true });
      expect(Object.keys(payer ?? {}).sort()).toEqual(['email', 'name', 'surname']);
    });
  });
});
