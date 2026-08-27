import { describe, expect, it } from 'vitest';

import {
  type ChartColumn,
  type GridTemplateAttribute,
  chartLevelAttributes,
  columnAttributeIds,
  detectMeasureTypes,
  draftChartAttributeValue,
  extractChartAttributes,
  extractColumns,
  extractGridTemplates,
  mainAttributeCandidates,
  maxRows,
  resolveChartAttributeValue,
} from './chartSpec';
import { unitLabel } from './units';

/**
 * Mirrors the real `?section=grids` response for `MLB-T_SHIRTS`, transcribed
 * from the legacy embedded sample (`.old/…/mercado_livre/scripts/domain.dart`):
 * a `GRIDS` group holds a `GRID` component whose CHILD components are the
 * columns, GENDER/BRAND echo back as `TEXT_OUTPUT`, `FILTRABLE_SIZE` is a
 * hidden read-only list that is nonetheless `required` per row, and every
 * measurement is a
 * `LINKED_BY_CONNECTOR_INPUT` FROM/TO pair tagged by measure type.
 */
const tshirtGrid = {
  input: {
    groups: [
      {
        id: 'SIZE_CHART',
        section: 'GRIDS',
        components: [
          {
            component: 'GRID',
            label: 'Guia de tamanhos',
            ui_config: { max_allowed: 75, allow_custom_value: true },
            components: [
              {
                component: 'TEXT_OUTPUT',
                label: 'Gênero',
                attributes: [
                  {
                    id: 'GENDER',
                    name: 'Gênero',
                    // The DOMAIN ficha técnica types GENDER as a closed list;
                    // chart-level attributes are read from that response, not
                    // from the grid one (where it echoes back as a string).
                    value_type: 'list',
                    tags: ['grid_template_required', 'grid_filter', 'required'],
                    values: [
                      { id: '339665', name: 'Feminino' },
                      { id: '339666', name: 'Masculino' },
                    ],
                  },
                ],
              },
              {
                component: 'TEXT_OUTPUT',
                label: 'Marca',
                attributes: [
                  {
                    id: 'BRAND',
                    name: 'Marca',
                    value_type: 'string',
                    tags: ['grid_filter', 'required'],
                  },
                ],
              },
              {
                component: 'TEXT_INPUT',
                label: 'Tamanho na etiqueta',
                ui_config: { hint: 'Como o tamanho aparece na etiqueta.' },
                attributes: [
                  {
                    id: 'SIZE',
                    name: 'Tamanho na etiqueta',
                    value_type: 'string',
                    tags: ['unique', 'main_attribute_candidate', 'required'],
                  },
                ],
              },
              {
                component: 'COMBO',
                label: 'Equivalências',
                attributes: [
                  {
                    id: 'FILTRABLE_SIZE',
                    name: 'Tamanho padrão',
                    value_type: 'list',
                    // ⚠️ `required` sits alongside `read_only`/`hidden`, and ML
                    // means all three: the tags describe how the attribute
                    // behaves on the LISTING (derived onto the anúncio, absent
                    // from the VIP page), while `required` is the row contract.
                    tags: ['multivalued', 'read_only', 'hidden', 'required'],
                    // More than one option on purpose — a single-value list
                    // cannot catch a mapping that drops members.
                    values: [
                      { id: '3189130', name: '34' },
                      { id: '4608574', name: '36' },
                      { id: '3259450', name: '38' },
                    ],
                  },
                ],
              },
              {
                component: 'LINKED_BY_CONNECTOR_INPUT',
                label: 'Contorno do peito',
                ui_config: { connector: 'a', hint: 'De - Até' },
                default_unified_unit_id: 'cm',
                unified_units: [
                  { id: 'cm', name: 'cm' },
                  { id: '"', name: '"' },
                ],
                attributes: [
                  {
                    id: 'CHEST_CIRCUMFERENCE_FROM',
                    name: 'Contorno do peito de',
                    value_type: 'number_unit',
                    tags: ['BODY_MEASURE'],
                    default_unit_id: 'cm',
                    units: [
                      { id: 'cm', name: 'cm' },
                      { id: '"', name: '"' },
                    ],
                  },
                  {
                    id: 'CHEST_CIRCUMFERENCE_TO',
                    name: 'Contorno do peito até',
                    value_type: 'number_unit',
                    tags: ['BODY_MEASURE'],
                    default_unit_id: 'cm',
                  },
                ],
              },
              {
                component: 'LINKED_BY_CONNECTOR_INPUT',
                label: 'Comprimento da roupa',
                ui_config: { connector: 'a' },
                attributes: [
                  {
                    id: 'GARMENT_LENGTH_FROM',
                    name: 'Comprimento da roupa de',
                    value_type: 'number_unit',
                    tags: ['CLOTHING_MEASURE'],
                    default_unit_id: 'cm',
                  },
                  {
                    id: 'GARMENT_LENGTH_TO',
                    name: 'Comprimento da roupa até',
                    value_type: 'number_unit',
                    tags: ['CLOTHING_MEASURE'],
                    default_unit_id: 'cm',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

/** A footwear grid: several main-attribute candidates and NO plain SIZE column. */
const sneakerGrid = {
  input: {
    groups: [
      {
        section: 'GRIDS',
        components: [
          {
            component: 'GRID',
            ui_config: {},
            components: [
              {
                component: 'TEXT_INPUT',
                label: 'Tamanho da marca',
                attributes: [
                  {
                    id: 'MANUFACTURER_SIZE',
                    name: 'Tamanho da marca',
                    value_type: 'string',
                    tags: ['unique', 'main_attribute_candidate'],
                  },
                ],
              },
              {
                component: 'NUMBER_UNIT_INPUT',
                label: 'EU',
                attributes: [
                  {
                    id: 'EU_SIZE',
                    name: 'EU',
                    value_type: 'number_unit',
                    tags: ['main_attribute_candidate'],
                    default_unit_id: 'EU',
                    units: [{ id: 'EU', name: 'EU' }],
                  },
                ],
              },
              {
                component: 'NUMBER_UNIT_INPUT',
                label: 'Comprimento do pé',
                attributes: [
                  {
                    id: 'FOOT_LENGTH',
                    name: 'Comprimento do pé',
                    value_type: 'number_unit',
                    tags: ['required'],
                    default_unit_id: 'cm',
                    units: [{ id: 'cm', name: 'cm' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

/**
 * Mirrors the real `GET /domains/MLB-T_SHIRTS/technical_specs` response — the
 * DOMAIN ficha técnica, which is a different document from `tshirtGrid` above.
 *
 * ⚠️ The reason this fixture exists: at DOMAIN level `grid_filter` marks the
 * `/catalog/charts/search` vocabulary, so MODEL and LINE carry it while being
 * listing attributes ML refuses inside a chart body. GENDER is also typed as a
 * closed `list` here and BRAND carries its suggestion list — neither is true of
 * the grid response, which is why this is the RENDERING source.
 */
const tshirtDomainSpec = {
  input: {
    groups: [
      {
        id: 'MAIN',
        section: 'SPECIFICATIONS',
        components: [
          {
            component: 'COMBO',
            label: 'Marca',
            ui_config: { allow_custom_value: true },
            attributes: [
              {
                id: 'BRAND',
                name: 'Marca',
                value_type: 'string',
                tags: ['grid_filter', 'catalog_required', 'required'],
                values: [
                  { id: '14671', name: 'Nike' },
                  { id: '9999', name: 'Genérica' },
                ],
              },
            ],
          },
          {
            component: 'COMBO',
            label: 'Modelo',
            attributes: [
              {
                id: 'MODEL',
                name: 'Modelo',
                value_type: 'string',
                tags: ['grid_filter', 'catalog_required'],
                values: [],
              },
            ],
          },
          {
            component: 'COMBO',
            label: 'Linha',
            attributes: [
              { id: 'LINE', name: 'Linha', value_type: 'string', tags: ['grid_filter'] },
            ],
          },
          {
            component: 'COMBO',
            label: 'Gênero',
            attributes: [
              {
                id: 'GENDER',
                name: 'Gênero',
                value_type: 'list',
                tags: ['grid_template_required', 'grid_filter', 'required'],
                values: [
                  { id: '339665', name: 'Feminino' },
                  { id: '339666', name: 'Masculino' },
                ],
              },
            ],
          },
          {
            component: 'GRID_ROW_INPUT',
            label: 'ID da linha da guia',
            attributes: [
              {
                id: 'SIZE_GRID_ROW_ID',
                name: 'ID da linha da guia de tamanhos',
                value_type: 'grid_row_id',
                tags: ['vip_hidden', 'hidden', 'variation_attribute'],
              },
            ],
          },
        ],
      },
    ],
  },
};

function byKey(columns: ChartColumn[], key: string): ChartColumn {
  const found = columns.find((c) => c.key === key);
  if (!found) throw new Error(`no column ${key}: ${columns.map((c) => c.key).join(', ')}`);
  return found;
}

describe('extractGridTemplates', () => {
  it('returns every grid_template_required attribute with its values', () => {
    expect(extractGridTemplates(tshirtGrid)).toEqual([
      {
        id: 'GENDER',
        name: 'Gênero',
        required: true,
        kind: 'select',
        values: [
          { id: '339665', name: 'Feminino' },
          { id: '339666', name: 'Masculino' },
        ],
      },
    ]);
  });

  it('handles MORE THAN ONE template — the MVP punted to the old app here', () => {
    const twoTemplates = {
      input: {
        groups: [
          {
            components: [
              {
                component: 'GRID',
                components: [
                  {
                    component: 'COMBO',
                    attributes: [
                      { id: 'GENDER', name: 'Gênero', tags: ['grid_template_required'] },
                    ],
                  },
                  {
                    component: 'COMBO',
                    attributes: [
                      { id: 'AGE_GROUP', name: 'Idade', tags: ['grid_template_required'] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(extractGridTemplates(twoTemplates).map((t) => t.id)).toEqual(['GENDER', 'AGE_GROUP']);
  });

  it('is empty for a domain with no chart template', () => {
    expect(extractGridTemplates({ input: { groups: [] } })).toEqual([]);
  });

  it('never mistakes a VALUE that carries attributes for an attribute', () => {
    const trap = {
      input: {
        groups: [
          {
            components: [
              {
                component: 'GRID',
                components: [
                  {
                    attributes: [
                      {
                        id: 'GENDER',
                        name: 'Gênero',
                        tags: ['grid_template_required'],
                        values: [
                          {
                            id: '1',
                            name: 'Feminino',
                            attributes: [{ id: 'FAKE', tags: ['grid_template_required'] }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(extractGridTemplates(trap).map((t) => t.id)).toEqual(['GENDER']);
  });
});

describe('extractChartAttributes', () => {
  it('returns the grid_filter attributes — ML forbids these inside rows', () => {
    expect(extractChartAttributes(tshirtGrid).map((a) => a.id)).toEqual(['GENDER', 'BRAND']);
  });

  it('drops read-only / hidden filters, which ML derives itself', () => {
    const spec = {
      input: {
        groups: [
          {
            components: [
              {
                component: 'GRID',
                components: [
                  {
                    attributes: [
                      { id: 'AGE_GROUP', name: 'Idade', tags: ['grid_filter', 'read_only'] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(extractChartAttributes(spec)).toEqual([]);
  });
});

describe('chartLevelAttributes', () => {
  it('NEVER offers a domain-only grid_filter attribute — the MODEL regression', () => {
    // The domain spec tags MODEL and LINE `grid_filter` because they filter a
    // CHART SEARCH; the grid spec — the chart's own ficha técnica — does not
    // mention them. Reading the list from the domain spec rendered a "Modelo"
    // field whose answer ML rejected outright: "Attribute MODEL found in
    // chart's attributes is not valid and should not be present in the chart's
    // general attributes."
    expect(extractChartAttributes(tshirtDomainSpec).map((a) => a.id)).toContain('MODEL');

    const ids = chartLevelAttributes(tshirtDomainSpec, tshirtGrid).map((a) => a.id);
    expect(ids).toEqual(['GENDER', 'BRAND']);
    expect(ids).not.toContain('MODEL');
    expect(ids).not.toContain('LINE');
  });

  it('never repeats an attribute that is BOTH a template and a filter', () => {
    // GENDER on MLB-T_SHIRTS carries `grid_template_required` AND `grid_filter`.
    // Concatenating the two lists rendered two form fields with key="GENDER"
    // and sent the attribute twice in the chart body.
    expect(extractGridTemplates(tshirtDomainSpec).map((a) => a.id)).toContain('GENDER');
    expect(extractChartAttributes(tshirtGrid).map((a) => a.id)).toContain('GENDER');

    const ids = chartLevelAttributes(tshirtDomainSpec, tshirtGrid).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders GENDER from the DOMAIN spec, not the grid spec echo', () => {
    // The grid spec echoes GENDER back narrowed to the chosen value; taking it
    // from there would drop every other gender from the Select.
    const gender = chartLevelAttributes(tshirtDomainSpec, tshirtGrid).find(
      (a) => a.id === 'GENDER',
    );
    expect(gender).toMatchObject({ required: true, name: 'Gênero', kind: 'select' });
    expect(gender?.values.map((v) => v.name)).toEqual(['Feminino', 'Masculino']);
  });

  it('keeps a grid-only filter, with the DOMAIN spec supplying its suggestions', () => {
    // BRAND carries NO `values` on the grid spec, so a chart-level list built
    // from that response alone would offer the operator nothing to pick from.
    expect(extractChartAttributes(tshirtGrid).find((a) => a.id === 'BRAND')?.values).toEqual([]);

    const brand = chartLevelAttributes(tshirtDomainSpec, tshirtGrid).find((a) => a.id === 'BRAND');
    expect(brand).toMatchObject({ id: 'BRAND', required: true, kind: 'text' });
    expect(brand?.values.map((v) => v.name)).toEqual(['Nike', 'Genérica']);
  });

  it('is the templates alone until the grid spec lands', () => {
    // `gridSpecs` is null while the operator is still answering the questions
    // that fetch it — the form must not be empty in that window.
    expect(chartLevelAttributes(tshirtDomainSpec, null).map((a) => a.id)).toEqual(['GENDER']);
  });

  it('is empty for a domain with neither', () => {
    expect(chartLevelAttributes(sneakerGrid, sneakerGrid)).toEqual([]);
  });

  it('marks a CLOSED list as select and an open one as free text', () => {
    // GENDER is `value_type: list` — a real closed list. BRAND is
    // `value_type: string` with a pile of known brands, and ML accepts any
    // value; a Select there blocks every brand ML has not seen.
    const byId = new Map(chartLevelAttributes(tshirtDomainSpec, tshirtGrid).map((a) => [a.id, a]));
    expect(byId.get('GENDER')?.kind).toBe('select');
    expect(byId.get('BRAND')?.kind).toBe('text');
  });
});

describe('draftChartAttributeValue', () => {
  it('KEEPS a trailing space, so a multi-word brand is typeable', () => {
    // Resolving on the change path trimmed the text the input renders back, so
    // the space vanished before the caret moved — and the known-value snap ate
    // it a second time, putting "Nike Air" out of reach on a domain shipping
    // "Nike".
    expect(draftChartAttributeValue('Nike ')).toEqual({ id: '', name: 'Nike ' });
  });

  it('treats a blank draft as no answer at all', () => {
    // An answered chart attribute goes into the grid-spec query KEY, so a
    // whitespace one would spend a real ML round trip.
    expect(draftChartAttributeValue('  ')).toBeNull();
    expect(draftChartAttributeValue('')).toBeNull();
  });

  it('still keeps the spaces around text that IS an answer', () => {
    expect(draftChartAttributeValue(' Nike ')).toEqual({ id: '', name: ' Nike ' });
  });
});

describe('resolveChartAttributeValue', () => {
  const brand: GridTemplateAttribute = {
    id: 'BRAND',
    name: 'Marca',
    required: true,
    kind: 'text',
    values: [
      { id: '14671', name: 'Nike' },
      { id: '9999', name: 'Genérica' },
    ],
  };

  it('keeps a custom brand ML has never seen, with NO invented id', () => {
    expect(resolveChartAttributeValue(brand, 'Delfrance')).toEqual({
      id: '',
      name: 'Delfrance',
    });
  });

  it('snaps to a known option so the id goes up too', () => {
    expect(resolveChartAttributeValue(brand, 'Nike')).toEqual({ id: '14671', name: 'Nike' });
  });

  it('matches a known option through accents and case', () => {
    // 'Generica' typed for 'Genérica' would otherwise be sent as a custom value.
    expect(resolveChartAttributeValue(brand, 'generica')).toEqual({
      id: '9999',
      name: 'Genérica',
    });
  });

  it('trims, and treats blank as no answer at all', () => {
    expect(resolveChartAttributeValue(brand, '  Nike  ')).toEqual({ id: '14671', name: 'Nike' });
    expect(resolveChartAttributeValue(brand, '   ')).toBeNull();
    expect(resolveChartAttributeValue(brand, '')).toBeNull();
  });
});

describe('detectMeasureTypes', () => {
  it('offers both when the domain tags both families', () => {
    expect(detectMeasureTypes(tshirtGrid)).toEqual(['BODY_MEASURE', 'CLOTHING_MEASURE']);
  });

  it('is empty for a domain with no measure columns (footwear)', () => {
    expect(detectMeasureTypes(sneakerGrid)).toEqual([]);
  });
});

describe('mainAttributeCandidates', () => {
  it('apparel offers only SIZE', () => {
    expect(mainAttributeCandidates(tshirtGrid)).toEqual([
      { id: 'SIZE', name: 'Tamanho na etiqueta' },
    ]);
  });

  it('footwear offers several — the case the MVP could not create at all', () => {
    expect(mainAttributeCandidates(sneakerGrid).map((c) => c.id)).toEqual([
      'MANUFACTURER_SIZE',
      'EU_SIZE',
    ]);
  });
});

describe('unitLabel', () => {
  it('spells out the inch unit, whose ML id is a bare double quote', () => {
    // ML sends `units: [{id: '"', name: '"'}, …]`. Rendered raw it looks like a
    // blank option — it is real data, not a null, and must not be filtered out.
    expect(unitLabel('"')).toBe('pol. (")');
  });

  it('leaves every other unit exactly as ML sent it', () => {
    for (const unit of ['cm', 'EU', 'US', 'UK', 'AR', 'BR']) {
      expect(unitLabel(unit)).toBe(unit);
    }
  });

  it('is what the picker shows for the T_SHIRTS chest column', () => {
    const chest = byKey(extractColumns(tshirtGrid, 'BODY_MEASURE'), 'CHEST_CIRCUMFERENCE_FROM');
    expect(chest.unit.options.map((u) => unitLabel(u.id))).toEqual(['cm', 'pol. (")']);
    // The stored VALUE stays ML's own id — that is what goes up in `unit_id`.
    expect(chest.unit.options.map((u) => u.id)).toEqual(['cm', '"']);
  });
});

describe('maxRows', () => {
  it("reads the GRID's ui_config.max_allowed", () => {
    expect(maxRows(tshirtGrid)).toBe(75);
  });

  it('is null when ML sends no cap', () => {
    expect(maxRows(sneakerGrid)).toBeNull();
  });
});

describe('extractColumns', () => {
  const body = extractColumns(tshirtGrid, 'BODY_MEASURE');

  it('drops the TEXT_OUTPUT echoes but KEEPS the required hidden list', () => {
    // ⚠️ The regression this pins. `FILTRABLE_SIZE` used to be dropped on
    // `hidden`/`read_only` alone, on the belief that ML computes what it marks
    // read-only. It does not: ML's row contract is "no nível de rows, você terá
    // de enviar os atributos somente com a tag required", and their own
    // POST /catalog/charts example sends it in every row next to SIZE. Dropping
    // it earned `required_row_attribute_not_found` on EVERY row of an apparel
    // guia — with no cell in the DOM to pin the error to, so the operator got
    // "veja os campos destacados" over a grid with nothing highlighted.
    expect(body.map((c) => c.key)).toEqual(['SIZE', 'FILTRABLE_SIZE', 'CHEST_CIRCUMFERENCE_FROM']);
  });

  it('renders the equivalence column as a multiselect over ML’s closed list', () => {
    const equiv = byKey(body, 'FILTRABLE_SIZE');
    expect(equiv).toMatchObject({ required: true, mainCandidate: false, sizeEquivalence: true });
    expect(equiv.parts[0]!.kind).toBe('multiselect');
    expect(equiv.parts[0]!.values).toEqual([
      { id: '3189130', name: '34' },
      { id: '4608574', name: '36' },
      { id: '3259450', name: '38' },
    ]);
  });

  it('still drops a hidden/read-only attribute ML does NOT mark required', () => {
    // `AGE_GROUP` on the footwear grid — ML really does derive that one, and it
    // is `grid_filter` besides. `required` is the whole escape hatch.
    const spec = {
      input: {
        groups: [
          {
            components: [
              {
                component: 'GRID',
                components: [
                  {
                    component: 'TEXT_INPUT',
                    label: 'Idade',
                    attributes: [
                      {
                        id: 'AGE_GROUP',
                        name: 'Idade',
                        value_type: 'string',
                        tags: ['hidden', 'read_only'],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(extractColumns(spec, null)).toEqual([]);
  });

  it('flags ONLY the carve-out as a size equivalence', () => {
    // A plainly-required column is not an equivalence, or `chartAiGrid` would
    // tell the model to derive a measurement instead of reading it.
    expect(byKey(body, 'SIZE').sizeEquivalence).toBe(false);
    expect(byKey(body, 'CHEST_CIRCUMFERENCE_FROM').sizeEquivalence).toBe(false);
  });

  it('folds a FROM/TO pair into ONE column carrying the connector', () => {
    const chest = byKey(body, 'CHEST_CIRCUMFERENCE_FROM');
    expect(chest.label).toBe('Contorno do peito');
    expect(chest.connector).toBe('a');
    expect(chest.hint).toBe('De - Até');
    expect(columnAttributeIds(chest)).toEqual([
      'CHEST_CIRCUMFERENCE_FROM',
      'CHEST_CIRCUMFERENCE_TO',
    ]);
    expect(chest.unit).toEqual({
      default: 'cm',
      options: [
        { id: 'cm', name: 'cm' },
        { id: '"', name: '"' },
      ],
    });
  });

  it('filters by measure type — a mismatched column is rejected by ML', () => {
    expect(extractColumns(tshirtGrid, 'CLOTHING_MEASURE').map((c) => c.key)).toEqual([
      'SIZE',
      'FILTRABLE_SIZE',
      'GARMENT_LENGTH_FROM',
    ]);
  });

  it('keeps both families when no measure type is chosen yet', () => {
    expect(extractColumns(tshirtGrid, null).map((c) => c.key)).toEqual([
      'SIZE',
      'FILTRABLE_SIZE',
      'CHEST_CIRCUMFERENCE_FROM',
      'GARMENT_LENGTH_FROM',
    ]);
  });

  it('marks required and main-candidate columns', () => {
    const size = byKey(body, 'SIZE');
    expect(size).toMatchObject({ required: true, mainCandidate: true, connector: null });
    expect(size.parts[0]!.kind).toBe('text');
    expect(byKey(body, 'CHEST_CIRCUMFERENCE_FROM').mainCandidate).toBe(false);
  });

  it('maps value_type to a control, multivalued lists included', () => {
    const spec = {
      input: {
        groups: [
          {
            components: [
              {
                component: 'GRID',
                components: [
                  {
                    component: 'COMBO',
                    label: 'Única',
                    attributes: [
                      { id: 'A', name: 'A', value_type: 'list', values: [{ id: '1', name: 'um' }] },
                    ],
                  },
                  {
                    component: 'COMBO',
                    label: 'Múltipla',
                    attributes: [{ id: 'B', name: 'B', value_type: 'list', tags: ['multivalued'] }],
                  },
                  {
                    component: 'NUMBER_UNIT_INPUT',
                    label: 'Número',
                    attributes: [{ id: 'C', name: 'C', value_type: 'number_unit' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const cols = extractColumns(spec, null);
    expect(cols.map((c) => c.parts[0]!.kind)).toEqual(['select', 'multiselect', 'number']);
    expect(byKey(cols, 'A').parts[0]!.values).toEqual([{ id: '1', name: 'um' }]);
  });

  it('degrades an UNKNOWN component to a text column instead of throwing', () => {
    // The legacy screen raised UnimplementedError here and blanked the grid —
    // a hard dead end for something ML can change unilaterally.
    const spec = {
      input: {
        groups: [
          {
            components: [
              {
                component: 'GRID',
                components: [
                  {
                    component: 'SOMETHING_ML_ADDED_LATER',
                    label: 'Novo',
                    attributes: [{ id: 'NOVO', name: 'Novo', value_type: 'quantum' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const cols = extractColumns(spec, null);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ key: 'NOVO', label: 'Novo' });
    expect(cols[0]!.parts[0]!.kind).toBe('text');
  });

  it('is empty for a spec with no GRID component at all', () => {
    expect(extractColumns({ input: { groups: [{ components: [] }] } }, null)).toEqual([]);
  });

  it('footwear: every candidate is an editable column, none is filtered out', () => {
    expect(extractColumns(sneakerGrid, null).map((c) => c.key)).toEqual([
      'MANUFACTURER_SIZE',
      'EU_SIZE',
      'FOOT_LENGTH',
    ]);
  });
});
