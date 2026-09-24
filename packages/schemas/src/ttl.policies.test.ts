import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TTL_FIELD, TTL_POLICIES } from './index';

// Backstop for the TTL registry: `firestore.indexes.json` must declare EXACTLY
// the policies `TTL_POLICIES` lists. Both directions fail silently otherwise —
// a policy nobody stamps deletes nothing, and a stamp with no policy keeps every
// document forever while the code reads as if it expired them. A stray policy
// on the wrong group is worse: it deletes whatever carries that field.

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find pnpm-workspace.yaml above ' + startDir);
}

interface FieldOverride {
  collectionGroup?: unknown;
  fieldPath?: unknown;
  ttl?: unknown;
  indexes?: unknown;
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const parsed = JSON.parse(readFileSync(resolve(repoRoot, 'firestore.indexes.json'), 'utf8')) as {
  fieldOverrides?: FieldOverride[];
};
const overrides = Array.isArray(parsed.fieldOverrides) ? parsed.fieldOverrides : [];
const ttlOverrides = overrides.filter((o) => o.ttl === true);
const registryGroups = TTL_POLICIES.map((p) => p.collectionGroup);

describe('firestore.indexes.json TTL policies', () => {
  it('declares every TTL_POLICIES row', () => {
    const declared = ttlOverrides.map((o) => o.collectionGroup);
    expect(registryGroups.filter((g) => !declared.includes(g))).toEqual([]);
  });

  it('declares no TTL policy outside TTL_POLICIES', () => {
    expect(
      ttlOverrides
        .map((o) => o.collectionGroup)
        .filter((g) => !registryGroups.includes(g as string)),
    ).toEqual([]);
  });

  it('keys every policy on TTL_FIELD with no single-field indexes', () => {
    for (const o of ttlOverrides) {
      expect({ group: o.collectionGroup, fieldPath: o.fieldPath, indexes: o.indexes }).toEqual({
        group: o.collectionGroup,
        fieldPath: TTL_FIELD,
        indexes: [],
      });
    }
  });

  it('declares each collection group at most once (one TTL field per group)', () => {
    const groups = ttlOverrides.map((o) => o.collectionGroup);
    expect(groups.filter((g, i) => groups.indexOf(g) !== i)).toEqual([]);
  });

  it('lists each registry group once', () => {
    expect(new Set(registryGroups).size).toBe(registryGroups.length);
  });
});
