import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that the root `src/index.ts` reaches them.
import {
  MOTIVO_RECUSA_APRENDIZADO_LI,
  TIPO_CONFLITO_ENTRE_GRUPOS_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  conflitosEntreGruposLi,
  decidirAprendizadoLi,
  fundirLinksVariacoesLi,
  resolverOpcoesDoFilhoLi,
  type EvidenciaAprendizadoLi,
  type GrupoComLinksLi,
} from '../../index';

/**
 * The product import's three uses of the Loja Integrada variation links (step 9): resolving a
 * variation's options, the never-drop merge, and the learning pass with its cross-grupo check.
 * Fake ids throughout: conta `C1`/`C2`, grades 8xxx, options 3xxxx, variantes `vN`.
 */

const opcaoUri = (g: number, v: number) => `/api/v1/grade/${String(g)}/variacao/${String(v)}`;

const entrada = (
  conta: string,
  gradeId: number,
  opcoes: readonly (readonly [number, readonly string[]])[],
  extra: Record<string, unknown> = {},
) => ({
  name: null,
  grade_id: gradeId,
  integracaoLiId: conta,
  variationOptions: opcoes.map(([li_option_id, arakene_variation_id]) => ({
    li_option_id,
    li_option_name: null,
    arakene_variation_id: [...arakene_variation_id],
  })),
  ...extra,
});

const grupo = (
  id: string,
  variantesIds: readonly string[],
  linksVariacoesli: unknown,
): GrupoComLinksLi => ({ id, variantesIds, linksVariacoesli });

/* -------------------------------------------------------------------------- */
/*                          resolverOpcoesDoFilhoLi                            */
/* -------------------------------------------------------------------------- */

describe('resolverOpcoesDoFilhoLi — a variation’s options to ERP variantes', () => {
  const COR = grupo('cor', ['v1', 'v2'], [entrada('C1', 8001, [[30001, ['v1']]])]);

  it('EQUAL: one option, one variante, one grupo ⇒ resolved', () => {
    expect(
      resolverOpcoesDoFilhoLi({
        contaId: 'C1',
        opcoesUris: [opcaoUri(8001, 30001)],
        grupos: [COR],
      }),
    ).toEqual([
      {
        tipo: TIPO_RESOLUCAO_OPCAO_LI.resolvida,
        gradeId: 8001,
        opcaoId: 30001,
        grupoIds: ['cor'],
        varianteIds: ['v1'],
      },
    ]);
  });

  it('⚠️ NEAR-MISS: an option holding two variantes ⇒ variacao-ambigua (never a guess)', () => {
    const g = grupo('cor', ['v1', 'v2'], [entrada('C1', 8001, [[30001, ['v1', 'v2']]])]);
    const [r] = resolverOpcoesDoFilhoLi({
      contaId: 'C1',
      opcoesUris: [opcaoUri(8001, 30001)],
      grupos: [g],
    });
    expect(r?.tipo).toBe(TIPO_RESOLUCAO_OPCAO_LI.variacaoAmbigua);
    expect(r?.varianteIds).toEqual(['v1', 'v2']);
  });

  it('⚠️ NEAR-MISS: (C, g) linked in two grupos ⇒ grade-em-dois-grupos', () => {
    const outro = grupo('cor2', ['v9'], [entrada('C1', 8001, [[30002, ['v9']]])]);
    const [r] = resolverOpcoesDoFilhoLi({
      contaId: 'C1',
      opcoesUris: [opcaoUri(8001, 30001)],
      grupos: [COR, outro],
    });
    expect(r).toMatchObject({
      tipo: TIPO_RESOLUCAO_OPCAO_LI.gradeEmDoisGrupos,
      grupoIds: ['cor', 'cor2'],
    });
  });

  it('⚠️ NEAR-MISS: (C, v) linked in two grupos ⇒ opcao-em-dois-grupos', () => {
    const outro = grupo('tam', ['v9'], [entrada('C1', 8002, [[30001, ['v9']]])]);
    const [r] = resolverOpcoesDoFilhoLi({
      contaId: 'C1',
      opcoesUris: [opcaoUri(8001, 30001)],
      grupos: [COR, outro],
    });
    expect(r).toMatchObject({
      tipo: TIPO_RESOLUCAO_OPCAO_LI.opcaoEmDoisGrupos,
      grupoIds: ['cor', 'tam'],
    });
  });

  it('⚠️ NEAR-MISS: the same (g, v) linked for C2 only ⇒ not resolved for C1', () => {
    const deC2 = grupo('cor', ['v1'], [entrada('C2', 8001, [[30001, ['v1']]])]);
    const [r] = resolverOpcoesDoFilhoLi({
      contaId: 'C1',
      opcoesUris: [opcaoUri(8001, 30001)],
      grupos: [deC2],
    });
    expect(r?.tipo).toBe(TIPO_RESOLUCAO_OPCAO_LI.gradeSemVinculo);
  });

  it('⚠️ NEAR-MISS: a path-shaped integracaoLiId is not conta C1', () => {
    const caminho = grupo(
      'cor',
      ['v1'],
      [entrada('documents/integracao/C1', 8001, [[30001, ['v1']]])],
    );
    const [r] = resolverOpcoesDoFilhoLi({
      contaId: 'C1',
      opcoesUris: [opcaoUri(8001, 30001)],
      grupos: [caminho],
    });
    expect(r?.tipo).toBe(TIPO_RESOLUCAO_OPCAO_LI.gradeSemVinculo);
  });

  it('an option missing from the grade’s link, or holding only a stale id ⇒ opcao-sem-vinculo', () => {
    const [ausente] = resolverOpcoesDoFilhoLi({
      contaId: 'C1',
      opcoesUris: [opcaoUri(8001, 30009)],
      grupos: [COR],
    });
    expect(ausente?.tipo).toBe(TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo);
    const velho = grupo('cor', ['v2'], [entrada('C1', 8001, [[30001, ['v1']]])]);
    const [stale] = resolverOpcoesDoFilhoLi({
      contaId: 'C1',
      opcoesUris: [opcaoUri(8001, 30001)],
      grupos: [velho],
    });
    expect(stale?.tipo).toBe(TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo);
  });

  it('an unreadable URI ⇒ ilegivel; an invalid stored entry resolves nothing', () => {
    const invalida = grupo('cor', ['v1'], [{ grade_id: '8001', integracaoLiId: 'C1' }]);
    expect(
      resolverOpcoesDoFilhoLi({
        contaId: 'C1',
        opcoesUris: ['/api/v1/grades/8001/variacao/30001', opcaoUri(8001, 30001)],
        grupos: [invalida],
      }).map((r) => r.tipo),
    ).toEqual([TIPO_RESOLUCAO_OPCAO_LI.ilegivel, TIPO_RESOLUCAO_OPCAO_LI.gradeSemVinculo]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          conflitosEntreGruposLi                             */
/* -------------------------------------------------------------------------- */

describe('conflitosEntreGruposLi — one grade and one option per conta, in ONE grupo', () => {
  it('nothing when each grade and option of the conta sits in one grupo', () => {
    const grupos = [
      grupo('cor', ['v1'], [entrada('C1', 8001, [[30001, ['v1']]])]),
      grupo('tam', ['v2'], [entrada('C1', 8002, [[30002, ['v2']]])]),
    ];
    expect(conflitosEntreGruposLi(grupos, 'C1')).toEqual([]);
  });

  it('⚠️ a grade in two grupos, and an option in two grupos, are both named', () => {
    const grupos = [
      grupo('a', ['v1'], [entrada('C1', 8001, [[30001, ['v1']]])]),
      grupo(
        'b',
        ['v2'],
        [entrada('C1', 8001, [[30002, ['v2']]]), entrada('C1', 8003, [[30001, ['v2']]])],
      ),
    ];
    expect(conflitosEntreGruposLi(grupos, 'C1')).toEqual([
      {
        tipo: TIPO_CONFLITO_ENTRE_GRUPOS_LI.gradeEmDoisGrupos,
        gradeId: 8001,
        opcaoId: null,
        grupoIds: ['a', 'b'],
      },
      {
        tipo: TIPO_CONFLITO_ENTRE_GRUPOS_LI.opcaoEmDoisGrupos,
        gradeId: null,
        opcaoId: 30001,
        grupoIds: ['a', 'b'],
      },
    ]);
  });

  it('⚠️ NEAR-MISS: another conta’s links never conflict with this one’s', () => {
    const grupos = [
      grupo('a', ['v1'], [entrada('C1', 8001, [[30001, ['v1']]])]),
      grupo('b', ['v2'], [entrada('C2', 8001, [[30001, ['v2']]])]),
    ];
    expect(conflitosEntreGruposLi(grupos, 'C1')).toEqual([]);
  });

  it('a grade repeated inside ONE grupo is that grupo’s own finding, not this one', () => {
    const grupos = [
      grupo('a', ['v1'], [entrada('C1', 8001, [[30001, ['v1']]]), entrada('C1', 8001, [])]),
    ];
    expect(conflitosEntreGruposLi(grupos, 'C1')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                           fundirLinksVariacoesLi                            */
/* -------------------------------------------------------------------------- */

describe('fundirLinksVariacoesLi — the merge that never drops', () => {
  const APRENDIZADO = {
    integracaoLiId: 'C1',
    gradeId: 8001,
    opcaoId: 30002,
    varianteId: 'v2',
  } as const;

  it('EQUAL: nothing new ⇒ mudou: false, the same elements back', () => {
    const armazenado = [entrada('C1', 8001, [[30002, ['v2']]])];
    const fusao = fundirLinksVariacoesLi(armazenado, [APRENDIZADO]);
    expect(fusao).toEqual({ ok: true, array: armazenado, mudou: false, editadas: [] });
    expect(fusao.ok && fusao.array[0]).toBe(armazenado[0]);
  });

  it('a new option is appended to the conta’s entry; a null label is filled', () => {
    const armazenado = [entrada('C1', 8001, [[30001, ['v1']]], { extraDoCorpus: 1 })];
    const fusao = fundirLinksVariacoesLi(armazenado, [
      { ...APRENDIZADO, nomeGrade: 'Cor', nomeOpcao: 'Azul' },
    ]);
    expect(fusao).toEqual({
      ok: true,
      mudou: true,
      editadas: [0],
      array: [
        {
          name: 'Cor',
          grade_id: 8001,
          integracaoLiId: 'C1',
          extraDoCorpus: 1,
          variationOptions: [
            { li_option_id: 30001, li_option_name: null, arakene_variation_id: ['v1'] },
            { li_option_id: 30002, li_option_name: 'Azul', arakene_variation_id: ['v2'] },
          ],
        },
      ],
    });
  });

  it('no entry for (C, g) ⇒ a new one is appended', () => {
    const fusao = fundirLinksVariacoesLi(null, [APRENDIZADO]);
    expect(fusao).toEqual({
      ok: true,
      mudou: true,
      editadas: [0],
      array: [entrada('C1', 8001, [[30002, ['v2']]])],
    });
  });

  it('⚠️ NEAR-MISS: an unparseable element is kept VERBATIM and in place', () => {
    const quebrada = { grade_id: 'x', integracaoLiId: 'C1', lixo: true };
    const armazenado = [quebrada, entrada('C1', 8001, [[30001, ['v1']]])];
    const fusao = fundirLinksVariacoesLi(armazenado, [APRENDIZADO]);
    expect(fusao.ok && fusao.array[0]).toBe(quebrada);
    expect(fusao.ok && fusao.array).toHaveLength(2);
  });

  it('⚠️ NEAR-MISS: another conta’s entry for the same grade is byte-identical', () => {
    const deC2 = entrada('C2', 8001, [[30002, ['v7']]]);
    const fusao = fundirLinksVariacoesLi([deC2], [APRENDIZADO]);
    expect(fusao.ok && fusao.array[0]).toBe(deC2);
    expect(fusao.ok && fusao.array).toHaveLength(2);
  });

  it('⚠️ NEAR-MISS: the key is EXACT — a path-shaped conta is another entry, never merged into', () => {
    const caminho = entrada('documents/integracao/C1', 8001, [[30001, ['v1']]]);
    const fusao = fundirLinksVariacoesLi([caminho], [APRENDIZADO]);
    expect(fusao.ok && fusao.array[0]).toBe(caminho);
    expect(fusao.ok && fusao.array).toHaveLength(2);
  });

  it('⚠️ NEAR-MISS: a stored label is never replaced', () => {
    const armazenado = [
      {
        ...entrada('C1', 8001, [[30002, ['v1']]]),
        name: 'Cor da loja',
        variationOptions: [
          { li_option_id: 30002, li_option_name: 'Azul claro', arakene_variation_id: ['v1'] },
        ],
      },
    ];
    const fusao = fundirLinksVariacoesLi(armazenado, [
      { ...APRENDIZADO, nomeGrade: 'Cor', nomeOpcao: 'Azul' },
    ]);
    expect(fusao.ok && fusao.array[0]).toMatchObject({
      name: 'Cor da loja',
      variationOptions: [
        { li_option_id: 30002, li_option_name: 'Azul claro', arakene_variation_id: ['v1', 'v2'] },
      ],
    });
  });

  it('⚠️ NEAR-MISS: a variante-id list is extended in the stored order, never reordered', () => {
    const armazenado = [entrada('C1', 8001, [[30002, ['v9', 'v3']]])];
    const fusao = fundirLinksVariacoesLi(armazenado, [APRENDIZADO]);
    expect(fusao.ok && fusao.array[0]).toMatchObject({
      variationOptions: [{ li_option_id: 30002, arakene_variation_id: ['v9', 'v3', 'v2'] }],
    });
  });

  it('a stored value that is not a list cannot be merged into: refused, never replaced', () => {
    expect(fundirLinksVariacoesLi({ grade_id: 1 }, [APRENDIZADO])).toEqual({ ok: false });
  });
});

/* -------------------------------------------------------------------------- */
/*                            decidirAprendizadoLi                             */
/* -------------------------------------------------------------------------- */

describe('decidirAprendizadoLi — learn only what the evidence proves', () => {
  const evidencia = (
    gradeId: number,
    opcaoId: number,
    alegacoes: readonly [string, string, boolean?][],
  ): EvidenciaAprendizadoLi => ({
    gradeId,
    opcaoId,
    alegacoes: alegacoes.map(([grupoId, varianteId, todasDeEixoUnico]) => ({
      grupoId,
      varianteId,
      todasDeEixoUnico: todasDeEixoUnico ?? true,
    })),
  });

  it('EQUAL: unanimous claims for an option of a linked grade ⇒ learned into that entry', () => {
    const cor = grupo('cor', ['v1', 'v2'], [entrada('C1', 8001, [[30001, ['v1']]])]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30002, [['cor', 'v2']])],
      grupos: [cor],
    });
    expect(decisao.aprendidos).toEqual([
      { gradeId: 8001, opcaoId: 30002, grupoId: 'cor', varianteId: 'v2', novaEntrada: false },
    ]);
    expect(decisao.recusados).toEqual([]);
    expect(decisao.grupos).toEqual([
      {
        grupoId: 'cor',
        linksVariacoesli: [
          entrada('C1', 8001, [
            [30001, ['v1']],
            [30002, ['v2']],
          ]),
        ],
      },
    ]);
  });

  it('EQUAL: no grupo holds (C, g) and every claim is single-axis ⇒ a new entry', () => {
    const cor = grupo('cor', ['v1', 'v2'], []);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [
        evidencia(8001, 30001, [['cor', 'v1']]),
        evidencia(8001, 30002, [['cor', 'v2']]),
      ],
      grupos: [cor],
    });
    expect(decisao.aprendidos.map((a) => a.novaEntrada)).toEqual([true, false]);
    expect(decisao.grupos).toEqual([
      {
        grupoId: 'cor',
        linksVariacoesli: [
          entrada('C1', 8001, [
            [30001, ['v1']],
            [30002, ['v2']],
          ]),
        ],
      },
    ]);
  });

  it('⚠️ NEAR-MISS: claims naming two variantes ⇒ divergente, nothing learned', () => {
    const cor = grupo('cor', ['v1', 'v2'], [entrada('C1', 8001, [])]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [
        evidencia(8001, 30002, [
          ['cor', 'v1'],
          ['cor', 'v2'],
        ]),
      ],
      grupos: [cor],
    });
    expect(decisao.recusados).toEqual([
      { gradeId: 8001, opcaoId: 30002, motivo: MOTIVO_RECUSA_APRENDIZADO_LI.divergente },
    ]);
    expect(decisao.aprendidos).toEqual([]);
    expect(decisao.grupos).toEqual([]);
  });

  it('⚠️ NEAR-MISS: family A on G1 and family B on G2 both proposing a new (C, g) ⇒ both refused', () => {
    const g1 = grupo('g1', ['v1'], []);
    const g2 = grupo('g2', ['v2'], []);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30001, [['g1', 'v1']]), evidencia(8001, 30002, [['g2', 'v2']])],
      grupos: [g1, g2],
    });
    expect(decisao.aprendidos).toEqual([]);
    expect(decisao.recusados.map((r) => r.motivo)).toEqual([
      MOTIVO_RECUSA_APRENDIZADO_LI.gruposDivergentesNaGrade,
      MOTIVO_RECUSA_APRENDIZADO_LI.gruposDivergentesNaGrade,
    ]);
  });

  it('⚠️ NEAR-MISS: an INVALID entry naming C for g in G "holds" — no second entry is added', () => {
    const cor = grupo('cor', ['v1'], [{ grade_id: '8001', integracaoLiId: 'C1' }]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30001, [['cor', 'v1']])],
      grupos: [cor],
    });
    expect(decisao.recusados[0]?.motivo).toBe(MOTIVO_RECUSA_APRENDIZADO_LI.gradeRepetida);
    expect(decisao.grupos).toEqual([]);
  });

  it('⚠️ NEAR-MISS: a path-shaped entry of C for g also "holds" (fail closed)', () => {
    const cor = grupo('cor', ['v1'], [entrada('documents/integracao/C1', 8001, [])]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30001, [['cor', 'v1']])],
      grupos: [cor],
    });
    expect(decisao.recusados[0]?.motivo).toBe(MOTIVO_RECUSA_APRENDIZADO_LI.gradeRepetida);
  });

  it('⚠️ NEAR-MISS: (C, g) held by another grupo ⇒ refused, never a second grupo', () => {
    const g1 = grupo('g1', ['v1'], [entrada('C1', 8001, [[30001, ['v1']]])]);
    const g2 = grupo('g2', ['v2'], []);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30002, [['g2', 'v2']])],
      grupos: [g1, g2],
    });
    expect(decisao.recusados[0]?.motivo).toBe(MOTIVO_RECUSA_APRENDIZADO_LI.gradeEmOutroGrupo);
  });

  it('⚠️ NEAR-MISS: a new entry from a family with several axes ⇒ refused', () => {
    const cor = grupo('cor', ['v1'], []);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30001, [['cor', 'v1', false]])],
      grupos: [cor],
    });
    expect(decisao.recusados[0]?.motivo).toBe(MOTIVO_RECUSA_APRENDIZADO_LI.eixosMultiplos);
  });

  it('⚠️ NEAR-MISS: a variante already held by another option of the conta ⇒ refused', () => {
    const cor = grupo('cor', ['v1'], [entrada('C1', 8001, [[30001, ['v1']]])]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30002, [['cor', 'v1']])],
      grupos: [cor],
    });
    expect(decisao.recusados[0]?.motivo).toBe(MOTIVO_RECUSA_APRENDIZADO_LI.varianteEmOutraOpcao);
  });

  it('⚠️ NEAR-MISS: the option already linked in another grupo ⇒ the cross-grupo check refuses', () => {
    const cor = grupo('cor', ['v2'], [entrada('C1', 8001, [])]);
    const tam = grupo('tam', ['v9'], [entrada('C1', 8002, [[30002, ['v9']]])]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30002, [['cor', 'v2']])],
      grupos: [cor, tam],
    });
    expect(decisao.recusados[0]?.motivo).toBe(MOTIVO_RECUSA_APRENDIZADO_LI.conflitoEntreGrupos);
  });

  it('⚠️ NEAR-MISS: the merged entry carrying a blocking finding (a stale variante) ⇒ refused', () => {
    // The entry this learning edits already names a variante the grupo no longer has: writing it
    // would carry that finding on an EDITED entry, so the learning is refused.
    const cor = grupo('cor', ['v1', 'v2'], [entrada('C1', 8001, [[30001, ['vX']]])]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30002, [['cor', 'v2']])],
      grupos: [cor],
    });
    expect(decisao.recusados[0]?.motivo).toBe(MOTIVO_RECUSA_APRENDIZADO_LI.conflitoNoGrupo);
    expect(decisao.grupos).toEqual([]);
  });

  it('stale evidence (a variante the grupo lacks, an unknown grupo) is refused', () => {
    const cor = grupo('cor', ['v1'], [entrada('C1', 8001, [])]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30001, [['cor', 'v7']]), evidencia(8001, 30002, [['xx', 'v1']])],
      grupos: [cor],
    });
    expect(decisao.recusados.map((r) => r.motivo)).toEqual([
      MOTIVO_RECUSA_APRENDIZADO_LI.varianteForaDoGrupo,
      MOTIVO_RECUSA_APRENDIZADO_LI.grupoDesconhecido,
    ]);
  });

  it('an option already linked in the claimed grupo ⇒ nothing to learn', () => {
    const cor = grupo('cor', ['v1'], [entrada('C1', 8001, [[30001, ['v1']]])]);
    const decisao = decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30001, [['cor', 'v1']])],
      grupos: [cor],
    });
    expect(decisao).toEqual({
      aprendidos: [],
      recusados: [],
      jaVinculadas: [{ gradeId: 8001, opcaoId: 30001 }],
      grupos: [],
    });
  });

  it('the input memo is never mutated', () => {
    const links = [entrada('C1', 8001, [[30001, ['v1']]])];
    const copia = structuredClone(links);
    decidirAprendizadoLi({
      contaId: 'C1',
      evidencias: [evidencia(8001, 30002, [['cor', 'v2']])],
      grupos: [grupo('cor', ['v1', 'v2'], links)],
    });
    expect(links).toEqual(copia);
  });
});
