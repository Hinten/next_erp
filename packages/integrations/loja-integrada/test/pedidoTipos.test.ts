import { describe, expect, it } from 'vitest';

import {
  liPedidoSchema,
  liProdutoIdentidadeSchema,
  liSituacaoHistoricoLinhaSchema,
  liSituacaoSchema,
} from '../src/pedidoTipos';
import {
  historicoCanceladoNaFormaCapturada,
  NUMERO_EXEMPLO,
  pedidoCartaoNaFormaCapturada,
  pedidoPixNaFormaCapturada,
} from './_fixtures/pedidoCapturas';

/** The smallest body the import can still read: the required set and nothing else. */
const MINIMO = {
  numero: NUMERO_EXEMPLO,
  situacao: { codigo: 'pedido_pago' },
  data_modificacao: '2026-09-12T09:15:42.105377',
};

describe('liPedidoSchema over the captured shape', () => {
  it('parses the card order: quoted money as numbers, the 4-place line prices unrounded', () => {
    const p = liPedidoSchema.parse(pedidoCartaoNaFormaCapturada);
    expect(p.numero).toBe(165);
    expect(p.valor_total).toBe(152.2);
    expect(p.valor_subtotal).toBe(149.7);
    expect(p.valor_envio).toBe(18.5);
    expect(p.valor_desconto).toBe(16);
    expect(p.itens.map((i) => [i.quantidade, i.preco_venda, i.preco_subtotal])).toEqual([
      [2, 59.9, 119.8],
      [1, 29.9, 29.9],
    ]);
    expect(p.envios[0]?.valor).toBe(18.5);
    expect(p.envios[0]?.prazo).toBe(7);
    expect(p.pagamentos[0]?.valor).toBe(152.2);
  });

  it('a JSON-number instalment value and a quoted one both parse', () => {
    const numero = liPedidoSchema.parse(pedidoCartaoNaFormaCapturada);
    expect(numero.pagamentos[0]?.parcelamento?.valor_parcela).toBe(50.73);
    const quoted = liPedidoSchema.parse({
      ...pedidoCartaoNaFormaCapturada,
      pagamentos: [
        {
          ...pedidoCartaoNaFormaCapturada.pagamentos[0],
          parcelamento: { numero_parcelas: '3', valor_parcela: '50.73' },
        },
      ],
    });
    expect(quoted.pagamentos[0]?.parcelamento).toMatchObject({
      numero_parcelas: 3,
      valor_parcela: 50.73,
    });
  });

  it('an empty instalment plan `{}` (PIX, boleto) parses with nothing in it', () => {
    const p = liPedidoSchema.parse(pedidoPixNaFormaCapturada);
    expect(p.pagamentos[0]?.parcelamento?.numero_parcelas).toBeUndefined();
    expect(p.pagamentos[0]?.pagamento_tipo).toBe('instantPayment');
  });

  it('a 17-digit SKU stays the exact TEXT — never a number', () => {
    const p = liPedidoSchema.parse(pedidoCartaoNaFormaCapturada);
    expect(p.itens.map((i) => i.sku)).toEqual(['12345678901234567', '12345678901234']);
    // Near-miss: as a number it would already have lost its last digit.
    expect(String(Number('12345678901234567'))).not.toBe('12345678901234567');
  });

  it.each([
    ['a non-numeric string', 'custo indisponível'],
    ['an empty string', ''],
    ['a decimal string', '12.3400'],
    ['null', null],
  ])('`preco_custo` as %s never fails the order, and is kept RAW', (_caso, custo) => {
    const p = liPedidoSchema.parse({
      ...MINIMO,
      itens: [{ id: 1, preco_custo: custo }],
    });
    expect(p.itens[0]?.preco_custo).toBe(custo);
  });

  it('near-miss: a pt-BR comma amount is refused, not read as 1.5 or 150', () => {
    expect(liPedidoSchema.safeParse({ ...MINIMO, valor_total: '1,50' }).success).toBe(false);
  });

  it('keeps every undeclared field through passthrough — the order expiry, the coupon, the flags', () => {
    const p = liPedidoSchema.parse(pedidoCartaoNaFormaCapturada);
    expect(p).toHaveProperty('data_expiracao', '2026-09-16T14:03:11.482913');
    expect(p).toHaveProperty('cupom_desconto.codigo', 'CUPOM-SINTETICO');
    expect(p.situacao).toHaveProperty('aprovado', true);
    expect(p.pagamentos[0]).toHaveProperty('pix_code', null);
  });

  it('`itens[].produto` parses as the captured string AND as the documented object', () => {
    const p = liPedidoSchema.parse({
      ...MINIMO,
      itens: [
        { id: 1, produto: '/api/v1/produto/123' },
        { id: 2, produto: { resource_uri: '/api/v1/produto/456?id_externo=1', id_externo: 456 } },
        { id: 3, produto: { resource_uri: null, id_externo: '789' } },
      ],
    });
    expect(p.itens.map((i) => i.produto)).toEqual([
      '/api/v1/produto/123',
      { resource_uri: '/api/v1/produto/456?id_externo=1', id_externo: 456 },
      { resource_uri: null, id_externo: '789' },
    ]);
  });

  it('a pickup method with `tipo: null` and a method with no code both parse', () => {
    const p = liPedidoSchema.parse(pedidoPixNaFormaCapturada);
    expect(p.envios[0]?.forma_envio?.tipo).toBeNull();
    const semCode = liPedidoSchema.parse({
      ...MINIMO,
      envios: [{ id: 1, forma_envio: { id: 9 } }],
    });
    expect(semCode.envios[0]?.forma_envio?.code).toBeUndefined();
  });

  it('`forma_envio.id` is kept RAW — the registration key decides its form, not this schema', () => {
    const ler = (id: unknown) =>
      liPedidoSchema.parse({ ...MINIMO, envios: [{ forma_envio: { id, code: 'X' } }] }).envios[0]
        ?.forma_envio?.id;
    expect(ler(141909)).toBe(141909);
    expect(ler('141909')).toBe('141909');
    // Near-miss: `wireInt()` would fold both of these into 141909.
    expect(ler('0141909')).toBe('0141909');
    expect(ler(' 141909')).toBe(' 141909');
  });

  it('a quoted id elsewhere is still read as a number (wireInt)', () => {
    const p = liPedidoSchema.parse({
      ...MINIMO,
      numero: '165',
      itens: [{ id: '5005' }],
      envios: [{ id: '4004' }],
      pagamentos: [{ id: '69291176' }],
    });
    expect(p.numero).toBe(165);
    expect(p.itens[0]?.id).toBe(5005);
    expect(p.envios[0]?.id).toBe(4004);
    expect(p.pagamentos[0]?.id).toBe(69291176);
  });
});

describe('liPedidoSchema: the required set is minimal', () => {
  it('every optional leaf absent parses, and the three arrays default to []', () => {
    const p = liPedidoSchema.parse(MINIMO);
    expect(p.itens).toEqual([]);
    expect(p.envios).toEqual([]);
    expect(p.pagamentos).toEqual([]);
    expect(p.cliente).toBeUndefined();
    expect(p.endereco_entrega).toBeUndefined();
  });

  it('an empty line, shipment and payment parse — every leaf inside them is optional', () => {
    const p = liPedidoSchema.parse({ ...MINIMO, itens: [{}], envios: [{}], pagamentos: [{}] });
    expect(p.itens).toHaveLength(1);
    expect(p.envios).toHaveLength(1);
    expect(p.pagamentos).toHaveLength(1);
  });

  it('a codigo this ERP does not know still parses — the importer keeps the order', () => {
    const p = liPedidoSchema.parse({ ...MINIMO, situacao: { codigo: 'xyz_novo' } });
    expect(p.situacao.codigo).toBe('xyz_novo');
  });

  it.each([
    ['no numero', { situacao: MINIMO.situacao, data_modificacao: MINIMO.data_modificacao }],
    ['no situacao', { numero: 165, data_modificacao: MINIMO.data_modificacao }],
    ['a situacao without codigo', { ...MINIMO, situacao: { id: 4 } }],
    ['no data_modificacao', { numero: 165, situacao: MINIMO.situacao }],
    ['a fractional numero', { ...MINIMO, numero: 165.5 }],
    ['itens that is not an array', { ...MINIMO, itens: {} }],
  ])('refuses %s', (_caso, corpo) => {
    expect(liPedidoSchema.safeParse(corpo).success).toBe(false);
  });
});

describe('liSituacaoSchema', () => {
  it('types the codigo only; the flags ride through untyped', () => {
    const s = liSituacaoSchema.parse(pedidoCartaoNaFormaCapturada.situacao);
    expect(s.codigo).toBe('pedido_enviado');
    expect(s.id).toBe(11);
    expect(s).toHaveProperty('final', true);
  });

  it('near-miss: a numeric codigo is refused — codigo is text, never a number', () => {
    expect(liSituacaoSchema.safeParse({ codigo: 4 }).success).toBe(false);
  });
});

describe('liSituacaoHistoricoLinhaSchema', () => {
  it('parses every row of the captured shape', () => {
    const linhas = historicoCanceladoNaFormaCapturada.objects.map((o) =>
      liSituacaoHistoricoLinhaSchema.parse(o),
    );
    expect(linhas.map((l) => [l.situacao_anterior?.codigo, l.situacao.codigo])).toEqual([
      ['pedido_efetuado', 'aguardando_pagamento'],
      ['aguardando_pagamento', 'pedido_cancelado'],
    ]);
    expect(linhas.every((l) => l.numero === NUMERO_EXEMPLO)).toBe(true);
  });

  it('a first row with no previous situação parses (null or absent)', () => {
    const base = historicoCanceladoNaFormaCapturada.objects[0];
    expect(
      liSituacaoHistoricoLinhaSchema.parse({ ...base, situacao_anterior: null }).situacao_anterior,
    ).toBeNull();
    const { situacao_anterior: _omitida, ...semAnterior } = base ?? {};
    expect(liSituacaoHistoricoLinhaSchema.safeParse(semAnterior).success).toBe(true);
  });

  it.each(['id', 'numero', 'data', 'situacao'])('refuses a row without `%s`', (campo) => {
    const linha: Record<string, unknown> = { ...historicoCanceladoNaFormaCapturada.objects[0] };
    delete linha[campo];
    expect(liSituacaoHistoricoLinhaSchema.safeParse(linha).success).toBe(false);
  });
});

describe('liProdutoIdentidadeSchema', () => {
  it('reads the LI id, quoted or not, and keeps the rest', () => {
    expect(liProdutoIdentidadeSchema.parse({ id: '123', nome: 'x' })).toEqual({
      id: 123,
      nome: 'x',
    });
    expect(liProdutoIdentidadeSchema.parse({ id: 123, sku: null }).sku).toBeNull();
  });

  it('refuses a produto without an id — there is nothing to resolve to', () => {
    expect(liProdutoIdentidadeSchema.safeParse({ sku: 'A' }).success).toBe(false);
  });
});
