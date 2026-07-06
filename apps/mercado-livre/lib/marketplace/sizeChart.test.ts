import { describe, expect, it } from 'vitest';
import type { MlSizeChart } from '@delfrance/schemas';

import { findChartRow, resolveSizeChart } from './sizeChart';

const chart = (over: Partial<MlSizeChart>): MlSizeChart => ({
  id: 'chart-1',
  domain_id: 'MLB-PANTS',
  nome: 'Tabela calças',
  attributes: [],
  rows: [],
  ...over,
});

describe('resolveSizeChart', () => {
  const tabelas: MlSizeChart[] = [
    chart({
      id: '100',
      attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
    }),
    chart({
      id: '200',
      attributes: [{ id: 'GENDER', value_id: '339666', value_name: 'Masculino' }],
    }),
    chart({ id: null, domain_id: 'MLB-PANTS' }), // never sent to ML — not a candidate
    chart({ id: '300', domain_id: 'MLB-SNEAKERS' }), // other domain
  ];

  it('filters by catalog domain and requires an ML id', () => {
    expect(resolveSizeChart(tabelas, 'MLB-SNEAKERS', null)?.id).toBe('300');
    expect(resolveSizeChart(tabelas, 'MLB-DRESSES', null)).toBeNull();
    expect(resolveSizeChart(tabelas, null, null)).toBeNull();
  });

  it('no valued link attributes → first domain candidate (legacy)', () => {
    expect(resolveSizeChart(tabelas, 'MLB-PANTS', null)?.id).toBe('100');
    expect(resolveSizeChart(tabelas, 'MLB-PANTS', [{ id: 'GENDER' }])?.id).toBe('100');
  });

  it('attribute-hit scoring picks the best match (value_id or value_name)', () => {
    const byId = resolveSizeChart(tabelas, 'MLB-PANTS', [{ id: 'GENDER', value_id: '339666' }]);
    expect(byId?.id).toBe('200');
    const byName = resolveSizeChart(tabelas, 'MLB-PANTS', [
      { id: 'GENDER', value_name: 'Feminino' },
    ]);
    expect(byName?.id).toBe('100');
  });

  it('valued attributes with ZERO hits → null (legacy: never bind blind)', () => {
    expect(
      resolveSizeChart(tabelas, 'MLB-PANTS', [{ id: 'GENDER', value_id: 'no-such' }]),
    ).toBeNull();
  });
});

describe('findChartRow', () => {
  const c = chart({
    rows: [
      // Unsent row (no ML id) must never bind.
      { varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-p', id: null, attributes: [] },
      {
        varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
        id: '100:2',
        attributes: [{ id: 'SIZE', value_name: 'M (38-40)' }],
      },
      { varianteUid: null, id: '100:3', attributes: [] },
    ],
  });

  it('matches by the varianteUid LAST SEGMENT against the child variacoesUid', () => {
    const row = findChartRow(c, [
      'documents/grupoDeVariacoes/g-cor/variacoes/v-preto',
      'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
    ]);
    expect(row).toEqual({ rowId: '100:2', size: { id: 'SIZE', value_name: 'M (38-40)' } });
  });

  it('tolerates bare (non-prefixed) fake paths on either side', () => {
    const row = findChartRow(c, ['grupoDeVariacoes/g-tam/variacoes/v-m']);
    expect(row?.rowId).toBe('100:2');
  });

  it('skips rows without an ML id — an unsent row must not bind (v-p)', () => {
    expect(findChartRow(c, ['documents/grupoDeVariacoes/g-tam/variacoes/v-p'])).toBeNull();
  });

  it('null when nothing matches', () => {
    expect(findChartRow(c, ['documents/grupoDeVariacoes/g-tam/variacoes/v-gg'])).toBeNull();
  });
});
