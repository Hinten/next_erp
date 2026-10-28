import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that `src/index.ts` exports the
// module (a star export, so the fold-inventory scan sees no listed name there).
import {
  LIMITE_PAGINA_CATALOGO_LI,
  MAX_PAGINAS_CATALOGO_LI,
  RECURSO_URI_LI,
  TIPO_PAI_CATEGORIA_LI,
  gradeIdDaRotaLi,
  idDoRecursoLi,
  mesmaGradeLi,
  projetarCategoriasLi,
  projetarGradeLi,
  projetarGradesLi,
  projetarMarcasLi,
  respostaCategoriasLiSchema,
  respostaGradeLiSchema,
  respostaGradesLiSchema,
  respostaMarcasLiSchema,
} from './index';

/* -------------------------------------------------------------------------- */
/*                              The page constants                             */
/* -------------------------------------------------------------------------- */

describe('the catalogue page constants', () => {
  it('a page asks for the limit the read-only capture saw honoured on all three lists', () => {
    expect(LIMITE_PAGINA_CATALOGO_LI).toBe(50);
  });

  it('the page ceiling fits the route budget: pages × (2 s pacer + 20 s per call) + 30 s ≤ 250 s', () => {
    const RITMO_MS = 2_000;
    const PRAZO_POR_CHAMADA_MS = 20_000;
    const MARGEM_MS = 30_000;
    expect(
      MAX_PAGINAS_CATALOGO_LI * (RITMO_MS + PRAZO_POR_CHAMADA_MS) + MARGEM_MS,
    ).toBeLessThanOrEqual(250_000);
  });

  it('the ceiling leaves room above the largest list captured (67 categories, 2 pages)', () => {
    expect(MAX_PAGINAS_CATALOGO_LI * LIMITE_PAGINA_CATALOGO_LI).toBeGreaterThanOrEqual(5 * 67);
  });
});

/* -------------------------------------------------------------------------- */
/*                                idDoRecursoLi                                */
/* -------------------------------------------------------------------------- */

describe('idDoRecursoLi — the one reader of a Loja Integrada resource URI', () => {
  it.each([
    ['/api/v1/categoria/7645875'],
    ['/api/v1/categoria/7645875/'],
    ['/v1/categoria/7645875'],
    ['/v1/categoria/7645875/'],
  ])('EQUAL: %s ⇒ 7645875 (both prefixes, with or without ONE trailing slash)', (uri) => {
    expect(idDoRecursoLi(uri, RECURSO_URI_LI.categoria)).toBe(7645875);
  });

  it('EQUAL: an option’s plural grade URI reads as the grade id', () => {
    expect(idDoRecursoLi('/api/v1/grades/8946', RECURSO_URI_LI.grades)).toBe(8946);
    expect(idDoRecursoLi('/api/v1/marca/12', RECURSO_URI_LI.marca)).toBe(12);
  });

  it('EQUAL: the exact forms the store was captured answering (fake ids) read as their ids', () => {
    // A category's `resource_uri` and `categoria_pai` carry NO `/api` prefix
    // and no trailing slash; an option's `grade` is the PLURAL `/api/v1/grades/<g>`
    // and a brand's `resource_uri` is `/api/v1/marca/<id>`.
    expect(idDoRecursoLi('/v1/categoria/1000001', RECURSO_URI_LI.categoria)).toBe(1000001);
    expect(idDoRecursoLi('/api/v1/grades/1000002', RECURSO_URI_LI.grades)).toBe(1000002);
    expect(idDoRecursoLi('/api/v1/marca/1000003', RECURSO_URI_LI.marca)).toBe(1000003);
  });

  it.each([
    ['a leading zero', '/api/v1/categoria/07645875'],
    [
      'a query string (id_externo makes the id OUR external id)',
      '/api/v1/categoria/7645875?id_externo=1',
    ],
    ['an empty query string', '/api/v1/categoria/7645875?'],
    ['a fragment', '/api/v1/categoria/7645875#x'],
    ['an absolute URL', 'https://x/api/v1/categoria/1'],
    ['an extra segment', '/api/v1/categoria/1/2'],
    ['a doubled slash', '/api/v1/categoria//1'],
    ['two trailing slashes', '/api/v1/categoria/1//'],
    ['the literal None', '/api/v1/categoria/None'],
    ['an exponent', '/api/v1/categoria/1e3'],
    ['a fraction', '/api/v1/categoria/1.0'],
    ['a zero id', '/api/v1/categoria/0'],
    ['a space in the id', '/api/v1/categoria/ 1'],
    ['a trailing space', '/api/v1/categoria/1 '],
    ['an unsafe integer', `/api/v1/categoria/${2 ** 53}`],
    ['another API version', '/api/v2/categoria/1'],
    ['a doubled prefix', '/api/api/v1/categoria/1'],
    ['an upper-case prefix', '/API/v1/categoria/1'],
    ['no leading slash', 'api/v1/categoria/1'],
    ['the redaction marker', 'REDACTED'],
    ['an empty string', ''],
  ])('⚠️ NEAR-MISS: %s ⇒ null', (_rotulo, uri) => {
    expect(idDoRecursoLi(uri, RECURSO_URI_LI.categoria)).toBeNull();
  });

  it('⚠️ NEAR-MISS: another resource is never this one', () => {
    expect(idDoRecursoLi('/api/v1/marca/7645875', RECURSO_URI_LI.categoria)).toBeNull();
    expect(idDoRecursoLi('/api/v1/seo/1', RECURSO_URI_LI.categoria)).toBeNull();
    // The SINGULAR `grade` is the option URI's resource, never the plural list's.
    expect(idDoRecursoLi('/api/v1/grade/8946', RECURSO_URI_LI.grades)).toBeNull();
    expect(idDoRecursoLi('/api/v1/grades/8946', RECURSO_URI_LI.categoria)).toBeNull();
  });

  it('⚠️ NEAR-MISS: the option form (two ids) is not a grade URI', () => {
    expect(idDoRecursoLi('/api/v1/grade/8946/variacao/37097', RECURSO_URI_LI.grades)).toBeNull();
  });

  it.each([[null], [undefined], [7645875], [{ id: 1 }], [['/api/v1/categoria/1']]])(
    'a non-string %j ⇒ null, never an exception',
    (valor) => {
      expect(idDoRecursoLi(valor, RECURSO_URI_LI.categoria)).toBeNull();
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                        gradeIdDaRotaLi / mesmaGradeLi                        */
/* -------------------------------------------------------------------------- */

describe('gradeIdDaRotaLi — a route’s gradeId segment', () => {
  it('EQUAL: the canonical decimal is the answer', () => {
    expect(gradeIdDaRotaLi('8946')).toBe('8946');
  });

  it.each([['08946'], [' 8946'], ['8946 '], ['8946.0'], ['1e3'], ['0'], ['-1'], [''], ['89a46']])(
    '⚠️ NEAR-MISS: %j ⇒ null',
    (segmento) => {
      expect(gradeIdDaRotaLi(segmento)).toBeNull();
    },
  );
});

describe('mesmaGradeLi — is the detail the grade the route asked for?', () => {
  it('EQUAL: a numeric detail id is the same grade as its decimal route segment', () => {
    expect(mesmaGradeLi(8946, '8946')).toBe(true);
    expect(mesmaGradeLi('8946', '8946')).toBe(true);
  });

  it('⚠️ NEAR-MISS: another grade is not the same', () => {
    expect(mesmaGradeLi(8947, '8946')).toBe(false);
  });

  it.each([
    [8946, '08946'],
    ['08946', '8946'],
    [null, '8946'],
    [undefined, '8946'],
    [0, '0'],
    [8946.5, '8946'],
  ])('⚠️ NEAR-MISS: (%j, %j) is never the same grade', (detalhe, rota) => {
    expect(mesmaGradeLi(detalhe, rota)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 Projections                                 */
/* -------------------------------------------------------------------------- */

describe('projetarCategoriasLi — a parent has THREE states, never two', () => {
  it.each([
    ['null', { categoria_pai: null }],
    ['an empty string', { categoria_pai: '' }],
    ['absent', {}],
  ])('EQUAL: a parent that is %s ⇒ raiz', (_rotulo, pai) => {
    const { categorias, paisIlegiveis } = projetarCategoriasLi([{ id: 1, nome: 'A', ...pai }]);
    expect(categorias).toEqual([{ id: 1, nome: 'A', pai: { tipo: TIPO_PAI_CATEGORIA_LI.raiz } }]);
    expect(paisIlegiveis).toBe(0);
  });

  it.each([['/api/v1/categoria/7645875'], ['/v1/categoria/7645875/']])(
    'EQUAL: a readable parent %s ⇒ its id',
    (uri) => {
      const { categorias } = projetarCategoriasLi([{ id: 2, nome: 'B', categoria_pai: uri }]);
      expect(categorias[0]?.pai).toEqual({ tipo: TIPO_PAI_CATEGORIA_LI.id, id: 7645875 });
    },
  );

  it.each([
    ['an absolute URL', 'https://x/api/v1/categoria/1'],
    ['another API version', '/api/v2/categoria/1'],
    ['an object', { id: 1 }],
    ['the redaction marker', 'REDACTED'],
    ['a bare number', 1],
    ['another resource', '/api/v1/marca/1'],
  ])('⚠️ NEAR-MISS: %s ⇒ ilegivel, counted, and NEVER raiz', (_rotulo, valor) => {
    const { categorias, paisIlegiveis } = projetarCategoriasLi([
      { id: 3, nome: 'C', categoria_pai: valor },
    ]);
    expect(categorias[0]?.pai).toEqual({ tipo: TIPO_PAI_CATEGORIA_LI.ilegivel });
    expect(categorias[0]?.pai).not.toEqual({ tipo: TIPO_PAI_CATEGORIA_LI.raiz });
    expect(paisIlegiveis).toBe(1);
  });

  it('EQUAL: a row in the captured shape (fake ids) reads its parent, with nothing unreadable', () => {
    // Package rows carry `resource_uri` too (never read here).
    const linhas = [
      {
        id: 1000002,
        nome: 'Filha',
        categoria_pai: '/v1/categoria/1000001',
        resource_uri: '/v1/categoria/1000002',
      },
      { id: 1000001, nome: 'Raiz', categoria_pai: null, resource_uri: '/v1/categoria/1000001' },
    ];
    const { categorias, paisIlegiveis } = projetarCategoriasLi(linhas);
    expect(categorias.map((c) => c.pai)).toEqual([
      { tipo: TIPO_PAI_CATEGORIA_LI.id, id: 1000001 },
      { tipo: TIPO_PAI_CATEGORIA_LI.raiz },
    ]);
    expect(paisIlegiveis).toBe(0);
  });

  it('ids come from `id`, never from `resource_uri`', () => {
    // A package row carries `resource_uri` too; the projection never reads it.
    const linha = { id: 5, nome: 'E', categoria_pai: null, resource_uri: '/api/v1/categoria/999' };
    const { categorias } = projetarCategoriasLi([linha]);
    expect(categorias[0]?.id).toBe(5);
    // …and the parent comes from `categoria_pai` alone: this row is a ROOT.
    expect(categorias[0]?.pai).toEqual({ tipo: TIPO_PAI_CATEGORIA_LI.raiz });
  });

  it('keeps LI’s order, and drops (and counts) a row whose id no link could ever store', () => {
    const { categorias, linhasSemId } = projetarCategoriasLi([
      { id: 9, nome: 'Z', categoria_pai: '/api/v1/categoria/1' },
      { id: 0, nome: 'zero', categoria_pai: null },
      { id: 1, nome: 'A', categoria_pai: null },
      { id: -3, nome: 'negativo', categoria_pai: null },
    ]);
    expect(categorias.map((c) => c.id)).toEqual([9, 1]);
    expect(linhasSemId).toBe(2);
  });

  it('its output is a valid route answer', () => {
    const { categorias } = projetarCategoriasLi([
      { id: 1, nome: 'A', categoria_pai: null },
      { id: 2, nome: 'B', categoria_pai: '/v1/categoria/1' },
      { id: 3, nome: 'C', categoria_pai: 'https://x/' },
    ]);
    expect(respostaCategoriasLiSchema.parse({ categorias, lidaEmMs: 1 }).categorias).toEqual(
      categorias,
    );
  });
});

describe('projetarMarcasLi', () => {
  it('keeps inactive brands, marked; an unknown `ativo` reads as null', () => {
    const { marcas, linhasSemId } = projetarMarcasLi([
      { id: 1, nome: 'Marca Um', ativo: true },
      { id: 2, nome: 'Marca Dois', ativo: false },
      { id: 3, nome: 'Marca Tres', ativo: null },
      { id: 4, nome: 'Marca Quatro' },
      { id: 5, nome: 'Marca Cinco', ativo: 'true' },
    ]);
    expect(marcas).toEqual([
      { id: 1, nome: 'Marca Um', ativo: true },
      { id: 2, nome: 'Marca Dois', ativo: false },
      { id: 3, nome: 'Marca Tres', ativo: null },
      { id: 4, nome: 'Marca Quatro', ativo: null },
      { id: 5, nome: 'Marca Cinco', ativo: null },
    ]);
    expect(linhasSemId).toBe(0);
    expect(respostaMarcasLiSchema.parse({ marcas, lidaEmMs: 1 }).marcas).toEqual(marcas);
  });
});

describe('projetarGradesLi — `nomeVisivel`', () => {
  it.each([
    ['empty', ''],
    ['null', null],
    ['absent', undefined],
  ])('EQUAL: %s ⇒ null', (_rotulo, nomeVisivel) => {
    const linha =
      nomeVisivel === undefined
        ? { id: 1, nome: 'Tamanho' }
        : { id: 1, nome: 'Tamanho', nome_visivel: nomeVisivel };
    expect(projetarGradesLi([linha]).grades).toEqual([
      { id: 1, nome: 'Tamanho', nomeVisivel: null },
    ]);
  });

  it('⚠️ NEAR-MISS: a blank is not empty — `" "` stays `" "`', () => {
    expect(projetarGradesLi([{ id: 1, nome: 'T', nome_visivel: ' ' }]).grades[0]?.nomeVisivel).toBe(
      ' ',
    );
  });

  it('keeps every grade, the store’s and the platform’s, in LI’s order', () => {
    const { grades } = projetarGradesLi([
      { id: 1000001, nome: 'Própria', nome_visivel: 'Tamanho' },
      { id: 8946, nome: 'Sistema', nome_visivel: 'Tamanho' },
    ]);
    expect(grades.map((g) => g.id)).toEqual([1000001, 8946]);
    expect(respostaGradesLiSchema.parse({ grades, lidaEmMs: 1 }).grades).toEqual(grades);
  });
});

describe('projetarGradeLi — the options of ONE grade', () => {
  const detalhe = (variacoes: readonly { id: number; nome: string; grade?: unknown }[]) => ({
    id: 8946,
    nome: 'Tamanho',
    nome_visivel: 'Tamanho',
    variacoes,
  });

  it('EQUAL: an option whose `grade` names this grade, or carries none, is offered', () => {
    const projecao = projetarGradeLi(
      detalhe([
        { id: 37097, nome: 'P', grade: '/api/v1/grades/8946' },
        { id: 37098, nome: 'M', grade: '/v1/grades/8946/' },
        { id: 37099, nome: 'G' },
      ]),
    );
    expect(projecao?.opcoes).toEqual([
      { id: 37097, nome: 'P' },
      { id: 37098, nome: 'M' },
      { id: 37099, nome: 'G' },
    ]);
    expect(projecao?.opcoesDeOutraGrade).toBe(0);
  });

  it('EQUAL: options in the captured shape (fake ids) are all offered, with nothing counted', () => {
    // Each option carries the PLURAL `grade` URI and its own singular two-id URI.
    const capturado = {
      id: 1000001,
      nome: 'Tamanho',
      nome_visivel: 'Tamanho',
      variacoes: [
        {
          id: 2000001,
          nome: 'P',
          grade: '/api/v1/grades/1000001',
          resource_uri: '/api/v1/grade/1000001/variacao/2000001',
        },
        {
          id: 2000002,
          nome: 'M',
          grade: '/api/v1/grades/1000001',
          resource_uri: '/api/v1/grade/1000001/variacao/2000002',
        },
      ],
    };
    const projecao = projetarGradeLi(capturado);
    expect(projecao).toEqual({
      grade: { id: 1000001, nome: 'Tamanho', nomeVisivel: 'Tamanho' },
      opcoes: [
        { id: 2000001, nome: 'P' },
        { id: 2000002, nome: 'M' },
      ],
      opcoesDeOutraGrade: 0,
      opcoesComGradeIlegivel: 0,
      linhasSemId: 0,
    });
  });

  it('⚠️ NEAR-MISS: an option whose `grade` READS as another grade is NOT offered, and counted', () => {
    const projecao = projetarGradeLi(
      detalhe([
        { id: 37097, nome: 'P', grade: '/api/v1/grades/8946' },
        { id: 40001, nome: 'X', grade: '/api/v1/grades/8947' },
      ]),
    );
    expect(projecao?.opcoes.map((o) => o.id)).toEqual([37097]);
    expect(projecao?.opcoesDeOutraGrade).toBe(1);
  });

  it.each([
    ['absent', undefined],
    ['unreadable', 'https://x/api/v1/grades/8946'],
    ['the singular form', '/api/v1/grade/8946'],
    ['redacted', 'REDACTED'],
  ])('⚠️ NEAR-MISS: an option whose `grade` is %s is still OFFERED, and counted', (_r, grade) => {
    const opcao = grade === undefined ? { id: 37097, nome: 'P' } : { id: 37097, nome: 'P', grade };
    const projecao = projetarGradeLi(detalhe([opcao]));
    expect(projecao?.opcoes).toEqual([{ id: 37097, nome: 'P' }]);
    expect(projecao?.opcoesComGradeIlegivel).toBe(1);
    expect(projecao?.opcoesDeOutraGrade).toBe(0);
  });

  it('the grade itself reads `nomeVisivel` like the list, and an empty grade is no error', () => {
    const projecao = projetarGradeLi({
      id: 8946,
      nome: 'Tamanho',
      nome_visivel: '',
      variacoes: [],
    });
    expect(projecao).toEqual({
      grade: { id: 8946, nome: 'Tamanho', nomeVisivel: null },
      opcoes: [],
      opcoesDeOutraGrade: 0,
      opcoesComGradeIlegivel: 0,
      linhasSemId: 0,
    });
  });

  it('an option whose id no link could store is dropped and counted', () => {
    const projecao = projetarGradeLi(
      detalhe([{ id: 0, nome: 'zero', grade: '/api/v1/grades/8946' }]),
    );
    expect(projecao?.opcoes).toEqual([]);
    expect(projecao?.linhasSemId).toBe(1);
  });

  it('a detail whose own id is unreadable projects to null (the route refuses it)', () => {
    expect(projetarGradeLi({ id: 0, nome: 'X', variacoes: [] })).toBeNull();
  });

  it('its output is a valid route answer', () => {
    const projecao = projetarGradeLi(
      detalhe([{ id: 37097, nome: 'P', grade: '/api/v1/grades/8946' }]),
    );
    expect(projecao).not.toBeNull();
    if (projecao === null) return;
    const resposta = respostaGradeLiSchema.parse({
      grade: projecao.grade,
      opcoes: projecao.opcoes,
      lidaEmMs: 1,
    });
    expect(resposta).toEqual({ grade: projecao.grade, opcoes: projecao.opcoes, lidaEmMs: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/*                         The route answers (contract)                        */
/* -------------------------------------------------------------------------- */

describe('the route answers are NON-strict: a newer backend’s extra key is stripped, never refused', () => {
  it('categorias', () => {
    const resposta = respostaCategoriasLiSchema.parse({
      categorias: [{ id: 1, nome: 'A', pai: { tipo: TIPO_PAI_CATEGORIA_LI.raiz }, novo: 1 }],
      lidaEmMs: 1,
      campoNovo: true,
    });
    expect(resposta).toEqual({
      categorias: [{ id: 1, nome: 'A', pai: { tipo: TIPO_PAI_CATEGORIA_LI.raiz } }],
      lidaEmMs: 1,
    });
  });

  it('marcas, grades and one grade', () => {
    expect(respostaMarcasLiSchema.parse({ marcas: [], lidaEmMs: 1, campoNovo: true })).toEqual({
      marcas: [],
      lidaEmMs: 1,
    });
    expect(respostaGradesLiSchema.parse({ grades: [], lidaEmMs: 1, campoNovo: true })).toEqual({
      grades: [],
      lidaEmMs: 1,
    });
    expect(
      respostaGradeLiSchema.parse({
        grade: { id: 1, nome: 'T', nomeVisivel: null, extra: 1 },
        opcoes: [],
        lidaEmMs: 1,
        campoNovo: true,
      }),
    ).toEqual({ grade: { id: 1, nome: 'T', nomeVisivel: null }, opcoes: [], lidaEmMs: 1 });
  });

  it('⚠️ NEAR-MISS: an id that no link could store is refused (a link stores positive ints)', () => {
    expect(
      respostaGradesLiSchema.safeParse({
        grades: [{ id: 0, nome: 'T', nomeVisivel: null }],
        lidaEmMs: 1,
      }).success,
    ).toBe(false);
    expect(
      respostaCategoriasLiSchema.safeParse({
        categorias: [{ id: 1, nome: 'A', pai: { tipo: TIPO_PAI_CATEGORIA_LI.id, id: 0 } }],
        lidaEmMs: 1,
      }).success,
    ).toBe(false);
  });

  it('⚠️ NEAR-MISS: a parent id is only carried by the `id` state', () => {
    expect(
      respostaCategoriasLiSchema.safeParse({
        categorias: [{ id: 1, nome: 'A', pai: { tipo: TIPO_PAI_CATEGORIA_LI.id } }],
        lidaEmMs: 1,
      }).success,
    ).toBe(false);
    expect(
      respostaCategoriasLiSchema.safeParse({
        categorias: [{ id: 1, nome: 'A', pai: { tipo: 'outro' } }],
        lidaEmMs: 1,
      }).success,
    ).toBe(false);
  });
});
