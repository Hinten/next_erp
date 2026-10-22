/**
 * The pedido id hashes the SHARED preimage (`preimagemPedidoLi`, `@delfrance/schemas`): the
 * string the web's identity check hashes too, so the two can never disagree on which pedido an
 * order is. `orderIdsLi.test.ts` pins the vectors themselves; this
 * file pins that the importer reaches them through the shared preimage, and what the shared
 * preimage refuses.
 */
import { createHash } from 'node:crypto';
import { preimagemPedidoLi } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { idPedidoLi } from './orderIdsLi';

/** An independent sha256, so a digest is never checked against the helper it pins. */
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('idPedidoLi — the digest of the shared preimage', () => {
  it('EQUAL pair: the pedido id IS the sha256 of preimagemPedidoLi, numero as a number or its decimal string', () => {
    for (const [conta, numero] of [
      ['CONTA1', 165],
      ['CONTA2', 1],
      ['conta-x', 50801],
      ['CONTA1', Number.MAX_SAFE_INTEGER],
    ] as const) {
      const id = idPedidoLi(conta, numero);
      expect(id, `${conta} ${String(numero)}`).toBe(
        sha256(preimagemPedidoLi(conta, String(numero)) ?? ''),
      );
      expect(id, `${conta} ${String(numero)}`).toBe(sha256(preimagemPedidoLi(conta, numero) ?? ''));
    }
  });

  it('⚠️ NEAR-MISS: a conta id no document can have is refused (programming error), never hashed into a second id', () => {
    for (const conta of ['', '.', '..', 'integracao/CONTA1', 'CONTA1/x']) {
      expect(() => idPedidoLi(conta, 165), JSON.stringify(conta)).toThrow(RangeError);
    }
  });
});
