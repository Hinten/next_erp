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
import { SHAPES_FILE, renderShapesDocument } from '../lib/marketplace/fixtures/wireShapes';

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
 * ⚠️ Re-parsing the serialised output and comparing is not belt-and-braces — it
 * is the only thing standing between a pretty-printed fixture and silent
 * numeric corruption. An ML id past `Number.MAX_SAFE_INTEGER` survives the raw
 * bytes but not a `JSON.parse` → `JSON.stringify` round trip, and the damage
 * would show up as a fixture that disagrees with production by one digit.
 */
function serialise(value: WireValue, file: string): string {
  const texto = `${JSON.stringify(value, null, 2)}\n`;
  const roundTrip = JSON.parse(texto) as WireValue;
  if (JSON.stringify(roundTrip) !== JSON.stringify(value)) {
    throw new Error(
      `${file}: o round trip JSON alterou o valor — provável perda de precisão numérica. Fixture NÃO promovida.`,
    );
  }
  return texto;
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

    saida.set(file, serialise(redigido, file));
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
  const parsedBodies = new Map<string, WireValue>(
    [...saida].map(([file, texto]) => [file, JSON.parse(texto) as WireValue]),
  );
  writeFileSync(join(WIRE_DIR, SHAPES_FILE), renderShapesDocument(parsedBodies), 'utf8');

  log(`\n✅ ${saida.size} fixture(s) promovidas para ${WIRE_DIR}\n`);
  for (const p of promocoes) log(`  ${p.file}`);
  log(`\n📐 ${SHAPES_FILE} regenerado — revise o diff DELE, não o dos JSONs.\n`);
}

main();
