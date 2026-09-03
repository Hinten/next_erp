import { describe, expect, it } from 'vitest';

import {
  REDACTED_PATH_SUFFIXES,
  type WireValue,
  isRedactedPath,
  placeholderFor,
  redactWireBody,
} from './redact';

/**
 * A body shaped like the real corpus: the PII paths this module targets sitting
 * next to the product/carrier keys that share their leaf names. Both halves are
 * load-bearing — the second is the control that proves the redactor is scoped.
 */
const CORPO: WireValue = {
  buyer: {
    id: 3644236740,
    first_name: 'Mariana',
    last_name: 'Ferreira',
    nickname: 'MARIFER123',
    cust_id: '3644236740',
    billing_info: {
      name: 'Mariana',
      last_name: 'Ferreira',
      identification: { type: 'CPF', number: '39053344705' },
      address: {
        street_name: 'Rua das Palmeiras',
        street_number: '452',
        zip_code: '04567010',
        neighborhood: 'Vila Mariana',
        city_name: 'São Paulo',
        state: { code: 'BR-SP', name: 'São Paulo' },
        country_id: 'BR',
      },
    },
  },
  destination: {
    receiver_id: 3644236740,
    receiver_name: 'Mariana Ferreira',
    receiver_phone: '11987654321',
    shipping_address: {
      address_line: 'Rua das Palmeiras 452',
      street_name: 'Rua das Palmeiras',
      zip_code: '04567010',
      comment: 'Apto 71B',
      latitude: -23.5891,
      longitude: -46.6412,
      city: { id: 'BR-SP-SAO', name: 'São Paulo' },
      neighborhood: { id: null, name: 'Vila Mariana' },
      state: { id: 'BR-SP', name: 'São Paulo' },
    },
  },
  payer: {
    email: 'mariana.ferreira@example.com',
    phone: { area_code: '11', number: '987654321', extension: null },
  },
  // — the control half: same leaf names, product and carrier data.
  attributes: [
    { id: 'BRAND', name: 'Marca', value_name: 'Delfrance' },
    { id: 'SIZE', name: 'Tamanho', value_name: 'M' },
  ],
  sale_terms: [{ id: 'WARRANTY_TYPE', name: 'Tipo de garantia', value_name: 'Sem garantia' }],
  lead_time: { shipping_method: { id: 100009, name: 'Normal' }, cost: 24.9 },
  seller_id: 3616169770,
  shipping: { id: 47868202073 },
};

describe('redactWireBody', () => {
  it('CONTROL A (known-bad) — scrubs every personal leaf', () => {
    const out = redactWireBody(CORPO) as Record<string, never>;
    const flat = JSON.stringify(out);

    for (const leaked of [
      'Mariana',
      'Ferreira',
      'MARIFER123',
      '39053344705',
      'Rua das Palmeiras',
      '04567010',
      'Vila Mariana',
      'Apto 71B',
      'mariana.ferreira@example.com',
      '987654321',
    ]) {
      expect(flat, `"${leaked}" survived redaction`).not.toContain(leaked);
    }

    // Geo coordinates are numbers, so a string denylist would never have caught them.
    expect(flat).not.toContain('-23.5891');
    expect(flat).not.toContain('-46.6412');

    // ⚠️ `cust_id` is asserted on the FIELD, not on its digits. Its value is the
    // same string as the numeric `buyer.id`, which is deliberately kept — so a
    // substring check for `3644236740` would fail against correct behaviour and
    // could only be "fixed" by redacting an id the contract tests depend on.
    const out2 = out as unknown as { buyer: { cust_id: string; id: number } };
    expect(out2.buyer.cust_id).toBe('REDACTED');
    expect(out2.buyer.id).toBe(3644236740);
  });

  it('CONTROL B (known-good) — leaves product and carrier data untouched', () => {
    const out = redactWireBody(CORPO) as {
      attributes: { name: string; value_name: string }[];
      sale_terms: { name: string }[];
      lead_time: { shipping_method: { name: string }; cost: number };
      seller_id: number;
      shipping: { id: number };
      buyer: { id: number };
      destination: {
        receiver_id: number;
        shipping_address: { state: { name: string }; city: { id: string } };
      };
    };

    // `name` under attributes/sale_terms/shipping_method is NOT a person.
    expect(out.attributes[0]?.name).toBe('Marca');
    expect(out.attributes[0]?.value_name).toBe('Delfrance');
    expect(out.attributes[1]?.name).toBe('Tamanho');
    expect(out.sale_terms[0]?.name).toBe('Tipo de garantia');
    expect(out.lead_time.shipping_method.name).toBe('Normal');
    expect(out.lead_time.cost).toBe(24.9);

    // Numeric ML account/resource ids are deliberately kept — see the ⚠️ on
    // REDACTED_PATH_SUFFIXES. If that decision is ever reversed, this fails first.
    expect(out.seller_id).toBe(3616169770);
    expect(out.shipping.id).toBe(47868202073);
    expect(out.buyer.id).toBe(3644236740);
    expect(out.destination.receiver_id).toBe(3644236740);

    // Coarse geography survives: fiscal logic keys on it.
    expect(out.destination.shipping_address.state.name).toBe('São Paulo');
    expect(out.destination.shipping_address.city.id).toBe('BR-SP-SAO');
  });

  it('preserves the TYPE of every leaf, which is what the digest records', () => {
    const tipos = (value: WireValue, path: string[] = []): Map<string, string> => {
      const out = new Map<string, string>();
      if (value === null) return out.set(path.join('.'), 'null');
      if (Array.isArray(value)) {
        value.forEach((entry, i) => {
          for (const [k, v] of tipos(entry, [...path, '*'])) out.set(k, v);
        });
        return out;
      }
      if (typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          for (const [k, v] of tipos(entry, [...path, key])) out.set(k, v);
        }
        return out;
      }
      return out.set(path.join('.'), typeof value);
    };

    const antes = tipos(CORPO);
    const depois = tipos(redactWireBody(CORPO));

    expect([...depois.keys()].sort()).toEqual([...antes.keys()].sort());
    for (const [path, tipo] of antes) {
      expect(depois.get(path), `${path} changed type under redaction`).toBe(tipo);
    }
  });

  it('is idempotent — the property piiScan relies on to detect residue', () => {
    const uma = redactWireBody(CORPO);
    const duas = redactWireBody(uma);
    expect(duas).toEqual(uma);
  });

  it('leaves null alone rather than materialising a placeholder', () => {
    // `null` carries no personal data, and replacing it would destroy the
    // omitted-vs-null distinction wire fixtures exist to preserve.
    const out = redactWireBody({
      payer: { email: null, phone: { number: null, area_code: null } },
    }) as { payer: { email: null; phone: { number: null; area_code: null } } };

    expect(out.payer.email).toBeNull();
    expect(out.payer.phone.number).toBeNull();
    expect(out.payer.phone.area_code).toBeNull();
  });
});

describe('isRedactedPath', () => {
  it('matches on a SUFFIX, so a bare leaf name is not enough', () => {
    // The suffix matches at any depth...
    expect(isRedactedPath(['billing_info', 'name'])).toBe(true);
    expect(isRedactedPath(['buyer', 'billing_info', 'name'])).toBe(true);
    expect(isRedactedPath(['a', 'b', 'c', 'identification', 'number'])).toBe(true);

    // ...but `name` under ANY other parent is product/carrier data and survives.
    // This pair is the whole reason the denylist is suffixes and not leaf keys.
    expect(isRedactedPath(['order_items', '*', 'item', 'attributes', '*', 'name'])).toBe(false);
    expect(isRedactedPath(['sale_terms', '*', 'name'])).toBe(false);
    expect(isRedactedPath(['lead_time', 'shipping_method', 'name'])).toBe(false);
    expect(isRedactedPath(['name'])).toBe(false);
  });

  it('accepts a single-segment suffix anywhere in the tree', () => {
    expect(isRedactedPath(['email'])).toBe(true);
    expect(isRedactedPath(['payer', 'email'])).toBe(true);
  });
});

describe('placeholderFor', () => {
  it('keeps the primitive type', () => {
    expect(typeof placeholderFor('latitude', -23.5)).toBe('number');
    expect(typeof placeholderFor('street_name', 'x')).toBe('string');
    expect(typeof placeholderFor('flag', true)).toBe('boolean');
  });

  it('keeps a shape where downstream code parses one', () => {
    expect(placeholderFor('zip_code', '04567010')).toMatch(/^\d{8}$/);
    expect(placeholderFor('number', '39053344705')).toMatch(/^\d{11}$/);
    expect(placeholderFor('email', 'a@b.com')).toMatch(/^[^@]+@[^@]+$/);
  });

  it('depends only on key and type — the source of idempotence', () => {
    expect(placeholderFor('street_name', 'Rua A')).toBe(placeholderFor('street_name', 'Rua B'));
  });
});

describe('REDACTED_PATH_SUFFIXES', () => {
  it('has no duplicate entries', () => {
    const chaves = REDACTED_PATH_SUFFIXES.map((s) => s.join('.'));
    expect(new Set(chaves).size).toBe(chaves.length);
  });
});
