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
    expect(resolveSizeChart(tabelas, 'MLB-SNEAKERS', null).chart?.id).toBe('300');
    expect(resolveSizeChart(tabelas, 'MLB-DRESSES', null).chart).toBeNull();
    expect(resolveSizeChart(tabelas, null, null).chart).toBeNull();
  });

  it('null/EMPTY link attributes → first domain candidate (legacy boundary)', () => {
    expect(resolveSizeChart(tabelas, 'MLB-PANTS', null).chart?.id).toBe('100');
    expect(resolveSizeChart(tabelas, 'MLB-PANTS', []).chart?.id).toBe('100');
  });

  it('NON-EMPTY but all-unvalued attributes → scoring → zero hits → NO chart (legacy)', () => {
    // ML-imported stub attributes carry neither value_id nor value_name; the
    // legacy scorer returns null here — falling back would bind a blind chart
    // (possibly the wrong gender) that legacy never bound.
    expect(resolveSizeChart(tabelas, 'MLB-PANTS', [{ id: 'GENDER' }]).chart).toBeNull();
  });

  it('attribute-hit scoring picks the best match (value_id or value_name)', () => {
    const byId = resolveSizeChart(tabelas, 'MLB-PANTS', [{ id: 'GENDER', value_id: '339666' }]);
    expect(byId.chart?.id).toBe('200');
    const byName = resolveSizeChart(tabelas, 'MLB-PANTS', [
      { id: 'GENDER', value_name: 'Feminino' },
    ]);
    expect(byName.chart?.id).toBe('100');
  });

  it('valued attributes with ZERO hits → null (legacy: never bind blind)', () => {
    expect(
      resolveSizeChart(tabelas, 'MLB-PANTS', [{ id: 'GENDER', value_id: 'no-such' }]).chart,
    ).toBeNull();
  });

  // ---- WHY nothing bound (#1087) -----------------------------------------
  //
  // Each miss carries its own reason and its own payload. A test asserting only
  // `chart === null` cannot tell a domain mismatch from a guia nobody sent, and
  // that conflation is exactly what let `Attribute [SIZE_GRID_ID] is missing`
  // reach an operator with no way to act on it.

  it('a bound chart reports NO reason', () => {
    expect(resolveSizeChart(tabelas, 'MLB-SNEAKERS', null).motivo).toBeNull();
  });

  it('no catalog_domain on the category → categoria-sem-dominio', () => {
    expect(resolveSizeChart(tabelas, null, null)).toEqual({
      chart: null,
      motivo: 'categoria-sem-dominio',
    });
  });

  it('the live case: guias in another domain → dominio-divergente, naming BOTH', () => {
    // The reproduced bug (#1087): the tabela's guia is MLB-SHIRTS, the produto's
    // category MLB1398 reports MLB-T_SHIRTS. Both strings must come out — that
    // sentence is the entire fix for the operator.
    const shirts = [chart({ id: '7523235', domain_id: 'MLB-SHIRTS' })];
    expect(resolveSizeChart(shirts, 'MLB-T_SHIRTS', null)).toEqual({
      chart: null,
      motivo: 'dominio-divergente',
      dominiosDaTabela: ['MLB-SHIRTS'],
      dominioDaCategoria: 'MLB-T_SHIRTS',
    });
  });

  it('dominiosDaTabela is DISTINCT, SORTED, and lists only guias that were SENT', () => {
    const mistas = [
      chart({ id: '1', domain_id: 'MLB-PANTS' }),
      chart({ id: '2', domain_id: 'MLB-PANTS' }), // duplicate domain
      chart({ id: '3', domain_id: 'MLB-DRESSES' }),
      chart({ id: null, domain_id: 'MLB-COATS' }), // never sent — cannot bind, must not be offered
    ];
    const out = resolveSizeChart(mistas, 'MLB-SNEAKERS', null);
    expect(out).toEqual({
      chart: null,
      motivo: 'dominio-divergente',
      dominiosDaTabela: ['MLB-DRESSES', 'MLB-PANTS'],
      dominioDaCategoria: 'MLB-SNEAKERS',
    });
  });

  it('a guia in the RIGHT domain that was never sent → guias-nao-enviadas, NOT a mismatch', () => {
    // ⚠️ The split that matters: telling this operator their domain is wrong
    // sends them to change the one field that is already correct. What they
    // have to do is press Enviar.
    const rascunho = [
      chart({ id: null, domain_id: 'MLB-T_SHIRTS' }),
      chart({ id: '900', domain_id: 'MLB-PANTS' }),
    ];
    expect(resolveSizeChart(rascunho, 'MLB-T_SHIRTS', null)).toEqual({
      chart: null,
      motivo: 'guias-nao-enviadas',
      dominioDaCategoria: 'MLB-T_SHIRTS',
    });
  });

  it('NOTHING sent at all → guias-nao-enviadas, whatever the domains are', () => {
    const nenhuma = [chart({ id: null, domain_id: 'MLB-PANTS' }), chart({ id: '' })];
    expect(resolveSizeChart(nenhuma, 'MLB-SNEAKERS', null)).toEqual({
      chart: null,
      motivo: 'guias-nao-enviadas',
      dominioDaCategoria: 'MLB-SNEAKERS',
    });
  });

  it('right domain, wrong gênero → sem-atributos-correspondentes', () => {
    expect(resolveSizeChart(tabelas, 'MLB-PANTS', [{ id: 'GENDER', value_id: 'no-such' }])).toEqual(
      {
        chart: null,
        motivo: 'sem-atributos-correspondentes',
        dominioDaCategoria: 'MLB-PANTS',
      },
    );
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

  it("prefers ML's computed sizeCalculado — the only size a footwear chart has", () => {
    // A footwear chart's main attribute is EU_SIZE, so the row carries no SIZE
    // of its own; ML derives one and `applyChartResponse` caches it.
    const calcados = chart({
      main_attribute_id: 'EU_SIZE',
      rows: [
        {
          varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-40',
          id: '100:1',
          attributes: [{ id: 'EU_SIZE', value_name: '40 EU' }],
          sizeCalculado: { id: 'SIZE', value_name: '8,5 US' },
        },
      ],
    });
    expect(findChartRow(calcados, ['documents/grupoDeVariacoes/g-tam/variacoes/v-40'])).toEqual({
      rowId: '100:1',
      size: { id: 'SIZE', value_name: '8,5 US' },
    });
  });

  it('falls back to the row own SIZE when there is no cache (every pre-existing chart)', () => {
    const row = findChartRow(c, ['documents/grupoDeVariacoes/g-tam/variacoes/v-m']);
    expect(row?.size).toEqual({ id: 'SIZE', value_name: 'M (38-40)' });
  });
});
