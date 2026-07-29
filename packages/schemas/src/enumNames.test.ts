/**
 * Backstop for `delfrance/prefer-schema-enum`, which identifies a Zod enum by
 * NAME — the schema variable (`estadoPedidoSchema`) or the type alias
 * (`EstadoPedido`) — and keys its registry on both.
 *
 * That keying is only sound while those names are unique across the package. A
 * duplicate would make the registry last-writer-wins and let the rule suggest
 * one module's constant inside another's code — which compiles, because two
 * enums that collide this way usually carry the same wire values. The rule used
 * to key on the member SET instead and hit exactly that failure (see its header),
 * so the invariant is worth asserting rather than assuming.
 *
 * Same shape as `defaultQuery.indexes.test.ts`: a schemas-side test guarding an
 * assumption a lint rule depends on.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '.');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/** `name` → the files declaring it, for every declaration matching `pattern`. */
function declarationsBy(pattern: RegExp, group: number): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(pattern)) {
      const name = match[group];
      if (name === undefined) continue;
      const where = file.slice(SRC.length + 1);
      byName.set(name, [...(byName.get(name) ?? []), where]);
    }
  }
  return byName;
}

const duplicates = (byName: Map<string, string[]>): string[] =>
  [...byName]
    .filter(([, files]) => files.length > 1)
    .map(([n, files]) => `${n} — ${files.join(', ')}`);

describe('Zod enum names are unique across the package', () => {
  it('no two files declare the same z.enum schema variable', () => {
    // `z\s*\.?\s*\n?\s*\.?enum` also matches the wrapped
    // `export const x = z\n  .enum([...])` form several schemas use.
    const schemas = declarationsBy(/export const (\w+) = z\s*\n?\s*\.enum\(/g, 1);
    expect(schemas.size).toBeGreaterThan(20); // the scan actually found things
    expect(duplicates(schemas)).toEqual([]);
  });

  it('no two files declare the same z.infer type alias', () => {
    const aliases = declarationsBy(/export type (\w+) = z\.infer<typeof (\w+)>/g, 1);
    expect(aliases.size).toBeGreaterThan(100);
    expect(duplicates(aliases)).toEqual([]);
  });
});
