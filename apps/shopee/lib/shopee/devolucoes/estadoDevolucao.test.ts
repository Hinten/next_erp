import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATUS_CLAIM, PENDENCIA_RECLAMACAO } from '@delfrance/schemas';
import {
  SHOPEE_RETURN_SOLUTION,
  shopeeReturnAvailableSolutionsSchema,
  shopeeReturnDetailBodySchema,
  type ShopeeReturnAvailableSolutions,
  type ShopeeReturnDetail,
} from '@delfrance/integrations-shopee';

import { makePedidoIdShopee } from '../pedidos/orderIds';
import {
  STATUS_DEVOLUCAO_SHOPEE,
  mapearDevolucaoShopee,
  pendenciaDoVendedor,
} from './devolucaoMapping';
import {
  ACAO_DEVOLUCAO_SHOPEE,
  PENDENCIA_FORA_DO_ERP,
  TIPO_PRAZO_DEVOLUCAO,
  acaoDevolucaoShopeeSchema,
  acoesDisponiveisDe,
  avaliarAcoesDevolucao,
  projetarEstadoDevolucao,
  recusaDaAcaoPedida,
  recusaGeralDaDevolucao,
  recusaPreviaDaAcao,
  type AcaoDevolucaoShopee,
  type AcaoPedidaDevolucao,
  type AvaliacaoAcaoDevolucao,
} from './estadoDevolucao';
import {
  FRASE_RECUSA_DEVOLUCAO,
  MOTIVO_RECUSA_DEVOLUCAO,
  type MotivoRecusaDevolucao,
} from './recusaDevolucao';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const RETURN_SN = '260910ABCDE0001';
const PEDIDO_ID = makePedidoIdShopee(INTEGRACAO, ORDER_SN);

/** 2026-09-10 — SECONDS, like every Shopee clock. */
const UPDATE_S = 1_789_042_568;
const PRAZO_A_S = 1_789_400_000;
const PRAZO_B_S = 1_789_300_000;

/**
 * A detail through the PACKAGE schema, defaulting to the one return every
 * action is open on: REQUESTED, Normal request, seller validation, RRBOC,
 * R$ 10,50, a buyer offer waiting for the seller.
 */
function detalhe(campos: Record<string, unknown> = {}): ShopeeReturnDetail {
  return shopeeReturnDetailBodySchema.parse({
    return_sn: RETURN_SN,
    order_sn: ORDER_SN,
    status: STATUS_DEVOLUCAO_SHOPEE.requested,
    update_time: UPDATE_S,
    return_refund_request_type: 0,
    validation_type: 'seller_validation',
    return_refund_type: 'RRBOC',
    refund_amount: 10.5,
    currency: 'BRL',
    negotiation: {
      negotiation_status: 'PENDING_RESPOND',
      latest_solution: 'REFUND',
      latest_offer_amount: 7.25,
      counter_limit: 1,
    },
    ...campos,
  });
}

/** `get_available_solutions.response` through the PACKAGE schema. */
function solucoes(response: Record<string, unknown>): ShopeeReturnAvailableSolutions {
  return shopeeReturnAvailableSolutionsSchema.parse({ error: ' ', response }).response;
}

const AMBAS_ELEGIVEIS = (): ShopeeReturnAvailableSolutions =>
  solucoes({
    return_sn: RETURN_SN,
    offer_return_refund: { eligibility: true, refund_amount_adjustable: false },
    offer_refund: {
      eligibility: true,
      refund_amount_adjustable: true,
      min_refund_amount: 5,
      max_refund_amount: 10.5,
    },
  });

function motivos(
  av: readonly AvaliacaoAcaoDevolucao[],
): Record<string, MotivoRecusaDevolucao | null> {
  return Object.fromEntries(av.map((a) => [a.acao, a.motivo]));
}

function motivoDe(
  d: ShopeeReturnDetail,
  acao: AcaoDevolucaoShopee,
  s: ShopeeReturnAvailableSolutions | null = AMBAS_ELEGIVEIS(),
): MotivoRecusaDevolucao | null {
  return motivos(avaliarAcoesDevolucao(d, s))[acao] ?? null;
}

/* ------------------------------ the vocabularies ----------------------------- */

describe('o vocabulário das ações — persistido no fio', () => {
  it('as três ações, nesta grafia — a web as envia de volta', () => {
    expect(acaoDevolucaoShopeeSchema.options).toEqual(['confirmar', 'ofertar', 'aceitar-oferta']);
    expect(Object.values(ACAO_DEVOLUCAO_SHOPEE)).toEqual(acaoDevolucaoShopeeSchema.options);
  });

  it('as pendências fora do ERP e os tipos de prazo, nesta grafia', () => {
    expect(Object.values(PENDENCIA_FORA_DO_ERP)).toEqual([
      'contestar',
      'enviar-evidencias',
      'organizar-coleta',
    ]);
    expect(Object.values(TIPO_PRAZO_DEVOLUCAO)).toEqual([
      'resposta-vendedor',
      'final-vendedor',
      'envio-comprador',
      'evidencias',
      'compensacao',
      'proposta',
    ]);
  });
});

/* -------------------------------- the gate -------------------------------- */

describe('recusaGeralDaDevolucao — as linhas que fecham TODAS as ações', () => {
  it.each([STATUS_DEVOLUCAO_SHOPEE.closed, STATUS_DEVOLUCAO_SHOPEE.cancelled])(
    '%s ⇒ devolucao-encerrada',
    (status) => {
      expect(recusaGeralDaDevolucao(detalhe({ status }))).toBe(
        MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada,
      );
    },
  );

  it.each([STATUS_DEVOLUCAO_SHOPEE.sellerDispute, STATUS_DEVOLUCAO_SHOPEE.judging])(
    '%s ⇒ devolucao-em-disputa',
    (status) => {
      expect(recusaGeralDaDevolucao(detalhe({ status }))).toBe(
        MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa,
      );
    },
  );

  it.each(['RETURNED', 'Requested', ' REQUESTED', 'REQUESTED ', 'Closed'])(
    'um status desconhecido %j ⇒ status-nao-permite (fail closed, sem fold de caixa nem trim)',
    (status) => {
      expect(recusaGeralDaDevolucao(detalhe({ status }))).toBe(
        MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
      );
    },
  );

  it.each([
    STATUS_DEVOLUCAO_SHOPEE.requested,
    STATUS_DEVOLUCAO_SHOPEE.processing,
    STATUS_DEVOLUCAO_SHOPEE.accepted,
  ])('%s deixa as regras por ação decidirem', (status) => {
    expect(recusaGeralDaDevolucao(detalhe({ status }))).toBeNull();
  });

  it('a linha geral vale para as três ações, mesmo com tudo o mais aberto', () => {
    const av = avaliarAcoesDevolucao(
      detalhe({ status: STATUS_DEVOLUCAO_SHOPEE.closed }),
      AMBAS_ELEGIVEIS(),
    );
    expect(av.every((a) => a.motivo === MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada)).toBe(true);
    expect(acoesDisponiveisDe(av)).toEqual([]);
  });
});

describe('avaliarAcoesDevolucao — a forma da resposta', () => {
  it('sempre três veredictos, na ordem confirmar, ofertar, aceitar-oferta', () => {
    const av = avaliarAcoesDevolucao(detalhe(), AMBAS_ELEGIVEIS());
    expect(av.map((a) => a.acao)).toEqual(['confirmar', 'ofertar', 'aceitar-oferta']);
    expect(av.every((a) => a.disponivel && a.motivo === null)).toBe(true);
  });

  it('motivo é null EXATAMENTE quando disponível', () => {
    for (const status of [...Object.values(STATUS_DEVOLUCAO_SHOPEE), 'DESCONHECIDO']) {
      for (const av of avaliarAcoesDevolucao(detalhe({ status }), AMBAS_ELEGIVEIS())) {
        expect(av.disponivel).toBe(av.motivo === null);
      }
    }
  });
});

describe('confirmar — "Confirm refund" (o comprador fica com o produto)', () => {
  it.each([STATUS_DEVOLUCAO_SHOPEE.requested, STATUS_DEVOLUCAO_SHOPEE.processing])(
    'aberto em %s',
    (status) => {
      expect(motivoDe(detalhe({ status }), ACAO_DEVOLUCAO_SHOPEE.confirmar)).toBeNull();
    },
  );

  it('ACCEPTED ⇒ status-nao-permite (a solicitação já foi respondida)', () => {
    expect(
      motivoDe(
        detalhe({ status: STATUS_DEVOLUCAO_SHOPEE.accepted }),
        ACAO_DEVOLUCAO_SHOPEE.confirmar,
      ),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite);
  });

  it.each([1, 2, null])(
    'tipo de requisição %j ⇒ tipo-requisicao-nao-permite (só 0 = Normal; ausente FECHA)',
    (tipo) => {
      expect(
        motivoDe(detalhe({ return_refund_request_type: tipo }), ACAO_DEVOLUCAO_SHOPEE.confirmar),
      ).toBe(MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite);
    },
  );

  it('warehouse_validation ⇒ validacao-pelo-armazem; seller_validation e ausente abrem', () => {
    expect(
      motivoDe(
        detalhe({ validation_type: 'warehouse_validation' }),
        ACAO_DEVOLUCAO_SHOPEE.confirmar,
      ),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem);
    expect(
      motivoDe(detalhe({ validation_type: 'seller_validation' }), ACAO_DEVOLUCAO_SHOPEE.confirmar),
    ).toBeNull();
    expect(
      motivoDe(detalhe({ validation_type: null }), ACAO_DEVOLUCAO_SHOPEE.confirmar),
    ).toBeNull();
  });

  it('RRAOC ⇒ tipo-reembolso-nao-permite; RRBOC abre', () => {
    expect(
      motivoDe(detalhe({ return_refund_type: 'RRAOC' }), ACAO_DEVOLUCAO_SHOPEE.confirmar),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite);
    expect(
      motivoDe(detalhe({ return_refund_type: 'RRBOC' }), ACAO_DEVOLUCAO_SHOPEE.confirmar),
    ).toBeNull();
  });

  it('sem refund_amount NÃO é listado (nada a ecoar); um reembolso 0 é um valor e abre', () => {
    expect(motivoDe(detalhe({ refund_amount: null }), ACAO_DEVOLUCAO_SHOPEE.confirmar)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
    );
    expect(motivoDe(detalhe({ refund_amount: 0 }), ACAO_DEVOLUCAO_SHOPEE.confirmar)).toBeNull();
  });

  it('as regras de confirmar não fecham as outras duas ações', () => {
    const av = motivos(
      avaliarAcoesDevolucao(
        detalhe({ return_refund_request_type: 1, validation_type: 'warehouse_validation' }),
        AMBAS_ELEGIVEIS(),
      ),
    );
    expect(av).toEqual({
      confirmar: MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite,
      ofertar: null,
      'aceitar-oferta': null,
    });
  });
});

describe('ofertar — ao menos uma solução com eligibility === true', () => {
  it('soluções não lidas (null) ⇒ solucao-indisponivel', () => {
    expect(motivoDe(detalhe(), ACAO_DEVOLUCAO_SHOPEE.ofertar, null)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel,
    );
  });

  it('nenhuma elegível ⇒ solucao-indisponivel; UMA elegível basta', () => {
    const nenhuma = solucoes({
      offer_return_refund: { eligibility: false },
      offer_refund: { eligibility: false },
    });
    expect(motivoDe(detalhe(), ACAO_DEVOLUCAO_SHOPEE.ofertar, nenhuma)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel,
    );
    const so = solucoes({
      offer_return_refund: { eligibility: false },
      offer_refund: { eligibility: true },
    });
    expect(motivoDe(detalhe(), ACAO_DEVOLUCAO_SHOPEE.ofertar, so)).toBeNull();
  });

  it('eligibility ausente ou um objeto que derivou NÃO é elegível (=== true, nunca truthy)', () => {
    const ausente = solucoes({ offer_return_refund: {}, offer_refund: null });
    expect(motivoDe(detalhe(), ACAO_DEVOLUCAO_SHOPEE.ofertar, ausente)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel,
    );
    const derivado = solucoes({ offer_return_refund: { eligibility: 'yes' }, offer_refund: 7 });
    expect(motivoDe(detalhe(), ACAO_DEVOLUCAO_SHOPEE.ofertar, derivado)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel,
    );
  });

  it('em disputa fecha, mesmo com soluções elegíveis', () => {
    expect(
      motivoDe(detalhe({ status: STATUS_DEVOLUCAO_SHOPEE.judging }), ACAO_DEVOLUCAO_SHOPEE.ofertar),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa);
  });
});

describe('aceitar-oferta — só com a proposta do COMPRADOR aguardando o vendedor', () => {
  it('PENDING_RESPOND abre', () => {
    expect(motivoDe(detalhe(), ACAO_DEVOLUCAO_SHOPEE.aceitarOferta)).toBeNull();
  });

  it.each([
    [
      'PENDING_BUYER_RESPOND (a proposta é da loja)',
      { negotiation_status: 'PENDING_BUYER_RESPOND' },
    ],
    ['TERMINATED', { negotiation_status: 'TERMINATED' }],
    ['pending_respond (caixa)', { negotiation_status: 'pending_respond' }],
    ['status ausente', { negotiation_status: null }],
  ])('%s ⇒ sem-proposta-do-comprador', (_, negotiation) => {
    expect(motivoDe(detalhe({ negotiation }), ACAO_DEVOLUCAO_SHOPEE.aceitarOferta)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador,
    );
  });

  it('sem negociação alguma ⇒ sem-proposta-do-comprador', () => {
    expect(motivoDe(detalhe({ negotiation: null }), ACAO_DEVOLUCAO_SHOPEE.aceitarOferta)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador,
    );
  });
});

describe('os tokens que a pendência do aviso também lê — as duas leituras concordam', () => {
  // Both read the ONE pair of tokens `devolucaoMapping.ts` exports; this pins
  // the BEHAVIOUR too — the gate and the aviso agree on every negotiation state.
  const aceito = { status: STATUS_DEVOLUCAO_SHOPEE.accepted };

  it.each(['PENDING_RESPOND', 'PENDING_BUYER_RESPOND', 'pending_respond', 'TERMINATED'])(
    'negociação %j: aceitar-oferta aberta ⇔ pendência responder-proposta',
    (negotiation_status) => {
      const d = detalhe({ ...aceito, negotiation: { negotiation_status } });
      const aberta = motivoDe(d, ACAO_DEVOLUCAO_SHOPEE.aceitarOferta) === null;
      const pendencia = pendenciaDoVendedor(STATUS_CLAIM.aberta, mapearDevolucaoShopee(d).bloco);
      expect(aberta).toBe(pendencia?.pendencia === PENDENCIA_RECLAMACAO.responderProposta);
    },
  );

  it.each(['PENDING', 'PENDING_SUBMIT', 'pending', 'SUBMITTED'])(
    'prova %j: pendência fora do ERP enviar-evidencias ⇔ pendência do aviso enviar-evidencias',
    (seller_proof_status) => {
      const d = detalhe({ ...aceito, negotiation: null, seller_proof: { seller_proof_status } });
      const fora = projetarEstadoDevolucao({
        integracaoId: INTEGRACAO,
        detalhe: d,
        solucoes: null,
      }).pendenciasForaDoErp.includes(PENDENCIA_FORA_DO_ERP.enviarEvidencias);
      const pendencia = pendenciaDoVendedor(STATUS_CLAIM.aberta, mapearDevolucaoShopee(d).bloco);
      expect(fora).toBe(pendencia?.pendencia === PENDENCIA_RECLAMACAO.enviarEvidencias);
    },
  );
});

/* ------------------------- the request half of the gate ------------------------- */

function pedido(
  campos: Partial<AcaoPedidaDevolucao> & Pick<AcaoPedidaDevolucao, 'acao'>,
): AcaoPedidaDevolucao {
  return { integracaoId: INTEGRACAO, pedidoId: PEDIDO_ID, ...campos };
}

const CONFIRMAR = (valorExibidoMinor: number | null | undefined): AcaoPedidaDevolucao =>
  pedido({ acao: ACAO_DEVOLUCAO_SHOPEE.confirmar, valorExibidoMinor });

describe('recusaPreviaDaAcao / pedido-divergente — a aba velha agindo na devolução de outro pedido', () => {
  it('o pedido do order_sn VIVO confere ⇒ null', () => {
    expect(recusaPreviaDaAcao(detalhe(), pedido({ acao: 'confirmar' }))).toBeNull();
  });

  it.each([
    ['outro order_sn', makePedidoIdShopee(INTEGRACAO, '260910KJBHUJDN')],
    ['outra integração', makePedidoIdShopee('int-2', ORDER_SN)],
    ['o próprio order_sn cru', ORDER_SN],
  ])('%s ⇒ pedido-divergente', (_, pedidoId) => {
    expect(recusaPreviaDaAcao(detalhe(), pedido({ acao: 'confirmar', pedidoId }))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente,
    );
    expect(recusaDaAcaoPedida(detalhe(), AMBAS_ELEGIVEIS(), { ...CONFIRMAR(1050), pedidoId })).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente,
    );
  });

  it('vem ANTES da linha geral: uma devolução encerrada de outro pedido é pedido-divergente', () => {
    const d = detalhe({ status: STATUS_DEVOLUCAO_SHOPEE.closed });
    expect(recusaPreviaDaAcao(d, pedido({ acao: 'confirmar', pedidoId: 'outro' }))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente,
    );
    expect(recusaPreviaDaAcao(d, pedido({ acao: 'confirmar' }))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada,
    );
  });
});

describe('recusaDaAcaoPedida — confirmar ecoa o valor que o operador VIU (R-15)', () => {
  it('o valor exibido em centavos igual ao vivo ⇒ null', () => {
    expect(recusaDaAcaoPedida(detalhe(), null, CONFIRMAR(1050))).toBeNull();
  });

  it.each([
    ['um centavo a mais', 1051],
    ['um centavo a menos', 1049],
    ['em reais, não centavos', 10.5],
    ['null (nada exibido)', null],
    ['ausente', undefined],
  ])('%s ⇒ valor-mudou', (_, eco) => {
    expect(recusaDaAcaoPedida(detalhe(), null, CONFIRMAR(eco))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.valorMudou,
    );
  });

  it('centavos pelo centavosDeReais (roundReais primeiro), nunca Math.round(x * 100)', () => {
    // 10.045 → roundReais 10.04 (the double leans down) → 1004; Math.round(1004.4999…·) says 1005.
    const d = detalhe({ refund_amount: 10.045 });
    expect(recusaDaAcaoPedida(d, null, CONFIRMAR(1004))).toBeNull();
    expect(recusaDaAcaoPedida(d, null, CONFIRMAR(1005))).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorMudou);
    // 2.675 → 267 (Math.round(2.675 * 100) is 268).
    const e = detalhe({ refund_amount: 2.675 });
    expect(recusaDaAcaoPedida(e, null, CONFIRMAR(267))).toBeNull();
    expect(recusaDaAcaoPedida(e, null, CONFIRMAR(268))).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorMudou);
  });

  it('uma ação indisponível responde o motivo do gate, não o do eco', () => {
    expect(recusaDaAcaoPedida(detalhe({ return_refund_request_type: 2 }), null, CONFIRMAR(1))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite,
    );
  });
});

describe('recusaDaAcaoPedida — ofertar', () => {
  const ofertar = (
    solucao: AcaoPedidaDevolucao['solucao'],
    valorReembolsoMinor?: number,
  ): AcaoPedidaDevolucao =>
    pedido({ acao: ACAO_DEVOLUCAO_SHOPEE.ofertar, solucao, valorReembolsoMinor });

  it('a solução ESCOLHIDA precisa ser elegível — a outra elegível não basta', () => {
    const s = solucoes({
      offer_return_refund: { eligibility: true, refund_amount_adjustable: false },
      offer_refund: { eligibility: false },
    });
    expect(recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.soReembolso, 500))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel,
    );
    expect(
      recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso)),
    ).toBeNull();
  });

  it('valor numa solução não ajustável ⇒ valor-nao-ajustavel; sem valor ⇒ null', () => {
    const s = AMBAS_ELEGIVEIS();
    expect(
      recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso, 500)),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorNaoAjustavel);
    expect(
      recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso)),
    ).toBeNull();
  });

  it('solução ajustável sem valor ⇒ valor-obrigatorio', () => {
    expect(
      recusaDaAcaoPedida(detalhe(), AMBAS_ELEGIVEIS(), ofertar(SHOPEE_RETURN_SOLUTION.soReembolso)),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorObrigatorio);
  });

  it.each([
    ['o mínimo exato', 500, null],
    ['o máximo exato', 1050, null],
    ['no meio', 777, null],
    ['um centavo abaixo do mínimo', 499, MOTIVO_RECUSA_DEVOLUCAO.valorForaDaFaixa],
    ['um centavo acima do máximo', 1051, MOTIVO_RECUSA_DEVOLUCAO.valorForaDaFaixa],
    ['muito acima', 1_000_000, MOTIVO_RECUSA_DEVOLUCAO.valorForaDaFaixa],
  ])(
    'faixa [R$ 5,00, R$ 10,50] em centavos: %s ⇒ %j (nunca ajustado à borda)',
    (_, valor, esperado) => {
      expect(
        recusaDaAcaoPedida(
          detalhe(),
          AMBAS_ELEGIVEIS(),
          ofertar(SHOPEE_RETURN_SOLUTION.soReembolso, valor),
        ),
      ).toBe(esperado);
    },
  );

  it('as bordas cruzam por centavosDeReais: um máximo 10.045 é 1004 centavos', () => {
    const s = solucoes({
      offer_refund: {
        eligibility: true,
        refund_amount_adjustable: true,
        max_refund_amount: 10.045,
      },
    });
    expect(
      recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.soReembolso, 1004)),
    ).toBeNull();
    expect(
      recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.soReembolso, 1005)),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorForaDaFaixa);
  });

  it('uma borda que a Shopee não mandou não é checada — a recusa dela é a árbitra', () => {
    const s = solucoes({ offer_refund: { eligibility: true, refund_amount_adjustable: true } });
    for (const v of [1, 99_999_999]) {
      expect(
        recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.soReembolso, v)),
      ).toBeNull();
    }
  });

  it('sem solução escolhida ⇒ solucao-indisponivel (nunca a "primeira elegível")', () => {
    expect(recusaDaAcaoPedida(detalhe(), AMBAS_ELEGIVEIS(), ofertar(undefined))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel,
    );
  });

  it.each(['refund', 'REFUND_ONLY', 'RETURN_AND_REFUND'])(
    'uma solução fora do enum (%j, um cast) nunca cai na oferta de outra ⇒ solucao-indisponivel',
    (solucao) => {
      expect(
        recusaDaAcaoPedida(
          detalhe(),
          AMBAS_ELEGIVEIS(),
          ofertar(solucao as AcaoPedidaDevolucao['solucao'], 500),
        ),
      ).toBe(MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel);
    },
  );

  it('refund_amount_adjustable AUSENTE não é ajustável (=== true): sem valor passa, com valor recusa', () => {
    const s = solucoes({ offer_refund: { eligibility: true } });
    expect(
      recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.soReembolso)),
    ).toBeNull();
    expect(recusaDaAcaoPedida(detalhe(), s, ofertar(SHOPEE_RETURN_SOLUTION.soReembolso, 500))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.valorNaoAjustavel,
    );
  });
});

describe('recusaDaAcaoPedida — aceitar-oferta ecoa a proposta E o valor', () => {
  const aceitar = (
    solucaoExibida: AcaoPedidaDevolucao['solucaoExibida'],
    valorExibidoMinor: AcaoPedidaDevolucao['valorExibidoMinor'],
  ): AcaoPedidaDevolucao =>
    pedido({ acao: ACAO_DEVOLUCAO_SHOPEE.aceitarOferta, solucaoExibida, valorExibidoMinor });

  it('a proposta viva (REFUND, R$ 7,25) igual ao eco ⇒ null', () => {
    expect(
      recusaDaAcaoPedida(detalhe(), null, aceitar(SHOPEE_RETURN_SOLUTION.soReembolso, 725)),
    ).toBeNull();
  });

  it('outra solução ⇒ proposta-mudou, antes de olhar o valor', () => {
    expect(
      recusaDaAcaoPedida(detalhe(), null, aceitar(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso, 1)),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.propostaMudou);
  });

  it('a solução viva é lida pelo normalizador: "refund" (caixa) é DESCONHECIDA, não REFUND', () => {
    const d = detalhe({
      negotiation: {
        negotiation_status: 'PENDING_RESPOND',
        latest_solution: 'refund',
        latest_offer_amount: 7.25,
      },
    });
    expect(recusaDaAcaoPedida(d, null, aceitar(SHOPEE_RETURN_SOLUTION.soReembolso, 725))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.propostaMudou,
    );
    expect(recusaDaAcaoPedida(d, null, aceitar(null, 725))).toBeNull();
  });

  it.each([
    ['um centavo a mais', 726],
    ['em reais', 7.25],
    ['null quando há valor', null],
  ])('valor %s ⇒ valor-mudou', (_, eco) => {
    expect(
      recusaDaAcaoPedida(detalhe(), null, aceitar(SHOPEE_RETURN_SOLUTION.soReembolso, eco)),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorMudou);
  });

  it('sem valor vivo: só o eco null confere — 0 é um valor, não "nada"', () => {
    const d = detalhe({
      negotiation: { negotiation_status: 'PENDING_RESPOND', latest_solution: 'RETURN_REFUND' },
    });
    expect(
      recusaDaAcaoPedida(d, null, aceitar(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso, null)),
    ).toBeNull();
    expect(
      recusaDaAcaoPedida(d, null, aceitar(SHOPEE_RETURN_SOLUTION.devolucaoEReembolso, 0)),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.valorMudou);
  });

  it('ecos AUSENTES nunca passam — nem com a proposta viva nula', () => {
    const d = detalhe({ negotiation: { negotiation_status: 'PENDING_RESPOND' } });
    expect(recusaDaAcaoPedida(d, null, aceitar(undefined, null))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.propostaMudou,
    );
    expect(recusaDaAcaoPedida(d, null, aceitar(null, undefined))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.valorMudou,
    );
  });

  it('sem a proposta do comprador ⇒ o motivo do gate', () => {
    const d = detalhe({ negotiation: { negotiation_status: 'PENDING_BUYER_RESPOND' } });
    expect(recusaDaAcaoPedida(d, null, aceitar(null, null))).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador,
    );
  });

  it('uma ação fora do enum (um cast) é recusada, nunca enviada', () => {
    expect(
      recusaDaAcaoPedida(detalhe(), AMBAS_ELEGIVEIS(), {
        ...pedido({ acao: ACAO_DEVOLUCAO_SHOPEE.confirmar }),
        acao: 'contestar' as AcaoDevolucaoShopee,
      }),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido);
  });
});

/* --------------------------------- the estado --------------------------------- */

describe('projetarEstadoDevolucao — o contrato do GET …/reclamacao/estado', () => {
  const projetar = (
    d: ShopeeReturnDetail,
    s: ShopeeReturnAvailableSolutions | null = AMBAS_ELEGIVEIS(),
  ) => projetarEstadoDevolucao({ integracaoId: INTEGRACAO, detalhe: d, solucoes: s });

  it('os nomes dos campos — idênticos ao shopeeReclamacaoEstadoSchema da web', () => {
    expect(Object.keys(projetar(detalhe())).sort()).toEqual(
      [
        'returnSn',
        'orderSn',
        'pedidoId',
        'status',
        'terminal',
        'solucao',
        'motivo',
        'motivoReavaliado',
        'valorReembolso',
        'valorAntesDesconto',
        'moeda',
        'tipoRequisicao',
        'tipoValidacao',
        'negociacao',
        'prova',
        'compensacao',
        'prazos',
        'solucoes',
        'acoesDisponiveis',
        'motivoSemAcao',
        'pendenciasForaDoErp',
      ].sort(),
    );
  });

  it('identidade, status, solução e motivos pelos leitores do importador', () => {
    const e = projetar(
      detalhe({
        return_solution: 0,
        reason: 'NONE',
        reassessed_request_reason: 'NONE',
        amount_before_discount: 12,
        validation_type: '-',
      }),
    );
    expect(e).toMatchObject({
      returnSn: RETURN_SN,
      orderSn: ORDER_SN,
      pedidoId: PEDIDO_ID,
      status: STATUS_DEVOLUCAO_SHOPEE.requested,
      terminal: false,
      solucao: SHOPEE_RETURN_SOLUTION.devolucaoEReembolso,
      // `reason` 'NONE' is a REAL value; the REASSESSED one's 'NONE' means "not reassessed".
      motivo: 'NONE',
      motivoReavaliado: null,
      valorReembolso: 10.5,
      valorAntesDesconto: 12,
      moeda: 'BRL',
      tipoRequisicao: 0,
      // `-` is Shopee's absence sentinel.
      tipoValidacao: null,
    });
    expect(projetar(detalhe({ return_solution: 1 })).solucao).toBe(
      SHOPEE_RETURN_SOLUTION.soReembolso,
    );
    expect(projetar(detalhe({ return_solution: 2 })).solucao).toBeNull();
  });

  it.each([
    [STATUS_DEVOLUCAO_SHOPEE.closed, true],
    [STATUS_DEVOLUCAO_SHOPEE.cancelled, true],
    [STATUS_DEVOLUCAO_SHOPEE.accepted, false],
    ['Closed', false],
  ])('terminal(%j) = %j', (status, terminal) => {
    expect(projetar(detalhe({ status })).terminal).toBe(terminal);
  });

  it('negociação, prova e compensação: null quando o objeto não veio', () => {
    const e = projetar(detalhe({ negotiation: null }));
    expect(e.negociacao).toBeNull();
    expect(e.prova).toBeNull();
    expect(e.compensacao).toBeNull();
  });

  it('negociação, prova e compensação presentes', () => {
    const e = projetar(
      detalhe({
        negotiation: {
          negotiation_status: 'PENDING_RESPOND',
          latest_solution: 'RETURN_REFUND',
          latest_offer_amount: 3.2,
          counter_limit: 0,
        },
        seller_proof: { seller_proof_status: 'PENDING' },
        seller_compensation: {
          seller_compensation_status: 'PENDING_REQUEST',
          compensation_amount: 4,
        },
      }),
    );
    expect(e.negociacao).toEqual({
      status: 'PENDING_RESPOND',
      solucaoOfertada: SHOPEE_RETURN_SOLUTION.devolucaoEReembolso,
      valorOfertado: 3.2,
      // ⚠️ 0 is "no counter-offer left", never absent.
      contrapropostasRestantes: 0,
    });
    expect(e.prova).toEqual({ status: 'PENDING' });
    expect(e.compensacao).toEqual({ status: 'PENDING_REQUEST', valor: 4 });
  });

  it('prazos: MILISSEGUNDOS = segundos × 1000, ordem fixa, só os presentes', () => {
    const e = projetar(
      detalhe({
        due_date: PRAZO_A_S,
        return_seller_due_date: PRAZO_B_S,
        return_ship_due_date: PRAZO_A_S + 1,
        seller_proof: { seller_evidence_deadline: PRAZO_A_S + 2 },
        seller_compensation: { seller_compensation_due_date: PRAZO_A_S + 3 },
        negotiation: { negotiation_status: 'PENDING_RESPOND', offer_due_date: PRAZO_A_S + 4 },
      }),
    );
    expect(e.prazos).toEqual([
      { tipo: 'resposta-vendedor', prazoMs: PRAZO_B_S * 1000, reembolsoAutomatico: true },
      { tipo: 'final-vendedor', prazoMs: PRAZO_A_S * 1000, reembolsoAutomatico: true },
      { tipo: 'envio-comprador', prazoMs: (PRAZO_A_S + 1) * 1000, reembolsoAutomatico: false },
      { tipo: 'evidencias', prazoMs: (PRAZO_A_S + 2) * 1000, reembolsoAutomatico: false },
      { tipo: 'compensacao', prazoMs: (PRAZO_A_S + 3) * 1000, reembolsoAutomatico: false },
      { tipo: 'proposta', prazoMs: (PRAZO_A_S + 4) * 1000, reembolsoAutomatico: false },
    ]);
    // Milliseconds, never µs: a 2026 deadline in ms is ~1.79e12.
    for (const p of e.prazos) expect(p.prazoMs).toBeLessThan(1e13);
  });

  it('prazos zerados, ausentes ou anteriores a 2020 não existem (o piso do importador)', () => {
    const e = projetar(
      detalhe({ due_date: 0, return_seller_due_date: 1_000, return_ship_due_date: null }),
    );
    expect(e.prazos).toEqual([]);
  });

  it.each([
    [true, true],
    [false, false],
    [null, false],
  ])(
    'envio-comprador tem reembolso automático só sob coleta pelo vendedor (is_seller_arrange %j)',
    (is_seller_arrange, automatico) => {
      const e = projetar(detalhe({ return_ship_due_date: PRAZO_A_S, is_seller_arrange }));
      expect(e.prazos).toEqual([
        { tipo: 'envio-comprador', prazoMs: PRAZO_A_S * 1000, reembolsoAutomatico: automatico },
      ]);
    },
  );

  it('soluções: só as elegíveis, na ordem do fio, com as bordas em REAIS como vieram', () => {
    expect(projetar(detalhe()).solucoes).toEqual([
      { solucao: 'RETURN_REFUND', ajustavel: false, minimo: null, maximo: null },
      { solucao: 'REFUND', ajustavel: true, minimo: 5, maximo: 10.5 },
    ]);
    expect(
      projetar(
        detalhe(),
        solucoes({
          offer_return_refund: { eligibility: false },
          offer_refund: { eligibility: true },
        }),
      ).solucoes,
    ).toEqual([{ solucao: 'REFUND', ajustavel: false, minimo: null, maximo: null }]);
    expect(projetar(detalhe(), null).solucoes).toEqual([]);
  });

  it('acoesDisponiveis é a saída do gate — nenhuma regra de segunda mão', () => {
    const d = detalhe({ validation_type: 'warehouse_validation' });
    const s = AMBAS_ELEGIVEIS();
    expect(projetar(d, s).acoesDisponiveis).toEqual(
      acoesDisponiveisDe(avaliarAcoesDevolucao(d, s)),
    );
    expect(projetar(d, s).acoesDisponiveis).toEqual(['ofertar', 'aceitar-oferta']);
    expect(projetar(d, s).motivoSemAcao).toBeNull();
  });

  it.each([
    [STATUS_DEVOLUCAO_SHOPEE.closed, MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada],
    [STATUS_DEVOLUCAO_SHOPEE.sellerDispute, MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa],
    ['DESCONHECIDO', MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite],
  ])('sem ação por UM motivo (%s) ⇒ motivoSemAcao é a frase dele', (status, motivo) => {
    const e = projetar(detalhe({ status }));
    expect(e.acoesDisponiveis).toEqual([]);
    expect(e.motivoSemAcao).toBe(FRASE_RECUSA_DEVOLUCAO[motivo]);
  });

  it('sem ação por motivos MISTOS ⇒ motivoSemAcao null (a frase genérica do painel)', () => {
    const e = projetar(
      detalhe({ status: STATUS_DEVOLUCAO_SHOPEE.accepted, negotiation: null }),
      null,
    );
    expect(e.acoesDisponiveis).toEqual([]);
    expect(e.motivoSemAcao).toBeNull();
  });

  it.each([
    [STATUS_DEVOLUCAO_SHOPEE.requested, ['contestar']],
    [STATUS_DEVOLUCAO_SHOPEE.processing, ['contestar']],
    [STATUS_DEVOLUCAO_SHOPEE.accepted, ['contestar']],
    [STATUS_DEVOLUCAO_SHOPEE.judging, []],
    [STATUS_DEVOLUCAO_SHOPEE.sellerDispute, []],
    [STATUS_DEVOLUCAO_SHOPEE.closed, []],
  ])('pendências fora do ERP em %s: %j', (status, esperado) => {
    expect(projetar(detalhe({ status })).pendenciasForaDoErp).toEqual(esperado);
  });

  it('enviar-evidencias com a prova PENDING; organizar-coleta com is_seller_arrange e não terminal', () => {
    expect(
      projetar(
        detalhe({
          status: STATUS_DEVOLUCAO_SHOPEE.accepted,
          seller_proof: { seller_proof_status: 'PENDING' },
          is_seller_arrange: true,
        }),
      ).pendenciasForaDoErp,
    ).toEqual(['contestar', 'enviar-evidencias', 'organizar-coleta']);
    expect(
      projetar(
        detalhe({
          status: STATUS_DEVOLUCAO_SHOPEE.closed,
          seller_proof: { seller_proof_status: 'PENDING' },
          is_seller_arrange: true,
        }),
      ).pendenciasForaDoErp,
    ).toEqual(['enviar-evidencias']);
    expect(
      projetar(
        detalhe({ seller_proof: { seller_proof_status: 'pending' }, is_seller_arrange: false }),
      ).pendenciasForaDoErp,
    ).toEqual(['contestar']);
  });

  it('é JSON puro: sobrevive a um JSON.stringify sem perder nada', () => {
    const e = projetar(detalhe({ due_date: PRAZO_A_S }));
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });
});

/* ------------------------------ purity (source pins) ------------------------------ */

describe('estadoDevolucao.ts — puro, sem segunda cópia', () => {
  const fonte = readFileSync(new URL('./estadoDevolucao.ts', import.meta.url), 'utf8');
  const codigo = fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  it('sem relógio, ambiente, Firestore, console ou conversão para µs', () => {
    for (const proibido of [
      'Date.now',
      'new Date',
      'process.env',
      'console.',
      'firebase',
      '@delfrance/data',
      'runTransaction',
      'microsDeSegundosShopee',
      'millisToMicros',
      'coerceToMicros',
    ]) {
      expect(codigo, proibido).not.toContain(proibido);
    }
  });

  it('centavos SÓ por centavosDeReais — nenhum Math.round(x * 100) feito à mão', () => {
    expect(codigo).not.toMatch(/Math\.round/);
    expect(codigo).not.toMatch(/\*\s*100\b/);
    expect(codigo).toContain('centavosDeReais(');
  });

  it('o conjunto terminal e o vocabulário de status vêm de devolucaoMapping.ts, não de uma cópia', () => {
    expect(codigo).not.toMatch(/['"]CLOSED['"]|['"]CANCELLED['"]|['"]SELLER_DISPUTE['"]/);
    expect(codigo).toContain('STATUS_DEVOLUCAO_TERMINAIS');
  });
});
