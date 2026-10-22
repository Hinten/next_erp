import { createHash } from 'node:crypto';
import { LiSchemaError } from '@delfrance/integrations-loja-integrada';
import { describe, expect, it } from 'vitest';

import {
  CAMPO_DE_CHAVE_LI,
  ensureUniqueIdLi,
  exigirChaveDeEscritaLi,
  exigirIdPagamentoLi,
  idPagamentoLi,
  idPedidoLi,
  type RespostaDoDetalheLi,
} from './orderIdsLi';

/** An independent sha256, so a vector is never checked against the helper it pins. */
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const RESPOSTA: RespostaDoDetalheLi = {
  operacao: 'buscarPedido',
  caminho: '/v1/pedido/165/',
  correlationId: 'corr-1',
  refCredencial: 'ref-1',
  status: 200,
};

describe('the master plan vectors (numero 165 and pagamento 69291176 are spec example values)', () => {
  it('pedido: sha256("lojaIntegrada" + contaId + "-" + numero)', () => {
    expect(idPedidoLi('CONTA1', 165)).toBe(
      '60fe37ac35667bf3d56a8cb3a015114133ce02dad6d7338ac5db4f421413e532',
    );
    expect(idPedidoLi('CONTA1', 165)).toBe(sha256('lojaIntegradaCONTA1-165'));
  });

  it('pagamento: sha256("integracao/" + contaId + "-" + pagamentoId)', () => {
    expect(idPagamentoLi('CONTA1', 69291176)).toBe(
      '39d4d6a7a8bbe3ec98fa3c0564f3c2974228ee2cc306a03ad6e6ef091b115178',
    );
    expect(idPagamentoLi('CONTA1', 69291176)).toBe(sha256('integracao/CONTA1-69291176'));
  });

  it('⚠️ NEAR-MISS: the other channels’ spellings stay DISTINCT', () => {
    // Mercado Livre's pagamento spelling: a leading slash and `documents/`.
    const ml = '4d70fa6a3875ae722644b147143cdef061411406114f9e28ddab15123435560d';
    expect(sha256('/documents/integracao/CONTA1-69291176')).toBe(ml);
    expect(idPagamentoLi('CONTA1', 69291176)).not.toBe(ml);
    // The canonical outer-ref form (`documents/…`) is not the preimage either.
    expect(idPagamentoLi('CONTA1', 69291176)).not.toBe(
      sha256('documents/integracao/CONTA1-69291176'),
    );
    // Shopee's pedido spelling: no prefix.
    const shopee = '02d33e497ceebc8dbbc25f818c8f8c6ed56492d26ce84c57c4d295b201725c6f';
    expect(sha256('CONTA1-165')).toBe(shopee);
    expect(idPedidoLi('CONTA1', 165)).not.toBe(shopee);
    // A slash after the channel name is a different string.
    expect(idPedidoLi('CONTA1', 165)).not.toBe(sha256('lojaIntegrada/CONTA1-165'));
  });

  it('⚠️ NEAR-MISS: a pedido and a pagamento with the same number never share an id', () => {
    expect(idPedidoLi('CONTA1', 165)).not.toBe(idPagamentoLi('CONTA1', 165));
  });

  it('⚠️ NEAR-MISS: another conta or another numero is another pedido', () => {
    expect(idPedidoLi('CONTA2', 165)).not.toBe(idPedidoLi('CONTA1', 165));
    expect(idPedidoLi('CONTA1', 1650)).not.toBe(idPedidoLi('CONTA1', 165));
    // The separator keeps `CONTA1` + `65` apart from `CONTA` + `165`.
    expect(idPedidoLi('CONTA1', 65)).not.toBe(idPedidoLi('CONTA', 165));
  });

  it('refuses a numero or a pagamento id that is not a positive safe integer (programming error)', () => {
    for (const ruim of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => idPedidoLi('CONTA1', ruim), String(ruim)).toThrow(RangeError);
      expect(() => idPagamentoLi('CONTA1', ruim), String(ruim)).toThrow(RangeError);
    }
  });
});

describe('the line key', () => {
  it('is the provider line id as text, NOT hashed', () => {
    expect(ensureUniqueIdLi(987654)).toBe('987654');
  });

  it('⚠️ NEAR-MISS: two lines with different ids never share a key', () => {
    expect(ensureUniqueIdLi(12)).not.toBe(ensureUniqueIdLi(120));
  });
});

describe('a missing key is refused before any key is built', () => {
  it('absent and null (the schema’s reading of an empty string) are one "no id" → LiSchemaError', () => {
    for (const campo of Object.values(CAMPO_DE_CHAVE_LI)) {
      for (const vazio of [null, undefined]) {
        let erro: unknown = null;
        try {
          exigirChaveDeEscritaLi(vazio, campo, RESPOSTA);
        } catch (err) {
          if (!(err instanceof LiSchemaError)) throw err;
          erro = err;
        }
        expect(erro, campo).toBeInstanceOf(LiSchemaError);
        // The field PATH, never a value.
        expect((erro as LiSchemaError).campos).toEqual([campo]);
        expect((erro as LiSchemaError).status).toBe(200);
      }
    }
  });

  it('EQUAL pair: a present id passes through unchanged, zero included (only pagamentos refuse it)', () => {
    expect(exigirChaveDeEscritaLi(7, CAMPO_DE_CHAVE_LI.item, RESPOSTA)).toBe(7);
    expect(exigirChaveDeEscritaLi(0, CAMPO_DE_CHAVE_LI.envio, RESPOSTA)).toBe(0);
  });

  it('a pagamento id must be positive: 0 and negatives are refused', () => {
    expect(exigirIdPagamentoLi(69291176, RESPOSTA)).toBe(69291176);
    for (const ruim of [0, -5, null, undefined]) {
      expect(() => exigirIdPagamentoLi(ruim, RESPOSTA), String(ruim)).toThrow(LiSchemaError);
    }
  });
});
