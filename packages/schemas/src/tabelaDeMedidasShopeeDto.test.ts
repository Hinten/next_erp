import { describe, expect, it } from 'vitest';

import * as barrel from './index';
import {
  type ListaTabelasMedidasDto,
  detalheTabelaMedidasDtoSchema,
  listaTabelasMedidasDtoSchema,
  tabelaMedidasLinhaDtoSchema,
} from './tabelaDeMedidasShopeeDto';
import {
  type DetalheTabelaShopeeEntrada,
  projetarTabelaShopee,
  tabelaShopeeProjetadaSchema,
} from './tabelaDeMedidasShopeeProjecao';

/**
 * The size-chart route ENVELOPES (Shopee step 18, #1526), declared once for
 * `apps/shopee` (which builds them) and `apps/web` (which parses them). What is
 * pinned here is the CONTRACT both sides now share: the exact key sets (R-a),
 * strict numbers (our own answers), every field required, and unknown keys
 * stripped (R-b — the two apps deploy separately).
 *
 * ⚠️ Every "accepts X" below is worthless alone — `z.any()` passes it. The
 * near-miss rows (one key missing, one number quoted) are the controls.
 */

/** Shopee's doc-sample id — a published sample, never a real shop's template. */
const ID_DO_EXEMPLO = 700024639;

/** A one-column chart — enough to fill `tabela`; the projector's own suite owns the rest. */
const DETALHE_MINIMO: DetalheTabelaShopeeEntrada = {
  size_chart_id: ID_DO_EXEMPLO,
  size_chart_name: 'testtestt',
  size_chart_table: {
    column_list: [
      {
        measurement: { display_name: 'Busto', input_type: 'Input Single Number', unit: 'cm' },
        measurement_value_list: [{ option: null, value: 90, min_value: null, max_value: null }],
      },
    ],
  },
};

function lista(
  sobre: Partial<Record<keyof ListaTabelasMedidasDto, unknown>> = {},
): Record<string, unknown> {
  return {
    leaf: true,
    categoryId: 400055,
    tabelas: [
      { sizeChartId: 700024641, sizeChartName: 'Básica', legivel: true },
      { sizeChartId: 700024613, sizeChartName: null, legivel: false },
    ],
    totalCount: 2,
    truncado: false,
    removidas: 0,
    idsIlegiveis: 0,
    ...sobre,
  };
}

describe('the barrel exposes THESE instances — one declaration, no copy', () => {
  it('index.ts re-exports the same three schema objects', () => {
    expect(barrel.tabelaMedidasLinhaDtoSchema).toBe(tabelaMedidasLinhaDtoSchema);
    expect(barrel.listaTabelasMedidasDtoSchema).toBe(listaTabelasMedidasDtoSchema);
    expect(barrel.detalheTabelaMedidasDtoSchema).toBe(detalheTabelaMedidasDtoSchema);
  });
});

describe('listaTabelasMedidasDtoSchema — the list answer', () => {
  it('accepts a complete answer and hands it back equal', () => {
    expect(listaTabelasMedidasDtoSchema.parse(lista())).toEqual(lista());
  });

  it('the keys are EXACTLY the seam’s seven (R-a) — none translated, none extra', () => {
    expect(Object.keys(listaTabelasMedidasDtoSchema.shape).sort()).toEqual(
      [
        'categoryId',
        'idsIlegiveis',
        'leaf',
        'removidas',
        'tabelas',
        'totalCount',
        'truncado',
      ].sort(),
    );
    expect(Object.keys(tabelaMedidasLinhaDtoSchema.shape).sort()).toEqual([
      'legivel',
      'sizeChartId',
      'sizeChartName',
    ]);
  });

  it('totalCount null is a valid answer (Shopee did not say); a non-leaf answers the same shape, empty', () => {
    expect(listaTabelasMedidasDtoSchema.safeParse(lista({ totalCount: null })).success).toBe(true);
    const naoFolha = lista({ leaf: false, tabelas: [], totalCount: null });
    expect(listaTabelasMedidasDtoSchema.safeParse(naoFolha).success).toBe(true);
  });

  it('R-b: an unknown key is STRIPPED — on the envelope and on a row — never a failure', () => {
    const corpo = {
      ...lista({
        tabelas: [{ sizeChartId: 700024641, sizeChartName: 'Básica', legivel: true, novo: 1 }],
      }),
      chaveDeUmaRotaMaisNova: 'x',
    };
    expect(listaTabelasMedidasDtoSchema.parse(corpo)).toEqual(
      lista({ tabelas: [{ sizeChartId: 700024641, sizeChartName: 'Básica', legivel: true }] }),
    );
  });

  // Plain `z.number()`: our OWN answer — a string here is our serialisation bug.
  it.each<[string, unknown]>([
    ['a QUOTED sizeChartId', [{ sizeChartId: '700024641', sizeChartName: null, legivel: true }]],
    ['a fractional sizeChartId', [{ sizeChartId: 1.5, sizeChartName: null, legivel: true }]],
    ['no legivel', [{ sizeChartId: 700024641, sizeChartName: null }]],
    ['no sizeChartName (null is the empty value)', [{ sizeChartId: 700024641, legivel: true }]],
  ])('NEAR-MISS: refuses a row with %s', (_, tabelas) => {
    expect(listaTabelasMedidasDtoSchema.safeParse(lista({ tabelas })).success).toBe(false);
  });

  it.each<[string, Partial<Record<keyof ListaTabelasMedidasDto, unknown>>]>([
    ['no leaf', { leaf: undefined }],
    ['no truncado — never read as "complete"', { truncado: undefined }],
    ['no tabelas', { tabelas: undefined }],
    ['a quoted categoryId', { categoryId: '400055' }],
    ['a quoted totalCount', { totalCount: '3' }],
    ['a fractional removidas', { removidas: 0.5 }],
    ['no idsIlegiveis', { idsIlegiveis: undefined }],
    ['truncado as a number', { truncado: 0 }],
  ])('NEAR-MISS: refuses an answer with %s', (_, sobre) => {
    expect(listaTabelasMedidasDtoSchema.safeParse(lista(sobre)).success).toBe(false);
  });
});

describe('detalheTabelaMedidasDtoSchema — the detail answer', () => {
  it('its table IS the projector’s output schema — never a mirror', () => {
    expect(detalheTabelaMedidasDtoSchema.shape.tabela).toBe(tabelaShopeeProjetadaSchema);
    expect(Object.keys(detalheTabelaMedidasDtoSchema.shape)).toEqual(['tabela']);
  });

  it('the real projector’s output, through JSON, nested WHOLE under `tabela`, parses back equal', () => {
    const tabela = projetarTabelaShopee(ID_DO_EXEMPLO, DETALHE_MINIMO);
    const corpo = JSON.parse(JSON.stringify({ tabela })) as unknown;
    expect(detalheTabelaMedidasDtoSchema.parse(corpo)).toEqual({ tabela });
  });

  it('NEAR-MISS: the table SPREAD into the envelope is refused (the body is built by name)', () => {
    const tabela = projetarTabelaShopee(ID_DO_EXEMPLO, DETALHE_MINIMO);
    expect(detalheTabelaMedidasDtoSchema.safeParse({ ...tabela }).success).toBe(false);
  });

  it('NEAR-MISS: a table without `problemas` is refused (the problem list is part of the contract)', () => {
    const tabela = projetarTabelaShopee(ID_DO_EXEMPLO, DETALHE_MINIMO);
    const { problemas: _problemas, ...semProblemas } = tabela;
    expect(detalheTabelaMedidasDtoSchema.safeParse({ tabela: semProblemas }).success).toBe(false);
  });
});
