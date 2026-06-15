import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as barrel from './index';
import { ALL_DOMAINS } from './registry';

interface DomainSchemaShape {
  schema: z.ZodTypeAny;
  meta: { collectionPath: string };
}

function isDomainSchema(value: unknown): value is DomainSchemaShape {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { schema?: unknown; meta?: unknown };
  if (!(candidate.schema instanceof z.ZodType)) return false;
  if (typeof candidate.meta !== 'object' || candidate.meta === null) return false;
  return typeof (candidate.meta as { collectionPath?: unknown }).collectionPath === 'string';
}

describe('ALL_DOMAINS registry', () => {
  it('registers every DomainSchema exported from the barrel', () => {
    const registered = new Set<unknown>(ALL_DOMAINS);
    const missing = Object.entries(barrel)
      .filter(([, value]) => isDomainSchema(value) && !registered.has(value))
      .map(([name]) => name);
    expect(missing, 'add these exports to ALL_DOMAINS in registry.ts').toEqual([]);
  });

  it('contains no entries that are absent from the barrel', () => {
    const fromBarrel = new Set<unknown>(Object.values(barrel).filter(isDomainSchema));
    const stray = ALL_DOMAINS.filter((d) => !fromBarrel.has(d));
    expect(stray.map((d) => d.meta.collectionPath)).toEqual([]);
  });

  it('has no duplicate registrations or collection paths', () => {
    expect(new Set(ALL_DOMAINS).size).toBe(ALL_DOMAINS.length);
    const paths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
