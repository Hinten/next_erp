import { describe, expect, it } from 'vitest';

import {
  chaveDaLinhaShopee,
  makeItemEnsureUniqueId,
  makePedidoIdShopee,
  mktplaceIdDe,
} from './orderIds';
import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const ORDER_SN = '220810QSK8S7BX';

describe('makePedidoIdShopee', () => {
  it('é sha256("<contaId>-<order_sn>") — o preimage do importador LEGADO, byte a byte', () => {
    // ⚠️ Este digest é fixado de propósito. O corpus migrado chega com os ids do
    // app legado (regra 8), então mudar o preimage FORKA todo pedido Shopee
    // migrado na primeira reimportação: dois pedidos para uma venda, e o
    // operador está olhando o outro. Uma reformatação "inofensiva" do template
    // literal falha AQUI, e não na janela de migração.
    expect(makePedidoIdShopee(CONTA, ORDER_SN)).toBe(
      'a7ea89f52c36e6746ce0545c23d1fccdea4d831e6d22a7208de35e3f693a72de',
    );
  });

  it('⚠️ NEAR-MISS: as duas outras grafias em registro dão OUTRO id', () => {
    const legado = makePedidoIdShopee(CONTA, ORDER_SN);
    // A grafia proposta na issue (`<contaId>|shopee|<order_sn>`)…
    expect(legado).not.toBe('5c4eeeca3e91549541a45dfb4b88690d794de910a563e190988a376ae9caa9d2');
    // …e a do Mercado Livre (`shopee<contaId>-<order_sn>`).
    expect(legado).not.toBe('06bdd0caaae80890e36f59e996486a7a1b38fc71313b31507fead3d71109569e');
  });

  it('é estável entre duas leituras e muda com a conta', () => {
    expect(makePedidoIdShopee(CONTA, ORDER_SN)).toBe(makePedidoIdShopee(CONTA, ORDER_SN));
    expect(makePedidoIdShopee('int-2', ORDER_SN)).not.toBe(makePedidoIdShopee(CONTA, ORDER_SN));
  });
});

describe('makeItemEnsureUniqueId', () => {
  it('é sha256("<order_sn>-<mktplaceId>-<index>"), fixado byte a byte', () => {
    expect(makeItemEnsureUniqueId(ORDER_SN, '12984093', 0)).toBe(
      'f9fff5c4b3dbac919da0a3e076b5d37a3f04b5201a5edaa48a55a5f4876ed567',
    );
  });

  it('o índice separa duas linhas do MESMO (order_sn, mktplaceId)', () => {
    expect(makeItemEnsureUniqueId(ORDER_SN, '12984093', 0)).not.toBe(
      makeItemEnsureUniqueId(ORDER_SN, '12984093', 1),
    );
  });

  it('uma segunda entrega do mesmo pedido cai na MESMA string (tier 0)', () => {
    expect(makeItemEnsureUniqueId(ORDER_SN, '12984093', 0)).toBe(
      makeItemEnsureUniqueId(ORDER_SN, '12984093', 0),
    );
  });
});

describe('mktplaceIdDe', () => {
  it('usa o model_id quando a linha vendeu uma variação', () => {
    expect(mktplaceIdDe({ item_id: 846056136, model_id: 12984093 })).toBe('12984093');
  });

  it('⚠️ NEAR-MISS: model_id 0 devolve o item_id — 0 é "sem variação", não ausência', () => {
    expect(mktplaceIdDe({ item_id: 846056136, model_id: 0 })).toBe('846056136');
  });

  it('model_id null devolve o item_id', () => {
    expect(mktplaceIdDe({ item_id: 846056136, model_id: null })).toBe('846056136');
  });

  it('dois modelos do MESMO anúncio dão mktplaceIds DIFERENTES', () => {
    const a = mktplaceIdDe({ item_id: 846056136, model_id: 1 });
    const b = mktplaceIdDe({ item_id: 846056136, model_id: 2 });
    expect(a).not.toBe(b);
  });

  it('o pedido SG do corpus resolve para o model_id, não para o order_item_id', () => {
    const linha = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!
      .item_list![0]!;
    // ⚠️ É o que refuta `String(order_item_id)`: nesse pedido
    // `order_item_id === item_id`, então ele não identifica a linha.
    expect(linha.order_item_id).toBe(linha.item_id);
    expect(mktplaceIdDe(linha)).toBe(String(linha.model_id));
    expect(mktplaceIdDe(linha)).not.toBe(String(linha.order_item_id));
  });
});

describe('chaveDaLinhaShopee', () => {
  it('o MESMO par dá a MESMA chave (o par igual)', () => {
    expect(chaveDaLinhaShopee(846056136, 12984093)).toBe(chaveDaLinhaShopee(846056136, 12984093));
  });

  it('⚠️ NEAR-MISS: model_id 0 e model_id null são chaves DIFERENTES', () => {
    // Dobrar as duas deixaria uma linha sem variação tomar o dinheiro de uma
    // linha do escrow cujo campo veio ausente.
    expect(chaveDaLinhaShopee(1, 0)).not.toBe(chaveDaLinhaShopee(1, null));
    expect(chaveDaLinhaShopee(1, undefined)).toBe(chaveDaLinhaShopee(1, null));
  });

  it('⚠️ NEAR-MISS: (12, 3) e (1, 23) não colidem — o separador é o que separa', () => {
    expect(chaveDaLinhaShopee(12, 3)).not.toBe(chaveDaLinhaShopee(1, 23));
  });

  it('anúncios diferentes com o mesmo model_id são chaves diferentes', () => {
    expect(chaveDaLinhaShopee(1, 7)).not.toBe(chaveDaLinhaShopee(2, 7));
  });
});
