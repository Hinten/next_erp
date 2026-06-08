/**
 * Re-encrypt a PFX file with a fresh, cryptographically-random
 * password. Non-destructive: the X.509 certificate and RSA private key
 * inside the PFX are byte-for-byte unchanged — only the symmetric
 * PKCS#12 wrapper around the private key bag is replaced. The OLD PFX
 * stays valid against its old password; treat them as siblings, not as
 * a rotation that invalidates one another.
 *
 * Use case (one-off): before uploading a real ICP-Brasil A1 cert to
 * GitHub Secrets, run this against a copy of the local PFX to produce
 * a CI-only PFX whose password isn't memorable (~256 bits of entropy)
 * — so even a leak of `NFE_CERT_BASE64` alone is computationally
 * useless without `NFE_CERT_PASSWORD`.
 *
 * Usage (from repo root):
 *   pnpm --filter @delfrance/integrations-nfe rotate:pfx-password \
 *     --in  .ignore/cert.pfx \
 *     --out .ignore/cert-strong.pfx
 *
 * Output to **stderr** (never stdout — keeps the password out of any
 * accidental `$GITHUB_ENV` capture):
 *   - The freshly generated password (save in your password manager NOW).
 *   - Ready-to-paste `gh secret set` lines for NFE_CERT_BASE64 +
 *     NFE_CERT_PASSWORD.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

import forge from 'node-forge';

interface CliArgs {
  in: string;
  out: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--in') args.in = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
  }
  if (!args.in || !args.out) {
    process.stderr.write('Usage: rotate-pfx-password --in <input.pfx> --out <output.pfx>\n');
    process.exit(2);
  }
  return args as CliArgs;
}

function readPasswordFromStdin(prompt: string): Promise<string> {
  // `terminal: true` enables raw mode on TTY; we still emit the prompt
  // manually via stderr so it doesn't pollute stdout.
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, terminal: false });
  return new Promise<string>((resolve) => {
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
  });
}

/**
 * 32 random bytes → URL-safe base64 (no `=` padding, no `+` / `/`).
 * That's ~43 ASCII chars carrying 256 bits of entropy. Long enough
 * that brute-force is infeasible; short enough to paste reliably.
 */
function generateStrongPassword(): string {
  const bytes = forge.random.getBytesSync(32);
  return Buffer.from(bytes, 'binary')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function reencryptPfx(pfxBytes: Buffer, oldPassword: string, newPassword: string): Buffer {
  const der = forge.util.createBuffer(pfxBytes.toString('binary'));
  const asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, oldPassword);

  const KEY_OID = forge.pki.oids.pkcs8ShroudedKeyBag as string;
  const CERT_OID = forge.pki.oids.certBag as string;
  const keyBag = p12.getBags({ bagType: KEY_OID })[KEY_OID]?.[0];
  const certBag = p12.getBags({ bagType: CERT_OID })[CERT_OID]?.[0];
  if (!keyBag?.key) throw new Error('Input PFX has no private key bag');
  if (!certBag?.cert) throw new Error('Input PFX has no certificate bag');

  // 3des keeps the wire shape identical to what node-forge writes in
  // the test fixture (`test/cert/cert.test.ts:39`) and what Receita
  // Federal's portal-exported PFXs use, so the resulting file is
  // accepted by the same loader code without any algorithm-toggle.
  const newAsn1 = forge.pkcs12.toPkcs12Asn1(keyBag.key, [certBag.cert], newPassword, {
    algorithm: '3des',
  });
  const newDer = forge.asn1.toDer(newAsn1).getBytes();
  return Buffer.from(newDer, 'binary');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // pnpm runs the script from the filtered package's directory, so a
  // relative `--in .ignore/cert.pfx` would resolve under
  // packages/integrations/nfe/. Resolve both paths against `INIT_CWD`
  // (the directory the user invoked pnpm from) so relative paths land
  // at the worktree root, matching the convention `.env.local`'s
  // NFE_CERT_PATH already uses.
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const inPath = resolve(baseDir, args.in);
  const outPath = resolve(baseDir, args.out);

  if (!existsSync(inPath)) {
    process.stderr.write(`Input PFX not found: ${inPath}\n`);
    process.exit(2);
  }
  if (existsSync(outPath)) {
    process.stderr.write(
      `Output path already exists: ${outPath}\n` +
        'Refusing to overwrite — delete it first if you really want to clobber.\n',
    );
    process.exit(2);
  }

  const oldPassword = await readPasswordFromStdin(
    `Old PFX password (input will be visible — pipe via < password.txt to hide): `,
  );

  const pfxBytes = readFileSync(inPath);
  const newPassword = generateStrongPassword();
  const reencrypted = reencryptPfx(pfxBytes, oldPassword, newPassword);

  // Round-trip verification: parse the output we just wrote with the new
  // password before declaring success. Catches any subtle reformatting
  // bug before the user uploads it as a CI secret.
  try {
    const verifyDer = forge.util.createBuffer(reencrypted.toString('binary'));
    const verifyAsn1 = forge.asn1.fromDer(verifyDer);
    forge.pkcs12.pkcs12FromAsn1(verifyAsn1, newPassword);
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(`Round-trip verification failed: ${e.message}`);
    }
    throw e;
  }

  writeFileSync(outPath, reencrypted, { mode: 0o600 });

  // All sensitive output goes to STDERR — stdout stays empty so callers
  // capturing stdout (e.g. into $GITHUB_ENV via `echo`) cannot
  // accidentally surface the password to a workflow environment file.
  const base64 = reencrypted.toString('base64');
  process.stderr.write(
    [
      '',
      'OK — rotated PFX written to ' + outPath,
      '',
      '═════════════════════════════════════════════════════════════════',
      '  NEW PASSWORD (save in password manager NOW — printed once):',
      '',
      '    ' + newPassword,
      '',
      '═════════════════════════════════════════════════════════════════',
      '',
      'Paste these to upload as GitHub Secrets:',
      '',
      `  gh secret set NFE_CERT_BASE64 -R Hinten/next_erp -b '${base64}'`,
      `  gh secret set NFE_CERT_PASSWORD -R Hinten/next_erp -b '${newPassword}'`,
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`rotate-pfx-password FAILED: ${msg}\n`);
  process.exit(1);
});
