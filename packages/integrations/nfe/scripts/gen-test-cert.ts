/**
 * CLI wrapper for `generateTestCertificate`. Two modes:
 *
 * **1. Env-var mode** (default, no arg) — designed to be piped into
 *    GitHub Actions' `$GITHUB_ENV`:
 *
 *      - name: Generate self-signed test certificate
 *        run: pnpm --filter @delfrance/integrations-nfe gen:test-cert >> "$GITHUB_ENV"
 *
 *    Stdout is exactly two lines:
 *
 *      NFE_CERT_BASE64=<long base64>
 *      NFE_CERT_PASSWORD=homologacao-test
 *
 * **2. File mode** (positional arg = output path) — writes the binary
 *    PKCS#12 to the given path. Useful for local dev where
 *    `NFE_CERT_PATH` in `.env.local` is the easier knob than chasing
 *    shell env-var inheritance:
 *
 *      pnpm --filter @delfrance/integrations-nfe gen:test-cert .ignore/test-cert.pfx
 *
 *    Stdout becomes:
 *
 *      NFE_CERT_PATH=<absolute path>
 *      NFE_CERT_PASSWORD=homologacao-test
 *
 * Status / informational messages go to stderr in both modes so they
 * don't pollute the env-var pipe.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { generateTestCertificate } from '../src/cert';

const outArg = process.argv[2];
const { pfxBase64, password, cert } = generateTestCertificate();

// stderr: a one-line audit so the log shows what we generated
// without ever printing the private key material.
process.stderr.write(
  `[gen-test-cert] generated self-signed cert subject="${cert.subjectCommonName}" notAfter=${cert.notAfter.toISOString()}\n`,
);

if (outArg) {
  // pnpm cd's into the filtered package's directory before running
  // the script. Resolve the path arg against `INIT_CWD` (the directory
  // the user invoked pnpm from) so `.ignore/test-cert.pfx` lands at
  // the worktree root, not at packages/integrations/nfe/.ignore/.
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const absPath = resolve(baseDir, outArg);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, Buffer.from(pfxBase64, 'base64'));
  process.stderr.write(`[gen-test-cert] wrote PFX to ${absPath}\n`);
  process.stdout.write(`NFE_CERT_PATH=${absPath}\n`);
  process.stdout.write(`NFE_CERT_PASSWORD=${password}\n`);
} else {
  process.stdout.write(`NFE_CERT_BASE64=${pfxBase64}\n`);
  process.stdout.write(`NFE_CERT_PASSWORD=${password}\n`);
}
