import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ORIGEM_CMUN, cmunDocId, cmunSchema } from '@delfrance/schemas';
import { migrationDb, parseArgs } from '@delfrance/migrations';
import { type CmunDumpRow, formatGapReport, validateDump } from './validate';

/**
 * Import a `CMUN` dump into a target project's `CMUN` collection.
 *
 *   pnpm --filter @delfrance/cmun-table import --project <id>          # dry-run
 *   pnpm --filter @delfrance/cmun-table import --project <id> --apply  # write
 *
 * **Production almost certainly does not need this.** The legacy Flutter app
 * already writes `CMUN` there, and this port deliberately reuses that exact
 * collection — so the import exists to seed *other* projects (staging, a fresh
 * environment) from a production dump.
 *
 * Idempotent: the doc id is derived from `cepInicial` (`cmunDocId`), so a
 * re-run overwrites rather than duplicates. The legacy seeder used Firestore
 * auto-ids and duplicated every row on a second run.
 *
 * Credentials follow the migrations contract (`tools/migrations/src/admin.ts`):
 * service account only, `--project` REQUIRED and never inferred.
 */

/** Firestore caps a batch at 500 writes; leave headroom like the migrations do. */
const BATCH_SIZE = 400;

const IN_FLAG = '--in';

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

/** `parseArgs` rejects unknown flags, so pull `--in` out before delegating. */
function extractIn(argv: readonly string[]): { input: string | null; rest: string[] } {
  const rest: string[] = [];
  let input: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === IN_FLAG) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`${IN_FLAG} requires a value.`);
      input = value;
      i += 1;
    } else if (arg.startsWith(`${IN_FLAG}=`)) {
      input = arg.slice(IN_FLAG.length + 1);
    } else {
      rest.push(arg);
    }
  }
  return { input, rest };
}

/** Newest `data/cmun-export-*.jsonl`, so the happy path takes no arguments. */
function newestDump(): string {
  const dir = resolve(process.cwd(), 'data');
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith('cmun-export-') && name.endsWith('.jsonl'))
    .sort();
  const newest = candidates[candidates.length - 1];
  if (!newest) {
    throw new Error(
      `Nenhum dump encontrado em ${dir}. Rode primeiro: ` +
        'pnpm --filter @delfrance/cmun-table dump --project <prod-project-id>',
    );
  }
  return resolve(dir, newest);
}

export function parseJsonl(raw: string): CmunDumpRow[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as CmunDumpRow;
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new Error(`Linha ${index + 1} do dump não é JSON válido: ${err.message}`);
        }
        throw err;
      }
    });
}

async function main(): Promise<void> {
  const { input, rest } = extractIn(process.argv.slice(2));
  const args = parseArgs(rest);
  const dumpPath = input ? resolve(process.cwd(), input) : newestDump();

  const rows = parseJsonl(readFileSync(dumpPath, 'utf8'));
  log(`[cmun-import] ${dumpPath} → ${rows.length} linha(s)`);

  // Same gatekeeper as before: a corrupt dump must fail loudly here, not become
  // wrong <cMun> values on signed NF-e later.
  const result = validateDump(rows);
  for (const warning of result.warnings) log(`[cmun-import] aviso: ${warning}`);
  log('');
  log('=== Relatório de buracos ===');
  log(formatGapReport(result.gaps));
  log('');
  log(
    `[cmun-import] project=${args.projectId} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} — ` +
      `${result.ranges.length} faixas, ${result.codeCount} municípios`,
  );

  if (!args.apply) {
    log('[cmun-import] DRY-RUN — nenhuma escrita. Reexecute com --apply para gravar.');
    return;
  }

  const db = migrationDb(args.projectId, args.serviceAccountPath);
  const now = Date.now();
  let written = 0;
  let batch = db.batch();
  let pending = 0;

  for (const range of result.ranges) {
    const data = cmunSchema.parse({
      cepInicial: range.cepInicial,
      cepFinal: range.cepFinal,
      cMun: String(range.cMun).padStart(7, '0'),
      nomeMunicipio: range.nomeMunicipio,
      estado: range.estado,
      origem: ORIGEM_CMUN.tabelao,
      timestamp: now,
      ultimaModificacao: now,
    });

    // `set` (not `create`): the import is a seed that must be safely re-runnable
    // over an existing collection.
    batch.set(db.collection('CMUN').doc(cmunDocId(range.cepInicial)), data);
    pending += 1;

    if (pending >= BATCH_SIZE) {
      await batch.commit();
      written += pending;
      log(`[cmun-import] ${written}/${result.ranges.length}…`);
      batch = db.batch();
      pending = 0;
    }
  }

  if (pending > 0) {
    await batch.commit();
    written += pending;
  }

  log(`[cmun-import] pronto: ${written} faixa(s) gravada(s) em ${args.projectId}.`);
}

await main();
