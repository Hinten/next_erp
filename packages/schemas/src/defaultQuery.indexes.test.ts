import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type RequiredIndex,
  deriveRequiredIndex,
  formatIndexJson,
  indexSatisfies,
} from '@delfrance/config-eslint/rules/lib/required-index.js';
import * as registry from './index';
import type { CollectionMetadata } from './types';

// End-to-end backstop for the delfrance/default-query-needs-index lint rule:
// imports the REAL schema registry barrel (catches anything the AST rule can't
// see) and asserts firestore.indexes.json covers every declared defaultQuery
// AND every TableView update-monitor query. Firestore Enterprise creates no
// indexes automatically, so a missing one means a full collection scan.

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find pnpm-workspace.yaml above ' + startDir);
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const indexesFile = resolve(repoRoot, 'firestore.indexes.json');
const parsed = JSON.parse(readFileSync(indexesFile, 'utf8')) as {
  indexes?: unknown[];
};
const indexes = Array.isArray(parsed.indexes) ? parsed.indexes : [];

interface Bundle {
  schema: unknown;
  meta: CollectionMetadata;
}

function isBundle(value: unknown): value is Bundle {
  if (!value || typeof value !== 'object') return false;
  const v = value as { schema?: unknown; meta?: { collectionPath?: unknown } };
  return !!v.schema && typeof v.meta?.collectionPath === 'string';
}

// Every exported `{ schema, meta }` bundle, de-duped by collectionPath.
const bundles: Bundle[] = [];
const seenPaths = new Set<string>();
for (const value of Object.values(registry)) {
  if (isBundle(value) && !seenPaths.has(value.meta.collectionPath)) {
    seenPaths.add(value.meta.collectionPath);
    bundles.push(value);
  }
}

/** Top-level field keys of a Zod object schema (tolerates `.passthrough()`). */
function topLevelKeys(schema: unknown): Set<string> {
  const shape = (schema as { shape?: Record<string, unknown> })?.shape;
  return new Set(shape && typeof shape === 'object' ? Object.keys(shape) : []);
}

/**
 * Replicate TableView's update-monitor field auto-resolution
 * (`resolvedMonitorField` in packages/ui/src/table/TableView.tsx): prefer
 * `ultimaModificacao`, then `timestamp`, else no monitor (and no index).
 */
function monitorField(schema: unknown): string | null {
  const keys = topLevelKeys(schema);
  if (keys.has('ultimaModificacao')) return 'ultimaModificacao';
  if (keys.has('timestamp')) return 'timestamp';
  return null;
}

function failWithPasteable(missing: RequiredIndex[], kind: string): never {
  expect.fail(
    `Missing Firestore index(es) for ${kind}. Firestore Enterprise creates no indexes ` +
      `automatically — add these to the "indexes" array of firestore.indexes.json and run ` +
      `\`firebase deploy --only firestore:indexes\`:\n` +
      missing.map(formatIndexJson).join(',\n'),
  );
}

describe('firestore.indexes.json coverage', () => {
  it('sanity: the registry exposes collection bundles', () => {
    expect(bundles.length).toBeGreaterThan(0);
  });

  it('covers every declared defaultQuery', () => {
    const missing: RequiredIndex[] = [];
    for (const { meta } of bundles) {
      if (!meta.defaultQuery) continue;
      const required = deriveRequiredIndex(meta.collectionPath, meta.defaultQuery);
      if (!indexes.some((idx) => indexSatisfies(idx, required))) missing.push(required);
    }
    if (missing.length > 0) failWithPasteable(missing, 'declared defaultQuery entries');
  });

  it('covers every TableView update-monitor query', () => {
    const missing: RequiredIndex[] = [];
    for (const { schema, meta } of bundles) {
      // The monitor only runs on collections rendered through TableView, which
      // are exactly the ones declaring a defaultQuery. (A defaultQuery
      // collection rendered with a custom table — e.g. produtos — would over-
      // require here, but those happen to carry no monitor field, so the set
      // stays exact. An unused monitor index is harmless anyway.)
      if (!meta.defaultQuery) continue;
      const field = monitorField(schema);
      if (!field) continue;
      const required = deriveRequiredIndex(meta.collectionPath, {
        orderBy: [{ field, direction: 'desc' }],
      });
      if (!indexes.some((idx) => indexSatisfies(idx, required))) missing.push(required);
    }
    if (missing.length > 0) failWithPasteable(missing, 'TableView update-monitor queries');
  });

  it('reports unused index entries (warning only — never fails)', () => {
    const required: RequiredIndex[] = [];
    for (const { schema, meta } of bundles) {
      if (!meta.defaultQuery) continue;
      required.push(deriveRequiredIndex(meta.collectionPath, meta.defaultQuery));
      const field = monitorField(schema);
      if (field) {
        required.push(
          deriveRequiredIndex(meta.collectionPath, { orderBy: [{ field, direction: 'desc' }] }),
        );
      }
    }
    const unused = indexes.filter((idx) => !required.some((r) => indexSatisfies(idx, r)));
    if (unused.length > 0) {
      // Legitimate for non-defaultQuery queries (admin, Functions, future).
      console.warn(
        `firestore.indexes.json has ${unused.length} index(es) not matched by any declared ` +
          `defaultQuery or monitor query. This is allowed (admin / Functions / future queries).`,
      );
    }
    expect(true).toBe(true);
  });
});
