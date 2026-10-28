import { describe, expect, it } from 'vitest';

import {
  liCategoriaSchema,
  liEnvelopeSchema,
  liGradeDetalheSchema,
  liGradeSchema,
  liMarcaSchema,
  liMetaSchema,
  liOpcaoGradeSchema,
  liPedidoBuscaLinhaSchema,
} from '../src/types';
import {
  categoriaSintetica,
  gradeDetalheSintetica,
  gradesSinteticas,
  marcasSinteticas,
  paginaCategoriasSintetica,
} from './_fixtures/catalogoSintetico';
import {
  categoriaPagina1,
  categoriaUltimaPagina,
  gradeDetalheExemplo,
  gradesPaginaExemplo,
  marcaPaginaExemplo,
  metaLimite15,
  pedidoBuscaExemplo,
} from './_fixtures/especificacao';

const envelopeCategoria = liEnvelopeSchema(liCategoriaSchema);
const envelopePedidoBusca = liEnvelopeSchema(liPedidoBuscaLinhaSchema);
const [linha164, linha165] = pedidoBuscaExemplo.objects;

describe('the document examples', () => {
  it('the categoria list example parses', () => {
    const r = envelopeCategoria.safeParse(categoriaPagina1);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.meta).toMatchObject({
      limit: 20,
      offset: 0,
      next: '/api/v1/categoria?limit=20&offset=20',
      previous: null,
      total_count: 55,
    });
    expect(r.data.objects.map((o) => o.id)).toEqual([7645875, 7645904, 7645906]);
    expect(r.data.objects[0]?.categoria_pai).toBeNull();
    expect(r.data.objects[1]?.categoria_pai).toBe('/api/v1/categoria/7645875');
  });

  it('the last-page example parses with next: null', () => {
    const r = envelopeCategoria.safeParse(categoriaUltimaPagina);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.meta.next).toBeNull();
  });

  it('the pedido/search meta (limit 15) parses', () => {
    expect(liMetaSchema.parse(metaLimite15).limit).toBe(15);
  });
});

describe('number tolerance', () => {
  it('`limit: "20"` reads as 20, and so do a quoted offset, total_count and id', () => {
    const meta = liMetaSchema.parse({
      ...categoriaPagina1.meta,
      limit: '20',
      offset: '40',
      total_count: '55',
    });
    expect(meta.limit).toBe(20);
    expect(meta.offset).toBe(40);
    expect(meta.total_count).toBe(55);
    expect(liCategoriaSchema.parse({ ...categoriaPagina1.objects[0], id: '7645875' }).id).toBe(
      7645875,
    );
  });

  it('near-miss: a non-numeric or fractional limit still fails', () => {
    expect(liMetaSchema.safeParse({ ...categoriaPagina1.meta, limit: 'vinte' }).success).toBe(
      false,
    );
    expect(liMetaSchema.safeParse({ ...categoriaPagina1.meta, limit: '20.5' }).success).toBe(false);
    expect(liMetaSchema.safeParse({ ...categoriaPagina1.meta, limit: '' }).success).toBe(false);
  });

  it('total_count may be absent or null', () => {
    const { total_count: _omitido, ...semTotal } = categoriaPagina1.meta;
    expect(liMetaSchema.safeParse(semTotal).success).toBe(true);
    expect(liMetaSchema.safeParse({ ...semTotal, total_count: null }).success).toBe(true);
  });
});

describe('an empty total_count', () => {
  const { total_count: _omitido, ...semTotal } = categoriaPagina1.meta;
  const comTotal = (total_count: unknown) => liMetaSchema.safeParse({ ...semTotal, total_count });

  it("`''` reads as null — never 0, which would announce an empty window", () => {
    const r = comTotal('');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.total_count).toBeNull();
  });

  it.each([['abc'], ['   '], [' '], ['2.5'], [2.5], ['1,5']])(
    'near-miss: %j is still refused, at meta.total_count',
    (total) => {
      const r = comTotal(total);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.path)).toEqual([['total_count']]);
    },
  );

  it('null and an absent key are unchanged', () => {
    const nulo = comTotal(null);
    expect(nulo.success).toBe(true);
    if (nulo.success) expect(nulo.data.total_count).toBeNull();
    const ausente = liMetaSchema.safeParse(semTotal);
    expect(ausente.success).toBe(true);
    if (ausente.success) expect(ausente.data.total_count).toBeUndefined();
  });

  it.each([[7], ['7'], [0], ['0']])('%j still reads as a number', (total) => {
    const r = comTotal(total);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.total_count).toBe(Number(total));
  });

  it('near-miss: the REQUIRED leaves keep refusing an empty string', () => {
    expect(liMetaSchema.safeParse({ ...categoriaPagina1.meta, offset: '' }).success).toBe(false);
    expect(liCategoriaSchema.safeParse({ ...categoriaPagina1.objects[0], id: '' }).success).toBe(
      false,
    );
  });
});

describe('passthrough', () => {
  it('unknown keys survive on the meta, the envelope and the row', () => {
    const r = envelopeCategoria.parse({
      ...categoriaPagina1,
      extra_envelope: 1,
      meta: { ...categoriaPagina1.meta, extra_meta: 'x' },
    });
    expect(r.extra_envelope).toBe(1);
    expect(r.meta.extra_meta).toBe('x');
    // `descricao`, `seo`, `url` and `id_externo` are not declared, and are kept.
    expect(r.objects[0]).toMatchObject({
      descricao: 'Looks para mulheres modernas.',
      seo: '/api/v1/seo/44626931',
      url: 'https://loja.example/feminino',
      id_externo: null,
    });
  });

  it('a row missing a declared field fails', () => {
    const { nome: _nome, ...semNome } = categoriaPagina1.objects[0];
    expect(liCategoriaSchema.safeParse(semNome).success).toBe(false);
  });
});

describe('the pedido search row', () => {
  it("the document's example parses: both rows, meta.limit read back as 15", () => {
    const r = envelopePedidoBusca.safeParse(pedidoBuscaExemplo);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.meta.limit).toBe(15);
    expect(r.data.meta.total_count).toBe(2);
    expect(r.data.objects.map((o) => o.numero)).toEqual([164, 165]);
    // The stamp is carried through untouched: canonicalising it is the app's job.
    expect(r.data.objects.map((o) => o.data_modificacao)).toEqual([
      '2022-10-31T12:17:58.949670',
      '2022-10-31T12:28:12.653648',
    ]);
  });

  it('a quoted numero reads as the number (one quoting serializer must not cost the page)', () => {
    expect(liPedidoBuscaLinhaSchema.parse({ ...linha164, numero: '164' }).numero).toBe(164);
  });

  it('near-miss: a numero that is not an integer, or absent, fails the row', () => {
    for (const numero of ['164.5', 164.5, 'cento', '', null, '9007199254740992']) {
      expect(
        liPedidoBuscaLinhaSchema.safeParse({ ...linha164, numero }).success,
        String(numero),
      ).toBe(false);
    }
    const { numero: _numero, ...semNumero } = linha164;
    expect(liPedidoBuscaLinhaSchema.safeParse(semNumero).success).toBe(false);
  });

  it('data_modificacao is NOT validated here: any shape, or none, still parses the row', () => {
    for (const data_modificacao of [
      '2022-10-31 12:17:58',
      '2022-10-31T12:17:58Z',
      1667218678,
      null,
      { $date: 'x' },
    ]) {
      const r = liPedidoBuscaLinhaSchema.safeParse({ ...linha165, data_modificacao });
      expect(r.success, JSON.stringify(data_modificacao)).toBe(true);
      if (r.success) expect(r.data.data_modificacao).toEqual(data_modificacao);
    }
    // An ABSENT key too: under a bare `z.unknown()` Zod 4 fails it as `nonoptional`.
    const { data_modificacao: _data, ...semData } = linha165;
    const r = liPedidoBuscaLinhaSchema.safeParse(semData);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.data_modificacao).toBeUndefined();
  });

  it('one odd stamp does not cost the page: the envelope still parses every row', () => {
    const r = envelopePedidoBusca.safeParse({
      ...pedidoBuscaExemplo,
      objects: [{ ...linha164, data_modificacao: 'ontem' }, linha165],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.objects.map((o) => o.numero)).toEqual([164, 165]);
  });

  it('every undeclared field of the row is kept (passthrough)', () => {
    const r = liPedidoBuscaLinhaSchema.parse({ ...linha165, campo_novo: 1 });
    expect(r).toMatchObject({
      situacao: { codigo: 'pedido_cancelado' },
      resource_uri: '/api/v1/pedido/165',
      campo_novo: 1,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                            The catalogue rows                              */
/* -------------------------------------------------------------------------- */

const [categoriaRaiz] = categoriaPagina1.objects;

describe('the categoria row is tolerant of its parent and its URI', () => {
  const comPai = (categoria_pai: unknown) =>
    liCategoriaSchema.safeParse({ ...categoriaRaiz, categoria_pai });

  it("`categoria_pai: ''` is a root (null), never a refused page", () => {
    const r = comPai('');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.categoria_pai).toBeNull();
  });

  it('`categoria_pai` absent is a root too (undefined), and null stays null', () => {
    const { categoria_pai: _pai, ...semPai } = categoriaRaiz;
    const ausente = liCategoriaSchema.safeParse(semPai);
    expect(ausente.success).toBe(true);
    if (ausente.success) expect(ausente.data.categoria_pai).toBeUndefined();
    const nulo = comPai(null);
    expect(nulo.success).toBe(true);
    if (nulo.success) expect(nulo.data.categoria_pai).toBeNull();
  });

  it.each([
    ['/api/v1/categoria/7645875'],
    ['/v1/categoria/7645875/'],
    ['https://loja.invalid/api/v1/categoria/1'],
    ['REDACTED'],
  ])('a parent URI in any form (%s) is carried VERBATIM: its form is the reader’s call', (uri) => {
    const r = comPai(uri);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.categoria_pai).toBe(uri);
  });

  it("near-miss: only the exact '' is empty — a blank parent stays a blank string", () => {
    const r = comPai(' ');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.categoria_pai).toBe(' ');
  });

  it('`resource_uri` may be absent: nothing derives an id from it', () => {
    const { resource_uri: _uri, ...semUri } = categoriaRaiz;
    const r = liCategoriaSchema.safeParse(semUri);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.id).toBe(7645875);
  });

  it('the synthetic capture-shaped page parses: string and null parents, null and string descricao', () => {
    const pagina = paginaCategoriasSintetica(0, '/api/v1/categoria?limit=50&offset=50', 5001, 50);
    const r = envelopeCategoria.safeParse(pagina);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.objects).toHaveLength(50);
    const pais = r.data.objects.map((o) => o.categoria_pai);
    expect(pais.filter((p) => p === null).length).toBeGreaterThan(0);
    expect(pais.filter((p) => typeof p === 'string').length).toBeGreaterThan(0);
    const descricoes = r.data.objects.map((o) => o.descricao);
    expect(descricoes).toContain(null);
    expect(descricoes.some((d) => typeof d === 'string')).toBe(true);
  });

  it('a row whose parent is an absolute URL still parses (the page is never refused over it)', () => {
    const r = liCategoriaSchema.safeParse(
      categoriaSintetica(5002, 'https://loja.invalid/api/v1/categoria/5001', 1),
    );
    expect(r.success).toBe(true);
  });
});

describe('the marca row', () => {
  const envelopeMarca = liEnvelopeSchema(liMarcaSchema);
  const [marcaA] = marcaPaginaExemplo.objects;
  const comAtivo = (ativo: unknown) => liMarcaSchema.safeParse({ ...marcaA, ativo });

  it("the document's example parses, with its descricao the STRING 'null' (unread, kept)", () => {
    const r = envelopeMarca.safeParse(marcaPaginaExemplo);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.objects.map((o) => o.id)).toEqual([2875259, 2875261, 3012488]);
    expect(r.data.objects.map((o) => o.nome)).toEqual([
      'Marca Exemplo A',
      'Marca Exemplo B',
      'Marca Exemplo C',
    ]);
    expect(r.data.objects[0]?.ativo).toBe(true);
    expect(r.data.objects[0]?.descricao).toBe('null');
  });

  it('the synthetic capture-shaped page parses: ativo both ways, descricao and imagem null or string', () => {
    const r = envelopeMarca.safeParse(marcasSinteticas);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.objects.map((o) => o.ativo)).toEqual([true, false]);
    expect(r.data.objects.map((o) => o.descricao)).toEqual([null, 'Texto sintético.']);
    expect(r.data.objects.map((o) => o.imagem)).toEqual([
      null,
      'https://imagens.invalid/marca-7002.png',
    ]);
    expect(r.data.objects.map((o) => o.destaque)).toEqual([false, true]);
  });

  it('a quoted id reads as the number', () => {
    expect(liMarcaSchema.parse({ ...marcaA, id: '2875259' }).id).toBe(2875259);
  });

  it("`ativo` '' or null reads as null (unknown), absent stays undefined — never a refused page", () => {
    for (const vazio of ['', null]) {
      const r = comAtivo(vazio);
      expect(r.success, JSON.stringify(vazio)).toBe(true);
      if (r.success) expect(r.data.ativo).toBeNull();
    }
    const { ativo: _ativo, ...semAtivo } = marcaA;
    const r = liMarcaSchema.safeParse(semAtivo);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ativo).toBeUndefined();
  });

  it.each([['true'], ['false'], [1], [0], [' ']])(
    'near-miss: `ativo: %j` is NOT folded into a boolean — refused',
    (ativo) => {
      expect(comAtivo(ativo).success).toBe(false);
    },
  );

  it('a row without a nome, or with an empty id, fails', () => {
    const { nome: _nome, ...semNome } = marcaA;
    expect(liMarcaSchema.safeParse(semNome).success).toBe(false);
    expect(liMarcaSchema.safeParse({ ...marcaA, id: '' }).success).toBe(false);
  });

  it('`id_externo` is unread: any value parses, and is kept untouched', () => {
    for (const idExterno of [null, 5, '5', {}]) {
      const r = liMarcaSchema.safeParse({ ...marcaA, id_externo: idExterno });
      expect(r.success, JSON.stringify(idExterno)).toBe(true);
      if (r.success) expect(r.data.id_externo).toEqual(idExterno);
    }
  });
});

describe('the grade row', () => {
  const envelopeGrade = liEnvelopeSchema(liGradeSchema);
  const [genero] = gradesPaginaExemplo.objects;
  const comVisivel = (nome_visivel: unknown) =>
    liGradeSchema.safeParse({ ...genero, nome_visivel });

  it("the document's example parses; an empty nome_visivel reads as null", () => {
    const r = envelopeGrade.safeParse(gradesPaginaExemplo);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.objects.map((o) => o.id)).toEqual([32769, 8945, 8946, 8949, 2047707]);
    expect(r.data.objects.map((o) => o.nome_visivel)).toEqual([
      'Gênero',
      'Cor',
      'Tamanho',
      'Voltagem',
      null,
    ]);
  });

  it('the synthetic capture-shaped page parses: nome_visivel a string or null, specification_id kept', () => {
    const r = envelopeGrade.safeParse(gradesSinteticas);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.objects.map((o) => o.nome_visivel)).toEqual([
      'Visível um',
      null,
      'Visível plataforma',
    ]);
    expect(r.data.objects[0]?.specification_id).toBeNull();
  });

  it("`nome_visivel` '' and null read as null; absent stays undefined", () => {
    for (const vazio of ['', null]) {
      const r = comVisivel(vazio);
      expect(r.success, JSON.stringify(vazio)).toBe(true);
      if (r.success) expect(r.data.nome_visivel).toBeNull();
    }
    const { nome_visivel: _visivel, ...semVisivel } = genero;
    const r = liGradeSchema.safeParse(semVisivel);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nome_visivel).toBeUndefined();
  });

  it("near-miss: a blank nome_visivel (' ') is NOT empty — it stays ' '", () => {
    const r = comVisivel(' ');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nome_visivel).toBe(' ');
  });

  it('a quoted id reads as the number; a fractional one or a missing nome fails', () => {
    expect(liGradeSchema.parse({ ...genero, id: '8946' }).id).toBe(8946);
    expect(liGradeSchema.safeParse({ ...genero, id: '8946.5' }).success).toBe(false);
    const { nome: _nome, ...semNome } = genero;
    expect(liGradeSchema.safeParse(semNome).success).toBe(false);
  });
});

describe('the grade detail and its options', () => {
  const [opcao37097] = gradeDetalheExemplo.variacoes;

  it("the document's example parses: the grade, then its options in order", () => {
    const r = liGradeDetalheSchema.safeParse(gradeDetalheExemplo);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.id).toBe(8946);
    expect(r.data.nome_visivel).toBe('Tamanho');
    expect(r.data.variacoes.map((v) => v.id)).toEqual([37097, 37098, 37099]);
    expect(r.data.variacoes.map((v) => v.grade)).toEqual([
      '/api/v1/grades/8946',
      '/api/v1/grades/8946',
      '/api/v1/grades/8946',
    ]);
    // Undeclared keys survive, on the grade and on each option.
    expect(r.data.resource_uri).toBe('/api/v1/grades/8946');
    expect(r.data.variacoes[0]?.resource_uri).toBe('/api/v1/grade/8946/variacao/37097');
  });

  it('the synthetic capture-shaped detail parses, specification_id and every option kept', () => {
    const r = liGradeDetalheSchema.safeParse(gradeDetalheSintetica(900001, 28));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.variacoes).toHaveLength(28);
    expect(r.data.specification_id).toBeNull();
  });

  it('a grade with no options (`variacoes: []`) parses', () => {
    const r = liGradeDetalheSchema.safeParse({ ...gradeDetalheExemplo, variacoes: [] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.variacoes).toEqual([]);
  });

  it('a detail WITHOUT `variacoes` fails: its options are the whole point of the read', () => {
    const { variacoes: _variacoes, ...semVariacoes } = gradeDetalheExemplo;
    expect(liGradeDetalheSchema.safeParse(semVariacoes).success).toBe(false);
  });

  it('an option’s `grade` may be absent, or any string: which grade it names is the reader’s call', () => {
    const { grade: _grade, ...semGrade } = opcao37097;
    const ausente = liOpcaoGradeSchema.safeParse(semGrade);
    expect(ausente.success).toBe(true);
    if (ausente.success) expect(ausente.data.grade).toBeUndefined();
    for (const grade of ['/api/v1/grades/8947', 'https://loja.invalid/api/v1/grades/8946', '']) {
      const r = liOpcaoGradeSchema.safeParse({ ...opcao37097, grade });
      expect(r.success, grade).toBe(true);
      if (r.success) expect(r.data.grade).toBe(grade);
    }
  });

  it('quoted option ids read as numbers; a missing option nome fails the detail', () => {
    const r = liGradeDetalheSchema.parse({
      ...gradeDetalheExemplo,
      id: '8946',
      variacoes: [{ ...opcao37097, id: '37097' }],
    });
    expect(r.id).toBe(8946);
    expect(r.variacoes[0]?.id).toBe(37097);
    const { nome: _nome, ...semNome } = opcao37097;
    expect(
      liGradeDetalheSchema.safeParse({ ...gradeDetalheExemplo, variacoes: [semNome] }).success,
    ).toBe(false);
  });

  it('the detail keeps an unknown top-level key (passthrough survives the extension)', () => {
    const r = liGradeDetalheSchema.parse({ ...gradeDetalheExemplo, campo_novo: 1 });
    expect(r).toMatchObject({ campo_novo: 1 });
  });
});
