// Repair an existing checkout without resetting files or changing the index.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..', '..');

function isCredentialFile(file) {
  const name = basename(file);
  return (
    /^\.env(?:\..*)?$/i.test(name) ||
    /\.(?:pem|key|pfx|p12|crt|cer|jks|keystore)$/i.test(name) ||
    /(?:credential|secret|service[-_]?account).*\.json$/i.test(name)
  );
}

/**
 * Normalize only tracked files stored with LF and governed by eol=lf.
 * Read/write Buffers so encoding, BOMs, and every byte except CRLF survive.
 * @param {string} root
 * @param {{ env?: NodeJS.ProcessEnv }} options
 */
export function normalizeLineEndings(root = REPO_ROOT, { env = process.env } = {}) {
  const records = execFileSync('git', ['ls-files', '--eol', '-z'], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).split('\0');
  const normalized = [];
  const skipped = [];

  for (const record of records) {
    const match = record.match(/^i\/lf\s+w\/(?:crlf|mixed)\s+attr\/[^\t]*\beol=lf\s*\t(.+)$/s);
    if (!match) continue;
    const file = match[1];
    const path = resolve(root, file);
    if (isCredentialFile(file) || lstatSync(path).isSymbolicLink()) {
      skipped.push(file);
      continue;
    }

    const input = readFileSync(path);
    const output = Buffer.allocUnsafe(input.length);
    let length = 0;
    for (let i = 0; i < input.length; i += 1) {
      if (input[i] === 0x0d && input[i + 1] === 0x0a) continue;
      output[length] = input[i];
      length += 1;
    }
    if (length === input.length) continue;
    writeFileSync(path, output.subarray(0, length));
    normalized.push(file);
  }

  return { normalized, skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const { normalized, skipped } = normalizeLineEndings();
  process.stdout.write(
    `Normalized ${normalized.length} tracked files to LF; skipped ${skipped.length}.\n`,
  );
}
