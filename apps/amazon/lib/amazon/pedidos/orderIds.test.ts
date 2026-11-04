/**
 * The two deterministic ids of the Amazon order import (master plan step 5,
 * PR 5-a). Every digest below is a LITERAL, computed once with `node:crypto`
 * (sha256 / sha1, UTF-8, lowercase hex) and never derived from a fixture: the
 * sanitizer fakes order ids, and a vector that moved with its fixture would pin
 * nothing.
 *
 * The ids are fake: `Ab3dE5gH7jK9mN1pQ2rS` is no conta, `171-9876543-2109876`
 * is the Orders model's own sandbox example, and `000-0000000-2412538` is the
 * fake the sanitizer gave that same example in `sb-getorder-br.json`. The conta
 * id is MIXED-CASE on purpose, so a lowercasing mutant is not vacuous.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { makePagamentoIdAmazon, makePedidoIdAmazon, preimagemPedidoAmazon } from './orderIds';

const CONTA = 'Ab3dE5gH7jK9mN1pQ2rS';
const PEDIDO = '171-9876543-2109876';

/** The legacy digest of (`CONTA`, `PEDIDO`). */
const DIGESTO = 'cea5a8005dad3e8c4cfaed862694599e29c817e4600493ad90819a41310c5b0b';

describe('makePedidoIdAmazon: the legacy digest, byte for byte', () => {
  it.each<[string, string, string, string]>([
    ['the model example', CONTA, PEDIDO, DIGESTO],
    [
      'the committed fixture’s faked id',
      CONTA,
      '000-0000000-2412538',
      '209c4bceff5be89bf6ec5f9f82948f83f131c4b71443c44aa46565cc6d3d3643',
    ],
    [
      'a conta id with a dash of its own',
      'int-1',
      PEDIDO,
      '3dc46aaa3f648fd933c056a816e2123c8ff98062b592373a2ba896f504a610b4',
    ],
  ])('%s', (_caso, conta, pedido, digesto) => {
    // ⚠️ Pinned on purpose. A migrated Amazon pedido already sits at this digest
    // (root CLAUDE.md rule 8): another spelling forks every one of them on its
    // first re-import.
    expect(makePedidoIdAmazon(conta, pedido)).toBe(digesto);
  });

  it('the preimage is the bare conta id, ONE ASCII hyphen-minus, the order id verbatim', () => {
    expect(preimagemPedidoAmazon(CONTA, PEDIDO)).toBe('Ab3dE5gH7jK9mN1pQ2rS-171-9876543-2109876');
    expect(preimagemPedidoAmazon('int-1', '000-0000000-2412538')).toBe('int-1-000-0000000-2412538');
  });

  it('is stable, and moves with the conta and with the order', () => {
    expect(makePedidoIdAmazon(CONTA, PEDIDO)).toBe(makePedidoIdAmazon(CONTA, PEDIDO));
    expect(makePedidoIdAmazon('int-2', PEDIDO)).not.toBe(makePedidoIdAmazon('int-1', PEDIDO));
    expect(makePedidoIdAmazon(CONTA, '171-9876543-2109877')).not.toBe(DIGESTO);
  });
});

describe('⚠️ NEAR-MISS: every other spelling on record, or a plausible slip, gives ANOTHER id', () => {
  // Each row is a preimage a sibling channel uses or a plausible bug produces,
  // written out IN FULL with its sha256 computed once (`node:crypto`).
  it.each<[string, string, string]>([
    [
      'the LI/Shopee pagamento spelling (`integracao/` prefix)',
      'integracao/Ab3dE5gH7jK9mN1pQ2rS-171-9876543-2109876',
      'd25b1727a77ad8cae0ec2b33f159954a08c10b9e5504c7ae8245f620fb634eab',
    ],
    [
      'the Mercado Livre spelling (`/documents/integracao/`)',
      '/documents/integracao/Ab3dE5gH7jK9mN1pQ2rS-171-9876543-2109876',
      'a6fbdf099e559ca42843e24f624373212994853d7891cdc6209add3140651fb8',
    ],
    [
      'the same without the leading slash',
      'documents/integracao/Ab3dE5gH7jK9mN1pQ2rS-171-9876543-2109876',
      '9078fb4e6f0779fb6f50f2fe937ccdfb7a4d86b6208ac59ba38d761ee1968689',
    ],
    [
      'a channel prefix',
      'amazonAb3dE5gH7jK9mN1pQ2rS-171-9876543-2109876',
      '14c9b6f49905e36f1acd5ea6f8bd62c75c4192b87f5303a25d0df3bb95f8fef8',
    ],
    [
      'a `|amazon|` separator',
      'Ab3dE5gH7jK9mN1pQ2rS|amazon|171-9876543-2109876',
      '6d1fec557612065893a97857fc1a548f3637df5aac0b980f0acf4a4b3e927f79',
    ],
    [
      'the conta id lowercased',
      'ab3de5gh7jk9mn1pq2rs-171-9876543-2109876',
      'b65cdbee4397eca683c2998097b4033005d09e33af9843b84d0c06a96e828eea',
    ],
    [
      'no separator',
      'Ab3dE5gH7jK9mN1pQ2rS171-9876543-2109876',
      '86c9a7a4b2c60f79cedb6ae56f1aba170967ba2549a198b9af613f614a7d48a9',
    ],
    [
      'the pair swapped',
      '171-9876543-2109876-Ab3dE5gH7jK9mN1pQ2rS',
      'e3a9d3ee0ac1218f1e0aeb81fe2da60d132c1f1057881491f707d5a27362669e',
    ],
    [
      'the order id without its dashes',
      'Ab3dE5gH7jK9mN1pQ2rS-17198765432109876',
      'ca1d42fe541d1161300d0c436253f0340fc8ed513db87bb268ff809a2866c390',
    ],
    [
      'an en dash (U+2013) as the separator',
      'Ab3dE5gH7jK9mN1pQ2rS–171-9876543-2109876',
      '4ff5c562945cc433bd59065b1d94cf06bc3e221fd2cbb71176441dc004bee552',
    ],
    [
      'a trailing line feed',
      'Ab3dE5gH7jK9mN1pQ2rS-171-9876543-2109876\n',
      '02044cdc46032ce3275249d5c7d9ebb53471c8f40bf0845c500b9d19dd5464f4',
    ],
  ])('%s', (_caso, preimagem, digesto) => {
    // The literal is the spelling's real digest (the row is not vacuous)…
    expect(createHash('sha256').update(preimagem, 'utf8').digest('hex')).toBe(digesto);
    // …and it is not ours, through either producer.
    expect(makePedidoIdAmazon(CONTA, PEDIDO)).not.toBe(digesto);
    expect(makePagamentoIdAmazon(CONTA, PEDIDO)).not.toBe(digesto);
  });

  it('the sha1 of the RIGHT preimage is not the id (the algorithm is sha256)', () => {
    const sha1 = 'f17ae54cd37a45f09608ad611aaba2873c6815e3';
    expect(
      createHash('sha1').update('Ab3dE5gH7jK9mN1pQ2rS-171-9876543-2109876', 'utf8').digest('hex'),
    ).toBe(sha1);
    expect(makePedidoIdAmazon(CONTA, PEDIDO)).not.toBe(sha1);
  });

  it('the UPPERCASE hex of the right digest is not the id (the encoding is lowercase hex)', () => {
    const id = makePedidoIdAmazon(CONTA, PEDIDO);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe(DIGESTO.toUpperCase());
  });
});

describe('makePagamentoIdAmazon: the SAME digest as the pedido', () => {
  it('equals the pedido id, and the legacy vector, for every vector', () => {
    expect(makePagamentoIdAmazon(CONTA, PEDIDO)).toBe(DIGESTO);
    for (const [conta, pedido] of [
      [CONTA, PEDIDO],
      [CONTA, '000-0000000-2412538'],
      ['int-1', PEDIDO],
    ] as const) {
      expect(makePagamentoIdAmazon(conta, pedido)).toBe(makePedidoIdAmazon(conta, pedido));
    }
  });
});

describe('a malformed id is a bug: RangeError, never a document id', () => {
  it.each<[string, string, string]>([
    // A PREFIXED conta id (the near-miss of the bare one): a path is not an id.
    ['a conta path', 'integracao/Ab3dE5gH7jK9mN1pQ2rS', PEDIDO],
    ['a documents/ conta path', 'documents/integracao/Ab3dE5gH7jK9mN1pQ2rS', PEDIDO],
    ['an empty conta id', '', PEDIDO],
    ['a conta id with a space', 'Ab3d E5', PEDIDO],
    ['an empty order id', CONTA, ''],
    ['an order id without dashes', CONTA, '17198765432109876'],
    ['an order id with a trailing line feed', CONTA, `${PEDIDO}\n`],
    ['an order id with an en dash', CONTA, '171–9876543-2109876'],
    ['an order id one digit short', CONTA, '171-9876543-210987'],
  ])('%s', (_caso, conta, pedido) => {
    expect(() => preimagemPedidoAmazon(conta, pedido)).toThrow(RangeError);
    expect(() => makePedidoIdAmazon(conta, pedido)).toThrow(RangeError);
    expect(() => makePagamentoIdAmazon(conta, pedido)).toThrow(RangeError);
  });

  it('the message names the grammar, never the value', () => {
    expect(() => makePedidoIdAmazon('integracao/x', PEDIDO)).toThrow(/CONTA_ID_AMAZON_REGEX/);
    expect(() => makePedidoIdAmazon(CONTA, '1-2-3')).toThrow(/PEDIDO_AMAZON_REGEX/);
    for (const [conta, pedido, valor] of [
      ['conta/MARCADOR-CONTA', PEDIDO, 'MARCADOR-CONTA'],
      [CONTA, 'MARCADOR-PEDIDO', 'MARCADOR-PEDIDO'],
    ] as const) {
      try {
        makePedidoIdAmazon(conta, pedido);
        expect.unreachable('o id malformado devia lançar');
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        expect(err.message).not.toContain(valor);
      }
    }
  });
});
