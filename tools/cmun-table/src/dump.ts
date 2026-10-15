import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FieldPath, type Query } from 'firebase-admin/firestore';
import { migrationDb, parseArgs } from '@delfrance/migrations';
import type { CmunDumpRow } from './validate';

/**
 * Export the production `CMUN` collection to JSONL.
 *
 * READ-ONLY. This is the human step of #785: the legacy `TabelaoCmun` CEP-range
 * table exists ONLY in production Firestore — there is no CSV, JSON or seed
 * file anywhere in `.old/`, and the legacy seeder (`.old/lib/clientes/etc.dart`)
 * read a CSV that was never committed. Lose this collection and the dataset is
 * gone.
 *
 *   pnpm --filter @delfrance/cmun-table dump --project <prod-project-id>
 *
 * Credentials follow the migrations contract (`tools/migrations/src/admin.ts`):
 * service account only, `--project` is REQUIRED and never inferred, and the
 * service account's own project must match it.
 *
 * Output is sorted by `cepInicial` so a future re-export diffs line-wise
 * against the committed dump instead of as one opaque blob.
 */

/** Page size for the `__name__` scan. Keeps memory bounded on ~11k docs. */
const PAGE_SIZE = 1_000;

const OUT_FLAG = '--out';

/**
 * `parseArgs` (shared with the migrations) rejects unknown flags, so pull
 * `--out` out of `argv` before handing the rest over.
 */
function extractOut(argv: readonly string[]): { out: string | null; rest: string[] } {
  const rest: string[] = [];
  let out: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === OUT_FLAG) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${OUT_FLAG} requires a value.`);
      }
      out = value;
      i += 1;
    } else if (arg.startsWith(`${OUT_FLAG}=`)) {
      out = arg.slice(OUT_FLAG.length + 1);
    } else {
      rest.push(arg);
    }
  }
  return { out, rest };
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

/**
 * Page the collection by document id.
 *
 * ⚠️ On Firestore Enterprise this rides the DECLARED key index `CMUN(__name__ ASC)`
 * in `firestore.indexes.json` — Enterprise has no implicit document-key ordering.
 * Without it each page walks another index (or the whole table) end to end and
 * sorts in memory: #1874/#1895 measured 313 index rows read per page of 100 on
 * `arquivos` and a full table scan per page on a collection group with no index,
 * so ~11 pages of 1,000 would read the collection ~11 times. (This comment used to
 * say the order "could not be declared even if we wanted to" — #1874 showed
 * Enterprise accepts a `__name__`-only index and seeks the cursor on it.) The
 * dump reads the legacy STANDARD project today, where the order is native, but
 * after the cutover production is Enterprise, and seeding or re-exporting any
 * Enterprise project walks the same way. `src/dump.indexes.test.ts` pins the
 * pairing. Same idiom as `tools/migrations` (`key-walks.json`).
 */
async function* pagesByDocId(
  query: Query,
): AsyncGenerator<FirebaseFirestore.QueryDocumentSnapshot[]> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.docs.length < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

async function main(): Promise<void> {
  const { out, rest } = extractOut(process.argv.slice(2));
  const args = parseArgs(rest.filter((arg) => arg !== '--apply'));

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = resolve(process.cwd(), out ?? `data/cmun-export-${stamp}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });

  const db = migrationDb(args.projectId, args.serviceAccountPath);
  log(`[cmun-dump] project=${args.projectId} → ${outPath}`);

  // The legacy collection is literally uppercase `CMUN`
  // (`.old/packages/clientes/lib/src/models.dart:20`), unlike every other
  // collection in the database.
  const rows: (CmunDumpRow & { docId: string })[] = [];
  for await (const docs of pagesByDocId(db.collection('CMUN'))) {
    for (const doc of docs) {
      const data = doc.data() as CmunDumpRow;
      rows.push({
        docId: doc.id,
        cepInicial: data.cepInicial,
        cepFinal: data.cepFinal,
        cMun: data.cMun,
        nomeMunicipio: data.nomeMunicipio,
        uf: data.uf,
      });
    }
    log(`[cmun-dump] ${rows.length} linha(s)…`);
  }

  if (rows.length === 0) {
    throw new Error(
      `A coleção CMUN do projeto "${args.projectId}" está vazia. ` +
        'Confirme o projeto — este dump é a única cópia do dataset.',
    );
  }

  rows.sort((a, b) => {
    const ai = typeof a.cepInicial === 'number' ? a.cepInicial : Number.MAX_SAFE_INTEGER;
    const bi = typeof b.cepInicial === 'number' ? b.cepInicial : Number.MAX_SAFE_INTEGER;
    return ai - bi || a.docId.localeCompare(b.docId);
  });

  const stream = createWriteStream(outPath, { flags: 'w' });
  for (const row of rows) stream.write(`${JSON.stringify(row)}\n`);
  await new Promise<void>((done) => stream.end(done));

  log(`[cmun-dump] pronto: ${rows.length} linha(s) em ${outPath}`);
  log('[cmun-dump] próximo passo: pnpm --filter @delfrance/cmun-table vendor');
}

await main();
