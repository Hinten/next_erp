import { describe, expect, it } from 'vitest';
import { DELETE_MARK } from '@delfrance/ui';
import { TIPO_CONFLITO_LINK_LI } from '@delfrance/schemas';

import {
  CONFLITO_VINCULO_LI,
  MARCA_CONFLITO_VINCULO_LI,
  achadosDoVinculadorLi,
  agruparVinculosLi,
  alternarRemocaoLi,
  definirVariantesDaOpcaoLi,
  editadasPorValorLi,
  marcaDeConflitoLi,
  mensagemDoConflitoLi,
  novoVinculoLi,
  prepararVinculosLi,
  rebaseVinculosLi,
  validarVinculosLi,
  type SeedVinculadorLi,
} from './vinculadorLi';

/**
 * The variation linker's pure rules (master plan step 10): what the Loja
 * Integrada tab edits, what its save checks, and how a conflicting save merges.
 *
 * Every fold here comes as a PAIR — what must come out equal, and the near-miss
 * that must stay distinct:
 *  - edited vs untouched is decided BY VALUE against the form's seed, never by
 *    object identity, and fails CLOSED;
 *  - a finding blocks a save only through an edited entry (or a variante this
 *    save removes); an untouched stored defect is shown, never blocking;
 *  - a conta is matched EXACTLY (no case, trim or path fold);
 *  - a conflict merges link by link, keyed by (conta, grade): neither side is
 *    ever taken wholesale, and a link both sides changed keeps the other side's
 *    version, marked.
 */

type Doc = Record<string, unknown>;

const opcao = (id: number, variantes: string[], nome: string | null = `Opção ${id}`): Doc => ({
  li_option_id: id,
  li_option_name: nome,
  arakene_variation_id: variantes,
});

/** A legacy-shaped valid link: the stored keys, as the migrated corpus holds them. */
const vinculo = (conta: string, grade: number, opcoes: Doc[], extra: Doc = {}): Doc => ({
  name: `Grade ${grade}`,
  grade_id: grade,
  integracaoLiId: conta,
  variationOptions: opcoes,
  ...extra,
});

const variante = (id: string, nome = id.toUpperCase()) => ({ id, nome, codigo: null });
const VARIANTES = [variante('v1'), variante('v2'), variante('v3')];

const seed = (links: unknown, variacoes: unknown = VARIANTES): SeedVinculadorLi => ({
  links,
  variacoes,
});

describe('prepararVinculosLi — what the save writes (the field’s prepareForSave)', () => {
  it('drops a link staged for removal and strips the marks; an untouched entry is written back AS IS', () => {
    const intacto = vinculo('C1', 8946, [opcao(1, ['v1'])], { chaveDesconhecida: 7 });
    const removido = { ...vinculo('C1', 8950, []), [DELETE_MARK]: true };
    const desfeito = { ...vinculo('C2', 8946, []), [DELETE_MARK]: false };
    const alterado = { ...vinculo('C3', 1, []), [MARCA_CONFLITO_VINCULO_LI]: 'alterado' };

    const saida = prepararVinculosLi([intacto, removido, desfeito, alterado]) as Doc[];

    expect(saida).toEqual([intacto, vinculo('C2', 8946, []), vinculo('C3', 1, [])]);
  });

  it('the untouched entry is the same object, extra keys and all', () => {
    const intacto = vinculo('C1', 8946, [opcao(1, ['v1'])], { chaveDesconhecida: 7 });
    const saida = prepararVinculosLi([intacto]) as Doc[];
    expect(saida[0]).toBe(intacto);
  });

  it('⚠️ an untouched entry holding an EMPTY option is written back as stored: only an edit drops an option', () => {
    const comOpcaoVazia = vinculo('C1', 8946, [opcao(1, ['v1']), opcao(2, [])]);
    const antes = structuredClone(comOpcaoVazia);

    const saida = prepararVinculosLi([comOpcaoVazia]) as Doc[];

    expect(saida[0]).toBe(comOpcaoVazia);
    expect(saida[0]).toEqual(antes);
  });

  it('an entry the server removed while this operator changed it ("removido") is dropped on save', () => {
    const marcado = { ...vinculo('C1', 8946, []), [MARCA_CONFLITO_VINCULO_LI]: 'removido' };
    expect(prepararVinculosLi([marcado])).toEqual([]);
  });

  it('a value that is not a list passes through untouched (the schema reports it)', () => {
    expect(prepararVinculosLi(null)).toBeNull();
    const ilegivel = { legado: true };
    expect(prepararVinculosLi(ilegivel)).toBe(ilegivel);
  });
});

describe('editadasPorValorLi — edited or untouched, BY VALUE against the seed', () => {
  const guardado = vinculo('C1', 8946, [opcao(1, ['v1', 'v2'])]);

  it('EQUAL: another object with the same value (an RHF clone, a remove-then-undo copy) is untouched', () => {
    const clone = structuredClone(guardado);
    expect(editadasPorValorLi([clone], seed([guardado]))).toEqual(new Set());
  });

  it.each([
    ['one option’s variante list reordered', vinculo('C1', 8946, [opcao(1, ['v2', 'v1'])])],
    ['a null label where the seed has none', { ...guardado, rotulo: null }],
    ['one id changed', vinculo('C1', 8947, [opcao(1, ['v1', 'v2'])])],
    ['the grade id as a string', { ...guardado, grade_id: '8946' }],
  ])('⚠️ NEAR-MISS: %s ⇒ edited', (_caso, entrada) => {
    expect(editadasPorValorLi([entrada], seed([guardado]))).toEqual(new Set([0]));
  });

  it('⚠️ FAIL CLOSED: a seed not yet published counts every entry as edited', () => {
    expect(editadasPorValorLi([guardado, guardado], null)).toEqual(new Set([0, 1]));
  });

  it('⚠️ a second copy of a stored entry is edited — one stored entry vouches for ONE entry', () => {
    expect(editadasPorValorLi([guardado, structuredClone(guardado)], seed([guardado]))).toEqual(
      new Set([1]),
    );
  });

  it('a seed with no links (never linked, or a new grupo) makes every entry edited', () => {
    expect(editadasPorValorLi([guardado], seed(null))).toEqual(new Set([0]));
  });
});

describe('validarVinculosLi — what blocks a save', () => {
  // v1 in two options of ONE conta: a per-store finding between untouched legacy entries.
  const legado = [vinculo('C1', 8946, [opcao(1, ['v1'])]), vinculo('C1', 8950, [opcao(2, ['v1'])])];

  it('EQUAL: an untouched stored finding never blocks — a rename of the grupo saves', () => {
    const values = { nome: 'Renomeado', variacoes: VARIANTES, linksVariacoesli: legado };
    expect(validarVinculosLi(values, seed(legado))).toEqual([]);
  });

  it('⚠️ NEAR-MISS: the same finding once one of its entries is edited ⇒ refused, on the tab', () => {
    const editado = [legado[0], vinculo('C1', 8950, [opcao(2, ['v1']), opcao(3, ['v3'])])];
    const values = { variacoes: VARIANTES, linksVariacoesli: editado };

    const issues = validarVinculosLi(values, seed(legado));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('linksVariacoesli');
    expect(issues[0]?.message).toContain('"V1" está em mais de uma opção desta loja');
  });

  it('one option per variante is per CONTA: the same variante under two contas is fine', () => {
    const links = [
      vinculo('C1', 8946, [opcao(1, ['v1'])]),
      vinculo('C2', 8946, [opcao(1, ['v1'])]),
    ];
    expect(validarVinculosLi({ variacoes: VARIANTES, linksVariacoesli: links }, seed([]))).toEqual(
      [],
    );
  });

  it('⚠️ NEAR-MISS: `C1` and `c1` are two contas — no fold, so no finding between them', () => {
    const links = [
      vinculo('C1', 8946, [opcao(1, ['v1'])]),
      vinculo('c1', 8946, [opcao(2, ['v1'])]),
    ];
    expect(validarVinculosLi({ variacoes: VARIANTES, linksVariacoesli: links }, seed([]))).toEqual(
      [],
    );
  });

  it('one option holding two variantes is a WARNING: it never blocks', () => {
    const links = [vinculo('C1', 8946, [opcao(1, ['v1', 'v2'])])];
    expect(validarVinculosLi({ variacoes: VARIANTES, linksVariacoesli: links }, seed([]))).toEqual(
      [],
    );
  });

  it('a variante removed by THIS save while an UNTOUCHED entry names it ⇒ refused, on the Variantes tab', () => {
    const links = [vinculo('C1', 8946, [opcao(1, ['v3'])])];
    const values = { variacoes: VARIANTES.slice(0, 2), linksVariacoesli: links };

    const issues = validarVinculosLi(values, seed(links));

    expect(issues).toEqual([
      {
        path: 'variacoes',
        message: 'a variante "V3" está vinculada à Loja Integrada; desvincule-a antes de excluir',
      },
    ]);
  });

  it('⚠️ NEAR-MISS: a variante deleted long ago (in neither the seed nor this save) is only a stale id — shown, never blocking', () => {
    const links = [vinculo('C1', 8946, [opcao(1, ['vx'])])];
    const values = { variacoes: VARIANTES, linksVariacoesli: links };
    expect(validarVinculosLi(values, seed(links))).toEqual([]);
  });

  it('⚠️ FAIL CLOSED: without a published seed the same stale id blocks', () => {
    const links = [vinculo('C1', 8946, [opcao(1, ['vx'])])];
    const issues = validarVinculosLi({ variacoes: VARIANTES, linksVariacoesli: links }, null);
    expect(issues.map((i) => i.path)).toEqual(['linksVariacoesli']);
  });

  it('nothing to say when the field is absent or not a list (the schema speaks for the latter)', () => {
    expect(validarVinculosLi({ variacoes: VARIANTES }, seed(null))).toEqual([]);
    expect(validarVinculosLi({ linksVariacoesli: { x: 1 } }, seed(null))).toEqual([]);
  });
});

describe('agruparVinculosLi — one block per ACTIVE conta, the rest read-only', () => {
  const ativas = new Set(['CONTA1']);

  it('EQUAL: an entry whose integracaoLiId IS the conta id goes to that conta', () => {
    const grupos = agruparVinculosLi([vinculo('CONTA1', 8946, [])], ativas);
    expect(grupos.porConta.get('CONTA1')?.map((i) => i.indice)).toEqual([0]);
    expect(grupos.outras).toEqual([]);
  });

  it.each(['documents/integracao/CONTA1', 'conta1', 'CONTA1 ', 'CONTA2'])(
    '⚠️ NEAR-MISS: %j is "conta não reconhecida" (or another conta) — never folded in',
    (conta) => {
      const grupos = agruparVinculosLi([vinculo(conta, 8946, [])], ativas);
      expect(grupos.porConta.size).toBe(0);
      expect(grupos.outras.map((i) => i.indice)).toEqual([0]);
    },
  );

  it('an invalid entry (a half-made one) is never dropped: it is listed with the others', () => {
    const grupos = agruparVinculosLi([{ integracaoLiId: 'CONTA1' }, 'lixo'], ativas);
    expect(grupos.outras.map((i) => [i.indice, i.entrada.tipo])).toEqual([
      [0, 'invalida'],
      [1, 'invalida'],
    ]);
  });

  it('a stored value that is not a list says so', () => {
    expect(agruparVinculosLi({ legado: 1 }, ativas).formatoInvalido).toBe(true);
    expect(agruparVinculosLi(null, ativas).formatoInvalido).toBe(false);
  });
});

describe('the edits — immutable, and an emptied option is dropped AS IT IS EDITED', () => {
  const guardado = vinculo('C1', 8946, [opcao(1, ['v1']), opcao(2, ['v2'])], { extra: 'k' });

  it('assigns variantes to an option, keeping every other key and option untouched', () => {
    const antes = structuredClone(guardado);
    const novo = definirVariantesDaOpcaoLi(guardado, { id: 2, nome: 'M' }, ['v2', 'v3']);
    expect(novo).toEqual(
      vinculo('C1', 8946, [opcao(1, ['v1']), opcao(2, ['v2', 'v3'])], { extra: 'k' }),
    );
    expect(guardado).toEqual(antes);
  });

  it('clearing an option’s last variante drops the option from the entry', () => {
    const novo = definirVariantesDaOpcaoLi(guardado, { id: 1, nome: 'P' }, []);
    expect(novo.variationOptions).toEqual([opcao(2, ['v2'])]);
  });

  it('a new option is appended with the store’s name as its label', () => {
    const novo = definirVariantesDaOpcaoLi(guardado, { id: 3, nome: 'G' }, ['v3']);
    expect((novo.variationOptions as Doc[])[2]).toEqual(opcao(3, ['v3'], 'G'));
  });

  it('an edit redoes a link marked by a conflict: the mark goes', () => {
    const marcado = { ...guardado, [MARCA_CONFLITO_VINCULO_LI]: 'removido' };
    const novo = definirVariantesDaOpcaoLi(marcado, { id: 1, nome: 'P' }, ['v1', 'v3']);
    expect(MARCA_CONFLITO_VINCULO_LI in novo).toBe(false);
  });

  it('remove, then undo: the mark comes and goes, the value is back exactly', () => {
    const marcada = alternarRemocaoLi([guardado], 0);
    expect((marcada[0] as Doc)[DELETE_MARK]).toBe(true);
    expect(alternarRemocaoLi(marcada, 0)).toEqual([guardado]);
  });

  it('⚠️ remove, then undo, on an entry a conflict marked "removido": the note STAYS, and the save still drops it', () => {
    const marcado = { ...guardado, [MARCA_CONFLITO_VINCULO_LI]: CONFLITO_VINCULO_LI.removido };

    const volta = alternarRemocaoLi(alternarRemocaoLi([marcado], 0), 0);

    expect(volta).toEqual([marcado]);
    expect(marcaDeConflitoLi(volta[0])).toBe(CONFLITO_VINCULO_LI.removido);
    expect(prepararVinculosLi(volta)).toEqual([]);
  });

  it('⚠️ NEAR-MISS: EDITING that entry is what clears the note — and then the save keeps it', () => {
    const marcado = { ...guardado, [MARCA_CONFLITO_VINCULO_LI]: CONFLITO_VINCULO_LI.removido };

    const editado = definirVariantesDaOpcaoLi(marcado, { id: 1, nome: 'P' }, ['v1', 'v3']);

    expect(marcaDeConflitoLi(editado)).toBeNull();
    expect(prepararVinculosLi([editado])).toEqual([editado]);
  });

  it('remove, then undo, on an "alterado" entry keeps its note too', () => {
    const marcado = { ...guardado, [MARCA_CONFLITO_VINCULO_LI]: CONFLITO_VINCULO_LI.alterado };
    const volta = alternarRemocaoLi(alternarRemocaoLi([marcado], 0), 0);
    expect(volta).toEqual([marcado]);
  });

  it('even an element that is not an object can be staged for removal, and restored', () => {
    const marcada = alternarRemocaoLi(['lixo'], 0);
    expect(prepararVinculosLi(marcada)).toEqual([]);
    expect(alternarRemocaoLi(marcada, 0)).toEqual(['lixo']);
  });

  it('a new link holds the conta id verbatim and the grade’s nome as its label', () => {
    expect(novoVinculoLi('CONTA1', { id: 8946, nome: 'Tamanho' })).toEqual({
      name: 'Tamanho',
      grade_id: 8946,
      integracaoLiId: 'CONTA1',
      variationOptions: [],
    });
  });
});

describe('achadosDoVinculadorLi — the tab’s findings, on the form’s indices', () => {
  it('maps findings back to the RAW index, skipping an entry staged for removal', () => {
    const removido = { ...vinculo('C1', 1, [opcao(9, ['v1'])]), [DELETE_MARK]: true };
    const a = vinculo('C1', 8946, [opcao(1, ['v1'])]);
    const b = vinculo('C1', 8950, [opcao(2, ['v1'])]);

    const achados = achadosDoVinculadorLi([removido, a, b], VARIANTES, seed([a, b]));

    expect(achados).toEqual([
      expect.objectContaining({
        tipo: TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes,
        bloqueia: false,
        indices: [1, 2],
      }),
    ]);
  });

  it('a variante staged for deletion on the Variantes tab already shows here as removed while linked', () => {
    const links = [vinculo('C1', 8946, [opcao(1, ['v3'])])];
    const vivas = [...VARIANTES.slice(0, 2), { ...VARIANTES[2], [DELETE_MARK]: true }];

    const achados = achadosDoVinculadorLi(links, vivas, seed(links));

    expect(achados.map((a) => [a.tipo, a.bloqueia])).toEqual([
      [TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada, true],
    ]);
  });
});

describe('mensagemDoConflitoLi — pt-BR, by name', () => {
  it('the per-store rule names the variante', () => {
    const [achado] = achadosDoVinculadorLi(
      [vinculo('C1', 8946, [opcao(1, ['v1'])]), vinculo('C1', 8950, [opcao(2, ['v1'])])],
      VARIANTES,
      null,
    );
    expect(mensagemDoConflitoLi(achado!, (id) => (id === 'v1' ? '40' : id))).toBe(
      'a variante "40" está em mais de uma opção desta loja; cada variante aponta para uma só ' +
        'opção por loja',
    );
  });
});

describe('rebaseVinculosLi — a conflicting save merges link by link', () => {
  const ana = vinculo('C2', 8946, [opcao(1, ['v1'])]);
  const bruno = vinculo('C1', 8950, [opcao(5, ['v2'])]);
  const comum = vinculo('C1', 8946, [opcao(1, ['v1'])]);

  it('EQUAL: Ana adds (C2, 8946), Bruno adds (C1, 8950) ⇒ both kept, nothing collides', () => {
    const r = rebaseVinculosLi({ loaded: [comum], server: [comum, ana], mine: [comum, bruno] });
    expect(r).toEqual({ value: [comum, ana, bruno], collided: false });
  });

  it('Bruno removes an entry Ana did not touch ⇒ removed (staged; the save drops it)', () => {
    const removido = { ...comum, [DELETE_MARK]: true };
    const r = rebaseVinculosLi({ loaded: [comum], server: [comum, ana], mine: [removido] });
    expect(r.collided).toBe(false);
    expect(prepararVinculosLi(r.value)).toEqual([ana]);
  });

  it('Ana removes an entry Bruno did not touch ⇒ it stays removed', () => {
    const r = rebaseVinculosLi({
      loaded: [comum, ana],
      server: [comum],
      mine: [comum, ana, bruno],
    });
    expect(r).toEqual({ value: [comum, bruno], collided: false });
  });

  it('⚠️ NEAR-MISS: both change (C1, 8946) ⇒ Ana’s version kept, MARKED, and it collides', () => {
    const daAna = vinculo('C1', 8946, [opcao(1, ['v2'])]);
    const doBruno = vinculo('C1', 8946, [opcao(1, ['v3'])]);

    const r = rebaseVinculosLi({ loaded: [comum], server: [daAna], mine: [doBruno] });

    expect(r.collided).toBe(true);
    expect(r.value).toEqual([
      { ...daAna, [MARCA_CONFLITO_VINCULO_LI]: CONFLITO_VINCULO_LI.alterado },
    ]);
    // …and the save writes Ana's version, the mark stripped.
    expect(prepararVinculosLi(r.value)).toEqual([daAna]);
  });

  it('⚠️ NEAR-MISS: a key twice on the server, which Bruno changed ⇒ the server’s kept, marked', () => {
    const doBruno = vinculo('C1', 8946, [opcao(1, ['v3'])]);
    const r = rebaseVinculosLi({ loaded: [comum], server: [comum, comum], mine: [doBruno] });
    expect(r.collided).toBe(true);
    expect(r.value).toEqual([
      { ...comum, [MARCA_CONFLITO_VINCULO_LI]: 'alterado' },
      { ...comum, [MARCA_CONFLITO_VINCULO_LI]: 'alterado' },
    ]);
  });

  it('both made the SAME change ⇒ nothing collides', () => {
    const igual = vinculo('C1', 8946, [opcao(1, ['v2'])]);
    expect(rebaseVinculosLi({ loaded: [comum], server: [igual], mine: [igual] })).toEqual({
      value: [igual],
      collided: false,
    });
  });

  it('Ana removed what Bruno changed ⇒ collides; Bruno’s version shown "removido", dropped on save unless redone', () => {
    const doBruno = vinculo('C1', 8946, [opcao(1, ['v3'])]);
    const r = rebaseVinculosLi({ loaded: [comum], server: [], mine: [doBruno] });
    expect(r.collided).toBe(true);
    expect(r.value).toEqual([{ ...doBruno, [MARCA_CONFLITO_VINCULO_LI]: 'removido' }]);
    expect(prepararVinculosLi(r.value)).toEqual([]);
  });

  it('a staged removal of a key-less legacy entry is re-applied while the server still has it', () => {
    const meiaBoca = { integracaoLiId: 'C1' };
    const removida = { ...meiaBoca, [DELETE_MARK]: true };
    const r = rebaseVinculosLi({
      loaded: [meiaBoca],
      server: [meiaBoca, ana],
      mine: [removida],
    });
    expect(r.collided).toBe(false);
    expect(prepararVinculosLi(r.value)).toEqual([ana]);
  });

  it('a field the server holds as null merges like an empty list', () => {
    expect(rebaseVinculosLi({ loaded: null, server: null, mine: [bruno] })).toEqual({
      value: [bruno],
      collided: false,
    });
  });
});
