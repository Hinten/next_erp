import {
  SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS,
  shopeeOrderDetailRowSchema,
  shopeePackageDetailRowSchema,
  type ShopeeOrderDetailRow,
  type ShopeePackageDetailRow,
} from '@delfrance/integrations-shopee';
import { describe, expect, it } from 'vitest';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { ESTADO_FRETE_DE_TOKEN_SHOPEE } from '../pedidos/freteShopeeMapping';
import { SHOPEE_ETIQUETA_DETALHE_CAMPOS } from './constantesEtiqueta';
import {
  CANAIS_ARRANJO_AUTOMATICO,
  CANAIS_ETIQUETA_COM_PRAZO,
  decidirArranjoAutomatico,
  decidirProximaAcao,
  ehCanalDeArranjoAutomatico,
  ehCanalDeEtiquetaComPrazo,
  ehPedidoFbsShopee,
  elegibilidadeDoArranjoAutomatico,
  faseDoTokenShopee,
  fasePacote,
  faseTemPortaoDeNfe,
  gruposDeDownload,
  observacaoDaOrdemShopee,
  observacaoDoPacoteShopee,
  progressoDe,
  type AcaoEtiqueta,
  type ElegibilidadeDoArranjo,
  type FasePacote,
  type ObservacaoOrdemEtiqueta,
  type ObservacaoPacoteEtiqueta,
} from './faseEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from './motivosEtiqueta';

/* ------------------------------- fixtures ---------------------------------- */

const P1 = 'OFG000000000001';
const P2 = 'OFG000000000002';
const RASTREIO = 'BR000000000000T';

/** A fresh READY package nobody arranged yet. */
function pacote(extra: Partial<ObservacaoPacoteEtiqueta> = {}): ObservacaoPacoteEtiqueta {
  return {
    numero: P1,
    canalId: 1,
    fulfillment: 'LOGISTICS_READY',
    arranjado: false,
    termosPendentes: [],
    nfePendente: false,
    rastreio: null,
    tipoDocumento: null,
    documento: 'desconhecido',
    recriadoNestaChamada: false,
    ...extra,
  };
}

/** An arranged package whose document is ready to download. */
function pronto(extra: Partial<ObservacaoPacoteEtiqueta> = {}): ObservacaoPacoteEtiqueta {
  return pacote({
    fulfillment: 'LOGISTICS_REQUEST_CREATED',
    arranjado: true,
    rastreio: RASTREIO,
    tipoDocumento: 'NORMAL_AIR_WAYBILL',
    documento: 'pronto',
    ...extra,
  });
}

function ordem(extra: Partial<ObservacaoOrdemEtiqueta> = {}): ObservacaoOrdemEtiqueta {
  return { status: 'READY_TO_SHIP', fbs: false, pacotes: [P1], ...extra };
}

function decidir(
  o: ObservacaoOrdemEtiqueta,
  ps: readonly ObservacaoPacoteEtiqueta[],
  pacoteDoCorpo: string | null = null,
): AcaoEtiqueta {
  return decidirProximaAcao(o, ps, { pacote: pacoteDoCorpo });
}

const recusa = (motivo: MotivoEtiquetaShopee): AcaoEtiqueta => ({ tipo: 'recusa', motivo });

/* ------------------------------- fasePacote --------------------------------- */

describe('fasePacote — a tabela do D2 §2', () => {
  it.each<[string, Partial<ObservacaoPacoteEtiqueta>, FasePacote]>([
    ['NOT_START', { fulfillment: 'LOGISTICS_NOT_START' }, 'nao-pronto'],
    ['NOT_STARTED (o alias)', { fulfillment: 'LOGISTICS_NOT_STARTED' }, 'nao-pronto'],
    ['READY, não programado', { arranjado: false }, 'programar'],
    ['READY, programado', { arranjado: true }, 'arranjado'],
    ['READY, retido (pending_terms)', { termosPendentes: ['ARRANGE_SHIPMENT_PENDING'] }, 'retido'],
    [
      'READY, programado E com pending_terms — o arranjo vence',
      { arranjado: true, termosPendentes: ['SYSTEM_PENDING'] },
      'arranjado',
    ],
    ['REQUEST_CREATED', { fulfillment: 'LOGISTICS_REQUEST_CREATED' }, 'arranjado'],
    ['PICKUP_DONE', { fulfillment: 'LOGISTICS_PICKUP_DONE' }, 'janela-fechada'],
    ['DELIVERY_DONE', { fulfillment: 'LOGISTICS_DELIVERY_DONE' }, 'janela-fechada'],
    ['DELIVERY_FAILED', { fulfillment: 'LOGISTICS_DELIVERY_FAILED' }, 'janela-fechada'],
    ['LOST', { fulfillment: 'LOGISTICS_LOST' }, 'janela-fechada'],
    ['INVALID', { fulfillment: 'LOGISTICS_INVALID' }, 'inelegivel'],
    ['REQUEST_CANCELED', { fulfillment: 'LOGISTICS_REQUEST_CANCELED' }, 'inelegivel'],
    ['REQUEST_CANCELLED (o alias)', { fulfillment: 'LOGISTICS_REQUEST_CANCELLED' }, 'inelegivel'],
    ['PICKUP_FAILED', { fulfillment: 'LOGISTICS_PICKUP_FAILED' }, 'inelegivel'],
    ['COD_REJECTED', { fulfillment: 'LOGISTICS_COD_REJECTED' }, 'inelegivel'],
  ])('%s', (_, extra, esperado) => {
    expect(fasePacote(pacote(extra))).toBe(esperado);
  });

  it('S21: a NF-e é checada PRIMEIRO — NOT_START com nota pendente ⇒ nfe-pendente', () => {
    expect(fasePacote(pacote({ fulfillment: 'LOGISTICS_NOT_START', nfePendente: true }))).toBe(
      'nfe-pendente',
    );
    // Near-miss: the same package without the pending invoice is merely not ready.
    expect(fasePacote(pacote({ fulfillment: 'LOGISTICS_NOT_START', nfePendente: false }))).toBe(
      'nao-pronto',
    );
  });

  it('a NF-e pendente vence os tokens de antes do arranjo — e um desconhecido', () => {
    expect(fasePacote(pacote({ nfePendente: true }))).toBe('nfe-pendente');
    expect(fasePacote(pacote({ arranjado: null, nfePendente: true }))).toBe('nfe-pendente');
    expect(fasePacote(pacote({ fulfillment: 'LOGISTICS_NOT_STARTED', nfePendente: true }))).toBe(
      'nfe-pendente',
    );
    expect(fasePacote(pacote({ fulfillment: 'LOGISTICS_SEI_LA', nfePendente: true }))).toBe(
      'nfe-pendente',
    );
    // Invoice first among the pre-arrange states: it wins over pending_terms too.
    expect(fasePacote(pacote({ termosPendentes: ['SYSTEM_PENDING'], nfePendente: true }))).toBe(
      'nfe-pendente',
    );
  });

  it('R4-5: um pacote JÁ PROGRAMADO ou fora da impressão ignora um invoice_pending velho', () => {
    // Pair: every arranged / excluded phase reads as if the flag were absent…
    const casos: readonly (readonly [Partial<ObservacaoPacoteEtiqueta>, FasePacote])[] = [
      [{ fulfillment: 'LOGISTICS_REQUEST_CREATED' }, 'arranjado'],
      [{ fulfillment: 'LOGISTICS_PICKUP_RETRY' }, 'arranjado'],
      [{ arranjado: true }, 'arranjado'],
      [{ fulfillment: 'LOGISTICS_PICKUP_DONE' }, 'janela-fechada'],
      [{ fulfillment: 'LOGISTICS_DELIVERY_DONE' }, 'janela-fechada'],
      [{ fulfillment: 'LOGISTICS_REQUEST_CANCELLED' }, 'inelegivel'],
      [{ fulfillment: 'LOGISTICS_INVALID' }, 'inelegivel'],
    ];
    for (const [extra, esperado] of casos) {
      expect(fasePacote(pacote({ ...extra, nfePendente: true }))).toBe(esperado);
      expect(fasePacote(pacote({ ...extra, nfePendente: false }))).toBe(esperado);
    }
    // …near-miss: the SAME READY package, not arranged, is still held by the invoice.
    expect(fasePacote(pacote({ arranjado: false, nfePendente: true }))).toBe('nfe-pendente');
  });

  it('S22: is_shipment_arranged null conta como NÃO programado ⇒ programar', () => {
    expect(fasePacote(pacote({ arranjado: null }))).toBe('programar');
    expect(fasePacote(pacote({ arranjado: true }))).toBe('arranjado');
  });

  it('R4-2: pending_terms passa pelo leitor do passo 7 — o zero-fill não retém nada', () => {
    // Pair: Shopee's zero-fill (and a blank) ≡ no term at all.
    for (const termosPendentes of [[], ['-'], [''], ['  '], [' - '], ['-', '']]) {
      expect(fasePacote(pacote({ termosPendentes }))).toBe('programar');
    }
    // Near-miss: a real term — known or not, alone or beside a zero-fill — holds.
    for (const termosPendentes of [['SYSTEM_PENDING'], ['-', 'SYSTEM_PENDING'], ['--'], ['x']]) {
      expect(fasePacote(pacote({ termosPendentes }))).toBe('retido');
    }
  });

  it('S23: PICKUP_RETRY é programado — nunca programar de novo, mesmo com arranjado false/null', () => {
    for (const arranjado of [true, false, null]) {
      expect(fasePacote(pacote({ fulfillment: 'LOGISTICS_PICKUP_RETRY', arranjado }))).toBe(
        'arranjado',
      );
    }
  });

  it('S24: PICKUP_DONE fecha a janela — nunca arranjado, mesmo com arranjado true', () => {
    expect(fasePacote(pacote({ fulfillment: 'LOGISTICS_PICKUP_DONE', arranjado: true }))).toBe(
      'janela-fechada',
    );
  });

  it('o token é lido EXATO, como no passo 7 — nenhuma dobra de caixa, espaço ou prefixo', () => {
    for (const token of [
      ' LOGISTICS_READY',
      'LOGISTICS_READY ',
      'logistics_ready',
      'LOGISTICS_REQUEST_CANCELLED_X',
      'LOGISTICS_PENDING_ARRANGE',
      'constructor',
      'toString',
      '',
    ]) {
      expect(fasePacote(pacote({ fulfillment: token }))).toBe('desconhecido');
    }
    expect(fasePacote(pacote({ fulfillment: null }))).toBe('desconhecido');
  });

  it('todo token que o passo 7 conhece tem uma fase — nenhum cai em desconhecido', () => {
    for (const token of Object.keys(ESTADO_FRETE_DE_TOKEN_SHOPEE)) {
      expect(fasePacote(pacote({ fulfillment: token, arranjado: true }))).not.toBe('desconhecido');
    }
  });
});

/* --------------------------- decidirProximaAcao ----------------------------- */

describe('decidirProximaAcao — regra 1, a ordem', () => {
  it('FBS ⇒ pedido-fbs, antes de tudo (até de um CANCELLED)', () => {
    expect(decidir(ordem({ fbs: true, status: 'CANCELLED' }), [pacote()])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoFbs),
    );
  });

  it('CANCELLED ⇒ pedido-cancelado, mesmo com um pacote já programado', () => {
    expect(decidir(ordem({ status: 'CANCELLED' }), [pronto()])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado),
    );
  });

  it('sem pacotes ⇒ sem-pacotes', () => {
    expect(decidir(ordem({ pacotes: [] }), [])).toEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.semPacotes));
  });

  it('um pacote do corpo que a ordem não lista ⇒ pacote-inexistente (near-miss: listado segue)', () => {
    expect(decidir(ordem(), [pacote()], P2)).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteInexistente),
    );
    expect(decidir(ordem(), [pacote()], P1)).toMatchObject({ tipo: 'programar', pacote: P1 });
  });
});

describe('decidirProximaAcao — regra 2, o conjunto de trabalho', () => {
  it('todos com a janela fechada ⇒ janela-fechada', () => {
    const ps = [pacote({ fulfillment: 'LOGISTICS_PICKUP_DONE' })];
    expect(decidir(ordem(), ps)).toEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.janelaFechada));
  });

  it('todos inelegíveis ⇒ pacote-inelegivel', () => {
    const ps = [pacote({ fulfillment: 'LOGISTICS_INVALID' })];
    expect(decidir(ordem(), ps)).toEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteInelegivel));
  });

  it('um fechado e um inelegível ⇒ janela-fechada vence', () => {
    const ps = [
      pacote({ numero: P1, fulfillment: 'LOGISTICS_INVALID' }),
      pacote({ numero: P2, fulfillment: 'LOGISTICS_DELIVERY_DONE' }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.janelaFechada),
    );
  });

  it('um irmão já coletado sai da impressão — o outro segue', () => {
    const ps = [
      pacote({ numero: P1, fulfillment: 'LOGISTICS_PICKUP_DONE' }),
      pronto({ numero: P2 }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual({
      tipo: 'baixar',
      pacotes: [P2],
      tipoDocumento: 'NORMAL_AIR_WAYBILL',
    });
  });

  it('o pacote do corpo, com a janela fechada ⇒ janela-fechada (nunca o irmão no lugar)', () => {
    const ps = [
      pacote({ numero: P1, fulfillment: 'LOGISTICS_PICKUP_DONE' }),
      pronto({ numero: P2 }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps, P1)).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.janelaFechada),
    );
  });
});

describe('decidirProximaAcao — regras 3 a 5, os portões', () => {
  it('um token desconhecido ⇒ status-desconhecido', () => {
    expect(decidir(ordem(), [pacote({ fulfillment: 'LOGISTICS_NOVO' })])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido),
    );
  });

  it('um pacote listado na ordem sem linha de detalhe ⇒ status-desconhecido, nunca programar', () => {
    expect(decidir(ordem({ pacotes: [P1, P2] }), [pacote({ numero: P1 })])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido),
    );
  });

  it('NF-e pendente ⇒ nfe-pendente (a ação, não uma recusa)', () => {
    expect(decidir(ordem(), [pacote({ nfePendente: true })])).toEqual({ tipo: 'nfe-pendente' });
  });

  it('o desconhecido vem antes da NF-e; a NF-e antes do não-pronto', () => {
    const ps = [
      pacote({ numero: P1, nfePendente: true }),
      pacote({ numero: P2, fulfillment: 'LOGISTICS_NOVO' }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido),
    );
    const ps2 = [
      pacote({ numero: P1, fulfillment: 'LOGISTICS_NOT_START' }),
      pacote({ numero: P2, nfePendente: true }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps2)).toEqual({ tipo: 'nfe-pendente' });
  });

  it('não pronto ⇒ pacote-nao-pronto; retido ⇒ retido-pela-shopee', () => {
    expect(decidir(ordem(), [pacote({ fulfillment: 'LOGISTICS_NOT_START' })])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteNaoPronto),
    );
    expect(decidir(ordem(), [pacote({ termosPendentes: ['ARRANGE_SHIPMENT_PENDING'] })])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.retidoPelaShopee),
    );
  });

  it("R4-2: pending_terms ['-'] / [''] ⇒ programar; ['SYSTEM_PENDING'] ⇒ retido-pela-shopee", () => {
    for (const termosPendentes of [['-'], ['']]) {
      expect(decidir(ordem(), [pacote({ termosPendentes })])).toEqual({
        tipo: 'programar',
        pacote: P1,
        comPacote: false,
      });
    }
    expect(decidir(ordem(), [pacote({ termosPendentes: ['SYSTEM_PENDING'] })])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.retidoPelaShopee),
    );
  });

  it('R4-5: um pacote PROGRAMADO com invoice_pending velho ainda imprime (near-miss: não programado ⇒ nfe-pendente)', () => {
    expect(decidir(ordem(), [pronto({ nfePendente: true })])).toEqual({
      tipo: 'baixar',
      pacotes: [P1],
      tipoDocumento: 'NORMAL_AIR_WAYBILL',
    });
    expect(decidir(ordem(), [pacote({ nfePendente: true })])).toEqual({ tipo: 'nfe-pendente' });
  });

  it('R4-5: um irmão coletado ou inelegível com invoice_pending velho não segura a ordem', () => {
    for (const fulfillment of ['LOGISTICS_PICKUP_DONE', 'LOGISTICS_REQUEST_CANCELED']) {
      const ps = [pacote({ numero: P1, fulfillment, nfePendente: true }), pronto({ numero: P2 })];
      expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual({
        tipo: 'baixar',
        pacotes: [P2],
        tipoDocumento: 'NORMAL_AIR_WAYBILL',
      });
    }
    // Alone, they refuse for what they ARE — never an NF-e re-drive.
    expect(
      decidir(ordem(), [pacote({ fulfillment: 'LOGISTICS_PICKUP_DONE', nfePendente: true })]),
    ).toEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.janelaFechada));
    expect(
      decidir(ordem(), [pacote({ fulfillment: 'LOGISTICS_INVALID', nfePendente: true })]),
    ).toEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteInelegivel));
  });
});

describe('decidirProximaAcao — regra 6, programar', () => {
  it('R2-5: READY com arranjado null ⇒ programar, nunca um passo do documento (a escolha, fixada)', () => {
    // The row a `frete.read` caller meets as the arrange's 403: chosen, not incidental.
    expect(decidir(ordem(), [pacote({ arranjado: null, rastreio: RASTREIO })])).toEqual({
      tipo: 'programar',
      pacote: P1,
      comPacote: false,
    });
    // Near-miss: the same package reported arranged goes on to the tracking number.
    expect(decidir(ordem(), [pacote({ arranjado: true })])).toEqual({
      tipo: 'buscar-rastreio',
      pacotes: [P1],
    });
  });

  it('S29: pedido de UM pacote ⇒ programar SEM package_number', () => {
    expect(decidir(ordem(), [pacote()])).toEqual({
      tipo: 'programar',
      pacote: P1,
      comPacote: false,
    });
  });

  it('pedido dividido ⇒ programar COM package_number, um pacote por decisão', () => {
    const ps = [pacote({ numero: P1 }), pacote({ numero: P2 })];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual({
      tipo: 'programar',
      pacote: P1,
      comPacote: true,
    });
  });

  it('um pacote programado e outro não ⇒ programa o que falta antes de buscar rastreio', () => {
    const ps = [
      pacote({ numero: P1, fulfillment: 'LOGISTICS_REQUEST_CREATED', arranjado: true }),
      pacote({ numero: P2 }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual({
      tipo: 'programar',
      pacote: P2,
      comPacote: true,
    });
  });

  it('o pacote do corpo num pedido dividido ⇒ comPacote continua true (a ordem é dividida)', () => {
    const ps = [pronto({ numero: P1 }), pacote({ numero: P2 })];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps, P2)).toEqual({
      tipo: 'programar',
      pacote: P2,
      comPacote: true,
    });
  });

  it('um package_number repetido na ordem não conta como divisão', () => {
    expect(decidir(ordem({ pacotes: [P1, P1] }), [pacote()])).toEqual({
      tipo: 'programar',
      pacote: P1,
      comPacote: false,
    });
  });

  it('IN_CANCEL recusa SÓ na hora de programar (R-v) — um pacote já programado ainda imprime', () => {
    expect(decidir(ordem({ status: 'IN_CANCEL' }), [pacote()])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoEmCancelamento),
    );
    expect(decidir(ordem({ status: 'IN_CANCEL' }), [pronto()])).toEqual({
      tipo: 'baixar',
      pacotes: [P1],
      tipoDocumento: 'NORMAL_AIR_WAYBILL',
    });
  });
});

describe('decidirProximaAcao — regras 7 a 12, o documento', () => {
  it('programado sem rastreio ⇒ buscar-rastreio só dos que faltam', () => {
    const ps = [
      pronto({ numero: P1 }),
      pronto({ numero: P2, rastreio: null, tipoDocumento: null, documento: 'desconhecido' }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual({
      tipo: 'buscar-rastreio',
      pacotes: [P2],
    });
  });

  it('o sentinela "-" (e o vazio) NÃO é rastreio — near-miss: um número real segue', () => {
    for (const rastreio of ['-', '', '  ']) {
      expect(decidir(ordem(), [pronto({ rastreio, tipoDocumento: null })])).toEqual({
        tipo: 'buscar-rastreio',
        pacotes: [P1],
      });
    }
    expect(decidir(ordem(), [pronto({ tipoDocumento: null })])).toEqual({
      tipo: 'ler-parametros-documento',
      pacotes: [P1],
    });
  });

  it('sem tipo de documento ⇒ ler-parametros-documento', () => {
    expect(decidir(ordem(), [pronto({ tipoDocumento: null, documento: 'desconhecido' })])).toEqual({
      tipo: 'ler-parametros-documento',
      pacotes: [P1],
    });
  });

  it('documento em estado desconhecido ⇒ ler-resultado', () => {
    expect(decidir(ordem(), [pronto({ documento: 'desconhecido' })])).toEqual({
      tipo: 'ler-resultado',
      pacotes: [P1],
    });
  });

  it('documento inexistente, ou falhou uma vez ⇒ criar-documento', () => {
    expect(decidir(ordem(), [pronto({ documento: 'inexistente' })])).toEqual({
      tipo: 'criar-documento',
      pacotes: [P1],
    });
    expect(decidir(ordem(), [pronto({ documento: 'falhou' })])).toEqual({
      tipo: 'criar-documento',
      pacotes: [P1],
    });
  });

  it('falhou DE NOVO depois de recriado nesta chamada ⇒ documento-falhou, antes de criar o irmão', () => {
    expect(decidir(ordem(), [pronto({ documento: 'falhou', recriadoNestaChamada: true })])).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.documentoFalhou),
    );
    const ps = [
      pronto({ numero: P1, documento: 'inexistente' }),
      pronto({ numero: P2, documento: 'falhou', recriadoNestaChamada: true }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.documentoFalhou),
    );
  });

  it('um recriado que ficou pronto não recusa nada', () => {
    expect(decidir(ordem(), [pronto({ recriadoNestaChamada: true })])).toMatchObject({
      tipo: 'baixar',
    });
  });

  it('processando ⇒ aguardar-documento', () => {
    expect(decidir(ordem(), [pronto({ documento: 'processando' })])).toEqual({
      tipo: 'aguardar-documento',
    });
  });

  it('tudo pronto no mesmo canal ⇒ UM download com os pacotes na ordem da Shopee', () => {
    const ps = [pronto({ numero: P2 }), pronto({ numero: P1 })];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual({
      tipo: 'baixar',
      pacotes: [P1, P2],
      tipoDocumento: 'NORMAL_AIR_WAYBILL',
    });
  });

  it('canais diferentes ⇒ por-pacote; com o pacote no corpo ⇒ baixa só ele', () => {
    const ps = [pronto({ numero: P1, canalId: 1 }), pronto({ numero: P2, canalId: 2 })];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual({
      tipo: 'por-pacote',
      pacotes: [P1, P2],
    });
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps, P2)).toEqual({
      tipo: 'baixar',
      pacotes: [P2],
      tipoDocumento: 'NORMAL_AIR_WAYBILL',
    });
  });

  it('mesmo canal com tipos de documento diferentes ⇒ por-pacote (o download leva UM tipo)', () => {
    const ps = [
      pronto({ numero: P1 }),
      pronto({ numero: P2, tipoDocumento: 'THERMAL_AIR_WAYBILL' }),
    ];
    expect(decidir(ordem({ pacotes: [P1, P2] }), ps)).toEqual({
      tipo: 'por-pacote',
      pacotes: [P1, P2],
    });
  });

  it('é pura: não muda as entradas, e a mesma entrada dá a mesma ação', () => {
    const o = Object.freeze(ordem({ pacotes: Object.freeze([P1, P2]) }));
    const ps = Object.freeze([
      Object.freeze(pronto({ numero: P1 })),
      Object.freeze(pacote({ numero: P2 })),
    ]);
    const a = decidirProximaAcao(o, ps, { pacote: null });
    const b = decidirProximaAcao(o, ps, { pacote: null });
    expect(a).toEqual(b);
    expect(a).toEqual({ tipo: 'programar', pacote: P2, comPacote: true });
  });

  it('R5-7: três parâmetros, nenhum relógio (o quarto do seam não tinha leitor)', () => {
    expect(decidirProximaAcao.length).toBe(3);
  });
});

/* --------------------------- gruposDeDownload ------------------------------- */

describe('gruposDeDownload', () => {
  it('agrupa por canal, mantendo a ordem da Shopee', () => {
    const P3 = 'OFG000000000003';
    const ps = [
      pronto({ numero: P1, canalId: 1 }),
      pronto({ numero: P2, canalId: 2 }),
      pronto({ numero: P3, canalId: 1 }),
    ];
    expect(gruposDeDownload(ps)).toEqual([[P1, P3], [P2]]);
  });

  it('canal null é um grupo SÓ seu — near-miss: dois null nunca se juntam', () => {
    const ps = [pronto({ numero: P1, canalId: null }), pronto({ numero: P2, canalId: null })];
    expect(gruposDeDownload(ps)).toEqual([[P1], [P2]]);
  });

  it('nenhum pacote ⇒ nenhum grupo', () => {
    expect(gruposDeDownload([])).toEqual([]);
  });
});

/* ------------------------------- progressoDe -------------------------------- */

describe('progressoDe', () => {
  it('conta organizados (programado OU já coletado), com rastreio e prontos', () => {
    const ps = [
      pronto({ numero: P1 }),
      pronto({ numero: P2, rastreio: '-', documento: 'processando' }),
      pacote({ numero: 'OFG000000000003' }),
      pacote({
        numero: 'OFG000000000004',
        fulfillment: 'LOGISTICS_PICKUP_DONE',
        rastreio: RASTREIO,
      }),
    ];
    expect(progressoDe(ps)).toEqual({ total: 4, organizados: 3, comRastreio: 2, prontos: 1 });
  });

  it('nada programado ⇒ organizados 0 (a mensagem de desistência NÃO diz "organizado")', () => {
    expect(progressoDe([pacote()])).toEqual({
      total: 1,
      organizados: 0,
      comRastreio: 0,
      prontos: 0,
    });
  });

  it('R4-5: um pacote programado com invoice_pending velho conta como organizado', () => {
    expect(progressoDe([pronto({ nfePendente: true })])).toEqual({
      total: 1,
      organizados: 1,
      comRastreio: 1,
      prontos: 1,
    });
    // Near-miss: a READY one nobody arranged, held by the invoice, is not.
    expect(progressoDe([pacote({ nfePendente: true })])).toMatchObject({ organizados: 0 });
  });

  it('lista vazia ⇒ tudo zero', () => {
    expect(progressoDe([])).toEqual({ total: 0, organizados: 0, comRastreio: 0, prontos: 0 });
  });
});

/* ------------------------- o que a ordem pergunta ---------------------------- */

describe('SHOPEE_ETIQUETA_DETALHE_CAMPOS — o que a observação da ordem lê', () => {
  it('é exatamente package_list + fulfillment_flag (Apêndice A: sem pay_time)', () => {
    expect([...SHOPEE_ETIQUETA_DETALHE_CAMPOS]).toEqual(['package_list', 'fulfillment_flag']);
  });

  it('cada campo é um token opcional real de get_order_detail; order_status NÃO é (é campo base)', () => {
    const opcionais = SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS.split(',');
    for (const campo of SHOPEE_ETIQUETA_DETALHE_CAMPOS) expect(opcionais).toContain(campo);
    expect(opcionais).not.toContain('order_status');
  });

  it('nunca pede a chave da NF-e, o comprador ou o pagamento', () => {
    for (const proibido of [
      'pay_time',
      'invoice_data',
      'recipient_address',
      'buyer_cpf_id',
      'buyer_username',
      'order_status',
    ]) {
      expect(SHOPEE_ETIQUETA_DETALHE_CAMPOS as readonly string[]).not.toContain(proibido);
    }
  });
});

/* ===================== step 15b — the automatic arrange ===================== */

const ORDER_SN = '260910KJBHUJDM';
const TURBO = 90011;

/** A raw `get_package_detail` row through the REAL package schema (defaults applied). */
function linhaDePacote(extra: Record<string, unknown> = {}): ShopeePackageDetailRow {
  return shopeePackageDetailRowSchema.parse({
    order_sn: ORDER_SN,
    package_number: P1,
    fulfillment_status: 'LOGISTICS_READY',
    logistics_channel_id: TURBO,
    is_shipment_arranged: false,
    ...extra,
  });
}

/** A raw `get_order_detail` row through the REAL package schema (defaults applied). */
function linhaDeOrdem(extra: Record<string, unknown> = {}): ShopeeOrderDetailRow {
  return shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    order_status: 'READY_TO_SHIP',
    package_list: [{ package_number: P1 }],
    fulfillment_flag: 'fulfilled_by_local_seller',
    ...extra,
  });
}

/** A READY package on a 1573 channel that nobody arranged — the `candidato`. */
function turbo(extra: Partial<ObservacaoPacoteEtiqueta> = {}): ObservacaoPacoteEtiqueta {
  return pacote({ canalId: TURBO, ...extra });
}

/** Every token step 7 knows, plus tokens nobody knows (the `desconhecido` side). */
const TOKENS: readonly string[] = [
  ...Object.keys(ESTADO_FRETE_DE_TOKEN_SHOPEE),
  'LOGISTICS_NOVO',
  'LOGISTICS_PENDING_ARRANGE',
  'logistics_ready',
];

describe('faseDoTokenShopee — a metade do TOKEN de fasePacote (15b)', () => {
  it.each<[string, FasePacote]>([
    ['LOGISTICS_NOT_START', 'nao-pronto'],
    ['LOGISTICS_NOT_STARTED', 'nao-pronto'],
    ['LOGISTICS_READY', 'programar'],
    ['LOGISTICS_REQUEST_CREATED', 'arranjado'],
    ['LOGISTICS_PICKUP_RETRY', 'arranjado'],
    ['LOGISTICS_PICKUP_DONE', 'janela-fechada'],
    ['LOGISTICS_DELIVERY_DONE', 'janela-fechada'],
    ['LOGISTICS_DELIVERY_FAILED', 'janela-fechada'],
    ['LOGISTICS_LOST', 'janela-fechada'],
    ['LOGISTICS_INVALID', 'inelegivel'],
    ['LOGISTICS_REQUEST_CANCELED', 'inelegivel'],
    ['LOGISTICS_REQUEST_CANCELLED', 'inelegivel'],
    ['LOGISTICS_PICKUP_FAILED', 'inelegivel'],
    ['LOGISTICS_COD_REJECTED', 'inelegivel'],
  ])('%s ⇒ %s', (token, esperado) => {
    expect(faseDoTokenShopee(token)).toBe(esperado);
  });

  it('a tabela cobre TODO token do passo 7 — nenhum cai em desconhecido', () => {
    for (const token of Object.keys(ESTADO_FRETE_DE_TOKEN_SHOPEE)) {
      expect(faseDoTokenShopee(token), token).not.toBe('desconhecido');
    }
  });

  it('lido EXATO: espaço, caixa, sufixo, protótipo, vazio e null ⇒ desconhecido', () => {
    for (const token of [
      ' LOGISTICS_READY',
      'LOGISTICS_READY ',
      'logistics_ready',
      'LOGISTICS_REQUEST_CANCELLED_X',
      'LOGISTICS_PENDING_ARRANGE',
      'constructor',
      'toString',
      '__proto__',
      '',
    ]) {
      expect(faseDoTokenShopee(token), token).toBe('desconhecido');
    }
    expect(faseDoTokenShopee(null)).toBe('desconhecido');
  });

  it('fasePacote é faseDoTokenShopee + os refinamentos: sem arranjo, NF-e nem termo, as duas concordam', () => {
    for (const token of TOKENS) {
      for (const arranjado of [false, null]) {
        expect(fasePacote(pacote({ fulfillment: token, arranjado })), token).toBe(
          faseDoTokenShopee(token),
        );
      }
    }
    expect(fasePacote(pacote({ fulfillment: null }))).toBe(faseDoTokenShopee(null));
    // Near-miss: only fasePacote refines READY — the token half alone cannot know it is arranged.
    expect(faseDoTokenShopee('LOGISTICS_READY')).toBe('programar');
    expect(fasePacote(pacote({ arranjado: true }))).toBe('arranjado');
  });
});

describe('os canais do anúncio 1573 (15b)', () => {
  it('CANAIS_ARRANJO_AUTOMATICO é exatamente 90011, 90012 e 90026 — NÚMEROS (mutantes 1 e 2)', () => {
    expect([...CANAIS_ARRANJO_AUTOMATICO]).toEqual([90011, 90012, 90026]);
    for (const canal of CANAIS_ARRANJO_AUTOMATICO) expect(typeof canal).toBe('number');
  });

  it('CANAIS_ETIQUETA_COM_PRAZO é exatamente 90011 e 90012 — um SUBCONJUNTO do arranjo, sem o 90026 (mutante 5)', () => {
    expect([...CANAIS_ETIQUETA_COM_PRAZO]).toEqual([90011, 90012]);
    const arranjo: readonly number[] = CANAIS_ARRANJO_AUTOMATICO;
    for (const canal of CANAIS_ETIQUETA_COM_PRAZO) {
      expect(arranjo).toContain(canal);
      expect(ehCanalDeArranjoAutomatico(canal)).toBe(true);
    }
    // Near-miss: 1573 names 90026 for the arrange and leaves it out of the print alert.
    expect(ehCanalDeArranjoAutomatico(90026)).toBe(true);
    expect(ehCanalDeEtiquetaComPrazo(90026)).toBe(false);
  });

  it.each([90011, 90012, 90026])('arranjo automático: %i ⇒ true', (canal) => {
    expect(ehCanalDeArranjoAutomatico(canal)).toBe(true);
  });

  it.each([90021, 90025, 9001, 900110, 90013, 0, -90011, Number.NaN])(
    'arranjo automático, near-miss: %d ⇒ false',
    (canal) => {
      expect(ehCanalDeArranjoAutomatico(canal)).toBe(false);
    },
  );

  it.each([90011, 90012])('etiqueta com prazo: %i ⇒ true', (canal) => {
    expect(ehCanalDeEtiquetaComPrazo(canal)).toBe(true);
  });

  it.each([90026, 90021, 90025, 9001, 0, Number.NaN])(
    'etiqueta com prazo, near-miss: %d ⇒ false',
    (canal) => {
      expect(ehCanalDeEtiquetaComPrazo(canal)).toBe(false);
    },
  );

  it('canal null nunca é um canal — nos dois predicados (mutante 4)', () => {
    expect(ehCanalDeArranjoAutomatico(null)).toBe(false);
    expect(ehCanalDeEtiquetaComPrazo(null)).toBe(false);
  });

  it("a GRAFIA em string de um id não casa — '90011' ≠ 90011 (mutante 3)", () => {
    // The wire string is coerced by the schema BEFORE it reaches the predicate
    // (see the round trip below); a string that reaches it raw is not a channel.
    const comoTexto = '90011' as unknown as number;
    expect(ehCanalDeArranjoAutomatico(comoTexto)).toBe(false);
    expect(ehCanalDeEtiquetaComPrazo(comoTexto)).toBe(false);
  });
});

describe('observacaoDoPacoteShopee — a linha FRESCA do get_package_detail (15b)', () => {
  it('projeta cada campo da linha — e nada que só a chamada aprendeu', () => {
    const linha = linhaDePacote({
      package_number: ` ${P1} `,
      logistics_channel_id: '90012',
      is_shipment_arranged: true,
      pending_terms: ['SYSTEM_PENDING'],
      invoice_pending: { status: ' Pending ', pending_reason: null },
      tracking_number: ` ${RASTREIO} `,
    });
    expect(observacaoDoPacoteShopee(linha)).toEqual({
      numero: P1,
      canalId: 90012,
      fulfillment: 'LOGISTICS_READY',
      arranjado: true,
      termosPendentes: ['SYSTEM_PENDING'],
      nfePendente: true,
      rastreio: RASTREIO,
      tipoDocumento: null,
      documento: 'desconhecido',
      recriadoNestaChamada: false,
    });
  });

  it('a linha mínima: os defaults do schema viram uma observação neutra — arranjado null CONTINUA null', () => {
    const linha = shopeePackageDetailRowSchema.parse({ order_sn: ORDER_SN, package_number: P2 });
    expect(observacaoDoPacoteShopee(linha)).toEqual({
      numero: P2,
      canalId: null,
      fulfillment: null,
      arranjado: null,
      termosPendentes: [],
      nfePendente: false,
      rastreio: null,
      tipoDocumento: null,
      documento: 'desconhecido',
      recriadoNestaChamada: false,
    });
  });

  it('a dobra da NF-e: só "pending" (aparado, sem caixa) segura — near-miss: valid, pendente, sufixos, vazio, ausente', () => {
    // Pair: the spellings that must fold to "pending".
    for (const status of ['pending', 'PENDING', ' Pending\t']) {
      const linha = linhaDePacote({ invoice_pending: { status } });
      expect(observacaoDoPacoteShopee(linha).nfePendente, status).toBe(true);
    }
    // Near-miss: everything else — a neighbour word included — must stay distinct.
    for (const invoice_pending of [
      { status: 'valid' },
      { status: 'pendente' },
      { status: 'pending_review' },
      { status: 'not pending' },
      { status: '' },
      { status: null },
      {},
      null,
    ]) {
      const linha = linhaDePacote({ invoice_pending });
      expect(observacaoDoPacoteShopee(linha).nfePendente, JSON.stringify(invoice_pending)).toBe(
        false,
      );
    }
  });

  it('o rastreio passa pelo leitor do passo 7: "-", vazio e branco ⇒ null — near-miss: um número com hífen fica', () => {
    for (const tracking_number of ['-', ' - ', '', '   ', null]) {
      expect(observacaoDoPacoteShopee(linhaDePacote({ tracking_number })).rastreio).toBeNull();
    }
    expect(
      observacaoDoPacoteShopee(linhaDePacote({ tracking_number: 'BR-000000000T' })).rastreio,
    ).toBe('BR-000000000T');
  });

  it("R4-2: pending_terms ['-'] chega CRU e fasePacote o descarta — near-miss: um termo real retém", () => {
    const zeroFill = observacaoDoPacoteShopee(linhaDePacote({ pending_terms: ['-'] }));
    expect(zeroFill.termosPendentes).toEqual(['-']);
    expect(fasePacote(zeroFill)).toBe('programar');
    const real = observacaoDoPacoteShopee(linhaDePacote({ pending_terms: ['SYSTEM_PENDING'] }));
    expect(fasePacote(real)).toBe('retido');
  });
});

describe('observacaoDaOrdemShopee — a linha do get_order_detail (15b)', () => {
  it('linha nula ⇒ nada observado — e a decisão recusa sem-pacotes', () => {
    const o = observacaoDaOrdemShopee(null);
    expect(o).toEqual({ status: null, fbs: false, pacotes: [] });
    expect(decidirProximaAcao(o, [], { pacote: null })).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.semPacotes),
    );
  });

  it('a dobra do FBS: fulfilled_by_shopee aparado e sem caixa — near-miss: o vendedor local, o cross-border, um sufixo', () => {
    for (const fulfillment_flag of ['fulfilled_by_shopee', ' FULFILLED_BY_SHOPEE ']) {
      expect(observacaoDaOrdemShopee(linhaDeOrdem({ fulfillment_flag })).fbs).toBe(true);
    }
    for (const fulfillment_flag of [
      'fulfilled_by_local_seller',
      'fulfilled_by_cb_seller',
      'fulfilled_by_shopee_x',
      'shopee',
      '',
      null,
    ]) {
      expect(
        observacaoDaOrdemShopee(linhaDeOrdem({ fulfillment_flag })).fbs,
        String(fulfillment_flag),
      ).toBe(false);
    }
  });

  it('pacotes pelo leitor do passo 7, sem repetição, na ordem da Shopee', () => {
    const linha = linhaDeOrdem({
      package_list: [
        { package_number: P2 },
        { package_number: '-' },
        { package_number: null },
        { package_number: ` ${P1} ` },
        { package_number: P2 },
        {},
      ],
    });
    expect(observacaoDaOrdemShopee(linha).pacotes).toEqual([P2, P1]);
    expect(observacaoDaOrdemShopee(linhaDeOrdem({ package_list: null })).pacotes).toEqual([]);
  });

  it('o status chega VERBATIM — IN_CANCEL e CANCELLED como a Shopee mandou', () => {
    for (const order_status of ['IN_CANCEL', 'CANCELLED', 'READY_TO_SHIP']) {
      expect(observacaoDaOrdemShopee(linhaDeOrdem({ order_status })).status).toBe(order_status);
    }
  });

  it('o corpo do SG (fixture): READY_TO_SHIP, o vendedor local NÃO é FBS, e só três chaves — nenhum relógio (R-f)', () => {
    const linha =
      lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list.find(
        (r) => r.order_sn === ORDER_SN,
      ) ?? null;
    expect(linha).not.toBeNull();
    const o = observacaoDaOrdemShopee(linha);
    expect(Object.keys(o).sort()).toEqual(['fbs', 'pacotes', 'status']);
    expect(o.status).toBe('READY_TO_SHIP');
    expect(o.fbs).toBe(false);
    expect(o.pacotes).toEqual(
      (linha?.package_list ?? []).map((p) => (p.package_number ?? '').trim()),
    );
    expect(o.pacotes).toHaveLength(1);
  });
});

describe('elegibilidadeDoArranjoAutomatico — o CANAL primeiro, depois fasePacote (15b)', () => {
  const candidato: ElegibilidadeDoArranjo = { tipo: 'candidato' };
  const fora: ElegibilidadeDoArranjo = { tipo: 'fora-do-canal' };

  it.each([90011, 90012, 90026])(
    'um pacote pronto e não programado no canal %i é candidato',
    (canalId) => {
      expect(elegibilidadeDoArranjoAutomatico(pacote({ canalId }))).toEqual(candidato);
    },
  );

  it.each([1, 90021, 90025, null])(
    'canal %s ⇒ fora-do-canal, mesmo pronto para programar',
    (canalId) => {
      expect(elegibilidadeDoArranjoAutomatico(pacote({ canalId }))).toEqual(fora);
    },
  );

  it('mutante 6: o canal vem ANTES da fase — fora do canal com NF-e pendente é fora-do-canal', () => {
    expect(elegibilidadeDoArranjoAutomatico(pacote({ canalId: 1, nfePendente: true }))).toEqual(
      fora,
    );
    expect(
      elegibilidadeDoArranjoAutomatico(
        pacote({ canalId: null, fulfillment: 'LOGISTICS_NOT_START', nfePendente: true }),
      ),
    ).toEqual(fora);
    // Near-miss: the SAME row on a Turbo channel is the hook's nfe-pendente.
    expect(elegibilidadeDoArranjoAutomatico(turbo({ nfePendente: true }))).toEqual({
      tipo: 'fase',
      fase: 'nfe-pendente',
    });
  });

  it('fora do canal, QUALQUER fase é fora-do-canal — programado, desconhecido, coletado', () => {
    for (const extra of [
      { arranjado: true },
      { fulfillment: 'LOGISTICS_NOVO' },
      { fulfillment: 'LOGISTICS_PICKUP_DONE' },
      { termosPendentes: ['SYSTEM_PENDING'] },
    ]) {
      expect(elegibilidadeDoArranjoAutomatico(pacote({ canalId: 1, ...extra }))).toEqual(fora);
    }
  });

  it('S22 (mutante 7): is_shipment_arranged null ⇒ candidato; true ⇒ fase arranjado', () => {
    expect(elegibilidadeDoArranjoAutomatico(turbo({ arranjado: null }))).toEqual(candidato);
    expect(elegibilidadeDoArranjoAutomatico(turbo({ arranjado: true }))).toEqual({
      tipo: 'fase',
      fase: 'arranjado',
    });
  });

  it('PICKUP_RETRY (mutante 8) é arranjado, nunca candidato — com arranjado false, null ou true', () => {
    for (const arranjado of [false, null, true]) {
      expect(
        elegibilidadeDoArranjoAutomatico(
          turbo({ fulfillment: 'LOGISTICS_PICKUP_RETRY', arranjado }),
        ),
      ).toEqual({ tipo: 'fase', fase: 'arranjado' });
    }
  });

  it("R4-2 (mutante 9): pending_terms ['-'] ⇒ candidato; um termo real ⇒ fase retido", () => {
    for (const termosPendentes of [['-'], [''], ['  ', '-']]) {
      expect(elegibilidadeDoArranjoAutomatico(turbo({ termosPendentes }))).toEqual(candidato);
    }
    for (const termosPendentes of [['SYSTEM_PENDING'], ['-', 'KYC_PENDING']]) {
      expect(elegibilidadeDoArranjoAutomatico(turbo({ termosPendentes }))).toEqual({
        tipo: 'fase',
        fase: 'retido',
      });
    }
  });

  it.each<[string, Partial<ObservacaoPacoteEtiqueta>, FasePacote]>([
    ['NOT_START', { fulfillment: 'LOGISTICS_NOT_START' }, 'nao-pronto'],
    ['REQUEST_CREATED', { fulfillment: 'LOGISTICS_REQUEST_CREATED' }, 'arranjado'],
    ['PICKUP_DONE', { fulfillment: 'LOGISTICS_PICKUP_DONE' }, 'janela-fechada'],
    ['INVALID', { fulfillment: 'LOGISTICS_INVALID' }, 'inelegivel'],
    ['REQUEST_CANCELLED', { fulfillment: 'LOGISTICS_REQUEST_CANCELLED' }, 'inelegivel'],
    ['um token desconhecido', { fulfillment: 'LOGISTICS_NOVO' }, 'desconhecido'],
    ['sem token', { fulfillment: null }, 'desconhecido'],
    ['NF-e pendente', { nfePendente: true }, 'nfe-pendente'],
  ])('no canal Turbo, %s ⇒ fase %s', (_, extra, fase) => {
    expect(elegibilidadeDoArranjoAutomatico(turbo(extra))).toEqual({ tipo: 'fase', fase });
  });

  it('é fasePacote, não uma cópia: candidato ⇔ programar em todo o produto token × arranjado × NF-e × termos', () => {
    for (const fulfillment of TOKENS) {
      for (const arranjado of [true, false, null]) {
        for (const nfePendente of [true, false]) {
          for (const termosPendentes of [[], ['-'], ['SYSTEM_PENDING']]) {
            const p = turbo({ fulfillment, arranjado, nfePendente, termosPendentes });
            const fase = fasePacote(p);
            const esperado: ElegibilidadeDoArranjo =
              fase === 'programar' ? candidato : { tipo: 'fase', fase };
            expect(elegibilidadeDoArranjoAutomatico(p)).toEqual(esperado);
            // …and the same package off-channel is never anything but fora-do-canal.
            expect(elegibilidadeDoArranjoAutomatico({ ...p, canalId: 90021 })).toEqual(fora);
          }
        }
      }
    }
  });

  it('mutante 10: decide a linha FRESCA — uma linha já programada nunca é candidata', () => {
    for (const extra of [
      { is_shipment_arranged: true },
      { fulfillment_status: 'LOGISTICS_REQUEST_CREATED' },
      { fulfillment_status: 'LOGISTICS_PICKUP_RETRY', is_shipment_arranged: null },
    ]) {
      expect(
        elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(linhaDePacote(extra))),
      ).toEqual({ tipo: 'fase', fase: 'arranjado' });
    }
    // Near-miss: the same fresh row, not arranged, is the candidate.
    expect(elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(linhaDePacote()))).toEqual(
      candidato,
    );
  });

  it('ida e volta: linha crua (canal em string) → schema → projeção → elegibilidade', () => {
    const turboEmTexto = linhaDePacote({ logistics_channel_id: '90011' });
    expect(elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(turboEmTexto))).toEqual(
      candidato,
    );
    const xpressEmTexto = linhaDePacote({ logistics_channel_id: '90021' });
    expect(elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(xpressEmTexto))).toEqual(fora);
    const pendente = linhaDePacote({ invoice_pending: { status: 'pending' } });
    expect(elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(pendente))).toEqual({
      tipo: 'fase',
      fase: 'nfe-pendente',
    });
  });
});

describe('decidirArranjoAutomatico — o ladder do passo 15 sobre UM pacote (15b)', () => {
  it('pedido de UM pacote ⇒ programar SEM package_number', () => {
    expect(decidirArranjoAutomatico(ordem(), turbo())).toEqual({
      tipo: 'programar',
      comPacote: false,
    });
  });

  it('mutante 14: pedido de DOIS pacotes ⇒ programar COM package_number, para qualquer dos dois', () => {
    const o = ordem({ pacotes: [P1, P2] });
    expect(decidirArranjoAutomatico(o, turbo({ numero: P1 }))).toEqual({
      tipo: 'programar',
      comPacote: true,
    });
    expect(decidirArranjoAutomatico(o, turbo({ numero: P2 }))).toEqual({
      tipo: 'programar',
      comPacote: true,
    });
    // Near-miss: a package number repeated by the order is not a split.
    expect(decidirArranjoAutomatico(ordem({ pacotes: [P1, P1] }), turbo())).toEqual({
      tipo: 'programar',
      comPacote: false,
    });
  });

  it('mutante 12: IN_CANCEL ⇒ recusa pedido-em-cancelamento — near-miss: READY_TO_SHIP programa', () => {
    expect(decidirArranjoAutomatico(ordem({ status: 'IN_CANCEL' }), turbo())).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoEmCancelamento),
    );
    expect(decidirArranjoAutomatico(ordem({ status: 'READY_TO_SHIP' }), turbo())).toMatchObject({
      tipo: 'programar',
    });
  });

  it('mutante 13: CANCELLED ⇒ pedido-cancelado; FBS ⇒ pedido-fbs (o FBS vence o CANCELLED)', () => {
    expect(decidirArranjoAutomatico(ordem({ status: 'CANCELLED' }), turbo())).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado),
    );
    expect(decidirArranjoAutomatico(ordem({ fbs: true }), turbo())).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoFbs),
    );
    expect(decidirArranjoAutomatico(ordem({ fbs: true, status: 'CANCELLED' }), turbo())).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoFbs),
    );
  });

  it('mutante 15 (a defesa): uma ordem que não lista o pacote ⇒ pacote-inexistente; ordem nula ⇒ sem-pacotes', () => {
    // A row of ANOTHER order (matched by position, say) lists other packages.
    expect(decidirArranjoAutomatico(ordem({ pacotes: [P2] }), turbo({ numero: P1 }))).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteInexistente),
    );
    expect(decidirArranjoAutomatico(observacaoDaOrdemShopee(null), turbo())).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.semPacotes),
    );
  });

  it.each<[string, Partial<ObservacaoPacoteEtiqueta>, unknown]>([
    ['NF-e pendente', { nfePendente: true }, { tipo: 'nfe-pendente' }],
    [
      'retido',
      { termosPendentes: ['SYSTEM_PENDING'] },
      recusa(MOTIVO_ETIQUETA_SHOPEE.retidoPelaShopee),
    ],
    [
      'não pronto',
      { fulfillment: 'LOGISTICS_NOT_START' },
      recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteNaoPronto),
    ],
    [
      'coletado',
      { fulfillment: 'LOGISTICS_PICKUP_DONE' },
      recusa(MOTIVO_ETIQUETA_SHOPEE.janelaFechada),
    ],
    [
      'inelegível',
      { fulfillment: 'LOGISTICS_INVALID' },
      recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteInelegivel),
    ],
    [
      'token desconhecido',
      { fulfillment: 'LOGISTICS_NOVO' },
      recusa(MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido),
    ],
  ])('%s ⇒ a resposta do passo 15, tal qual', (_, extra, esperado) => {
    expect(decidirArranjoAutomatico(ordem(), turbo(extra))).toEqual(esperado);
  });

  it.each<[AcaoEtiqueta['tipo'], Partial<ObservacaoPacoteEtiqueta>]>([
    ['buscar-rastreio', { arranjado: true }],
    ['ler-parametros-documento', { arranjado: true, rastreio: RASTREIO }],
    ['ler-resultado', { arranjado: true, rastreio: RASTREIO, tipoDocumento: 'NORMAL_AIR_WAYBILL' }],
    [
      'criar-documento',
      {
        arranjado: true,
        rastreio: RASTREIO,
        tipoDocumento: 'NORMAL_AIR_WAYBILL',
        documento: 'inexistente',
      },
    ],
    [
      'aguardar-documento',
      {
        arranjado: true,
        rastreio: RASTREIO,
        tipoDocumento: 'NORMAL_AIR_WAYBILL',
        documento: 'processando',
      },
    ],
    [
      'baixar',
      {
        arranjado: true,
        rastreio: RASTREIO,
        tipoDocumento: 'NORMAL_AIR_WAYBILL',
        documento: 'pronto',
      },
    ],
  ])(
    'um passo de DOCUMENTO (%s) ⇒ recusa status-desconhecido — nunca agir no que não sabe explicar',
    (tipo, extra) => {
      const p = turbo(extra);
      // The arm IS reached: step 15 answers that document step for this package…
      expect(decidirProximaAcao(ordem(), [p], { pacote: p.numero }).tipo).toBe(tipo);
      // …and the arrange refuses it.
      expect(decidirArranjoAutomatico(ordem(), p)).toEqual(
        recusa(MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido),
      );
    },
  );

  it('um CANDIDATO nunca chega a um passo de documento: é decidirProximaAcao, mapeado sem perda', () => {
    const candidatos = [
      turbo(),
      turbo({ arranjado: null }),
      turbo({ termosPendentes: ['-'] }),
      turbo({ numero: P2, canalId: 90026 }),
    ];
    const ordens = [
      ordem(),
      ordem({ pacotes: [P1, P2] }),
      ordem({ pacotes: [P2] }),
      ordem({ status: 'IN_CANCEL', pacotes: [P1, P2] }),
      ordem({ status: 'CANCELLED' }),
      ordem({ fbs: true }),
      ordem({ pacotes: [] }),
    ];
    for (const p of candidatos) {
      expect(elegibilidadeDoArranjoAutomatico(p)).toEqual({ tipo: 'candidato' });
      for (const o of ordens) {
        const acao = decidirProximaAcao(o, [p], { pacote: p.numero });
        expect(['programar', 'recusa']).toContain(acao.tipo);
        const decisao = decidirArranjoAutomatico(o, p);
        if (acao.tipo === 'programar') {
          expect(decisao).toEqual({ tipo: 'programar', comPacote: acao.comPacote });
        } else {
          expect(decisao).toEqual(acao);
          expect(decisao).not.toEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido));
        }
      }
    }
  });

  it('é pura e de dois parâmetros — nenhum relógio, nenhuma entrada mudada', () => {
    expect(decidirArranjoAutomatico.length).toBe(2);
    const o = Object.freeze(ordem({ pacotes: Object.freeze([P1, P2]) }));
    const p = Object.freeze(turbo());
    expect(decidirArranjoAutomatico(o, p)).toEqual(decidirArranjoAutomatico(o, p));
  });

  it('ida e volta com o corpo do SG: a ordem real + a linha do MESMO pacote num canal Turbo ⇒ programar sem package_number', () => {
    const linhaSg =
      lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list.find(
        (r) => r.order_sn === ORDER_SN,
      ) ?? null;
    const o = observacaoDaOrdemShopee(linhaSg);
    expect(o.pacotes).toHaveLength(1);
    const numero = o.pacotes[0] ?? '';
    const p = observacaoDoPacoteShopee(linhaDePacote({ package_number: numero }));
    expect(elegibilidadeDoArranjoAutomatico(p)).toEqual({ tipo: 'candidato' });
    expect(decidirArranjoAutomatico(o, p)).toEqual({ tipo: 'programar', comPacote: false });
    // Near-miss: the same order once it has moved to IN_CANCEL refuses before any ship.
    expect(decidirArranjoAutomatico({ ...o, status: 'IN_CANCEL' }, p)).toEqual(
      recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoEmCancelamento),
    );
  });
});

/* ============ review 3a (Q4) — the predicates other folders read ============ */

/**
 * Every phase `fasePacote` can answer → whether the invoice gate decides there.
 * A `Record` over the union, so a new phase is a COMPILE error here until it
 * says which side it is on.
 */
const PORTAO_DA_NFE: Readonly<Record<FasePacote, boolean>> = {
  'nao-pronto': true,
  programar: true,
  retido: true,
  desconhecido: true,
  arranjado: false,
  'janela-fechada': false,
  inelegivel: false,
  'nfe-pendente': false,
};

describe('faseTemPortaoDeNfe — as fases em que a NF-e pendente decide (review 3a, Q4-3)', () => {
  it.each(Object.entries(PORTAO_DA_NFE) as [FasePacote, boolean][])('%s ⇒ %s', (fase, esperado) => {
    expect(faseTemPortaoDeNfe(fase)).toBe(esperado);
  });

  it('é a pergunta de fasePacote, nas DUAS direções — token × arranjado × termos', () => {
    // For every package: with the invoice pending, fasePacote answers
    // nfe-pendente EXACTLY when the predicate holds on the phase it answers
    // without it; and where the predicate is false the invoice changes nothing.
    const vistas = new Set<FasePacote>();
    for (const fulfillment of [...TOKENS, null]) {
      for (const arranjado of [true, false, null]) {
        for (const termosPendentes of [[], ['-'], ['SYSTEM_PENDING']]) {
          const sem = fasePacote(pacote({ fulfillment, arranjado, termosPendentes }));
          const com = fasePacote(
            pacote({ fulfillment, arranjado, termosPendentes, nfePendente: true }),
          );
          const rotulo = `${String(fulfillment)}/${String(arranjado)}/${termosPendentes.join()}`;
          expect(com === 'nfe-pendente', rotulo).toBe(faseTemPortaoDeNfe(sem));
          if (!faseTemPortaoDeNfe(sem)) expect(com, rotulo).toBe(sem);
          vistas.add(sem);
        }
      }
    }
    // ANCHOR: the grid reached every phase fasePacote answers without the
    // invoice — both sides of the predicate, `retido` and `desconhecido` included.
    expect([...vistas].sort()).toEqual(
      (Object.keys(PORTAO_DA_NFE) as FasePacote[]).filter((f) => f !== 'nfe-pendente').sort(),
    );
  });

  it('⚠️ retido está DENTRO: o termo é lido DEPOIS do portão — near-miss: arranjado com termo fica fora', () => {
    const retido = pacote({ termosPendentes: ['SYSTEM_PENDING'] });
    expect(fasePacote(retido)).toBe('retido');
    expect(fasePacote({ ...retido, nfePendente: true })).toBe('nfe-pendente');
    expect(faseTemPortaoDeNfe('retido')).toBe(true);
    // Near-miss: arranged AND holding a term — the arrange wins, the gate never runs.
    const arranjado = pacote({ arranjado: true, termosPendentes: ['SYSTEM_PENDING'] });
    expect(fasePacote({ ...arranjado, nfePendente: true })).toBe('arranjado');
    expect(faseTemPortaoDeNfe(fasePacote(arranjado))).toBe(false);
  });

  it('nfe-pendente é o VEREDITO do portão, não uma fase guardada ⇒ false (nunca "a nota passou")', () => {
    expect(faseTemPortaoDeNfe(fasePacote(pacote({ nfePendente: true })))).toBe(false);
  });
});

describe('ehPedidoFbsShopee — a ÚNICA dobra do FBS (review 3a, Q4-2)', () => {
  /** The PAIR: every spelling below is Shopee's own fulfilment. */
  const FBS: readonly string[] = [
    'fulfilled_by_shopee',
    ' Fulfilled_By_Shopee ',
    'FULFILLED_BY_SHOPEE',
    '\tfulfilled_by_shopee\n',
  ];
  /** The NEAR-MISSES: none of them is — a prefix, substring or separator fold would say yes. */
  const NAO_FBS: readonly (string | null | undefined)[] = [
    'fulfilled_by_local_seller',
    'fulfilled_by_cb_seller',
    'fulfilled_by_shopee_x',
    'xfulfilled_by_shopee',
    'fulfilled by shopee',
    'fulfilled-by-shopee',
    'shopee',
    '',
    '   ',
    null,
    undefined,
  ];

  it.each(FBS)('PAR: %j ⇒ true', (flag) => {
    expect(ehPedidoFbsShopee(flag)).toBe(true);
  });

  it.each(NAO_FBS)('QUASE-MISS: %j ⇒ false', (flag) => {
    expect(ehPedidoFbsShopee(flag)).toBe(false);
  });

  it('observacaoDaOrdemShopee lê o FBS POR ELA — a mesma resposta em toda grafia', () => {
    for (const fulfillment_flag of [...FBS, ...NAO_FBS]) {
      expect(
        observacaoDaOrdemShopee(linhaDeOrdem({ fulfillment_flag })).fbs,
        String(fulfillment_flag),
      ).toBe(ehPedidoFbsShopee(fulfillment_flag));
    }
  });
});
