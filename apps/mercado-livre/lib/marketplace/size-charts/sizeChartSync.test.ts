import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import type { MlSizeChart } from '@delfrance/schemas';

import {
  TabelaDeMedidasNotFoundError,
  applyChartResponse,
  cellAttributeIds,
  chartAttributeToMercadoLivre,
  chartCreatePayload,
  chartRowPayload,
  deepEqual,
  resolveErrorRowIndex,
  syncSizeCharts,
} from './sizeChartSync';

/* ----------------------------- fake Firestore ---------------------------- */

type DocData = Record<string, unknown>;

/** `set(…, {merge: true})` deep-merges maps — the conta-key preservation relies on it. */
function deepMergeInto(target: DocData, patch: DocData): DocData {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (
      v &&
      cur &&
      typeof v === 'object' &&
      typeof cur === 'object' &&
      !Array.isArray(v) &&
      !Array.isArray(cur)
    ) {
      out[k] = deepMergeInto(cur as DocData, v as DocData);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) {
      c = new Map();
      this.cols.set(path, c);
    }
    return c;
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }

  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  collection(path: string) {
    const col = this.col(path);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? deepMergeInto(col.get(id) ?? {}, data) : { ...data });
        },
      }),
    };
  }
}

/* ------------------------------- fixtures -------------------------------- */

const CONTA = 'conta-1';
const TAB = 'tm-1';

const CHART_RESPONSE = {
  id: '1594439',
  main_attribute_id: 'SIZE',
  rows: [{ id: '1594439:1' }, { id: '1594439:2' }],
};

function makeApi(overrides: Partial<Record<string, unknown>> = {}) {
  const mocks = {
    createSizeChart: vi.fn(async () => CHART_RESPONSE),
    updateSizeChartName: vi.fn(async () => CHART_RESPONSE),
    addSizeChartRow: vi.fn(async () => CHART_RESPONSE),
    updateSizeChartRow: vi.fn(async () => CHART_RESPONSE),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as MercadoLivreApi, mocks };
}

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

function seedDoc(db: FakeDb, tabelas: unknown[]): void {
  db.seed('tabMedi', TAB, {
    nome: 'Tabela camisetas',
    codigo: null,
    descricao: null,
    tabelasDeMedidasMercadoLivre: {
      [CONTA]: { tabelas },
      'outra-conta': { tabelas: [{ id: '999', nome: 'Outra', domain_id: 'MLB-PANTS' }] },
    },
    tabelasMedidasShopee: { 'conta-shopee': [{ size_chart_id: 1 }] },
  });
}

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

describe('applyChartResponse', () => {
  it('writes back chart id, main_attribute_id and per-INDEX row ids', () => {
    const updated = applyChartResponse(novaChart, CHART_RESPONSE);
    expect(updated.id).toBe('1594439');
    expect(updated.main_attribute_id).toBe('SIZE');
    expect(updated.rows![0]!.id).toBe('1594439:1');
    expect(updated.rows![1]!.id).toBe('1594439:2');
  });

  it('extra local rows (beyond the response) keep their state', () => {
    const updated = applyChartResponse(novaChart, { ...CHART_RESPONSE, rows: [{ id: 'X:1' }] });
    expect(updated.rows![0]!.id).toBe('X:1');
    expect(updated.rows![1]!.id).toBeNull();
  });

  it("caches ML's COMPUTED row SIZE as sizeCalculado, outside attributes", () => {
    // A footwear chart: the row was sent with EU_SIZE only, and ML answers with
    // the SIZE it derived — the value the listing's variation must match.
    const calcados: MlSizeChart = {
      ...novaChart,
      main_attribute_id: 'EU_SIZE',
      rows: [{ varianteUid: null, id: null, attributes: [{ id: 'EU_SIZE', value_name: '40' }] }],
    };
    const updated = applyChartResponse(calcados, {
      id: '999',
      main_attribute_id: 'EU_SIZE',
      rows: [
        {
          id: '999:1',
          attributes: [
            { id: 'SIZE', name: 'Tamanho', values: [{ name: '8,5 US' }] },
            { id: 'EU_SIZE', name: 'EU', values: [{ name: '40 EU' }] },
          ],
        },
      ],
    });
    expect(updated.rows![0]!.sizeCalculado).toEqual({
      id: 'SIZE',
      value_id: null,
      value_name: '8,5 US',
    });
    // ⚠️ It must NOT reach `attributes`: everything valued there is re-sent on
    // the next row PUT, and ML rejects a computed attribute in a row body.
    expect(updated.rows![0]!.attributes).toEqual([{ id: 'EU_SIZE', value_name: '40' }]);
    // No unit_id either, or the next send would append the unit twice.
    expect(updated.rows![0]!.sizeCalculado).not.toHaveProperty('unit_id');
  });

  it('leaves sizeCalculado alone when the response row carries no SIZE', () => {
    const updated = applyChartResponse(novaChart, CHART_RESPONSE);
    expect(updated.rows![0]!.sizeCalculado).toBeUndefined();
  });
});

describe('deepEqual', () => {
  it('structural equality on JSON data', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
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

describe('syncSizeCharts', () => {
  it('creates a new chart and merges ONLY this conta (others + Shopee survive)', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api, mocks } = makeApi();

    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [novaChart],
    );

    expect(mocks.createSizeChart).toHaveBeenCalledOnce();
    expect(result.updated).toBe(true);
    expect(result.validationErrors).toEqual([]);
    expect(result.tabelas[0]!.id).toBe('1594439');
    expect(result.tabelas[0]!.rows![0]!.id).toBe('1594439:1');

    const doc = db.docs('tabMedi').get(TAB)!;
    const map = doc.tabelasDeMedidasMercadoLivre as Record<string, { tabelas: MlSizeChart[] }>;
    expect(map[CONTA]!.tabelas[0]!.id).toBe('1594439');
    // Deep merge preserved the other conta and the Shopee map.
    expect(map['outra-conta']!.tabelas[0]!.id).toBe('999');
    expect(doc.tabelasMedidasShopee).toEqual({ 'conta-shopee': [{ size_chart_id: 1 }] });
  });

  it('name change → PUT name; unchanged charts make no ML calls and no write', async () => {
    // Fully in-sync fixture: the chart AND every row already carry ML ids —
    // an id-less row would (correctly) always re-send.
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: novaChart.rows!.map((r, i) => ({ ...r, id: `1594439:${i + 1}` })),
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    // Unchanged → nothing happens.
    const same = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [stored],
    );
    expect(same.updated).toBe(false);
    expect(mocks.updateSizeChartName).not.toHaveBeenCalled();

    // Renamed → PUT name only.
    const renamed = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [{ ...stored, nome: 'Novo nome' }],
    );
    expect(mocks.updateSizeChartName).toHaveBeenCalledWith('1594439', { MLB: 'Novo nome' });
    expect(renamed.updated).toBe(true);
  });

  it('row diffs: changed row with id → PUT row; new row → POST row; unchanged skipped', async () => {
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: [
        {
          varianteUid: 'documents/g/variacoes/v-m',
          id: '1594439:1',
          attributes: [{ id: 'SIZE', value_name: 'M' }],
        },
        {
          varianteUid: 'documents/g/variacoes/v-g',
          id: '1594439:2',
          attributes: [{ id: 'SIZE', value_name: 'G' }],
        },
      ],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    const edited: MlSizeChart = {
      ...stored,
      rows: [
        // row 0 changed (new measurement attr) — PUT
        {
          ...stored.rows![0]!,
          attributes: [
            ...stored.rows![0]!.attributes!,
            { id: 'WAIST', value_name: '62', unit_id: 'cm' },
          ],
        },
        // row 1 unchanged — skipped
        stored.rows![1]!,
        // row 2 brand new — POST
        {
          varianteUid: 'documents/g/variacoes/v-gg',
          id: null,
          attributes: [{ id: 'SIZE', value_name: 'GG' }],
        },
      ],
    };

    await syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
      edited,
    ]);

    expect(mocks.updateSizeChartRow!).toHaveBeenCalledTimes(1);
    expect(mocks.updateSizeChartRow!.mock.calls[0]![0]).toBe('1594439');
    expect(mocks.updateSizeChartRow!.mock.calls[0]![1]).toBe('1594439:1');
    // The update payload excludes the SIZE main attribute.
    expect(mocks.updateSizeChartRow!.mock.calls[0]![2]).toEqual({
      sites: ['MLB'],
      attributes: [
        { id: 'WAIST', values: [{ name: '62 cm', struct: { number: 62, unit: 'cm' } }] },
      ],
    });
    expect(mocks.addSizeChartRow).toHaveBeenCalledTimes(1);
  });

  it('an ML chart-validation error is collected, keeps the chart, and does not abort', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api, mocks } = makeApi({
      createSizeChart: vi
        .fn()
        .mockRejectedValueOnce(
          new MercadoLivreHttpError('chart validation', 400, {
            error: 'chart_validation_error',
            errors: [{ code: 'chart_name_unavailable', message: 'name in use' }],
          }),
        )
        .mockResolvedValueOnce({ ...CHART_RESPONSE, id: '777' }),
    });

    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [novaChart, { ...novaChart, nome: 'Segunda' }],
    );

    expect(mocks.createSizeChart).toHaveBeenCalledTimes(2); // continued past the failure
    // No `cell` → a CHART-level problem: no row, no attribute to point at.
    expect(result.validationErrors).toEqual([
      {
        chartIndex: 0,
        code: 'chart_name_unavailable',
        message: 'name in use',
        rowIndex: null,
        attributeIds: [],
        rowMainValue: null,
      },
    ]);
    expect(result.tabelas[0]!.id).toBeNull(); // failed chart kept as-was
    expect(result.tabelas[1]!.id).toBe('777');
    expect(result.updated).toBe(true); // the second chart landed → write happened
  });

  it('a per-cell rejection on CREATE resolves the row from the main-attribute value', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api } = makeApi({
      createSizeChart: vi.fn(async () => {
        throw new MercadoLivreHttpError('chart validation', 400, {
          error: 'chart_validation_error',
          errors: [
            {
              code: 'duplicated_measure_value',
              message: 'Duplicated measure in attribute CHEST_CIRCUMFERENCE_FROM.',
              cell: {
                attribute_id: 'CHEST_CIRCUMFERENCE_FROM - CHEST_CIRCUMFERENCE_TO',
                // ML sends a null row id on a create — the value is the key.
                row: { id: null, main_attribute: { id: 'SIZE', value: 'G' } },
              },
            },
          ],
        });
      }),
    });

    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [novaChart],
    );

    expect(result.validationErrors).toEqual([
      {
        chartIndex: 0,
        code: 'duplicated_measure_value',
        message: 'Duplicated measure in attribute CHEST_CIRCUMFERENCE_FROM.',
        rowIndex: 1, // the 'G' row
        attributeIds: ['CHEST_CIRCUMFERENCE_FROM', 'CHEST_CIRCUMFERENCE_TO'],
        rowMainValue: 'G',
      },
    ]);
  });

  it('a rejection from a ROW endpoint is pinned to the row being sent', async () => {
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: [
        { varianteUid: null, id: '1594439:1', attributes: [{ id: 'SIZE', value_name: 'M' }] },
        { varianteUid: null, id: '1594439:2', attributes: [{ id: 'SIZE', value_name: 'G' }] },
      ],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api } = makeApi({
      updateSizeChartRow: vi.fn(async () => {
        throw new MercadoLivreHttpError('chart validation', 400, {
          // No `cell` at all — the endpoint itself identifies the row.
          errors: [{ code: 'value_out_of_range', message: 'out of range' }],
        });
      }),
    });

    const edited: MlSizeChart = {
      ...stored,
      rows: [
        stored.rows![0]!,
        {
          ...stored.rows![1]!,
          attributes: [
            { id: 'SIZE', value_name: 'G' },
            { id: 'WAIST', value_name: '9999', unit_id: 'cm' },
          ],
        },
      ],
    };
    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [edited],
    );

    expect(result.validationErrors).toEqual([
      {
        chartIndex: 0,
        code: 'value_out_of_range',
        message: 'out of range',
        rowIndex: 1,
        attributeIds: [],
        rowMainValue: null,
      },
    ]);
  });

  it('a rejected rename reverts the nome and skips that chart´s rows', async () => {
    const stored: MlSizeChart = { ...novaChart, id: '1594439', main_attribute_id: 'SIZE' };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi({
      updateSizeChartName: vi.fn(async () => {
        throw new MercadoLivreHttpError('chart validation', 400, {
          errors: [{ code: 'chart_name_unavailable', message: 'in use' }],
        });
      }),
    });

    const edited: MlSizeChart = {
      ...stored,
      nome: 'Nome novo',
      rows: [{ varianteUid: null, id: null, attributes: [{ id: 'SIZE', value_name: 'XG' }] }],
    };
    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [edited],
    );

    expect(result.tabelas[0]!.nome).toBe('Camisetas ML'); // reverted
    expect(mocks.addSizeChartRow).not.toHaveBeenCalled(); // rows skipped
    expect(result.validationErrors).toHaveLength(1);
    expect(result.updated).toBe(false);
  });

  it('non-validation ML errors (5xx) rethrow', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api } = makeApi({
      createSizeChart: vi.fn(async () => {
        throw new MercadoLivreHttpError('boom', 500, { errors: [{ code: 'x' }] });
      }),
    });

    await expect(
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
        novaChart,
      ]),
    ).rejects.toThrow('boom');
  });

  it('a 429 carrying an errors array is NOT read as chart validation — it aborts', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api } = makeApi({
      createSizeChart: vi.fn(async () => {
        throw new MercadoLivreHttpError('rate limited', 429, {
          errors: [{ code: 'too_many_requests', message: 'slow down' }],
        });
      }),
    });

    await expect(
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
        novaChart,
      ]),
    ).rejects.toThrow('rate limited');
  });

  it('missing tabMedi doc → TabelaDeMedidasNotFoundError', async () => {
    const db = new FakeDb();
    const { api } = makeApi();
    await expect(
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, 'nope', []),
    ).rejects.toThrow(TabelaDeMedidasNotFoundError);
  });

  it('a hard mid-sync error still persists the ids already obtained (no ML orphans)', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api } = makeApi({
      createSizeChart: vi
        .fn()
        .mockResolvedValueOnce(CHART_RESPONSE) // chart A created
        .mockRejectedValueOnce(new MercadoLivreHttpError('rate limited', 429, 'slow down')),
    });

    await expect(
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
        novaChart,
        { ...novaChart, nome: 'Segunda' },
      ]),
    ).rejects.toThrow('rate limited');

    // Chart A's id landed on the doc despite the abort — a retry updates it
    // instead of re-creating an orphan that owns the name forever.
    const doc = db.docs('tabMedi').get(TAB)!;
    const map = doc.tabelasDeMedidasMercadoLivre as Record<string, { tabelas: MlSizeChart[] }>;
    expect(map[CONTA]!.tabelas[0]!.id).toBe('1594439');
    expect(map[CONTA]!.tabelas[1]!.id).toBeNull(); // the failed one, as submitted
  });

  it('an id-less row is ALWAYS re-sent, even when it deep-equals the stored copy', async () => {
    // The once-failed-row state: the doc holds the row id-less (a previous
    // partial sync persisted it); the user retries with the identical payload.
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: [{ varianteUid: null, id: null, attributes: [{ id: 'SIZE', value_name: 'XG' }] }],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [stored],
    );

    expect(mocks.addSizeChartRow!).toHaveBeenCalledOnce();
    expect(result.tabelas[0]!.rows![0]!.id).toBe('1594439:1');
  });

  it('explicit-null attribute keys do not count as a row change (legacy includeIfNull)', async () => {
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      // Flutter-authored: null keys ABSENT.
      rows: [{ varianteUid: null, id: '1594439:1', attributes: [{ id: 'SIZE', value_name: 'M' }] }],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    // UI-submitted: same row, but with explicit nulls (this repo's form shape).
    const edited: MlSizeChart = {
      ...stored,
      rows: [
        {
          varianteUid: null,
          id: '1594439:1',
          attributes: [{ id: 'SIZE', value_id: null, value_name: 'M', unit_id: null }],
        },
      ],
    };
    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [edited],
    );

    expect(mocks.updateSizeChartRow!).not.toHaveBeenCalled();
    expect(result.updated).toBe(false);
  });

  it('a decimal separator alone does not count as a row change', async () => {
    // The editor localises a stored `'90.5'` to `'90,5'` on load, because pt-BR
    // is what the operator types and reads. Without the diff fold, EVERY row of
    // EVERY legacy guia would come back "changed" and the next "Enviar" would
    // fire one PUT per row — N calls and N fresh chances for ML to reject a row
    // that was fine. `measureStruct` reads both spellings as the same number.
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: [
        {
          varianteUid: null,
          id: '1594439:1',
          attributes: [
            { id: 'SIZE', value_name: 'M' },
            { id: 'WAIST', value_name: '90.5', unit_id: 'cm' },
          ],
        },
      ],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    const edited: MlSizeChart = {
      ...stored,
      rows: [
        {
          ...stored.rows![0]!,
          attributes: [
            { id: 'SIZE', value_name: 'M' },
            { id: 'WAIST', value_name: '90,5', unit_id: 'cm' },
          ],
        },
      ],
    };
    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [edited],
    );

    expect(mocks.updateSizeChartRow!).not.toHaveBeenCalled();
    expect(result.updated).toBe(false);
  });

  it('a real change to a measurement DOES send the row', async () => {
    // ANTI-VACUITY for the case above: the fold compares numbers, so a
    // different number must still be a change. Without this, a fold that
    // flattened every value_name to a constant would pass.
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: [
        {
          varianteUid: null,
          id: '1594439:1',
          attributes: [
            { id: 'SIZE', value_name: 'M' },
            { id: 'WAIST', value_name: '90.5', unit_id: 'cm' },
          ],
        },
      ],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    const edited: MlSizeChart = {
      ...stored,
      rows: [
        {
          ...stored.rows![0]!,
          attributes: [
            { id: 'SIZE', value_name: 'M' },
            // The 0,01 offset the duplicate rule forces is a REAL change.
            { id: 'WAIST', value_name: '90,51', unit_id: 'cm' },
          ],
        },
      ],
    };
    await syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
      edited,
    ]);

    expect(mocks.updateSizeChartRow!).toHaveBeenCalledTimes(1);
  });

  it('a TRAILING-ZERO edit is a real change and must still be sent', async () => {
    // ⚠️ The fold must neutralise the SEPARATOR, never the value. ML echoes a
    // measurement back verbatim on the anúncio, which is the whole reason the
    // grid keeps plain `TextInput`s instead of `DecimalInput` — folding to a
    // NUMBER would reintroduce that erasure one layer down.
    // Worse than "not sent": `persistProgress` opens with `if (!updated) return`,
    // so the edit would reach neither ML nor Firestore, behind a 200.
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: [
        {
          varianteUid: null,
          id: '1594439:1',
          attributes: [
            { id: 'SIZE', value_name: 'M' },
            { id: 'WAIST', value_name: '90,5', unit_id: 'cm' },
          ],
        },
      ],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    const edited: MlSizeChart = {
      ...stored,
      rows: [
        {
          ...stored.rows![0]!,
          attributes: [
            { id: 'SIZE', value_name: 'M' },
            { id: 'WAIST', value_name: '90,50', unit_id: 'cm' },
          ],
        },
      ],
    };
    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [edited],
    );

    expect(mocks.updateSizeChartRow!).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(true);
  });

  it('a LABEL edit that only drops a leading zero is a real change too', async () => {
    // ⚠️ `seedRows` localises `kind === 'number'` parts ONLY, so folding a text
    // value buys nothing and can only lose an edit. `'01'` and `'1'` are the
    // same NUMBER and different LABELS, and ML stores the label.
    const stored: MlSizeChart = {
      ...novaChart,
      id: '1594439',
      main_attribute_id: 'SIZE',
      rows: [
        { varianteUid: null, id: '1594439:1', attributes: [{ id: 'SIZE', value_name: '01' }] },
      ],
    };
    const db = new FakeDb();
    seedDoc(db, [stored]);
    const { api, mocks } = makeApi();

    const edited: MlSizeChart = {
      ...stored,
      rows: [{ varianteUid: null, id: '1594439:1', attributes: [{ id: 'SIZE', value_name: '1' }] }],
    };
    const result = await syncSizeCharts(
      { db: db as unknown as Firestore, api, integracaoId: CONTA },
      TAB,
      [edited],
    );

    expect(mocks.updateSizeChartRow!).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(true);
  });

  it('rejects charts the write schema will not persist (nome, domain_id, tipo)', async () => {
    const db = new FakeDb();
    seedDoc(db, []);
    const { api } = makeApi();

    // No nome/domain_id — tolerated on READ, never persisted. ⚠️ The old reason
    // (a live Flutter `json['nome'] as String` crashing) is VOID — there is no
    // dual run — but the constraints stand on their own, as the schema's own
    // note says: `nome` ≤ 60 IS the ML chart-name limit, `domain_id` must be the
    // full `SITE-DOMAIN` form or ML rejects the chart, and a `tipo` outside the
    // two ML values is unusable to every reader of the stored map, ours included.
    await expect(
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
        { id: '123', rows: [] },
      ]),
    ).rejects.toThrow();

    await expect(
      syncSizeCharts({ db: db as unknown as Firestore, api, integracaoId: CONTA }, TAB, [
        { ...novaChart, tipo: 'WEIRD_MEASURE' },
      ]),
    ).rejects.toThrow();
  });
});
