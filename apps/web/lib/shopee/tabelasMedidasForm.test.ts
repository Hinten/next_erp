import { describe, expect, it } from 'vitest';

import { DELETE_MARK, valuesEqual } from '@delfrance/ui';
import {
  ESTADO_LISTA_SHOPEE,
  MOTIVO_ENTRADA_SHOPEE_ILEGIVEL,
  type EntradaTabelaShopee,
} from '@delfrance/schemas';

import {
  PAPEL_DA_LINHA,
  adicionarOuSubstituir,
  entradasDeContasAusentes,
  indiceAtivoDaCategoria,
  linhasDaConta,
  marcarRemocao,
  prepararTabelasShopeeParaSalvar,
} from './tabelasMedidasForm';

/**
 * What these pin is the staged edit of ONE conta's picks inside the tabela's
 * form (reconcile §2.6.4): the role each stored row plays for publish, and the
 * three mutators plus `prepareForSave`, which must never drop or rewrite a
 * stored value the operator could not see (root CLAUDE.md rule 8 — the migrated
 * corpus carries per-key `null`s, unreadable rows and duplicate categories).
 *
 * ⚠️ The selection rule is NOT re-tested here as logic — it is
 * `indiceDaEntradaShopee` from `@delfrance/schemas`. What is pinned is that this
 * module feeds it the rows that SURVIVE the save, in raw-index terms, and never
 * a local first-match loop over the form's list (M59).
 *
 * Ids are Shopee's own published doc-sample ids (size charts 7000246xx,
 * categories 100087 / 400055) and the fixture conta `int-1`.
 */

const CONTA = 'int-1';
const IRMA = 'conta-shopee-irma';

const CAMISETAS: EntradaTabelaShopee = {
  categoryId: 100087,
  size_chart_id: 700024639,
  name: 'Camisetas',
};
const COPIA: EntradaTabelaShopee = {
  categoryId: 100087,
  size_chart_id: 700024641,
  name: '(Cópia) Camisetas',
};
const CALCAS: EntradaTabelaShopee = {
  categoryId: 400055,
  size_chart_id: 700024613,
  name: 'Calças',
};

/** Freeze a value all the way down, so a mutation of the INPUT throws instead of passing. */
function congelar<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const filho of Object.values(v)) congelar(filho);
    Object.freeze(v);
  }
  return v;
}

const marcada = (e: object) => ({ ...e, [DELETE_MARK]: true });

describe('linhasDaConta — the estado of the conta slot', () => {
  it.each([
    ['outer null', null, ESTADO_LISTA_SHOPEE.semLista],
    ['outer undefined', undefined, ESTADO_LISTA_SHOPEE.semLista],
    ['empty map', {}, ESTADO_LISTA_SHOPEE.semLista],
    ['per-key null (legacy)', { [CONTA]: null }, ESTADO_LISTA_SHOPEE.semLista],
    ['another conta only', { [IRMA]: [CALCAS] }, ESTADO_LISTA_SHOPEE.semLista],
    ['a map that is an array', [CAMISETAS], ESTADO_LISTA_SHOPEE.campoInvalido],
    ['a map that is a string', 'x', ESTADO_LISTA_SHOPEE.campoInvalido],
    [
      'a conta value that is an object',
      { [CONTA]: { 0: CAMISETAS } },
      ESTADO_LISTA_SHOPEE.listaInvalida,
    ],
    ['an empty list', { [CONTA]: [] }, ESTADO_LISTA_SHOPEE.lista],
  ])('%s → %s, with no rows outside a list', (_nome, mapa, estado) => {
    const r = linhasDaConta(mapa, CONTA);
    expect(r.estado).toBe(estado);
    expect(r.linhas).toEqual([]);
  });

  it('NEAR-MISS keys: `int-10` and ` int-1` are other contas, never this one', () => {
    for (const chave of ['int-10', ' int-1', 'INT-1']) {
      expect(linhasDaConta({ [chave]: [CAMISETAS] }, CONTA).estado).toBe(
        ESTADO_LISTA_SHOPEE.semLista,
      );
    }
    expect(linhasDaConta({ [CONTA]: [CAMISETAS] }, CONTA).linhas).toHaveLength(1);
  });
});

describe('linhasDaConta — one row per STORED element, raw-indexed', () => {
  it('keeps stored order, the raw index, and each entry as EXACTLY its three keys', () => {
    const mapa = congelar({
      [CONTA]: [null, { ...CALCAS, extra: 'x' }, 'lixo', CAMISETAS],
    });

    const { linhas } = linhasDaConta(mapa, CONTA);

    expect(linhas.map((l) => l.indice)).toEqual([0, 1, 2, 3]);
    expect(linhas[1]?.entrada).toEqual(CALCAS);
    expect(Object.keys(linhas[1]?.entrada ?? {}).sort()).toEqual([
      'categoryId',
      'name',
      'size_chart_id',
    ]);
    expect(linhas[3]?.entrada).toEqual(CAMISETAS);
  });

  it('M5: an unreadable element at raw 0 leaves the readable one at raw 1 with `indice` 1, and `usada`', () => {
    const { linhas } = linhasDaConta({ [CONTA]: [{ size_chart_id: 1 }, CAMISETAS] }, CONTA);

    expect(linhas[0]).toMatchObject({
      indice: 0,
      entrada: null,
      motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.categoriaInvalida,
      papel: PAPEL_DA_LINHA.ilegivel,
      marcada: false,
    });
    expect(linhas[1]).toMatchObject({ indice: 1, papel: PAPEL_DA_LINHA.usada, motivo: null });
  });

  it('R-h: only a plain-object element is `removivel` — null, a string and an array are not', () => {
    const { linhas } = linhasDaConta(
      { [CONTA]: [{ size_chart_id: 1 }, null, 'x', [1], CAMISETAS] },
      CONTA,
    );

    expect(linhas.map((l) => l.removivel)).toEqual([true, false, false, false, true]);
    expect(linhas.map((l) => l.papel)).toEqual([
      PAPEL_DA_LINHA.ilegivel,
      PAPEL_DA_LINHA.ilegivel,
      PAPEL_DA_LINHA.ilegivel,
      PAPEL_DA_LINHA.ilegivel,
      PAPEL_DA_LINHA.usada,
    ]);
  });
});

describe('linhasDaConta — papel through the ONE selector', () => {
  it('a duplicated category: the FIRST row is `usada`, the second `ignorada-duplicada`', () => {
    const { linhas } = linhasDaConta({ [CONTA]: [CAMISETAS, COPIA] }, CONTA);

    expect(linhas.map((l) => l.papel)).toEqual([
      PAPEL_DA_LINHA.usada,
      PAPEL_DA_LINHA.ignoradaDuplicada,
    ]);
  });

  it('⭐ M59: marking the first `Camisetas` row PROMOTES the second to `usada` — the selector runs on the rows that survive the save', () => {
    const marcado = marcarRemocao({ [CONTA]: [CAMISETAS, COPIA] }, CONTA, 0, true);

    const { linhas } = linhasDaConta(marcado, CONTA);

    expect(linhas.map((l) => [l.indice, l.papel, l.marcada])).toEqual([
      [0, PAPEL_DA_LINHA.seraRemovida, true],
      [1, PAPEL_DA_LINHA.usada, false],
    ]);
  });

  it('an unreadable row of the same category never wins — the readable one after it is `usada`', () => {
    // ⚠️ L2b: a digit-string id is UNREADABLE, never folded to the number.
    const legado = { categoryId: 100087, size_chart_id: '700024639', name: 'Camisetas' };

    const { linhas } = linhasDaConta({ [CONTA]: [legado, COPIA] }, CONTA);

    expect(linhas[0]).toMatchObject({
      papel: PAPEL_DA_LINHA.ilegivel,
      motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.tabelaInvalida,
    });
    expect(linhas[1]?.papel).toBe(PAPEL_DA_LINHA.usada);
  });

  it('FOLD SCOPE — only `categoryId` makes two rows the same: ±1, the same chart id, the same name are DISTINCT', () => {
    const vizinha = { ...COPIA, categoryId: 100088 };
    const mesmaTabela = { ...CALCAS, size_chart_id: CAMISETAS.size_chart_id };
    const mesmoNome = { ...CALCAS, name: CAMISETAS.name, size_chart_id: 700024605 };

    const { linhas } = linhasDaConta(
      { [CONTA]: [CAMISETAS, vizinha, mesmaTabela, mesmoNome] },
      CONTA,
    );

    // CAMISETAS (100087), vizinha (100088), mesmaTabela (400055) are all `usada`;
    // mesmoNome is 400055 AGAIN, so it is the duplicate — keyed on the category,
    // never on the name it shares with row 0.
    expect(linhas.map((l) => l.papel)).toEqual([
      PAPEL_DA_LINHA.usada,
      PAPEL_DA_LINHA.usada,
      PAPEL_DA_LINHA.usada,
      PAPEL_DA_LINHA.ignoradaDuplicada,
    ]);
  });

  it('M24-like: another conta’s rows never decide this conta’s roles', () => {
    const { linhas } = linhasDaConta({ [IRMA]: [COPIA, CAMISETAS], [CONTA]: [CAMISETAS] }, CONTA);

    expect(linhas.map((l) => l.papel)).toEqual([PAPEL_DA_LINHA.usada]);
  });

  it('a MARKED unreadable object is `sera-removida`, keeps its motivo and stays removable', () => {
    const { linhas } = linhasDaConta({ [CONTA]: [marcada({ size_chart_id: 1 })] }, CONTA);

    expect(linhas[0]).toMatchObject({
      papel: PAPEL_DA_LINHA.seraRemovida,
      motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.categoriaInvalida,
      marcada: true,
      removivel: true,
    });
  });

  it('`marcada` IS what the save drops: `true` marks, `false` does not (near-miss)', () => {
    const { linhas } = linhasDaConta(
      { [CONTA]: [{ ...CAMISETAS, [DELETE_MARK]: false }, marcada(CALCAS)] },
      CONTA,
    );

    expect(linhas.map((l) => [l.marcada, l.papel])).toEqual([
      [false, PAPEL_DA_LINHA.usada],
      [true, PAPEL_DA_LINHA.seraRemovida],
    ]);
    // …and the save agrees with what the screen showed.
    expect(
      prepararTabelasShopeeParaSalvar({
        [CONTA]: [{ ...CAMISETAS, [DELETE_MARK]: false }, marcada(CALCAS)],
      }),
    ).toEqual({ [CONTA]: [CAMISETAS] });
  });

  it('a foreign TRUTHY mark (`1`) is shown as marked — because the shared strip DROPS it on save', () => {
    // The screen asks `stripMarkedForDeletion` itself rather than re-spelling
    // "=== true": a second spelling would show this row as kept while the save
    // silently removed it.
    const valor = { [CONTA]: [{ ...CAMISETAS, [DELETE_MARK]: 1 }, COPIA] };

    const { linhas } = linhasDaConta(valor, CONTA);

    expect(linhas.map((l) => [l.marcada, l.papel])).toEqual([
      [true, PAPEL_DA_LINHA.seraRemovida],
      [false, PAPEL_DA_LINHA.usada],
    ]);
    expect(prepararTabelasShopeeParaSalvar(valor)).toEqual({ [CONTA]: [COPIA] });
  });
});

describe('adicionarOuSubstituir — a conta with no list yet', () => {
  it('outer null / undefined → a map holding ONLY this conta', () => {
    expect(adicionarOuSubstituir(null, CONTA, CAMISETAS, { tipo: 'adicionar' })).toEqual({
      [CONTA]: [CAMISETAS],
    });
    expect(adicionarOuSubstituir(undefined, CONTA, CAMISETAS, { tipo: 'adicionar' })).toEqual({
      [CONTA]: [CAMISETAS],
    });
  });

  it('a per-key null or an absent key → `[nova]`, every sibling key carried by reference', () => {
    const irma = [CALCAS];
    const mapa = congelar({ [IRMA]: irma, [CONTA]: null, outra: null });

    const r = adicionarOuSubstituir(mapa, CONTA, CAMISETAS, { tipo: 'adicionar' });

    expect(r).toEqual({ [IRMA]: [CALCAS], [CONTA]: [CAMISETAS], outra: null });
    expect(r[IRMA]).toBe(irma);
    expect(
      adicionarOuSubstituir({ [IRMA]: irma }, CONTA, CAMISETAS, { tipo: 'adicionar' }),
    ).toEqual({ [IRMA]: [CALCAS], [CONTA]: [CAMISETAS] });
  });

  it('`trocar` with no list has nothing to replace → `mapa` unchanged', () => {
    const mapa = { [CONTA]: null };
    expect(adicionarOuSubstituir(mapa, CONTA, CAMISETAS, { tipo: 'trocar', indice: 0 })).toBe(mapa);
  });
});

describe('adicionarOuSubstituir — `adicionar` on a list (Q6 = replace)', () => {
  it('⭐ M60: a category that already has a SURVIVING row is REPLACED at that row’s index — never a second entry', () => {
    const mapa = congelar({ [CONTA]: [CALCAS, CAMISETAS] });

    const r = adicionarOuSubstituir(mapa, CONTA, COPIA, { tipo: 'adicionar' });

    expect(r[CONTA]).toEqual([CALCAS, COPIA]);
  });

  it('NEAR-MISS: a category one id away is a NEW category — appended', () => {
    const vizinha = { ...COPIA, categoryId: 100088 };

    const r = adicionarOuSubstituir({ [CONTA]: [CAMISETAS] }, CONTA, vizinha, {
      tipo: 'adicionar',
    });

    expect(r[CONTA]).toEqual([CAMISETAS, vizinha]);
  });

  it('a row only MARKED for removal does not count — the new pick is appended, the mark stays', () => {
    const r = adicionarOuSubstituir({ [CONTA]: [marcada(CAMISETAS)] }, CONTA, COPIA, {
      tipo: 'adicionar',
    });

    expect(r[CONTA]).toEqual([marcada(CAMISETAS), COPIA]);
    expect(prepararTabelasShopeeParaSalvar(r)).toEqual({ [CONTA]: [COPIA] });
  });

  it('with the first row marked, the SURVIVING row of the category is the one replaced', () => {
    const r = adicionarOuSubstituir({ [CONTA]: [marcada(CAMISETAS), COPIA] }, CONTA, CAMISETAS, {
      tipo: 'adicionar',
    });

    expect(r[CONTA]).toEqual([marcada(CAMISETAS), CAMISETAS]);
  });

  it('an UNREADABLE row of the category is never replaced — appended beside it, kept verbatim', () => {
    const legado = { categoryId: 100087, size_chart_id: '700024639', name: 'Camisetas' };
    const mapa = congelar({ [CONTA]: [legado] });

    const r = adicionarOuSubstituir(mapa, CONTA, COPIA, { tipo: 'adicionar' });

    expect(r[CONTA]).toEqual([legado, COPIA]);
    expect((r[CONTA] as unknown[])[0]).toBe(legado);
  });

  it('stores EXACTLY the three keys — a caller object with one more never reaches the map', () => {
    const comExtra = { ...CAMISETAS, [DELETE_MARK]: true, extra: 1 } as EntradaTabelaShopee;

    const r = adicionarOuSubstituir(null, CONTA, comExtra, { tipo: 'adicionar' });

    expect(r).toEqual({ [CONTA]: [CAMISETAS] });
  });
});

describe('adicionarOuSubstituir — `trocar`', () => {
  it('replaces at `indice`, keeps the position and clears the mark', () => {
    const r = adicionarOuSubstituir(
      { [CONTA]: [CALCAS, marcada(CAMISETAS), COPIA] },
      CONTA,
      { ...CAMISETAS, size_chart_id: 700024605 },
      { tipo: 'trocar', indice: 1 },
    );

    expect(r[CONTA]).toEqual([CALCAS, { ...CAMISETAS, size_chart_id: 700024605 }, COPIA]);
  });

  it('an unreadable OBJECT may be replaced (R-h: it is removable)', () => {
    const r = adicionarOuSubstituir({ [CONTA]: [{ size_chart_id: 1 }] }, CONTA, CAMISETAS, {
      tipo: 'trocar',
      indice: 0,
    });

    expect(r[CONTA]).toEqual([CAMISETAS]);
  });

  it.each([
    ['out of range', 2],
    ['negative', -1],
    ['not an integer', 0.5],
  ])('an index %s → `mapa` unchanged', (_nome, indice) => {
    const mapa = { [CONTA]: [CAMISETAS, CALCAS] };
    expect(adicionarOuSubstituir(mapa, CONTA, COPIA, { tipo: 'trocar', indice })).toBe(mapa);
  });

  it('a non-object element (shown "ilegível (mantida)") is never replaced', () => {
    const mapa = { [CONTA]: [null, 'x'] };
    expect(adicionarOuSubstituir(mapa, CONTA, COPIA, { tipo: 'trocar', indice: 0 })).toBe(mapa);
    expect(adicionarOuSubstituir(mapa, CONTA, COPIA, { tipo: 'trocar', indice: 1 })).toBe(mapa);
  });
});

describe('the mutators refuse what the tab offers no edit for', () => {
  it.each([
    ['campo-invalido (an array map)', [CAMISETAS]],
    ['campo-invalido (a string map)', 'x'],
    ['lista-invalida', { [CONTA]: { 0: CAMISETAS } }],
  ])('%s → `mapa` returned as is, never "repaired"', (_nome, mapa) => {
    expect(adicionarOuSubstituir(mapa, CONTA, COPIA, { tipo: 'adicionar' })).toBe(mapa);
    expect(adicionarOuSubstituir(mapa, CONTA, COPIA, { tipo: 'trocar', indice: 0 })).toBe(mapa);
    expect(marcarRemocao(mapa, CONTA, 0, true)).toBe(mapa);
  });
});

describe('marcarRemocao — staged, reversible', () => {
  it('marking sets the mark on a COPY of the element; the input is untouched', () => {
    const mapa = congelar({ [CONTA]: [CAMISETAS, CALCAS] });

    const r = marcarRemocao(mapa, CONTA, 1, true);

    expect(r[CONTA]).toEqual([CAMISETAS, { ...CALCAS, [DELETE_MARK]: true }]);
    expect((r[CONTA] as unknown[])[0]).toBe(CAMISETAS);
  });

  it('⭐ RT6 / M67: mark → unmark gives back a value `valuesEqual` to the load — no stray key', () => {
    const load = congelar({ [CONTA]: [CAMISETAS, CALCAS], [IRMA]: [COPIA] });

    const desfeito = marcarRemocao(marcarRemocao(load, CONTA, 0, true), CONTA, 0, false);

    expect(valuesEqual(desfeito, load)).toBe(true);
    expect(Object.keys((desfeito[CONTA] as Record<string, unknown>[])[0] ?? {})).not.toContain(
      DELETE_MARK,
    );
  });

  it('undoing a mark-free element returns `mapa` itself', () => {
    const mapa = { [CONTA]: [CAMISETAS] };
    expect(marcarRemocao(mapa, CONTA, 0, false)).toBe(mapa);
  });

  it('an unreadable OBJECT can be marked, and the save drops it (R-h)', () => {
    const r = marcarRemocao({ [CONTA]: [{ size_chart_id: 1 }, CAMISETAS] }, CONTA, 0, true);

    expect(linhasDaConta(r, CONTA).linhas[0]?.papel).toBe(PAPEL_DA_LINHA.seraRemovida);
    expect(prepararTabelasShopeeParaSalvar(r)).toEqual({ [CONTA]: [CAMISETAS] });
  });

  it('a non-object element, an index out of range, or no list → `mapa` unchanged', () => {
    const mapa = { [CONTA]: [null, CAMISETAS] };
    expect(marcarRemocao(mapa, CONTA, 0, true)).toBe(mapa);
    expect(marcarRemocao(mapa, CONTA, 5, true)).toBe(mapa);
    expect(marcarRemocao(mapa, CONTA, -1, true)).toBe(mapa);
    expect(marcarRemocao(null, CONTA, 0, true)).toBe(null);
  });
});

describe('prepararTabelasShopeeParaSalvar — the field’s prepareForSave', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [CAMISETAS]],
    ['a string', 'x'],
  ])('a non-object field (%s) is returned as is', (_nome, valor) => {
    expect(prepararTabelasShopeeParaSalvar(valor)).toBe(valor);
  });

  it('⭐ M66: drops the marked, strips the marker, and keeps every other value VERBATIM', () => {
    const ilegivel = { size_chart_id: 1 };
    const invalida = { 0: CALCAS };
    const valor = congelar({
      [CONTA]: [marcada(CAMISETAS), COPIA, ilegivel, null, 'x'],
      [IRMA]: invalida,
      nula: null,
    });

    const salvo = prepararTabelasShopeeParaSalvar(valor) as Record<string, unknown>;

    expect(salvo).toEqual({
      [CONTA]: [COPIA, ilegivel, null, 'x'],
      [IRMA]: invalida,
      nula: null,
    });
    expect((salvo[CONTA] as unknown[])[1]).toBe(ilegivel);
    expect(salvo[IRMA]).toBe(invalida);
    expect(JSON.stringify(salvo)).not.toContain(DELETE_MARK);
  });
});

describe('RT5 — load → add → prepareForSave keeps everything but the new pick', () => {
  it('every element and key but the new one is `valuesEqual` to the load', () => {
    const ilegivel = { size_chart_id: 1 };
    const load = congelar({
      [CONTA]: [CAMISETAS, ilegivel],
      [IRMA]: [CALCAS],
      'int-3': null,
    });

    const salvo = prepararTabelasShopeeParaSalvar(
      adicionarOuSubstituir(load, CONTA, CALCAS, { tipo: 'adicionar' }),
    ) as Record<string, unknown>;

    expect(Object.keys(salvo).sort()).toEqual([CONTA, IRMA, 'int-3'].sort());
    expect(valuesEqual(salvo[IRMA], load[IRMA])).toBe(true);
    expect(salvo['int-3']).toBeNull();
    const lista = salvo[CONTA] as unknown[];
    expect(lista).toHaveLength(3);
    expect(valuesEqual(lista[0], CAMISETAS)).toBe(true);
    expect(lista[1]).toBe(ilegivel);
    expect(lista[2]).toEqual(CALCAS);
  });

  it('a `__proto__` conta id stays OWN data through every step — never the prototype', () => {
    const chave = '__proto__';

    const adicionado = adicionarOuSubstituir({}, chave, CAMISETAS, { tipo: 'adicionar' });
    const salvo = prepararTabelasShopeeParaSalvar(adicionado) as Record<string, unknown>;

    expect(Object.hasOwn(salvo, chave)).toBe(true);
    expect(Object.getPrototypeOf(salvo)).toBe(Object.prototype);
    expect(linhasDaConta(salvo, chave).linhas[0]?.papel).toBe(PAPEL_DA_LINHA.usada);
  });
});

describe('entradasDeContasAusentes — what sits under contas that no longer exist', () => {
  it('counts the elements under keys outside `contaIds`; a per-key null counts nothing, a non-array counts one', () => {
    const mapa = {
      [CONTA]: [CAMISETAS, COPIA],
      [IRMA]: [CALCAS, null],
      'int-10': { 0: CALCAS },
      'int-3': null,
    };

    expect(entradasDeContasAusentes(mapa, new Set([CONTA]))).toBe(3);
    expect(entradasDeContasAusentes(mapa, new Set([CONTA, IRMA, 'int-10']))).toBe(0);
  });

  it('NEAR-MISS: `int-10` is not `int-1` — its entries are orphans', () => {
    expect(entradasDeContasAusentes({ 'int-10': [CAMISETAS] }, new Set([CONTA]))).toBe(1);
  });

  it('a non-object field counts nothing', () => {
    expect(entradasDeContasAusentes(null, new Set())).toBe(0);
    expect(entradasDeContasAusentes([CAMISETAS], new Set())).toBe(0);
  });
});

describe('indiceAtivoDaCategoria — THE "active" filter, shared with the modal (R2-F7)', () => {
  it('the raw index of the first row that SURVIVES the save — a marked and an unreadable row are skipped', () => {
    const { linhas } = linhasDaConta(
      { [CONTA]: [marcada(CAMISETAS), { size_chart_id: 1 }, COPIA, CALCAS] },
      CONTA,
    );

    expect(indiceAtivoDaCategoria(linhas, 100087)).toBe(2);
    expect(indiceAtivoDaCategoria(linhas, 400055)).toBe(3);
    // NEAR-MISS: the neighbouring category id (±1) has no row.
    expect(indiceAtivoDaCategoria(linhas, 100088)).toBe(-1);
    expect(indiceAtivoDaCategoria(linhas, 100086)).toBe(-1);
  });

  it('agrees with the roles: the row it returns is exactly the one `linhasDaConta` calls `usada`', () => {
    const valor = marcarRemocao({ [CONTA]: [CAMISETAS, COPIA, CALCAS, COPIA] }, CONTA, 0, true);
    const { linhas } = linhasDaConta(valor, CONTA);

    for (const categoryId of [100087, 400055]) {
      const usadas = linhas
        .filter((l) => l.papel === PAPEL_DA_LINHA.usada && l.entrada?.categoryId === categoryId)
        .map((l) => l.indice);
      expect(usadas).toEqual([indiceAtivoDaCategoria(linhas, categoryId)]);
    }
  });

  it('`exceto` leaves out EXACTLY that raw index — the row a "Trocar" is about to replace', () => {
    const { linhas } = linhasDaConta({ [CONTA]: [CAMISETAS, CALCAS, COPIA] }, CONTA);

    expect(indiceAtivoDaCategoria(linhas, 100087, { exceto: 0 })).toBe(2);
    expect(indiceAtivoDaCategoria(linhas, 100087, { exceto: 2 })).toBe(0);
    // NEAR-MISS: leaving out a neighbouring index changes nothing.
    expect(indiceAtivoDaCategoria(linhas, 100087, { exceto: 1 })).toBe(0);
    // The only row of its category, left out → no OTHER row covers it.
    expect(indiceAtivoDaCategoria(linhas, 400055, { exceto: 1 })).toBe(-1);
  });

  it('what the modal warns about: a "Trocar" into a category ANOTHER row covers leaves the EARLIER one in force', () => {
    // Row 1 (Calças) swapped into Camisetas, which row 0 already covers.
    const depois = adicionarOuSubstituir({ [CONTA]: [CAMISETAS, CALCAS] }, CONTA, COPIA, {
      tipo: 'trocar',
      indice: 1,
    });
    expect(linhasDaConta(depois, CONTA).linhas.map((l) => l.papel)).toEqual([
      PAPEL_DA_LINHA.usada,
      PAPEL_DA_LINHA.ignoradaDuplicada,
    ]);
    // Row 0 swapped into Calças, which row 1 covers: row 0 wins, the LATER row is demoted.
    const antes = adicionarOuSubstituir(
      { [CONTA]: [CAMISETAS, CALCAS] },
      CONTA,
      { ...CALCAS, size_chart_id: 700024605 },
      { tipo: 'trocar', indice: 0 },
    );
    expect(linhasDaConta(antes, CONTA).linhas.map((l) => l.papel)).toEqual([
      PAPEL_DA_LINHA.usada,
      PAPEL_DA_LINHA.ignoradaDuplicada,
    ]);
  });
});
