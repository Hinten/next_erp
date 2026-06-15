import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateRulesSource } from './generate';
import { sizeGate } from './size-gate';

const REGEN_HINT = 'pnpm --filter @delfrance/rules-gen gen:rules';

// src/cli.ts → packages/rules-gen → packages → repo root.
const RULES_PATH = fileURLToPath(new URL('../../../firestore.rules', import.meta.url));

function main(argv: string[]): number {
  const source = generateRulesSource();
  sizeGate(source);

  if (argv.includes('--stdout')) {
    process.stdout.write(source);
    return 0;
  }

  if (argv.includes('--check')) {
    // Normalize CRLF→LF before comparing — Windows working trees may check
    // the file out with CRLF; the generated content itself is always LF.
    const onDisk = readFileSync(RULES_PATH, 'utf8').replaceAll('\r\n', '\n');
    if (onDisk !== source) {
      console.error(`firestore.rules is out of date with the schemas/PERM sources.`);
      console.error(`Regenerate and commit: ${REGEN_HINT}`);
      return 1;
    }
    console.log('firestore.rules is up to date.');
    return 0;
  }

  writeFileSync(RULES_PATH, source);
  console.log(`wrote ${RULES_PATH} (${Buffer.byteLength(source, 'utf8')} bytes)`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
