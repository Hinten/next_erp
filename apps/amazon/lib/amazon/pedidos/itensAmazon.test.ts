import { describe, expect, it } from 'vitest';

import { linhaAmazon, pedidoAmazon } from '../testing/pedidoWireAmazon';
import { PedidoAmazonIlegivelError } from './erros';
import { linhasArmazenadasAmazon, linhasRecebidasAmazon, regraD17Amazon } from './itensAmazon';
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
