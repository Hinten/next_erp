import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import { INTEGRACAO_FRETE, MOTIVO_ROTA_ETIQUETA_LI, type FreteDoPedido } from '@delfrance/schemas';

import {
  MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI,
  type PrevisaoRotaEtiquetaLi,
} from '@/lib/loja-integrada/rotaEtiqueta';
import {
  avisoDeEtiquetaAntesDoCheckoutLi,
  motivoSemTransportadoraLi,
} from './conferenciaLojaIntegrada';

/**
 * The checkout's two Loja Integrada notices that are not the paid re-check
 * (master plan step 15): the read-only pre-save preview of the label route and
 * the post-save "why there is no carrier" copy. Both are for an IMPORTED Loja
 * Integrada order only — every other channel keeps today's behaviour, which
 * the near-misses pin.
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const CONTA = 'CONTA1';
const ID_LI = sha256(`lojaIntegrada${CONTA}-165`);
const ID_ML = sha256(`mercadoLivre${CONTA}-165`);

const FRETE_NO_DOC_LI = {
  integracaoFreteOuterRef: `documents/int_frete/lojaIntegrada-${CONTA}`,
  enderecoFreteOuterReference: 'documents/clientes/c1/enderecos/e1',
  externalOptionData: { id: 1001, code: 'A' },
  modalidade: '0',
  printLabelId: null,
} as unknown as FreteDoPedido;

const pedidoLi = (frete: unknown = FRETE_NO_DOC_LI) => ({
  estado: 'pago' as const,
  numero: '165',
  integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
  freteInicial: frete,
});

const previsao = (p: PrevisaoRotaEtiquetaLi) => vi.fn(() => Promise.resolve(p));

describe('avisoDeEtiquetaAntesDoCheckoutLi — the pre-save route preview', () => {
  it('a route the backend would REFUSE warns before the stock leaves, with the refusal’s own copy', async () => {
    const prever = previsao({
      tipo: 'recusa',
      motivo: MOTIVO_ROTA_ETIQUETA_LI.semMapeamento,
      mensagem: MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.semMapeamento],
    });
    const aviso = await avisoDeEtiquetaAntesDoCheckoutLi({
      pedidoId: ID_LI,
      pedido: pedidoLi(),
      prever,
    });
    expect(aviso).toBe(
      'A etiqueta deste pedido não poderá ser gerada depois do checkout: ' +
        `${MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.semMapeamento]} ` +
        'Deseja continuar mesmo assim?',
    );
    expect(prever).toHaveBeenCalledTimes(1);
  });

  it('a pedido already routed, or one the backend WOULD route, says nothing', async () => {
    for (const p of [
      { tipo: 'ja-roteado', tipoAlvo: INTEGRACAO_FRETE.motoboy },
      {
        tipo: 'rota',
        alvoId: 'me-1',
        tipoAlvo: INTEGRACAO_FRETE.melhorEnvios,
        externalOptionId: '3',
      },
    ] as const) {
      await expect(
        avisoDeEtiquetaAntesDoCheckoutLi({
          pedidoId: ID_LI,
          pedido: pedidoLi(),
          prever: previsao(p),
        }),
        p.tipo,
      ).resolves.toBeNull();
    }
  });

  it('⚠️ NEAR-MISS: a pedido NOT on its Loja Integrada doc (`sem-rota-li`) is not this preview’s — the post-save copy says why', async () => {
    const prever = previsao({
      tipo: 'recusa',
      motivo: MOTIVO_ROTA_ETIQUETA_LI.semRotaLi,
      mensagem: MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.semRotaLi],
    });
    await expect(
      avisoDeEtiquetaAntesDoCheckoutLi({ pedidoId: ID_LI, pedido: pedidoLi(), prever }),
    ).resolves.toBeNull();
  });

  it('⚠️ NEAR-MISS: a Mercado Livre order, a duplicate and a manual pedido are never previewed — not one read', async () => {
    const casos: Array<[string, string, ReturnType<typeof pedidoLi>]> = [
      ['mercado livre', ID_ML, pedidoLi()],
      ['duplicate', ID_LI, { ...pedidoLi(), numero: null as never }],
      ['manual', 'manual-1', { ...pedidoLi(), integracaoPedidoOuterRef: null as never }],
    ];
    for (const [nome, pedidoId, pedido] of casos) {
      const prever = previsao({
        tipo: 'recusa',
        motivo: MOTIVO_ROTA_ETIQUETA_LI.semMapeamento,
        mensagem: 'x',
      });
      await expect(
        avisoDeEtiquetaAntesDoCheckoutLi({ pedidoId, pedido, prever }),
        nome,
      ).resolves.toBeNull();
      expect(prever, nome).not.toHaveBeenCalled();
    }
  });

  it('a preview that cannot READ (a Firestore error) says nothing — it is advisory, the label step reports its own outcome', async () => {
    const prever = vi.fn(() =>
      Promise.reject(
        new FirebaseError('permission-denied', 'Missing or insufficient permissions.'),
      ),
    );
    await expect(
      avisoDeEtiquetaAntesDoCheckoutLi({ pedidoId: ID_LI, pedido: pedidoLi(), prever }),
    ).resolves.toBeNull();
  });

  it('any other failure is rethrown (rule 6)', async () => {
    const prever = vi.fn(() => Promise.reject(new TypeError('bug')));
    await expect(
      avisoDeEtiquetaAntesDoCheckoutLi({ pedidoId: ID_LI, pedido: pedidoLi(), prever }),
    ).rejects.toThrow(TypeError);
  });
});

describe('motivoSemTransportadoraLi — why an imported order has no carrier', () => {
  it('no delivery endereço: says so', async () => {
    const frete = {
      ...FRETE_NO_DOC_LI,
      integracaoFreteOuterRef: null,
      enderecoFreteOuterReference: null,
    } as FreteDoPedido;
    await expect(motivoSemTransportadoraLi(ID_LI, pedidoLi(frete), frete)).resolves.toBe(
      'Pedido sem endereço de entrega: não há transportadora para gerar a etiqueta.',
    );
  });

  it('an endereço but no freight ref: the conta has no Loja Integrada freight integration', async () => {
    const frete = { ...FRETE_NO_DOC_LI, integracaoFreteOuterRef: null } as FreteDoPedido;
    await expect(motivoSemTransportadoraLi(ID_LI, pedidoLi(frete), frete)).resolves.toBe(
      'A conta Loja Integrada não tem integração de frete: não há transportadora para gerar a ' +
        'etiqueta.',
    );
  });

  it('⚠️ NEAR-MISS: a ref that names a doc which is gone keeps the generic copy (it is not "no integration")', async () => {
    await expect(
      motivoSemTransportadoraLi(ID_LI, pedidoLi(FRETE_NO_DOC_LI), FRETE_NO_DOC_LI),
    ).resolves.toBeNull();
  });

  it('⚠️ NEAR-MISS: every other channel keeps today’s copy — a Mercado Livre order and a manual pedido', async () => {
    const frete = {
      ...FRETE_NO_DOC_LI,
      integracaoFreteOuterRef: null,
      enderecoFreteOuterReference: null,
    } as FreteDoPedido;
    await expect(motivoSemTransportadoraLi(ID_ML, pedidoLi(frete), frete)).resolves.toBeNull();
    await expect(
      motivoSemTransportadoraLi(
        'manual-1',
        { ...pedidoLi(frete), integracaoPedidoOuterRef: null as never },
        frete,
      ),
    ).resolves.toBeNull();
  });
});
