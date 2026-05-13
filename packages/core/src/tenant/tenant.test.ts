import { describe, expect, it } from 'vitest';
import {
  GRUPO_ECONOMICO_COLLECTION_PATH,
  grupoEconomicoSchema,
} from './index';

describe('grupoEconomicoSchema', () => {
  it('parses a minimal grupo with defaults applied', () => {
    const out = grupoEconomicoSchema.parse({ nome: 'Tenant A' });
    expect(out).toEqual({
      nome: 'Tenant A',
      databases: [],
      databaseMap: [],
      users: [],
    });
  });

  it('rejects missing nome', () => {
    expect(grupoEconomicoSchema.safeParse({}).success).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    expect(
      grupoEconomicoSchema.safeParse({ nome: 'x'.repeat(256) }).success,
    ).toBe(false);
  });

  it('passes databaseMap entries through with extra fields', () => {
    const out = grupoEconomicoSchema.parse({
      nome: 'Tenant B',
      databaseMap: [{ database: 'br-south', region: 'southamerica-east1', extra: 1 }],
    });
    expect(out.databaseMap[0]).toMatchObject({
      database: 'br-south',
      region: 'southamerica-east1',
      extra: 1,
    });
  });

  it('exposes the canonical collection path', () => {
    expect(GRUPO_ECONOMICO_COLLECTION_PATH).toBe('grupoEconomico');
  });
});
