/**
 * Render the legacy-vs-generated ruleset coverage report (issue #783).
 *
 *   pnpm --filter @delfrance/rules-gen report:legacy-coverage
 *   pnpm --filter @delfrance/rules-gen report:legacy-coverage --check
 *
 * ⚠️ Requires the legacy Flutter checkout at `.old/`, which is **gitignored** —
 * it exists only in a full local clone, never in CI and never in a worktree. Run
 * this from the main checkout. The rendered report is committed so reviewers and
 * CI can read it without `.old/`.
 *
 * `--check` exits 1 when the committed report is stale (used by the guarded
 * staleness test in `src/legacyCoverage.test.ts`).
 */
/* eslint-disable no-console -- CLI tool: stdout is the interface */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import {
  compareCoverage,
  renderMarkdown,
  type ClientUsage,
  type CoverageRow,
} from '../src/legacyCoverage';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const LEGACY_RULES_PATH = join(REPO_ROOT, '.old', 'firestore.rules');
export const GENERATED_RULES_PATH = join(REPO_ROOT, 'firestore.rules');
export const REPORT_PATH = join(
  REPO_ROOT,
  'apps',
  'docs',
  'src',
  'content',
  'docs',
  'architecture',
  'legacy-rules-coverage.md',
);

const LEGACY_ROOT = join(REPO_ROOT, '.old');
const LEGACY_APP_LIB = join(LEGACY_ROOT, 'lib');
const LEGACY_PACKAGES = join(LEGACY_ROOT, 'packages');

function walkDart(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    // `build/` and `.dart_tool/` hold copies that would double-count references.
    if (entry === 'build' || entry === '.dart_tool' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDart(full, out);
    else if (entry.endsWith('.dart')) out.push(full);
  }
  return out;
}

/**
 * Map each legacy `permCode` to the Dart model class it annotates. The legacy
 * rules generator emitted one match block per `@EasyFirebase(...)` model, so the
 * perm code is the only stable join key between a rules block and its model.
 */
function buildPermCodeIndex(files: string[]): Map<string, string> {
  const index = new Map<string, string>();
  const permCode = /permCode:\s*'([^']+)'/g;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let hit: RegExpExecArray | null;
    while ((hit = permCode.exec(source)) !== null) {
      const code = hit[1]!;
      if (index.has(code)) continue;
      const nextClass = /\bclass\s+(\w+)/.exec(source.slice(hit.index));
      if (nextClass) index.set(code, nextClass[1]!);
    }
  }
  return index;
}

interface DartSource {
  /** Path relative to `.old/`, forward-slashed for the report. */
  rel: string;
  text: string;
}

/** Files under `.old/lib` (the Flutter app) referencing a model, generated code excluded. */
function findClientReferences(model: string, appSources: DartSource[]): string[] {
  const token = new RegExp(`\\b${model}\\b`);
  return appSources.filter((s) => token.test(s.text)).map((s) => s.rel);
}

function annotate(rows: CoverageRow[]): CoverageRow[] {
  // Read each file at most once. The naive shape — re-reading every app file per
  // model — is O(permCodes × files) over a few thousand Dart files, which pushed
  // the guarded staleness test past Vitest's default timeout.
  const appFiles = walkDart(LEGACY_APP_LIB);
  const appSources: DartSource[] = appFiles
    .filter((f) => !f.endsWith('.g.dart'))
    .map((f) => ({
      rel: relative(LEGACY_ROOT, f).split(sep).join('/'),
      text: readFileSync(f, 'utf8'),
    }));
  const permIndex = buildPermCodeIndex([...appFiles, ...walkDart(LEGACY_PACKAGES)]);

  const cache = new Map<string, ClientUsage>();
  return rows.map((row) => {
    if (row.permCode === null) return { ...row, clientUsage: null };
    const cached = cache.get(row.permCode);
    if (cached) return { ...row, clientUsage: cached };
    const model = permIndex.get(row.permCode) ?? null;
    const usage: ClientUsage = {
      model,
      referencedBy: model === null ? [] : findClientReferences(model, appSources),
    };
    cache.set(row.permCode, usage);
    return { ...row, clientUsage: usage };
  });
}

/** Build the report text. Exported so the staleness test reuses the exact pipeline. */
export function buildReport(): string {
  const legacy = readFileSync(LEGACY_RULES_PATH, 'utf8');
  const generated = readFileSync(GENERATED_RULES_PATH, 'utf8');
  return renderMarkdown(annotate(compareCoverage(legacy, generated)), { withClientUsage: true });
}

function main(argv: string[]): number {
  if (!existsSync(LEGACY_RULES_PATH)) {
    console.error(
      `Legacy ruleset not found at ${LEGACY_RULES_PATH}.\n` +
        '`.old/` is gitignored — run this from the main checkout, not a worktree or CI.',
    );
    return 1;
  }

  const report = buildReport();

  if (argv.includes('--check')) {
    const current = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, 'utf8') : '';
    // Normalize CRLF→LF before comparing — Windows working trees may check the
    // file out with CRLF; the generated content itself is always LF.
    if (current.replaceAll('\r\n', '\n') !== report) {
      console.error(`${REPORT_PATH} is out of date with .old/firestore.rules + firestore.rules.`);
      console.error('Regenerate: pnpm --filter @delfrance/rules-gen report:legacy-coverage');
      return 1;
    }
    console.log('legacy-rules-coverage.md is up to date.');
    return 0;
  }

  writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(`wrote ${REPORT_PATH} (${Buffer.byteLength(report, 'utf8')} bytes)`);
  return 0;
}

// Importable from the guarded staleness test without running the CLI.
const RUN_DIRECTLY =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('legacy-coverage.ts') === true;

if (RUN_DIRECTLY) process.exitCode = main(process.argv.slice(2));
