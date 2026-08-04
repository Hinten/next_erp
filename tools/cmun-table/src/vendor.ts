import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { renderRangesModule } from './render';
import { type CmunDumpRow, formatGapReport } from './validate';

/**
 * Turn a `CMUN` dump into the committed `ranges.data.ts` module.
 *
 * This is a one-off VENDORING script, not a generator in the sense of root
 * `CLAUDE.md` rule 3: nothing automated re-runs it, it is not in `turbo.json`,
 * and its output is reviewed like source. Same shape as the `CCLASSTRIB_SEED`
 * refresh routine in `packages/schemas/src/imposto/cclasstrib.ts`.
 *
 *   pnpm --filter @delfrance/cmun-table vendor [-- --in <file.jsonl>]
 *
 * The interesting half lives in `render.ts` so it can be unit-tested; this file
 * is only the IO shell.
 */

const DEFAULT_OUT = '../../packages/core/src/cep/cmun/ranges.data.ts';
const REPO_ROOT = resolve(process.cwd(), '..', '..');

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

function flagValue(argv: readonly string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === flag) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value.`);
      }
      return value;
    }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
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
        'pnpm --filter @delfrance/cmun-table dump -- --project <prod-project-id>',
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

function main(): void {
  const argv = process.argv.slice(2);
  const inPath = flagValue(argv, '--in');
  const dumpPath = inPath ? resolve(process.cwd(), inPath) : newestDump();
  const outPath = resolve(process.cwd(), flagValue(argv, '--out') ?? DEFAULT_OUT);

  const raw = readFileSync(dumpPath);
  const dumpSha256 = createHash('sha256').update(raw).digest('hex');
  const rows = parseJsonl(raw.toString('utf8'));
  log(`[cmun-vendor] ${dumpPath} → ${rows.length} linha(s), sha256 ${dumpSha256.slice(0, 16)}…`);

  const { source, encoded, validation } = renderRangesModule(rows, {
    dumpFile: relative(REPO_ROOT, dumpPath).replace(/\\/g, '/'),
    dumpSha256,
    exportedAt: new Date().toISOString().slice(0, 10),
  });

  writeFileSync(outPath, source, 'utf8');

  const bytes = encoded.startGaps.length + encoded.rangeLens.length + encoded.codes.length;
  log(`[cmun-vendor] escrito ${outPath}`);
  log(
    `[cmun-vendor] ${encoded.rangeCount.toLocaleString('pt-BR')} faixas, ` +
      `${validation.codeCount.toLocaleString('pt-BR')} municípios, ` +
      `${(bytes / 1024).toFixed(1)} KiB codificados`,
  );
  for (const warning of validation.warnings) log(`[cmun-vendor] aviso: ${warning}`);
  log('');
  log('=== Relatório de buracos (cole no corpo do PR) ===');
  log(formatGapReport(validation.gaps));
  log('');
  log('[cmun-vendor] rode `pnpm --filter @delfrance/core test` e o prettier no arquivo gerado.');
}

main();
