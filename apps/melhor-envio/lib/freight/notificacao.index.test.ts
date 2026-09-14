import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Melhor Envio notification indexes', () => {
  it('declares the pedido label lookup index without a Standard-edition name suffix', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../firestore.indexes.json', import.meta.url), 'utf8'),
    ) as {
      indexes: Array<{
        collectionGroup: string;
        queryScope: string;
        fields: Array<{ fieldPath: string; order: string }>;
      }>;
    };

    const index = manifest.indexes.find(
      (candidate) =>
        candidate.collectionGroup === 'pedidos' &&
        candidate.queryScope === 'COLLECTION' &&
        candidate.fields.length === 1 &&
        candidate.fields[0]?.fieldPath === 'freteInicial.printLabelId',
    );
    expect(index?.fields).toEqual([{ fieldPath: 'freteInicial.printLabelId', order: 'ASCENDING' }]);
    expect(index?.fields.some((field) => field.fieldPath === '__name__')).toBe(false);
  });
});
