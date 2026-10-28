import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that the `export *` line in
// `produto/index.ts` (and, through it, the root `src/index.ts`) reaches the new
// module.
import {
  TIPO_CONFLITO_LINK_LI,
  TIPO_ENTRADA_LINK_LI,
  conflitosLinksVariacoesLi,
  lerLinksVariacoesLi,
  linkVariacaoOpcaoLiSchema,
  linkVariacoesLiSchema,
  type ConflitoLinkLi,
  type EntradaLinkVariacoesLi,
} from '../../index';

/**
 * A stored entry in the shape the migrated corpus holds: ids as numbers,
 * `arakene_variation_id` as a LIST, the conta as a BARE id, plus a key this
 * schema does not model (carried back unchanged).
 */
const ENTRADA_ARMAZENADA = {
  name: 'Tamanho',
  grade_id: 8946,
  integracaoLiId: 'CONTA1',
  variationOptions: [
    { li_option_id: 37097, li_option_name: 'P', arakene_variation_id: ['v1'] },
    { li_option_id: 37098, li_option_name: 'M', arakene_variation_id: ['v2', 'v3'] },
  ],
  extraDoCorpus: { qualquer: [1, 'dois', null] },
};

describe('linkVariacoesLiSchema — the element', () => {
  it('round-trips a stored entry, extra keys included', () => {
    expect(linkVariacoesLiSchema.parse(ENTRADA_ARMAZENADA)).toEqual(ENTRADA_ARMAZENADA);
  });

  it('an absent `variationOptions` reads as an empty list', () => {
    const { variationOptions: _omitida, ...semOpcoes } = ENTRADA_ARMAZENADA;
    expect(linkVariacoesLiSchema.parse(semOpcoes).variationOptions).toEqual([]);
  });

  it('labels are labels: `name` and `li_option_name` may be null or absent', () => {
    const { name: _nome, ...semNome } = ENTRADA_ARMAZENADA;
    expect(linkVariacoesLiSchema.safeParse(semNome).success).toBe(true);
    expect(linkVariacoesLiSchema.safeParse({ ...ENTRADA_ARMAZENADA, name: null }).success).toBe(
      true,
    );
    expect(
      linkVariacaoOpcaoLiSchema.safeParse({ li_option_id: 1, arakene_variation_id: ['v1'] })
        .success,
    ).toBe(true);
    expect(
      linkVariacaoOpcaoLiSchema.safeParse({
        li_option_id: 1,
        li_option_name: null,
        arakene_variation_id: ['v1'],
      }).success,
    ).toBe(true);
  });

  it('an absent label READS as null, never undefined (a writer must never hand Firestore an undefined)', () => {
    const { name: _nome, ...semNome } = ENTRADA_ARMAZENADA;
    const lido = linkVariacoesLiSchema.parse(semNome);
    expect(Object.hasOwn(lido, 'name')).toBe(true);
    expect(lido.name).toBeNull();
    const opcao = linkVariacaoOpcaoLiSchema.parse({
      li_option_id: 1,
      arakene_variation_id: ['v1'],
    });
    expect(Object.hasOwn(opcao, 'li_option_name')).toBe(true);
    expect(opcao.li_option_name).toBeNull();
  });

  it.each([
    ['grade_id as a STRING (never coerced)', { grade_id: '8946' }],
    ['grade_id absent (a half-made entry)', { grade_id: undefined }],
    ['grade_id null (a half-made entry)', { grade_id: null }],
    ['grade_id zero', { grade_id: 0 }],
    ['grade_id negative', { grade_id: -1 }],
    ['grade_id a fraction', { grade_id: 1.5 }],
    ['grade_id beyond the safe integers', { grade_id: 2 ** 53 }],
    ['integracaoLiId empty', { integracaoLiId: '' }],
    ['integracaoLiId absent', { integracaoLiId: undefined }],
    ['variationOptions null', { variationOptions: null }],
  ])('⚠️ NEAR-MISS: %s is an invalid entry', (_rotulo, patch) => {
    expect(linkVariacoesLiSchema.safeParse({ ...ENTRADA_ARMAZENADA, ...patch }).success).toBe(
      false,
    );
  });

  it.each([
    ['li_option_id a fraction', { li_option_id: 1.5 }],
    ['li_option_id zero', { li_option_id: 0 }],
    ['li_option_id as a string', { li_option_id: '37097' }],
    ['arakene_variation_id a scalar (it is a LIST)', { arakene_variation_id: 'v1' }],
    ['arakene_variation_id holding an empty id', { arakene_variation_id: [''] }],
    ['arakene_variation_id holding a number', { arakene_variation_id: [1] }],
  ])('⚠️ NEAR-MISS: an option with %s is invalid', (_rotulo, patch) => {
    expect(
      linkVariacaoOpcaoLiSchema.safeParse({
        li_option_id: 37097,
        li_option_name: 'P',
        arakene_variation_id: ['v1'],
        ...patch,
      }).success,
    ).toBe(false);
  });

  it('the conta id is stored VERBATIM: a path-shaped value is accepted, never rewritten', () => {
    const comCaminho = { ...ENTRADA_ARMAZENADA, integracaoLiId: 'documents/integracao/CONTA1' };
    expect(linkVariacoesLiSchema.parse(comCaminho).integracaoLiId).toBe(
      'documents/integracao/CONTA1',
    );
  });
});

describe('lerLinksVariacoesLi — the one tolerant reader, never throws', () => {
  it('null and absent read as no entries', () => {
    expect(lerLinksVariacoesLi(null)).toEqual({ entradas: [], formatoInvalido: false });
    expect(lerLinksVariacoesLi(undefined)).toEqual({ entradas: [], formatoInvalido: false });
    expect(lerLinksVariacoesLi([])).toEqual({ entradas: [], formatoInvalido: false });
  });

  it.each([['texto'], [42], [{ grade_id: 1 }], [true]])(
    'a stored %j that is not a list is ONE format finding, never an exception',
    (valor) => {
      expect(lerLinksVariacoesLi(valor)).toEqual({ entradas: [], formatoInvalido: true });
    },
  );

  it('each element is reported at its own index: valid ones parsed, invalid ones kept raw', () => {
    const meiaEntrada = { integracaoLiId: 'CONTA1' };
    const leitura = lerLinksVariacoesLi([ENTRADA_ARMAZENADA, meiaEntrada, 'lixo', null]);
    expect(leitura.formatoInvalido).toBe(false);
    expect(leitura.entradas.map((e) => [e.indice, e.tipo])).toEqual([
      [0, TIPO_ENTRADA_LINK_LI.valida],
      [1, TIPO_ENTRADA_LINK_LI.invalida],
      [2, TIPO_ENTRADA_LINK_LI.invalida],
      [3, TIPO_ENTRADA_LINK_LI.invalida],
    ]);
    const [valida, meia, lixo] = leitura.entradas;
    expect(valida?.tipo === TIPO_ENTRADA_LINK_LI.valida && valida.link).toEqual(ENTRADA_ARMAZENADA);
    // ⭐ The raw value travels with every entry, so a writer can carry an
    // untouched one back EXACTLY as stored.
    expect(valida?.bruto).toBe(ENTRADA_ARMAZENADA);
    expect(meia?.bruto).toBe(meiaEntrada);
    expect(meia?.tipo === TIPO_ENTRADA_LINK_LI.invalida && meia.campos).toEqual(['grade_id']);
    // A non-object entry has no field to blame: the entry itself is unreadable.
    expect(lixo?.tipo === TIPO_ENTRADA_LINK_LI.invalida && lixo.campos).toEqual([]);
  });

  it('an invalid option names its own path', () => {
    const leitura = lerLinksVariacoesLi([
      {
        ...ENTRADA_ARMAZENADA,
        variationOptions: [{ li_option_id: 37097, arakene_variation_id: 'v1' }],
      },
    ]);
    const [entrada] = leitura.entradas;
    expect(entrada?.tipo === TIPO_ENTRADA_LINK_LI.invalida && entrada.campos).toEqual([
      'variationOptions.0.arakene_variation_id',
    ]);
  });

  it('⚠️ NEAR-MISS: an invalid entry is REPORTED, never skipped — the count matches the stored array', () => {
    const bruto = [ENTRADA_ARMAZENADA, { ...ENTRADA_ARMAZENADA, grade_id: '8946' }];
    expect(lerLinksVariacoesLi(bruto).entradas).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                          conflitosLinksVariacoesLi                          */
/* -------------------------------------------------------------------------- */

interface OpcaoTeste {
  readonly id: number;
  readonly variantes: readonly string[];
}

function link(integracaoLiId: string, gradeId: number, opcoes: readonly OpcaoTeste[]) {
  return {
    name: null,
    grade_id: gradeId,
    integracaoLiId,
    variationOptions: opcoes.map((o) => ({
      li_option_id: o.id,
      li_option_name: null,
      arakene_variation_id: [...o.variantes],
    })),
  };
}

function entradas(...brutos: readonly unknown[]): readonly EntradaLinkVariacoesLi[] {
  return lerLinksVariacoesLi(brutos).entradas;
}

const VARIANTES = ['v1', 'v2', 'v3', 'v4'];

function conflitos(
  lista: readonly EntradaLinkVariacoesLi[],
  editadas: readonly number[],
  opts: { variantesIds?: readonly string[]; removidas?: readonly string[] } = {},
): ConflitoLinkLi[] {
  return conflitosLinksVariacoesLi({
    variantesIds: opts.variantesIds ?? VARIANTES,
    variantesRemovidasNestaGravacao: opts.removidas ?? [],
    entradas: lista,
    editadas: new Set(editadas),
  });
}

function tipos(lista: readonly ConflitoLinkLi[]) {
  return lista.map((c) => c.tipo);
}

describe('conflitosLinksVariacoesLi — a clean grupo has no finding', () => {
  it('two options on two variantes, per conta, is fine', () => {
    const lista = entradas(
      link('C1', 8946, [
        { id: 37097, variantes: ['v1'] },
        { id: 37098, variantes: ['v2'] },
      ]),
    );
    expect(conflitos(lista, [0])).toEqual([]);
  });
});

describe('one variante in two options of ONE conta (per conta, never per link)', () => {
  it('two options of one link ⇒ a finding naming the variante and the conta', () => {
    const lista = entradas(
      link('C1', 8946, [
        { id: 37097, variantes: ['v1'] },
        { id: 37098, variantes: ['v1'] },
      ]),
    );
    expect(conflitos(lista, [0])).toEqual([
      {
        tipo: TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes,
        bloqueia: true,
        indices: [0],
        integracaoLiId: 'C1',
        gradeId: null,
        opcaoId: null,
        varianteId: 'v1',
        campos: [],
      },
    ]);
  });

  it('⚠️ NEAR-MISS: options of TWO links of the same conta still conflict (one store option per variante, per store)', () => {
    const lista = entradas(
      link('C1', 8946, [{ id: 37097, variantes: ['v1'] }]),
      link('C1', 8950, [{ id: 40001, variantes: ['v1'] }]),
    );
    const achados = conflitos(lista, [1]);
    expect(tipos(achados)).toEqual([TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes]);
    expect(achados[0]?.indices).toEqual([0, 1]);
    expect(achados[0]?.bloqueia).toBe(true);
  });

  it('the same variante in an option of ANOTHER conta is no finding', () => {
    const lista = entradas(
      link('C1', 8946, [{ id: 37097, variantes: ['v1'] }]),
      link('C2', 8946, [{ id: 37097, variantes: ['v1'] }]),
    );
    expect(conflitos(lista, [0, 1])).toEqual([]);
  });

  it('⚠️ NEAR-MISS: ids are exact — `V1` and `v1 ` are other variantes, so no conflict with `v1`', () => {
    const lista = entradas(
      link('C1', 8946, [
        { id: 37097, variantes: ['v1'] },
        { id: 37098, variantes: ['V1'] },
        { id: 37099, variantes: ['v1 '] },
      ]),
    );
    expect(tipos(conflitos(lista, [0], { variantesIds: ['v1', 'V1', 'v1 '] }))).toEqual([]);
  });

  it('⚠️ NEAR-MISS: conta ids are exact — `c1` is another conta than `C1`', () => {
    const lista = entradas(
      link('C1', 8946, [{ id: 37097, variantes: ['v1'] }]),
      link('c1', 8950, [{ id: 40001, variantes: ['v1'] }]),
    );
    expect(conflitos(lista, [0, 1])).toEqual([]);
  });
});

describe('one grade twice in one conta', () => {
  it('⇒ a finding over both entries', () => {
    const lista = entradas(
      link('C1', 8946, [{ id: 37097, variantes: ['v1'] }]),
      link('C1', 8946, [{ id: 37098, variantes: ['v2'] }]),
    );
    const achados = conflitos(lista, [1]);
    expect(tipos(achados)).toEqual([TIPO_CONFLITO_LINK_LI.gradeRepetidaNaConta]);
    expect(achados[0]).toMatchObject({ indices: [0, 1], integracaoLiId: 'C1', gradeId: 8946 });
  });

  it('the same grade for two contas is fine', () => {
    const lista = entradas(
      link('C1', 8946, [{ id: 37097, variantes: ['v1'] }]),
      link('C2', 8946, [{ id: 37097, variantes: ['v1'] }]),
    );
    expect(conflitos(lista, [0, 1])).toEqual([]);
  });
});

describe('one option twice in one link', () => {
  it('⇒ a finding on that entry, naming the option', () => {
    const lista = entradas(
      link('C1', 8946, [
        { id: 37097, variantes: ['v1'] },
        { id: 37097, variantes: ['v2'] },
      ]),
    );
    const achados = conflitos(lista, [0]);
    expect(tipos(achados)).toEqual([TIPO_CONFLITO_LINK_LI.opcaoRepetidaNoVinculo]);
    expect(achados[0]).toMatchObject({ indices: [0], gradeId: 8946, opcaoId: 37097 });
  });

  it('⚠️ NEAR-MISS: one variante under the same option id twice is that duplicate, not "two options"', () => {
    const lista = entradas(
      link('C1', 8946, [
        { id: 37097, variantes: ['v1'] },
        { id: 37097, variantes: ['v1'] },
      ]),
    );
    expect(tipos(conflitos(lista, [0]))).toEqual([TIPO_CONFLITO_LINK_LI.opcaoRepetidaNoVinculo]);
  });
});

describe('a variante the grupo does not have', () => {
  it('a variante deleted long ago (in neither the seed nor this save) ⇒ "inexistente", never "removida"', () => {
    const lista = entradas(link('C1', 8946, [{ id: 37097, variantes: ['v9'] }]));
    const achados = conflitos(lista, [0]);
    expect(tipos(achados)).toEqual([TIPO_CONFLITO_LINK_LI.varianteInexistente]);
    expect(achados[0]).toMatchObject({ varianteId: 'v9', indices: [0], bloqueia: true });
  });

  it('…and on an UNTOUCHED entry it is shown, never blocking', () => {
    const lista = entradas(link('C1', 8946, [{ id: 37097, variantes: ['v9'] }]));
    expect(conflitos(lista, [])).toMatchObject([
      { tipo: TIPO_CONFLITO_LINK_LI.varianteInexistente, bloqueia: false },
    ]);
  });

  it('⚠️ NEAR-MISS: a variante removed by THIS save, still named by an untouched entry ⇒ "removida", which ALWAYS blocks', () => {
    const lista = entradas(link('C1', 8946, [{ id: 37097, variantes: ['v4'] }]));
    const achados = conflitos(lista, [], { variantesIds: ['v1', 'v2', 'v3'], removidas: ['v4'] });
    expect(achados).toEqual([
      {
        tipo: TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada,
        bloqueia: true,
        indices: [0],
        integracaoLiId: null,
        gradeId: null,
        opcaoId: null,
        varianteId: 'v4',
        campos: [],
      },
    ]);
  });

  it('a variante listed as removed but still in the grupo is no finding', () => {
    const lista = entradas(link('C1', 8946, [{ id: 37097, variantes: ['v1'] }]));
    expect(conflitos(lista, [0], { removidas: ['v1'] })).toEqual([]);
  });
});

describe('one option holding several variantes — allowed, with a warning', () => {
  it('⇒ a finding that never blocks, even on an edited entry', () => {
    const lista = entradas(link('C1', 8946, [{ id: 37097, variantes: ['v1', 'v2'] }]));
    expect(conflitos(lista, [0])).toEqual([
      {
        tipo: TIPO_CONFLITO_LINK_LI.opcaoComVariasVariantes,
        bloqueia: false,
        indices: [0],
        integracaoLiId: 'C1',
        gradeId: 8946,
        opcaoId: 37097,
        varianteId: null,
        campos: [],
      },
    ]);
  });

  it('⚠️ NEAR-MISS: the same variante listed twice in one option is ONE variante', () => {
    const lista = entradas(link('C1', 8946, [{ id: 37097, variantes: ['v1', 'v1'] }]));
    expect(conflitos(lista, [0])).toEqual([]);
  });
});

describe('an invalid entry', () => {
  it('edited ⇒ blocks, naming its fields', () => {
    const lista = entradas({ integracaoLiId: 'C1' });
    expect(conflitos(lista, [0])).toEqual([
      {
        tipo: TIPO_CONFLITO_LINK_LI.entradaInvalida,
        bloqueia: true,
        indices: [0],
        integracaoLiId: null,
        gradeId: null,
        opcaoId: null,
        varianteId: null,
        campos: ['grade_id'],
      },
    ]);
  });

  it('untouched ⇒ shown, never blocking (renaming the grupo still saves)', () => {
    const lista = entradas({ integracaoLiId: 'C1' });
    expect(conflitos(lista, [])).toMatchObject([
      { tipo: TIPO_CONFLITO_LINK_LI.entradaInvalida, bloqueia: false },
    ]);
  });

  it('resolves nothing: its ids take part in no other rule', () => {
    const lista = entradas(link('C1', 8946, [{ id: 37097, variantes: ['v1'] }]), {
      ...link('C1', 8946, [{ id: 37098, variantes: ['v1', 'v9'] }]),
      grade_id: '8946',
    });
    expect(tipos(conflitos(lista, [0]))).toEqual([TIPO_CONFLITO_LINK_LI.entradaInvalida]);
  });

  /** Invalid only because its grade id is a STRING; it still names `v1`. */
  const INVALIDA_NOMEANDO_V1 = {
    grade_id: '8946',
    integracaoLiId: 'C1',
    variationOptions: [{ li_option_id: 37097, arakene_variation_id: ['v1'] }],
  };

  it('⚠️ NEAR-MISS: untouched, but naming a variante THIS save removes ⇒ that removal is blocked, under its own index', () => {
    // The one rule an invalid entry still takes part in: deleting the variante
    // would leave the stored entry naming a variante that no longer exists.
    const lista = entradas(INVALIDA_NOMEANDO_V1);
    expect(conflitos(lista, [], { variantesIds: [], removidas: ['v1'] })).toEqual([
      {
        tipo: TIPO_CONFLITO_LINK_LI.entradaInvalida,
        bloqueia: false,
        indices: [0],
        integracaoLiId: null,
        gradeId: null,
        opcaoId: null,
        varianteId: null,
        campos: ['grade_id'],
      },
      {
        tipo: TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada,
        bloqueia: true,
        indices: [0],
        integracaoLiId: null,
        gradeId: null,
        opcaoId: null,
        varianteId: 'v1',
        campos: [],
      },
    ]);
  });

  it('EQUAL: naming only variantes this save did NOT remove ⇒ its own finding alone', () => {
    // `v1` stays in the grupo; `v9` was deleted long ago (in neither the seed
    // nor this save): an invalid entry never yields "inexistente".
    const lista = entradas({
      ...INVALIDA_NOMEANDO_V1,
      variationOptions: [{ li_option_id: 37097, arakene_variation_id: ['v1', 'v9'] }],
    });
    expect(tipos(conflitos(lista, [], { variantesIds: ['v1'], removidas: ['v4'] }))).toEqual([
      TIPO_CONFLITO_LINK_LI.entradaInvalida,
    ]);
  });

  it('a valid and an invalid entry naming the same removed variante ⇒ ONE finding over both', () => {
    const lista = entradas(link('C1', 8946, [{ id: 37097, variantes: ['v4'] }]), {
      ...link('C2', 9000, [{ id: 50001, variantes: ['v4'] }]),
      grade_id: null,
    });
    expect(
      conflitos(lista, [], { variantesIds: ['v1', 'v2', 'v3'], removidas: ['v4'] }),
    ).toMatchObject([
      { tipo: TIPO_CONFLITO_LINK_LI.entradaInvalida, bloqueia: false, indices: [1] },
      {
        tipo: TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada,
        bloqueia: true,
        indices: [0, 1],
        varianteId: 'v4',
      },
    ]);
  });

  it('a variante listed as removed but still in the grupo is no finding for an invalid entry either', () => {
    const lista = entradas(INVALIDA_NOMEANDO_V1);
    expect(tipos(conflitos(lista, [], { variantesIds: ['v1'], removidas: ['v1'] }))).toEqual([
      TIPO_CONFLITO_LINK_LI.entradaInvalida,
    ]);
  });

  it.each([
    ['an upper-case id', { variationOptions: [{ li_option_id: 1, arakene_variation_id: ['V4'] }] }],
    [
      'an id with a trailing space',
      { variationOptions: [{ li_option_id: 1, arakene_variation_id: ['v4 '] }] },
    ],
    ['a NUMBER id', { variationOptions: [{ li_option_id: 1, arakene_variation_id: [4] }] }],
    [
      'a bare string where the list belongs',
      { variationOptions: [{ li_option_id: 1, arakene_variation_id: 'v4' }] },
    ],
    ['options that are not a list', { variationOptions: 'v4' }],
    ['options that are not objects', { variationOptions: ['v4', null, ['v4']] }],
  ])(
    '⚠️ NEAR-MISS: an invalid entry naming it only through %s does not name it (exact ids, lists of strings only)',
    (_rotulo, patch) => {
      const lista = entradas({ integracaoLiId: 'C1', ...patch });
      expect(tipos(conflitos(lista, [], { variantesIds: [], removidas: ['v4', '4'] }))).toEqual([
        TIPO_CONFLITO_LINK_LI.entradaInvalida,
      ]);
    },
  );

  it('⚠️ NEAR-MISS: an INHERITED field is not stored data, so it names nothing', () => {
    const herdada: unknown = Object.create({
      variationOptions: [{ li_option_id: 1, arakene_variation_id: ['v4'] }],
    });
    const lista = entradas(herdada);
    expect(tipos(conflitos(lista, [], { variantesIds: [], removidas: ['v4'] }))).toEqual([
      TIPO_CONFLITO_LINK_LI.entradaInvalida,
    ]);
  });

  it.each([['lixo'], [null], [42], [['v4']]])(
    'an invalid entry that is not an object (%j) names nothing, and never throws',
    (valor) => {
      const lista = entradas(valor);
      expect(tipos(conflitos(lista, [], { variantesIds: [], removidas: ['v4'] }))).toEqual([
        TIPO_CONFLITO_LINK_LI.entradaInvalida,
      ]);
    },
  );
});

describe('what blocks a save: a finding blocks only through an EDITED entry', () => {
  const lista = entradas(
    link('C1', 8946, [
      { id: 37097, variantes: ['v1'] },
      { id: 37098, variantes: ['v1'] },
    ]),
    link('C2', 9000, [{ id: 50001, variantes: ['v2'] }]),
  );

  it('an untouched stored entry carrying a conflict ⇒ shown, save allowed', () => {
    expect(conflitos(lista, [1])).toMatchObject([
      { tipo: TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes, bloqueia: false, indices: [0] },
    ]);
  });

  it('⚠️ NEAR-MISS: the same finding once one of its entries is edited ⇒ save refused', () => {
    expect(conflitos(lista, [0])).toMatchObject([
      { tipo: TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes, bloqueia: true, indices: [0] },
    ]);
  });
});

describe('the findings come in a fixed order', () => {
  it('invalid entries, then repeated grades, repeated options, a variante in two options, removed and unknown variantes, then the warnings', () => {
    const lista = entradas(
      link('C1', 8946, [
        { id: 37097, variantes: ['v1', 'v2'] },
        { id: 37097, variantes: ['v1'] },
        { id: 37098, variantes: ['v1', 'v9', 'v4'] },
      ]),
      link('C1', 8946, [{ id: 40001, variantes: ['v3'] }]),
      { integracaoLiId: 'C1' },
    );
    expect(
      tipos(
        conflitos(lista, [0, 1, 2], { variantesIds: VARIANTES.slice(0, 3), removidas: ['v4'] }),
      ),
    ).toEqual([
      TIPO_CONFLITO_LINK_LI.entradaInvalida,
      TIPO_CONFLITO_LINK_LI.gradeRepetidaNaConta,
      TIPO_CONFLITO_LINK_LI.opcaoRepetidaNoVinculo,
      TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes,
      TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada,
      TIPO_CONFLITO_LINK_LI.varianteInexistente,
      TIPO_CONFLITO_LINK_LI.opcaoComVariasVariantes,
      TIPO_CONFLITO_LINK_LI.opcaoComVariasVariantes,
    ]);
  });
});
