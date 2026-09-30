import { SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS } from '@delfrance/integrations-shopee';
import { describe, expect, it } from 'vitest';

import { ESTADO_FRETE_DE_TOKEN_SHOPEE } from '../pedidos/freteShopeeMapping';
import { SHOPEE_ETIQUETA_DETALHE_CAMPOS } from './constantesEtiqueta';
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
