/**
 * Live SEFAZ-SP homologação smoke test — full typed pipeline.
 *
 * Skipped automatically unless `NFE_CERT_BASE64` + `NFE_CERT_PASSWORD` are
 * set in the environment. Run locally with:
 *
 *   $env:NFE_CERT_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("path-to.pfx"))
 *   $env:NFE_CERT_PASSWORD = "your-pfx-password"
 *   pnpm --filter @delfrance/integrations-nfe test operations.homologacao
 *
 * Exercises the **full typed pipeline** end-to-end:
 *
 *   consultarStatusServico(call, { cUF: '35' })
 *     → serialize('consStatServ', {...})    (Zod once Step 2 lands)
 *     → nfeStatusServico(call, xml)
 *       → assertSafeTpAmb('2')              (safety guard)
 *       → validateXsd('consStatServ', xml)   (XSD pre-send gate)
 *       → mTLS POST → SEFAZ-SP
 *       → validateXsd('retConsStatServ', x)  (XSD inbound gate)
 *     → parse('retConsStatServ', x) → typed TRetConsStatServ
 *
 * Replaces the older `soap.homologacao.test.ts` — one smoke test, one
 * pipeline, asserted on the typed return.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertCertNotExpired, loadCertificateFromEnv, warnIfCertNearExpiry } from '../../src/cert';
import { getEndpoints } from '../../src/endpoints';
import { createSefazAgent, type SefazCall } from '../../src/soap';
import { consultarStatusServico } from '../../src/operations/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED_CHAIN = resolve(HERE, '..', '..', 'ca', 'sefaz-sp-homologacao.pem');

const hasCert =
  (Boolean(process.env.NFE_CERT_PATH) || Boolean(process.env.NFE_CERT_BASE64)) &&
  process.env.NFE_CERT_PASSWORD != null;

const describeOrSkip = hasCert ? describe : describe.skip;

describeOrSkip('SEFAZ-SP homologação smoke (typed)', () => {
  it('loaded certificate is not expired', () => {
    const cert = loadCertificateFromEnv();
    expect(() => assertCertNotExpired(cert)).not.toThrow();
    // Heads-up if renewal is approaching — same observability the
    // apps/nfe boot path will get via loadCertificateFromEnv.
    warnIfCertNearExpiry(cert);
  });

  it('consultarStatusServico returns a typed TRetConsStatServ with cStat=107', async () => {
    const cert = loadCertificateFromEnv();
    assertCertNotExpired(cert); // fail fast before any SEFAZ traffic
    // SEFAZ chains through Brazilian CAs that aren't all in Node's bundled
    // Mozilla list. Resolution order:
    //   1. NFE_TLS_CA_PATH env var (explicit override)
    //   2. Vendored chain at packages/integrations/nfe/ca/sefaz-sp-homologacao.pem
    //      (run `pnpm fetch:sefaz-ca` once to populate it)
    //   3. None — relies on Node's default + NODE_OPTIONS=--use-system-ca
    const caPath = process.env.NFE_TLS_CA_PATH
      ?? (existsSync(VENDORED_CHAIN) ? VENDORED_CHAIN : undefined);
    const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
    if (caPath) {
      // eslint-disable-next-line no-console
      console.log(`[tls] using CA bundle: ${caPath}`);
    }
    const agent = createSefazAgent(cert, { ca });
    const url = getEndpoints('SP', 'homologacao').NfeStatusServico;
    const call: SefazCall = { url, cert, agent, tpAmb: '2', timeoutMs: 30_000 };

    const result = await consultarStatusServico(call, { cUF: '35' });

    expect(result.tpAmb).toBe('2');
    // 107 (operating) is the happy path; 108/109 (paralisado) is a
    // non-failure outcome that still proves the typed pipeline works.
    expect(['107', '108', '109']).toContain(result.cStat);
    expect(result.xMotivo).toBeTruthy();
    expect(result.cUF).toBe('35');
    // eslint-disable-next-line no-console
    console.log(
      `[SEFAZ-SP homologação] cStat=${result.cStat} xMotivo="${result.xMotivo}"`,
    );
  }, 45_000);
});
