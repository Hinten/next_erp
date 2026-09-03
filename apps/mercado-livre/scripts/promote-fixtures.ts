/**
 * Promote raw captures from the gitignored `out/fixtures/` into the **committed**
 * `lib/marketplace/fixtures/__wire__/`, redacting on the way.
 *
 *   pnpm --filter @delfrance/mercado-livre-app promote:fixtures
 *   pnpm --filter @delfrance/mercado-livre-app promote:fixtures --dry-run
 *
 * This is the ONE path that moves an ML response body from a local scratch
 * directory into a public Apache-2.0 repository, which is why the redaction and
 * the scan both live here rather than in `fixtureCapture.ts` (see the header of
 * `redact.ts` for why that module keeps its byte-faithfulness instead).
 *
 * ⚠️ **A scan finding is FATAL and writes nothing** — not a warning, and not a
 * per-file skip that leaves the rest promoted. The failure mode being prevented
 * is a real customer's address landing in git history, where deleting the file
 * does not remove it. Refusing the whole run is the only outcome that cannot be
 * half-applied.
 *
 * ⚠️ It takes no `--project` and touches no credential: pure file IO over bodies
 * that were already captured. Nothing here can reach Mercado Livre or Firestore.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { formatFindings, scanForPii } from '../lib/marketplace/fixtures/piiScan';
import { type WireValue, redactWireBody } from '../lib/marketplace/fixtures/redact';
import { SHAPES_FILE, renderShapesFromCorpus } from '../lib/marketplace/fixtures/wireShapes';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

const RAW_DIR = resolve(import.meta.dirname, '..', 'out', 'fixtures');
const WIRE_DIR = resolve(import.meta.dirname, '..', 'lib', 'marketplace', 'fixtures', '__wire__');

/**
 * Never promoted. `_manifest.json` records the capture's `projectId` and
 * `integracaoId` — internal identifiers with no test value, and the fixture set
 * is self-describing through its filenames anyway.
 */
const SKIP_FILES: ReadonlySet<string> = new Set(['_manifest.json']);

interface Promocao {
  readonly file: string;
  readonly bytes: number;
  readonly findings: number;
}

function listRawFixtures(): string[] {
  if (!existsSync(RAW_DIR)) {
    throw new Error(`Nada a promover: ${RAW_DIR} não existe. Rode capture:fixtures antes.`);
  }
  return readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json') && !SKIP_FILES.has(f))
    .sort();
}

/**
 * Every integer literal in the RAW text whose `Number()` round trip does not
 * reproduce it — i.e. a value already destroyed by `JSON.parse`.
 *
 * ⚠️ **This has to read `bruto`, not the parsed value.** The previous version
 * compared `JSON.parse(JSON.stringify(value))` against `value` and called itself
 * "the only thing standing between a pretty-printed fixture and silent numeric
 * corruption". It could never fire: by then every number is already a double,
 * and `JSON.stringify` emits the shortest round-trippable representation of a
 * double, so re-parsing returns the identical double. The comparison is an
 * identity for anything that came out of `JSON.parse`.
 *
 * ```
 * raw bytes    : {"id": 2000018143664980123}
 * reserialised : {"id":2000018143664980200}
 * old guard    : clean ✗
 * ```
 *
 * ⚠️ Latent rather than active today — the largest ML id in the corpus is
 * `2000018143664980`, comfortably under `MAX_SAFE_INTEGER` (`9007199254740991`).
 * It is kept because the post-migration capture points at real orders, and a
 * fixture that disagrees with production by one digit is worse than no fixture.
 */
export function unsafeIntegerLiterals(bruto: string): string[] {
  const achados: string[] = [];
  // ⚠️ VALUE POSITION only — anchored on the `:` `[` or `,` before and the `,`
  // `]` or `}` after. A looser `(?<![\w.])\d{16,}` also matches digits INSIDE a
  // JSON string, because the character before them is a quote, and ML sends
  // several 18-digit ids as strings (`billing_info.id: "880802100988250668"`).
  // Those are not numbers, `JSON.parse` never touches them, and flagging them
  // would refuse the whole corpus for values that are perfectly intact.
  //
  // Integers only: a fractional double is lossy by nature, so comparing its text
  // would flag every ordinary price.
  for (const match of bruto.matchAll(/[:[,]\s*(-?\d{16,})\s*(?=[,\]}])/g)) {
    const literal = match[1];
    if (literal !== undefined && String(Number(literal)) !== literal) achados.push(literal);
  }
  return achados;
}

function serialise(value: WireValue, bruto: string, file: string): string {
  const perdidos = unsafeIntegerLiterals(bruto);
  const exemplo = perdidos[0];
  if (exemplo !== undefined) {
    throw new Error(
      `${file}: ${perdidos.length} inteiro(s) além de Number.MAX_SAFE_INTEGER — ` +
        `JSON.parse já alterou o valor (ex.: ${exemplo} → ${Number(exemplo)}). Fixture NÃO promovida.`,
    );
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const arquivos = listRawFixtures();
  if (arquivos.length === 0) throw new Error(`Nenhum .json em ${RAW_DIR}.`);

  const promocoes: Promocao[] = [];
  const problemas: string[] = [];
  const saida = new Map<string, string>();

  for (const file of arquivos) {
    const bruto = readFileSync(join(RAW_DIR, file), 'utf8');
    let parsed: WireValue;
    try {
      parsed = JSON.parse(bruto) as WireValue;
    } catch (err) {
      if (err instanceof SyntaxError) {
        problemas.push(`${file}  <corpo não é JSON> :: parse`);
        continue;
      }
      throw err;
    }

    const redigido = redactWireBody(parsed);
    const findings = scanForPii(redigido);
    if (findings.length > 0) problemas.push(formatFindings(file, findings));

    saida.set(file, serialise(redigido, bruto, file));
    promocoes.push({ file, bytes: bruto.length, findings: findings.length });
  }

  if (problemas.length > 0) {
    console.error('\n⛔ PII sobreviveu à redação — nada foi escrito.\n');
    console.error(problemas.join('\n'));
    console.error(
      '\nCada linha é <arquivo> <caminho> :: <tipo>. O VALOR nunca é impresso (#1015).',
    );
    console.error(
      'Corrija adicionando o sufixo do caminho a REDACTED_PATH_SUFFIXES em redact.ts.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    log(`\n${promocoes.length} fixture(s) prontas para promover (dry run):\n`);
    for (const p of promocoes) log(`  ${p.file}  (${p.bytes} bytes brutos)`);
    log(`\nDestino: ${WIRE_DIR}\n`);
    return;
  }

  mkdirSync(WIRE_DIR, { recursive: true });
  for (const [file, texto] of saida) writeFileSync(join(WIRE_DIR, file), texto, 'utf8');

  // ⚠️ Rendered from DISK, after the bodies land — never from `saida`.
  //
  // `saida` holds only what `out/fixtures/` contained on THIS run, and a partial
  // capture is the normal workflow: `capture:fixtures` takes per-id flags, so
  // capturing one new order and promoting it writes that body beside the other
  // 30 and would then overwrite SHAPES.txt with a SINGLE section.
  //
  // `wireShapes.test.ts` would red — but the remediation it points at is
  // "regenerate with promote:fixtures", which reproduced the truncation. A
  // detector whose documented fix re-creates the defect is a loop that never
  // closes, which is worse than no detector.
  //
  // Reading the directory back makes the script and the test share ONE source
  // of truth, and makes a truncated document self-healing on the next run.
  writeFileSync(join(WIRE_DIR, SHAPES_FILE), renderShapesFromCorpus(), 'utf8');

  log(`\n✅ ${saida.size} fixture(s) promovidas para ${WIRE_DIR}\n`);
  for (const p of promocoes) log(`  ${p.file}`);
  log(`\n📐 ${SHAPES_FILE} regenerado — revise o diff DELE, não o dos JSONs.\n`);
}

main();
