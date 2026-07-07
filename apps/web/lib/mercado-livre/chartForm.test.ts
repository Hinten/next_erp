import { describe, expect, it } from 'vitest';
import type { Variante } from '@delfrance/schemas';

import { buildNewChart, extractGridTemplate, rowsFromVariantes } from './chartForm';

/**
 * Mirrors the real ML `technical_specs` shape (verified against the legacy
 * embedded sample, `.old/.../api_response.dart:381`): a `GRIDS` group holds a
 * `GRID` component whose CHILD components each carry `attributes[]`. GENDER is
 * tagged `grid_template_required`; BRAND is a `grid_filter`; the size/measure
 * columns carry other tags.
 */
const specsSample = {
  input: {
    groups: [
      {
        id: 'SIZE_CHART',
        section: 'GRIDS',
        components: [
          {
            component: 'GRID',
            components: [
              {
                component: 'TEXT_OUTPUT',
                attributes: [
                  {
                    id: 'GENDER',
                    name: 'Gênero',
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
                attributes: [{ id: 'BRAND', name: 'Marca', tags: ['grid_filter', 'required'] }],
              },
              {
                component: 'NUMBER_UNIT_INPUT',
                attributes: [
                  { id: 'CHEST_CIRCUMFERENCE', name: 'Busto', tags: [], default_unit_id: 'cm' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('extractGridTemplate', () => {
  it('finds the single grid_template_required attribute + its values', () => {
    const res = extractGridTemplate(specsSample);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.template.id).toBe('GENDER');
    expect(res.template.name).toBe('Gênero');
    expect(res.template.values).toEqual([
      { id: '339665', name: 'Feminino' },
      { id: '339666', name: 'Masculino' },
    ]);
  });

  it('tolerates a top-level `groups` (no `input` wrapper)', () => {
    const res = extractGridTemplate({ groups: specsSample.input.groups });
    expect(res.ok).toBe(true);
  });

  it('reports `none` when the domain has no chart template', () => {
    expect(extractGridTemplate({ input: { groups: [] } })).toEqual({ ok: false, reason: 'none' });
    expect(extractGridTemplate({})).toEqual({ ok: false, reason: 'none' });
  });

  it('reports `multiple` when more than one template attribute exists', () => {
    const two = {
      input: {
        groups: [
          {
            components: [
              {
                components: [
                  { attributes: [{ id: 'GENDER', tags: ['grid_template_required'] }] },
                  { attributes: [{ id: 'AGE', tags: ['grid_template_required'] }] },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(extractGridTemplate(two)).toEqual({ ok: false, reason: 'multiple' });
  });

  it('never mistakes an attribute value-list for a nested attribute set', () => {
    // A value object carrying its own `attributes` key must NOT be walked.
    const tricky = {
      input: {
        groups: [
          {
            components: [
              {
                attributes: [
                  {
                    id: 'GENDER',
                    tags: ['grid_template_required'],
                    values: [
                      {
                        id: '1',
                        name: 'X',
                        attributes: [{ id: 'EVIL', tags: ['grid_template_required'] }],
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
    expect(extractGridTemplate(tricky)).toEqual({
      ok: true,
      template: expect.objectContaining({ id: 'GENDER' }),
    });
  });
});

const variantes: Variante[] = [
  { id: 'v-m', nome: 'M' },
  { id: 'v-g', nome: 'G' },
];

describe('rowsFromVariantes', () => {
  it('emits one row per variante with the canonical varianteUid + SIZE label', () => {
    expect(rowsFromVariantes('g-tam', variantes)).toEqual([
      {
        varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
        id: null,
        attributes: [{ id: 'SIZE', value_name: 'M' }],
      },
      {
        varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-g',
        id: null,
        attributes: [{ id: 'SIZE', value_name: 'G' }],
      },
    ]);
  });
});

describe('buildNewChart', () => {
  it('assembles a write-shape chart (id null, empty main_attribute, GENDER + rows)', () => {
    const chart = buildNewChart({
      nome: '  Camisetas ML  ',
      domainId: 'MLB-T_SHIRTS',
      templateId: 'GENDER',
      templateValue: { id: '339665', name: 'Feminino' },
      grupoId: 'g-tam',
      variantes,
    });
    expect(chart).toEqual({
      id: null,
      nome: 'Camisetas ML',
      domain_id: 'MLB-T_SHIRTS',
      tipo: 'CLOTHING_MEASURE',
      grupoDeVariacoesUid: 'documents/grupoDeVariacoes/g-tam',
      attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
      main_attribute: [],
      rows: [
        {
          varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
          id: null,
          attributes: [{ id: 'SIZE', value_name: 'M' }],
        },
        {
          varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-g',
          id: null,
          attributes: [{ id: 'SIZE', value_name: 'G' }],
        },
      ],
    });
  });
});
