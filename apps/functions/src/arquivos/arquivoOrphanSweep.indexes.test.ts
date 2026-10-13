import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The round-robin page of `sweepUnreferencedArquivos` orders `arquivos` by
 * document key, and on Firestore Enterprise that needs a DECLARED key index
 * (#1874): Enterprise creates none, not even one on `__name__`. Without the entry
 * nothing fails — not the deploy, not the emulator suite (the Standard emulator
 * serves key order natively), not the sweep — the page just walks another
 * arquivos index end to end and sorts in memory. Measured on staging: 313 index
 * rows read per page of 100, i.e. the whole collection on every 48h tick. So the
 * pairing is pinned here, offline, in both directions.
 */

interface IndexEntry {
  collectionGroup: string;
  queryScope: string;
  fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>;
}

function lerIndices(): IndexEntry[] {
  const manifest = JSON.parse(
    readFileSync(new URL('../../../../firestore.indexes.json', import.meta.url), 'utf8'),
  ) as { indexes: IndexEntry[] };
  return manifest.indexes;
}

/** `fetchArquivoPage`'s body, as shipped. */
function corpoDaPagina(): string {
  const fonte = readFileSync(new URL('./arquivoOrphanSweep.ts', import.meta.url), 'utf8');
  const corpo = fonte.match(/async function fetchArquivoPage\([\s\S]*?\n}\n/)?.[0];
  if (corpo == null) throw new Error('fetchArquivoPage not found in arquivoOrphanSweep.ts');
  return corpo;
}

describe('arquivo orphan sweep — the round-robin page and its key index (#1874)', () => {
  it('fetchArquivoPage still pages arquivos by document key', () => {
    // If this goes red because the page was re-keyed onto a field, the index
    // below has lost its only reader: delete it from firestore.indexes.json
    // together with this file, and re-measure the new page with
    // scripts/check-sweep-indexes.mjs.
    expect(corpoDaPagina()).toContain('.orderBy(FieldPath.documentId())');
  });

  it('declares arquivos(__name__ ASC) — Enterprise has no implicit key index', () => {
    const chave = lerIndices().filter(
      (i) =>
        i.collectionGroup === 'arquivos' &&
        i.queryScope === 'COLLECTION' &&
        i.fields[0]?.fieldPath === '__name__',
    );
    expect(
      chave.map((i) => i.fields),
      'firestore.indexes.json must declare arquivos (COLLECTION) with __name__ ASC as its ONLY ' +
        'field — without it every sweep page reads the whole collection (#1874)',
    ).toEqual([[{ fieldPath: '__name__', order: 'ASCENDING' }]]);
  });
});
