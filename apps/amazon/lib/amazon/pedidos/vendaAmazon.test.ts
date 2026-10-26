import { describe, expect, it } from 'vitest';

import {
  execucaoAmazon,
  linhaAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import { lerResumoArmazenadoAmazon } from './estadoPedidoAmazon';
import { linhasArmazenadasAmazon } from './itensAmazon';
import {
  classificarVendaAmazon,
  faseVendaAmazon,
  type PedidoArmazenadoVendaAmazon,
} from './vendaAmazon';

function armazenado(
  raw: Record<string, unknown>,
  pagamentoValor: number | null = null,
): PedidoArmazenadoVendaAmazon {
  return {
    resumo: lerResumoArmazenadoAmazon(raw),
    linhas: linhasArmazenadasAmazon(raw.itens),
    pagamentoValor,
  };
}

const PAGO_COM_DUAS_LINHAS_RAW: Record<string, unknown> = {
  estado: 'pago',
  marketplace: { tipo: 'amazon', status: 'UNSHIPPED' },
  itens: {
    NONE: [
      { mktplaceId: 'L1', quantidade: 2, precoDeVenda: 10 },
      { mktplaceId: 'L2', quantidade: 1, precoDeVenda: 5 },
    ],
  },
};
const PAGO_COM_DUAS_LINHAS = armazenado(PAGO_COM_DUAS_LINHAS_RAW);

describe('faseVendaAmazon', () => {
  it('maps the statuses exactly; anything else is desconhecida', () => {
    expect(
      [
        'PENDING',
        'PENDING_AVAILABILITY',
        'UNSHIPPED',
        'PARTIALLY_SHIPPED',
        'SHIPPED',
        'CANCELLED',
      ].map(faseVendaAmazon),
    ).toEqual(['pre', 'pre', 'apr', 'apr', 'env', 'cancelado']);
    for (const s of ['UNFULFILLABLE', 'INVOICE_UNCONFIRMED', 'shipped', '', null, undefined]) {
      expect(faseVendaAmazon(s), String(s)).toBe('desconhecida');
    }
  });
});

describe('classificarVendaAmazon — the signals', () => {
  it('C and rev on CANCELLED; R is never set with C or with an execution', () => {
    const c = classificarVendaAmazon(
      pedidoAmazon({
        status: 'CANCELLED',
        linhas: [linhaAmazon('L1', { qtd: 1, preco: '1.00', solicitacao: true })],
      }),
      PAGO_COM_DUAS_LINHAS,
    );
    expect(c).toMatchObject({ cancelado: true, revertido: true, solicitacao: false });
    const rx = classificarVendaAmazon(
      pedidoAmazon({
        linhas: [
          linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true }),
          linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
        ],
      }),
      PAGO_COM_DUAS_LINHAS,
    );
    expect(rx).toMatchObject({ execucao: true, solicitacao: false, revertido: false });
    const r = classificarVendaAmazon(
      pedidoAmazon({
        linhas: [
          linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true }),
          linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
        ],
      }),
      PAGO_COM_DUAS_LINHAS,
    );
    expect(r).toMatchObject({ solicitacao: true, revertido: false, aprovado: true });
  });

  it('solicitacaoAberta is per LINE: an execution on another line hides R but not the open request; on the SAME line it closes it (NEAR-MISS)', () => {
    const aberta = (linhas: Record<string, unknown>[]) =>
      classificarVendaAmazon(pedidoAmazon({ linhas }), PAGO_COM_DUAS_LINHAS);
    expect(
      aberta([
        linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true }),
        linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
      ]),
    ).toMatchObject({ solicitacao: false, solicitacaoAberta: true });
    expect(
      aberta([
        linhaAmazon('L1', { qtd: 0, preco: '10.00', solicitacao: true, execucao: true }),
        linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
      ]),
    ).toMatchObject({ solicitacao: false, solicitacaoAberta: false });
    expect(aberta([linhaAmazon('L1', { qtd: 2, preco: '10.00' })])).toMatchObject({
      solicitacaoAberta: false,
    });
  });

  it('X reverses only after shipment; P on any reversal package token', () => {
    const xEnv = classificarVendaAmazon(
      pedidoAmazon({
        status: 'SHIPPED',
        linhas: [
          linhaAmazon('L1', { qtd: 2, preco: '10.00', execucao: true }),
          linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
        ],
      }),
      PAGO_COM_DUAS_LINHAS,
    );
    expect(xEnv).toMatchObject({ execucao: true, revertido: true });
    const p = classificarVendaAmazon(
      pedidoAmazon({
        status: 'SHIPPED',
        pacotes: ['DELIVERED', 'LOST'],
        linhas: [
          linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
          linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
        ],
      }),
      PAGO_COM_DUAS_LINHAS,
    );
    expect(p).toMatchObject({ reversaoPacote: true, revertido: true, zerado: false });
    const naoP = classificarVendaAmazon(
      pedidoAmazon({
        status: 'SHIPPED',
        pacotes: ['DELIVERED', 'lost'],
        linhas: [
          linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
          linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
        ],
      }),
      PAGO_COM_DUAS_LINHAS,
    );
    expect(naoP).toMatchObject({ reversaoPacote: false, revertido: false });
  });

  it('Z on SHIPPED: emptied, absent, short, or a matched line zeroed — never on UNSHIPPED', () => {
    const z = (linhas: OpcoesPedidoTeste['linhas'], status = 'SHIPPED') =>
      classificarVendaAmazon(pedidoAmazon({ status, linhas }), PAGO_COM_DUAS_LINHAS).zerado;
    expect(z([])).toBe(true);
    expect(z(null)).toBe(true);
    expect(z([linhaAmazon('L1', { qtd: 2, preco: '10.00' })])).toBe(true);
    expect(
      z([
        linhaAmazon('L1', { qtd: 0, preco: '10.00' }),
        linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
      ]),
    ).toBe(true);
    expect(z([linhaAmazon('L1', { qtd: 2 }), linhaAmazon('L2', { qtd: 1, preco: '5.00' })])).toBe(
      true,
    );
    expect(
      z([
        linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
        linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
      ]),
    ).toBe(false);
    expect(z([], 'UNSHIPPED')).toBe(false);
  });

  it('★ Z’s payment term (PR 6): intact lines on SHIPPED, but the executions sum to 0, are absent or unreadable while the stored pagamento’s valor is positive ⇒ Z', () => {
    const linhas = [
      linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
      linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
    ];
    const comPagamento = armazenado(PAGO_COM_DUAS_LINHAS_RAW, 25);
    const z = (
      pagamento: OpcoesPedidoTeste['pagamento'],
      guardado = comPagamento,
      status = 'SHIPPED',
    ) => classificarVendaAmazon(pedidoAmazon({ status, linhas, pagamento }), guardado);
    expect(z([execucaoAmazon('CreditCard', '0.00')])).toMatchObject({
      zerado: true,
      revertido: true,
    });
    expect(z([])).toMatchObject({ zerado: true });
    expect(z(null)).toMatchObject({ zerado: true });
    expect(z([execucaoAmazon('CreditCard', 'abc')])).toMatchObject({ zerado: true });
    expect(z([execucaoAmazon('CreditCard', '25.00')])).toMatchObject({ zerado: false });
    // NEAR-MISS: one centavo is a payment, not a zero; a stored valor of 0 (or none) protects nothing.
    expect(z([execucaoAmazon('CreditCard', '0.01')])).toMatchObject({ zerado: false });
    expect(z([], armazenado(PAGO_COM_DUAS_LINHAS_RAW, 0))).toMatchObject({ zerado: false });
    expect(z([], armazenado(PAGO_COM_DUAS_LINHAS_RAW, null))).toMatchObject({ zerado: false });
    // Only on SHIPPED.
    expect(z([], comPagamento, 'UNSHIPPED')).toMatchObject({ zerado: false });
  });

  it('Z without a stored pedido: a zero or absent value on SHIPPED; intact lines are not Z (NEAR-MISS)', () => {
    const order = (linhas: Record<string, unknown>[]) =>
      pedidoAmazon({ status: 'SHIPPED', linhas });
    expect(
      classificarVendaAmazon(order([linhaAmazon('L1', { qtd: 1, preco: '0.00' })]), null),
    ).toMatchObject({ zerado: true, primeiraVez: true });
    expect(
      classificarVendaAmazon(order([linhaAmazon('L1', { qtd: 1, preco: '9.00' })]), null),
    ).toMatchObject({ zerado: false, revertido: false });
  });

  it('reads the stored lock, freeze and print stamp; a create has none of them', () => {
    const congelado = armazenado({
      estado: 'pago',
      hasUserInteraction: true,
      dtImpressao: 1_700_000_000_000_000,
    });
    expect(classificarVendaAmazon(pedidoAmazon(), congelado)).toMatchObject({
      congelado: true,
      impresso: true,
      aprovado: true,
    });
    expect(classificarVendaAmazon(pedidoAmazon(), null)).toMatchObject({
      congelado: false,
      impresso: false,
      aprovado: false,
    });
  });
});
