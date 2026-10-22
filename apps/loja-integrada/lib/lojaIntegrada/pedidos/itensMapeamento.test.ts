import { liPedidoItemSchema, type PedidoItemLi } from '@delfrance/integrations-loja-integrada';
import { describe, expect, it } from 'vitest';

import {
  custoDoItemLi,
  descontoUnitarioLi,
  formaDoProdutoLi,
  idLiDoProdutoPai,
  mapearItensLi,
  referenciasDeProdutoLi,
  type ResolucaoLinhaLi,
} from './itensMapeamento';

const AGORA_US = 1_760_000_000_000_000;
const SEM_RESOLUCAO = new Map<string, ResolucaoLinhaLi>();

/** A line as the wire schema reads it (strings for money, as captured). */
function item(campos: Record<string, unknown>): PedidoItemLi {
  return liPedidoItemSchema.parse({
    id: 11,
    linha: 1,
    sku: '12345678901234567',
    nome: 'Produto',
    quantidade: '1.000',
    preco_venda: '10.0000',
    preco_subtotal: '10.0000',
    preco_custo: 'x',
    produto: '/api/v1/produto/500',
    ...campos,
  });
}

function mapear(itens: PedidoItemLi[], valorSubtotal: number | null, resolucoes = SEM_RESOLUCAO) {
  const r = mapearItensLi({ itens, valorSubtotal, resolucoes, nowUs: AGORA_US });
  if (!r.ok) throw new Error(`refused: ${r.campos.join(',')}`);
  return r;
}

describe('the produto reference form', () => {
  it('the Loja Integrada id: the resource path, with or without a trailing slash', () => {
    expect(formaDoProdutoLi('/api/v1/produto/401')).toEqual({ forma: 'id-li', idLi: '401' });
    expect(formaDoProdutoLi('/api/v1/produto/401/')).toEqual({ forma: 'id-li', idLi: '401' });
  });

  it('the external id: the same path with exactly `?id_externo=1`', () => {
    expect(formaDoProdutoLi('/api/v1/produto/77?id_externo=1')).toEqual({
      forma: 'id-externo',
      idExterno: '77',
    });
    expect(formaDoProdutoLi('/api/v1/produto/77/?id_externo=1')).toEqual({
      forma: 'id-externo',
      idExterno: '77',
    });
  });

  it("⚠️ NEAR-MISS: '' and a placeholder are NEITHER form (never a GET built out of '')", () => {
    for (const nada of ['', 'REDACTED', 'produto', null, undefined]) {
      expect(formaDoProdutoLi(nada), String(nada)).toEqual({ forma: 'nenhuma' });
    }
  });

  it('⚠️ NEAR-MISS: a leading zero, a zero id, another query, a full URL, an unsafe id are neither', () => {
    for (const ruim of [
      '/api/v1/produto/0401',
      '/api/v1/produto/0',
      '/api/v1/produto/77?id_externo=0',
      '/api/v1/produto/77?id_externo=1&x=2',
      'https://loja.example/api/v1/produto/77',
      '/v1/produto/77',
      '/api/v1/produto/77 ',
      '/api/v1/produto/99999999999999999',
    ]) {
      expect(formaDoProdutoLi(ruim), ruim).toEqual({ forma: 'nenhuma' });
    }
  });

  it('⚠️ EQUAL pair: the object form with a Loja Integrada resource_uri IS that id (narrowest first), whatever its id_externo', () => {
    expect(formaDoProdutoLi({ resource_uri: '/api/v1/produto/5', id_externo: 77 })).toEqual(
      formaDoProdutoLi('/api/v1/produto/5'),
    );
    expect(formaDoProdutoLi({ resource_uri: '/api/v1/produto/5/', id_externo: '77' })).toEqual({
      forma: 'id-li',
      idLi: '5',
    });
  });

  it('⚠️ NEAR-MISS: the object form WITHOUT a readable Loja Integrada id falls back to its id_externo', () => {
    expect(formaDoProdutoLi({ id_externo: 77 })).toEqual({ forma: 'id-externo', idExterno: '77' });
    expect(formaDoProdutoLi({ resource_uri: 'REDACTED', id_externo: 77 })).toEqual({
      forma: 'id-externo',
      idExterno: '77',
    });
    // A resource_uri in the id_externo form is itself the external id.
    expect(
      formaDoProdutoLi({ resource_uri: '/api/v1/produto/77?id_externo=1', id_externo: null }),
    ).toEqual({ forma: 'id-externo', idExterno: '77' });
  });

  it('the object form: the remaining edges', () => {
    // EQUAL pair: a numeric id_externo and its decimal string.
    expect(formaDoProdutoLi({ id_externo: '77' })).toEqual(formaDoProdutoLi({ id_externo: 77 }));
    // An empty id_externo is nothing: the resource path decides.
    expect(formaDoProdutoLi({ resource_uri: '/api/v1/produto/5', id_externo: '' })).toEqual({
      forma: 'id-li',
      idLi: '5',
    });
    // ⚠️ NEAR-MISS: a non-canonical id_externo is not one.
    expect(formaDoProdutoLi({ resource_uri: null, id_externo: '077' })).toEqual({
      forma: 'nenhuma',
    });
    expect(formaDoProdutoLi({ resource_uri: '', id_externo: null })).toEqual({ forma: 'nenhuma' });
  });

  it('produto_pai: the parent’s Loja Integrada id, the id-li form only', () => {
    expect(idLiDoProdutoPai('/api/v1/produto/402')).toBe('402');
    expect(idLiDoProdutoPai('/api/v1/produto/402?id_externo=1')).toBeNull();
    expect(idLiDoProdutoPai('')).toBeNull();
    expect(idLiDoProdutoPai(null)).toBeNull();
  });

  it('referenciasDeProdutoLi: one per keyed line, with its form, parent and SKU text', () => {
    const refs = referenciasDeProdutoLi([
      item({ id: 1, produto: '/api/v1/produto/9', produto_pai: '/api/v1/produto/8' }),
      item({ id: 2, produto: '', sku: '' }),
      item({ id: null }),
    ]);
    expect(refs).toEqual([
      {
        ensureUniqueId: '1',
        forma: { forma: 'id-li', idLi: '9' },
        idLiPai: '8',
        sku: '12345678901234567',
      },
      { ensureUniqueId: '2', forma: { forma: 'nenhuma' }, idLiPai: null, sku: null },
    ]);
  });
});

describe('the line fields', () => {
  it('maps a line: key, order, SKU as text, unrounded price, quantity, now', () => {
    const r = mapear(
      [item({ id: 987, linha: 2, preco_venda: '12.3456', preco_subtotal: '12.3456' })],
      null,
    );
    const [l] = r.itens;
    expect(l).toMatchObject({
      produtoUid: null,
      ordem: 2,
      ensureUniqueId: '987',
      mktplaceId: '500',
      sku: '12345678901234567',
      gtin: null,
      nomeDeVenda: 'Produto',
      precoDeVenda: 12.3456,
      descontoUnitario: 0,
      quantidade: 1,
      custo: null,
      timestamp: AGORA_US,
    });
    expect(r.semProduto).toEqual(['987']);
  });

  it('⚠️ a 17-digit SKU stays the exact string (never Number(sku))', () => {
    const sku = '98765432109876543';
    expect(mapear([item({ sku })], null).itens[0]?.sku).toBe(sku);
    expect(String(Number(sku))).not.toBe(sku);
  });

  it('an empty SKU or name is no value', () => {
    const [l] = mapear([item({ sku: '', nome: '' })], null).itens;
    expect(l?.sku).toBeNull();
    expect(l?.nomeDeVenda).toBeNull();
  });

  it('a resolved line carries its produto, and the resolution’s Loja Integrada id wins', () => {
    const resolucoes = new Map<string, ResolucaoLinhaLi>([
      ['11', { produtoUid: 'prod-1', idLi: '321' }],
    ]);
    const r = mapear([item({ produto: '/api/v1/produto/77?id_externo=1' })], null, resolucoes);
    expect(r.itens[0]).toMatchObject({ produtoUid: 'prod-1', mktplaceId: '321' });
    expect(r.semProduto).toEqual([]);
  });

  it('the line order falls back to the position when `linha` is absent', () => {
    const r = mapear([item({ id: 1, linha: null }), item({ id: 2, linha: undefined })], null);
    expect(r.itens.map((l) => l.ordem)).toEqual([1, 2]);
  });

  it('a line without quantity or price, or with a negative one, refuses the mapping (paths only)', () => {
    for (const [campos, esperado] of [
      [{ quantidade: null }, ['itens[].quantidade']],
      [{ preco_venda: '' }, ['itens[].preco_venda']],
      [{ preco_venda: '-1.0000' }, ['itens[].preco_venda']],
      [{ id: null }, ['itens[].id']],
    ] as const) {
      const r = mapearItensLi({
        itens: [item(campos)],
        valorSubtotal: null,
        resolucoes: SEM_RESOLUCAO,
        nowUs: AGORA_US,
      });
      expect(r, JSON.stringify(campos)).toEqual({ ok: false, campos: esperado });
    }
  });
});

describe('the cost', () => {
  it('a decimal string or a JSON number is the cost', () => {
    expect(custoDoItemLi('12.5000')).toBe(12.5);
    expect(custoDoItemLi(7)).toBe(7);
  });

  it("⚠️ '' and a non-numeric string are NO cost, and the line still maps", () => {
    for (const nada of ['', 'abc', 'REDACTED', '1,50', null, undefined, {}, Number.NaN]) {
      expect(custoDoItemLi(nada), String(nada)).toBeNull();
    }
    const r = mapear([item({ preco_custo: '' })], null);
    expect(r.itens[0]?.custo).toBeNull();
  });
});

describe('the unit discount and the subtotal reconciliation', () => {
  it('descontoUnitario = (q·pv − subtotal) / q when positive', () => {
    expect(descontoUnitarioLi(2, 10, 18)).toBe(1);
    // A subtotal above q·pv is NOT adjusted.
    expect(descontoUnitarioLi(2, 10, 21)).toBe(0);
    expect(descontoUnitarioLi(1, 59.9, 59.9)).toBe(0);
    expect(descontoUnitarioLi(0, 10, 0)).toBe(0);
    expect(descontoUnitarioLi(2, 10, null)).toBe(0);
  });

  it('⚠️ 4-dp price on q = 3: Σ line totals == valor_subtotal; never a per-unit rounding', () => {
    const linha = item({ quantidade: '3.000', preco_venda: '33.3333', preco_subtotal: '99.9999' });
    const r = mapear([linha], 100);
    expect(r.itens[0]?.precoDeVenda).toBe(33.3333);
    expect(r.residuo).toBe(0);
    expect(r.divergente).toBe(false);
    // The mutant "roundReais(preco_venda) per unit" reads 3 × 33.33 = 99.99: a centavo short.
  });

  it('⚠️ a positive residual (the platform cut the subtotal) joins descontoTotal', () => {
    const linha = item({ quantidade: '3.000', preco_venda: '33.3333', preco_subtotal: '99.9999' });
    const r = mapear([linha], 99.99);
    expect(r.residuo).toBe(0.01);
    expect(r.descontoExtra).toBe(0.01);
    expect(r.divergente).toBe(false);
  });

  it('⚠️ a positive residual BEYOND a centavo per line is still absorbed, and reported: rounding cannot explain it', () => {
    const linha = item({ quantidade: '1.000', preco_venda: '10.0000', preco_subtotal: '10.0000' });
    const r = mapear([linha], 9.5);
    expect(r.residuo).toBe(0.5);
    expect(r.descontoExtra).toBe(0.5);
    expect(r.divergente).toBe(true);
  });

  it('NEAR-MISS: the bound is one centavo PER LINE — 0.02 over two lines is rounding, 0.03 is not', () => {
    const duas = [
      item({ id: 1, quantidade: '1.000', preco_venda: '10.0000', preco_subtotal: '10.0000' }),
      item({ id: 2, quantidade: '1.000', preco_venda: '10.0000', preco_subtotal: '10.0000' }),
    ];
    expect(mapear(duas, 19.98).divergente).toBe(false);
    expect(mapear(duas, 19.97).divergente).toBe(true);
    expect(mapear(duas, 19.97).descontoExtra).toBe(0.03);
  });

  it('⚠️ a SUB-centavo line discount is kept: it can move the line’s centavo (10.0060 sold at 10.0020)', () => {
    const linha = item({ quantidade: '1.000', preco_venda: '10.0060', preco_subtotal: '10.0020' });
    const r = mapear([linha], 10);
    expect(r.itens[0]?.descontoUnitario).toBeCloseTo(0.004, 10);
    // Without it the line reads 10.01 and a phantom centavo joins descontoTotal.
    expect(r.residuo).toBe(0);
    expect(r.descontoExtra).toBe(0);
  });

  it('⚠️ NEAR-MISS: a negative residual of ONE centavo is already reported', () => {
    const linha = item({ quantidade: '1.000', preco_venda: '10.0000', preco_subtotal: '10.0000' });
    const r = mapear([linha], 10.01);
    expect(r.residuo).toBe(-0.01);
    expect(r.descontoExtra).toBe(0);
    expect(r.divergente).toBe(true);
  });

  it('⚠️ NEAR-MISS: a negative residual is reported, never adjusted', () => {
    const linha = item({ quantidade: '1.000', preco_venda: '10.0000', preco_subtotal: '10.0000' });
    const r = mapear([linha], 10.5);
    expect(r.residuo).toBe(-0.5);
    expect(r.descontoExtra).toBe(0);
    expect(r.divergente).toBe(true);
  });

  it('a discounted line: the line total is its subtotal, so the residual is zero', () => {
    const linha = item({ quantidade: '2.000', preco_venda: '10.0000', preco_subtotal: '18.0000' });
    const r = mapear([linha], 18);
    expect(r.itens[0]?.descontoUnitario).toBe(1);
    expect(r.residuo).toBe(0);
  });

  it('no valor_subtotal: no reconciliation', () => {
    expect(mapear([item({})], null).residuo).toBe(0);
  });
});
