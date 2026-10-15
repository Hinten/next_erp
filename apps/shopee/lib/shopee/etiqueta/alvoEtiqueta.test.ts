/**
 * The label's pedido → conta ladder (#1523, step 15; review 1, R5-3) — the ONE
 * copy the route and the `baixar:etiqueta` CLI both run. The first five cases
 * were the CLI's ladder tests, moved here with the ladder; the route keeps its
 * own end-to-end rows.
 *
 * ⛔ A predicate test names a PAIR (must come out equal) and a NEAR-MISS (must
 * stay distinct). Every id is a repo fixture id.
 */
import { describe, expect, it } from 'vitest';
import { INTEGRACAO_FRETE, INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';

import { avaliarContaParaNfeShopee } from '../nfe/pedidoNfe';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { avaliarContaParaEtiquetaShopee, avaliarPedidoParaEtiquetaShopee } from './alvoEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE } from './motivosEtiqueta';

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);

function pedidoRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numero: ORDER_SN,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.shopee },
    ...extra,
  };
}

const conta = (o: Partial<Integracao>): Integracao =>
  ({ tipo: INTEGRACAO_TIPO.shopee, ativo: true, ...o }) as Integracao;

describe('avaliarPedidoParaEtiquetaShopee — o pedido', () => {
  it('PAR: o digest que recomputa passa; NEAR-MISS: o que não recomputa ⇒ nao-shopee', () => {
    expect(avaliarPedidoParaEtiquetaShopee(PEDIDO_ID, pedidoRaw())).toEqual({
      ok: true,
      contaId: CONTA,
      orderSn: ORDER_SN,
    });
    expect(avaliarPedidoParaEtiquetaShopee('outro-id', pedidoRaw())).toEqual({
      ok: false,
      motivo: MOTIVO_ETIQUETA_SHOPEE.naoShopee,
    });
  });

  it('PAR: externalOptionIntegracao shopee, null e ausente passam', () => {
    const esperado = { ok: true, contaId: CONTA, orderSn: ORDER_SN };
    expect(avaliarPedidoParaEtiquetaShopee(PEDIDO_ID, pedidoRaw())).toEqual(esperado);
    expect(
      avaliarPedidoParaEtiquetaShopee(
        PEDIDO_ID,
        pedidoRaw({ freteInicial: { externalOptionIntegracao: null } }),
      ),
    ).toEqual(esperado);
    expect(avaliarPedidoParaEtiquetaShopee(PEDIDO_ID, pedidoRaw({ freteInicial: {} }))).toEqual(
      esperado,
    );
    expect(avaliarPedidoParaEtiquetaShopee(PEDIDO_ID, pedidoRaw({ freteInicial: null }))).toEqual(
      esperado,
    );
  });

  it('NEAR-MISS: outra integração e "Shopee" com maiúscula são recusadas', () => {
    for (const dono of [INTEGRACAO_FRETE.mercadoLivre, 'Shopee']) {
      expect(
        avaliarPedidoParaEtiquetaShopee(
          PEDIDO_ID,
          pedidoRaw({ freteInicial: { externalOptionIntegracao: dono } }),
        ),
      ).toEqual({ ok: false, motivo: MOTIVO_ETIQUETA_SHOPEE.freteDeOutraIntegracao });
    }
  });

  it('bloquearEmissaoNFe NÃO recusa a etiqueta — é o degrau da NF-e, e ele recusa todo pedido SG', () => {
    expect(
      avaliarPedidoParaEtiquetaShopee(PEDIDO_ID, pedidoRaw({ bloquearEmissaoNFe: true })).ok,
    ).toBe(true);
  });

  it('um freteInicial que não é objeto é um bloco AUSENTE (passa); um dono não-texto é outro dono', () => {
    const esperado = { ok: true, contaId: CONTA, orderSn: ORDER_SN };
    for (const freteInicial of [[], 'shopee', 7]) {
      expect(avaliarPedidoParaEtiquetaShopee(PEDIDO_ID, pedidoRaw({ freteInicial }))).toEqual(
        esperado,
      );
    }
    // Near-miss: the SAME field holding a non-string is an owner, and not ours.
    expect(
      avaliarPedidoParaEtiquetaShopee(
        PEDIDO_ID,
        pedidoRaw({ freteInicial: { externalOptionIntegracao: 1 } }),
      ),
    ).toEqual({ ok: false, motivo: MOTIVO_ETIQUETA_SHOPEE.freteDeOutraIntegracao });
  });

  it('a ORDEM dos degraus: sem prova E com frete de outra integração ⇒ nao-shopee (a prova vem antes)', () => {
    expect(
      avaliarPedidoParaEtiquetaShopee(
        'outro-id',
        pedidoRaw({ freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre } }),
      ),
    ).toEqual({ ok: false, motivo: MOTIVO_ETIQUETA_SHOPEE.naoShopee });
  });
});

describe('avaliarContaParaEtiquetaShopee — a conta', () => {
  it('a conta: ausente ou de outro tipo ⇒ nao-configurada; ativo diferente de true ⇒ inativa', () => {
    expect(avaliarContaParaEtiquetaShopee(conta({}))).toEqual({ ok: true });
    expect(avaliarContaParaEtiquetaShopee(null)).toEqual({
      ok: false,
      motivo: MOTIVO_ETIQUETA_SHOPEE.contaNaoConfigurada,
    });
    expect(avaliarContaParaEtiquetaShopee(conta({ tipo: INTEGRACAO_TIPO.mercadoLivre }))).toEqual({
      ok: false,
      motivo: MOTIVO_ETIQUETA_SHOPEE.contaNaoConfigurada,
    });
    for (const ativo of [false, null, undefined]) {
      expect(avaliarContaParaEtiquetaShopee(conta({ ativo } as Partial<Integracao>))).toEqual({
        ok: false,
        motivo: MOTIVO_ETIQUETA_SHOPEE.contaInativa,
      });
    }
  });

  it('é o predicado da NF-e: as duas respostas concordam em TODA entrada (a mesma slug, o mesmo ok)', () => {
    const casos: (Integracao | null)[] = [
      null,
      conta({}),
      conta({ tipo: INTEGRACAO_TIPO.mercadoLivre }),
      conta({ tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: false }),
      conta({ ativo: false }),
      conta({ ativo: null } as unknown as Partial<Integracao>),
    ];
    for (const c of casos) {
      expect(avaliarContaParaEtiquetaShopee(c)).toEqual(avaliarContaParaNfeShopee(c));
    }
  });
});
