import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every migration that walks a whole collection by document key needs a
 * DECLARED key index on Firestore Enterprise (#1895). Enterprise creates none —
 * not even on `__name__` — and nothing fails without one: no deploy, no emulator
 * run (the Standard emulator serves key order natively), no migration. Each page
 * just scans the whole collection and sorts in memory (#1874 measured 313 index
 * rows read per page of 100), so a walk inside the cutover window costs
 * N²/page instead of N.
 *
 * `key-walks.json` is the inventory. This pins it three ways, because each one
 * drifts silently on its own:
 *  1. every script that pages by key is IN the inventory — a new walk cannot
 *     land without saying what it walks;
 *  2. every inventory row is TRUE about its script — the collection is named
 *     there, in the scope the row claims;
 *  3. every row has its `__name__ ASC` index, and every key-only index in
 *     `firestore.indexes.json` is either a row or a known PERMANENT one — so the
 *     post-cutover cleanup (#1896) deletes exactly the migration-only set.
 */

type Escopo = 'COLLECTION' | 'COLLECTION_GROUP';

interface Caminhada {
  script: string;
  collection: string;
  scope: Escopo;
}

interface IndexEntry {
  collectionGroup: string;
  queryScope: string;
  fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>;
}

const SRC = fileURLToPath(new URL('.', import.meta.url));

/**
 * Key-only indexes with a PERMANENT reader outside tools/migrations — never part
 * of the post-cutover cleanup.
 */
const PERMANENTES: ReadonlyArray<{ collection: string; scope: Escopo; leitor: string }> = [
  {
    collection: 'arquivos',
    scope: 'COLLECTION',
    leitor: 'apps/functions arquivo orphan sweep, round-robin page (#1874)',
  },
];

function lerCaminhadas(): Caminhada[] {
  const raw = JSON.parse(readFileSync(new URL('../key-walks.json', import.meta.url), 'utf8')) as {
    walks: Caminhada[];
  };
  return raw.walks;
}

function lerIndices(): IndexEntry[] {
  return (
    JSON.parse(
      readFileSync(new URL('../../../firestore.indexes.json', import.meta.url), 'utf8'),
    ) as { indexes: IndexEntry[] }
  ).indexes;
}

/** Every non-test `.ts` source under `src/<script>/`, keyed by script dir. */
function fontesPorScript(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of readdirSync(SRC)) {
    const caminho = join(SRC, dir);
    if (!statSync(caminho).isDirectory()) continue;
    const textos = readdirSync(caminho)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(join(caminho, f), 'utf8'));
    out.set(dir, textos.join('\n'));
  }
  return out;
}

const chave = (c: { collection: string; scope: string }) => `${c.scope} ${c.collection}`;
const ehSoChave = (i: IndexEntry) => i.fields.length === 1 && i.fields[0]?.fieldPath === '__name__';

describe('migration key walks ↔ key indexes (#1895)', () => {
  const caminhadas = lerCaminhadas();
  const fontes = fontesPorScript();

  it('every script that pages by document key is in key-walks.json', () => {
    const naoListados = [...fontes]
      .filter(([, texto]) => texto.includes('.orderBy(FieldPath.documentId())'))
      .map(([script]) => script)
      .filter((script) => !caminhadas.some((c) => c.script === script));
    expect(
      naoListados,
      'add each collection these scripts walk by key to tools/migrations/key-walks.json, and ' +
        'declare its __name__ ASC index in firestore.indexes.json — on Enterprise a key-ordered ' +
        'page without one scans the whole collection',
    ).toEqual([]);
  });

  it('every key-walks.json row is true about its script', () => {
    for (const c of caminhadas) {
      const texto = fontes.get(c.script);
      expect(texto, `${c.script}: no such script dir under tools/migrations/src`).toBeDefined();
      expect(texto, `${c.script}: still pages by key?`).toContain(
        '.orderBy(FieldPath.documentId())',
      );
      expect(texto, `${c.script}: never names '${c.collection}'`).toContain(`'${c.collection}'`);
      expect(texto, `${c.script}: claims ${c.scope} but never builds that scope`).toContain(
        c.scope === 'COLLECTION_GROUP' ? '.collectionGroup(' : '.collection(',
      );
    }
  });

  it('every walked (collection, scope) has exactly one __name__ ASC index', () => {
    const indices = lerIndices().filter(ehSoChave);
    for (const alvo of new Set(caminhadas.map(chave))) {
      const casam = indices.filter(
        (i) => chave({ collection: i.collectionGroup, scope: i.queryScope }) === alvo,
      );
      expect(
        casam.map((i) => i.fields),
        `${alvo}: declare { collectionGroup, queryScope, fields: [{ fieldPath: "__name__", ` +
          'order: "ASCENDING" }] } in firestore.indexes.json',
      ).toEqual([[{ fieldPath: '__name__', order: 'ASCENDING' }]]);
    }
  });

  it('every key-only index is a migration walk or a known permanent one — nothing unattributed', () => {
    const conhecidos = new Set([...caminhadas.map(chave), ...PERMANENTES.map(chave)]);
    const orfaos = lerIndices()
      .filter(ehSoChave)
      .map((i) => chave({ collection: i.collectionGroup, scope: i.queryScope }))
      .filter((k) => !conhecidos.has(k));
    expect(
      orfaos,
      'a key-only index with no listed reader: add its walk to key-walks.json, or its permanent ' +
        'reader to PERMANENTES here — #1896 deletes the migration-only set after the cutover',
    ).toEqual([]);
  });
});
