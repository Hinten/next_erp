import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { type ValorJsonLi, redigirCorpo, tabelaDoCaminho } from '../core/redacao';
import {
  CHAVE_DE_TESTE_HEX,
  OUTRA_CHAVE_DE_TESTE_HEX,
  chaveDeTeste,
  colisaoDePseudonimo,
} from '../testing/chaveDeFixtures';
import {
  ChaveDeFixturesLi,
  PSEUDONIMO_MAXIMO_LI,
  OCULTAR_IDS_LI,
  PSEUDONIMO_MINIMO_LI,
  PseudonimosLi,
  idCanonicoLi,
  pseudonimizarCaminhoLi,
  pseudonimizarCorpoLi,
  pseudonimizarQueryLi,
  textoDeChaveNovaLi,
} from './pseudonimo';

/* Synthetic ids and TEST keys only: no capture, no real key. */
const CHAVE = chaveDeTeste();
const OUTRA = chaveDeTeste(OUTRA_CHAVE_DE_TESTE_HEX);
const f = (id: number, chave: ChaveDeFixturesLi = CHAVE) => chave.pseudonimo(String(id));

/** The `fixture` profile's output for a 2xx body, then the mapping under `chave`. */
function pseudonimizar(caminho: string, corpo: unknown, chave: ChaveDeFixturesLi = CHAVE) {
  const r = redigirCorpo({ caminho, status: 200, corpo: JSON.stringify(corpo) }, 'fixture');
  if (!r.ok) throw new Error(`refused: ${r.motivo}`);
  const pseudonimos = new PseudonimosLi(chave);
  return {
    antes: r.corpo,
    depois: pseudonimizarCorpoLi(corpo, r.corpo, tabelaDoCaminho(caminho), pseudonimos),
    pseudonimos,
  };
}

const CATEGORIAS = {
  meta: {
    limit: 50,
    offset: 50,
    total_count: 67,
    previous: '/api/v1/categoria?limit=50&offset=0',
    next: null,
  },
  objects: [
    {
      id: 4101,
      id_externo: null,
      categoria_pai: null,
      nome: 'Camisetas',
      resource_uri: '/v1/categoria/4101',
    },
    {
      id: 4102,
      id_externo: null,
      categoria_pai: '/v1/categoria/4101',
      nome: 'Regatas',
      resource_uri: '/v1/categoria/4102',
    },
  ],
};

const GRADE = {
  id: 6062,
  id_externo: null,
  nome: 'Tamanho',
  resource_uri: '/api/v1/grades/6062',
  variacoes: [
    {
      grade: '/api/v1/grades/6062',
      id: 31,
      nome: 'P',
      resource_uri: '/api/v1/grade/6062/variacao/31',
    },
    {
      grade: '/api/v1/grades/6062',
      id: 32,
      nome: 'M',
      resource_uri: '/api/v1/grade/6062/variacao/32',
    },
  ],
};

describe('the pseudonym', () => {
  it('is 1e8 + (the first 6 bytes of HMAC-SHA256(key, "li-fixture-id:" + id)) mod 9e8', () => {
    const mac = createHmac('sha256', Buffer.from(CHAVE_DE_TESTE_HEX, 'hex'))
      .update('li-fixture-id:1234567', 'utf8')
      .digest();
    expect(CHAVE.pseudonimo('1234567')).toBe(100_000_000 + (mac.readUIntBE(0, 6) % 900_000_000));
  });

  it('is a canonical 9-digit safe integer for every id', () => {
    for (let id = 0; id < 2000; id++) {
      const falso = f(id);
      expect(Number.isSafeInteger(falso)).toBe(true);
      expect(falso).toBeGreaterThanOrEqual(PSEUDONIMO_MINIMO_LI);
      expect(falso).toBeLessThanOrEqual(PSEUDONIMO_MAXIMO_LI);
      expect(String(falso)).toMatch(/^[1-9]\d{8}$/);
    }
    expect([PSEUDONIMO_MINIMO_LI, PSEUDONIMO_MAXIMO_LI]).toEqual([100_000_000, 999_999_999]);
  });

  it('EQUAL: the same key and the same id give the same pseudonym, whatever spells the id', () => {
    expect(f(6062)).toBe(chaveDeTeste().pseudonimo('6062'));
    expect(idCanonicoLi(6062)).toBe('6062');
    expect(idCanonicoLi('0006062')).toBe('6062');
    expect(idCanonicoLi('0')).toBe('0');
    expect(idCanonicoLi('000')).toBe('0');
  });

  it('NEAR-MISS: another key gives other pseudonyms, and so does a neighbouring id', () => {
    for (const id of [1, 6062, 1234567, 7654321]) expect(f(id, OUTRA)).not.toBe(f(id));
    expect(f(6063)).not.toBe(f(6062));
    expect(idCanonicoLi('6062')).not.toBe(idCanonicoLi('60620'));
  });
});

describe('the key file', () => {
  it('reads 64 hexadecimal digits, with or without a BOM, a trailing newline or capitals', () => {
    for (const texto of [
      CHAVE_DE_TESTE_HEX,
      `${CHAVE_DE_TESTE_HEX}\n`,
      `${CHAVE_DE_TESTE_HEX}\r\n`,
      `﻿${CHAVE_DE_TESTE_HEX}`,
      CHAVE_DE_TESTE_HEX.toUpperCase(),
    ]) {
      expect(ChaveDeFixturesLi.deTexto(texto)?.pseudonimo('1')).toBe(f(1));
    }
  });

  it.each([
    ['empty', ''],
    ['63 digits', CHAVE_DE_TESTE_HEX.slice(1)],
    ['65 digits', `${CHAVE_DE_TESTE_HEX}0`],
    ['a non-hexadecimal digit', `${CHAVE_DE_TESTE_HEX.slice(1)}g`],
    ['two lines', `${CHAVE_DE_TESTE_HEX}\n${CHAVE_DE_TESTE_HEX}`],
    ['a space inside', `${CHAVE_DE_TESTE_HEX.slice(0, 32)} ${CHAVE_DE_TESTE_HEX.slice(32)}`],
  ])('refuses %s', (_caso, texto) => {
    expect(ChaveDeFixturesLi.deTexto(texto)).toBeNull();
  });

  it('a new key file is 32 bytes as 64 lowercase digits and a newline, and reads back', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const texto = textoDeChaveNovaLi(bytes);
    expect(texto).toMatch(/^[0-9a-f]{64}\n$/);
    expect(ChaveDeFixturesLi.deTexto(texto)?.pseudonimo('5')).toBe(
      100_000_000 +
        (createHmac('sha256', Buffer.from(bytes))
          .update('li-fixture-id:5')
          .digest()
          .readUIntBE(0, 6) %
          900_000_000),
    );
    expect(() => textoDeChaveNovaLi(new Uint8Array(31))).toThrow(RangeError);
  });

  it('SENTINEL: a key never prints itself (JSON, string, inspect)', () => {
    for (const texto of [JSON.stringify({ CHAVE }), String(CHAVE), inspect(CHAVE)]) {
      expect(texto).not.toContain(CHAVE_DE_TESTE_HEX);
      expect(texto).not.toContain('7e57');
    }
  });
});

describe('PseudonimosLi', () => {
  it('records each pseudonym once and counts no collision for distinct pseudonyms', () => {
    const p = new PseudonimosLi(CHAVE);
    expect(p.de('31')).toBe(f(31));
    expect(p.de('31')).toBe(f(31));
    expect(p.de('32')).toBe(f(32));
    expect(p.colisoes).toBe(0);
    expect([...p.ids.keys()].sort()).toEqual([f(31), f(32)].sort());
  });

  it('NEAR-MISS: two different ids with one pseudonym are a collision', () => {
    const [a, b] = colisaoDePseudonimo();
    expect(a).not.toBe(b);
    const p = new PseudonimosLi(CHAVE);
    expect(p.de(String(a))).toBe(p.de(String(b)));
    expect(p.colisoes).toBe(1);
  });
});

describe('pseudonimizarCaminhoLi: the request path', () => {
  it('maps every digit-only segment, and nothing else', () => {
    const p = new PseudonimosLi(CHAVE);
    expect(pseudonimizarCaminhoLi('/v1/grades/6062/', p)).toBe(`/v1/grades/${String(f(6062))}/`);
    expect(pseudonimizarCaminhoLi('/v1/grades/6062', p)).toBe(`/v1/grades/${String(f(6062))}`);
    expect(pseudonimizarCaminhoLi('/v1/categoria/', p)).toBe('/v1/categoria/');
    expect(pseudonimizarCaminhoLi('/v1/produto/<redacted>/', p)).toBe('/v1/produto/<redacted>/');
    expect(pseudonimizarCaminhoLi('/v1/produto/12a/', p)).toBe('/v1/produto/12a/');
  });

  it('maps each id of a `/set/<id>;<id>` subset (a segment the path redactor keeps)', () => {
    const p = new PseudonimosLi(CHAVE);
    expect(pseudonimizarCaminhoLi('/v1/categoria/set/41;42/', p)).toBe(
      `/v1/categoria/set/${String(f(41))};${String(f(42))}/`,
    );
    // Near-miss: a segment that is not an id list is left alone.
    expect(pseudonimizarCaminhoLi('/v1/categoria/set/41;x/', p)).toBe('/v1/categoria/set/41;x/');
    expect(pseudonimizarCaminhoLi('/v1/categoria/set/;41/', p)).toBe('/v1/categoria/set/;41/');
  });
});

describe('pseudonimizarCorpoLi: a category page', () => {
  const { antes, depois } = pseudonimizar('/v1/categoria/', CATEGORIAS);
  const linha = (v: ValorJsonLi, i: number) =>
    (v as { objects: Record<string, ValorJsonLi>[] }).objects[i] ?? {};

  it("EQUAL: a row's id, its resource_uri and the categoria_pai naming it map to one pseudonym", () => {
    expect(linha(depois, 0)).toMatchObject({
      id: f(4101),
      resource_uri: `/v1/categoria/${String(f(4101))}`,
      categoria_pai: null,
    });
    expect(linha(depois, 1)).toMatchObject({
      id: f(4102),
      resource_uri: `/v1/categoria/${String(f(4102))}`,
      categoria_pai: `/v1/categoria/${String(f(4101))}`,
    });
  });

  it('NEAR-MISS: the meta numbers, meta.previous and the faked leaves are left as the profile wrote them', () => {
    expect((depois as { meta: ValorJsonLi }).meta).toEqual(CATEGORIAS.meta);
    expect(linha(depois, 0).nome).toBe(linha(antes, 0).nome);
    expect(linha(depois, 0).id_externo).toBeNull();
  });

  it('NEAR-MISS: another key gives other ids', () => {
    const outro = pseudonimizar('/v1/categoria/', CATEGORIAS, OUTRA).depois;
    expect(linha(outro, 0).id).toBe(f(4101, OUTRA));
    expect(linha(outro, 0).id).not.toBe(linha(depois, 0).id);
  });

  it('EQUAL: the same key and capture give identical bytes', () => {
    expect(JSON.stringify(pseudonimizar('/v1/categoria/', CATEGORIAS).depois)).toBe(
      JSON.stringify(depois),
    );
  });
});

describe('pseudonimizarCorpoLi: a grade detail', () => {
  it("EQUAL: the grade's id, its URI, every option's plural and singular URI map to one pseudonym", () => {
    const { depois } = pseudonimizar('/v1/grades/6062/', GRADE);
    const g = String(f(6062));
    expect(depois).toMatchObject({
      id: f(6062),
      resource_uri: `/api/v1/grades/${g}`,
      variacoes: [
        {
          grade: `/api/v1/grades/${g}`,
          id: f(31),
          resource_uri: `/api/v1/grade/${g}/variacao/${String(f(31))}`,
        },
        {
          grade: `/api/v1/grades/${g}`,
          id: f(32),
          resource_uri: `/api/v1/grade/${g}/variacao/${String(f(32))}`,
        },
      ],
    });
  });
});

describe('pseudonimizarCorpoLi: what it never touches', () => {
  it('a kept number under a key other than `id`, and a kept URI under a leaf that is not a resource URI', () => {
    const corpo = {
      meta: { limit: 50, offset: 0, total_count: 4101, next: null, previous: null },
      objects: [],
    };
    const { antes, depois } = pseudonimizar('/v1/categoria/', corpo);
    expect(depois).toEqual(antes);
    expect(depois).toEqual(corpo);
    // A URI-shaped SKU is a SKU: kept as captured.
    const produto = { sku: '/v1/categoria/4101', estoque_quantidade: 4101 };
    expect(pseudonimizar('/v1/produto/7', produto).depois).toEqual(produto);
  });

  it('a resource-URI leaf the predicate refuses (the profile faked it): not mapped', () => {
    const corpo = { objects: [{ id: 7, resource_uri: 'https://x.invalid/v1/categoria/7' }] };
    const { depois } = pseudonimizar('/v1/categoria/', corpo);
    expect(depois).toEqual({ objects: [{ id: f(7), resource_uri: 'REDACTED' }] });
  });

  it('a kept leaf the predicate refuses is not mapped, even under a resource-URI path', () => {
    // Bypasses the profile on purpose: only the mapping's own guard stands here.
    const bruto = { resource_uri: '/v1/categoria/7?x=1' };
    const p = new PseudonimosLi(CHAVE);
    expect(pseudonimizarCorpoLi(bruto, bruto, tabelaDoCaminho('/v1/categoria/7'), p)).toEqual(
      bruto,
    );
    expect(p.ids.size).toBe(0);
  });

  it('an `id` the profile faked stays the fake', () => {
    const bruto = { id: 7.5 };
    const { antes, depois } = pseudonimizar('/v1/categoria/7', bruto);
    expect(antes).toEqual({ id: 0 });
    expect(depois).toEqual({ id: 0 });
  });

  it('a digit-only `id` string the profile kept is mapped as a string', () => {
    const { depois } = pseudonimizar('/v1/categoria/7', { id: '7' });
    expect(depois).toEqual({ id: String(f(7)) });
  });

  it('keeps an own `__proto__` key and every renamed key in place', () => {
    const texto = '{"__proto__":{"id":7},"id":8}';
    const bruto: unknown = JSON.parse(texto);
    const r = redigirCorpo({ caminho: '/v1/categoria/8', status: 200, corpo: texto }, 'fixture');
    if (!r.ok) throw new Error('refused');
    const depois = pseudonimizarCorpoLi(
      bruto,
      r.corpo,
      tabelaDoCaminho('/v1/categoria/8'),
      new PseudonimosLi(CHAVE),
    );
    expect(Object.keys(depois ?? {})).toEqual(['__proto__', 'id']);
    expect((depois as Record<string, ValorJsonLi>).id).toBe(f(8));
  });
});

describe('pseudonimizarCorpoLi: other kept id leaves', () => {
  const PRODUTO = {
    id: 7,
    sku: 'CAM-01',
    estoque_quantidade: 5,
    imagem_principal: { id: 18, imagem_id: 19, posicao: 1 },
    imagens: [{ id: 18, imagem_id: 19, posicao: 1 }],
  };

  it('EQUAL: a kept number under a key ending in `_id` (an image id) is mapped like an `id`', () => {
    const { depois } = pseudonimizar('/v1/produto/7', PRODUTO);
    expect(depois).toMatchObject({
      id: f(7),
      imagem_principal: { id: f(18), imagem_id: f(19) },
      imagens: [{ id: f(18), imagem_id: f(19) }],
    });
  });

  it('NEAR-MISS: a kept number under any other key stays as captured', () => {
    const { antes, depois } = pseudonimizar('/v1/produto/7', PRODUTO);
    expect(depois).toMatchObject({
      sku: 'CAM-01',
      estoque_quantidade: 5,
      imagem_principal: { posicao: 1 },
      imagens: [{ posicao: 1 }],
    });
    expect((antes as { estoque_quantidade: number }).estoque_quantidade).toBe(5);
  });
});

describe('pseudonimizarCorpoLi: meta.next and meta.previous', () => {
  it('EQUAL: a `produto=` value and the path ids of meta.next map like the rows they name', () => {
    const corpo = {
      meta: {
        limit: 1,
        offset: 0,
        total_count: 2,
        next: '/api/v1/produto_imagem/?limit=1&offset=1&produto=5555',
        previous: '/api/v1/categoria/set/3333;2222/?limit=20&offset=0',
      },
      objects: [
        { id: 1, produto: '/api/v1/produto/5555', resource_uri: '/api/v1/produto_imagem/1' },
      ],
    };
    const { depois } = pseudonimizar('/v1/produto_imagem/', corpo);
    const p = String(f(5555));
    expect(depois).toMatchObject({
      meta: {
        limit: 1,
        offset: 0,
        total_count: 2,
        next: `/api/v1/produto_imagem/?limit=1&offset=1&produto=${p}`,
        previous: `/api/v1/categoria/set/${String(f(3333))};${String(f(2222))}/?limit=20&offset=0`,
      },
      objects: [{ produto: `/api/v1/produto/${p}` }],
    });
  });

  it('NEAR-MISS: limit, offset and every other query value of meta.next stay as captured', () => {
    const corpo = {
      meta: {
        limit: 20,
        offset: 20,
        total_count: 67,
        next: '/api/v1/categoria?limit=20&offset=40&ativo=1&numero=5555',
        previous: '/api/v1/categoria?limit=20&offset=0',
      },
      objects: [],
    };
    const { antes, depois } = pseudonimizar('/v1/categoria/', corpo);
    expect(depois).toEqual(antes);
    expect(depois).toEqual(corpo);
  });
});

describe('pseudonimizarQueryLi: the request query', () => {
  it('maps a digit-only `produto` value, and nothing else', () => {
    const p = new PseudonimosLi(CHAVE);
    expect(
      pseudonimizarQueryLi(
        [
          ['limit', '50'],
          ['offset', '50'],
          ['produto', '5555'],
          ['numero', '5555'],
        ],
        p,
      ),
    ).toEqual([
      ['limit', '50'],
      ['offset', '50'],
      ['produto', String(f(5555))],
      ['numero', '5555'],
    ]);
    expect(pseudonimizarQueryLi([['produto', '<redacted>']], p)).toEqual([
      ['produto', '<redacted>'],
    ]);
    expect(p.ids.size).toBe(1);
  });
});

describe('OCULTAR_IDS_LI: the request line of a pair with no key', () => {
  it('blanks every id position of a path and the `produto` query value, and nothing else', () => {
    expect(pseudonimizarCaminhoLi('/v1/categoria/set/41;42/', OCULTAR_IDS_LI)).toBe(
      '/v1/categoria/set/<id>;<id>/',
    );
    expect(
      pseudonimizarQueryLi(
        [
          ['produto', '5555'],
          ['limit', '5'],
        ],
        OCULTAR_IDS_LI,
      ),
    ).toEqual([
      ['produto', '<id>'],
      ['limit', '5'],
    ]);
  });
});

describe('pseudonimizarCorpoLi: the mapping guards its own scope', () => {
  const TABELA = tabelaDoCaminho('/v1/categoria/7');
  /** Bypasses the profile on purpose: `bruto` stands for both trees, so every leaf is KEPT. */
  const direto = (bruto: ValorJsonLi) => {
    const p = new PseudonimosLi(CHAVE);
    return { depois: pseudonimizarCorpoLi(bruto, bruto, TABELA, p), p };
  };

  it('NEAR-MISS: a key that ends in `id` without the underscore is not an id key', () => {
    const { depois, p } = direto({ paid: 5, valid: '6' });
    expect(depois).toEqual({ paid: 5, valid: '6' });
    expect(p.ids.size).toBe(0);
  });

  it('NEAR-MISS: a kept `id` that is not a safe integer or a digit run is left alone', () => {
    expect(direto({ id: 7.5 }).depois).toEqual({ id: 7.5 });
    expect(direto({ id: 'abc' }).depois).toEqual({ id: 'abc' });
    expect(direto({ id: '12a' }).depois).toEqual({ id: '12a' });
  });

  it('NEAR-MISS: a URI the resource-URI predicate refuses keeps its digit segments', () => {
    const { depois, p } = direto({ resource_uri: 'https://x.invalid/v1/categoria/7' });
    expect(depois).toEqual({ resource_uri: 'https://x.invalid/v1/categoria/7' });
    expect(p.ids.size).toBe(0);
  });

  it('a catalogue 2xx body that is `null` stays `null` (a root leaf has no key)', () => {
    expect(pseudonimizar('/v1/categoria/', null).depois).toBeNull();
    expect(direto(null).depois).toBeNull();
  });

  it('writes the keys the profile wrote, a renamed one included, never the raw ones', () => {
    const { antes, depois } = pseudonimizar('/v1/categoria/7', { 'a-b': 1, id: 7 });
    expect(Object.keys(antes ?? {})).not.toContain('a-b');
    expect(Object.keys(depois ?? {})).toEqual(Object.keys(antes ?? {}));
    expect((depois as Record<string, ValorJsonLi>).id).toBe(f(7));
  });

  it('EQUAL: a meta.previous with no query still has its path ids mapped', () => {
    const corpo = {
      meta: {
        limit: 2,
        offset: 0,
        total_count: 2,
        next: null,
        previous: '/api/v1/categoria/set/3333;2222/',
      },
      objects: [],
    };
    expect(pseudonimizar('/v1/categoria/', corpo).depois).toMatchObject({
      meta: { previous: `/api/v1/categoria/set/${String(f(3333))};${String(f(2222))}/` },
    });
  });
});
