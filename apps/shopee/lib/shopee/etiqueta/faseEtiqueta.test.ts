import { SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS } from '@delfrance/integrations-shopee';
import { describe, expect, it } from 'vitest';

import { ESTADO_FRETE_DE_TOKEN_SHOPEE } from '../pedidos/freteShopeeMapping';
import { SHOPEE_ETIQUETA_DETALHE_CAMPOS } from './constantesEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from './errosEtiqueta';
import {
  decidirProximaAcao,
  fasePacote,
  gruposDeDownload,
  progressoDe,
  type AcaoEtiqueta,
  type FasePacote,
  type ObservacaoOrdemEtiqueta,
  type ObservacaoPacoteEtiqueta,
} from './faseEtiqueta';

/* ------------------------------- fixtures ---------------------------------- */

const P1 = 'OFG000000000001';
const P2 = 'OFG000000000002';
const RASTREIO = 'BR000000000000T';
const AGORA = 1_760_000_000_000;

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
  return decidirProximaAcao(o, ps, { pacote: pacoteDoCorpo }, AGORA);
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

  it('a NF-e pendente vence qualquer token, até um desconhecido', () => {
    expect(fasePacote(pacote({ nfePendente: true }))).toBe('nfe-pendente');
    expect(fasePacote(pacote({ fulfillment: 'LOGISTICS_SEI_LA', nfePendente: true }))).toBe(
      'nfe-pendente',
    );
  });

  it('S22: is_shipment_arranged null conta como NÃO programado ⇒ programar', () => {
    expect(fasePacote(pacote({ arranjado: null }))).toBe('programar');
    expect(fasePacote(pacote({ arranjado: true }))).toBe('arranjado');
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
});

describe('decidirProximaAcao — regra 6, programar', () => {
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

  it('é pura: não muda as entradas e não depende do relógio', () => {
    const o = Object.freeze(ordem({ pacotes: Object.freeze([P1, P2]) }));
    const ps = Object.freeze([
      Object.freeze(pronto({ numero: P1 })),
      Object.freeze(pacote({ numero: P2 })),
    ]);
    const a = decidirProximaAcao(o, ps, { pacote: null }, 0);
    const b = decidirProximaAcao(o, ps, { pacote: null }, Number.MAX_SAFE_INTEGER);
    expect(a).toEqual(b);
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
