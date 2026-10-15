import { wireNumber } from '@delfrance/core/wire';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import {
  type liEnderecoEntregaSchema,
  type liFormaEnvioSchema,
  type liPedidoClienteSchema,
  liPedidoSchema,
  liProdutoIdentidadeSchema,
  liSituacaoHistoricoLinhaSchema,
  liSituacaoSchema,
  type PedidoEnvioLi,
  type PedidoItemLi,
  type PedidoLi,
  type PedidoPagamentoLi,
  type SituacaoHistoricoLinhaLi,
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

  it.each(['itens', 'envios', 'pagamentos'] as const)(
    'a JSON `null` %s reads as [] like an absent one — a refusal would park the order for good',
    (campo) => {
      const p = liPedidoSchema.parse({ ...MINIMO, [campo]: null });
      expect(p[campo]).toEqual([]);
    },
  );

  it('the order’s own `id_externo` is NOT a hub marker and is not typed: any shape parses, kept raw', () => {
    // A store-side ERP may stamp it through the platform's API; the hub guard
    // reads `id_anymarket` only. Undeclared, it can never fail the parse.
    for (const idExterno of ['ERP-123', 4512, { origem: 'erp', id: 9 }, true]) {
      const p = liPedidoSchema.parse({ ...MINIMO, id_externo: idExterno });
      expect(p).toHaveProperty('id_externo', idExterno);
    }
  });

  it('`id_anymarket` stays typed (text or number, nullable) — the hub guard reads its presence', () => {
    expect(liPedidoSchema.parse({ ...MINIMO, id_anymarket: 'AM-1' }).id_anymarket).toBe('AM-1');
    expect(liPedidoSchema.parse({ ...MINIMO, id_anymarket: 77 }).id_anymarket).toBe(77);
    expect(liPedidoSchema.parse({ ...MINIMO, id_anymarket: null }).id_anymarket).toBeNull();
  });

  it('an empty buyer and an empty delivery address parse — a pickup order may carry no CEP', () => {
    const p = liPedidoSchema.parse({ ...MINIMO, cliente: {}, endereco_entrega: {} });
    expect(p.cliente).toEqual({});
    expect(p.endereco_entrega).toEqual({});
    const nulos = liPedidoSchema.parse({
      ...MINIMO,
      endereco_entrega: { cep: null, estado: null },
    });
    expect(nulos.endereco_entrega?.cep).toBeNull();
  });

  it('a fractional quantity (three decimals on the wire) is kept, never refused as a non-integer', () => {
    const p = liPedidoSchema.parse({ ...MINIMO, itens: [{ id: 1, quantidade: '1.500' }] });
    expect(p.itens[0]?.quantidade).toBe(1.5);
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

type Caminho = readonly (string | number)[];

/**
 * The card order (captured shape) with each leaf at `caminho` replaced by its
 * `valor`, or DELETED when that is `undefined`. A deep copy every time.
 */
function pedidoComFolhas(edicoes: readonly (readonly [Caminho, unknown])[]) {
  const corpo = structuredClone(pedidoCartaoNaFormaCapturada) as Record<string, unknown>;
  for (const [caminho, valor] of edicoes) {
    let alvo = corpo as Record<string | number, unknown>;
    for (const seg of caminho.slice(0, -1)) alvo = alvo[seg] as Record<string | number, unknown>;
    const ultimo = caminho[caminho.length - 1]!;
    if (valor === undefined) delete alvo[ultimo];
    else alvo[ultimo] = valor;
  }
  return corpo;
}

const pedidoCom = (caminho: Caminho, valor: unknown) => pedidoComFolhas([[caminho, valor]]);

function folha(corpo: unknown, caminho: Caminho): unknown {
  let v = corpo;
  for (const seg of caminho) v = (v as Record<string | number, unknown>)[seg];
  return v;
}

/** The parsed leaf, or `'RECUSADO'` when the whole order is refused. */
function lerComFolha(caminho: Caminho, valor: unknown): unknown {
  const r = liPedidoSchema.safeParse(pedidoCom(caminho, valor));
  return r.success ? folha(r.data, caminho) : 'RECUSADO';
}

const nomeado = (caminhos: Caminho[]) => caminhos.map((c) => [c.join('.'), c] as const);

/**
 * Every OPTIONAL leaf of the order that reads `''` as `null`, by kind, each
 * with its near-misses: a leaf that loses its helper fails its own `''` case
 * below, by name. Each path exists in the card order, so the test exercises
 * the leaf inside a whole, otherwise valid body. These lists are kept by hand;
 * the sweep further down walks the SCHEMA, so a leaf added without an entry
 * here is still covered.
 */
const FOLHAS_NUMERO: Caminho[] = [
  ['valor_total'],
  ['valor_subtotal'],
  ['valor_envio'],
  ['valor_desconto'],
  ['itens', 0, 'quantidade'],
  ['itens', 0, 'preco_venda'],
  ['itens', 0, 'preco_cheio'],
  ['itens', 0, 'preco_promocional'],
  ['itens', 0, 'preco_subtotal'],
  ['itens', 0, 'peso'],
  ['itens', 0, 'altura'],
  ['itens', 0, 'largura'],
  ['itens', 0, 'profundidade'],
  ['envios', 0, 'valor'],
  ['pagamentos', 0, 'valor'],
  ['pagamentos', 0, 'valor_pago'],
  ['pagamentos', 0, 'parcelamento', 'valor_parcela'],
];

/** Counts, and the ids nothing keys a write on (diagnostic or unread). */
const FOLHAS_INTEIRO: Caminho[] = [
  ['situacao', 'id'],
  ['itens', 0, 'linha'],
  ['envios', 0, 'prazo'],
  ['pagamentos', 0, 'parcelamento', 'numero_parcelas'],
  ['pagamentos', 0, 'forma_pagamento', 'id'],
  ['cliente', 'id'],
];

/**
 * The three ids the import KEYS a write on: the line's `ensureUniqueId`, the
 * freight block's `externalId`, the pagamento digest. Integer leaves like the
 * ones above: the schema does not decide what a missing key costs, the
 * importer does, in one place.
 */
const FOLHAS_CHAVE: Caminho[] = [
  ['itens', 0, 'id'],
  ['envios', 0, 'id'],
  ['pagamentos', 0, 'id'],
];

const FOLHAS_OBJETO: Caminho[] = [
  ['cliente'],
  ['endereco_entrega'],
  ['envios', 0, 'forma_envio'],
  ['pagamentos', 0, 'forma_pagamento'],
  ['pagamentos', 0, 'parcelamento'],
];

describe('an empty optional wire leaf reads as null — it never parks the order', () => {
  it('a full order in the captured shape with an empty `peso` on one line parses, and that leaf is null', () => {
    const r = liPedidoSchema.safeParse(pedidoCom(['itens', 0, 'peso'], ''));
    expect(r.success).toBe(true);
    expect(r.data?.itens[0]?.peso).toBeNull();
    // The sibling line is untouched.
    expect(r.data?.itens[1]?.peso).toBe(0.1);
  });

  describe.each(nomeado(FOLHAS_NUMERO))('number leaf `%s`', (_nome, caminho) => {
    it("'' reads as null", () => {
      expect(lerComFolha(caminho, '')).toBeNull();
    });
    it.each([
      ['a non-numeric string', 'abc'],
      ['a whitespace-only string', '  '],
      ['a pt-BR decimal comma', '1,50'],
    ])('near-miss: %s is still refused — only the exact empty string is "nothing"', (_c, v) => {
      expect(lerComFolha(caminho, v)).toBe('RECUSADO');
    });
    it('null stays null and an absent key stays undefined', () => {
      expect(lerComFolha(caminho, null)).toBeNull();
      expect(lerComFolha(caminho, undefined)).toBeUndefined();
    });
    it('a wire value still parses — a JSON number, a decimal string, and a zero that is not "nothing"', () => {
      expect(lerComFolha(caminho, 12.5)).toBe(12.5);
      expect(lerComFolha(caminho, '12.5000')).toBe(12.5);
      expect(lerComFolha(caminho, 0)).toBe(0);
      expect(lerComFolha(caminho, '0')).toBe(0);
    });
  });

  describe.each(nomeado([...FOLHAS_INTEIRO, ...FOLHAS_CHAVE]))(
    'integer leaf `%s`',
    (_nome, caminho) => {
      it("'' reads as null", () => {
        expect(lerComFolha(caminho, '')).toBeNull();
      });
      it.each([
        ['a non-numeric string', 'abc'],
        ['a whitespace-only string', '  '],
        ['a fractional string', '2.5'],
      ])('near-miss: %s is still refused', (_c, v) => {
        expect(lerComFolha(caminho, v)).toBe('RECUSADO');
      });
      it('null stays null and an absent key stays undefined', () => {
        expect(lerComFolha(caminho, null)).toBeNull();
        expect(lerComFolha(caminho, undefined)).toBeUndefined();
      });
      it('a wire value still parses — a JSON number, a quoted one, and a zero', () => {
        expect(lerComFolha(caminho, 7)).toBe(7);
        expect(lerComFolha(caminho, '7')).toBe(7);
        expect(lerComFolha(caminho, 0)).toBe(0);
        expect(lerComFolha(caminho, '0')).toBe(0);
      });
    },
  );

  describe.each(nomeado(FOLHAS_OBJETO))('object leaf `%s`', (_nome, caminho) => {
    it("'' reads as null", () => {
      expect(lerComFolha(caminho, '')).toBeNull();
    });
    it.each([
      ['a non-empty string', 'abc'],
      ['a whitespace-only string', '  '],
      ['an array', []],
    ])('near-miss: %s is still refused', (_c, v) => {
      expect(lerComFolha(caminho, v)).toBe('RECUSADO');
    });
    it('null stays null, an absent key stays undefined, and an object still parses', () => {
      expect(lerComFolha(caminho, null)).toBeNull();
      expect(lerComFolha(caminho, undefined)).toBeUndefined();
      expect(lerComFolha(caminho, { extra: 1 })).toEqual({ extra: 1 });
    });
  });

  it("`id_anymarket` (read for presence) reads '' as null; any other text, a blank included, stays as given", () => {
    expect(lerComFolha(['id_anymarket'], '')).toBeNull();
    // Near-miss: only the exact empty string is folded.
    expect(lerComFolha(['id_anymarket'], ' ')).toBe(' ');
    expect(lerComFolha(['id_anymarket'], 'AM-1')).toBe('AM-1');
    expect(lerComFolha(['id_anymarket'], 0)).toBe(0);
    expect(lerComFolha(['id_anymarket'], null)).toBeNull();
    expect(lerComFolha(['id_anymarket'], undefined)).toBeUndefined();
    // The leaf schema on its own gives the same answer: it is what a raw-body
    // hub hint reads the marker through, so the two surfaces share one rule.
    const leaf = liPedidoSchema.shape.id_anymarket;
    expect(leaf.parse('')).toBeNull();
    expect(leaf.parse(' ')).toBe(' ');
    expect(leaf.parse(undefined)).toBeUndefined();
  });

  it.each(nomeado(FOLHAS_CHAVE))(
    "key id `%s`: '', null and an absent key are ONE outcome — no id, never a refusal of the whole order",
    (_nome, caminho) => {
      const lidos = ['', null, undefined].map((v) => lerComFolha(caminho, v));
      expect(lidos).not.toContain('RECUSADO');
      expect(lidos.map((v) => v ?? 'SEM-ID')).toEqual(['SEM-ID', 'SEM-ID', 'SEM-ID']);
      // Near-miss: a present id is read, a broken one is still refused.
      expect(lerComFolha(caminho, '5005')).toBe(5005);
      expect(lerComFolha(caminho, 'abc')).toBe('RECUSADO');
    },
  );

  it("text-capable leaves keep their '' — it already parses, and the mapper reads text", () => {
    expect(lerComFolha(['itens', 0, 'produto'], '')).toBe('');
    expect(lerComFolha(['envios', 0, 'forma_envio', 'id'], '')).toBe('');
    expect(lerComFolha(['cliente_obs'], '')).toBe('');
    expect(lerComFolha(['endereco_entrega', 'complemento'], '')).toBe('');
  });

  it('a whole order with several empty optional leaves at once parses, and keeps everything else', () => {
    const vazias: Caminho[] = [
      ['valor_desconto'],
      ['itens', 0, 'peso'],
      ['itens', 1, 'altura'],
      ['envios', 0, 'prazo'],
      ['envios', 0, 'forma_envio'],
      ['pagamentos', 0, 'parcelamento', 'numero_parcelas'],
      ['situacao', 'id'],
      ['cliente', 'id'],
      ['id_anymarket'],
    ];
    const p = liPedidoSchema.parse(pedidoComFolhas(vazias.map((c) => [c, ''] as const)));
    expect(p.valor_desconto).toBeNull();
    expect(p.itens[0]?.peso).toBeNull();
    expect(p.itens[1]?.altura).toBeNull();
    expect(p.envios[0]?.prazo).toBeNull();
    expect(p.envios[0]?.forma_envio).toBeNull();
    expect(p.pagamentos[0]?.parcelamento?.numero_parcelas).toBeNull();
    expect(p.situacao.id).toBeNull();
    expect(p.cliente?.id).toBeNull();
    expect(p.id_anymarket).toBeNull();
    // Everything else is read exactly as before.
    expect(p.numero).toBe(NUMERO_EXEMPLO);
    expect(p.situacao.codigo).toBe('pedido_enviado');
    expect(p.valor_total).toBe(152.2);
    expect(p.itens[0]?.quantidade).toBe(2);
    expect(p.envios[0]?.valor).toBe(18.5);
    expect(p.pagamentos[0]?.parcelamento?.valor_parcela).toBe(50.73);
    expect(p.cliente?.email).toBe(pedidoCartaoNaFormaCapturada.cliente.email);
  });

  it.each([
    ['the order `numero`', ['numero']],
    ['the `situacao`', ['situacao']],
    ['`itens` (a list never reads a string as [])', ['itens']],
    ['`envios`', ['envios']],
    ['`pagamentos`', ['pagamentos']],
    ['a line (a list entry is an object, never "nothing")', ['itens', 0]],
  ] as const)('an empty REQUIRED leaf — %s — is still refused, at its own path', (_c, caminho) => {
    const r = liPedidoSchema.safeParse(pedidoCom(caminho, ''));
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual([caminho.join('.')]);
  });

  it('the history row: an empty `id` or `numero` is refused, an empty previous situação reads as null', () => {
    const base = historicoCanceladoNaFormaCapturada.objects[1]!;
    expect(liSituacaoHistoricoLinhaSchema.safeParse({ ...base, id: '' }).success).toBe(false);
    expect(liSituacaoHistoricoLinhaSchema.safeParse({ ...base, numero: '' }).success).toBe(false);
    expect(liSituacaoHistoricoLinhaSchema.safeParse({ ...base, situacao: '' }).success).toBe(false);
    const linha = liSituacaoHistoricoLinhaSchema.parse({
      ...base,
      situacao: { ...base.situacao, id: '' },
      situacao_anterior: '',
    });
    expect(linha.situacao_anterior).toBeNull();
    expect(linha.situacao.id).toBeNull();
    expect(linha.situacao.codigo).toBe('pedido_cancelado');
    // Near-miss: a non-empty string is not a situação.
    expect(
      liSituacaoHistoricoLinhaSchema.safeParse({ ...base, situacao_anterior: 'abc' }).success,
    ).toBe(false);
  });

  it('the produto identity: an empty `id` is refused — there is nothing to resolve to', () => {
    expect(liProdutoIdentidadeSchema.safeParse({ id: '', sku: 'A' }).success).toBe(false);
  });

  it('the parsed TYPES are unchanged: the helper widens the input, never the output', () => {
    expectTypeOf<PedidoLi['valor_total']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<PedidoItemLi['peso']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<PedidoItemLi['id']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<PedidoEnvioLi['prazo']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<PedidoPagamentoLi['valor']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<PedidoLi['id_anymarket']>().toEqualTypeOf<string | number | null | undefined>();
    expectTypeOf<PedidoLi['cliente']>().toEqualTypeOf<
      z.output<typeof liPedidoClienteSchema> | null | undefined
    >();
    expectTypeOf<PedidoLi['endereco_entrega']>().toEqualTypeOf<
      z.output<typeof liEnderecoEntregaSchema> | null | undefined
    >();
    expectTypeOf<PedidoEnvioLi['forma_envio']>().toEqualTypeOf<
      z.output<typeof liFormaEnvioSchema> | null | undefined
    >();
    expectTypeOf<SituacaoHistoricoLinhaLi['situacao_anterior']>().toEqualTypeOf<
      z.output<typeof liSituacaoSchema> | null | undefined
    >();
  });
});

/** The parts of a Zod 4 schema definition the sweep below walks. */
interface EsquemaZod {
  readonly def: {
    readonly type: string;
    readonly shape?: Readonly<Record<string, EsquemaZod>>;
    readonly element?: EsquemaZod;
    readonly innerType?: EsquemaZod;
    readonly in?: EsquemaZod;
    readonly out?: EsquemaZod;
  };
}

/** Wrappers whose `innerType` carries the structure. */
const EMBRULHOS = new Set(['optional', 'nullable', 'default', 'prefault', 'catch', 'readonly']);

/**
 * The schema that carries the structure under the optional / nullable wrappers
 * and the pipes: a preprocess (`vazioComoNulo`, `wireNumber()`) keeps it on its
 * OUT side, a `.transform()` (`lista`) on its IN side.
 */
function semEmbrulho(s: EsquemaZod): EsquemaZod {
  const { type, innerType, in: entrada, out: saida } = s.def;
  if (innerType && EMBRULHOS.has(type)) return semEmbrulho(innerType);
  if (type === 'pipe' && entrada && saida) {
    return semEmbrulho(saida.def.type === 'transform' ? entrada : saida);
  }
  return s;
}

/**
 * Every key path `schema` DECLARES: each object key, the keys of each nested
 * object, and a list's entry as index 0. A union is a leaf (its object branch is
 * a form the importer tests, not a shape this sweep owns).
 */
function caminhosDeclarados(schema: unknown, prefixo: Caminho = []): Caminho[] {
  const { type, shape, element } = semEmbrulho(schema as EsquemaZod).def;
  if (type === 'object' && shape) {
    return Object.entries(shape).flatMap(([chave, filho]) => {
      const caminho = [...prefixo, chave];
      return [caminho, ...caminhosDeclarados(filho, caminho)];
    });
  }
  if (type === 'array' && element) {
    const caminho = [...prefixo, 0];
    return [caminho, ...caminhosDeclarados(element, caminho)];
  }
  return [];
}

/** `corpo` with its leaf at `caminho` set to `valor`, as a deep copy. The parent must exist. */
function comFolha(corpo: unknown, caminho: Caminho, valor: unknown): unknown {
  const copia = structuredClone(corpo);
  let alvo = copia as Record<string | number, unknown>;
  for (const seg of caminho.slice(0, -1)) {
    const proximo = alvo[seg];
    if (proximo === null || typeof proximo !== 'object') {
      throw new Error(`teste: the body has no parent for ${caminho.join('.')}`);
    }
    alvo = proximo as Record<string | number, unknown>;
  }
  alvo[caminho[caminho.length - 1]!] = valor;
  return copia;
}

/**
 * Puts `''` at each path of `caminhos`, one at a time, and parses the whole
 * body. Returns the paths refused, and every path that broke the contract: a
 * refusal must name only that path, and a parse must read the leaf as `null`
 * (folded) or keep it as `''` (text).
 */
function varrerVazios(schema: z.ZodType, corpo: unknown, caminhos: readonly Caminho[]) {
  const recusados = new Set<string>();
  const problemas: string[] = [];
  for (const caminho of caminhos) {
    const nome = caminho.join('.');
    const r = schema.safeParse(comFolha(corpo, caminho, ''));
    if (!r.success) {
      recusados.add(nome);
      const onde = r.error.issues.map((i) => i.path.join('.'));
      if (onde.length !== 1 || onde[0] !== nome) problemas.push(`${nome}: refused elsewhere`);
      continue;
    }
    const lido = folha(r.data, caminho);
    if (lido !== null && lido !== '') problemas.push(`${nome}: read as neither null nor ''`);
  }
  return { recusados, problemas };
}

/** The order's paths where `''` must still be refused: the required set and a list entry. */
const ESTRITOS_PEDIDO = new Set([
  'numero',
  'situacao',
  'itens',
  'itens.0',
  'envios',
  'envios.0',
  'pagamentos',
  'pagamentos.0',
]);

describe("the '' sweep: every DECLARED leaf, found by walking the schema itself", () => {
  const caminhosDoPedido = caminhosDeclarados(liPedidoSchema);

  it('the walk reaches the whole declared shape: every hand-listed leaf above is in it', () => {
    const declarados = new Set(caminhosDoPedido.map((c) => c.join('.')));
    for (const c of [...FOLHAS_NUMERO, ...FOLHAS_INTEIRO, ...FOLHAS_CHAVE, ...FOLHAS_OBJETO]) {
      expect(declarados.has(c.join('.')), c.join('.')).toBe(true);
    }
    for (const nome of ['id_anymarket', 'itens.0.preco_custo', 'envios.0.forma_envio.id']) {
      expect(declarados.has(nome), nome).toBe(true);
    }
  });

  it("the order: '' is refused ONLY on the required set, each at its own path; every other leaf reads null or ''", () => {
    const { recusados, problemas } = varrerVazios(
      liPedidoSchema,
      pedidoCartaoNaFormaCapturada,
      caminhosDoPedido,
    );
    expect(problemas).toEqual([]);
    expect(recusados).toEqual(ESTRITOS_PEDIDO);
  });

  it("a history row: '' is refused only on `id`, `numero` and `situacao`", () => {
    const { recusados, problemas } = varrerVazios(
      liSituacaoHistoricoLinhaSchema,
      historicoCanceladoNaFormaCapturada.objects[1],
      caminhosDeclarados(liSituacaoHistoricoLinhaSchema),
    );
    expect(problemas).toEqual([]);
    expect(recusados).toEqual(new Set(['id', 'numero', 'situacao']));
  });

  it("the produto identity: '' is refused only on `id`", () => {
    const { recusados, problemas } = varrerVazios(
      liProdutoIdentidadeSchema,
      { id: 123, sku: 'A' },
      caminhosDeclarados(liProdutoIdentidadeSchema),
    );
    expect(problemas).toEqual([]);
    expect(recusados).toEqual(new Set(['id']));
  });

  it('near-miss: the sweep CATCHES a new leaf declared with the old idiom — it is not vacuous', () => {
    // `peso_real` rides through passthrough today; declared the old way, its ''
    // would refuse the whole order, and nothing hand-listed above would know.
    const comFolhaVelha = liPedidoSchema.extend({ peso_real: wireNumber().nullable().optional() });
    const { recusados } = varrerVazios(
      comFolhaVelha,
      pedidoCartaoNaFormaCapturada,
      caminhosDeclarados(comFolhaVelha),
    );
    expect(recusados.has('peso_real')).toBe(true);
  });
});

describe('liSituacaoSchema', () => {
  it('types the codigo only; the flags ride through untyped', () => {
    const s = liSituacaoSchema.parse(pedidoCartaoNaFormaCapturada.situacao);
    expect(s.codigo).toBe('pedido_enviado');
    expect(s.id).toBe(11);
    expect(s).toHaveProperty('final', true);
  });

  it('a quoted situação id is read as a number — a diagnostic leaf must never park the order', () => {
    expect(liSituacaoSchema.parse({ codigo: 'pedido_pago', id: '4' }).id).toBe(4);
    expect(
      liPedidoSchema.parse({ ...MINIMO, situacao: { codigo: 'pedido_pago', id: '4' } }).situacao.id,
    ).toBe(4);
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
