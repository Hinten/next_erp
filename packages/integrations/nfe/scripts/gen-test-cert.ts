/**
 * CLI wrapper for `generateTestCertificate`. Designed to be piped
 * into GitHub Actions' `$GITHUB_ENV` so a CI run can mint a fresh
 * self-signed cert without any cert secrets configured at the repo
 * level. Sample CI usage:
 *
 *   - name: Generate self-signed test certificate
 *     run: pnpm --filter @delfrance/integrations-nfe gen:test-cert >> "$GITHUB_ENV"
 *
 * Output (stdout) is exactly two lines, formatted for `KEY=VALUE`
 * env-var binding — nothing else, no progress chatter:
 *
 *   NFE_CERT_BASE64=<long base64>
 *   NFE_CERT_PASSWORD=homologacao-test
 *
 * Status / informational messages go to stderr so they don't
 * pollute `>> $GITHUB_ENV`.
 */
import { generateTestCertificate } from '../src/cert';

const { pfxBase64, password, cert } = generateTestCertificate();

// stderr: a one-line audit of what was generated, so the CI log shows
// the Subject CN + notAfter without leaking any private material.
process.stderr.write(
  `[gen-test-cert] generated self-signed cert subject="${cert.subjectCommonName}" notAfter=${cert.notAfter.toISOString()}\n`,
);

// stdout: KEY=VALUE lines only.
process.stdout.write(`NFE_CERT_BASE64=${pfxBase64}\n`);
process.stdout.write(`NFE_CERT_PASSWORD=${password}\n`);
