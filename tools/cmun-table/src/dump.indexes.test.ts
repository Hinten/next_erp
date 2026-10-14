import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The `CMUN` dump pages the whole collection by document key, and on Firestore
 * Enterprise that needs a DECLARED key index: Enterprise creates none, not even
 * on `__name__` (#1874, #1895). Without the entry nothing fails — the dump just
 * re-reads the collection on every page. It reads the legacy Standard project
 * today, but after the cutover production is Enterprise, and any re-export or
 * staging seed walks an Enterprise project. Pinned here, offline, both ways.
 */

interface IndexEntry {
  collectionGroup: string;
  queryScope: string;
  fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>;
}

describe('CMUN dump ↔ its key index', () => {
  it('the dump still pages CMUN by document key', () => {
    // If this goes red because the dump stopped walking by key, the index below
    // has lost its reader: delete it from firestore.indexes.json with this file.
    const fonte = readFileSync(new URL('./dump.ts', import.meta.url), 'utf8');
    expect(fonte).toContain('.orderBy(FieldPath.documentId())');
    expect(fonte).toContain("db.collection('CMUN')");
  });

  it('declares CMUN(__name__ ASC) — Enterprise has no implicit key index', () => {
    const { indexes } = JSON.parse(
      readFileSync(new URL('../../../firestore.indexes.json', import.meta.url), 'utf8'),
    ) as { indexes: IndexEntry[] };
    const chave = indexes.filter(
      (i) =>
        i.collectionGroup === 'CMUN' &&
        i.queryScope === 'COLLECTION' &&
        i.fields[0]?.fieldPath === '__name__',
    );
    expect(
      chave.map((i) => i.fields),
      'firestore.indexes.json must declare CMUN (COLLECTION) with __name__ ASC as its ONLY field',
    ).toEqual([[{ fieldPath: '__name__', order: 'ASCENDING' }]]);
  });
});
