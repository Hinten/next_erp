import { describe, expect, it } from 'vitest';

import {
  rotuloMotivoDevolucaoShopee,
  rotuloPendenciaForaDoErp,
  rotuloPrazo,
  rotuloSolucaoDevolucao,
  rotuloStatusCompensacao,
  rotuloStatusDevolucaoShopee,
  rotuloStatusNegociacao,
  rotuloStatusProva,
  rotuloTipoRequisicao,
} from './reclamacaoLabels';

/**
 * The property that matters on this screen: an operator deciding whether to
 * refund must never be shown an empty cell where a value exists. Every lookup
 * is TOTAL — known ⇒ its label, unknown ⇒ the RAW value, absent ⇒ an em dash.
 */

const ROTULOS_DE_TEXTO = [
  ['rotuloStatusDevolucaoShopee', rotuloStatusDevolucaoShopee],
  ['rotuloSolucaoDevolucao', rotuloSolucaoDevolucao],
  ['rotuloMotivoDevolucaoShopee', rotuloMotivoDevolucaoShopee],
  ['rotuloStatusNegociacao', rotuloStatusNegociacao],
  ['rotuloStatusProva', rotuloStatusProva],
  ['rotuloStatusCompensacao', rotuloStatusCompensacao],
  ['rotuloPrazo', rotuloPrazo],
  ['rotuloPendenciaForaDoErp', rotuloPendenciaForaDoErp],
] as const;

describe('reclamacaoLabels — totality', () => {
  it.each(ROTULOS_DE_TEXTO)('%s returns an unknown token RAW, never blank', (_nome, fn) => {
    expect(fn('ALGO_QUE_A_SHOPEE_INVENTOU')).toBe('ALGO_QUE_A_SHOPEE_INVENTOU');
  });

  it.each(ROTULOS_DE_TEXTO)('%s renders an em dash for an ABSENT value', (_nome, fn) => {
    // Distinct from the raw fallback: absent is not the same as unrecognised.
    expect(fn(null)).toBe('—');
    expect(fn(undefined)).toBe('—');
    expect(fn('')).toBe('—');
  });

  it.each(ROTULOS_DE_TEXTO)(
    '⚠️ %s never resolves an Object.prototype key — `constructor` stays raw',
    (_nome, fn) => {
      // A plain object literal would answer a FUNCTION here, and the panel would
      // print its source. Maps hold only what was put in them.
      expect(fn('constructor')).toBe('constructor');
      expect(fn('toString')).toBe('toString');
      expect(fn('__proto__')).toBe('__proto__');
    },
  );

  it('rotuloTipoRequisicao: an unknown int comes back as its number, absent as the dash', () => {
    expect(rotuloTipoRequisicao(7)).toBe('7');
    expect(rotuloTipoRequisicao(null)).toBe('—');
    expect(rotuloTipoRequisicao(undefined)).toBe('—');
  });
});

describe('reclamacaoLabels — the vocabulary Shopee documents today', () => {
  it('translates every ReturnStatus — the positive control for every fallback above', () => {
    expect(
      [
        'REQUESTED',
        'PROCESSING',
        'ACCEPTED',
        'SELLER_DISPUTE',
        'JUDGING',
        'CLOSED',
        'CANCELLED',
      ].map(rotuloStatusDevolucaoShopee),
    ).toEqual([
      'solicitada',
      'em processamento',
      'aceita',
      'em disputa pelo vendedor',
      'em análise pela Shopee',
      'encerrada',
      'cancelada',
    ]);
  });

  it('status labels are case-SENSITIVE: a lower-cased token is not a status we know', () => {
    // Near-miss: nothing here folds case — `closed` is not documented, and a
    // fold would also hide a token that means something else.
    expect(rotuloStatusDevolucaoShopee('closed')).toBe('closed');
    expect(rotuloStatusDevolucaoShopee(' CLOSED')).toBe(' CLOSED');
  });

  it('labels the two solutions apart', () => {
    expect(rotuloSolucaoDevolucao('RETURN_REFUND')).toBe('Devolução e reembolso');
    expect(rotuloSolucaoDevolucao('REFUND')).toBe('Apenas reembolso');
    // Shopee's READ encoding is an int; only the normalised string has a label.
    expect(rotuloSolucaoDevolucao('0')).toBe('0');
  });

  it('PAIR: both spellings of one reason read the same', () => {
    expect(rotuloMotivoDevolucaoShopee('NOT_RECEIPT')).toBe(
      rotuloMotivoDevolucaoShopee('NONRECEIPT'),
    );
    expect(rotuloMotivoDevolucaoShopee('CHANGE_MIND')).toBe(
      rotuloMotivoDevolucaoShopee('CHANGE_OF_MIND'),
    );
    expect(rotuloMotivoDevolucaoShopee('MUITAL_AGREE')).toBe(
      rotuloMotivoDevolucaoShopee('MUTUAL_AGREE'),
    );
    expect(rotuloMotivoDevolucaoShopee('DIFF_DESC')).toBe(
      rotuloMotivoDevolucaoShopee('DIFFERENT_DESCRIPTION'),
    );
    expect(rotuloMotivoDevolucaoShopee('NOT_RECEIPT')).toBe('Produto não recebido');
  });

  it('NEAR MISS: distinct reasons keep distinct labels — the table is not one big fold', () => {
    const rotulos = [
      'WRONG_ITEM',
      'ITEM_DAMAGED',
      'ITEM_MISSING',
      'ITEM_FAKE',
      'PHYSICAL_DMG',
      'FUNCTIONAL_DMG',
      'EXPECTATION_FAILED',
      'SPOILED_ROTTEN',
    ].map(rotuloMotivoDevolucaoShopee);
    expect(new Set(rotulos).size).toBe(rotulos.length);
    // A NONE is "no reason", and NO_REASON is "no reason GIVEN" — kept apart.
    expect(rotuloMotivoDevolucaoShopee('NONE')).not.toBe(rotuloMotivoDevolucaoShopee('NO_REASON'));
  });

  it('negotiation and proof states', () => {
    expect(rotuloStatusNegociacao('PENDING_RESPOND')).toBe('aguardando sua resposta');
    expect(rotuloStatusNegociacao('PENDING_BUYER_RESPOND')).toBe('aguardando o comprador');
    expect(rotuloStatusNegociacao('TERMINATED')).toBe('encerrada');
    expect(rotuloStatusProva('PENDING')).toBe('pedidas pela Shopee');
    expect(rotuloStatusProva('NOT_NEEDED')).toBe('não pedidas');
    expect(rotuloStatusProva('UPLOADED')).toBe('enviadas');
    expect(rotuloStatusProva('OVERDUE')).toBe('prazo vencido');
  });

  it('PAIR: the prefixed and the unprefixed compensation spellings read the same', () => {
    for (const token of [
      'NOT_APPLICABLE',
      'INITIAL_STAGE',
      'PENDING_REQUEST',
      'NOT_REQUIRED',
      'REQUESTED',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
      'NOT_ELIGIBLE',
    ]) {
      const prefixado = rotuloStatusCompensacao(`COMPENSATION_${token}`);
      expect(prefixado).not.toBe(`COMPENSATION_${token}`);
      expect(rotuloStatusCompensacao(token)).toBe(prefixado);
    }
    expect(rotuloStatusCompensacao('COMPENSATION_APPROVED')).toBe('aprovada');
  });

  it('NEAR MISS: a lower-cased or FUSED compensation token stays raw — no prefix stripping', () => {
    expect(rotuloStatusCompensacao('compensation_approved')).toBe('compensation_approved');
    expect(rotuloStatusCompensacao('COMPENSATIONAPPROVED')).toBe('COMPENSATIONAPPROVED');
    expect(rotuloStatusCompensacao('COMPENSATION_')).toBe('COMPENSATION_');
    expect(rotuloStatusCompensacao('COMPENSATION_COMPENSATION_APPROVED')).toBe(
      'COMPENSATION_COMPENSATION_APPROVED',
    );
  });

  it('the request types — the panel’s legend lines', () => {
    expect(rotuloTipoRequisicao(0)).toBe('Devolução normal');
    expect(rotuloTipoRequisicao(1)).toBe('Devolução durante o transporte');
    expect(rotuloTipoRequisicao(2)).toBe('Devolução no ato da entrega');
  });

  it('the six deadline codes', () => {
    expect(
      [
        'resposta-vendedor',
        'final-vendedor',
        'envio-comprador',
        'evidencias',
        'compensacao',
        'proposta',
      ].map(rotuloPrazo),
    ).toEqual([
      'Responder à solicitação até',
      'Prazo final do vendedor',
      'Comprador devolver até',
      'Enviar evidências até',
      'Pedir compensação até',
      'Responder à proposta até',
    ]);
  });

  it('⭐ every out-of-ERP step names WHERE to do it — never a dead end', () => {
    for (const codigo of ['contestar', 'enviar-evidencias', 'organizar-coleta']) {
      expect(rotuloPendenciaForaDoErp(codigo)).toMatch(/Seller Centre/);
    }
  });
});
