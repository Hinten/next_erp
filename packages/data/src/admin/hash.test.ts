import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from './hash';

/* -------------------------------------------------------------------------- */
/*  Fixtures — nenhuma delas é real.                                           */
/* -------------------------------------------------------------------------- */

/**
 * O preimage do pedido Shopee de fixture (`<contaId>-<order_sn>`), escrito por
 * extenso. Não é uma escolha decorativa: é EXATAMENTE a string que
 * `apps/shopee/lib/shopee/pedidos/orderIds.ts` monta, e o digest fixado abaixo é
 * o mesmo literal que `orderIds.test.ts` fixa desde o passo 5 — a prova de que a
 * promoção deste helper não mexeu em nenhum id já escrito.
 */
const PREIMAGE = 'int-1-220810QSK8S7BX';
const DIGEST = 'a7ea89f52c36e6746ce0545c23d1fccdea4d831e6d22a7208de35e3f693a72de';

describe('sha256Hex', () => {
  it('é o sha256 hex do preimage, fixado byte a byte', () => {
    expect(sha256Hex(PREIMAGE)).toBe(DIGEST);
  });

  it('⛔ NEAR-MISS: UM caractere diferente no preimage dá OUTRO digest', () => {
    // ⚠️ É o que um "ajuste inofensivo" no template literal de um chamador
    // quebra: `int-2` não é `int-1`, e um id derivado do preimage errado não
    // colide com o antigo — ele simplesmente nasce em outro documento, sem erro
    // nenhum em lugar nenhum.
    expect(sha256Hex('int-2-220810QSK8S7BX')).toBe(
      'f5f17c78569acf3aa70d87646e6dc9a558415c0682d65ab1ae0c498331259754',
    );
    expect(sha256Hex('int-2-220810QSK8S7BX')).not.toBe(DIGEST);
  });

  it('lê o preimage como UTF-8: "ação" tem um digest fixado', () => {
    expect(sha256Hex('ação')).toBe(
      '0664077f33cc3ebbaa4bbdacac0eb70e740983080f01dce29929e73b7785a7ad',
    );
  });

  it('⛔ NEAR-MISS: a mesma "ação" lida como latin1 dá OUTRO digest', () => {
    // ⚠️ A razão de `.update(input, 'utf8')` escrever a codificação. Um nome de
    // produto ou uma opção de variação com acento é entrada normal aqui, e a
    // troca silenciosa de codificação re-homeia todo documento mintado antes
    // dela — sem exceção, sem log, sem teste que reclame.
    const latin1 = createHash('sha256').update('ação', 'latin1').digest('hex');
    expect(latin1).toBe('5021bb98b2f2a48f39f2be7c788c933cf82c274b387ba879f8fca8e188b88610');
    expect(sha256Hex('ação')).not.toBe(latin1);
  });

  it('a string vazia dá o digest sha256("") conhecido', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('é byte-idêntico ao `.update(s)` SEM argumento de codificação — a cópia que ele substitui', () => {
    // ⚠️ Esta é a asserção que explica por que `orderIds.test.ts` continua verde
    // sem uma única linha editada: a cópia privada chamava `.update(input, 'utf8')`
    // e o Node já usa utf8 por padrão, então as duas grafias são a MESMA função.
    // As duas cópias do Mercado Livre (que chamam `.update(s)` sem codificação)
    // são follow-up justamente por isso.
    for (const entrada of [PREIMAGE, '', 'ação', 'shopee|int-1|1200000001']) {
      expect(sha256Hex(entrada)).toBe(createHash('sha256').update(entrada).digest('hex'));
    }
  });

  it('devolve sempre 64 caracteres hex minúsculos', () => {
    for (const entrada of [PREIMAGE, '', 'ação', 'shopee|int-1|1200000001']) {
      expect(sha256Hex(entrada)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('é estável entre duas leituras — sem relógio, sem aleatoriedade', () => {
    expect(sha256Hex(PREIMAGE)).toBe(sha256Hex(PREIMAGE));
  });
});
