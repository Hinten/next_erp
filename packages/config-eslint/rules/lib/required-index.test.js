import { describe, expect, it } from 'vitest';
import {
  collectionGroupOf,
  deriveRequiredIndex,
  formatIndexJson,
  indexSatisfies,
} from './required-index.js';

describe('collectionGroupOf', () => {
  it('returns the path itself for a top-level collection', () => {
    expect(collectionGroupOf('clientes')).toBe('clientes');
  });
  it('returns the leaf segment for a subcollection path', () => {
    expect(collectionGroupOf('clientes/{clienteId}/enderecos')).toBe('enderecos');
  });
});

describe('deriveRequiredIndex', () => {
  it('maps a single ascending orderBy', () => {
    expect(
      deriveRequiredIndex('clientes', { orderBy: [{ field: 'nome', direction: 'asc' }] }),
    ).toEqual({
      collectionGroup: 'clientes',
      queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'nome', order: 'ASCENDING' }],
    });
  });

  it('maps a descending orderBy', () => {
    expect(
      deriveRequiredIndex('pedidos', { orderBy: [{ field: 'numero', direction: 'desc' }] }),
    ).toEqual({
      collectionGroup: 'pedidos',
      queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'numero', order: 'DESCENDING' }],
    });
  });

  it('puts equality where fields (ASCENDING) before orderBy fields', () => {
    expect(
      deriveRequiredIndex('produtos', {
        where: [{ field: 'paiId' }],
        orderBy: [{ field: 'nome', direction: 'asc' }],
      }),
    ).toEqual({
      collectionGroup: 'produtos',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'paiId', order: 'ASCENDING' },
        { fieldPath: 'nome', order: 'ASCENDING' },
      ],
    });
  });

  it('uses the leaf collection group for subcollection paths', () => {
    expect(
      deriveRequiredIndex('clientes/{clienteId}/enderecos', {
        orderBy: [{ field: 'logradouro', direction: 'asc' }],
      }).collectionGroup,
    ).toBe('enderecos');
  });
});

describe('indexSatisfies', () => {
  const required = deriveRequiredIndex('clientes', {
    orderBy: [{ field: 'nome', direction: 'asc' }],
  });

  it('matches an exact entry', () => {
    expect(
      indexSatisfies(
        {
          collectionGroup: 'clientes',
          queryScope: 'COLLECTION',
          fields: [{ fieldPath: 'nome', order: 'ASCENDING' }],
        },
        required,
      ),
    ).toBe(true);
  });

  it('tolerates a trailing __name__ field', () => {
    expect(
      indexSatisfies(
        {
          collectionGroup: 'clientes',
          queryScope: 'COLLECTION',
          fields: [
            { fieldPath: 'nome', order: 'ASCENDING' },
            { fieldPath: '__name__', order: 'ASCENDING' },
          ],
        },
        required,
      ),
    ).toBe(true);
  });

  it('treats a missing queryScope as COLLECTION', () => {
    expect(
      indexSatisfies(
        { collectionGroup: 'clientes', fields: [{ fieldPath: 'nome', order: 'ASCENDING' }] },
        required,
      ),
    ).toBe(true);
  });

  it('rejects a direction mismatch', () => {
    expect(
      indexSatisfies(
        {
          collectionGroup: 'clientes',
          queryScope: 'COLLECTION',
          fields: [{ fieldPath: 'nome', order: 'DESCENDING' }],
        },
        required,
      ),
    ).toBe(false);
  });

  it('rejects a different collection group', () => {
    expect(
      indexSatisfies(
        {
          collectionGroup: 'categorias',
          queryScope: 'COLLECTION',
          fields: [{ fieldPath: 'nome', order: 'ASCENDING' }],
        },
        required,
      ),
    ).toBe(false);
  });

  it('rejects a COLLECTION_GROUP scope', () => {
    expect(
      indexSatisfies(
        {
          collectionGroup: 'clientes',
          queryScope: 'COLLECTION_GROUP',
          fields: [{ fieldPath: 'nome', order: 'ASCENDING' }],
        },
        required,
      ),
    ).toBe(false);
  });

  it('rejects extra leading fields', () => {
    expect(
      indexSatisfies(
        {
          collectionGroup: 'clientes',
          queryScope: 'COLLECTION',
          fields: [
            { fieldPath: 'tipo', order: 'ASCENDING' },
            { fieldPath: 'nome', order: 'ASCENDING' },
          ],
        },
        required,
      ),
    ).toBe(false);
  });

  it('rejects non-object candidates', () => {
    expect(indexSatisfies(null, required)).toBe(false);
    expect(indexSatisfies('nope', required)).toBe(false);
  });
});

describe('formatIndexJson', () => {
  it('pretty-prints a ready-to-paste entry', () => {
    const json = formatIndexJson(
      deriveRequiredIndex('clientes', { orderBy: [{ field: 'nome', direction: 'asc' }] }),
    );
    expect(JSON.parse(json)).toEqual({
      collectionGroup: 'clientes',
      queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'nome', order: 'ASCENDING' }],
    });
    expect(json).toContain('\n');
  });
});
