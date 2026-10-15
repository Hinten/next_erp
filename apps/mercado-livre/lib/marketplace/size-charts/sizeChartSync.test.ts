import { describe, expect, it } from 'vitest';
import type { MlSizeChart } from '@delfrance/schemas';

import {
  cellAttributeIds,
  chartAttributeToMercadoLivre,
  chartCreatePayload,
  chartRowPayload,
  resolveErrorRowIndex,
} from './sizeChartSync';

/* ------------------------------- fixtures -------------------------------- */

const novaChart: MlSizeChart = {
  id: null,
  nome: 'Camisetas ML',
  domain_id: 'MLB-T_SHIRTS',
  tipo: 'CLOTHING_MEASURE',
  attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
  main_attribute: [],
  rows: [
    {
      varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-m',
      id: null,
      attributes: [
        { id: 'SIZE', value_name: 'M' },
        { id: 'CHEST_CIRCUMFERENCE_FROM', value_name: '90', unit_id: 'cm' },
      ],
    },
    {
      varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-g',
      id: null,
      attributes: [{ id: 'SIZE', value_name: 'G' }],
    },
  ],
};

/* ------------------------------ pure builders ---------------------------- */

describe('chartAttributeToMercadoLivre', () => {
  it('folds the unit into the value name (legacy "62 cm") and adds ML\'s struct', () => {
    expect(chartAttributeToMercadoLivre({ id: 'WAIST', value_name: '62', unit_id: 'cm' })).toEqual({
      id: 'WAIST',
      values: [{ name: '62 cm', struct: { number: 62, unit: 'cm' } }],
    });
  });

  it('parses a pt-BR decimal into the struct', () => {
    expect(
      chartAttributeToMercadoLivre({ id: 'WAIST', value_name: '62,5', unit_id: 'cm' }),
    ).toEqual({
      id: 'WAIST',
      values: [{ name: '62,5 cm', struct: { number: 62.5, unit: 'cm' } }],
    });
  });

  it('omits the struct when the value is not numeric (a size label keeps only its name)', () => {
    expect(chartAttributeToMercadoLivre({ id: 'SIZE', value_name: 'M', unit_id: 'BR' })).toEqual({
      id: 'SIZE',
      values: [{ name: 'M BR' }],
    });
  });

  it('omits the struct when the attribute carries no unit', () => {
    expect(chartAttributeToMercadoLivre({ id: 'SIZE', value_name: '42' })).toEqual({
      id: 'SIZE',
      values: [{ name: '42' }],
    });
  });

  it('keeps value_id and omits absent parts', () => {
    expect(chartAttributeToMercadoLivre({ id: 'GENDER', value_id: '339665' })).toEqual({
      id: 'GENDER',
      values: [{ id: '339665' }],
    });
  });

  it('valueList produces one entry per item, unit folded per item', () => {
    expect(
      chartAttributeToMercadoLivre({
        id: 'FILTRABLE_SIZE',
        unit_id: 'cm',
        valueList: [{ value_name: '38' }, { value_id: 'x', value_name: '40' }],
      } as never),
    ).toEqual({
      id: 'FILTRABLE_SIZE',
      values: [
        { name: '38 cm', struct: { number: 38, unit: 'cm' } },
        { id: 'x', name: '40 cm', struct: { number: 40, unit: 'cm' } },
      ],
    });
  });
});

describe('chartCreatePayload', () => {
  it('builds the legacy POST /catalog/charts body (domain suffix, SIZE main-attr fallback)', () => {
    const payload = chartCreatePayload(novaChart);
    expect(payload).toMatchObject({
      names: { MLB: 'Camisetas ML' },
      domain_id: 'T_SHIRTS',
      site_id: 'MLB',
      measure_type: 'CLOTHING_MEASURE',
      attributes: [{ id: 'GENDER', values: [{ id: '339665', name: 'Feminino' }] }],
    });
    // No valued main_attribute → synthetic SIZE from the rows, every value
    // normalized through the shared mapper (flat {id?, name?} entries).
    expect(payload.main_attribute).toEqual({
      attributes: [
        {
          site_id: 'MLB',
          id: 'SIZE',
          values: [{ name: 'M' }, { name: 'G' }],
        },
      ],
    });
    const rows = payload.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.attributes).toEqual([
      { id: 'SIZE', values: [{ name: 'M' }] },
      {
        id: 'CHEST_CIRCUMFERENCE_FROM',
        values: [{ name: '90 cm', struct: { number: 90, unit: 'cm' } }],
      },
    ]);
  });

  it('omits measure_type when tipo is absent', () => {
    expect(chartCreatePayload({ ...novaChart, tipo: null })).not.toHaveProperty('measure_type');
  });

  it('strips ONLY the site prefix from a multi-dash domain id', () => {
    const payload = chartCreatePayload({ ...novaChart, domain_id: 'MLB-BABY-CAR' });
    expect(payload.domain_id).toBe('BABY-CAR');
    expect(payload.site_id).toBe('MLB');
  });

  it('SIZE fallback flattens valueList entries into normalized {id, name} values', () => {
    const payload = chartCreatePayload({
      ...novaChart,
      rows: [
        {
          varianteUid: null,
          id: null,
          attributes: [
            {
              id: 'SIZE',
              valueList: [{ value_id: 's1', value_name: '38' }, { value_name: '40' }],
            } as never,
          ],
        },
      ],
    });
    const main = payload.main_attribute as { attributes: Array<Record<string, unknown>> };
    expect(main.attributes[0]!.values).toEqual([{ id: 's1', name: '38' }, { name: '40' }]);
  });

  it('an explicit main_attribute_id wins over the SIZE fallback, as a bare {site_id,id}', () => {
    // A footwear chart: no SIZE column anywhere, so the legacy fallback could
    // never build a valid body for it.
    const calcados: MlSizeChart = {
      ...novaChart,
      domain_id: 'MLB-SNEAKERS',
      main_attribute_id: 'EU_SIZE',
      rows: [
        {
          varianteUid: null,
          id: null,
          attributes: [{ id: 'EU_SIZE', value_name: '40', unit_id: 'EU' }],
        },
      ],
    };
    expect(chartCreatePayload(calcados).main_attribute).toEqual({
      attributes: [{ site_id: 'MLB', id: 'EU_SIZE' }],
    });
  });

  it('a VALUED main_attribute still outranks main_attribute_id', () => {
    const payload = chartCreatePayload({
      ...novaChart,
      main_attribute_id: 'EU_SIZE',
      main_attribute: [{ id: 'MANUFACTURER_SIZE', value_name: '40' }],
    });
    expect(payload.main_attribute).toEqual({
      attributes: [{ site_id: 'MLB', id: 'MANUFACTURER_SIZE', values: [{ name: '40' }] }],
    });
  });
});

describe('chartRowPayload', () => {
  const chart: MlSizeChart = { ...novaChart, id: '1594439', main_attribute_id: 'SIZE' };
  const row = {
    varianteUid: null,
    id: '1594439:1',
    attributes: [
      { id: 'SIZE', value_name: 'M' },
      { id: 'WAIST', value_name: '62', unit_id: 'cm' },
    ],
  };

  it('row UPDATE excludes the main attribute (immutable on ML)', () => {
    expect(chartRowPayload(chart, row)).toEqual({
      sites: ['MLB'],
      attributes: [
        { id: 'WAIST', values: [{ name: '62 cm', struct: { number: 62, unit: 'cm' } }] },
      ],
    });
  });

  it('NEW row (no ML id) includes the main attribute', () => {
    const attrs = chartRowPayload(chart, { ...row, id: null }).attributes as unknown[];
    expect(attrs).toHaveLength(2);
  });
});

describe('cellAttributeIds', () => {
  it('splits a combined column id, as the legacy error mapper did', () => {
    expect(cellAttributeIds('CHEST_CIRCUMFERENCE_FROM - CHEST_CIRCUMFERENCE_TO')).toEqual([
      'CHEST_CIRCUMFERENCE_FROM',
      'CHEST_CIRCUMFERENCE_TO',
    ]);
  });

  it('a plain id yields one entry, an absent one yields none', () => {
    expect(cellAttributeIds('WAIST')).toEqual(['WAIST']);
    expect(cellAttributeIds(null)).toEqual([]);
    expect(cellAttributeIds(undefined)).toEqual([]);
  });
});

describe('resolveErrorRowIndex', () => {
  const chart: MlSizeChart = {
    ...novaChart,
    id: '1594439',
    main_attribute_id: 'SIZE',
    rows: [
      { varianteUid: null, id: '1594439:1', attributes: [{ id: 'SIZE', value_name: 'M' }] },
      { varianteUid: null, id: '1594439:2', attributes: [{ id: 'SIZE', value_name: 'G' }] },
    ],
  };

  it('matches on the main-attribute VALUE — the only key ML gives on a create', () => {
    expect(
      resolveErrorRowIndex(chart, {
        attribute_id: 'WAIST',
        row: { id: null, main_attribute: { id: 'SIZE', value: 'G' } },
      }),
    ).toBe(1);
  });

  it('matches a list-valued main attribute on value_id too (legacy accepted either)', () => {
    const porId: MlSizeChart = {
      ...chart,
      rows: [{ varianteUid: null, id: 'x:1', attributes: [{ id: 'SIZE', value_id: '3189130' }] }],
    };
    expect(
      resolveErrorRowIndex(porId, {
        row: { id: null, main_attribute: { id: 'SIZE', value: '3189130' } },
      }),
    ).toBe(0);
  });

  it('prefers a row id, bare or full', () => {
    expect(resolveErrorRowIndex(chart, { row: { id: '1594439:2' } })).toBe(1);
    expect(resolveErrorRowIndex(chart, { row: { id: '2' } })).toBe(1);
  });

  it('is null when nothing matches, so the editor never blames the wrong cell', () => {
    expect(resolveErrorRowIndex(chart, null)).toBeNull();
    expect(
      resolveErrorRowIndex(chart, { row: { main_attribute: { id: 'SIZE', value: 'GG' } } }),
    ).toBeNull();
    expect(resolveErrorRowIndex(chart, { attribute_id: 'WAIST' })).toBeNull();
  });
});

/* ------------------------------ orchestrator ----------------------------- */
