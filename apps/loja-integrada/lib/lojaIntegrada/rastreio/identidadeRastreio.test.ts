/**
 * The identity proof of the status write-back (master plan step 7, PR 7-d): is
 * this pedido an imported Loja Integrada order of THIS conta, and is the live
 * order and its envio the one the pedido stores?
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ESTADO_FRETE } from '@delfrance/schemas';

import { envioDoPedidoLi, numeroConfereLi, pedidoRastreioLi } from './identidadeRastreio';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The master plan's vector: `('CONTA1', '165')` ⇒ `lojaIntegradaCONTA1-165`. */
const ID_CONTA1_165 = sha('lojaIntegradaCONTA1-165');

function pedido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numero: '165',
    integracaoPedidoOuterRef: 'integracao/CONTA1',
    freteInicial: {
      estado: ESTADO_FRETE.postado,
      codRastreio: 'PJ258408772BR',
      externalId: '69291055',
    },
    cliente: { nome: 'Comprador' },
    ...over,
  };
}

describe('pedidoRastreioLi: the identity proof', () => {
  it('EQUAL pair: the master-plan vector — the digest of the preimage IS the pedido id', () => {
    expect(pedidoRastreioLi(ID_CONTA1_165, pedido())).toEqual({
      contaId: 'CONTA1',
      numero: '165',
      codRastreio: 'PJ258408772BR',
      externalId: '69291055',
      estadoFrete: ESTADO_FRETE.postado,
    });
  });

  it('EQUAL pair: a migrated NUMBER numero and a `documents/` conta ref are the same order', () => {
    expect(
      pedidoRastreioLi(
        ID_CONTA1_165,
        pedido({ numero: 165, integracaoPedidoOuterRef: 'documents/integracao/CONTA1' }),
      ),
    ).toMatchObject({ contaId: 'CONTA1', numero: '165' });
  });

  it('⚠️ NEAR-MISS: a duplicate (a random id with the same conta and numero) is NOT an LI order ⇒ null', () => {
    expect(pedidoRastreioLi('a'.repeat(64), pedido())).toBeNull();
  });

  it.each([
    ['a padded numero', { numero: '0165' }],
    ['a fractional numero', { numero: '165.0' }],
    ['no numero (a duplicate)', { numero: null }],
    ['another conta', { integracaoPedidoOuterRef: 'integracao/CONTA2' }],
    ['another collection', { integracaoPedidoOuterRef: 'int_frete/CONTA1' }],
    ['no conta ref', { integracaoPedidoOuterRef: null }],
  ])('⚠️ NEAR-MISS: %s ⇒ not this LI order (zero LI work)', (_caso, over) => {
    expect(pedidoRastreioLi(ID_CONTA1_165, pedido(over))).toBeNull();
  });

  it('a body that is not an object, or a freteInicial that is not one, never throws', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      expect(pedidoRastreioLi(ID_CONTA1_165, raw)).toBeNull();
    }
    expect(pedidoRastreioLi(ID_CONTA1_165, pedido({ freteInicial: 'x' }))).toEqual({
      contaId: 'CONTA1',
      numero: '165',
      codRastreio: undefined,
      externalId: undefined,
      estadoFrete: undefined,
    });
  });
});

describe('envioDoPedidoLi: the live envio matched by the stored externalId', () => {
  const envios = [
    { id: 11, objeto: null },
    { id: 69291055, objeto: '' },
  ];

  it('EQUAL pair: stored `69291055` ≡ live `69291055`, wherever it sits in the list', () => {
    expect(envioDoPedidoLi(envios, '69291055')).toEqual({
      kind: 'encontrado',
      id: 69291055,
      objeto: '',
    });
    expect(envioDoPedidoLi(envios, 69291055)).toEqual({
      kind: 'encontrado',
      id: 69291055,
      objeto: '',
    });
  });

  it('a stored null, absent or "" envio ⇒ sem-external-id (the situação is still decided)', () => {
    for (const externalId of [null, undefined, '']) {
      expect(envioDoPedidoLi(envios, externalId)).toEqual({ kind: 'sem-external-id' });
    }
  });

  it.each(['069291055', '69291055.0', ' 69291055', '12', 12, 0, 'abc'])(
    '⚠️ NEAR-MISS: stored %j matches no live envio ⇒ nao-encontrado (pedido-divergente: NOTHING written)',
    (externalId) => {
      expect(envioDoPedidoLi(envios, externalId)).toEqual({ kind: 'nao-encontrado' });
    },
  );

  it('⚠️ NEAR-MISS: a present stored envio and NO live envio at all ⇒ nao-encontrado', () => {
    expect(envioDoPedidoLi([], '69291055')).toEqual({ kind: 'nao-encontrado' });
  });

  it('a live envio with no readable id is never matched', () => {
    expect(envioDoPedidoLi([{ id: null, objeto: null }], '69291055')).toEqual({
      kind: 'nao-encontrado',
    });
  });
});

describe('numeroConfereLi: the guard read is about THIS order', () => {
  it('EQUAL pair: the live `numero` 165 ≡ the stored `"165"`', () => {
    expect(numeroConfereLi(165, '165')).toBe(true);
    expect(numeroConfereLi('165', '165')).toBe(true);
  });

  it.each([
    [166, '165'],
    ['0165', '165'],
    [165, '0165'],
    [165.5, '165'],
    [null, '165'],
    [undefined, '165'],
    [165, null],
  ])('⚠️ NEAR-MISS: %j vs %j ⇒ not this order (pedido-ausente)', (corpo, numero) => {
    expect(numeroConfereLi(corpo, numero)).toBe(false);
  });
});
