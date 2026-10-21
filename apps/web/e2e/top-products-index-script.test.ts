// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assessTopProductsPlan,
  parseTopProductsProbeArgs,
  validateTopProductsProbeAccount,
} from '../scripts/check-top-products-indexes.mjs';

const args = [
  '--project',
  'example-staging',
  '--start-us',
  '1768003200000000',
  '--end-exclusive-us',
  '1768176000000000',
];

describe('top-products staging Explain diagnostic', () => {
  it('requires an explicit real project and ordered integer microsecond bounds', () => {
    expect(parseTopProductsProbeArgs(args)).toMatchObject({
      projectId: 'example-staging',
      estados: ['finalizado', 'pago'],
      ehSaida: true,
      accountId: null,
    });
    expect(() => parseTopProductsProbeArgs([])).toThrow(RangeError);
    expect(() => parseTopProductsProbeArgs([...args, '--project', 'another-project'])).toThrow(
      RangeError,
    );
    expect(() => parseTopProductsProbeArgs(['--project', 'demo-erp', ...args.slice(2)])).toThrow(
      RangeError,
    );
    expect(() =>
      parseTopProductsProbeArgs([
        '--project',
        'example-staging',
        '--start-us',
        '2',
        '--end-exclusive-us',
        '1',
      ]),
    ).toThrow(RangeError);
    expect(() =>
      parseTopProductsProbeArgs([
        ...args.slice(0, 2),
        '--start-us',
        'NaN',
        '--end-exclusive-us',
        '2',
      ]),
    ).toThrow(RangeError);
    expect(() => parseTopProductsProbeArgs([...args, '--unknown', 'true'])).toThrow(RangeError);
  });

  it('preserves distinct account IDs and validates account, state and direction options', () => {
    expect(
      parseTopProductsProbeArgs([
        ...args,
        '--account',
        'ShopA',
        '--states',
        'pago,pago,finalizado',
        '--direction',
        'incoming',
      ]),
    ).toMatchObject({ accountId: 'ShopA', estados: ['finalizado', 'pago'], ehSaida: false });
    expect(parseTopProductsProbeArgs([...args, '--account', 'shopa']).accountId).toBe('shopa');
    expect(() => parseTopProductsProbeArgs([...args, '--account', 'integracao/shopa'])).toThrow(
      RangeError,
    );
    expect(() => parseTopProductsProbeArgs([...args, '--states', 'pago,'])).toThrow(RangeError);
    expect(() => parseTopProductsProbeArgs([...args, '--direction', 'both'])).toThrow(RangeError);
  });

  it('rejects mismatched service-account project IDs before connecting', () => {
    expect(() =>
      validateTopProductsProbeAccount('example-staging', { project_id: 'example-staging' }),
    ).not.toThrow();
    expect(() =>
      validateTopProductsProbeAccount('example-staging', { project_id: 'another-project' }),
    ).toThrow(RangeError);
    expect(() => validateTopProductsProbeAccount('example-staging', {})).toThrow(RangeError);
  });

  it('uses the same finite upper quantity bound as the actual report query', () => {
    for (const relative of [
      '../lib/reports/topProducts.ts',
      '../scripts/check-top-products-indexes.mjs',
    ]) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      expect(source).toMatch(/lessThanOrEqual\(quantity, Number\.MAX_VALUE\)/);
      expect(source).not.toContain('Number.POSITIVE_INFINITY');
    }
  });

  const plan = (
    bounds: string,
    index = '/pedidos (ehSaida ASC, estado ASC, timestamp DESC)@[id = report-index]',
  ) =>
    [
      'Execution:',
      '  results returned: 3',
      '  data bytes read: 240',
      '  index row scanned: 2',
      'Billing:',
      '  read units: 1',
      'Tree:',
      '• SequentialScan',
      '  index: ' + index,
      '  ranges: /',
      bounds,
    ].join('\n');
  const fields = ['ehSaida ASC', 'estado ASC', 'timestamp DESC'];

  it('passes a named index only when ranges include every filter and the date bound', () => {
    const result = assessTopProductsPlan(
      plan(
        '  |----[true]\n       |----["pago"]\n' +
          '            |----[1768003200000000..1768176000000000)',
      ),
      fields,
    );
    expect(result.status).toBe('pass');
    expect(result.indexes).toEqual(['/pedidos (ehSaida ASC, estado ASC, timestamp DESC)']);
  });

  it('rejects empty or unknown plans, wrong indexes and residual date filters', () => {
    expect(assessTopProductsPlan('', fields).status).toBe('unverified');
    expect(assessTopProductsPlan('unrecognized plan', fields).status).toBe('unverified');
    expect(assessTopProductsPlan(plan('  |----[true]\n       |----["pago"]'), fields).status).toBe(
      'fail',
    );
    expect(assessTopProductsPlan(plan('  |----(-∞..+∞)'), fields).status).toBe('fail');
    expect(
      assessTopProductsPlan(
        plan('  |----[true]', '/pedidos (ehSaida ASC, timestamp DESC)@[id = other-index]'),
        fields,
      ).status,
    ).toBe('fail');
    expect(
      assessTopProductsPlan('Tree:\n• TableScan\n  kind: pedidos\n  ranges: /', fields).status,
    ).toBe('fail');
  });
});
