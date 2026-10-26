import { describe, expect, it } from 'vitest';

import { linhaAmazon, pedidoAmazon } from '../testing/pedidoWireAmazon';
import { PedidoAmazonIlegivelError } from './erros';
import {
  bloquearPorValorDoPagamento,
  linhasArmazenadasAmazon,
  linhasRecebidasAmazon,
  reconciliarItens,
  regraD17Amazon,
} from './itensAmazon';
import { classificarVendaAmazon } from './vendaAmazon';
import { lerResumoArmazenadoAmazon } from './estadoPedidoAmazon';
import type { VendaAmazon } from './vendaAmazon';

describe('linhasRecebidasAmazon — the wire lines', () => {
  it('maps each line in Amazon’s order; absent quantity, product or price is ABSENT (null), never 0', () => {
    const linhas = linhasRecebidasAmazon(
      pedidoAmazon({
        linhas: [
          linhaAmazon('L1', { qtd: '3', preco: '12.50' }),
          linhaAmazon('L2'),
          linhaAmazon('L3', { qtd: 1, semProduto: true }),
          linhaAmazon('L4', { qtd: 0, preco: '0.00' }),
        ],
      }),
    );
    expect(linhas.map((l) => [l.orderItemId, l.posicao, l.quantidade, l.precoUnitario])).toEqual([
      ['L1', 1, 3, 12.5],
      ['L2', 2, null, null],
      ['L3', 3, 1, null],
      ['L4', 4, 0, 0],
    ]);
    expect(linhas[2]?.sku).toBeNull();
  });

  it('the SKU keeps its exact bytes; a non-COUNT measurement is flagged; X and the request are per line', () => {
    const [a, b] = linhasRecebidasAmazon(
      pedidoAmazon({
        linhas: [
          linhaAmazon('L1', {
            qtd: 1,
            preco: '1.00',
            sku: ' Abc-1 ',
            unidade: 'KILOGRAM',
            execucao: true,
          }),
          linhaAmazon('L2', { qtd: 1, preco: '1.00', unidade: 'COUNT', solicitacao: true }),
        ],
      }),
    );
    expect(a).toMatchObject({
      sku: ' Abc-1 ',
      medidaNaoUnitaria: true,
      execucaoCancelamento: true,
      canceladoPor: 'BUYER',
    });
    expect(b).toMatchObject({
      medidaNaoUnitaria: false,
      execucaoCancelamento: false,
      solicitacaoCancelamento: true,
    });
  });

  it('a duplicate orderItemId refuses the whole order', () => {
    const order = pedidoAmazon({
      linhas: [linhaAmazon('L1', { qtd: 1 }), linhaAmazon('L1', { qtd: 2 })],
    });
    expect(() => linhasRecebidasAmazon(order)).toThrow(PedidoAmazonIlegivelError);
  });

  it('absent orderItems and [] both read as no lines', () => {
    expect(linhasRecebidasAmazon(pedidoAmazon({ linhas: null }))).toEqual([]);
    expect(linhasRecebidasAmazon(pedidoAmazon({ linhas: [] }))).toEqual([]);
  });
});

describe('linhasArmazenadasAmazon — the stored lines, tolerantly', () => {
  it('a migrated line (under a produto key, no produtoUid field) takes its produto from the key; NONE ⇒ null', () => {
    const linhas = linhasArmazenadasAmazon({
      'prod-1': [{ mktplaceId: 'L1', precoDeVenda: 33.300000000000004, quantidade: 1, ordem: 1 }],
      NONE: [{ mktplaceId: 'L2', precoDeVenda: 5, quantidade: 2, ordem: 1 }],
    });
    expect(linhas.map((l) => [l.chave, l.mktplaceId, l.produtoUid, l.precoDeVenda])).toEqual([
      ['prod-1', 'L1', 'prod-1', 33.300000000000004],
      ['NONE', 'L2', null, 5],
    ]);
    expect(linhas[0]?.item?.ensureUniqueId).toBeNull();
  });

  it('a line the item schema refuses is read, but never re-emittable (item null); junk is skipped', () => {
    const linhas = linhasArmazenadasAmazon({
      NONE: [{ mktplaceId: 'L1', quantidade: 1, precoDeVenda: 2, campoDesconhecido: 1 }, 'lixo'],
      X: 'lixo',
    });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ mktplaceId: 'L1', item: null });
    expect(linhasArmazenadasAmazon(null)).toEqual([]);
  });
});

describe('regraD17Amazon — the D17 table, top-down, first match wins', () => {
  const venda = (over: Partial<VendaAmazon>): VendaAmazon => ({
    fase: 'apr',
    cancelado: false,
    execucao: false,
    solicitacao: false,
    solicitacaoAberta: false,
    reversaoPacote: false,
    zerado: false,
    revertido: false,
    primeiraVez: false,
    aprovado: true,
    congelado: false,
    impresso: false,
    ...over,
  });

  it.each([
    [{ congelado: true, revertido: true, execucao: true }, 1, 'congeladas'],
    [
      { primeiraVez: true, aprovado: false, fase: 'cancelado', cancelado: true, revertido: true },
      2,
      'cancelado-nao-importado',
    ],
    [
      { primeiraVez: true, aprovado: false, fase: 'env', reversaoPacote: true, revertido: true },
      3,
      'reversao-nao-importada',
    ],
    [
      { fase: 'env', zerado: true, revertido: true, aprovado: false },
      4,
      'itens-preservados-reversao',
    ],
    [{ primeiraVez: true, aprovado: false, execucao: true }, 5, 'criar-bloqueado'],
    [{ execucao: true, aprovado: false }, 6, 'bloquear'],
    [{ primeiraVez: true, aprovado: false, fase: 'env' }, 7, 'escritas'],
    [{ aprovado: false, fase: 'pre' }, 8, 'espelhadas'],
    [{ aprovado: false, fase: 'apr' }, 9, 'espelhadas'],
    [{ fase: 'apr' }, 10, 'comparar'],
    [{ fase: 'env' }, 11, 'mantidas'],
    [{ fase: 'pre' }, 12, 'mantidas'],
    [{ fase: 'desconhecida' }, 13, 'mantidas'],
  ] as const)('%o ⇒ row %i (%s)', (over, linha, regra) => {
    expect(regraD17Amazon(venda(over as Partial<VendaAmazon>))).toEqual({ linha, regra });
  });

  it('NEAR-MISS: X on PENDING is not a block (row 8 mirrors it, protected)', () => {
    expect(regraD17Amazon(venda({ execucao: true, aprovado: false, fase: 'pre' }))).toEqual({
      linha: 8,
      regra: 'espelhadas',
    });
  });
});

describe('★ PR 6 — bloquearPorValorDoPagamento (row 10’s pagamento term)', () => {
  const raw = {
    estado: 'pago',
    marketplace: { tipo: 'amazon', status: 'UNSHIPPED' },
    itens: {
      NONE: [
        { mktplaceId: 'L1', quantidade: 2, precoDeVenda: 10, ordem: 1 },
        { mktplaceId: 'L2', quantidade: 1, precoDeVenda: 0, ordem: 2 },
      ],
    },
  };
  const linhas = linhasArmazenadasAmazon(raw.itens);
  const reconciliar = (status: string, l2 = '5.00') => {
    const order = pedidoAmazon({
      status,
      linhas: [
        linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
        linhaAmazon('L2', { qtd: 1, preco: l2 }),
      ],
    });
    const venda = classificarVendaAmazon(order, {
      resumo: lerResumoArmazenadoAmazon(raw),
      linhas,
      pagamentoValor: null,
    });
    return reconciliarItens(
      { linhas, dinheiro: { descontoTotal: 0, valorFrete: null, freteNosso: true } },
      {
        linhas: linhasRecebidasAmazon(order),
        dinheiro: { descontoTotal: 0, valorFrete: null },
        criadoUs: null,
        vinculos: new Map(),
      },
      venda,
    );
  };

  it('turns a row-10 `mantidas` into the BLOCK: nothing applied (a filled price included), every stored line kept', () => {
    const mantidas = reconciliar('UNSHIPPED');
    expect(mantidas).toMatchObject({ linhaD17: 10, acao: 'mantidas' });
    // The stored 0 price is FILLED on the comparison...
    expect(mantidas.itens).not.toBeNull();
    expect(mantidas.eventos).toContain('preco-preenchido');
    const b = bloquearPorValorDoPagamento(mantidas, linhas);
    expect(b).toMatchObject({
      acao: 'divergencia-itens-aprovado',
      itens: null,
      dinheiro: null,
      dinheiroDasLinhasMudou: false,
      bloqueio: { causa: 'pagamento', linhas: [] },
      contagens: { linhasPreservadas: 2, linhasDivergentes: 0, linhasSemProduto: 2 },
    });
    // ...and not under the block.
    expect(b.eventos).not.toContain('preco-preenchido');
  });

  it('NEAR-MISS: any other reconciliation is returned AS IT IS (row 11 SHIPPED, a row-10 line divergence)', () => {
    const enviado = reconciliar('SHIPPED');
    expect(enviado.linhaD17).toBe(11);
    expect(bloquearPorValorDoPagamento(enviado, linhas)).toBe(enviado);
    // A row-10 line change (L1 qty 2 → 3) is already a block: left as it is.
    const outra = reconciliarItens(
      { linhas, dinheiro: { descontoTotal: 0, valorFrete: null, freteNosso: true } },
      {
        linhas: linhasRecebidasAmazon(
          pedidoAmazon({
            linhas: [
              linhaAmazon('L1', { qtd: 3, preco: '10.00' }),
              linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
            ],
          }),
        ),
        dinheiro: { descontoTotal: 0, valorFrete: null },
        criadoUs: null,
        vinculos: new Map(),
      },
      classificarVendaAmazon(pedidoAmazon(), {
        resumo: lerResumoArmazenadoAmazon(raw),
        linhas,
        pagamentoValor: null,
      }),
    );
    expect(outra).toMatchObject({ linhaD17: 10, acao: 'divergencia-itens-aprovado' });
    expect(bloquearPorValorDoPagamento(outra, linhas)).toBe(outra);
  });
});
