/**
 * The live order's gates (step 14, PR 14-b), over parsed `getOrder` orders
 * built by the app's own wire builder (`testing/pedidoWireAmazon.ts`). Pure.
 */
import { describe, expect, it } from 'vitest';

import { PedidoAmazonIlegivelError } from '../pedidos/erros';
import { linhaAmazon, pedidoAmazon, type OpcoesPedidoTeste } from '../testing/pedidoWireAmazon';
import { gatesDoPedidoAmazonParaNfe } from './gatesPedidoNfe';

/** A Delivery-by-Amazon order: MERCHANT, the DBA program, UNSHIPPED — the gates' `segue`. */
const dba = (o: OpcoesPedidoTeste = {}) =>
  pedidoAmazon({ status: 'UNSHIPPED', por: 'MERCHANT', programs: ['DELIVERY_BY_AMAZON'], ...o });

const motivo = (o: OpcoesPedidoTeste = {}) => {
  const p = gatesDoPedidoAmazonParaNfe(dba(o));
  return p.segue ? 'segue' : p.motivo;
};

describe('gatesDoPedidoAmazonParaNfe', () => {
  it('★ MERCHANT + DELIVERY_BY_AMAZON + UNSHIPPED, PARTIALLY_SHIPPED or SHIPPED ⇒ segue', () => {
    for (const status of ['UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED']) {
      expect(motivo({ status }), status).toBe('segue');
    }
  });

  it('★ CANCELLED ⇒ pedido-cancelado; PENDING and PENDING_AVAILABILITY ⇒ pedido-pendente', () => {
    expect(motivo({ status: 'CANCELLED' })).toBe('pedido-cancelado');
    expect(motivo({ status: 'PENDING' })).toBe('pedido-pendente');
    expect(motivo({ status: 'PENDING_AVAILABILITY' })).toBe('pedido-pendente');
  });

  it('★ an OPEN cancellation request ⇒ cancelamento-solicitado; NEAR-MISS a request its own execution closed', () => {
    const aberta = [linhaAmazon('L1', { qtd: 1, preco: '10.00', solicitacao: true })];
    expect(motivo({ linhas: aberta })).toBe('cancelamento-solicitado');
    const fechada = [
      linhaAmazon('L1', { qtd: 1, preco: '10.00', solicitacao: true, execucao: true }),
    ];
    expect(motivo({ linhas: fechada })).toBe('segue');
    // An open request on ONE line is open, whatever another line carries.
    expect(
      motivo({
        linhas: [
          linhaAmazon('L1', { qtd: 1, preco: '10.00', execucao: true }),
          linhaAmazon('L2', { qtd: 1, preco: '10.00', solicitacao: true }),
        ],
      }),
    ).toBe('cancelamento-solicitado');
  });

  it('★ fulfilledBy AMAZON, absent or another spelling ⇒ nao-dba', () => {
    expect(motivo({ por: 'AMAZON' })).toBe('nao-dba');
    expect(motivo({ por: null })).toBe('nao-dba');
    expect(motivo({ por: 'merchant' })).toBe('nao-dba');
  });

  it('★ mutation 8: programs without DELIVERY_BY_AMAZON ⇒ nao-dba — AMAZON_EASY_SHIP is NEVER the DBA key', () => {
    expect(motivo({ programs: ['AMAZON_EASY_SHIP'] })).toBe('nao-dba');
    expect(motivo({ programs: ['PRIME'] })).toBe('nao-dba');
    expect(motivo({ programs: [] })).toBe('nao-dba');
    expect(motivo({ programs: null })).toBe('nao-dba');
    expect(motivo({ programs: ['DELIVERY_BY_AMAZON '] })).toBe('nao-dba');
    expect(motivo({ programs: ['PRIME', 'DELIVERY_BY_AMAZON'] })).toBe('segue');
  });

  it('★ mutation 25: the order-level NOT_REQUIRED ⇒ nf-nao-requerida', () => {
    expect(motivo({ invoiceStatus: 'NOT_REQUIRED' })).toBe('nf-nao-requerida');
  });

  it('NEAR-MISS: the order-level NOT_FOUND, ACCEPTED, absent, or a case fold of NOT_REQUIRED ⇒ segue', () => {
    expect(motivo({ invoiceStatus: 'NOT_FOUND' })).toBe('segue');
    expect(motivo({ invoiceStatus: 'ACCEPTED' })).toBe('segue');
    expect(motivo({ invoiceStatus: null })).toBe('segue');
    expect(motivo({ invoiceStatus: 'not_required' })).toBe('segue');
  });

  it('an unknown, absent or UNFULFILLABLE status ⇒ status-pedido-desconhecido', () => {
    expect(motivo({ status: 'SHIPPED_SOMEHOW' })).toBe('status-pedido-desconhecido');
    expect(motivo({ status: null })).toBe('status-pedido-desconhecido');
    expect(motivo({ status: 'UNFULFILLABLE' })).toBe('status-pedido-desconhecido');
    expect(motivo({ status: 'cancelled' })).toBe('status-pedido-desconhecido');
  });

  it('the order of the gates: cancelled first, then pending, then the request, then DBA, then NOT_REQUIRED, then the status', () => {
    const solicitada = [linhaAmazon('L1', { qtd: 1, preco: '10.00', solicitacao: true })];
    expect(motivo({ status: 'CANCELLED', por: 'AMAZON', linhas: solicitada })).toBe(
      'pedido-cancelado',
    );
    expect(motivo({ status: 'PENDING', por: 'AMAZON', linhas: solicitada })).toBe(
      'pedido-pendente',
    );
    expect(motivo({ por: 'AMAZON', linhas: solicitada })).toBe('cancelamento-solicitado');
    expect(motivo({ por: 'AMAZON', invoiceStatus: 'NOT_REQUIRED' })).toBe('nao-dba');
    expect(motivo({ status: 'UNFULFILLABLE', invoiceStatus: 'NOT_REQUIRED' })).toBe(
      'nf-nao-requerida',
    );
    expect(motivo({ status: 'UNFULFILLABLE', por: 'AMAZON' })).toBe('nao-dba');
  });

  it('two lines sharing an orderItemId ⇒ the line reader’s PedidoAmazonIlegivelError (documented)', () => {
    const linhas = [
      linhaAmazon('L1', { qtd: 1, preco: '10.00' }),
      linhaAmazon('L1', { qtd: 1, preco: '10.00' }),
    ];
    expect(() => gatesDoPedidoAmazonParaNfe(dba({ linhas }))).toThrow(PedidoAmazonIlegivelError);
  });
});
