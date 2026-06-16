import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateRulesSource } from './generate';
import { sizeGate } from './size-gate';

// src/cli.ts → packages/rules-gen → packages → repo root. The --e2e variant
// is the staging-only ruleset (firebase.staging.json); production is the plain
// firestore.rules.
const RULES_PATH = fileURLToPath(new URL('../../../firestore.rules', import.meta.url));
const E2E_RULES_PATH = fileURLToPath(new URL('../../../firestore.e2e.rules', import.meta.url));

function main(argv: string[]): number {
  const e2e = argv.includes('--e2e');
  const source = generateRulesSource({ e2e });
  sizeGate(source);

  const rulesPath = e2e ? E2E_RULES_PATH : RULES_PATH;
  const fileName = e2e ? 'firestore.e2e.rules' : 'firestore.rules';
  const regenHint = `pnpm --filter @delfrance/rules-gen gen:rules${e2e ? ':e2e' : ''}`;

  if (argv.includes('--stdout')) {
    process.stdout.write(source);
    return 0;
  }

  if (argv.includes('--check')) {
    // Normalize CRLF→LF before comparing — Windows working trees may check
    // the file out with CRLF; the generated content itself is always LF.
    const onDisk = readFileSync(rulesPath, 'utf8').replaceAll('\r\n', '\n');
    if (onDisk !== source) {
      console.error(`${fileName} is out of date with the schemas/PERM sources.`);
      console.error(`Regenerate and commit: ${regenHint}`);
      return 1;
    }
    console.log(`${fileName} is up to date.`);
    return 0;
  }

  writeFileSync(rulesPath, source);
  console.log(`wrote ${rulesPath} (${Buffer.byteLength(source, 'utf8')} bytes)`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
