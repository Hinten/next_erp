import { describe, expect, it } from 'vitest';

import { formatFindings, patternFindings, redactionResidue, scanForPii } from './piiScan';
import { type WireValue, redactWireBody } from './redact';

/** An unredacted body — what a raw capture against a real order would look like. */
const CRU: WireValue = {
  buyer: {
    id: 3644236740,
    nickname: 'MARIFER123',
    billing_info: {
      name: 'Mariana',
      identification: { type: 'CPF', number: '39053344705' },
      address: { street_name: 'Rua das Palmeiras', zip_code: '04567010' },
    },
  },
  destination: {
    receiver_name: 'Mariana Ferreira',
    shipping_address: { comment: 'Apto 71B', latitude: -23.5891 },
  },
};

describe('redactionResidue', () => {
  it('CONTROL A (known-bad) — an unredacted body reports every personal leaf', () => {
    const findings = redactionResidue(CRU);
    const paths = findings.map((f) => f.path).sort();

    expect(findings.length).toBeGreaterThan(0);
    expect(paths).toContain('buyer.nickname');
    expect(paths).toContain('buyer.billing_info.name');
    expect(paths).toContain('buyer.billing_info.identification.number');
    expect(paths).toContain('buyer.billing_info.address.street_name');
    expect(paths).toContain('buyer.billing_info.address.zip_code');
    expect(paths).toContain('destination.receiver_name');
    expect(paths).toContain('destination.shipping_address.comment');
    expect(paths).toContain('destination.shipping_address.latitude');
    expect(findings.every((f) => f.kind === 'unredacted-path')).toBe(true);
  });

  it('CONTROL B (known-good) — the redacted body is a fixpoint, so it reports nothing', () => {
    expect(redactionResidue(redactWireBody(CRU))).toEqual([]);
  });

  it('does not flag the ids the denylist deliberately keeps', () => {
    const paths = redactionResidue(CRU).map((f) => f.path);
    expect(paths).not.toContain('buyer.id');
  });
});

describe('patternFindings', () => {
  it('CONTROL A (known-bad) — catches PII in a key no denylist could anticipate', () => {
    // The point of this layer: the KEY is innocent, the prose is not. A denylist
    // cannot enumerate `comment`, a claim message body, or a seller note.
    const findings = patternFindings({
      order_items: [{ item: { title: 'Camiseta' } }],
      comentario_livre: 'Falar com Mariana, CPF 390.533.447-05, tel (11) 98765-4321',
      mensagem: { text: 'meu email é mariana.ferreira@example.com' },
      empresa: { obs: 'CNPJ 12.345.678/0001-95' },
    });

    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toContain('cpf');
    expect(kinds).toContain('phone');
    expect(kinds).toContain('email');
    expect(kinds).toContain('cnpj');
  });

  it('CONTROL B (known-good) — clean product data reports nothing', () => {
    expect(
      patternFindings({
        attributes: [{ id: 'BRAND', name: 'Marca', value_name: 'Delfrance' }],
        title: 'Camiseta Lisa Infantil 100% algodão',
        price: 49.9,
        permalink: 'https://www.mercadolivre.com.br/camiseta-lisa-infantil/up/MLBU5009023942',
      }),
    ).toEqual([]);
  });

  it('does not report the redactor OWN placeholders as leaks', () => {
    // Without this the scanner fires on every file it just cleaned:
    // `redacted@example.invalid` matches the email pattern.
    expect(patternFindings(redactWireBody(CRU))).toEqual([]);
  });

  it('ignores an unpunctuated 11-digit run, which is an ML id far more often than a CPF', () => {
    // Deliberate gap, documented in piiScan.ts: unpunctuated documents are
    // covered by PATH (`identification.number`), never by a pattern that would
    // fire on `2000018143664980` and be switched off within a day.
    expect(patternFindings({ order_id: 2000018143664980, resource: '47868202073' })).toEqual([]);
  });
});

describe('scanForPii', () => {
  it('is the union of both layers', () => {
    const corpo: WireValue = { buyer: { nickname: 'X' }, nota: 'CPF 390.533.447-05' };
    const kinds = scanForPii(corpo).map((f) => f.kind);
    expect(kinds).toContain('unredacted-path');
    expect(kinds).toContain('cpf');
  });
});

describe('formatFindings', () => {
  it('NEVER carries the matched value — only the path and the kind (#1015)', () => {
    const linhas = formatFindings('orders-1.json', scanForPii(CRU));

    // The whole population here is text we suspect is personal, and this string
    // goes to a CI log and a test failure message.
    for (const segredo of [
      'Mariana',
      'Ferreira',
      'MARIFER123',
      '39053344705',
      'Rua das Palmeiras',
      '04567010',
      'Apto 71B',
      '-23.5891',
    ]) {
      expect(linhas, `formatFindings leaked "${segredo}"`).not.toContain(segredo);
    }

    expect(linhas).toContain('orders-1.json');
    expect(linhas).toContain('unredacted-path');
  });
});
