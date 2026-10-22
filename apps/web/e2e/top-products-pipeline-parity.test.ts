// @vitest-environment node
import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import { ESTADO_PEDIDO } from '@delfrance/schemas';
import { buildTopProductsPipeline } from '../lib/reports/topProducts';
import { buildTopProductsIndexProbePipeline } from '../scripts/check-top-products-indexes.mjs';

type TaggedExpression = {
  kind: string;
  args: unknown[];
  as: (name: string) => TaggedExpression;
  ifAbsent: (value: unknown) => TaggedExpression;
  ifNull: (value: unknown) => TaggedExpression;
};

const expressions = vi.hoisted(() => {
  const tag = (kind: string, args: unknown[]): TaggedExpression => ({
    kind,
    args,
    as: (name) => tag('as', [{ kind, args }, name]),
    ifAbsent: (value) => tag('ifAbsent', [{ kind, args }, value]),
    ifNull: (value) => tag('ifNull', [{ kind, args }, value]),
  });
  const factory =
    (kind: string) =>
    (...args: unknown[]) =>
      tag(kind, args);
  return {
    and: factory('and'),
    or: factory('or'),
    array: factory('array'),
    map: factory('map'),
    conditional: factory('conditional'),
    constant: factory('constant'),
    countAll: factory('countAll'),
    documentId: factory('documentId'),
    equal: factory('equal'),
    equalAny: factory('equalAny'),
    execute: vi.fn(),
    field: factory('field'),
    greaterThanOrEqual: factory('greaterThanOrEqual'),
    isType: factory('isType'),
    lessThan: factory('lessThan'),
    lessThanOrEqual: factory('lessThanOrEqual'),
    mapEntries: factory('mapEntries'),
    sum: factory('sum'),
  };
});
vi.mock('firebase/firestore/pipelines', () => expressions);

function capturePipeline() {
  const stages: { name: string; args: unknown[] }[] = [];
  const stage =
    (name: string) =>
    (...args: unknown[]): unknown => {
      stages.push({ name, args });
      return chain;
    };
  const chain = {
    collection: stage('collection'),
    where: stage('where'),
    select: stage('select'),
    unnest: stage('unnest'),
    aggregate: stage('aggregate'),
  };
  // The test deliberately supplies only the Pipeline methods exercised by the
  // builders; the full SDK Firestore instance is unnecessary for stage parity.
  const db = { pipeline: () => chain } as unknown as Firestore;
  return { db, stages };
}

describe('top-products client and Explain query parity', () => {
  it.each([true, false])('keeps every report stage identical for outgoing=%s', (ehSaida) => {
    for (const accountIds of [[], ['shopa', 'ShopA', 'shopa']]) {
      const filters = {
        startUs: 1768003200000000,
        endExclusiveUs: 1768176000000000,
        estados: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado, ESTADO_PEDIDO.pago],
        accountIds,
        ehSaida,
      };
      const client = capturePipeline();
      const admin = capturePipeline();
      buildTopProductsPipeline(client.db, filters);
      buildTopProductsIndexProbePipeline(admin.db, filters, expressions);
      // The tag methods are fixture behavior. Comparing serialized stages
      // compares every expression and value while omitting those functions.
      expect(JSON.stringify(admin.stages)).toBe(JSON.stringify(client.stages));
      expect(admin.stages.map(({ name }) => name)).toEqual([
        'collection',
        'where',
        'select',
        'unnest',
        'unnest',
        'aggregate',
      ]);
      const serialized = JSON.stringify(admin.stages);
      expect(serialized).toContain('lessThanOrEqual');
      expect(serialized).toContain(String(Number.MAX_VALUE));
      expect(serialized).toContain('invalidLines');
      expect(serialized).toContain('ifAbsent');
      expect(serialized).toContain('ifNull');
    }
  });
});
