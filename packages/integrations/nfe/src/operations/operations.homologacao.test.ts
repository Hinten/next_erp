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
import { describe, expect, it } from 'vitest';

import { loadCertificateFromEnv } from '../cert';
import { getEndpoints } from '../endpoints';
import { createSefazAgent, type SefazCall } from '../soap';
import { consultarStatusServico } from './index';

const hasCert =
  Boolean(process.env.NFE_CERT_BASE64) && process.env.NFE_CERT_PASSWORD != null;

const describeOrSkip = hasCert ? describe : describe.skip;

describeOrSkip('SEFAZ-SP homologação smoke (typed)', () => {
  it('consultarStatusServico returns a typed TRetConsStatServ with cStat=107', async () => {
    const cert = loadCertificateFromEnv();
    const agent = createSefazAgent(cert);
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
